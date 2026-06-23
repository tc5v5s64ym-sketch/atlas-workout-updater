'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { routeNextMove, ROUTE_ACTIONS } = require('../services/fatigueRouter');

// ---------------------------------------------------------------------------
// PR 483 — Live Fatigue Router (Taxonomy §6). Cross-pattern / cross-modality
// reroute of the next planned move from logged fatigue. Pure, suggestion-only,
// unwired. Goldens pin each §6 routing rule.
// ---------------------------------------------------------------------------

test('repeated RIR 0 on the same load blocks a PR attempt (highest priority)', () => {
  const r = routeNextMove({
    justLogged: { pattern: 'horizontal_push', muscles: ['chest'], fatigue_signal: 'high', repeated_rir0: true },
    nextMove: { pattern: 'horizontal_push', muscles: ['chest'], is_pr_attempt: true },
  });
  assert.equal(r.action, 'block_pr');
});

test('cardio after a heavy lower-body block → reduce intensity (Zone 2)', () => {
  const r = routeNextMove({
    justLogged: { pattern: 'squat', muscles: ['quads'], fatigue_signal: 'high' },
    nextMove: { pattern: 'locomotion', modalityCategory: 'cardio' },
    heavy_lower_block_done: true,
  });
  assert.equal(r.action, 'reduce_intensity');
});

test('circuit with an objective form/round-quality breakdown → reduce density', () => {
  const r = routeNextMove({
    justLogged: { muscles: [] },
    nextMove: { modalityCategory: 'circuit' },
    form_breakdown: true,
  });
  assert.equal(r.action, 'reduce_density');
});

test('high same-muscle fatigue + a rested alternative → promote the antagonist', () => {
  const r = routeNextMove({
    justLogged: { pattern: 'horizontal_push', muscles: ['chest', 'triceps'], fatigue_signal: 'high' },
    nextMove: { pattern: 'vertical_push', muscles: ['triceps', 'front_delts'] },
    restedAlternative: { pattern: 'horizontal_pull', available: true },
  });
  assert.equal(r.action, 'promote_alternative');
  assert.equal(r.target, 'horizontal_pull');
});

test('high same-muscle fatigue, no rested alternative → make the next item optional', () => {
  const r = routeNextMove({
    justLogged: { pattern: 'horizontal_push', muscles: ['chest'], fatigue_signal: 'high' },
    nextMove: { pattern: 'horizontal_push', muscles: ['chest'] },
  });
  assert.equal(r.action, 'make_optional');
});

test('elevated same-muscle fatigue → reduce sets/load on the next item', () => {
  const r = routeNextMove({
    justLogged: { muscles: ['chest'], fatigue_signal: 'elevated' },
    nextMove: { muscles: ['chest'] },
  });
  assert.equal(r.action, 'reduce');
});

test('a rested / antagonist next move with no shared load → keep', () => {
  const r = routeNextMove({
    justLogged: { pattern: 'squat', muscles: ['quads'], fatigue_signal: 'high' },
    nextMove: { pattern: 'horizontal_pull', muscles: ['lats'] },
  });
  assert.equal(r.action, 'keep');
});

test('no fatigue signal → keep even on the same muscle (never reroute without a signal)', () => {
  const r = routeNextMove({
    justLogged: { muscles: ['chest'], fatigue_signal: 'none' },
    nextMove: { muscles: ['chest'] },
  });
  assert.equal(r.action, 'keep');
});

test('form_breakdown only fires for a circuit modality (objective signal, not inferred)', () => {
  // Same flag on a resistance next move must NOT trigger density reduction.
  const r = routeNextMove({
    justLogged: { muscles: ['chest'], fatigue_signal: 'none' },
    nextMove: { pattern: 'horizontal_push', muscles: ['chest'], modalityCategory: 'resistance' },
    form_breakdown: true,
  });
  assert.equal(r.action, 'keep');
});

test('every emitted action is in the ROUTE_ACTIONS vocabulary; output is safe on empty input', () => {
  const cases = [
    {},
    { justLogged: {}, nextMove: {} },
    { justLogged: { muscles: ['chest'], fatigue_signal: 'high' }, nextMove: { muscles: ['chest'] } },
  ];
  for (const c of cases) {
    const r = routeNextMove(c);
    assert.ok(ROUTE_ACTIONS.includes(r.action), `action ${r.action} out of vocab`);
    assert.equal(typeof r.reason, 'string');
  }
  assert.ok(Object.isFrozen(ROUTE_ACTIONS));
});
