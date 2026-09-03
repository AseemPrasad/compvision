/**
 * src/vision/VisionEngine.js
 *
 * Loads yolo11n.onnx via onnxruntime-node, runs object detection on incoming
 * camera frames, feeds detections through Tracker.js for persistent IDs, and
 * emits ANIMAL_DETECTED (INFO severity) so downstream boundary logic can
 * suppress false human-intrusion alarms.
 *
 * CPU-friendly by design:
 *   - Frames are already downsampled to MAX_PROCESSING_WIDTH by CameraManager
 *     before they ever reach here.
 *   - Canvas-based letterbox resize keeps aspect ratio and avoids distortion.
 *   - A single reusable Float32Array input buffer avoids per-frame GC churn.
 */

import { EventEmitter } from 'node:events';
import * as ort from 'onnxruntime-node';
import { createCanvas, loadImage } from 'canvas';
import { Tracker } from './Tracker.js';
import { getISTTimestamp } from '../utils/timeUtils.js';

// COCO class names, index-aligned with standard YOLO11 export ordering.
const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
  'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

// Classes IBVAP actually cares about for border-surveillance analytics.
const RELEVANT_CLASSES = new Set([
  'person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'dog', 'cow', 'horse', 'sheep',
]);

const ANIMAL_CLASSES = new Set(['dog', 'cow', 'horse', 'sheep']);

/**
 * Applies a letterbox resize (aspect-ratio preserving, padded) to fit the
 * model's square input while recording the scale/offset needed to project
 * detections back to original frame coordinates.
 */
function letterboxResize(image, targetSize) {
  const canvas = createCanvas(targetSize, targetSize);
  const ctx = canvas.getContext('2d');

  // Neutral grey padding — standard YOLO letterbox convention.
  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, targetSize, targetSize);

  const scale = Math.min(targetSize / image.width, targetSize / image.height);
  const newW = Math.round(image.width * scale);
  const newH = Math.round(image.height * scale);
  const padX = Math.floor((targetSize - newW) / 2);
  const padY = Math.floor((targetSize - newH) / 2);

  ctx.drawImage(image, 0, 0, image.width, image.height, padX, padY, newW, newH);

  return { canvas, ctx, scale, padX, padY };
}

/**
 * Converts canvas RGBA pixel data into a CHW, normalized [0,1] Float32Array
 * suitable for ONNX Runtime NCHW tensor input.
 */
function imageDataToCHWTensor(imageData, size) {
  const { data } = imageData; // RGBA, length = size*size*4
  const chwData = new Float32Array(3 * size * size);
  const plane = size * size;

  for (let i = 0; i < plane; i += 1) {
    const offset = i * 4;
    chwData[i] = data[offset] / 255; // R
    chwData[plane + i] = data[offset + 1] / 255; // G
    chwData[2 * plane + i] = data[offset + 2] / 255; // B
  }
  return chwData;
}

/**
 * Standard greedy NMS over a single class's candidate boxes.
 */
function nms(boxes, iouThreshold) {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
  const keep = [];

  while (sorted.length) {
    const best = sorted.shift();
    keep.push(best);

    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const iouScore = boxIoU(best.box, sorted[i].box);
      if (iouScore > iouThreshold) sorted.splice(i, 1);
    }
  }
  return keep;
}

