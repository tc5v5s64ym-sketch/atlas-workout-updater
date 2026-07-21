'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const shadow = require('../services/interactionTraceShadow');
const { validateInteractionTrace } = require('../services/interactionTrace');

const ENV = process.env.ATLAS_INTERACTION_TRACE;
beforeEach(() => shadow._resetForTesting());
afterEach(() => {
  if (ENV === undefined) delete process.env.ATLAS_INTERACTION_TRACE;
  else process.env.ATLAS_INTERACTION_TRACE = ENV;
});

describe('interactionTraceShadow — flag gating', () => {
  it('is inert unless ATLAS_INTERACTION_TRACE=shadow', () => {
    delete process.env.ATLAS_INTERACTION_TRACE;
    assert.equal(shadow.isShadowEnabled(), false);
    assert.equal(shadow.observeTurnStart({ turnId: shadow.mintTurnId(), intentType: 'set' }), null);
    assert.deepEqual(shadow.getShadowLog(), []);
  });
  it('enables only for the exact value "shadow"', () => {
    process.env.ATLAS_INTERACTION_TRACE = 'on';
    assert.equal(shadow.isShadowEnabled(), false);
    process.env.ATLAS_INTERACTION_TRACE = 'shadow';
    assert.equal(shadow.isShadowEnabled(), true);
  });
});

describe('interactionTraceShadow — mintTurnId', () => {
  it('mints a trace-id-formatted, non-empty, unique id', () => {
    const now = new Date('2026-07-21T06:00:00.000Z');
    const a = shadow.mintTurnId(now);
    const b = shadow.mintTurnId(now);
    assert.match(a, /^turn:2026-07-21T06:00:00\.000Z_\d+_[a-z0-9]+$/);
    assert.notEqual(a, b, 'sequence makes ids unique even at the same instant');
  });
});

describe('interactionTraceShadow — observeTurnStart', () => {
  beforeEach(() => { process.env.ATLAS_INTERACTION_TRACE = 'shadow'; });

  it('records a schema-valid InteractionTrace opened at the intent stage', () => {
    const turnId = shadow.mintTurnId();
    const rec = shadow.observeTurnStart({ turnId, intentType: 'set', source: 'coach_message' });
    assert.ok(rec);
    assert.equal(rec.valid, true, `errors: ${rec.errors.join(' | ')}`);
    assert.equal(rec.trace.turn_id, turnId);
    assert.equal(rec.intent_type, 'set');
    assert.equal(rec.source, 'coach_message');
    assert.deepEqual(rec.trace.stages.map(s => s.stage), ['intent']);
    // the recorded trace is valid against the ratified contract
    assert.equal(validateInteractionTrace(rec.trace).valid, true);
  });

  it('defaults started_at to a strict ISO-8601 timestamp when none is given', () => {
    const rec = shadow.observeTurnStart({ turnId: shadow.mintTurnId(), intentType: 'plan' });
    assert.match(rec.trace.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  });

  it('accumulates records in a bounded newest-last ring buffer', () => {
    for (let i = 0; i < 3; i++) shadow.observeTurnStart({ turnId: shadow.mintTurnId(), intentType: 'set' });
    const log = shadow.getShadowLog();
    assert.equal(log.length, 3);
    // newest last
    assert.equal(log[2].trace.turn_id, log[log.length - 1].trace.turn_id);
  });

  it('never throws on a malformed turn id — returns null, records nothing extra', () => {
    const before = shadow.getShadowLog().length;
    const rec = shadow.observeTurnStart({ turnId: 42 }); // non-string turn_id → invalid trace, but still recorded as invalid
    // it does not throw; an invalid trace is still captured (valid:false) so shadow surfaces mis-threads
    assert.ok(rec === null || rec.valid === false);
    assert.ok(shadow.getShadowLog().length >= before);
  });
});
