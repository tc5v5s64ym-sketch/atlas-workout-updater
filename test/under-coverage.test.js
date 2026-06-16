'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeUnderCoverage, MUSCLE_TARGETS } = require('../services/underCoverage');
const { TAXONOMY } = require('../services/muscleCoverage');

// Anchor date used for all deterministic fixtures.
const ANCHOR = '2026-06-14';

// Build N identical log rows for one exercise, all on ANCHOR date.
function sets(exercise, liftCode, count) {
  return Array.from({ length: count }, (_, i) =>
    [ANCHOR, 'S1', exercise, exercise, 'X', liftCode, String(i + 1), '100', '8', '2', '']);
}

/* ───────────────────────────────────────────────────────────────────────────
 * Structural guarantees
 * ─────────────────────────────────────────────────────────────────────────── */

test('returns exactly 17 records — one per taxonomy muscle', () => {
  const out = computeUnderCoverage([], { today: ANCHOR });
  assert.equal(out.length, 17);
});

test('every record has the required shape', () => {
  const out = computeUnderCoverage([], { today: ANCHOR });
  for (const rec of out) {
    assert.ok('muscle' in rec);
    assert.ok('currentEffectiveSets' in rec);
    assert.ok('targetRange' in rec);
    assert.ok('min' in rec.targetRange);
    assert.ok('max' in rec.targetRange);
    assert.ok('status' in rec);
    assert.ok('reason' in rec);
    assert.ok(['under', 'adequate', 'optimal'].includes(rec.status),
      `unexpected status "${rec.status}" for ${rec.muscle}`);
  }
});

test('returned muscles match the 17-muscle taxonomy exactly', () => {
  const out = computeUnderCoverage([], { today: ANCHOR });
  const muscles = out.map(r => r.muscle);
  assert.deepEqual(muscles, [...TAXONOMY]);
});

test('MUSCLE_TARGETS covers every taxonomy muscle', () => {
  for (const muscle of [...TAXONOMY]) {
    assert.ok(MUSCLE_TARGETS[muscle], `no target for "${muscle}"`);
    assert.ok(MUSCLE_TARGETS[muscle].min >= 0);
    assert.ok(MUSCLE_TARGETS[muscle].max > MUSCLE_TARGETS[muscle].min);
  }
});

/* ───────────────────────────────────────────────────────────────────────────
 * Fixture A: Bench Press × 5 sets
 * Hand-computed: chest 5.0 direct → adequate (min=4, max=12)
 *                triceps 2.5 indirect → under (min=3)
 *                front_delts 2.5 indirect → adequate (min=2, max=6)
 * ─────────────────────────────────────────────────────────────────────────── */

test('Bench × 5: chest = 5.0 eff. sets → adequate', () => {
  const out = computeUnderCoverage(sets('Bench Press', 'BP01', 5), { today: ANCHOR });
  const chest = out.find(r => r.muscle === 'chest');
  assert.equal(chest.currentEffectiveSets, 5);
  assert.equal(chest.status, 'adequate');
  assert.deepEqual(chest.targetRange, { min: 4, max: 12 });
});

test('Bench × 5: triceps = 2.5 eff. sets (indirect) → under', () => {
  const out = computeUnderCoverage(sets('Bench Press', 'BP01', 5), { today: ANCHOR });
  const tri = out.find(r => r.muscle === 'triceps');
  assert.equal(tri.currentEffectiveSets, 2.5);
  assert.equal(tri.status, 'under');
});

test('Bench × 5: front_delts = 2.5 eff. sets (indirect) → adequate', () => {
  const out = computeUnderCoverage(sets('Bench Press', 'BP01', 5), { today: ANCHOR });
  const fd = out.find(r => r.muscle === 'front_delts');
  assert.equal(fd.currentEffectiveSets, 2.5);
  assert.equal(fd.status, 'adequate');
});

/* ───────────────────────────────────────────────────────────────────────────
 * Fixture B: Lat Pulldown × 4 sets
 * Hand-computed: lats 4.0 direct → adequate (min=4; boundary is inclusive)
 *                biceps 2.0 indirect → under (min=3)
 * ─────────────────────────────────────────────────────────────────────────── */

test('LP × 4: lats = 4.0 eff. sets → adequate (min boundary is inclusive)', () => {
  const out = computeUnderCoverage(sets('Lat Pulldown', 'LP01', 4), { today: ANCHOR });
  const lats = out.find(r => r.muscle === 'lats');
  assert.equal(lats.currentEffectiveSets, 4);
  assert.equal(lats.status, 'adequate', 'exactly at min boundary must be adequate, not under');
});

test('LP × 4: biceps = 2.0 eff. sets (indirect) → under', () => {
  const out = computeUnderCoverage(sets('Lat Pulldown', 'LP01', 4), { today: ANCHOR });
  const bi = out.find(r => r.muscle === 'biceps');
  assert.equal(bi.currentEffectiveSets, 2);
  assert.equal(bi.status, 'under');
});

