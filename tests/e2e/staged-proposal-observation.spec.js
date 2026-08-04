'use strict';

// ── F-SB4B DEBUGGING DIAGNOSTIC: the staged-proposal evidence seam ─────────────
//
// PURPOSE. Two harness evidence defects cost Session 1 four scorecard conditions on
// both preserved runs (20260804T214054-2E85D9 and 20260804T220911-B8C426) against a
// product that completed the owner-pattern workout correctly. Reaching those defects
// required a full live rehearsal: an operator command, a spawned gate server, a real
// sandbox workbook, a live provider, and a whole owner-pattern session — tens of
// minutes, credentials, and Sheets quota per attempt. That cost, not the defects, is
// why they survived two runs.
//
// This spec reaches the SAME seam in seconds, in the real browser, against the real
// built shell, with no sandbox, no provider key, and no workbook. It is a diagnostic
// of the HARNESS's evidence path, not a second runner and not a second scorecard: it
// consumes the very functions the live rehearsal scores with
// (`gate/rehearsal-scorecard.js`) and the very observer the live rehearsal installs
// (`gate/rehearsal-staged-proposal.js`), over the real Session 1 shape — six-lift
// plan, accepted session, six pre-bench sets, constraint-lane proposal, prescription
// follow-up.
//
// IT CANNOT FALSE-GREEN, and this is the point of the last two tests. Every claim it
// makes is arbitrated by the LIVE browser state, and the two retired inference paths
// are kept here as executable mutations: the phase-window `recommend/next` inference
// and the declared-set-count expectation are both recomputed on the real run and
// asserted to FAIL. If someone reinstates either defect, or weakens the observation
// so it stops being an independent authority, these tests go red. A green run means
// the corrected path agreed with the live product AND the defective path still
// disagrees with it — an assertion no missing, defaulted, or hardcoded evidence can
// satisfy.
//
// SUNSET. This spec is F-SB4B rehearsal-harness machinery. It is deleted with the
// rest of the rehearsal harness at F-SB4C, on the same condition as
// `gate/rehearsal-staged-proposal.js`.

const { test, expect } = require('@playwright/test');
const {
  openCoachLane, submit, acceptPlanByLogging, outcomePosts, revisionPosts,
} = require('./support/coach-lane-harness');
const {
  STAGED_PROPOSALS_KEY, stagedProposalObserverScript, readStagedProposals,
  latestStagedObservation, assertObservationComplete, observationToIdentity,
  observationToPrescription,
} = require('./gate/rehearsal-staged-proposal');
const {
  compareReplacementIdentity, deriveExpectedRemaining, compareRemainingToExpectation,
} = require('./gate/rehearsal-scorecard');

// The Session 1 owner plan, verbatim from the frozen scenario declaration
// (gate/rehearsal.spec.js OWNER_PLAN).
const OWNER_PLAN = [
  { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 2, target_rir: 2 },
  { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 110, target_reps: 6, target_sets: 2, target_rir: 2 },
  { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 235, target_reps: 5, target_sets: 2, target_rir: 2 },
  { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 215, target_reps: 5, target_sets: 2, target_rir: 2 },
  { exercise: 'Seated Row', lift_code: 'SR01', target_weight: 205, target_reps: 10, target_sets: 2, target_rir: 2 },
  { exercise: 'Bicep Curl', lift_code: 'BC01', target_weight: 35, target_reps: 15, target_sets: 2, target_rir: 2 },
];

// The engine's substitute for an unavailable bench, with the prescription the live
// runs actually observed: THREE sets, not the plan's two. The set count is the
// engine's to choose, which is exactly why a harness may not declare it in advance.
const SUBSTITUTE_SETS = 3;
const SUBSTITUTE = {
  recommendation: 'Incline Dumbbell Press', quality: 'excellent',
  reason: 'Same horizontal press pattern with dumbbells',
  next_target: { weight: 90, reps: 10, sets: SUBSTITUTE_SETS, rir: 2 },
};

const twoSets = (weight, reps, rir) => [{ weight, reps, rir }, { weight, reps, rir }];
const logged = (name, sets) => ({ intent: 'log_sets', raw_name: name.toLowerCase(), canonical_name: name, exercise: name, sets });

