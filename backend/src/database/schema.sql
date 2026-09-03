-- ==========================================================================
-- IBVAP - Intelligent Border Video Analytics Platform
-- SQLite schema (better-sqlite3)
-- All timestamp columns store IST-anchored ISO-8601 strings produced by
-- src/utils/timeUtils.js (getISTIso). Never insert raw new Date() output.
-- ==========================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- --------------------------------------------------------------------------
-- cameras: registered video sources (RTSP phone stream, HTTP MJPEG, MP4 loop)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cameras (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id                 TEXT NOT NULL UNIQUE,          -- e.g. "CAM-001"
  name                      TEXT NOT NULL,
  source_type               TEXT NOT NULL CHECK (source_type IN ('RTSP', 'MJPEG', 'MP4', 'HTTP')),
  source_url                TEXT NOT NULL,
  location_name             TEXT,
  status                    TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE', 'RECONNECTING', 'OFFLINE', 'DEGRADED')),
  fps                       REAL DEFAULT 0,
  -- Per-camera detection tuning. NULL means "use VisionEngine's global
  -- default" (see .env: YOLO_CONFIDENCE_THRESHOLD, YOLO_IOU_THRESHOLD,
  -- ANALYTICS_FRAME_INTERVAL). Input *resolution* is NOT overridable per
  -- camera here — the ONNX model is exported with a fixed 640x640 input
  -- shape, so only post-inference parameters (confidence/IoU filtering) and
  -- frame-skip cadence can vary per camera without re-exporting the model.
  confidence_threshold      REAL,
  iou_threshold             REAL,
  frame_stride              INTEGER DEFAULT 1,             -- run inference every Nth frame; 1 = every frame
  analytics_frame_interval  INTEGER,                        -- ANPR/Face cadence override, in frames
  last_seen_at              TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cameras_status ON cameras (status);

-- --------------------------------------------------------------------------
-- zones: polygon / line-fence geometry per camera (GeoJSON-style coordinates)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id        TEXT NOT NULL,
  zone_name        TEXT NOT NULL,
  zone_type        TEXT NOT NULL CHECK (zone_type IN ('POLYGON', 'LINE')),
  coordinates_json TEXT NOT NULL,               -- JSON array of [x, y] pixel or geo points
  severity         TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  direction_hint   TEXT DEFAULT 'BOTH' CHECK (direction_hint IN ('INBOUND', 'OUTBOUND', 'BOTH')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (camera_id) REFERENCES cameras (camera_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_zones_camera ON zones (camera_id);

-- --------------------------------------------------------------------------
-- vehicles: whitelist / lookup table for ANPR
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_number      TEXT NOT NULL,              -- human-entered, e.g. "GJ-18 AB 1234"
  normalized_plate  TEXT NOT NULL UNIQUE,        -- normalized, e.g. "GJ18AB1234"
  vehicle_type      TEXT DEFAULT 'UNKNOWN',
  label             TEXT,                        -- owner / unit label
  status            TEXT NOT NULL DEFAULT 'AUTHORIZED' CHECK (status IN ('AUTHORIZED', 'BLACKLISTED', 'UNKNOWN')),
  -- Organizational role of the registered vehicle. This is independent of
  -- `status` (access authorization) — a vehicle can be AUTHORIZED but still
  -- have role=CIVILIAN. Any plate whose role is not 'ARMY' (including
  -- plates with no database entry at all) triggers an email alert — see
  -- src/notifications/Mailer.js.
  role              TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (role IN ('ARMY', 'POLICE', 'CIVILIAN', 'UNKNOWN')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles (normalized_plate);

-- --------------------------------------------------------------------------
-- face_registry: enrolled face embeddings for identification
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS face_registry (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  person_code    TEXT NOT NULL UNIQUE,          -- e.g. "P-JAWAN-014"
  label          TEXT NOT NULL,
  embedding_json TEXT NOT NULL,                  -- JSON array of 128 floats
  status         TEXT NOT NULL DEFAULT 'AUTHORIZED' CHECK (status IN ('AUTHORIZED', 'WATCHLIST', 'UNKNOWN')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_face_registry_status ON face_registry (status);

-- --------------------------------------------------------------------------
-- events: every detected/analyzed occurrence emitted by the pipeline
-- --------------------------------------------------------------------------
-- Additional columns added by feature expansions:
--   behavior_type  TEXT  — e.g. RUNNING, CRAWLING, CLIMBING, LOITERING, CROWD_SURGE, OBJECT_LEFT_BEHIND
--   tamper_type    TEXT  — e.g. CAMERA_FREEZE, CAMERA_DARKNESS, CAMERA_OVEREXPOSURE, CAMERA_OBSTRUCTED
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL UNIQUE,          -- UUID
  camera_id      TEXT NOT NULL,
  track_id       TEXT,                           -- e.g. "P-17", "V-04", "A-03"
  event_type     TEXT NOT NULL,                  -- e.g. INBOUND_CROSSING, ANIMAL_DETECTED, UNKNOWN_VEHICLE
  severity       TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  risk_score     INTEGER DEFAULT 0,
  details_json   TEXT,                           -- JSON: explanation breakdown, plate, face match, geometry, etc.
  snapshot_path  TEXT,
  timestamp      TEXT NOT NULL,                  -- IST ISO timestamp of occurrence
  created_at     TEXT NOT NULL,
  behavior_type  TEXT,                           -- e.g. RUNNING, CRAWLING, CLIMBING, CROWD_SURGE, OBJECT_LEFT_BEHIND
  tamper_type    TEXT,                           -- e.g. CAMERA_FREEZE, CAMERA_DARKNESS, CAMERA_OBSTRUCTED
  FOREIGN KEY (camera_id) REFERENCES cameras (camera_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_camera ON events (camera_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events (severity);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp);

-- --------------------------------------------------------------------------
-- alerts: dispatch/acknowledgement lifecycle wrapping high-severity events
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id         TEXT NOT NULL UNIQUE,        -- UUID
  event_id         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED')),
  acknowledged_by  TEXT,
  acknowledged_at  TEXT,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events (event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status);
CREATE INDEX IF NOT EXISTS idx_alerts_event ON alerts (event_id);
