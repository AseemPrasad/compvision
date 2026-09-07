/**
 * src/server.js
 *
 * IBVAP application entrypoint. Wires together:
 *   CameraManager -> VisionEngine -> SpatialEngine -> AnalyticsEngine -> RiskEngine -> SQLite -> WebSocket
 *
 * Exposes:
 *   - REST API for managing cameras, zones, faces, vehicles, events, alerts
 *   - WebSocket endpoint (/ws/stream) broadcasting live telemetry and alerts
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  insertCamera,
  getCamera,
  getAllCameras,
  deleteCamera,
  updateCameraDetectionParams,
  insertZone,
  getZonesForCamera,
  getAllZones,
  deleteZone,
  upsertVehicle,
  getAllVehicles,
  upsertFace,
  getAllFaces,
  insertEvent,
  searchEvents,
  insertAlert,
  getAllAlerts,
  acknowledgeAlert,
} from './database/db.js';

import { CameraManager } from './camera/CameraManager.js';
import { VisionEngine } from './vision/VisionEngine.js';
import { SpatialEngine } from './spatial/SpatialEngine.js';
import { AnalyticsEngine } from './analytics/AnalyticsEngine.js';
import { normalizePlate } from './analytics/AnprService.js';
import { RiskEngine } from './risk/RiskEngine.js';
import { getISTTimestamp, getISTIso, isNightTimeIST } from './utils/timeUtils.js';
import { FaceService } from './analytics/FaceService.js';
import { sendUnauthorizedVehicleAlert, sendBoundaryCrossingAlert, sendGenericAlert, verifyMailerConfig } from './notifications/Mailer.js';
import { BehaviorEngine } from './analytics/BehaviorEngine.js';
import { TamperDetector } from './analytics/TamperDetector.js';
import { C2Webhook } from './integration/C2Webhook.js';
import { MQTTAdapter } from './integration/MQTTAdapter.js';
import { TAKAdapter } from './integration/TAKAdapter.js';
import { SMSAlert } from './notifications/SMSAlert.js';
import { RadioAlert } from './notifications/RadioAlert.js';

// ---------------------------------------------------------------------------
// App & HTTP/WebSocket bootstrap
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // face/plate enrolment images arrive base64-encoded

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path !== '/api/health') { // don't log health checks
      console.log(`${req.method.padEnd(7)} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR)); // serves public/viewer.html at "/"

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || './storage/snapshots';
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/stream' });

/** Broadcasts a JSON payload to every connected WebSocket client. */
function broadcast(type, payload) {
  const message = JSON.stringify({ type, payload, ts: getISTTimestamp() });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'WELCOME',
    payload: { message: 'Connected to IBVAP live stream', cameras: getAllCameras() },
    ts: getISTTimestamp(),
  }));

  ws.on('error', () => {
    // Ignore — a broken client socket should never affect the server process.
  });
});

// ---------------------------------------------------------------------------
// Core engine instances
// ---------------------------------------------------------------------------

const cameraManager = new CameraManager();
const visionEngine = new VisionEngine();
const spatialEngine = new SpatialEngine();
const analyticsEngine = new AnalyticsEngine();

// BehaviorEngine uses spatial zones for crowd / suspicious-appearance detection
const behaviorEngine = new BehaviorEngine((cameraId) => getZonesForCamera(cameraId));

// Per-camera tamper detectors — one instance per camera
const tamperDetectors = new Map();

// C2 integration adapters
const c2Webhook = new C2Webhook();
const mqttAdapter = new MQTTAdapter();
const takAdapter = new TAKAdapter();

// Offline alerting
const smsAlert = new SMSAlert();
const radioAlert = new RadioAlert();

let enginesReady = false;

