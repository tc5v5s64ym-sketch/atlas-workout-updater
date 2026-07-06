'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  getProgram,
  listPrograms,
  buildNextSession,
} = require('../services/starterProgramModule');

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const SL_ID   = 'stronglifts-5x5';
const GZCLP_ID = 'gzclp';

// Minimal SL5x5 state with no prior history (first-ever session).
function slFresh() {
  return { sessionCount: 0, currentWeights: {}, consecutiveFails: {} };
}

// SL5x5 state after N successful sessions (weights set, no stalls).
function slProgress(sessionCount, weights) {
  return { sessionCount, currentWeights: weights, consecutiveFails: {} };
}

// SL5x5 state with stall counts.
function slStall(sessionCount, weights, fails) {
  return { sessionCount, currentWeights: weights, consecutiveFails: fails };
}

// Minimal GZCLP state with no prior history.
function gzFresh() {
  return { sessionCount: 0, currentWeights: {}, t2Weights: {}, t1Tiers: {}, consecutiveFails: {} };
}

// GZCLP state at a specific session with weights set.
function gzProgress(sessionCount, t1w, t2w) {
  return { sessionCount, currentWeights: t1w || {}, t2Weights: t2w || {}, t1Tiers: {}, consecutiveFails: {} };
}

// ─── getProgram ───────────────────────────────────────────────────────────────

describe('getProgram', () => {
  it('returns null for null input', () => {
    assert.strictEqual(getProgram(null), null);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(getProgram(''), null);
  });

  it('returns null for unknown program id', () => {
    assert.strictEqual(getProgram('nonexistent-program'), null);
  });

  it('returns a program object for stronglifts-5x5', () => {
    const p = getProgram(SL_ID);
    assert.ok(p, 'should return a program');
    assert.strictEqual(p.id, SL_ID);
    assert.strictEqual(typeof p.name, 'string');
  });

  it('stronglifts-5x5 has two sessions in the cycle', () => {
    const p = getProgram(SL_ID);
    assert.strictEqual(p.cycle_length, 2);
    assert.strictEqual(p.sessions.length, 2);
  });

  it('stronglifts-5x5 session A has squat, bench, row', () => {
    const p = getProgram(SL_ID);
    const sessionA = p.sessions[0];
    assert.strictEqual(sessionA.label, 'A');
    const codes = sessionA.exercises.map(e => e.lift_code);
    assert.ok(codes.includes('SQUAT'));
    assert.ok(codes.includes('BENCH'));
    assert.ok(codes.includes('ROW'));
  });

  it('stronglifts-5x5 session B has squat, ohp, deadlift', () => {
    const p = getProgram(SL_ID);
    const sessionB = p.sessions[1];
    assert.strictEqual(sessionB.label, 'B');
    const codes = sessionB.exercises.map(e => e.lift_code);
    assert.ok(codes.includes('SQUAT'));
    assert.ok(codes.includes('OHP'));
    assert.ok(codes.includes('DEADLIFT'));
  });

  it('returns a program object for gzclp', () => {
    const p = getProgram(GZCLP_ID);
    assert.ok(p);
    assert.strictEqual(p.id, GZCLP_ID);
    assert.strictEqual(p.cycle_length, 4);
    assert.strictEqual(p.sessions.length, 4);
  });

  it('gzclp Day 1 has T1/T2/T3 exercises', () => {
    const p = getProgram(GZCLP_ID);
    const day1 = p.sessions[0];
    const tiers = day1.exercises.map(e => e.tier);
    assert.ok(tiers.includes('T1'));
    assert.ok(tiers.includes('T2'));
    assert.ok(tiers.includes('T3'));
  });
});

// ─── listPrograms ─────────────────────────────────────────────────────────────

describe('listPrograms', () => {
  it('returns an array', () => {
    const list = listPrograms();
    assert.ok(Array.isArray(list));
  });

  it('includes stronglifts-5x5', () => {
    const list = listPrograms();
    const ids = list.map(p => p.id);
    assert.ok(ids.includes(SL_ID), 'stronglifts-5x5 should be listed');
  });

  it('includes gzclp', () => {
    const list = listPrograms();
    const ids = list.map(p => p.id);
    assert.ok(ids.includes(GZCLP_ID), 'gzclp should be listed');
  });

  it('each entry has id and name', () => {
    const list = listPrograms();
    for (const p of list) {
      assert.strictEqual(typeof p.id,   'string');
      assert.strictEqual(typeof p.name, 'string');
    }
  });
});

// ─── buildNextSession — guard rails ──────────────────────────────────────────

