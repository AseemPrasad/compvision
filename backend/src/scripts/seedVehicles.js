/**
 * src/scripts/seedVehicles.js
 *
 * Hardcoded vehicle registry backing IBVAP's ANPR + role-based alerting
 * subsystem. Per project requirements, this data lives directly in source
 * rather than being entered through the API or an external file — these
 * are exactly the plates checked whenever a vehicle's role is evaluated as
 * "not ARMY" (see src/notifications/Mailer.js for what happens then).
 *
 * All plates below are fictional/illustrative test data — none correspond
 * to real vehicles, registrations, or individuals. Replace this list with
 * your actual registry before any real deployment.
 *
 * Any plate NOT in this list (or not yet seeded) is treated as
 * role=UNREGISTERED when detected, which is also "not ARMY" and will
 * trigger the alert email — so you don't need to enumerate every possible
 * civilian plate, only the ones you want the system to recognize.
 *
 * Usage:
 *   node src/scripts/seedVehicles.js
 *   npm run seed:vehicles
 *
 * Idempotent: uses upsertVehicle (INSERT ... ON CONFLICT DO UPDATE), so
 * re-running this updates existing rows rather than erroring on duplicates.
 */

import 'dotenv/config';
import { upsertVehicle } from '../database/db.js';
import { normalizePlate } from '../analytics/AnprService.js';

const VEHICLES = [
  // --- Army-registered vehicles (role: ARMY) — these will NOT trigger alerts ---
  { plateNumber: 'AR01A1234', vehicleType: 'TRUCK', label: 'SSB Convoy Truck 1', status: 'AUTHORIZED', role: 'ARMY' },
  { plateNumber: 'AR02B5678', vehicleType: 'CAR', label: 'SSB Patrol Jeep', status: 'AUTHORIZED', role: 'ARMY' },
  { plateNumber: 'AR03C4321', vehicleType: 'MOTORCYCLE', label: 'SSB Despatch Rider Bike', status: 'AUTHORIZED', role: 'ARMY' },
  { plateNumber: 'AR04D8765', vehicleType: 'TRUCK', label: 'SSB Supply Truck 2', status: 'AUTHORIZED', role: 'ARMY' },

  // --- Non-army vehicles (role: CIVILIAN / POLICE) — these WILL trigger alerts ---
  { plateNumber: 'DL8CAF9999', vehicleType: 'CAR', label: 'Civilian sedan (test)', status: 'UNKNOWN', role: 'CIVILIAN' },
  { plateNumber: 'WB20X0001', vehicleType: 'MOTORCYCLE', label: 'Local resident motorcycle (test)', status: 'UNKNOWN', role: 'CIVILIAN' },
  { plateNumber: 'GJ18AB1234', vehicleType: 'CAR', label: 'Civilian visitor car (test)', status: 'AUTHORIZED', role: 'CIVILIAN' },
  { plateNumber: 'BORDER007X', vehicleType: 'TRUCK', label: 'Flagged suspect vehicle (test)', status: 'BLACKLISTED', role: 'CIVILIAN' },
  { plateNumber: 'PL01POL999', vehicleType: 'CAR', label: 'Local police patrol car (test)', status: 'AUTHORIZED', role: 'POLICE' },
];

function seed() {
  console.log('[IBVAP] Seeding hardcoded vehicle registry...\n');

  let count = 0;
  for (const v of VEHICLES) {
    const normalizedPlate = normalizePlate(v.plateNumber);
    upsertVehicle({ ...v, normalizedPlate });
    console.log(`  ✅ ${v.plateNumber.padEnd(12)} -> role=${v.role.padEnd(10)} status=${v.status.padEnd(12)} (${v.label})`);
    count += 1;
  }

  console.log(`\n[IBVAP] Seeded/updated ${count} vehicle records.`);
  console.log('  Any plate NOT in this list is treated as role=UNREGISTERED when detected,');
  console.log('  which also counts as "not ARMY" and will trigger the alert email.');
  console.log('\n  Remember to edit src/notifications/Mailer.js with real SMTP credentials');
  console.log('  and a real recipient address before alerts will actually send.');
}

seed();
