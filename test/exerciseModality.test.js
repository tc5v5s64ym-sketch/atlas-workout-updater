'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  modalityFor,
  isValidModality,
  EXERCISE_TYPES,
  LOAD_TYPES,
  FATIGUE_CLASSES,
  EFFORT_METRICS,
  PROGRESSION_METRICS,
} = require('../services/exerciseModality');

// ---------------------------------------------------------------------------
// PR 478 — Exercise Modality Schema (Training Profile Taxonomy §3).
// Pure data: modalityFor(name) returns the lens the engine uses to interpret a
// logged row. These goldens pin the §3 "Coverage required (minimum)" table so
// the modality mapping can't silently drift.
// ---------------------------------------------------------------------------

// Each row: input → expected { exercise_type, load_type, fatigue_class, effort_metric, progression_metric }.
const COVERAGE = [
  ['Bench Press',      { exercise_type: 'compound',        load_type: 'external_weight',      fatigue_class: 'moderate_systemic', effort_metric: 'rir',      progression_metric: 'load' }],
  ['Deadlift',         { exercise_type: 'compound',        load_type: 'external_weight',      fatigue_class: 'high_cns',          effort_metric: 'rir',      progression_metric: 'load' }],
  ['Lateral Raise',    { exercise_type: 'isolation',       load_type: 'external_weight',      fatigue_class: 'local',             effort_metric: 'rir',      progression_metric: 'load' }],
  ['Leg Press',        { exercise_type: 'machine',         load_type: 'external_weight',      fatigue_class: 'moderate_systemic', effort_metric: 'rir',      progression_metric: 'load' }],
  ['Power Clean',      { exercise_type: 'power',           load_type: 'external_weight',      fatigue_class: 'moderate_systemic', effort_metric: 'rir',      progression_metric: 'load' }],
  ['Pushups',          { exercise_type: 'bodyweight',      load_type: 'bodyweight',           fatigue_class: 'local',             effort_metric: 'rir',      progression_metric: 'reps' }],
  ['Pull Up',          { exercise_type: 'bodyweight',      load_type: 'bodyweight',           fatigue_class: 'local',             effort_metric: 'rir',      progression_metric: 'reps' }],
  ['Weighted Dip',     { exercise_type: 'bodyweight',      load_type: 'added_load_bodyweight', fatigue_class: 'moderate_systemic', effort_metric: 'rir',     progression_metric: 'load' }],
  ['Assisted Pull Up', { exercise_type: 'bodyweight',      load_type: 'assisted_bodyweight',  fatigue_class: 'local',             effort_metric: 'rir',      progression_metric: 'assistance' }],
  ['Elliptical',       { exercise_type: 'cardio_steady',   load_type: 'cardio_machine',       fatigue_class: 'aerobic',           effort_metric: 'hr_zone',  progression_metric: 'duration' }],
  ['Run',              { exercise_type: 'cardio_steady',   load_type: 'locomotion',           fatigue_class: 'aerobic',           effort_metric: 'pace',     progression_metric: 'pace' }],
  ['Plank',            { exercise_type: 'timed_hold',      load_type: 'timed',                fatigue_class: 'local',             effort_metric: 'duration', progression_metric: 'duration' }],
  ['Intervals 8x400m', { exercise_type: 'cardio_interval', load_type: 'locomotion',           fatigue_class: 'anaerobic',         effort_metric: 'hr_zone',  progression_metric: 'rounds' }],
  ['AMRAP 12 min',     { exercise_type: 'circuit',         load_type: 'bodyweight',           fatigue_class: 'metabolic',         effort_metric: 'rounds',   progression_metric: 'density' }],
];

test('modalityFor pins the §3 minimum-coverage table', () => {
  for (const [name, expected] of COVERAGE) {
    const m = modalityFor(name);
    for (const k of Object.keys(expected)) {
      assert.equal(m[k], expected[k], `${JSON.stringify(name)} .${k}: expected ${expected[k]}, got ${m[k]}`);
    }
  }
});

test('every modalityFor result is within the controlled vocabularies', () => {
  const names = COVERAGE.map(([n]) => n).concat(['Cable Fly', 'Stretching', 'Back Squat', 'Treadmill Run', 'unknownlift', '']);
  for (const n of names) {
    assert.equal(isValidModality(modalityFor(n)), true, `out-of-enum modality for ${JSON.stringify(n)}`);
  }
});

test('the resistance default is external_weight / rir / load (today\'s workflow)', () => {
  const m = modalityFor('Overhead Press');
  assert.equal(m.load_type, 'external_weight');
  assert.equal(m.effort_metric, 'rir');
  assert.deepEqual(m.effort_metric_alternates, ['rpe']);
  assert.equal(m.progression_metric, 'load');
});

test('non-resistance modalities are detected before the resistance default', () => {
  // A weighted/assisted bodyweight variant must NOT read as a plain external lift.
  assert.equal(modalityFor('Weighted Dip').load_type, 'added_load_bodyweight');
  assert.equal(modalityFor('Assisted Chin Up').load_type, 'assisted_bodyweight');
  // Circuits / intervals / holds / cardio win over any incidental keyword.
  assert.equal(modalityFor('EMOM 10 min').exercise_type, 'circuit');
  assert.equal(modalityFor('Sprints').exercise_type, 'cardio_interval');
  assert.equal(modalityFor('Wall Sit').exercise_type, 'timed_hold');
  assert.equal(modalityFor('Stationary Bike').exercise_type, 'cardio_steady');
});

test('empty / nullish input is a safe unknown modality (no throw)', () => {
  for (const v of ['', '   ', null, undefined]) {
    const m = modalityFor(v);
    assert.equal(m.exercise_type, 'unknown');
    assert.equal(isValidModality(m), true);
  }
});

test('enums are frozen and non-empty (schema guard)', () => {
  for (const e of [EXERCISE_TYPES, LOAD_TYPES, FATIGUE_CLASSES, EFFORT_METRICS, PROGRESSION_METRICS]) {
    assert.ok(Array.isArray(e) && e.length > 0);
    assert.ok(Object.isFrozen(e), 'controlled vocabularies must be frozen');
  }
  // The extension over the legacy EXERCISE_TYPES is present.
  for (const t of ['cardio_steady', 'cardio_interval', 'circuit', 'timed_hold', 'mobility']) {
    assert.ok(EXERCISE_TYPES.includes(t), `EXERCISE_TYPES must extend with ${t}`);
  }
});