describe('buildNextSession — guard rails', () => {
  it('returns null for null programId', () => {
    assert.strictEqual(buildNextSession(null, slFresh()), null);
  });

  it('returns null for empty programId', () => {
    assert.strictEqual(buildNextSession('', slFresh()), null);
  });

  it('returns null for unknown program', () => {
    assert.strictEqual(buildNextSession('phantom-program', slFresh()), null);
  });

  it('accepts null state gracefully (uses defaults)', () => {
    const result = buildNextSession(SL_ID, null);
    assert.ok(result, 'should still produce a prescription');
    assert.strictEqual(result.programId, SL_ID);
  });

  it('returns an object with required fields', () => {
    const result = buildNextSession(SL_ID, slFresh());
    assert.ok(result);
    assert.strictEqual(typeof result.programId,    'string');
    assert.strictEqual(typeof result.sessionLabel, 'string');
    assert.strictEqual(typeof result.cyclePosition,'number');
    assert.ok(Array.isArray(result.exercises));
  });
});

// ─── buildNextSession — StrongLifts 5×5 ──────────────────────────────────────

describe('buildNextSession — StrongLifts 5×5 — cycle', () => {
  it('session 0 → Workout A', () => {
    const r = buildNextSession(SL_ID, slFresh());
    assert.strictEqual(r.sessionLabel,  'A');
    assert.strictEqual(r.cyclePosition, 0);
  });

  it('session 1 → Workout B', () => {
    const r = buildNextSession(SL_ID, slProgress(1, { SQUAT: 55, OHP: 50, DEADLIFT: 105 }));
    assert.strictEqual(r.sessionLabel,  'B');
    assert.strictEqual(r.cyclePosition, 1);
  });

  it('session 2 → Workout A again', () => {
    const r = buildNextSession(SL_ID, slProgress(2, { SQUAT: 65, BENCH: 50, ROW: 75 }));
    assert.strictEqual(r.sessionLabel,  'A');
    assert.strictEqual(r.cyclePosition, 0);
  });

  it('cycles A/B correctly over 6 sessions', () => {
    const expected = ['A', 'B', 'A', 'B', 'A', 'B'];
    for (let i = 0; i < 6; i++) {
      const r = buildNextSession(SL_ID, slProgress(i, {}));
      assert.strictEqual(r.sessionLabel, expected[i], `session ${i} should be ${expected[i]}`);
    }
  });
});

describe('buildNextSession — StrongLifts 5×5 — start weights', () => {
  it('uses program default when currentWeights is empty', () => {
    const r = buildNextSession(SL_ID, slFresh());
    for (const ex of r.exercises) {
      assert.ok(ex.targetWeight > 0, `${ex.liftCode} targetWeight should be > 0`);
      assert.strictEqual(ex.progressionNote, 'start weight');
    }
  });

  it('Workout A squat start weight is 45 lb', () => {
    const r = buildNextSession(SL_ID, slFresh());
    const squat = r.exercises.find(e => e.liftCode === 'SQUAT');
    assert.ok(squat);
    assert.strictEqual(squat.targetWeight, 45);
  });
});

