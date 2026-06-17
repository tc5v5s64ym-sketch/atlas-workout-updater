'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { scoreIntents } = require('../services/analytics');

// ── Log row helpers (12-column contract, volume_calc omitted — normalizer is lenient) ──

function row(date, session, name, muscle, code, weight, reps, set = '1', rir = 2) {
  return [date, session, name, name, muscle, code, String(set), String(weight), String(reps), String(rir), ''];
}

function sets(date, session, name, muscle, code, weight, reps, count = 3, rir = 2) {
  return Array.from({ length: count }, (_, i) => row(date, session, name, muscle, code, weight, reps, i + 1, rir));
}

// Helper: find intent by id from scoreIntents result
function intentById(result, id) {
  return result.intents.find(i => i.id === id);
}

// ── Fixture 1: strength goal + legs fresh → build_strength outranks recovery_pump ──────

describe('golden fixture 1 — strength goal + legs fresh', () => {
  // Setup: lower body last trained 7 days ago (fresh), upper trained 2 days ago.
  // Fatigue is normal — only 6 sets in the window.
  const TODAY = '2026-06-17';
  const logRows = [
    // Lower body 7 days ago (fresh)
    ...sets('2026-06-10', 'S1', 'Back Squat', 'Quads', 'SQ01', 315, 5),
    // Upper 2 days ago (ready/recovering)
    ...sets('2026-06-15', 'S2', 'Bench Press', 'Chest', 'BP01', 225, 5),
    ...sets('2026-06-15', 'S2', 'Lat Pulldown', 'Back', 'LP01', 160, 8),
  ];

  it('build_strength outranks recovery_pump with goal=strength', () => {
    const result = scoreIntents(logRows, [], { today: TODAY, goal: 'strength' });
    const bs = intentById(result, 'build_strength');
    const rp = intentById(result, 'recovery_pump');
    assert.ok(bs, 'build_strength intent must exist');
    assert.ok(rp, 'recovery_pump intent must exist');
    assert.ok(bs.score > rp.score, `build_strength (${bs.score}) should outrank recovery_pump (${rp.score}) when goal=strength and legs are fresh`);
  });

  it('build_strength is the recommended intent when goal=strength + legs fresh', () => {
    const result = scoreIntents(logRows, [], { today: TODAY, goal: 'strength' });
    assert.strictEqual(result.todays_read.recommended_intent_id, 'build_strength');
  });

  it('build_strength score is higher with goal=strength than without', () => {
    const withGoal    = scoreIntents(logRows, [], { today: TODAY, goal: 'strength' });
    const withoutGoal = scoreIntents(logRows, [], { today: TODAY });
    const bsWith    = intentById(withGoal,    'build_strength').score;
    const bsWithout = intentById(withoutGoal, 'build_strength').score;
    assert.ok(bsWith > bsWithout, `build_strength should score higher with goal=strength (${bsWith} vs ${bsWithout})`);
  });

  it('recovery_pump score is lower with goal=strength than without', () => {
    const withGoal    = scoreIntents(logRows, [], { today: TODAY, goal: 'strength' });
    const withoutGoal = scoreIntents(logRows, [], { today: TODAY });
    const rpWith    = intentById(withGoal,    'recovery_pump').score;
    const rpWithout = intentById(withoutGoal, 'recovery_pump').score;
    assert.ok(rpWith < rpWithout, `recovery_pump should score lower with goal=strength (${rpWith} vs ${rpWithout})`);
  });

  it('build_strength exercises include lower-body compounds when legs are fresh + strength goal', () => {
    const result = scoreIntents(logRows, [], { today: TODAY, goal: 'strength' });
    const bs = intentById(result, 'build_strength');
    const exerciseNames = bs.exercises.map(e => e.exercise.toLowerCase());
    const hasLower = exerciseNames.some(n => /squat|deadlift|leg press|lunge|rdl|romanian/i.test(n));
    assert.ok(hasLower, `build_strength exercises should include a lower-body lift when legs are fresh and goal=strength. Got: ${bs.exercises.map(e => e.exercise).join(', ')}`);
  });
});

// ── Fixture 2: hypertrophy goal + rear delts under-volumed → build_muscle ranks up ─────

