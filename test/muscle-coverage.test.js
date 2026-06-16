'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { musclesFor, liftsForMuscle, TAXONOMY } = require('../services/muscleCoverage');

// Canonical fixture list from COACH_PLAN.md §PR 1.1.
// Parenthetical variants each produce a concrete name to test.
const FIXTURE_LIFTS = [
  'Back Squat',
  'Barbell Row',
  'Bench Press',
  'Machine Bench Press',
  'Bent Over Row',
  'Reverse Bent Over Row',
  'Cable Crossover',
  'Deadlift',
  'Dips',
  'Weighted Dips',
  'Dumbbell Curl',
  'Dumbbell Side Bend',
  'Face Pull',
  'Hammer Curls',
  'Hanging Knee Raises',
  'Incline DB Press',
  'Incline Dumbbell Press',
  'Lat Pulldown',
  'Lateral Raise',
  'Lateral Raises',
  'Leg Curl',
  'Leg Extension',
  'Leg Press',
  'Linear Leg Press',
  'Seated Leg Press',
  'Single-Leg Leg Press',
  'Overhead Press',
  'Romanian Deadlift',
  'Seated Row',
  'Shrugs',
  'Single-Leg Leg Curl',
];

/* ===== structural guarantees ===== */

test('every fixture lift has at least one primary muscle', () => {
  for (const lift of FIXTURE_LIFTS) {
    const result = musclesFor(lift);
    assert.ok(
      !result.needsReview && result.primary.length > 0,
      `${lift}: expected primary muscles, got ${JSON.stringify(result)}`
    );
  }
});

test('all returned muscles are in the 17-muscle taxonomy', () => {
  for (const lift of FIXTURE_LIFTS) {
    const { primary, secondary } = musclesFor(lift);
    for (const m of [...primary, ...secondary]) {
      assert.ok(TAXONOMY.has(m), `${lift}: "${m}" is not in the taxonomy`);
    }
  }
});

test('TAXONOMY contains exactly the 17 defined muscles', () => {
  const expected = [
    'chest', 'front_delts', 'side_delts', 'rear_delts', 'traps',
    'lats', 'upper_back', 'lower_back', 'biceps', 'triceps', 'forearms',
    'quads', 'hamstrings', 'glutes', 'calves', 'abs', 'obliques',
  ];
  assert.equal(TAXONOMY.size, 17);
  for (const m of expected) assert.ok(TAXONOMY.has(m), `taxonomy missing: ${m}`);
});

/* ===== unknown / edge-case inputs ===== */

test('unknown lift returns needsReview:true with empty muscle arrays', () => {
  const result = musclesFor('Alien Barbell Spinoza Machine');
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.primary, []);
  assert.deepEqual(result.secondary, []);
});

test('null / undefined / empty string inputs return needsReview', () => {
  for (const bad of [null, undefined, '']) {
    const r = musclesFor(bad);
    assert.equal(r.needsReview, true, `input ${JSON.stringify(bad)} should needsReview`);
  }
});

/* ===== required spot-checks from COACH_PLAN.md ===== */

test('Deadlift: traps is secondary, not primary', () => {
  const { primary, secondary } = musclesFor('Deadlift');
  assert.ok(!primary.includes('traps'), 'traps must NOT be primary for Deadlift');
  assert.ok(secondary.includes('traps'), 'traps must be secondary for Deadlift');
});

test('Row variants: biceps is secondary (not primary)', () => {
  for (const name of ['Barbell Row', 'Bent Over Row', 'Seated Row']) {
    const { primary, secondary } = musclesFor(name);
    assert.ok(!primary.includes('biceps'), `${name}: biceps must not be primary`);
    assert.ok(secondary.includes('biceps'), `${name}: biceps must be secondary`);
  }
});

test('Shrugs: primary = [traps], secondary = []', () => {
  const { primary, secondary } = musclesFor('Shrugs');
  assert.deepEqual(primary, ['traps']);
  assert.deepEqual(secondary, []);
});

