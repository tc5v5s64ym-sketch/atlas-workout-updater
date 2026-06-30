'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getAllTiers,
  getTier,
  getExcluded,
  _resetForTesting,
} = require('../services/evidenceTiersModule');

beforeEach(() => _resetForTesting());

// Known tier numbers from the config
const KNOWN_TIER_NUMBERS = [1, 2, 3, 4, 5];

// --- getAllTiers ---

test('getAllTiers: returns an array', () => {
  assert.ok(Array.isArray(getAllTiers()));
});

test('getAllTiers: returns 5 tiers matching the config', () => {
  assert.strictEqual(getAllTiers().length, 5);
});

test('getAllTiers: every tier has tier, name, examples, best_for, caution', () => {
  for (const t of getAllTiers()) {
    assert.ok(typeof t.tier === 'number', `missing numeric tier`);
    assert.ok(typeof t.name === 'string' && t.name.length > 0, `tier ${t.tier}: missing name`);
    assert.ok(Array.isArray(t.examples) && t.examples.length > 0, `tier ${t.tier}: examples should be non-empty array`);
    assert.ok(typeof t.best_for === 'string' && t.best_for.length > 0, `tier ${t.tier}: missing best_for`);
    assert.ok(typeof t.caution === 'string' && t.caution.length > 0, `tier ${t.tier}: missing caution`);
  }
});

test('getAllTiers: tiers are in ascending order (1 through 5)', () => {
  const numbers = getAllTiers().map(t => t.tier);
  assert.deepEqual(numbers, KNOWN_TIER_NUMBERS);
});

test('getAllTiers: examples are non-empty strings', () => {
  for (const t of getAllTiers()) {
    for (const ex of t.examples) {
      assert.strictEqual(typeof ex, 'string');
      assert.ok(ex.length > 0);
    }
  }
});

test('getAllTiers: returns a copy (push does not mutate catalog)', () => {
  const first = getAllTiers();
  first.push({ tier: 99 });
  assert.strictEqual(getAllTiers().length, 5);
});

// --- getTier ---

test('getTier: returns correct record for each known tier number', () => {
  for (const n of KNOWN_TIER_NUMBERS) {
    const t = getTier(n);
    assert.ok(t, `should return a tier for number ${n}`);
    assert.strictEqual(t.tier, n);
  }
});

test('getTier: tier 1 is consensus statements / safest recommendations', () => {
  const t = getTier(1);
  assert.ok(t.name.toLowerCase().includes('consensus') || t.best_for.toLowerCase().includes('safe'));
});

test('getTier: tier 2 is systematic reviews / meta-analyses', () => {
  const t = getTier(2);
  assert.ok(
    t.name.toLowerCase().includes('systematic') || t.name.toLowerCase().includes('meta'),
    'tier 2 should reference systematic reviews or meta-analyses'
  );
});

test('getTier: tier 5 is evidence-based practitioners (lowest ranked)', () => {
  const t = getTier(5);
  assert.ok(
    t.name.toLowerCase().includes('practitioner') || t.name.toLowerCase().includes('evidence-based'),
    'tier 5 should reference practitioners'
  );
});

test('getTier: tier 1 examples include at least one well-known org (ACSM or NSCA)', () => {
  const { examples } = getTier(1);
  assert.ok(examples.some(e => e.includes('ACSM') || e.includes('NSCA')));
});

test('getTier: tier 5 examples include RP or Stronger by Science', () => {
  const { examples } = getTier(5);
  assert.ok(
    examples.some(e => e.toLowerCase().includes('renaissance') || e.toLowerCase().includes('stronger by science') || e.toLowerCase().includes('rp'))
  );
});

test('getTier: returns null for unknown tier number', () => {
  assert.strictEqual(getTier(0), null);
  assert.strictEqual(getTier(6), null);
  assert.strictEqual(getTier(99), null);
});

test('getTier: returns null for non-integer number', () => {
  assert.strictEqual(getTier(1.5), null);
  assert.strictEqual(getTier(NaN), null);
});

test('getTier: returns null for non-number inputs', () => {
  assert.strictEqual(getTier('1'), null);
  assert.strictEqual(getTier(null), null);
  assert.strictEqual(getTier(undefined), null);
});

// --- getExcluded ---

test('getExcluded: returns an object with description and examples', () => {
  const ex = getExcluded();
  assert.ok(ex, 'should return an object');
  assert.ok('description' in ex);
  assert.ok('examples' in ex);
});

test('getExcluded: description is a non-empty string', () => {
  assert.ok(typeof getExcluded().description === 'string');
  assert.ok(getExcluded().description.length > 0);
});

test('getExcluded: examples is a non-empty array of strings', () => {
  const { examples } = getExcluded();
  assert.ok(Array.isArray(examples));
  assert.ok(examples.length > 0);
  for (const ex of examples) {
    assert.strictEqual(typeof ex, 'string');
    assert.ok(ex.length > 0);
  }
});

test('getExcluded: examples include anecdote', () => {
  assert.ok(getExcluded().examples.some(e => e.toLowerCase().includes('anecdote')));
});

// --- Cross-function consistency ---

test('getAllTiers() and getTier() agree on all tier numbers', () => {
  for (const t of getAllTiers()) {
    const found = getTier(t.tier);
    assert.ok(found, `getTier(${t.tier}) should return a tier`);
    assert.strictEqual(found.tier, t.tier);
    assert.strictEqual(found.name, t.name);
  }
});

test('tier numbers from getAllTiers() are contiguous 1–5', () => {
  const numbers = getAllTiers().map(t => t.tier);
  for (let i = 0; i < numbers.length; i++) {
    assert.strictEqual(numbers[i], i + 1);
  }
});
