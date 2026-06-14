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

test('integration: an accessory reset programs a fuller session, not just the stalled lifts', () => {
  const rows = [
    ...flatStall('Dumbbell Curl', 'Biceps', 'DBC01', 30, 12),
    ...flatStall('Barbell Shrug', 'Traps', 'SHR01', 135, 12),
    ...flatStall('Face Pull', 'Rear Delts', 'FP01', 50, 15),
    // progressing pull movements: stay out of the stall list, but in the pool
    row('2026-06-01', 'SR-S1', 'Seated Cable Row', 'Back', 'SCR01', 150, 10),
    row('2026-06-04', 'SR-S2', 'Seated Cable Row', 'Back', 'SCR01', 155, 10),
    row('2026-06-07', 'SR-S3', 'Seated Cable Row', 'Back', 'SCR01', 160, 10),
    row('2026-06-01', 'LP-S1', 'Lat Pulldown', 'Back', 'LPD01', 150, 10),
    row('2026-06-04', 'LP-S2', 'Lat Pulldown', 'Back', 'LPD01', 155, 10),
    row('2026-06-07', 'LP-S3', 'Lat Pulldown', 'Back', 'LPD01', 160, 10),
  ];
  const result = scoreIntents(rows, [], { today: TODAY });
  const intent = result.intents.find(i => i.id === 'deload_reset');
  assert.ok(intent);
  assert.equal(intent.label, 'Recovery Pull / Accessory');

  // The session is broader than the 3 stalled lifts — it pulls in the rested
  // movements the owner actually trains.
  assert.ok(intent.exercises.length > 3, `expected a fuller session, got ${intent.exercises.length}`);
  const names = intent.exercises.map(e => e.exercise);
  assert.ok(names.includes('Seated Cable Row'), 'session should include a non-stalled rested movement');
  for (const ex of intent.exercises) {
    assert.ok(ex.target_reps >= 8, `${ex.exercise} should not be a low-rep scheme (got ${ex.target_reps})`);
  }
});

test('integration: the stalled accessories are always in the session, even behind newer work', () => {
  // Stalls are older; six newer (more recent) pull movements would crowd them out
  // of a recency-ordered slice — but the stalled lifts being reset must stay.
  const oldStall = (name, muscle, code, w, r) => [
    row('2026-05-20', `${code}1`, name, muscle, code, w, r),
    row('2026-05-23', `${code}2`, name, muscle, code, w, r),
    row('2026-05-26', `${code}3`, name, muscle, code, w, r),
  ];
  const rows = [
    ...oldStall('Dumbbell Curl', 'Biceps', 'DBC01', 30, 12),
    ...oldStall('Barbell Shrug', 'Traps', 'SHR01', 135, 12),
    ...oldStall('Face Pull', 'Rear Delts', 'FP01', 50, 15),
  ];
  for (let i = 0; i < 6; i++) {
    ['2026-06-01', '2026-06-04', '2026-06-07'].forEach((d, j) =>
      rows.push(row(d, `EX${i}-${j}`, `Cable Pull ${i}`, 'Back', `CP${i}`, 100 + j * 5, 12)));
  }
  const result = scoreIntents(rows, [], { today: TODAY });
  const intent = result.intents.find(i => i.id === 'deload_reset');
  assert.ok(intent, 'gate should fire');
  const names = intent.exercises.map(e => e.exercise);
  for (const n of ['Dumbbell Curl', 'Barbell Shrug', 'Face Pull']) {
    assert.ok(names.includes(n), `${n} (a stalled lift being reset) must be in the session`);
  }
});

test('integration: a fatigued pattern is kept out of the recovery session', () => {
  const rows = [
    ...flatStall('Dumbbell Curl', 'Biceps', 'DBC01', 30, 12),   // pull — rested
    ...flatStall('Barbell Shrug', 'Traps', 'SHR01', 135, 12),   // pull — rested
    ...flatStall('Face Pull', 'Rear Delts', 'FP01', 50, 15),    // pull — rested
    // Legs trained the day before "today" → lower pattern is fatigued.
    row('2026-06-18', 'LE-1', 'Leg Extension', 'Quads', 'LEX01', 120, 12, 1),
    row('2026-06-20', 'LE-2', 'Leg Extension', 'Quads', 'LEX01', 120, 12, 1),
  ];
  const result = scoreIntents(rows, [], { today: TODAY });
  const intent = result.intents.find(i => i.id === 'deload_reset');
  assert.ok(intent, 'gate should fire');
  const names = intent.exercises.map(e => e.exercise);
  assert.ok(names.includes('Dumbbell Curl'), 'rested stalled accessory stays in');
  assert.ok(!names.includes('Leg Extension'), 'a freshly-fatigued pattern must be excluded');
});
