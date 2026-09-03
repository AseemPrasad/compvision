/**
 * src/analytics/AnprService.js
 *
 * Automatic Number Plate Recognition subsystem.
 *   1. Crops the vehicle bounding box from the source frame.
 * 2. Runs Tesseract.js OCR on the crop.
 *   3. Normalizes the raw OCR string into a canonical plate format
 *      (e.g. "GJ-18 AB 1234" -> "GJ18AB1234").
 *   4. Looks up the normalized plate against the SQLite `vehicles` table and
 *      labels it AUTHORIZED_VEHICLE / BLACKLISTED_VEHICLE / UNKNOWN_VEHICLE.
 *
 * Runs on a persistent Tesseract worker (created lazily, reused across
 * calls) so we avoid the multi-hundred-millisecond worker-spawn cost on
 * every single plate read — important since this executes on a throttled
 * frame interval, not every frame, but still needs to stay CPU-friendly.
 */

import { createWorker } from 'tesseract.js';
import { createCanvas, loadImage } from 'canvas';
import { findVehicleByPlate } from '../database/db.js';

// Indian plate convention: two letters (state), two digits (RTO code),
// 1-3 letters (series), 1-4 digits (unique number). We normalize first and
// validate loosely — OCR noise means a strict full-format regex would
// reject too many legitimate reads.
const PLATE_CLEAN_REGEX = /[^A-Z0-9]/g;
const PLATE_SHAPE_REGEX = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{1,4}$/;

// OCR accuracy on surveillance footage depends heavily on how large and
// clean the plate text is by the time Tesseract sees it. A vehicle crop
// straight from a 640px-wide downsampled frame is often tiny — this floor
// ensures crops get upscaled before OCR rather than fed in at native size.
const MIN_OCR_WIDTH = 400;

/**
 * Upscales (if needed) and converts a vehicle crop to grayscale with a
 * simple min-max contrast stretch, which measurably improves Tesseract's
 * hit rate on small/blurry plate text — whether the blur comes from a
 * moving vehicle or just a low-resolution wide-angle camera. Runs on the
 * already-cropped vehicle region only, so the cost stays bounded even
 * though it touches every pixel.
 * @param {Buffer} cropBuffer
 * @returns {Promise<Buffer>} PNG buffer (lossless — avoids re-compressing
 *   already-noisy small text with further JPEG artifacts before OCR)
 */
async function preprocessForOcr(cropBuffer) {
  const image = await loadImage(cropBuffer);
  const scale = image.width < MIN_OCR_WIDTH ? MIN_OCR_WIDTH / image.width : 1;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const pixelCount = width * height;

  const gray = new Float32Array(pixelCount);
  let min = 255;
  let max = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const o = i * 4;
    const g = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    gray[i] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }

  const range = Math.max(1, max - min);
  for (let i = 0; i < pixelCount; i += 1) {
    const stretched = ((gray[i] - min) / range) * 255;
    const o = i * 4;
    data[o] = data[o + 1] = data[o + 2] = stretched;
  }
  ctx.putImageData(imageData, 0, 0);

  return canvas.toBuffer('image/png');
}

/**
 * Normalizes a raw OCR plate string into canonical form.
 * "GJ-18 AB 1234" -> "GJ18AB1234"
 * "gj 18ab1234"   -> "GJ18AB1234"
 */
export function normalizePlate(rawText) {
  if (!rawText) return '';
  return rawText.toUpperCase().replace(PLATE_CLEAN_REGEX, '');
}

export function isPlausiblePlate(normalized) {
  return PLATE_SHAPE_REGEX.test(normalized);
}

export class AnprService {
  constructor() {
    /** @type {import('tesseract.js').Worker|null} */
    this._worker = null;
    this._initPromise = null;
  }

  async _ensureWorker() {
    if (this._worker) return this._worker;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      const worker = await createWorker('eng');
      await worker.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ',
        // PSM 11 = "sparse text: find as much text as possible in no
        // particular order". A vehicle crop isn't a page of text — the
        // plate is one small text region surrounded by car body, so the
        // default "assume a single uniform block" mode (PSM 3) tends to
        // either miss the plate or garble it by trying to read the whole
        // crop as one block. Sparse-text mode finds isolated text regions
        // like a plate far more reliably.
        tessedit_pageseg_mode: '11',
      });
      this._worker = worker;
      return worker;
    })();

    return this._initPromise;
  }

  /**
   * Crops a vehicle bounding box out of the full frame buffer and returns a
   * new JPEG buffer of just that region, for OCR and snapshot storage.
   * @param {Buffer} frameBuffer
   * @param {[number, number, number, number]} box - [x1, y1, x2, y2]
   */
  async cropVehicle(frameBuffer, box) {
    const image = await loadImage(frameBuffer);
    const [x1, y1, x2, y2] = box;
    const width = Math.max(1, Math.round(x2 - x1));
    const height = Math.max(1, Math.round(y2 - y1));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, x1, y1, width, height, 0, 0, width, height);
    return canvas.toBuffer('image/jpeg', { quality: 0.92 });
  }

  /**
   * Runs full ANPR pipeline on a vehicle crop: OCR -> normalize -> lookup.
   * @param {Buffer} vehicleCropBuffer
   * @returns {Promise<{rawText: string, normalizedPlate: string, plausible: boolean, match: object|null, label: string}>}
   */
  async recognizePlate(vehicleCropBuffer) {
    const worker = await this._ensureWorker();

    // The upscale/grayscale/contrast-stretch preprocessing below measurably
    // improves Tesseract's hit rate on small or motion-blurred plate crops
    // — feeding it the raw, small, color crop directly (as this used to do)
    // wastes the preprocessing work that was already written but never
    // actually plugged in.
    const preprocessed = await preprocessForOcr(vehicleCropBuffer);
    const { data } = await worker.recognize(preprocessed);
    const rawText = (data?.text || '').trim();
    const normalizedPlate = normalizePlate(rawText);
    const plausible = isPlausiblePlate(normalizedPlate);

    let match = null;
    let label = 'UNREADABLE';
    let role = null;

    if (normalizedPlate.length >= 4) {
      match = findVehicleByPlate(normalizedPlate) ?? null;
      if (match) {
        label = match.status === 'BLACKLISTED' ? 'BLACKLISTED_VEHICLE' : 'AUTHORIZED_VEHICLE';
        role = match.role ?? 'UNKNOWN';
      } else {
        label = 'UNKNOWN_VEHICLE';
        role = 'UNREGISTERED';
      }
    }

    return {
      rawText,
      normalizedPlate,
      plausible,
      confidence: data?.confidence ?? 0,
      match,
      label,
      role,
    };
  }

  /**
   * Convenience: crop + recognize in one call.
   * @param {Buffer} frameBuffer
   * @param {[number, number, number, number]} box
   */
  async recognizeFromFrame(frameBuffer, box) {
    const crop = await this.cropVehicle(frameBuffer, box);
    const result = await this.recognizePlate(crop);
    return { ...result, cropBuffer: crop };
  }

  async terminate() {
    if (this._worker) {
      await this._worker.terminate();
      this._worker = null;
      this._initPromise = null;
    }
  }
}

export default AnprService;
