'use strict';

// Drift Guard 4 self-test. Proves the completion-ladder evidence guard is a REAL
// failing check — it bites on a synthetic route_consumed/live_proven claim that
// lacks a linked test or trace id — while confirming the shipped manifest is
// clean (nothing claims those rungs yet).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findEvidenceViolations, run } = require('../scripts/check-completion-ladder');
const shipped = require('../config/coaching/manifests/capabilities.json').capabilities;

// A full nine-rung ladder, all false unless overridden — keeps fixtures monotonic.
const ladder = over => ({
  built: false, unit_tested: false, runner_wired: false, inputs_available: false,
  route_consumed: false, user_visible: false, validator_covered: false,
  live_proven: false, owner_accepted: false, ...over,
});
// A capability whose ladder is monotonic up through route_consumed.
const consumedThrough = extra => ({
  ladder: ladder({ built: true, unit_tested: true, runner_wired: true, inputs_available: true, route_consumed: true, ...(extra && extra.ladder) }),
  consumer: 'routes/coachOps.js POST /api/coach/message',
  ...(extra && extra.rest),
});

describe('Drift Guard 4 — completion-ladder evidence guard', () => {
  it('the shipped manifest has zero evidence violations (nothing claims route_consumed/live_proven today)', () => {
    assert.deepEqual(findEvidenceViolations(shipped), []);
  });

  it('the full guard passes on the shipped manifest', () => {
    assert.deepEqual(run(), []);
  });

  it('FAILS a route_consumed claim with no evidence (the guard bites)', () => {
    const v = findEvidenceViolations({ x: consumedThrough() });
    assert.equal(v.length, 1);
    assert.match(v[0], /route_consumed/);
  });

  it('FAILS a live_proven claim with no evidence', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ ladder: { user_visible: true, validator_covered: true, live_proven: true } }) });
    assert.equal(v.length, 1);
    assert.match(v[0], /live_proven/);
  });

  it('PASSES a route_consumed claim WITH a linked trace id', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ rest: { evidence: [{ type: 'trace', ref: 'flight:2026-07-21T10:00Z#abc' }] } }) });
    assert.deepEqual(v, []);
  });

  it('PASSES a route_consumed claim WITH a linked test id', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ rest: { evidence: [{ type: 'test', ref: 'test/coachRoutePacket.test.js' }] } }) });
    assert.deepEqual(v, []);
  });

  it('FAILS evidence with an unrecognized type', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ rest: { evidence: [{ type: 'vibes', ref: 'trust me' }] } }) });
    assert.equal(v.length, 1);
  });

  it('FAILS evidence with an empty/blank ref', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ rest: { evidence: [{ type: 'test', ref: '   ' }] } }) });
    assert.equal(v.length, 1);
  });

  it('a capability below route_consumed needs no evidence', () => {
    const v = findEvidenceViolations({ x: { ladder: ladder({ built: true, unit_tested: true, runner_wired: true, inputs_available: true }) } });
    assert.deepEqual(v, []);
  });
});
