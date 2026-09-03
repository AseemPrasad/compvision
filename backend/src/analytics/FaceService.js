/**
 * src/analytics/FaceService.js
 *
 * Software-based face detection, 128-d descriptor extraction, and
 * identification using @vladmandic/face-api backed by @tensorflow/tfjs-node,
 * with `canvas` supplying the Node-compatible Image/Canvas/ImageData shims
 * face-api expects in a non-browser environment.
 *
 * Identification is a straightforward nearest-neighbour search over the
 * SQLite `face_registry` embeddings using Euclidean distance — sufficient
 * accuracy at hackathon scale (tens of enrolled faces), and cheap enough to
 * run on the throttled analytics frame interval on a single laptop CPU.
 */

import '@tensorflow/tfjs-node'; // registers the Node CPU backend for face-api
import * as faceapi from '@vladmandic/face-api';
import { Canvas, Image, ImageData, loadImage } from 'canvas';
import { getAllFaces } from '../database/db.js';

// face-api.js expects browser-global Canvas/Image/ImageData constructors —
// monkeypatch them onto its env in the Node runtime.
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MATCH_DISTANCE_THRESHOLD = Number.parseFloat(
  process.env.FACE_MATCH_DISTANCE_THRESHOLD ?? '0.5',
);
const MODELS_PATH = process.env.FACE_MODELS_PATH || './assets/models/face-api-models';

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export class FaceService {
  constructor() {
    this._ready = false;
  }

  async init() {
    if (this._ready) return;

    await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_PATH);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_PATH);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH);

    this._ready = true;
  }

  _assertReady() {
    if (!this._ready) {
      throw new Error('FaceService.init() must complete before use');
    }
  }

  /**
   * Detects faces in an image buffer (a full frame or a person-track crop)
   * and returns 128-d descriptors alongside detection boxes.
   * @param {Buffer} imageBuffer
   * @returns {Promise<Array<{box: {x:number,y:number,width:number,height:number}, descriptor: Float32Array, detectionScore: number}>>}
   */
  async detectFaces(imageBuffer) {
    this._assertReady();

    const image = await loadImage(imageBuffer);

    const detections = await faceapi
      .detectAllFaces(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    return detections.map((d) => ({
      box: {
        x: d.detection.box.x,
        y: d.detection.box.y,
        width: d.detection.box.width,
        height: d.detection.box.height,
      },
      descriptor: d.descriptor,
      detectionScore: d.detection.score,
    }));
  }

  /**
   * Finds the closest enrolled face in the SQLite face_registry for a given
   * 128-d descriptor.
   * @param {Float32Array|number[]} descriptor
   * @returns {{personCode: string, label: string, status: string, distance: number}|null}
   */
  identify(descriptor) {
    const enrolled = getAllFaces();
    if (!enrolled.length) return null;

    let best = null;
    for (const face of enrolled) {
      const distance = euclideanDistance(descriptor, face.embedding);
      if (!best || distance < best.distance) {
        best = { personCode: face.person_code, label: face.label, status: face.status, distance };
      }
    }

    if (!best || best.distance > MATCH_DISTANCE_THRESHOLD) return null;
    return best;
  }

  /**
   * Convenience: detect + identify every face found in an image.
   * @param {Buffer} imageBuffer
   * @returns {Promise<Array<{box: object, descriptor: Float32Array, match: object|null, label: string}>>}
   */
  async recognizeFromImage(imageBuffer) {
    const faces = await this.detectFaces(imageBuffer);

    return faces.map((face) => {
      const match = this.identify(face.descriptor);
      const label = match
        ? (match.status === 'WATCHLIST' ? 'WATCHLIST_PERSON' : 'AUTHORIZED')
        : 'UNKNOWN_PERSON';
      return { ...face, match, label };
    });
  }

  /**
   * Computes a plain-array descriptor suitable for storing in
   * face_registry.embedding_json (enrolment flow used by POST /api/faces).
   * @param {Buffer} imageBuffer
   */
  async extractSingleDescriptorForEnrolment(imageBuffer) {
    const faces = await this.detectFaces(imageBuffer);
    if (!faces.length) {
      throw new Error('No face detected in the provided enrolment image');
    }
    // Enrolment expects exactly one clear face; pick the highest-confidence one.
    const best = faces.reduce((a, b) => (b.detectionScore > a.detectionScore ? b : a));
    return Array.from(best.descriptor);
  }
}

export default FaceService;
