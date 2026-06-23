'use strict';

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');

const { buildWarmupRamp, buildPersonalizedRamp, isBlockedPair, buildIntentSession, orderByRole, attachMainCompoundWarmups, capLowerBodyAccessoriesForHeavyLegDay, capSessionToProfile, structureSession } = require('../services/sessionBuilder');

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

// ── orderByRole + attachMainCompoundWarmups ─────────────────────────────────
// SESSION_DESIGN.md "Set progression — warm-up ramps" + owner ordering direction
// (main → secondary → accessory). The strength session's exForPatterns list is in
// recency order; orderByRole structures it and attachMainCompoundWarmups ramps
// each main compound per movement pattern (the live "Back Squat buried after leg
// extension, and flat" bug).

// Exercise shape as emitted by exForPatterns / buildIntentSession.
function makeEx(exercise, lift_code, target_weight, target_reps = 5, target_sets = 3) {
  return { exercise, lift_code, target_weight, target_reps, target_sets, reason: 'Continue progressing' };
}

describe('orderByRole — main compounds first, accessories last, no burying', () => {
  it('Deadlift + Back Squat session does not place accessories between the compounds', () => {
    // Recency order (the live bug): DL, leg ext, leg curl, squat, leg press.
    const recencyOrder = [
      makeEx('Deadlift', 'DL01', 245, 7),
      makeEx('Leg Extension', 'LE01', 60, 16),
      makeEx('Single-Leg Leg Curl', 'LC01', 60, 11),
      makeEx('Back Squat', 'SQ01', 240, 5),
      makeEx('Single-Leg Seated Leg Press', 'LP01', 70, 12),
    ];
    const out = orderByRole(recencyOrder).map(e => e.exercise);
    // Both heavy compounds precede every accessory; leg press (secondary) sits between.
    assert.deepEqual(out, [
      'Deadlift', 'Back Squat',
      'Single-Leg Seated Leg Press',
      'Leg Extension', 'Single-Leg Leg Curl',
    ]);
    const lastMain = out.lastIndexOf('Back Squat');
    const firstAccessory = out.indexOf('Leg Extension');
    assert.ok(lastMain < firstAccessory, 'no accessory may sit before a main compound');
  });

  it('is stable within a role tier (preserves upstream recency order)', () => {
    const list = [makeEx('Deadlift', 'DL01', 245, 7), makeEx('Back Squat', 'SQ01', 240, 5)];
    assert.deepEqual(orderByRole(list).map(e => e.exercise), ['Deadlift', 'Back Squat']);
  });

  it('empty / non-array input is safe', () => {
    assert.deepEqual(orderByRole([]), []);
    assert.deepEqual(orderByRole(null), []);
  });
});

