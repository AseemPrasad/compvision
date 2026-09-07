/**
 * src/vision/Tracker.js
 *
 * Lightweight ByteTrack-inspired, IoU-based multi-object tracker.
 * Pure JavaScript, no native deps — designed to run every frame on CPU
 * alongside YOLO11 inference without adding meaningful overhead.
 *
 * Algorithm summary (per class-group: person / vehicle / animal):
 *   1. High-confidence detections are matched first to existing tracks via
 *      greedy IoU association (Hungarian-quality matching is unnecessary at
 *      this frame rate/detection count).
 *   2. Low-confidence detections are matched second, against tracks that
 *      remained unmatched after step 1 — this is the core ByteTrack idea:
 *      recovering objects during brief occlusion/motion blur instead of
 *      dropping and re-assigning a new ID.
 *   3. Unmatched tracks age; after `maxAge` frames without a match they are
 *      removed.
 *   4. Unmatched high-confidence detections spawn new tracks with a
 *      persistent, human-readable ID: P-<n> (person), V-<n> (vehicle),
 *      A-<n> (animal).
 */

const HIGH_CONF_THRESHOLD = 0.5;
const IOU_MATCH_THRESHOLD = 0.3;

const CLASS_GROUP = {
  person: 'person',
  car: 'vehicle',
  truck: 'vehicle',
  bus: 'vehicle',
  motorcycle: 'vehicle',
  bicycle: 'vehicle',
  dog: 'animal',
  cow: 'animal',
  horse: 'animal',
  sheep: 'animal',
};

const GROUP_PREFIX = {
  person: 'P',
  vehicle: 'V',
  animal: 'A',
};

function classToGroup(className) {
  return CLASS_GROUP[className] ?? 'other';
}

/**
 * Computes Intersection-over-Union between two [x1, y1, x2, y2] boxes.
 */
function iou(boxA, boxB) {
  const xA = Math.max(boxA[0], boxB[0]);
  const yA = Math.max(boxA[1], boxB[1]);
  const xB = Math.min(boxA[2], boxB[2]);
  const yB = Math.min(boxA[3], boxB[3]);

  const interW = Math.max(0, xB - xA);
  const interH = Math.max(0, yB - yA);
  const interArea = interW * interH;
  if (interArea === 0) return 0;

  const areaA = Math.max(0, boxA[2] - boxA[0]) * Math.max(0, boxA[3] - boxA[1]);
  const areaB = Math.max(0, boxB[2] - boxB[0]) * Math.max(0, boxB[3] - boxB[1]);
  const union = areaA + areaB - interArea;
  return union <= 0 ? 0 : interArea / union;
}

/**
 * Ground contact point: midpoint of the box's bottom edge — the entity's
 * effective "footprint" for spatial/zone analysis.
 */
export function groundContactPoint(box) {
  const [x1, y1, x2, y2] = box;
  return [(x1 + x2) / 2, y2];
}

class Track {
  constructor(id, group, className, box, confidence) {
    this.id = id;
    this.group = group;
    this.className = className;
    this.box = box;
    this.confidence = confidence;
    this.age = 0; // frames since last match
    this.hits = 1; // total successful matches
    this.groundPoint = groundContactPoint(box);
    this.history = [this.groundPoint];
  }

  update(box, confidence, className) {
    this.box = box;
    this.confidence = confidence;
    this.className = className;
    this.age = 0;
    this.hits += 1;
    this.groundPoint = groundContactPoint(box);
    this.history.push(this.groundPoint);
    if (this.history.length > 30) this.history.shift();
  }
}

