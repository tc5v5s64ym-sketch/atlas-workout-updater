'use strict';

// Drift Guard 5 self-test — proves the packet & trace honesty guard actually BITES on a
// synthetic overclaim (a real failing check, not a tautology), and that the real shadow
// assembler is clean today.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { analyze, checkPacketHonesty, checkTraceHonesty } = require('../scripts/check-packet-trace');

describe('Drift Guard 5 — packet & trace honesty', () => {
  it('the REAL shadow assembler is honest (analyze passes clean)', () => {
    const { ok, violations, checked } = analyze();
    assert.equal(ok, true, `unexpected violations: ${violations.join(' | ')}`);
    assert.ok(checked >= 5, 'a representative matrix is checked');
  });

  it('BITES: a session claimed present while it does not validate is an overclaim', () => {
    const packet = { athlete: null, session: { schema_version: 1, session_id: null, slots: [{ name: 'X', status: 'bogus' }] }, exercises: [], decision: null, safety: null, closeout: null };
    const claim = { athlete: false, session: true, exercises: 0, decision: false, safety: false, closeout: false };
    const v = checkPacketHonesty(packet, claim);
    assert.ok(v.some((s) => /embedded\.session/.test(s)), 'the guard flags the session overclaim');
  });

  it('BITES: a decision claimed present while it does not validate is an overclaim (H-03)', () => {
    // A route-local decision shape dressed up as canonical — embedded.decision true while the
    // object fails validateCoachingDecision. As the live route consumes packet.decision (H-03),
    // this is the overclaim the guard must catch.
    const packet = { athlete: null, session: null, exercises: [], decision: { decision_type: 'not_a_real_type' }, safety: null, closeout: null };
    const claim = { athlete: false, session: false, exercises: 0, decision: true, safety: false, closeout: false };
    const v = checkPacketHonesty(packet, claim);
    assert.ok(v.some((s) => /embedded\.decision/.test(s)), 'the guard flags the decision overclaim');
  });

  it('does NOT flag a genuinely-valid embedded decision (H-03, no overclaim)', () => {
    const { buildRecoveryDecision } = require('../services/coachDecisionSnapshot');
    const decision = buildRecoveryDecision({ engine_grounded: true, fatigueStatus: { status: 'high' }, daysSinceLastSession: 1 });
    const packet = { athlete: null, session: null, exercises: [], decision, safety: null, closeout: null };
    const claim = { athlete: false, session: false, exercises: 0, decision: true, safety: false, closeout: false };
    assert.deepEqual(checkPacketHonesty(packet, claim), [], 'a validating decision claimed present is honest');
  });

  it('BITES: an exercises count exceeding the genuinely-valid identities is an overclaim', () => {
    const packet = { session: null, exercises: [{ not: 'a valid identity' }], decision: null, safety: null, closeout: null };
    const claim = { athlete: false, session: false, exercises: 1, decision: false, safety: false, closeout: false };
    const v = checkPacketHonesty(packet, claim);
    assert.ok(v.some((s) => /embedded\.exercises/.test(s)), 'the guard flags the exercises overclaim');
  });

  it('does NOT flag an UNDERclaim (a valid fact reported absent is safe — H-05/H-15)', () => {
    // A valid-ish structure reported as NOT present must not be a violation (understating is safe).
    const packet = { session: null, exercises: [], decision: null, safety: null, closeout: null };
    const claim = { athlete: false, session: false, exercises: 0, decision: false, safety: false, closeout: false };
    assert.deepEqual(checkPacketHonesty(packet, claim), []);
  });

  it('BITES: an emitted trace whose missing list is hard-coded empty despite omitted stages (Codex #1150 P2)', () => {
    // Simulates a broken finish() that emits `missing: []` while stages were omitted.
    const lying = { valid: true, missing: [], trace: { stages: [{ stage: 'intent' }, { stage: 'rendered_output' }] } };
    const v = checkTraceHonesty(lying);
    assert.ok(v.some((s) => /missing-stage list is dishonest/.test(s)), 'the guard flags the dishonest missing list');
  });

  it('checkTraceHonesty passes an honest emitted record (missing == the omitted stages)', () => {
    const { STAGES } = require('../services/interactionTrace');
    const stages = [{ stage: 'intent' }, { stage: 'rendered_output' }];
    const honest = { valid: true, trace: { stages }, missing: STAGES.filter((s) => s !== 'intent' && s !== 'rendered_output') };
    assert.deepEqual(checkTraceHonesty(honest), []);
  });
});
