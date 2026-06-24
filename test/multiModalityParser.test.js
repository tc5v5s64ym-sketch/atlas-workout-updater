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

test('timed hold: a mid-string "x3" multiplier is captured (not just trailing)', () => {
  const r = recognizeModalityInput('Plank 60 sec x3 RPE 7');
  assert.equal(r.modality, 'timed_hold');
  assert.equal(r.duration_sec, 60);
  assert.equal(r.sets, 3);
  assert.equal(r.rpe, 7);
});

test('timed hold: a leading "3x" multiplier is captured too', () => {
  const r = recognizeModalityInput('Dead Hang 30 sec 3x');
  assert.equal(r.modality, 'timed_hold');
  assert.equal(r.sets, 3);
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

// ── Cardio intervals (PR 486 slice 2) ────────────────────────────────────────
test('intervals (distance work + rest): "8 x 400m / 90 sec"', () => {
  const r = recognizeModalityInput('8 x 400m / 90 sec');
  assert.equal(r.modality, 'cardio_interval');
  assert.equal(r.rounds, 8);
  assert.equal(r.work_distance_m, 400);
  assert.equal(r.work_sec, null);
  assert.equal(r.rest_sec, 90);
});

test('intervals (named, miles → meters, rest in min, RPE)', () => {
  const r = recognizeModalityInput('Run intervals 4 x 1 mile / 3 min RPE 8');
  assert.equal(r.modality, 'cardio_interval');
  assert.equal(r.rounds, 4);
  assert.equal(r.work_distance_m, Math.round(1 * 1609.34));
  assert.equal(r.rest_sec, 180);
  assert.equal(r.rpe, 8);
});

test('intervals (time-based work): "6 x 2 min / 60 sec"', () => {
  const r = recognizeModalityInput('6 x 2 min / 60 sec');
  assert.equal(r.modality, 'cardio_interval');
  assert.equal(r.rounds, 6);
  assert.equal(r.work_sec, 120);
  assert.equal(r.work_distance_m, null);
  assert.equal(r.rest_sec, 60);
});

test('intervals run before steady cardio (a rounds pattern wins over distance)', () => {
  const r = recognizeModalityInput('5 x 800m');
  assert.equal(r.modality, 'cardio_interval');
  assert.equal(r.rounds, 5);
  assert.equal(r.work_distance_m, 800);
  assert.equal(r.rest_sec, null);
});

// ── Circuits / conditioning (PR 486 slice 2) ─────────────────────────────────
test('circuit (AMRAP): cap, movements, rounds, RPE', () => {
  const r = recognizeModalityInput('AMRAP 12 min: pushups 10, air squats 15, situps 20 - 6 rounds RPE 8');
  assert.equal(r.modality, 'circuit');
  assert.equal(r.kind, 'amrap');
  assert.equal(r.cap_min, 12);
  assert.equal(r.rounds, 6);
  assert.deepEqual(r.movements, ['pushups 10', 'air squats 15', 'situps 20']);
  assert.equal(r.rpe, 8);
});

test('circuit (EMOM): cap + movements, no reported rounds', () => {
  const r = recognizeModalityInput('EMOM 10 min: 5 pullups, 10 pushups, 15 squats');
  assert.equal(r.modality, 'circuit');
  assert.equal(r.kind, 'emom');
  assert.equal(r.cap_min, 10);
  assert.equal(r.rounds, null);
  assert.deepEqual(r.movements, ['5 pullups', '10 pushups', '15 squats']);
});

test('circuit cap is anchored to the keyword header, not a movement duration', () => {
  const r = recognizeModalityInput('AMRAP: plank 2 min, lunges 10');
  assert.equal(r.modality, 'circuit');
  assert.equal(r.cap_min, null); // "2 min" belongs to the movement, not the cap
  assert.deepEqual(r.movements, ['plank 2 min', 'lunges 10']);
});

test('circuit wins over a hold-name listed inside it', () => {
  const r = recognizeModalityInput('AMRAP 8 min: plank 30 sec, lunges 10');
  assert.equal(r.modality, 'circuit');
  assert.equal(r.kind, 'amrap');
});

// PR 486 close-out (slice-3 follow-up edge): a bare "circuit" keyword inside a
// steady-cardio name, with no circuit structure, is a steady ride — not a circuit.
test('a bare "circuit" inside a cardio name is steady cardio, not a circuit', () => {
  const r = recognizeModalityInput('Bike circuit 20 min');
  assert.equal(r.modality, 'cardio_steady');
  assert.equal(r.duration_min, 20);
});

test('a structured bike circuit (rounds / movement list) is still a circuit', () => {
  const rounds = recognizeModalityInput('Bike circuit 5 rounds');
  assert.equal(rounds.modality, 'circuit');
  assert.equal(rounds.rounds, 5);
  const listed = recognizeModalityInput('Bike circuit: sprint 30 sec, easy 60 sec - 4 rounds');
  assert.equal(listed.modality, 'circuit');
});

test('a bare "circuit" without a cardio name is still a circuit', () => {
  const r = recognizeModalityInput('Circuit 15 min');
  assert.equal(r.modality, 'circuit');
  assert.equal(r.cap_min, 15);
});

test('AMRAP/EMOM strong formats are unaffected by the cardio-name guard', () => {
  assert.equal(recognizeModalityInput('AMRAP 20 min').modality, 'circuit');
  assert.equal(recognizeModalityInput('EMOM 12 min').modality, 'circuit');
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

test('a unitless rounds-ish input is NOT an interval/circuit (returns null)', () => {
  // "N x N" with no work unit (km/mi/m/min/sec) is resistance shorthand, not an
  // interval; locks the interval guard's required-work-unit against regex edits.
  for (const t of ['Bench 3 x 5', '3 x 5', 'Squat 5 x 5 reps', '4 x 8 @ 135']) {
    assert.equal(recognizeModalityInput(t), null, `must not be a modality: ${JSON.stringify(t)}`);
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
  const samples = [
    'Plank 60 sec', 'Run 5 km 30:00', 'Elliptical 30 min',
    '8 x 400m / 90 sec', 'AMRAP 10 min: pushups 10',
  ];
  for (const t of samples) {
    const r = recognizeModalityInput(t);
    assert.ok(r && MODALITIES.includes(r.modality), `unknown modality for ${JSON.stringify(t)}`);
  }
  assert.ok(Object.isFrozen(MODALITIES));
});