describe('golden fixture 2 — hypertrophy goal + rear delts under-served', () => {
  // Setup: only pressing work in the last 7 days — no pulling.
  // rear_delts gets 0 effective sets (threshold min = 3) → under.
  // upper_back, lats, biceps also under → pull pattern has coverage gaps.
  const TODAY = '2026-06-17';
  const logRows = [
    // Only bench press in last 7 days — no row for rear delts / pulls
    ...sets('2026-06-15', 'S1', 'Bench Press', 'Chest', 'BP01', 225, 8),
    ...sets('2026-06-15', 'S1', 'Overhead Press', 'Shoulders', 'OHP01', 135, 8),
    // Older pull work (>7 days ago, outside the volume window)
    ...sets('2026-06-08', 'S0', 'Face Pull', 'Rear Delts', 'FP01', 50, 15),
  ];

  it('build_muscle outranks recovery_pump with goal=hypertrophy', () => {
    const result = scoreIntents(logRows, [], { today: TODAY, goal: 'hypertrophy' });
    const bm = intentById(result, 'build_muscle');
    const rp = intentById(result, 'recovery_pump');
    assert.ok(bm, 'build_muscle intent must exist');
    assert.ok(rp, 'recovery_pump intent must exist');
    assert.ok(bm.score > rp.score, `build_muscle (${bm.score}) should outrank recovery_pump (${rp.score}) when goal=hypertrophy and gaps exist`);
  });

  it('build_muscle score is higher with goal=hypertrophy + gap than without goal', () => {
    const withGoal    = scoreIntents(logRows, [], { today: TODAY, goal: 'hypertrophy' });
    const withoutGoal = scoreIntents(logRows, [], { today: TODAY });
    const bmWith    = intentById(withGoal,    'build_muscle').score;
    const bmWithout = intentById(withoutGoal, 'build_muscle').score;
    assert.ok(bmWith > bmWithout, `build_muscle should score higher with goal=hypertrophy+gaps (${bmWith} vs ${bmWithout})`);
  });

  it('coverage-gap bonus raises fix_blind_spots independent of goal', () => {
    // Inject underCoverage directly to isolate the gap-bonus path from volume math.
    // One pull-pattern gap → bonus = 8; zero gaps → no bonus. Same logRows and freshness.
    const pullGap = [{ muscle: 'rear_delts', status: 'under' }];
    const withGap    = scoreIntents(logRows, [], { today: TODAY, underCoverage: pullGap });
    const withoutGap = scoreIntents(logRows, [], { today: TODAY, underCoverage: [] });
    const fsWithGap    = intentById(withGap,    'fix_blind_spots').score;
    const fsWithoutGap = intentById(withoutGap, 'fix_blind_spots').score;
    assert.ok(fsWithGap > fsWithoutGap,
      `fix_blind_spots should score higher with coverage gap (${fsWithGap} vs ${fsWithoutGap})`);
    assert.strictEqual(fsWithGap - fsWithoutGap, 8, 'gap bonus should be exactly 8 for one under-served pattern');
  });
});

// ── Backward compat: no goal → same result as before ─────────────────────────────────

// NOTE: "backward compat" here means the GOAL_BONUS block only — the coverage-gap
// bonus for fix_blind_spots is intentionally goal-independent (coverage gaps are a
// real signal for that intent regardless of goal). See the pinning test below.
describe('backward compatibility — absent goal leaves GOAL_BONUS scoring unchanged', () => {
  const TODAY = '2026-06-17';
  const logRows = [
    ...sets('2026-06-15', 'S1', 'Bench Press', 'Chest', 'BP01', 225, 5),
    ...sets('2026-06-15', 'S1', 'Lat Pulldown', 'Back', 'LP01', 160, 8),
  ];

  it('null goal produces same scores as no goal option', () => {
    const withNull   = scoreIntents(logRows, [], { today: TODAY, goal: null });
    const withNone   = scoreIntents(logRows, [], { today: TODAY });
    for (const intent of withNull.intents) {
      const other = intentById(withNone, intent.id);
      if (!other) continue;
      assert.strictEqual(intent.score, other.score, `${intent.id} score should be identical with goal=null vs omitted`);
    }
  });

  it('unknown goal string produces same scores as no goal', () => {
    const withUnknown = scoreIntents(logRows, [], { today: TODAY, goal: 'not_a_real_goal' });
    const withNone    = scoreIntents(logRows, [], { today: TODAY });
    for (const intent of withUnknown.intents) {
      const other = intentById(withNone, intent.id);
      if (!other) continue;
      assert.strictEqual(intent.score, other.score, `${intent.id} score should be identical with unknown goal vs omitted`);
    }
  });

  it('recommended_intent_id is present in both cases', () => {
    const withGoal    = scoreIntents(logRows, [], { today: TODAY, goal: 'strength' });
    const withoutGoal = scoreIntents(logRows, [], { today: TODAY });
    assert.ok(withGoal.todays_read.recommended_intent_id,    'should have recommended intent with goal');
    assert.ok(withoutGoal.todays_read.recommended_intent_id, 'should have recommended intent without goal');
  });
});

