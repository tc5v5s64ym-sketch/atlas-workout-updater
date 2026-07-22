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

// ═══════════════════════════════════════════════════════════════════════════
// FAIL-CLOSED active-plan dispute (2026-07-22) — deterministic factual answers,
// abbreviation resolution, and modification-request preservation.
// ═══════════════════════════════════════════════════════════════════════════

const seatedPlanCtx = () => ({ current_plan: [{ name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 }] });

// ── turn classification ──────────────────────────────────────────────────────

test('isFactualPlanDispute: factual disputes, but NOT explanations / modifications / education', () => {
  const ctx = seatedPlanCtx();
  // Factual disputes → deterministic path.
  for (const m of [
    "That isn't what you planned. You planned 3 sets at 8 reps.",
    'No, you told me 10 reps.',
    "That's not the weight you gave me. You said 195.",
    'You had me at 1 RIR, not 2.',
    'The plan was 8 reps.',
    'I thought the plan said 200.',
  ]) assert.equal(g.isFactualPlanDispute(m, ctx), true, `dispute: ${JSON.stringify(m)}`);
  // Explanations keep model narration.
  assert.equal(g.isFactualPlanDispute('Why did you program Seated Row at 200×10?', ctx), false, 'explanation is not a dispute');
  // Modification requests keep the proposal flow.
  assert.equal(g.isFactualPlanDispute('Change it to 3 sets of 8.', ctx), false, 'modify(it) is not a dispute');
  assert.equal(g.isFactualPlanDispute('Change the plan to 8 reps.', ctx), false, 'modify(the plan) is not a dispute');
  assert.equal(g.isFactualPlanDispute('Please update the plan to 3x8.', ctx), false, 'modify(update the plan) is not a dispute');
  // Education / no active plan.
  assert.equal(g.isFactualPlanDispute('What is progressive overload?', ctx), false, 'education is not a dispute');
  assert.equal(g.isFactualPlanDispute("That isn't what you planned.", {}), false, 'no active plan → not a dispute');
});

test('isPlanModificationRequest: imperative change requests, not assertions', () => {
  for (const m of ['Change it to 3 sets of 8.', 'Make it 8 reps.', 'Switch to Front Squat.', 'Please update the plan to 3x8.', "Let's bump it to 225."]) {
    assert.equal(g.isPlanModificationRequest(m), true, `modify: ${JSON.stringify(m)}`);
  }
  for (const m of ["That isn't what you planned.", 'You planned 3 sets at 8 reps.', "you didn't change the plan", 'The plan says 200.']) {
    assert.equal(g.isPlanModificationRequest(m), false, `assertion: ${JSON.stringify(m)}`);
  }
});

// ── deterministic dispute answer ─────────────────────────────────────────────

