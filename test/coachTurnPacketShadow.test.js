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

describe('coachTurnPacketShadow — assembleShadowPacket embeds the canonical session (H-08A)', () => {
  const { buildCanonicalSessionSnapshot } = require('../services/coachSessionSnapshot');
  const session = () => buildCanonicalSessionSnapshot({ active_session: { exercises: [
    { name: 'Back Squat', liftCode: 'SQ', status: 'completed', source: 'planned' },
    { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'substituted' },
    { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'planned' },
  ] } });

  it('a valid canonical session produces packet.session !== null, still schema-valid', () => {
    const { packet, valid } = packetShadow.assembleShadowPacket({ turnId: 'turn:x_1_a', profileGoal: 'strength', session: session() });
    assert.equal(valid, true);
    assert.notEqual(packet.session, null, 'the canonical session is embedded');
    assert.equal(validateCoachTurnPacket(packet).valid, true);
    // slot identity survives into the packet: order + duplicate slots preserved.
    assert.deepEqual(packet.session.slots.map((s) => s.name), ['Back Squat', 'Bench Press', 'Bench Press']);
    assert.equal(packet.session.slots[0].status, 'completed');
    assert.equal(packet.session.slots[1].source, 'substituted');
  });

  it('embedding the session leaves exercises/decision/safety/closeout honestly empty', () => {
    const { packet } = packetShadow.assembleShadowPacket({ turnId: 'turn:x_1_b', profileGoal: 'strength', session: session() });
    assert.deepEqual(packet.exercises, []);
    assert.equal(packet.decision, null);
    assert.equal(packet.safety, null);
    assert.equal(packet.closeout, null);
  });

  it('an absent session keeps packet.session === null (unchanged prior behavior)', () => {
    const { packet, valid } = packetShadow.assembleShadowPacket({ turnId: 'turn:x_1_c', profileGoal: 'strength' });
    assert.equal(valid, true);
    assert.equal(packet.session, null);
  });

  it('a valid canonical decision produces packet.decision !== null, still schema-valid (H-03)', () => {
    const { buildCoachingDecisionFromExplanation } = require('../services/coachDecisionSnapshot');
    const decision = buildCoachingDecisionFromExplanation({ coaching_strategy: 'explain_recommendation', label: 'Upper', target: { name: 'Bench' }, history: { last_date: '2026-07-20' } });
    const { packet, valid } = packetShadow.assembleShadowPacket({ turnId: 'turn:x_1_e', profileGoal: 'strength', decision });
    assert.equal(valid, true);
    assert.notEqual(packet.decision, null, 'the canonical decision is embedded');
    assert.equal(packet.decision.decision_type, 'progress_readout');
    assert.equal(validateCoachTurnPacket(packet).valid, true);
    // the OTHER embedded facts stay honestly empty
    assert.deepEqual(packet.exercises, []);
    assert.equal(packet.safety, null);
    assert.equal(packet.closeout, null);
  });

  it('an INVALID decision is honestly dropped to null (never a half-populated packet.decision)', () => {
    const bad = { schema_version: 1, decision_type: 'bogus', intent: {}, confidence: {}, safety: {}, payload: {}, missing_info: [], explanation_inputs: {}, provenance: { modules_run: [], skipped: [] } };
    const { packet, valid } = packetShadow.assembleShadowPacket({ turnId: 'turn:x_1_f', profileGoal: 'strength', decision: bad });
    assert.equal(packet.decision, null, 'a decision that does not validate is not embedded');
    assert.equal(valid, true, 'the packet itself stays valid (decision honestly null)');
  });

  it('an INVALID session is honestly dropped to null (never a half-populated packet.session)', () => {
    const bad = { schema_version: 1, session_id: null, slots: [{ name: 'Bench', status: 'bogus' }] };
    const { packet, valid } = packetShadow.assembleShadowPacket({ turnId: 'turn:x_1_d', profileGoal: 'strength', session: bad });
    assert.equal(packet.session, null, 'a session that does not validate is not embedded');
    assert.equal(valid, true, 'the packet itself stays valid (session honestly null)');
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

  it('records embedded.session:true when a canonical session was embedded (H-08A)', () => {
    const { buildCanonicalSessionSnapshot } = require('../services/coachSessionSnapshot');
    const session = buildCanonicalSessionSnapshot({ active_session: { exercises: [
      { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'planned' },
    ] } });
    const assembled = packetShadow.assembleShadowPacket({ turnId: 'turn:x_9_z', profileGoal: 'strength', session });
    const rec = packetShadow.observe({ trace: TRACE_REC, assembled, visible: { data: { message: 'x' } } });
    assert.equal(rec.packet_valid, true);
    assert.equal(rec.embedded.session, true, 'the shadow record reports the embedded session');
    // the other embedded facts stay honestly empty
    assert.equal(rec.embedded.exercises, 0);
    assert.equal(rec.embedded.decision, false);
  });

  it('carries the route referent pick vs the packet referent (null when no session carries it)', () => {
    const assembled = packetShadow.assembleShadowPacket({ turnId: 'turn:x_9_z', profileGoal: 'strength' });
    const rec = packetShadow.observe({
      trace: TRACE_REC,
      assembled,
      visible: { data: { message: 'The current plan shows Bench Press…', source: 'engine', configured: true } },
      routeReferent: { route: 'BENCHPRESS', is_dispute: true },
    });
    assert.ok(rec.referent, 'the record carries a referent block');
    assert.equal(rec.referent.route, 'BENCHPRESS', 'the route pick is recorded');
    assert.equal(rec.referent.packet, null, 'no session ⇒ the packet carries no referent');
    assert.equal(rec.referent.is_dispute, true);
  });

  it('D10: a session carrying discussion_referent makes referent.packet == the route pick (route-local cleared)', () => {
    const { buildCanonicalSessionSnapshot } = require('../services/coachSessionSnapshot');
    const session = buildCanonicalSessionSnapshot({ active_session: { exercises: [
      { name: 'Bench Press', liftCode: '', status: 'pending', source: 'planned' },
    ] } }, { discussion_referent: 'BENCHPRESS' });
    const assembled = packetShadow.assembleShadowPacket({ turnId: 'turn:x_9_z', profileGoal: 'strength', session });
    const rec = packetShadow.observe({ trace: TRACE_REC, assembled, visible: { data: { message: 'x' } }, routeReferent: { route: 'BENCHPRESS', is_dispute: false } });
    assert.equal(rec.referent.route, 'BENCHPRESS');
    assert.equal(rec.referent.packet, 'BENCHPRESS', 'the packet now carries the referent (D10)');
    assert.equal(rec.embedded.session, true);
  });

  it('defaults the referent block to nulls when the route recorded none', () => {
    const assembled = packetShadow.assembleShadowPacket({ turnId: 'turn:x_9_z', profileGoal: 'strength' });
    const rec = packetShadow.observe({ trace: TRACE_REC, assembled, visible: { data: { message: 'x' } } });
    assert.deepEqual(rec.referent, { route: null, packet: null, is_dispute: false });
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
