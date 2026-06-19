'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { movementCeilingFor, isLoadPlausible, sanitizeLoad } = require('../services/loadSanity');

// ── movementCeilingFor ─────────────────────────────────────────────────────────

test('movementCeilingFor: lateral raises ceiling is 100 lb', () => {
  assert.equal(movementCeilingFor('Lateral Raises'), 100);
});

test('movementCeilingFor: lateral raise (singular) ceiling is 100 lb', () => {
  assert.equal(movementCeilingFor('Lateral Raise'), 100);
});

test('movementCeilingFor: face pulls ceiling is 100 lb', () => {
  assert.equal(movementCeilingFor('Face Pull'), 100);
  assert.equal(movementCeilingFor('Face Pulls'), 100);
});

test('movementCeilingFor: rear delt ceiling is 100 lb', () => {
  assert.equal(movementCeilingFor('Rear Delt Fly'), 100);
  assert.equal(movementCeilingFor('Rear Delt Raise'), 100);
});

test('movementCeilingFor: core exercises ceiling is 100 lb', () => {
  assert.equal(movementCeilingFor('Hanging Knee Raises'), 100);
  assert.equal(movementCeilingFor('Knee Raises'), 100);
  assert.equal(movementCeilingFor('Plank'), 100);
});

test('movementCeilingFor: arm isolations ceiling is 200 lb', () => {
  assert.equal(movementCeilingFor('Hammer Curl'), 200);
  assert.equal(movementCeilingFor('Bicep Curl'), 200);
  assert.equal(movementCeilingFor('Tricep Pushdown'), 200);
});

test('movementCeilingFor: leg isolations ceiling is 400 lb', () => {
  assert.equal(movementCeilingFor('Leg Curl'), 400);
  assert.equal(movementCeilingFor('Leg Extension'), 400);
  assert.equal(movementCeilingFor('Hamstring Curl'), 400);
});

test('movementCeilingFor: compound upper ceiling is 600 lb', () => {
  assert.equal(movementCeilingFor('Bench Press'), 600);
  assert.equal(movementCeilingFor('Overhead Press'), 600);
  assert.equal(movementCeilingFor('Bent-Over Row'), 600);
  assert.equal(movementCeilingFor('Lat Pulldown'), 600);
  assert.equal(movementCeilingFor('Seated Row'), 600);
});

test('movementCeilingFor: leg press ceiling is 1200 lb (machine)', () => {
  assert.equal(movementCeilingFor('Leg Press'), 1200);
  assert.equal(movementCeilingFor('Single-Leg Seated Leg Press'), 1200);
});

test('movementCeilingFor: big compounds ceiling is 900 lb', () => {
  assert.equal(movementCeilingFor('Deadlift'), 900);
  assert.equal(movementCeilingFor('Back Squat'), 900);
  assert.equal(movementCeilingFor('RDL'), 900);
  assert.equal(movementCeilingFor('Romanian Deadlift'), 900);
});

test('movementCeilingFor: unknown exercise gets default ceiling', () => {
  assert.equal(movementCeilingFor('Unknown Exercise'), 700);
  assert.equal(movementCeilingFor(''), 700);
  assert.equal(movementCeilingFor(null), 700);
});

// ── isLoadPlausible ────────────────────────────────────────────────────────────

test('isLoadPlausible: GOLDEN FIXTURE — 170 lb lateral raise is not plausible', () => {
  assert.equal(isLoadPlausible('Lateral Raises', 170), false);
  assert.equal(isLoadPlausible('Lateral Raise', 170), false);
});

test('isLoadPlausible: 15 lb lateral raise is plausible', () => {
  assert.equal(isLoadPlausible('Lateral Raises', 15), true);
});

test('isLoadPlausible: 100 lb lateral raise is at ceiling — plausible', () => {
  assert.equal(isLoadPlausible('Lateral Raises', 100), true);
});

test('isLoadPlausible: 101 lb lateral raise is over ceiling — not plausible', () => {
  assert.equal(isLoadPlausible('Lateral Raises', 101), false);
});

test('isLoadPlausible: realistic bench press weights are plausible', () => {
  assert.equal(isLoadPlausible('Bench Press', 135), true);
  assert.equal(isLoadPlausible('Bench Press', 225), true);
  assert.equal(isLoadPlausible('Bench Press', 495), true);
  assert.equal(isLoadPlausible('Bench Press', 600), true);
});

