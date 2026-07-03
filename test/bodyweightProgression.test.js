'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { bodyweightRepProgression } = require('../services/bodyweightProgression');

test('bodyweight: no logged RIR → low-confidence repeat', () => {
  const out = bodyweightRepProgression({ weight: null, reps: 12, rir: null });
  assert.equal(out.recommendation, 'Repeat 12 reps and keep form tight.');
  assert.equal(out.reasoning, 'Bodyweight movement — progress by adding reps, not load.');
  assert.equal(out.nextReps, 12);
  assert.equal(out.confidence, 'low');
});

test('bodyweight: RIR ≤ 0 → hold the rep count at high confidence', () => {
  const out = bodyweightRepProgression({ weight: null, reps: 10, rir: 0 });
  assert.equal(out.recommendation, 'Hold 10 reps — the last set was at or near failure.');
  assert.match(out.reasoning, /very close to failure/);
  assert.equal(out.nextReps, 10);
  assert.equal(out.confidence, 'high');
});

test('bodyweight: RIR above 0 → add a rep; confidence high at RIR ≥ 2, medium below', () => {
  const high = bodyweightRepProgression({ weight: null, reps: 8, rir: 3 });
  assert.equal(high.recommendation, 'Add a rep — target 9 reps next set.');
  assert.equal(high.nextReps, 9);
  assert.equal(high.confidence, 'high');

  const medium = bodyweightRepProgression({ weight: null, reps: 8, rir: 1 });
  assert.equal(medium.nextReps, 9);
  assert.equal(medium.confidence, 'medium');
});

test('bodyweight: never prescribes a weight — the return shape carries reps only', () => {
  const out = bodyweightRepProgression({ weight: null, reps: 15, rir: 4 });
  assert.deepEqual(Object.keys(out).sort(), ['confidence', 'nextReps', 'reasoning', 'recommendation'],
    'no nextWeight field — bodyweight progression is rep-based by construction');
});
