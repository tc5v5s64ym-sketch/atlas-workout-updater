const { test } = require('node:test');
const assert = require('node:assert/strict');

// Integration coverage: drive the REAL scoreIntents() path (not just the pure
// liftRole helper) and confirm the deload-vs-accessory behaviour end-to-end.
const { scoreIntents } = require('../services/analytics');

// 12-column Log_Cleaned array row (volume_calc omitted — analytics derives it).
function row(date, session, name, muscle, code, weight, reps, rir = 2) {
  return [date, session, name, name, muscle, code, '1', String(weight), String(reps), String(rir), ''];
}

// Three flat-weight sessions for one lift → a stall in detectStalls().
function flatStall(name, muscle, code, weight, reps) {
  return [
    row('2026-06-01', `${code}-S1`, name, muscle, code, weight, reps),
    row('2026-06-04', `${code}-S2`, name, muscle, code, weight, reps),
    row('2026-06-07', `${code}-S3`, name, muscle, code, weight, reps),
  ];
}

// ~2 weeks after the last session, so every trained pattern reads as rested and
// the stalls become "eligible" — which is what arms the deload_reset gate.
const TODAY = '2026-06-21';

test('integration: accessory-only stalls never emit a Deload & Reset', () => {
  const rows = [
    ...flatStall('Dumbbell Curl', 'Biceps', 'DBC01', 30, 12),
    ...flatStall('Barbell Shrug', 'Traps', 'SHR01', 135, 12),
    ...flatStall('Face Pull', 'Rear Delts', 'FP01', 50, 15),
  ];
  const result = scoreIntents(rows, [], { today: TODAY });

  // The gate fired (2+ rested stalls) — so this proves the real path, not a stub.
  const deload = result.intents.find(i => i.id === 'deload_reset');
  assert.ok(deload, 'deload_reset gate should fire for 2+ rested stalls');

  // …but it is reframed and never surfaces as a Deload anywhere.
  assert.equal(deload.label, 'Recovery Pull / Accessory');
  assert.ok(!result.intents.some(i => i.label === 'Deload & Reset'), 'no intent may be labeled Deload');
  assert.notEqual(result.todays_read.recommended_label, 'Deload & Reset');

  // No accessory gets a 5×3.
  for (const ex of deload.exercises) {
    assert.ok(ex.target_reps >= 8 && ex.target_reps !== 5, `${ex.exercise} should not be 5 reps (got ${ex.target_reps})`);
  }

  // No deload wording survives in the user-facing rationale.
  const copy = [deload.label, deload.focus, ...(deload.why_today || []), ...(deload.watch_for || [])].join(' | ');
  assert.doesNotMatch(copy, /deload/i);
});

test('integration: main-lift stalls can still emit a true Deload', () => {
  const rows = [
    ...flatStall('Back Squat', 'Quads', 'SQ01', 315, 5),
    ...flatStall('Bench Press', 'Chest', 'BEN01', 225, 5),
  ];
  const result = scoreIntents(rows, [], { today: TODAY });

  const deload = result.intents.find(i => i.id === 'deload_reset');
  assert.ok(deload, 'deload_reset gate should fire for two main-lift stalls');
  assert.equal(deload.label, 'Deload & Reset');             // stays a genuine deload
  for (const ex of deload.exercises) {
    assert.equal(ex.target_reps, 5);                        // main 5-rep deload singles preserved
  }
});
