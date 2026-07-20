'use strict';

// SafetyDecision contract — Phase 2 Work item 2 (docs/CANONICAL_CONTRACTS.md).
//
// The single safety verdict for route + Brain: a traffic-light state, whether it
// blocks, the confidence in it, the matched signals, and a grounded reason. Pure
// builder + total validator + a boundary adapter over the live classifier.
// Read-only; not yet wired (Phase 5d wires it as the most-conservative override).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  buildSafetyDecision,
  validateSafetyDecision,
  fromClassification,
  STATES,
  CONFIDENCE_LEVELS,
  _resetForTesting,
} = require('../services/safetyDecision');
const { classifyTrafficLight } = require('../services/safetyClassifierModule');

beforeEach(() => _resetForTesting());

const valid = () => ({
  schema_version: SCHEMA_VERSION,
  state: 'yellow',
  blocking: false,
  confidence: 'moderate',
  signals: ['low readiness', 'travel fatigue'],
  reason: 'Reduce / modify',
});

describe('buildSafetyDecision', () => {
  it('stamps schema_version; defaults confidence none / signals [] / reason null', () => {
    const d = buildSafetyDecision({ state: 'green' });
    assert.equal(d.schema_version, SCHEMA_VERSION);
    assert.equal(d.state, 'green');
    assert.equal(d.confidence, 'none');
    assert.deepEqual(d.signals, []);
    assert.equal(d.reason, null);
  });
  it('does not invent a state (fails validation when unspecified — fail closed)', () => {
    const d = buildSafetyDecision({});
    assert.equal(d.state, undefined);
    assert.equal(validateSafetyDecision(d).valid, false);
  });
  it('derives a safe blocking default from the state (red blocks; others do not)', () => {
    assert.equal(buildSafetyDecision({ state: 'red' }).blocking, true);
    assert.equal(buildSafetyDecision({ state: 'yellow' }).blocking, false);
    assert.equal(buildSafetyDecision({ state: 'green' }).blocking, false);
    // an explicit blocking wins over the derivation
    assert.equal(buildSafetyDecision({ state: 'yellow', blocking: true }).blocking, true);
  });
  it('tolerates junk input without throwing', () => {
    assert.deepEqual(buildSafetyDecision(undefined).signals, []);
    assert.equal(buildSafetyDecision(null).state, undefined);
  });
});