test('isLoadPlausible: over-ceiling bench weight is not plausible', () => {
  assert.equal(isLoadPlausible('Bench Press', 605), false);
});

test('isLoadPlausible: realistic squat and deadlift weights are plausible', () => {
  assert.equal(isLoadPlausible('Back Squat', 315), true);
  assert.equal(isLoadPlausible('Deadlift', 500), true);
  assert.equal(isLoadPlausible('Deadlift', 900), true);
});

test('isLoadPlausible: zero and negative weights are not plausible', () => {
  assert.equal(isLoadPlausible('Lateral Raises', 0), false);
  assert.equal(isLoadPlausible('Bench Press', -10), false);
});

test('isLoadPlausible: non-finite weight is not plausible', () => {
  assert.equal(isLoadPlausible('Bench Press', NaN), false);
  assert.equal(isLoadPlausible('Bench Press', Infinity), false);
  assert.equal(isLoadPlausible('Bench Press', null), false);
});

// ── sanitizeLoad ───────────────────────────────────────────────────────────────

test('sanitizeLoad: GOLDEN FIXTURE — 170 lb lateral raise with no history → null weight', () => {
  const result = sanitizeLoad('Lateral Raises', 170, null);
  assert.equal(result.sanitized, true);
  assert.equal(result.weight, null);
  assert.equal(result.originalWeight, 170);
  assert.ok(result.reason.includes('170'));
  assert.ok(result.reason.includes('100'));
});

test('sanitizeLoad: GOLDEN FIXTURE — 170 lb lateral raise falls back to real working weight', () => {
  const result = sanitizeLoad('Lateral Raises', 170, 15);
  assert.equal(result.sanitized, true);
  assert.equal(result.weight, 15);
  assert.equal(result.originalWeight, 170);
});

test('sanitizeLoad: lateral raise at 170, history best = 25 → falls back to 25', () => {
  const result = sanitizeLoad('Lateral Raise', 170, 25);
  assert.equal(result.sanitized, true);
  assert.equal(result.weight, 25);
});

test('sanitizeLoad: plausible bench press weight passes through unchanged', () => {
  const result = sanitizeLoad('Bench Press', 225, 220);
  assert.equal(result.sanitized, false);
  assert.equal(result.weight, 225);
  assert.equal(result.originalWeight, undefined);
});

test('sanitizeLoad: plausible deadlift weight passes through unchanged', () => {
  const result = sanitizeLoad('Deadlift', 500, 495);
  assert.equal(result.sanitized, false);
  assert.equal(result.weight, 500);
});

test('sanitizeLoad: face pull over ceiling falls back to history', () => {
  const result = sanitizeLoad('Face Pull', 150, 45);
  assert.equal(result.sanitized, true);
  assert.equal(result.weight, 45);
  assert.equal(result.originalWeight, 150);
});

test('sanitizeLoad: invalid historyBest is treated as no history', () => {
  const result = sanitizeLoad('Lateral Raises', 170, NaN);
  assert.equal(result.sanitized, true);
  assert.equal(result.weight, null);
});

test('sanitizeLoad: historyBest of 0 is treated as no history', () => {
  const result = sanitizeLoad('Lateral Raises', 170, 0);
  assert.equal(result.sanitized, true);
  assert.equal(result.weight, null);
});

test('sanitizeLoad: historyBest that is also above ceiling is not used as fallback', () => {
  // Corrupt history: lifter somehow has 170 lb logged as lateral raises.
  // The fallback must also be sanitized — cannot use 170 as the "safe" weight.
  const result = sanitizeLoad('Lateral Raises', 170, 170);
  assert.equal(result.sanitized, true);
  assert.equal(result.weight, null, 'corrupt historyBest must not be used as fallback');
});

// ── Integration: recommendNextSet load sanity ──────────────────────────────────

