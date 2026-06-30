'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  routeOnboarding,
  ROUTE_COLD_START,
  ROUTE_BEGINNER_LP,
  ROUTE_INT_531,
  ROUTE_ADV_BLOCK,
  ROUTE_ADV_DUP,
} = require('../services/onboardingRouter');

// Minimal log entry — just needs to be non-empty to signal "has history"
const ONE_ENTRY = Object.freeze([{ date: '2025-01-01', exercise: 'Back Squat', weight: 135, reps: 5 }]);

// --- null / invalid guards ---

describe('routeOnboarding — null/invalid guards', () => {
  it('returns null for null params', () => assert.strictEqual(routeOnboarding(null), null));
  it('returns null for non-object params', () => assert.strictEqual(routeOnboarding('x'), null));
  it('returns null for missing goalId', () =>
    assert.strictEqual(routeOnboarding({ trainingLevel: 'beginner' }), null));
  it('returns null for empty goalId', () =>
    assert.strictEqual(routeOnboarding({ goalId: '', trainingLevel: 'beginner' }), null));
  it('returns null for non-string goalId', () =>
    assert.strictEqual(routeOnboarding({ goalId: 42, trainingLevel: 'beginner' }), null));
  it('returns null for missing trainingLevel', () =>
    assert.strictEqual(routeOnboarding({ goalId: 'powerlifting' }), null));
  it('returns null for unknown trainingLevel', () =>
    assert.strictEqual(routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'elite' }), null));
  it('returns null for unknown goalId (intermediate)', () =>
    assert.strictEqual(routeOnboarding({ goalId: 'underwater-basket-weaving', trainingLevel: 'intermediate', logEntries: ONE_ENTRY }), null));
  it('returns null for unknown goalId (advanced)', () =>
    assert.strictEqual(routeOnboarding({ goalId: 'niche-sport', trainingLevel: 'advanced', logEntries: ONE_ENTRY }), null));
});

// --- cold-start routing (no log history) ---

describe('routeOnboarding — cold_start_calibration', () => {
  it('routes when logEntries is null', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner', logEntries: null });
    assert.ok(r);
    assert.strictEqual(r.route, ROUTE_COLD_START);
  });
  it('routes when logEntries is missing', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'intermediate' });
    assert.ok(r);
    assert.strictEqual(r.route, ROUTE_COLD_START);
  });
  it('routes when logEntries is empty array', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'intermediate', logEntries: [] });
    assert.ok(r);
    assert.strictEqual(r.route, ROUTE_COLD_START);
  });
  it('cold start ignores trainingLevel — advanced user with no history gets calibration', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'advanced' });
    assert.strictEqual(r.route, ROUTE_COLD_START);
  });
  it('cold start programId is null', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner' });
    assert.strictEqual(r.programId, null);
  });
  it('cold start modelSelection is null', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner' });
    assert.strictEqual(r.modelSelection, null);
  });
  it('cold start plan is the calibration session plan', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner' });
    assert.ok(r.plan);
    assert.strictEqual(r.plan.shape, 'full_body_calibration');
  });
  it('cold start plan has sessions', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner' });
    assert.ok(Array.isArray(r.plan.sessions) && r.plan.sessions.length > 0);
  });
  it('cold start notes is a non-empty string', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner' });
    assert.ok(typeof r.notes === 'string' && r.notes.length > 0);
  });
  it('cold start with explicit equipment passes it through to plan', () => {
    const r = routeOnboarding({
      goalId:             'powerlifting',
      trainingLevel:      'beginner',
      availableEquipment: ['barbell'],
    });
    assert.ok(r.plan);
    assert.deepEqual(r.plan.available_equipment, ['barbell']);
  });
  it('cold start with empty availableEquipment defaults to full equipment set', () => {
    const r = routeOnboarding({
      goalId:             'powerlifting',
      trainingLevel:      'beginner',
      availableEquipment: [],
    });
    assert.ok(r.plan);
    assert.ok(Array.isArray(r.plan.available_equipment) && r.plan.available_equipment.length > 1,
      'expected non-trivial equipment set from default');
  });
});

// --- beginner LP routing ---

