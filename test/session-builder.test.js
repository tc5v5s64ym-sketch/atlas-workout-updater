'use strict';

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');

const { buildWarmupRamp, isBlockedPair, buildIntentSession, attachAnchorWarmup } = require('../services/sessionBuilder');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Minimal synthetic allRec matching the shape used by scoreIntents.
function makeRec(exercise, liftCode, coarsePattern, weight, reps, sets = 3, recommendation = 'Continue progressing') {
  return {
    exercise_name: exercise,
    liftCode,
    pattern: coarsePattern,
    next_target: { weight, reps, sets },
    recommendation,
    e1rm_trend: 'stable',
    last_working_sets: [],
    sessions_analyzed: 3,
  };
}

// ── buildWarmupRamp ───────────────────────────────────────────────────────────

describe('buildWarmupRamp — basic ramp', () => {
  it('returns 3 sets for a typical working weight', () => {
    const ramp = buildWarmupRamp(225);
    assert.equal(ramp.length, 3);
  });

  it('sets are at ~50%, ~70%, ~85% of working weight rounded to 5 lb', () => {
    const ramp = buildWarmupRamp(225);
    // 225 × 0.50 = 112.5 → rounds to 115
    // 225 × 0.70 = 157.5 → rounds to 160
    // 225 × 0.85 = 191.25 → rounds to 190
    assert.equal(ramp[0].weight, 115);
    assert.equal(ramp[1].weight, 160);
    assert.equal(ramp[2].weight, 190);
  });

  it('reps taper: 8 / 5 / 3', () => {
    const ramp = buildWarmupRamp(225);
    assert.deepEqual(ramp.map(s => s.reps), [8, 5, 3]);
  });

  it('all sets are flagged priming:true', () => {
    const ramp = buildWarmupRamp(225);
    assert.ok(ramp.every(s => s.priming === true), 'all warm-up sets must be priming:true');
  });

  it('enforces 45 lb minimum (empty barbell) for very light working weights', () => {
    const ramp = buildWarmupRamp(65); // 50% = 32.5 → 35, but min is 45
    assert.ok(ramp.every(s => s.weight >= 45), `weights should be ≥ 45 lb; got ${ramp.map(s => s.weight)}`);
  });

  it('returns empty array for zero weight', () => {
    assert.deepEqual(buildWarmupRamp(0), []);
  });

  it('returns empty array for negative weight', () => {
    assert.deepEqual(buildWarmupRamp(-100), []);
  });

  it('returns empty array for null', () => {
    assert.deepEqual(buildWarmupRamp(null), []);
  });

  it('returns empty array for NaN', () => {
    assert.deepEqual(buildWarmupRamp(NaN), []);
  });
});

// ── isBlockedPair ─────────────────────────────────────────────────────────────

describe('isBlockedPair — blocked combinations', () => {
  it('Deadlift + RDL is blocked (both hinge, both HIGH)', () => {
    assert.equal(isBlockedPair('Deadlift', 'RDL'), true);
  });

  it('RDL + Deadlift is blocked (commutative)', () => {
    assert.equal(isBlockedPair('RDL', 'Deadlift'), true);
  });

  it('Deadlift + Romanian Deadlift is blocked', () => {
    assert.equal(isBlockedPair('Deadlift', 'Romanian Deadlift'), true);
  });

  it('Barbell Row + Bent-Over Row is blocked (both horizontal_pull, both HIGH)', () => {
    assert.equal(isBlockedPair('Barbell Row', 'Bent-Over Row'), true);
  });
});