describe('buildNextSession — StrongLifts 5×5 — progression', () => {
  it('lower body lifts increase by 10 lb on success', () => {
    const r = buildNextSession(SL_ID, slProgress(0, { SQUAT: 135 }));
    const squat = r.exercises.find(e => e.liftCode === 'SQUAT');
    assert.ok(squat);
    assert.strictEqual(squat.targetWeight, 145);
    assert.ok(squat.progressionNote.includes('10 lb'));
  });

  it('upper body lifts increase by 5 lb on success', () => {
    const r = buildNextSession(SL_ID, slProgress(0, { BENCH: 95, ROW: 75 }));
    const bench = r.exercises.find(e => e.liftCode === 'BENCH');
    assert.ok(bench);
    assert.strictEqual(bench.targetWeight, 100);
    assert.ok(bench.progressionNote.includes('5 lb'));
  });

  it('holds weight on 1 consecutive fail', () => {
    const r = buildNextSession(SL_ID, slStall(0, { BENCH: 100 }, { BENCH: 1 }));
    const bench = r.exercises.find(e => e.liftCode === 'BENCH');
    assert.ok(bench);
    assert.strictEqual(bench.targetWeight, 100);
    assert.ok(bench.progressionNote.includes('hold'));
    assert.ok(bench.progressionNote.includes('1/3'));
  });

  it('holds weight on 2 consecutive fails', () => {
    const r = buildNextSession(SL_ID, slStall(0, { SQUAT: 185 }, { SQUAT: 2 }));
    const squat = r.exercises.find(e => e.liftCode === 'SQUAT');
    assert.ok(squat);
    assert.strictEqual(squat.targetWeight, 185);
    assert.ok(squat.progressionNote.includes('2/3'));
  });

  it('deloads 10% after 3 consecutive fails', () => {
    const r = buildNextSession(SL_ID, slStall(0, { SQUAT: 200 }, { SQUAT: 3 }));
    const squat = r.exercises.find(e => e.liftCode === 'SQUAT');
    assert.ok(squat);
    // 200 * 0.90 = 180, round to nearest 5 → 180
    assert.strictEqual(squat.targetWeight, 180);
    assert.ok(squat.progressionNote.includes('deload'));
  });

  it('deload rounds to nearest 5 lb', () => {
    // 210 * 0.90 = 189 → nearest 5 = 190
    const r = buildNextSession(SL_ID, slStall(0, { BENCH: 210 }, { BENCH: 3 }));
    const bench = r.exercises.find(e => e.liftCode === 'BENCH');
    assert.ok(bench);
    assert.strictEqual(bench.targetWeight % 5, 0, 'deload weight should be divisible by 5');
  });

  it('deload never exceeds current weight (no inverted deload near floor)', () => {
    // 40 * 0.90 = 36 → _round5 → 45 lb floor, but Math.min(40, 45) caps at 40
    const r = buildNextSession(SL_ID, slStall(0, { BENCH: 40 }, { BENCH: 3 }));
    const bench = r.exercises.find(e => e.liftCode === 'BENCH');
    assert.ok(bench);
    assert.ok(bench.targetWeight <= 40, 'deloaded weight must not exceed current weight');
  });
});

describe('buildNextSession — StrongLifts 5×5 — exercise shape', () => {
  it('all exercises have required fields', () => {
    const r = buildNextSession(SL_ID, slFresh());
    for (const ex of r.exercises) {
      assert.strictEqual(typeof ex.exerciseId,      'string');
      assert.strictEqual(typeof ex.liftCode,        'string');
      assert.strictEqual(typeof ex.sets,            'number');
      assert.strictEqual(typeof ex.reps,            'number');
      assert.strictEqual(typeof ex.repsScheme,      'string');
      assert.strictEqual(typeof ex.targetWeight,    'number');
      assert.strictEqual(typeof ex.bodyRegion,      'string');
      assert.strictEqual(ex.tier,                   null);
      assert.strictEqual(typeof ex.progressionNote, 'string');
    }
  });

  it('Workout A has 3 exercises', () => {
    const r = buildNextSession(SL_ID, slFresh());
    assert.strictEqual(r.exercises.length, 3);
  });

  it('Workout B has 3 exercises', () => {
    const r = buildNextSession(SL_ID, slProgress(1, {}));
    assert.strictEqual(r.exercises.length, 3);
  });

  it('Deadlift is 1×5 in Workout B', () => {
    const r = buildNextSession(SL_ID, slProgress(1, {}));
    const dl = r.exercises.find(e => e.liftCode === 'DEADLIFT');
    assert.ok(dl);
    assert.strictEqual(dl.sets, 1);
    assert.strictEqual(dl.reps, 5);
  });

  it('repsScheme is fixed for all SL5×5 exercises', () => {
    for (let i = 0; i < 2; i++) {
      const r = buildNextSession(SL_ID, slProgress(i, {}));
      for (const ex of r.exercises) {
        assert.strictEqual(ex.repsScheme, 'fixed');
      }
    }
  });
});

// ─── buildNextSession — GZCLP ────────────────────────────────────────────────

describe('buildNextSession — GZCLP — cycle', () => {
  it('session 0 → Day 1', () => {
    const r = buildNextSession(GZCLP_ID, gzFresh());
    assert.strictEqual(r.sessionLabel,  'Day 1');
    assert.strictEqual(r.cyclePosition, 0);
  });

  it('session 1 → Day 2', () => {
    const r = buildNextSession(GZCLP_ID, gzProgress(1, {}, {}));
    assert.strictEqual(r.sessionLabel,  'Day 2');
    assert.strictEqual(r.cyclePosition, 1);
  });

  it('session 4 → Day 1 again (cycle wraps)', () => {
    const r = buildNextSession(GZCLP_ID, gzProgress(4, {}, {}));
    assert.strictEqual(r.sessionLabel, 'Day 1');
  });

  it('day labels cycle: Day 1/2/3/4 over 8 sessions', () => {
    const expected = ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 1', 'Day 2', 'Day 3', 'Day 4'];
    for (let i = 0; i < 8; i++) {
      const r = buildNextSession(GZCLP_ID, gzProgress(i, {}, {}));
      assert.strictEqual(r.sessionLabel, expected[i], `session ${i}`);
    }
  });
});

