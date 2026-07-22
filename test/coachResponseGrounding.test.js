'use strict';

// Pure unit tests for services/coachResponseGrounding.js — the active-session
// response-grounding helpers behind the 2026-07-21 chat fixes:
//   Failure 1 (relevance): an unrelated lift's diagnostic contaminated a single-
//     exercise explanation. narrowContextToPlanTurn filters the all-lift diagnostics
//     to the target exercise and recomputes coach_mode.
//   Failure 2 (mutation truth): a read-only turn falsely claimed the plan was updated.
//     detectUnsupportedMutationClaim flags such prose (state-aware); buildGroundedPlanStatement
//     supplies the truthful, grounded replacement.

const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../services/coachResponseGrounding');
const { generateLiftCode } = require('../services/exerciseEnrichment');

// ── detectUnsupportedMutationClaim — state-aware ────────────────────────────

test('detectUnsupportedMutationClaim flags completed-mutation claims (no write proof)', () => {
  const claims = [
    // The exact production Failure 2 prose (two claim sentences).
    'The plan was updated. It now calls for 3 sets of 10 reps at 200, aiming for 1 RIR.',
    'I changed the plan.',
    'It now calls for 3 sets of 10.',
    'I switched it to 3 sets of 8.',
    'I adjusted your workout.',
    'That has been saved.',
    "I've updated the plan to 3x8.",
    'The plan now shows 3 sets of 8.',
    'I updated it.',
    'Your workout has been changed.',
    // "was updated" is unprovable on this read-only route regardless of "yesterday".
    'The plan was updated yesterday.',
  ];
  for (const c of claims) {
    assert.ok(g.detectUnsupportedMutationClaim(c).length > 0, `should flag: ${JSON.stringify(c)}`);
  }
});

test('detectUnsupportedMutationClaim does NOT flag proposals, questions, quotations, negations, or present-state', () => {
  const allowed = [
    'Do you want me to update the plan?',
    'I can propose that change.',
    'I can update it if you want.',
    'I can change it to 3 sets of 8.',
    'Want me to switch it?',
    'You said the plan was updated.',            // quoting the athlete
    "I haven't changed the plan.",
    'Nothing has been saved yet.',
    'The current plan calls for 3 sets of 10 at 200.',   // present state, no "now"/verb
    'The plan calls for 200 for 10 reps at 1 RIR to increase volume.',
    "I've noted that in this conversation.",      // "noted" is the allowed word, not a mutation
    'You planned 3 sets at 8 reps, but the plan shows 10.',
    // The deterministic grounded statement must never self-trip.
    "The current plan shows Seated Row: 3 sets of 10 reps at 200 lb, 1 RIR. I haven't changed it.",
  ];
  for (const a of allowed) {
    assert.equal(g.detectUnsupportedMutationClaim(a).length, 0, `should NOT flag: ${JSON.stringify(a)}`);
  }
});

test('detectUnsupportedMutationClaim is safe on empty / non-string', () => {
  assert.deepEqual(g.detectUnsupportedMutationClaim(''), []);
  assert.deepEqual(g.detectUnsupportedMutationClaim(null), []);
  assert.deepEqual(g.detectUnsupportedMutationClaim(undefined), []);
});

// ── turn classification ─────────────────────────────────────────────────────

const seatedPlan = () => ({ current_plan: [{ name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 }] });

test('isActivePlanGroundedTurn: plan explanations and corrections during an active session', () => {
  assert.equal(g.isActivePlanGroundedTurn('Why did you program seated rows for 200 pounds at 10 reps with 1 RIR?', seatedPlan()), true);
  assert.equal(g.isActivePlanGroundedTurn("That isn't what you planned. You planned 3 sets at 8 reps.", seatedPlan()), true);
  assert.equal(g.isActivePlanGroundedTurn('Why did you program bench press at 225 for 5 reps?', { current_plan: [{ name: 'Bench Press' }] }), true);
});

test('isActivePlanGroundedTurn: NOT a broad-session review, NOT without an active session', () => {
  assert.equal(g.isActivePlanGroundedTurn("Are there any problems with today's workout or my recent training?", seatedPlan()), false);
  assert.equal(g.isActivePlanGroundedTurn("That isn't what you planned.", {}), false);        // no active session
  assert.equal(g.isActivePlanGroundedTurn('What is progressive overload?', seatedPlan()), false); // pure education
});