describe('attachMainCompoundWarmups — every main compound ramps per pattern', () => {
  it('Deadlift main compound gets an ascending warm-up ramp (not flat from set one)', () => {
    const list = [makeEx('Deadlift', 'DL01', 245, 7), makeEx('Face Pull', 'FP01', 50, 15)];
    const out = attachMainCompoundWarmups(list);
    const dl = out.find(e => e.exercise === 'Deadlift');
    assert.ok(Array.isArray(dl.warmup_sets) && dl.warmup_sets.length === 3, 'Deadlift should carry a 3-step ramp');
    const w = dl.warmup_sets.map(s => s.weight);
    assert.ok(w[0] < w[1] && w[1] < w[2] && w[2] < 245, `ramp must ascend below working weight; got ${w}`);
    dl.warmup_sets.forEach(s => assert.equal(s.priming, true, 'warm-ups are priming, not working sets'));
  });

  it('Back Squat (second main, DIFFERENT pattern) ALSO ramps — the live fix', () => {
    const list = [makeEx('Deadlift', 'DL01', 245, 7), makeEx('Back Squat', 'SQ01', 240, 5)];
    const out = attachMainCompoundWarmups(list);
    assert.ok(out[0].warmup_sets && out[0].warmup_sets.length === 3, 'Deadlift (hinge) ramps');
    assert.ok(out[1].warmup_sets && out[1].warmup_sets.length === 3, 'Back Squat (squat) also ramps — different pattern');
  });

  it('Bench and OHP both ramp when working weight is known (different push patterns)', () => {
    const out = attachMainCompoundWarmups([makeEx('Bench Press', 'BN01', 185, 6), makeEx('Overhead Press', 'OHP01', 116, 10)]);
    assert.ok(out[0].warmup_sets.length === 3, 'Bench (horizontal push) ramps');
    assert.ok(out[1].warmup_sets.length === 3, 'OHP (vertical push) ramps');
  });

  it('a SECOND main of the SAME pattern (RDL after Deadlift — both hinge) stays flat', () => {
    const out = attachMainCompoundWarmups([makeEx('Deadlift', 'DL01', 245, 7), makeEx('Romanian Deadlift', 'RDL01', 185, 8)]);
    assert.ok(out[0].warmup_sets, 'first hinge ramps');
    assert.ok(!out[1].warmup_sets, 'already-warm same-pattern main stays flat (reduced-depth deferred)');
  });

  it('working sets are preserved — the ramp is ADDED, never a substitute', () => {
    const out = attachMainCompoundWarmups([makeEx('Back Squat', 'SQ01', 240, 5, 3)]);
    assert.equal(out[0].target_weight, 240);
    assert.equal(out[0].target_reps, 5);
    assert.equal(out[0].target_sets, 3, 'prescribed working sets unchanged');
  });

  it('secondary compounds (leg press) and accessories stay flat', () => {
    const list = [
      makeEx('Single-Leg Seated Leg Press', 'LP01', 70, 12),
      makeEx('Leg Extension', 'LE01', 60, 16),
      makeEx('Bicep Curl', 'BC01', 40, 12),
    ];
    const out = attachMainCompoundWarmups(list);
    out.forEach(e => assert.ok(!e.warmup_sets, `${e.exercise} (secondary/accessory) must stay flat`));
  });

  it('unknown / missing working weight does NOT fabricate a ramp', () => {
    const noWeight = attachMainCompoundWarmups([makeEx('Deadlift', 'DL01', null, 5)]);
    assert.ok(!noWeight[0].warmup_sets, 'no working weight → no ramp');
    const zero = attachMainCompoundWarmups([makeEx('Deadlift', 'DL01', 0, 5)]);
    assert.ok(!zero[0].warmup_sets, 'zero working weight → no ramp');
  });

  it('is idempotent — a list already ramped is left untouched', () => {
    const already = [{ ...makeEx('Deadlift', 'DL01', 245, 7), is_anchor: true, warmup_sets: buildWarmupRamp(245) }];
    const out = attachMainCompoundWarmups(already);
    assert.equal(out, already, 'already-ramped list returned unchanged (same reference)');
  });

  it('empty / non-array input is safe', () => {
    assert.deepEqual(attachMainCompoundWarmups([]), []);
    assert.deepEqual(attachMainCompoundWarmups(null), []);
  });
});

