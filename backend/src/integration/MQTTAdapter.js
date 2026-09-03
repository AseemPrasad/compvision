/**
 * src/integration/MQTTAdapter.js
 *
 * Publishes IBVAP events to an MQTT broker so that distributed C2 clients can
 * subscribe and receive real-time alerts.
 *
 * Usage:
 *   const mqtt = new MQTTAdapter();
 *   await mqtt.connect();
 *   await mqtt.publish(event);
 *
 * Environment variables:
 *   MQTT_BROKER_URL     — e.g. mqtt://broker.example.gov.in:1883 (leave blank to disable)
 *   MQTT_USERNAME
 *   MQTT_PASSWORD
 *   MQTT_TOPIC_PREFIX   — default: 'ibvap/events'
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// MQTTAdapter
// ---------------------------------------------------------------------------

export class MQTTAdapter extends EventEmitter {
  constructor() {
    super();
    this._brokerUrl = process.env.MQTT_BROKER_URL || '';
    this._username = process.env.MQTT_USERNAME || '';
    this._password = process.env.MQTT_PASSWORD || '';
    this._topicPrefix = process.env.MQTT_TOPIC_PREFIX || 'ibvap/events';
    this._client = null;
    this._connected = false;
    this._pendingMessages = [];

    if (!this._brokerUrl) {
      this._disabled = true;
    }
  }

  /**
   * Attempts to connect to the MQTT broker. Safe to call even when disabled —
   * it will resolve without doing anything.
   */
  async connect() {
    if (this._disabled) return;

    try {
      // Dynamically import mqtt — it's an optional dependency
      const mqtt = await import('mqtt').catch(() => null);
      if (!mqtt) {
        console.warn('[IBVAP][MQTTAdapter] mqtt package not installed — MQTT disabled');
        this._disabled = true;
        return;
      }

      const options = {
        username: this._username || undefined,
        password: this._password || undefined,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
        keepalive: 60,
      };

      this._client = mqtt.connect(this._brokerUrl, options);

      this._client.on('connect', () => {
        this._connected = true;
        console.log(`[IBVAP][MQTTAdapter] Connected to broker: ${this._brokerUrl}`);
        this._flushPending();
      });

      this._client.on('error', (err) => {
        console.error(`[IBVAP][MQTTAdapter] Broker error: ${err.message}`);
        this._connected = false;
      });

      this._client.on('close', () => {
        this._connected = false;
      });

      this._client.on('reconnect', () => {
        console.log('[IBVAP][MQTTAdapter] Reconnecting to broker...');
      });
    } catch (err) {
      console.error(`[IBVAP][MQTTAdapter] Failed to initialize MQTT: ${err.message}`);
      this._disabled = true;
    }
  }

  /**
   * Publishes an event to the MQTT broker.
   * If not connected yet, the message is queued and sent on reconnect.
   *
   * @param {object} event
   * @returns {Promise<boolean>}
   */
  async publish(event) {
    if (this._disabled || !this._brokerUrl) return false;

    const eventType = event.event_type || event.eventType || 'UNKNOWN';
    const topic = `${this._topicPrefix}/${eventType}`;
    const payload = JSON.stringify(event);

    const message = { topic, payload };

    if (!this._connected || !this._client) {
      // Queue up to 50 pending messages
      if (this._pendingMessages.length < 50) {
        this._pendingMessages.push(message);
      }
      return false;
    }

    return new Promise((resolve) => {
      this._client.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) {
          console.error(`[IBVAP][MQTTAdapter] Publish failed for ${topic}: ${err.message}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  _flushPending() {
    if (!this._connected || !this._client) return;
    while (this._pendingMessages.length > 0) {
      const msg = this._pendingMessages.shift();
      this._client.publish(msg.topic, msg.payload, { qos: 1 });
    }
  }

  /**
   * Gracefully disconnects from the MQTT broker.
   */
  disconnect() {
    if (this._client) {
      this._client.end();
      this._client = null;
      this._connected = false;
    }
  }

  get isConnected() {
    return this._connected && !this._disabled;
  }

  get isEnabled() {
    return !this._disabled;
  }
}

export default MQTTAdapter;
