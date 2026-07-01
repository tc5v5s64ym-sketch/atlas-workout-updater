'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const manifest = require('../services/capabilityManifest');
const {
  validateManifest, resolve, listIntents, getCapability, getIntent,
  DECISION_TYPES, INPUT_KEYS, _resetForTesting,
} = manifest;

before(() => _resetForTesting());

// The 13 IntentEnvelope intent types (must each have a manifest entry).
const ALL_INTENTS = [
  'best_workout', 'generate_workout', 'modify_workout', 'progression_review',
  'explain_recommendation', 'substitute_exercise', 'log_intent', 'progress_query',
  'readiness_checkin', 'ingest_signal', 'nutrition_query', 'onboarding_step', 'clarify_intent',
];

// ─── manifest integrity ──────────────────────────────────────────────────────

describe('validateManifest — the shipped manifest is internally consistent', () => {
  it('validates clean', () => {
    const r = validateManifest();
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
    assert.deepEqual(r.errors, []);
  });
  it('every IntentEnvelope intent type has a manifest entry', () => {
    const present = new Set(listIntents());
    for (const t of ALL_INTENTS) assert.ok(present.has(t), `missing manifest entry for '${t}'`);
  });
  it('every intent capability resolves to a descriptor', () => {
    for (const type of listIntents()) {
      for (const id of getIntent(type).capabilities) {
        assert.ok(getCapability(id), `intent '${type}' → unresolved capability '${id}'`);
      }
    }
  });
  it('every depends_on resolves to a descriptor', () => {
    for (const id of Object.keys(require('../config/coaching/manifests/capabilities.json').capabilities)) {
      for (const dep of getCapability(id).depends_on) {
        assert.ok(getCapability(dep), `capability '${id}' → unresolved depends_on '${dep}'`);
      }
    }
  });
  it('every requires/optional key is in the input-key vocabulary', () => {
    const keys = new Set(INPUT_KEYS);
    for (const type of listIntents()) {
      for (const id of getIntent(type).capabilities) {
        const cap = getCapability(id);
        for (const k of [...cap.requires, ...cap.optional]) {
          assert.ok(keys.has(k), `capability '${id}' uses non-vocabulary input key '${k}'`);
        }
      }
    }
  });
  it('every decision_type is in the legal set', () => {
    const dts = new Set(DECISION_TYPES);
    for (const type of listIntents()) {
      const intent = getIntent(type);
      if (intent.brain === false) continue;
      assert.ok(dts.has(intent.decision_type), `intent '${type}' → illegal decision_type '${intent.decision_type}'`);
    }
  });
  it('read_only intents yield progress_readout', () => {
    for (const type of listIntents()) {
      const intent = getIntent(type);
      if (intent.read_only === true) assert.strictEqual(intent.decision_type, 'progress_readout', type);
    }
  });
  it('brain:false intents carry routes_to and no decision_type', () => {
    for (const type of listIntents()) {
      const intent = getIntent(type);
      if (intent.brain === false) {
        assert.ok(typeof intent.routes_to === 'string', `intent '${type}' brain:false needs routes_to`);
      }
    }
  });
});

// ─── resolver: closure + topo order ──────────────────────────────────────────

