'use strict';

// Golden fixtures for services/extraWorkDetector.js
// Pure data — no I/O, no Sheets, no LLM.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { detectExtraWork } = require('../services/extraWorkDetector');

describe('detectExtraWork — extra sets', () => {
  it('flags a planned exercise logged for more sets than prescribed', () => {
    const r = detectExtraWork(
      [{ exercise: 'Bench Press', target_sets: 3 }],
      [{ exercise: 'Bench Press', sets: 5 }]
    );
    assert.equal(r.has_extra, true);
    assert.equal(r.extra_sets.length, 1);
    assert.deepEqual(r.extra_sets[0], {
      exercise: 'Bench Press', prescribed_sets: 3, logged_sets: 5, extra: 2,
    });
    assert.equal(r.extra_exercises.length, 0);
  });

  it('exactly the prescribed sets → no extra', () => {
    const r = detectExtraWork(
      [{ exercise: 'Bench Press', target_sets: 3 }],
      [{ exercise: 'Bench Press', sets: 3 }]
    );
    assert.equal(r.has_extra, false);
    assert.equal(r.extra_sets.length, 0);
  });

  it('fewer than prescribed → no extra (under-work is not extra work)', () => {
    const r = detectExtraWork(
      [{ exercise: 'Bench Press', target_sets: 3 }],
      [{ exercise: 'Bench Press', sets: 2 }]
    );
    assert.equal(r.has_extra, false);
  });

  it('accepts an array of sets as the logged count', () => {
    const r = detectExtraWork(
      [{ exercise: 'Squat', target_sets: 2 }],
      [{ exercise: 'Squat', sets: [{}, {}, {}] }]
    );
    assert.equal(r.extra_sets[0].extra, 1);
  });

  it('matches by lift_code when names differ', () => {
    const r = detectExtraWork(
      [{ exercise: 'Bench Press', lift_code: 'BP01', target_sets: 3 }],
      [{ exercise: 'Barbell Bench Press', lift_code: 'BP01', sets: 4 }]
    );
    assert.equal(r.extra_sets.length, 1);
    assert.equal(r.extra_sets[0].exercise, 'Bench Press');
    assert.equal(r.extra_exercises.length, 0);
  });
});

describe('detectExtraWork — extra exercises', () => {
  it('flags a logged exercise that was not prescribed', () => {
    const r = detectExtraWork(
      [{ exercise: 'Bench Press', target_sets: 3 }],
      [{ exercise: 'Bench Press', sets: 3 }, { exercise: 'Bicep Curl', sets: 4 }]
    );
    assert.equal(r.has_extra, true);
    assert.deepEqual(r.extra_exercises, [{ exercise: 'Bicep Curl' }]);
    assert.equal(r.extra_sets.length, 0);
  });

  it('reports both extra sets and extra exercises together', () => {
    const r = detectExtraWork(
      [{ exercise: 'Bench Press', target_sets: 3 }],
      [{ exercise: 'Bench Press', sets: 5 }, { exercise: 'Tricep Pushdown', sets: 3 }]
    );
    assert.equal(r.extra_sets.length, 1);
    assert.equal(r.extra_exercises.length, 1);
    assert.equal(r.has_extra, true);
  });
});

describe('detectExtraWork — missing data is never guessed', () => {
  it('no target_sets on the plan → cannot assess extra sets', () => {
    const r = detectExtraWork(
      [{ exercise: 'Bench Press' }],
      [{ exercise: 'Bench Press', sets: 5 }]
    );
    assert.equal(r.extra_sets.length, 0);
    assert.equal(r.has_extra, false);
  });

  it('no logged set count → cannot assess extra sets', () => {
    const r = detectExtraWork(
      [{ exercise: 'Bench Press', target_sets: 3 }],
      [{ exercise: 'Bench Press' }]
    );
    assert.equal(r.extra_sets.length, 0);
  });
});

describe('detectExtraWork — defensive inputs', () => {
  it('empty inputs → no extra', () => {
    assert.deepEqual(detectExtraWork([], []), { extra_sets: [], extra_exercises: [], has_extra: false });
  });

  it('non-array inputs → safe empty result', () => {
    assert.equal(detectExtraWork(null, undefined).has_extra, false);
  });

  it('string-form exercises are accepted', () => {
    const r = detectExtraWork(['Bench Press'], ['Bicep Curl']);
    assert.deepEqual(r.extra_exercises, [{ exercise: 'Bicep Curl' }]);
  });

  it('entries without a name are skipped', () => {
    const r = detectExtraWork(
      [{ target_sets: 3 }],
      [{ sets: 5 }, { exercise: 'Curl', sets: 2 }]
    );
    assert.deepEqual(r.extra_exercises, [{ exercise: 'Curl' }]);
  });
});