test('Leg Extension: primary = [quads], secondary = []', () => {
  const { primary, secondary } = musclesFor('Leg Extension');
  assert.deepEqual(primary, ['quads']);
  assert.deepEqual(secondary, []);
});

test('Bench Press: chest is primary; triceps and front_delts are secondary', () => {
  const { primary, secondary } = musclesFor('Bench Press');
  assert.deepEqual(primary, ['chest']);
  assert.ok(secondary.includes('triceps'), 'Bench Press: triceps must be secondary');
  assert.ok(secondary.includes('front_delts'), 'Bench Press: front_delts must be secondary');
});

test('Overhead Press: triceps is secondary', () => {
  const { primary, secondary } = musclesFor('Overhead Press');
  assert.ok(primary.includes('front_delts'), 'OHP: front_delts must be primary');
  assert.ok(secondary.includes('triceps'), 'OHP: triceps must be secondary');
});

test('Lat Pulldown: lats is primary; biceps is secondary', () => {
  const { primary, secondary } = musclesFor('Lat Pulldown');
  assert.ok(primary.includes('lats'), 'Lat Pulldown: lats must be primary');
  assert.ok(!primary.includes('biceps'), 'Lat Pulldown: biceps must NOT be primary');
  assert.ok(secondary.includes('biceps'), 'Lat Pulldown: biceps must be secondary');
});

/* ===== additional fixture spot-checks ===== */

test('Deadlift: primary = glutes + hamstrings + lower_back', () => {
  const { primary } = musclesFor('Deadlift');
  for (const m of ['glutes', 'hamstrings', 'lower_back']) {
    assert.ok(primary.includes(m), `Deadlift primary must include ${m}`);
  }
});

test('Romanian Deadlift: hamstrings + glutes primary; lower_back secondary', () => {
  const { primary, secondary } = musclesFor('Romanian Deadlift');
  assert.ok(primary.includes('hamstrings'));
  assert.ok(primary.includes('glutes'));
  assert.ok(secondary.includes('lower_back'));
  assert.ok(!primary.includes('traps'), 'RDL: traps not primary');
});

test('Machine Bench Press matches bench_press profile', () => {
  const { primary, secondary } = musclesFor('Machine Bench Press');
  assert.deepEqual(primary, ['chest']);
  assert.ok(secondary.includes('triceps'));
  assert.ok(secondary.includes('front_delts'));
});

test('Incline DB Press and Incline Dumbbell Press: chest + front_delts primary', () => {
  for (const name of ['Incline DB Press', 'Incline Dumbbell Press', 'Incline Bench Press']) {
    const { primary, secondary } = musclesFor(name);
    assert.ok(primary.includes('chest'), `${name}: chest must be primary`);
    assert.ok(primary.includes('front_delts'), `${name}: front_delts must be primary`);
    assert.ok(secondary.includes('triceps'), `${name}: triceps must be secondary`);
  }
});

test('Hammer Curls: biceps + forearms primary, no secondary', () => {
  const { primary, secondary } = musclesFor('Hammer Curls');
  assert.ok(primary.includes('biceps'));
  assert.ok(primary.includes('forearms'));
  assert.deepEqual(secondary, []);
});

test('Dumbbell Curl: biceps primary, no secondary', () => {
  const { primary, secondary } = musclesFor('Dumbbell Curl');
  assert.deepEqual(primary, ['biceps']);
  assert.deepEqual(secondary, []);
});

test('Lateral Raise(s): side_delts primary, no secondary', () => {
  for (const name of ['Lateral Raise', 'Lateral Raises']) {
    const { primary, secondary } = musclesFor(name);
    assert.deepEqual(primary, ['side_delts'], `${name}: primary`);
    assert.deepEqual(secondary, [], `${name}: secondary`);
  }
});

test('Face Pull: rear_delts + upper_back primary; traps secondary', () => {
  const { primary, secondary } = musclesFor('Face Pull');
  assert.ok(primary.includes('rear_delts'));
  assert.ok(primary.includes('upper_back'));
  assert.ok(secondary.includes('traps'));
});

