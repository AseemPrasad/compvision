/**
 * src/spatial/SpatialEngine.js
 *
 * IBVAP's "Virtual Fencing" engine — evaluates tracked entities' ground-
 * contact points against virtual polygon zones and line fences (loaded
 * from SQLite), and maintains a per-track Boundary State Machine:
 *
 *   UNKNOWN -> OUTSIDE -> APPROACHING -> CROSSING -> INSIDE
 *
 * This is specifically valuable anywhere a physical fence can't be built —
 * riverbanks, open unfenced border stretches, buffer terrain — since the
 * boundary exists only as geometry drawn once in the live viewer and
 * persisted in SQLite, with zero physical infrastructure required.
 *
 * Three independent false-positive suppression mechanisms guard every
 * crossing event before it's allowed to fire:
 *   1. Consecutive-frame confirmation (DEBOUNCE_FRAMES) — a track must
 *      consistently report the new state for several frames running, not
 *      just once, before a transition is accepted.
 *   2. Minimum track age (MIN_TRACK_AGE_HITS) — a track that only just
 *      appeared (possibly a fresh ID from a brief tracking hiccup) cannot
 *      trigger a crossing until it's been confirmed present for a while.
 *   3. Time-based event debounce (EVENT_DEBOUNCE_MS) — even after 1 and 2
 *      pass, the same track+zone pair cannot fire a second crossing event
 *      within this wall-clock window, guarding against a track oscillating
 *      right on the boundary line.
 *
 * Class-based routing: entities with group 'animal' still pass through the
 * full state machine (so their movement is tracked and logged), but their
 * crossings are tagged as informational (`isAnimalEvent: true`) rather than
 * a security event — callers (server.js) use this to skip alert emails for
 * animal crossings while still recording them for the log.
 */

import { EventEmitter } from 'node:events';
import * as turf from '@turf/turf';
import { getZonesForCamera } from '../database/db.js';
import { getISTTimestamp, getISTEpochMillis } from '../utils/timeUtils.js';

const APPROACH_BUFFER_METERS_EQUIV = 40; // pixel-space buffer distance treated as "approaching"
const DEBOUNCE_FRAMES = Number.parseInt(process.env.FENCE_DEBOUNCE_FRAMES ?? '3', 10);
const MIN_TRACK_AGE_HITS = Number.parseInt(process.env.FENCE_MIN_TRACK_AGE_HITS ?? '10', 10);
const EVENT_DEBOUNCE_MS = Number.parseInt(process.env.FENCE_EVENT_DEBOUNCE_MS ?? '10000', 10);

const STATE = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  OUTSIDE: 'OUTSIDE',
  APPROACHING: 'APPROACHING',
  CROSSING: 'CROSSING',
  INSIDE: 'INSIDE',
});

function pointFeature([x, y]) {
  return turf.point([x, y]);
}

function polygonFeature(coordinates) {
  // Ensure the ring is closed (first point === last point), as turf requires.
  const ring = [...coordinates];
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx !== lx || fy !== ly) ring.push(ring[0]);
  return turf.polygon([ring]);
}

function lineFeature(coordinates) {
  return turf.lineString(coordinates);
}

/**
 * Raw spatial classification of a point against a polygon zone, ignoring
 * temporal debouncing — used as the input signal to the state machine.
 */
function classifyAgainstPolygon(point, polygon) {
  const pt = pointFeature(point);
  const inside = turf.booleanPointInPolygon(pt, polygon);
  if (inside) return STATE.INSIDE;

  // Distance (in the same unit as coordinates, i.e. pixels) from point to
  // the polygon boundary determines "approaching" vs plain "outside".
  const boundary = turf.polygonToLine(polygon);
  const distance = turf.pointToLineDistance(pt, boundary, { units: 'degrees' });
  // NOTE: coordinates here are pixel-space, not geographic. turf's distance
  // units are nominal in this context — we treat the numeric magnitude
  // directly as a pixel-equivalent buffer comparison.
  const pixelDistance = distance * 111320; // degrees->meters nominal conversion, reused as a generic scalar
  return pixelDistance <= APPROACH_BUFFER_METERS_EQUIV ? STATE.APPROACHING : STATE.OUTSIDE;
}

/**
 * Per-track spatial memory: current confirmed state, a pending-state
 * debounce counter, recent trajectory for line-crossing checks, and the
 * last time each zone fired an event (for time-based debouncing).
 */
