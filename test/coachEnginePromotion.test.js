'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { planBrianOverride, applyBrianOverride, brianVerdictText } = require('../services/coachEnginePromotion');
const { buildIntentEnvelope } = require('../services/intentEnvelope');
const { assembleState } = require('../services/stateAssembly');
const { orchestrate } = require('../services/coachOrchestrator');
const { validateCoachingDecision } = require('../services/coachingDecision');
const { buildRunners } = require('../services/coachRunners');
const manifest = require('../services/capabilityManifest');

before(() => manifest._resetForTesting());

// ─── fixtures ─────────────────────────────────────────────────────────────

function legacyRecommendation(overrides = {}) {
  return {
    recommendation: 'Hold 225 and build cleaner 5s.',
    reasoning: 'Two clean sessions at this load.',
    next_target: { weight: 225, reps: 5, sets: 3 },
    target_rir: 2,
    ...overrides
  };
}

const ANSWERED_PROGRESSION = {
  decision_type: 'progression',
  status: 'answered',
  payload: { lift_code: 'BEN01', action: 'increase_load', lever: 'weight', target_weight: 230, target_reps: 5, rationale: 'Two clean sessions above target RIR.' },
  confidence: { score: 82, tier: 'high', action: 'act', caveats: [] },
  safety: { level: 'green', flags: [], blocking: false }
};

const CLARIFICATION = {
  decision_type: 'clarification_needed',
  status: 'needs_clarification',
  payload: { reason: 'insufficient_data' },
  confidence: { score: 20, tier: 'low', action: 'ask', caveats: ['insufficient_history'] },
  safety: { level: 'green', flags: [], blocking: false }
};

const VALID = { valid: true, errors: [] };
const INVALID = { valid: false, errors: ['schema_version: must be 1.0.0'] };

// ─── planBrianOverride ────────────────────────────────────────────────────

describe('planBrianOverride', () => {
  it('eligible when both target_weight and target_reps are present', () => {
    const plan = planBrianOverride(legacyRecommendation(), ANSWERED_PROGRESSION, VALID, null);
    assert.equal(plan.eligible, true);
    assert.equal(plan.reason, null);
    assert.equal(plan.weight, 230);
    assert.equal(plan.reps, 5);
    assert.equal(plan.action, 'increase_load');
    assert.equal(plan.rationale, 'Two clean sessions above target RIR.');
  });

  it('eligible with weight only (payload omitted target_reps)', () => {
    const brian = { ...ANSWERED_PROGRESSION, payload: { lift_code: 'BEN01', action: 'increase_load', target_weight: 230 } };
    const plan = planBrianOverride(legacyRecommendation(), brian, VALID, null);
    assert.equal(plan.eligible, true);
    assert.equal(plan.weight, 230);
    assert.equal(plan.reps, null);
  });

  it('eligible with reps only (payload omitted target_weight)', () => {
    const brian = { ...ANSWERED_PROGRESSION, payload: { lift_code: 'BEN01', action: 'add_rep', target_reps: 6 } };
    const plan = planBrianOverride(legacyRecommendation(), brian, VALID, null);
    assert.equal(plan.eligible, true);
    assert.equal(plan.weight, null);
    assert.equal(plan.reps, 6);
  });

  it('ineligible: an active deload always wins, even over an otherwise-answered decision', () => {
    const plan = planBrianOverride(legacyRecommendation(), ANSWERED_PROGRESSION, VALID, { in_deload: true, protocol: 'STRENGTH_DELOAD_V1' });
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, 'active_deload');
  });

  it('ineligible: validation failed (covers orchestrator error / malformed decision)', () => {
    const plan = planBrianOverride(legacyRecommendation(), ANSWERED_PROGRESSION, INVALID, null);
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, 'invalid_decision');
  });

  it('ineligible: brian is null (orchestrate returned nothing)', () => {
    const plan = planBrianOverride(legacyRecommendation(), null, { valid: false, errors: ['decision: must be an object'] }, null);
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, 'invalid_decision');
  });

  it('ineligible: needs_clarification', () => {
    const plan = planBrianOverride(legacyRecommendation(), CLARIFICATION, VALID, null);
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, 'needs_clarification');
  });

  it('ineligible: decision_type is not progression (defensive — this call path only ever requests progression_review)', () => {
    const brian = { decision_type: 'recovery', status: 'answered', payload: {}, confidence: { score: 80, tier: 'high', action: 'act', caveats: [] }, safety: { level: 'green', flags: [], blocking: false } };
    const plan = planBrianOverride(legacyRecommendation(), brian, VALID, null);
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, 'wrong_decision_type');
  });

  it('ineligible: answered progression with no prescribed numbers at all', () => {
    const brian = { ...ANSWERED_PROGRESSION, payload: { lift_code: 'BEN01', action: 'hold' } };
    const plan = planBrianOverride(legacyRecommendation(), brian, VALID, null);
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, 'no_prescribed_numbers');
  });

  it('ineligible: legacy produced no next_target to override (nothing to compare/override onto)', () => {
    const plan = planBrianOverride(legacyRecommendation({ next_target: null }), ANSWERED_PROGRESSION, VALID, null);
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, 'no_legacy_target');
  });

  it('never throws on garbage input', () => {
    assert.doesNotThrow(() => planBrianOverride(null, null, null, null));
    assert.doesNotThrow(() => planBrianOverride(undefined, 'not-an-object', {}, 'not-an-object'));
  });
});

