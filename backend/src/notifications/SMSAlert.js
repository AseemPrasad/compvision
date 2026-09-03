/**
 * src/notifications/SMSAlert.js
 *
 * Sends SMS alerts via two fallback mechanisms:
 *   Mode A — SMS Gateway API (HTTP): Twilio, MSG91, etc.
 *   Mode B — GSM Modem (Serial): SIM7600-style USB modem via AT commands
 *
 * If neither is available, returns { sent: false, reason }.
 * Alerts are sent for P0_CRITICAL and P1_HIGH priority events by default.
 *
 * Environment variables:
 *   SMS_PROVIDER       — 'gateway' or 'gsmmodem' (default: 'gateway')
 *   SMS_GATEWAY_URL    — HTTP POST URL for SMS gateway
 *   SMS_GATEWAY_API_KEY
 *   SMS_GATEWAY_API_SECRET
 *   SMS_FROM_NUMBER
 *   GSM_MODEM_PORT     — e.g. /dev/ttyUSB0 or COM3
 *   GSM_MODEM_BAUD
 *   ALERT_PHONE_NUMBERS — comma-separated list
 *   SMS_INCLUDE_MEDIUM — if 'true', also send SMS for P2_MEDIUM events
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// SMSAlert
// ---------------------------------------------------------------------------

export class SMSAlert extends EventEmitter {
  constructor() {
    super();

    this._provider = process.env.SMS_PROVIDER || 'gateway';
    this._gatewayUrl = process.env.SMS_GATEWAY_URL || '';
    this._gatewayApiKey = process.env.SMS_GATEWAY_API_KEY || '';
    this._gatewayApiSecret = process.env.SMS_GATEWAY_API_SECRET || '';
    this._fromNumber = process.env.SMS_FROM_NUMBER || '';

    this._gsmPort = process.env.GSM_MODEM_PORT || '';
    this._gsmBaud = Number.parseInt(process.env.GSM_MODEM_BAUD ?? '115200', 10);

    this._phoneNumbers = (process.env.ALERT_PHONE_NUMBERS || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    this._includeMedium = process.env.SMS_INCLUDE_MEDIUM === 'true';

    this._gsmSerial = null;
    this._gsmReady = false;
    this._gsmInitPromise = null;

    this._cooldownMap = new Map();
    this._COOLDOWN_MS = 60000; // 1 minute between SMS to same event type
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Sends an SMS for the given event if it meets priority criteria.
   * @param {object} details
   * @param {string} details.eventType
   * @param {string} details.cameraId
   * @param {string} [details.trackId]
   * @param {string} [details.zoneName]
   * @param {string} [details.severity]
   * @param {string} details.timestamp
   * @returns {Promise<{sent: boolean, reason?: string}>}
   */
  async sendAlert(details) {
    if (!this._phoneNumbers.length) {
      return { sent: false, reason: 'no_phone_numbers_configured' };
    }

    if (!this._shouldSendSMS(details.eventType)) {
      return { sent: false, reason: 'priority_too_low' };
    }

    if (this._isOnCooldown(details.eventType)) {
      return { sent: false, reason: 'cooldown' };
    }

    const message = this._buildMessage(details);
    const result = await this._sendToAll(message);

    if (result.sent) {
      this._setCooldown(details.eventType);
    }

    return result;
  }

  /**
   * Initializes the GSM modem (mode B). Safe to call multiple times —
   * returns the existing promise if already initializing.
   */
  async initGSMModem() {
    if (this._provider !== 'gsmmodem' || !this._gsmPort) return;

    if (this._gsmInitPromise) return this._gsmInitPromise;

    this._gsmInitPromise = this._initModem();
    return this._gsmInitPromise;
  }

  // -------------------------------------------------------------------------
  // Priority filtering
  // -------------------------------------------------------------------------

  _shouldSendSMS(eventType) {
    const CRITICAL = [
      'CAMERA_TAMPER_FREEZE', 'CAMERA_TAMPER_DARKNESS', 'CAMERA_TAMPER_OBSTRUCTED',
      'CAMERA_TAMPER_OVEREXPOSURE', 'INBOUND_CROSSING_NIGHT', 'BLACKLISTED_VEHICLE',
    ];
    const HIGH = [
      'INBOUND_CROSSING', 'OUTBOUND_CROSSING', 'UNKNOWN_VEHICLE', 'WATCHLIST_PERSON',
      'RUNNING_DETECTED', 'CLIMBING_DETECTED', 'CROWD_SURGE', 'OBJECT_LEFT_BEHIND',
      'CRAWLING_DETECTED',
    ];

    if (CRITICAL.includes(eventType)) return true;
    if (HIGH.includes(eventType)) return true;
    if (this._includeMedium) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Message construction
  // -------------------------------------------------------------------------

  _buildMessage(details) {
    const parts = [
      `[IBVAP] ${details.eventType}`,
      `Camera: ${details.cameraId}`,
    ];
    if (details.trackId) parts.push(`Track: ${details.trackId}`);
    if (details.zoneName) parts.push(`Zone: ${details.zoneName}`);
    if (details.severity) parts.push(`Sev: ${details.severity}`);
    parts.push(`Time: ${details.timestamp}`);

    // SMS character limit is ~160, so truncate if needed
    const msg = parts.join(' | ');
    return msg.length > 160 ? msg.substring(0, 157) + '...' : msg;
  }

  // -------------------------------------------------------------------------
  // Send (tries gateway first, falls back to modem)
  // -------------------------------------------------------------------------

  async _sendToAll(message) {
    let result = { sent: false, reason: 'no_provider_configured' };

    if (this._provider === 'gateway' && this._gatewayUrl) {
      result = await this._sendViaGateway(message);
    }

    if (!result.sent && this._provider === 'gsmmodem') {
      result = await this._sendViaGSMModem(message);
    }

    return result;
  }

  // ---- SMS Gateway (HTTP) ------------------------------------------------

  async _sendViaGateway(message) {
    if (!this._gatewayUrl) return { sent: false, reason: 'no_gateway_url' };

    try {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this._gatewayApiKey}`,
      };

      const results = await Promise.allSettled(
        this._phoneNumbers.map(async (phone) => {
          const body = JSON.stringify({
            to: phone,
            from: this._fromNumber,
            body: message,
          });

          const resp = await fetch(this._gatewayUrl, {
            method: 'POST',
            headers,
            body,
          });

          if (!resp.ok) {
            throw new Error(`Gateway returned ${resp.status}`);
          }
          return true;
        }),
      );

      const allSent = results.every((r) => r.status === 'fulfilled');
      return { sent: allSent, reason: allSent ? undefined : 'some_numbers_failed' };
    } catch (err) {
      console.error(`[IBVAP][SMSAlert] Gateway error: ${err.message}`);
      return { sent: false, reason: err.message };
    }
  }

  // ---- GSM Modem (AT commands) -------------------------------------------

  async _sendViaGSMModem(message) {
    // Lazy-init the modem
    await this.initGSMModem();

    if (!this._gsmReady || !this._gsmSerial) {
      return { sent: false, reason: 'gsm_modem_not_ready' };
    }

    try {
      for (const phone of this._phoneNumbers) {
        await this._gsmSendSMS(phone, message);
      }
      return { sent: true };
    } catch (err) {
      console.error(`[IBVAP][SMSAlert] GSM modem error: ${err.message}`);
      return { sent: false, reason: err.message };
    }
  }

  async _gsmSendSMS(phoneNumber, message) {
    return new Promise((resolve, reject) => {
      const serial = this._gsmSerial;
      if (!serial) return reject(new Error('GSM serial not open'));

      let response = '';
      const timeout = setTimeout(() => {
        serial.removeAllListeners('data');
        reject(new Error('GSM command timeout'));
      }, 15000);

      serial.on('data', (chunk) => {
        response += chunk.toString();
        if (response.includes('>')) {
          // Modem is waiting for SMS body
          serial.write(message + '\x1a', () => {
            // Ctrl+Z to send
          });
        }
        if (response.includes('+CMS ERROR') || response.includes('+CMGS:')) {
          clearTimeout(timeout);
          serial.removeAllListeners('data');
          if (response.includes('+CMGS:')) {
            resolve();
          } else {
            reject(new Error(response.trim()));
          }
        }
      });

      serial.write(`AT+CMGS="${phoneNumber}"\r`);
    });
  }

  async _initModem() {
    try {
      // Dynamic import — serialport is an optional dependency
      const { SerialPort } = await import('serialport').catch(() => {
        throw new Error('serialport package not installed');
      });

      this._gsmSerial = new SerialPort({
        path: this._gsmPort,
        baudRate: this._gsmBaud,
      });

      await new Promise((resolve, reject) => {
        this._gsmSerial.open((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Initialize modem
      await this._gsmCommand('AT');
      await this._gsmCommand('AT+CMGF=1'); // SMS text mode
      await this._gsmCommand('AT+CSCS="GSM"');
      await this._gsmCommand('AT+CSMP=17,0,2,0'); // Store and forward

      this._gsmReady = true;
      console.log(`[IBVAP][SMSAlert] GSM modem ready on ${this._gsmPort}`);
    } catch (err) {
      console.error(`[IBVAP][SMSAlert] GSM modem init failed: ${err.message}`);
      this._gsmReady = false;
    }
  }

  async _gsmCommand(cmd) {
    return new Promise((resolve, reject) => {
      const serial = this._gsmSerial;
      if (!serial) return reject(new Error('Serial not open'));

      let response = '';
      const timeout = setTimeout(() => {
        serial.removeAllListeners('data');
        reject(new Error(`Command timeout: ${cmd}`));
      }, 10000);

      serial.on('data', (chunk) => {
        response += chunk.toString();
        if (response.includes('OK') || response.includes('ERROR')) {
          clearTimeout(timeout);
          serial.removeAllListeners('data');
          if (response.includes('OK')) resolve(response);
          else reject(new Error(response.trim()));
        }
      });

      serial.write(`${cmd}\r`);
    });
  }

  // -------------------------------------------------------------------------
  // Cooldown helpers
  // -------------------------------------------------------------------------

  _isOnCooldown(eventType) {
    const last = this._cooldownMap.get(eventType);
    if (!last) return false;
    return Date.now() - last < this._COOLDOWN_MS;
  }

  _setCooldown(eventType) {
    this._cooldownMap.set(eventType, Date.now());
  }

  /**
   * Closes the GSM serial connection.
   */
  close() {
    if (this._gsmSerial) {
      this._gsmSerial.close();
      this._gsmSerial = null;
      this._gsmReady = false;
    }
  }
}

export default SMSAlert;