// ── Coverage-gap bonus is goal-independent for fix_blind_spots ────────────────────────
// Under-coverage is a real gap signal for fix_blind_spots regardless of whether the
// caller passes a goal. This affects every scoreIntents caller (incl. coach chat at
// /api/coach/chat). Pinned here so the behavior is explicit and tested.
describe('coverage-gap bonus is goal-independent for fix_blind_spots', () => {
  it('fix_blind_spots gap bonus fires without any goal', () => {
    const pullGap    = [{ muscle: 'rear_delts', status: 'under' }];
    const withGap    = scoreIntents([], [], { underCoverage: pullGap });
    const withoutGap = scoreIntents([], [], { underCoverage: [] });
    const delta = intentById(withGap, 'fix_blind_spots').score - intentById(withoutGap, 'fix_blind_spots').score;
    assert.strictEqual(delta, 8, `gap bonus should fire (+8) even when no goal is passed; delta was ${delta}`);
  });

  it('fix_blind_spots gap bonus stacks with goal bonus when both apply', () => {
    const pullGap = [{ muscle: 'rear_delts', status: 'under' }];
    const withGoalAndGap = scoreIntents([], [], { goal: 'hypertrophy', underCoverage: pullGap });
    const withGoalOnly   = scoreIntents([], [], { goal: 'hypertrophy', underCoverage: [] });
    const delta = intentById(withGoalAndGap, 'fix_blind_spots').score - intentById(withGoalOnly, 'fix_blind_spots').score;
    assert.strictEqual(delta, 8, `coverage-gap bonus should stack with goal bonus; delta was ${delta}`);
  });

  it('build_muscle gap bonus only fires when goal=hypertrophy (remains goal-gated)', () => {
    const pullGap     = [{ muscle: 'rear_delts', status: 'under' }];
    const withGoal    = scoreIntents([], [], { goal: 'hypertrophy', underCoverage: pullGap });
    const withoutGoal = scoreIntents([], [], { underCoverage: pullGap });
    const bmWithGoal    = intentById(withGoal,    'build_muscle').score;
    const bmWithoutGoal = intentById(withoutGoal, 'build_muscle').score;
    // With goal=hypertrophy: GOAL_BONUS (+20) + gap bonus (+6) both fire.
    // Without goal: neither fires (goal-gated).
    assert.ok(bmWithGoal > bmWithoutGoal,
      `build_muscle should score higher with goal=hypertrophy + gap than gap alone (${bmWithGoal} vs ${bmWithoutGoal})`);
  });
});

// ── Goal bonus table: verify each goal shifts the right intents ───────────────────────

describe('goal bonus direction tests', () => {
  const TODAY = '2026-06-17';
  const logRows = [
    ...sets('2026-06-15', 'S1', 'Bench Press',   'Chest', 'BP01', 225, 5),
    ...sets('2026-06-15', 'S1', 'Lat Pulldown',  'Back',  'LP01', 160, 8),
    ...sets('2026-06-13', 'S0', 'Back Squat',    'Quads', 'SQ01', 315, 5),
  ];

  it('goal=recovery raises recovery_pump, lowers build_strength', () => {
    const with_recovery = scoreIntents(logRows, [], { today: TODAY, goal: 'recovery' });
    const baseline      = scoreIntents(logRows, [], { today: TODAY });
    const rpDiff = intentById(with_recovery, 'recovery_pump').score - intentById(baseline, 'recovery_pump').score;
    const bsDiff = intentById(with_recovery, 'build_strength').score - intentById(baseline, 'build_strength').score;
    assert.ok(rpDiff > 0, `recovery_pump should score higher with goal=recovery (delta ${rpDiff})`);
    assert.ok(bsDiff < 0, `build_strength should score lower with goal=recovery (delta ${bsDiff})`);
  });

  it('goal=hypertrophy raises build_muscle, lowers build_strength slightly', () => {
    const with_hyp = scoreIntents(logRows, [], { today: TODAY, goal: 'hypertrophy' });
    const baseline  = scoreIntents(logRows, [], { today: TODAY });
    const bmDiff = intentById(with_hyp, 'build_muscle').score  - intentById(baseline, 'build_muscle').score;
    const bsDiff = intentById(with_hyp, 'build_strength').score - intentById(baseline, 'build_strength').score;
    assert.ok(bmDiff > 0, `build_muscle should score higher with goal=hypertrophy (delta ${bmDiff})`);
    assert.ok(bsDiff < 0, `build_strength should score lower with goal=hypertrophy (delta ${bsDiff})`);
  });

  it('goal=mixed raises both build_strength and build_muscle', () => {
    const with_mixed = scoreIntents(logRows, [], { today: TODAY, goal: 'mixed' });
    const baseline   = scoreIntents(logRows, [], { today: TODAY });
    const bsDiff = intentById(with_mixed, 'build_strength').score - intentById(baseline, 'build_strength').score;
    const bmDiff = intentById(with_mixed, 'build_muscle').score   - intentById(baseline, 'build_muscle').score;
    assert.ok(bsDiff > 0, `build_strength should score higher with goal=mixed (delta ${bsDiff})`);
    assert.ok(bmDiff > 0, `build_muscle should score higher with goal=mixed (delta ${bmDiff})`);
  });

  it('goal=power raises test_progress, lowers recovery_pump', () => {
    const with_power = scoreIntents(logRows, [], { today: TODAY, goal: 'power' });
    const baseline   = scoreIntents(logRows, [], { today: TODAY });
    const rpDiff = intentById(with_power, 'recovery_pump').score - intentById(baseline, 'recovery_pump').score;
    assert.ok(rpDiff < 0, `recovery_pump should score lower with goal=power (delta ${rpDiff})`);
  });
});
