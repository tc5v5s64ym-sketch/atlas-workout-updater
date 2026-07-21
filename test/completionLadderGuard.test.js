'use strict';

// Drift Guard 4 self-test. Proves the completion-ladder evidence guard is a REAL
// failing check — it bites on a synthetic route_consumed/live_proven claim that
// lacks a genuinely linked test or trace id — while confirming the shipped
// manifest is clean (nothing claims those rungs yet). It also proves the guard
// VALIDATES the ref, not just its non-blankness: a test ref must resolve to a
// real test file and a trace ref must match the defined trace-id format (else a
// bare "trust me" string would defeat the guard's purpose).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { findEvidenceViolations, evidenceIsLinked, run } = require('../scripts/check-completion-ladder');
const shipped = require('../config/coaching/manifests/capabilities.json').capabilities;

const ROOT = path.join(__dirname, '..');

// A full nine-rung ladder, all false unless overridden — keeps fixtures monotonic.
const ladder = over => ({
  built: false, unit_tested: false, runner_wired: false, inputs_available: false,
  route_consumed: false, user_visible: false, validator_covered: false,
  live_proven: false, owner_accepted: false, ...over,
});
// A capability whose ladder is monotonic up through route_consumed, plus consumer.
const consumedThrough = extra => ({
  ladder: ladder({ built: true, unit_tested: true, runner_wired: true, inputs_available: true, route_consumed: true, ...(extra && extra.ladder) }),
  consumer: 'routes/coachOps.js POST /api/coach/message',
  ...(extra && extra.rest),
});

// A real, existing test file — valid test evidence.
const REAL_TEST = 'test/completionLadderGuard.test.js';

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

  it('PASSES a route_consumed claim WITH a linked, EXISTING test file', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ rest: { evidence: [{ type: 'test', ref: REAL_TEST }] } }) });
    assert.deepEqual(v, []);
  });

  it('PASSES a test ref with a #test-name anchor on an existing file', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ rest: { evidence: [{ type: 'test', ref: REAL_TEST + '#the guard bites' }] } }) });
    assert.deepEqual(v, []);
  });

  it('PASSES a route_consumed claim WITH a well-formed trace id', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ rest: { evidence: [{ type: 'trace', ref: 'flight:sess_2026-07-21_abc123' }] } }) });
    assert.deepEqual(v, []);
  });

  it('FAILS a test ref that does not resolve to a real file (a bare string is not evidence)', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ rest: { evidence: [{ type: 'test', ref: 'test/not-a-real.test.js' }] } }) });
    assert.equal(v.length, 1);
  });

  it('FAILS a test ref not shaped like a test file (e.g. a source path)', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ rest: { evidence: [{ type: 'test', ref: 'services/foo.js' }] } }) });
    assert.equal(v.length, 1);
  });

  it('FAILS a trace ref that does not match the defined trace-id format', () => {
    const v = findEvidenceViolations({ x: consumedThrough({ rest: { evidence: [{ type: 'trace', ref: 'not-a-trace' }] } }) });
    assert.equal(v.length, 1);
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

  it('evidenceIsLinked: ref validators (existing test file, bad test file, good/bad trace id)', () => {
    assert.equal(evidenceIsLinked({ type: 'test',  ref: REAL_TEST },            ROOT), true);
    assert.equal(evidenceIsLinked({ type: 'test',  ref: 'test/nope.test.js' },  ROOT), false);
    assert.equal(evidenceIsLinked({ type: 'trace', ref: 'turn:abc-123' },       ROOT), true);
    assert.equal(evidenceIsLinked({ type: 'trace', ref: 'abc' },                ROOT), false);
  });
});