describe('capLowerBodyAccessoriesForHeavyLegDay — volume budget for double-heavy-leg days', () => {
  // The live overload: DL + Squat + leg press + leg ext + leg curl.
  function heavyLegDay() {
    return [
      makeEx('Deadlift', 'DL01', 245, 7),
      makeEx('Back Squat', 'SQ01', 240, 5),
      makeEx('Single-Leg Seated Leg Press', 'LP01', 70, 12),
      makeEx('Leg Extension', 'LE01', 60, 16),
      makeEx('Single-Leg Leg Curl', 'LC01', 60, 11),
    ];
  }

  it('with 2 main lower compounds, caps lower-body accessories to 1 (drops the surplus)', () => {
    const out = capLowerBodyAccessoriesForHeavyLegDay(heavyLegDay());
    const names = out.map(e => e.exercise);
    // Both mains + the secondary leg press are kept; only one leg isolation remains.
    assert.ok(names.includes('Deadlift') && names.includes('Back Squat'), 'main compounds kept');
    assert.ok(names.includes('Single-Leg Seated Leg Press'), 'secondary compound kept');
    const lowerAccessories = names.filter(n => /leg extension|leg curl/i.test(n));
    assert.equal(lowerAccessories.length, 1, `lower-body accessories capped to 1; got ${lowerAccessories.length}`);
    // The full DL+Squat+press+ext+curl pile-up must not survive intact.
    assert.ok(out.length < 5, 'session trimmed below the 5-lift overload');
  });

  it('does NOT fire with only ONE main lower compound (normal leg day untouched)', () => {
    const list = [
      makeEx('Back Squat', 'SQ01', 240, 5),
      makeEx('Leg Extension', 'LE01', 60, 16),
      makeEx('Single-Leg Leg Curl', 'LC01', 60, 11),
    ];
    assert.deepEqual(capLowerBodyAccessoriesForHeavyLegDay(list), list, 'single-compound leg day is unchanged');
  });

  it('never trims main / secondary compounds or upper-body work', () => {
    const list = [
      makeEx('Deadlift', 'DL01', 245, 7),
      makeEx('Back Squat', 'SQ01', 240, 5),
      makeEx('Bench Press', 'BN01', 185, 6),   // upper main — must stay
      makeEx('Lateral Raise', 'LR01', 20, 15), // upper accessory — must stay
      makeEx('Leg Extension', 'LE01', 60, 16),
      makeEx('Single-Leg Leg Curl', 'LC01', 60, 11),
    ];
    const out = capLowerBodyAccessoriesForHeavyLegDay(list).map(e => e.exercise);
    assert.ok(out.includes('Bench Press') && out.includes('Lateral Raise'), 'upper-body work untouched');
    assert.equal(out.filter(n => /leg extension|leg curl/i.test(n)).length, 1, 'only lower accessories capped');
  });

  it('empty / non-array input is safe', () => {
    assert.deepEqual(capLowerBodyAccessoriesForHeavyLegDay([]), []);
    assert.deepEqual(capLowerBodyAccessoriesForHeavyLegDay(null), []);
  });
});

describe('structureSession — one role-aware pass shared by every training intent', () => {
  it('strips a builder-applied anchor ramp and re-ramps the MAIN compounds', () => {
    // buildIntentSession-style input: Leg Press (a SECONDARY lift) is the anchor
    // and pre-ramped; accessories interleaved; Back Squat flat. The screenshot bug.
    const fromBuildIntentSession = [
      { exercise: 'Deadlift', lift_code: 'DL01', target_weight: 245, target_reps: 7, target_sets: 3, is_anchor: true, warmup_sets: buildWarmupRamp(245) },
      makeEx('Leg Extension', 'LE01', 60, 16),
      makeEx('Single-Leg Leg Curl', 'LC01', 60, 11),
      makeEx('Back Squat', 'SQ01', 240, 5),
      makeEx('Single-Leg Seated Leg Press', 'LP01', 70, 12),
    ];
    const out = structureSession(fromBuildIntentSession);
    const names = out.map(e => e.exercise);
    // main compounds first, both ramped; secondary leg press next; one isolation; curl capped out.
    assert.deepEqual(names, ['Deadlift', 'Back Squat', 'Single-Leg Seated Leg Press', 'Leg Extension']);
    assert.ok(out[0].warmup_sets && out[1].warmup_sets, 'both main compounds ramp');
    assert.ok(!out[2].warmup_sets, 'secondary leg press stays flat');
    assert.ok(!out[3].warmup_sets, 'accessory stays flat');
  });

  it('does NOT let a secondary-lift anchor keep its ramp (only main compounds ramp)', () => {
    // Leg Press is the anchor buildIntentSession ramped, but it is role=secondary.
    const input = [
      { exercise: 'Single-Leg Seated Leg Press', lift_code: 'LP01', target_weight: 70, target_reps: 12, target_sets: 3, is_anchor: true, warmup_sets: buildWarmupRamp(70) },
      makeEx('Leg Extension', 'LE01', 60, 16),
    ];
    const out = structureSession(input);
    out.forEach(e => assert.ok(!e.warmup_sets, `${e.exercise} (secondary/accessory) must not ramp`));
  });

  it('preserves non-ramp fields (reason, confidence) through the pass', () => {
    const input = [{ exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 240, target_reps: 5, target_sets: 3, reason: 'progress', confidence_factors: { sessions: 5 } }];
    const out = structureSession(input);
    assert.equal(out[0].reason, 'progress');
    assert.deepEqual(out[0].confidence_factors, { sessions: 5 });
    assert.ok(out[0].warmup_sets, 'a known-weight main compound ramps');
  });

  it('empty / non-array input is safe', () => {
    assert.deepEqual(structureSession([]), []);
    assert.deepEqual(structureSession(null), []);
  });
});

