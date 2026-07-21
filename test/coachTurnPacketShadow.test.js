'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const packetShadow = require('../services/coachTurnPacketShadow');
const { validateCoachTurnPacket } = require('../services/coachTurnPacket');

const ENV = process.env.ATLAS_INTERACTION_TRACE;
const GOAL = process.env.ATLAS_PROFILE_GOAL;
beforeEach(() => packetShadow._resetForTesting());
afterEach(() => {
  if (ENV === undefined) delete process.env.ATLAS_INTERACTION_TRACE; else process.env.ATLAS_INTERACTION_TRACE = ENV;
  if (GOAL === undefined) delete process.env.ATLAS_PROFILE_GOAL; else process.env.ATLAS_PROFILE_GOAL = GOAL;
});

describe('coachTurnPacketShadow — assembleShadowPacket', () => {
  it('assembles a structurally complete, schema-valid CoachTurnPacket keyed by the turn id', () => {
    const { packet, valid, errors } = packetShadow.assembleShadowPacket({ turnId: 'turn:2026-07-21T06:00:00.000Z_1_abc', profileGoal: 'strength' });
    assert.equal(valid, true, `errors: ${errors.join(' | ')}`);
    assert.equal(validateCoachTurnPacket(packet).valid, true);
    assert.equal(packet.turn_id, 'turn:2026-07-21T06:00:00.000Z_1_abc');
    // Every embedded field is PRESENT (explicit-null rule) — the packet is structurally full.
    for (const k of ['athlete', 'session', 'exercises', 'decision', 'safety', 'closeout']) {
      assert.ok(Object.prototype.hasOwnProperty.call(packet, k), `packet must carry ${k}`);
    }
  });

  it('populates athlete.profile_goal from the (already canonical) profile goal; leaves the rest null/[]', () => {
    const { packet, valid } = packetShadow.assembleShadowPacket({ turnId: 'turn:x_1_a', profileGoal: 'hypertrophy' });
    assert.equal(valid, true);
    assert.equal(packet.athlete.profile_goal, 'hypertrophy');
    assert.equal(packet.session, null, 'session is null (H-08, Phase 4)');
    assert.deepEqual(packet.exercises, [], 'exercises is empty (no canonical identity registry, H-11)');
    assert.equal(packet.decision, null, 'decision is null (route-local recomputation, H-03, Phase 4)');
    assert.equal(packet.safety, null, 'safety is null (route-local classifier, H-12, Phase 5d)');
    assert.equal(packet.closeout, null, 'closeout is null (not a closeout turn)');
  });

  it('a null profile goal still yields a valid packet (all-null-but-present athlete)', () => {
    const { packet, valid } = packetShadow.assembleShadowPacket({ turnId: 'turn:x_2_a', profileGoal: null });
    assert.equal(valid, true);
    assert.equal(packet.athlete.profile_goal, null);
  });

  it('a non-canonical turn id (empty) makes the packet invalid — surfaced, never hidden', () => {
    const { valid, errors } = packetShadow.assembleShadowPacket({ turnId: '', profileGoal: 'strength' });
    assert.equal(valid, false);
    assert.ok(errors.some((e) => /turn_id/.test(e)));
  });
});

describe('coachTurnPacketShadow — summarizeVisible (bounded/redacted)', () => {
  it('reports presence and shape only — never the prose text', () => {
    const s = packetShadow.summarizeVisible({ data: { message: 'Nice work on that squat PR.', source: 'gemini', configured: true, note_tier: null, kind: 'set' } });
    assert.equal(s.message_present, true);
    assert.equal(s.message_len, 'Nice work on that squat PR.'.length);
    assert.equal(s.source, 'gemini');
    assert.equal(s.configured, true);
    assert.equal(s.kind, 'set');
    assert.equal(s.error_present, false);
    // The prose itself must not appear anywhere in the summary.
    assert.ok(!JSON.stringify(s).includes('squat'), 'the summary must not carry the coaching prose');
  });

  it('a silent (null-message) response reports message_present:false', () => {
    const s = packetShadow.summarizeVisible({ data: { message: null, source: 'gemini', configured: true } });
    assert.equal(s.message_present, false);
    assert.equal(s.message_len, 0);
  });

  it('a degrade/error response reports error_present:true', () => {
    const s = packetShadow.summarizeVisible({ data: { message: null, configured: true, error: 'gemini exploded' } });
    assert.equal(s.error_present, true);
  });

  it('tolerates a malformed body', () => {
    assert.equal(packetShadow.summarizeVisible(null).message_present, false);
    assert.equal(packetShadow.summarizeVisible({}).source, null);
  });
});

describe('coachTurnPacketShadow — observe (packet vs visible side by side)', () => {
  beforeEach(() => { process.env.ATLAS_INTERACTION_TRACE = 'shadow'; });

  const TRACE_REC = {
    trace: { turn_id: 'turn:x_9_z', stages: [{ stage: 'intent', status: 'ok' }, { stage: 'rendered_output', status: 'ok' }] },
    valid: true,
    missing: ['parser', 'knowledge_retrieval', 'write_proof'],
  };

  it('is inert unless the shadow flag is set', () => {
    delete process.env.ATLAS_INTERACTION_TRACE;
    const assembled = packetShadow.assembleShadowPacket({ turnId: 'turn:x_9_z', profileGoal: 'strength' });
    assert.equal(packetShadow.observe({ trace: TRACE_REC, assembled, visible: { data: { message: 'x' } } }), null);
    assert.deepEqual(packetShadow.getShadowLog(), []);
  });

  it('records a self-contained side-by-side record (packet summary + visible + trace)', () => {
    const assembled = packetShadow.assembleShadowPacket({ turnId: 'turn:x_9_z', profileGoal: 'strength' });
    const rec = packetShadow.observe({ trace: TRACE_REC, assembled, visible: { data: { message: 'Solid.', source: 'gemini', configured: true, kind: 'set' } } });
    assert.ok(rec);
    assert.equal(rec.turn_id, 'turn:x_9_z');
    assert.equal(rec.packet_valid, true);
    assert.deepEqual(rec.packet_errors, []);
    // embedded facts: athlete carried (profile_goal present), everything else bypassed.
    assert.equal(rec.embedded.athlete, true);
    assert.equal(rec.embedded.athlete_profile_goal, true);
    assert.equal(rec.embedded.session, false);
    assert.equal(rec.embedded.exercises, 0);
    assert.equal(rec.embedded.decision, false);
    assert.equal(rec.embedded.safety, false);
    assert.equal(rec.embedded.closeout, false);
    // visible + trace joined by the same turn id.
    assert.equal(rec.visible.source, 'gemini');
    assert.deepEqual(rec.trace.missing, ['parser', 'knowledge_retrieval', 'write_proof']);
    assert.deepEqual(rec.trace.stages.map((s) => s.stage), ['intent', 'rendered_output']);
    // newest-last ring buffer
    assert.equal(packetShadow.getShadowLog().length, 1);
  });

  it('records an invalid packet honestly (packet_valid:false + errors)', () => {
    const assembled = packetShadow.assembleShadowPacket({ turnId: '', profileGoal: 'strength' });
    const rec = packetShadow.observe({ trace: null, assembled, visible: { data: {} } });
    assert.equal(rec.packet_valid, false);
    assert.ok(rec.packet_errors.length >= 1);
  });

  it('never throws on malformed inputs', () => {
    assert.doesNotThrow(() => packetShadow.observe({}));
    assert.doesNotThrow(() => packetShadow.observe(null));
  });
});