async function initEngines() {
  try {
    await visionEngine.init();
    console.log('[IBVAP] VisionEngine ready (YOLO11 ONNX loaded).');
  } catch (err) {
    console.error('[IBVAP] VisionEngine failed to initialize:', err.message);
    console.error('[IBVAP] Place a valid yolo11n.onnx at', process.env.YOLO_MODEL_PATH || './assets/models/yolo11n.onnx');
  }

  try {
    await analyticsEngine.init();
    console.log('[IBVAP] AnalyticsEngine ready (ANPR + Face models loaded).');
  } catch (err) {
    console.error('[IBVAP] AnalyticsEngine failed to initialize:', err.message);
    console.error('[IBVAP] Ensure face-api models exist at', process.env.FACE_MODELS_PATH || './assets/models/face-api-models');
  }

  await verifyMailerConfig();

  // Initialize C2 integrations
  await mqttAdapter.connect();

  // Log C2 status
  if (c2Webhook['_urls'] && c2Webhook['_urls'].length > 0) {
    console.log(`[IBVAP] C2Webhook ready — ${c2Webhook['_urls'].length} webhook(s) configured`);
  }
  if (mqttAdapter.isEnabled) {
    console.log(`[IBVAP] MQTTAdapter ready — broker: ${mqttAdapter['_brokerUrl']}`);
  }
  if (takAdapter['_enabled']) {
    console.log(`[IBVAP] TAKAdapter ready — multicasting to ${takAdapter['_multicastAddr']}:${takAdapter['_multicastPort']}`);
  }
  if (smsAlert['_phoneNumbers'].length > 0) {
    console.log(`[IBVAP] SMSAlert ready — ${smsAlert['_phoneNumbers'].length} recipient(s) configured`);
  }
  if (radioAlert['_enabled']) {
    console.log(`[IBVAP] RadioAlert ready — serial port: ${radioAlert['_port']}`);
  }

  enginesReady = true;
}

// ---------------------------------------------------------------------------
// Snapshot persistence helper
// ---------------------------------------------------------------------------