describe('buildPersonalizedRamp — scale a lifter\'s learned ramp to today\'s weight', () => {
  it('scales the owner\'s 2-step Bench shape (~0.60/0.82 × 15/10) to the working weight', () => {
    const shape = { steps: [{ load_fraction: 0.60, reps: 15 }, { load_fraction: 0.82, reps: 10 }] };
    const ramp = buildPersonalizedRamp(225, shape);
    assert.deepEqual(ramp, [
      { weight: 135, reps: 15, priming: true }, // 225×0.60
      { weight: 185, reps: 10, priming: true }, // 225×0.82 = 184.5 → 185
    ]);
  });

  it('preserves the lifter\'s rep scheme (not the generic 8/5/3)', () => {
    const ramp = buildPersonalizedRamp(225, { steps: [{ load_fraction: 0.6, reps: 15 }, { load_fraction: 0.82, reps: 10 }] });
    assert.deepEqual(ramp.map(s => s.reps), [15, 10]);
  });

  it('drops steps that round to ≥ the working weight (not a warm-up)', () => {
    const ramp = buildPersonalizedRamp(100, { steps: [{ load_fraction: 0.5, reps: 8 }, { load_fraction: 0.99, reps: 3 }] });
    assert.equal(ramp.length, 1);
    assert.ok(ramp[0].weight < 100);
  });

  it('keeps the ramp strictly ascending (drops post-rounding duplicates)', () => {
    const ramp = buildPersonalizedRamp(100, { steps: [{ load_fraction: 0.50, reps: 8 }, { load_fraction: 0.52, reps: 6 }] });
    const ws = ramp.map(s => s.weight);
    for (let i = 1; i < ws.length; i++) assert.ok(ws[i] > ws[i - 1], `ascending; got ${ws}`);
  });

  it('returns [] for missing/invalid shape or weight (→ caller uses the generic ramp)', () => {
    assert.deepEqual(buildPersonalizedRamp(225, null), []);
    assert.deepEqual(buildPersonalizedRamp(225, { steps: [] }), []);
    assert.deepEqual(buildPersonalizedRamp(0, { steps: [{ load_fraction: 0.6, reps: 10 }] }), []);
    assert.deepEqual(buildPersonalizedRamp(225, { steps: [{ load_fraction: 1.2, reps: 10 }] }), []); // ≥1 → no sub-working step
  });
});

describe('attachMainCompoundWarmups — personalized when a shape exists, generic otherwise', () => {
  it('uses the lifter\'s learned ramp for a main compound that has a shape', () => {
    const list = [makeEx('Bench Press', 'BEN01', 225, 5)];
    const rampShapeFor = (ex) => ex.lift_code === 'BEN01'
      ? { steps: [{ load_fraction: 0.60, reps: 15 }, { load_fraction: 0.82, reps: 10 }] }
      : null;
    const out = attachMainCompoundWarmups(list, { rampShapeFor });
    assert.deepEqual(out[0].warmup_sets.map(s => s.reps), [15, 10], 'personalized rep scheme');
    assert.equal(out[0].warmup_sets.length, 2);
  });

  it('falls back to the generic ramp when no shape is available', () => {
    const list = [makeEx('Bench Press', 'BEN01', 225, 5)];
    const out = attachMainCompoundWarmups(list, { rampShapeFor: () => null });
    assert.deepEqual(out[0].warmup_sets.map(s => s.reps), [8, 5, 3], 'generic 8/5/3');
  });

  it('with no opts, behaves exactly as before (generic ramp)', () => {
    const out = attachMainCompoundWarmups([makeEx('Deadlift', 'DL01', 245, 5)]);
    assert.deepEqual(out[0].warmup_sets.map(s => s.reps), [8, 5, 3]);
  });
});

