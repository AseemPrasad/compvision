/**
 * src/analytics/PlateAggregator.js
 *
 * Accumulates OCR plate readings per tracked vehicle (keyed by
 * `${cameraId}:${trackId}`) and only "resolves" a plate once there's real
 * confidence behind it — either one very high-confidence single read, or
 * the same plate string showing up across multiple independent frames.
 *
 * This matters for both moving and stationary vehicles:
 *   - A moving vehicle produces several noisy/blurred OCR reads as it
 *     crosses frame; trusting any single one risks logging (and alerting
 *     on) a garbled plate string.
 *   - A stationary vehicle gives many clean reads over time — aggregation
 *     lets those agree quickly rather than re-triggering a fresh DB lookup
 *     and a fresh alert on every single analytics frame.
 *
 * Because every vehicle already gets a persistent tracker ID from
 * Tracker.js, "wait for a few more frames from this exact vehicle" is
 * simple: readings are grouped by that ID, not re-detected from scratch.
 */

const MAX_READINGS_PER_TRACK = 6;

// A single OCR read this confident is trusted immediately, no need to wait
// for a second agreeing frame.
const MIN_CONFIDENCE_FOR_SINGLE_READ = 75;

// Otherwise, the same normalized plate string must appear at least this
// many times among recent readings before it's trusted.
const MIN_AGREEING_READS = 2;

export class PlateAggregator {
  constructor() {
    /** @type {Map<string, {readings: Array<{plate: string, confidence: number}>, resolvedPlate: string|null}>} */
    this.tracks = new Map();
  }

  _getEntry(key) {
    if (!this.tracks.has(key)) {
      this.tracks.set(key, { readings: [], resolvedPlate: null });
    }
    return this.tracks.get(key);
  }

  /**
   * Records a new OCR reading for a tracked vehicle and returns the
   * current consensus state. Garbled/implausible reads are recorded but
   * don't count toward consensus, so a run of bad frames on a moving
   * vehicle can't accidentally "win" just by being numerous.
   *
   * @param {string} key - `${cameraId}:${trackId}`
   * @param {string} plate - normalized plate string (may be empty/garbled)
   * @param {number} confidence - 0-100 OCR confidence for this read
   * @param {boolean} plausible - whether this read matches expected plate shape
   * @returns {{resolvedPlate: string|null, justResolved: boolean}}
   */
  addReading(key, plate, confidence, plausible) {
    const entry = this._getEntry(key);
    const wasResolved = entry.resolvedPlate !== null;

    if (plate && plate.length >= 4 && plausible) {
      entry.readings.push({ plate, confidence });
      if (entry.readings.length > MAX_READINGS_PER_TRACK) {
        entry.readings.shift();
      }
    }

    if (!wasResolved) {
      entry.resolvedPlate = this._computeConsensus(entry.readings);
    }

    return {
      resolvedPlate: entry.resolvedPlate,
      justResolved: !wasResolved && entry.resolvedPlate !== null,
    };
  }

  _computeConsensus(readings) {
    if (!readings.length) return null;

    const strongSingle = readings.find((r) => r.confidence >= MIN_CONFIDENCE_FOR_SINGLE_READ);
    if (strongSingle) return strongSingle.plate;

    const counts = new Map();
    for (const r of readings) {
      counts.set(r.plate, (counts.get(r.plate) ?? 0) + 1);
    }
    for (const [plate, count] of counts.entries()) {
      if (count >= MIN_AGREEING_READS) return plate;
    }

    return null;
  }

  /** Removes aggregation state for a single track (e.g. it left frame). */
  clearTrack(key) {
    this.tracks.delete(key);
  }

  /**
   * Drops aggregation entries for any track under this camera that isn't
   * in the currently-active track ID list — called once per analytics
   * frame so stale entries don't accumulate forever as vehicles come and go.
   * @param {string} cameraId
   * @param {string[]} activeTrackIds
   */
  pruneStale(cameraId, activeTrackIds) {
    const activeKeys = new Set(activeTrackIds.map((id) => `${cameraId}:${id}`));
    for (const key of this.tracks.keys()) {
      if (key.startsWith(`${cameraId}:`) && !activeKeys.has(key)) {
        this.tracks.delete(key);
      }
    }
  }

  removeCamera(cameraId) {
    for (const key of this.tracks.keys()) {
      if (key.startsWith(`${cameraId}:`)) {
        this.tracks.delete(key);
      }
    }
  }
}

export default PlateAggregator;
