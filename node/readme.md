Supports heating and cooling logic for zone based climate control systems. Centralise HVAC & hot water control to node red, removing the need for complex and expensive hardware controllers.  

Create as many zones as needed and link to your own control panels via smart home system.  Obviously, you will still need switches and thermostats to physically control your systems but these can now be much simpler devices controlled via node red.

Note that scheduling is intentionally not part of the climate node to maximise re-use.  Nodes such as <https://flows.nodered.org/node/thingzi-logic-timers> can be easily linked to inputs providing full management of schedules.  This supports the use case where one schedule controls many zones.

### Features

- Decides when to heat or cool based on current & target temperatures.
- Multiple ways to configure e.g. heating only, cooling only, both heat & cool or manual control.
- Integration with MQTT and/or homeassistant.
- Safety cut out when temperature readings are stale (when setpoint is active).
- Configure minimum cycle time to protect equipment from rapid changes of state.
- Manual control for simpler use cases e.g. hot water timers that do not need a setpoint but require keep alive or boost functionality.
- Optional node status output to aid with debugging or deeper integration.

Ive used this logic at home for years in conjunction with zwave thermostats, thermostatic radiator valves (switched via sonoff basic) & underfloor heating to create per room/zone temperature management on a budget :).  

<i>Disclaimer</i>. Please note that these nodes are virtual and you alone are responsible for ensuring the safety of any equipment you connect.

If you like/use this node, coffee makes me happy and it keeps me coding when i should be sleeping...

<a href="https://www.buymeacoffee.com/thingzi" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 50px !important;width: 200px !important;" ></a>

<h2>Release Notes</h1>

<b>0.4.0</b>

- Fix mqtt exception on reconnect
- No code changes, updated package links for github
- Fix package dependencies for moment and is_utf8
- Fix error when selected heat & cool with mqtt

<b>0.3.5</b>

- When passing "ON" to mode via payload or mode topic a sensible default is used insted of always using "HEAT".  Previously using ON would allow setting the mode to heat when the climate control was configured for cooling only.

<b>0.3.4</b>

- Fixed boost timeout issue

<b>0.3.3</b>

- Fixed broken file dependency

<b>0.3.0</b>

- Added optional MQTT support to replicate the climate controller to an MQTT broker.
- Added advertising of the climate controller via homeassistant MQTT protocol.  This allows easier integration with any smart home system that supports the homeassistant protocol.
- Added more configuration options to set temperature scale & set point limits.
- Removed 'power' input and replaced with 'away' to more closely match thermostat away modes.

<b>0.2.1</b>

- Merged the climate node with hot water node.  Climate was already a superset of hot water and it was difficult to maintain both.  Main climate node functionality & behavior remains backwards compatible.
- Added configurable climate boost.  Note that this accepts a mode to 'boost' for a period of time set in config.  Once the time expires it will return to the normal 'mode'.
- Breaking - Removed hot water node, instead please use the climate node using the 'manual' setting for similar functionality.

<b>0.1.2</b>

- Added optional status output from climate node.  Useful for debugging or passing out of a sub flow.

<b>0.1.1</b>

- Changed payload input for climate to be the mode.  Essentially the schedule should set 'mode' so ive made this the default payload.  Note that passing 'on' will be mapped to 'auto'.
- Added input for climate 'power', which will enable or disable the zone irrespective of 'mode'.  This can be used as an override for nodes on a schedule. e.g. for a guest room you don't use much but enable it when you have visitors.

<b>0.0.4</b>

- Documentation update.
- Add boost output from hot water node.

<b>0.0.1</b>

- 1st release, climate and hot water control nodes.
- Released for testing purposes.