test('resolveTurnExercises: named lift wins; else the active plan', () => {
  assert.deepEqual(g.resolveTurnExercises('Why did you program seated rows at 200?', seatedPlan()), ['Seated Row']);
  // Correction with no lift named → the active plan exercise the correction is about.
  assert.deepEqual(g.resolveTurnExercises("That isn't what you planned. You planned 3 sets at 8 reps.", seatedPlan()), ['Seated Row']);
});

// ── relevance narrowing (Failure 1) ─────────────────────────────────────────

function diagContext(planName) {
  return {
    current_plan: [{ name: planName, sets: 3, reps: 10, weight: 200, rir: 1 }],
    stalls: [{ exercise: 'Bench Press' }, { exercise: 'Seated Row' }],
    memory_patterns: [
      { liftCode: generateLiftCode('Bench Press'), patterns: [{ type: 'consistent_underperformance', details: { sessions_below: 5, sessions_checked: 5 } }] },
      { liftCode: generateLiftCode('Seated Row'), patterns: [] },
    ],
    muscle_gaps: [{ muscle: 'chest', currentEffectiveSets: 2, targetMin: 6 }],
    coach_mode: 'challenge',
  };
}

test('Failure 1: a Seated Row explanation drops the unrelated Bench Press diagnostic and suppresses challenge', () => {
  const n = g.narrowContextToPlanTurn(diagContext('Seated Row'), 'Why did you program seated rows for 200 pounds at 10 reps with 1 RIR?', {});
  assert.ok(!n.stalls.some(s => s.exercise === 'Bench Press'), 'Bench Press stall dropped');
  assert.ok(n.stalls.some(s => s.exercise === 'Seated Row'), 'Seated Row stall kept');
  assert.ok(!n.memory_patterns.some(p => p.liftCode === generateLiftCode('Bench Press')), 'Bench Press pattern dropped');
  assert.deepEqual(n.muscle_gaps, [], 'muscle_gaps dropped for a focused plan explanation');
  assert.notEqual(n.coach_mode, 'challenge', 'no challenge — the target lift carries no pattern');
});

test('Test 6 control: a Bench Press explanation keeps Bench diagnostics and drops the unrelated Seated Row', () => {
  const n = g.narrowContextToPlanTurn(diagContext('Bench Press'), 'Why did you program bench press at 225 for 5 reps?', {});
  assert.ok(n.stalls.some(s => s.exercise === 'Bench Press'), 'Bench Press stall kept');
  assert.ok(!n.stalls.some(s => s.exercise === 'Seated Row'), 'Seated Row stall dropped');
  assert.equal(n.coach_mode, 'challenge', 'challenge survives — it names the target lift itself');
});

test('Test 5 control: a broad-session review is returned unchanged (full diagnostics)', () => {
  const c = diagContext('Seated Row');
  const n = g.narrowContextToPlanTurn(c, "Are there any problems with today's workout or my recent training?", {});
  assert.equal(n, c, 'broad review context is not narrowed (identity)');
});

// ── grounded plan statement (Failure 2 replacement) ─────────────────────────

test('buildGroundedPlanStatement states the current plan + no-change when the plan is in view', () => {
  const s = g.buildGroundedPlanStatement(seatedPlan(), { exercises: ['Seated Row'] });
  assert.match(s, /current plan shows/i);
  assert.match(s, /3 sets of 10/);
  assert.match(s, /200/);
  assert.match(s, /1 RIR/);
  assert.match(s, /haven't changed/i);
  assert.match(s, /Seated Row/);
  assert.equal(g.detectUnsupportedMutationClaim(s).length, 0, 'the grounded statement is not itself a mutation claim');
});

test('Test 7: buildGroundedPlanStatement states uncertainty (no fabrication) when the plan is not in view', () => {
  const s = g.buildGroundedPlanStatement({}, { exercises: ['Seated Row'] });
  assert.match(s, /don't have the current plan/i);
  assert.match(s, /haven't changed/i);
  assert.doesNotMatch(s, /\b\d+ sets\b/, 'no fabricated set/rep numbers when the plan is absent');
});
