'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { intentToGoal, recommendTargetRir } = require('../services/rirPolicy');
const { getTrainingGoal, TRAINING_GOALS } = require('../services/trainingKnowledge');

test('session intents map to canonical training goals', () => {
  assert.equal(intentToGoal('build_strength'), 'strength');
  assert.equal(intentToGoal('test_progress'), 'strength');
  assert.equal(intentToGoal('build_muscle'), 'hypertrophy');
  assert.equal(intentToGoal('recovery_pump'), 'recovery');
  assert.equal(intentToGoal('deload_reset'), 'recovery');
  assert.equal(intentToGoal('something_unknown'), 'general_health'); // safe default
});

test('recommended RIR is training-type aware and distinct across goals', () => {
  const strength = recommendTargetRir({ goal: 'strength', role: 'main' });
  const hypMain = recommendTargetRir({ goal: 'hypertrophy', role: 'main' });
  const hypAcc = recommendTargetRir({ goal: 'hypertrophy', role: 'accessory' });
  const power = recommendTargetRir({ goal: 'power', role: 'main' });
  const recovery = recommendTargetRir({ goal: 'recovery', role: 'main' });

  assert.equal(strength, 2);
  assert.equal(hypMain, 2);
  assert.equal(hypAcc, 1);
  assert.equal(power, 4);
  assert.equal(recovery, 5);

  // The science the table encodes:
  assert.ok(recovery > strength, 'recovery leaves more in reserve than strength');
  assert.ok(power > strength, 'power stays further from failure than strength');
  assert.ok(hypAcc < hypMain, 'hypertrophy accessories sit closer to failure than the compound');
});

test('every recommended RIR sits inside its goal band from trainingKnowledge', () => {
  for (const goal of Object.keys(TRAINING_GOALS)) {
    const band = getTrainingGoal(goal).targetRIR;
    for (const role of ['main', 'accessory']) {
      const rir = recommendTargetRir({ goal, role });
      assert.ok(rir >= band.min && rir <= band.max, `${goal}/${role} = ${rir} outside band ${band.min}-${band.max}`);
    }
  }
});

test('aliases and unknown goals are handled safely', () => {
  // alias normalizes (build muscle -> hypertrophy)
  assert.equal(recommendTargetRir({ goal: 'build muscle', role: 'accessory' }), 1);
  // unknown goal falls back to general_health and stays in-band
  const rir = recommendTargetRir({ goal: 'nonsense', role: 'main' });
  const band = getTrainingGoal('general_health').targetRIR;
  assert.ok(rir >= band.min && rir <= band.max);
});
