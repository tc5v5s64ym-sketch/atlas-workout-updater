'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  getGoalTemplate,
  listGoalTemplates,
  selectPrograms,
  _resetForTesting,
} = require('../services/goalTemplateModule');

before(() => _resetForTesting());

// --- null guards ---

describe('getGoalTemplate — null guards', () => {
  it('returns null for null', () => assert.strictEqual(getGoalTemplate(null), null));
  it('returns null for empty string', () => assert.strictEqual(getGoalTemplate(''), null));
  it('returns null for unknown id', () => assert.strictEqual(getGoalTemplate('unknown-goal-xyz'), null));
  it('returns null for numeric id', () => assert.strictEqual(getGoalTemplate(42), null));
});

// --- known goal templates ---

describe('getGoalTemplate — known goals', () => {
  it('returns general-fitness template', () => {
    const g = getGoalTemplate('general-fitness');
    assert.ok(g, 'should return a template');
    assert.strictEqual(g.id, 'general-fitness');
    assert.ok(typeof g.name === 'string');
    assert.ok(Array.isArray(g.recommended_programs));
  });

  it('returns powerlifting template', () => {
    const g = getGoalTemplate('powerlifting');
    assert.ok(g);
    assert.strictEqual(g.id, 'powerlifting');
    assert.ok(Array.isArray(g.recommended_programs));
    assert.ok(g.recommended_programs.length > 0);
  });

  it('returns bodybuilding template', () => {
    const g = getGoalTemplate('bodybuilding');
    assert.ok(g);
    assert.strictEqual(g.id, 'bodybuilding');
    assert.strictEqual(g.knowledge_goal_id, 'hypertrophy');
  });

  it('returns weight-loss template', () => {
    const g = getGoalTemplate('weight-loss');
    assert.ok(g);
    assert.strictEqual(g.id, 'weight-loss');
    assert.ok(typeof g.nutrition_note === 'string', 'weight-loss should carry a nutrition disclaimer');
  });

  it('all templates have required shape fields', () => {
    for (const id of ['general-fitness', 'powerlifting', 'bodybuilding', 'weight-loss']) {
      const g = getGoalTemplate(id);
      assert.ok(g.id,          `${id}: missing id`);
      assert.ok(g.name,        `${id}: missing name`);
      assert.ok(g.description, `${id}: missing description`);
      assert.ok(g.knowledge_goal_id, `${id}: missing knowledge_goal_id`);
      assert.ok(Array.isArray(g.recommended_programs), `${id}: recommended_programs not array`);
      assert.ok(g.target_days_per_week, `${id}: missing target_days_per_week`);
    }
  });
});

// --- listGoalTemplates ---

describe('listGoalTemplates', () => {
  it('returns at least 4 entries', () => {
    const list = listGoalTemplates();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 4, `expected ≥4 goals, got ${list.length}`);
  });

  it('each entry has id, name, description only', () => {
    for (const entry of listGoalTemplates()) {
      assert.ok(entry.id,          'missing id');
      assert.ok(entry.name,        'missing name');
      assert.ok(entry.description, 'missing description');
      assert.strictEqual(entry.recommended_programs, undefined, 'should not expose recommended_programs in summary');
    }
  });

  it('includes all four expected goal ids', () => {
    const ids = listGoalTemplates().map(g => g.id);
    for (const id of ['general-fitness', 'powerlifting', 'bodybuilding', 'weight-loss']) {
      assert.ok(ids.includes(id), `missing goal id: ${id}`);
    }
  });
});

// --- selectPrograms ---

describe('selectPrograms — null/unknown guards', () => {
  it('returns [] for null goalId', () => assert.deepStrictEqual(selectPrograms(null), []));
  it('returns [] for unknown goalId', () => assert.deepStrictEqual(selectPrograms('unknown'), []));
  it('returns [] for empty goalId', () => assert.deepStrictEqual(selectPrograms('')  , []));
});

describe('selectPrograms — beginner level (default)', () => {
  it('general-fitness beginner → includes stronglifts-5x5', () => {
    const ids = selectPrograms('general-fitness');
    assert.ok(ids.includes('stronglifts-5x5'), `expected stronglifts-5x5, got [${ids}]`);
  });

  it('powerlifting beginner → includes stronglifts-5x5', () => {
    const ids = selectPrograms('powerlifting', { trainingLevel: 'beginner' });
    assert.ok(ids.includes('stronglifts-5x5'));
  });

  it('bodybuilding beginner → includes gzclp', () => {
    const ids = selectPrograms('bodybuilding', { trainingLevel: 'beginner' });
    assert.ok(ids.includes('gzclp'));
  });

  it('weight-loss beginner → includes stronglifts-5x5', () => {
    const ids = selectPrograms('weight-loss', { trainingLevel: 'beginner' });
    assert.ok(ids.includes('stronglifts-5x5'));
  });
});

describe('selectPrograms — intermediate level', () => {
  it('powerlifting intermediate → includes 531-intermediate', () => {
    const ids = selectPrograms('powerlifting', { trainingLevel: 'intermediate' });
    assert.ok(ids.includes('531-intermediate'), `expected 531-intermediate, got [${ids}]`);
  });

  it('general-fitness intermediate → includes gzclp', () => {
    const ids = selectPrograms('general-fitness', { trainingLevel: 'intermediate' });
    assert.ok(ids.includes('gzclp'));
  });
});

describe('selectPrograms — advanced level', () => {
  it('powerlifting advanced → includes 531-intermediate', () => {
    const ids = selectPrograms('powerlifting', { trainingLevel: 'advanced' });
    assert.ok(ids.includes('531-intermediate'));
  });
});

describe('selectPrograms — return type', () => {
  it('always returns an array', () => {
    assert.ok(Array.isArray(selectPrograms('general-fitness')));
    assert.ok(Array.isArray(selectPrograms('bodybuilding', { trainingLevel: 'advanced' })));
  });
});
