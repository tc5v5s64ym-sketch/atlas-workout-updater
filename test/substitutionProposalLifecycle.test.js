'use strict';

// F-SB3 — SUBSTITUTION TRUTH, the full A–E lifecycle (owner ruling 2026-08-02).
//
// Workout 20260801-PM-01 / Flight Recorder FR-20260802025836-l7hey0gz. Atlas told the owner
// "Understood. You're substituting Bench Press with Incline Dumbbell Press." and "Okay, I've
// noted the substitution." The durable ledger disagreed on every point: 0 item_outcome
// events, BEN01 still pending with its prescription untouched, and 3 performed IDB01 rows
// recorded as an INSERTED exercise. Atlas visibly claimed a substitution it never performed.
//
// The ruling's classification is an AUTHORITY DEFECT. The canonical active-session plan slot,
// its retained plan_item_id, and its durable Session_Plans item_outcome win; coach prose,
// pending conversational state, and an independently inserted completed exercise are never
// proof that the plan changed. This file proves the surviving lifecycle end to end:
//
//   A RECOMMENDATION      — stages a bounded pending proposal; mutates nothing
//   B GROUNDED FOLLOW-UP  — "how much should I lift?" answered from the engine prescription
//   C ACCEPTANCE          — one canonical mutation, one item_outcome, then the claim
//   D ACCEPTANCE BY LOGGING — the replacement binds to the ORIGINAL slot, once
//   E FAILURE             — the plan is unchanged and no success wording is emitted
//
// The harness composes the REAL lifecycle slice and the REAL emitSetLogged out of the built
// public/app.js, with the REAL activeReplacement + planMutationIntent modules — so the
// binding is proven through the live lane, not a reimplementation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

let planMutationIntent, activeReplacement;
test.before(async () => {
  planMutationIntent = await import('../src/app/planMutationIntent.js');
  activeReplacement = await import('../src/app/activeReplacement.js');
});

class FakeCustomEvent {
  constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; }
}

