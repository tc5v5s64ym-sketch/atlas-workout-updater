'use strict';

// Drift Guard 5 — packet & trace shadow honesty guard.
//
// Contract (Phase 4; Drift Guards §5): the CoachTurnPacket / InteractionTrace shadow can
// NEVER claim a fact it cannot back with a validating canonical contract object. This is the
// permanent tripwire for the disease this whole campaign cures (H-05/H-15): understating is
// safe; overstating is the failure. As Phases 4–5 populate the packet's embedded facts
// (session → H-08, decision → H-03, safety → H-12, exercises → H-11), each new fact must be
// claimed present ONLY when it validates under its own contract — never a route-local shape
// dressed up as canonical.
//
// The guard runs the REAL services/coachTurnPacketShadow.assembleShadowPacket over a fixed
// input matrix and asserts:
//   (a) VALIDITY HONESTY — an `assembled.valid` of true is truthful: validateCoachTurnPacket
//       agrees. The shadow never reports a silently-invalid packet as valid.
//   (b) ANTI-OVERCLAIM — the shadow's `_embeddedFields` presence flags never exceed contract
//       validity: `embedded.<fact> === true` implies packet.<fact> validates under its own
//       canonical validator, and `embedded.exercises` equals the count of genuinely-valid
//       ExerciseIdentity entries. An UNDERclaim (a valid fact reported absent) is safe and is
//       NOT flagged — only overclaims are.
//   (c) TRACE HONESTY — a record from the REAL shadow emitter (interactionTraceShadow.beginTurn
//       /finish, not just the contract helper) validates and its EMITTED `missing` list is
//       exactly the canonical stages it did not record — so a stale/hard-coded missing list in
//       the production finish() path cannot slip past (Codex #1150 P2).
// The two contract files must also load and be versioned (schema_version === 1).
//
// The honesty CHECKER (`checkPacketHonesty`) is exported so the self-test
// (test/packetTraceGuard.test.js) can feed a SYNTHETIC overclaim (embedded.session true while
// packet.session is invalid) and prove the guard actually bites — a real failing check, not a
// tautology.
//
// Read-only, deterministic, no network. Exit 0 = clean, 1 = violations.

const path = require('node:path');
const fs   = require('node:fs');

const { assembleShadowPacket, _embeddedFields } = require('../services/coachTurnPacketShadow');
const { validateCoachTurnPacket }     = require('../services/coachTurnPacket');
const { fromActiveSession, validateWorkoutSession } = require('../services/workoutSession');
const { validateAthleteContext }      = require('../services/athleteContext');
const { validateExerciseIdentity }    = require('../services/exerciseIdentity');
const { validateCoachingDecision }    = require('../services/coachingDecision');
const { buildRecoveryDecision }       = require('../services/coachDecisionSnapshot');
const { validateSafetyDecision }      = require('../services/safetyDecision');
const { validateCloseoutTransaction } = require('../services/closeoutTransaction');
const { STAGES } = require('../services/interactionTrace');
const interactionTraceShadow = require('../services/interactionTraceShadow');

const ROOT = path.join(__dirname, '..');
const PACKET_CONTRACT = path.join(ROOT, 'config', 'coaching', 'contracts', 'coach-turn-packet.contract.json');
const TRACE_CONTRACT  = path.join(ROOT, 'config', 'coaching', 'contracts', 'interaction-trace.contract.json');

// The anti-overclaim CHECKER (H-05/H-15). Given a packet and the shadow's embedded-presence
// `claim`, return every place the claim OVERSTATES — a fact reported present that does NOT
// validate under its own canonical contract. Understating is safe, so it is never flagged.
function checkPacketHonesty(packet, claim) {
  const p = packet && typeof packet === 'object' ? packet : {};
  const c = claim && typeof claim === 'object' ? claim : {};
  const violations = [];
  const overclaims = (present, obj, validate, name) => {
    if (present && !(obj != null && typeof obj === 'object' && validate(obj).valid)) {
      violations.push(`embedded.${name} is claimed present but does not validate under its contract`);
    }
  };
  overclaims(c.athlete,  p.athlete,  validateAthleteContext,     'athlete');
  overclaims(c.session,  p.session,  validateWorkoutSession,     'session');
  overclaims(c.decision, p.decision, validateCoachingDecision,   'decision');
  overclaims(c.safety,   p.safety,   validateSafetyDecision,     'safety');
  overclaims(c.closeout, p.closeout, validateCloseoutTransaction, 'closeout');
  // exercises: the claimed count must equal the number of GENUINELY-VALID ExerciseIdentity
  // entries — a name/slug slice masquerading as an identity is an overclaim.
  const validEx = Array.isArray(p.exercises) ? p.exercises.filter((e) => e && typeof e === 'object' && validateExerciseIdentity(e).valid).length : 0;
  if (typeof c.exercises === 'number' && c.exercises > validEx) {
    violations.push(`embedded.exercises claims ${c.exercises} identities but only ${validEx} validate`);
  }
  return violations;
}

// Produce ONE representative shadow InteractionTrace record through the REAL emitter
// (interactionTraceShadow.beginTurn/finish), flag forced on locally then restored, console
// output suppressed so the guard stays quiet. Returns the emitted record (or an {_error} marker).
function _emitShadowTrace(recordedStages) {
  const prevFlag = process.env.ATLAS_INTERACTION_TRACE;
  const prevLog = console.log;
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  console.log = () => {};
  try {
    interactionTraceShadow._resetForTesting();
    const turn = interactionTraceShadow.beginTurn({ intentType: 'guard', source: 'packet-trace-guard' });
    for (const s of recordedStages) turn.stage(s, 'ok');
    return turn.finish();
  } catch (e) {
    return { _error: e && e.message ? e.message : String(e) };
  } finally {
    console.log = prevLog;
    if (prevFlag === undefined) delete process.env.ATLAS_INTERACTION_TRACE; else process.env.ATLAS_INTERACTION_TRACE = prevFlag;
    interactionTraceShadow._resetForTesting();
  }
}

