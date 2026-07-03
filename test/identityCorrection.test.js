'use strict';

// P0 PR 4 (AC7) — deterministic exercise-identity correction classifier.
// The live-gym gap: "sorry that was squats" must be recognized as a correction so
// the just-logged lift is relabeled deterministically (no LLM in the loop).

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyIdentityCorrection, cleanName } = require('../public/identityCorrection');

test('repro: "sorry that was squats" → correction to squats', () => {
  assert.deepEqual(classifyIdentityCorrection('sorry that was squats'), { to: 'squats' });
});

test('correction phrasings all classify', () => {
  const cases = [
    ['sorry that was squats', 'squats'],
    ['sorry, it was lat pulldown', 'lat pulldown'],
    ['sorry i meant overhead press', 'overhead press'],
    ['actually that was rows', 'rows'],
    ['oops, that was front squat', 'front squat'],
    ['that was actually leg press', 'leg press'],
    ['i meant romanian deadlift', 'romanian deadlift'],
    ['i meant to say hack squat', 'hack squat'],
    ['correction: incline bench', 'incline bench'],
    ['correction bulgarian split squat', 'bulgarian split squat'],
    ['make that lat pulldown', 'lat pulldown'],
    ['make it cable row', 'cable row'],
    ['that should be seated row', 'seated row'],
    ['should be pull ups', 'pull ups'],
    ['that was rows not curls', 'rows'],            // "X not Y" → X
    ['sorry that was squats 225 8/2', 'squats'],     // set-notation tail stripped
  ];
  for (const [text, to] of cases) {
    const r = classifyIdentityCorrection(text);
    assert.ok(r, `should classify: ${text}`);
    assert.equal(r.to, to, `to: ${text}`);
  }
});

test('an ordinary remark is NOT a correction (requires an explicit cue)', () => {
  for (const text of [
    'that was heavy', 'that was a good set', 'that felt easy', 'that was tough',
    'how many reps?', 'what should i do next?', 'was that right?',
    'bench 225 5/2', 'i am tired', '', '   ',
    'squats', 'deadlift',                       // a bare lift name is not a correction
    'that was squats',                          // bare "that was X" needs a cue (actually/sorry/really)
  ]) {
    assert.equal(classifyIdentityCorrection(text), null, `should be null: "${text}"`);
  }
});

test('a question is never a correction, even with a cue word', () => {
  for (const q of [
    'sorry was that squats?',
    'did i mean squats?',
    'should that be rows?',
  ]) {
    assert.equal(classifyIdentityCorrection(q), null, `question → null: "${q}"`);
  }
});

// ── "X is Y" form (owner live find 2026-07-03) ────────────────────────────────
test('repro: "Sorry slslp is single leg seated leg prep" → from/to correction', () => {
  assert.deepEqual(
    classifyIdentityCorrection('Sorry slslp is single leg seated leg prep'),
    { from: 'slslp', to: 'single leg seated leg prep' }
  );
});

test('"X is/was Y" phrasings carry both sides', () => {
  const cases = [
    ['sorry slslp is single leg seated leg press', 'slslp', 'single leg seated leg press'],
    ['slslp is single leg seated leg press', 'slslp', 'single leg seated leg press'],   // cueless — the caller gates on `from`
    ['oops, bench was incline bench', 'bench', 'incline bench'],
    ['actually curls means bicep curl', 'curls', 'bicep curl'],
    ['slslp should be single leg press', 'slslp', 'single leg press'],
    ['bench press was actually incline bench', 'bench press', 'incline bench'],
  ];
  for (const [text, from, to] of cases) {
    const r = classifyIdentityCorrection(text);
    assert.ok(r, `should classify: ${text}`);
    assert.equal(r.from, from, `from: ${text}`);
    assert.equal(r.to, to, `to: ${text}`);
  }
});

test('"X is Y" never fires on demonstratives or questions', () => {
  // Demonstratives stay with the cue-gated that-was patterns above.
  assert.equal(classifyIdentityCorrection('that was squats'), null);
  assert.equal(classifyIdentityCorrection('this is hard'), null);
  assert.equal(classifyIdentityCorrection('is slslp single leg press?'), null);
  // Numeric sides never classify.
  assert.equal(classifyIdentityCorrection('rest was 2 minutes'), null);
  assert.equal(classifyIdentityCorrection('225 was the weight'), null);
});

test('a slash-set log is never read as a correction', () => {
  assert.equal(classifyIdentityCorrection('that was actually 225 5/2'), null);
  assert.equal(classifyIdentityCorrection('make that 185 8/2'), null);
});

test('cleanName strips articles, fillers, punctuation, and a number tail', () => {
  assert.equal(cleanName('the squats'), 'squats');
  assert.equal(cleanName('lat pulldown, actually'), 'lat pulldown');
  assert.equal(cleanName('back squat 225 8/2'), 'back squat');
});
