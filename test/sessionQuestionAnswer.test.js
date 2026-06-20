'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSessionQuestionAnswer, attributesAsked, resolveLiftName } = require('../services/sessionQuestionAnswer');

// Engine target stub — stands in for recommendNextSet-derived numbers.
const benchTarget = { exercise_name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: 2 };
const resolveBench = (name) => (/bench/i.test(name) ? benchTarget : null);

test('attributesAsked detects each shorthand and combinations', () => {
  assert.deepEqual(attributesAsked('RIR?'), ['rir']);
  assert.deepEqual(attributesAsked('reps?'), ['reps']);
  assert.deepEqual(attributesAsked('sets?'), ['sets']);
  assert.deepEqual(attributesAsked('how much?'), ['weight']);
  assert.deepEqual(attributesAsked('how many reps and rir should I do?').sort(), ['reps', 'rir']);
  assert.deepEqual(attributesAsked('hey coach'), []);
});

test('answers a multi-attribute question from the lift named in the message', () => {
  const ans = buildSessionQuestionAnswer('Going to do bench 225 how many reps and rir should I do?', {
    resolveTarget: resolveBench
  });
  assert.equal(ans, 'Bench Press: 5 reps, RIR 2.');
});

test('answers "how much?" with the engine weight when the lift is in recent history', () => {
  const ans = buildSessionQuestionAnswer('how much?', {
    history: [{ role: 'user', text: 'Going to do bench next' }],
    resolveTarget: resolveBench
  });
  assert.equal(ans, 'Bench Press: 230 lbs.');
});

test('resolves the lift from the client preview/plan and prefers its target (no Sheets)', () => {
  const ans = buildSessionQuestionAnswer('RIR?', {
    clientContext: { current_plan: [{ name: 'Overhead Press', weight: 116, reps: 10, sets: 3, rir: 2 }] },
    resolveTarget: () => { throw new Error('should not be called — context target wins'); }
  });
  assert.equal(ans, 'Overhead Press: RIR 2.');
});

test('returns null when no session attribute is asked (defers to caller fallback)', () => {
  assert.equal(buildSessionQuestionAnswer('what should we do about my deadlift form', { resolveTarget: resolveBench }), null);
});

test('returns null when the lift cannot be resolved', () => {
  assert.equal(buildSessionQuestionAnswer('RIR?', { resolveTarget: resolveBench }), null);
});

test('returns null when no target is available for the resolved lift', () => {
  const ans = buildSessionQuestionAnswer('bench rir?', { resolveTarget: () => null });
  assert.equal(ans, null);
});

test('only includes asked attributes that the engine actually knows', () => {
  // Asks reps + rir, but the target has no rir → only reps is reported.
  const ans = buildSessionQuestionAnswer('bench reps and rir?', {
    resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: null })
  });
  assert.equal(ans, 'Bench Press: 5 reps.');
});

test('resolveLiftName prefers the message over history over context', () => {
  assert.equal(
    resolveLiftName('do bench now', [{ text: 'earlier we did squat' }], { current_plan: [{ name: 'Deadlift' }] }),
    'Bench Press'
  );
  assert.equal(
    resolveLiftName('RIR?', [{ text: 'going with rdl today' }], { current_plan: [{ name: 'Deadlift' }] }),
    'RDL'
  );
});
