'use strict';

// Reproduces the production active-session exercise-REPLACEMENT trust failure on commit
// 523042e (Flight Recorder FR-20260723031748-ux7ogmwp) at the deterministic decision +
// state-machine level: the classifier recognises the atomic replacement, the proposal is
// staged WITHOUT mutating the plan, the follow-up turns bind to the proposal, and approval
// applies it exactly once in the same position. Pure modules imported directly (no DOM).
//
// Failing-first: the classifier cases fail on the pre-fix classifier (which mis-read
// "remove back squats and change it out for bench press" as a one-sided SKIP), and the
// state-machine / store cases exercise the newly-added modules.

const test = require('node:test');
const assert = require('node:assert/strict');

let PM;   // planMutationIntent (classifier)
let AR;   // activeReplacement (proposal state machine)
let store;

test.before(async () => {
  PM = await import('../src/app/planMutationIntent.js');
  AR = await import('../src/app/activeReplacement.js');
  store = await import('../src/app/store.js');
});

// The authoritative five-exercise recommendation from the production session.
function fivePlan() {
  return [
    { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: 'BAC01', weight: 315, reps: 5, sets: 3, rir: 2 },
    { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01', weight: 225, reps: 8, sets: 3, rir: 2 },
    { name: 'Deadlift', canonicalName: 'Deadlift', liftCode: 'DEA01', weight: 315, reps: 5, sets: 1, rir: 2 },
    { name: 'Leg Extension', canonicalName: 'Leg Extension', liftCode: 'LEG01', weight: 120, reps: 15, sets: 3, rir: 1 },
    { name: 'Hammer Curls', canonicalName: 'Hammer Curls', liftCode: 'HAM01', weight: 30, reps: 12, sets: 3, rir: 1 },
  ];
}
const BENCH = { name: 'Bench Press', lift_code: 'BEN01', weight: 175, reps: 9, sets: 3, rir: 5 };

// ── classifier: atomic replacement recognition (req 1) + negative controls (req 11) ──

test('classifier: the production compound command is ONE replacement, not a one-sided skip', () => {
  const r = PM.classifyMutationIntent("Let's remove back squats and change it out for bench press.");
  assert.equal(r && r.action, 'replace', 'recognised as a source→replacement, not a skip');
  assert.match(r.target, /back squat/i);
  assert.match(r.substitute, /bench press/i);
});

test('classifier: the required replacement phrasings all resolve to one replace', () => {
  for (const msg of [
    'Replace back squats with bench press.',
    'Remove back squats and change it out for bench press.',
    'Swap squats for bench.',
    "Instead of squats, let's bench.",
    'change back squats to bench press',
  ]) {
    const r = PM.classifyMutationIntent(msg);
    assert.equal(r && r.action, 'replace', `"${msg}" is a replacement`);
  }
});

test('classifier: negative controls keep their existing meaning', () => {
  assert.equal(PM.classifyMutationIntent('Skip Back Squat').action, 'skip', 'a one-sided skip stays a skip');
  assert.equal(PM.classifyMutationIntent('What are alternatives to Back Squat?'), null, 'an educational question is not a mutation');
  assert.equal(PM.classifyMutationIntent('Why is Bench Press underperforming?'), null, 'a diagnostic question is not a mutation');
  assert.equal(PM.classifyMutationIntent('Replace the bar'), null, '"the bar" is not a plan exercise → not a swap');
});

// req 11 (phantom-replacement guard): a BARE removal with NO replacement named must NOT be
// promoted into a replacement — it stays the existing, tested skip (planMutationIntent.test.js
// locks "remove X" → skip). The atomic-replacement lane only fires on action === 'replace',
// so it never invents a substitute for a plain "remove back squats". (Whether a bare removal
// should additionally PROMPT "skip or replace?" is an owner-facing change to the skip lane —
// out of scope for this trust fix, and deliberately NOT done here so the skip contract holds.)
test('req 11: a bare "remove/skip Back Squat" (no replacement) never becomes a replacement proposal', () => {
  for (const msg of ['Remove Back Squat', 'remove back squats', 'Skip Back Squat', 'drop back squats']) {
    const r = PM.classifyMutationIntent(msg);
    assert.equal(r && r.action, 'skip', `"${msg}" stays a skip`);
    assert.notEqual(r.action, 'replace', `"${msg}" is never a replace → the proposer (action==='replace' only) never fires`);
    assert.equal(r.substitute, undefined, `"${msg}" carries no substitute — no phantom replacement`);
  }
});

// ── proposal state machine: no pre-approval mutation, atomic apply, idempotent ──

test('req 3/9: building the proposal does NOT mutate the plan; the source stays, the replacement is not active', () => {
  const plan = fivePlan();
  const before = plan.map((e) => e.name);
  const proposal = AR.buildReplacementProposal({ source: { name: 'Back Squat' }, replacement: BENCH, planExercises: plan });
  assert.deepEqual(plan.map((e) => e.name), before, 'the plan array is untouched by proposal construction');
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.position, 0, 'the source position is recorded');
  assert.equal(proposal.replacement.name, 'Bench Press');
  assert.equal(proposal.replacement.load_state, 'resolved');
  // The proposal carries the complete proposed prescription (req 3).
  assert.equal(AR.formatReplacementPrescription(proposal.replacement), '175 lb 9 reps @ 5 RIR × 3 sets');
});

