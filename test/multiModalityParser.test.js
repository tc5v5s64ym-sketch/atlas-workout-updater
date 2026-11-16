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

// Pre-review round 2 (B5–B10) — the B1–B4 fix left holes of its own: a
// leading-decimal sign, more minus lookalikes, "between" ranges,
// same-dimension spaced pairs, and two false-refusal regressions on common
// shorthand (glued units, elapsed-then-quantity separators).
// ---------------------------------------------------------------------------

test('F-1 pre-review B5: a leading-decimal sign refuses', () => {
  for (const t of ['Dead hang -.5 seconds', 'Plank -.5 sec', 'Plank - .5 sec', 'Plank -.05 sec', 'Run -.5 km', 'Plank -0.5 sec']) {
    assert.equal(recognizeModalityInput(t), null, `leading-decimal sign must refuse: ${JSON.stringify(t)}`);
  }
  // The unsigned ".5 sec" magnitude quirk (reads 5) is pre-existing and
  // out of scope — only the SIGNED form is F-1.
});

test('F-1 pre-review B6: the sign class is the Unicode dash category, not a denylist', () => {
  const lookalikes = [
    'Dead hang \u207B45 seconds', // U+207B SUPERSCRIPT MINUS
    'Dead hang \u208B45 seconds', // U+208B SUBSCRIPT MINUS
    'Dead hang \u279645 seconds', // U+2796 HEAVY MINUS SIGN
    'Dead hang \u204345 seconds', // U+2043 HYPHEN BULLET
    'Dead hang \u2E3A45 seconds', // U+2E3A TWO-EM DASH
    'Dead hang \u2E3B45 seconds', // U+2E3B THREE-EM DASH
    'Dead hang \u058A45 seconds', // U+058A ARMENIAN HYPHEN
    'Dead hang \u05BE45 seconds', // U+05BE HEBREW MAQAF
    'Dead hang \u180645 seconds', // U+1806 MONGOLIAN TODO HYPHEN
    'Dead hang \u2E1745 seconds', // U+2E17 DOUBLE OBLIQUE HYPHEN
    'Dead hang \u2E4045 seconds', // U+2E40 DOUBLE HYPHEN
    'Dead hang \u207B 45 seconds', // spaced superscript minus
    'Plank 30\u2E3A45 sec', // two-em dash range
  ];
  for (const t of lookalikes) {
    assert.equal(recognizeModalityInput(t), null, `lookalike sign must refuse: ${JSON.stringify(t)}`);
  }
  // Characters that are NOT minuses still parse: U+2019 right single quote
  // and U+00AF macron in front of the number are punctuation, not signs.
  assert.equal(recognizeModalityInput('Dead hang \u201945 seconds').duration_sec, 45);
  assert.equal(recognizeModalityInput('Dead hang \u00AF45 seconds').duration_sec, 45);
});