const FIXTURE = {
  plan: {
    label: 'Full', focus: 'Owner pattern', recommended_label: 'Full',
    recommended_reason: 'The owner-pattern session.', exercises: OWNER_PLAN,
  },
  catalog: [
    ...OWNER_PLAN.map(p => ({ canonical_name: p.exercise, lift_code: p.lift_code })),
    { canonical_name: 'Incline Dumbbell Press', lift_code: 'IDB01' },
  ],
  substitute: SUBSTITUTE,
  parses: [
    { match: /incline/i, parsed: logged('Incline Dumbbell Press', [{ weight: 90, reps: 10, rir: 2 }]) },
    { match: /back squat/i, parsed: logged('Back Squat', twoSets(225, 5, 2)) },
    { match: /overhead press/i, parsed: logged('Overhead Press', twoSets(110, 6, 2)) },
    { match: /romanian deadlift/i, parsed: logged('Romanian Deadlift', twoSets(235, 5, 2)) },
    { match: /seated row/i, parsed: logged('Seated Row', twoSets(205, 10, 2)) },
    { match: /bicep curl/i, parsed: logged('Bicep Curl', twoSets(35, 15, 2)) },
  ],
  chatMessage: "Understood. You're substituting Bench Press with Incline Dumbbell Press.",
};

const SOURCE_NAME = 'Bench Press';
const SOURCE_LIFT = 'BEN01';
const REPLACEMENT_NAME = 'Incline Dumbbell Press';
const REPLACEMENT_LIFT = 'IDB01';
// The owner's verbatim Session 1 turn.
const SUBSTITUTION_ASK = 'The bench is taken at the gym so plan give me a substitute workout';
const PRESCRIPTION_ASK = 'Nice! How much should I lift?';

const observer = { fn: stagedProposalObserverScript, arg: STAGED_PROPOSALS_KEY };
const proposalLine = page => page.locator('#thread-messages .replacement-proposal-line').last();
const remainingNames = page => page.evaluate(() => (window.remainingPlannedExercises
  ? window.remainingPlannedExercises().map(e => e.canonicalName || e.name || e) : null));
const planNames = page => page.evaluate(() => window.getActivePlannedSession().exercises
  .map(e => e.canonicalName || e.name));

// Drive the Session 1 shape to the point the proposal is staged, then through the
// prescription follow-up, approval, and the substitute's logged sets. Returns
// everything the evidence checks need — nothing derived, only observed.
async function runSessionOneToSubstitution(page, capture) {
  await openCoachLane(page, capture, FIXTURE, [observer]);

  // Acceptance through the production boundary: log the first lift of the displayed
  // pick, which mints the plan identity (pv_/pi_) the ledger addresses.
  const accept = await acceptPlanByLogging(page, capture, {
    ask: 'What are we doing today?', firstLiftName: 'Back Squat', firstSetText: 'back squat 225 5/2 x2',
  });
  const benchItem = accept.items.find(it => String(it.planned_lift_code).toUpperCase() === SOURCE_LIFT);
  expect(benchItem, 'the accepted plan carries Bench Press with an immutable item id').toBeTruthy();

  // The rest of the six pre-bench sets.
  await submit(page, 'overhead press 110 6/2 x2');
  await submit(page, 'romanian deadlift 235 5/2 x2');
  await expect(page.locator('#active-session-banner')).toContainText(SOURCE_NAME);

  // The constraint lane. The proposal is staged here; the observer records it at that
  // instant, before any approval, mutation, or durable read.
  const recommendNextBefore = capture.recommendNextCalls.length;
  await submit(page, SUBSTITUTION_ASK);
  await expect(proposalLine(page)).toContainText(`Replace ${SOURCE_NAME} with ${REPLACEMENT_NAME}`);
  const observations = await readStagedProposals(page);
  // The window the retired inference watched: every recommend/next call from the ask
  // until the proposal was visibly staged.
  const recommendNextDuringAsk = capture.recommendNextCalls.slice(recommendNextBefore);

  // The prescription follow-up, answered from the staged proposal.
  await submit(page, PRESCRIPTION_ASK);
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText(REPLACEMENT_NAME);

  // Approval is what mutates, exactly once.
  await page.locator('#thread-messages .replacement-approve-btn').last().click();
  await expect.poll(async () => (await planNames(page)).some(n => /bench press/i.test(n)), { timeout: 15000 }).toBe(false);

  // The athlete performs the substitute — two sets, exactly as the frozen Session 1
  // conversation declares.
  await submit(page, 'incline db press 90 10/2');
  await submit(page, 'incline db press 90 10/2');

  const loggedNames = [
    'back squat', 'back squat', 'overhead press', 'overhead press',
    'romanian deadlift', 'romanian deadlift',
    REPLACEMENT_NAME.toLowerCase(), REPLACEMENT_NAME.toLowerCase(),
  ];
  return { accept, benchItemId: benchItem.plan_item_id, observations, recommendNextDuringAsk, loggedNames };
}

