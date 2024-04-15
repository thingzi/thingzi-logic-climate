// Advertise over mqtt
module.exports = function(id, topic, broker, listener, advtopic, advconfig) {
    'use strict'
    let adv = this;

    this.id = id;
    this.topic = topic;
    this.broker = broker;
    this.listener = listener;
    this.advtopic = advtopic;
    this.advconfig = advconfig;
    this.connected = false;
    this.started = true;
    this.queued = {};

    // Clean up
    this.stop = function(done) {
        if (adv.started) {
            adv.broker.unsubscribe(adv.topic + '/#', adv.id, true);
            adv.broker.deregister(this, done);
            adv.started = false;
            adv.listener = undefined;
        }
    }

    // Handle incoming messages
    this.message = function(topic, payload, packet) {
        let parts = topic.split('/');
        let len = parts.length  

        // Check that its a valid request
        if (len >= 2 && parts[len-1] === 'set') {
            adv.listener?.onMqttSet(parts[len-2], payload.toString());
        }
    }

    // Listen for changes to status and look at connection state
    this.status = function() {
        var con = adv.broker.connected;
        if (con != adv.connected) {
            if (con) {
                // Advertise if set
                if (adv.advtopic && adv.advconfig) {
                    adv.listener?.onMqttInfo(`Advertise on '${adv.advtopic}'...`);
                    adv.broker.publish({ topic: adv.advtopic, payload: adv.advconfig, retain: true, qos: 1 }, function(err) {
                        if(err && err.warn) {
                            adv.listener?.onMqttWarn(err);
                        }
                    });
                } else {
                    adv.listener?.onMqttInfo(`Advertisement disabled`);
                }

                // Queued items
                for (const id in adv.queued) {
                    if (adv.queued.hasOwnProperty(id)) {
                        adv.broker.publish({ topic: `${adv.topic}/${id}`, payload: adv.queued[id], retain: true, qos: 1 }, function(err) {
                            if(err && err.warn) {
                                adv.listener?.onMqttWarn(err);
                            }
                        });
                    }
                }

                adv.queued = {};
            }
            
            adv.connected = con;
            adv.listener?.onMqttConnect(con);
        }
    }
    
    this.setValue = function(id, value) {
        if (value !== undefined) {
            if (adv.connected) {
                adv.broker.publish({ topic: `${adv.topic}/${id}`, payload: value, retain: true, qos: 1 }, function(err) {
                    if(err && err.warn) {
                        adv.listener?.onMqttWarn(err);
                    }
                });
            } else {
                adv.queued[id] = value;
            }
        }
    }

    // Initial set up
    adv.broker.register(this);
    adv.broker.subscribe(adv.topic + '/#', 1, adv.message, adv.id);
}
