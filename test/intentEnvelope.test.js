'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  SCHEMA_VERSION,
  buildIntentEnvelope,
  validateIntentEnvelope,
  _resetForTesting,
} = require('../services/intentEnvelope');

before(() => _resetForTesting());

const ASOF = '2026-06-30T14:00:00Z';

// Convenience: a valid envelope of each shape, mirroring spec §1.5.
const EX = {
  best_workout: () => ({
    schema_version: 1, type: 'best_workout', constraints: {},
    source: 'button', asOf: ASOF, actor: 'user',
  }),
  upper_body: () => ({
    schema_version: 1, type: 'generate_workout', constraints: { focus: 'upper_body' },
    source: 'chat', raw_input: 'I want upper body',
    extraction: { confidence: 0.96, model: 'input-llm', fields_extracted: ['type', 'focus'] },
    asOf: ASOF, actor: 'user',
  }),
  thirty_min: () => ({
    schema_version: 1, type: 'generate_workout', constraints: { duration_minutes: 30 },
    source: 'chat', raw_input: 'I only have 30 minutes',
    extraction: { confidence: 0.93, model: 'input-llm', fields_extracted: ['type', 'duration_minutes'] },
    asOf: ASOF, actor: 'user',
  }),
  shoulder: () => ({
    schema_version: 1, type: 'modify_workout', constraints: { injury: 'shoulder' },
    source: 'voice', raw_input: 'my shoulder hurts',
    extraction: { confidence: 0.89, model: 'input-llm', fields_extracted: ['type', 'injury'] },
    asOf: ASOF, actor: 'user',
  }),
  progression: () => ({
    schema_version: 1, type: 'progression_review', constraints: { target_lift: 'BENCH' },
    source: 'chat', raw_input: 'bench felt easy today',
    extraction: { confidence: 0.91, model: 'input-llm', fields_extracted: ['type', 'target_lift'] },
    asOf: ASOF, actor: 'user',
  }),
};

// ─── builder ───────────────────────────────────────────────────────────────

describe('buildIntentEnvelope', () => {
  it('sets schema_version automatically', () => {
    const env = buildIntentEnvelope({ type: 'best_workout', source: 'button', asOf: ASOF });
    assert.strictEqual(env.schema_version, SCHEMA_VERSION);
  });
  it('defaults constraints to {} and actor to user', () => {
    const env = buildIntentEnvelope({ type: 'best_workout', source: 'button', asOf: ASOF });
    assert.deepEqual(env.constraints, {});
    assert.strictEqual(env.actor, 'user');
  });
  it('omits optional raw_input/extraction when not provided', () => {
    const env = buildIntentEnvelope({ type: 'best_workout', source: 'button', asOf: ASOF });
    assert.ok(!('raw_input' in env));
    assert.ok(!('extraction' in env));
  });
  it('passes through provided fields', () => {
    const env = buildIntentEnvelope({
      type: 'generate_workout', source: 'chat', asOf: ASOF,
      constraints: { focus: 'upper_body' }, raw_input: 'upper body',
      extraction: { confidence: 0.9 },
    });
    assert.strictEqual(env.type, 'generate_workout');
    assert.deepEqual(env.constraints, { focus: 'upper_body' });
    assert.strictEqual(env.raw_input, 'upper body');
    assert.strictEqual(env.extraction.confidence, 0.9);
  });
  it('build → validate round-trips valid for a structured envelope', () => {
    const env = buildIntentEnvelope({ type: 'best_workout', source: 'button', asOf: ASOF });
    assert.strictEqual(validateIntentEnvelope(env).valid, true);
  });
  it('does not throw on null/garbage input', () => {
    assert.doesNotThrow(() => buildIntentEnvelope(null));
    assert.doesNotThrow(() => buildIntentEnvelope('x'));
  });
});

// ─── the five worked examples (spec §1.5) ────────────────────────────────────

describe('validateIntentEnvelope — five canonical examples all valid', () => {
  for (const [name, make] of Object.entries(EX)) {
    it(`${name} is valid`, () => {
      const r = validateIntentEnvelope(make());
      assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
      assert.deepEqual(r.errors, []);
    });
  }
});

