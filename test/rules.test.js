const test = require('node:test');
const assert = require('node:assert/strict');

const { decision, DECISION_TYPES, SEVERITY_TYPES } = require('../rules/ruleTypes');
const {
  validateLogRowBounds, validateLogRowsBounds, checkBound, checkE1rmJump, BOUNDS
} = require('../rules/validationRules');
const {
  rirCaution, junkRepGuard, painFlag, rirDrift, evaluateSessionSafety, groupBySession
} = require('../rules/safetyRules');
const { holdUntilClean, isLowerBodyGroup } = require('../rules/progressionRules');

/* ===== ruleTypes ===== */

test('decision enforces the frozen shape', () => {
  const d = decision({ decision: 'hold', rule_id: 'test_rule', reasoning: 'because' });
  assert.deepEqual(Object.keys(d).sort(), ['criterion_progress', 'decision', 'lift_code', 'reasoning', 'rule_id', 'severity'].sort());
  assert.equal(d.severity, 'info');
});

test('decision rejects invalid decision types and missing fields', () => {
  assert.throws(() => decision({ decision: 'yolo', rule_id: 'x', reasoning: 'y' }), /Invalid decision type/);
  assert.throws(() => decision({ decision: 'hold', reasoning: 'y' }), /rule_id is required/);
  assert.throws(() => decision({ decision: 'hold', rule_id: 'x' }), /reasoning is required/);
  assert.throws(() => decision({ decision: 'hold', rule_id: 'x', reasoning: 'y', severity: 'fatal' }), /Invalid severity/);
});

test('decision type and severity vocabularies are frozen', () => {
  assert.ok(DECISION_TYPES.includes('hold'));
  assert.ok(DECISION_TYPES.includes('load'));
  assert.ok(DECISION_TYPES.includes('caution'));
  assert.ok(SEVERITY_TYPES.includes('warning'));
  assert.ok(Object.isFrozen(DECISION_TYPES));
  assert.ok(Object.isFrozen(SEVERITY_TYPES));
});

/* ===== validationRules: bounds ===== */

test('validateLogRowBounds accepts plausible sets', () => {
  assert.deepEqual(validateLogRowBounds({ weight: 225, reps: 5, rir: 2 }), []);
  assert.deepEqual(validateLogRowBounds({ weight: 0, reps: 20, rir: null }), []); // bodyweight
  assert.deepEqual(validateLogRowBounds({ weight: 45, reps: 12 }), []);           // no rir is fine
});

test('validateLogRowBounds rejects the 2250-lb typo', () => {
  const errors = validateLogRowBounds({ weight: 2250, reps: 5, rir: 2 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, 'weight');
  assert.match(errors[0].error, /0–1500/);
});

test('validateLogRowBounds rejects impossible reps and rir', () => {
  assert.equal(validateLogRowBounds({ weight: 100, reps: 500 })[0].field, 'reps');
  assert.equal(validateLogRowBounds({ weight: 100, reps: 5, rir: 50 })[0].field, 'rir');
  assert.equal(validateLogRowBounds({ weight: -10, reps: 5 })[0].field, 'weight');
  assert.equal(validateLogRowBounds({ weight: 100, reps: 0 })[0].field, 'reps');
});

test('validateLogRowBounds rejects non-numeric garbage', () => {
  const errors = validateLogRowBounds({ weight: 'heavy', reps: 5 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /must be a number/);
});

test('validateLogRowsBounds reports row indices for a batch', () => {
  const errors = validateLogRowsBounds([
    { weight: 100, reps: 5 },
    { weight: 9999, reps: 5 },
    { weight: 100, reps: 200 },
  ]);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].row_index, 1);
  assert.equal(errors[1].row_index, 2);
});

test('bounds constants stay sane', () => {
  assert.equal(BOUNDS.weight.max, 1500);
  assert.equal(BOUNDS.reps.max, 100);
  assert.equal(BOUNDS.rir.max, 10);
});

/* ===== validationRules: e1RM jump guard ===== */

test('checkE1rmJump flags a >15% jump', () => {
  const warning = checkE1rmJump(300, 250); // 20% jump
  assert.ok(warning);
  assert.match(warning.warning, /jumped 20\.0%/);
});

