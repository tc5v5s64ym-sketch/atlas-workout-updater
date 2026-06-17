'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { getProfileGoal } = require('../services/profileGoal');
const { resolveTrainingGoal } = require('../services/trainingGoalClassifier');

// ─── getProfileGoal — reading ATLAS_PROFILE_GOAL ─────────────────────────────

describe('getProfileGoal — absent env var', () => {
  let saved;
  beforeEach(() => { saved = process.env.ATLAS_PROFILE_GOAL; delete process.env.ATLAS_PROFILE_GOAL; });
  afterEach(() => { if (saved === undefined) delete process.env.ATLAS_PROFILE_GOAL; else process.env.ATLAS_PROFILE_GOAL = saved; });

  it('returns null when ATLAS_PROFILE_GOAL is not set', () => {
    assert.strictEqual(getProfileGoal(), null);
  });
});

describe('getProfileGoal — empty / whitespace', () => {
  let saved;
  beforeEach(() => { saved = process.env.ATLAS_PROFILE_GOAL; });
  afterEach(() => { if (saved === undefined) delete process.env.ATLAS_PROFILE_GOAL; else process.env.ATLAS_PROFILE_GOAL = saved; });

  it('returns null for empty string', () => {
    process.env.ATLAS_PROFILE_GOAL = '';
    assert.strictEqual(getProfileGoal(), null);
  });

  it('returns null for whitespace-only string', () => {
    process.env.ATLAS_PROFILE_GOAL = '   ';
    assert.strictEqual(getProfileGoal(), null);
  });
});

describe('getProfileGoal — canonical goal values', () => {
  let saved;
  beforeEach(() => { saved = process.env.ATLAS_PROFILE_GOAL; });
  afterEach(() => { if (saved === undefined) delete process.env.ATLAS_PROFILE_GOAL; else process.env.ATLAS_PROFILE_GOAL = saved; });

  it('returns "strength" for ATLAS_PROFILE_GOAL=strength', () => {
    process.env.ATLAS_PROFILE_GOAL = 'strength';
    assert.strictEqual(getProfileGoal(), 'strength');
  });

  it('returns "hypertrophy" for ATLAS_PROFILE_GOAL=hypertrophy', () => {
    process.env.ATLAS_PROFILE_GOAL = 'hypertrophy';
    assert.strictEqual(getProfileGoal(), 'hypertrophy');
  });

  it('returns "recovery" for ATLAS_PROFILE_GOAL=recovery', () => {
    process.env.ATLAS_PROFILE_GOAL = 'recovery';
    assert.strictEqual(getProfileGoal(), 'recovery');
  });

  it('returns "power" for ATLAS_PROFILE_GOAL=power', () => {
    process.env.ATLAS_PROFILE_GOAL = 'power';
    assert.strictEqual(getProfileGoal(), 'power');
  });

  it('returns "mixed" for ATLAS_PROFILE_GOAL=mixed', () => {
    process.env.ATLAS_PROFILE_GOAL = 'mixed';
    assert.strictEqual(getProfileGoal(), 'mixed');
  });

  it('returns "general_health" for ATLAS_PROFILE_GOAL=general_health', () => {
    process.env.ATLAS_PROFILE_GOAL = 'general_health';
    assert.strictEqual(getProfileGoal(), 'general_health');
  });
});

describe('getProfileGoal — aliases and normalisation', () => {
  let saved;
  beforeEach(() => { saved = process.env.ATLAS_PROFILE_GOAL; });
  afterEach(() => { if (saved === undefined) delete process.env.ATLAS_PROFILE_GOAL; else process.env.ATLAS_PROFILE_GOAL = saved; });

  it('alias "muscle" normalises to "hypertrophy"', () => {
    process.env.ATLAS_PROFILE_GOAL = 'muscle';
    assert.strictEqual(getProfileGoal(), 'hypertrophy');
  });

  it('alias "get_stronger" normalises to "strength"', () => {
    process.env.ATLAS_PROFILE_GOAL = 'get_stronger';
    assert.strictEqual(getProfileGoal(), 'strength');
  });

  it('alias "powerbuilding" normalises to "mixed"', () => {
    process.env.ATLAS_PROFILE_GOAL = 'powerbuilding';
    assert.strictEqual(getProfileGoal(), 'mixed');
  });

  it('trims surrounding whitespace before normalising', () => {
    process.env.ATLAS_PROFILE_GOAL = '  hypertrophy  ';
    assert.strictEqual(getProfileGoal(), 'hypertrophy');
  });
});

// ─── resolveTrainingGoal layering with stored profile goal ───────────────────

