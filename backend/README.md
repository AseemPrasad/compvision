# IBVAP — Intelligent Border Video Analytics Platform

Node.js backend engine for **SSB / Ministry of Home Affairs — Problem ID 26187**.
Transforms existing IP-based CCTV/mobile camera feeds into an intelligent
surveillance network using software-only computer vision — no hardware
replacement required.

## Architecture

```
React Command Center (UI)
        ▲  WebSockets (/ws/stream) / REST
Node.js Express Application Server
 ├─ CameraManager   (RTSP / MJPEG / MP4 ingestion, auto-reconnect)
 ├─ VisionEngine    (YOLO11 ONNX detection + IoU tracking)
 ├─ SpatialEngine   (Turf.js zones + boundary state machine)
 ├─ AnalyticsEngine (ANPR via Tesseract.js, Face ID via face-api.js)
 └─ RiskEngine      (explainable weighted risk scoring)
        ▼
   SQLite (better-sqlite3)
```

## Prerequisites

- Node.js v20+
- `ffmpeg` available on PATH (used by `fluent-ffmpeg` for stream ingestion)
- A YOLO11 model exported to ONNX at `assets/models/yolo11n.onnx`
- face-api.js model weights in `assets/models/face-api-models/`
  (`tiny_face_detector`, `face_landmark_68`, `face_recognition`)

## Setup

```bash
npm install
cp .env.example .env
# place yolo11n.onnx and face-api model weights under assets/models/
npm run dev
```

The server listens on `http://localhost:4000` by default, with a WebSocket
stream at `ws://localhost:4000/ws/stream`.

## Running with Docker

Docker gives you a reproducible environment — no chasing distro-specific
`cairo-devel`/`pango-devel` packages or native build toolchains by hand.

### Prerequisites

- Docker Engine + Docker Compose v2 (`docker compose version` to check)
- Your models already present at `ai-engine/models/yolo11n.onnx` and
  `ai-engine/models/face-api-models/` (same requirement as running without
  Docker — see model setup above)
- A `.env` file (`cp .env.example .env`) — path-related variables in it are
  overridden automatically by `docker-compose.yml` to match the container's
  filesystem layout, so you don't need to edit paths for Docker specifically

### Build and start

```bash
docker compose up --build
```

First build takes a few minutes (compiling native modules inside the
container). Subsequent builds are much faster thanks to Docker layer
caching, as long as `package.json`/`package-lock.json` haven't changed.

### Seed the 4 demo cameras (inside the running container)

```bash
docker compose exec ibvap-backend npm run seed:cameras
```

Since `assets/demo_videos/` is volume-mounted from your host, the seed
script finds whatever `.mp4` files you've already placed in the 4 camera
folders — no need to copy anything into the container manually.

### Access

- Live viewer: `http://localhost:4000/`
- REST API: `http://localhost:4000/api/...`
- WebSocket: `ws://localhost:4000/ws/stream`

### Common operations

```bash
# View logs
docker compose logs -f ibvap-backend

# Restart after changing .env
docker compose restart ibvap-backend

# Stop everything
docker compose down

# Stop AND wipe persisted database + snapshots (careful — destructive)
docker compose down -v

# Rebuild after changing source code
docker compose up --build
```

### What's persisted vs. rebuilt

| Data | Location | Persisted via |
|---|---|---|
| SQLite database (cameras, zones, events, alerts) | `/app/data/ibvap.db` | named volume `ibvap-data` |
| Snapshots (high-severity event JPEGs) | `/app/storage/snapshots` | named volume `ibvap-storage` |
| YOLO/face models | `/app/ai-engine/models` | bind mount to host `./ai-engine/models` (read-only) |
| Demo videos | `/app/assets/demo_videos` | bind mount to host `./assets/demo_videos` (read-only) |

Swapping a model file or adding a new demo video on the host takes effect
immediately on container restart — no rebuild needed, since those are bind
mounts, not baked into the image.

### Reading plates on moving vs. stationary vehicles

