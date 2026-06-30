'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getExerciseById,
  getExercisesByMovementPattern,
  getExercisesByMuscle,
  getAllExercises,
  getMovementPatterns,
  hasExercise,
  _resetForTesting,
} = require('../services/exerciseLookupModule');

beforeEach(() => _resetForTesting());

// --- getExerciseById ---

test('getExerciseById: returns correct record for a known exercise', () => {
  const ex = getExerciseById('back-squat');
  assert.ok(ex, 'should return an exercise object');
  assert.strictEqual(ex.id, 'back-squat');
  assert.strictEqual(ex.movement_pattern, 'squat');
  assert.ok(Array.isArray(ex.primary_muscles));
  assert.ok(ex.primary_muscles.length > 0);
});

test('getExerciseById: returns null for an unknown id', () => {
  assert.strictEqual(getExerciseById('machine-chest-press'), null);
});

test('getExerciseById: returns null for empty string', () => {
  assert.strictEqual(getExerciseById(''), null);
});

test('getExerciseById: returns null for non-string input', () => {
  assert.strictEqual(getExerciseById(null), null);
  assert.strictEqual(getExerciseById(undefined), null);
  assert.strictEqual(getExerciseById(42), null);
});

test('getExerciseById: returned object has required schema fields', () => {
  const ex = getExerciseById('conventional-deadlift');
  assert.ok('id' in ex);
  assert.ok('name' in ex);
  assert.ok('movement_pattern' in ex);
  assert.ok('implement' in ex);
  assert.ok('primary_muscles' in ex);
  assert.ok('provenance' in ex);
});

test('getExerciseById: isolation exercise roundtrip', () => {
  const ex = getExerciseById('bicep-curl');
  assert.strictEqual(ex.movement_pattern, 'isolation');
});

// --- hasExercise ---

test('hasExercise: returns true for a known exercise', () => {
  assert.strictEqual(hasExercise('pull-up'), true);
});

test('hasExercise: returns false for an unknown exercise', () => {
  assert.strictEqual(hasExercise('machine-chest-press'), false);
});

// --- getAllExercises ---

test('getAllExercises: returns 52 exercises matching the ontology size', () => {
  const all = getAllExercises();
  assert.strictEqual(all.length, 52);
});

test('getAllExercises: every entry has an id', () => {
  for (const ex of getAllExercises()) {
    assert.ok(typeof ex.id === 'string' && ex.id.length > 0, `exercise missing id: ${JSON.stringify(ex).slice(0, 40)}`);
  }
});

test('getAllExercises: ids are unique', () => {
  const ids = getAllExercises().map(e => e.id);
  const unique = new Set(ids);
  assert.strictEqual(unique.size, ids.length);
});

// --- getExercisesByMovementPattern ---

test('getExercisesByMovementPattern: squat returns 7 exercises (4 original + 6 new − back-squat=1+6=7)', () => {
  const squats = getExercisesByMovementPattern('squat');
  // back-squat + front-squat + goblet-squat + leg-press + hack-squat + box-squat + belt-squat = 7
  assert.strictEqual(squats.length, 7);
  const ids = squats.map(e => e.id);
  assert.ok(ids.includes('back-squat'));
  assert.ok(ids.includes('belt-squat'));
  assert.ok(ids.includes('goblet-squat'));
});

test('getExercisesByMovementPattern: isolation returns 9 exercises', () => {
  const isolation = getExercisesByMovementPattern('isolation');
  assert.strictEqual(isolation.length, 9);
});

test('getExercisesByMovementPattern: all returned exercises match the requested pattern', () => {
  for (const ex of getExercisesByMovementPattern('hinge')) {
    assert.strictEqual(ex.movement_pattern, 'hinge');
  }
});

test('getExercisesByMovementPattern: returns empty array for unknown pattern', () => {
  assert.deepEqual(getExercisesByMovementPattern('unknown-pattern'), []);
});

test('getExercisesByMovementPattern: returns empty array for empty string', () => {
  assert.deepEqual(getExercisesByMovementPattern(''), []);
});

// --- getExercisesByMuscle ---

test('getExercisesByMuscle: returns exercises involving quadriceps', () => {
  const results = getExercisesByMuscle('quadriceps');
  assert.ok(results.length > 0, 'should find exercises with quadriceps');
  // back-squat and front-squat both involve quads
  const ids = results.map(e => e.id);
  assert.ok(ids.includes('back-squat'), 'back-squat involves quadriceps');
  assert.ok(ids.includes('front-squat'), 'front-squat involves quadriceps');
});

test('getExercisesByMuscle: returns exercises for biceps brachii', () => {
  const results = getExercisesByMuscle('biceps brachii');
  assert.ok(results.length > 0);
  const ids = results.map(e => e.id);
  assert.ok(ids.includes('bicep-curl'));
  assert.ok(ids.includes('preacher-curl'));
});

test('getExercisesByMuscle: lookup is case-insensitive', () => {
  const lower = getExercisesByMuscle('quadriceps');
  const upper = getExercisesByMuscle('Quadriceps');
  assert.strictEqual(lower.length, upper.length);
});

test('getExercisesByMuscle: returns empty array for unknown muscle', () => {
  assert.deepEqual(getExercisesByMuscle('fictional-muscle'), []);
});

test('getExercisesByMuscle: returns empty array for empty string', () => {
  assert.deepEqual(getExercisesByMuscle(''), []);
});

test('getExercisesByMuscle: no duplicate exercises in result (muscle in both primary and secondary)', () => {
  // Run for all muscles in the catalog and check for duplicates
  const patterns = getMovementPatterns();
  assert.ok(patterns.length > 0);
  for (const ex of getAllExercises()) {
    for (const muscle of (ex.secondary_muscles || [])) {
      if ((ex.primary_muscles || []).includes(muscle)) {
        const results = getExercisesByMuscle(muscle);
        const ids = results.map(e => e.id);
        const unique = new Set(ids);
        assert.strictEqual(unique.size, ids.length, `duplicate exercise in muscle lookup for '${muscle}'`);
      }
    }
  }
});

// --- getMovementPatterns ---

test('getMovementPatterns: returns the 12 expected movement patterns', () => {
  const patterns = new Set(getMovementPatterns());
  const expected = [
    'squat','hinge','lunge','horizontal_push','vertical_push',
    'horizontal_pull','vertical_pull','carry','anti_rotation','rotation','isolation',
  ];
  for (const p of expected) {
    assert.ok(patterns.has(p), `missing movement pattern: ${p}`);
  }
});

test('getMovementPatterns: returns an array', () => {
  assert.ok(Array.isArray(getMovementPatterns()));
});

// --- Catalog completeness ---

test('catalog: total exercise count by movement pattern sums to 52', () => {
  const patterns = getMovementPatterns();
  const total = patterns.reduce((sum, p) => sum + getExercisesByMovementPattern(p).length, 0);
  assert.strictEqual(total, 52);
});

test('catalog: every exercise is reachable via movement pattern lookup', () => {
  const all = getAllExercises();
  for (const ex of all) {
    const byPattern = getExercisesByMovementPattern(ex.movement_pattern);
    const ids = byPattern.map(e => e.id);
    assert.ok(ids.includes(ex.id), `${ex.id} not reachable via getExercisesByMovementPattern('${ex.movement_pattern}')`);
  }
});
