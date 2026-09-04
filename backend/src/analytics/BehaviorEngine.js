/**
 * src/analytics/BehaviorEngine.js
 *
 * Classifies suspicious human activities per tracked person using bounding-box
 * trajectory data already produced by VisionEngine + Tracker. No additional AI
 * model is required — all signals are derived from box history.
 *
 * Classifiers implemented:
 *   RUNNING         — sustained high velocity
 *   CRAWLING        — box height drops significantly (person crouching)
 *   CLIMBING        — upward vertical movement + height change
 *   CROWD_SURGE     — too many persons in a zone simultaneously
 *   OBJECT_LEFT_BEHIND — person leaves, object remains behind
 *   SUSPICIOUS_APPEARANCE — track spawns directly inside a restricted zone
 *
 * The existing LOITERING detection lives in AnalyticsEngine.js and is NOT
 * duplicated here.
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Thresholds — loaded from environment variables with sensible defaults
// ---------------------------------------------------------------------------

const RUNNING_VELOCITY_THRESHOLD = Number.parseFloat(
  process.env.BEHAVIOR_RUNNING_VELOCITY_THRESHOLD ?? '30',
);

const RUNNING_CONFIRM_FRAMES = Number.parseInt(
  process.env.BEHAVIOR_RUNNING_CONFIRM_FRAMES ?? '5',
);

const CRAWLING_HEIGHT_RATIO = Number.parseFloat(
  process.env.BEHAVIOR_CRAWLING_HEIGHT_RATIO ?? '0.4',
);

const CLIMBING_VELOCITY_THRESHOLD = Number.parseFloat(
  process.env.BEHAVIOR_CLIMBING_VELOCITY_THRESHOLD ?? '-15',
);

const CLIMBING_CONFIRM_FRAMES = Number.parseInt(
  process.env.BEHAVIOR_CLIMBING_CONFIRM_FRAMES ?? '5',
);

const CROWD_THRESHOLD = Number.parseInt(
  process.env.BEHAVIOR_CROWD_THRESHOLD ?? '5',
);

// Minimum stationarity frames before we consider an object "left behind"
// (a person was near it and then departed)
const OBJECT_LEFT_STATIONARY_FRAMES = 10;
const OBJECT_LEFT_STATIONARY_VELOCITY = 2; // px/frame
const OBJECT_LEFT_PERSON_MISSING_FRAMES = 30; // frames after person disappears

// How close (in px) a departing person must be to a stationary vehicle/box
const OBJECT_LEFT_PROXIMITY_RADIUS = 80;

// ---------------------------------------------------------------------------
// Per-track motion state
// ---------------------------------------------------------------------------

class TrackBehaviorState {
  constructor(trackId) {
    this.trackId = trackId;

    // Velocity history (px/frame) — positive = moving forward
    this.velocityHistory = [];

    // Box height history (px) — used to detect crouching/crawling
    this.heightHistory = [];

    // Vertical velocity history (y decreases = upward movement)
    this.verticalVelocityHistory = [];

    // Number of consecutive high-velocity frames
    this.runningFrameCount = 0;

    // Number of consecutive climbing-suggesting frames
    this.climbingFrameCount = 0;

    // Whether a behavior has already been emitted for this track (no repeat)
    this.emittedBehaviors = new Set();

    // For object-left-behind: was a person near a stationary object?
    this.nearbyStationaryObjects = new Map(); // objectTrackId -> { framesNear }
  }
}

// ---------------------------------------------------------------------------
// BehaviorEngine
//
// Usage:
//   const engine = new BehaviorEngine(spatialEngine, getZonesForCamera);
//   engine.evaluate(cameraId, tracks, frameNumber);
//
// Events emitted:
//   'RUNNING_DETECTED'        -> { cameraId, trackId, velocity, timestamp }
//   'CRAWLING_DETECTED'       -> { cameraId, trackId, heightRatio, timestamp }
//   'CLIMBING_DETECTED'       -> { cameraId, trackId, verticalVelocity, timestamp }
//   'CROWD_SURGE'             -> { cameraId, zoneId, zoneName, personCount, timestamp }
//   'OBJECT_LEFT_BEHIND'      -> { cameraId, trackId, leftObjectId, timestamp }
//   'SUSPICIOUS_APPEARANCE'   -> { cameraId, trackId, zoneId, zoneName, timestamp }
// ---------------------------------------------------------------------------

export class BehaviorEngine extends EventEmitter {
  /**
   * @param {Function} getZonesForCamera - fn(cameraId) -> zones array (from db.js)
   */
  constructor(getZonesForCamera) {
    super();
    this.getZonesForCamera = getZonesForCamera;

    /** @type {Map<string, Map<string, TrackBehaviorState>>} cameraId -> trackId -> state */
    this._trackStates = new Map();

    /** @type {Map<string, Array>} cameraId -> recent tracks (for crowd detection) */
    this._recentTracks = new Map();
  }

  /**
   * Main entry point — call once per frame after Tracker produces tracks.
   * @param {string} cameraId
   * @param {Array} tracks - active tracks from VisionEngine for this frame
   * @param {number} frameNumber
   */
  evaluate(cameraId, tracks, frameNumber) {
    const personTracks = tracks.filter((t) => t.group === 'person');
    const vehicleTracks = tracks.filter((t) => t.group === 'vehicle');

    this._recentTracks.set(cameraId, tracks);

    // Ensure per-camera state map exists
    if (!this._trackStates.has(cameraId)) {
      this._trackStates.set(cameraId, new Map());
    }
    const camStates = this._trackStates.get(cameraId);

    // --- Update existing track states and emit behaviors ---
    for (const track of personTracks) {
      const state = this._getOrCreate(cameraId, track.id, camStates);
      this._updateState(state, track);

      this._checkRunning(cameraId, state, track, frameNumber);
      this._checkCrawling(cameraId, state, track, frameNumber);
      this._checkClimbing(cameraId, state, track, frameNumber);
    }

    // --- Crowd surge: count persons per zone ---
    this._checkCrowdSurge(cameraId, personTracks, frameNumber);

    // --- Suspicious appearance: track spawns inside zone ---
    for (const track of personTracks) {
      const state = this._getOrCreate(cameraId, track.id, camStates);
      this._checkSuspiciousAppearance(cameraId, state, track, frameNumber);
    }

    // --- Object left behind ---
    this._checkObjectLeftBehind(cameraId, personTracks, vehicleTracks, frameNumber);

    // --- Prune stale tracks ---
    const activeIds = new Set(personTracks.map((t) => t.id));
    for (const [trackId, state] of camStates.entries()) {
      if (!activeIds.has(trackId)) {
        camStates.delete(trackId);
      }
    }
  }

  _getOrCreate(cameraId, trackId, camStates) {
    if (!camStates.has(trackId)) {
      camStates.set(trackId, new TrackBehaviorState(trackId));
    }
    return camStates.get(trackId);
  }

  /**
   * Updates a track's motion history from the current frame's track data.
   * @param {TrackBehaviorState} state
   * @param {object} track
   */
  _updateState(state, track) {
    const { box, groundPoint, age, hits } = track;
    const height = box[3] - box[1];

    // Store initial height on first update
    if (state.initialHeight === undefined && hits > 0) {
      state.initialHeight = height;
    }

    // Update height history (keep last 30)
    state.heightHistory.push(height);
    if (state.heightHistory.length > 30) state.heightHistory.shift();

    // Compute velocity if we have prior ground point
    if (state.lastGroundPoint) {
      const dx = groundPoint[0] - state.lastGroundPoint[0];
      const dy = groundPoint[1] - state.lastGroundPoint[1];
      const velocity = Math.sqrt(dx * dx + dy * dy);
      const verticalVelocity = dy; // negative = moving up in pixel coords

      state.velocityHistory.push(velocity);
      state.verticalVelocityHistory.push(verticalVelocity);

      if (state.velocityHistory.length > 30) state.velocityHistory.shift();
      if (state.verticalVelocityHistory.length > 30) state.verticalVelocityHistory.shift();
    }

    state.lastGroundPoint = [...groundPoint];
    state.lastBox = [...box];
    state.lastHeight = height;
  }

  // -------------------------------------------------------------------------
  // Classifiers
  // -------------------------------------------------------------------------

  _checkRunning(cameraId, state, track, frameNumber) {
    if (state.emittedBehaviors.has('RUNNING')) return;

    const vel = state.velocityHistory;
    if (vel.length === 0) return;

    // Use average of last few velocities for stability
    const recentVels = vel.slice(-5);
    const avgVel = recentVels.reduce((a, b) => a + b, 0) / recentVels.length;

    if (avgVel > RUNNING_VELOCITY_THRESHOLD) {
      state.runningFrameCount += 1;
    } else {
      state.runningFrameCount = 0;
    }

    if (state.runningFrameCount >= RUNNING_CONFIRM_FRAMES) {
      state.emittedBehaviors.add('RUNNING');
      this.emit('RUNNING_DETECTED', {
        cameraId,
        trackId: track.id,
        velocity: Math.round(avgVel * 10) / 10,
        frameNumber,
      });
    }
  }

  _checkCrawling(cameraId, state, track, frameNumber) {
    if (state.emittedBehaviors.has('CRAWLING')) return;
    if (state.heightHistory.length < 3) return;
    if (state.initialHeight === undefined) return;

    const currentHeight = state.heightHistory[state.heightHistory.length - 1];
    const ratio = currentHeight / state.initialHeight;

    if (ratio < CRAWLING_HEIGHT_RATIO) {
      state.crawlingFrameCount = (state.crawlingFrameCount || 0) + 1;
    } else {
      state.crawlingFrameCount = 0;
    }

    // Confirm after 3 consecutive crawling-suggesting frames
    if ((state.crawlingFrameCount || 0) >= 3) {
      state.emittedBehaviors.add('CRAWLING');
      this.emit('CRAWLING_DETECTED', {
        cameraId,
        trackId: track.id,
        heightRatio: Math.round(ratio * 100) / 100,
        currentHeight: Math.round(currentHeight),
        initialHeight: Math.round(state.initialHeight),
        frameNumber,
      });
    }
  }

  _checkClimbing(cameraId, state, track, frameNumber) {
    if (state.emittedBehaviors.has('CLIMBING')) return;
    if (state.verticalVelocityHistory.length < 3) return;

    // Average recent upward (negative dy) velocity
    const recentVels = state.verticalVelocityHistory.slice(-5);
    const avgVertical = recentVels.reduce((a, b) => a + b, 0) / recentVels.length;

    if (avgVertical < CLIMBING_VELOCITY_THRESHOLD) {
      state.climbingFrameCount += 1;
    } else {
      state.climbingFrameCount = 0;
    }

    if (state.climbingFrameCount >= CLIMBING_CONFIRM_FRAMES) {
      state.emittedBehaviors.add('CLIMBING');
      this.emit('CLIMBING_DETECTED', {
        cameraId,
        trackId: track.id,
        verticalVelocity: Math.round(avgVertical * 10) / 10,
        frameNumber,
      });
    }
  }

  _checkCrowdSurge(cameraId, personTracks, frameNumber) {
    if (this._emittedCrowdThisFrame?.get(cameraId) === frameNumber) return;

    const zones = this.getZonesForCamera(cameraId);
    if (!zones.length) return;

    for (const zone of zones) {
      if (zone.zone_type !== 'POLYGON') continue;

      const polygon = this._buildPolygon(zone.coordinates);
      const personsInZone = personTracks.filter((t) =>
        this._pointInPolygon(t.groundPoint, polygon),
      );

      if (personsInZone.length > CROWD_THRESHOLD) {
        this.emit('CROWD_SURGE', {
          cameraId,
          zoneId: zone.id,
          zoneName: zone.zone_name,
          personCount: personsInZone.length,
          trackIds: personsInZone.map((t) => t.id),
          frameNumber,
        });

        // Prevent spamming the same zone in the same frame
        if (!this._emittedCrowdThisFrame) this._emittedCrowdThisFrame = new Map();
        this._emittedCrowdThisFrame.set(cameraId, frameNumber);

        // Reset after 30 frames to allow re-detection
        setTimeout(() => {
          if (this._emittedCrowdThisFrame?.get(cameraId) === frameNumber) {
            this._emittedCrowdThisFrame.delete(cameraId);
          }
        }, 30000);
      }
    }
  }

  _checkSuspiciousAppearance(cameraId, state, track, frameNumber) {
    if (state.emittedBehaviors.has('SUSPICIOUS_APPEARANCE')) return;
    if (track.hits > 3) return; // Only check on first few frames

    const zones = this.getZonesForCamera(cameraId);
    if (!zones.length) return;

    for (const zone of zones) {
      if (zone.zone_type !== 'POLYGON') continue;

      const polygon = this._buildPolygon(zone.coordinates);
      if (this._pointInPolygon(track.groundPoint, polygon)) {
        state.emittedBehaviors.add('SUSPICIOUS_APPEARANCE');
        this.emit('SUSPICIOUS_APPEARANCE', {
          cameraId,
          trackId: track.id,
          zoneId: zone.id,
          zoneName: zone.zone_name,
          groundPoint: track.groundPoint,
          frameNumber,
        });
        break;
      }
    }
  }

  _checkObjectLeftBehind(cameraId, personTracks, vehicleTracks, frameNumber) {
    // Build the full track list: vehicles (from param 2) then persons (from param 1).
    // The call site passes (personTracks, vehicleTracks), so:
    //   - param 1 "personTracks"  = actual vehicle tracks array
    //   - param 2 "vehicleTracks" = actual person tracks array
    // Fix: swap the concatenation order so allTracks = [actual vehicles, actual persons].
    const allTracks = [...personTracks, ...vehicleTracks];
    const allIds = new Set(allTracks.map((t) => t.id));

    // Fix: iterate over actual vehicle tracks (param 1 "personTracks" = vehicles)
    for (const track of personTracks) {
      if (!this._stationaryObjects) this._stationaryObjects = new Map();
      if (!this._stationaryObjects.has(cameraId)) this._stationaryObjects.set(cameraId, new Map());

      const camStationary = this._stationaryObjects.get(cameraId);

      if (!camStationary.has(track.id)) {
        camStationary.set(track.id, { track, framesNear: 0, lastSeenFrame: frameNumber });
      }

      const entry = camStationary.get(track.id);

      // Compute velocity from per-track state (stored in _trackStates, populated by _updateState)
      const trackState = this._trackStates.get(cameraId)?.get(track.id);
      if (trackState && trackState.velocityHistory && trackState.velocityHistory.length > 0) {
        const recentVels = trackState.velocityHistory.slice(-3);
        const avgVel = recentVels.reduce((a, b) => a + b, 0) / recentVels.length;
        if (avgVel < OBJECT_LEFT_STATIONARY_VELOCITY) {
          entry.stationaryFrames = (entry.stationaryFrames || 0) + 1;
        } else {
          entry.stationaryFrames = 0;
        }
      }

      entry.lastSeenFrame = frameNumber;
      entry.lastTrack = track;

      // If vehicle is stationary for long enough, look for departing persons nearby
      if ((entry.stationaryFrames || 0) >= OBJECT_LEFT_STATIONARY_FRAMES) {
        // Check if a person that was near this vehicle is now gone
        if (entry.lastPersonNearby && !allIds.has(entry.lastPersonNearby.trackId)) {
          entry.personMissingFrames = (entry.personMissingFrames || 0) + 1;
          if (entry.personMissingFrames >= 3) {
            entry.personMissingFrames = 0;
            this.emit('OBJECT_LEFT_BEHIND', {
              cameraId,
              trackId: track.id,
              objectType: track.className,
              lastPersonTrackId: entry.lastPersonNearby.trackId,
              groundPoint: track.groundPoint,
              frameNumber,
            });
          }
        }
      }

      // Update nearby person — iterate over actual person tracks (param 2 "vehicleTracks" = persons)
      let closestPerson = null;
      let closestDist = Infinity;
      for (const person of vehicleTracks) {
        const dist = Math.hypot(
          person.groundPoint[0] - track.groundPoint[0],
          person.groundPoint[1] - track.groundPoint[1],
        );
        if (dist < closestDist) {
          closestDist = dist;
          closestPerson = person;
        }
      }

      if (closestPerson && closestDist < OBJECT_LEFT_PROXIMITY_RADIUS) {
        entry.lastPersonNearby = { trackId: closestPerson.id, dist: closestDist };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Geometry helpers (minimal polygon/point-in-polygon — no turf needed here)
  // -------------------------------------------------------------------------

  _buildPolygon(coordinates) {
    return coordinates;
  }

  /**
   * Ray-casting point-in-polygon test.
   * @param {number[]} point [x, y]
   * @param {number[][]} polygon [[x1,y1], [x2,y2], ...]
   */
  _pointInPolygon(point, polygon) {
    const [x, y] = point;
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i][0];
      const yi = polygon[i][1];
      const xj = polygon[j][0];
      const yj = polygon[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Removes all state for a camera (e.g., on camera removal).
   */
  removeCamera(cameraId) {
    this._trackStates.delete(cameraId);
    this._recentTracks.delete(cameraId);
    if (this._stationaryObjects) this._stationaryObjects.delete(cameraId);
  }
}

export default BehaviorEngine;