describe('buildNextSession — GZCLP — tiers present', () => {
  it('Day 1 exercises have tiers T1, T2, T3', () => {
    const r = buildNextSession(GZCLP_ID, gzFresh());
    const tiers = r.exercises.map(e => e.tier);
    assert.ok(tiers.includes('T1'));
    assert.ok(tiers.includes('T2'));
    assert.ok(tiers.includes('T3'));
  });

  it('Day 1 T1 lift is SQUAT', () => {
    const r = buildNextSession(GZCLP_ID, gzFresh());
    const t1 = r.exercises.find(e => e.tier === 'T1');
    assert.ok(t1);
    assert.strictEqual(t1.liftCode, 'SQUAT');
  });

  it('Day 2 T1 lift is BENCH', () => {
    const r = buildNextSession(GZCLP_ID, gzProgress(1, {}, {}));
    const t1 = r.exercises.find(e => e.tier === 'T1');
    assert.ok(t1);
    assert.strictEqual(t1.liftCode, 'BENCH');
  });
});

describe('buildNextSession — GZCLP — T1 sets/reps schemes', () => {
  it('T1 at tier 0 → 5×3 amrap', () => {
    const r = buildNextSession(GZCLP_ID, gzFresh());
    const t1 = r.exercises.find(e => e.tier === 'T1');
    assert.ok(t1);
    assert.strictEqual(t1.sets,       5);
    assert.strictEqual(t1.reps,       3);
    assert.strictEqual(t1.repsScheme, 'amrap');
  });

  it('T1 at tier 1 (first stall) → 6×2 amrap', () => {
    const state = { sessionCount: 0, currentWeights: { SQUAT: 135 }, t2Weights: {}, t1Tiers: { SQUAT: 1 }, consecutiveFails: {} };
    const r = buildNextSession(GZCLP_ID, state);
    const t1 = r.exercises.find(e => e.tier === 'T1');
    assert.ok(t1);
    assert.strictEqual(t1.sets, 6);
    assert.strictEqual(t1.reps, 2);
    assert.ok(t1.progressionNote.includes('hold'));
    assert.ok(t1.progressionNote.includes('tier 1'));
  });

  it('T1 at tier 2 (second stall) → 10×1 amrap', () => {
    const state = { sessionCount: 0, currentWeights: { SQUAT: 135 }, t2Weights: {}, t1Tiers: { SQUAT: 2 }, consecutiveFails: {} };
    const r = buildNextSession(GZCLP_ID, state);
    const t1 = r.exercises.find(e => e.tier === 'T1');
    assert.ok(t1);
    assert.strictEqual(t1.sets, 10);
    assert.strictEqual(t1.reps, 1);
    assert.ok(t1.progressionNote.includes('tier 2'));
  });

  it('T1 out-of-bounds tier is clamped to max (2)', () => {
    const state = { sessionCount: 0, currentWeights: { SQUAT: 135 }, t2Weights: {}, t1Tiers: { SQUAT: 99 }, consecutiveFails: {} };
    const r = buildNextSession(GZCLP_ID, state);
    const t1 = r.exercises.find(e => e.tier === 'T1');
    assert.ok(t1);
    assert.strictEqual(t1.sets, 10);
    assert.strictEqual(t1.reps, 1);
  });
});

describe('buildNextSession — GZCLP — T1 weight progression', () => {
  it('T1 upper body increases by 5 lb on success (tier 0)', () => {
    // Day 2: T1 is BENCH (upper_body)
    const state = gzProgress(1, { BENCH: 95 }, {});
    const r = buildNextSession(GZCLP_ID, state);
    const t1 = r.exercises.find(e => e.tier === 'T1');
    assert.ok(t1);
    assert.strictEqual(t1.liftCode, 'BENCH');
    assert.strictEqual(t1.targetWeight, 100);
    assert.ok(t1.progressionNote.includes('5 lb'));
  });

  it('T1 lower body increases by 10 lb on success (tier 0)', () => {
    // Day 1: T1 is SQUAT (lower_body)
    const state = gzProgress(0, { SQUAT: 135 }, {});
    const r = buildNextSession(GZCLP_ID, state);
    const t1 = r.exercises.find(e => e.tier === 'T1');
    assert.ok(t1);
    assert.strictEqual(t1.liftCode, 'SQUAT');
    assert.strictEqual(t1.targetWeight, 145);
  });

  it('T1 uses program default when weight is null', () => {
    const r = buildNextSession(GZCLP_ID, gzFresh());
    const t1 = r.exercises.find(e => e.tier === 'T1');
    assert.ok(t1);
    assert.ok(t1.targetWeight >= 0);
    assert.strictEqual(t1.progressionNote, 'start weight');
  });
});

