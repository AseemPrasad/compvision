/**
 * src/analytics/AnalyticsEngine.js
 *
 * Orchestrates the two heavy per-entity analytics subsystems (ANPR, Face
 * Recognition) plus the Night & Loitering rule, and normalizes their output
 * into IBVAP event payloads. Deliberately decoupled from VisionEngine and
 * SpatialEngine — it only reacts to `tracks` + `frameBuffer` handed to it by
 * server.js's per-frame pipeline, communicating outward purely via events.
 *
 * CPU-friendly throttling: heavy analytics (Tesseract OCR, face descriptor
 * extraction) only run on frames flagged `isAnalyticsFrame` by VisionEngine
 * (every ANALYTICS_FRAME_INTERVAL frames), never on every frame.
 */

import { EventEmitter } from 'node:events';
import { AnprService } from './AnprService.js';
import { FaceService } from './FaceService.js';
import { isNightTimeIST, getISTTimestamp, diffSeconds, nowIST } from '../utils/timeUtils.js';

const LOITERING_THRESHOLD_SECONDS = Number.parseInt(
  process.env.LOITERING_THRESHOLD_SECONDS ?? '45',
  10,
);

// ANPR multi-frame consensus: rather than trusting a single OCR pass (which
// is fragile for a moving vehicle — motion blur can wreck any one frame's
// reading), we accumulate readings across several analytics-eligible
// frames per vehicle track and only lock in a final plate once either the
// same plausible plate has been read multiple times, or we've spent our
// attempt budget and pick the best single reading we got. This works
// equally well for a stopped vehicle (which just reaches consensus faster,
// since consecutive reads tend to agree immediately) and a moving one
// (which gets several independent looks before we commit).
const PLATE_CONSENSUS_COUNT = Number.parseInt(process.env.ANPR_CONSENSUS_COUNT ?? '2', 10);
const PLATE_MAX_ATTEMPTS = Number.parseInt(process.env.ANPR_MAX_ATTEMPTS ?? '5', 10);

/**
 * AnalyticsEngine
 *
 * Events emitted:
 *   'ready'              -> {}
 *   'VEHICLE_CHECKED'    -> { cameraId, trackId, label, plate details, attemptsUsed, timestamp }
 *                           Emitted ONCE per vehicle track, after multi-frame
 *                           ANPR consensus finalizes (see PLATE_CONSENSUS_COUNT
 *                           / PLATE_MAX_ATTEMPTS below) — not on every frame.
 *   'PERSON_IDENTIFIED'  -> { cameraId, trackId, label, match details, timestamp }
 *   'LOITERING_DETECTED' -> { cameraId, trackId, dwellSeconds, timestamp }
 *   'error'              -> { cameraId, message }
 */
export class AnalyticsEngine extends EventEmitter {
  constructor() {
    super();
    this.anpr = new AnprService();
    this.face = new FaceService();

    // Track first-seen timestamps per (cameraId, trackId) for loitering/dwell.
    /** @type {Map<string, {firstSeen: import('luxon').DateTime, lastAlerted: number}>} */
    this._trackDwell = new Map();

    // ANPR consensus state per (cameraId, trackId). Cleared once a track
    // stops appearing in the active tracks list (same lifecycle pattern as
    // _trackDwell above).
    /** @type {Map<string, {attempts: Array<object>, finalized: boolean}>} */
    this._plateAggregation = new Map();
  }

  async init() {
    await this.face.init();
    // AnprService's Tesseract worker initializes lazily on first use — no
    // separate init step needed, but we warm it here so the first real
    // detection during a demo isn't slowed by worker spawn latency.
    await this.anpr._ensureWorker();
    this.emit('ready', {});
  }

  /**
   * Main entry point called once per analytics-eligible frame.
   * @param {string} cameraId
   * @param {Buffer} frameBuffer
   * @param {Array} tracks - active tracks for this frame (from VisionEngine)
   */
  async processFrame(cameraId, frameBuffer, tracks) {
    const timestamp = getISTTimestamp();
    const night = isNightTimeIST();

    const vehicleTracks = tracks.filter((t) => t.group === 'vehicle');
    const personTracks = tracks.filter((t) => t.group === 'person');

    await Promise.all([
      ...vehicleTracks.map((t) => this._handleVehicle(cameraId, frameBuffer, t, timestamp)),
      ...personTracks.map((t) => this._handlePerson(cameraId, frameBuffer, t, timestamp, night)),
    ]);

    this._evaluateLoitering(cameraId, tracks, timestamp);
    this._cleanupPlateAggregation(cameraId, vehicleTracks);
  }

