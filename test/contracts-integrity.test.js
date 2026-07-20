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
