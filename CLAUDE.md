# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node-RED node package (`thingzi-logic-climate`) that provides climate control logic for zone-based HVAC systems. It centralizes heating/cooling control in Node-RED, eliminating the need for complex hardware controllers.

## Development

### Installation for Development

```bash
cd node
npm install
```

### Testing in Node-RED

Link the node to your local Node-RED installation:
```bash
cd ~/.node-red
npm link /path/to/thingzi-logic-climate/node
```

Restart Node-RED to see changes.

### Publishing

The package is published from the `node/` directory, not the root.

## Architecture

### Core Files

- **node/climate.js** - Main node logic implementing the climate controller
- **node/mqtt.js** - MQTT handler for broker communication and Home Assistant/thingZi discovery
- **node/climate.html** - Node-RED editor UI configuration

### Climate Modes and States

The node supports multiple climate types configured via `climateType`:
- `heat` - Heating only
- `cool` - Cooling only
- `both` - Heating and cooling with auto mode
- `manual` - Direct on/off control without setpoint

Operating modes: `off`, `heat`, `cool`, `auto`
Presets: `none`, `boost`, `away`
Actions: `off`, `heating`, `cooling`, `idle`

### MQTT Discovery

Three advertising types (`advertiseType`):
- `none` - MQTT state only, no discovery
- `hass` - Home Assistant MQTT discovery (topic: `homeassistant/climate/{deviceId}/climate/config`)
- `thingzi` - thingZi discovery (topic: `discovery/nodered/{deviceId}/config`)

### State Management

The node uses Node-RED context storage for persisting state between deployments. Key stored values:
- `mode`, `preset`, `setpoint`, `temp`, `tempTime`, `action`, `presetExpiry`, `heating`, `cooling`

State is synchronized to MQTT topics under `{topic}/{deviceId}/{property}`.

For thingZi discovery, additional binary properties `heating` and `cooling` are published to indicate current output states.

### Input Message Properties

- `payload` or `mode` - Set mode
- `preset` - Set preset (none/boost/away)
- `setpoint` - Target temperature
- `temp` - Current temperature reading
- `tolerance` - Temperature tolerance override
- `boost`/`away` - Legacy preset toggles

### Output Behavior

- Output 1: Heating signal (configurable payload)
- Output 2: Cooling signal (configurable payload)
- Output 3 (optional): Status messages for debugging

### Safety Features

- `tempValidMs` - Temperature reading staleness timeout
- `cycleDelayMs` - Minimum time between state changes
- `swapDelayMs` - Delay between heating/cooling mode swaps
- `keepAliveMs` - Periodic output refresh interval
