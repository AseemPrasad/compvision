/**
 * src/utils/timeUtils.js
 *
 * Centralized IST (Asia/Kolkata, UTC+05:30) timezone utilities for IBVAP.
 *
 * RULE: Every timestamp surfaced to the database, REST API, or WebSocket
 * payloads MUST be produced through this module. Never call
 * `new Date().toISOString()` or rely on local system time directly anywhere
 * else in the codebase.
 */

import { DateTime } from 'luxon';

export const APP_TIMEZONE = 'Asia/Kolkata';

// Night window boundaries (IST, 24h clock). Configurable via env, with
// sane hackathon-demo defaults matching the SSB night-patrol scenario.
const NIGHT_START_HOUR = Number.parseInt(process.env.NIGHT_START_HOUR ?? '19', 10);
const NIGHT_END_HOUR = Number.parseInt(process.env.NIGHT_END_HOUR ?? '6', 10);

const DISPLAY_FORMAT = 'dd LLL yyyy, HH:mm:ss';

/**
 * Returns the current instant as a Luxon DateTime, anchored to IST.
 * @returns {DateTime}
 */
export function nowIST() {
  return DateTime.now().setZone(APP_TIMEZONE);
}

/**
 * Converts any Date, epoch millis, ISO string, or Luxon DateTime into an
 * IST-anchored Luxon DateTime.
 * @param {Date|number|string|DateTime} input
 * @returns {DateTime}
 */
export function toIST(input) {
  if (input instanceof DateTime) {
    return input.setZone(APP_TIMEZONE);
  }
  if (input instanceof Date) {
    return DateTime.fromJSDate(input).setZone(APP_TIMEZONE);
  }
  if (typeof input === 'number') {
    return DateTime.fromMillis(input).setZone(APP_TIMEZONE);
  }
  if (typeof input === 'string') {
    const iso = DateTime.fromISO(input);
    if (iso.isValid) return iso.setZone(APP_TIMEZONE);
    const sql = DateTime.fromSQL(input);
    if (sql.isValid) return sql.setZone(APP_TIMEZONE);
  }
  // Fall back to "now" if input is unparseable — never throw on a bad
  // timestamp, since surveillance logging must never crash on this path.
  return nowIST();
}

/**
 * Human-facing IST timestamp string, formatted exactly as:
 *   "DD MMM YYYY, HH:MM:SS IST"
 * e.g. "22 Aug 2026, 21:47:03 IST"
 *
 * @param {Date|number|string|DateTime} [input] - defaults to now
 * @returns {string}
 */
export function getISTTimestamp(input) {
  const dt = input === undefined ? nowIST() : toIST(input);
  return `${dt.toFormat(DISPLAY_FORMAT)} IST`;
}

/**
 * Machine-sortable ISO-8601 string with the +05:30 offset baked in.
 * Use this for values stored in SQLite `timestamp`/`created_at` columns so
 * they remain lexically sortable while still being IST-explicit.
 *
 * @param {Date|number|string|DateTime} [input] - defaults to now
 * @returns {string} e.g. "2026-08-22T21:47:03.482+05:30"
 */
export function getISTIso(input) {
  const dt = input === undefined ? nowIST() : toIST(input);
  return dt.toISO({ suppressMilliseconds: false });
}

/**
 * Epoch millis for the given (or current) instant. Useful for fast numeric
 * comparisons (loitering duration, debounce windows) without re-parsing
 * strings.
 * @param {Date|number|string|DateTime} [input]
 * @returns {number}
 */
export function getISTEpochMillis(input) {
  const dt = input === undefined ? nowIST() : toIST(input);
  return dt.toMillis();
}

/**
 * Determines whether the given (or current) instant falls within the
 * configured IST night window. Handles windows that wrap past midnight
 * (e.g. 19:00 -> 06:00).
 *
 * @param {Date|number|string|DateTime} [input] - defaults to now
 * @returns {boolean}
 */
export function isNightTimeIST(input) {
  const dt = input === undefined ? nowIST() : toIST(input);
  const hour = dt.hour;

  if (NIGHT_START_HOUR === NIGHT_END_HOUR) {
    // Degenerate config (0-length or full-day window) — treat as "always day".
    return false;
  }

  if (NIGHT_START_HOUR < NIGHT_END_HOUR) {
    // Simple same-day window, e.g. 01:00 -> 05:00
    return hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
  }

  // Wrapping window, e.g. 19:00 -> 06:00
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/**
 * Returns a compact object with both display and machine-sortable IST
 * representations, handy for embedding in WebSocket payloads.
 * @param {Date|number|string|DateTime} [input]
 */
export function istTimestampBundle(input) {
  const dt = input === undefined ? nowIST() : toIST(input);
  return {
    display: `${dt.toFormat(DISPLAY_FORMAT)} IST`,
    iso: dt.toISO({ suppressMilliseconds: false }),
    epochMillis: dt.toMillis(),
    isNight: isNightTimeIST(dt),
  };
}

/**
 * Difference, in whole seconds, between two IST-normalizable inputs
 * (end - start). Used by loitering / dwell-time calculations.
 * @param {Date|number|string|DateTime} start
 * @param {Date|number|string|DateTime} [end] - defaults to now
 * @returns {number}
 */
export function diffSeconds(start, end) {
  const startDt = toIST(start);
  const endDt = end === undefined ? nowIST() : toIST(end);
  return Math.max(0, endDt.diff(startDt, 'seconds').seconds);
}

export default {
  APP_TIMEZONE,
  nowIST,
  toIST,
  getISTTimestamp,
  getISTIso,
  getISTEpochMillis,
  isNightTimeIST,
  istTimestampBundle,
  diffSeconds,
};
