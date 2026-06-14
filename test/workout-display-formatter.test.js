'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatSetLine,
  formatExerciseBlock,
  formatSuggestedWorkout,
} = require('../services/workoutDisplayFormatter');

// ── formatSetLine ─────────────────────────────────────────────────────────────

test('formatSetLine: scalar RIR', () => {
  assert.equal(formatSetLine({ weight: 225, reps: 5, rir: 2 }), '225lbs 5/2');
});

test('formatSetLine: zero RIR is preserved', () => {
  assert.equal(formatSetLine({ weight: 135, reps: 10, rir: 0 }), '135lbs 10/0');
});

test('formatSetLine: RIR range preserves display order (descending)', () => {
  // "2-1" means starts ~2 RIR and may drift to 1 — do not sort
  assert.equal(formatSetLine({ weight: 225, reps: 5, rirMin: 2, rirMax: 1 }), '225lbs 5/2-1');
});

test('formatSetLine: RIR range preserves display order (ascending)', () => {
  assert.equal(formatSetLine({ weight: 100, reps: 8, rirMin: 1, rirMax: 2 }), '100lbs 8/1-2');
});

test('formatSetLine: missing RIR omits slash entirely', () => {
  const result = formatSetLine({ weight: 225, reps: 5 });
  assert.equal(result, '225lbs 5');
  assert.ok(!result.includes('/'), 'must not produce a trailing slash when RIR is absent');
});

test('formatSetLine: throws when weight is missing', () => {
  assert.throws(() => formatSetLine({ reps: 5, rir: 2 }), /weight/);
});

test('formatSetLine: throws when reps is missing', () => {
  assert.throws(() => formatSetLine({ weight: 225, rir: 2 }), /reps/);
});

// ── formatExerciseBlock ───────────────────────────────────────────────────────

test('formatExerciseBlock: exercise name is bold markdown', () => {
  const result = formatExerciseBlock({
    name: 'Bench Press',
    sets: [{ weight: 135, reps: 10, rir: 4 }],
  });
  assert.ok(result.startsWith('**Bench Press**'), 'name must be wrapped in **');
});

test('formatExerciseBlock: set lines use Atlas shorthand', () => {
  const result = formatExerciseBlock({
    name: 'Bench Press',
    sets: [
      { weight: 135, reps: 10, rir: 4 },
      { weight: 185, reps: 10, rir: 2 },
    ],
  });
  assert.ok(result.includes('135lbs 10/4'));
  assert.ok(result.includes('185lbs 10/2'));
});

test('formatExerciseBlock: no bullets on set lines', () => {
  const result = formatExerciseBlock({
    name: 'Squat',
    sets: [{ weight: 225, reps: 5, rir: 2 }],
  });
  assert.ok(!result.includes('- '), 'must not insert dash bullets');
  assert.ok(!result.includes('* '), 'must not insert asterisk bullets');
  assert.ok(!result.includes('• '), 'must not insert dot bullets');
});

test('formatExerciseBlock: exact output for two sets', () => {
  const result = formatExerciseBlock({
    name: 'Lat Pulldown',
    sets: [
      { weight: 180, reps: 8, rir: 2 },
      { weight: 180, reps: 8, rir: 2 },
    ],
  });
  assert.equal(result, '**Lat Pulldown**\n180lbs 8/2\n180lbs 8/2');
});

test('formatExerciseBlock: throws when name is missing', () => {
  assert.throws(
    () => formatExerciseBlock({ sets: [{ weight: 100, reps: 10, rir: 2 }] }),
    /name/
  );
});

test('formatExerciseBlock: throws when sets is empty', () => {
  assert.throws(() => formatExerciseBlock({ name: 'Squat', sets: [] }), /sets/);
});

// ── formatSuggestedWorkout ────────────────────────────────────────────────────

test('formatSuggestedWorkout: exercises separated by exactly one blank line', () => {
  const result = formatSuggestedWorkout({
    exercises: [
      { name: 'Squat',       sets: [{ weight: 225, reps: 5, rir: 2 }] },
      { name: 'Bench Press', sets: [{ weight: 185, reps: 8, rir: 2 }] },
    ],
  });
  assert.ok(result.includes('\n\n'), 'must have a blank line between exercises');
  assert.ok(!result.includes('\n\n\n'), 'must not have more than one blank line between exercises');
});

test('formatSuggestedWorkout: why line precedes the block with one blank line', () => {
  const result = formatSuggestedWorkout({
    why: 'Push is recovering.',
    exercises: [
      { name: 'Row', sets: [{ weight: 180, reps: 10, rir: 2 }] },
    ],
  });
  assert.ok(
    result.startsWith('Push is recovering.\n\n**Row**'),
    'why line must precede the block with exactly one blank line'
  );
});

test('formatSuggestedWorkout: no why prefix when why is absent', () => {
  const result = formatSuggestedWorkout({
    exercises: [
      { name: 'Row', sets: [{ weight: 180, reps: 10, rir: 2 }] },
    ],
  });
  assert.ok(result.startsWith('**Row**'), 'output must start with the first exercise when why is absent');
});

test('formatSuggestedWorkout: whitespace-only why is treated as absent', () => {
  const result = formatSuggestedWorkout({
    why: '   ',
    exercises: [
      { name: 'Row', sets: [{ weight: 180, reps: 10, rir: 2 }] },
    ],
  });
  assert.ok(result.startsWith('**Row**'), 'whitespace-only why must not add a blank prefix line');
});

test('formatSuggestedWorkout: throws when exercises is empty', () => {
  assert.throws(() => formatSuggestedWorkout({ exercises: [] }), /exercises/);
});

// ── Snapshot ──────────────────────────────────────────────────────────────────

test('formatSuggestedWorkout: full snapshot matches expected output exactly', () => {
  const result = formatSuggestedWorkout({
    why: 'Pull is ready, push is recovering, so today is clean upper pull/accessory work.',
    exercises: [
      {
        name: 'Face Pull',
        sets: [
          { weight: 50, reps: 15, rir: 3 },
          { weight: 50, reps: 15, rir: 3 },
          { weight: 50, reps: 15, rir: 3 },
        ],
      },
      {
        name: 'Shrugs',
        sets: [
          { weight: 75, reps: 15, rir: 3 },
          { weight: 75, reps: 15, rir: 3 },
          { weight: 75, reps: 15, rir: 3 },
        ],
      },
      {
        name: 'Dumbbell Curl',
        sets: [
          { weight: 30, reps: 8, rir: 2 },
          { weight: 30, reps: 8, rir: 2 },
          { weight: 30, reps: 8, rir: 2 },
        ],
      },
      {
        name: 'Lat Pulldown',
        sets: [
          { weight: 180, reps: 8, rir: 2 },
          { weight: 180, reps: 8, rir: 2 },
        ],
      },
    ],
  });

  const expected = [
    'Pull is ready, push is recovering, so today is clean upper pull/accessory work.',
    '',
    '**Face Pull**',
    '50lbs 15/3',
    '50lbs 15/3',
    '50lbs 15/3',
    '',
    '**Shrugs**',
    '75lbs 15/3',
    '75lbs 15/3',
    '75lbs 15/3',
    '',
    '**Dumbbell Curl**',
    '30lbs 8/2',
    '30lbs 8/2',
    '30lbs 8/2',
    '',
    '**Lat Pulldown**',
    '180lbs 8/2',
    '180lbs 8/2',
  ].join('\n');

  assert.equal(result, expected);
});