test('F-1 pre-review B7: "between X and Y" ranges refuse', () => {
  for (const t of ['Plank between 30 and 45 sec', 'Run between 5 and 10 km', 'Run 5 km between 20 and 30 min', 'Plank between 5 km and 10 km']) {
    assert.equal(recognizeModalityInput(t), null, `between-range must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review B8: a spaced dash between same-dimension quantities is a range', () => {
  for (const t of ['Plank 60 sec - 45 sec', 'Dead hang 45 sec - 30 sec', 'Run 5 km - 10 km', 'Run 5 km - 500 m', 'Plank 60 sec - 3 min', 'Plank 30 sec to 45 sec', 'Run 5 km to 10 km']) {
    assert.equal(recognizeModalityInput(t), null, `same-dimension pair must refuse: ${JSON.stringify(t)}`);
  }
  // Different dimensions stay separators.
  assert.equal(recognizeModalityInput('Run 5 km - 30 min').duration_min, 30);
  assert.equal(recognizeModalityInput('Run 5 km to 30 min').distance_km, 5);
});

test('F-1 pre-review B9: a unit glued to its digits still separates', () => {
  assert.equal(recognizeModalityInput('Run 5km - 30 min').distance_km, 5);
  assert.equal(recognizeModalityInput('Run 5km - 30 min').duration_min, 30);
  assert.equal(recognizeModalityInput('Run 10km - 45 min').distance_km, 10);
  assert.equal(recognizeModalityInput('Plank 60sec - 3x').sets, 3);
  assert.equal(recognizeModalityInput('Plank 45sec - 2x').duration_sec, 45);
  // Bare "5k" was never a distance, but the real 30-min row must survive.
  assert.equal(recognizeModalityInput('Run 5k - 30 min').duration_min, 30);
});

test('F-1 pre-review B10: an elapsed time before the separator is not a range start', () => {
  assert.equal(recognizeModalityInput('Run 32:10 - 5 km').distance_km, 5);
  assert.equal(recognizeModalityInput('Run 32:10 - 30 min').duration_min, 30);
  assert.equal(recognizeModalityInput('Run 5 km - 32:10').distance_km, 5);
});

test('F-1 pre-review N9/N10/N11/N12: range spellings and rating signs folded in', () => {
  for (const t of ['Plank 30 and 45 sec', 'Plank 30~45 sec', 'Plank 30..45 sec', 'Plank 30 ... 45 sec', 'Plank 60 sec 3x -3', 'Plank 60 sec 3x - 3', 'Plank 60 sec RPE minus 7', 'Plank 60 sec RPE negative 7', 'AMRAP 12 min: dead hang - 45 sec', 'Plank 60 sec - 0 sec']) {
    assert.equal(recognizeModalityInput(t), null, `must refuse: ${JSON.stringify(t)}`);
  }
  // The rounds count after a circuit list still separates.
  assert.equal(recognizeModalityInput('AMRAP 12 min: - 6 rounds').rounds, 6);
});

test('F-1 pre-review B11: plus-minus signs are signs, not decoration', () => {
  for (const t of ['Plank ±45 sec', 'Plank 30 ± 45 sec', 'Plank ∓45 sec', 'Plank 30 ∓ 45 sec', 'Run ±5 km']) {
    assert.equal(recognizeModalityInput(t), null, `plus-minus sign must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review B12: signed decimal-comma quantities refuse', () => {
  for (const t of ['Dead hang -5,5 seconds', 'Dead hang -,5 seconds', 'Dead hang - 5,5 seconds', 'Plank -30,5 sec', 'Run -2,5 km', 'Plank 30,5-45,5 sec', 'Plank 30,5 - 45,5 sec']) {
    assert.equal(recognizeModalityInput(t), null, `signed comma-decimal must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review B13: "and/or" and "up to" word ranges refuse', () => {
  for (const t of ['Plank 30 and/or 45 sec', 'Plank 30 up to 45 sec']) {
    assert.equal(recognizeModalityInput(t), null, `word range must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review B14: a sets count between "x" and the sign still refuses', () => {
  for (const t of ['Plank 60 sec x3-3', 'Plank 60 sec x3 -3', 'Plank 60 sec x3 - 3', 'Plank 60 sec x 3-3', 'Plank 60 sec x2 -3', 'Plank 60 sec x3−3']) {
    assert.equal(recognizeModalityInput(t), null, `prefix-order sets sign must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review B15: a separator chain stating one dimension twice refuses', () => {
  for (const t of ['Run 5 km - 30 min - 45 sec', 'Run 5 km - 30 min - 45 min', 'Run 5 km - 30 min - 500 m', 'Run 5 km - 30 min - 10 km', 'Run 5 km - 30 min - 10 mi', 'Plank 60 sec - 2 min - 45 sec', 'Run 5 km in 20 min - 30 min']) {
    assert.equal(recognizeModalityInput(t), null, `repeated-dimension chain must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review B16: a second end with its unit elided refuses', () => {
  for (const t of ['Plank 30 sec to 45', 'Run 5 km and 10', 'Plank 60 sec or 45', 'Run 5 km or 10', 'Plank 30 sec and 45', 'Plank between 30 sec and 45', 'Run between 5 km and 10', 'Run 5 km - 10', 'Plank 60 sec - 45', 'Plank 30sec-45', 'Run 5km-10', 'Plank 30sec - 45', 'Plank 30sec to 45', 'Run 5km and 10']) {
    assert.equal(recognizeModalityInput(t), null, `elided second end must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review B17: two elapsed times refuse', () => {
  for (const t of ['Run 32:10 - 45:20', 'Run 5 km - 32:10 - 45:20']) {
    assert.equal(recognizeModalityInput(t), null, `elapsed-time pair must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review B11-B17: the elided/chain carve-outs still parse', () => {
  // Word-form sets/reps after a dash are dropped, never parsed (pre-existing).
  assert.equal(recognizeModalityInput('Plank 60 sec - 3 sets').duration_sec, 60);
  assert.equal(recognizeModalityInput('Plank 60 sec - 3 sets').sets, 1);
  assert.equal(recognizeModalityInput('Plank 60 sec - 3 reps').duration_sec, 60);
  assert.equal(recognizeModalityInput('Plank 60 sec - 3 reps').sets, 1);
  // An elapsed time after the dash is a second quantity, not a range end.
  assert.equal(recognizeModalityInput('Run 5 km - 32:10').distance_km, 5);
  assert.equal(recognizeModalityInput('Run 5 km - 32:10').elapsed, '32:10');
  // Elapsed plus duration are different dimensions and both survive.
  assert.equal(recognizeModalityInput('Run 32:10 - 30 min').duration_min, 30);
  assert.equal(recognizeModalityInput('Run 32:10 - 30 min').elapsed, '32:10');
  // Distinct-dimension separators still parse.
  assert.equal(recognizeModalityInput('Run 5 km - 30 min').distance_km, 5);
  assert.equal(recognizeModalityInput('Run 5 km to 30 min').duration_min, 30);
  assert.equal(recognizeModalityInput('Plank 60 sec - 3x').sets, 3);
});

test('F-1 pre-review C1: "vs" / "versus" / "v" word ranges refuse', () => {
  for (const t of ['Plank 30 vs 45 sec', 'Plank 30 versus 45 sec', 'Plank 30 v 45 sec', 'Plank 30 vs. 45 sec', 'Run 5 vs 10 km', 'Plank 30 sec vs 45 sec', 'Run 5 km vs 10 km']) {
    assert.equal(recognizeModalityInput(t), null, `versus range must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review C2: arithmetic/symbol connectors refuse', () => {
  for (const t of ['Plank 30 + 45 sec', 'Plank 30+45 sec', 'Run 5+10 km', 'Plank 30 plus 45 sec', 'Plank 30 & 45 sec', 'Plank 30 * 45 sec', 'Plank 30 sec + 45 sec', 'Plank 30 sec & 45 sec', 'Plank 30 sec + 45', 'Run 5 km + 10', 'Plank 60 sec RPE 7+8', 'Plank 60 sec RPE 7 + 8']) {
    assert.equal(recognizeModalityInput(t), null, `symbol connector must refuse: ${JSON.stringify(t)}`);
  }
  // A leading "+" stays positive, and "+" between distinct dimensions is a separator.
  assert.equal(recognizeModalityInput('Dead hang +45 seconds').duration_sec, 45);
  assert.equal(recognizeModalityInput('Run 5 km + 30 min').distance_km, 5);
  assert.equal(recognizeModalityInput('Run 5 km + 30 min').duration_min, 30);
  // "x" is not a symbol connector: sets multiplier still parses.
  assert.equal(recognizeModalityInput('Plank 30 x 45 sec').sets, 30);
});

test('F-1 pre-review C3: Unicode approx-operator ranges refuse', () => {
  for (const t of ['Plank 30≈45 sec', 'Plank 30∼45 sec', 'Plank 30∽45 sec', 'Plank 30～45 sec', 'Plank 30≃48 sec', 'Plank 30≅45 sec', 'Plank 30 ≈ 45 sec', 'Plank 30 ∼ 45 sec']) {
    assert.equal(recognizeModalityInput(t), null, `approx-operator range must refuse: ${JSON.stringify(t)}`);
  }
});

test('F-1 pre-review N18: a signed number dangling after a count word refuses', () => {
  for (const t of ['Plank 60 sec 3 sets -3', 'Plank 60 sec 3 reps -3', 'Plank 60 sec 3 rounds -3']) {
    assert.equal(recognizeModalityInput(t), null, `dangling signed count must refuse: ${JSON.stringify(t)}`);
  }
  // A rounds count after a dash still parses (elided-guard carve-out).
  assert.equal(recognizeModalityInput('Plank 60 sec - 3 rounds').duration_sec, 60);
});
