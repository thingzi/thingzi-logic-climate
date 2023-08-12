module.exports = function(RED) {
    'use strict'
    const moment = require('moment');
    const mqtt = require('./mqtt');

    const offValue = 'off';
    const boostValue = 'boost';
    const awayValue = 'away';

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
        this.defaultPreset = config.defaultPreset || 'none';

        this.log('default preset = ' + this.defaultPreset);

        // Set Point
        this.degrees = config.degrees;
        this.defaultSetPoint = parseFloat(config.defaultSetPoint);
        this.tolerance = parseFloat(config.tolerance);
        this.minTemp = parseFloat(config.minTemp);
        this.maxTemp = parseFloat(config.maxTemp);
        this.tempValidMs = parseFloat(config.tempValid) * 1000 * 60; //< mins to ms
        this.swapDelayMs = parseFloat(config.swapDelay) * 1000 * 60; //< mins to ms
        
        // Outputs
        this.onPayload = config.onPayload;
        this.onPayloadType = config.onPayloadType;
        this.offPayload = config.offPayload;
        this.offPayloadType = config.offPayloadType;

        // Advertising
        this.advertise = config.advertise;
        this.broker = RED.nodes.getNode(config.broker);
        this.topic = config.topic ? `${config.topic.toLowerCase().trim('/')}/${this.deviceId}` : null;

        // Capabilities
        this.hasHeating = config.climateType === 'both' || config.climateType === 'heat' || config.climateType === 'manual';
        this.hasCooling = config.climateType === 'both' || config.climateType === 'cool' || config.climateType === 'manual';
        this.hasSetpoint = config.climateType !== 'manual';

        // Default mode when on value or boost is used
        this.defaultMode = 'heat';
        if (config.climateType === 'both') {
            this.defaultMode = 'auto';
        } else if (config.climateType === 'cool') {
            this.defaultMode = 'cool';
        }

        // Previous state
        this.lastChange = null;
        this.lastAction = null;
        this.lastTemp = null;
        this.lastHeatTime = null;
        this.lastCoolTime = null;
        this.lastSend = null;

        // Handle direct inputs
        this.on("input", function(msg, send, done) {
            if (msg.hasOwnProperty('payload')) { node.mode.set(msg.payload); }
            if (msg.hasOwnProperty('mode')) { node.mode.set(msg.mode); }
            if (msg.hasOwnProperty('preset')) { node.preset.set(msg.preset); }
            if (msg.hasOwnProperty('setpoint')) { node.setpoint.set(msg.setpoint); }
            if (msg.hasOwnProperty('temp')) { node.temp.set(msg.temp); }

            // Backwards compatibility
            if (msg.hasOwnProperty('boost')) { node.preset.set(isOn(msg.boost) ? boostValue : node.defaultPreset); }
            if (msg.hasOwnProperty('away')) { node.preset.set(isOn(msg.away) ? awayValue : node.defaultPreset); }

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

        // On mqtt message
        this.onMqttSet = function (type, value) {
            if (type === 'mode') { node.mode.set(value); }
            if (type === 'preset') { node.preset.set(value); }
            if (type === 'setpoint') { node.setpoint.set(value); }

            node.update();
        }

        // On mqtt advertise
        this.onMqttConnect = function() {
            let device = {
                identifiers: [ node.deviceId ],
                name: `${node.name} Climate`,
                model: 'thingZi Climate',
                sw_version: '1.0',
                manufacturer: 'thingZi'
            };

            let climate = {
                name: node.name,
                unique_id: node.deviceId,
                action_topic: `${node.topic}/action`,
                mode_state_topic: `${node.topic}/mode`,
                mode_command_topic: `${node.topic}/mode/set`,
                preset_mode_state_topic: `${node.topic}/preset`,
                preset_mode_command_topic: `${node.topic}/preset/set`,
                preset_modes: [ node.defaultPreset, boostValue, awayValue ],
                modes: [ offValue ],
                device: device
            };

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

                if (node.hasCooling && node.hasHeating) 
                    climate.modes.push('auto');
            }

            // Add climate modes
            if (node.hasHeating) climate.modes.push('heat');
            if (node.hasCooling) climate.modes.push('cool');

            return [
                { type: 'climate', payload: climate }
            ];
        }

        // Get value from storage
        this.getValue = function(id) {
            return node.context().get(id);
        }

        // Get value in selected format
        this.getOutput = function(isOn) {

            let value = isOn ? node.onPayload : node.offPayload;
            let type = isOn ? node.onPayloadType : node.offPayloadType;

            if (value === undefined || value.length == 0 || type === undefined || type.length == 0) {
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
            let mode = s.preset === boostValue ? s.mode + '*' : s.mode;
            let msg = { fill: col, shape:'dot' };

            if (s.action == 'idle') {
                msg.text = `${pre}waiting for temp...`;
            } else if (node.hasSetpoint) {
                let set = s.preset === awayValue ? 'away' : s.setpoint;
                msg.text = `${pre}mode=${mode}, set=${set}, temp=${s.temp}`;
            } else {
                msg.text = `${pre}mode=${mode}`;
            }
            
            node.status(msg);
            if (node.sendStatus) {
                node.send([ null, null, { payload: msg, status: s }]);
            }
        }

        this.calcSetpointAction = function(s, now) {

            // Waiting for input
            if (!s.tempTime || now.diff(s.tempTime) >= node.tempValidMs) {
                return 'idle';
            }

            // Get Current Capability
            let canHeat = node.hasHeating && (s.mode === 'auto' || s.mode === 'heat');
            let canCool = node.hasCooling && (s.mode === 'auto' || s.mode === 'cool');
            
            // Use direction of temperature change to improve calculation and reduce ping pong effect
            let isTempRising = node.lastTemp ? s.temp - node.lastTemp > 0.01 : false;
            let isTempFalling = node.lastTemp ? s.temp - node.lastTemp < -0.01 : false;
            let heatPoint = isTempFalling ? s.setpoint + node.tolerance : s.setpoint - node.tolerance;
            let coolPoint = isTempRising ? s.setpoint - node.tolerance : s.setpoint + node.tolerance;

            // Store last temp
            node.lastTemp = s.temp;

            // Calculate what to do based on temp, setpoint and other settings.
            if (canHeat && s.temp < heatPoint) {
                if (!node.lastCoolTime || now.diff(node.lastCoolTime) >= node.swapDelayMs ) {
                    return 'heating';
                }
            } else if (canCool && s.temp > coolPoint) {
                if (!node.lastHeatTime || now.diff(node.lastHeatTime) >= node.swapDelayMs) {
                    return 'cooling';
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
                action: offValue,
                changed: false,
                pending: false,
                keepAlive: false
            };

            // Use default mode for boosting
            if (s.preset === boostValue) {
                s.mode = node.defaultMode;
            }

            // Backwards compatibility
            s.boost = node.preset.get() === boostValue ? s.mode : offValue;

            // Calculate action when setpoint is active
            if (node.hasSetpoint) {
                s.action = node.calcSetpointAction(s, now);
            } else {
                // Manual set
                if (s.mode === 'heat') s.action = 'heating';
                else if (s.mode ===  'cool') s.action = 'cooling';
            }

            // Do nothing if away is active
            if (s.preset === awayValue) {
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
                node.lastAction = s.action;
                node.setValue('action', s.action);

                // Update last heat/cool time
                if (heating || s.lastAction === 'heating') node.lastHeatTime = now;
                if (cooling || s.lastAction === 'cooling') node.lastCoolTime = now;
            }

            // Send a message
            if (s.changed || s.keepAlive) {
                node.lastSend = now;
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
                return m === undefined ? offValue : m;
            };
            this.set = function(s) {
                if (s !== undefined) {
                    s = s.toString().toLowerCase();
                    if (isOn(s)) {
                        node.setValue('mode', node.defaultMode);
                    } else if (isOff(s)) {
                        node.setValue('mode', offValue);
                    } else if ((s === 'auto' && node.hasSetpoint) || (s === 'heat' && node.hasHeating) || (s === 'cool' && node.hasCooling)) {
                        node.setValue('mode', s);
                    } 
                }
            };
        };

        // Preset
        function presetStore() {
            this.get = function() { 
                let b = node.getValue('preset');
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
                    } else if (s === boostValue) {
                        node.setValue('preset', boostValue);
                        if (this.get() != before) {
                            node.context().set('presetExpiry', moment().add(node.boostDurationMins,'minutes').valueOf());
                        }
                    } else if (s === awayValue) {
                        node.setValue('preset', awayValue);
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
            node.mqtt = new mqtt(node.deviceId, node.advertise, node.topic, node.broker, node.onMqttConnect, node.onMqttSet);
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
            }
        }, 1000);
    });
}
