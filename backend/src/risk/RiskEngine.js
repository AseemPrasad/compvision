/**
 * src/risk/RiskEngine.js
 *
 * Computes explainable 0-100 risk scores for IBVAP events by summing
 * weighted contributions from independent signals, and produces a
 * human-readable explanation array suitable for direct display in the React
 * Command Center (e.g. ["Person detected (+20)", "Restricted Zone 01 (+30)",
 * "Night hours IST (+25)", "Outbound direction (+17)"]).
 *
 * Weights are intentionally centralized and named so judges/reviewers can
 * see exactly how a score of, say, 92/100 CRITICAL was derived.
 */

const WEIGHTS = Object.freeze({
  PERSON_DETECTED: 20,
  VEHICLE_DETECTED: 10,
  ANIMAL_DETECTED: 0, // animals never contribute to human-intrusion risk

  ZONE_SEVERITY: {
    LOW: 10,
    MEDIUM: 20,
    HIGH: 30,
    CRITICAL: 40,
  },

  NIGHT_HOURS: 25,

  DIRECTION: {
    OUTBOUND_CROSSING: 17,
    INBOUND_CROSSING: 12,
  },

  UNKNOWN_VEHICLE: 15,
  BLACKLISTED_VEHICLE: 35,
  NON_ARMY_VEHICLE: 30,
  UNKNOWN_PERSON: 15,
  WATCHLIST_PERSON: 35,

  LOITERING: 15,

  // Behavioral analytics signals
  RUNNING: 25,
  CRAWLING: 30,
  CLIMBING: 40,
  CROWD_SURGE: 35,
  OBJECT_LEFT_BEHIND: 30,
  SUSPICIOUS_APPEARANCE: 35,

  // Camera tampering signals
  CAMERA_TAMPER: 50,
});

const SEVERITY_BANDS = [
  { max: 24, level: 'INFO' },
  { max: 49, level: 'LOW' },
  { max: 69, level: 'MEDIUM' },
  { max: 89, level: 'HIGH' },
  { max: 100, level: 'CRITICAL' },
];

function severityFromScore(score) {
  const band = SEVERITY_BANDS.find((b) => score <= b.max);
  return band ? band.level : 'CRITICAL';
}

/**
 * @typedef {object} RiskSignals
 * @property {'person'|'vehicle'|'animal'} [entityGroup]
 * @property {string} [zoneSeverity] - LOW | MEDIUM | HIGH | CRITICAL, if inside a zone
 * @property {boolean} [isNight]
 * @property {'INBOUND_CROSSING'|'OUTBOUND_CROSSING'} [crossingDirection]
 * @property {'AUTHORIZED_VEHICLE'|'UNKNOWN_VEHICLE'|'BLACKLISTED_VEHICLE'} [vehicleLabel]
 * @property {boolean} [nonArmyVehicle] - true if the vehicle's registered role is not ARMY, including no registry match at all
 * @property {'AUTHORIZED'|'UNKNOWN_PERSON'|'WATCHLIST_PERSON'} [personLabel]
 * @property {boolean} [isLoitering]
 * @property {'running'|'crawling'|'climbing'|'crowdSurge'|'objectLeftBehind'|'suspiciousAppearance'} [behavior]
 * @property {'freeze'|'darkness'|'obstruction'|'brightness'} [tamperType]
 */