A single OCR pass on one frame is fragile — motion blur from a moving
vehicle, or just an awkward viewing angle, can easily produce a garbled
read. IBVAP addresses this two ways:

1. **Image preprocessing before OCR** (`AnprService.js`): every vehicle
   crop is upscaled (if small), converted to grayscale, and contrast-
   stretched before Tesseract sees it — this alone meaningfully improves
   accuracy on small or blurry plate text, whether the blur comes from
   vehicle motion or a low-resolution wide-angle camera.
2. **Multi-frame consensus** (`AnalyticsEngine.js`): rather than trusting
   one OCR attempt, each vehicle track accumulates readings across several
   analytics-eligible frames. A plate is "finalized" (and only then does
   `VEHICLE_CHECKED` fire, database logging and any alert email included)
   once either:
   - The same plausible plate has been read `ANPR_CONSENSUS_COUNT` times
     (default 2) — this is the common case for a **stationary or slow
     vehicle**, where consecutive reads tend to agree almost immediately, or
   - `ANPR_MAX_ATTEMPTS` attempts (default 5) have been spent without
     consensus, in which case the single highest-confidence plausible
     reading wins — this covers a **fast-moving vehicle** only briefly in
     frame, where every attempt might come back slightly different.

This also fixes a side effect of the old single-shot design: previously,
a vehicle sitting in frame across many analytics frames would re-trigger
`VEHICLE_CHECKED` (and therefore a new database event, and an alert email
attempt) on every single analytics frame. Now it fires exactly once per
vehicle track, right when its plate is confidently resolved.

Tune the two thresholds in `.env` if needed — lower `ANPR_CONSENSUS_COUNT`
to `1` for faster (but less certain) finalization, or raise
`ANPR_MAX_ATTEMPTS` to give fast-moving traffic more chances before falling
back to a best-guess reading.

## Virtual Fencing (SpatialEngine)

Physical fencing isn't always possible — riverbanks, open unfenced border
stretches, and buffer terrain often can't have a real barrier built. Virtual
fencing solves this by making the boundary purely a piece of geometry drawn
once in the live viewer and stored in SQLite; the same YOLO tracking
pipeline that already runs on every camera evaluates every tracked object's
position against that geometry, frame by frame, with zero physical
infrastructure required.

### How a crossing gets validated (three independent guards)

A crossing event only ever fires after clearing all three:

1. **Consecutive-frame confirmation** (`FENCE_DEBOUNCE_FRAMES`, default 3) —
   the object's position must consistently report the new side of the
   boundary for several frames running, not just one noisy frame.
2. **Minimum track age** (`FENCE_MIN_TRACK_AGE_HITS`, default 10) — a track
   that only just appeared (e.g. a fresh ID minted right after a brief
   occlusion) cannot trigger a crossing until it's been reliably tracked for
   a while. This is checked against `track.hits` in `Tracker.js`, i.e. how
   many frames this exact track ID has been successfully matched.
3. **Time-based event debounce** (`FENCE_EVENT_DEBOUNCE_MS`, default 10000ms)
   — even after the two gates above pass, the same track+zone pair can't
   fire a second crossing event within this wall-clock window. This guards
   specifically against an object oscillating right on the boundary line.

All three are tunable in `.env` without touching code.

### Animal bypass

Objects tracked with `group: 'animal'` still pass through the full state
machine (so their movement is logged), but their crossings are tagged
`isAnimalEvent: true`. This means:
- **No risk score contribution** (matches the existing `ANIMAL_DETECTED`
  zero-weighting philosophy in `RiskEngine.js`)
- **No alert email** — a riverbank fence will see plenty of wildlife;
  emailing on every one would train people to ignore real alerts
- **Different on-screen styling** — a calm blue informational HUD banner
  instead of the red security alert banner (see below)
- Still fully recorded in the `events` table as `ANIMAL_BOUNDARY_EVENT`,
  so the trajectory is on record for later review

### Alerts