function boxIoU(a, b) {
  const xA = Math.max(a[0], b[0]);
  const yA = Math.max(a[1], b[1]);
  const xB = Math.min(a[2], b[2]);
  const yB = Math.min(a[3], b[3]);
  const interW = Math.max(0, xB - xA);
  const interH = Math.max(0, yB - yA);
  const interArea = interW * interH;
  if (interArea === 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  return interArea / (areaA + areaB - interArea);
}

/**
 * VisionEngine
 *
 * Events emitted:
 *   'ready'            -> {}
 *   'detections'       -> { cameraId, frameNumber, tracks, timestamp }
 *   'ANIMAL_DETECTED'  -> { cameraId, trackId, className, box, timestamp, severity: 'INFO' }
 *   'error'            -> { cameraId, message }
 */
export class VisionEngine extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.modelPath]
   * @param {number} [opts.inputSize]
   * @param {number} [opts.confidenceThreshold]
   * @param {number} [opts.iouThreshold]
   * @param {number} [opts.analyticsFrameInterval] - how often (in frames) to flag frames for heavy downstream analytics
   */
  constructor(opts = {}) {
    super();
    this.modelPath = opts.modelPath || process.env.YOLO_MODEL_PATH || './assets/models/yolo11n.onnx';
    this.inputSize = opts.inputSize || Number.parseInt(process.env.YOLO_INPUT_SIZE ?? '640', 10);
    this.confidenceThreshold = opts.confidenceThreshold
      ?? Number.parseFloat(process.env.YOLO_CONFIDENCE_THRESHOLD ?? '0.45');
    this.iouThreshold = opts.iouThreshold ?? Number.parseFloat(process.env.YOLO_IOU_THRESHOLD ?? '0.45');
    this.analyticsFrameInterval = opts.analyticsFrameInterval
      ?? Number.parseInt(process.env.ANALYTICS_FRAME_INTERVAL ?? '7', 10);

    /** @type {ort.InferenceSession|null} */
    this.session = null;

    // One Tracker instance per camera keeps track IDs independent per feed.
    /** @type {Map<string, Tracker>} */
    this.trackers = new Map();

    // Per-camera frame counters, used purely to decide when to flag a frame
    // as eligible for throttled heavy analytics (ANPR / face) downstream.
    this._frameCounters = new Map();

    // Per-camera detection tuning overrides. Any field left unset falls
    // back to this engine's global defaults (confidenceThreshold,
    // iouThreshold, analyticsFrameInterval) set above. `frameStride` lets
    // a given camera run YOLO inference only every Nth frame — mirrors the
    // "--vid-stride" idea from frame-skipping CV pipelines: cheaper cameras
    // (e.g. a wide elevated watchtower view) can run inference less often
    // than a high-priority vehicle checkpoint.
    /** @type {Map<string, {confidenceThreshold?: number, iouThreshold?: number, frameStride?: number, analyticsFrameInterval?: number}>} */
    this.cameraConfigs = new Map();

    this._ready = false;
  }

  async init() {
    try {
      this.session = await ort.InferenceSession.create(this.modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      this._ready = true;
      this.emit('ready', {});
    } catch (err) {
      this.emit('error', { message: `Failed to load YOLO model at ${this.modelPath}: ${err.message}` });
      throw err;
    }
  }

  _getTracker(cameraId) {
    if (!this.trackers.has(cameraId)) {
      this.trackers.set(cameraId, new Tracker());
    }
    return this.trackers.get(cameraId);
  }

  /**
   * Sets or updates per-camera detection tuning. Call this on camera
   * registration and again any time parameters are changed live (e.g. via
   * PATCH /api/cameras/:cameraId/params). Unspecified fields are left
   * untouched if a config already exists for this camera.
   * @param {string} cameraId
   * @param {{confidenceThreshold?: number, iouThreshold?: number, frameStride?: number, analyticsFrameInterval?: number}} config
   */
  setCameraConfig(cameraId, config = {}) {
    const existing = this.cameraConfigs.get(cameraId) ?? {};
    this.cameraConfigs.set(cameraId, {
      confidenceThreshold: config.confidenceThreshold ?? existing.confidenceThreshold,
      iouThreshold: config.iouThreshold ?? existing.iouThreshold,
      frameStride: config.frameStride ?? existing.frameStride ?? 1,
      analyticsFrameInterval: config.analyticsFrameInterval ?? existing.analyticsFrameInterval,
    });
  }

  getCameraConfig(cameraId) {
    const override = this.cameraConfigs.get(cameraId) ?? {};
    return {
      confidenceThreshold: override.confidenceThreshold ?? this.confidenceThreshold,
      iouThreshold: override.iouThreshold ?? this.iouThreshold,
      frameStride: override.frameStride ?? 1,
      analyticsFrameInterval: override.analyticsFrameInterval ?? this.analyticsFrameInterval,
    };
  }

  /**
   * Determines whether the given frame number for a camera should be routed
   * to heavy analytics (ANPR / face embeddings) — every Nth frame only, to
   * keep CPU usage bounded on a single-laptop deployment. Uses this
   * camera's own analyticsFrameInterval override if one is set.
   */
  isAnalyticsFrame(cameraId, frameNumber) {
    const { analyticsFrameInterval } = this.getCameraConfig(cameraId);
    return frameNumber % analyticsFrameInterval === 0;
  }

  /**
   * Runs detection + tracking on a single JPEG frame buffer.
   * @param {string} cameraId
   * @param {Buffer} frameBuffer - JPEG bytes
   * @param {number} frameNumber
   * @returns {Promise<Array>} active tracks for this camera after this frame
   */
  async processFrame(cameraId, frameBuffer, frameNumber) {
    if (!this._ready || !this.session) {
      throw new Error('VisionEngine.init() must complete before processing frames');
    }

    const { confidenceThreshold, iouThreshold, frameStride } = this.getCameraConfig(cameraId);
    const tracker = this._getTracker(cameraId);

    // Frame-stride skipping: run full YOLO inference only every Nth frame
    // for this camera. On a skipped frame we deliberately do NOT touch the
    // tracker at all — the previously computed tracks are simply returned
    // as-is, so downstream consumers (telemetry broadcast, spatial checks)
    // see a brief "hold" on stale positions rather than paying the full
    // inference cost every frame. This mirrors a "--vid-stride" style
    // frame-skip used in other CV pipelines to trade a little temporal
    // precision for meaningfully lower CPU load, and is why higher-stride
    // cameras (e.g. a wide low-priority watchtower view) cost less than a
    // stride=1 camera watching a critical checkpoint.
    if (frameStride > 1 && frameNumber % frameStride !== 0) {
      return tracker.getActiveTracks();
    }

    let image;
    try {
      image = await loadImage(frameBuffer);
    } catch (err) {
      this.emit('error', { cameraId, message: `Failed to decode frame: ${err.message}` });
      return [];
    }

    const { canvas, scale, padX, padY } = letterboxResize(image, this.inputSize);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, this.inputSize, this.inputSize);
    const chwData = imageDataToCHWTensor(imageData, this.inputSize);

    const inputTensor = new ort.Tensor('float32', chwData, [1, 3, this.inputSize, this.inputSize]);
    const inputName = this.session.inputNames[0];
    const outputName = this.session.outputNames[0];

    let results;
    try {
      results = await this.session.run({ [inputName]: inputTensor });
    } catch (err) {
      this.emit('error', { cameraId, message: `Inference failed: ${err.message}` });
      return [];
    }

    const output = results[outputName];
    const detections = this._decodeYolo11Output(
      output, scale, padX, padY, image.width, image.height,
      confidenceThreshold, iouThreshold,
    );

    const tracks = tracker.update(detections);

    const timestamp = getISTTimestamp();

    for (const track of tracks) {
      if (track.age === 0 && ANIMAL_CLASSES.has(track.className)) {
        this.emit('ANIMAL_DETECTED', {
          cameraId,
          trackId: track.id,
          className: track.className,
          box: track.box,
          groundPoint: track.groundPoint,
          severity: 'INFO',
          timestamp,
        });
      }
    }

    this.emit('detections', {
      cameraId,
      frameNumber,
      tracks,
      isAnalyticsFrame: this.isAnalyticsFrame(cameraId, frameNumber),
      timestamp,
    });

    return tracks;
  }

  /**
   * Decodes a YOLO11 ONNX output tensor of shape [1, 4+numClasses, numAnchors]
   * into filtered, NMS'd, original-image-space detections restricted to the
   * classes IBVAP cares about. Confidence/IoU thresholds are passed in
   * per-call so each camera can apply its own tuned values against the same
   * loaded model.
   */
  _decodeYolo11Output(output, scale, padX, padY, origWidth, origHeight, confidenceThreshold, iouThreshold) {
    const dims = output.dims; // [1, 84, N]
    const numAttrs = dims[1];
    const numAnchors = dims[2];
    const numClasses = numAttrs - 4;
    const data = output.data;

    const perClassBoxes = new Map();

    for (let i = 0; i < numAnchors; i += 1) {
      // Layout is channel-major: attribute a at anchor i => data[a * numAnchors + i]
      const cx = data[0 * numAnchors + i];
      const cy = data[1 * numAnchors + i];
      const w = data[2 * numAnchors + i];
      const h = data[3 * numAnchors + i];

      let bestClass = -1;
      let bestScore = 0;
      for (let c = 0; c < numClasses; c += 1) {
        const score = data[(4 + c) * numAnchors + i];
        if (score > bestScore) {
          bestScore = score;
          bestClass = c;
        }
      }

      if (bestScore < confidenceThreshold) continue;

      const className = COCO_CLASSES[bestClass];
      if (!className || !RELEVANT_CLASSES.has(className)) continue;

      // Undo letterbox: map from model input space back to original frame.
      const x1Model = cx - w / 2;
      const y1Model = cy - h / 2;
      const x2Model = cx + w / 2;
      const y2Model = cy + h / 2;

      const x1 = Math.max(0, (x1Model - padX) / scale);
      const y1 = Math.max(0, (y1Model - padY) / scale);
      const x2 = Math.min(origWidth, (x2Model - padX) / scale);
      const y2 = Math.min(origHeight, (y2Model - padY) / scale);

      if (x2 <= x1 || y2 <= y1) continue;

      const box = { className, box: [x1, y1, x2, y2], confidence: bestScore };
      if (!perClassBoxes.has(className)) perClassBoxes.set(className, []);
      perClassBoxes.get(className).push(box);
    }

    const finalDetections = [];
    for (const boxes of perClassBoxes.values()) {
      finalDetections.push(...nms(boxes, iouThreshold));
    }
    return finalDetections;
  }

  resetTracker(cameraId) {
    this.trackers.get(cameraId)?.reset();
  }

  removeCamera(cameraId) {
    this.trackers.delete(cameraId);
    this._frameCounters.delete(cameraId);
  }
}

export default VisionEngine;
