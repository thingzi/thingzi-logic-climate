Supports heating and cooling logic for zone based climate control systems. Centralise HVAC & hot water control to node red, removing the need for complex and expensive hardware controllers.  

Create as many zones as needed and link to your own control panels via smart home system.  Obviously, you will still need switches and thermostats to physically control your systems but these can now be much simpler devices controlled via node red.

Note that scheduling is intentionally not part of the climate node to maximise re-use.  Nodes such as <https://flows.nodered.org/node/thingzi-logic-timers> can be easily linked to inputs providing full management of schedules.  This supports the use case where one schedule controls many zones.

### Features

- Decides when to heat or cool based on current & target temperatures.
- Multiple ways to configure e.g. heating only, cooling only, both heat & cool or manual control.
- Control current program with "away" & "boost" presets.
- Integration with MQTT and/or homeassistant.
- Safety cut out when temperature readings are stale (when setpoint is active).
- Configure minimum cycle time to protect equipment from rapid changes of state.
- Manual control for simpler use cases e.g. hot water timers that do not need a setpoint but require keep alive or boost functionality.
- Optional node status output to aid with debugging or deeper integration.

Ive used this logic at home for years in conjunction with zwave thermostats, thermostatic radiator valves (switched via sonoff basic) & underfloor heating to create per room/zone temperature management on a budget :).  

<i>Disclaimer</i>. Please note that these nodes are virtual and you alone are responsible for ensuring the safety of any equipment you connect.

If you like/use this node, coffee makes me happy and it keeps me coding when i should be sleeping...

<a href="https://www.buymeacoffee.com/thingzi" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 50px !important;width: 200px !important;" ></a>

Releases
https://github.com/thingzi/thingzi-logic-climate/releases