describe('buildNextSession — GZCLP — T2 progression', () => {
  it('T2 normal scheme is 4×6 amrap', () => {
    const r = buildNextSession(GZCLP_ID, gzFresh());
    const t2 = r.exercises.find(e => e.tier === 'T2');
    assert.ok(t2);
    assert.strictEqual(t2.sets,       4);
    assert.strictEqual(t2.reps,       6);
    assert.strictEqual(t2.repsScheme, 'amrap');
  });

  it('T2 stall scheme switches to 4×10 amrap on first fail', () => {
    const state = { sessionCount: 0, currentWeights: {}, t2Weights: { OHP: 65 }, t1Tiers: {}, consecutiveFails: { OHP: 1 } };
    const r = buildNextSession(GZCLP_ID, state);
    const t2 = r.exercises.find(e => e.tier === 'T2');
    assert.ok(t2);
    assert.strictEqual(t2.sets, 4);
    assert.strictEqual(t2.reps, 10);
    assert.ok(t2.progressionNote.includes('stall'));
  });

  it('T2 deloads after 2 consecutive fails', () => {
    const state = { sessionCount: 0, currentWeights: {}, t2Weights: { OHP: 100 }, t1Tiers: {}, consecutiveFails: { OHP: 2 } };
    const r = buildNextSession(GZCLP_ID, state);
    const t2 = r.exercises.find(e => e.tier === 'T2');
    assert.ok(t2);
    // 100 * 0.90 = 90 → round to nearest 5 → 90
    assert.strictEqual(t2.targetWeight, 90);
    assert.ok(t2.progressionNote.includes('deload'));
  });

  it('T2 deload uses normal scheme (4×6) not stall scheme (4×10)', () => {
    // Deload resets to base 4×6+ so the lifter rebuilds from a lower weight at normal reps.
    const state = { sessionCount: 0, currentWeights: {}, t2Weights: { OHP: 100 }, t1Tiers: {}, consecutiveFails: { OHP: 2 } };
    const r = buildNextSession(GZCLP_ID, state);
    const t2 = r.exercises.find(e => e.tier === 'T2');
    assert.ok(t2);
    assert.strictEqual(t2.sets, 4);
    assert.strictEqual(t2.reps, 6);
  });

  it('T2 deload never exceeds current weight (no inverted deload near floor)', () => {
    // 35 * 0.90 = 31.5 → _round5 → 45 lb floor, but Math.min(35, 45) caps at 35
    const state = { sessionCount: 0, currentWeights: {}, t2Weights: { OHP: 35 }, t1Tiers: {}, consecutiveFails: { OHP: 2 } };
    const r = buildNextSession(GZCLP_ID, state);
    const t2 = r.exercises.find(e => e.tier === 'T2');
    assert.ok(t2);
    assert.ok(t2.targetWeight <= 35, 'T2 deloaded weight must not exceed current weight');
  });

  it('T2 weight increases on success (upper body: +5 lb)', () => {
    const state = gzProgress(0, {}, { OHP: 65 });
    const r = buildNextSession(GZCLP_ID, state);
    const t2 = r.exercises.find(e => e.tier === 'T2');
    assert.ok(t2);
    assert.strictEqual(t2.liftCode, 'OHP');
    assert.strictEqual(t2.targetWeight, 70);
  });
});

describe('buildNextSession — GZCLP — T3 accessories', () => {
  it('T3 exercises use fixed sets/reps from session template', () => {
    const r = buildNextSession(GZCLP_ID, gzFresh());
    const t3 = r.exercises.find(e => e.tier === 'T3');
    assert.ok(t3);
    assert.strictEqual(t3.sets, 3);
    assert.strictEqual(t3.reps, 10);
  });

  it('T3 progressionNote indicates accessory / no load tracking', () => {
    const r = buildNextSession(GZCLP_ID, gzFresh());
    const t3 = r.exercises.find(e => e.tier === 'T3');
    assert.ok(t3);
    assert.ok(t3.progressionNote.includes('accessory'));
  });

  it('T3 exercise is present on all 4 days', () => {
    for (let i = 0; i < 4; i++) {
      const r = buildNextSession(GZCLP_ID, gzProgress(i, {}, {}));
      const t3 = r.exercises.find(e => e.tier === 'T3');
      assert.ok(t3, `Day ${i + 1} should have a T3 exercise`);
    }
  });
});
