/**
 * src/scripts/seedCameras.js
 *
 * Registers IBVAP's 4 standard demo camera locations, each backed by a
 * looping local MP4 file, so the whole multi-camera pipeline (vision,
 * spatial, analytics, risk) can be exercised without any live RTSP/phone
 * feed for the hackathon demo.
 *
 * Idempotent: safe to run multiple times — existing cameras are left
 * untouched (their video file is NOT overwritten), only missing ones are
 * created.
 *
 * Usage:
 *   node src/scripts/seedCameras.js
 *   npm run seed:cameras
 *
 * Each camera expects a video file at the path below. Drop your own .mp4
 * clips into these folders (any filename patterns you like — see
 * VIDEO_FILENAME_CANDIDATES) before running the server.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { insertCamera, getCamera } from '../database/db.js';

// Filenames this script will look for inside each camera's folder, in
// priority order. Rename your downloaded/recorded clip to any of these
// (or just "video.mp4") and it will be picked up automatically.
const VIDEO_FILENAME_CANDIDATES = ['video.mp4', 'video_001.mp4', 'sample.mp4', 'demo.mp4'];

const CAMERAS = [
  {
    cameraId: 'CAM-001',
    name: 'North Gate',
    locationName: 'North Gate — Main Vehicle Checkpoint',
    folder: 'camera_1_north_gate',
    // High-priority checkpoint: run inference on every frame, tighter
    // confidence to reduce false positives on a well-lit, close-range feed.
    detectionParams: { confidenceThreshold: 0.55, iouThreshold: 0.45, frameStride: 1, analyticsFrameInterval: 5 },
  },
  {
    cameraId: 'CAM-002',
    name: 'East Fence Line',
    locationName: 'East Fence Line — Pedestrian Boundary',
    folder: 'camera_2_east_fence',
    // Boundary line: lower confidence to catch smaller/distant people near
    // the fence; still every frame since crossing timing matters here.
    detectionParams: { confidenceThreshold: 0.35, iouThreshold: 0.45, frameStride: 1, analyticsFrameInterval: 7 },
  },
  {
    cameraId: 'CAM-003',
    name: 'South Patrol Road',
    locationName: 'South Patrol Road — Vehicle & Foot Traffic',
    folder: 'camera_3_south_patrol_road',
    // Mixed traffic, moderate priority: balanced defaults, mild frame-skip.
    detectionParams: { confidenceThreshold: 0.45, iouThreshold: 0.45, frameStride: 2, analyticsFrameInterval: 7 },
  },
  {
    cameraId: 'CAM-004',
    name: 'West Watchtower',
    locationName: 'West Watchtower — Elevated Perimeter View',
    folder: 'camera_4_west_watchtower',
    // Wide elevated overview, lowest priority for compute: skip more frames
    // to save CPU, slightly looser confidence since subjects are farther away.
    detectionParams: { confidenceThreshold: 0.35, iouThreshold: 0.5, frameStride: 3, analyticsFrameInterval: 10 },
  },
];

const DEMO_VIDEOS_ROOT = path.join(process.cwd(), 'assets', 'demo_videos');

function findVideoFile(folder) {
  const folderPath = path.join(DEMO_VIDEOS_ROOT, folder);

  if (!fs.existsSync(folderPath)) {
    return { found: false, folderPath, filePath: null };
  }

  for (const candidate of VIDEO_FILENAME_CANDIDATES) {
    const candidatePath = path.join(folderPath, candidate);
    if (fs.existsSync(candidatePath)) {
      return { found: true, folderPath, filePath: candidatePath };
    }
  }

  // Fall back to the first .mp4 file present, whatever it's named.
  const files = fs.readdirSync(folderPath).filter((f) => f.toLowerCase().endsWith('.mp4'));
  if (files.length > 0) {
    return { found: true, folderPath, filePath: path.join(folderPath, files[0]) };
  }

  return { found: false, folderPath, filePath: null };
}

function seed() {
  console.log('[IBVAP] Seeding 4 standard camera locations...\n');

  let createdCount = 0;
  let skippedExisting = 0;
  let missingVideo = 0;

  for (const cam of CAMERAS) {
    if (getCamera(cam.cameraId)) {
      console.log(`  ⏭  ${cam.cameraId} (${cam.name}) already registered — skipping.`);
      skippedExisting += 1;
      continue;
    }

    const { found, folderPath, filePath } = findVideoFile(cam.folder);

    if (!found) {
      console.log(`  ⚠️  ${cam.cameraId} (${cam.name}): no video file found in`);
      console.log(`      ${folderPath}`);
      console.log(`      Drop an .mp4 there (named one of: ${VIDEO_FILENAME_CANDIDATES.join(', ')}, or anything ending in .mp4) and re-run this script.\n`);
      missingVideo += 1;
      continue;
    }

    // Store a relative, forward-slash path — this is what CameraManager /
    // ffmpeg will consume, and keeps the DB portable across machines.
    const relativePath = `./${path.relative(process.cwd(), filePath).split(path.sep).join('/')}`;

    insertCamera({
      cameraId: cam.cameraId,
      name: cam.name,
      sourceType: 'MP4',
      sourceUrl: relativePath,
      locationName: cam.locationName,
      status: 'OFFLINE',
      confidenceThreshold: cam.detectionParams?.confidenceThreshold,
      iouThreshold: cam.detectionParams?.iouThreshold,
      frameStride: cam.detectionParams?.frameStride,
      analyticsFrameInterval: cam.detectionParams?.analyticsFrameInterval,
    });

    console.log(`  ✅ ${cam.cameraId} (${cam.name}) registered -> ${relativePath}`);
    if (cam.detectionParams) {
      const p = cam.detectionParams;
      console.log(`      params: confidence=${p.confidenceThreshold}, iou=${p.iouThreshold}, frameStride=${p.frameStride}, analyticsEvery=${p.analyticsFrameInterval}`);
    }
    createdCount += 1;
  }

  console.log('\n[IBVAP] Seeding complete.');
  console.log(`  Created: ${createdCount}  |  Already existed: ${skippedExisting}  |  Missing video: ${missingVideo}`);

  if (missingVideo > 0) {
    console.log('\n  ⚠️  Some cameras were skipped because no video file was found.');
    console.log('     Add the missing .mp4 file(s) and re-run: npm run seed:cameras');
  }

  if (createdCount > 0) {
    console.log('\n  Start (or restart) the server to begin ingesting all seeded cameras:');
    console.log('     npm run dev');
  }
}

seed();
