const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIONS, BAND_ADJUST_MIN, BAND_OFFER_MIN, BAND_RECOMMEND_MIN,
  ACTION_SUGGESTED_STATE, classify, evaluate
} = require('../services/deloadEscalationLadder');
const { STATES } = require('../services/deloadStateMachine');
const { STRENGTH_DELOAD_V1, HYPERTROPHY_DELOAD_V1 } = require('../services/deloadProtocols');

/* ===== Band boundaries match the spec's ESCALATION LADDER exactly ===== */

test('the four bands map to the spec actions', () => {
  // < 50 normal · 50-75 adjust · 75-90 offer · > 90 recommend
  assert.equal(evaluate(0).action, ACTIONS.NORMAL_COACHING);
  assert.equal(evaluate(49).action, ACTIONS.NORMAL_COACHING);
  assert.equal(evaluate(50).action, ACTIONS.WORKOUT_ADJUSTMENT);
  assert.equal(evaluate(74).action, ACTIONS.WORKOUT_ADJUSTMENT);
  assert.equal(evaluate(75).action, ACTIONS.OFFER_DELOAD);
  assert.equal(evaluate(90).action, ACTIONS.OFFER_DELOAD);
  assert.equal(evaluate(91).action, ACTIONS.RECOMMEND_DELOAD);
  assert.equal(evaluate(100).action, ACTIONS.RECOMMEND_DELOAD);
});

test('the exact boundary scores fall on the documented side', () => {
  // Lower bound inclusive; upper label included in its band; next band opens above.
  assert.equal(classify(BAND_ADJUST_MIN).action, ACTIONS.WORKOUT_ADJUSTMENT);   // 50
  assert.equal(classify(BAND_OFFER_MIN - 1).action, ACTIONS.WORKOUT_ADJUSTMENT); // 74
  assert.equal(classify(BAND_OFFER_MIN).action, ACTIONS.OFFER_DELOAD);           // 75
  assert.equal(classify(BAND_RECOMMEND_MIN).action, ACTIONS.OFFER_DELOAD);       // 90
  assert.equal(classify(BAND_RECOMMEND_MIN + 1).action, ACTIONS.RECOMMEND_DELOAD); // 91
});

/* ===== Each action points at the right training state ===== */

test('each action suggests the correct training state', () => {
  assert.equal(evaluate(10).suggested_state, STATES.NORMAL);
  assert.equal(evaluate(60).suggested_state, STATES.RECOVERY_CANDIDATE);
  assert.equal(evaluate(80).suggested_state, STATES.DELOAD_RECOMMENDED);
  assert.equal(evaluate(95).suggested_state, STATES.DELOAD_RECOMMENDED);
  // The mapping table covers every action.
  for (const action of Object.values(ACTIONS)) {
    assert.ok(ACTION_SUGGESTED_STATE[action], `${action} must map to a state`);
  }
});

/* ===== Protocol is selected only when a deload is on the table ===== */

test('a protocol is selected only for offer/recommend, by focus', () => {
  assert.equal(evaluate(30, { focus: 'strength' }).protocol, null);  // normal coaching
  assert.equal(evaluate(60, { focus: 'strength' }).protocol, null);  // adjustment
  assert.equal(evaluate(80, { focus: 'strength' }).protocol, STRENGTH_DELOAD_V1);
  assert.equal(evaluate(95, { focus: 'hypertrophy' }).protocol, HYPERTROPHY_DELOAD_V1);
});

test('offer/recommend with unknown focus still resolves to a protocol (strength default)', () => {
  assert.equal(evaluate(80).protocol, STRENGTH_DELOAD_V1);
  assert.equal(evaluate(95, { focus: 'mystery' }).protocol, STRENGTH_DELOAD_V1);
});

/* ===== Reason + band labels ===== */

test('evaluate returns the score, a band label, and a deterministic reason', () => {
  const out = evaluate(87, { focus: 'strength' });
  assert.equal(out.score, 87);
  assert.equal(out.band, '75-90');
  assert.equal(out.action, ACTIONS.OFFER_DELOAD);
  assert.match(out.reason, /Fatigue score 87 is in the 75-90 band/);
});

/* ===== Defensive input handling ===== */

test('a non-numeric score throws (a loud bug, never a silent normal)', () => {
  assert.throws(() => evaluate('80'), /must be a finite number/);
  assert.throws(() => evaluate(null), /must be a finite number/);
  assert.throws(() => evaluate(NaN), /must be a finite number/);
  assert.throws(() => evaluate(undefined), /must be a finite number/);
});

test('out-of-range numeric scores are clamped to 0-100', () => {
  const low = evaluate(-20);
  assert.equal(low.score, 0);
  assert.equal(low.action, ACTIONS.NORMAL_COACHING);

  const high = evaluate(150);
  assert.equal(high.score, 100);
  assert.equal(high.action, ACTIONS.RECOMMEND_DELOAD);
});
