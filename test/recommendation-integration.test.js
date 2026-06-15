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

test('integration: a true deload is framed as a proposal — duration, return point, and a decline path (PR 3a)', () => {
  const rows = [
    ...flatStall('Back Squat', 'Quads', 'SQ01', 315, 5),
    ...flatStall('Bench Press', 'Chest', 'BEN01', 225, 5),
  ];
  const result = scoreIntents(rows, [], { today: TODAY });
  const deload = result.intents.find(i => i.id === 'deload_reset');
  assert.ok(deload && deload.label === 'Deload & Reset', 'a genuine deload should be present');

  // Structured proposal carries all three consent elements.
  assert.ok(deload.proposal, 'deload must carry a structured proposal');
  assert.match(deload.proposal.duration, /week|rotation/i, 'states how long the deload runs');
  assert.match(deload.proposal.return_point, /normal working weight|back to/i, 'states the return point');
  assert.match(deload.proposal.return_point, /315|225/, 'names a real pre-deload working weight to return to');
  assert.match(deload.proposal.decline, /Test Progress|Strength|power through|optional/i, 'offers a decline / power-through path');

  // The proposal also surfaces in the rendered why_today rationale (so it shows
  // even without a UI that reads the structured field).
  const why = (deload.why_today || []).join(' | ');
  assert.match(why, /week|rotation/i, 'why_today states the duration');
  assert.match(why, /normal working weight|back to/i, 'why_today states the return point');
  assert.match(why, /Test Progress|Strength|power through|optional/i, 'why_today offers the decline path');
});

test('integration: a true deload rounds out to a fuller session with rested accessories', () => {
  const rows = [
    // Two stalled MAIN lifts → a genuine systemic deload (not accessory-only).
    ...flatStall('Back Squat', 'Quads', 'SQ01', 315, 5),
    ...flatStall('Bench Press', 'Chest', 'BEN01', 225, 5),
    // Rested, progressing accessories the owner trains → fillers for the deload day.
    row('2026-06-01', 'DBC-1', 'Dumbbell Curl', 'Biceps', 'DBC01', 25, 12),
    row('2026-06-04', 'DBC-2', 'Dumbbell Curl', 'Biceps', 'DBC01', 30, 12),
    row('2026-06-01', 'FP-1', 'Face Pull', 'Rear Delts', 'FP01', 45, 15),
    row('2026-06-04', 'FP-2', 'Face Pull', 'Rear Delts', 'FP01', 50, 15),
    row('2026-06-01', 'LPD-1', 'Lat Pulldown', 'Back', 'LPD01', 120, 10),
    row('2026-06-04', 'LPD-2', 'Lat Pulldown', 'Back', 'LPD01', 130, 10),
  ];
  const result = scoreIntents(rows, [], { today: TODAY });

  const deload = result.intents.find(i => i.id === 'deload_reset');
  assert.ok(deload, 'two main-lift stalls must arm a true deload');
  assert.equal(deload.label, 'Deload & Reset');

  // The deloaded mains lead at 5 reps; the session is fuller than just the 2 stalls.
  assert.ok(deload.exercises.length > 2, `expected a fuller deload, got ${deload.exercises.length}`);
  assert.ok(deload.exercises.length <= 6, 'deload session is capped at 6 movements');
  const mains = deload.exercises.filter(e => ['SQ01', 'BEN01'].includes(e.lift_code));
  assert.equal(mains.length, 2, 'both deloaded mains lead the session');
  for (const m of mains) assert.equal(m.target_reps, 5);
  // At least one rested accessory was pulled in to round it out, and no extra main
  // compound was added to the deload day.
  const names = deload.exercises.map(e => e.exercise);
  assert.ok(
    names.some(n => ['Dumbbell Curl', 'Face Pull', 'Lat Pulldown'].includes(n)),
    'a rested accessory should round out the deload day'
  );
});

test('integration: a deload clamps EVERY lift to its documented working weight on real increments (PR 5)', () => {
  const rows = [
    ...flatStall('Back Squat', 'Quads', 'SQ01', 315, 5),
    ...flatStall('Bench Press', 'Chest', 'BEN01', 225, 5),
    // Rested, progressing accessories — their next_target would be a step UP, so
    // before PR 5 they overshot (face pull 55 > 50 best, lat pulldown 180 > 170).
    row('2026-06-01', 'FP-1', 'Face Pull', 'Rear Delts', 'FP01', 45, 15),
    row('2026-06-04', 'FP-2', 'Face Pull', 'Rear Delts', 'FP01', 50, 15),
    row('2026-06-01', 'LPD-1', 'Lat Pulldown', 'Back', 'LPD01', 160, 10),
    row('2026-06-04', 'LPD-2', 'Lat Pulldown', 'Back', 'LPD01', 170, 10),
    row('2026-06-01', 'DBC-1', 'Dumbbell Curl', 'Biceps', 'DBC01', 25, 12),
    row('2026-06-04', 'DBC-2', 'Dumbbell Curl', 'Biceps', 'DBC01', 30, 12),
  ];
  const result = scoreIntents(rows, [], { today: TODAY });
  const deload = result.intents.find(i => i.id === 'deload_reset');
  assert.ok(deload && deload.label === 'Deload & Reset', 'a genuine deload should be present');

  // Documented working weight = the heaviest the lifter has actually used per lift.
  const workingByCode = {};
  for (const r of rows) {
    const code = r[5];
    workingByCode[code] = Math.max(workingByCode[code] || 0, Number(r[7]));
  }

  for (const ex of deload.exercises) {
    const working = workingByCode[ex.lift_code];
    assert.ok(working, `${ex.exercise} should have working history`);
    // Every prescribed lift — mains AND accessories — is deloaded: below the usual
    // working weight, never above it, and on a real 5 lb increment.
    assert.ok(ex.target_weight <= working, `${ex.exercise} ${ex.target_weight} must not exceed working ${working}`);
    assert.ok(ex.target_weight < working, `${ex.exercise} ${ex.target_weight} must be deloaded below working ${working}`);
    assert.equal(ex.target_weight % 5, 0, `${ex.exercise} ${ex.target_weight} must land on a real increment`);
  }

  // The exact repro lifts no longer step UP on a deload day.
  const fp = deload.exercises.find(e => e.lift_code === 'FP01');
  const lpd = deload.exercises.find(e => e.lift_code === 'LPD01');
  if (fp) assert.ok(fp.target_weight <= 45, `face pull deload ${fp.target_weight} should be ~45, not a step up to 55`);
  if (lpd) assert.ok(lpd.target_weight < 170, `lat pulldown deload ${lpd.target_weight} should be below the usual 170, not 180`);
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
