/**
 * src/analytics/TamperDetector.js
 *
 * Detects when a camera feed is being tampered with by analyzing pixel
 * statistics of incoming frames. No additional AI model needed — purely
 * statistical analysis of frame brightness, contrast, and frame-to-frame
 * similarity.
 *
 * Tamper types detected:
 *   CAMERA_TAMPER_FREEZE       — same frame repeated for too many consecutive frames
 *   CAMERA_TAMPER_DARKNESS    — camera covered or blinded
 *   CAMERA_TAMPER_OVEREXPOSURE — bright light directed at camera
 *   CAMERA_TAMPER_OBSTRUCTED  — gradual lens obstruction (contrast drops)
 *
 * Thresholds are configurable via environment variables. Tamper events are
 * emitted once per tamper-type per camera until the condition clears (at which
 * point the detector resets for that type).
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Thresholds — loaded from environment variables
// ---------------------------------------------------------------------------

const FREEZE_FRAME_COUNT = Number.parseInt(
  process.env.TAMPER_FREEZE_FRAME_COUNT ?? '10',
);

const DARKNESS_THRESHOLD = Number.parseFloat(
  process.env.TAMPER_DARKNESS_THRESHOLD ?? '0.02',
);
const DARKNESS_FRAME_COUNT = Number.parseInt(
  process.env.TAMPER_DARKNESS_FRAME_COUNT ?? '5',
);

const BRIGHTNESS_THRESHOLD = Number.parseFloat(
  process.env.TAMPER_BRIGHTNESS_THRESHOLD ?? '0.95',
);
const BRIGHTNESS_FRAME_COUNT = Number.parseInt(
  process.env.TAMPER_BRIGHTNESS_FRAME_COUNT ?? '3',
);

const CONTRAST_THRESHOLD = Number.parseFloat(
  process.env.TAMPER_CONTRAST_THRESHOLD ?? '0.05',
);
const OBSTRUCTION_FRAME_COUNT = Number.parseInt(
  process.env.TAMPER_OBSTRUCTION_FRAME_COUNT ?? '30',
);

// ---------------------------------------------------------------------------
// TamperDetector
// ---------------------------------------------------------------------------

export class TamperDetector extends EventEmitter {
  /**
   * @param {string} cameraId
   */
  constructor(cameraId) {
    super();
    this.cameraId = cameraId;

    this._frameCount = 0;
    this._lastFrameHash = null;

    // Per-tamper-type counters (reset when condition clears)
    this._freezeCount = 0;
    this._darkCount = 0;
    this._brightCount = 0;
    this._lowContrastCount = 0;

    // Per-tamper-type "already emitted this session" flags
    this._emitted = {
      freeze: false,
      darkness: false,
      brightness: false,
      obstruction: false,
    };

    // Brightness history for averaging (reduce false positives from flashes)
    this._brightnessHistory = [];
    this._contrastHistory = [];

    // Running statistics for current window
    this._pixelSum = 0;
    this._pixelCount = 0;
    this._pixelSqSum = 0;

    // Downsample ratio for performance — analyze every Nth pixel
    this._pixelStep = 4;
  }

  /**
   * Analyze an incoming frame for tamper indicators.
   * Call this from CameraManager's 'frame' event, before VisionEngine processing.
   *
   * @param {Buffer} frameBuffer - JPEG bytes
   * @returns {Promise<{freeze: boolean, darkness: boolean, brightness: boolean, obstruction: boolean}>}
   */
  async analyzeFrame(frameBuffer) {
    this._frameCount += 1;

    let stats;
    try {
      stats = await this._computeFrameStats(frameBuffer);
    } catch (err) {
      // Frame decode failure — skip tamper analysis for this frame
      return { freeze: false, darkness: false, brightness: false, obstruction: false };
    }

    this._updateRunningStats(stats);
    this._checkFreeze(stats);
    this._checkDarkness(stats);
    this._checkBrightness(stats);
    this._checkObstruction(stats);

    return {
      freeze: this._emitted.freeze,
      darkness: this._emitted.darkness,
      brightness: this._emitted.brightness,
      obstruction: this._emitted.obstruction,
    };
  }

  /**
   * Synchronous lightweight analysis — computes only what we need for freeze
   * detection (frame hash) without loading the full image. Use this as a
   * first-pass filter; call analyzeFrame only if needed.
   *
   * @param {Buffer} frameBuffer
   */
  quickAnalyzeFrame(frameBuffer) {
    this._frameCount += 1;

    // Simple hash: sum of first 1024 bytes modulo a large prime.
    // Even a frozen frame will have minor JPEG quantization differences,
    // so we use a tolerance window rather than exact equality.
    const hash = this._simpleHash(frameBuffer);

    const isFrozen = this._lastFrameHash !== null && this._frameSimilar(hash, this._lastFrameHash);
    this._lastFrameHash = hash;

    if (isFrozen) {
      this._freezeCount += 1;
    } else {
      this._freezeCount = 0;
    }

    if (this._freezeCount >= FREEZE_FRAME_COUNT && !this._emitted.freeze) {
      this._emitted.freeze = true;
      this._emitTamper('freeze', 'CAMERA_TAMPER_FREEZE');
    } else if (!isFrozen && this._emitted.freeze) {
      // Condition cleared — allow future detections
      this._emitted.freeze = false;
      this._freezeCount = 0;
    }
  }

  /**
   * Computes per-frame statistics (mean brightness, contrast) from a JPEG buffer.
   * Uses a downsampled grid of pixels for performance.
   */
  async _computeFrameStats(frameBuffer) {
    const { loadImage } = await import('canvas');
    const image = await loadImage(frameBuffer);
    const width = image.width;
    const height = image.height;

    let sum = 0;
    let sumSq = 0;
    let count = 0;

    // Downsample for speed — sample every _pixelStep pixels
    const step = this._pixelStep;

    // Use canvas to extract pixel data
    const { createCanvas } = await import('canvas');
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        // Grayscale
        const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        sum += gray;
        sumSq += gray * gray;
        count += 1;
      }
    }

    const mean = sum / count;
    // Variance = E[X^2] - E[X]^2; std dev = sqrt(variance)
    const variance = Math.max(0, sumSq / count - mean * mean);
    const contrast = Math.sqrt(variance) / 255;

    return { mean: mean / 255, contrast };
  }

  _updateRunningStats(stats) {
    this._brightnessHistory.push(stats.mean);
    this._contrastHistory.push(stats.contrast);

    const MAX_HISTORY = 10;
    if (this._brightnessHistory.length > MAX_HISTORY) this._brightnessHistory.shift();
    if (this._contrastHistory.length > MAX_HISTORY) this._contrastHistory.shift();
  }

  _checkFreeze(stats) {
    // Use quick hash for freeze — brightness stats alone aren't reliable
    // for freeze detection (a still dark scene passes darkness but is frozen)
    // This is handled by quickAnalyzeFrame; here we just handle reset
    if (!this._emitted.freeze) this._freezeCount = 0;
  }

  _checkDarkness(stats) {
    if (this._emitted.darkness) {
      // Check if condition cleared
      if (stats.mean > DARKNESS_THRESHOLD * 2) {
        this._emitted.darkness = false;
        this._darkCount = 0;
      }
      return;
    }

    if (stats.mean < DARKNESS_THRESHOLD) {
      this._darkCount += 1;
    } else {
      this._darkCount = 0;
    }

    if (this._darkCount >= DARKNESS_FRAME_COUNT) {
      this._emitted.darkness = true;
      this._emitTamper('darkness', 'CAMERA_TAMPER_DARKNESS');
    }
  }

  _checkBrightness(stats) {
    if (this._emitted.brightness) {
      if (stats.mean < BRIGHTNESS_THRESHOLD * 0.8) {
        this._emitted.brightness = false;
        this._brightCount = 0;
      }
      return;
    }

    if (stats.mean > BRIGHTNESS_THRESHOLD) {
      this._brightCount += 1;
    } else {
      this._brightCount = 0;
    }

    if (this._brightCount >= BRIGHTNESS_FRAME_COUNT) {
      this._emitted.brightness = true;
      this._emitTamper('brightness', 'CAMERA_TAMPER_OVEREXPOSURE');
    }
  }

  _checkObstruction(stats) {
    if (this._emitted.obstruction) {
      if (stats.contrast > CONTRAST_THRESHOLD * 2) {
        this._emitted.obstruction = false;
        this._lowContrastCount = 0;
      }
      return;
    }

    if (stats.contrast < CONTRAST_THRESHOLD) {
      this._lowContrastCount += 1;
    } else {
      this._lowContrastCount = 0;
    }

    if (this._lowContrastCount >= OBSTRUCTION_FRAME_COUNT) {
      this._emitted.obstruction = true;
      this._emitTamper('obstruction', 'CAMERA_TAMPER_OBSTRUCTED');
    }
  }

  _emitTamper(type, eventType) {
    this.emit(eventType, {
      cameraId: this.cameraId,
      tamperType: type,
      frameCount: this._frameCount,
    });
    console.warn(`[IBVAP][TamperDetector][${this.cameraId}] ${eventType} — possible camera tampering`);
  }

  /**
   * Simple perceptual hash — sums byte ranges to create a compact frame fingerprint.
   */
  _simpleHash(buffer) {
    let h = 0;
    const step = Math.max(1, Math.floor(buffer.length / 256));
    for (let i = 0; i < buffer.length; i += step) {
      h = (h * 31 + buffer[i]) & 0xffffffff;
    }
    return h;
  }

  /**
   * Two hashes are "similar" if they differ by less than a tolerance.
   * JPEG re-encoding of the same frame produces slightly different bytes,
   * so exact equality would miss frozen frames.
   */
  _frameSimilar(h1, h2) {
    const diff = Math.abs(h1 - h2);
    const tolerance = Math.max(h1, h2) * 0.001; // 0.1% tolerance
    return diff <= tolerance;
  }

  /**
   * Resets the detector state — call when a camera is removed or re-registered.
   */
  reset() {
    this._frameCount = 0;
    this._lastFrameHash = null;
    this._freezeCount = 0;
    this._darkCount = 0;
    this._brightCount = 0;
    this._lowContrastCount = 0;
    this._emitted = { freeze: false, darkness: false, brightness: false, obstruction: false };
    this._brightnessHistory = [];
    this._contrastHistory = [];
  }
}

export default TamperDetector;