// ─── applyBrianOverride ───────────────────────────────────────────────────

describe('applyBrianOverride', () => {
  it('overwrites next_target.weight/reps, reasoning, and recommendation — nothing else', () => {
    const rec = legacyRecommendation();
    const plan = planBrianOverride(rec, ANSWERED_PROGRESSION, VALID, null);
    applyBrianOverride(rec, plan);
    assert.equal(rec.next_target.weight, 230);
    assert.equal(rec.next_target.reps, 5);
    assert.equal(rec.next_target.sets, 3, 'sets is not part of the progression payload — legacy value preserved');
    assert.equal(rec.target_rir, 2, 'target_rir is not part of the progression payload — legacy value preserved');
    assert.equal(rec.reasoning, 'Two clean sessions above target RIR.');
    assert.match(rec.recommendation, /230/);
    assert.match(rec.recommendation, /5/);
  });

  it('leaves the untouched field null when only one of weight/reps was prescribed', () => {
    const rec = legacyRecommendation({ next_target: { weight: 225, reps: 5, sets: 3 } });
    const brian = { ...ANSWERED_PROGRESSION, payload: { lift_code: 'BEN01', action: 'increase_load', target_weight: 230 } };
    const plan = planBrianOverride(rec, brian, VALID, null);
    applyBrianOverride(rec, plan);
    assert.equal(rec.next_target.weight, 230);
    assert.equal(rec.next_target.reps, 5, 'legacy reps preserved — Brian did not prescribe a rep change');
  });

  it('keeps legacy reasoning when Brian supplied no rationale', () => {
    const rec = legacyRecommendation();
    const brian = { ...ANSWERED_PROGRESSION, payload: { lift_code: 'BEN01', action: 'increase_load', target_weight: 230, target_reps: 5 } };
    const plan = planBrianOverride(rec, brian, VALID, null);
    applyBrianOverride(rec, plan);
    assert.equal(rec.reasoning, 'Two clean sessions at this load.', 'legacy reasoning preserved when Brian gave no rationale');
  });
});

// ─── brianVerdictText — no LLM, no invented numbers; every token is either a
// fixed connective word or copied straight from the plan ───────────────────

describe('brianVerdictText', () => {
  it('weight and reps both present', () => {
    assert.equal(brianVerdictText({ action: 'increase_load', weight: 230, reps: 5 }), 'Brian: increase load — 230 x 5.');
  });
  it('weight only', () => {
    assert.equal(brianVerdictText({ action: 'increase_load', weight: 230, reps: null }), 'Brian: increase load — 230.');
  });
  it('reps only', () => {
    assert.equal(brianVerdictText({ action: 'add_rep', weight: null, reps: 6 }), 'Brian: add rep — 6 reps.');
  });
  it('falls back to a generic action label when action is missing', () => {
    assert.equal(brianVerdictText({ action: null, weight: null, reps: null }), 'Brian: progress.');
  });
});

