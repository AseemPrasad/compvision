/**
 * src/notifications/Mailer.js
 *
 * Sends email alerts to configured recipients whenever a non-army vehicle is
 * detected or a boundary crossing occurs. Credentials and recipients are loaded
 * from environment variables — see .env.example for the full list.
 *
 * Alert priority levels:
 *   P0 — Critical: Camera tamper, night breach  → SMS + Email immediately
 *   P1 — High:     Inbound crossing, unknown vehicle, watchlist → SMS + Email
 *   P2 — Medium:   Outbound crossing, loitering, crowd surge   → Email only
 *   P3 — Low:      Animal events, state transitions            → Log only
 */

import nodemailer from 'nodemailer';

// ---------------------------------------------------------------------------
// SMTP Configuration — loaded from environment variables
// ---------------------------------------------------------------------------

const SMTP_CONFIG = {
  host:     process.env.SMTP_HOST     || 'smtp.gmail.com',
  port:     Number.parseInt(process.env.SMTP_PORT ?? '587', 10),
  secure:   process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
};

const ALERT_RECIPIENT_EMAILS = [
  process.env.ALERT_RECIPIENT_1,
  process.env.ALERT_RECIPIENT_2,
  process.env.ALERT_RECIPIENT_3,
].filter(Boolean);

const ALERT_SENDER_DISPLAY_NAME = process.env.ALERT_SENDER_NAME || 'IBVAP Border Surveillance Alert';

// Alert priority: determines which events warrant immediate SMS + email
// vs. email-only vs. log-only
const ALERT_PRIORITY = {
  P0_CRITICAL: ['CAMERA_TAMPER_FREEZE', 'CAMERA_TAMPER_DARKNESS', 'CAMERA_TAMPER_OBSTRUCTED',
    'CAMERA_TAMPER_OVEREXPOSURE', 'INBOUND_CROSSING_NIGHT', 'BLACKLISTED_VEHICLE'],
  P1_HIGH:    ['INBOUND_CROSSING', 'OUTBOUND_CROSSING', 'UNKNOWN_VEHICLE', 'WATCHLIST_PERSON',
    'RUNNING_DETECTED', 'CLIMBING_DETECTED', 'CROWD_SURGE', 'OBJECT_LEFT_BEHIND',
    'CRAWLING_DETECTED'],
  P2_MEDIUM:  ['LOITERING_DETECTED', 'PERSON_IDENTIFIED'],
};

function getAlertPriority(eventType) {
  if (ALERT_PRIORITY.P0_CRITICAL.includes(eventType)) return 'P0_CRITICAL';
  if (ALERT_PRIORITY.P1_HIGH.includes(eventType)) return 'P1_HIGH';
  if (ALERT_PRIORITY.P2_MEDIUM.includes(eventType)) return 'P2_MEDIUM';
  return 'P3_LOW';
}

// Minimum time between repeat alert emails for the *same plate* (or the
// same camera+track if the plate couldn't be read), so a vehicle idling in
// frame across many analytics-eligible frames doesn't flood the inbox.
const ALERT_COOLDOWN_MS = Number.parseInt(process.env.ALERT_EMAIL_COOLDOWN_MS ?? '300000', 10); // default 5 minutes

// ============================================================
// Implementation — shouldn't need to touch below this line
// ============================================================

const transporter = nodemailer.createTransport(SMTP_CONFIG);

/** cooldownKey (plate or "cameraId:trackId") -> epoch millis of last send */
const lastAlertSentAt = new Map();

function isOnCooldown(key) {
  const last = lastAlertSentAt.get(key);
  if (!last) return false;
  return Date.now() - last < ALERT_COOLDOWN_MS;
}

