/**
 * src/database/db.js
 *
 * better-sqlite3 initialization and typed data-access helpers for IBVAP.
 * Synchronous by design (better-sqlite3 is sync-only) — this is intentional
 * and safe here since the write volume of a single-laptop hackathon
 * prototype is far below the point where this would block the event loop
 * meaningfully. All timestamps are produced via src/utils/timeUtils.js.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getISTIso } from '../utils/timeUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'ibvap.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Applies schema.sql idempotently (all statements use CREATE TABLE/INDEX
 * IF NOT EXISTS), so this is safe to call on every server boot.
 */
function initSchema() {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schemaSql);
}

initSchema();

/**
 * Patches older SQLite files created before per-camera detection tuning
 * columns existed. CREATE TABLE IF NOT EXISTS in schema.sql only helps for
 * brand-new databases — an existing ibvap.db needs these columns added
 * explicitly. SQLite has no "ADD COLUMN IF NOT EXISTS", so we just attempt
 * each ALTER TABLE and swallow the "duplicate column name" error when the
 * column is already present.
 */
function migrateSchema() {
  const migrations = [
    'ALTER TABLE cameras ADD COLUMN confidence_threshold REAL',
    'ALTER TABLE cameras ADD COLUMN iou_threshold REAL',
    'ALTER TABLE cameras ADD COLUMN frame_stride INTEGER DEFAULT 1',
    'ALTER TABLE cameras ADD COLUMN analytics_frame_interval INTEGER',
    "ALTER TABLE vehicles ADD COLUMN role TEXT DEFAULT 'UNKNOWN'",
    "ALTER TABLE events ADD COLUMN behavior_type TEXT",
    "ALTER TABLE events ADD COLUMN tamper_type TEXT",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(err.message)) {
        console.error(`[IBVAP] Schema migration failed for "${sql}":`, err.message);
      }
    }
  }
}

migrateSchema();

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

const stmtInsertCamera = db.prepare(`
  INSERT INTO cameras (
    camera_id, name, source_type, source_url, location_name, status, fps,
    confidence_threshold, iou_threshold, frame_stride, analytics_frame_interval,
    created_at, updated_at
  )
  VALUES (
    @camera_id, @name, @source_type, @source_url, @location_name, @status, @fps,
    @confidence_threshold, @iou_threshold, @frame_stride, @analytics_frame_interval,
    @created_at, @updated_at
  )
`);

const stmtGetCameraById = db.prepare(`SELECT * FROM cameras WHERE camera_id = ?`);
const stmtGetAllCameras = db.prepare(`SELECT * FROM cameras ORDER BY created_at DESC`);
const stmtUpdateCameraStatus = db.prepare(`
  UPDATE cameras SET status = ?, last_seen_at = ?, updated_at = ? WHERE camera_id = ?
`);
const stmtUpdateCameraFps = db.prepare(`
  UPDATE cameras SET fps = ?, updated_at = ? WHERE camera_id = ?
`);
const stmtDeleteCamera = db.prepare(`DELETE FROM cameras WHERE camera_id = ?`);

export function insertCamera(camera) {
  const now = getISTIso();
  stmtInsertCamera.run({
    camera_id: camera.cameraId,
    name: camera.name,
    source_type: camera.sourceType,
    source_url: camera.sourceUrl,
    location_name: camera.locationName ?? null,
    status: camera.status ?? 'OFFLINE',
    fps: camera.fps ?? 0,
    confidence_threshold: camera.confidenceThreshold ?? null,
    iou_threshold: camera.iouThreshold ?? null,
    frame_stride: camera.frameStride ?? 1,
    analytics_frame_interval: camera.analyticsFrameInterval ?? null,
    created_at: now,
    updated_at: now,
  });
  return stmtGetCameraById.get(camera.cameraId);
}

export function getCamera(cameraId) {
  return stmtGetCameraById.get(cameraId);
}

export function getAllCameras() {
  return stmtGetAllCameras.all();
}

export function updateCameraStatus(cameraId, status) {
  const now = getISTIso();
  stmtUpdateCameraStatus.run(status, now, now, cameraId);
  return stmtGetCameraById.get(cameraId);
}

export function updateCameraFps(cameraId, fps) {
  stmtUpdateCameraFps.run(fps, getISTIso(), cameraId);
}

export function deleteCamera(cameraId) {
  return stmtDeleteCamera.run(cameraId);
}

const stmtUpdateCameraParams = db.prepare(`
  UPDATE cameras
  SET confidence_threshold = @confidence_threshold,
      iou_threshold = @iou_threshold,
      frame_stride = @frame_stride,
      analytics_frame_interval = @analytics_frame_interval,
      updated_at = @updated_at
  WHERE camera_id = @camera_id
`);