Every non-animal crossing (`INBOUND_CROSSING` or `OUTBOUND_CROSSING`) fires
an email via `sendBoundaryCrossingAlert()` in `src/notifications/Mailer.js`
— the same hardcoded `SMTP_CONFIG`/`ALERT_RECIPIENT_EMAIL` used by the
vehicle-role alerting (see below), with its own independent 5-minute
per-track-per-zone cooldown so a person lingering near a boundary doesn't
flood the inbox. The email includes a snapshot attachment.

### Visible in the live video

Two distinct visual indicators fire together at the moment a crossing is
confirmed, in `public/index.html`:
- **Zone flash** — the drawn zone/fence outline flashes white for ~1 second
- **HUD banner** — a bold, unmissable banner appears across the top of that
  camera's tile for 4 seconds: `🚨 INBOUND CROSSING DETECTED` (or
  `OUTBOUND`) with the zone name, track ID, and object class. Animal
  crossings get the calmer `ℹ️ Animal crossing — informational only` blue
  variant instead.

### Setting up a virtual fence on unfenced terrain

1. Open `http://localhost:4000/`
2. On the camera covering the unfenced area (e.g. a riverbank view), click
   **+ Line Fence** (a 2-point tripwire is usually the right shape for a
   riverbank or open stretch) or **+ Polygon Zone** for an enclosed area
3. Click 2 (line) or 3+ (polygon) points along where the boundary actually
   runs in the video
