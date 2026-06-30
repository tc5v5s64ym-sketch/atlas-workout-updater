'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getAllPatterns,
  getAllPatternIds,
  getPattern,
  getPatternsByFamily,
  getFamilies,
  _resetForTesting,
} = require('../services/movementPatternsModule');

beforeEach(() => _resetForTesting());

// Known pattern ids from the taxonomy
const KNOWN_IDS = [
  'squat', 'hinge', 'lunge',
  'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull',
  'carry', 'rotation', 'anti_rotation', 'isolation', 'locomotion',
];

// Known families and their expected pattern ids
const FAMILY_PATTERNS = {
  lower:    ['squat', 'hinge', 'lunge'],
  upper:    ['horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull'],
  full:     ['carry', 'locomotion'],
  trunk:    ['rotation', 'anti_rotation'],
  modifier: ['isolation'],
};

// --- getAllPatterns ---

test('getAllPatterns: returns an array', () => {
  assert.ok(Array.isArray(getAllPatterns()));
});

test('getAllPatterns: returns 12 patterns matching the taxonomy', () => {
  assert.strictEqual(getAllPatterns().length, 12);
});

test('getAllPatterns: every pattern has id, family, description, typical_primary', () => {
  for (const p of getAllPatterns()) {
    assert.ok(typeof p.id === 'string' && p.id.length > 0, `missing id`);
    assert.ok(typeof p.family === 'string' && p.family.length > 0, `${p.id}: missing family`);
    assert.ok(typeof p.description === 'string' && p.description.length > 0, `${p.id}: missing description`);
    assert.ok(Array.isArray(p.typical_primary) && p.typical_primary.length > 0, `${p.id}: typical_primary should be non-empty array`);
  }
});

test('getAllPatterns: preserves config order', () => {
  const ids = getAllPatterns().map(p => p.id);
  assert.deepEqual(ids, KNOWN_IDS);
});

test('getAllPatterns: returns a copy (push does not mutate catalog)', () => {
  const first = getAllPatterns();
  first.push({ id: 'injected' });
  assert.strictEqual(getAllPatterns().length, 12);
});

// --- getAllPatternIds ---

test('getAllPatternIds: returns all 12 known ids in order', () => {
  assert.deepEqual(getAllPatternIds(), KNOWN_IDS);
});

test('getAllPatternIds: each id is a non-empty string', () => {
  for (const id of getAllPatternIds()) {
    assert.strictEqual(typeof id, 'string');
    assert.ok(id.length > 0);
  }
});

// --- getPattern ---

test('getPattern: returns correct record for each known id', () => {
  for (const id of KNOWN_IDS) {
    const p = getPattern(id);
    assert.ok(p, `should return a pattern for id '${id}'`);
    assert.strictEqual(p.id, id);
  }
});

test('getPattern: squat → family is lower', () => {
  assert.strictEqual(getPattern('squat').family, 'lower');
});

test('getPattern: horizontal_push → family is upper', () => {
  assert.strictEqual(getPattern('horizontal_push').family, 'upper');
});

test('getPattern: carry → family is full', () => {
  assert.strictEqual(getPattern('carry').family, 'full');
});

test('getPattern: rotation → family is trunk', () => {
  assert.strictEqual(getPattern('rotation').family, 'trunk');
});

test('getPattern: isolation → family is modifier', () => {
  assert.strictEqual(getPattern('isolation').family, 'modifier');
});

test('getPattern: returns null for unknown id', () => {
  assert.strictEqual(getPattern('cardio'), null);
});

test('getPattern: returns null for empty string', () => {
  assert.strictEqual(getPattern(''), null);
});

test('getPattern: returns null for non-string inputs', () => {
  assert.strictEqual(getPattern(null), null);
  assert.strictEqual(getPattern(undefined), null);
  assert.strictEqual(getPattern(42), null);
});

// --- getPatternsByFamily ---

test('getPatternsByFamily: lower returns squat, hinge, lunge', () => {
  const ids = getPatternsByFamily('lower').map(p => p.id);
  assert.deepEqual(ids, FAMILY_PATTERNS.lower);
});

test('getPatternsByFamily: upper returns 4 patterns', () => {
  const ids = getPatternsByFamily('upper').map(p => p.id);
  assert.deepEqual(ids, FAMILY_PATTERNS.upper);
});

test('getPatternsByFamily: full returns carry and locomotion', () => {
  const ids = getPatternsByFamily('full').map(p => p.id);
  assert.deepEqual(ids, FAMILY_PATTERNS.full);
});

test('getPatternsByFamily: trunk returns rotation and anti_rotation', () => {
  const ids = getPatternsByFamily('trunk').map(p => p.id);
  assert.deepEqual(ids, FAMILY_PATTERNS.trunk);
});

test('getPatternsByFamily: modifier returns isolation', () => {
  const ids = getPatternsByFamily('modifier').map(p => p.id);
  assert.deepEqual(ids, FAMILY_PATTERNS.modifier);
});

test('getPatternsByFamily: unknown family returns empty array', () => {
  assert.deepEqual(getPatternsByFamily('unknown'), []);
});

test('getPatternsByFamily: empty string returns empty array', () => {
  assert.deepEqual(getPatternsByFamily(''), []);
});

test('getPatternsByFamily: non-string returns empty array', () => {
  assert.deepEqual(getPatternsByFamily(null), []);
  assert.deepEqual(getPatternsByFamily(undefined), []);
});

test('getPatternsByFamily: returns a copy (push does not mutate catalog)', () => {
  const first = getPatternsByFamily('lower');
  first.push({ id: 'injected' });
  assert.strictEqual(getPatternsByFamily('lower').length, 3);
});

test('getPatternsByFamily: all families together cover all 12 patterns', () => {
  const allFromFamilies = Object.keys(FAMILY_PATTERNS)
    .flatMap(f => getPatternsByFamily(f).map(p => p.id));
  assert.deepEqual(allFromFamilies.sort(), [...KNOWN_IDS].sort());
});

// --- getFamilies ---

test('getFamilies: returns 5 distinct families', () => {
  assert.strictEqual(getFamilies().length, 5);
});

test('getFamilies: contains all expected families', () => {
  const families = new Set(getFamilies());
  for (const family of Object.keys(FAMILY_PATTERNS)) {
    assert.ok(families.has(family), `missing family '${family}'`);
  }
});

test('getFamilies: first family is lower (first-appearance order)', () => {
  assert.strictEqual(getFamilies()[0], 'lower');
});

test('getFamilies: returns a copy (mutation does not affect catalog)', () => {
  const first = getFamilies();
  first[0] = 'tampered';
  assert.strictEqual(getFamilies()[0], 'lower');
});

// --- Cross-function consistency ---

test('getAllPatternIds() and getAllPatterns() ids agree', () => {
  const fromIds = getAllPatternIds();
  const fromPatterns = getAllPatterns().map(p => p.id);
  assert.deepEqual(fromIds, fromPatterns);
});

test('every getAllPatternIds() entry is retrievable via getPattern()', () => {
  for (const id of getAllPatternIds()) {
    const p = getPattern(id);
    assert.ok(p, `getPattern('${id}') should return a pattern`);
    assert.strictEqual(p.id, id);
  }
});

test('getPatternsByFamily() returns same records as getPattern() for same ids', () => {
  for (const [family, ids] of Object.entries(FAMILY_PATTERNS)) {
    const fromFamily = getPatternsByFamily(family).map(p => p.id);
    assert.deepEqual(fromFamily, ids);
    for (const id of ids) {
      assert.strictEqual(getPattern(id).family, family);
    }
  }
});