/**
 * Partially updates a camera's per-camera detection tuning. Any field left
 * `undefined` retains its current stored value (fetched first so we don't
 * accidentally null out fields the caller didn't intend to touch).
 */
export function updateCameraDetectionParams(cameraId, params) {
  const existing = stmtGetCameraById.get(cameraId);
  if (!existing) return null;

  stmtUpdateCameraParams.run({
    camera_id: cameraId,
    confidence_threshold: params.confidenceThreshold ?? existing.confidence_threshold,
    iou_threshold: params.iouThreshold ?? existing.iou_threshold,
    frame_stride: params.frameStride ?? existing.frame_stride ?? 1,
    analytics_frame_interval: params.analyticsFrameInterval ?? existing.analytics_frame_interval,
    updated_at: getISTIso(),
  });

  return stmtGetCameraById.get(cameraId);
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const stmtInsertZone = db.prepare(`
  INSERT INTO zones (camera_id, zone_name, zone_type, coordinates_json, severity, direction_hint, created_at, updated_at)
  VALUES (@camera_id, @zone_name, @zone_type, @coordinates_json, @severity, @direction_hint, @created_at, @updated_at)
`);
const stmtGetZonesByCamera = db.prepare(`SELECT * FROM zones WHERE camera_id = ?`);
const stmtGetAllZones = db.prepare(`SELECT * FROM zones ORDER BY created_at DESC`);
const stmtGetZoneById = db.prepare(`SELECT * FROM zones WHERE id = ?`);
const stmtDeleteZone = db.prepare(`DELETE FROM zones WHERE id = ?`);

export function insertZone(zone) {
  const now = getISTIso();
  const info = stmtInsertZone.run({
    camera_id: zone.cameraId,
    zone_name: zone.zoneName,
    zone_type: zone.zoneType,
    coordinates_json: JSON.stringify(zone.coordinates),
    severity: zone.severity ?? 'MEDIUM',
    direction_hint: zone.directionHint ?? 'BOTH',
    created_at: now,
    updated_at: now,
  });
  return stmtGetZoneById.get(info.lastInsertRowid);
}

export function getZonesForCamera(cameraId) {
  return stmtGetZonesByCamera.all(cameraId).map((z) => ({
    ...z,
    coordinates: JSON.parse(z.coordinates_json),
  }));
}

export function getAllZones() {
  return stmtGetAllZones.all().map((z) => ({
    ...z,
    coordinates: JSON.parse(z.coordinates_json),
  }));
}

export function deleteZone(id) {
  return stmtDeleteZone.run(id);
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

const stmtUpsertVehicle = db.prepare(`
  INSERT INTO vehicles (plate_number, normalized_plate, vehicle_type, label, status, role, created_at, updated_at)
  VALUES (@plate_number, @normalized_plate, @vehicle_type, @label, @status, @role, @created_at, @updated_at)
  ON CONFLICT(normalized_plate) DO UPDATE SET
    plate_number = excluded.plate_number,
    vehicle_type = excluded.vehicle_type,
    label = excluded.label,
    status = excluded.status,
    role = excluded.role,
    updated_at = excluded.updated_at
`);
const stmtGetVehicleByPlate = db.prepare(`SELECT * FROM vehicles WHERE normalized_plate = ?`);
const stmtGetAllVehicles = db.prepare(`SELECT * FROM vehicles ORDER BY created_at DESC`);

export function upsertVehicle(vehicle) {
  const now = getISTIso();
  stmtUpsertVehicle.run({
    plate_number: vehicle.plateNumber,
    normalized_plate: vehicle.normalizedPlate,
    vehicle_type: vehicle.vehicleType ?? 'UNKNOWN',
    label: vehicle.label ?? null,
    status: vehicle.status ?? 'AUTHORIZED',
    role: vehicle.role ?? 'UNKNOWN',
    created_at: now,
    updated_at: now,
  });
  return stmtGetVehicleByPlate.get(vehicle.normalizedPlate);
}

export function findVehicleByPlate(normalizedPlate) {
  return stmtGetVehicleByPlate.get(normalizedPlate);
}

export function getAllVehicles() {
  return stmtGetAllVehicles.all();
}

// ---------------------------------------------------------------------------
// Face registry
// ---------------------------------------------------------------------------

const stmtUpsertFace = db.prepare(`
  INSERT INTO face_registry (person_code, label, embedding_json, status, created_at, updated_at)
  VALUES (@person_code, @label, @embedding_json, @status, @created_at, @updated_at)
  ON CONFLICT(person_code) DO UPDATE SET
    label = excluded.label,
    embedding_json = excluded.embedding_json,
    status = excluded.status,
    updated_at = excluded.updated_at
`);
const stmtGetFaceByCode = db.prepare(`SELECT * FROM face_registry WHERE person_code = ?`);
const stmtGetAllFaces = db.prepare(`SELECT * FROM face_registry ORDER BY created_at DESC`);

export function upsertFace(face) {
  const now = getISTIso();
  stmtUpsertFace.run({
    person_code: face.personCode,
    label: face.label,
    embedding_json: JSON.stringify(face.embedding),
    status: face.status ?? 'AUTHORIZED',
    created_at: now,
    updated_at: now,
  });
  return stmtGetFaceByCode.get(face.personCode);
}

export function getAllFaces() {
  return stmtGetAllFaces.all().map((f) => ({
    ...f,
    embedding: JSON.parse(f.embedding_json),
  }));
}

export function getFaceByCode(personCode) {
  const row = stmtGetFaceByCode.get(personCode);
  if (!row) return null;
  return { ...row, embedding: JSON.parse(row.embedding_json) };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const stmtInsertEvent = db.prepare(`
  INSERT INTO events (event_id, camera_id, track_id, event_type, severity, risk_score, details_json, snapshot_path, timestamp, created_at, behavior_type, tamper_type)
  VALUES (@event_id, @camera_id, @track_id, @event_type, @severity, @risk_score, @details_json, @snapshot_path, @timestamp, @created_at, @behavior_type, @tamper_type)
`);
const stmtGetEventById = db.prepare(`SELECT * FROM events WHERE event_id = ?`);

export function insertEvent(event) {
  const now = getISTIso();
  stmtInsertEvent.run({
    event_id: event.eventId,
    camera_id: event.cameraId,
    track_id: event.trackId ?? null,
    event_type: event.eventType,
    severity: event.severity ?? 'INFO',
    risk_score: event.riskScore ?? 0,
    details_json: JSON.stringify(event.details ?? {}),
    snapshot_path: event.snapshotPath ?? null,
    timestamp: event.timestamp ?? now,
    created_at: now,
    behavior_type: event.behaviorType ?? null,
    tamper_type: event.tamperType ?? null,
  });
  return stmtGetEventById.get(event.eventId);
}

/**
 * Historical event search with optional filters.
 * @param {{cameraId?: string, eventType?: string, severity?: string, from?: string, to?: string, limit?: number, offset?: number}} filters
 */
export function searchEvents(filters = {}) {
  const clauses = [];
  const params = {};

  if (filters.cameraId) {
    clauses.push('camera_id = @cameraId');
    params.cameraId = filters.cameraId;
  }
  if (filters.eventType) {
    clauses.push('event_type = @eventType');
    params.eventType = filters.eventType;
  }
  if (filters.severity) {
    clauses.push('severity = @severity');
    params.severity = filters.severity;
  }
  if (filters.from) {
    clauses.push('timestamp >= @from');
    params.from = filters.from;
  }
  if (filters.to) {
    clauses.push('timestamp <= @to');
    params.to = filters.to;
  }
  if (filters.behaviorType) {
    clauses.push('behavior_type = @behaviorType');
    params.behaviorType = filters.behaviorType;
  }
  if (filters.tamperType) {
    clauses.push('tamper_type = @tamperType');
    params.tamperType = filters.tamperType;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Number.isInteger(filters.limit) ? filters.limit : 100;
  const offset = Number.isInteger(filters.offset) ? filters.offset : 0;

  const rows = db
    .prepare(`SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });

  return rows.map((r) => ({ ...r, details: JSON.parse(r.details_json || '{}') }));
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

const stmtInsertAlert = db.prepare(`
  INSERT INTO alerts (alert_id, event_id, status, created_at)
  VALUES (@alert_id, @event_id, @status, @created_at)
`);
const stmtGetAlertById = db.prepare(`SELECT * FROM alerts WHERE alert_id = ?`);
const stmtGetAllAlerts = db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC`);
const stmtAcknowledgeAlert = db.prepare(`
  UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ? WHERE alert_id = ?
`);

export function insertAlert(alert) {
  const now = getISTIso();
  stmtInsertAlert.run({
    alert_id: alert.alertId,
    event_id: alert.eventId,
    status: alert.status ?? 'ACTIVE',
    created_at: now,
  });
  return stmtGetAlertById.get(alert.alertId);
}

export function getAllAlerts() {
  return stmtGetAllAlerts.all();
}

export function getAlert(alertId) {
  return stmtGetAlertById.get(alertId);
}

export function acknowledgeAlert(alertId, acknowledgedBy) {
  const now = getISTIso();
  const result = stmtAcknowledgeAlert.run(acknowledgedBy ?? 'UNKNOWN', now, alertId);
  if (result.changes === 0) return null;
  return stmtGetAlertById.get(alertId);
}

export default db;
