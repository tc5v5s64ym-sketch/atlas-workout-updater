const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STRENGTH_DELOAD_V1, HYPERTROPHY_DELOAD_V1, POWER_DELOAD_V1, ENDURANCE_DELOAD_V1,
  PROTOCOLS, selectProtocol, computePrescription, roundLoad
} = require('../services/deloadProtocols');

/* ===== Protocol values are pinned to docs/DELOAD_SPEC.md =====
   These fixtures are hand-transcribed from the spec's prescription tables.
   If a value changes here, the spec must change first. */

test('STRENGTH_DELOAD_V1 matches the spec prescription', () => {
  assert.equal(STRENGTH_DELOAD_V1.id, 'STRENGTH_DELOAD_V1');
  assert.equal(STRENGTH_DELOAD_V1.focus, 'strength');
  assert.equal(STRENGTH_DELOAD_V1.load_multiplier, 0.92);
  assert.equal(STRENGTH_DELOAD_V1.set_multiplier, 0.50);
  assert.equal(STRENGTH_DELOAD_V1.target_rir, 5);
});

test('HYPERTROPHY_DELOAD_V1 matches the spec prescription', () => {
  assert.equal(HYPERTROPHY_DELOAD_V1.id, 'HYPERTROPHY_DELOAD_V1');
  assert.equal(HYPERTROPHY_DELOAD_V1.focus, 'hypertrophy');
  assert.equal(HYPERTROPHY_DELOAD_V1.load_multiplier, 0.85);
  assert.equal(HYPERTROPHY_DELOAD_V1.set_multiplier, 0.50);
  assert.equal(HYPERTROPHY_DELOAD_V1.target_rir, 5);
  // The spec requires intensity techniques be stripped during a hypertrophy deload.
  assert.deepEqual(
    [...HYPERTROPHY_DELOAD_V1.remove],
    ['failure sets', 'drop sets', 'rest-pause', 'intensity techniques']
  );
});

test('POWER_DELOAD_V1 matches the spec prescription', () => {
  assert.equal(POWER_DELOAD_V1.id, 'POWER_DELOAD_V1');
  assert.equal(POWER_DELOAD_V1.focus, 'power');
  assert.equal(POWER_DELOAD_V1.load_multiplier, 0.90);
  assert.equal(POWER_DELOAD_V1.set_multiplier, 0.35);
  assert.equal(POWER_DELOAD_V1.target_rir, 4);
  assert.ok(POWER_DELOAD_V1.notes.some(n => /speed declines/i.test(n)));
});

test('ENDURANCE_DELOAD_V1 matches the spec prescription', () => {
  assert.equal(ENDURANCE_DELOAD_V1.id, 'ENDURANCE_DELOAD_V1');
  assert.equal(ENDURANCE_DELOAD_V1.focus, 'endurance');
  assert.equal(ENDURANCE_DELOAD_V1.load_multiplier, 0.80);
  assert.equal(ENDURANCE_DELOAD_V1.set_multiplier, 0.60);
  assert.equal(ENDURANCE_DELOAD_V1.target_rir, 5);
});

/* ===== Protocols are frozen — nothing downstream can mutate the source of truth ===== */

test('protocols are frozen constants', () => {
  assert.ok(Object.isFrozen(STRENGTH_DELOAD_V1));
  assert.ok(Object.isFrozen(PROTOCOLS));
  // An attempted mutation must not change the pinned value.
  try { STRENGTH_DELOAD_V1.load_multiplier = 0.5; } catch { /* strict-mode throw is fine */ }
  assert.equal(STRENGTH_DELOAD_V1.load_multiplier, 0.92);
});

/* ===== selectProtocol: focus → protocol, with a safe default ===== */

test('selectProtocol maps each focus to its protocol', () => {
  assert.equal(selectProtocol('strength'), STRENGTH_DELOAD_V1);
  assert.equal(selectProtocol('hypertrophy'), HYPERTROPHY_DELOAD_V1);
  assert.equal(selectProtocol('power'), POWER_DELOAD_V1);
  assert.equal(selectProtocol('endurance'), ENDURANCE_DELOAD_V1);
});

test('selectProtocol is case- and whitespace-insensitive', () => {
  assert.equal(selectProtocol('  Strength '), STRENGTH_DELOAD_V1);
  assert.equal(selectProtocol('HYPERTROPHY'), HYPERTROPHY_DELOAD_V1);
});

