# Select a method to advertise the node for use in smart home systems

* Status: accepted
* Deciders: Bryan
* Date: 08/08/2020

## Context and Problem Statement

To be easily integrated with smart home systems the node should be able to advertise itself for auto discovery.  
There are a few approaches to achieve this

## Decision Drivers

* Easy to implement and consume
* Works over MQTT
* Popular and well maintained

## Considered Options

* Homeassistant (https://www.home-assistant.io/integrations/mqtt/)
* Homie (https://homieiot.github.io/)

## Decision Outcome

Overall Homie looks much more thought out and flexible as a protocol, however it lacks real popularity and traction.  
The Homeassistant protocol, while clunky is well maintained and is *very* popular.  Based on popularity alone Homeassistant 
is the best choice although in future i may look to support Matter (when im ready) in addition to this.