4. Name it, set severity, click **Finish & Save**
5. Walk (or play a video of) a person/vehicle across that line — you should
   see the zone flash white, the red HUD banner appear, an event logged, and
   (once you've configured real SMTP credentials in `Mailer.js`) an email
   alert sent

## Vehicle Tracking, ANPR & Role-Based Email Alerts

Every detected vehicle already gets a persistent tracker ID (`V-1`, `V-2`,
...) from `Tracker.js`, same mechanism as person tracking. On top of that,
IBVAP reads each vehicle's plate and checks it against a hardcoded registry,
then emails a centralized inbox for anything that isn't role `ARMY`.

### How it works

1. `VisionEngine` detects and tracks the vehicle, assigning a persistent ID.
2. On the throttled analytics frame, `AnprService` crops the vehicle's box,
   runs Tesseract OCR, and normalizes the plate string
   (`"GJ-18 AB 1234"` → `"GJ18AB1234"`).
3. The normalized plate is looked up in the `vehicles` table. Every vehicle
   row has both a `status` (AUTHORIZED / BLACKLISTED / UNKNOWN — access
   control) and a `role` (ARMY / POLICE / CIVILIAN / UNKNOWN —
   organizational classification). These are independent: a vehicle can be
   `AUTHORIZED` and still have `role=CIVILIAN`.
4. **Any plate whose role is not `ARMY`** — including plates with no
   registry entry at all (treated as `role=UNREGISTERED`) — triggers:
   - A `+30` contribution to that event's risk score (`RiskEngine.js`)
   - An email alert to a single hardcoded recipient (`Mailer.js`), with a
     snapshot of the frame attached as evidence
   - A 5-minute cooldown per plate, so an idling vehicle doesn't flood the
     inbox with repeat alerts

### Hardcoded data (per project requirement)

Both the vehicle registry and the alert email credentials are committed
directly in source rather than loaded from `.env` or entered via the API:

- **Vehicle registry**: `src/scripts/seedVehicles.js` — edit this array and
  re-run `npm run seed:vehicles` to update the database. All example plates
  shipped here are fictional test data.
- **Email credentials + recipient**: `src/notifications/Mailer.js` — the
  `SMTP_CONFIG` and `ALERT_RECIPIENT_EMAIL` constants at the top of the
  file. **You must replace the placeholder values here before alerts will
  actually send** — see the comment block at the top of that file for exact
  instructions (Gmail requires an App Password, not your normal password).

⚠️ **Security note**: hardcoding real credentials in source means they will
be committed to git history if you ever push this repository anywhere. This
is acceptable for a local/offline demo but should be reverted to `.env`
before sharing the repo or deploying it anywhere persistent.

### Setting up

```bash
npm run seed:vehicles
```

Then edit `src/notifications/Mailer.js` with your real SMTP account and
recipient address. On next server boot, watch the console for:
```
[IBVAP][Mailer] SMTP configuration verified — ready to send alerts.
```
If you see a verification failure instead, alerts won't send until the
credentials are fixed — the rest of the pipeline (detection, tracking,
risk scoring, database logging) keeps working regardless.

### Testing it

Point a camera at (or use a demo video containing) a vehicle whose plate
matches one of the `CIVILIAN`/`POLICE`/`BLACKLISTED` entries in
`seedVehicles.js`, or any plate not in the registry at all — either should
trigger an alert email and a `VEHICLE_ALERT_EMAIL` broadcast visible in the
live viewer's event log at `http://localhost:4000/`.

## Per-Camera Detection Tuning

Each camera can run detection with **independently tuned parameters** —
useful when a high-priority checkpoint needs tighter accuracy while a wide,
low-priority overview camera can trade some precision for lower CPU cost.

| Parameter | What it controls | Constraint |
|---|---|---|
| `confidenceThreshold` (0–1) | Minimum YOLO confidence to keep a detection | Independent per camera, no model reload needed |
| `iouThreshold` (0–1) | NMS overlap threshold (higher = allows more overlapping boxes) | Independent per camera |
| `frameStride` (integer ≥1) | Run inference only every Nth frame for this camera; skipped frames reuse the last known tracks | Independent per camera — this is IBVAP's equivalent of a `--vid-stride` flag |
| `analyticsFrameInterval` (integer ≥1) | How often (in frames) ANPR/Face recognition runs for this camera | Independent per camera |

**Not overridable per camera:** input *resolution* (e.g. 640 vs 480 vs 320).
The shipped `yolo11n.onnx` is exported with a fixed 640×640 input shape, so
all cameras share that resolution. To vary resolution per camera you'd need
to export additional `.onnx` files at different sizes (`yolo export
model=yolo11n.pt format=onnx imgsz=480`) and extend `VisionEngine` to hold
multiple sessions — not included by default since it roughly multiplies
memory usage per extra resolution tier.

### Setting params at registration

```bash
curl -X POST http://localhost:4000/api/cameras \
  -H "Content-Type: application/json" \
  -d '{
    "cameraId": "CAM-005",
    "name": "New Feed",
    "sourceType": "MP4",
    "sourceUrl": "./assets/demo_videos/camera_5/video.mp4",
    "confidenceThreshold": 0.4,
    "iouThreshold": 0.45,
    "frameStride": 2,
    "analyticsFrameInterval": 8
  }'
```

### Adjusting params live (no restart needed)

```bash
curl -X PATCH http://localhost:4000/api/cameras/CAM-004/params \
  -H "Content-Type: application/json" \
  -d '{"confidenceThreshold": 0.25, "frameStride": 1}'
```

The next frame processed for that camera immediately picks up the new
values — useful for live-tuning during a demo (e.g. lowering confidence to
show a previously-missed detection start appearing).

The 4 seeded demo cameras (`npm run seed:cameras`) already ship with
deliberately different parameters — see `src/scripts/seedCameras.js` — so
running them side by side in the live viewer (`http://localhost:4000/`)
visibly demonstrates the concept: North Gate runs every frame at high
confidence, West Watchtower skips 2 of every 3 frames at looser confidence.

## Multi-Camera Demo Setup (4 hardcoded locations)

IBVAP ships with a seed script that registers 4 standard border-camera
locations, each backed by its own looping local video file — no live
RTSP/phone stream required to exercise the full pipeline.

| Camera ID | Location | Video folder |
|---|---|---|
| `CAM-001` | North Gate — Main Vehicle Checkpoint | `assets/demo_videos/camera_1_north_gate/` |
| `CAM-002` | East Fence Line — Pedestrian Boundary | `assets/demo_videos/camera_2_east_fence/` |
| `CAM-003` | South Patrol Road — Vehicle & Foot Traffic | `assets/demo_videos/camera_3_south_patrol_road/` |
| `CAM-004` | West Watchtower — Elevated Perimeter View | `assets/demo_videos/camera_4_west_watchtower/` |

### Steps

1. Drop one `.mp4` file into each of the 4 folders above. Name it
   `video.mp4` (recommended), or any of `video_001.mp4`, `sample.mp4`,
   `demo.mp4` — or any filename ending in `.mp4`, the seed script will find it.
2. Run the seed script:
   ```bash
   npm run seed:cameras
   ```
   This registers any camera whose video file is present, and skips (without
   overwriting) any camera already registered. Re-run it any time after
   adding a missing video — already-seeded cameras are left untouched.
3. Start (or restart) the server:
   ```bash
   npm run dev
   ```
   All 4 cameras begin ingesting simultaneously — each gets its own ffmpeg
   process, its own Tracker instance, and independent zone/analytics state,
   so one feed's issues never affect another's.
4. Confirm all 4 are live:
   ```bash
   curl http://localhost:4000/api/cameras
   ```
   Each entry's `status` should read `ONLINE` with a nonzero `fps` after a
   few seconds.
5. Watch live detections over the WebSocket feed (`/ws/stream`) — every
   `TELEMETRY` message includes the `cameraId`, so a single connection shows
   all 4 feeds' tracks interleaved.

To re-seed from scratch (e.g. swap in different demo footage), delete the
camera first, then re-run the seed script:
```bash
curl -X DELETE http://localhost:4000/api/cameras/CAM-001
npm run seed:cameras
```

## REST API Summary

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/cameras` | Register / list camera feeds |
| DELETE | `/api/cameras/:cameraId` | Remove a camera and stop ingestion |
| GET/POST | `/api/zones` | Configure polygon/line boundaries per camera |
| DELETE | `/api/zones/:id` | Remove a zone |
| GET/POST | `/api/faces` | Register face profiles (base64 image → 128-d embedding) |
| GET/POST | `/api/vehicles` | Whitelist / blacklist license plates |
| GET | `/api/events` | Search historical events with filters |
| GET | `/api/alerts` | List alerts |
| POST | `/api/alerts/:id/acknowledge` | Acknowledge an active alert |
| GET | `/api/health` | Engine/camera health check |

## Demo Scenario (Stage 2 Judging)

1. **Boot**: `npm start`, launch the React frontend, confirm `/api/health`.
2. **Connect Wi-Fi phone camera**: Start an RTSP stream via an IP Webcam app,
   register it as `CAM-001` via `POST /api/cameras`
   (`rtsp://192.168.1.15:8080/h264_pcm.sdp`).
3. **Animal vs. human**: Point the camera at an animal crossing a configured
   line zone → `ANIMAL_DETECTED` logged at `INFO`, no human-intrusion alarm.
4. **Boundary state machine**: Walk a person across a zone → watch
   `STATE_TRANSITION` / `INBOUND_CROSSING` events move
   `OUTSIDE → APPROACHING → CROSSING → INSIDE` over the WebSocket feed.
5. **ANPR & FRS**: Show a vehicle plate → `VEHICLE_CHECKED` event with
   normalized plate and AUTHORIZED/UNKNOWN label. Show an enrolled face →
   `PERSON_IDENTIFIED` event.
6. **Night + explainable risk**: Simulate an outbound crossing after 19:00 IST
   → risk score composed from weighted signals (person, zone severity, night
   hours, direction), e.g. `92/100 CRITICAL`, broadcast with a full
   explanation array over `/ws/stream`.

## Notes on CPU-friendly operation

- Frames are downsampled to `MAX_PROCESSING_WIDTH` (default 640px) before
  inference.
- ANPR and face recognition run only every `ANALYTICS_FRAME_INTERVAL` frames
  (default 7), not on every frame.
- Camera streams recover from drops via exponential backoff
  (`CameraManager.js`), reflecting `ONLINE` / `RECONNECTING` / `OFFLINE`
  status into SQLite without crashing the main process.
