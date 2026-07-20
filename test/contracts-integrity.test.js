'use strict';

// Contracts-integrity guard — the "one Brain" standing test.
//
// Enforces that the three coaching contracts (IntentEnvelope, CapabilityManifest,
// CoachingDecision) stay mutually consistent. If a future change breaks the
// one-Brain property — an intent without a manifest entry, a manifest pointing
// at a non-existent decision_type, a caveat enum drifting from its producer,
// a decision fixture that no longer validates — this fails before merge.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const intentVocab = require('../config/coaching/contracts/intent.vocabulary.json');
const decisionContract = require('../config/coaching/contracts/decision.contract.json');
const intentCaps = require('../config/coaching/manifests/intent-capabilities.json');

const manifest = require('../services/capabilityManifest');
const { validateCoachingDecision } = require('../services/coachingDecision');
const { CAVEAT_KEYS: CONF_CAVEATS } = require('../services/confidenceModule');
const { validateExerciseIdentity, MOVEMENT_PATTERNS } = require('../services/exerciseIdentity');
const movementPatterns = require('../config/coaching/movement-patterns/patterns.json');
const exerciseSchema = require('../config/coaching/schemas/exercise.schema.json');
const { validateAthleteContext, buildAthleteContext, CANONICAL_GOALS } = require('../services/athleteContext');
const { TRAINING_GOALS } = require('../services/trainingKnowledge');
const workoutSession = require('../services/workoutSession');
const interactionTrace = require('../services/interactionTrace');
const safetyDecision = require('../services/safetyDecision');
const safetyRules = require('../config/coaching/rules/safety.rules.json');
const safetyRuleSchema = require('../config/coaching/schemas/safety-rule.schema.json');
const { classifyTrafficLight } = require('../services/safetyClassifierModule');
const closeoutTransaction = require('../services/closeoutTransaction');
const { buildCloseoutSummary } = require('../services/closeoutSummary');
const coachTurnPacket = require('../services/coachTurnPacket');

before(() => manifest._resetForTesting());

// ─── every intent has a manifest entry ───────────────────────────────────────