/**
 * Sends the non-army vehicle alert email. Resolves (never rejects) even on
 * failure — a broken mail server must never crash the surveillance
 * pipeline, matching the fail-safe philosophy used throughout IBVAP
 * (see CameraManager's reconnect logic for the same principle applied to
 * streams).
 *
 * @param {object} details
 * @param {string} details.cameraId
 * @param {string} details.trackId
 * @param {string|null} [details.plateNumber] - normalized plate, or null/undefined if unreadable
 * @param {string} [details.vehicleType]
 * @param {string} [details.role] - 'ARMY' | 'POLICE' | 'CIVILIAN' | 'UNKNOWN' | 'UNREGISTERED'
 * @param {string} [details.matchLabel] - AUTHORIZED_VEHICLE / UNKNOWN_VEHICLE / BLACKLISTED_VEHICLE
 * @param {string} details.timestamp - IST display timestamp, e.g. "24 Aug 2026, 10:15:03 IST"
 * @param {string|null} [details.snapshotPath] - local file path to attach as evidence, if available
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function sendUnauthorizedVehicleAlert(details) {
  const cooldownKey = details.plateNumber || `${details.cameraId}:${details.trackId}`;

  if (isOnCooldown(cooldownKey)) {
    return { sent: false, reason: 'cooldown' };
  }

  const plateDisplay = details.plateNumber || '(plate unreadable)';
  const subject = `[IBVAP ALERT] Non-army vehicle detected — ${details.cameraId}`;

  const textBody = [
    'IBVAP Border Surveillance — Non-Army Vehicle Alert',
    '',
    `Camera: ${details.cameraId}`,
    `Track ID: ${details.trackId}`,
    `Plate: ${plateDisplay}`,
    `Vehicle type: ${details.vehicleType || 'unknown'}`,
    `Registered role: ${details.role || 'UNREGISTERED'}`,
    `Database match: ${details.matchLabel || 'UNKNOWN_VEHICLE'}`,
    `Timestamp: ${details.timestamp}`,
    '',
    'This vehicle is not registered with role ARMY in the IBVAP vehicle',
    'registry. Please verify and take appropriate action.',
  ].join('\n');

  const mailOptions = {
    from: `"${ALERT_SENDER_DISPLAY_NAME}" <${SMTP_CONFIG.auth.user}>`,
    to: ALERT_RECIPIENT_EMAILS.join(', '),
    subject,
    text: textBody,
  };

  if (details.snapshotPath) {
    mailOptions.attachments = [{ filename: 'snapshot.jpg', path: details.snapshotPath }];
  }

  try {
    await transporter.sendMail(mailOptions);
    lastAlertSentAt.set(cooldownKey, Date.now());
    return { sent: true };
  } catch (err) {
    console.error('[IBVAP][Mailer] Failed to send alert email:', err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Sends the virtual fence crossing alert email. Skips animal crossings by
 * design — callers should check `isAnimalEvent` before calling this, but
 * this function also refuses to send for an animal className as a second
 * safety net, since a fence-line alert flooding the inbox with deer/cattle
 * crossings would train people to ignore real ones.
 *
 * @param {object} details
 * @param {string} details.cameraId
 * @param {string} details.trackId
 * @param {string} details.zoneId
 * @param {string} details.zoneName
 * @param {string} details.zoneSeverity
 * @param {string} details.eventType - 'INBOUND_CROSSING' | 'OUTBOUND_CROSSING'
 * @param {string} details.className
 * @param {string} details.timestamp - IST display timestamp
 * @param {string|null} [details.snapshotPath]
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function sendBoundaryCrossingAlert(details) {
  if (details.className && ['dog', 'cow', 'horse', 'sheep'].includes(details.className)) {
    return { sent: false, reason: 'animal-excluded' };
  }

  // Cooldown keyed per track+zone, distinctly prefixed so it never collides
  // with the vehicle-plate cooldown keys sharing the same Map.
  const cooldownKey = `boundary:${details.cameraId}:${details.trackId}:${details.zoneId}`;

  if (isOnCooldown(cooldownKey)) {
    return { sent: false, reason: 'cooldown' };
  }

  const direction = details.eventType === 'OUTBOUND_CROSSING' ? 'OUTBOUND' : 'INBOUND';
  const subject = `[IBVAP ALERT] Virtual fence ${direction} crossing — ${details.cameraId} / ${details.zoneName}`;

  const textBody = [
    'IBVAP Border Surveillance — Virtual Fence Crossing Alert',
    '',
    `Camera: ${details.cameraId}`,
    `Zone: ${details.zoneName} (severity: ${details.zoneSeverity})`,
    `Track ID: ${details.trackId}`,
    `Object: ${details.className}`,
    `Direction: ${direction}`,
    `Timestamp: ${details.timestamp}`,
    '',
    'A tracked object has crossed a software-defined virtual fence line.',
    'This zone has no physical barrier — please verify and dispatch as needed.',
  ].join('\n');

  const mailOptions = {
    from: `"${ALERT_SENDER_DISPLAY_NAME}" <${SMTP_CONFIG.auth.user}>`,
    to: ALERT_RECIPIENT_EMAILS.join(', '),
    subject,
    text: textBody,
  };

  if (details.snapshotPath) {
    mailOptions.attachments = [{ filename: 'snapshot.jpg', path: details.snapshotPath }];
  }

  try {
    await transporter.sendMail(mailOptions);
    lastAlertSentAt.set(cooldownKey, Date.now());
    return { sent: true };
  } catch (err) {
    console.error('[IBVAP][Mailer] Failed to send boundary crossing alert email:', err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Sends a generic alert email for any event type (behavior, tamper, etc.).
 * Uses alert priority to determine severity in the subject line.
 *
 * @param {object} details
 * @param {string} details.eventType
 * @param {string} details.cameraId
 * @param {string} [details.trackId]
 * @param {string} details.timestamp
 * @param {string} [details.zoneName]
 * @param {string} [details.severity]
 * @param {string} [details.riskScore]
 * @param {string} [details.extraInfo] - additional lines for the email body
 * @param {string|null} [details.snapshotPath]
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function sendGenericAlert(details) {
  const cooldownKey = details.eventType
    ? `${details.eventType}:${details.cameraId}:${details.trackId || 'no-track'}`
    : `${details.cameraId}:${details.trackId || 'no-track'}`;

  // Tamper events have no cooldown — always send immediately
  const cooldown = details.eventType?.startsWith('CAMERA_TAMPER') ? 0 : ALERT_COOLDOWN_MS;
  if (cooldown > 0 && isOnCooldown(cooldownKey)) {
    return { sent: false, reason: 'cooldown' };
  }

  const priority = getAlertPriority(details.eventType || '');
  const priorityLabel = priority.replace('_', ' ');

  const severityIcon = priority === 'P0_CRITICAL' ? '🚨 CRITICAL'
    : priority === 'P1_HIGH' ? '⚠️ HIGH'
    : priority === 'P2_MEDIUM' ? '⚡ MEDIUM'
    : 'ℹ️ LOW';

  const subject = `[IBVAP ${priorityLabel}] ${details.eventType} — ${details.cameraId}`;

  const lines = [
    `IBVAP Border Surveillance — ${priorityLabel} Alert`,
    '',
    `Event:  ${details.eventType}`,
    `Camera: ${details.cameraId}`,
    details.trackId ? `Track ID: ${details.trackId}` : null,
    details.zoneName ? `Zone: ${details.zoneName}` : null,
    details.severity ? `Severity: ${details.severity}` : null,
    details.riskScore != null ? `Risk Score: ${details.riskScore}/100` : null,
    `Timestamp: ${details.timestamp}`,
    '',
    ...(details.extraInfo || []),
  ].filter(Boolean);

  const textBody = lines.join('\n');

  const mailOptions = {
    from: `"${ALERT_SENDER_DISPLAY_NAME}" <${SMTP_CONFIG.auth.user}>`,
    to: ALERT_RECIPIENT_EMAILS.join(', '),
    subject,
    text: textBody,
  };

  if (details.snapshotPath) {
    mailOptions.attachments = [{ filename: 'snapshot.jpg', path: details.snapshotPath }];
  }

  try {
    await transporter.sendMail(mailOptions);
    if (cooldown > 0) lastAlertSentAt.set(cooldownKey, Date.now());
    return { sent: true };
  } catch (err) {
    console.error(`[IBVAP][Mailer] Failed to send generic alert (${details.eventType}):`, err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Verifies the SMTP configuration works at all, without sending a real
 * alert. Useful to call once at server boot so a misconfigured mailbox
 * shows up in the logs immediately rather than silently failing on the
 * first real detection.
 */
export async function verifyMailerConfig() {
  try {
    await transporter.verify();
    console.log('[IBVAP][Mailer] SMTP configuration verified — ready to send alerts.');
    return true;
  } catch (err) {
    console.error('[IBVAP][Mailer] SMTP verification failed — alerts will NOT send until this is fixed:', err.message);
    console.error('[IBVAP][Mailer] Edit src/notifications/Mailer.js and replace the placeholder SMTP_CONFIG/ALERT_RECIPIENT_EMAILS values.');
    return false;
  }
}

export default { sendUnauthorizedVehicleAlert, sendBoundaryCrossingAlert, sendGenericAlert, verifyMailerConfig };