/* ───────────────────────────────────────────────────────────────────────────
 * Fixture C: Overhead Press × 3 sets
 * Hand-computed: front_delts 3.0 → adequate (min=2)
 *                side_delts 3.0 → adequate (min=3; boundary inclusive)
 *                triceps 1.5 → under (min=3)
 *                traps 1.5 → under (min=2)
 * ─────────────────────────────────────────────────────────────────────────── */

test('OHP × 3: front_delts = 3.0 → adequate', () => {
  const out = computeUnderCoverage(sets('Overhead Press', 'OHP01', 3), { today: ANCHOR });
  const fd = out.find(r => r.muscle === 'front_delts');
  assert.equal(fd.currentEffectiveSets, 3);
  assert.equal(fd.status, 'adequate');
});

test('OHP × 3: side_delts = 3.0 → adequate (min boundary inclusive)', () => {
  const out = computeUnderCoverage(sets('Overhead Press', 'OHP01', 3), { today: ANCHOR });
  const sd = out.find(r => r.muscle === 'side_delts');
  assert.equal(sd.currentEffectiveSets, 3);
  assert.equal(sd.status, 'adequate');
});

test('OHP × 3: triceps = 1.5 → under', () => {
  const out = computeUnderCoverage(sets('Overhead Press', 'OHP01', 3), { today: ANCHOR });
  const tri = out.find(r => r.muscle === 'triceps');
  assert.equal(tri.currentEffectiveSets, 1.5);
  assert.equal(tri.status, 'under');
});

test('OHP × 3: traps = 1.5 → under', () => {
  const out = computeUnderCoverage(sets('Overhead Press', 'OHP01', 3), { today: ANCHOR });
  const tr = out.find(r => r.muscle === 'traps');
  assert.equal(tr.currentEffectiveSets, 1.5);
  assert.equal(tr.status, 'under');
});

/* ───────────────────────────────────────────────────────────────────────────
 * Ceiling: max boundary → optimal
 * Bench × 12: chest = 12.0 → optimal (max=12; ≥ max is optimal)
 * Bench × 11: chest = 11.0 → adequate (11 < 12)
 * ─────────────────────────────────────────────────────────────────────────── */

test('Bench × 12: chest at ceiling → optimal', () => {
  const out = computeUnderCoverage(sets('Bench Press', 'BP01', 12), { today: ANCHOR });
  const chest = out.find(r => r.muscle === 'chest');
  assert.equal(chest.currentEffectiveSets, 12);
  assert.equal(chest.status, 'optimal');
});

test('Bench × 11: chest just below ceiling → adequate', () => {
  const out = computeUnderCoverage(sets('Bench Press', 'BP01', 11), { today: ANCHOR });
  const chest = out.find(r => r.muscle === 'chest');
  assert.equal(chest.currentEffectiveSets, 11);
  assert.equal(chest.status, 'adequate');
});

/* ───────────────────────────────────────────────────────────────────────────
 * Empty / null inputs → all muscles under at 0 eff. sets
 * ─────────────────────────────────────────────────────────────────────────── */

test('empty log: all 17 muscles are under at 0 effective sets', () => {
  const out = computeUnderCoverage([], { today: ANCHOR });
  for (const rec of out) {
    assert.equal(rec.currentEffectiveSets, 0, `${rec.muscle} should be 0`);
    assert.equal(rec.status, 'under', `${rec.muscle} should be under`);
  }
});

test('null logRows handled safely — same as empty', () => {
  const out = computeUnderCoverage(null, { today: ANCHOR });
  assert.equal(out.length, 17);
  assert.ok(out.every(r => r.status === 'under'));
});

/* ───────────────────────────────────────────────────────────────────────────
 * reason field
 * ─────────────────────────────────────────────────────────────────────────── */

test('under reason mentions the muscle name and the minimum', () => {
  const out = computeUnderCoverage([], { today: ANCHOR });
  const rec = out.find(r => r.muscle === 'chest');
  assert.match(rec.reason, /chest/i);
  assert.match(rec.reason, /4/);  // min for chest
});

test('adequate reason mentions the target range', () => {
  const out = computeUnderCoverage(sets('Bench Press', 'BP01', 5), { today: ANCHOR });
  const chest = out.find(r => r.muscle === 'chest');
  assert.equal(chest.status, 'adequate');
  assert.match(chest.reason, /4/);   // min
  assert.match(chest.reason, /12/);  // max
});

test('optimal reason mentions the ceiling', () => {
  const out = computeUnderCoverage(sets('Bench Press', 'BP01', 12), { today: ANCHOR });
  const chest = out.find(r => r.muscle === 'chest');
  assert.equal(chest.status, 'optimal');
  assert.match(chest.reason, /12/);  // max/ceiling
});

/* ───────────────────────────────────────────────────────────────────────────
 * today option passes through to the volume window
 * ─────────────────────────────────────────────────────────────────────────── */

test('today option: rows after the anchor are excluded', () => {
  const future = ['2026-06-15', 'S1', 'Bench Press', 'Bench Press', 'X', 'BP01', '1', '100', '8', '2', ''];
  const out = computeUnderCoverage([future], { today: ANCHOR });
  const chest = out.find(r => r.muscle === 'chest');
  assert.equal(chest.currentEffectiveSets, 0, 'row after anchor must be excluded');
  assert.equal(chest.status, 'under');
});
