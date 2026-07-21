'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const shadow = require('../services/interactionTraceShadow');
const { validateInteractionTrace, missingStages } = require('../services/interactionTrace');

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
    const turn = shadow.beginTurn({ intentType: 'set' });
    assert.equal(turn.enabled, false);
    turn.stage('intent', 'ok').stage('session_snapshot', 'ok');
    assert.equal(turn.finish(), null, 'a disabled turn records nothing');
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

describe('interactionTraceShadow — beginTurn spanning trace', () => {
  beforeEach(() => { process.env.ATLAS_INTERACTION_TRACE = 'shadow'; });

  // The canonical spine a real (Gemini-up) coach turn threads through. parser,
  // knowledge_retrieval, and write_proof are legitimately absent on the read-only
  // coach route and surface in `missing`.
  const FULL_SPINE = ['intent', 'session_snapshot', 'engine_decision', 'coaching_strategy', 'model_response', 'validator_result', 'rendered_output'];

  function recordFullTurn(turn) {
    turn.stage('intent', 'ok');
    turn.stage('session_snapshot', 'ok');
    turn.stage('engine_decision', 'ok');
    turn.stage('coaching_strategy', 'ok');
    turn.stage('model_response', 'ok');
    turn.stage('validator_result', 'ok');
    turn.stage('rendered_output', 'ok');
    return turn.finish();
  }

  it('assembles a schema-valid trace spanning every stage the turn passed through', () => {
    const turn = shadow.beginTurn({ intentType: 'set', source: 'coach_message' });
    const rec = recordFullTurn(turn);
    assert.ok(rec);
    assert.equal(rec.valid, true, `errors: ${rec.errors.join(' | ')}`);
    assert.deepEqual(rec.trace.stages.map((s) => s.stage), FULL_SPINE);
    assert.equal(rec.intent_type, 'set');
    assert.equal(rec.source, 'coach_message');
    assert.equal(validateInteractionTrace(rec.trace).valid, true);
  });

  it('carries ONE minted turn id across every stage', () => {
    const turn = shadow.beginTurn({ intentType: 'set' });
    assert.match(turn.turnId, /^turn:/);
    const rec = recordFullTurn(turn);
    assert.equal(rec.trace.turn_id, turn.turnId, 'the whole span is keyed by the single minted id');
  });

  it('reports the stages the turn bypassed as `missing` (raw material for the divergence report)', () => {
    const turn = shadow.beginTurn({ intentType: 'set' });
    const rec = recordFullTurn(turn);
    // A read-only coach turn skips parser (client parses), knowledge_retrieval (Phase 6),
    // and write_proof (this route never writes).
    assert.deepEqual(rec.missing, ['parser', 'knowledge_retrieval', 'write_proof']);
    assert.deepEqual(rec.missing, missingStages(rec.trace));
  });

  it('records stage status honestly — an enrichment failure marks session_snapshot error', () => {
    const turn = shadow.beginTurn({ intentType: 'set' });
    turn.stage('intent', 'ok');
    turn.stage('session_snapshot', 'error');
    turn.stage('rendered_output', 'ok');
    const rec = turn.finish();
    assert.equal(rec.valid, true);
    assert.equal(rec.trace.stages.find((s) => s.stage === 'session_snapshot').status, 'error');
  });

  it('an out-of-canonical-order thread surfaces as valid:false (never hidden)', () => {
    const turn = shadow.beginTurn({ intentType: 'set' });
    turn.stage('rendered_output', 'ok'); // recorded before its predecessors — a real mis-thread
    turn.stage('intent', 'ok');
    const rec = turn.finish();
    assert.equal(rec.valid, false, 'an impossible ordering must not validate as a span');
  });

  it('is idempotent — a second finish is a no-op, and stages after finish are ignored', () => {
    const turn = shadow.beginTurn({ intentType: 'set' });
    turn.stage('intent', 'ok');
    const first = turn.finish();
    assert.ok(first);
    assert.equal(turn.finish(), null, 'a second finish records nothing');
    turn.stage('rendered_output', 'ok'); // ignored — the turn is closed
    assert.equal(shadow.getShadowLog().length, 1);
  });

  it('dedups a repeated stage — the first write wins', () => {
    const turn = shadow.beginTurn({ intentType: 'set' });
    turn.stage('intent', 'ok');
    turn.stage('session_snapshot', 'ok');
    turn.stage('session_snapshot', 'error'); // ignored
    const rec = turn.finish();
    assert.equal(rec.trace.stages.filter((s) => s.stage === 'session_snapshot').length, 1);
    assert.equal(rec.trace.stages.find((s) => s.stage === 'session_snapshot').status, 'ok');
  });

  it('accumulates records in a bounded newest-last ring buffer', () => {
    for (let i = 0; i < 3; i++) {
      const t = shadow.beginTurn({ intentType: 'set' });
      t.stage('intent', 'ok');
      t.finish();
    }
    const log = shadow.getShadowLog();
    assert.equal(log.length, 3);
    assert.equal(log[2].trace.turn_id, log[log.length - 1].trace.turn_id);
  });

  it('defaults started_at to a strict ISO-8601 timestamp when none is given', () => {
    const turn = shadow.beginTurn({ intentType: 'plan' });
    turn.stage('intent', 'ok');
    const rec = turn.finish();
    assert.match(rec.trace.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  });
});
