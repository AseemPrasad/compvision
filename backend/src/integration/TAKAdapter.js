/**
 * src/integration/TAKAdapter.js
 *
 * Sends Cursor on Target (COT) messages to Team Awareness Kit (ATAK/WinTAK)
 * military radio networks. COT is the standard XML message format used by
 * ATAK, WinTAK, and other NATO/coalition situational awareness systems.
 *
 * Events are converted to COT point events and sent as UDP multicast datagrams
 * to the configured TAK multicast address.
 *
 * Environment variables:
 *   TAK_ENABLED         — set to 'true' to enable
 *   TAK_MULTICAST_ADDR — ATAK multicast address (default: 224.0.0.2)
 *   TAK_MULTICAST_PORT — ATAK multicast port (default: 6969)
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// TAK / COT event type mapping
// ---------------------------------------------------------------------------

const COT_EVENT_TYPES = {
  INBOUND_CROSSING: { type: 'a-f-G-U-C', name: 'Inbound Crossing', stability: 'persist' },
  OUTBOUND_CROSSING: { type: 'a-f-G-U-C', name: 'Outbound Crossing', stability: 'persist' },
  UNKNOWN_VEHICLE: { type: 'a-f-G-E-V', name: 'Unknown Vehicle', stability: 'p' },
  BLACKLISTED_VEHICLE: { type: 'a-h-G-E-V', name: 'Blacklisted Vehicle', stability: 'p' },
  WATCHLIST_PERSON: { type: 'a-h-G-U-C', name: 'Watchlist Person', stability: 'p' },
  UNKNOWN_PERSON: { type: 'a-f-G-U-C', name: 'Unknown Person', stability: 'p' },
  RUNNING_DETECTED: { type: 'a-f-G-U-C', name: 'Running Person', stability: 'p' },
  CRAWLING_DETECTED: { type: 'a-f-G-U-C', name: 'Crawling Person', stability: 'p' },
  CLIMBING_DETECTED: { type: 'a-f-G-U-C', name: 'Climbing Attempt', stability: 'p' },
  CROWD_SURGE: { type: 'b-m-p-s', name: 'Crowd Surge', stability: 'p' },
  OBJECT_LEFT_BEHIND: { type: 'a-f-G-U-S', name: 'Object Left Behind', stability: 'p' },
  CAMERA_TAMPER_FREEZE: { type: 'a-f-A-F-C', name: 'Camera Freeze', stability: 'p' },
  CAMERA_TAMPER_DARKNESS: { type: 'a-f-A-F-C', name: 'Camera Darkness', stability: 'p' },
  CAMERA_TAMPER_OVEREXPOSURE: { type: 'a-f-A-F-C', name: 'Camera Overexposure', stability: 'p' },
  CAMERA_TAMPER_OBSTRUCTED: { type: 'a-f-A-F-C', name: 'Camera Obstructed', stability: 'p' },
};

const DEFAULT_COT = { type: 'a-f-G-U-C', name: 'IBVAP Event', stability: 'p' };

// ---------------------------------------------------------------------------
// TAKAdapter
// ---------------------------------------------------------------------------

export class TAKAdapter extends EventEmitter {
  constructor() {
    super();
    this._enabled = process.env.TAK_ENABLED === 'true';
    this._multicastAddr = process.env.TAK_MULTICAST_ADDR || '224.0.0.2';
    this._multicastPort = Number.parseInt(process.env.TAK_MULTICAST_PORT ?? '6969', 10);
    this._socket = null;

    if (!this._enabled) return;

    this._socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this._socket.on('error', (err) => {
      console.error(`[IBVAP][TAKAdapter] Socket error: ${err.message}`);
    });

    this._socket.bind(() => {
      try {
        this._socket.addMembership(this._multicastAddr);
        this._socket.setMulticastTTL(2);
        console.log(`[IBVAP][TAKAdapter] Enabled — multicasting COT to ${this._multicastAddr}:${this._multicastPort}`);
      } catch (err) {
        console.error(`[IBVAP][TAKAdapter] Failed to join multicast: ${err.message}`);
      }
    });
  }

  /**
   * Converts an IBVAP event to a COT XML message and sends it as a UDP datagram.
   *
   * @param {object} event
   * @returns {Promise<boolean>}
   */
  async sendCOT(event) {
    if (!this._enabled || !this._socket) return false;

    const xml = this._buildCOT(event);

    return new Promise((resolve) => {
      this._socket.send(
        xml,
        this._multicastPort,
        this._multicastAddr,
        (err) => {
          if (err) {
            console.error(`[IBVAP][TAKAdapter] COT send failed: ${err.message}`);
            resolve(false);
          } else {
            resolve(true);
          }
        },
      );
    });
  }

  /**
   * Builds a COT XML message from an IBVAP event.
   * Uses pixel-space coordinates as a proxy; in a real deployment these would
   * be mapped to geo-coordinates using camera calibration.
   */
  _buildCOT(event) {
    const now = new Date();
    const stale = new Date(now.getTime() + 300000); // 5 min stale

    const eventType = event.event_type || event.eventType || 'UNKNOWN';
    const cotDef = COT_EVENT_TYPES[eventType] || DEFAULT_COT;

    const cameraId = event.camera_id || event.cameraId || 'UNKNOWN';
    const trackId = event.track_id || event.trackId || '';
    const severity = event.severity || 'INFO';

    // Pixel coords as a stand-in; in production these would be geo-coords
    const px = event.groundPoint?.[0] ?? 0;
    const py = event.groundPoint?.[1] ?? 0;

    // Simplified lat/lon from pixel coords for demo — would come from camera calibration in production
    const lat = 28.6139 + (py / 10000); // placeholder geo mapping
    const lon = 77.2090 + (px / 10000);

    const uid = `IBVAP-${cameraId}-${trackId || eventType}-${now.getTime()}`;
    const callsign = `IBVAP_${cameraId}_${trackId || eventType}`;

    const riskScore = event.risk_score ?? event.riskScore ?? 0;
    const detailLines = [];
    if (event.explanation && Array.isArray(event.explanation)) {
      detailLines.push(...event.explanation);
    }
    if (severity) detailLines.push(`Severity: ${severity}`);
    if (riskScore) detailLines.push(`Risk: ${riskScore}/100`);
    if (trackId) detailLines.push(`Track: ${trackId}`);
    const detail = detailLines.join(' | ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0"
  uid="${uid}"
  type="${cotDef.type}"
  time="${this._cotTime(now)}"
  start="${this._cotTime(now)}"
  stale="${this._cotTime(stale)}"
  how="m-g"
  lat="${lat.toFixed(6)}"
  lon="${lon.toFixed(6)}">
  <detail>
    <contact callsign="${callsign}" />
    <uid DAGR="${uid}" />
    <remarks source="IBVAP">${this._escapeXml(detail)}</remarks>
    <status readiness="true" />
  </detail>
</event>`;
  }

  _cotTime(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  _escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Closes the UDP socket.
   */
  close() {
    if (this._socket) {
      this._socket.close();
      this._socket = null;
    }
  }
}

export default TAKAdapter;
