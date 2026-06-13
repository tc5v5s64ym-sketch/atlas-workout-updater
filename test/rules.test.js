'use strict';

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

/* ===== NEW: every BOUNDS boundary value + e1RM jump cap ===== */

test('validateLogRowBounds accepts exact BOUNDS boundaries (min/max pass)', () => {
  // weight
  assert.deepEqual(validateLogRowBounds({ weight: 0, reps: 5, rir: 2 }), []);
  assert.deepEqual(validateLogRowBounds({ weight: 1500, reps: 5, rir: 2 }), []);
  // reps
  assert.deepEqual(validateLogRowBounds({ weight: 100, reps: 1, rir: 2 }), []);
  assert.deepEqual(validateLogRowBounds({ weight: 100, reps: 100, rir: 2 }), []);
  // rir
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

test('checkE1rmJump flags exactly at E1RM_JUMP_MAX_PCT cap and above', () => {
  // exactly 15% should flag ( > threshold )
  const atCap = checkE1rmJump(287.5, 250); // 15% exactly
  assert.ok(atCap);
  assert.match(atCap.warning, /jumped 15\.0%/);
  // just over
  const over = checkE1rmJump(288, 250);
  assert.ok(over);
  // just under — no flag
  const under = checkE1rmJump(287, 250); // ~14.8%
  assert.equal(under, null);
});

/* ===== safetyRules triggers across history window (expanded) ===== */

test('rirDrift works across full window=3 history and flags only on decline', () => {
  const history = [
    { session_id: 'S1', date_clean: '2026-06-01', lift_code: 'BP01', weight: 205, reps: 6, rir: 3 },
    { session_id: 'S2', date_clean: '2026-06-04', lift_code: 'BP01', weight: 205, reps: 6, rir: 2 },
    { session_id: 'S3', date_clean: '2026-06-08', lift_code: 'BP01', weight: 205, reps: 5, rir: 1 },
    { session_id: 'S4', date_clean: '2026-06-10', lift_code: 'BP01', weight: 205, reps: 6, rir: 0 },
  ];
  const flag = rirDrift(history, 'BP01', { window: 3 });
  assert.ok(flag);
  assert.equal(flag.rule_id, 'rir_drift');
  assert.match(flag.reasoning, /2\.0 → 1\.0|1\.0 → 0\.0/);
});

test('safety rules degrade safely on empty array / null / malformed rows (no throw)', () => {
  assert.equal(rirCaution(null), null);
  assert.equal(rirCaution([]), null);
  assert.equal(junkRepGuard('not-an-array'), null);
  assert.equal(painFlag(undefined), null);
  assert.deepEqual(evaluateSessionSafety(null), []);
  assert.deepEqual(evaluateSessionSafety([]), []);
  // non-object rows ignored gracefully
  const flags = evaluateSessionSafety([null, 'bad', { weight: 100, reps: 5, rir: 2 }]);
  assert.deepEqual(flags, []);
});

/* ===== progressionRules.holdUntilClean state transitions (clean count progression) ===== */

test('holdUntilClean progresses clean count across sessions (0 → 3 triggers load)', () => {
  const cleanSet = [[205, 6, 2], [205, 6, 2], [205, 6, 2]];
  // session 1: not clean
  let history = bpSession('S1', '2026-06-01', [[205, 5, 1]]);
  let d = holdUntilClean(history, 'BP01');
  assert.equal(d.decision, 'hold');
  assert.match(d.criterion_progress, /0 of 3/);

  // add clean session 2
  history = history.concat(bpSession('S2', '2026-06-04', cleanSet));
  d = holdUntilClean(history, 'BP01');
  assert.equal(d.decision, 'hold');
  assert.match(d.criterion_progress, /1 of 3/);

  // add clean session 3 → load
  history = history.concat(bpSession('S3', '2026-06-08', cleanSet));
  d = holdUntilClean(history, 'BP01');
  assert.equal(d.decision, 'load');
  assert.match(d.reasoning, /Load to 210/);
});

test('holdUntilClean degrades safely on malformed history input (no throw)', () => {
  const d1 = holdUntilClean(null, 'BP01');
  assert.equal(d1.decision, 'no_data');
  const d2 = holdUntilClean('bad-string', 'BP01');
  assert.equal(d2.decision, 'no_data');
  const d3 = holdUntilClean([{ weight: 'NaN', reps: 'foo' }], 'BP01');
  assert.equal(d3.decision, 'no_data');
});

/* ===== evaluateSessionSafety end-to-end representative session ===== */

test('evaluateSessionSafety end-to-end on representative bench session (with notes)', () => {
  const repSession = [
    { session_id: 'S-2025-10-04', lift_code: 'BEN01', canonical_exercise: 'Bench Press', weight: 165, reps: 8, rir: 2, notes: '' },
    { session_id: 'S-2025-10-04', lift_code: 'BEN01', canonical_exercise: 'Bench Press', weight: 165, reps: 8, rir: 1, notes: 'shoulder felt tight' },
    { session_id: 'S-2025-10-04', lift_code: 'BEN01', canonical_exercise: 'Bench Press', weight: 165, reps: 6, rir: 0, notes: '' },
  ];
  const flags = evaluateSessionSafety(repSession, 'Good session overall but shoulder note');
  const ids = flags.map(f => f.rule_id).sort();
  assert.ok(ids.includes('rir_caution'));
  assert.ok(ids.includes('junk_rep_guard'));
  assert.ok(ids.includes('pain_flag'));
  // representative from Log data style
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