describe('isBlockedPair — allowed combinations', () => {
  it('Back Squat + Deadlift is allowed (squat ≠ hinge)', () => {
    assert.equal(isBlockedPair('Back Squat', 'Deadlift'), false);
  });

  it('Deadlift + Bench Press is allowed (hinge ≠ horizontal_push)', () => {
    assert.equal(isBlockedPair('Deadlift', 'Bench Press'), false);
  });

  it('Lat Pulldown + Seated Row is allowed (both MEDIUM, not HIGH)', () => {
    assert.equal(isBlockedPair('Lat Pulldown', 'Seated Row'), false);
  });

  it('Bench Press + Barbell Row is allowed (horizontal_push ≠ horizontal_pull)', () => {
    assert.equal(isBlockedPair('Bench Press', 'Barbell Row'), false);
  });

  it('Overhead Press + Deadlift is allowed (vertical_push ≠ hinge)', () => {
    assert.equal(isBlockedPair('Overhead Press', 'Deadlift'), false);
  });
});

describe('isBlockedPair — null safety', () => {
  it('returns false for null first arg', () => {
    assert.equal(isBlockedPair(null, 'Deadlift'), false);
  });

  it('returns false for null second arg', () => {
    assert.equal(isBlockedPair('Deadlift', null), false);
  });

  it('returns false for both null', () => {
    assert.equal(isBlockedPair(null, null), false);
  });
});

// ── buildIntentSession — AC4: Anchor + ramp ──────────────────────────────────

describe('AC4 — anchor selection and warm-up ramp', () => {
  const allRecs = [
    makeRec('Barbell Row', 'BR01', 'pull', 185, 8),
    makeRec('Seated Row',  'SR01', 'pull', 140, 12),
    makeRec('Face Pull',   'FP01', 'pull', 50,  15),
  ];

  it('Barbell Row (HIGH cost) becomes the anchor', () => {
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    assert.equal(session.anchor, 'Barbell Row');
  });

  it('anchor is the first exercise in the session', () => {
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    assert.equal(session.exercises[0].exercise, 'Barbell Row');
  });

  it('anchor is flagged is_anchor:true', () => {
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    assert.equal(session.exercises[0].is_anchor, true);
  });

  it('non-anchor exercises are flagged is_anchor:false', () => {
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    const nonAnchors = session.exercises.filter(e => !e.is_anchor);
    assert.ok(nonAnchors.length > 0, 'at least one non-anchor exercise expected');
    assert.ok(nonAnchors.every(e => e.is_anchor === false), 'all non-anchors must be is_anchor:false');
  });

  it('anchor gets exactly 3 warm-up sets', () => {
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    assert.equal(session.exercises[0].warmup_sets.length, 3);
  });

  it('all warm-up sets are priming:true', () => {
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    const ramp = session.exercises[0].warmup_sets;
    assert.ok(ramp.every(s => s.priming === true), 'every warm-up set must have priming:true');
  });

  it('warm-up weights ascend toward working weight', () => {
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    const ramp = session.exercises[0].warmup_sets;
    assert.ok(ramp[0].weight < ramp[1].weight, 'first ramp set lighter than second');
    assert.ok(ramp[1].weight < ramp[2].weight, 'second ramp set lighter than third');
    assert.ok(ramp[2].weight < 185, 'top ramp set lighter than working weight');
  });

  it('non-anchor exercises have no warmup_sets', () => {
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    const nonAnchors = session.exercises.filter(e => !e.is_anchor);
    for (const ex of nonAnchors) {
      assert.equal(ex.warmup_sets, undefined, `${ex.exercise} should not have warmup_sets`);
    }
  });

  it('MEDIUM-cost lift becomes anchor when no HIGH-cost lift is present', () => {
    const medsOnly = [
      makeRec('Seated Row',  'SR01', 'pull', 140, 12),
      makeRec('Lat Pulldown','LP01', 'pull', 130, 10),
    ];
    const session = buildIntentSession({ patterns: ['pull'], allRecs: medsOnly, underCoverageData: [] });
    assert.equal(session.anchor, 'Seated Row');
    assert.equal(session.exercises[0].is_anchor, true);
    assert.equal(session.exercises[0].warmup_sets.length, 3);
  });
});

// ── buildIntentSession — AC2: No duplicate lifts ─────────────────────────────

