/**
 * src/integration/C2Webhook.js
 *
 * Sends IBVAP events to external Command & Control systems via HTTP POST
 * webhooks. Each event fires an HTTP request to all configured webhook URLs
 * with a GeoJSON-compatible payload.
 *
 * Usage:
 *   const c2 = new C2Webhook();
 *   c2.broadcast(eventPayload);
 *
 * Environment variables:
 *   C2_WEBHOOK_URLS    — comma-separated list of webhook URLs
 *   C2_WEBHOOK_INCLUDE_SNAPSHOT — if 'true', includes base64 snapshot (default: false)
 *   C2_WEBHOOK_TIMEOUT_MS      — request timeout in ms (default: 5000)
 */

import fs from 'node:fs';

// ---------------------------------------------------------------------------
// C2Webhook
// ---------------------------------------------------------------------------

export class C2Webhook {
  constructor() {
    this._urls = this._parseUrls();
    this._timeout = Number.parseInt(process.env.C2_WEBHOOK_TIMEOUT_MS ?? '5000', 10);
    this._includeSnapshot = process.env.C2_WEBHOOK_INCLUDE_SNAPSHOT === 'true';
  }

  _parseUrls() {
    const env = process.env.C2_WEBHOOK_URLS || '';
    return env
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
  }

  /**
   * Builds a GeoJSON-compatible feature payload from an IBVAP event.
   * @param {object} event
   */
  _formatPayload(event) {
    const feature = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [
          event.details?.groundPoint?.[0] ?? 0,
          event.details?.groundPoint?.[1] ?? 0,
        ],
      },
      properties: {
        eventId: event.event_id || event.eventId || null,
        eventType: event.event_type || event.eventType || event.eventType,
        cameraId: event.camera_id || event.cameraId,
        trackId: event.track_id || event.trackId || null,
        zoneId: event.zone_id || event.zoneId || null,
        zoneName: event.zone_name || event.zoneName || null,
        severity: event.severity || 'INFO',
        riskScore: event.risk_score ?? event.riskScore ?? 0,
        explanation: event.explanation || (event.details?.explanation || []),
        behaviorType: event.behavior_type || event.behaviorType || null,
        tamperType: event.tamper_type || event.tamperType || null,
        timestamp: event.timestamp || null,
        source: 'IBVAP',
        version: '1.0',
      },
    };

    // Optionally attach snapshot
    if (this._includeSnapshot && event.snapshotPath) {
      try {
        const snapshotData = fs.readFileSync(event.snapshotPath);
        feature.properties.snapshotBase64 = snapshotData.toString('base64');
        feature.properties.snapshotFilename = event.snapshotPath.split('/').pop();
      } catch {
        // Snapshot file not accessible — skip
      }
    }

    return feature;
  }

  /**
   * Broadcasts an event to all configured webhook URLs.
   * Resolves after all requests complete; failures are logged but do not throw.
   *
   * @param {object} event
   * @returns {Promise<Array<{url: string, sent: boolean, status?: number, error?: string}>>}
   */
  async broadcast(event) {
    if (!this._urls.length) return [];

    const payload = this._formatPayload(event);
    const body = JSON.stringify(payload);

    const results = await Promise.allSettled(
      this._urls.map(async (url) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this._timeout);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'IBVAP/1.0',
              'X-IBVAP-Event': event.event_type || event.eventType || 'UNKNOWN',
              'X-IBVAP-Severity': event.severity || 'INFO',
            },
            body,
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (!response.ok) {
            console.warn(`[IBVAP][C2Webhook] ${url} returned ${response.status}`);
          }

          return { url, sent: response.ok, status: response.status };
        } catch (err) {
          clearTimeout(timeout);
          const reason = err.name === 'AbortError' ? 'timeout' : err.message;
          console.error(`[IBVAP][C2Webhook] Failed to send to ${url}: ${reason}`);
          return { url, sent: false, error: reason };
        }
      }),
    );

    return results.map((r) => {
      if (r.status === 'fulfilled') return r.value;
      return { url: 'unknown', sent: false, error: String(r.reason) };
    });
  }

  /**
   * Re-reads C2_WEBHOOK_URLS from env. Call this after updating the env var
   * if you need to add/remove webhook URLs at runtime.
   */
  refresh() {
    this._urls = this._parseUrls();
    console.log(`[IBVAP][C2Webhook] Refreshed — ${this._urls.length} webhook URL(s) configured`);
  }
}

export default C2Webhook;