test('checkE1rmJump allows normal progress and missing baselines', () => {
  assert.equal(checkE1rmJump(260, 250), null);  // 4% — fine
  assert.equal(checkE1rmJump(300, null), null); // no baseline
  assert.equal(checkE1rmJump(300, 0), null);
});

/* ===== safetyRules ===== */

const grindRows = [
  { session_id: 'S1', lift_code: 'BP01', canonical_exercise: 'Bench Press', weight: 205, reps: 6, rir: 1, notes: '' },
  { session_id: 'S1', lift_code: 'BP01', canonical_exercise: 'Bench Press', weight: 205, reps: 5, rir: 0, notes: '' },
  { session_id: 'S1', lift_code: 'SQ01', canonical_exercise: 'Back Squat', weight: 225, reps: 5, rir: 3, notes: '' },
];

test('rirCaution flags grinding sets and names the lifts', () => {
  const flag = rirCaution(grindRows);
  assert.ok(flag);
  assert.equal(flag.rule_id, 'rir_caution');
  assert.equal(flag.severity, 'warning');
  assert.match(flag.reasoning, /2 set\(s\) at RIR ≤ 1/);
  assert.match(flag.reasoning, /Bench Press/);
  assert.ok(!flag.reasoning.includes('Back Squat'));
});

test('rirCaution returns null when all sets have headroom', () => {
  assert.equal(rirCaution([{ weight: 100, reps: 5, rir: 3 }, { weight: 100, reps: 5, rir: 2 }]), null);
  assert.equal(rirCaution([{ weight: 100, reps: 5, rir: null }]), null); // missing RIR is not a grind
});

test('junkRepGuard flags only RIR 0 sets', () => {
  const flag = junkRepGuard(grindRows);
  assert.ok(flag);
  assert.equal(flag.rule_id, 'junk_rep_guard');
  assert.match(flag.reasoning, /1 set\(s\) at RIR 0/);
  assert.equal(junkRepGuard([{ weight: 100, reps: 5, rir: 1 }]), null);
});

test('painFlag detects pain words in set notes and workout notes', () => {
  const flag = painFlag([{ notes: 'left shoulder pinching on warmups' }]);
  assert.ok(flag);
  assert.equal(flag.rule_id, 'pain_flag');
  assert.equal(flag.severity, 'error');

  const topLevel = painFlag([{ notes: '' }], 'lower back tweaked on last deadlift');
  assert.ok(topLevel);

  assert.equal(painFlag([{ notes: 'felt strong today' }], 'great session'), null);
});

test('painFlag does not fire on innocuous words', () => {
  assert.equal(painFlag([{ notes: 'no pain at all... just kidding, none' }]) === null, false); // "pain" present → flags (conservative)
  assert.equal(painFlag([{ notes: 'paused reps' }]), null);
  assert.equal(painFlag([{ notes: 'sprained nothing, strict form' }]), null);
});

test('groupBySession orders sessions oldest first', () => {
  const rows = [
    { session_id: 'B', date_clean: '2026-06-10', weight: 1 },
    { session_id: 'A', date_clean: '2026-06-01', weight: 2 },
    { session_id: 'B', date_clean: '2026-06-10', weight: 3 },
  ];
  const sessions = groupBySession(rows);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].session_id, 'A');
  assert.equal(sessions[1].rows.length, 2);
});

test('rirDrift flags declining RIR at the modal weight', () => {
  const history = [
    { session_id: 'S1', date_clean: '2026-06-01', lift_code: 'BP01', weight: 205, reps: 6, rir: 2 },
    { session_id: 'S2', date_clean: '2026-06-04', lift_code: 'BP01', weight: 205, reps: 6, rir: 1 },
    { session_id: 'S3', date_clean: '2026-06-08', lift_code: 'BP01', weight: 205, reps: 5, rir: 1 },
  ];
  const flag = rirDrift(history, 'BP01');
  assert.ok(flag);
  assert.equal(flag.rule_id, 'rir_drift');
  assert.match(flag.reasoning, /2\.0 → 1\.0/);
});