describe('stored profile goal flows through resolveTrainingGoal', () => {
  it('userProfileGoal drives goal when no explicit goal or session text', () => {
    const result = resolveTrainingGoal({ userProfileGoal: 'hypertrophy' });
    assert.strictEqual(result.goal, 'hypertrophy');
    assert.strictEqual(result.source, 'userProfileGoal');
  });

  it('userProfileGoal drives goal when session text is absent', () => {
    const result = resolveTrainingGoal({ userProfileGoal: 'strength' });
    assert.strictEqual(result.goal, 'strength');
    assert.strictEqual(result.source, 'userProfileGoal');
  });

  it('explicit goal overrides stored profile goal', () => {
    const result = resolveTrainingGoal({ explicitGoal: 'power', userProfileGoal: 'hypertrophy' });
    assert.strictEqual(result.goal, 'power');
    assert.strictEqual(result.source, 'explicitGoal');
  });

  it('session text (high confidence) overrides stored profile goal', () => {
    const result = resolveTrainingGoal({ sessionText: 'I am cooked need an easy day', userProfileGoal: 'strength' });
    assert.strictEqual(result.goal, 'recovery');
    assert.strictEqual(result.source, 'text');
  });

  it('explicit goal beats both session text and profile goal', () => {
    const result = resolveTrainingGoal({
      explicitGoal: 'power',
      sessionText: 'I am cooked',
      userProfileGoal: 'hypertrophy',
    });
    assert.strictEqual(result.goal, 'power');
    assert.strictEqual(result.source, 'explicitGoal');
  });

  it('absent profile goal (null) falls back to general_health default', () => {
    const result = resolveTrainingGoal({ userProfileGoal: null });
    assert.strictEqual(result.goal, 'general_health');
    assert.strictEqual(result.source, 'fallback');
  });

  it('absent profile goal (undefined) falls back to general_health default', () => {
    const result = resolveTrainingGoal({ userProfileGoal: undefined });
    assert.strictEqual(result.goal, 'general_health');
    assert.strictEqual(result.source, 'fallback');
  });
});

// ─── integration: getProfileGoal() → resolveTrainingGoal ────────────────────

describe('getProfileGoal() → resolveTrainingGoal integration', () => {
  let saved;
  beforeEach(() => { saved = process.env.ATLAS_PROFILE_GOAL; });
  afterEach(() => { if (saved === undefined) delete process.env.ATLAS_PROFILE_GOAL; else process.env.ATLAS_PROFILE_GOAL = saved; });

  it('stored goal flows through pipeline when no query override', () => {
    process.env.ATLAS_PROFILE_GOAL = 'hypertrophy';
    const profileGoal = getProfileGoal();
    const result = resolveTrainingGoal({ userProfileGoal: profileGoal });
    assert.strictEqual(result.goal, 'hypertrophy');
    assert.strictEqual(result.source, 'userProfileGoal');
  });

  it('non-empty query value wins over stored goal (simulates req.query.profileGoal || getProfileGoal())', () => {
    process.env.ATLAS_PROFILE_GOAL = 'hypertrophy';
    const storedGoal = getProfileGoal(); // 'hypertrophy'
    const queryValue = 'strength';
    const effectiveGoal = queryValue || storedGoal; // queryValue is truthy → storedGoal not reached
    assert.strictEqual(effectiveGoal, 'strength');
    const result = resolveTrainingGoal({ userProfileGoal: effectiveGoal });
    assert.strictEqual(result.goal, 'strength');
    assert.strictEqual(result.source, 'userProfileGoal');
  });

  it('empty query value falls back to stored goal (simulates absent ?profileGoal=)', () => {
    process.env.ATLAS_PROFILE_GOAL = 'hypertrophy';
    const storedGoal = getProfileGoal(); // 'hypertrophy'
    const queryValue = undefined; // absent query param
    const effectiveGoal = queryValue || storedGoal; // queryValue is falsy → storedGoal wins
    assert.strictEqual(effectiveGoal, 'hypertrophy');
    const result = resolveTrainingGoal({ userProfileGoal: effectiveGoal });
    assert.strictEqual(result.goal, 'hypertrophy');
    assert.strictEqual(result.source, 'userProfileGoal');
  });

  it('absent env var → pipeline falls back to general_health', () => {
    delete process.env.ATLAS_PROFILE_GOAL;
    const profileGoal = getProfileGoal(); // null
    const result = resolveTrainingGoal({ userProfileGoal: profileGoal });
    assert.strictEqual(result.goal, 'general_health');
    assert.strictEqual(result.source, 'fallback');
  });
});