test('buildDisputeAnswer: states the current plan, distinguishes the claim, says nothing changed — never a mutation claim', () => {
  const a = g.buildDisputeAnswer("That isn't what you planned. You planned 3 sets at 8 reps.", seatedPlanCtx());
  assert.match(a, /current plan shows/i, 'states what the plan currently shows');
  assert.match(a, /3 sets of 10/, 'the real prescription');
  assert.match(a, /200/);
  assert.match(a, /1 RIR/);
  assert.match(a, /not 3 sets of 8/i, "distinguishes the athlete's claim");
  assert.match(a, /haven't changed/i, 'states no change was made');
  assert.equal(g.detectUnsupportedMutationClaim(a).length, 0, 'the deterministic answer is never a completed-mutation claim');
});

test('buildDisputeAnswer: weight and no-plan variants stay grounded and invent nothing', () => {
  const w = g.buildDisputeAnswer("That's not the weight you gave me. You said 195.", seatedPlanCtx());
  assert.match(w, /200/); assert.match(w, /not 195/i); assert.match(w, /haven't changed/i);
  const none = g.buildDisputeAnswer("That isn't what you planned.", {});
  assert.match(none, /don't have the current plan/i);
  assert.match(none, /haven't changed/i);
  assert.doesNotMatch(none, /\b\d+ sets\b/, 'no fabricated numbers when the plan is absent');
});

// ── fail-closed property: no denylist reliance ───────────────────────────────

test('FAIL-CLOSED: buildDisputeAnswer never emits a completed-mutation claim for ANY dispute, incl. novel wording the denylist would miss', () => {
  // The denylist is a finite backstop; prove it does NOT catch this novel completed-write
  // wording — so if the model produced it on a dispute, a denylist alone would let it
  // through. The deterministic answer below never contains it, which is the point.
  const novel = 'Boom — your program is locked in and rewritten to 3x8. All set!';
  assert.equal(g.detectUnsupportedMutationClaim(novel).length, 0, 'the denylist does NOT catch this novel wording');
  // The deterministic dispute answer is model-free and mutation-claim-free by construction.
  for (const m of [
    "That isn't what you planned. You planned 3 sets at 8 reps.",
    'No, you told me 8 reps.',
    'The workout says 200 × 10.',
    'You said 195.',
  ]) {
    const a = g.buildDisputeAnswer(m, seatedPlanCtx());
    assert.equal(g.detectUnsupportedMutationClaim(a).length, 0, `dispute answer is claim-free: ${JSON.stringify(m)}`);
    assert.match(a, /haven't changed/i);
  }
});

// ── abbreviation resolution (Codex #1122) ────────────────────────────────────

test('abbreviation resolution: RDL / OHP map to their plan lift so narrowing drops unrelated diagnostics', () => {
  const ctx = {
    current_plan: [{ name: 'Romanian Deadlift', sets: 3, reps: 8, weight: 225, rir: 2 }, { name: 'Bench Press', sets: 3, reps: 5, weight: 225, rir: 2 }],
    stalls: [{ exercise: 'Bench Press' }, { exercise: 'Romanian Deadlift' }],
    memory_patterns: [{ liftCode: generateLiftCode('Bench Press'), patterns: [{ type: 'consistent_underperformance', details: { sessions_below: 5, sessions_checked: 5 } }] }],
    muscle_gaps: [{ muscle: 'chest' }], coach_mode: 'challenge',
  };
  assert.deepEqual(g.namedLiftsInMessage('Why did you program RDL?', ctx).map(n => g.nameKey(n)), [g.nameKey('Romanian Deadlift')], 'RDL → Romanian Deadlift');
  assert.deepEqual(g.namedLiftsInMessage('why did you program OHP', { current_plan: [{ name: 'Overhead Press' }, { name: 'Bench Press' }] }).map(g.nameKey), [g.nameKey('Overhead Press')], 'OHP → Overhead Press');
  const n = g.narrowContextToPlanTurn(ctx, 'Why did you program RDL?', {});
  assert.ok(!n.stalls.some(s => /bench/i.test(s.exercise)), 'Bench stall dropped (no leak into an RDL answer)');
  assert.ok(n.stalls.some(s => /romanian/i.test(s.exercise)), 'RDL stall kept');
  assert.notEqual(n.coach_mode, 'challenge', 'the unrelated Bench challenge is suppressed');
});

test('resolveTurnExercises: a message that names an unmappable lift does NOT fall back to the whole plan', () => {
  const ctx = { current_plan: [{ name: 'Seated Row' }, { name: 'Bench Press' }] };
  // Names a specific lift (abbreviation the canonicalizer resolves) that is NOT in the
  // plan → narrow to nothing (no leak), never the whole plan's diagnostics.
  assert.deepEqual(g.resolveTurnExercises('Why did you program RDL?', ctx), []);
  // Names nothing → the active plan it refers to.
  assert.deepEqual(g.resolveTurnExercises("That isn't what you planned.", { current_plan: [{ name: 'Seated Row' }] }), ['Seated Row']);
});