export class Tracker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxAge] - frames a track survives without a match before removal
   * @param {number} [opts.iouThreshold]
   */
  constructor(opts = {}) {
    this.maxAge = opts.maxAge ?? 5; // Reduced from 20 to 5 to immediately drop phantom boxes when subjects exit
    this.iouThreshold = opts.iouThreshold ?? IOU_MATCH_THRESHOLD;
    /** @type {Map<string, Track>} */
    this.tracks = new Map();
    this._idCounters = { person: 0, vehicle: 0, animal: 0, other: 0 };
  }

  _nextId(group) {
    this._idCounters[group] = (this._idCounters[group] ?? 0) + 1;
    const prefix = GROUP_PREFIX[group] ?? 'O';
    return `${prefix}-${this._idCounters[group]}`;
  }

  /**
   * Runs one tracking step.
   * @param {Array<{className: string, box: [number,number,number,number], confidence: number}>} detections
   * @returns {Array<{id: string, group: string, className: string, box: number[], confidence: number, groundPoint: number[]}>}
   */
  update(detections) {
    const groupedTracks = this._groupTracksByGroup();
    const groupedDetections = this._groupDetectionsByGroup(detections);

    const matchedTrackIds = new Set();

    for (const group of Object.keys(GROUP_PREFIX)) {
      const tracksInGroup = groupedTracks[group] ?? [];
      const dets = groupedDetections[group] ?? [];

      const highConf = dets.filter((d) => d.confidence >= HIGH_CONF_THRESHOLD);
      const lowConf = dets.filter((d) => d.confidence < HIGH_CONF_THRESHOLD);

      const unmatchedTracks = new Set(tracksInGroup.map((t) => t.id));

      // Pass 1: match high-confidence detections
      const unmatchedHigh = this._greedyMatch(tracksInGroup, highConf, unmatchedTracks, matchedTrackIds);

      // Pass 2: recover remaining tracks with low-confidence detections
      this._greedyMatch(tracksInGroup, lowConf, unmatchedTracks, matchedTrackIds);

      // Spawn new tracks for unmatched high-confidence detections only —
      // low-confidence detections should never create brand-new identities.
      for (const det of unmatchedHigh) {
        const id = this._nextId(group);
        const track = new Track(id, group, det.className, det.box, det.confidence);
        this.tracks.set(id, track);
      }
    }

    // Age and prune tracks that received no match this frame.
    for (const [id, track] of this.tracks.entries()) {
      if (!matchedTrackIds.has(id)) {
        track.age += 1;
        if (track.age > this.maxAge) {
          this.tracks.delete(id);
        }
      }
    }

    return this.getActiveTracks();
  }

  _groupTracksByGroup() {
    const out = {};
    for (const track of this.tracks.values()) {
      (out[track.group] ??= []).push(track);
    }
    return out;
  }

  _groupDetectionsByGroup(detections) {
    const out = {};
    for (const det of detections) {
      const group = classToGroup(det.className);
      (out[group] ??= []).push(det);
    }
    return out;
  }

  /**
   * Greedy IoU-based matching between existing tracks and a set of
   * detections. Mutates `unmatchedTracks` and `matchedTrackIds`. Returns the
   * list of detections that found no acceptable track.
   */
  _greedyMatch(tracksInGroup, detections, unmatchedTracks, matchedTrackIds) {
    const candidateTracks = tracksInGroup.filter((t) => unmatchedTracks.has(t.id));
    const pairs = [];

    for (const track of candidateTracks) {
      for (const det of detections) {
        if (det._consumed) continue;
        const score = iou(track.box, det.box);
        if (score >= this.iouThreshold) {
          pairs.push({ track, det, score });
        }
      }
    }

    // Greedily assign highest-IoU pairs first.
    pairs.sort((a, b) => b.score - a.score);

    const usedTracks = new Set();
    const unmatchedDetections = [];

    for (const { track, det } of pairs) {
      if (usedTracks.has(track.id) || det._consumed) continue;
      track.update(det.box, det.confidence, det.className);
      usedTracks.add(track.id);
      unmatchedTracks.delete(track.id);
      matchedTrackIds.add(track.id);
      det._consumed = true;
    }

    for (const det of detections) {
      if (!det._consumed) unmatchedDetections.push(det);
    }

    return unmatchedDetections;
  }

  getActiveTracks() {
    return Array.from(this.tracks.values())
      .filter((t) => t.age === 0) // Only emit tracks actively detected in the current frame (no ghost boxes)
      .map((t) => ({
        id: t.id,
        group: t.group,
        className: t.className,
        box: t.box,
        confidence: t.confidence,
        groundPoint: t.groundPoint,
        age: t.age,
        hits: t.hits,
      }));
  }

  reset() {
    this.tracks.clear();
    this._idCounters = { person: 0, vehicle: 0, animal: 0, other: 0 };
  }
}

export default Tracker;
