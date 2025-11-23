'use strict';

/**
 * Auto-tune module for thermal lag prediction
 * Learns optimal thermal lag values from heating/cooling cycles
 */

class AutoTune {
    constructor(node) {
        this.node = node;

        // Cycle tracking
        this.cycleStopRate = null;
        this.cycleStopTime = null;
        this.cyclePeakTemp = null;
        this.cycleType = null; // 'heating', 'cooling', 'ambient-heat', 'ambient-cool'
    }

    /**
     * Calculate median of array
     */
    calcMedian(arr) {
        if (arr.length === 0) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Get auto-tuned values from context
     */
    getValues() {
        const node = this.node;
        const defaultData = { cycles: 0, lags: [], min: null, max: null };

        // Load heating data (off = turn-off prediction, on = turn-on prediction)
        let heating = node.context().get('autoTuneHeating');
        heating = heating || { off: { ...defaultData }, on: { ...defaultData } };
        // Ensure structure has both keys
        if (!heating.off) heating.off = { ...defaultData };
        if (!heating.on) heating.on = { ...defaultData };

        // Load cooling data (off = turn-off prediction, on = turn-on prediction)
        let cooling = node.context().get('autoTuneCooling');
        cooling = cooling || { off: { ...defaultData }, on: { ...defaultData } };
        // Ensure structure has both keys
        if (!cooling.off) cooling.off = { ...defaultData };
        if (!cooling.on) cooling.on = { ...defaultData };

        return { heating, cooling };
    }

    /**
     * Update auto-tune with a completed cycle
     */
    update(stopRate, peakTemp, setpoint, cycleType) {
        const node = this.node;
        if (node.thermalLagTune !== 'auto') return;

        // Require minimum rate to avoid bad calculations from short cycles
        const absRate = Math.abs(stopRate);
        if (absRate < node.minAutoTuneRate) {
            node.debug(`Auto-tune skipped: rate too low (${absRate.toFixed(3)}°${node.degrees}/min) - need longer ${cycleType} cycle`);
            return;
        }

        let auto = this.getValues();

        if (cycleType === 'heating') {
            // Lag Off: Calculate ideal lag based on overshoot (temp went above setpoint after heating stopped)
            const overshoot = peakTemp - setpoint;
            const idealLagMins = overshoot / stopRate;
            const clampedLag = Math.max(1, Math.min(30, idealLagMins));

            // Update heating off data
            let data = auto.heating.off;
            data.lags.push(clampedLag);
            if (data.lags.length > 5) data.lags.shift(); // Keep last 5
            data.cycles++;
            data.min = data.min === null ? clampedLag : Math.min(data.min, clampedLag);
            data.max = data.max === null ? clampedLag : Math.max(data.max, clampedLag);

            node.context().set('autoTuneHeating', auto.heating);
            const median = this.calcMedian(data.lags);
            node.log(`Auto-tune heating-off cycle ${data.cycles}: overshoot=${overshoot.toFixed(2)}°${node.degrees}, rate=${stopRate.toFixed(3)}°${node.degrees}/min, ideal=${idealLagMins.toFixed(1)}min, median=${median.toFixed(1)}min [${data.lags.map(l => l.toFixed(1)).join(', ')}]`);
        } else if (cycleType === 'cooling') {
            // Lag Off: Calculate ideal lag based on undershoot (temp went below setpoint after cooling stopped)
            const undershoot = setpoint - peakTemp;
            const idealLagMins = undershoot / absRate;
            const clampedLag = Math.max(1, Math.min(30, idealLagMins));

            // Update cooling off data
            let data = auto.cooling.off;
            data.lags.push(clampedLag);
            if (data.lags.length > 5) data.lags.shift(); // Keep last 5
            data.cycles++;
            data.min = data.min === null ? clampedLag : Math.min(data.min, clampedLag);
            data.max = data.max === null ? clampedLag : Math.max(data.max, clampedLag);

            node.context().set('autoTuneCooling', auto.cooling);
            const median = this.calcMedian(data.lags);
            node.log(`Auto-tune cooling-off cycle ${data.cycles}: undershoot=${undershoot.toFixed(2)}°${node.degrees}, rate=${absRate.toFixed(3)}°${node.degrees}/min, ideal=${idealLagMins.toFixed(1)}min, median=${median.toFixed(1)}min [${data.lags.map(l => l.toFixed(1)).join(', ')}]`);
        } else if (cycleType === 'ambient-cool') {
            // Lag On for heating: Calculate ideal lag based on undershoot (temp dropped below threshold before heating started)
            const threshold = setpoint - node.tolerance;
            const undershoot = threshold - peakTemp;
            const idealLagMins = undershoot / absRate;
            const clampedLag = Math.max(0, Math.min(10, idealLagMins));

            // Update heating on data
            let data = auto.heating.on;
            data.lags.push(clampedLag);
            if (data.lags.length > 5) data.lags.shift(); // Keep last 5
            data.cycles++;
            data.min = data.min === null ? clampedLag : Math.min(data.min, clampedLag);
            data.max = data.max === null ? clampedLag : Math.max(data.max, clampedLag);

            node.context().set('autoTuneHeating', auto.heating);
            const median = this.calcMedian(data.lags);
            node.log(`Auto-tune heating-on cycle ${data.cycles}: undershoot=${undershoot.toFixed(2)}°${node.degrees}, rate=${absRate.toFixed(3)}°${node.degrees}/min, ideal=${idealLagMins.toFixed(1)}min, median=${median.toFixed(1)}min [${data.lags.map(l => l.toFixed(1)).join(', ')}]`);
        } else if (cycleType === 'ambient-heat') {
            // Lag On for cooling: Calculate ideal lag based on overshoot (temp rose above threshold before cooling started)
            const threshold = setpoint + node.tolerance;
            const overshoot = peakTemp - threshold;
            const idealLagMins = overshoot / absRate;
            const clampedLag = Math.max(0, Math.min(10, idealLagMins));

            // Update cooling on data
            let data = auto.cooling.on;
            data.lags.push(clampedLag);
            if (data.lags.length > 5) data.lags.shift(); // Keep last 5
            data.cycles++;
            data.min = data.min === null ? clampedLag : Math.min(data.min, clampedLag);
            data.max = data.max === null ? clampedLag : Math.max(data.max, clampedLag);

            node.context().set('autoTuneCooling', auto.cooling);
            const median = this.calcMedian(data.lags);
            node.log(`Auto-tune cooling-on cycle ${data.cycles}: overshoot=${overshoot.toFixed(2)}°${node.degrees}, rate=${absRate.toFixed(3)}°${node.degrees}/min, ideal=${idealLagMins.toFixed(1)}min, median=${median.toFixed(1)}min [${data.lags.map(l => l.toFixed(1)).join(', ')}]`);
        }
    }

    /**
     * Get effective thermal lag for heating turn-off
     */
    getEffectiveLagOffHeating() {
        const node = this.node;
        if (node.thermalLagTune === 'auto') {
            const auto = this.getValues();
            if (auto.heating.off.cycles >= 3 && auto.heating.off.lags.length > 0) {
                return this.calcMedian(auto.heating.off.lags) * 60000; // Convert mins to ms
            }
        }
        return node.thermalLagOffMs;
    }

    /**
     * Get effective thermal lag for cooling turn-off
     */
    getEffectiveLagOffCooling() {
        const node = this.node;
        if (node.thermalLagTune === 'auto') {
            const auto = this.getValues();
            if (auto.cooling.off.cycles >= 3 && auto.cooling.off.lags.length > 0) {
                return this.calcMedian(auto.cooling.off.lags) * 60000; // Convert mins to ms
            }
        }
        return node.thermalLagOffMs;
    }

    /**
     * Get effective thermal lag for heating turn-on (ambient cooling)
     */
    getEffectiveLagOnHeating() {
        const node = this.node;
        if (node.thermalLagTune === 'auto') {
            const auto = this.getValues();
            if (auto.heating.on.cycles >= 3 && auto.heating.on.lags.length > 0) {
                return this.calcMedian(auto.heating.on.lags) * 60000; // Convert mins to ms
            }
        }
        return node.thermalLagOnMs;
    }

    /**
     * Get effective thermal lag for cooling turn-on (ambient heating)
     */
    getEffectiveLagOnCooling() {
        const node = this.node;
        if (node.thermalLagTune === 'auto') {
            const auto = this.getValues();
            if (auto.cooling.on.cycles >= 3 && auto.cooling.on.lags.length > 0) {
                return this.calcMedian(auto.cooling.on.lags) * 60000; // Convert mins to ms
            }
        }
        return node.thermalLagOnMs;
    }

    /**
     * Track peak/trough temperature after heating/cooling changes
     * Call this in the update loop with current temp and setpoint
     */
    trackCycle(temp, setpoint, tempRate, now) {
        if (this.cycleStopTime === null) return;

        const elapsed = now.valueOf() - this.cycleStopTime;

        if (this.cycleType === 'heating') {
            // Track peak (max temp) after heating stops
            if (temp > this.cyclePeakTemp) {
                this.cyclePeakTemp = temp;
            }
            // Detect peak when rate turns negative or 20 mins elapsed
            if (tempRate < 0 || elapsed > 20 * 60 * 1000) {
                this.update(this.cycleStopRate, this.cyclePeakTemp, setpoint, 'heating');
                this.cycleStopTime = null;
            }
        } else if (this.cycleType === 'cooling') {
            // Track trough (min temp) after cooling stops
            if (temp < this.cyclePeakTemp) {
                this.cyclePeakTemp = temp;
            }
            // Detect trough when rate turns positive or 20 mins elapsed
            if (tempRate > 0 || elapsed > 20 * 60 * 1000) {
                this.update(this.cycleStopRate, this.cyclePeakTemp, setpoint, 'cooling');
                this.cycleStopTime = null;
            }
        } else if (this.cycleType === 'ambient-cool') {
            // Track trough (min temp) before heating started - continue tracking briefly
            if (temp < this.cyclePeakTemp) {
                this.cyclePeakTemp = temp;
            }
            // Detect trough when rate turns positive (heating taking effect) or 10 mins elapsed
            if (tempRate > 0 || elapsed > 10 * 60 * 1000) {
                this.update(this.cycleStopRate, this.cyclePeakTemp, setpoint, 'ambient-cool');
                this.cycleStopTime = null;
            }
        } else if (this.cycleType === 'ambient-heat') {
            // Track peak (max temp) before cooling started - continue tracking briefly
            if (temp > this.cyclePeakTemp) {
                this.cyclePeakTemp = temp;
            }
            // Detect peak when rate turns negative (cooling taking effect) or 10 mins elapsed
            if (tempRate < 0 || elapsed > 10 * 60 * 1000) {
                this.update(this.cycleStopRate, this.cyclePeakTemp, setpoint, 'ambient-heat');
                this.cycleStopTime = null;
            }
        }
    }

    /**
     * Record when heating/cooling action changes for cycle tracking
     */
    recordActionChange(lastAction, newAction, temp, tempRate, now) {
        // Track when heating/cooling stops (for Lag Off)
        if (lastAction === 'heating' && newAction !== 'heating') {
            this.cycleStopRate = tempRate;
            this.cycleStopTime = now.valueOf();
            this.cyclePeakTemp = temp;
            this.cycleType = 'heating';
        } else if (lastAction === 'cooling' && newAction !== 'cooling') {
            this.cycleStopRate = tempRate;
            this.cycleStopTime = now.valueOf();
            this.cyclePeakTemp = temp;
            this.cycleType = 'cooling';
        }
        // Track when heating/cooling starts from idle (for Lag On)
        else if (lastAction !== 'heating' && newAction === 'heating') {
            // Only track if temperature was actually falling (ambient cooling)
            if (tempRate < 0) {
                this.cycleStopRate = tempRate;
                this.cycleStopTime = now.valueOf();
                this.cyclePeakTemp = temp;
                this.cycleType = 'ambient-cool';
            }
        } else if (lastAction !== 'cooling' && newAction === 'cooling') {
            // Only track if temperature was actually rising (ambient heating)
            if (tempRate > 0) {
                this.cycleStopRate = tempRate;
                this.cycleStopTime = now.valueOf();
                this.cyclePeakTemp = temp;
                this.cycleType = 'ambient-heat';
            }
        }
    }
}

module.exports = AutoTune;
