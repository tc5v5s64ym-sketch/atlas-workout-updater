'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectResponseDepth, RESPONSE_DEPTHS, isLoggingShaped } = require('../services/trainingQuestionClassifier');

test('workout logging text stays quiet (log_only) and does not trigger a lecture', () => {
  assert.equal(selectResponseDepth('bench 190 6/2'), 'log_only');
  assert.equal(selectResponseDepth('225 5/1'), 'log_only');
  assert.equal(selectResponseDepth('squat 3x8 @ 315'), 'log_only');
  assert.equal(selectResponseDepth('135 lbs 12 reps'), 'log_only');
});

test('a practical question maps to coach_brief', () => {
  assert.equal(selectResponseDepth('what should I do today?'), 'coach_brief');
});

test('a "why" question maps to explain', () => {
  assert.equal(selectResponseDepth('why are we holding 190?'), 'explain');
  assert.equal(selectResponseDepth('explain rest periods'), 'explain');
});

test('a comparison question maps to compare_options', () => {
  assert.equal(selectResponseDepth('explain hypertrophy vs strength'), 'compare_options');
  assert.equal(selectResponseDepth('machines versus free weights, which is better?'), 'compare_options');
});

test('"teach me" maps to teach_me', () => {
  assert.equal(selectResponseDepth('teach me how progressive overload works'), 'teach_me');
});

test('"go deep" maps to deep_dive', () => {
  assert.equal(selectResponseDepth('go deep on training to failure'), 'deep_dive');
});

test('depth is always one of the known levels; empty input is log_only', () => {
  assert.ok(RESPONSE_DEPTHS.includes(selectResponseDepth('anything at all?')));
  assert.equal(selectResponseDepth(''), 'log_only');
  assert.equal(selectResponseDepth(null), 'log_only');
});

test('isLoggingShaped recognizes logged-set notation but not prose questions', () => {
  assert.equal(isLoggingShaped('190 6/2'), true);
  assert.equal(isLoggingShaped('why are we holding the weight today'), false);
});
