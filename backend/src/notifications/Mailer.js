/**
 * src/notifications/Mailer.js
 *
 * Sends an email alert to a hardcoded list of recipients — e.g. the unit
 * head, the duty employee, and gate/checkpoint staff — whenever a detected
 * vehicle's registered role is anything other than "ARMY" (including
 * vehicles with no database match at all, UNREGISTERED), or a tracked
 * object crosses a virtual fence line.
 *
 * ============================================================
 * WHY CREDENTIALS ARE HARDCODED HERE (READ BEFORE DEPLOYING)
 * ============================================================
 * Per project requirements, the SMTP account and alert recipients are
 * hardcoded directly in this file rather than loaded from `.env`. This is
 * simpler for a single-purpose demo/hackathon build, but it means:
 *   - These values WILL be committed to source control if you push this
 *     repo anywhere (GitHub, GitLab, a shared drive, etc.).
 *   - Anyone with read access to this file can see your SMTP password.
 * If this project ever leaves your own machine, either scrub this file
 * from git history and rotate the credentials, or move these constants
 * back into `.env` (the rest of the codebase already follows that pattern
 * everywhere else — see src/server.js for examples).
 *
 * REPLACE THE PLACEHOLDER VALUES BELOW before alerts will actually send.
 * For Gmail specifically: you cannot use your normal account password —
 * you must generate an "App Password" (Google Account -> Security -> 2-Step
 * Verification -> App Passwords) and use that 16-character value instead.
 */

import nodemailer from 'nodemailer';

// ============================================================
// HARDCODED CONFIGURATION — EDIT THESE TWO BLOCKS
// ============================================================

/** Your sending mailbox's SMTP settings and login. */
const SMTP_CONFIG = {
  host: 'smtp.gmail.com',       // e.g. smtp.gmail.com, smtp.office365.com, your org's SMTP relay
  port: 587,                     // 587 = STARTTLS (recommended), 465 = implicit TLS
  secure: false,                  // true only if port is 465
  auth: {
    user: 'REPLACE_WITH_YOUR_SENDER_EMAIL@gmail.com',
    pass: 'REPLACE_WITH_YOUR_APP_PASSWORD',
  },
};

/** The list of inboxes that receive every alert email — one entry per role. */
const ALERT_RECIPIENT_EMAILS = [
  'REPLACE_WITH_HEAD_EMAIL@example.gov.in',       // Officer-in-charge / SSB unit head
  'REPLACE_WITH_EMPLOYEE_EMAIL@example.gov.in',   // Duty employee / control room operator
  'REPLACE_WITH_GATEKEEPER_EMAIL@example.gov.in', // Gate/checkpoint staff
];

const ALERT_SENDER_DISPLAY_NAME = 'IBVAP Border Surveillance Alert';

// Minimum time between repeat alert emails for the *same plate* (or the
// same camera+track if the plate couldn't be read), so a vehicle idling in
// frame across many analytics-eligible frames doesn't flood the inbox.
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

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

export default { sendUnauthorizedVehicleAlert, sendBoundaryCrossingAlert, verifyMailerConfig };