test('rirDrift stays quiet on stable or improving RIR and thin data', () => {
  const stable = [
    { session_id: 'S1', date_clean: '2026-06-01', lift_code: 'BP01', weight: 205, reps: 6, rir: 2 },
    { session_id: 'S2', date_clean: '2026-06-04', lift_code: 'BP01', weight: 205, reps: 6, rir: 2 },
  ];
  assert.equal(rirDrift(stable, 'BP01'), null);
  assert.equal(rirDrift([], 'BP01'), null);
  assert.equal(rirDrift(stable.slice(0, 1), 'BP01'), null);
});

test('evaluateSessionSafety composes all per-session flags', () => {
  const flags = evaluateSessionSafety(
    [
      { weight: 205, reps: 6, rir: 0, notes: '' },
      { weight: 225, reps: 5, rir: 1, notes: 'elbow ache on lockout' },
    ],
    ''
  );
  const ids = flags.map(f => f.rule_id).sort();
  assert.deepEqual(ids, ['junk_rep_guard', 'pain_flag', 'rir_caution']);
});

test('evaluateSessionSafety returns empty for a clean session', () => {
  const flags = evaluateSessionSafety(
    [{ weight: 205, reps: 6, rir: 2, notes: 'smooth' }],
    'good day'
  );
  assert.deepEqual(flags, []);
});

/* ===== progressionRules: holdUntilClean ===== */

function bpSession(sessionId, date, sets) {
  return sets.map(([weight, reps, rir]) => ({
    session_id: sessionId, date_clean: date, lift_code: 'BP01',
    muscle_group: 'Chest', weight, reps, rir, notes: ''
  }));
}

test('holdUntilClean returns no_data without history', () => {
  const d = holdUntilClean([], 'BP01');
  assert.equal(d.decision, 'no_data');
  assert.equal(d.rule_id, 'hold_until_clean');
});

test('holdUntilClean holds while the clean-session standard is unmet', () => {
  const history = [
    ...bpSession('S1', '2026-06-01', [[205, 6, 2], [205, 5, 1], [205, 5, 1]]), // not clean: reps + rir
    ...bpSession('S2', '2026-06-04', [[205, 6, 2], [205, 6, 2], [205, 6, 2]]), // clean
    ...bpSession('S3', '2026-06-08', [[205, 6, 2], [205, 6, 1], [205, 6, 2]]), // not clean: one RIR 1
  ];
  const d = holdUntilClean(history, 'BP01');
  assert.equal(d.decision, 'hold');
  assert.equal(d.criterion_progress, '1 of 3 clean sessions at 205');
  assert.match(d.reasoning, /Hold 205/);
});

test('holdUntilClean loads after three clean sessions with upper-body increment', () => {
  const clean = [[205, 6, 2], [205, 6, 2], [205, 6, 3]];
  const history = [
    ...bpSession('S1', '2026-06-01', clean),
    ...bpSession('S2', '2026-06-04', clean),
    ...bpSession('S3', '2026-06-08', clean),
  ];
  const d = holdUntilClean(history, 'BP01');
  assert.equal(d.decision, 'load');
  assert.match(d.reasoning, /Load to 210/);
});

test('holdUntilClean uses the 10 lb increment for lower body', () => {
  const rows = [[225, 6, 2], [225, 6, 2], [225, 6, 2]];
  const history = ['S1', 'S2', 'S3'].flatMap((id, i) =>
    rows.map(([weight, reps, rir]) => ({
      session_id: id, date_clean: `2026-06-0${i + 1}`, lift_code: 'SQ01',
      muscle_group: 'Legs', weight, reps, rir, notes: ''
    }))
  );
  const d = holdUntilClean(history, 'SQ01');
  assert.equal(d.decision, 'load');
  assert.match(d.reasoning, /Load to 235/);
});

test('holdUntilClean counts rep-only sessions when RIR is unrecorded', () => {
  const history = [
    ...bpSession('S1', '2026-06-01', [[205, 6, null], [205, 6, null]]),
    ...bpSession('S2', '2026-06-04', [[205, 6, null], [205, 6, null]]),
    ...bpSession('S3', '2026-06-08', [[205, 7, null], [205, 6, null]]),
  ];
  const d = holdUntilClean(history, 'BP01');
  assert.equal(d.decision, 'load');
});