  async _handleVehicle(cameraId, frameBuffer, track, timestamp) {
    const key = `${cameraId}:${track.id}`;
    let aggregation = this._plateAggregation.get(key);

    if (!aggregation) {
      aggregation = { attempts: [], finalized: false };
      this._plateAggregation.set(key, aggregation);
    }

    // Once this track's plate has been finalized, skip OCR entirely — both
    // to save CPU (matching the frame-skip philosophy used elsewhere in
    // IBVAP) and to avoid re-emitting VEHICLE_CHECKED repeatedly for a
    // vehicle that's simply sitting in frame, which would otherwise create
    // duplicate DB events and re-trigger alert emails on every analytics
    // frame (the Mailer's cooldown masks the symptom but this fixes the
    // actual cause).
    if (aggregation.finalized) return;

    try {
      const result = await this.anpr.recognizeFromFrame(frameBuffer, track.box);

      aggregation.attempts.push({
        rawText: result.rawText,
        normalizedPlate: result.normalizedPlate,
        plausible: result.plausible,
        confidence: result.confidence,
        label: result.label,
        role: result.role,
        match: result.match,
        box: track.box,
      });

      const finalAttempt = this._resolvePlateConsensus(aggregation);
      if (!finalAttempt) return; // not enough attempts/consensus yet — try again next analytics frame

      aggregation.finalized = true;

      this.emit('VEHICLE_CHECKED', {
        cameraId,
        trackId: track.id,
        box: finalAttempt.box,
        rawText: finalAttempt.rawText,
        normalizedPlate: finalAttempt.normalizedPlate,
        plausible: finalAttempt.plausible,
        label: finalAttempt.label,
        role: finalAttempt.role,
        match: finalAttempt.match,
        attemptsUsed: aggregation.attempts.length,
        timestamp,
      });
    } catch (err) {
      this.emit('error', { cameraId, message: `ANPR failed for ${track.id}: ${err.message}` });
    }
  }

  /**
   * Decides whether this vehicle track's accumulated OCR attempts are ready
   * to finalize, and if so, returns the winning attempt. Returns null if
   * more attempts are still needed.
   *
   * Finalizes early (potentially after just 1 attempt if PLATE_CONSENSUS_COUNT
   * is 1) once the same plausible normalized plate has been read
   * PLATE_CONSENSUS_COUNT times — this is the common case for a stationary
   * or slow-moving vehicle, where consecutive reads tend to agree quickly.
   *
   * Otherwise, once PLATE_MAX_ATTEMPTS have been spent without consensus
   * (typical for a fast-moving vehicle glimpsed only briefly, where every
   * reading might differ slightly), falls back to whichever single
   * plausible attempt had the highest OCR confidence. If none of the
   * attempts ever produced a plausible plate shape, finalizes as
   * UNREADABLE using the last attempt (so the track stops being retried
   * forever, but nothing false gets reported).
   *
   * @param {{attempts: Array<object>}} aggregation
   * @returns {object|null}
   */
  _resolvePlateConsensus(aggregation) {
    const { attempts } = aggregation;

    const plausibleCounts = new Map(); // normalizedPlate -> count
    for (const attempt of attempts) {
      if (!attempt.plausible) continue;
      plausibleCounts.set(attempt.normalizedPlate, (plausibleCounts.get(attempt.normalizedPlate) ?? 0) + 1);
    }

    for (const [plate, count] of plausibleCounts.entries()) {
      if (count >= PLATE_CONSENSUS_COUNT) {
        // Prefer the highest-confidence attempt among the ones that agreed,
        // rather than just "the first one that hit the count" — a later,
        // clearer frame of the same plate is a better representative.
        const matching = attempts.filter((a) => a.plausible && a.normalizedPlate === plate);
        return matching.reduce((best, a) => (a.confidence > best.confidence ? a : best));
      }
    }

    if (attempts.length < PLATE_MAX_ATTEMPTS) {
      return null; // keep trying
    }

    // Attempt budget exhausted without consensus — fall back to the best
    // single plausible reading, or UNREADABLE if none were ever plausible.
    const plausibleAttempts = attempts.filter((a) => a.plausible);
    if (plausibleAttempts.length > 0) {
      return plausibleAttempts.reduce((best, a) => (a.confidence > best.confidence ? a : best));
    }

    return attempts[attempts.length - 1]; // label will be UNREADABLE or UNKNOWN_VEHICLE
  }

