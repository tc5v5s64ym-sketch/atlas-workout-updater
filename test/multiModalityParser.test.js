'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { recognizeModalityInput, MODALITIES } = require('../services/multiModalityParser');

// ---------------------------------------------------------------------------
// PR 486 slice 1 — Multi-modality input recognition (Taxonomy §4).
// Recognizes the NON-slash formats (timed holds + steady cardio) into structured
// fields. CRITICAL: it must return null for the existing weighted/slash-notation
// workflow so the resistance parser contract is never hijacked. Pure, unwired.
// ---------------------------------------------------------------------------

test('timed hold: "Plank 60 sec RPE 7 x3"', () => {
  assert.deepEqual(recognizeModalityInput('Plank 60 sec RPE 7 x3'), {
    modality: 'timed_hold', exercise: 'Plank', duration_sec: 60, sets: 3, rpe: 7,
  });
});

test('timed hold: minutes convert to seconds; sets default to 1', () => {
  const r = recognizeModalityInput('Wall Sit 2 min');
  assert.equal(r.modality, 'timed_hold');
  assert.equal(r.duration_sec, 120);
  assert.equal(r.sets, 1);
});

test('cardio (duration + RPE + HR): "Elliptical 30 min RPE 6 avg HR 142"', () => {
  assert.deepEqual(recognizeModalityInput('Elliptical 30 min RPE 6 avg HR 142'), {
    modality: 'cardio_steady', exercise: 'Elliptical', duration_min: 30,
    distance_km: null, elapsed: null, level: null, rpe: 6, avg_hr: 142,
  });
});

test('cardio (machine level): "Stairmaster 20 min level 7 RPE 8"', () => {
  const r = recognizeModalityInput('Stairmaster 20 min level 7 RPE 8');
  assert.equal(r.modality, 'cardio_steady');
  assert.equal(r.duration_min, 20);
  assert.equal(r.level, 7);
  assert.equal(r.rpe, 8);
});

test('cardio (distance + elapsed + HR): "Run 5 km 32:10 RPE 7 avg HR 151"', () => {
  const r = recognizeModalityInput('Run 5 km 32:10 RPE 7 avg HR 151');
  assert.equal(r.modality, 'cardio_steady');
  assert.equal(r.exercise, 'Run');
  assert.equal(r.distance_km, 5);
  assert.equal(r.elapsed, '32:10');
  assert.equal(r.avg_hr, 151);
});

test('cardio: miles convert to km', () => {
  const r = recognizeModalityInput('Run 3 mi 24:00');
  assert.equal(r.modality, 'cardio_steady');
  assert.equal(r.distance_km, Math.round(3 * 1.60934 * 100) / 100);
});

// ── The contract guard: resistance / slash-notation inputs are NOT ours ───────
test('the slash-notation resistance contract is never hijacked (returns null)', () => {
  const resistance = [
    'Bench 225 5/2',
    'Squat 315 5/2 x3',
    'Bench Press 225 5/2 185 8/2',
    'Lat Pulldown 175lbs 8/2 8/2 8/2',
    'Curl 30 12/0',
    'Deadlift 405 3/1',
    'Pushups 20/2 x3',   // bodyweight reps/RIR — the existing slash parser owns this
  ];
  for (const t of resistance) {
    assert.equal(recognizeModalityInput(t), null, `must defer to the resistance parser: ${JSON.stringify(t)}`);
  }
});

test('non-workout chatter and empty input → null', () => {
  for (const t of ['thanks coach', 'what should I do next?', '', '   ', null, undefined]) {
    assert.equal(recognizeModalityInput(t), null);
  }
});

test('a bare cardio/hold name with no quantity → null (needs a real signal)', () => {
  assert.equal(recognizeModalityInput('Run'), null);
  assert.equal(recognizeModalityInput('Plank'), null);
});

test('every recognized modality is in the MODALITIES vocabulary', () => {
  for (const t of ['Plank 60 sec', 'Run 5 km 30:00', 'Elliptical 30 min']) {
    const r = recognizeModalityInput(t);
    assert.ok(r && MODALITIES.includes(r.modality));
  }
  assert.ok(Object.isFrozen(MODALITIES));
});