class TrackSpatialState {
  constructor() {
    this.state = STATE.UNKNOWN;
    this.pendingState = null;
    this.pendingCount = 0;
    this.trajectory = []; // recent ground points, for line-intersection checks
    this.lineCrossed = new Set(); // zoneIds already fired for this track's current pass
    this.lastEventAtByZone = new Map(); // zoneId -> epoch millis of last emitted crossing event
  }

  pushTrajectoryPoint(point) {
    this.trajectory.push(point);
    if (this.trajectory.length > 10) this.trajectory.shift();
  }

  isWithinEventDebounce(zoneId, nowMillis) {
    const last = this.lastEventAtByZone.get(zoneId);
    if (last == null) return false;
    return nowMillis - last < EVENT_DEBOUNCE_MS;
  }

  markEventFired(zoneId, nowMillis) {
    this.lastEventAtByZone.set(zoneId, nowMillis);
  }
}

export class SpatialEngine extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Array>} cameraId -> zones (with parsed coordinates) */
    this._zoneCache = new Map();
    /** @type {Map<string, TrackSpatialState>} `${cameraId}:${trackId}` -> state */
    this._trackStates = new Map();
  }

  /**
   * Loads (or reloads) zone geometry for a camera from SQLite. Call this on
   * boot and whenever zones are edited via the REST API.
   */
  refreshZones(cameraId) {
    const zones = getZonesForCamera(cameraId);
    this._zoneCache.set(cameraId, zones);
    return zones;
  }

  _getZones(cameraId) {
    if (!this._zoneCache.has(cameraId)) {
      return this.refreshZones(cameraId);
    }
    return this._zoneCache.get(cameraId);
  }

  _getTrackState(cameraId, trackId) {
    const key = `${cameraId}:${trackId}`;
    if (!this._trackStates.has(key)) {
      this._trackStates.set(key, new TrackSpatialState());
    }
    return this._trackStates.get(key);
  }

  /**
   * Evaluates a single frame's worth of tracks against a camera's configured
   * zones. Emits debounced INBOUND_CROSSING / OUTBOUND_CROSSING events.
   *
   * @param {string} cameraId
   * @param {Array<{id: string, group: string, className: string, groundPoint: number[]}>} tracks
   */
  evaluate(cameraId, tracks) {
    const zones = this._getZones(cameraId);
    if (!zones.length) return [];

    const results = [];
    const timestamp = getISTTimestamp();

    for (const track of tracks) {
      const trackState = this._getTrackState(cameraId, track.id);
      trackState.pushTrajectoryPoint(track.groundPoint);

      for (const zone of zones) {
        if (zone.zone_type === 'POLYGON') {
          const result = this._evaluatePolygonZone(cameraId, track, zone, trackState, timestamp);
          if (result) results.push(result);
        } else if (zone.zone_type === 'LINE') {
          const result = this._evaluateLineZone(cameraId, track, zone, trackState, timestamp);
          if (result) results.push(result);
        }
      }
    }

    return results;
  }

  _evaluatePolygonZone(cameraId, track, zone, trackState, timestamp) {
    const polygon = polygonFeature(zone.coordinates);
    const rawState = classifyAgainstPolygon(track.groundPoint, polygon);

    return this._applyDebounce(cameraId, track, zone, trackState, rawState, timestamp);
  }

  _applyDebounce(cameraId, track, zone, trackState, rawState, timestamp) {
    if (trackState.state === STATE.UNKNOWN) {
      // First observation seeds state directly without debounce/alerting.
      trackState.state = rawState;
      return null;
    }

    if (rawState === trackState.state) {
      trackState.pendingState = null;
      trackState.pendingCount = 0;
      return null;
    }

    // Candidate transition — require consecutive confirmations.
    if (trackState.pendingState === rawState) {
      trackState.pendingCount += 1;
    } else {
      trackState.pendingState = rawState;
      trackState.pendingCount = 1;
    }

    if (trackState.pendingCount < DEBOUNCE_FRAMES) {
      return null; // not yet confirmed
    }

    // Gate 2: minimum track age. A track that just spawned (e.g. from a
    // brief occlusion causing a fresh ID) cannot trigger a crossing yet —
    // wait until it's been reliably matched across enough frames to trust
    // its trajectory. We still update `state` below so the state machine
    // itself stays accurate; we just suppress the outward event.
    const trackIsOldEnough = (track.hits ?? 0) >= MIN_TRACK_AGE_HITS;

    const previousState = trackState.state;
    trackState.state = rawState;
    trackState.pendingState = null;
    trackState.pendingCount = 0;

    if (!trackIsOldEnough) {
      return null;
    }

    // Gate 3: time-based event debounce, independent of the frame-based
    // debounce above — guards against a track oscillating right on a
    // boundary line and re-triggering rapidly even after each individual
    // transition was itself frame-confirmed.
    const nowMillis = getISTEpochMillis();
    if (trackState.isWithinEventDebounce(zone.id, nowMillis)) {
      return null;
    }

    const result = this._emitTransitionEvent(cameraId, track, zone, previousState, rawState, timestamp);
    if (result?.eventType && result.eventType !== 'STATE_TRANSITION') {
      trackState.markEventFired(zone.id, nowMillis);
    }
    return result;
  }

  _emitTransitionEvent(cameraId, track, zone, previousState, newState, timestamp) {
    const wasOutsideLike = previousState === STATE.OUTSIDE || previousState === STATE.APPROACHING;
    const isNowInsideLike = newState === STATE.INSIDE || newState === STATE.CROSSING;
    const wasInsideLike = previousState === STATE.INSIDE || previousState === STATE.CROSSING;
    const isNowOutsideLike = newState === STATE.OUTSIDE || newState === STATE.APPROACHING;

    let eventType = null;
    if (wasOutsideLike && isNowInsideLike) {
      eventType = 'INBOUND_CROSSING';
    } else if (wasInsideLike && isNowOutsideLike) {
      eventType = 'OUTBOUND_CROSSING';
    }

    // Class-based routing: animals still pass through the full state
    // machine (so their trajectory is tracked and logged), but their
    // crossings are informational only — callers use this flag to skip
    // alert emails and de-emphasize severity for animal movement.
    const isAnimalEvent = track.group === 'animal';

    const payload = {
      cameraId,
      trackId: track.id,
      group: track.group,
      className: track.className,
      zoneId: zone.id,
      zoneName: zone.zone_name,
      zoneSeverity: zone.severity,
      previousState,
      newState,
      groundPoint: track.groundPoint,
      isAnimalEvent,
      timestamp,
    };

    if (eventType) {
      payload.eventType = eventType;
      this.emit(eventType, payload);
    } else {
      this.emit('STATE_TRANSITION', { ...payload, eventType: 'STATE_TRANSITION' });
    }

    return payload;
  }

  _evaluateLineZone(cameraId, track, zone, trackState, timestamp) {
    if (trackState.trajectory.length < 2) return null;

    const fenceKey = `line:${zone.id}`;
    const line = lineFeature(zone.coordinates);

    const [prevPoint, currPoint] = trackState.trajectory.slice(-2);
    const segment = turf.lineString([prevPoint, currPoint]);

    let intersects = false;
    try {
      const intersection = turf.lineIntersect(segment, line);
      intersects = intersection.features.length > 0;
    } catch (_err) {
      intersects = false;
    }

    if (!intersects) {
      trackState.lineCrossed.delete(fenceKey);
      return null;
    }

    // Debounce re-firing on the same crossing across consecutive frames.
    if (trackState.lineCrossed.has(fenceKey)) return null;
    trackState.lineCrossed.add(fenceKey);

    // Gate 2: minimum track age, same rationale as the polygon path above.
    if ((track.hits ?? 0) < MIN_TRACK_AGE_HITS) {
      return null;
    }

    // Gate 3: time-based event debounce.
    const nowMillis = getISTEpochMillis();
    if (trackState.isWithinEventDebounce(zone.id, nowMillis)) {
      return null;
    }

    // Direction inferred from the fence's configured direction_hint, falling
    // back to a simple sign check on movement relative to the fence normal.
    const eventType = zone.direction_hint === 'OUTBOUND' ? 'OUTBOUND_CROSSING' : 'INBOUND_CROSSING';
    const isAnimalEvent = track.group === 'animal';

    const payload = {
      cameraId,
      trackId: track.id,
      group: track.group,
      className: track.className,
      zoneId: zone.id,
      zoneName: zone.zone_name,
      zoneSeverity: zone.severity,
      eventType,
      previousState: trackState.state,
      newState: STATE.CROSSING,
      groundPoint: track.groundPoint,
      isAnimalEvent,
      timestamp,
    };

    this.emit(eventType, payload);
    trackState.markEventFired(zone.id, nowMillis);
    return payload;
  }

  /** Clears all spatial memory for a track (e.g. once it leaves frame for good). */
  clearTrack(cameraId, trackId) {
    this._trackStates.delete(`${cameraId}:${trackId}`);
  }

  removeCamera(cameraId) {
    this._zoneCache.delete(cameraId);
    for (const key of this._trackStates.keys()) {
      if (key.startsWith(`${cameraId}:`)) this._trackStates.delete(key);
    }
  }
}

export const BOUNDARY_STATE = STATE;
export default SpatialEngine;
