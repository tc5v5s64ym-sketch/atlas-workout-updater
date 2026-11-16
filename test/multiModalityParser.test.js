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

// #1659 re-fix (Astra re-audit): a mixed turn leads with the resistance
// work, so the hold must name itself — the message lead is not the hold.
// Priya's exact fixture text must yield the named 40-second plank, or the
// persona-plank-pb fact check (which requires a named plank) fails on a
// blank exercise. Pure hold inputs are unchanged (see the tests above).
test('timed hold: mixed turn names the hold itself, not the message lead (#1659)', () => {
  assert.deepEqual(
    recognizeModalityInput('Rows done, 30 pounds, 10 each arm, 3 sets. Tank answer: 2. Plank 40 seconds!! That is a record for me.'),
    { modality: 'timed_hold', exercise: 'Plank', duration_sec: 40, sets: 1, rpe: null },
  );
});

test('timed hold: mixed turn names the hold without the comma too (#1659)', () => {
  const r = recognizeModalityInput('Rows done 30 pounds 10 each arm 3 sets Tank answer 2 Plank 40 seconds');
  assert.equal(r.modality, 'timed_hold');
  assert.equal(r.exercise, 'Plank');
  assert.equal(r.duration_sec, 40);
});

test('timed hold: a multi-word hold names itself on a mixed turn (#1659)', () => {
  const r = recognizeModalityInput('Rows done, 30 pounds, 10 each arm, 3 sets. Side plank 45 seconds!');
  assert.equal(r.modality, 'timed_hold');
  assert.equal(r.exercise, 'Side plank');
  assert.equal(r.duration_sec, 45);
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

// ---------------------------------------------------------------------------
// #1767 (Astra F-1) — a signed quantity must never become positive work.
// The extractors match digits only, so the sign was silently dropped; the
// entire signed, dimensional quantity is now consumed and nonpositive or
// ambiguous work is refused before an approvable row exists.
// ---------------------------------------------------------------------------

test('F-1: signed quantities are refused (no positive row)', () => {
  const signed = [
    'Dead hang \u221245 seconds', // U+2212 minus — the audit payload
    'Dead hang -45 seconds',
    'Run -2 km in 20 min',
    'Run 5 km in -20 min',
    '8 x -400m / 90 sec',
    '-8 x 400m / 90 sec',
    'Run 6 x -2 min / 60 sec',
    '8 x 400m / -90 sec',
    'Plank 60 sec -3x',
    'AMRAP -12 min: push-ups, squats',
    'Plank 60 sec RPE -7',
    'Run -32:10',
    'Run 5 km - level -7',
  ];
  for (const t of signed) {
    assert.equal(recognizeModalityInput(t), null, `signed quantity must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1: ranged quantities are refused (ambiguous work)', () => {
  for (const t of ['Plank 30-45 sec', 'Plank 30 - 45 sec', 'Run 5-10 km', 'Run 3-4 miles', 'Plank 60 sec RPE 7-8']) {
    assert.equal(recognizeModalityInput(t), null, `ranged quantity must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1: zero work quantities are refused', () => {
  for (const t of ['Plank 0 sec', 'Run 0 km', 'Run 5 km in 0 min', '8 x 0m / 90 sec', '0 x 400m / 90 sec', 'Run 0:00', 'Plank 60 sec x0', 'AMRAP 0 min: push-ups, squats']) {
    assert.equal(recognizeModalityInput(t), null, `zero quantity must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1: zero rest is meaningful (no rest between intervals) and stays', () => {
  const r = recognizeModalityInput('8 x 400m / 0 sec');
  assert.equal(r.modality, 'cardio_interval');
  assert.equal(r.rest_sec, 0);
});

test('F-1: spaced dashes stay separators; plus stays positive; dates do not false-trigger', () => {
  // Spaced dash = this module's own separator idiom (circuits split on it).
  assert.equal(recognizeModalityInput('Run 5 km - 30 min').distance_km, 5);
  assert.equal(recognizeModalityInput('Run 5 km - 30 min').duration_min, 30);
  assert.equal(recognizeModalityInput('AMRAP 12 min: push-ups, squats - 6 rounds RPE 8').rounds, 6);
  assert.equal(recognizeModalityInput('Plank 60 sec - RPE 7').rpe, 7);
  // Explicit plus is positive work, unchanged.
  assert.equal(recognizeModalityInput('Dead hang +45 seconds').duration_sec, 45);
  // A date range carries no modality unit, so it is not a ranged quantity.
  assert.equal(recognizeModalityInput('Plank 60 sec on 2026-11-16').duration_sec, 60);
  assert.equal(recognizeModalityInput('Run 5 km, Nov 16-17').distance_km, 5);
  // Hyphenated names and non-unit signed numbers are untouched.
  assert.equal(recognizeModalityInput('L-sit 45 sec').duration_sec, 45);
  assert.equal(recognizeModalityInput('side-plank 30 sec').duration_sec, 30);
  assert.equal(recognizeModalityInput('Plank 60 sec, temp -5C').duration_sec, 60);
  // Zero ratings are legitimate (Borg 0; machine level 0).
  assert.equal(recognizeModalityInput('Plank 60 sec RPE 0').rpe, 0);
  assert.equal(recognizeModalityInput('Elliptical 30 min level 0').level, 0);
});

// ---------------------------------------------------------------------------
// Pre-review (B1–B4) — the first fix was a denylist with systematic gaps:
// a spaced sign, other minus lookalikes, word ranges, spelled-out signs.
// ---------------------------------------------------------------------------

test('F-1 pre-review B1: a spaced sign refuses unless it separates two stated quantities', () => {
  const spacedSign = [
    'Plank - 45 sec',
    'Run - 2 km',
    'Run 5 km in - 20 min',
    'AMRAP - 12 min: push-ups, squats',
    '8 x - 400m / 90 sec',
    '- 8 x 400m / 90 sec',
    'Run - 32:10',
    'Dead hang \u2212 45 seconds', // spaced U+2212
    'Plank 60 sec RPE - 7', // a dash after a rating keyword is never a separator
    'Plank 60 sec x -3',
    'Plank 60 sec x-3',
  ];
  for (const t of spacedSign) {
    assert.equal(recognizeModalityInput(t), null, `spaced sign must refuse: ${JSON.stringify(t)}`);
  }
  // The dash BETWEEN two stated quantities stays a separator — including
  // duration-then-sets ("60 sec - 3x" reads as 3 sets, not negative sets).
  assert.equal(recognizeModalityInput('Plank 60 sec - 3x').sets, 3);
  assert.equal(recognizeModalityInput('Run 5 km - 30 min').duration_min, 30);
  assert.equal(recognizeModalityInput('AMRAP 12 min: push-ups, squats - 6 rounds RPE 8').rounds, 6);
});

test('F-1 pre-review B2: every hyphen/minus lookalike is a sign', () => {
  const lookalikes = [
    'Dead hang \u201045 seconds', // U+2010 HYPHEN
    'Dead hang \u201145 seconds', // U+2011 NON-BREAKING HYPHEN
    'Dead hang \uFF0D45 seconds', // U+FF0D FULLWIDTH HYPHEN-MINUS
    'Dead hang \uFE5845 seconds', // U+FE58 SMALL EM DASH
    'Dead hang \u02D745 seconds', // U+02D7 MODIFIER LETTER MINUS SIGN
    'Dead hang \u00AD45 seconds', // U+00AD SOFT HYPHEN
    'Plank 30\u201045 sec',
    'Plank 30\uFF0D45 sec',
  ];
  for (const t of lookalikes) {
    assert.equal(recognizeModalityInput(t), null, `lookalike sign must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review B3: word ranges refuse', () => {
  for (const t of ['Plank 30 to 45 sec', 'Run 5 to 10 km', 'Plank 30 or 45 sec', 'Plank 30 through 45 sec', 'Plank 60 sec RPE 7 to 8', 'Plank 60 sec RPE 7 - 8']) {
    assert.equal(recognizeModalityInput(t), null, `word range must refuse: ${JSON.stringify(t)}`);
  }
  // "to" as a connector between two complete quantities is not a range.
  assert.equal(recognizeModalityInput('Run 5 km to 30 min').distance_km, 5);
  assert.equal(recognizeModalityInput('Plank 60 sec to failure').duration_sec, 60);
});

test('F-1 pre-review B4: spelled-out signs refuse', () => {
  for (const t of ['Dead hang minus 45 seconds', 'Plank negative 45 sec']) {
    assert.equal(recognizeModalityInput(t), null, `spelled sign must refuse: ${JSON.stringify(t)}`);
  }
  // "plus"/"positive" state the true value and still parse.
  assert.equal(recognizeModalityInput('Dead hang plus 45 seconds').duration_sec, 45);
});