  async _handlePerson(cameraId, frameBuffer, track, timestamp, night) {
    try {
      const results = await this.face.recognizeFromImage(frameBuffer);
      if (!results.length) return;

      // Associate the face closest to this track's bounding box (simple
      // spatial nearest-match since we run face detection on the full frame
      // rather than a pre-cropped person region).
      const [tx1, ty1, tx2, ty2] = track.box;
      const trackCx = (tx1 + tx2) / 2;
      const trackCy = (ty1 + ty2) / 2;

      let closest = null;
      let closestDist = Infinity;
      for (const face of results) {
        const fcx = face.box.x + face.box.width / 2;
        const fcy = face.box.y + face.box.height / 2;
        const dist = Math.hypot(fcx - trackCx, fcy - trackCy);
        if (dist < closestDist) {
          closestDist = dist;
          closest = face;
        }
      }
      if (!closest) return;

      this.emit('PERSON_IDENTIFIED', {
        cameraId,
        trackId: track.id,
        box: closest.box,
        label: closest.label,
        match: closest.match,
        isNight: night,
        timestamp,
      });
    } catch (err) {
      this.emit('error', { cameraId, message: `Face recognition failed for ${track.id}: ${err.message}` });
    }
  }

  _evaluateLoitering(cameraId, tracks, timestamp) {
    const activeKeys = new Set();

    for (const track of tracks) {
      if (track.group !== 'person') continue;

      const key = `${cameraId}:${track.id}`;
      activeKeys.add(key);

      if (!this._trackDwell.has(key)) {
        this._trackDwell.set(key, { firstSeen: nowIST(), lastAlerted: 0 });
        continue;
      }

      const dwell = this._trackDwell.get(key);
      const dwellSeconds = diffSeconds(dwell.firstSeen);

      if (dwellSeconds >= LOITERING_THRESHOLD_SECONDS && dwell.lastAlerted !== Math.floor(dwellSeconds / LOITERING_THRESHOLD_SECONDS)) {
        dwell.lastAlerted = Math.floor(dwellSeconds / LOITERING_THRESHOLD_SECONDS);
        this.emit('LOITERING_DETECTED', {
          cameraId,
          trackId: track.id,
          dwellSeconds: Math.round(dwellSeconds),
          timestamp,
        });
      }
    }

    // Clean up dwell entries for tracks no longer present.
    for (const key of this._trackDwell.keys()) {
      if (key.startsWith(`${cameraId}:`) && !activeKeys.has(key)) {
        this._trackDwell.delete(key);
      }
    }
  }

  /**
   * Removes ANPR consensus state for vehicle tracks that Tracker.js has
   * stopped reporting (i.e. the track aged out and was dropped). Without
   * this, a long-running demo with many vehicles passing through would
   * leak one Map entry per vehicle forever.
   */
  _cleanupPlateAggregation(cameraId, vehicleTracks) {
    const activeKeys = new Set(vehicleTracks.map((t) => `${cameraId}:${t.id}`));
    for (const key of this._plateAggregation.keys()) {
      if (key.startsWith(`${cameraId}:`) && !activeKeys.has(key)) {
        this._plateAggregation.delete(key);
      }
    }
  }

  removeCamera(cameraId) {
    for (const key of this._trackDwell.keys()) {
      if (key.startsWith(`${cameraId}:`)) this._trackDwell.delete(key);
    }
    for (const key of this._plateAggregation.keys()) {
      if (key.startsWith(`${cameraId}:`)) this._plateAggregation.delete(key);
    }
  }

  async shutdown() {
    await this.anpr.terminate();
  }
}

export default AnalyticsEngine;