describe('integrity — intent vocabulary ↔ capability manifest', () => {
  it('every IntentEnvelope intent type has a manifest entry', () => {
    const manifested = new Set(manifest.listIntents());
    for (const type of intentVocab.intent_types) {
      assert.ok(manifested.has(type), `intent '${type}' has no manifest entry`);
    }
  });
  it('every manifest intent is a real vocabulary intent (no orphans)', () => {
    const vocab = new Set(intentVocab.intent_types);
    for (const type of manifest.listIntents()) {
      assert.ok(vocab.has(type), `manifest intent '${type}' is not in the intent vocabulary`);
    }
  });
  it('the manifest validates clean', () => {
    const r = manifest.validateManifest();
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('every intent resolves without throwing', () => {
    for (const type of intentVocab.intent_types) {
      assert.doesNotThrow(() => manifest.resolve(type));
      assert.ok(manifest.resolve(type) !== null, `resolve('${type}') returned null`);
    }
  });
});

// ─── manifest ↔ decision contract: decision_types agree ──────────────────────

describe('integrity — capability manifest ↔ decision contract', () => {
  it('manifest decision_types are a subset of the decision contract enum', () => {
    const contractTypes = new Set(decisionContract.decision_types);
    for (const dt of intentCaps.decision_types) {
      assert.ok(contractTypes.has(dt), `manifest decision_type '${dt}' not in decision contract`);
    }
  });
  it('every brain intent yields a decision_type the contract knows', () => {
    const contractTypes = new Set(decisionContract.decision_types);
    for (const type of manifest.listIntents()) {
      const intent = manifest.getIntent(type);
      if (intent.brain === false) continue;
      assert.ok(contractTypes.has(intent.decision_type),
        `intent '${type}' decision_type '${intent.decision_type}' not in decision contract`);
    }
  });
  it('every decision_type has a payload spec in the contract', () => {
    for (const dt of decisionContract.decision_types) {
      assert.ok(decisionContract.payloads[dt], `decision_type '${dt}' has no payload spec`);
    }
  });
});

// ─── decision contract ↔ confidenceModule: caveat enum has not drifted ───────

describe('integrity — decision contract ↔ confidenceModule (caveat producer)', () => {
  it('decision contract caveat_keys exactly match confidenceModule CAVEAT_KEYS values', () => {
    const producer = new Set(Object.values(CONF_CAVEATS));
    const contract = new Set(decisionContract.caveat_keys);
    assert.deepEqual([...contract].sort(), [...producer].sort(),
      'caveat_keys in decision.contract.json must equal the values confidenceModule emits');
  });
  it('the safety_flag_caveat is one of the caveat_keys', () => {
    assert.ok(decisionContract.caveat_keys.includes(decisionContract.safety_flag_caveat));
  });
});

// ─── module.file references point at real or planned files ───────────────────

describe('integrity — capability module references', () => {
  const caps = require('../config/coaching/manifests/capabilities.json').capabilities;
  it('complete/partial capabilities point at an existing services file', () => {
    for (const [id, cap] of Object.entries(caps)) {
      if (cap.status === 'missing') continue;
      const p = path.join(__dirname, '..', cap.module.file);
      assert.ok(fs.existsSync(p), `capability '${id}': ${cap.module.file} does not exist (status=${cap.status})`);
    }
  });
  it('missing capabilities point at a not-yet-built file', () => {
    for (const [id, cap] of Object.entries(caps)) {
      if (cap.status !== 'missing') continue;
      const p = path.join(__dirname, '..', cap.module.file);
      assert.ok(!fs.existsSync(p), `capability '${id}' is status=missing but ${cap.module.file} already exists`);
    }
  });
});

// ─── every decision fixture validates ────────────────────────────────────────

describe('integrity — canonical decision fixtures validate', () => {
  // One representative answered + one clarification, spanning the contract.
  const fixtures = {
    workout: {
      schema_version: 1, intent: { type: 'best_workout', constraints: {}, source: 'button' },
      decision_type: 'workout', status: 'answered',
      confidence: { score: 82, tier: 'high', action: 'act', caveats: [] },
      safety: { level: 'green', flags: [], blocking: false },
      payload: { session_label: 'Upper', blocks: [{ exercise: 'Bench', lift_code: 'BENCH',
        sets: 3, reps: 5, target_weight: 185, target_rir: 2 }] },
      missing_info: [], explanation_inputs: { blocks: [{ target_weight: 185, reps: 5, target_rir: 2 }] },
      provenance: { modules_run: ['confidence'], skipped: [], state_asOf: null, engine_version: '1' },
    },
    clarification: {
      schema_version: 1, intent: { type: 'progression_review', constraints: {}, source: 'chat' },
      decision_type: 'clarification_needed', status: 'needs_clarification',
      confidence: { score: 38, tier: 'low', action: 'ask', caveats: ['insufficient_history'] },
      safety: { level: 'green', flags: [], blocking: false },
      payload: { reason: 'insufficient_data' },
      missing_info: [{ field: 'readiness_inputs', required: true, question: 'How did it feel?', information_gain: 0.7 }],
      explanation_inputs: { sessions_analyzed: 1 },
      provenance: { modules_run: ['confidence'], skipped: [], state_asOf: null, engine_version: '1' },
    },
  };
  for (const [name, fx] of Object.entries(fixtures)) {
    it(`${name} fixture validates`, () => {
      const r = validateCoachingDecision(fx);
      assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
    });
  }
});

// ─── ExerciseIdentity ↔ movement-pattern vocabulary (single owner) ───────────

describe('integrity — ExerciseIdentity contract', () => {
  it('a canonical ExerciseIdentity fixture validates', () => {
    const r = validateExerciseIdentity({
      schema_version: 1, exercise_id: 'conventional-deadlift', canonical_name: 'Conventional Deadlift',
      lift_code: 'DL', muscle_group: 'Posterior Chain', movement_pattern: 'hinge',
      aliases: ['Deadlift', 'Barbell Deadlift'],
    });
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('the ExerciseIdentity movement_pattern vocabulary is exactly patterns.json (loaded, never copied)', () => {
    const fromPatterns = movementPatterns.patterns.map((p) => p.id).sort();
    assert.deepEqual([...MOVEMENT_PATTERNS].sort(), fromPatterns);
  });
  it('the KB ontology inline movement_pattern enum has not drifted from patterns.json', () => {
    const patternIds = movementPatterns.patterns.map((p) => p.id).sort();
    const schemaEnum = [...exerciseSchema.properties.movement_pattern.enum].sort();
    assert.deepEqual(schemaEnum, patternIds,
      'exercise.schema.json movement_pattern enum must equal config/coaching/movement-patterns/patterns.json ids');
  });
});

// ─── AthleteContext ↔ goal vocabulary (single owner) ─────────────────────────

describe('integrity — AthleteContext contract', () => {
  it('a canonical AthleteContext fixture validates', () => {
    const r = validateAthleteContext({
      schema_version: 1, profile_goal: 'strength', training_level: 'intermediate',
      population: 'general', equipment_profile: { barbell: true, dumbbells: true },
    });
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('AthleteContext profile_goal vocabulary is exactly trainingKnowledge TRAINING_GOALS (loaded, never copied)', () => {
    assert.deepEqual([...CANONICAL_GOALS].sort(), Object.keys(TRAINING_GOALS).sort());
  });
  it('AthleteContext promotes the StateSnapshot.profile fields', () => {
    const c = buildAthleteContext({});
    for (const key of ['profile_goal', 'training_level', 'population']) {
      assert.ok(key in c, `AthleteContext must carry StateSnapshot.profile field '${key}'`);
    }
  });
});

// ─── WorkoutSession — session-truth spine + derived cursor ───────────────────

describe('integrity — WorkoutSession contract', () => {
  it('a canonical WorkoutSession fixture validates', () => {
    const fx = workoutSession.buildWorkoutSession({
      session_id: 's_2026',
      slots: [
        { name: 'Back Squat', lift_code: 'SQ', status: 'completed', sets_logged: 3, sets_target: 3 },
        { name: 'Bench Press', lift_code: 'BENCH', status: 'pending', sets_logged: 0, sets_target: 3 },
      ],
    });
    const r = workoutSession.validateWorkoutSession(fx);
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('the derived cursor is the first pending slot (single owner of session-truth selectors)', () => {
    const fx = workoutSession.buildWorkoutSession({
      slots: [{ name: 'A', status: 'completed' }, { name: 'B', status: 'pending' }, { name: 'C', status: 'pending' }],
    });
    assert.strictEqual(workoutSession.currentSlot(fx).name, 'B');
    assert.strictEqual(workoutSession.remainingSlots(fx).length, 2);
  });
});

// ─── InteractionTrace — one turn_id across the canonical stage spine ──────────

describe('integrity — InteractionTrace contract', () => {
  it('a full-span InteractionTrace fixture validates', () => {
    const trace = interactionTrace.buildInteractionTrace({
      turn_id: 't_integrity',
      started_at: '2026-07-20T00:00:00Z',
      stages: interactionTrace.STAGES.map((s) => ({ stage: s, status: 'ok', ref: null })),
    });
    const r = interactionTrace.validateInteractionTrace(trace);
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
    assert.deepEqual(interactionTrace.missingStages(trace), [], 'a full trace has no missing stages');
  });
  it('the canonical stage spine matches the Phase 3 plan order', () => {
    assert.deepEqual(interactionTrace.STAGES, [
      'parser', 'intent', 'session_snapshot', 'engine_decision', 'knowledge_retrieval',
      'coaching_strategy', 'model_response', 'validator_result', 'rendered_output', 'write_proof',
    ]);
  });
});

// ─── SafetyDecision — one verdict; single owner of the safety-state vocabulary ──

describe('integrity — SafetyDecision contract', () => {
  it('a canonical SafetyDecision fixture validates', () => {
    const r = safetyDecision.validateSafetyDecision(safetyDecision.buildSafetyDecision({
      state: 'red', confidence: 'high', signals: ['chest pain'], reason: 'Stop and route to medical evaluation',
    }));
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('SafetyDecision owns the safety-state vocabulary; decision.contract.json safety_levels have not drifted (order-sensitive)', () => {
    assert.deepEqual(safetyDecision.STATES, decisionContract.safety_levels,
      'CoachingDecision safety.level enum (decision.contract.json safety_levels) must equal SafetyDecision STATES, in severity order');
  });
  it('the safety.rules.json traffic-light states have not drifted from SafetyDecision STATES', () => {
    const ruleStates = safetyRules.traffic_light.map((t) => t.state).sort();
    assert.deepEqual(ruleStates, [...safetyDecision.STATES].sort(),
      'config/coaching/rules/safety.rules.json traffic_light states must be exactly the SafetyDecision states');
  });
  it('the safety-rule.schema.json state enum has not drifted from SafetyDecision STATES', () => {
    const schemaEnum = [...safetyRuleSchema.properties.traffic_light.items.properties.state.enum].sort();
    assert.deepEqual(schemaEnum, [...safetyDecision.STATES].sort(),
      'safety-rule.schema.json traffic_light state enum must be exactly the SafetyDecision states');
  });
  it('the live classifier output threads through fromClassification into a valid, blocking red verdict', () => {
    const verdict = safetyDecision.fromClassification(classifyTrafficLight(['chest pain', 'shortness of breath']));
    assert.strictEqual(verdict.state, 'red');
    assert.strictEqual(verdict.blocking, true);
    const r = safetyDecision.validateSafetyDecision(verdict);
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
});

// ─── CloseoutTransaction — the atomic closeout write; proof invariants W1/W3 ────

describe('integrity — CloseoutTransaction contract', () => {
  it('a canonical dry-run CloseoutTransaction fixture validates', () => {
    const r = closeoutTransaction.validateCloseoutTransaction(closeoutTransaction.buildCloseoutTransaction({
      session_id: 's_int', session_date: '2026-07-20', test_mode: true,
      log_rows: [{ exercise: 'Squat', weight: 225, reps: 5 }], effort_row: null, seal: { count: 1, already_sealed: 0 },
      proof: { sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true, log_rows_written: null, logAppendedRange: null },
    }));
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('the real closeoutSummary output threads through fromCloseoutSummary into a valid transaction', () => {
    const summary = buildCloseoutSummary({
      session: { session_id: 's_int', session_date: '2026-07-20' },
      logRowsPreview: [{ exercise: 'Squat', weight: 225, reps: 5 }],
      effortRowPreview: { duration: 40 },
      sealPreview: { would_seal: 2, already_sealed: 0 },
    });
    const tx = closeoutTransaction.fromCloseoutSummary(summary, {
      test_mode: true,
      proof: { sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true, log_rows_written: null, logAppendedRange: null },
    });
    assert.deepEqual(tx.seal, { count: 2, already_sealed: 0 }, 'rows_to_seal maps to seal');
    assert.strictEqual(tx.log_rows.length, 1);
    const r = closeoutTransaction.validateCloseoutTransaction(tx);
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('enforces W1 (dry-run must not report a write) and W3 (live success needs the range)', () => {
    const dryClaimingWrite = closeoutTransaction.buildCloseoutTransaction({
      session_id: 's', session_date: null, test_mode: true, proof: { sheet_write: 'success', sheet_written: true, no_write_confirmed: false, log_rows_written: 3, logAppendedRange: 'Log_Cleaned!A2:L4' },
    });
    assert.strictEqual(closeoutTransaction.validateCloseoutTransaction(dryClaimingWrite).valid, false, 'W1: a dry-run claiming a write must be rejected');
    const liveNoRange = closeoutTransaction.buildCloseoutTransaction({
      session_id: 's', session_date: null, test_mode: false, proof: { sheet_write: 'success', sheet_written: true, no_write_confirmed: false, log_rows_written: 3, logAppendedRange: null },
    });
    assert.strictEqual(closeoutTransaction.validateCloseoutTransaction(liveNoRange).valid, false, 'W3: a live success without logAppendedRange must be rejected');
  });
});

// ─── CoachTurnPacket — the capstone; assembled from the other seven (one Brain) ──

describe('integrity — CoachTurnPacket contract', () => {
  // valid embedded facts, each canonical under its own contract
  const _athlete = () => buildAthleteContext({ profile_goal: 'strength', training_level: 'intermediate', population: 'general', equipment_profile: { barbell: true } });
  const _session = () => workoutSession.buildWorkoutSession({ session_id: 's1', slots: [{ name: 'Bench', lift_code: 'BENCH', status: 'pending', sets_target: 3 }] });
  const _exercise = () => ({ schema_version: 1, exercise_id: 'conventional-deadlift', canonical_name: 'Conventional Deadlift', lift_code: 'DL', muscle_group: 'Posterior Chain', movement_pattern: 'hinge', aliases: ['Deadlift'] });
  const _decision = () => ({
    schema_version: 1, intent: { type: 'best_workout', constraints: {}, source: 'button' },
    decision_type: 'workout', status: 'answered',
    confidence: { score: 82, tier: 'high', action: 'act', caveats: [] },
    safety: { level: 'green', flags: [], blocking: false },
    payload: { session_label: 'Upper', blocks: [{ exercise: 'Bench', lift_code: 'BENCH', sets: 3, reps: 5, target_weight: 185, target_rir: 2 }] },
    missing_info: [], explanation_inputs: { blocks: [{ target_weight: 185, reps: 5, target_rir: 2 }] },
    provenance: { modules_run: ['confidence'], skipped: [], state_asOf: null, engine_version: '1' },
  });
  const _safety = () => safetyDecision.buildSafetyDecision({ state: 'green', confidence: 'none', signals: [], reason: null });

  it('a full CoachTurnPacket assembled from all seven contracts validates', () => {
    const packet = coachTurnPacket.buildCoachTurnPacket({
      turn_id: 't_integrity', athlete: _athlete(), session: _session(), exercises: [_exercise()],
      decision: _decision(), safety: _safety(),
      closeout: closeoutTransaction.buildCloseoutTransaction({ session_id: 's1', session_date: '2026-07-20', test_mode: true, proof: { sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true } }),
    });
    const r = coachTurnPacket.validateCoachTurnPacket(packet);
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('delegates to each sibling validator: an embedded fact that is not canonical fails the packet (one Brain)', () => {
    const badDecision = { ..._decision(), decision_type: 'not_a_type' };
    const packet = coachTurnPacket.buildCoachTurnPacket({ turn_id: 't', decision: badDecision });
    const r = coachTurnPacket.validateCoachTurnPacket(packet);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => e.startsWith('decision.')), 'the sub-error is surfaced under decision.*');
  });
  it('binds the single safety verdict: safety.state must equal decision.safety.level', () => {
    const packet = coachTurnPacket.buildCoachTurnPacket({
      turn_id: 't', decision: _decision(),
      safety: safetyDecision.buildSafetyDecision({ state: 'yellow', blocking: false, confidence: 'low', signals: ['low readiness'], reason: null }),
    });
    assert.strictEqual(coachTurnPacket.validateCoachTurnPacket(packet).valid, false, 'a yellow verdict against a green decision must not validate');
  });
});