function saveSnapshot(cameraId, frameBuffer) {
  const filename = `${cameraId}_${Date.now()}.jpg`;
  const filePath = path.join(SNAPSHOT_DIR, filename);
  try {
    fs.writeFileSync(filePath, frameBuffer);
    return filePath;
  } catch (err) {
    console.error(`[IBVAP] Failed to persist snapshot for ${cameraId}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event persistence + alert dispatch helper
// ---------------------------------------------------------------------------

function recordEvent({ cameraId, trackId, eventType, riskResult, details, frameBuffer, behaviorType, tamperType }) {
  const eventId = randomUUID();
  const timestamp = getISTIso();

  let snapshotPath = null;
  if (frameBuffer && (riskResult.severity === 'HIGH' || riskResult.severity === 'CRITICAL')) {
    snapshotPath = saveSnapshot(cameraId, frameBuffer);
  }

  const event = insertEvent({
    eventId,
    cameraId,
    trackId,
    eventType,
    severity: riskResult.severity,
    riskScore: riskResult.score,
    details: { ...details, explanation: riskResult.explanation, breakdown: riskResult.breakdown },
    snapshotPath,
    timestamp,
    behaviorType,
    tamperType,
  });

  broadcast('EVENT', event);

  if (riskResult.severity === 'HIGH' || riskResult.severity === 'CRITICAL') {
    const alertId = randomUUID();
    const alert = insertAlert({ alertId, eventId });
    broadcast('ALERT', alert);
  }

  // Push to C2 integrations asynchronously — never blocks the pipeline
  Promise.resolve().then(() => {
    c2Webhook.broadcast(event);
    mqttAdapter.publish(event);
    takAdapter.sendCOT(event);
  });

  return event;
}

/**
 * Sends a generic priority-aware alert via email, SMS, and radio.
 * Safe to call asynchronously — never throws.
 */
async function dispatchAlert(eventType, details) {
  const timestamp = getISTTimestamp();
  const payload = { ...details, eventType, timestamp };

  // Email (via generic alert)
  const emailResult = await sendGenericAlert(payload);
  broadcast('GENERIC_ALERT_EMAIL', { eventType, emailSent: emailResult.sent, reason: emailResult.reason, timestamp });

  // SMS (priority-aware)
  const smsResult = await smsAlert.sendAlert({ ...details, eventType, timestamp });
  if (smsResult.sent) {
    console.log(`[IBVAP][SMSAlert] SMS sent for ${eventType} on ${details.cameraId}`);
  }

  // Radio tone (critical events only)
  const radioEvents = [
    'CAMERA_TAMPER_FREEZE', 'CAMERA_TAMPER_DARKNESS', 'CAMERA_TAMPER_OBSTRUCTED',
    'CAMERA_TAMPER_OVEREXPOSURE', 'INBOUND_CROSSING', 'OUTBOUND_CROSSING',
    'UNKNOWN_VEHICLE', 'BLACKLISTED_VEHICLE',
  ];
  if (radioEvents.includes(eventType)) {
    radioAlert.sendAlert({ eventType, cameraId: details.cameraId, trackId: details.trackId });
  }
}

// ---------------------------------------------------------------------------
// Camera pipeline wiring: frame -> vision -> spatial -> analytics -> risk
// ---------------------------------------------------------------------------

// Cache of the most recent frame buffer per camera, so async spatial/risk
// event handlers (which fire slightly after the triggering `frame` event)
// can still attach a snapshot without re-plumbing the buffer through every
// intermediate emitter.
const lastFrameByCamera = new Map();

// Throttles live JPEG preview broadcasting independently per camera, since
// sending a base64 frame on every single tick would flood the WebSocket
// with far more bandwidth than the live viewer actually needs.
const FRAME_BROADCAST_INTERVAL = Number.parseInt(process.env.FRAME_BROADCAST_INTERVAL ?? '2', 10);
const lastBroadcastFrameNumber = new Map();

const processingByCamera = new Set();

cameraManager.on('frame', async ({ cameraId, frameBuffer, frameNumber }) => {
  lastFrameByCamera.set(cameraId, frameBuffer);

  // Frame-dropping backpressure guard: if this camera is already processing an
  // inference frame, drop the incoming frame so the event loop never locks up.
  if (processingByCamera.has(cameraId)) return;
  processingByCamera.add(cameraId);

  try {
    // --- TamperDetector: run before vision engine (fast, pre-empts analysis) ---
    const tamperDetector = tamperDetectors.get(cameraId);
    if (tamperDetector) {
      // Quick freeze check on every frame (no image decode needed)
      tamperDetector.quickAnalyzeFrame(frameBuffer);
      // Full brightness/contrast analysis every 10 frames (lightweight decode)
      if (frameNumber % 10 === 0) {
        tamperDetector.analyzeFrame(frameBuffer).catch(() => {});
      }
    }

    if (!enginesReady || !visionEngine.session) return;

    const tracks = await visionEngine.processFrame(cameraId, frameBuffer, frameNumber);

    // Broadcast lightweight live telemetry every frame regardless of
    // whether anything noteworthy happened, so the UI can render bounding
    // boxes smoothly.
    broadcast('TELEMETRY', {
      cameraId,
      frameNumber,
      tracks: tracks.map((t) => ({
        id: t.id,
        group: t.group,
        className: t.className,
        box: t.box,
        confidence: t.confidence,
      })),
      timestamp: getISTTimestamp(),
    });

    // Throttled live JPEG preview: only every Nth frame, and only the
    // actual bytes (already downsampled by CameraManager) base64-encoded
    // for direct <img>/canvas rendering in the browser viewer.
    const lastSent = lastBroadcastFrameNumber.get(cameraId) ?? 0;
    if (frameNumber - lastSent >= FRAME_BROADCAST_INTERVAL) {
      lastBroadcastFrameNumber.set(cameraId, frameNumber);
      broadcast('FRAME', {
        cameraId,
        frameNumber,
        jpegBase64: frameBuffer.toString('base64'),
      });
    }

    spatialEngine.evaluate(cameraId, tracks);

    // --- BehaviorEngine: runs on every frame (lightweight trajectory math) ---
    behaviorEngine.evaluate(cameraId, tracks, frameNumber);

    if (visionEngine.isAnalyticsFrame(cameraId, frameNumber)) {
      await analyticsEngine.processFrame(cameraId, frameBuffer, tracks);
    }
  } catch (err) {
    console.error(`[IBVAP] Pipeline error for ${cameraId}:`, err.message);
  } finally {
    processingByCamera.delete(cameraId);
  }
});

cameraManager.on('status', (payload) => broadcast('CAMERA_STATUS', payload));
cameraManager.on('error', (payload) => console.error(`[IBVAP][${payload.cameraId}] ${payload.message}`));
cameraManager.on('info', (payload) => console.log(`[IBVAP][${payload.cameraId}] ${payload.message}`));

// --- VisionEngine: animal detection suppresses human-intrusion scoring ---
visionEngine.on('ANIMAL_DETECTED', (payload) => {
  const riskResult = RiskEngine.computeRisk({ entityGroup: 'animal' });
  recordEvent({
    cameraId: payload.cameraId,
    trackId: payload.trackId,
    eventType: 'ANIMAL_DETECTED',
    riskResult,
    details: { className: payload.className, box: payload.box },
    frameBuffer: lastFrameByCamera.get(payload.cameraId),
  });
  broadcast('ANIMAL_DETECTED', payload);
});

visionEngine.on('error', (payload) => console.error(`[IBVAP][Vision][${payload.cameraId ?? '-'}] ${payload.message}`));

// --- SpatialEngine: boundary crossings drive the primary risk pipeline ---
function handleCrossing(eventType) {
  return (payload) => {
    // Class-based routing: animal crossings still get logged (so the
    // trajectory is on record), but they're informational only — no
    // security risk contribution and no alert email, matching the
    // philosophy already used for ANIMAL_DETECTED elsewhere in the
    // pipeline. A virtual fence along a riverbank will see plenty of
    // wildlife; treating every one as a security event would drown out
    // real crossings.
    const riskResult = RiskEngine.computeRisk({
      entityGroup: payload.group,
      zoneSeverity: payload.isAnimalEvent ? undefined : payload.zoneSeverity,
      isNight: isNightTimeIST(),
      crossingDirection: payload.isAnimalEvent ? undefined : eventType,
    });

    const frameBuffer = lastFrameByCamera.get(payload.cameraId);
    let snapshotPath = null;
    if (!payload.isAnimalEvent && frameBuffer) {
      snapshotPath = saveSnapshot(payload.cameraId, frameBuffer);
    }

    recordEvent({
      cameraId: payload.cameraId,
      trackId: payload.trackId,
      eventType: payload.isAnimalEvent ? 'ANIMAL_BOUNDARY_EVENT' : eventType,
      riskResult,
      details: {
        zoneId: payload.zoneId,
        zoneName: payload.zoneName,
        previousState: payload.previousState,
        newState: payload.newState,
        groundPoint: payload.groundPoint,
        className: payload.className,
        isAnimalEvent: payload.isAnimalEvent,
      },
      frameBuffer,
    });

    broadcast(eventType, payload);

    if (!payload.isAnimalEvent) {
      sendBoundaryCrossingAlert({
        cameraId: payload.cameraId,
        trackId: payload.trackId,
        zoneId: payload.zoneId,
        zoneName: payload.zoneName,
        zoneSeverity: payload.zoneSeverity,
        eventType,
        className: payload.className,
        timestamp: payload.timestamp,
        snapshotPath,
      }).then((result) => {
        broadcast('BOUNDARY_ALERT_EMAIL', {
          cameraId: payload.cameraId,
          trackId: payload.trackId,
          zoneId: payload.zoneId,
          zoneName: payload.zoneName,
          eventType,
          emailSent: result.sent,
          reason: result.reason,
          timestamp: getISTTimestamp(),
        });
      });
    }
  };
}

spatialEngine.on('INBOUND_CROSSING', handleCrossing('INBOUND_CROSSING'));
spatialEngine.on('OUTBOUND_CROSSING', handleCrossing('OUTBOUND_CROSSING'));
spatialEngine.on('STATE_TRANSITION', (payload) => broadcast('STATE_TRANSITION', payload));

// --- AnalyticsEngine: vehicle/person identification and loitering ---
analyticsEngine.on('VEHICLE_CHECKED', (payload) => {
  if (payload.label === 'UNREADABLE') return; // nothing conclusive to log

  const isArmy = payload.role === 'ARMY';

  const riskResult = RiskEngine.computeRisk({
    entityGroup: 'vehicle',
    isNight: isNightTimeIST(),
    vehicleLabel: payload.label,
    nonArmyVehicle: !isArmy,
  });

  const frameBuffer = lastFrameByCamera.get(payload.cameraId);

  // Always keep a snapshot for non-army detections regardless of overall
  // risk severity — this is the evidence attached to the alert email, and
  // "was this actually a civilian vehicle" is exactly the kind of question
  // a human reviewer will want a picture for, even if the combined risk
  // score didn't happen to cross the HIGH/CRITICAL threshold.
  let snapshotPath = null;
  if (!isArmy && frameBuffer) {
    snapshotPath = saveSnapshot(payload.cameraId, frameBuffer);
  }

  recordEvent({
    cameraId: payload.cameraId,
    trackId: payload.trackId,
    eventType: payload.label,
    riskResult,
    details: {
      rawText: payload.rawText,
      normalizedPlate: payload.normalizedPlate,
      matchedVehicle: payload.match,
      role: payload.role,
    },
    frameBuffer,
  });

  broadcast('VEHICLE_CHECKED', payload);

  if (!isArmy) {
    sendUnauthorizedVehicleAlert({
      cameraId: payload.cameraId,
      trackId: payload.trackId,
      plateNumber: payload.normalizedPlate,
      vehicleType: payload.match?.vehicle_type,
      role: payload.role || 'UNREGISTERED',
      matchLabel: payload.label,
      timestamp: getISTTimestamp(),
      snapshotPath,
    }).then((result) => {
      broadcast('VEHICLE_ALERT_EMAIL', {
        cameraId: payload.cameraId,
        trackId: payload.trackId,
        plateNumber: payload.normalizedPlate,
        role: payload.role,
        emailSent: result.sent,
        reason: result.reason,
        timestamp: getISTTimestamp(),
      });
    });
  }
});

analyticsEngine.on('PERSON_IDENTIFIED', (payload) => {
  const riskResult = RiskEngine.computeRisk({
    entityGroup: 'person',
    isNight: payload.isNight,
    personLabel: payload.label,
  });

  recordEvent({
    cameraId: payload.cameraId,
    trackId: payload.trackId,
    eventType: payload.label,
    riskResult,
    details: { faceBox: payload.box, match: payload.match },
    frameBuffer: lastFrameByCamera.get(payload.cameraId),
  });

  broadcast('PERSON_IDENTIFIED', payload);

  // Watchlist persons trigger immediate alerts
  if (payload.label === 'WATCHLIST_PERSON') {
    dispatchAlert('WATCHLIST_PERSON', {
      cameraId: payload.cameraId,
      trackId: payload.trackId,
      severity: riskResult.severity,
      riskScore: riskResult.score,
      extraInfo: ['Face matched against watchlist'],
    });
  }
});

analyticsEngine.on('LOITERING_DETECTED', (payload) => {
  const riskResult = RiskEngine.computeRisk({
    entityGroup: 'person',
    isNight: isNightTimeIST(),
    isLoitering: true,
  });

  recordEvent({
    cameraId: payload.cameraId,
    trackId: payload.trackId,
    eventType: 'LOITERING_DETECTED',
    riskResult,
    details: { dwellSeconds: payload.dwellSeconds },
    frameBuffer: lastFrameByCamera.get(payload.cameraId),
  });

  broadcast('LOITERING_DETECTED', payload);

  if (riskResult.severity === 'HIGH' || riskResult.severity === 'CRITICAL') {
    dispatchAlert('LOITERING_DETECTED', {
      cameraId: payload.cameraId,
      trackId: payload.trackId,
      severity: riskResult.severity,
      riskScore: riskResult.score,
      extraInfo: [`Dwell time: ${payload.dwellSeconds}s`],
    });
  }
});

analyticsEngine.on('error', (payload) => console.error(`[IBVAP][Analytics][${payload.cameraId ?? '-'}] ${payload.message}`));

// --- TamperDetector: camera feed tampering alerts ---
function registerTamperHandlers(detector) {
  const tamperTypes = [
    'CAMERA_TAMPER_FREEZE', 'CAMERA_TAMPER_DARKNESS',
    'CAMERA_TAMPER_OVEREXPOSURE', 'CAMERA_TAMPER_OBSTRUCTED',
  ];

  for (const eventType of tamperTypes) {
    detector.on(eventType, (payload) => {
      const riskResult = RiskEngine.computeRisk({ tamperType: payload.tamperType });
      const frameBuffer = lastFrameByCamera.get(payload.cameraId);
      const snapshotPath = frameBuffer ? saveSnapshot(payload.cameraId, frameBuffer) : null;

      recordEvent({
        cameraId: payload.cameraId,
        trackId: null,
        eventType,
        riskResult,
        details: { tamperType: payload.tamperType, frameCount: payload.frameCount },
        frameBuffer,
        tamperType: payload.tamperType,
      });

      broadcast(eventType, payload);
      dispatchAlert(eventType, {
        cameraId: payload.cameraId,
        severity: riskResult.severity,
        riskScore: riskResult.score,
        extraInfo: [`Tamper type: ${payload.tamperType}`, `Frames affected: ${payload.frameCount}`],
      });
    });
  }
}

// --- BehaviorEngine: suspicious activity detection ---
function registerBehaviorHandlers() {
  const BEHAVIOR_EVENTS = [
    { event: 'RUNNING_DETECTED', behavior: 'running', label: 'Running detected' },
    { event: 'CRAWLING_DETECTED', behavior: 'crawling', label: 'Crawling/crouching detected' },
    { event: 'CLIMBING_DETECTED', behavior: 'climbing', label: 'Climbing attempt detected' },
    { event: 'CROWD_SURGE', behavior: 'crowdSurge', label: 'Abnormal crowd detected' },
    { event: 'OBJECT_LEFT_BEHIND', behavior: 'objectLeftBehind', label: 'Object left behind' },
    { event: 'SUSPICIOUS_APPEARANCE', behavior: 'suspiciousAppearance', label: 'Suspicious appearance in restricted zone' },
  ];

  for (const { event, behavior, label } of BEHAVIOR_EVENTS) {
    behaviorEngine.on(event, (payload) => {
      const riskResult = RiskEngine.computeRisk({
        entityGroup: 'person',
        behavior,
        isNight: isNightTimeIST(),
      });

      const frameBuffer = lastFrameByCamera.get(payload.cameraId);

      recordEvent({
        cameraId: payload.cameraId,
        trackId: payload.trackId,
        eventType: event,
        riskResult,
        details: { ...payload },
        frameBuffer,
        behaviorType: behavior,
      });

      broadcast(event, payload);

      if (riskResult.severity === 'HIGH' || riskResult.severity === 'CRITICAL') {
        dispatchAlert(event, {
          cameraId: payload.cameraId,
          trackId: payload.trackId,
          zoneName: payload.zoneName,
          severity: riskResult.severity,
          riskScore: riskResult.score,
          extraInfo: [label],
        });
      }
    });
  }
}

registerBehaviorHandlers();

// ---------------------------------------------------------------------------
// REST API: Cameras
// ---------------------------------------------------------------------------

app.get('/api/cameras', (req, res) => {
  res.json({ cameras: getAllCameras() });
});

app.post('/api/cameras', (req, res) => {
  const {
    cameraId, name, sourceType, sourceUrl, locationName, loop,
    confidenceThreshold, iouThreshold, frameStride, analyticsFrameInterval,
  } = req.body;

  if (!cameraId || !name || !sourceType || !sourceUrl) {
    return res.status(400).json({ error: 'cameraId, name, sourceType, and sourceUrl are required' });
  }
  if (!['RTSP', 'MJPEG', 'MP4', 'HTTP'].includes(sourceType)) {
    return res.status(400).json({ error: 'sourceType must be one of RTSP, MJPEG, MP4, HTTP' });
  }
  if (getCamera(cameraId)) {
    return res.status(409).json({ error: `Camera ${cameraId} already exists` });
  }

  const camera = insertCamera({
    cameraId, name, sourceType, sourceUrl, locationName, status: 'OFFLINE',
    confidenceThreshold, iouThreshold, frameStride, analyticsFrameInterval,
  });

  visionEngine.setCameraConfig(cameraId, { confidenceThreshold, iouThreshold, frameStride, analyticsFrameInterval });

  // Create per-camera tamper detector
  const detector = new TamperDetector(cameraId);
  registerTamperHandlers(detector);
  tamperDetectors.set(cameraId, detector);

  try {
    cameraManager.addCamera({ cameraId, sourceType, sourceUrl, loop });
  } catch (err) {
    return res.status(500).json({ error: `Camera registered but ingestion failed to start: ${err.message}` });
  }

  res.status(201).json({ camera });
});

app.patch('/api/cameras/:cameraId/params', (req, res) => {
  const { cameraId } = req.params;
  const { confidenceThreshold, iouThreshold, frameStride, analyticsFrameInterval } = req.body;

  if (!getCamera(cameraId)) {
    return res.status(404).json({ error: `Unknown camera ${cameraId}` });
  }

  if (confidenceThreshold != null && (confidenceThreshold < 0 || confidenceThreshold > 1)) {
    return res.status(400).json({ error: 'confidenceThreshold must be between 0 and 1' });
  }
  if (iouThreshold != null && (iouThreshold < 0 || iouThreshold > 1)) {
    return res.status(400).json({ error: 'iouThreshold must be between 0 and 1' });
  }
  if (frameStride != null && (!Number.isInteger(frameStride) || frameStride < 1)) {
    return res.status(400).json({ error: 'frameStride must be a positive integer' });
  }
  if (analyticsFrameInterval != null && (!Number.isInteger(analyticsFrameInterval) || analyticsFrameInterval < 1)) {
    return res.status(400).json({ error: 'analyticsFrameInterval must be a positive integer' });
  }

  const camera = updateCameraDetectionParams(cameraId, {
    confidenceThreshold, iouThreshold, frameStride, analyticsFrameInterval,
  });

  // Applies immediately — no restart needed. The next processed frame for
  // this camera picks up the new thresholds/stride.
  visionEngine.setCameraConfig(cameraId, { confidenceThreshold, iouThreshold, frameStride, analyticsFrameInterval });

  broadcast('CAMERA_PARAMS_UPDATED', camera);
  res.json({ camera });
});

app.delete('/api/cameras/:cameraId', (req, res) => {
  const { cameraId } = req.params;

  cameraManager.removeCamera(cameraId); // stops ffmpeg ingestion if running
  visionEngine.removeCamera(cameraId);
  spatialEngine.removeCamera(cameraId);
  analyticsEngine.removeCamera(cameraId);
  behaviorEngine.removeCamera(cameraId);
  tamperDetectors.delete(cameraId); // stops and removes tamper detector

  const result = deleteCamera(cameraId); // removes the persisted DB row
  res.json({ removed: result.changes > 0 });
});

// ---------------------------------------------------------------------------
// REST API: Zones
// ---------------------------------------------------------------------------

app.get('/api/zones', (req, res) => {
  const { cameraId } = req.query;
  const zones = cameraId ? getZonesForCamera(cameraId) : getAllZones();
  res.json({ zones });
});

app.post('/api/zones', (req, res) => {
  const { cameraId, zoneName, zoneType, coordinates, severity, directionHint } = req.body;

  if (!cameraId || !zoneName || !zoneType || !Array.isArray(coordinates) || coordinates.length < 2) {
    return res.status(400).json({
      error: 'cameraId, zoneName, zoneType, and coordinates (array of >=2 [x,y] points) are required',
    });
  }
  if (!getCamera(cameraId)) {
    return res.status(404).json({ error: `Unknown camera ${cameraId}` });
  }
  if (!['POLYGON', 'LINE'].includes(zoneType)) {
    return res.status(400).json({ error: 'zoneType must be POLYGON or LINE' });
  }
  if (zoneType === 'POLYGON' && coordinates.length < 3) {
    return res.status(400).json({ error: 'POLYGON zones require at least 3 points' });
  }

  const zone = insertZone({ cameraId, zoneName, zoneType, coordinates, severity, directionHint });
  spatialEngine.refreshZones(cameraId);

  res.status(201).json({ zone });
});

app.delete('/api/zones/:id', (req, res) => {
  const zone = getAllZones().find((z) => z.id === Number.parseInt(req.params.id, 10));
  const result = deleteZone(req.params.id);
  if (zone) spatialEngine.refreshZones(zone.camera_id);
  res.json({ deleted: result.changes > 0 });
});

// ---------------------------------------------------------------------------
// REST API: Face profiles
// ---------------------------------------------------------------------------

const enrolmentFaceService = new FaceService();
let faceServiceReady = false;

app.get('/api/faces', (req, res) => {
  const faces = getAllFaces().map(({ embedding_json, embedding, ...rest }) => rest);
  res.json({ faces });
});

app.post('/api/faces', async (req, res) => {
  const { personCode, label, imageBase64, status } = req.body;

  if (!personCode || !label || !imageBase64) {
    return res.status(400).json({ error: 'personCode, label, and imageBase64 are required' });
  }

  try {
    if (!faceServiceReady) {
      await enrolmentFaceService.init();
      faceServiceReady = true;
    }
    const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const embedding = await enrolmentFaceService.extractSingleDescriptorForEnrolment(buffer);
    const face = upsertFace({ personCode, label, embedding, status });
    const { embedding_json, ...safeFace } = face;
    res.status(201).json({ face: safeFace });
  } catch (err) {
    res.status(422).json({ error: `Face enrolment failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// REST API: Vehicles
// ---------------------------------------------------------------------------

app.get('/api/vehicles', (req, res) => {
  res.json({ vehicles: getAllVehicles() });
});

app.post('/api/vehicles', (req, res) => {
  const { plateNumber, vehicleType, label, status, role } = req.body;

  if (!plateNumber) {
    return res.status(400).json({ error: 'plateNumber is required' });
  }

  const normalizedPlate = normalizePlate(plateNumber);
  if (!normalizedPlate) {
    return res.status(400).json({ error: 'plateNumber could not be normalized to a valid plate string' });
  }

  if (role && !['ARMY', 'POLICE', 'CIVILIAN', 'UNKNOWN'].includes(role)) {
    return res.status(400).json({ error: 'role must be one of ARMY, POLICE, CIVILIAN, UNKNOWN' });
  }

  const vehicle = upsertVehicle({ plateNumber, normalizedPlate, vehicleType, label, status, role });
  res.status(201).json({ vehicle });
});

// ---------------------------------------------------------------------------
// REST API: Events & Alerts
// ---------------------------------------------------------------------------

app.get('/api/events', (req, res) => {
  const { cameraId, eventType, severity, from, to, limit, offset, behaviorType, tamperType } = req.query;
  const events = searchEvents({
    cameraId,
    eventType,
    severity,
    from,
    to,
    limit: limit ? Number.parseInt(limit, 10) : undefined,
    offset: offset ? Number.parseInt(offset, 10) : undefined,
    behaviorType: behaviorType || undefined,
    tamperType: tamperType || undefined,
  });
  res.json({ events });
});

app.get('/api/alerts', (req, res) => {
  res.json({ alerts: getAllAlerts() });
});

app.post('/api/alerts/:id/acknowledge', (req, res) => {
  const { acknowledgedBy } = req.body;
  const alert = acknowledgeAlert(req.params.id, acknowledgedBy);
  if (!alert) {
    return res.status(404).json({ error: `Alert ${req.params.id} not found` });
  }
  broadcast('ALERT_ACKNOWLEDGED', alert);
  res.json({ alert });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    enginesReady,
    visionReady: Boolean(visionEngine.session),
    timestamp: getISTTimestamp(),
    activeCameras: cameraManager.listCameraIds(),
    tamperDetectorsActive: tamperDetectors.size,
    c2WebhookConfigured: c2Webhook['_urls'].length > 0,
    mqttConnected: mqttAdapter.isConnected,
    takEnabled: takAdapter['_enabled'],
    smsConfigured: smsAlert['_phoneNumbers'].length > 0,
    radioEnabled: radioAlert['_enabled'],
  });
});

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

async function bootExistingCameras() {
  const cameras = getAllCameras();
  for (const camera of cameras) {
    try {
      cameraManager.addCamera({
        cameraId: camera.camera_id,
        sourceType: camera.source_type,
        sourceUrl: camera.source_url,
      });
      spatialEngine.refreshZones(camera.camera_id);

      // Re-create per-camera tamper detector
      const detector = new TamperDetector(camera.camera_id);
      registerTamperHandlers(detector);
      tamperDetectors.set(camera.camera_id, detector);
      visionEngine.setCameraConfig(camera.camera_id, {
        confidenceThreshold: camera.confidence_threshold ?? undefined,
        iouThreshold: camera.iou_threshold ?? undefined,
        frameStride: camera.frame_stride ?? undefined,
        analyticsFrameInterval: camera.analytics_frame_interval ?? undefined,
      });
    } catch (err) {
      console.error(`[IBVAP] Failed to resume camera ${camera.camera_id}:`, err.message);
    }
  }
}

async function start() {
  await initEngines();
  await bootExistingCameras();

  server.listen(PORT, HOST, () => {
    console.log(`[IBVAP] Server listening on http://${HOST}:${PORT}`);
    console.log(`[IBVAP] WebSocket stream available at ws://${HOST}:${PORT}/ws/stream`);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  console.log(`\n[IBVAP] ${signal} received — shutting down gracefully...`);

  cameraManager.stopAll();

  try {
    await analyticsEngine.shutdown();
  } catch (err) {
    console.error('[IBVAP] AnalyticsEngine shutdown error:', err.message);
  }

  mqttAdapter.disconnect();
  takAdapter.close();
  smsAlert.close();
  radioAlert.close();

  server.close(() => {
    console.log('[IBVAP] HTTP server closed.');
    process.exit(0);
  });

  // Force exit after 10 seconds if graceful shutdown stalls
  setTimeout(() => {
    console.error('[IBVAP] Forced exit after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[IBVAP] Unhandled rejection (process kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[IBVAP] Uncaught exception (process kept alive):', err);
});

start();

export { app, server, cameraManager, visionEngine, spatialEngine, analyticsEngine };