describe('AC2 — no duplicate lifts', () => {
  it('same exercise name (different lift codes) appears at most once', () => {
    // This is the Seated Row bug: same canonical name, two lift_codes
    const allRecs = [
      makeRec('Seated Row', 'SR01', 'pull', 190, 11),
      makeRec('Seated Row', 'SR02', 'pull', 190, 10),
      makeRec('Barbell Row','BR01', 'pull', 185, 8),
    ];
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    const names = session.exercises.map(e => e.exercise.toLowerCase());
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `duplicate exercise detected: ${names}`);
  });

  it('same lift code never appears twice even if listed twice in allRecs', () => {
    const rec = makeRec('Lat Pulldown', 'LP01', 'pull', 140, 10);
    const allRecs = [rec, { ...rec }]; // identical liftCode
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    const codes = session.exercises.map(e => e.lift_code);
    const unique = new Set(codes);
    assert.equal(unique.size, codes.length, `duplicate lift_code detected: ${codes}`);
  });
});

// ── buildIntentSession — AC3: per-muscle isolation cap ───────────────────────

describe('AC3 — at most one isolation per primary muscle', () => {
  it('blocks a second bicep isolation (Hammer Curls + Dumbbell Curl)', () => {
    const allRecs = [
      makeRec('Barbell Row',  'BR01', 'pull', 185, 8),
      makeRec('Lat Pulldown', 'LP01', 'pull', 140, 10),
      makeRec('Hammer Curls', 'HC01', 'pull', 40,  12),
      makeRec('Dumbbell Curl','DC01', 'pull', 35,  12),
    ];
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    const names = session.exercises.map(e => e.exercise);
    const bicepIsos = names.filter(n => /hammer|dumbbell curl/i.test(n));
    assert.equal(bicepIsos.length, 1, `expected 1 bicep isolation; got: ${bicepIsos.join(', ')}`);
  });

  it('allows two isolations when they target different muscles', () => {
    const allRecs = [
      makeRec('Barbell Row',   'BR01', 'pull', 185, 8),
      makeRec('Hammer Curls',  'HC01', 'pull', 40,  12), // biceps + forearms
      makeRec('Lateral Raise', 'LR01', 'push', 25,  15), // side_delts
    ];
    // Hammer Curls → pull pattern; Lateral Raise → push pattern
    const session = buildIntentSession({
      patterns: ['pull', 'push'],
      allRecs,
      underCoverageData: [],
    });
    const names = session.exercises.map(e => e.exercise);
    assert.ok(names.includes('Hammer Curls'), 'Hammer Curls should be included');
    assert.ok(names.includes('Lateral Raise'), 'Lateral Raise should be included (different muscle)');
  });
});

// ── buildIntentSession — AC1: brief matches session (coveredPatterns) ─────────

describe('AC1 — coveredPatterns reflects only scheduled patterns', () => {
  it('core is absent from coveredPatterns when no core exercises exist in allRecs', () => {
    const allRecs = [
      makeRec('Barbell Row', 'BR01', 'pull', 185, 8),
      makeRec('Seated Row',  'SR01', 'pull', 140, 12),
    ];
    const session = buildIntentSession({
      patterns: ['pull', 'core'],
      allRecs,
      underCoverageData: [],
    });
    assert.ok(!session.coveredPatterns.has('core'),
      'core should not appear in coveredPatterns when no core lifts are scheduled');
  });

  it('pull is present in coveredPatterns when pull exercises are scheduled', () => {
    const allRecs = [
      makeRec('Barbell Row', 'BR01', 'pull', 185, 8),
    ];
    const session = buildIntentSession({ patterns: ['pull', 'core'], allRecs, underCoverageData: [] });
    assert.ok(session.coveredPatterns.has('pull'), 'pull should be in coveredPatterns');
  });

  it('coveredPatterns matches exactly the coarse patterns of scheduled exercises', () => {
    const allRecs = [
      makeRec('Barbell Row',    'BR01', 'pull',  185, 8),
      makeRec('Bench Press',    'BP01', 'push',  225, 5),
      makeRec('Hanging Knee Raises', 'KR01', 'core', 0, 15),
    ];
    // Ask for pull+push+core but core exercise has weight 0 (won't get a next_target check — wait,
    // makeRec gives next_target: { weight: 0, reps: 15, sets: 3 }; that's fine for the test).
    const session = buildIntentSession({
      patterns: ['pull', 'push', 'core'],
      allRecs,
      underCoverageData: [],
    });
    // All three patterns present
    assert.ok(session.coveredPatterns.has('pull'), 'pull should be covered');
    assert.ok(session.coveredPatterns.has('push'), 'push should be covered');
    assert.ok(session.coveredPatterns.has('core'), 'core should be covered when core exercise exists');
  });
});

