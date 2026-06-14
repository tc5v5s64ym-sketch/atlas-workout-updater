const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyLiftRole, isAccessory, isMainCompound,
  accessoryRepTarget, guardAccessoryReps, recommendedTargetRir, applyLiftRoleGuards,
  ACCESSORY_RESET_LABEL,
} = require('../services/liftRole');

/* ===== recommended target RIR (intent + role based) ===== */

test('recommendedTargetRir is intent + role based', () => {
  // Strength: heavy main leaves less in the tank than accessories.
  assert.equal(recommendedTargetRir({ exercise: 'Back Squat', muscle_group: 'Quads' }, 'build_strength'), 1);
  assert.equal(recommendedTargetRir({ exercise: 'Face Pull', muscle_group: 'Rear Delts' }, 'build_strength'), 2);
  // Recovery / reduced stress: leave more in reserve.
  assert.equal(recommendedTargetRir({ exercise: 'Back Squat', muscle_group: 'Quads' }, 'recovery_pump'), 2);
  assert.equal(recommendedTargetRir({ exercise: 'Dumbbell Curl', muscle_group: 'Biceps' }, 'deload_reset'), 3);
  // Default (hypertrophy / balanced): moderate.
  assert.equal(recommendedTargetRir({ exercise: 'Incline Dumbbell Press', muscle_group: 'Chest' }, 'build_muscle'), 2);
});

test('applyLiftRoleGuards attaches a recommended target_rir to every planned exercise', () => {
  const result = {
    intents: [
      { id: 'build_strength', label: 'Build Strength', exercises: [
        { exercise: 'Back Squat', muscle_group: 'Quads', target_weight: 315, target_reps: 5, target_sets: 3 },
        { exercise: 'Face Pull', muscle_group: 'Rear Delts', target_weight: 50, target_reps: 15, target_sets: 3 },
      ] },
      { id: 'recovery_pump', label: 'Recovery / Pump', exercises: [
        { exercise: 'Dumbbell Curl', muscle_group: 'Biceps', target_weight: 30, target_reps: 12, target_sets: 3 },
      ] },
    ],
    todays_read: {},
  };
  const guarded = applyLiftRoleGuards(result);
  assert.equal(guarded.intents[0].exercises[0].target_rir, 1); // strength main
  assert.equal(guarded.intents[0].exercises[1].target_rir, 2); // strength accessory
  assert.equal(guarded.intents[1].exercises[0].target_rir, 3); // recovery accessory
  // existing fields are preserved
  assert.equal(guarded.intents[0].exercises[0].target_weight, 315);
});

test('applyLiftRoleGuards respects an explicit target_rir if already present', () => {
  const result = {
    intents: [{ id: 'build_muscle', exercises: [{ exercise: 'Bench Press', muscle_group: 'Chest', target_rir: 0 }] }],
    todays_read: {},
  };
  const guarded = applyLiftRoleGuards(result);
  assert.equal(guarded.intents[0].exercises[0].target_rir, 0);
});

/* ===== classifier ===== */

test('classifyLiftRole tags obvious accessories as accessory', () => {
  for (const name of [
    'Dumbbell Curl', 'Hammer Curl', 'Cable Curl', 'Face Pull', 'Lateral Raise',
    'Rear Delt Fly', 'Triceps Pressdown', 'Triceps Pushdown', 'Leg Curl',
    'Leg Extension', 'Barbell Shrug', 'Shrugs', 'Calf Raise', 'Standing Calf Raise',
    'Hanging Knee Raise', 'Cable Fly',
  ]) {
    assert.equal(classifyLiftRole(name), 'accessory', `${name} should be accessory`);
    assert.equal(isAccessory(name), true);
  }
});

test('classifyLiftRole tags big compounds as main', () => {
  for (const name of [
    'Back Squat', 'Front Squat', 'Deadlift', 'Romanian Deadlift', 'Bench Press',
    'Barbell Bench Press', 'Overhead Press', 'OHP', 'Push Press', 'Barbell Row',
    'Bent-Over Row', 'Pendlay Row', 'Weighted Pull-up',
  ]) {
    assert.equal(classifyLiftRole(name), 'main', `${name} should be main`);
    assert.equal(isMainCompound(name), true);
  }
});