export class RiskEngine {
  /**
   * Computes a risk score + explanation breakdown from a signals object.
   * @param {RiskSignals} signals
   * @returns {{score: number, severity: string, explanation: string[], breakdown: Record<string, number>}}
   */
  static computeRisk(signals = {}) {
    const breakdown = {};
    const explanation = [];

    const addContribution = (key, amount, label) => {
      if (!amount) return;
      breakdown[key] = amount;
      explanation.push(`${label} (+${amount})`);
    };

    if (signals.entityGroup === 'person') {
      addContribution('PERSON_DETECTED', WEIGHTS.PERSON_DETECTED, 'Person detected');
    } else if (signals.entityGroup === 'vehicle') {
      addContribution('VEHICLE_DETECTED', WEIGHTS.VEHICLE_DETECTED, 'Vehicle detected');
    } else if (signals.entityGroup === 'animal') {
      // Explicitly zero-weighted and explained, so the UI can show *why*
      // an animal-triggered event stayed at INFO severity.
      explanation.push('Animal detected — human-intrusion scoring suppressed (+0)');
    }

    if (signals.zoneSeverity && WEIGHTS.ZONE_SEVERITY[signals.zoneSeverity] != null) {
      addContribution(
        'ZONE_SEVERITY',
        WEIGHTS.ZONE_SEVERITY[signals.zoneSeverity],
        `Restricted zone (${signals.zoneSeverity})`,
      );
    }

    if (signals.isNight) {
      addContribution('NIGHT_HOURS', WEIGHTS.NIGHT_HOURS, 'Night hours IST');
    }

    if (signals.crossingDirection && WEIGHTS.DIRECTION[signals.crossingDirection] != null) {
      const label = signals.crossingDirection === 'OUTBOUND_CROSSING' ? 'Outbound direction' : 'Inbound direction';
      addContribution('DIRECTION', WEIGHTS.DIRECTION[signals.crossingDirection], label);
    }

    if (signals.vehicleLabel === 'UNKNOWN_VEHICLE') {
      addContribution('UNKNOWN_VEHICLE', WEIGHTS.UNKNOWN_VEHICLE, 'Unrecognized vehicle plate');
    } else if (signals.vehicleLabel === 'BLACKLISTED_VEHICLE') {
      addContribution('BLACKLISTED_VEHICLE', WEIGHTS.BLACKLISTED_VEHICLE, 'Blacklisted vehicle match');
    }

    if (signals.nonArmyVehicle) {
      addContribution('NON_ARMY_VEHICLE', WEIGHTS.NON_ARMY_VEHICLE, 'Non-army vehicle detected');
    }

    if (signals.personLabel === 'UNKNOWN_PERSON') {
      addContribution('UNKNOWN_PERSON', WEIGHTS.UNKNOWN_PERSON, 'Unidentified person');
    } else if (signals.personLabel === 'WATCHLIST_PERSON') {
      addContribution('WATCHLIST_PERSON', WEIGHTS.WATCHLIST_PERSON, 'Watchlist face match');
    }

    if (signals.isLoitering) {
      addContribution('LOITERING', WEIGHTS.LOITERING, 'Prolonged loitering');
    }

    // Behavioral signals
    if (signals.behavior === 'running') {
      addContribution('RUNNING', WEIGHTS.RUNNING, 'Running detected');
    } else if (signals.behavior === 'crawling') {
      addContribution('CRAWLING', WEIGHTS.CRAWLING, 'Crawling / crouching detected');
    } else if (signals.behavior === 'climbing') {
      addContribution('CLIMBING', WEIGHTS.CLIMBING, 'Climbing attempt detected');
    } else if (signals.behavior === 'crowdSurge') {
      addContribution('CROWD_SURGE', WEIGHTS.CROWD_SURGE, 'Abnormal crowd detected');
    } else if (signals.behavior === 'objectLeftBehind') {
      addContribution('OBJECT_LEFT_BEHIND', WEIGHTS.OBJECT_LEFT_BEHIND, 'Object left behind');
    } else if (signals.behavior === 'suspiciousAppearance') {
      addContribution('SUSPICIOUS_APPEARANCE', WEIGHTS.SUSPICIOUS_APPEARANCE, 'Suspicious appearance in restricted zone');
    }

    // Camera tampering signals
    if (signals.tamperType) {
      addContribution('CAMERA_TAMPER', WEIGHTS.CAMERA_TAMPER, `Camera tampering: ${signals.tamperType}`);
    }

    const rawScore = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
    const score = Math.max(0, Math.min(100, rawScore));
    const severity = severityFromScore(score);

    return { score, severity, explanation, breakdown };
  }

  static get weights() {
    return WEIGHTS;
  }
}

export default RiskEngine;