test('selectProtocol defaults to the most conservative protocol (strength) for unknown/missing focus', () => {
  assert.equal(selectProtocol('mobility'), STRENGTH_DELOAD_V1);
  assert.equal(selectProtocol(''), STRENGTH_DELOAD_V1);
  assert.equal(selectProtocol(null), STRENGTH_DELOAD_V1);
  assert.equal(selectProtocol(undefined), STRENGTH_DELOAD_V1);
});

/* ===== computePrescription: the spec's worked example, exactly ===== */

test('strength worked example: 225 × 5 sets @ RIR 2 → 205 × 3 sets @ RIR 5', () => {
  // Spec §STRENGTH_DELOAD_V1: "225 x 5 x 5 @2  becomes  205-210 x 5 x 2-3 @5".
  // 225 × 0.92 = 207 → rounds to 205 (in the 205-210 band).
  // 5 sets × 0.50 = 2.5 → 3 (in the 2-3 band).
  const rx = computePrescription(STRENGTH_DELOAD_V1, { working_weight: 225, working_sets: 5 });
  assert.deepEqual(rx, {
    protocol_id: 'STRENGTH_DELOAD_V1',
    weight: 205,
    target_sets: 3,
    target_rir: 5
  });
});

test('computePrescription applies each protocol deterministically', () => {
  // Hypertrophy: 200 × 0.85 = 170; 4 × 0.50 = 2; RIR 5.
  assert.deepEqual(
    computePrescription(HYPERTROPHY_DELOAD_V1, { working_weight: 200, working_sets: 4 }),
    { protocol_id: 'HYPERTROPHY_DELOAD_V1', weight: 170, target_sets: 2, target_rir: 5 }
  );
  // Power: 200 × 0.90 = 180; 6 × 0.35 = 2.1 → 2; RIR 4.
  assert.deepEqual(
    computePrescription(POWER_DELOAD_V1, { working_weight: 200, working_sets: 6 }),
    { protocol_id: 'POWER_DELOAD_V1', weight: 180, target_sets: 2, target_rir: 4 }
  );
  // Endurance: 200 × 0.80 = 160; 5 × 0.60 = 3; RIR 5.
  assert.deepEqual(
    computePrescription(ENDURANCE_DELOAD_V1, { working_weight: 200, working_sets: 5 }),
    { protocol_id: 'ENDURANCE_DELOAD_V1', weight: 160, target_sets: 3, target_rir: 5 }
  );
});

test('a deload keeps at least one working set even when the cut rounds toward zero', () => {
  // 1 working set × 0.35 = 0.35 → would round to 0; floored to 1 (still a real session).
  const rx = computePrescription(POWER_DELOAD_V1, { working_weight: 100, working_sets: 1 });
  assert.equal(rx.target_sets, 1);
});

test('computePrescription rounds load to the nearest 5 lb by default, honoring a custom step', () => {
  // 185 × 0.92 = 170.2 → 170 at the default 5 lb step.
  assert.equal(computePrescription(STRENGTH_DELOAD_V1, { working_weight: 185, working_sets: 3 }).weight, 170);
  // Same load at a 1 lb micro-step rounds to 170 as well (170.2 → 170).
  assert.equal(
    computePrescription(STRENGTH_DELOAD_V1, { working_weight: 185, working_sets: 3, step: 1 }).weight,
    170
  );
});

test('computePrescription returns null when there is no usable working weight', () => {
  assert.equal(computePrescription(STRENGTH_DELOAD_V1, { working_weight: null, working_sets: 3 }), null);
  assert.equal(computePrescription(STRENGTH_DELOAD_V1, { working_weight: 'n/a', working_sets: 3 }), null);
  assert.equal(computePrescription(null, { working_weight: 200, working_sets: 3 }), null);
});

test('computePrescription leaves target_sets null when working sets are unknown', () => {
  const rx = computePrescription(STRENGTH_DELOAD_V1, { working_weight: 225 });
  assert.equal(rx.weight, 205);
  assert.equal(rx.target_sets, null);
  assert.equal(rx.target_rir, 5);
});

/* ===== roundLoad helper ===== */

test('roundLoad rounds to the nearest rackable increment and guards bad input', () => {
  assert.equal(roundLoad(207), 205);
  assert.equal(roundLoad(166.5), 165);
  assert.equal(roundLoad(170.2, 1), 170);
  assert.equal(roundLoad(null), null);
  assert.equal(roundLoad(''), null);
  assert.equal(roundLoad('abc'), null);
});
