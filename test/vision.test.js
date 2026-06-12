const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkoutScreenshotPrompt } = require('../services/vision');

test('vision prompt maps averageHR to average labels only', () => {
  const prompt = buildWorkoutScreenshotPrompt();

  assert.match(prompt, /"Avg HR"/);
  assert.match(prompt, /"Average HR"/);
  assert.match(prompt, /"Avg Heart Rate"/);
  assert.match(prompt, /averageHR: use only the value next to labels like/);
  assert.doesNotMatch(
    prompt.match(/- averageHR:[^\n]*/)?.[0] ?? '',
    /Max HR|Peak HR|Maximum HR/
  );
});

test('vision prompt maps peakHR to max or peak labels or highest visible HR', () => {
  const prompt = buildWorkoutScreenshotPrompt();

  assert.match(prompt, /"Max HR"/);
  assert.match(prompt, /"Maximum HR"/);
  assert.match(prompt, /"Peak HR"/);
  assert.match(prompt, /"Peak Heart Rate"/);
  assert.match(prompt, /highest visible heart-rate value/);
});

test('vision prompt keeps averageHR and peakHR separate', () => {
  const prompt = buildWorkoutScreenshotPrompt();

  assert.match(prompt, /Do not confuse them/);
  assert.match(prompt, /do not copy one into the other/);
  assert.match(prompt, /return peakHR: null/);
});