describe('routeOnboarding — beginner_lp', () => {
  it('powerlifting beginner with history → beginner_lp', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.ok(r);
    assert.strictEqual(r.route, ROUTE_BEGINNER_LP);
  });
  it('general-fitness beginner → beginner_lp', () => {
    const r = routeOnboarding({ goalId: 'general-fitness', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.strictEqual(r.route, ROUTE_BEGINNER_LP);
  });
  it('bodybuilding beginner → beginner_lp', () => {
    const r = routeOnboarding({ goalId: 'bodybuilding', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.strictEqual(r.route, ROUTE_BEGINNER_LP);
  });
  it('weight-loss beginner → beginner_lp', () => {
    const r = routeOnboarding({ goalId: 'weight-loss', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.strictEqual(r.route, ROUTE_BEGINNER_LP);
  });

  it('beginner_lp resolves programId', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.ok(typeof r.programId === 'string' && r.programId.length > 0, 'expected a programId');
  });
  it('beginner_lp modelSelection is null', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.strictEqual(r.modelSelection, null);
  });
  it('beginner_lp plan carries programId and initialState', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.ok(r.plan);
    assert.ok(typeof r.plan.programId === 'string');
    assert.deepEqual(r.plan.initialState, { sessionCount: 0, currentWeights: {}, consecutiveFails: {} });
  });
  it('beginner_lp plan.programId matches route programId', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.strictEqual(r.plan.programId, r.programId);
  });
  it('beginner_lp notes is a non-empty string', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.ok(typeof r.notes === 'string' && r.notes.length > 0);
  });
  it('beginner_lp powerlifting picks stronglifts-5x5 as first choice', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.strictEqual(r.programId, 'stronglifts-5x5');
  });
  it('beginner_lp general-fitness picks stronglifts-5x5', () => {
    const r = routeOnboarding({ goalId: 'general-fitness', trainingLevel: 'beginner', logEntries: ONE_ENTRY });
    assert.strictEqual(r.programId, 'stronglifts-5x5');
  });
});

// --- intermediate 5/3/1 routing ---

describe('routeOnboarding — intermediate_531', () => {
  it('powerlifting intermediate with history → intermediate_531', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'intermediate', logEntries: ONE_ENTRY });
    assert.ok(r);
    assert.strictEqual(r.route, ROUTE_INT_531);
  });
  it('general-fitness intermediate → intermediate_531', () => {
    const r = routeOnboarding({ goalId: 'general-fitness', trainingLevel: 'intermediate', logEntries: ONE_ENTRY });
    assert.strictEqual(r.route, ROUTE_INT_531);
  });

  it('intermediate_531 programId is 531-intermediate', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'intermediate', logEntries: ONE_ENTRY });
    assert.strictEqual(r.programId, '531-intermediate');
  });
  it('intermediate_531 modelSelection has modelId 531_wave', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'intermediate', logEntries: ONE_ENTRY });
    assert.ok(r.modelSelection);
    assert.strictEqual(r.modelSelection.modelId, '531_wave');
  });
  it('intermediate_531 plan is null (consumer provides trainingMaxes)', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'intermediate', logEntries: ONE_ENTRY });
    assert.strictEqual(r.plan, null);
  });
  it('intermediate_531 notes is non-empty string', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'intermediate', logEntries: ONE_ENTRY });
    assert.ok(typeof r.notes === 'string' && r.notes.length > 0);
  });
});

// --- advanced block periodization routing ---

describe('routeOnboarding — advanced_block', () => {
  it('powerlifting advanced with history → advanced_block', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'advanced', logEntries: ONE_ENTRY });
    assert.ok(r);
    assert.strictEqual(r.route, ROUTE_ADV_BLOCK);
  });

  it('advanced_block programId is null', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'advanced', logEntries: ONE_ENTRY });
    assert.strictEqual(r.programId, null);
  });
  it('advanced_block modelSelection has modelId block-intermediate', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'advanced', logEntries: ONE_ENTRY });
    assert.ok(r.modelSelection);
    assert.strictEqual(r.modelSelection.modelId, 'block-intermediate');
  });
  it('advanced_block plan is the block phase structure', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'advanced', logEntries: ONE_ENTRY });
    assert.ok(r.plan);
    assert.strictEqual(r.plan.totalWeeks, 8);
    assert.strictEqual(r.plan.phases.length, 3);
  });
  it('advanced_block notes is non-empty string', () => {
    const r = routeOnboarding({ goalId: 'powerlifting', trainingLevel: 'advanced', logEntries: ONE_ENTRY });
    assert.ok(typeof r.notes === 'string' && r.notes.length > 0);
  });
});

// --- advanced DUP routing ---