// ─── composition — real orchestrator, mirrors the exact index.js brian-mode
// path (envelope → assembleState(stub) → orchestrate → validate →
// planBrianOverride → applyBrianOverride). No live Sheets/Express — same
// no-live-I/O convention as test/coachRunners.test.js's shadow-composition
// suite, which this extends one step further (into the promotion decision). ─

describe('brian-mode composition (real Orchestrator + coachEnginePromotion)', () => {
  const ASOF = '2026-06-30T14:00:00Z';

  function readers(rows) {
    return {
      getLogRows: async () => rows,
      readDeloadState: async () => null,
      getProfile: async () => ({ profile_goal: 'powerlifting', training_level: 'intermediate', population: 'general' }),
    };
  }

  function env(constraints) {
    return buildIntentEnvelope({ type: 'progression_review', constraints, source: 'api', asOf: ASOF });
  }

  // Same shape as coachRunners.test.js's RICH_ROWS — 6 sessions of steady
  // improvement, enough for confidence to clear 'ask' and reach 'answered'.
  const RICH_ROWS = (() => {
    const dates = ['2026-05-20', '2026-05-24', '2026-05-28', '2026-06-01', '2026-06-05', '2026-06-08'];
    let w = 180; const rows = [];
    for (let i = 0; i < 6; i++) { rows.push([dates[i], 's' + i, 'Bench Press', 'Bench Press', 'chest', 'BEN01', 1, w, 5, 2, '', w * 5]); w += 5; }
    return rows;
  })();

  const THIN_ROWS = [['2026-06-08', 's1', 'Bench Press', 'Bench Press', 'chest', 'BEN01', 1, 185, 5, 2, '', 925]];

  async function runOrchestrator(rows) {
    const envelope = env({ target_lift: 'BEN01' });
    const snapshot = await assembleState({ readers: readers(rows), asOf: ASOF });
    const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
    const validation = validateCoachingDecision(brian);
    return { brian, validation };
  }

  it('rich history → real orchestrator answers → planBrianOverride is eligible and applyBrianOverride uses Brian\'s own numbers verbatim', async () => {
    const { brian, validation } = await runOrchestrator(RICH_ROWS);
    assert.equal(validation.valid, true, `errors: ${validation.errors.join(' | ')}`);
    assert.equal(brian.status, 'answered');
    assert.equal(brian.decision_type, 'progression');

    const rec = legacyRecommendation();
    const plan = planBrianOverride(rec, brian, validation, null);
    assert.equal(plan.eligible, true, `expected eligible, got reason=${plan.reason}`);
    applyBrianOverride(rec, plan);

    // Every number in the final response traces straight back to brian.payload —
    // nothing was invented by this module or an LLM.
    assert.equal(rec.next_target.weight, brian.payload.target_weight);
    assert.equal(rec.next_target.reps, brian.payload.target_reps);
    // sets was never part of the progression payload — legacy's value survives.
    assert.equal(rec.next_target.sets, 3);
  });

  it('thin history → real orchestrator returns clarification_needed → planBrianOverride falls back, recommendation untouched', async () => {
    const { brian, validation } = await runOrchestrator(THIN_ROWS);
    assert.equal(validation.valid, true);
    assert.equal(brian.decision_type, 'clarification_needed');

    const rec = legacyRecommendation();
    const before = JSON.parse(JSON.stringify(rec));
    const plan = planBrianOverride(rec, brian, validation, null);
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, 'needs_clarification');
    // Nothing is applied on an ineligible plan — the caller (index.js) never
    // calls applyBrianOverride in this branch, so rec must still equal the
    // untouched legacy object.
    assert.deepEqual(rec, before);
  });

  it('rich history + an active deload → deload still wins over an otherwise-answered decision', async () => {
    const { brian, validation } = await runOrchestrator(RICH_ROWS);
    assert.equal(brian.status, 'answered', 'sanity: Brian would have answered absent the deload');

    const rec = legacyRecommendation();
    const plan = planBrianOverride(rec, brian, validation, { in_deload: true, protocol: 'STRENGTH_DELOAD_V1' });
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, 'active_deload');
  });
});