test('req 9: approval applies the replacement exactly ONCE, in the same position, leaving the other four unchanged', () => {
  const plan = fivePlan();
  const proposal = AR.buildReplacementProposal({ source: { name: 'Back Squat' }, replacement: BENCH, planExercises: plan });
  const applied = AR.applyReplacement(plan, proposal);
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.exercises.map((e) => e.name),
    ['Bench Press', 'Romanian Deadlift', 'Deadlift', 'Leg Extension', 'Hammer Curls'],
    'Back Squat replaced by Bench Press in position 0; the other four unchanged');
  assert.equal(applied.exercises[0].weight, 175);
  assert.equal(applied.exercises[0].reps, 9);
  assert.equal(applied.exercises[0].sets, 3);
  assert.equal(applied.exercises[0].rir, 5);
  // Idempotent: applying again (source already gone) changes nothing.
  const again = AR.applyReplacement(applied.exercises, proposal);
  assert.equal(again.applied, false, 'a second apply is a no-op — no double replacement');
  assert.deepEqual(again.exercises.map((e) => e.name), applied.exercises.map((e) => e.name));
});

test('req 9: a stale proposal (the plan changed under it) is detected and never applied', () => {
  const plan = fivePlan();
  const proposal = AR.buildReplacementProposal({ source: { name: 'Back Squat' }, replacement: BENCH, planExercises: plan });
  assert.equal(AR.isProposalFresh(proposal, plan), true, 'fresh against the plan it was built on');
  const changed = plan.slice(1); // Back Squat skipped out from under the proposal
  assert.equal(AR.isProposalFresh(proposal, changed), false, 'stale after the plan changed');
});

// ── follow-up binding (req 6) + weight truth (req 7) ──

test('req 6: follow-up turns bind to the pending proposal', () => {
  const proposal = AR.buildReplacementProposal({ source: { name: 'Back Squat' }, replacement: BENCH, planExercises: fivePlan() });
  assert.equal(AR.classifyFollowup('No let\'s do bench press', proposal), 'approve', '"no, let\'s do bench" affirms the replacement, not a rejection');
  assert.equal(AR.classifyFollowup('yes, bench', proposal), 'approve');
  assert.equal(AR.classifyFollowup('what weight should I put on the bar?', proposal), 'query', 'the weight question is answered from the proposal');
  assert.equal(AR.classifyFollowup('what am I doing for bench?', proposal), 'query');
  assert.equal(AR.classifyFollowup('no, keep squats', proposal), 'reject', 'keeping the source is a rejection');
  assert.equal(AR.classifyFollowup('never mind', proposal), 'reject');
  assert.equal(AR.classifyFollowup('how many reps did I do on deadlift last week', proposal), null, 'an unrelated turn keeps the proposal pending');
});

// ── the production sequence, end to end at the decision level (req 10) ──

test('production sequence: recommendation → "remove … change out for bench" → "no let\'s do bench" → weight → approve', () => {
  const plan = fivePlan();
  const planBefore = plan.map((e) => e.name);

  // 1. "Let's remove back squats and change it out for bench press."
  const intent = PM.classifyMutationIntent("Let's remove back squats and change it out for bench press.");
  assert.equal(intent.action, 'replace', 'not a skip — no "Skipped Back Squat. Next up: RDL."');

  // Stage ONE proposal — the plan is NOT mutated (source stays, replacement not active).
  const proposal = AR.buildReplacementProposal({ source: { name: 'Back Squat' }, replacement: BENCH, planExercises: plan });
  assert.deepEqual(plan.map((e) => e.name), planBefore, 'no immediate skip/removal — the plan is intact');
  assert.match(AR.formatProposalLine(proposal), /Replace Back Squat with Bench Press/);

  // 2. "No let's do bench press" — the SAME pending proposal is retained (approve), not a
  //    duplicate proposal and not an unrelated chat/benchmark answer.
  assert.equal(AR.classifyFollowup('No let\'s do bench press', proposal), 'approve');

  // 3. "Who cares. what weight should I put on the bar." — answered from the pending proposal.
  assert.equal(AR.classifyFollowup('Who cares. what weight should I put on the bar.', proposal), 'query');
  assert.equal(AR.formatReplacementPrescription(proposal.replacement), '175 lb 9 reps @ 5 RIR × 3 sets');

  // approve → Back Squat replaced exactly once by Bench Press; the other four unchanged.
  const applied = AR.applyReplacement(plan, proposal);
  assert.deepEqual(applied.exercises.map((e) => e.name),
    ['Bench Press', 'Romanian Deadlift', 'Deadlift', 'Leg Extension', 'Hammer Curls']);
});

// ── store: the pending proposal survives a reload; the plan is never half-mutated ──

test('req 9: the pending proposal round-trips through the session snapshot (refresh-safe)', () => {
  const fakeStore = (() => { let m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; })();
  globalThis.localStorage = fakeStore;
  try {
    store.resetSessionStore();
    store.setActivePlannedSession({ label: 'x', index: 0, exercises: fivePlan() });
    store.setSessionLog([{ exercise: 'Warmup' }]); // a logged set so the snapshot persists
    const proposal = AR.buildReplacementProposal({ source: { name: 'Back Squat' }, replacement: BENCH, planExercises: fivePlan() });
    store.setPendingReplacement(proposal);
    store.persistSessionSnapshot('sess-1');

    // Simulate a reload: fresh store state, then hydrate.
    store.resetSessionStore();
    assert.equal(store.getPendingReplacement(), null, 'cleared before hydrate');
    const res = store.hydrateSessionSnapshot();
    assert.equal(res.resumed, true);
    const restored = store.getPendingReplacement();
    assert.ok(restored, 'the pending proposal is restored across the reload');
    assert.equal(restored.proposal_id, proposal.proposal_id);
    // The plan itself is intact (nothing was removed pre-approval) so the restored proposal is fresh.
    assert.equal(AR.isProposalFresh(restored, store.getActivePlannedSession().exercises), true);
  } finally {
    delete globalThis.localStorage;
    store.resetSessionStore();
  }
});
