// Advertise over mqtt
module.exports = function(id, advertise, topic, broker, onadvertise, onset) {
    'use strict'
    const isUtf8 = require('is-utf8');
    let adv = this;

    this.id = id;
    this.advertise = advertise;
    this.topic = topic;
    this.broker = broker;
    this.onadvertise = onadvertise;
    this.onset = onset;

    this.root = 'homeassistant';
    this.connected = false;
    this.started = true;
    this.queued = {};

    // Clean up
    this.stop = function(done) {
        if (adv.started) {
            adv.broker.unsubscribe(adv.topic + '/#', adv.id, true);
            adv.broker.deregister(this, done);
            adv.started = false;
        }
    }

    // Handle incoming messages
    this.message = function(topic, payload, packet) {
        let parts = topic.split('/');
        let len = parts.length  

        // Check that its a valid request
        if (len >= 2 && parts[len-1] === 'set' && isUtf8(payload)) {
            adv.onset(parts[len-2], payload.toString());
        }
    }

    // Listen for changes to status and look at connection state
    this.status = function(s) {
        var con = adv.broker.connected;
        if (con != adv.connected) {
            if (con) {
                // HASS advertising
                let entities = adv.onadvertise();
                if (entities) {
                    for (const entity of entities) {
                        adv.broker.publish({ 
                            topic:`${adv.root}/${entity.type}/${adv.id}/${entity.type}/config`,
                            payload: adv.advertise ? entity.payload : '',
                            retain: true,
                            qos: 1
                        });
                    }
                }

                // Queued items
                for (const id in adv.queued) {
                    if (adv.queued.hasOwnProperty(id)) {
                        adv.broker.publish({ topic: `${adv.topic}/${id}`, payload: adv.queued[id], retain: true, qos: 1 });
                    }
                }

                adv.queued = {};
            }
            
            adv.connected = con;
        }
    }
    
    this.setValue = function(id, value) {
        if (value !== undefined) {
            if (adv.connected) {
                adv.broker.publish({ topic: `${adv.topic}/${id}`, payload: value, retain: true, qos: 1 });
            } else {
                adv.queued[id] = value;
            }
        }
    }

    // Initial set up
    adv.broker.register(this);
    adv.broker.subscribe(adv.topic + '/#', 1, adv.message, adv.id);
}