describe('capSessionToProfile — the cap is DERIVED FROM the profile, not hardcoded', () => {
  // role check: main = Bench/Squat/Deadlift/OHP/Barbell Row; secondary = Leg Press /
  // Lat Pulldown; accessory = Lateral Raise / Bicep Curl / Face Pull / Leg Extension.
  const M = (n, c) => makeEx(n, c, 185, 5);      // main compound
  const S = (n, c) => makeEx(n, c, 150, 8);      // secondary compound
  const A = (n, c) => makeEx(n, c, 30, 12);      // accessory
  const roles = list => list.map(e => classifyRole(e));
  function classifyRole(e) { const { classifyLiftRole } = require('../services/liftRole'); return classifyLiftRole(e.exercise, e.muscle_group); }

  // An 8-exercise plan: 3 main + 2 secondary + 3 accessory (role-ordered).
  const bigPlan = () => [
    M('Bench Press', 'Chest'), M('Barbell Row', 'Back'), M('Overhead Press', 'Shoulders'),
    S('Leg Press', 'Quads'), S('Lat Pulldown', 'Back'),
    A('Lateral Raise', 'Shoulders'), A('Bicep Curl', 'Biceps'), A('Face Pull', 'Rear Delts'),
  ];

  it('profile cap 6 → a 7–8 exercise plan trims to 6 (mains preserved)', () => {
    const out = capSessionToProfile(bigPlan(), { session_cap: 6, accessory_cap: 2 });
    assert.equal(out.length, 6);
    assert.equal(roles(out).filter(r => r === 'main').length, 3, 'all 3 main compounds kept');
  });

  it('the cap FOLLOWS the profile value (cap 4 trims harder than cap 6)', () => {
    const at6 = capSessionToProfile(bigPlan(), { session_cap: 6, accessory_cap: 2 });
    const at4 = capSessionToProfile(bigPlan(), { session_cap: 4, accessory_cap: 2 });
    assert.equal(at6.length, 6);
    assert.equal(at4.length, 4, 'a smaller profile cap trims to 4 — proves it is data-derived');
    assert.equal(roles(at4).filter(r => r === 'main').length, 3, 'mains still preserved at cap 4');
  });

  it('accessory cap is profile-derived: above accessory_cap is trimmed first', () => {
    const at2 = capSessionToProfile(bigPlan(), { session_cap: 8, accessory_cap: 2 });
    assert.equal(roles(at2).filter(r => r === 'accessory').length, 2, 'accessories capped to the profile p75 (2)');
    const at1 = capSessionToProfile(bigPlan(), { session_cap: 8, accessory_cap: 1 });
    assert.equal(roles(at1).filter(r => r === 'accessory').length, 1, 'a profile with accessory_cap 1 trims to 1');
  });

  it('trims accessories FIRST, then secondary only if still over — never a main', () => {
    // cap 4, accessory_cap 0: must drop all 3 accessories, then 1 secondary, keep 3 main.
    const out = capSessionToProfile(bigPlan(), { session_cap: 4, accessory_cap: 0 });
    const r = roles(out);
    assert.equal(r.filter(x => x === 'main').length, 3, 'all mains preserved');
    assert.equal(r.filter(x => x === 'accessory').length, 0, 'accessories trimmed first');
    assert.equal(r.filter(x => x === 'secondary').length, 1, 'then one secondary trimmed to hit cap 4');
  });

  it('NEVER drops a main compound, even if that leaves the session above cap', () => {
    const mainsOnly = [M('Deadlift', 'Posterior Chain'), M('Back Squat', 'Quads'), M('Bench Press', 'Chest'), M('Overhead Press', 'Shoulders')];
    const out = capSessionToProfile(mainsOnly, { session_cap: 2, accessory_cap: 0 });
    assert.equal(out.length, 4, 'all 4 mains kept despite cap 2 — never drop a main');
  });

  it('does NOT reshape a normal session that already fits the profile', () => {
    const normal = [M('Bench Press', 'Chest'), M('Barbell Row', 'Back'), S('Lat Pulldown', 'Back'), A('Face Pull', 'Rear Delts')];
    const out = capSessionToProfile(normal, { session_cap: 6, accessory_cap: 2 });
    assert.deepEqual(out, normal, '4-exercise, 1-accessory day is left untouched');
  });

  it('falls back to generic (no trim) when there is no profile — insufficient history', () => {
    const plan = bigPlan();
    assert.equal(capSessionToProfile(plan, null).length, 8, 'null profile → unchanged');
    assert.equal(capSessionToProfile(plan, {}).length, 8, 'profile without session_cap → unchanged');
  });

  it('empty / non-array input is safe', () => {
    assert.deepEqual(capSessionToProfile([], { session_cap: 6 }), []);
    assert.deepEqual(capSessionToProfile(null, { session_cap: 6 }), []);
  });
});

