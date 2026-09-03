/**
 * src/camera/CameraManager.js
 *
 * Multi-source video ingestion for IBVAP.
 *
 * Supports:
 *   - RTSP (e.g. Android/iOS "IP Webcam" apps: rtsp://192.168.1.X:8080/h264_pcm.sdp)
 *   - HTTP MJPEG streams
 *   - Local looping MP4 files (demo fallback)
 *
 * Frames are extracted via fluent-ffmpeg, piped out as a continuous MJPEG
 * byte stream, and re-assembled into discrete JPEG buffers here (no temp
 * files touch disk on the hot path). Each camera gets its own ffmpeg child
 * process, tracked independently so one feed dying never affects another.
 *
 * On stream failure this manager retries with exponential backoff and
 * reflects camera health (ONLINE / RECONNECTING / OFFLINE) into SQLite via
 * updateCameraStatus(), without ever crashing the main Node.js process —
 * ffmpeg errors and stream-end events are caught and funneled into the
 * reconnect loop instead of thrown.
 */

import { EventEmitter } from 'node:events';
import ffmpeg from 'fluent-ffmpeg';
import { updateCameraStatus, updateCameraFps } from '../database/db.js';
import { getISTTimestamp } from '../utils/timeUtils.js';

const JPEG_SOI = Buffer.from([0xff, 0xd8]); // Start Of Image marker
const JPEG_EOI = Buffer.from([0xff, 0xd9]); // End Of Image marker

const BASE_RECONNECT_DELAY_MS = Number.parseInt(process.env.DEFAULT_RECONNECT_BASE_DELAY_MS ?? '1000', 10);
const MAX_RECONNECT_DELAY_MS = Number.parseInt(process.env.DEFAULT_RECONNECT_MAX_DELAY_MS ?? '30000', 10);
const MAX_RECONNECT_ATTEMPTS = Number.parseInt(process.env.DEFAULT_RECONNECT_MAX_ATTEMPTS ?? '0', 10); // 0 = infinite

/**
 * Internal per-camera ingestion state. One instance per registered camera.
 */
class CameraStream {
  /**
   * @param {object} config
   * @param {string} config.cameraId
   * @param {string} config.sourceType - 'RTSP' | 'MJPEG' | 'MP4' | 'HTTP'
   * @param {string} config.sourceUrl
   * @param {boolean} [config.loop] - loop local MP4 files (default true for MP4)
   * @param {CameraManager} manager
   */
  constructor(config, manager) {
    this.cameraId = config.cameraId;
    this.sourceType = config.sourceType;
    this.sourceUrl = config.sourceUrl;
    this.loop = config.loop ?? config.sourceType === 'MP4';
    this.manager = manager;

    this.command = null;
    this.frameNumber = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.stopped = false;
    this.jpegBuffer = Buffer.alloc(0);

    // FPS estimation
    this._fpsWindowStart = Date.now();
    this._fpsWindowFrames = 0;
  }

  start() {
    this.stopped = false;
    this._launchFfmpeg();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._killCommand();
    this._setStatus('OFFLINE');
  }

  _killCommand() {
    if (this.command) {
      try {
        this.command.kill('SIGKILL');
      } catch (_err) {
        // process may already be dead — safe to ignore
      }
      this.command = null;
    }
  }

  _setStatus(status) {
    try {
      updateCameraStatus(this.cameraId, status);
    } catch (err) {
      this.manager.emit('error', {
        cameraId: this.cameraId,
        message: `Failed to persist camera status: ${err.message}`,
      });
    }
    this.manager.emit('status', {
      cameraId: this.cameraId,
      status,
      timestamp: getISTTimestamp(),
    });
  }

  _buildFfmpegInputOptions() {
    const opts = [];
    if (this.sourceType === 'RTSP') {
      opts.push('-rtsp_transport', 'tcp');
      // NOTE: '-stimeout' was the RTSP socket-timeout option in older ffmpeg
      // builds. ffmpeg 5+ renamed this to '-timeout' (still microseconds).
      // Using the old name causes "Unrecognized option 'stimeout'" on
      // modern ffmpeg (confirmed failing on ffmpeg 8.1.2).
      opts.push('-timeout', '5000000'); // 5s socket timeout (microseconds)
    }
    if (this.sourceType === 'MP4' && this.loop) {
      opts.push('-stream_loop', '-1');
    }
    return opts;
  }

