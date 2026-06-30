'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  SCHEMA_VERSION, buildCoachingDecision, validateCoachingDecision,
  DECISION_TYPES, CAVEAT_KEYS, _resetForTesting,
} = require('../services/coachingDecision');

before(() => _resetForTesting());

// ─── canonical fixtures (spec §3.5, caveats aligned to confidenceModule values) ──

function workoutAnswered() {
  return {
    schema_version: 1,
    intent: { type: 'best_workout', constraints: {}, source: 'button' },
    decision_type: 'workout', status: 'answered',
    confidence: { score: 82, tier: 'high', action: 'act', caveats: [] },
    safety: { level: 'green', flags: [], blocking: false },
    payload: {
      session_label: 'Upper Power', focus: 'upper_body', target_duration_min: 60,
      blocks: [{ exercise: 'Bench Press', lift_code: 'BENCH', pattern: 'horizontal_push',
                 sets: 3, reps: 5, target_weight: 185, target_rir: 2,
                 scenario_id: 'consistent_progress', source: 'brian', warmup: false }],
      why_today: ['bench_trend:improving'], substitutions_applied: [],
    },
    missing_info: [],
    explanation_inputs: { blocks: [{ target_weight: 185, reps: 5, target_rir: 2 }], trend: 'improving' },
    provenance: { modules_run: ['goals', 'user_state', 'scenario_classifier', 'progression', 'session_generator', 'confidence'],
                  skipped: [], state_asOf: '2026-06-30T14:00:00Z', engine_version: '1.0.0' },
  };
}

function substitutionAnswered() {
  return {
    schema_version: 1,
    intent: { type: 'modify_workout', constraints: { injury: 'shoulder' }, source: 'voice' },
    decision_type: 'substitution', status: 'answered',
    confidence: { score: 71, tier: 'moderate', action: 'act_with_caveat', caveats: ['safety_flag_present'] },
    safety: { level: 'yellow', flags: ['shoulder'], blocking: false },
    payload: { original_lift_code: 'OHP',
      candidates: [{ exercise: 'Landmine Press', reason: 'reduced overhead shoulder load',
                     equipment: 'barbell', pattern_match: 'vertical_push_partial' }] },
    missing_info: [],
    explanation_inputs: { swapped_from: 'Overhead Press', swapped_to: 'Landmine Press' },
    provenance: { modules_run: ['ontology', 'movement_patterns', 'safety', 'equipment', 'confidence'],
                  skipped: [], state_asOf: '2026-06-30T14:00:00Z', engine_version: '1.0.0' },
  };
}

function clarification() {
  return {
    schema_version: 1,
    intent: { type: 'progression_review', constraints: { target_lift: 'BENCH' }, source: 'chat' },
    decision_type: 'clarification_needed', status: 'needs_clarification',
    confidence: { score: 38, tier: 'low', action: 'ask', caveats: ['insufficient_history', 'limited_readiness_inputs'] },
    safety: { level: 'green', flags: [], blocking: false },
    payload: { reason: 'insufficient_data' },
    missing_info: [{ field: 'readiness_inputs', required: true,
                     question: 'How did that set feel — close to failure or comfortable?', information_gain: 0.74 }],
    explanation_inputs: { sessions_analyzed: 1 },
    provenance: { modules_run: ['intensity', 'user_state', 'expected_performance', 'confidence'],
                  skipped: ['scenario_classifier', 'progression'], state_asOf: '2026-06-30T14:00:00Z', engine_version: '1.0.0' },
  };
}

// ─── canonical fixtures all valid ────────────────────────────────────────────