test('holdUntilClean evaluates the most recent load, not old weights', () => {
  const history = [
    ...bpSession('S1', '2026-05-01', [[185, 6, 2], [185, 6, 2]]), // old load — clean but irrelevant
    ...bpSession('S2', '2026-06-01', [[205, 5, 1], [205, 5, 1]]), // current load, not clean
  ];
  const d = holdUntilClean(history, 'BP01');
  assert.equal(d.decision, 'hold');
  assert.match(d.criterion_progress, /0 of 3 clean sessions at 205/);
});

test('holdUntilClean respects custom config (Dale numbers as config, not code)', () => {
  const history = [
    ...bpSession('S1', '2026-06-01', [[205, 8, 3], [205, 8, 3]]),
  ];
  const d = holdUntilClean(history, 'BP01', { target_reps: 8, min_rir: 3, required_sessions: 1 });
  assert.equal(d.decision, 'load');
});

test('isLowerBodyGroup classifies muscle groups', () => {
  assert.ok(isLowerBodyGroup('Legs'));
  assert.ok(isLowerBodyGroup('Hamstrings'));
  assert.ok(isLowerBodyGroup('Glutes'));
  assert.ok(!isLowerBodyGroup('Chest'));
  assert.ok(!isLowerBodyGroup('Back'));
  assert.ok(!isLowerBodyGroup(''));
});

/* ===== NEW COVERAGE: BOUNDS boundaries, e1RM cap, safety triggers, holdUntilClean transitions, e2e safety, malformed guards ===== */

 test('validateLogRowBounds accepts exact BOUNDS boundaries (min/max pass)', () => {
  assert.deepEqual(validateLogRowBounds({ weight: 0, reps: 5, rir: 2 }), []);
  assert.deepEqual(validateLogRowBounds({ weight: 1500, reps: 5, rir: 2 }), []);
  assert.deepEqual(validateLogRowBounds({ weight: 100, reps: 1, rir: 2 }), []);
  assert.deepEqual(validateLogRowBounds({ weight: 100, reps: 100, rir: 2 }), []);
  assert.deepEqual(validateLogRowBounds({ weight: 100, reps: 5, rir: 0 }), []);
  assert.deepEqual(validateLogRowBounds({ weight: 100, reps: 5, rir: 10 }), []);
});

 test('validateLogRowBounds rejects just outside BOUNDS boundaries', () => {
  assert.equal(validateLogRowBounds({ weight: -0.1, reps: 5 })[0].field, 'weight');
  assert.equal(validateLogRowBounds({ weight: 1500.1, reps: 5 })[0].field, 'weight');
  assert.equal(validateLogRowBounds({ weight: 100, reps: 0 })[0].field, 'reps');
  assert.equal(validateLogRowBounds({ weight: 100, reps: 101 })[0].field, 'reps');
  assert.equal(validateLogRowBounds({ weight: 100, reps: 5, rir: -0.1 })[0].field, 'rir');
  assert.equal(validateLogRowBounds({ weight: 100, reps: 5, rir: 10.1 })[0].field, 'rir');
});

 test('checkE1rmJump flags > E1RM_JUMP_MAX_PCT (strict) and allows <= cap', () => {
  const over = checkE1rmJump(288, 250); // >15%
  assert.ok(over);
  assert.match(over.warning, /jumped 15\.[0-9]%/);
  const atCap = checkE1rmJump(287.5, 250); // exactly 15% — not > so no flag (per current rule)
  assert.equal(atCap, null);
  const under = checkE1rmJump(287, 250);
  assert.equal(under, null);
});

 test('rirDrift + safety rules across history window + degrade on malformed (no throw)', () => {
  const history = [
    { session_id: 'S1', date_clean: '2026-06-01', lift_code: 'BP01', weight: 205, reps: 6, rir: 3 },
    { session_id: 'S2', date_clean: '2026-06-04', lift_code: 'BP01', weight: 205, reps: 6, rir: 2 },
    { session_id: 'S3', date_clean: '2026-06-08', lift_code: 'BP01', weight: 205, reps: 5, rir: 1 },
  ];
  const flag = rirDrift(history, 'BP01', { window: 3 });
  assert.ok(flag);
  assert.equal(flag.rule_id, 'rir_drift');
  // malformed degrade
  assert.equal(rirCaution(null), null);
  assert.deepEqual(evaluateSessionSafety([]), []);
  assert.deepEqual(evaluateSessionSafety([null, { weight: 'bad' }]), []);
});

 test('holdUntilClean clean-count state progression (builds to load) + safe degrade', () => {
  const clean = [[205, 6, 2], [205, 6, 2], [205, 6, 2]];
  // S1 establishes the 205 load but is not clean (5 reps @ RIR 1).
  let h = bpSession('S1', '2026-06-01', [[205, 5, 1]]);
  let d = holdUntilClean(h, 'BP01');
  assert.equal(d.decision, 'hold');
  // required_sessions is 3 -> need three clean sessions at the load before loading.
  h = h.concat(bpSession('S2', '2026-06-04', clean));
  d = holdUntilClean(h, 'BP01');
  assert.equal(d.decision, 'hold');
  assert.match(d.criterion_progress, /1 of 3/);
  h = h.concat(bpSession('S3', '2026-06-08', clean));
  d = holdUntilClean(h, 'BP01');
  assert.equal(d.decision, 'hold');
  assert.match(d.criterion_progress, /2 of 3/);
  h = h.concat(bpSession('S4', '2026-06-11', clean));
  d = holdUntilClean(h, 'BP01');
  assert.equal(d.decision, 'load');
  // degrade
  assert.equal(holdUntilClean(null, 'BP01').decision, 'no_data');
  assert.equal(holdUntilClean([{bad: true}], 'BP01').decision, 'no_data');
});

 test('evaluateSessionSafety end-to-end representative (Log-style bench + notes)', () => {
  const rep = [
    { session_id: 'S-2025-10-04', lift_code: 'BEN01', canonical_exercise: 'Bench Press', weight: 165, reps: 8, rir: 2, notes: '' },
    { session_id: 'S-2025-10-04', lift_code: 'BEN01', canonical_exercise: 'Bench Press', weight: 165, reps: 8, rir: 1, notes: 'shoulder pain' },
    { session_id: 'S-2025-10-04', lift_code: 'BEN01', canonical_exercise: 'Bench Press', weight: 165, reps: 6, rir: 0, notes: '' },
  ];
  const flags = evaluateSessionSafety(rep, 'shoulder note');
  const ids = flags.map(f => f.rule_id);
  assert.ok(ids.includes('rir_caution'));
  assert.ok(ids.includes('junk_rep_guard'));
  assert.ok(ids.includes('pain_flag'));
});

