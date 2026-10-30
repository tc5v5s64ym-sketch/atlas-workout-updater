'use strict';

// #1625 — deterministic VALUE-correction classifier.
//
// The live failure (persona run persona-marcus-20261030T002629-B6D931, Soul
// Corpus Session 6): Marcus logged "Bench 225 5/2 x3. RDL 285 6/2 x3." against
// a 275 RDL plan, then corrected with "Typo. 275." No deterministic lane owns a
// bare VALUE correction — the identity-correction classifier needs an exercise
// NAME and rejects digit-led captures — so the turn fell to the LLM coach,
// which left the retained sets at 285 and asserted they were "logged as
// planned". This classifier is the missing front half: an explicit correction
// cue + a corrected value (+ optionally the exercise named), nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');

// ES module — dynamic import (Node 20 CI has no require(esm)).
let classifyValueCorrection, formatValueCorrection, formatValueCorrectionAmbiguous;
test.before(async () => {
  ({ classifyValueCorrection, formatValueCorrection, formatValueCorrectionAmbiguous } =
    await import('../src/app/valueCorrection.js'));
});

test('repro: the corpus correction "Typo. 275." classifies as an unnamed weight correction', () => {
  assert.deepEqual(classifyValueCorrection('Typo. 275.'), { exercise: null, field: 'weight', value: 275 });
  assert.deepEqual(classifyValueCorrection('typo 275'), { exercise: null, field: 'weight', value: 275 });
  assert.deepEqual(classifyValueCorrection('Typo: 275 lbs'), { exercise: null, field: 'weight', value: 275 });
});

test('unnamed cue forms classify (weight by default)', () => {
  const cases = [
    ['correction: 275', 275],
    ['correction 275', 275],
    ['oops, 275', 275],
    ['whoops 275', 275],
    ['my bad, 275', 275],
    ['actually, 275', 275],
    ['sorry, 275', 275],
    ['make that 275', 275],
    ['make it 275', 275],
    ['should be 275', 275],
    ['that should be 275', 275],
    ['i meant 275', 275],
    ['i mean 275', 275],
    ['275 not 285', 275],
    ['typo, it was 275', 275],
    ['typo 102.5', 102.5],
  ];
  for (const [text, value] of cases) {
    assert.deepEqual(classifyValueCorrection(text), { exercise: null, field: 'weight', value }, `classify: ${text}`);
  }
});

test('an explicitly unit-ed value corrects that field, not the weight', () => {
  assert.deepEqual(classifyValueCorrection('typo, 8 reps'), { exercise: null, field: 'reps', value: 8 });
  assert.deepEqual(classifyValueCorrection('make that 6 reps'), { exercise: null, field: 'reps', value: 6 });
  assert.deepEqual(classifyValueCorrection('typo, RIR 3'), { exercise: null, field: 'rir', value: 3 });
  assert.deepEqual(classifyValueCorrection('should be rir 2'), { exercise: null, field: 'rir', value: 2 });
});

test('named forms carry the exercise (cleaned, lowercased)', () => {
  assert.deepEqual(classifyValueCorrection('RDL was 275'), { exercise: 'rdl', field: 'weight', value: 275 });
  assert.deepEqual(classifyValueCorrection('Romanian Deadlift was 275'), { exercise: 'romanian deadlift', field: 'weight', value: 275 });
  assert.deepEqual(classifyValueCorrection('bench should be 225'), { exercise: 'bench', field: 'weight', value: 225 });
  assert.deepEqual(classifyValueCorrection('typo, RDL 275'), { exercise: 'rdl', field: 'weight', value: 275 });
  assert.deepEqual(classifyValueCorrection('correction: bench press 225'), { exercise: 'bench press', field: 'weight', value: 225 });
  assert.deepEqual(classifyValueCorrection('make that RDL 275'), { exercise: 'rdl', field: 'weight', value: 275 });
});

test('a bare number is NOT a correction — it is a set continuation in this app', () => {
  for (const text of ['275', '275.', '225', '102.5']) {
    assert.equal(classifyValueCorrection(text), null, `should be null: "${text}"`);
  }
});

test('logs, questions and ordinary remarks are NOT value corrections', () => {
  for (const text of [
    'Bench 225 5/2 x3.',           // a fresh batch log
    'RDL 285 6/2 x3',              // a fresh log naming a lift and a weight
    '285 5/2 x3',                  // a continuation log (slash notation)
    'sorry that was squats 225 8/2', // an IDENTITY correction restating a set
    'sorry that was squats',       // an identity correction (no value at all)
    'that was heavy',              // a remark
    'I did 275',                   // a recount, no correction cue form
    'Bench was hard',              // no value
    'was that 275?',               // a question
    'should that be 275?',         // a question, even with a cue shape
    'typo?',                       // a question
    'how much was that?',          // a question
    '', '   ',
  ]) {
    assert.equal(classifyValueCorrection(text), null, `should be null: "${text}"`);
  }
});

test('out-of-bounds values are not corrections (no invented targets)', () => {
  for (const text of ['typo 0', 'typo 2000', 'typo, 0 reps', 'typo, 101 reps', 'typo, RIR 11']) {
    assert.equal(classifyValueCorrection(text), null, `should be null: "${text}"`);
  }
});

test('formatValueCorrection composes the confirmation from the correction detail only', () => {
  assert.equal(
    formatValueCorrection({ exercise: 'RDL', field: 'weight', from: 285, to: 275, count: 3, unchanged: false }),
    '✓ Corrected RDL: 285 → 275 on all 3 sets.');
  assert.equal(
    formatValueCorrection({ exercise: 'Bench Press', field: 'reps', from: 5, to: 8, count: 3, unchanged: false }),
    '✓ Corrected Bench Press: 5 reps → 8 reps on all 3 sets.');
  assert.equal(
    formatValueCorrection({ exercise: 'RDL', field: 'weight', from: 275, to: 275, count: 3, unchanged: true }),
    '✓ RDL already reads 275 — nothing to change.');
  assert.equal(
    formatValueCorrection({ exercise: 'RDL', field: 'weight', from: null, to: 275, count: 2, unchanged: false }),
    '✓ Corrected RDL: now 275 on all 2 sets.');
});

test('formatValueCorrectionAmbiguous asks without claiming any change', () => {
  const line = formatValueCorrectionAmbiguous({ exercise: 'rdl', field: 'weight', value: 275 });
  assert.match(line, /nothing changed/);
  assert.match(line, /275/);
});
