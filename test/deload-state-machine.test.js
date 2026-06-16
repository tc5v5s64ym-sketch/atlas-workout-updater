const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STATES, INITIAL_STATE, TRANSITIONS,
  isState, nextStates, canTransition, transition, isActiveDeload
} = require('../services/deloadStateMachine');

/* ===== States match the spec's training-state list ===== */

test('the five training states from the spec exist', () => {
  assert.deepEqual(Object.keys(STATES).sort(), [
    'DELOAD_ACTIVE', 'DELOAD_RECOMMENDED', 'NORMAL',
    'POST_DELOAD_EVALUATION', 'RECOVERY_CANDIDATE'
  ]);
});

test('the initial/resting state is NORMAL', () => {
  assert.equal(INITIAL_STATE, STATES.NORMAL);
});

/* ===== The spec's happy-path flow is walkable end to end ===== */

test('the linear spec flow NORMAL → … → NORMAL is legal at every step', () => {
  let s = STATES.NORMAL;
  s = transition(s, STATES.RECOVERY_CANDIDATE);
  s = transition(s, STATES.DELOAD_RECOMMENDED);
  s = transition(s, STATES.DELOAD_ACTIVE);
  s = transition(s, STATES.POST_DELOAD_EVALUATION);
  s = transition(s, STATES.NORMAL);
  assert.equal(s, STATES.NORMAL);
});

/* ===== Owner-invoked + de-escalation edges ===== */

test('owner can invoke a deload directly from NORMAL or RECOVERY_CANDIDATE', () => {
  assert.ok(canTransition(STATES.NORMAL, STATES.DELOAD_ACTIVE));
  assert.ok(canTransition(STATES.RECOVERY_CANDIDATE, STATES.DELOAD_ACTIVE));
});

test('fatigue resolving de-escalates RECOVERY_CANDIDATE back to NORMAL', () => {
  assert.ok(canTransition(STATES.RECOVERY_CANDIDATE, STATES.NORMAL));
});

test('a declined recommendation can fall back to RECOVERY_CANDIDATE or NORMAL', () => {
  assert.ok(canTransition(STATES.DELOAD_RECOMMENDED, STATES.RECOVERY_CANDIDATE));
  assert.ok(canTransition(STATES.DELOAD_RECOMMENDED, STATES.NORMAL));
  assert.ok(canTransition(STATES.DELOAD_RECOMMENDED, STATES.DELOAD_ACTIVE));
});

/* ===== Hard guards the spec demands ===== */

test('DELOAD_ACTIVE only exits to POST_DELOAD_EVALUATION — a deload runs to completion', () => {
  assert.deepEqual(nextStates(STATES.DELOAD_ACTIVE), [STATES.POST_DELOAD_EVALUATION]);
  assert.equal(canTransition(STATES.DELOAD_ACTIVE, STATES.NORMAL), false);
  assert.equal(canTransition(STATES.DELOAD_ACTIVE, STATES.DELOAD_RECOMMENDED), false);
  assert.equal(canTransition(STATES.DELOAD_ACTIVE, STATES.RECOVERY_CANDIDATE), false);
});

test('POST_DELOAD_EVALUATION returns only to NORMAL — never straight into another deload', () => {
  // The spec: if not rebounded, "do not immediately trigger another deload."
  assert.deepEqual(nextStates(STATES.POST_DELOAD_EVALUATION), [STATES.NORMAL]);
  assert.equal(canTransition(STATES.POST_DELOAD_EVALUATION, STATES.DELOAD_ACTIVE), false);
  assert.equal(canTransition(STATES.POST_DELOAD_EVALUATION, STATES.DELOAD_RECOMMENDED), false);
  assert.equal(canTransition(STATES.POST_DELOAD_EVALUATION, STATES.RECOVERY_CANDIDATE), false);
});

test('self-transitions are not legal edges', () => {
  for (const s of Object.values(STATES)) {
    assert.equal(canTransition(s, s), false, `${s} → ${s} must be illegal`);
  }
});

/* ===== transition() throws loudly on illegal / unknown moves ===== */

test('transition throws on an illegal move with a clear message', () => {
  assert.throws(
    () => transition(STATES.DELOAD_ACTIVE, STATES.NORMAL),
    /Illegal training-state transition: DELOAD_ACTIVE → NORMAL/
  );
});

test('transition throws on unknown from/to states', () => {
  assert.throws(() => transition('SLEEPING', STATES.NORMAL), /Unknown current training state/);
  assert.throws(() => transition(STATES.NORMAL, 'SLEEPING'), /Unknown target training state/);
  assert.throws(() => transition(null, STATES.NORMAL), /Unknown current training state/);
});

test('a legal transition returns the target state', () => {
  assert.equal(transition(STATES.NORMAL, STATES.DELOAD_ACTIVE), STATES.DELOAD_ACTIVE);
});

/* ===== isState / nextStates / isActiveDeload ===== */

test('isState recognizes only the five real states', () => {
  for (const s of Object.values(STATES)) assert.ok(isState(s));
  assert.equal(isState('SLEEPING'), false);
  assert.equal(isState(''), false);
  assert.equal(isState(null), false);
  assert.equal(isState(undefined), false);
});

test('nextStates returns a fresh array that cannot mutate the transition table', () => {
  const arr = nextStates(STATES.NORMAL);
  arr.push('SLEEPING');
  assert.equal(nextStates(STATES.NORMAL).includes('SLEEPING'), false);
  assert.deepEqual(nextStates('SLEEPING'), []); // unknown state → no moves
});

test('the transition table is frozen', () => {
  assert.ok(Object.isFrozen(TRANSITIONS));
  assert.ok(Object.isFrozen(TRANSITIONS[STATES.NORMAL]));
});

test('isActiveDeload is true only for DELOAD_ACTIVE', () => {
  assert.ok(isActiveDeload(STATES.DELOAD_ACTIVE));
  assert.equal(isActiveDeload(STATES.DELOAD_RECOMMENDED), false);
  assert.equal(isActiveDeload(STATES.NORMAL), false);
});