/* ===== wiring: rules engine is connected to the write path ===== */

const fsRules = require('node:fs');
const pathRules = require('node:path');
const indexSource = fsRules.readFileSync(pathRules.resolve(__dirname, '..', 'index.js'), 'utf8');
const appSourceRules = fsRules.readFileSync(pathRules.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');

test('write path enforces set bounds before any sheet write', () => {
  assert.match(indexSource, /require\('\.\/rules\/validationRules'\)/);
  assert.match(indexSource, /validateLogRowsBounds\(normalizedForBounds\)/);
  assert.match(indexSource, /Implausible set values rejected/);
});

test('previews carry rule_flags from the safety rules', () => {
  assert.match(indexSource, /require\('\.\/rules\/safetyRules'\)/);
  assert.match(indexSource, /evaluateSessionSafety\(/);
  assert.match(indexSource, /previewBody\.rule_flags = ruleFlags/);
  assert.match(indexSource, /responseBody\.data\.rule_flags = completeRuleFlags/);
});

test('recommendation endpoint includes the hold_until_clean decision', () => {
  assert.match(indexSource, /require\('\.\/rules\/progressionRules'\)/);
  assert.match(indexSource, /recommendation\.rule_decision = holdUntilClean\(/);
});

test('app preview renders coach rule flags', () => {
  assert.match(appSourceRules, /function renderRuleFlags/);
  assert.match(appSourceRules, /renderRuleFlags\(data\.rule_flags\)/);
  assert.match(appSourceRules, /Coach flags:/);
});