function loadHarness(apiState) {
  const sliceLifecycle = appSrc.slice(
    appSrc.indexOf('function applySessionSubstitution('),
    appSrc.indexOf('// ── P0 PR 4: deterministic exercise-identity correction')
  );
  const sliceEmit = appSrc.slice(
    appSrc.indexOf('function plannedExerciseEntries()'),
    appSrc.indexOf('async function fetchReaction(')
  );
  const sliceSuggest = appSrc.slice(
    appSrc.indexOf('async function checkAndSuggestSubstitute('),
    appSrc.indexOf('async function fetchSessionPrLabel(')
  );
  assert.ok(sliceLifecycle.includes('function stageSubstitutionProposal('), 'slice must contain stageSubstitutionProposal');
  assert.ok(sliceLifecycle.includes('function bindLoggedSubstituteToProposal('), 'slice must contain bindLoggedSubstituteToProposal');
  assert.ok(sliceEmit.includes('function emitSetLogged('), 'slice must contain emitSetLogged');
  assert.ok(sliceSuggest.includes('async function checkAndSuggestSubstitute('), 'slice must contain checkAndSuggestSubstitute');

  const events = [];
  const outcomes = [];
  const ledger = require('../src/app/sessionLedger.js');
  const { planSlotStatuses, remainingSlotNames, variantSatisfies } = require('../src/app/planSlotStatuses.js');
  const fakeDoc = { getElementById: () => null, dispatchEvent: evt => { events.push(evt); return true; } };
  const fakeWindow = { planMutationIntent, activeReplacement };
  const api = async (pathArg, opts) => {
    apiState.calls.push({ path: pathArg, body: JSON.parse((opts && opts.body) || '{}') });
    return { data: { recommendation: apiState.recommendation } };
  };

  const factory = new Function(
    'document', 'window', 'CustomEvent', 'api', 'outcomes',
    'setsTableBody', 'parsedRowsEditor', 'invalidatePreview',
    'planSlotStatuses', 'remainingSlotNames', 'variantSatisfies',
    'buildFutureRevisions', 'appendRevisions', 'ledgerPerformedSetCount',
    `${STORE_SHIM}
     let lastIntentData = null;
     let lastParsedWorkoutText = '';
     let lastUnverifiedExercise = null;
     let previewRequestSeq = 0;
     function renderActiveSessionBanner() {}
     function saveSessionSnapshot() {}
     function normalizePlanExercise(x) { return x; }
     function liftCodeFromCatalog() { return ''; }
     function getCanonicalSession() { return null; }        // → the fallback plan-entries path
     function firstUnloggedPlannedLift() { return remainingPlannedExercises()[0] || null; }
     function isConnected() { return true; }
     function currentPlannedExercise() {
       const s = getActivePlannedSession();
       const name = firstUnloggedPlannedLift();
       if (!s || !name) return null;
       const key = name.toLowerCase();
       return s.exercises.find(e => (e.canonicalName || e.name || '').toLowerCase() === key) || null;
     }
     ${sliceLifecycle}
     ${sliceEmit}
     ${sliceSuggest}

     // PR-G1 outcome sink — the canonical item_outcome emissions under test. Declared AFTER
     // the slices so it overrides the sliced emitter (which posts to the network sidecar).
     function emitPlanItemOutcome(o) { outcomes.push(o); }

     return {
       setActiveSession: s => { setActivePlannedSession(s); },
       getNames: () => (getActivePlannedSession() ? getActivePlannedSession().exercises.map(e => e.canonicalName || e.name) : []),
       getSlot: i => (getActivePlannedSession() ? getActivePlannedSession().exercises[i] : null),
       getProposal: () => getPendingReplacement(),
       setProposal: p => { setPendingReplacement(p); },
       remaining: () => remainingPlannedExercises(),
       checkAndSuggestSubstitute,
       tryResolvePendingReplacement,
       approvePendingReplacement,
       rejectPendingReplacement,
       emitSetLogged,
       getEvents: () => events.slice(),
     };`
  );
  const api2 = factory(fakeDoc, fakeWindow, FakeCustomEvent, api, outcomes,
    { innerHTML: '' }, { hidden: false }, () => {},
    planSlotStatuses, remainingSlotNames, variantSatisfies,
    ledger.buildFutureRevisions, ledger.appendRevisions, ledger.performedSetCount);
  return { api: api2, events, outcomes };
}

// The owner's session, reduced to the two lifts that matter: BEN01 accepted and pending,
// SR01 behind it. IDB01 (Incline Dumbbell Press) is the substitute the engine returns.
const BENCH_PLAN = () => ({
  accepted: true, session_id: '20260801-PM-01', session_date: '2026-08-01', plan_version: 'pv_x', index: 0,
  exercises: [
    { name: 'Bench Press', canonicalName: 'Bench Press', liftCode: 'BEN01', plan_item_id: 'pi_ben', weight: 185, reps: 8, sets: 2, rir: 2 },
    { name: 'Seated Row', canonicalName: 'Seated Row', liftCode: 'SR01', plan_item_id: 'pi_sr', weight: 200, reps: 10, sets: 2, rir: 1 },
  ],
});
const IDB_REC = {
  recommendation: 'Incline Dumbbell Press', quality: 'excellent',
  reason: 'Same horizontal press pattern with dumbbells',
  next_target: { weight: 90, reps: 10, sets: 2, rir: 2 },
};

function staged() {
  const apiState = { recommendation: IDB_REC, calls: [] };
  const h = loadHarness(apiState);
  h.api.setActiveSession(BENCH_PLAN());
  return { ...h, apiState };
}

const mutations = h => h.events.filter(e => e.type === 'atlas:plan-mutated');

// ── A. RECOMMENDATION ────────────────────────────────────────────────────────