test('classifyLiftRole leaves machine/cable compounds as secondary (not main, not accessory)', () => {
  for (const name of ['Seated Cable Row', 'Lat Pulldown', 'Leg Press', 'Incline DB Press']) {
    assert.equal(classifyLiftRole(name), 'secondary', `${name} should be secondary`);
  }
});

test('classifyLiftRole falls back to muscle group, and is null-safe', () => {
  assert.equal(classifyLiftRole('Mystery Move', 'Biceps'), 'accessory');
  assert.equal(classifyLiftRole('Mystery Move', 'Chest'), 'secondary');
  assert.equal(classifyLiftRole(null, null), 'secondary');
  assert.equal(classifyLiftRole(undefined), 'secondary');
});

/* ===== rep guard ===== */

test('guardAccessoryReps bumps a sub-floor accessory scheme into its rep range', () => {
  const curl = guardAccessoryReps({ exercise: 'Dumbbell Curl', target_weight: 27, target_reps: 5, target_sets: 3 });
  assert.ok(curl.target_reps >= 10, 'curl reps bumped out of 5');
  assert.notEqual(curl.target_reps, 5);
  assert.equal(curl.target_weight, 27, 'load reduction preserved');
  assert.match(curl.reason, /reset/i);

  const facePull = guardAccessoryReps({ exercise: 'Face Pull', target_weight: 41, target_reps: 5, target_sets: 3 });
  assert.equal(facePull.target_reps, 15);
});

test('guardAccessoryReps leaves main lifts and already-sane accessory reps alone', () => {
  const squat = { exercise: 'Back Squat', target_weight: 280, target_reps: 5, target_sets: 3 };
  assert.deepEqual(guardAccessoryReps(squat), squat); // main 5-rep deload is fine

  const goodCurl = { exercise: 'Dumbbell Curl', target_weight: 27, target_reps: 12, target_sets: 3 };
  assert.deepEqual(guardAccessoryReps(goodCurl), goodCurl); // already in range
});

/* ===== applyLiftRoleGuards — behavioral ===== */

function deloadResult(exercises, recommended = true) {
  return {
    today: '2026-06-13',
    todays_read: {
      patterns: [],
      recommended_intent_id: recommended ? 'deload_reset' : 'build_strength',
      recommended_label: 'Deload & Reset',
      recommended_reason: 'Drop ~10%, sharpen form, rebuild momentum',
    },
    intents: [
      {
        id: 'deload_reset', label: 'Deload & Reset', score: 60,
        focus: 'Drop ~10%, sharpen form, rebuild momentum',
        recommended,
        // Deload-worded rationale, exactly like scoreIntents emits it.
        why_today: exercises.map(e => `${e.exercise} stalled — deload to ~${e.target_weight} lb`),
        what_it_protects: ['Avoids grinding through a plateau', 'Lowers injury risk from repeated max-effort grinding'],
        watch_for: ['If a deloaded set still feels heavy, take a full rest day instead'],
        exercises,
      },
      { id: 'custom', label: 'Custom', score: 50, focus: 'You decide', exercises: [] },
    ],
  };
}

function rationaleText(intent) {
  return [
    intent.label, intent.focus,
    ...(intent.why_today || []), ...(intent.watch_for || []), ...(intent.what_it_protects || []),
    ...(intent.exercises || []).map(e => e.reason),
  ].filter(Boolean).join(' | ');
}

test('accessory-ONLY stalls do NOT produce a True Deload', () => {
  const out = applyLiftRoleGuards(deloadResult([
    { exercise: 'Dumbbell Curl', lift_code: 'DBC01', target_weight: 27, target_reps: 5, target_sets: 3 },
    { exercise: 'Shrugs', lift_code: 'SHR01', target_weight: 68, target_reps: 5, target_sets: 3 },
    { exercise: 'Face Pull', lift_code: 'FP01', target_weight: 45, target_reps: 5, target_sets: 3 },
  ]));

  const intent = out.intents.find(i => i.id === 'deload_reset');
  assert.equal(intent.label, ACCESSORY_RESET_LABEL);
  assert.doesNotMatch(intent.label, /deload/i);
  assert.equal(out.todays_read.recommended_label, ACCESSORY_RESET_LABEL);
  assert.doesNotMatch(out.todays_read.recommended_label, /deload/i);
  // No deload-worded rationale survives anywhere the UI/coach renders it.
  assert.doesNotMatch(rationaleText(intent), /deload/i);
  assert.doesNotMatch((out.todays_read.recommended_reason || ''), /deload/i);
});