// Trace honesty CHECKER (H-14): an EMITTED shadow record's `missing` list must be EXACTLY the
// canonical stages its own trace did not record. Exercising the real record (not just the
// contract helper) catches a stale/hard-coded missing list in the production finish() path
// (Codex #1150 P2). Returns violations.
function checkTraceHonesty(record) {
  const violations = [];
  if (!record || record._error) {
    violations.push(`shadow trace record was not emitted: ${record && record._error ? record._error : 'null'}`);
    return violations;
  }
  if (record.valid !== true || !record.trace || !Array.isArray(record.trace.stages)) {
    violations.push('emitted shadow trace record does not validate');
    return violations;
  }
  const recordedStages = record.trace.stages.map((s) => s && s.stage);
  const expected = STAGES.filter((s) => !recordedStages.includes(s));
  const missing = Array.isArray(record.missing) ? record.missing : null;
  if (missing === null || JSON.stringify(missing) !== JSON.stringify(expected)) {
    violations.push(`emitted trace missing-stage list is dishonest: got ${JSON.stringify(missing)}, expected ${JSON.stringify(expected)}`);
  }
  return violations;
}

function analyze() {
  const violations = [];
  let checked = 0;

  // The two contract files load and are versioned.
  for (const [name, file] of [['coach-turn-packet', PACKET_CONTRACT], ['interaction-trace', TRACE_CONTRACT]]) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (c.schema_version !== 1) violations.push(`${name} contract: schema_version must be 1`);
    } catch (e) {
      violations.push(`${name} contract failed to load: ${e.message}`);
    }
  }

  // A representative input matrix through the REAL shadow assembler.
  const goodSession = fromActiveSession({ exercises: [
    { name: 'Bench Press', liftCode: '', status: 'pending', source: 'planned' },
  ] }, { discussion_referent: 'BENCHPRESS' });
  const badSession = { schema_version: 1, session_id: null, slots: [{ name: 'X', status: 'bogus', source: 'planned', lift_code: null, sets_logged: 0, sets_target: null }] };
  // A genuinely-valid canonical decision (the recovery decision the live route now consumes,
  // H-03) and a malformed one — so the matrix exercises the packet.decision embed path, not only
  // session. A valid decision must embed AND validate (no overclaim); an invalid decision must be
  // dropped to null (embedded.decision false — an honest underclaim, never an overclaim).
  const goodDecision = buildRecoveryDecision({ engine_grounded: true, fatigueStatus: { status: 'high' }, daysSinceLastSession: 2, readiness: [{ pattern: 'push', status: 'fatigued' }] });
  const badDecision = { schema_version: 1, decision_type: 'not_a_real_type', intent: {}, confidence: {}, safety: {}, payload: {}, explanation_inputs: {} };
  const inputs = [
    { label: 'no session', params: { turnId: 'turn:g_1_a', profileGoal: 'strength' } },
    { label: 'null profile goal', params: { turnId: 'turn:g_2_a', profileGoal: null } },
    { label: 'valid session + referent', params: { turnId: 'turn:g_3_a', profileGoal: 'strength', session: goodSession } },
    { label: 'invalid session (must drop to null)', params: { turnId: 'turn:g_4_a', profileGoal: 'strength', session: badSession } },
    { label: 'valid decision (must embed + validate)', params: { turnId: 'turn:g_5_a', profileGoal: 'strength', decision: goodDecision } },
    { label: 'invalid decision (must drop to null)', params: { turnId: 'turn:g_6_a', profileGoal: 'strength', decision: badDecision } },
    { label: 'valid session + valid decision together', params: { turnId: 'turn:g_7_a', profileGoal: 'strength', session: goodSession, decision: goodDecision } },
  ];
  for (const { label, params } of inputs) {
    const assembled = assembleShadowPacket(params);
    checked += 1;
    // (a) validity honesty
    if (assembled.valid !== validateCoachTurnPacket(assembled.packet).valid) {
      violations.push(`[${label}] assembled.valid (${assembled.valid}) disagrees with validateCoachTurnPacket`);
    }
    // (b) anti-overclaim over the shadow's OWN presence computation
    for (const v of checkPacketHonesty(assembled.packet, _embeddedFields(assembled.packet))) {
      violations.push(`[${label}] ${v}`);
    }
  }

  // (c) trace honesty — exercise the REAL shadow emitter (beginTurn/finish), not just the
  // contract helper, so a stale/hard-coded missing-stage list in the production finish() path
  // is caught (Codex #1150 P2). Compare the EMITTED record.missing to the canonical complement
  // of the record's own recorded stages.
  const record = _emitShadowTrace(['intent', 'session_snapshot', 'rendered_output']);
  checked += 1;
  for (const v of checkTraceHonesty(record)) violations.push(v);

  return { ok: violations.length === 0, violations, checked };
}

module.exports = { analyze, checkPacketHonesty, checkTraceHonesty };

if (require.main === module) {
  const { ok, violations, checked } = analyze();
  if (ok) {
    console.log(`✅ Drift Guard 5 (packet & trace honesty) OK — ${checked} shadow assemblies/traces checked; no packet overclaims a fact its contract does not validate.`);
    process.exit(0);
  }
  console.error('❌ Drift Guard 5 (packet & trace honesty) FAILED:');
  for (const v of violations) console.error(`  • ${v}`);
  process.exit(1);
}