// ── buildIntentSession — blocked pair enforcement ─────────────────────────────

describe('blocked-pair enforcement in session', () => {
  it('RDL excluded from session when Deadlift is the anchor (hinge+hinge, both HIGH)', () => {
    const allRecs = [
      makeRec('Deadlift', 'DL01', 'hinge', 315, 5),
      makeRec('RDL',      'RD01', 'hinge', 225, 8),
      makeRec('Leg Curl', 'LC01', 'lower', 100, 12), // different pattern → allowed as filler
    ];
    const session = buildIntentSession({
      patterns: ['hinge', 'lower'],
      allRecs,
      underCoverageData: [],
    });
    assert.equal(session.anchor, 'Deadlift', 'Deadlift should be the anchor');
    const names = session.exercises.map(e => e.exercise);
    assert.ok(!names.some(n => /rdl|romanian/i.test(n)),
      `RDL should be blocked; session has: ${names.join(', ')}`);
  });

  it('Back Squat is NOT blocked when Deadlift is the anchor (squat ≠ hinge)', () => {
    const allRecs = [
      makeRec('Deadlift',   'DL01', 'hinge', 315, 5),
      makeRec('Back Squat', 'SQ01', 'lower', 275, 5),
    ];
    const session = buildIntentSession({
      patterns: ['hinge', 'lower'],
      allRecs,
      underCoverageData: [],
    });
    const names = session.exercises.map(e => e.exercise);
    assert.ok(names.includes('Back Squat'),
      `Back Squat should be allowed alongside Deadlift; session has: ${names.join(', ')}`);
  });
});

// ── buildIntentSession — balance slot ─────────────────────────────────────────

describe('balance slot — fills biggest under-coverage gap', () => {
  it('includes an exercise from outside the requested patterns when a gap exists', () => {
    // Patterns requested: pull only. But front_delts is under-served → OHP (push) should be added.
    const allRecs = [
      makeRec('Barbell Row',   'BR01', 'pull', 185, 8),
      makeRec('Lat Pulldown',  'LP01', 'pull', 140, 10),
      makeRec('Overhead Press','OHP01','push', 135, 6),
    ];
    const underCoverageData = [{ muscle: 'front_delts', status: 'under' }];
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData });
    const names = session.exercises.map(e => e.exercise);
    assert.ok(names.includes('Overhead Press'),
      `balance slot should include OHP for front_delts gap; session has: ${names.join(', ')}`);
  });

  it('balance reason mentions the under-served muscle', () => {
    const allRecs = [
      makeRec('Barbell Row',   'BR01', 'pull', 185, 8),
      makeRec('Overhead Press','OHP01','push', 135, 6),
    ];
    const underCoverageData = [{ muscle: 'front_delts', status: 'under' }];
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData });
    const balanceEx = session.exercises.find(e => e.exercise === 'Overhead Press');
    assert.ok(balanceEx, 'Overhead Press should be in session as balance slot');
    assert.match(balanceEx.reason, /front_delts/, 'balance reason should name the under-served muscle');
  });

  it('skips balance slot when under-coverage is empty', () => {
    const allRecs = [
      makeRec('Barbell Row', 'BR01', 'pull', 185, 8),
    ];
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    // Session should just have pull exercises, no extra balance slot
    const names = session.exercises.map(e => e.exercise);
    assert.deepEqual(names, ['Barbell Row']);
  });

  it('does not re-add an exercise already in the session as a balance slot', () => {
    const allRecs = [
      makeRec('Barbell Row', 'BR01', 'pull', 185, 8),
    ];
    // lats is under-covered; Barbell Row covers lats — but it's already in session
    const underCoverageData = [{ muscle: 'lats', status: 'under' }];
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData });
    const brows = session.exercises.filter(e => e.exercise === 'Barbell Row');
    assert.equal(brows.length, 1, 'Barbell Row should not appear twice even if lats is under-covered');
  });
});