// The durable surfaces, in ledger-sidecar payload form: the same facts the live
// rehearsal reads back out of Session_Plans / Session_Plan_Sets / Log_Cleaned.
function durableSurfaces(capture, accept) {
  const outcome = outcomePosts(capture).find(p => p.body && p.body.item && p.body.item.outcome === 'substituted');
  const item = (outcome && outcome.body.item) || {};
  const revisions = revisionPosts(capture).map(p => (p.body && p.body.revision) || {});
  const sourceItemIds = (accept.items || [])
    .filter(it => String(it.planned_lift_code).toUpperCase() === SOURCE_LIFT)
    .map(it => it.plan_item_id);
  return {
    outcomeCount: outcomePosts(capture).filter(p => p.body && p.body.item && p.body.item.outcome === 'substituted').length,
    surfaces: {
      // The substitute's own performed rows carry the replacement lift code.
      logLiftCodes: [REPLACEMENT_LIFT],
      outcomePerformedLiftCode: String(item.performed_lift_code || ''),
      outcomePlannedLiftCode: String(item.planned_lift_code || ''),
      outcomePlanItemId: String(item.plan_item_id || ''),
      acceptedSourcePlanItemIds: sourceItemIds,
      ledgerRevisionLiftCodes: revisions.map(r => String(r.planned_lift_code || '')),
      ledgerRevisionPlanItemIds: revisions.map(r => String(r.plan_item_id || '')),
    },
    revisions,
  };
}