// ─── Coach's Pick promotion (owner-approved 2026-07-02) ─────────────────────

const { planBrianPickOverride, applyBrianPickOverride } = require('../services/coachEnginePromotion');

function legacyPickResult() {
  return {
    intents: [
      { id: 'push_day', label: 'Push Day', focus: 'press + pull', recommended: true,
        why_today: ['Pressing patterns are fresh'],
        reason_codes: ['stall_detected'],
        pivot_logic: ['If pressing feels heavy, swap to rows'],
        what_it_protects: ['Strength trajectory'],
        exercises: [{ exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185, target_reps: 5, target_sets: 3, reason: 'steady' }] },
      { id: 'pull_day', label: 'Pull Day', recommended: false,
        exercises: [{ exercise: 'Barbell Row', lift_code: 'ROW01', target_weight: 135, target_reps: 8, target_sets: 3, reason: 'fresh' }] },
    ],
    todays_read: { recommended_label: 'Push Day', recommended_reason: 'Pressing patterns are fresh' },
  };
}

const ANSWERED_WORKOUT = {
  decision_type: 'workout',
  status: 'answered',
  payload: {
    session_label: 'Full Body', focus: 'full_body', target_duration_min: 60,
    blocks: [
      { exercise: 'Back Squat', lift_code: 'SQUAT', pattern: 'squat', sets: 3, reps: 5, target_weight: 250, target_rir: 2, scenario_id: 'on_target', source: 'brian', warmup: false },
      { exercise: 'Bench Press', lift_code: 'BENCH', pattern: 'push', sets: 3, reps: 5, target_weight: 210, target_rir: 2, scenario_id: 'underloaded', source: 'brian', warmup: false },
    ],
    why_today: ['SQUAT:on_target', 'BENCH:underloaded'],
    substitutions_applied: [],
  },
  confidence: { score: 82, tier: 'high', action: 'act', caveats: [] },
  safety: { level: 'green', flags: [], blocking: false },
};

describe('planBrianPickOverride', () => {
  it('eligible: maps every prescribed block verbatim (reps → target_reps)', () => {
    const plan = planBrianPickOverride(legacyPickResult(), ANSWERED_WORKOUT, VALID);
    assert.equal(plan.eligible, true, `got reason=${plan.reason}`);
    assert.equal(plan.exercises.length, 2);
    const [squat, bench] = plan.exercises;
    assert.deepEqual(squat, {
      exercise: 'Back Squat', lift_code: 'SQUAT', target_weight: 250,
      target_reps: 5, target_sets: 3, target_rir: 2, reason: 'Brian: on target',
    });
    assert.equal(bench.target_weight, 210);
    assert.equal(bench.reason, 'Brian: underloaded');
  });

  it('ineligible: invalid decision / clarification / wrong type / no numbers / no recommended intent', () => {
    assert.equal(planBrianPickOverride(legacyPickResult(), ANSWERED_WORKOUT, INVALID).reason, 'invalid_decision');
    assert.equal(planBrianPickOverride(legacyPickResult(), CLARIFICATION, VALID).reason, 'needs_clarification');
    assert.equal(planBrianPickOverride(legacyPickResult(), ANSWERED_PROGRESSION, VALID).reason, 'wrong_decision_type');
    const noNumbers = { ...ANSWERED_WORKOUT, payload: { ...ANSWERED_WORKOUT.payload, blocks: [{ exercise: 'Back Squat' }] } };
    assert.equal(planBrianPickOverride(legacyPickResult(), noNumbers, VALID).reason, 'no_prescribed_numbers');
    const noRec = legacyPickResult();
    noRec.intents.forEach(i => { i.recommended = false; });
    assert.equal(planBrianPickOverride(noRec, ANSWERED_WORKOUT, VALID).reason, 'no_recommended_intent');
  });

  it('never throws on garbage', () => {
    assert.doesNotThrow(() => planBrianPickOverride(null, null, null));
    assert.doesNotThrow(() => planBrianPickOverride({}, {}, VALID));
  });
});

