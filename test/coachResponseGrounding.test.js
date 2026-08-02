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

// Codex #1126 P1 — natural-language change REQUESTS (verb not opening the clause) must be
// preserved as modifications so the athlete can still start the proposal → approval flow;
// they must NOT be swept into the deterministic dispute path.
test('isPlanModificationRequest / isFactualPlanDispute: natural-language change requests stay modifications (Codex #1126)', () => {
  const ctx = seatedPlanCtx();
  for (const m of [
    'I want to change the plan to 3x8',
    'Can we change the plan?',
    "I'd like to change the plan",
    'Could you switch it to 8 reps?',
    'I need you to set it to 3 sets of 8',
    'can we make it 3x8',
  ]) {
    assert.equal(g.isPlanModificationRequest(m), true, `request is a modification: ${JSON.stringify(m)}`);
    assert.equal(g.isFactualPlanDispute(m, ctx), false, `request is NOT a factual dispute: ${JSON.stringify(m)}`);
  }
  // A plain assertion about what was planned that mentions a change verb is still a dispute,
  // not a request — the request cue ("i want / can we / could you …") must be present.
  assert.equal(g.isPlanModificationRequest('You set the plan to 3x8.'), false, 'an assertion is not a request');
  assert.equal(g.isFactualPlanDispute('You set the plan to 3x8.', ctx), true, 'an assertion about the plan stays a dispute');
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

// Omitted-lift correction in a MULTI-exercise plan — the disputed lift is resolved by a
// deterministic precedence (current message → server-recorded last-discussed lift → prior
// athlete turn → sole plan exercise), never the model, never numeric similarity.
test('buildDisputeAnswer: resolves the omitted-lift referent from history in a multi-exercise plan', () => {
  const plan = { current_plan: [
    { name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 },
    { name: 'Bench Press', sets: 4, reps: 6, weight: 185, rir: 2 },
    { name: 'Back Squat', sets: 5, reps: 5, weight: 275, rir: 2 },
  ] };
  const correction = "That isn't what you planned. You planned 3 sets at 8 reps.";
  // step 3 — the prior athlete turn named Seated Row, so the bare correction resolves to it.
  const hist = [
    { role: 'user', text: 'Why did you program seated rows for 200 at 10 reps with 1 RIR?' },
    { role: 'atlas', text: 'To add back volume.' },
  ];
  const a = g.buildDisputeAnswer(correction, plan, hist);
  assert.match(a, /Seated Row/); assert.match(a, /3 sets of 10/); assert.match(a, /200/); assert.match(a, /1 RIR/);
  assert.match(a, /not 3 sets of 8/i); assert.match(a, /haven't changed/i);
  assert.equal(g.detectUnsupportedMutationClaim(a).length, 0);
  // Atlas's own reply is NEVER a referent; a two-lift athlete turn is ambiguous → fail closed.
  assert.match(g.buildDisputeAnswer(correction, plan, [{ role: 'atlas', text: 'Bench Press looks strong.' }]), /not sure which exercise/i);
  assert.match(g.buildDisputeAnswer(correction, plan, [{ role: 'user', text: 'How are Bench Press and Back Squat?' }]), /not sure which exercise/i);
  // No usable history + multi-exercise plan → fail closed (never guesses a lift).
  assert.match(g.buildDisputeAnswer(correction, plan, []), /not sure which exercise/i);
  // step 1 — a lift named in the CURRENT message wins over history.
  assert.match(g.buildDisputeAnswer('You planned Bench Press at 3 sets of 8, not 6.', plan, hist), /Bench Press/);
  // step 2 — the server-recorded last-discussed lift (opts.lastDiscussedLift) is honored
  // over history, and a client-sent active_exercise field is NOT (server-side, unspoofable).
  assert.match(g.buildDisputeAnswer(correction, plan, [], { lastDiscussedLift: g.canonicalKey('Back Squat') }), /Back Squat/);
  assert.match(g.buildDisputeAnswer(correction, { ...plan, active_exercise: 'Back Squat' }, []), /not sure which exercise/i,
    'a client-sent active_exercise field is ignored — tier 2 is server-recorded only');
});

// Tier 3 is bounded: it scans only the last few athlete turns and stops at the first that
// names any plan lift (a referent recovered from deep history would be a stale, confident
// guess — worse than asking).
test('resolveDisputedLiftEntry: tier 3 is bounded to the recent athlete turns and stops at the first lift-naming turn', () => {
  const plan = { current_plan: [
    { name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 },
    { name: 'Bench Press', sets: 4, reps: 6, weight: 185, rir: 2 },
    { name: 'Back Squat', sets: 5, reps: 5, weight: 275, rir: 2 },
  ] };
  const nameOf = (e) => (e && (e.name || e.exercise)) || null;
  const D = "That isn't what you planned. You planned 3 sets at 6 reps.";
  // The most recent lift-naming athlete turn names TWO plan lifts → fail closed, even though
  // an older turn names exactly one.
  const twoThenOne = [
    { role: 'user', text: 'Why did you program seated rows?' }, { role: 'atlas', text: 'a' },
    { role: 'user', text: 'How are Bench Press and Back Squat looking?' }, { role: 'atlas', text: 'b' },
  ];
  assert.equal(resolveGround(D, plan, twoThenOne), null, 'stops at the first lift-naming turn; >1 name fails closed');
  // A lift-naming turn beyond the recent-turn window is NOT consulted (deep history).
  const deep = [
    { role: 'user', text: 'Why did you program seated rows?' }, { role: 'atlas', text: 'a' },
    { role: 'user', text: 'ok' }, { role: 'atlas', text: 'b' },
    { role: 'user', text: 'cool' }, { role: 'atlas', text: 'c' },
    { role: 'user', text: 'got it' }, { role: 'atlas', text: 'd' },
  ];
  assert.equal(resolveGround(D, plan, deep), null, 'a lift named beyond the recent window is not resolved');
  // Within the window, a single recent referent resolves.
  const recent = [{ role: 'user', text: 'Why did you program bench press?' }, { role: 'atlas', text: 'a' }];
  assert.equal(nameOf(g.resolveDisputedLiftEntry(D, plan, recent, {})), 'Bench Press');

  function resolveGround(msg, ctx, hist) { return g.resolveDisputedLiftEntry(msg, ctx, hist, {}); }
});

// A correction that explicitly names MORE THAN ONE plan lift is AMBIGUOUS, not an
// omitted-lift correction — it must fail closed rather than let a single-lift referent
// (tier 2) or the history scan answer for just one of them (Codex #1128).
test('resolveDisputedLiftEntry: a correction naming multiple plan lifts fails closed, even with a fresh referent', () => {
  const plan = { current_plan: [
    { name: 'Bench Press', sets: 4, reps: 6, weight: 185, rir: 2 },
    { name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 },
    { name: 'Back Squat', sets: 5, reps: 5, weight: 275, rir: 2 },
  ] };
  const multi = "Bench Press and Seated Row aren't what you planned.";
  // A recent Bench referent must NOT override a message that names two lifts.
  assert.equal(g.resolveDisputedLiftEntry(multi, plan, [], { lastDiscussedLift: g.canonicalKey('Bench Press') }), null);
  // The history scan must not pick one either.
  assert.equal(g.resolveDisputedLiftEntry(multi, plan, [{ role: 'user', text: 'why bench press?' }, { role: 'atlas', text: 'a' }], {}), null);
  // The dispute answer is the clarification response.
  assert.match(g.buildDisputeAnswer(multi, plan, [], { lastDiscussedLift: g.canonicalKey('Bench Press') }), /not sure which exercise|tell me the lift/i);
  // A correction that names an IN-PLAN lift AND a canonical lift absent from the snapshot
  // ("Bench Press and Deadlift are not what you planned") is still multi-lift → fail closed,
  // even though namedLiftsInMessage only surfaced the in-plan Bench.
  assert.equal(g.resolveDisputedLiftEntry('Bench Press and Deadlift are not what you planned.', plan, [], { lastDiscussedLift: g.canonicalKey('Seated Row') }), null);
  assert.equal(g.resolveDisputedLiftEntry('Deadlift and Bench Press are not what you planned.', plan, [], { lastDiscussedLift: g.canonicalKey('Seated Row') }), null);
  // A SHARED-WORD variant ("Bench Press and Incline Bench Press") — the second lift shares
  // words with the in-plan match, so stripping leaves only the variant modifier. Still
  // multi-lift → fail closed.
  assert.equal(g.resolveDisputedLiftEntry('Bench Press and Incline Bench Press are not what you planned.', plan, [], { lastDiscussedLift: g.canonicalKey('Seated Row') }), null);
  assert.equal(g.resolveDisputedLiftEntry('Bench Press and Dumbbell Bench Press are not what you planned.', plan, [], { lastDiscussedLift: g.canonicalKey('Seated Row') }), null);
  // A single-named correction still resolves (unchanged).
  assert.equal((g.resolveDisputedLiftEntry("Seated Row isn't what you planned, you said 8.", plan, [], { lastDiscussedLift: g.canonicalKey('Bench Press') }) || {}).name, 'Seated Row');
});

// A message that names exactly one lift which is NOT in current_plan — e.g. an unplanned
// preview/history lift that knownLiftNames surfaces — must fail closed rather than answer
// for a stale referent (Codex #1128).
test('resolveDisputedLiftEntry: a named lift not in the current plan fails closed (never a stale referent)', () => {
  const ctx = {
    current_plan: [
      { name: 'Bench Press', sets: 4, reps: 6, weight: 185, rir: 2 },
      { name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 },
    ],
    current_preview: [{ exercise: 'Deadlift' }], // unplanned — in the preview, not the plan
  };
  // "Deadlift isn't what you planned" names Deadlift (a preview row), which is not a plan
  // entry → clarify, do NOT answer for the saved Bench referent.
  assert.equal(g.resolveDisputedLiftEntry("Deadlift isn't what you planned. 3 sets at 6.", ctx, [], { lastDiscussedLift: g.canonicalKey('Bench Press') }), null);
  assert.match(g.buildDisputeAnswer("Deadlift isn't what you planned.", ctx, [], { lastDiscussedLift: g.canonicalKey('Bench Press') }), /not sure which exercise|tell me the lift/i);
  // A named lift that IS in the plan still resolves.
  assert.equal((g.resolveDisputedLiftEntry("Bench Press isn't what you planned, you said 8.", ctx, [], { lastDiscussedLift: g.canonicalKey('Seated Row') }) || {}).name, 'Bench Press');
});

// A named canonical lift that appears NOWHERE in the snapshot (not plan, preview, or
// history) — namedLiftsInMessage returns [] for it, but messageNamesALift recognizes it —
// must also fail closed, not answer for a referent (Codex #1128).
test('resolveDisputedLiftEntry: a named lift absent from the whole snapshot fails closed', () => {
  const ctx = { current_plan: [
    { name: 'Bench Press', sets: 4, reps: 6, weight: 185, rir: 2 },
    { name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 },
  ] }; // Deadlift is nowhere — not plan, preview, stalls, or recent sessions
  assert.equal(g.resolveDisputedLiftEntry("Deadlift isn't what you planned. 3 sets at 6.", ctx, [], { lastDiscussedLift: g.canonicalKey('Bench Press') }), null);
  assert.match(g.buildDisputeAnswer("Deadlift isn't what you planned.", ctx, [], { lastDiscussedLift: g.canonicalKey('Bench Press') }), /not sure which exercise|tell me the lift/i);
  // A genuine omitted-lift correction (names no lift) still resolves via the referent.
  assert.equal((g.resolveDisputedLiftEntry("That isn't what you planned. 3 sets at 6.", ctx, [], { lastDiscussedLift: g.canonicalKey('Bench Press') }) || {}).name, 'Bench Press');
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

// ── F-SB3: fail-closed substitution turn (owner ruling 2026-08-02) ───────────
//
// Workout 20260801-PM-01 / FR-20260802025836-l7hey0gz: the model answered a substitution
// request with "Understood. You're substituting Bench Press with Incline Dumbbell Press."
// and "Okay, I've noted the substitution." The ledger recorded ZERO item_outcome events,
// Bench Press stayed pending, Incline DB Press completed as an inserted exercise, and the
// closeout sealed over the contradiction. Atlas claimed a substitution it never performed.

const benchPlanCtx = () => ({
  current_plan: [
    { name: 'Bench Press', sets: 2, reps: 8, weight: 185, rir: 2 },
    { name: 'Seated Row', sets: 2, reps: 10, weight: 200, rir: 1 },
  ],
});

test('F-SB3: the two live phrasings that beat the denylist are exactly why the model is bypassed', () => {
  // Both wordings the model actually produced pass the completed-mutation denylist
  // untouched — `noted` is not one of its verbs, and it has no second-person completed
  // frame. A denylist alone would have shipped both to the athlete.
  for (const prose of [
    "Okay, I've noted the substitution.",
    "Understood. You're substituting Bench Press with Incline Dumbbell Press.",
  ]) {
    assert.equal(g.detectUnsupportedMutationClaim(prose).length, 0,
      `the denylist does NOT catch: ${JSON.stringify(prose)}`);
  }
  // The turn that drew them is claimed by the deterministic lane instead, so the model
  // is never asked. That is the fix — not another pattern.
  const ctx = benchPlanCtx();
  assert.equal(g.isSubstitutionTurn('The bench is taken, give me a substitute', ctx), true);
  assert.equal(g.isSubstitutionTurn('No I meant I substitute work out for bench press, like incline dumbbell or something', ctx), true);
  assert.equal(g.isSubstitutionTurn('Well I was asking for a substitute', ctx), true);
});

test('F-SB3 isSubstitutionTurn: needs an active session; explanations and broad reviews are excluded', () => {
  const ctx = benchPlanCtx();
  for (const m of [
    'swap bench for something else',
    'what can I do instead of bench press',
    'give me an alternative to the bench',
    'can I replace the row',
    'the bench is busy, I need a sub',
    'something else for chest',
  ]) {
    assert.equal(g.isSubstitutionTurn(m, ctx), true, `should claim: ${JSON.stringify(m)}`);
  }
  // No active session → nothing to be truthful about; the turn routes normally.
  assert.equal(g.isSubstitutionTurn('swap bench for something else', {}), false);
  // "Why did you substitute…" is an EXPLANATION, not a mutation request — it keeps its
  // (narrowed) model narration.
  assert.equal(g.isSubstitutionTurn('why did you substitute bench press?', ctx), false);
  // A broad-session review keeps the full picture.
  assert.equal(g.isSubstitutionTurn('any problems with my recent training? should I swap anything?', ctx), false);
  // An ordinary turn is untouched.
  assert.equal(g.isSubstitutionTurn('how is my bench trending?', ctx), false);
});

test('F-SB3 buildSubstitutionAnswer: grounded in the plan, never a completed-mutation claim', () => {
  const ctx = benchPlanCtx();
  const named = g.buildSubstitutionAnswer('the bench is taken, give me a substitute for bench press', ctx);
  assert.match(named, /Bench Press: 2 sets of 8 reps at 185 lb 2 RIR/, 'reads back the plan it still shows');
  assert.match(named, /haven't changed/i, 'states plainly that nothing changed');

  // FAIL-CLOSED property: for EVERY substitution turn the answer is claim-free by
  // construction — there is no wording for a denylist to outrun, because no model runs.
  for (const m of [
    'the bench is taken, give me a substitute',
    'No I meant I substitute work out for bench press, like incline dumbbell or something',
    'Well I was asking for a substitute',
    'swap the row for something else',
    'can I replace bench press and seated row',
  ]) {
    const a = g.buildSubstitutionAnswer(m, ctx);
    assert.equal(g.detectUnsupportedMutationClaim(a).length, 0, `claim-free: ${JSON.stringify(m)}`);
    assert.match(a, /haven't changed/i, `says nothing changed: ${JSON.stringify(m)}`);
    assert.ok(!/\b(i've noted|you're substituting|you are substituting)\b/i.test(a),
      `never the live failure's wording: ${JSON.stringify(m)}`);
  }

  // Ambiguous / unnamed / off-plan referents fail closed rather than answering for a lift
  // the athlete did not mean.
  assert.match(g.buildSubstitutionAnswer('I need a substitute', ctx), /haven't changed your plan/i);
  assert.match(g.buildSubstitutionAnswer('swap deadlift for something', ctx), /haven't changed your plan/i);
  // No plan in view → says so, still claim-free.
  const noPlan = g.buildSubstitutionAnswer('swap bench for something else', {});
  assert.match(noPlan, /don't have your current plan in view/i);
  assert.equal(g.detectUnsupportedMutationClaim(noPlan).length, 0);
});