test('A: the bench is taken → a bounded proposal is staged and NOTHING is mutated', async () => {
  const h = staged();
  assert.equal(await h.api.checkAndSuggestSubstitute('the bench is taken'), true);

  // The plan is untouched: Bench Press stays, keeps its identity, keeps its prescription,
  // and stays the current lift. This is the exact thing the live failure got wrong.
  assert.deepEqual(h.api.getNames(), ['Bench Press', 'Seated Row']);
  assert.equal(h.api.getSlot(0).plan_item_id, 'pi_ben');
  assert.equal(h.api.getSlot(0).weight, 185, 'the accepted BEN01 prescription is untouched');
  assert.notEqual(h.api.getSlot(0).reason, 'substituted');
  assert.deepEqual(h.api.remaining(), ['Bench Press', 'Seated Row']);
  assert.deepEqual(h.outcomes, [], 'a recommendation emits NO item_outcome');

  // One bounded, session-scoped proposal carrying the engine-owned prescription.
  const p = h.api.getProposal();
  assert.equal(p.status, 'pending');
  assert.equal(p.source.name, 'Bench Press');
  assert.equal(p.replacement.name, 'Incline Dumbbell Press');
  assert.equal(p.replacement.weight, 90);
  assert.equal(p.replacement.reps, 10);

  // The surfaced line carries the recommender's reason and NO completed-mutation wording.
  const proposed = h.events.filter(e => e.type === 'atlas:replacement-proposed');
  assert.equal(proposed.length, 1);
  assert.match(proposed[0].detail.line, /Replace Bench Press with Incline Dumbbell Press/);
  assert.match(proposed[0].detail.line, /90 lb/, 'the engine prescription is stated, not invented');
  assert.match(proposed[0].detail.line, /Same horizontal press pattern/, 'the engine reason rides along');
  for (const banned of [/i've noted/i, /you'?re substituting/i, /\bswapped\b/i, /\breplaced\b/i, /plan (?:is|has been) updated/i]) {
    assert.ok(!banned.test(proposed[0].detail.line), `recommendation must not claim a completed swap: ${banned}`);
  }
  assert.equal(mutations(h).length, 0, 'nothing is announced as mutated');
});

// ── B. GROUNDED FOLLOW-UP (F-SB2, folded in) ─────────────────────────────────