describe('applyBrianPickOverride', () => {
  it('swaps exercises + labels verbatim, strips exercise-derived siblings, keeps readiness facts (review #813)', () => {
    const result = legacyPickResult();
    const before = JSON.parse(JSON.stringify(result));
    const plan = planBrianPickOverride(result, ANSWERED_WORKOUT, VALID);
    applyBrianPickOverride(result, plan);

    const rec = result.intents.find(i => i.recommended);
    assert.equal(rec.exercises.length, 2);
    assert.equal(rec.exercises[0].target_weight, 250);
    // The card's headline now describes the list it shows — Brian's own labels, verbatim.
    assert.equal(rec.label, 'Full Body');
    assert.equal(rec.focus, 'full_body');
    assert.equal(result.todays_read.recommended_label, 'Full Body');
    // Exercise-derived siblings would describe movements no longer shown — stripped, not stale.
    assert.equal('pivot_logic' in rec, false, 'stale pivot_logic must be stripped');
    assert.equal('reason_codes' in rec, false, 'stale reason_codes must be stripped');
    // Readiness/theme facts that are not exercise-derived stay legacy:
    assert.deepEqual(rec.why_today, before.intents[0].why_today);
    assert.deepEqual(rec.what_it_protects, before.intents[0].what_it_protects);
    assert.equal(result.todays_read.recommended_reason, before.todays_read.recommended_reason);
    assert.deepEqual(result.intents[1], before.intents[1], 'non-recommended intents stay legacy');
  });
});

describe('pick composition (real Orchestrator → planBrianPickOverride)', () => {
  const ASOF = '2026-06-30T14:00:00Z';
  const FULL_BODY = (() => {
    const dates = ['2026-05-16', '2026-05-20', '2026-05-24', '2026-05-28', '2026-06-01', '2026-06-05'];
    const out = [];
    for (const [ex, code, m, w0] of [['Back Squat', 'SQUAT', 'quads', 225], ['Bench Press', 'BENCH', 'chest', 185],
      ['Barbell Row', 'ROW', 'back', 135], ['Romanian Deadlift', 'RDL', 'hamstrings', 205]]) {
      let w = w0;
      for (let i = 0; i < 6; i++) { out.push([dates[i], 's' + code + i, ex, ex, m, code, 1, w, 5, 2, '', w * 5]); w += 5; }
    }
    return out;
  })();

  it('rich history → answered workout → the pick\'s exercises are Brian\'s blocks verbatim', async () => {
    const envelope = buildIntentEnvelope({ type: 'best_workout', constraints: {}, source: 'api', asOf: ASOF });
    const snapshot = await assembleState({
      readers: {
        getLogRows: async () => FULL_BODY,
        readDeloadState: async () => null,
        getProfile: async () => ({ profile_goal: 'general-fitness', training_level: 'intermediate', population: 'general' }),
      },
      asOf: ASOF,
    });
    const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
    const validation = validateCoachingDecision(brian);
    assert.equal(validation.valid, true, `errors: ${validation.errors.join(' | ')}`);
    assert.equal(brian.decision_type, 'workout');

    const result = legacyPickResult();
    const plan = planBrianPickOverride(result, brian, validation);
    assert.equal(plan.eligible, true, `got reason=${plan.reason}`);
    applyBrianPickOverride(result, plan);

    const rec = result.intents.find(i => i.recommended);
    assert.equal(rec.exercises.length, brian.payload.blocks.length);
    brian.payload.blocks.forEach((b, i) => {
      assert.equal(rec.exercises[i].exercise, b.exercise);
      assert.equal(rec.exercises[i].target_weight, b.target_weight, 'weights trace verbatim from brian.payload');
      assert.equal(rec.exercises[i].target_reps, b.reps);
    });
  });
});