// Parity follow-up to the exForPatterns threading: buildIntentSession (the
// build_muscle / fix_blind_spots / balanced builder) now threads muscle_group
// from its allRecs onto every emitted exercise, so structureSession's role
// helpers can classify a keyword-less accessory by its muscle group.
test('buildIntentSession threads muscle_group onto emitted exercises', () => {
  const rec = (name, code, pattern, mg, weight) => ({
    exercise_name: name, liftCode: code, pattern, muscle_group: mg,
    next_target: { weight, reps: 8, sets: 3 }, recommendation: 'go',
    e1rm_trend: 'stable', last_working_sets: [], sessions_analyzed: 3,
    days_since_last_session: 3, confidence: 'medium',
  });
  const allRecs = [
    rec('Bench Press', 'BEN01', 'push', 'Chest', 185),   // anchor (compound)
    rec('Pallof Press', 'PAL01', 'core', 'Core', 60),    // keyword-less accessory (group-only)
  ];
  const { exercises } = buildIntentSession({ patterns: ['push', 'core'], allRecs });
  assert.ok(exercises.length >= 1, 'should build at least one exercise');
  for (const ex of exercises) {
    assert.ok('muscle_group' in ex, `emitted exercise should carry muscle_group: ${ex.exercise}`);
  }
  const pallof = exercises.find(e => /pallof/i.test(e.exercise));
  assert.ok(pallof, 'the keyword-less accessory should be included');
  assert.equal(pallof.muscle_group, 'Core', 'muscle_group must thread through buildIntentSession');
});

// Threading fix: exForPatterns now emits `muscle_group`, so orderByRole's
// muscle-group fallback (classifyLiftRole) classifies a keyword-less accessory
// correctly. "Pallof Press" matches no name pattern (→ secondary by name alone),
// but muscle_group "Core" makes it an accessory — so it must sort AFTER a true
// secondary lift, not interleave among the compounds.
test('orderByRole: a keyword-less accessory is ordered by its muscle group, not name only', () => {
  const withGroup = [
    { exercise: 'Back Squat', muscle_group: 'Quads' },   // main (by name)
    { exercise: 'Pallof Press', muscle_group: 'Core' },  // accessory (only via muscle group)
    { exercise: 'Leg Press', muscle_group: 'Quads' },    // secondary (by name)
  ];
  assert.deepEqual(
    orderByRole(withGroup).map(e => e.exercise),
    ['Back Squat', 'Leg Press', 'Pallof Press'],
    'the core accessory should sort last (after the secondary) via the muscle-group fallback');

  // Regression guard: without muscle_group the same lift reads as `secondary`
  // (name-only) and sits ahead of the true secondary — the bug this fix closes.
  const nameOnly = [
    { exercise: 'Back Squat' },
    { exercise: 'Pallof Press' },
    { exercise: 'Leg Press' },
  ];
  assert.deepEqual(
    orderByRole(nameOnly).map(e => e.exercise),
    ['Back Squat', 'Pallof Press', 'Leg Press'],
    'name-only classification leaves the core lift mid-pack (documents why threading matters)');
});
