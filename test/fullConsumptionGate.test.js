'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyFullConsumptionGate } = require('../services/fullConsumptionGate');

// A fabricated single-set parse result (as the parser would hand back), so these
// unit tests exercise the gate in isolation from the grammar.
function logSets(sets, extra = {}) {
  return { intent: 'log_sets', raw_text: 'x', exercise: 'Bench Press', canonical_name: 'Bench Press', sets, warnings: [], ...extra };
}

// --- PARSE-4: mixed set-notation families refuse-and-ask ---------------------

test('PARSE-4: mixing slash + NxM@ downgrades to needs_clarification (no partial rows)', () => {
  const parsed = logSets([{ weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }]);
  const out = applyFullConsumptionGate(parsed, 'bench 185 5/2 3x8@165');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('mixed_set_format'));
  assert.equal(out.sets, undefined, 'no partial set list survives the refusal');
  assert.match(out.message, /more than one set format/i);
});

test('PARSE-4: mixing NxM@ + "N for M" downgrades', () => {
  const out = applyFullConsumptionGate(logSets([{ weight: 165, reps: 8, rir: null }]), 'bench 3x8@165 then 175 for 5');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('mixed_set_format'));
});

test('PARSE-4: mixing dumbbell slash + xN@ downgrades', () => {
  const out = applyFullConsumptionGate(logSets([{ weight: 60, reps: 10, rir: 3 }]), 'incline db press 60s 10/3 55s x8 @2');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('mixed_set_format'));
});

// --- PARSE-5: ambiguous small "@N" barbell weight refuses -------------------

test('PARSE-5: a barbell "@N" with N<=10 that was emitted as the weight asks', () => {
  const parsed = logSets([{ weight: 2, reps: 10, rir: null }, { weight: 2, reps: 10, rir: null }, { weight: 2, reps: 10, rir: null }]);
  const out = applyFullConsumptionGate(parsed, 'bench 3x10 @2');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('ambiguous_at_value'));
  assert.equal(out.sets, undefined);
  assert.match(out.message, /weight.*or.*RIR|RIR/i);
});

test('PARSE-5: boundary — @10 asks, @11 does not', () => {
  const at10 = applyFullConsumptionGate(logSets([{ weight: 10, reps: 5, rir: null }]), 'bench 3x5 @10');
  assert.equal(at10.intent, 'needs_clarification');
  const at11 = applyFullConsumptionGate(logSets([{ weight: 11, reps: 5, rir: null }]), 'bench 3x5 @11');
  assert.equal(at11.intent, 'log_sets');
});

test('PARSE-5: precision — only fires when the parser actually emitted that tiny weight', () => {
  // Same raw text, but the parser emitted a real weight (not 2) — do not flag as
  // ambiguous-@; and it is single-notation, so PARSE-4 does not fire either.
  const out = applyFullConsumptionGate(logSets([{ weight: 165, reps: 10, rir: null }]), 'bench 3x10 @2');
  assert.equal(out.intent, 'log_sets');
});

// --- No over-rejection of valid terse notation ------------------------------

test('valid: the 225 5/2 slash contract and repeated slash sets pass untouched', () => {
  const single = logSets([{ weight: 225, reps: 5, rir: 2 }]);
  assert.equal(applyFullConsumptionGate(single, 'bench 225 5/2').intent, 'log_sets');
  const multiSlash = logSets([{ weight: 225, reps: 5, rir: 2 }, { weight: 185, reps: 8, rir: 2 }]);
  const out = applyFullConsumptionGate(multiSlash, 'squat 225 5/2 185 8/2');
  assert.equal(out.intent, 'log_sets');
  assert.deepEqual(out, multiSlash, 'the parsed object is returned unchanged');
});

test('valid: single-family NxM@W (W>10) and dumbbell @RIR pass untouched', () => {
  assert.equal(applyFullConsumptionGate(logSets([{ weight: 205, reps: 5, rir: null }]), 'bench 3x5 @205').intent, 'log_sets');
  assert.equal(applyFullConsumptionGate(logSets([{ weight: 55, reps: 10, rir: 3 }]), 'incline db press 55s x10 @3').intent, 'log_sets');
  assert.equal(applyFullConsumptionGate(logSets([{ weight: 165, reps: 8, rir: null }]), 'bench 3x8@165').intent, 'log_sets');
});

// --- Robustness -------------------------------------------------------------

test('gate is a no-op for non-log_sets intents and garbage input', () => {
  const clar = { intent: 'needs_clarification', warnings: ['missing_sets'] };
  assert.equal(applyFullConsumptionGate(clar, 'bench 185 5/2 3x8@165'), clar);
  const multi = { intent: 'log_sets_multi', exercises: [] };
  assert.equal(applyFullConsumptionGate(multi, 'bench 185 5/2 3x8@165'), multi);
  assert.equal(applyFullConsumptionGate(null, 'x'), null);
  assert.equal(applyFullConsumptionGate(logSets([{ weight: 225, reps: 5, rir: 2 }]), '').intent, 'log_sets');
});