describe('validateSafetyDecision', () => {
  it('accepts a well-formed verdict', () => {
    const r = validateSafetyDecision(valid());
    assert.equal(r.valid, true, r.errors.join(' | '));
  });
  it('rejects a non-object and a wrong schema_version', () => {
    assert.equal(validateSafetyDecision(null).valid, false);
    assert.equal(validateSafetyDecision('x').valid, false);
    assert.equal(validateSafetyDecision({ ...valid(), schema_version: 2 }).valid, false);
  });
  it('validates state against the enum', () => {
    assert.equal(validateSafetyDecision({ ...valid(), state: 'amber' }).valid, false);
    assert.equal(validateSafetyDecision({ ...valid(), state: undefined }).valid, false);
    for (const s of STATES) {
      // pick a blocking value consistent with each state so only `state` is under test
      const blocking = s === 'red';
      assert.equal(validateSafetyDecision({ ...valid(), state: s, blocking }).valid, true, `state ${s}`);
    }
  });

  it('enforces the safety ladder: red MUST block, green MUST NOT block, yellow may be either', () => {
    // red must block
    assert.equal(validateSafetyDecision({ ...valid(), state: 'red', blocking: true }).valid, true);
    assert.equal(validateSafetyDecision({ ...valid(), state: 'red', blocking: false }).valid, false);
    // green must not block
    assert.equal(validateSafetyDecision({ ...valid(), state: 'green', blocking: false }).valid, true);
    assert.equal(validateSafetyDecision({ ...valid(), state: 'green', blocking: true }).valid, false);
    // yellow may escalate to blocking or not
    assert.equal(validateSafetyDecision({ ...valid(), state: 'yellow', blocking: true }).valid, true);
    assert.equal(validateSafetyDecision({ ...valid(), state: 'yellow', blocking: false }).valid, true);
  });
  it('rejects a non-boolean blocking', () => {
    assert.equal(validateSafetyDecision({ ...valid(), blocking: 'true' }).valid, false);
    assert.equal(validateSafetyDecision({ ...valid(), blocking: 1 }).valid, false);
  });

  it('validates confidence against the enum', () => {
    assert.equal(validateSafetyDecision({ ...valid(), confidence: 'certain' }).valid, false);
    for (const c of CONFIDENCE_LEVELS) {
      assert.equal(validateSafetyDecision({ ...valid(), confidence: c }).valid, true, `confidence ${c}`);
    }
  });

  it('validates signals: an array of unique, non-empty strings; empty is allowed', () => {
    assert.equal(validateSafetyDecision({ ...valid(), signals: [] }).valid, true);
    assert.equal(validateSafetyDecision({ ...valid(), signals: 'chest pain' }).valid, false);
    assert.equal(validateSafetyDecision({ ...valid(), signals: [''] }).valid, false);
    assert.equal(validateSafetyDecision({ ...valid(), signals: [42] }).valid, false);
    assert.equal(validateSafetyDecision({ ...valid(), signals: ['low readiness', 'low readiness'] }).valid, false);
    // dedupe is case/whitespace-insensitive
    assert.equal(validateSafetyDecision({ ...valid(), signals: ['Low Readiness', ' low readiness '] }).valid, false);
  });

  it('requires reason present (explicit-null rule): null or a non-empty string', () => {
    const noKey = { ...valid() }; delete noKey.reason;
    assert.equal(validateSafetyDecision(noKey).valid, false);
    assert.equal(validateSafetyDecision({ ...valid(), reason: undefined }).valid, false);
    assert.equal(validateSafetyDecision({ ...valid(), reason: null }).valid, true);
    assert.equal(validateSafetyDecision({ ...valid(), reason: '' }).valid, false);
    assert.equal(validateSafetyDecision({ ...valid(), reason: 'Stop and route to medical' }).valid, true);
  });
});

describe('fromClassification (boundary adapter over the live classifier)', () => {
  it('maps a red-flag classification to a blocking red verdict that validates', () => {
    const classification = classifyTrafficLight(['chest pain', 'shortness of breath']);
    assert.equal(classification.state, 'red');
    const verdict = fromClassification(classification);
    assert.equal(verdict.state, 'red');
    assert.equal(verdict.blocking, true);
    assert.equal(verdict.confidence, classification.confidence);
    assert.deepEqual(verdict.signals, classification.matchedSignals);
    assert.equal(verdict.reason, classification.meaning);
    assert.equal(validateSafetyDecision(verdict).valid, true, validateSafetyDecision(verdict).errors.join(' | '));
  });
  it('maps a yellow classification to a non-blocking yellow verdict that validates', () => {
    const verdict = fromClassification(classifyTrafficLight(['low readiness']));
    assert.equal(verdict.state, 'yellow');
    assert.equal(verdict.blocking, false);
    assert.equal(validateSafetyDecision(verdict).valid, true);
  });
  it('maps an empty / no-signal classification to a green non-blocking verdict', () => {
    const verdict = fromClassification(classifyTrafficLight([]));
    assert.equal(verdict.state, 'green');
    assert.equal(verdict.blocking, false);
    assert.equal(verdict.confidence, 'none');
    assert.deepEqual(verdict.signals, []);
    assert.equal(validateSafetyDecision(verdict).valid, true);
  });
  it('tolerates junk input without throwing (fails validation, never crashes)', () => {
    assert.equal(validateSafetyDecision(fromClassification(null)).valid, false);
    assert.equal(validateSafetyDecision(fromClassification(undefined)).valid, false);
  });
});