describe('routeOnboarding — advanced_dup', () => {
  it('bodybuilding intermediate with history → advanced_dup', () => {
    const r = routeOnboarding({ goalId: 'bodybuilding', trainingLevel: 'intermediate', logEntries: ONE_ENTRY });
    assert.ok(r);
    assert.strictEqual(r.route, ROUTE_ADV_DUP);
  });
  it('bodybuilding advanced → advanced_dup', () => {
    const r = routeOnboarding({ goalId: 'bodybuilding', trainingLevel: 'advanced', logEntries: ONE_ENTRY });
    assert.strictEqual(r.route, ROUTE_ADV_DUP);
  });
  it('weight-loss intermediate → advanced_dup', () => {
    const r = routeOnboarding({ goalId: 'weight-loss', trainingLevel: 'intermediate', logEntries: ONE_ENTRY });
    assert.strictEqual(r.route, ROUTE_ADV_DUP);
  });
  it('general-fitness advanced → advanced_dup', () => {
    const r = routeOnboarding({ goalId: 'general-fitness', trainingLevel: 'advanced', logEntries: ONE_ENTRY });
    assert.strictEqual(r.route, ROUTE_ADV_DUP);
  });

  it('advanced_dup modelSelection has modelId dup-patterns', () => {
    const r = routeOnboarding({ goalId: 'bodybuilding', trainingLevel: 'intermediate', logEntries: ONE_ENTRY });
    assert.ok(r.modelSelection);
    assert.strictEqual(r.modelSelection.modelId, 'dup-patterns');
  });
  it('advanced_dup with daysPerWeek=3 resolves 3-day plan', () => {
    const r = routeOnboarding({ goalId: 'bodybuilding', trainingLevel: 'intermediate', logEntries: ONE_ENTRY, daysPerWeek: 3 });
    assert.ok(r.plan);
    assert.strictEqual(r.plan.daysPerWeek, 3);
    assert.strictEqual(r.plan.sessions.length, 3);
  });
  it('advanced_dup with daysPerWeek=4 resolves 4-day plan', () => {
    const r = routeOnboarding({ goalId: 'bodybuilding', trainingLevel: 'advanced', logEntries: ONE_ENTRY, daysPerWeek: 4 });
    assert.ok(r.plan);
    assert.strictEqual(r.plan.daysPerWeek, 4);
    assert.strictEqual(r.plan.sessions.length, 4);
  });
  it('advanced_dup without daysPerWeek → plan is null, notes explains', () => {
    const r = routeOnboarding({ goalId: 'bodybuilding', trainingLevel: 'intermediate', logEntries: ONE_ENTRY });
    assert.strictEqual(r.plan, null);
    assert.ok(r.notes.includes('3 or 4'), `expected hint about valid daysPerWeek values, got: "${r.notes}"`);
  });
  it('advanced_dup with invalid daysPerWeek=5 → plan is null', () => {
    const r = routeOnboarding({ goalId: 'bodybuilding', trainingLevel: 'intermediate', logEntries: ONE_ENTRY, daysPerWeek: 5 });
    assert.strictEqual(r.plan, null);
  });
  it('advanced_dup programId is null', () => {
    const r = routeOnboarding({ goalId: 'bodybuilding', trainingLevel: 'intermediate', logEntries: ONE_ENTRY, daysPerWeek: 3 });
    assert.strictEqual(r.programId, null);
  });
  it('advanced_dup notes is non-empty string', () => {
    const r = routeOnboarding({ goalId: 'bodybuilding', trainingLevel: 'intermediate', logEntries: ONE_ENTRY, daysPerWeek: 3 });
    assert.ok(typeof r.notes === 'string' && r.notes.length > 0);
  });
});

// --- exported constants ---

describe('routeOnboarding — exported route constants', () => {
  it('ROUTE_COLD_START is a string', () => assert.ok(typeof ROUTE_COLD_START === 'string'));
  it('ROUTE_BEGINNER_LP is a string', () => assert.ok(typeof ROUTE_BEGINNER_LP === 'string'));
  it('ROUTE_INT_531 is a string', () => assert.ok(typeof ROUTE_INT_531 === 'string'));
  it('ROUTE_ADV_BLOCK is a string', () => assert.ok(typeof ROUTE_ADV_BLOCK === 'string'));
  it('ROUTE_ADV_DUP is a string', () => assert.ok(typeof ROUTE_ADV_DUP === 'string'));
  it('route constants are all distinct', () => {
    const routes = [ROUTE_COLD_START, ROUTE_BEGINNER_LP, ROUTE_INT_531, ROUTE_ADV_BLOCK, ROUTE_ADV_DUP];
    assert.strictEqual(new Set(routes).size, routes.length);
  });
});