test('B: "How much should I lift?" is answered from the pending engine prescription', async () => {
  const h = staged();
  await h.api.checkAndSuggestSubstitute('the bench is taken');
  h.apiState.calls.length = 0;

  // The exact F-SB2 turn. On 2026-08-02 this reached /api/coach/chat with zero exercise
  // identity attached and the model supplied its own referent — Bench Press, a lift the
  // owner had finished twenty minutes earlier.
  assert.equal(h.api.tryResolvePendingReplacement('Nice! How much should I lift?'), true);
  const answer = mutations(h).at(-1).detail.summary;
  assert.match(answer, /Incline Dumbbell Press/, 'the answer is scoped to the proposal, not a stale lift');
  assert.match(answer, /90 lb/, 'the number is the engine\'s');
  assert.match(answer, /not active yet/, 'and it does not pretend the swap happened');
  assert.equal(h.apiState.calls.length, 0, 'no model, no network — the answer is deterministic');
  assert.deepEqual(h.api.getNames(), ['Bench Press', 'Seated Row'], 'answering a question mutates nothing');

  // Fail closed when the engine resolved no target: state that, never guess a load.
  const h2 = staged();
  h2.apiState.recommendation = { ...IDB_REC, next_target: null };
  await h2.api.checkAndSuggestSubstitute('the bench is taken');
  assert.equal(h2.api.tryResolvePendingReplacement('how much should I lift?'), true);
  const a2 = mutations(h2).at(-1).detail.summary;
  assert.match(a2, /don't have an authoritative load/i, 'it says it has no target rather than inventing one');
  assert.ok(!/\d+\s*lb/.test(a2), 'and states no load at all');
});

// ── C. ACCEPTANCE ────────────────────────────────────────────────────────────

test('C: acceptance mutates the canonical slot once — retained id, one outcome, then the claim', async () => {
  const h = staged();
  await h.api.checkAndSuggestSubstitute('the bench is taken');

  assert.equal(h.api.tryResolvePendingReplacement('yes'), true);

  // The canonical slot IS the mutation: same position, original plan_item_id retained,
  // the engine prescription applied, Bench Press out of remaining work.
  assert.deepEqual(h.api.getNames(), ['Incline Dumbbell Press', 'Seated Row']);
  assert.equal(h.api.getSlot(0).plan_item_id, 'pi_ben', 'the substitute satisfies the ORIGINAL slot');
  assert.equal(h.api.getSlot(0).reason, 'substituted');
  assert.equal(h.api.getSlot(0).weight, 90);
  assert.ok(!h.api.remaining().includes('Bench Press'), 'Bench Press leaves remaining work');

  // EXACTLY ONE canonical outcome, naming both sides.
  assert.deepEqual(h.outcomes, [{ plan_item_id: 'pi_ben', outcome: 'substituted', performed_lift_code: '' }]);

  // Only now is a success claim made — and it is deterministic, not model prose.
  assert.match(mutations(h).at(-1).detail.summary, /Replaced Bench Press with Incline Dumbbell Press/);
  assert.equal(h.api.getProposal(), null, 'the proposal is consumed');
});

test('C: repeated acceptance is idempotent — no second mutation, no second outcome', async () => {
  const h = staged();
  await h.api.checkAndSuggestSubstitute('the bench is taken');
  h.api.tryResolvePendingReplacement('yes');
  const namesAfter = h.api.getNames();
  const eventsAfter = h.events.length;

  assert.equal(h.api.approvePendingReplacement(), false, 'there is no proposal left to accept');
  assert.deepEqual(h.api.getNames(), namesAfter);
  assert.equal(h.outcomes.length, 1, 'still exactly one item_outcome');
  assert.equal(h.events.length, eventsAfter, 'and nothing further is claimed');
});

test('C negative: a generic "yes" cannot bind to a stale, superseded, or post-reset proposal', async () => {
  // STALE — the plan moved under the proposal (a slot was skipped elsewhere), so its
  // fingerprint no longer matches. It is discarded, never applied to the wrong slot.
  const h = staged();
  await h.api.checkAndSuggestSubstitute('the bench is taken');
  h.api.getSlot(1).name = 'Barbell Row';           // the plan changed under the proposal
  h.api.getSlot(1).canonicalName = 'Barbell Row';
  assert.equal(h.api.tryResolvePendingReplacement('yes'), true, 'the turn is still answered');
  assert.ok(h.api.getNames().includes('Bench Press'), 'the stale proposal never mutated the plan');
  assert.deepEqual(h.outcomes, [], 'and emitted no outcome');
  assert.match(mutations(h).at(-1).detail.summary, /didn't apply the swap/i, 'it says so plainly');

  // SUPERSEDED — a card tap carrying an older proposal id must not apply the current one.
  const h2 = staged();
  await h2.api.checkAndSuggestSubstitute('the bench is taken');
  assert.equal(h2.api.approvePendingReplacement({ proposal_id: 'repl:OLD->OTHER@x' }), false);
  assert.deepEqual(h2.api.getNames(), ['Bench Press', 'Seated Row'], 'the stale card applied nothing');
  assert.deepEqual(h2.outcomes, []);

  // POST-RESET / CROSS-SESSION — no proposal at all means a bare "yes" binds to nothing.
  const h3 = staged();
  await h3.api.checkAndSuggestSubstitute('the bench is taken');
  h3.api.setProposal(null);                        // session reset / new session
  assert.equal(h3.api.tryResolvePendingReplacement('yes'), false, 'nothing to resolve');
  assert.deepEqual(h3.api.getNames(), ['Bench Press', 'Seated Row']);
  assert.deepEqual(h3.outcomes, []);
});

test('C negative: a rejection leaves the plan exactly as it was', async () => {
  const h = staged();
  await h.api.checkAndSuggestSubstitute('the bench is taken');
  assert.equal(h.api.tryResolvePendingReplacement('no'), true);
  assert.deepEqual(h.api.getNames(), ['Bench Press', 'Seated Row']);
  assert.deepEqual(h.outcomes, []);
  assert.match(mutations(h).at(-1).detail.summary, /Kept Bench Press as-is/);
  assert.equal(h.api.getProposal(), null);
});

// ── D. ACCEPTANCE BY LOGGING ─────────────────────────────────────────────────

test('D: logging the replacement binds it to the ORIGINAL slot — never IDB inserted + BEN pending', () => {
  const h = staged();
  h.api.setProposal({
    proposal_id: 'repl:BENCHPRESS->INCLINEDUMBBELLPRESS@BENCHPRESS|SEATEDROW',
    source: { name: 'Bench Press', lift_code: 'BEN01' },
    replacement: { name: 'Incline Dumbbell Press', lift_code: 'IDB01', weight: 90, reps: 10, sets: 2, rir: 2, load_state: 'resolved' },
    position: 0, plan_fingerprint: 'BENCHPRESS|SEATEDROW', status: 'pending',
  });

  // The owner's actual next action: he just did the lift and logged it.
  h.api.emitSetLogged(
    [{ exercise: 'Incline DB Press', weight: 90, reps: 10, rir: 2 }],
    '',
    null,
    [{ exercise: 'Incline DB Press', canonical_exercise: 'Incline Dumbbell Press', lift_code: 'IDB01' }]
  );

  // The live failure was: IDB01 inserted + BEN01 pending + a visible success claim.
  assert.deepEqual(h.api.getNames(), ['Incline Dumbbell Press', 'Seated Row'], 'it bound to the slot, it was not inserted');
  assert.equal(h.api.getSlot(0).plan_item_id, 'pi_ben', 'the original plan_item_id is retained');
  assert.ok(!h.api.remaining().includes('Bench Press'), 'Bench Press does NOT stay pending');
  assert.deepEqual(h.outcomes, [{ plan_item_id: 'pi_ben', outcome: 'substituted', performed_lift_code: 'IDB01' }],
    'exactly one canonical outcome, naming the performed lift');
  assert.equal(h.api.getProposal(), null, 'the proposal is consumed by the acceptance');
});

test('D: the replacement binds even when it is NOT the first row of a batch (Codex P1)', () => {
  const h = staged();
  h.api.setProposal({
    proposal_id: 'repl:x', source: { name: 'Bench Press', lift_code: 'BEN01' },
    replacement: { name: 'Incline Dumbbell Press', lift_code: 'IDB01', weight: 90, reps: 10, sets: 2, rir: 2 },
    position: 0, plan_fingerprint: 'BENCHPRESS|SEATEDROW', status: 'pending',
  });

  // One submission, two exercises, the replacement SECOND. Scanning only the first row would
  // resolve Incline DB Press as an off-plan insertion and leave Bench Press pending — the
  // exact contradiction this card exists to prevent.
  h.api.emitSetLogged(
    [
      { exercise: 'Seated Row', weight: 200, reps: 10, rir: 1 },
      { exercise: 'Incline DB Press', weight: 90, reps: 10, rir: 2 },
    ],
    '', null,
    [
      { exercise: 'Seated Row', canonical_exercise: 'Seated Row', lift_code: 'SR01' },
      { exercise: 'Incline DB Press', canonical_exercise: 'Incline Dumbbell Press', lift_code: 'IDB01' },
    ]
  );

  assert.deepEqual(h.api.getNames(), ['Incline Dumbbell Press', 'Seated Row'], 'it bound to the Bench Press slot');
  assert.equal(h.api.getSlot(0).plan_item_id, 'pi_ben', 'the original plan_item_id is retained');
  assert.ok(!h.api.remaining().includes('Bench Press'), 'Bench Press does NOT stay pending');
  assert.deepEqual(h.outcomes, [{ plan_item_id: 'pi_ben', outcome: 'substituted', performed_lift_code: 'IDB01' }],
    'exactly one canonical outcome, naming the performed lift');
  assert.equal(h.api.getProposal(), null);
});

test('D: repeated logging creates no duplicate item_outcome', () => {
  const h = staged();
  h.api.setProposal({
    proposal_id: 'repl:x', source: { name: 'Bench Press', lift_code: 'BEN01' },
    replacement: { name: 'Incline Dumbbell Press', lift_code: 'IDB01', weight: 90, reps: 10, sets: 2, rir: 2 },
    position: 0, plan_fingerprint: 'BENCHPRESS|SEATEDROW', status: 'pending',
  });
  const enr = [{ exercise: 'Incline DB Press', canonical_exercise: 'Incline Dumbbell Press', lift_code: 'IDB01' }];
  h.api.emitSetLogged([{ exercise: 'Incline DB Press', weight: 90, reps: 10, rir: 2 }], '', null, enr);
  h.api.emitSetLogged([{ exercise: 'Incline DB Press', weight: 90, reps: 8, rir: 1 }], '', null, enr);

  assert.equal(h.outcomes.length, 1, 'the second set is more work on the SAME bound slot, not a second swap');
  assert.deepEqual(h.api.getNames(), ['Incline Dumbbell Press', 'Seated Row']);
});

test('D negative: an unrelated off-plan exercise stays a legitimate INSERTION', () => {
  const h = staged();
  h.api.setProposal({
    proposal_id: 'repl:x', source: { name: 'Bench Press', lift_code: 'BEN01' },
    replacement: { name: 'Incline Dumbbell Press', lift_code: 'IDB01', weight: 90, reps: 10, sets: 2, rir: 2 },
    position: 0, plan_fingerprint: 'BENCHPRESS|SEATEDROW', status: 'pending',
  });

  h.api.emitSetLogged(
    [{ exercise: 'Hammer Curls', weight: 30, reps: 12, rir: 1 }],
    '', null,
    [{ exercise: 'Hammer Curls', canonical_exercise: 'Hammer Curl', lift_code: 'HCURL' }]
  );

  assert.deepEqual(h.api.getNames(), ['Bench Press', 'Seated Row'], 'an accessory never satisfies a planned slot');
  assert.deepEqual(h.outcomes, [], 'and never emits a substitution outcome');
  assert.ok(h.api.getProposal(), 'the substitution decision is still outstanding');
});

test('D negative: a stale proposal (the plan moved under it) never binds a logged lift', () => {
  const h = staged();
  h.api.setProposal({
    proposal_id: 'repl:x', source: { name: 'Bench Press', lift_code: 'BEN01' },
    replacement: { name: 'Incline Dumbbell Press', lift_code: 'IDB01', weight: 90, reps: 10, sets: 2, rir: 2 },
    position: 0, plan_fingerprint: 'SOMETHING|ELSE', status: 'pending',   // built against another plan
  });

  h.api.emitSetLogged(
    [{ exercise: 'Incline DB Press', weight: 90, reps: 10, rir: 2 }],
    '', null,
    [{ exercise: 'Incline DB Press', canonical_exercise: 'Incline Dumbbell Press', lift_code: 'IDB01' }]
  );

  assert.deepEqual(h.api.getNames(), ['Bench Press', 'Seated Row'], 'the stale proposal applied nothing');
  assert.deepEqual(h.outcomes, []);
});

// ── E. FAILURE ───────────────────────────────────────────────────────────────

test('E: a mutation that does not happen can never emit success wording', async () => {
  const h = staged();
  await h.api.checkAndSuggestSubstitute('the bench is taken');
  // Force the canonical mutation to refuse: the proposal is fresh (the source slot is still
  // there and the fingerprint matches), but the substitute collapses to the source, so
  // applySessionSubstitution returns false. Nothing changed — say so.
  const p = h.api.getProposal();
  p.replacement.name = 'Bench Press';

  assert.equal(h.api.approvePendingReplacement(), true, 'the turn is answered');
  assert.deepEqual(h.api.getNames(), ['Bench Press', 'Seated Row'], 'the plan is unchanged');
  assert.deepEqual(h.outcomes, [], 'no outcome is emitted for a mutation that did not happen');
  const said = mutations(h).at(-1).detail.summary;
  assert.match(said, /couldn't change the plan/i, 'Atlas says plainly that the plan was not changed');
  assert.ok(!/\breplaced\b|\bswapped\b|\bupdated\b|i've noted/i.test(said), 'and never a success claim');
});