test('curl / face pull / shrug never get 5×3', () => {
  const out = applyLiftRoleGuards(deloadResult([
    { exercise: 'Dumbbell Curl', target_weight: 27, target_reps: 5, target_sets: 3 },
    { exercise: 'Shrugs', target_weight: 68, target_reps: 5, target_sets: 3 },
    { exercise: 'Face Pull', target_weight: 45, target_reps: 5, target_sets: 3 },
  ]));
  for (const ex of out.intents.find(i => i.id === 'deload_reset').exercises) {
    assert.ok(ex.target_reps >= 10, `${ex.exercise} reps should be >= 10`);
    assert.notEqual(ex.target_reps, 5);
    assert.equal(ex.target_sets, 3); // sets unchanged
  }
});

test('a deload that includes a real main lift stays a Deload', () => {
  const out = applyLiftRoleGuards(deloadResult([
    { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 280, target_reps: 5, target_sets: 3 },
    { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 220, target_reps: 5, target_sets: 3 },
  ]));
  const intent = out.intents.find(i => i.id === 'deload_reset');
  assert.equal(intent.label, 'Deload & Reset');
  assert.equal(out.todays_read.recommended_label, 'Deload & Reset');
  // main lifts keep their 5-rep deload singles
  for (const ex of intent.exercises) assert.equal(ex.target_reps, 5);
  // a genuine deload keeps its deload rationale (rewrite only fires accessory-only)
  assert.match(rationaleText(intent), /deload/i);
});

test('a mixed deload keeps the label but still fixes the accessory reps', () => {
  const out = applyLiftRoleGuards(deloadResult([
    { exercise: 'Back Squat', target_weight: 280, target_reps: 5, target_sets: 3 },
    { exercise: 'Dumbbell Curl', target_weight: 27, target_reps: 5, target_sets: 3 },
  ]));
  const ex = out.intents.find(i => i.id === 'deload_reset').exercises;
  assert.equal(out.intents.find(i => i.id === 'deload_reset').label, 'Deload & Reset');
  assert.equal(ex.find(e => e.exercise === 'Back Squat').target_reps, 5);
  assert.ok(ex.find(e => e.exercise === 'Dumbbell Curl').target_reps >= 10);
});

test('June 13 scenario classifies as Recovery Pull / Accessory, not Deload', () => {
  // The exact bad output: stalled accessories prescribed 5×3 and labeled a deload.
  const out = applyLiftRoleGuards(deloadResult([
    { exercise: 'Dumbbell Curl', lift_code: 'DBC01', target_weight: 27, target_reps: 5, target_sets: 3 },
    { exercise: 'Shrugs', lift_code: 'SHR01', target_weight: 68, target_reps: 5, target_sets: 3 },
    { exercise: 'Face Pull', lift_code: 'FP01', target_weight: 45, target_reps: 5, target_sets: 3 },
  ]));
  assert.equal(out.todays_read.recommended_label, 'Recovery Pull / Accessory');
  assert.doesNotMatch(out.todays_read.recommended_reason, /deload/i);
  for (const ex of out.intents.find(i => i.id === 'deload_reset').exercises) {
    assert.ok(ex.target_reps >= 10);
  }
});

test('applyLiftRoleGuards is a safe no-op on non-deload and malformed results', () => {
  assert.equal(applyLiftRoleGuards(null), null);
  assert.deepEqual(applyLiftRoleGuards({ intents: 'nope' }), { intents: 'nope' });

  const build = {
    todays_read: { recommended_intent_id: 'build_strength', recommended_label: 'Build Strength', recommended_reason: 'Heavy compound work' },
    intents: [{ id: 'build_strength', label: 'Build Strength', focus: 'Heavy compound work', recommended: true,
      exercises: [{ exercise: 'Bench Press', target_weight: 235, target_reps: 5, target_sets: 3 }] }],
  };
  const out = applyLiftRoleGuards(build);
  assert.equal(out.todays_read.recommended_label, 'Build Strength');
  assert.equal(out.intents[0].exercises[0].target_reps, 5); // main 5-rep strength work untouched
});