// ─── every intent type builds a valid envelope ───────────────────────────────

describe('validateIntentEnvelope — all 13 intent types accepted', () => {
  const intents = [
    'best_workout', 'generate_workout', 'modify_workout', 'progression_review',
    'explain_recommendation', 'substitute_exercise', 'log_intent', 'progress_query',
    'readiness_checkin', 'ingest_signal', 'nutrition_query', 'onboarding_step', 'clarify_intent',
  ];
  for (const type of intents) {
    it(`${type} accepted`, () => {
      const env = { schema_version: 1, type, constraints: {}, source: 'button', asOf: ASOF, actor: 'user' };
      // satisfy intent-specific required constraints
      if (type === 'ingest_signal') env.constraints.signal = { kind: 'recovery', provider: 'whoop' };
      if (type === 'readiness_checkin') env.constraints.readiness_inputs = { sleep: 6 };
      const r = validateIntentEnvelope(env);
      assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
    });
  }
});

// ─── rule 1: required fields + enums ─────────────────────────────────────────

describe('validateIntentEnvelope — required fields & enums', () => {
  it('rejects non-object', () => assert.strictEqual(validateIntentEnvelope(null).valid, false));
  it('rejects wrong schema_version', () => {
    const env = { ...EX.best_workout(), schema_version: 2 };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects unknown type', () => {
    const env = { ...EX.best_workout(), type: 'do_my_taxes' };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects unknown source', () => {
    const env = { ...EX.best_workout(), source: 'telepathy' };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects unknown actor', () => {
    const env = { ...EX.best_workout(), actor: 'robot' };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
});

// ─── rule 2: constraint key + value validation ───────────────────────────────

describe('validateIntentEnvelope — constraint validation', () => {
  it('rejects unknown constraint key', () => {
    const env = { ...EX.best_workout(), constraints: { vibe: 'chill' } };
    const r = validateIntentEnvelope(env);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('unknown constraint key')));
  });
  it('rejects bad focus enum', () => {
    const env = { ...EX.best_workout(), constraints: { focus: 'sideways' } };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('accepts valid focus enum', () => {
    const env = { ...EX.best_workout(), constraints: { focus: 'lower_body' } };
    assert.strictEqual(validateIntentEnvelope(env).valid, true);
  });
  it('rejects out-of-range duration_minutes', () => {
    const env = { ...EX.best_workout(), constraints: { duration_minutes: 5 } };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects non-integer duration_minutes', () => {
    const env = { ...EX.best_workout(), constraints: { duration_minutes: 30.5 } };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('accepts boundary duration_minutes (10 and 180)', () => {
    assert.strictEqual(validateIntentEnvelope({ ...EX.best_workout(), constraints: { duration_minutes: 10 } }).valid, true);
    assert.strictEqual(validateIntentEnvelope({ ...EX.best_workout(), constraints: { duration_minutes: 180 } }).valid, true);
  });
  it('rejects equipment with invalid item', () => {
    const env = { ...EX.best_workout(), constraints: { equipment: ['barbell', 'jetpack'] } };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('accepts valid equipment array', () => {
    const env = { ...EX.best_workout(), constraints: { equipment: ['barbell', 'dumbbell'] } };
    assert.strictEqual(validateIntentEnvelope(env).valid, true);
  });
  it('rejects bad injury enum', () => {
    const env = { ...EX.best_workout(), constraints: { injury: 'soul' } };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects readiness_inputs value out of range', () => {
    const env = { ...EX.best_workout(), constraints: { readiness_inputs: { sleep: 11 } } };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects readiness_inputs unknown sub-key', () => {
    const env = { ...EX.best_workout(), constraints: { readiness_inputs: { vibes: 5 } } };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('accepts valid readiness_inputs', () => {
    const env = { ...EX.best_workout(), constraints: { readiness_inputs: { sleep: 7, soreness: 3 } } };
    assert.strictEqual(validateIntentEnvelope(env).valid, true);
  });
});

// ─── rule 3: asOf ─────────────────────────────────────────────────────────────

describe('validateIntentEnvelope — asOf', () => {
  it('rejects missing asOf', () => {
    const env = { ...EX.best_workout() }; delete env.asOf;
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects unparseable asOf', () => {
    const env = { ...EX.best_workout(), asOf: 'yesterday-ish' };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects a Date.parse-able but non-strict-ISO asOf (bare date)', () => {
    const env = { ...EX.best_workout(), asOf: '2026-06-30' };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects a human-readable date string', () => {
    const env = { ...EX.best_workout(), asOf: 'June 30 2026' };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('accepts an ISO-8601 datetime with offset and millis', () => {
    assert.strictEqual(validateIntentEnvelope({ ...EX.best_workout(), asOf: '2026-06-30T14:00:00.500+02:00' }).valid, true);
  });
});

// ─── rule 4: extraction ⟺ chat/voice ─────────────────────────────────────────

describe('validateIntentEnvelope — extraction biconditional', () => {
  it('rejects extraction on a button source', () => {
    const env = { ...EX.best_workout(), extraction: { confidence: 0.9 } };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects chat source missing extraction', () => {
    const env = EX.upper_body(); delete env.extraction;
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects extraction.confidence out of [0,1]', () => {
    const env = EX.upper_body(); env.extraction = { confidence: 1.5 };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('accepts voice source with extraction', () => {
    assert.strictEqual(validateIntentEnvelope(EX.shoulder()).valid, true);
  });
});

// ─── rule 5: actor=system ⟹ wearable/schedule ────────────────────────────────

describe('validateIntentEnvelope — system actor', () => {
  it('accepts wearable + system', () => {
    const env = { schema_version: 1, type: 'ingest_signal',
      constraints: { signal: { kind: 'recovery', provider: 'whoop', captured_at: ASOF, values: { recovery: 42 } } },
      source: 'wearable', asOf: ASOF, actor: 'system' };
    const r = validateIntentEnvelope(env);
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('rejects system actor on a button source', () => {
    const env = { ...EX.best_workout(), actor: 'system' };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
});

// ─── rules 6 & 7: intent-specific required constraints ───────────────────────

describe('validateIntentEnvelope — intent-specific required constraints', () => {
  it('rejects ingest_signal without signal', () => {
    const env = { schema_version: 1, type: 'ingest_signal', constraints: {},
      source: 'wearable', asOf: ASOF, actor: 'system' };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects readiness_checkin without readiness_inputs', () => {
    const env = { schema_version: 1, type: 'readiness_checkin', constraints: {},
      source: 'button', asOf: ASOF, actor: 'user' };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
  it('rejects signal with bad kind', () => {
    const env = { schema_version: 1, type: 'ingest_signal',
      constraints: { signal: { kind: 'telepathy' } },
      source: 'wearable', asOf: ASOF, actor: 'system' };
    assert.strictEqual(validateIntentEnvelope(env).valid, false);
  });
});

// ─── purity / lane-equivalence ───────────────────────────────────────────────

describe('validateIntentEnvelope — purity & lane-equivalence', () => {
  it('never throws on malformed/partial input', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { type: 'best_workout' }]) {
      assert.doesNotThrow(() => validateIntentEnvelope(bad));
    }
  });
  it('does not mutate the input envelope', () => {
    const env = EX.upper_body();
    const snapshot = JSON.parse(JSON.stringify(env));
    validateIntentEnvelope(env);
    assert.deepEqual(env, snapshot);
  });
  it('same input → same result (deterministic)', () => {
    const env = EX.thirty_min();
    assert.deepEqual(validateIntentEnvelope(env), validateIntentEnvelope(env));
  });
  it('button and chat envelopes for the same intent share one shape', () => {
    // both generate_workout; differ only by source/constraints/extraction — both valid
    const btn = { schema_version: 1, type: 'generate_workout', constraints: { focus: 'upper_body' },
      source: 'button', asOf: ASOF, actor: 'user' };
    const chat = EX.upper_body();
    assert.strictEqual(validateIntentEnvelope(btn).valid, true);
    assert.strictEqual(validateIntentEnvelope(chat).valid, true);
    // identical envelope keys aside from the optional NL fields
    assert.strictEqual(btn.type, chat.type);
  });
});
