/**
 * src/notifications/RadioAlert.js
 *
 * Triggers radio alert tones for critical events via a serial-connected radio.
 * Each event type maps to a distinct DTMF tone sequence that guards can
 * recognize without looking at a screen.
 *
 * Tone mapping (DTMF sequences — standard telephone keypad tones):
 *   INBOUND_CROSSING      → '123'    (3 short beeps)
 *   OUTBOUND_CROSSING    → '1234'   (4 short beeps)
 *   CAMERA_TAMPER_*      → '999'    (continuous alert — distinct emergency tone)
 *   UNKNOWN_VEHICLE       → '77'     (double beep)
 *   BLACKLISTED_VEHICLE   → '99'     (double long beep)
 *   RUNNING_DETECTED     → '147'    (running pattern)
 *   CROWD_SURGE          → '1477'   (crowd alarm)
 *
 * Tone sequences are played over the serial port as raw ASCII characters
 * to a radio PTT (Push-To-Talk) trigger circuit or DTMF encoder.
 *
 * Environment variables:
 *   RADIO_SERIAL_PORT — e.g. /dev/ttyUSB0 or COM3 (leave blank to disable)
 *   RADIO_SERIAL_BAUD — e.g. 9600
 *   RADIO_TONE_INBOUND  — DTMF sequence for inbound crossing (default: 123)
 *   RADIO_TONE_OUTBOUND — DTMF sequence for outbound crossing (default: 1234)
 *   RADIO_TONE_CRITICAL — DTMF sequence for critical events (default: 999)
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// DTMF frequency map (for generating tones via serial if needed)
// ---------------------------------------------------------------------------

const DTMF_FREQUENCIES = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '0': [941, 1336], '*': [941, 1209], '#': [941, 1477],
};

// ---------------------------------------------------------------------------
// RadioAlert
// ---------------------------------------------------------------------------

export class RadioAlert extends EventEmitter {
  constructor() {
    super();

    this._port = process.env.RADIO_SERIAL_PORT || '';
    this._baud = Number.parseInt(process.env.RADIO_SERIAL_BAUD ?? '9600', 10);
    this._enabled = Boolean(this._port);

    // Default tone sequences — override via env
    this._TONE_MAP = {
      INBOUND_CROSSING: process.env.RADIO_TONE_INBOUND || '123',
      OUTBOUND_CROSSING: process.env.RADIO_TONE_OUTBOUND || '1234',
      CAMERA_TAMPER_FREEZE: '999',
      CAMERA_TAMPER_DARKNESS: '999',
      CAMERA_TAMPER_OBSTRUCTED: '999',
      CAMERA_TAMPER_OVEREXPOSURE: '999',
      UNKNOWN_VEHICLE: '77',
      BLACKLISTED_VEHICLE: '99',
      WATCHLIST_PERSON: '77',
      RUNNING_DETECTED: '147',
      CROWD_SURGE: '1477',
      CLIMBING_DETECTED: '159',
      OBJECT_LEFT_BEHIND: '5',
    };

    this._serial = null;
    this._initPromise = null;

    if (this._enabled) {
      this._initPromise = this._initSerial();
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Fires the radio tone sequence for the given event type.
   * @param {object} details
   * @param {string} details.eventType
   * @param {string} [details.cameraId]
   * @param {string} [details.trackId]
   * @returns {Promise<{sent: boolean, reason?: string}>}
   */
  async sendAlert(details) {
    if (!this._enabled) {
      return { sent: false, reason: 'radio_not_configured' };
    }

    const eventType = details.eventType;
    const tone = this._TONE_MAP[eventType];

    if (!tone) {
      return { sent: false, reason: 'no_tone_mapping' };
    }

    await this._initPromise;

    if (!this._serial || !this._serial.isOpen) {
      return { sent: false, reason: 'serial_not_open' };
    }

    return this._playTone(tone);
  }

  // -------------------------------------------------------------------------
  // Serial setup
  // -------------------------------------------------------------------------

  async _initSerial() {
    if (!this._enabled) return;

    try {
      const { SerialPort } = await import('serialport').catch(() => {
        throw new Error('serialport package not installed');
      });

      this._serial = new SerialPort({
        path: this._port,
        baudRate: this._baud,
      });

      await new Promise((resolve, reject) => {
        this._serial.open((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      console.log(`[IBVAP][RadioAlert] Serial port open on ${this._port}`);
    } catch (err) {
      console.error(`[IBVAP][RadioAlert] Failed to open serial port: ${err.message}`);
      this._enabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Tone playback
  // -------------------------------------------------------------------------

  /**
   * Sends a DTMF tone sequence over the serial port.
   * Each character is sent as-is; a radio/DTMF encoder at the other end
   * converts it to the actual tone.
   *
   * @param {string} tone - e.g. '1234'
   */
  async _playTone(tone) {
    return new Promise((resolve) => {
      const serial = this._serial;
      if (!serial || !serial.isOpen) {
        resolve({ sent: false, reason: 'serial_not_open' });
        return;
      }

      // Send each digit with a brief inter-digit gap
      let index = 0;
      const sendNext = () => {
        if (index >= tone.length) {
          resolve({ sent: true });
          return;
        }
        const digit = tone[index];
        serial.write(digit, (err) => {
          if (err) {
            resolve({ sent: false, reason: err.message });
            return;
          }
          index += 1;
          setTimeout(sendNext, 150); // 150ms between digits
        });
      };

      sendNext();
    });
  }

  /**
   * Closes the serial connection.
   */
  close() {
    if (this._serial) {
      this._serial.close();
      this._serial = null;
    }
  }
}

export default RadioAlert;