test('Leg Press variants all return quads + glutes primary', () => {
  for (const name of ['Leg Press', 'Linear Leg Press', 'Seated Leg Press', 'Single-Leg Leg Press']) {
    const { primary } = musclesFor(name);
    assert.ok(primary.includes('quads'), `${name}: quads must be primary`);
    assert.ok(primary.includes('glutes'), `${name}: glutes must be primary`);
  }
});

test('Leg Curl variants both return hamstrings primary', () => {
  for (const name of ['Leg Curl', 'Single-Leg Leg Curl']) {
    const { primary, secondary } = musclesFor(name);
    assert.deepEqual(primary, ['hamstrings'], `${name}: primary`);
    assert.deepEqual(secondary, [], `${name}: secondary`);
  }
});

test('Dips and Weighted Dips: chest + triceps primary', () => {
  for (const name of ['Dips', 'Weighted Dips']) {
    const { primary } = musclesFor(name);
    assert.ok(primary.includes('chest'), `${name}: chest primary`);
    assert.ok(primary.includes('triceps'), `${name}: triceps primary`);
  }
});

test('Back Squat: quads + glutes primary', () => {
  const { primary } = musclesFor('Back Squat');
  assert.ok(primary.includes('quads'));
  assert.ok(primary.includes('glutes'));
});

test('Cable Crossover: chest primary', () => {
  const { primary } = musclesFor('Cable Crossover');
  assert.deepEqual(primary, ['chest']);
});

test('Hanging Knee Raises: abs primary', () => {
  const { primary } = musclesFor('Hanging Knee Raises');
  assert.deepEqual(primary, ['abs']);
});

test('Dumbbell Side Bend: obliques primary, no secondary', () => {
  const { primary, secondary } = musclesFor('Dumbbell Side Bend');
  assert.deepEqual(primary, ['obliques']);
  assert.deepEqual(secondary, []);
});

/* ===== liftsForMuscle ===== */

test('liftsForMuscle returns lifts that train the given muscle (primary or secondary)', () => {
  const list = ['Back Squat', 'Bench Press', 'Deadlift', 'Lat Pulldown', 'Overhead Press', 'Unknown XYZ'];

  const quadLifts = liftsForMuscle('quads', list);
  assert.ok(quadLifts.includes('Back Squat'), 'Back Squat trains quads (primary)');
  assert.ok(!quadLifts.includes('Bench Press'), 'Bench Press does not train quads');

  const latsLifts = liftsForMuscle('lats', list);
  assert.ok(latsLifts.includes('Deadlift'), 'Deadlift contributes lats (secondary)');
  assert.ok(latsLifts.includes('Lat Pulldown'), 'Lat Pulldown trains lats (primary)');
  assert.ok(!latsLifts.includes('Unknown XYZ'), 'needsReview lifts excluded');
});

test('liftsForMuscle returns empty when no lift in the list trains the muscle', () => {
  const result = liftsForMuscle('calves', ['Bench Press', 'Overhead Press', 'Deadlift']);
  assert.deepEqual(result, []);
});

test('liftsForMuscle is safe with empty and bad inputs', () => {
  assert.deepEqual(liftsForMuscle('quads', []), []);
  assert.deepEqual(liftsForMuscle('', ['Back Squat']), []);
  assert.deepEqual(liftsForMuscle(null, ['Back Squat']), []);
  assert.deepEqual(liftsForMuscle('quads', null), []);
});

test('liftsForMuscle catches secondary contributors (traps from Deadlift)', () => {
  const result = liftsForMuscle('traps', ['Deadlift', 'Shrugs', 'Bench Press']);
  assert.ok(result.includes('Deadlift'), 'Deadlift is a traps secondary contributor');
  assert.ok(result.includes('Shrugs'), 'Shrugs is a traps primary');
  assert.ok(!result.includes('Bench Press'), 'Bench Press does not train traps');
});