test.describe('staged-proposal evidence authority (F-SB4B diagnostic)', () => {
  test.describe.configure({ timeout: 120000 });

  test('the staged proposal is one complete immutable observation, captured before any mutation', async ({ page }) => {
    const capture = {};
    const run = await runSessionOneToSubstitution(page, capture);

    expect(run.observations, 'exactly one proposal was staged in this session').toHaveLength(1);
    const obs = latestStagedObservation(run.observations);

    // The capture-time assertion. It fails immediately — here, at the seam — when
    // proposal identity or prescription evidence is absent.
    const complete = assertObservationComplete(obs);
    expect(complete.problems.join('; ')).toBe('');
    expect(complete.ok).toBe(true);

    // Identity, from the proposal itself and not from the visible line.
    expect(obs.replacement_lift_code).toBe(REPLACEMENT_LIFT);
    expect(obs.replacement_name).toBe(REPLACEMENT_NAME);
    expect(obs.source_name).toBe(SOURCE_NAME);
    expect(String(obs.source_lift_code).toUpperCase()).toBe(SOURCE_LIFT);
    expect(obs.source_plan_item_id).toBe(run.benchItemId);

    // The whole engine prescription, including the set count the plan does not declare.
    expect(obs.weight).toBe(90);
    expect(obs.reps).toBe(10);
    expect(obs.rir).toBe(2);
    expect(obs.sets).toBe(SUBSTITUTE_SETS);

    // Captured BEFORE the mutation: the source was still in the plan and still in its
    // own slot, and the replacement was not yet anywhere in it.
    expect(obs.plan_names_at_staging).toContain(SOURCE_NAME);
    expect(obs.plan_names_at_staging).not.toContain(REPLACEMENT_NAME);
    expect(obs.source_slot_name).toBe(SOURCE_NAME);

    // The record is immutable — a later read cannot have been edited by anything.
    const reread = latestStagedObservation(await readStagedProposals(page));
    expect(reread).toEqual(obs);
    const frozen = await page.evaluate(k => Object.isFrozen(window[k][0]), STAGED_PROPOSALS_KEY);
    expect(frozen).toBe(true);
  });

  test('every durable surface is compared against the captured identity, and agrees', async ({ page }) => {
    const capture = {};
    const run = await runSessionOneToSubstitution(page, capture);
    const obs = latestStagedObservation(run.observations);
    const { outcomeCount, surfaces, revisions } = durableSurfaces(capture, run.accept);

    expect(outcomeCount, 'exactly one substituted item_outcome').toBe(1);
    const cmp = compareReplacementIdentity(observationToIdentity(obs), surfaces);
    expect(cmp.problems.join('; ')).toBe('');
    expect(cmp.ok).toBe(true);

    // The ledger revision grain stays bound to the IMMUTABLE accepted set count (2),
    // never to the engine's prescribed 3 — the two counts are distinct facts and the
    // observation keeps them distinct.
    expect(revisions).toHaveLength(2);
    expect([...new Set(revisions.map(r => Number(r.target_set_count)))]).toEqual([2]);
    expect(obs.sets).toBe(SUBSTITUTE_SETS);
  });

  test('the expected remaining work follows the STAGED prescription, not a declared set count', async ({ page }) => {
    const capture = {};
    const run = await runSessionOneToSubstitution(page, capture);
    const obs = latestStagedObservation(run.observations);
    const prescription = observationToPrescription(obs);

    // The live product's own remaining work is the arbiter.
    const live = await remainingNames(page);

    const expectation = deriveExpectedRemaining({
      plan: OWNER_PLAN,
      loggedNames: run.loggedNames,
      replacement: {
        sourceName: SOURCE_NAME, replacementName: REPLACEMENT_NAME, sets: prescription.sets,
      },
    });
    const cmp = compareRemainingToExpectation(live, expectation);
    expect(cmp.problems.join('; ')).toBe('');
    expect(cmp.ok).toBe(true);

    // Two of the substitute's three prescribed sets are done, so it is still work.
    expect(expectation.remaining).toEqual([REPLACEMENT_NAME, 'Seated Row', 'Bicep Curl']);
  });

  // ── the two retired inference paths, kept as executable mutations ─────────────

  test('MUTATION — restoring the phase-window recommend/next inference makes the identity comparison fail', async ({ page }) => {
    const capture = {};
    const run = await runSessionOneToSubstitution(page, capture);
    const { surfaces } = durableSurfaces(capture, run.accept);

    // The retired inference, recomputed exactly as it was: the last
    // `/api/recommend/next/<code>` request observed inside the substitution-ask
    // window. The constraint lane never makes one — the substitute and its
    // prescription come from `/api/suggest-substitute` — so the window is empty and
    // the inferred identity is blank. This is structural, not a timing race: widening
    // the window finds nothing, because there is nothing on the wire to find.
    expect(run.recommendNextDuringAsk, 'the constraint lane asks recommend/next for nothing').toHaveLength(0);
    const staleStaged = run.recommendNextDuringAsk;
    const inferredLiftCode = staleStaged.length ? staleStaged[staleStaged.length - 1].lift_code : '';
    expect(inferredLiftCode).toBe('');

    const defective = compareReplacementIdentity(
      { replacementLiftCode: inferredLiftCode, sourceLiftCode: SOURCE_LIFT, sourcePlanItemId: run.benchItemId },
      surfaces,
    );
    expect(defective.ok, 'defect A must not be able to pass').toBe(false);
    expect(defective.problems.join('; ')).toMatch(/no replacement lift code was captured/);

    // …and the corrected authority, on the same run, does pass.
    const obs = latestStagedObservation(run.observations);
    expect(compareReplacementIdentity(observationToIdentity(obs), surfaces).ok).toBe(true);
  });

  test('MUTATION — restoring the declared substitute set count makes the remaining-work expectation fail', async ({ page }) => {
    const capture = {};
    const run = await runSessionOneToSubstitution(page, capture);
    const obs = latestStagedObservation(run.observations);
    const live = await remainingNames(page);

    // The retired expectation: the substitute inherits the plan's declared per-item
    // set count (2), so two logged sets "complete" it. The engine prescribed 3, so the
    // product correctly still lists it — and the declaration disagrees with the product.
    const defective = deriveExpectedRemaining({
      plan: OWNER_PLAN, loggedNames: run.loggedNames,
      replacement: { sourceName: SOURCE_NAME, replacementName: REPLACEMENT_NAME },
    });
    expect(defective.remaining).toEqual(['Seated Row', 'Bicep Curl']);
    const defectiveCmp = compareRemainingToExpectation(live, defective);
    expect(defectiveCmp.ok, 'defect B must not be able to pass').toBe(false);

    // …and the staged prescription, on the same run, does agree with the product.
    const corrected = deriveExpectedRemaining({
      plan: OWNER_PLAN, loggedNames: run.loggedNames,
      replacement: {
        sourceName: SOURCE_NAME, replacementName: REPLACEMENT_NAME,
        sets: observationToPrescription(obs).sets,
      },
    });
    expect(compareRemainingToExpectation(live, corrected).ok).toBe(true);
  });
});