// ── buildIntentSession — empty / edge inputs ──────────────────────────────────

describe('buildIntentSession — edge cases', () => {
  it('returns empty session for empty allRecs', () => {
    const session = buildIntentSession({ patterns: ['pull'], allRecs: [], underCoverageData: [] });
    assert.deepEqual(session.exercises, []);
    assert.equal(session.anchor, null);
    assert.equal(session.coveredPatterns.size, 0);
  });

  it('returns empty session when no candidates match requested patterns', () => {
    const allRecs = [
      makeRec('Back Squat', 'SQ01', 'lower', 225, 5),
    ];
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    assert.deepEqual(session.exercises, []);
    assert.equal(session.anchor, null);
  });

  it('isolation-only pool has no anchor', () => {
    const allRecs = [
      makeRec('Dumbbell Curl', 'DC01', 'pull', 35, 12),
      makeRec('Face Pull',     'FP01', 'pull', 50, 15),
    ];
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [] });
    assert.equal(session.anchor, null, 'no anchor when only isolations are available');
    // Both should still appear in exercises (as non-anchors without warmup_sets)
    assert.equal(session.exercises.length, 2);
    assert.ok(session.exercises.every(e => e.is_anchor === false));
  });

  it('respects maxExercises cap', () => {
    const allRecs = [
      makeRec('Barbell Row',    'BR01', 'pull', 185, 8),
      makeRec('Seated Row',     'SR01', 'pull', 140, 12),
      makeRec('Lat Pulldown',   'LP01', 'pull', 130, 10),
      makeRec('Hammer Curls',   'HC01', 'pull', 40,  12),
      makeRec('Dumbbell Curl',  'DC01', 'pull', 35,  12),
      makeRec('Face Pull',      'FP01', 'pull', 50,  15),
      makeRec('Reverse Fly',    'RF01', 'pull', 30,  15),
    ];
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [], maxExercises: 4 });
    assert.equal(session.exercises.length, 4, `should fill to maxExercises=4 when no under-coverage gap; got ${session.exercises.length}`);
  });

  it('fills to maxExercises when under-coverage is empty (no wasted balance slot)', () => {
    // Regression: with old code, supportCap was always maxExercises-1 even when
    // no balance lift would ever be added, silently returning one fewer exercise.
    const allRecs = [
      makeRec('Barbell Row',  'BR01', 'pull', 185, 8),
      makeRec('Seated Row',   'SR01', 'pull', 140, 12),
      makeRec('Lat Pulldown', 'LP01', 'pull', 130, 10),
      makeRec('Face Pull',    'FP01', 'pull', 50,  15),
      makeRec('Hammer Curls', 'HC01', 'pull', 40,  12),
      makeRec('Rear Delt Fly','RD01', 'pull', 25,  15),
    ];
    const session = buildIntentSession({ patterns: ['pull'], allRecs, underCoverageData: [], maxExercises: 6 });
    assert.equal(session.exercises.length, 6,
      `should return 6 exercises when 6+ candidates are available and under-coverage is empty; got ${session.exercises.length}`);
  });
});

// ── attachAnchorWarmup ──────────────────────────────────────────────────────
// SESSION_DESIGN.md "Set progression — warm-up ramps": the lead compound of a
// session climbs into its working sets; later lifts and accessories stay flat.
// This is the engine fix for the live "flat sets from set one" bug on the
// build_strength intent's exForPatterns list (which doesn't route through
// buildIntentSession's anchor ramp).