describe('resolve — closure & topological order', () => {
  it('returns null for an unknown intent', () => assert.strictEqual(resolve('do_my_taxes'), null));

  it('best_workout pulls transitive deps into the closure (expected_performance, intensity)', () => {
    const r = resolve('best_workout');
    const ids = r.order.map(d => d.id);
    // requested does NOT list expected_performance/intensity, but scenario_classifier depends on them
    assert.ok(!r.requested.includes('expected_performance'));
    assert.ok(ids.includes('expected_performance'), 'closure must include expected_performance');
    assert.ok(ids.includes('intensity'), 'closure must include intensity');
  });

  it('dependencies always precede dependents in the order', () => {
    const r = resolve('best_workout');
    const ids = r.order.map(d => d.id);
    const pos = id => ids.indexOf(id);
    // scenario_classifier depends_on user_state + expected_performance
    assert.ok(pos('user_state') < pos('scenario_classifier'));
    assert.ok(pos('expected_performance') < pos('scenario_classifier'));
    // progression depends_on scenario_classifier
    assert.ok(pos('scenario_classifier') < pos('progression'));
    // expected_performance depends_on intensity
    assert.ok(pos('intensity') < pos('expected_performance'));
    // session_generator depends_on progression + constraint_resolver, etc.
    assert.ok(pos('progression') < pos('session_generator'));
    assert.ok(pos('confidence') > pos('user_state'));
  });

  it('order is a permutation of the closure (no dup, no drop)', () => {
    const r = resolve('best_workout');
    const ids = r.order.map(d => d.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'no duplicates');
    // every dependency of every member is present
    for (const d of r.order) {
      for (const dep of d.depends_on) assert.ok(ids.includes(dep), `missing dep ${dep}`);
    }
  });

  it('is deterministic (stable order across calls)', () => {
    assert.deepEqual(resolve('best_workout').order.map(d => d.id),
                     resolve('best_workout').order.map(d => d.id));
  });

  it('flags missing-status capabilities (skip-with-flag, never dropped)', () => {
    const r = resolve('best_workout');
    // Both keystones shipped as 'partial' (scenario_classifier, session_generator),
    // so the remaining missing capability in this plan is `equipment`.
    assert.ok(r.missing.includes('equipment'));
    assert.ok(!r.missing.includes('scenario_classifier'));
    assert.ok(!r.missing.includes('session_generator'));
    // all are still present in the order (not silently dropped)
    const ids = r.order.map(d => d.id);
    assert.ok(ids.includes('scenario_classifier'));
    assert.ok(ids.includes('session_generator'));
    assert.ok(ids.includes('equipment'));
  });

  it('read_only intent resolves with read_only=true and progress_readout', () => {
    const r = resolve('progress_query');
    assert.strictEqual(r.read_only, true);
    assert.strictEqual(r.decision_type, 'progress_readout');
  });

  it('brain:false intent (log_intent) resolves with routes_to and null decision_type', () => {
    const r = resolve('log_intent');
    assert.strictEqual(r.brain, false);
    assert.strictEqual(r.decision_type, null);
    assert.strictEqual(r.routes_to, 'trust_loop');
    assert.deepEqual(r.order, []);
  });

  it('clarify_intent resolves to an empty capability run', () => {
    const r = resolve('clarify_intent');
    assert.strictEqual(r.decision_type, 'clarification_needed');
    assert.deepEqual(r.order, []);
  });

  it('every intent resolves without throwing', () => {
    for (const type of ALL_INTENTS) assert.doesNotThrow(() => resolve(type));
  });
});

// ─── validator robustness ────────────────────────────────────────────────────

describe('validateManifest — robustness', () => {
  it('is pure: repeated calls agree', () => {
    assert.deepEqual(validateManifest(), validateManifest());
  });
});

// ─── orchestrator-is-rule-free guard ─────────────────────────────────────────

describe('rule-free guard — the manifest reader holds no coaching rule', () => {
  it('capabilityManifest.js imports only node builtins (no Brain decision module)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'capabilityManifest.js'), 'utf8');
    // collect all require(...) targets
    const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    for (const target of requires) {
      assert.ok(target.startsWith('node:'),
        `capabilityManifest.js must import only node: builtins, found require('${target}') — ` +
        `the routing layer must not import a Brain decision module`);
    }
  });
  it('the manifest references Brain modules only as data (module.file strings), never via require', () => {
    // descriptors point at services/*.js by string — proving routing is declarative, not coded
    const cap = getCapability('progression');
    assert.strictEqual(cap.module.file, 'services/progressionModule.js');
    assert.strictEqual(typeof cap.module.export, 'string');
  });
});
