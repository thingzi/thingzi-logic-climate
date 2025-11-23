module.exports = function(RED) {
    'use strict'
    const moment = require('moment');
    const mqtt = require('./mqtt');

    const offValue = 'off';

    const presetBoost = 'boost';
    const presetAway = 'away';
    const presetNone = 'none';

    const modeAuto = 'auto';
    const modeHeat = 'heat';
    const modeCool = 'cool';

    const climateBoth = 'both';
    const climateHeat = 'heat';
    const climateCool = 'cool';
    const climateManual = 'manual';

    const advNone = 'none';
    const advHass = 'hass';
    const advThingzi = 'thingzi';

    RED.nodes.registerType('thingzi-climate', function(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // Internal State
        this.name = config.name || this.id;
        this.deviceId = config.name ? `${config.name.toLowerCase().trim().replace(/\s+/g, '-')}-climate` : `${this.id}-climate`;
        this.sendStatus = config.sendStatus;
        this.outputs = config.outputs;
        this.updateTimeout = null;
        this.starting = true;

        // Configuration
        this.keepAliveMs = parseFloat(config.keepAlive) * 1000 * 60; //< mins to ms
        this.cycleDelayMs = parseFloat(config.cycleDelay) * 1000; //< seconds to ms
        this.boostDurationMins = config.boostDuration;
        this.defaultPreset = config.defaultPreset;
        if (!this.defaultPreset || this.defaultPreset.trim().length === 0) {
            this.defaultPreset = presetNone;
        }

        // Set Point
        this.degrees = config.degrees;
        this.defaultSetPoint = parseFloat(config.defaultSetPoint);
        this.tolerance = parseFloat(config.tolerance);
        this.thermalLagUpMs = (parseFloat(config.thermalLagUp) || parseFloat(config.thermalLagOff) || parseFloat(config.thermalLag) || 0) * 1000 * 60; //< mins to ms (temp rising)
        this.thermalLagDnMs = (parseFloat(config.thermalLagDn) || parseFloat(config.thermalLagOn) || 0) * 1000 * 60; //< mins to ms (temp falling)
        this.thermalLagTune = config.thermalLagTune || config.autoTune || 'off';
        this.minTemp = parseFloat(config.minTemp);
        this.maxTemp = parseFloat(config.maxTemp);
        this.tempValidMs = parseFloat(config.tempValid) * 1000 * 60; //< mins to ms
        this.swapDelayMs = parseFloat(config.swapDelay) * 1000 * 60; //< mins to ms

        // Minimum rate for auto-tune (scaled for Fahrenheit)
        this.minAutoTuneRate = this.degrees === 'F' ? 0.0144 : 0.008; // °/min

        // Temperature history for rate calculation
        this.tempHistory = [];
        
        // Outputs
        this.onPayload = config.onPayload;
        this.onPayloadType = config.onPayloadType;
        this.offPayload = config.offPayload;
        this.offPayloadType = config.offPayloadType;

        // Advertising
        this.advertiseType = config.advertiseType ?? (config.advertise === true ? advHass : advNone);
        this.broker = RED.nodes.getNode(config.broker);
        this.topic = `${config.topic.trim('/')}/${this.deviceId}`;

        // Capabilities
        this.hasHeating = config.climateType === climateBoth || config.climateType === climateHeat || config.climateType === climateManual;
        this.hasCooling = config.climateType === climateBoth || config.climateType === climateCool || config.climateType === climateManual;
        this.hasSetpoint = config.climateType !== climateManual;
        this.hasAutoMode = this.hasSetpoint && this.hasHeating && this.hasCooling;

        // Default mode when on value or boost is used
        this.defaultMode = modeHeat;
        if (config.climateType === climateBoth) {
            this.defaultMode = modeAuto;
        } else if (config.climateType === climateCool) {
            this.defaultMode = modeCool;
        }

        // Previous state
        this.lastChange = null;
        this.lastAction = null;
        this.lastTemp = null;
        this.lastHeatTime = null;
        this.lastCoolTime = null;
        this.lastSend = null;

        // Auto-tune cycle tracking
        this.cycleStopTemp = null;
        this.cycleStopRate = null;
        this.cycleStopTime = null;
        this.cyclePeakTemp = null;
        this.cycleType = null; // 'heating' or 'cooling'

        // Handle direct inputs
        this.on("input", function(msg, send, done) {
            if (msg.hasOwnProperty('payload')) { node.mode.set(msg.payload); }
            if (msg.hasOwnProperty('mode')) { node.mode.set(msg.mode); }
            if (msg.hasOwnProperty('preset')) { node.preset.set(msg.preset); }
            if (msg.hasOwnProperty('setpoint')) { node.setpoint.set(msg.setpoint); }
            if (msg.hasOwnProperty('temp')) { node.temp.set(msg.temp); }
            if (msg.hasOwnProperty('tolerance')) { this.tolerance = parseFloat(msg.tolerance); }
            if (msg.hasOwnProperty('thermalLagUp')) { this.thermalLagUpMs = parseFloat(msg.thermalLagUp) * 1000 * 60; }
            if (msg.hasOwnProperty('thermalLagDn')) { this.thermalLagDnMs = parseFloat(msg.thermalLagDn) * 1000 * 60; }
            // Backwards compatibility
            if (msg.hasOwnProperty('thermalLagOff')) { this.thermalLagUpMs = parseFloat(msg.thermalLagOff) * 1000 * 60; }
            if (msg.hasOwnProperty('thermalLagOn')) { this.thermalLagDnMs = parseFloat(msg.thermalLagOn) * 1000 * 60; }

            // Backwards compatibility
            if (msg.hasOwnProperty('boost')) { node.preset.set(isOn(msg.boost) ? presetBoost : node.defaultPreset); }
            if (msg.hasOwnProperty('away')) { node.preset.set(isOn(msg.away) ? presetAway : node.defaultPreset); }

            node.update();
            done();
        });

        // On node shutdown
        this.on('close', function(removed, done) {
            node.clearUpdateTimeout();

            if (node.mqtt) {
                node.mqtt.stop(done);
            } else {
                done();
            }
        });

        this.onMqttConnect = function () {
            node.update();
        }

        this.onMqttSet = function (type, value) {
            if (type === 'mode') { node.mode.set(value); }
            if (type === 'preset') { node.preset.set(value); }
            if (type === 'setpoint') { node.setpoint.set(value); }

            node.update();
        }

        this.onMqttInfo = function (text) {
            node.log(text);
        }

        this.onMqttWarn = function (text) {
            node.warn(text);
        }

        // Get thingZi advertise config
        this.getThingziConfig = function() {
            let name = `${node.name} Climate`;
            let modes = [ offValue ];

            // Add climate modes
            if (node.hasAutoMode) modes.push(modeAuto);
            if (node.hasHeating) modes.push(modeHeat);
            if (node.hasCooling) modes.push(modeCool);

            let climate = {
                thing: {
                    id: node.deviceId,
                    type: 'climate',
                    name: `${node.name} Climate`,
                    device_model: 'thingZi Climate',
                    version: '1.0'
                },
                properties: [
                    { 
                        id: 'mode',
                        type: 'text',
                        name: `${name} Mode`,
                        metrics: true,
                        state_topic: `${node.topic}/mode`,
                        cmd_topic: `${node.topic}/mode/set`,
                        valid_states: modes
                    },
                    { 
                        id: 'program',
                        type: 'text',
                        name: `${name} Program`,
                        metrics: true,
                        state_topic: `${node.topic}/preset`,
                        cmd_topic: `${node.topic}/preset/set`,
                        valid_states: [ node.defaultPreset, presetBoost, presetAway ]
                    },
                    { 
                        id: 'action',
                        type: 'text',
                        name: `${name} Action`,
                        metrics: true,
                        state_topic: `${node.topic}/action`
                    },
                    { 
                        id: 'heating',
                        type: 'binary',
                        name: `${name} Heat On`,
                        metrics: false,
                        state_topic: `${node.topic}/heating`
                    },
                    { 
                        id: 'cooling',
                        type: 'binary',
                        name: `${name} Cool On`,
                        metrics: false,
                        state_topic: `${node.topic}/cool_on`
                    }
                ]
            };

            // Add setpoint config
            if (node.hasSetpoint) {
                climate.properties.push({
                    id: 'setpoint',
                    type: 'number',
                    name: `${name} Setpoint`,
                    unit: node.degrees,
                    metrics: true,
                    state_topic: `${node.topic}/setpoint`,
                    cmd_topic: `${node.topic}/setpoint/set`,
                    valid_states: [ `${node.minTemp}->${node.maxTemp}` ],
                    config: [
                        {
                            key: 'step',
                            value: node.degrees === 'C' ? 0.5 : 1
                        }
                    ]
                });

                climate.properties.push({
                    id: 'temp',
                    type: 'number',
                    name: `${name} Temp`,
                    unit: node.degrees,
                    metrics: true,
                    state_topic: `${node.topic}/temp`
                });
            }

            return climate;
        }

        // Get HASS advertise config
        this.getHassConfig = function() {
            let climate = {
                name: node.name,
                unique_id: node.deviceId,
                action_topic: `${node.topic}/action`,
                mode_state_topic: `${node.topic}/mode`,
                mode_command_topic: `${node.topic}/mode/set`,
                preset_mode_state_topic: `${node.topic}/preset`,
                preset_mode_command_topic: `${node.topic}/preset/set`,
                preset_modes: [ presetBoost, presetAway ],
                modes: [ offValue ],
                device: {
                    identifiers: [ node.deviceId ],
                    name: `${node.name} Climate`,
                    model: 'thingZi Climate',
                    sw_version: '1.0',
                    manufacturer: 'thingZi'
                }
            };

            // Add the default preset if its different or not home assistant
            // this is because home assistant implicitly allows 'none' as a preset
            if (node.defaultPreset !== presetNone || node.advertiseType !== advHass) {
                climate.preset_modes.unshift(node.defaultPreset)
            }

            // Add setpoint config
            if (node.hasSetpoint) {
                climate.temperature_state_topic = `${node.topic}/setpoint`; 
                climate.temperature_command_topic = `${node.topic}/setpoint/set`; 
                climate.current_temperature_topic = `${node.topic}/temp`; 
                climate.initial = node.defaultSetPoint;
                climate.max_temp = node.maxTemp;
                climate.min_temp = node.minTemp;
                climate.temp_step = node.degrees === 'C' ? 0.5 : 1;
                climate.temperature_unit = node.degrees;
            }

            // Add climate modes
            if (node.hasAutoMode) climate.modes.push(modeAuto);
            if (node.hasHeating)  climate.modes.push(modeHeat);
            if (node.hasCooling)  climate.modes.push(modeCool);

            return climate;
        }

        // Get value from storage
        this.getValue = function(id) {
            return node.context().get(id);
        }

        // Get value in selected format
        this.getOutput = function(isOn) {

            let value = isOn ? node.onPayload : node.offPayload;
            let type = isOn ? node.onPayloadType : node.offPayloadType;

            if (value === undefined || value.length === 0 || type === undefined || type.length === 0) {
                value = isOn ? 'ON' : 'OFF';
                type = 'str';
            }

            switch (type) {
                case 'json':
                    value = JSON.parse(value);
                    break;
                case 'bool':
                    value = (value === "true");
                    break;
                case 'num':
                    value = parseFloat(value);
                    break;
            }

            return value;
        };

        // Set value for storage (mqtt)
        this.setValue = function(id, v, mv) {
            node.context().set(id, v);
            if (node.mqtt) node.mqtt.setValue(id, mv || v);
        }

        // Clear update
        this.clearUpdateTimeout = function() {
            if (node.updateTimeout) {
                clearTimeout(node.updateTimeout);
                node.updateTimeout = null;
            }
        }

        // Set status message and optionally send via output node
        this.setStatus = function(msg) {
            node.status(msg);
            if (node.sendStatus) {
                node.send([ null, null, { payload: msg }]);
            }
        }

        // Update the node status & send if needed
        this.updateStatus = function(s) {

            let ac = s.pending ? node.lastAction : s.action
            let col = ac === 'heating' ? 'yellow' : ac === 'cooling' ? 'blue' : 'grey';
            let pre = s.pending ? '* ' : ''
            let mode = s.preset === presetBoost ? s.mode + '*' : s.mode;
            let msg = { fill: col, shape:'dot' };

            if (s.action == 'idle') {
                msg.text = `${pre}waiting for temp...`;
            } else {
                if (node.hasSetpoint) {
                    let set = s.preset === presetAway ? 'away' : s.setpoint;
                    msg.text = `${pre}mode=${mode}, set=${set}, temp=${s.temp}`;
                } else {
                    msg.text = `${pre}mode=${mode}`;
                }
                if (node.broker && !node.broker.connected) {
                    msg.text += ', mqtt=offline'
                }
            }

            node.status(msg);
            if (node.sendStatus) {
                node.send([ null, null, { payload: msg, status: s }]);
            }
        }

        // Calculate temperature rate of change (degrees per minute)
        this.calcTempRate = function(temp, now) {
            // Add current reading to history
            node.tempHistory.push({ temp: temp, time: now.valueOf() });

            // Keep only last 5 minutes of readings
            const maxAge = 5 * 60 * 1000;
            node.tempHistory = node.tempHistory.filter(h => now.valueOf() - h.time <= maxAge);

            // Need at least 2 readings for rate calculation
            if (node.tempHistory.length < 2) {
                return 0;
            }

            // Calculate rate from oldest to newest reading
            const oldest = node.tempHistory[0];
            const newest = node.tempHistory[node.tempHistory.length - 1];
            const timeDiffMs = newest.time - oldest.time;

            if (timeDiffMs < 30000) { // Need at least 30 seconds
                return 0;
            }

            // Return rate in degrees per minute
            return (newest.temp - oldest.temp) / (timeDiffMs / 60000);
        }

        // Get auto-tuned values from context
        this.getAutoTuneValues = function() {
            return {
                heating: node.context().get('autoTuneHeating') || { cycles: 0, lags: [], min: null, max: null },
                cooling: node.context().get('autoTuneCooling') || { cycles: 0, lags: [], min: null, max: null }
            };
        }

        // Calculate median of array
        this.calcMedian = function(arr) {
            if (arr.length === 0) return null;
            const sorted = [...arr].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        }

        // Update auto-tune with a completed cycle
        this.updateAutoTune = function(_stopTemp, stopRate, peakTemp, setpoint, cycleType) {
            if (node.thermalLagTune !== 'auto') return;

            // Require minimum rate to avoid bad calculations from short cycles
            const absRate = Math.abs(stopRate);
            if (absRate < node.minAutoTuneRate) {
                node.log(`Auto-tune skipped: rate too low (${absRate.toFixed(3)}°${node.degrees}/min) - need longer ${cycleType} cycle`);
                return;
            }

            let auto = node.getAutoTuneValues();

            if (cycleType === 'heating') {
                // Calculate ideal lag based on overshoot (temp went above setpoint)
                const overshoot = peakTemp - setpoint;
                const idealLagMins = overshoot / stopRate;
                const clampedLag = Math.max(1, Math.min(30, idealLagMins));

                // Update heating data
                let data = auto.heating;
                data.lags.push(clampedLag);
                if (data.lags.length > 5) data.lags.shift(); // Keep last 5
                data.cycles++;
                data.min = data.min === null ? clampedLag : Math.min(data.min, clampedLag);
                data.max = data.max === null ? clampedLag : Math.max(data.max, clampedLag);

                node.context().set('autoTuneHeating', data);
                const median = node.calcMedian(data.lags);
                node.log(`Auto-tune heating cycle ${data.cycles}: overshoot=${overshoot.toFixed(2)}°C, rate=${stopRate.toFixed(3)}°C/min, ideal=${idealLagMins.toFixed(1)}min, median=${median.toFixed(1)}min [${data.lags.map(l => l.toFixed(1)).join(', ')}]`);
            } else if (cycleType === 'cooling') {
                // Calculate ideal lag based on undershoot (temp went below setpoint)
                const undershoot = setpoint - peakTemp;
                const idealLagMins = undershoot / absRate;
                const clampedLag = Math.max(0, Math.min(10, idealLagMins));

                // Update cooling data
                let data = auto.cooling;
                data.lags.push(clampedLag);
                if (data.lags.length > 5) data.lags.shift(); // Keep last 5
                data.cycles++;
                data.min = data.min === null ? clampedLag : Math.min(data.min, clampedLag);
                data.max = data.max === null ? clampedLag : Math.max(data.max, clampedLag);

                node.context().set('autoTuneCooling', data);
                const median = node.calcMedian(data.lags);
                node.log(`Auto-tune cooling cycle ${data.cycles}: undershoot=${undershoot.toFixed(2)}°C, rate=${stopRate.toFixed(3)}°C/min, ideal=${idealLagMins.toFixed(1)}min, median=${median.toFixed(1)}min [${data.lags.map(l => l.toFixed(1)).join(', ')}]`);
            }
        }

        // Get effective thermal lag (auto-tuned if enabled and sufficient cycles)
        this.getEffectiveLagUp = function() {
            if (node.thermalLagTune === 'auto') {
                const auto = node.getAutoTuneValues();
                if (auto.heating.cycles >= 3 && auto.heating.lags.length > 0) {
                    return node.calcMedian(auto.heating.lags) * 60000; // Convert mins to ms
                }
            }
            return node.thermalLagUpMs;
        }

        this.getEffectiveLagDn = function() {
            if (node.thermalLagTune === 'auto') {
                const auto = node.getAutoTuneValues();
                if (auto.cooling.cycles >= 3 && auto.cooling.lags.length > 0) {
                    return node.calcMedian(auto.cooling.lags) * 60000; // Convert mins to ms
                }
            }
            return node.thermalLagDnMs;
        }

        this.calcSetpointAction = function(s, now) {
            // Waiting for input
            if (!s.tempTime || now.diff(s.tempTime) >= node.tempValidMs) {
                return 'idle';
            }

            // Get Current Capability
            let canHeat = node.hasHeating && (s.mode === modeAuto || s.mode === modeHeat);
            let canCool = node.hasCooling && (s.mode === modeAuto || s.mode === modeCool);

            // Calculate temperature rate of change
            const tempRate = node.calcTempRate(s.temp, now);

            // Get effective thermal lag (may be auto-tuned)
            const effectiveLagUpMs = node.getEffectiveLagUp();
            const effectiveLagDnMs = node.getEffectiveLagDn();

            // Predict temperature after thermal lag (different for turn-on vs turn-off)
            let predictedTempOff = s.temp;
            let predictedTempOn = s.temp;
            if (tempRate !== 0) {
                if (effectiveLagUpMs > 0) {
                    predictedTempOff = s.temp + (tempRate * (effectiveLagUpMs / 60000));
                }
                if (effectiveLagDnMs > 0) {
                    predictedTempOn = s.temp + (tempRate * (effectiveLagDnMs / 60000));
                }
            }

            // Currently heating - check if we should turn off
            if (node.lastAction === 'heating' && canHeat) {
                // Turn off when predicted temp reaches setpoint
                if (predictedTempOff >= s.setpoint) {
                    return offValue;
                }
                // Stay heating
                return 'heating';
            }

            // Currently cooling - check if we should turn off
            if (node.lastAction === 'cooling' && canCool) {
                // Turn off when predicted temp reaches setpoint
                if (predictedTempOff <= s.setpoint) {
                    return offValue;
                }
                // Stay cooling
                return 'cooling';
            }

            // Not currently heating/cooling - check if we should turn on
            // Turn heating ON when temp drops to setpoint - tolerance
            // Only consider heating when temp is falling or flat (not rising from coast)
            if (canHeat && tempRate <= 0) {
                const heatThreshold = s.setpoint - node.tolerance;
                const heatCheckTemp = (tempRate < 0 && effectiveLagDnMs > 0) ? predictedTempOn : s.temp;
                if (heatCheckTemp <= heatThreshold) {
                    if (!node.lastCoolTime || now.diff(node.lastCoolTime) >= node.swapDelayMs) {
                        return 'heating';
                    }
                }
            }

            // Turn cooling ON when temp rises to setpoint + tolerance
            // Only consider cooling when temp is rising or flat (not falling from coast)
            if (canCool && tempRate >= 0) {
                const coolThreshold = s.setpoint + node.tolerance;
                const coolCheckTemp = (tempRate > 0 && effectiveLagDnMs > 0) ? predictedTempOn : s.temp;
                if (coolCheckTemp >= coolThreshold) {
                    if (!node.lastHeatTime || now.diff(node.lastHeatTime) >= node.swapDelayMs) {
                        return 'cooling';
                    }
                }
            }

            return offValue;
        }

        // Update the current action
        this.update = function() {
            if (node.starting) {
                return;
            }

            node.clearUpdateTimeout();

            let now = moment();
            let presetExpiry = node.preset.expiry();
            let nextInterval = node.keepAliveMs;

            // End of preset time ?
            if (presetExpiry) {
                let diff = now.diff(presetExpiry);
                if (diff >= 0) {
                    node.preset.set(node.defaultPreset);
                } else if (nextInterval > 0) {
                    nextInterval = Math.min(nextInterval, -diff);
                }
            }

            // Current Status
            let s = {
                mode: node.mode.get(),
                preset: node.preset.get(),
                setpoint: node.setpoint.get(),
                temp: node.temp.get(),
                tempTime: node.temp.time(),
                tolerance: this.tolerance,
                action: offValue,
                changed: false,
                pending: false,
                keepAlive: false
            };

            // Auto-tune: track peak/trough temperature after heating/cooling stops
            if (node.cycleStopTime && s.temp !== undefined) {
                const tempRate = node.calcTempRate(s.temp, now);
                const elapsed = now.valueOf() - node.cycleStopTime;

                if (node.cycleType === 'heating') {
                    // Track peak (max temp) after heating stops
                    if (s.temp > node.cyclePeakTemp) {
                        node.cyclePeakTemp = s.temp;
                    }
                    // Detect peak when rate turns negative or 20 mins elapsed
                    if (tempRate < 0 || elapsed > 20 * 60 * 1000) {
                        node.updateAutoTune(node.cycleStopTemp, node.cycleStopRate, node.cyclePeakTemp, s.setpoint, 'heating');
                        node.cycleStopTime = null;
                    }
                } else if (node.cycleType === 'cooling') {
                    // Track trough (min temp) after cooling stops
                    if (s.temp < node.cyclePeakTemp) {
                        node.cyclePeakTemp = s.temp;
                    }
                    // Detect trough when rate turns positive or 20 mins elapsed
                    if (tempRate > 0 || elapsed > 20 * 60 * 1000) {
                        node.updateAutoTune(node.cycleStopTemp, node.cycleStopRate, node.cyclePeakTemp, s.setpoint, 'cooling');
                        node.cycleStopTime = null;
                    }
                }
            }

            // Use default mode for boosting
            if (s.preset === presetBoost) {
                s.mode = node.defaultMode;
            }

            // Backwards compatibility
            s.boost = node.preset.get() === presetBoost ? s.mode : offValue;

            // Calculate action when setpoint is active
            if (node.hasSetpoint) {
                s.action = node.calcSetpointAction(s, now);
            } else {
                // Manual set
                if (s.mode === modeHeat) s.action = 'heating';
                else if (s.mode ===  modeCool) s.action = 'cooling';
            }

            // Do nothing if away is active
            if (s.preset === presetAway) {
                s.action = offValue;
            }

            // Must be a keep alive or change to send message
            s.changed = s.action != node.lastAction;

            // Check if its time to keep alive
            if (node.lastSend && node.keepAliveMs > 0) {
                let diff = now.diff(node.lastSend);
                if (diff >= node.keepAliveMs) {
                    s.keepAlive = true;
                }
            }

            // Heating / cooling states
            let heating = s.action === 'heating';
            let cooling = s.action === 'cooling';

            // Dont allow changes faster than the cycle time to protect climate systems
            if (s.changed) {
                if (node.lastChange) {
                    let diff = now.diff(node.lastChange);
                    if (diff < node.cycleDelayMs) {
                        s.pending = true;
                        node.updateTimeout = setTimeout(node.update, node.cycleDelayMs - diff);
                        node.updateStatus(s);
                        return;
                    }
                }

                // Store states for future checks
                node.lastChange = now;

                // Auto-tune: track when heating/cooling stops
                if (node.lastAction === 'heating' && s.action !== 'heating') {
                    const tempRate = node.calcTempRate(s.temp, now);
                    node.cycleStopTemp = s.temp;
                    node.cycleStopRate = tempRate;
                    node.cycleStopTime = now.valueOf();
                    node.cyclePeakTemp = s.temp;
                    node.cycleType = 'heating';
                } else if (node.lastAction === 'cooling' && s.action !== 'cooling') {
                    const tempRate = node.calcTempRate(s.temp, now);
                    node.cycleStopTemp = s.temp;
                    node.cycleStopRate = tempRate;
                    node.cycleStopTime = now.valueOf();
                    node.cyclePeakTemp = s.temp;
                    node.cycleType = 'cooling';
                }

                node.lastAction = s.action;
                node.setValue('action', s.action);
                node.setValue('heating', heating);
                node.setValue('cooling', cooling);

                // Update last heat/cool time
                if (heating || node.lastAction === 'heating') node.lastHeatTime = now;
                if (cooling || node.lastAction === 'cooling') node.lastCoolTime = now;
            }

            // Send a message
            if (s.changed || s.keepAlive) {
                node.lastSend = now;
                node.setValue('action', s.action);
                node.setValue('heating', heating);
                node.setValue('cooling', cooling);
                node.send([ 
                    { payload: node.getOutput(heating) }, 
                    { payload: node.getOutput(cooling) } 
                ]);
            }

            // Update status
            node.updateStatus(s);

            // Make sure update is called every so often
            if (nextInterval > 0) {
                // Adjust interval based on last change
                if (node.lastSend) {
                    let diff = now.diff(node.lastSend);
                    nextInterval = Math.max(nextInterval - diff, 1);
                }

                nextInterval = Math.min(node.tempValidMs, nextInterval);
                nextInterval = Math.max(1000, nextInterval);
                node.updateTimeout = setTimeout(function() { node.update() }, nextInterval);
            }
        }

        function isOn(v) {
            return v === 'on' || v === 'ON' || v === '1' || v === 1 || v === 'true' || v === 'TRUE' || v === true;
        }

        function isOff(v) {
            return v === 'off' || v === 'OFF' || v === '0' || v === 0 || v === 'false' || v === 'FALSE' || v === false;
        }

        // Mode
        function modeStore() {
            this.get = function() {
                let m = node.getValue('mode');
                return m === undefined || !this.valid(m) ? offValue : m;
            };
            this.set = function(s) {
                if (s !== undefined) {
                    s = s.toString().toLowerCase();
                    if (isOn(s)) {
                        node.setValue('mode', node.defaultMode);
                    } else if (isOff(s)) {
                        node.setValue('mode', offValue);
                    } else if (this.valid(s)) {
                        node.setValue('mode', s);
                    } 
                }
            };
            this.valid = function name(v) {
                return v === offValue || (v === modeAuto && node.hasAutoMode) || 
                    (v === modeCool && node.hasCooling) || (v === modeHeat && node.hasHeating);
            }
        };

        // Preset
        function presetStore() {
            this.get = function() { 
                let b = node.getValue('preset');
                if (b !== node.defaultPreset && b !== presetBoost && b !== presetAway && b !== presetNone) {
                    return node.defaultPreset;
                }
                return b === undefined ? node.defaultPreset : b;
            };
            this.expiry = function() { 
                let t = node.context().get('presetExpiry'); 
                return t ? moment(t) : undefined;
            };
            this.set = function(s) {
                if (s !== undefined) {
                    s = s.toString().toLowerCase();
                    let before = this.get();
                    if (s === node.defaultPreset || isOff(s)) {
                        node.setValue('preset', node.defaultPreset);
                        node.setValue('presetExpiry', undefined);
                    } else if (s === presetBoost) {
                        node.setValue('preset', presetBoost);
                        if (this.get() != before) {
                            node.context().set('presetExpiry', moment().add(node.boostDurationMins,'minutes').valueOf());
                        }
                    } else if (s === presetAway) {
                        node.setValue('preset', presetAway);
                        node.setValue('presetExpiry', undefined);
                    }
                }
            };
        };

        // Setpoint
        function setpointStore() {
            this.get = function() { 
                let s = node.getValue('setpoint');
                return s === undefined ? node.defaultSetPoint : s; 
            };
            this.set = function(s) {
                if (s && node.hasSetpoint) { 
                    let t = parseFloat(s);
                    if (!isNaN(t)) {
                        t = Math.min(Math.max(t, node.minTemp), node.maxTemp);
                        node.setValue('setpoint', t);
                    }
                }
            };
        };

        // Temp
        function tempStore() {
            this.get = function() { 
                let t = node.getValue('temp');
                return t;
            };
            this.time = function() { 
                let t = node.getValue('tempTime'); 
                return t ? moment(t) : undefined;
            };
            this.set = function(s) {
                if (s !== undefined && node.hasSetpoint) { 
                    let t = parseFloat(s);
                    if (!isNaN(t)) {
                        node.setValue('temp', t);
                        node.setValue('tempTime', moment().valueOf());
                    }
                }
            };
        };

        // Init Things
        node.mode = new modeStore();
        node.preset = new presetStore();
        node.setpoint = new setpointStore();
        node.temp = new tempStore();

        // If a broker is specified we create an mqtt handler
        if (node.broker && node.topic) {
            switch (node.advertiseType) {
                case advNone:
                    node.mqtt = new mqtt(node.deviceId, node.topic, node.broker, node);
                    break;
                case advThingzi:
                    let tztopic = `discovery/nodered/${node.deviceId}/config`;
                    node.mqtt = new mqtt(node.deviceId, node.topic, node.broker, node, tztopic, node.getThingziConfig());
                    break;
                case advHass:
                    let hatopic = `homeassistant/climate/${node.deviceId}/climate/config`;
                    node.mqtt = new mqtt(node.deviceId, node.topic, node.broker, node, hatopic, node.getHassConfig());
                    break;
            }
        }

        // Initial update
        node.setStatus({fill:'grey', shape:'dot', text:'starting...'});
        setTimeout(function() { 
            node.starting = false;
            node.update();
            node.lastChange = null;
            if (node.mqtt) {
                node.mqtt.setValue('mode', node.mode.get());
                node.mqtt.setValue('preset', node.preset.get());
                if (node.hasSetpoint) {
                    node.mqtt.setValue('setpoint', node.setpoint.get());
                    node.mqtt.setValue('temp', node.temp.get());
                }
                node.mqtt.status();
            }
        }, 1000);
    });
}