  _launchFfmpeg() {
    if (this.stopped) return;

    this._setStatus(this.reconnectAttempts > 0 ? 'RECONNECTING' : 'ONLINE');

    const maxWidth = Number.parseInt(process.env.MAX_PROCESSING_WIDTH ?? '640', 10);

    const command = ffmpeg(this.sourceUrl)
      .inputOptions(this._buildFfmpegInputOptions())
      .outputOptions([
        '-an', // no audio
        `-vf scale='min(${maxWidth},iw)':-2`, // downsample for CPU-friendly inference
        '-q:v 5',
        '-f mjpeg',
      ])
      .on('start', () => {
        this.manager.emit('info', {
          cameraId: this.cameraId,
          message: `ffmpeg ingestion started for ${this.sourceType} source`,
        });
      })
      .on('error', (err) => {
        // Swallow the error here — never let ffmpeg errors crash the process.
        this.manager.emit('error', {
          cameraId: this.cameraId,
          message: `Stream error: ${err.message}`,
        });
        this._handleStreamDrop();
      })
      .on('end', () => {
        // Non-looping sources (e.g. a finite MP4) end naturally; treat as a
        // drop so it gets retried/looped rather than silently going dark.
        this._handleStreamDrop();
      });

    this.command = command;

    const stream = command.pipe();
    stream.on('data', (chunk) => this._onData(chunk));
    stream.on('error', (err) => {
      this.manager.emit('error', {
        cameraId: this.cameraId,
        message: `Output stream error: ${err.message}`,
      });
      this._handleStreamDrop();
    });
  }

  _onData(chunk) {
    this.jpegBuffer = Buffer.concat([this.jpegBuffer, chunk]);

    // Extract every complete JPEG frame currently buffered.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const start = this.jpegBuffer.indexOf(JPEG_SOI);
      if (start === -1) {
        this.jpegBuffer = Buffer.alloc(0);
        break;
      }
      const end = this.jpegBuffer.indexOf(JPEG_EOI, start + 2);
      if (end === -1) {
        // Incomplete frame — keep from `start` onward and wait for more data.
        if (start > 0) this.jpegBuffer = this.jpegBuffer.subarray(start);
        break;
      }

      const frame = this.jpegBuffer.subarray(start, end + 2);
      this.jpegBuffer = this.jpegBuffer.subarray(end + 2);

      this._emitFrame(frame);
    }
  }

  _emitFrame(frameBuffer) {
    this.frameNumber += 1;
    this.reconnectAttempts = 0; // successful data resets backoff

    this._fpsWindowFrames += 1;
    const elapsedMs = Date.now() - this._fpsWindowStart;
    if (elapsedMs >= 2000) {
      const fps = this._fpsWindowFrames / (elapsedMs / 1000);
      updateCameraFps(this.cameraId, Number(fps.toFixed(2)));
      this._fpsWindowFrames = 0;
      this._fpsWindowStart = Date.now();
    }

    if (this.frameNumber === 1 || this.reconnectAttempts === 0) {
      this._setStatus('ONLINE');
    }

    this.manager.emit('frame', {
      cameraId: this.cameraId,
      frameBuffer,
      frameNumber: this.frameNumber,
      timestamp: getISTTimestamp(),
    });
  }

  _handleStreamDrop() {
    if (this.stopped) return;
    this._killCommand();
    this._setStatus('RECONNECTING');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped) return;

    if (MAX_RECONNECT_ATTEMPTS > 0 && this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._setStatus('OFFLINE');
      this.manager.emit('error', {
        cameraId: this.cameraId,
        message: `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Marking camera OFFLINE.`,
      });
      return;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts += 1;

    this.manager.emit('info', {
      cameraId: this.cameraId,
      message: `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._launchFfmpeg();
    }, delay);
  }
}

/**
 * CameraManager orchestrates zero or more CameraStream ingestion pipelines
 * and republishes their lifecycle as a single EventEmitter surface:
 *   'frame'  -> { cameraId, frameBuffer, frameNumber, timestamp }
 *   'status' -> { cameraId, status, timestamp }
 *   'info'   -> { cameraId, message }
 *   'error'  -> { cameraId, message }
 */
export class CameraManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, CameraStream>} */
    this.streams = new Map();
  }

  /**
   * Registers and immediately starts ingesting a camera source.
   * @param {{cameraId: string, sourceType: string, sourceUrl: string, loop?: boolean}} config
   */
  addCamera(config) {
    if (this.streams.has(config.cameraId)) {
      throw new Error(`Camera ${config.cameraId} is already registered`);
    }
    const stream = new CameraStream(config, this);
    this.streams.set(config.cameraId, stream);
    stream.start();
    return stream;
  }

  removeCamera(cameraId) {
    const stream = this.streams.get(cameraId);
    if (!stream) return false;
    stream.stop();
    this.streams.delete(cameraId);
    return true;
  }

  getStream(cameraId) {
    return this.streams.get(cameraId);
  }

  listCameraIds() {
    return Array.from(this.streams.keys());
  }

  stopAll() {
    for (const stream of this.streams.values()) {
      stream.stop();
    }
    this.streams.clear();
  }
}

export default CameraManager;