describe('validateCoachingDecision — canonical fixtures', () => {
  it('workout answered is valid', () => {
    const r = validateCoachingDecision(workoutAnswered());
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('substitution answered is valid', () => {
    const r = validateCoachingDecision(substitutionAnswered());
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('clarification_needed is valid', () => {
    const r = validateCoachingDecision(clarification());
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
});

// ─── rule 1 / enums ──────────────────────────────────────────────────────────

describe('validateCoachingDecision — envelope & enums', () => {
  it('rejects non-object', () => assert.strictEqual(validateCoachingDecision(null).valid, false));
  it('rejects bad schema_version', () => {
    const d = workoutAnswered(); d.schema_version = 2;
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects unknown intent.type', () => {
    const d = workoutAnswered(); d.intent.type = 'do_my_taxes';
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects unknown decision_type', () => {
    const d = workoutAnswered(); d.decision_type = 'telekinesis';
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects score out of [0,100]', () => {
    const d = workoutAnswered(); d.confidence.score = 140;
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects unknown caveat token', () => {
    const d = workoutAnswered(); d.confidence.caveats = ['NOT_A_CAVEAT'];
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects bad safety.level', () => {
    const d = workoutAnswered(); d.safety.level = 'chartreuse';
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
});

// ─── rule 2 / discriminator ──────────────────────────────────────────────────

describe('validateCoachingDecision — discriminator integrity', () => {
  it('rejects workout missing blocks', () => {
    const d = workoutAnswered(); delete d.payload.blocks;
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects workout block missing target_weight', () => {
    const d = workoutAnswered(); delete d.payload.blocks[0].target_weight;
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects substitution missing candidates', () => {
    const d = substitutionAnswered(); delete d.payload.candidates;
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
});

// ─── rule 3 / ask-answer lockstep ────────────────────────────────────────────

describe('validateCoachingDecision — ask/answer four-way lockstep', () => {
  it('rejects answered status with action=ask', () => {
    const d = workoutAnswered(); d.confidence.action = 'ask';
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects clarification with empty missing_info', () => {
    const d = clarification(); d.missing_info = [];
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects needs_clarification status on a workout decision_type', () => {
    const d = workoutAnswered(); d.status = 'needs_clarification';
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
});

// ─── rule 4 / trust contract (highest-value test) ────────────────────────────

describe('validateCoachingDecision — trust contract (key-aware)', () => {
  it('rejects a prescribed number absent from explanation_inputs', () => {
    const d = workoutAnswered();
    d.payload.blocks[0].target_weight = 999; // explanation_inputs still says 185
    const r = validateCoachingDecision(d);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('trust-contract')), `errors: ${r.errors.join(' | ')}`);
  });
  it('accepts when every prescribed number is echoed under its block key', () => {
    const d = workoutAnswered(); // blocks[0] 185/5/2 echoed at explanation_inputs.blocks[0]
    assert.strictEqual(validateCoachingDecision(d).valid, true);
  });
  it('KEY-AWARE: rejects the right value echoed under the WRONG key (incidental match)', () => {
    const d = workoutAnswered();
    // target_weight 185 present, but only as an unrelated field — not blocks[0].target_weight
    d.explanation_inputs = { blocks: [{ reps: 5, target_rir: 2 }], some_other_metric: 185 };
    const r = validateCoachingDecision(d);
    assert.strictEqual(r.valid, false, 'incidental value match must no longer satisfy the trust contract');
    assert.ok(r.errors.some(e => e.includes('target_weight')));
  });
  it('KEY-AWARE: rejects a small integer (target_rir) that only matches incidentally', () => {
    const d = workoutAnswered();
    // drop blocks[0].target_rir from explanation; leave an incidental 2 elsewhere
    d.explanation_inputs = { blocks: [{ target_weight: 185, reps: 5 }], sessions_analyzed: 2 };
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('multi-block workout: each block must be echoed at its own index', () => {
    const d = workoutAnswered();
    d.payload.blocks.push({ exercise: 'Row', lift_code: 'ROW', sets: 3, reps: 8, target_weight: 135, target_rir: 2 });
    // explanation only has block 0
    let r = validateCoachingDecision(d);
    assert.strictEqual(r.valid, false, 'second block prescribed numbers must be echoed too');
    // now echo block 1 correctly
    d.explanation_inputs.blocks.push({ target_weight: 135, reps: 8, target_rir: 2 });
    r = validateCoachingDecision(d);
    assert.strictEqual(r.valid, true, `errors: ${r.errors.join(' | ')}`);
  });
  it('progression: accepts when target_weight/target_reps echoed under matching keys', () => {
    const d = {
      schema_version: 1, intent: { type: 'progression_review', constraints: {}, source: 'chat' },
      decision_type: 'progression', status: 'answered',
      confidence: { score: 80, tier: 'high', action: 'act', caveats: [] },
      safety: { level: 'green', flags: [], blocking: false },
      payload: { lift_code: 'BENCH', action: 'increase', target_weight: 190, target_reps: 5 },
      missing_info: [], explanation_inputs: { target_weight: 190, target_reps: 5 },
      provenance: { modules_run: [], skipped: [], state_asOf: null, engine_version: '1' },
    };
    assert.strictEqual(validateCoachingDecision(d).valid, true);
  });
  it('progression: rejects target_weight not echoed under its key', () => {
    const d = {
      schema_version: 1, intent: { type: 'progression_review', constraints: {}, source: 'chat' },
      decision_type: 'progression', status: 'answered',
      confidence: { score: 80, tier: 'high', action: 'act', caveats: [] },
      safety: { level: 'green', flags: [], blocking: false },
      payload: { lift_code: 'BENCH', action: 'increase', target_weight: 190, target_reps: 5 },
      missing_info: [], explanation_inputs: { target_reps: 5, note: 190 }, // 190 only incidental
      provenance: { modules_run: [], skipped: [], state_asOf: null, engine_version: '1' },
    };
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
});

// ─── rule 5 / safety escalation ──────────────────────────────────────────────

describe('validateCoachingDecision — safety escalation', () => {
  it('rejects blocking=true with action=act', () => {
    const d = workoutAnswered(); d.safety.blocking = true; d.confidence.action = 'act';
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects blocking=true without safety_flag_present caveat', () => {
    const d = substitutionAnswered(); d.safety.blocking = true; d.confidence.caveats = [];
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('accepts blocking=true with act_with_caveat + safety_flag_present', () => {
    const d = substitutionAnswered(); d.safety.blocking = true; // already act_with_caveat + safety_flag_present
    assert.strictEqual(validateCoachingDecision(d).valid, true);
  });
});

// ─── rule 6 / progress_readout no prescription ───────────────────────────────

describe('validateCoachingDecision — progress_readout', () => {
  it('rejects a prescription field on a progress_readout', () => {
    const d = {
      schema_version: 1, intent: { type: 'progress_query', constraints: {}, source: 'button' },
      decision_type: 'progress_readout', status: 'answered',
      confidence: { score: 90, tier: 'high', action: 'act', caveats: [] },
      safety: { level: 'green', flags: [], blocking: false },
      payload: { lift_code: 'BENCH', trend: 'improving', target_weight: 185 }, // prescription leaked
      missing_info: [], explanation_inputs: { trend: 'improving' },
      provenance: { modules_run: [], skipped: [], state_asOf: null, engine_version: '1' },
    };
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
});

// ─── rule 7 / provenance ─────────────────────────────────────────────────────

describe('validateCoachingDecision — provenance', () => {
  it('rejects a module in both run and skipped', () => {
    const d = workoutAnswered(); d.provenance.skipped = ['confidence'];
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects a module not in the manifest plan', () => {
    const d = workoutAnswered(); d.provenance.modules_run.push('nutrition');
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
});

// ─── rule 8 / missing_info ───────────────────────────────────────────────────

describe('validateCoachingDecision — missing_info', () => {
  it('rejects missing_info field not in vocabulary', () => {
    const d = clarification(); d.missing_info[0].field = 'vibes';
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects information_gain out of [0,1]', () => {
    const d = clarification(); d.missing_info[0].information_gain = 1.5;
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
  it('rejects unsorted missing_info (ascending gain)', () => {
    const d = clarification();
    d.missing_info = [
      { field: 'readiness_inputs', required: true, question: 'q1', information_gain: 0.3 },
      { field: 'log_history', required: true, question: 'q2', information_gain: 0.9 },
    ];
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
});

// ─── builder / purity ────────────────────────────────────────────────────────

describe('coachingDecision — builder & purity', () => {
  it('builder sets schema_version and defaults', () => {
    const d = buildCoachingDecision({ intent: { type: 'best_workout' }, decision_type: 'workout' });
    assert.strictEqual(d.schema_version, SCHEMA_VERSION);
    assert.strictEqual(d.status, 'answered');
    assert.deepEqual(d.missing_info, []);
  });
  it('validator never throws on garbage', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}]) {
      assert.doesNotThrow(() => validateCoachingDecision(bad));
    }
  });
  it('validator does not mutate input', () => {
    const d = workoutAnswered();
    const snap = JSON.parse(JSON.stringify(d));
    validateCoachingDecision(d);
    assert.deepEqual(d, snap);
  });
  it('DECISION_TYPES and CAVEAT_KEYS are exposed', () => {
    assert.ok(DECISION_TYPES.includes('workout'));
    assert.ok(CAVEAT_KEYS.includes('safety_flag_present'));
  });
});