// Exercise shape as emitted by exForPatterns / buildIntentSession.
function makeEx(exercise, lift_code, target_weight, target_reps = 5, target_sets = 3) {
  return { exercise, lift_code, target_weight, target_reps, target_sets, reason: 'Continue progressing' };
}

describe('attachAnchorWarmup — lead compound ramps, accessories stay flat', () => {
  it('Deadlift lead compound gets an ascending warm-up ramp (not flat from set one)', () => {
    const list = [makeEx('Deadlift', 'DL01', 245, 7), makeEx('Face Pull', 'FP01', 50, 15)];
    const out = attachAnchorWarmup(list);
    const dl = out.find(e => e.exercise === 'Deadlift');
    assert.ok(Array.isArray(dl.warmup_sets) && dl.warmup_sets.length === 3, 'Deadlift should carry a 3-step ramp');
    assert.equal(dl.is_anchor, true);
    // Ascending load into the working weight — proves it is a build-up, not flat.
    const w = dl.warmup_sets.map(s => s.weight);
    assert.ok(w[0] < w[1] && w[1] < w[2] && w[2] < 245, `ramp must ascend below working weight; got ${w}`);
    dl.warmup_sets.forEach(s => assert.equal(s.priming, true, 'warm-ups are priming, not working sets'));
  });

  it('working sets are preserved — the ramp is ADDED, never a substitute for them', () => {
    const out = attachAnchorWarmup([makeEx('Back Squat', 'SQ01', 240, 5, 3)]);
    const sq = out[0];
    assert.equal(sq.target_weight, 240);
    assert.equal(sq.target_reps, 5);
    assert.equal(sq.target_sets, 3, 'prescribed working sets unchanged');
  });

  it('Back Squat lead compound ramps', () => {
    const out = attachAnchorWarmup([makeEx('Back Squat', 'SQ01', 240, 5)]);
    assert.equal(out[0].warmup_sets.length, 3);
  });

  it('Overhead Press (a major compound) follows the same lead-compound policy', () => {
    const out = attachAnchorWarmup([makeEx('Overhead Press', 'OHP01', 116, 10)]);
    assert.ok(out[0].warmup_sets.length === 3, 'OHP is a compound → ramps');
    assert.equal(out[0].is_anchor, true);
  });

  it('accessories / isolation-only lists stay flat (no ramp)', () => {
    const list = [makeEx('Lateral Raise', 'LR01', 20, 15), makeEx('Bicep Curl', 'BC01', 40, 12)];
    const out = attachAnchorWarmup(list);
    out.forEach(e => assert.ok(!e.warmup_sets, `accessory ${e.exercise} must stay flat`));
  });

  it('only the FIRST compound (lead) ramps — a later compound stays flat', () => {
    const list = [makeEx('Deadlift', 'DL01', 245, 7), makeEx('Bench Press', 'BN01', 185, 6)];
    const out = attachAnchorWarmup(list);
    assert.ok(out[0].warmup_sets, 'lead compound ramps');
    assert.ok(!out[1].warmup_sets, 'later compound stays flat (already-warm policy)');
  });

  it('unknown / missing working weight does NOT fabricate a ramp', () => {
    const noWeight = attachAnchorWarmup([makeEx('Deadlift', 'DL01', null, 5)]);
    assert.ok(!noWeight[0].warmup_sets, 'no working weight → no ramp');
    const zero = attachAnchorWarmup([makeEx('Deadlift', 'DL01', 0, 5)]);
    assert.ok(!zero[0].warmup_sets, 'zero working weight → no ramp');
  });

  it('is idempotent — a list buildIntentSession already ramped is left untouched', () => {
    const already = [{ ...makeEx('Deadlift', 'DL01', 245, 7), is_anchor: true, warmup_sets: buildWarmupRamp(245) }];
    const out = attachAnchorWarmup(already);
    assert.equal(out, already, 'already-ramped list returned unchanged (same reference)');
  });

  it('empty / non-array input is safe', () => {
    assert.deepEqual(attachAnchorWarmup([]), []);
    assert.deepEqual(attachAnchorWarmup(null), []);
  });
});