// Verifies that the analytics engine cannot prescribe 170 lb on lateral raises,
// even when the underlying row data contains a wrong/colliding liftCode
// whose history happens to include 170 lb weights.
test('recommendNextSet: GOLDEN FIXTURE — lateral raises never prescribed at 170 lb', () => {
  const { recommendNextSet } = require('../services/analytics');

  // Simulate a history collision: rows labelled as lateral raises but with
  // weights typical of another exercise (e.g. bench press at 170 lb).
  // This is the root scenario for the live bug (2026-06-16).
  const liftCode = 'LRA01';
  const rows = [
    // 5 sessions of "Lateral Raises" logged at 170 lb — the corrupt history
    ['2026-05-01', 'S1', 'Lateral Raises', 'Lateral Raises', 'Shoulders', liftCode, '1', '170', '5', '2', ''],
    ['2026-05-08', 'S2', 'Lateral Raises', 'Lateral Raises', 'Shoulders', liftCode, '1', '170', '5', '2', ''],
    ['2026-05-15', 'S3', 'Lateral Raises', 'Lateral Raises', 'Shoulders', liftCode, '1', '170', '5', '2', ''],
    ['2026-05-22', 'S4', 'Lateral Raises', 'Lateral Raises', 'Shoulders', liftCode, '1', '170', '5', '2', ''],
    ['2026-05-29', 'S5', 'Lateral Raises', 'Lateral Raises', 'Shoulders', liftCode, '1', '170', '5', '2', ''],
  ];

  const rec = recommendNextSet(rows, liftCode, { today: '2026-06-01' });

  // The sanity guard must prevent 170 lb from being prescribed.
  if (rec.next_target !== null) {
    assert.ok(
      rec.next_target.weight <= 100,
      `Expected next_target.weight ≤ 100 lb (ceiling), got ${rec.next_target.weight}`
    );
  }
  // next_target may be null (fallback with best_weight = 170, which is also above ceiling)
  // In either case, 170 must never appear as a prescription.
  if (rec.next_target !== null) {
    assert.notEqual(rec.next_target.weight, 170, 'Lateral Raises must never be prescribed at 170 lb');
  }
});

test('recommendNextSet: GOLDEN FIXTURE — justLoggedSet at 170 lb lateral raise still blocked', () => {
  const { recommendNextSet } = require('../services/analytics');

  // The in-workout path passes justLoggedSet. Even when the lifter's just-logged set
  // is at a corrupt/colliding weight, the *next target* must still pass the ceiling.
  const liftCode = 'LRA01';
  const rows = [
    ['2026-05-01', 'S1', 'Lateral Raises', 'Lateral Raises', 'Shoulders', liftCode, '1', '170', '5', '2', ''],
    ['2026-05-08', 'S2', 'Lateral Raises', 'Lateral Raises', 'Shoulders', liftCode, '1', '170', '5', '2', ''],
  ];

  const rec = recommendNextSet(rows, liftCode, {
    today: '2026-06-01',
    justLoggedSet: { weight: 170, reps: 5, rir: 2 },
  });

  if (rec.next_target !== null) {
    assert.ok(
      rec.next_target.weight <= 100,
      `Expected next_target.weight ≤ 100 lb (ceiling), got ${rec.next_target.weight}`
    );
    assert.notEqual(rec.next_target.weight, 170, 'Lateral Raises must never be prescribed at 170 lb via justLoggedSet path');
  }
});

test('recommendNextSet: normal lateral raise history (15 lb) prescribes plausible weight', () => {
  const { recommendNextSet } = require('../services/analytics');

  const liftCode = 'LRA01';
  const rows = [
    ['2026-05-01', 'S1', 'Lateral Raises', 'Lateral Raises', 'Shoulders', liftCode, '1', '15', '12', '2', ''],
    ['2026-05-08', 'S2', 'Lateral Raises', 'Lateral Raises', 'Shoulders', liftCode, '1', '15', '12', '2', ''],
    ['2026-05-15', 'S3', 'Lateral Raises', 'Lateral Raises', 'Shoulders', liftCode, '1', '15', '12', '3', ''],
  ];

  const rec = recommendNextSet(rows, liftCode, { today: '2026-06-01' });
  assert.ok(rec.next_target !== null, 'should produce a recommendation');
  assert.ok(rec.next_target.weight <= 100, `Expected ≤ 100 lb, got ${rec.next_target.weight}`);
  assert.ok(rec.next_target.weight > 0, 'should produce a positive weight');
});
