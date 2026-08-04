'use strict';
/*
 * F-SB4B OWNER-PATTERN REHEARSAL — the ONE qualifying-session spec (TEMPORARY; sunset: F-SB4C).
 *
 * Adapted from the proven Stage A runner (stage-a-canary.spec.js, sunset PR #1234) under the
 * owner resolution recorded in docs/ATLAS_V1_EXECUTION_PLAN.md (F-SB4B, 2026-08-03). Launched
 * ONLY through `npm run atlas:rehearsal-session -- --session=N --model-up`, which mints the
 * run/athlete correlation identities and preflights count eligibility. The spec spawns its own
 * gate server with the combined rehearsal posture set EXPLICITLY (playwright.config.js scrubs
 * the flag from every inherited environment, so inheritance can never reach here).
 *
 * IDENTITY ISOLATION (recorded rules 2–5) is structural in this file:
 *   - #log-session-id is asserted EMPTY before acceptance and never written by this spec;
 *   - the workout identity is CAPTURED from the client after the server allocates it at
 *     acceptance (PR #1246) and used only for correlation, /durable-rows reads, and the
 *     review-tool adjudication;
 *   - every durable assertion goes through the harness's session-filtered verifier, which
 *     403s any identity this process did not write — proven in-run with a foreign id probe.
 *
 * Scenario expectations are DECLARED in SCENARIOS below before execution; the bounded
 * scorecard (rehearsal-scorecard.js) compares evidence against the declaration. Sessions are
 * added to SCENARIOS before their first run; an undeclared session number refuses.
 */

const { test, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  scoreRehearsalRun, renderMarkdown, compareLedgerToDeclaration, classifyRepeatApprovalProbe,
  classifySettlement, isSettled,
  deriveExpectedRemaining, compareRemainingToExpectation, replyMatchesExpectation,
  detectUnsupportedMutationWording, compareReplacementIdentity, pinMatchesExpectation,
  classifyCoachResponseCapture, detectUnsupportedWriteClaim, liftMentionIndex,
} = require('./rehearsal-scorecard');
const { REHEARSAL_SESSION } = require('./rehearsal-run-purpose');
const { measureSourceTree } = require('./rehearsal-source-facts');
const { markRunStarted, verifyRunStartMarker } = require('./rehearsal-run-start');
const { pickNetworkPassthrough, assertNoWorkbookId, GATE_STARTUP_TIMEOUT_MS } = require('./rehearsal-child-env');
const {
  OBSERVER_FLUSH_MS, bubbleObserverInitScript,
  ingestLiveObservation, reconcileSweep, recordsToMessages, makeBoundary,
  SEEN_ATTR,
  NEW_BUBBLE_SELECTOR,
  markExistingBubblesScript,
} = require('./rehearsal-bubble-observer');
const {
  STAGED_PROPOSALS_KEY, stagedProposalObserverScript, readStagedProposals,
  latestStagedObservation, assertObservationComplete, observationToIdentity,
  observationToPrescription,
} = require('./rehearsal-staged-proposal');
const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6 } = require('../../../config/sandboxSheet');
const { logCleanedColumns, effortColumns, sessionPlansColumns, sessionPlanSetsColumns } = require('../../../config/columns');

const GATE_KEY = 'playwright-gate-key';
const RUN_ID = process.env.ATLAS_REHEARSAL_RUN_ID;
const ATHLETE_ID = process.env.ATLAS_REHEARSAL_ATHLETE_ID;
const ARTIFACT_DIR = process.env.ATLAS_REHEARSAL_ARTIFACT_DIR;
const RUN_PURPOSE = process.env.ATLAS_RUN_PURPOSE || '';
const SESSION_NUMBER = /^[0-9]+$/.test(String(process.env.ATLAS_REHEARSAL_SESSION_NUMBER || ''))
  ? Number(process.env.ATLAS_REHEARSAL_SESSION_NUMBER) : NaN;

const SOURCE = measureSourceTree();

// ── The declared scenarios (expectations BEFORE execution) ──────────────────────
// All five owner-pattern sessions from the F-SB4 card, frozen BEFORE any qualifying
// run: the plan, the exact owner wording, the mutation lane, the durable end-state,
// the effort behavior, and the closeout expectation. The run may only MATCH a
// declaration, never define one. Every session is model-up (the operator command
// refuses any other posture). The common six-exercise owner plan is shared where the
// card does not prescribe a different order; Session 5 reorders to complete a
// pressing exercise early (referent-drift scenario).
const OWNER_PLAN = [
  { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 2, target_rir: 2 },
  { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 110, target_reps: 6, target_sets: 2, target_rir: 2 },
  { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 235, target_reps: 5, target_sets: 2, target_rir: 2 },
  { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 215, target_reps: 5, target_sets: 2, target_rir: 2 },
  { exercise: 'Seated Row', lift_code: 'SR01', target_weight: 205, target_reps: 10, target_sets: 2, target_rir: 2 },
  { exercise: 'Bicep Curl', lift_code: 'BC01', target_weight: 35, target_reps: 15, target_sets: 2, target_rir: 2 },
];
const EFFORT_FIXTURE = { duration: '52:10', active: '412', total: '545', avg: '128', peak: '164' };

const SCENARIOS = {
  1: {
    id: 'session-1-dale-substitution-flow',
    plan: OWNER_PLAN,
    preBenchSets: [
      'back squat 225 x 5 @2', 'back squat 225 x 5 @2',
      'overhead press 110 x 6 @2', 'overhead press 110 x 6 @2',
      'romanian deadlift 235 x 5 @2', 'romanian deadlift 235 x 5 @2',
    ],
    substitutionAsk: 'The bench is taken at the gym so plan give me a substitute workout',
    prescriptionAsk: 'Nice! How much should I lift?',
    postBenchSets: [
      'seated row 205 x 10 @2', 'seated row 205 x 10 @2',
      'bicep curl 35 x 15 @2', 'bicep curl 35 x 15 @2',
    ],
    effort: EFFORT_FIXTURE,
    expected: {
      session_plans_events: { plan_accepted: 6, item_outcome: 1, session_closeout: 1 },
      plan_set_rows: 14,
      log_rows: 12,
      effort_supplied: true,
      closeout_fully_verified: true,
    },
  },
  2: {
    id: 'session-2-conversational-correction',
    plan: OWNER_PLAN,
    preBenchSets: [
      'back squat 225 x 5 @2', 'back squat 225 x 5 @2',
      'overhead press 110 x 6 @2', 'overhead press 110 x 6 @2',
      'romanian deadlift 235 x 5 @2', 'romanian deadlift 235 x 5 @2',
    ],
    // The correction sequence, in the card's exact owner wording: an open question
    // Atlas may answer any way it likes, then the two corrections. A correction must
    // NEVER become a skip, whole-session generation, a subject change, or a false
    // pre-acceptance "noted" claim — the product's honest lane is a fail-closed
    // clarify that keeps the plan untouched and asks for the unavailability
    // statement, after which exactly ONE bounded proposal is staged and KEPT.
    openingAsk: 'What should I do about bench press today?',
    correction1: 'No I meant a substitute workout for bench press, like incline dumbbell or something',
    correction2: 'Well I was asking for a substitute',
    unavailabilityStatement: 'The bench is taken',
    prescriptionAsk: 'How much?',
    conversationalAccept: 'Yes use that',
    repeatedAccept: 'yes',
    postBenchSets: [
      'seated row 205 x 10 @2', 'seated row 205 x 10 @2',
      'bicep curl 35 x 15 @2', 'bicep curl 35 x 15 @2',
    ],
    effort: EFFORT_FIXTURE,
    // The card's Session 2 requirement: stale, superseded, and cross-session proposal
    // state must be unable to participate in the next session.
    proveTeardown: true,
    expected: {
      session_plans_events: { plan_accepted: 6, item_outcome: 1, session_closeout: 1 },
      plan_set_rows: 14,
      log_rows: 12,
      effort_supplied: true,
      closeout_fully_verified: true,
    },
  },
  3: {
    id: 'session-3-replacement-second-in-batch',
    plan: OWNER_PLAN,
    preBenchSets: [
      'back squat 225 x 5 @2', 'back squat 225 x 5 @2',
      'overhead press 110 x 6 @2', 'overhead press 110 x 6 @2',
      'romanian deadlift 235 x 5 @2', 'romanian deadlift 235 x 5 @2',
    ],
    substitutionAsk: 'The bench is taken at the gym so plan give me a substitute workout',
    // The Codex P1 edge at full-session level: after the proposal is staged, ONE
    // multi-exercise submission where a DIFFERENT valid planned exercise (Seated Row)
    // appears FIRST and the proposed replacement appears SECOND. The binder must
    // examine every logged exercise; the replacement binds to the Bench slot, the
    // seated row to its own slot, and no substitution is inferred from similarity.
    batchFirstLine: 'seated row 205 x 10 @2',
    // The genuinely unrelated off-plan exercise, submitted SEPARATELY — a legitimate
    // insertion, never a substitution.
    offPlanLine: 'face pull 60 x 12 @2',
    remainingAsk: 'What do I have left?',
    finishingSets: [
      'seated row 205 x 10 @2',
      'bicep curl 35 x 15 @2', 'bicep curl 35 x 15 @2',
    ],
    effort: EFFORT_FIXTURE,
    expected: {
      session_plans_events: { plan_accepted: 6, item_outcome: 1, session_closeout: 1 },
      plan_set_rows: 14,
      // 6 pre-Bench + batch (1 seated row + 1 replacement) + 1 off-plan + 1
      // replacement + 1 seated row + 2 bicep curl.
      log_rows: 13,
      effort_supplied: true,
      closeout_fully_verified: true,
    },
  },
  4: {
    id: 'session-4-honest-incompleteness',
    plan: OWNER_PLAN,
    // Five items completed in Dale's normal style; Bicep Curl deliberately left
    // UNFINISHED (zero sets). No substitution lane at all this session.
    completedSets: [
      'back squat 225 x 5 @2', 'back squat 225 x 5 @2',
      'overhead press 110 x 6 @2', 'overhead press 110 x 6 @2',
      'romanian deadlift 235 x 5 @2', 'romanian deadlift 235 x 5 @2',
      'bench press 215 x 5 @2', 'bench press 215 x 5 @2',
      'seated row 205 x 10 @2', 'seated row 205 x 10 @2',
    ],
    // The card's exact natural phrasing. (A COMPOUND "I'm wiped today, I'm done
    // for today" routes to the fatigue-aside lane — the coach responds to the
    // fatigue, honestly and without fabricating completion — so the declared end
    // uses the card's own single finish phrase.)
    endEarlyStatement: "I'm done for today",
    unfinishedLiftRegex: /bicep curl/i,
    // NO Apple Watch / effort data this session: its ABSENCE must not fail the write,
    // and exactly zero Effort rows may land.
    effort: null,
    // The card's Session 4 requirement: the next session cannot inherit this session's
    // proposal, logs, or pending state.
    proveTeardown: true,
    expected: {
      session_plans_events: { plan_accepted: 6, session_closeout: 1 },
      plan_set_rows: 12,
      log_rows: 10,
      effort_supplied: false,
      closeout_fully_verified: true,
    },
  },
  5: {
    id: 'session-5-referent-drift-evening',
    // The pressing exercise is completed EARLY (Overhead Press first); the fresh
    // substitution proposal later targets a DIFFERENT current lift (Seated Row).
    plan: [
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 110, target_reps: 6, target_sets: 2, target_rir: 2 },
      { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 2, target_rir: 2 },
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 235, target_reps: 5, target_sets: 2, target_rir: 2 },
      { exercise: 'Seated Row', lift_code: 'SR01', target_weight: 205, target_reps: 10, target_sets: 2, target_rir: 2 },
      { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 215, target_reps: 5, target_sets: 2, target_rir: 2 },
      { exercise: 'Bicep Curl', lift_code: 'BC01', target_weight: 35, target_reps: 15, target_sets: 2, target_rir: 2 },
    ],
    preSubSets: [
      'overhead press 110 x 6 @2', 'overhead press 110 x 6 @2',
      'back squat 225 x 5 @2', 'back squat 225 x 5 @2',
      'romanian deadlift 235 x 5 @2', 'romanian deadlift 235 x 5 @2',
    ],
    substitutionAsk: 'The seated row machine is taken, give me a substitute',
    // The referent-drift probe: the answer must use the FRESH pending proposal for
    // the Seated Row replacement — never the earlier COMPLETED press (F-SB2 drift).
    prescriptionAsk: 'How much should I lift?',
    driftRegex: /overhead press/i,
    finishingSets: [
      'bench press 215 x 5 @2', 'bench press 215 x 5 @2',
      'bicep curl 35 x 15 @2', 'bicep curl 35 x 15 @2',
    ],
    effort: EFFORT_FIXTURE,
    // Controlled Pacific-evening clock: the browser runs in America/Los_Angeles at
    // 19:30 local, so the browser's UTC calendar date is the FOLLOWING day while
    // every client-derived session/log date stays the Pacific-local date. (The gate
    // server's own timestamps remain real time — the harness fakes the client clock
    // only; the adjudication joins on the exact session identity.)
    clock: { timezoneId: 'America/Los_Angeles', localEveningHour: 19, localEveningMinute: 30 },
    reviewTextAgreement: true,
    expected: {
      session_plans_events: { plan_accepted: 6, item_outcome: 1, session_closeout: 1 },
      plan_set_rows: 14,
      log_rows: 12,
      effort_supplied: true,
      closeout_fully_verified: true,
    },
  },
};

// ── driver helpers (shared observation code, no scenario policy) ────────────────
const nameKey = (v) => String(v || '').trim().toLowerCase().replace(/[-\s]+/g, ' ');
function parseShorthand(s) {
  const m = s.match(/^(.+?)\s+([\d.]+)\s*x\s*(\d+)\s*@\s*(\d+)$/i);
  return { name: nameKey(m[1]), weight: Number(m[2]), reps: Number(m[3]), rir: Number(m[4]) };
}

// The INDEPENDENT remaining-work expectation for this point in the scenario, derived
// from the FROZEN declaration plus the sets the driver has declared it logged — never
// from client state, durable rows, or the visible reply (owner P1, 2026-08-03).
// `loggedSets` entries carry the parsed shorthand name; a substitute set carries the
// replacement's own name so it spends against the replaced slot.
//
// The substitute's SET COUNT comes from the staged proposal, never from the frozen
// plan: the engine prescribes it, and Session 1 proved a declared 2 against a
// prescribed 3 (F-SB4B corrective 3).
function expectedRemainingNow(SC, loggedSets, sub) {
  return deriveExpectedRemaining({
    plan: SC.plan,
    loggedNames: loggedSets.map(x => x.name),
    replacement: sub ? { sourceName: sub.sourceName, replacementName: sub.name, sets: sub.sets } : null,
  });
}

// Compare BOTH observations against that one expectation, and record each separately so
// a failure names which surface lied. Client state and reply agreeing with each other
// proves nothing — that agreement is the corruption shape this rehearsal exists to catch.
async function proveRemainingWork(page, h, { SC, loggedSets, sub, reply, label }) {
  const expectation = expectedRemainingNow(SC, loggedSets, sub);
  const observed = await page.evaluate(() => (window.remainingPlannedExercises
    ? window.remainingPlannedExercises().map(e => e.canonicalName || e.name || e) : null));
  const stateCmp = compareRemainingToExpectation(observed, expectation);
  h.stateCheck(`${label}-state-matches-declaration`, stateCmp.ok,
    stateCmp.ok
      ? `remaining [${expectation.remaining.join(', ')}], next up ${expectation.nextUp || '(none)'} — derived from the declaration`
      : stateCmp.problems.join('; '));

  if (typeof reply === 'string') {
    const replyCmp = replyMatchesExpectation(reply, expectation);
    h.beat(`${label}-reply-matches-declaration`, replyCmp.ok,
      replyCmp.ok
        ? `reply agrees with the declared remaining work [${expectation.remaining.join(', ')}]`
        : `${replyCmp.problems.join('; ')} — reply: "${String(reply).slice(0, 160)}"`);
  }
  return expectation;
}

async function planState(page) {
  return page.evaluate(() => {
    const p = window.getActivePlannedSession();
    return p ? { names: p.exercises.map(e => e.canonicalName || e.name), index: p.index } : { names: [], index: -1 };
  });
}

// Assert the STAGED (unaccepted) proposal state: source lift still in the plan and
// still current, no completed-mutation wording, and the complete staged-proposal
// observation captured at the moment the proposal was staged.
//
// The proposal LINE is no longer parsed for the prescription (F-SB4B corrective 3).
// Prose was the only carrier of the substitute's name and numbers, which made the
// visible text both the claim and its own evidence. The observation is the authority;
// the line is now checked for AGREEMENT with it, which is the stronger question.
async function assertStagedProposal(page, h, { sourceRegex }) {
  await expect(page.locator('#thread-messages .replacement-proposal-line').last()).toBeVisible({ timeout: 60000 });
  const line = await page.locator('#thread-messages .replacement-proposal-line').last().innerText();
  const after = await planState(page);
  const stillCurrent = sourceRegex.test(after.names[after.index] || '');
  h.beat('no-mutation-before-acceptance', after.names.some(n => sourceRegex.test(n)) && stillCurrent,
    `plan after ask: [${after.names.join(', ')}], current index ${after.index}`);
  // P1-4: read the bubbles this ask produced BY ELEMENT, never
  // `wholeThread.slice(before.length)`. That offset slice carries the same shrinking-
  // prefix assumption that produced the "ve." fragment, so a pre-acceptance
  // completed-mutation claim could be sliced away or missed entirely.
  const askBubbles = page.locator(NEW_BUBBLE_SELECTOR);
  const askTotal = await askBubbles.count();
  const newTexts = [];
  for (let i = 0; i < askTotal; i += 1) {
    newTexts.push(String(await askBubbles.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim());
  }
  const mutationWording = newTexts.some(t => /i've noted the substitution|you're substituting|has been (swapped|replaced)/i.test(t));
  h.beat('no-completed-mutation-wording', !mutationWording,
    mutationWording
      ? `completed-mutation wording appeared before acceptance across ${newTexts.length} new bubble(s)`
      : `clean across ${newTexts.length} new bubble(s) read by element`);
  // THE ONE STAGED-PROPOSAL OBSERVATION — recorded by the page-side observer at the
  // instant `renderReplacementProposal` announced the proposal, which is after
  // `setPendingReplacement` and before any approval, mutation, or durable read. It
  // carries the replacement lift code and name, the source lift, its lift code and its
  // immutable plan_item_id, and the engine's whole prescription including the set
  // count. Identity, binding, and the expected substitute set count all read THIS.
  //
  // It replaces the phase-window `recommend/next` inference, which was empty by
  // construction on the constraint lane: that lane takes its substitute and
  // prescription from `/api/suggest-substitute` and never asks `recommend/next` for
  // the replacement, so no request ever fell inside the window to be captured.
  const observation = latestStagedObservation(await readStagedProposals(page, STAGED_PROPOSALS_KEY));
  const complete = assertObservationComplete(observation);
  const identity = observationToIdentity(observation);
  const prescription = observationToPrescription(observation);
  h.beat('replacement-identity-captured', complete.ok,
    complete.ok
      ? `the staged proposal ${observation.proposal_id} resolves to lift code ${identity.replacementLiftCode} on source slot ${identity.sourcePlanItemId}, with ${prescription.weight}×${prescription.reps}${prescription.sets != null ? ` × ${prescription.sets} sets` : ''}, all captured at staging before any mutation or durable read`
      : `staged-proposal observation incomplete: ${complete.problems.join('; ')}`);
  // The visible line must AGREE with the observation. Before, the line WAS the
  // evidence, so a line that named the wrong lift or the wrong load agreed with
  // itself. Now a proposal card that contradicts the staged proposal fails.
  //
  // The FULL replacement name, through the scorecard's one lift-mention matcher.
  // A first-word test was too weak for an agreement check (Codex P2, this PR): a card
  // reading "Replace Bench Press with Incline Bench Press" would satisfy a staged
  // "Incline Dumbbell Press", so the visible mismatch this beat exists to catch would
  // pass. `liftMentionIndex` matches the whole phrase with flexible separators and is
  // already the authority for "does this text name this lift" everywhere else.
  const namesReplacement = Boolean(prescription.name) && liftMentionIndex(line, prescription.name) >= 0;
  const carriesNumbers = prescription.weight != null && prescription.reps != null
    && new RegExp(`\\b${prescription.weight}\\b`).test(line) && new RegExp(`\\b${prescription.reps}\\b`).test(line);
  h.beat('proposal-carries-prescription', namesReplacement && carriesNumbers,
    `visible line vs the staged proposal (${prescription.name} ${prescription.weight}×${prescription.reps}): "${line.slice(0, 140)}"`);
  return {
    line,
    name: prescription.name,
    weight: prescription.weight,
    reps: prescription.reps,
    sets: prescription.sets,
    replacementLiftCode: identity.replacementLiftCode,
    sourcePlanItemId: identity.sourcePlanItemId,
    observation,
  };
}

// Assert the proposal-grounded prescription answer: carries the proposal's own
// numbers, identifies the substitute (by name or as the replacement), and never
// drifts to a completed lift (the F-SB2 drift class).
function assertGroundedPrescription(h, reply, sub, sourceLabel, driftRegex) {
  const namesSubstitute = sub.name && new RegExp(sub.name.split(/\s+/)[0], 'i').test(reply);
  // "Approve the swap and I'll set it" is the engine's terse grounded variant — it
  // ties the numbers to the PENDING swap explicitly, which is the grounding fact.
  const referencesProposal = new RegExp(`replacement for ${sourceLabel}|proposed (?:target|replacement)|approve the swap`, 'i').test(reply);
  const carriesWeight = sub.weight != null && new RegExp(`\\b${sub.weight}\\b`).test(reply);
  const carriesReps = sub.reps != null && new RegExp(`\\b${sub.reps}\\b`).test(reply);
  const drifts = driftRegex.test(reply);
  h.beat('prescription-from-proposal',
    (namesSubstitute || referencesProposal) && carriesWeight && carriesReps && !drifts,
    `reply: "${reply.slice(0, 200)}"`);
}

// ── the five session drivers (frozen conversation flows) ────────────────────────
// Each driver runs the scenario's DECLARED conversation from post-acceptance to
// pre-closeout and returns { logged, loggedSets, substitution } for the common
// durable verification. Scenario policy lives HERE and in SCENARIOS — the runner,
// operator command, and frozen scorecard are never modified per scenario.
const DRIVERS = {
  // Session 1 — Dale's exact substitution flow.
  async 1({ page, SC, h }) {
    h.setPhase('logging');
    let logged = 0;
    const loggedSets = [];
    for (const s of SC.preBenchSets) { logged += 1; await h.logSet(s, logged); loggedSets.push(parseShorthand(s)); }
    const st = await planState(page);
    h.beat('bench-current', /bench press/i.test(st.names[st.index] || ''), `current lift after ${logged} sets: "${st.names[st.index] || ''}"`);
    await h.snap('03-source-current.png');

    h.setPhase('substitution_ask');
    await markBubblesSeen(page);   // the ask's own bubbles are the unmarked ones
    await h.say(SC.substitutionAsk);
    const sub = await assertStagedProposal(page, h, { sourceRegex: /bench press/i });
    h.beat('substitution-lane', /replace bench press with/i.test(sub.line), `proposal: "${sub.line.slice(0, 160)}"`);
    const approveButtons = await page.locator('#thread-messages .replacement-approve-btn').count();
    h.stateCheck('one-bounded-proposal', approveButtons === 1, `${approveButtons} approve control(s) in the thread`);
    await h.snap('04-substitution-proposal.png');

    h.setPhase('prescription_question');
    const howMuch = await h.settleReply(SC.prescriptionAsk);
    assertGroundedPrescription(h, howMuch, sub, 'bench press', /back squat|overhead press|romanian deadlift/i);
    await h.snap('05-how-much.png');

    h.setPhase('replacement');
    await page.locator('#thread-messages .replacement-approve-btn').last().click();
    await expect.poll(async () => (await planState(page)).names.some(n => /bench press/i.test(n)), { timeout: 20000 }).toBe(false);
    await h.markMutation();   // the source lift has provably left the plan — claims are earned from here
    const mutated = await planState(page);
    h.beat('replacement-mutated-plan', mutated.names.some(n => new RegExp(sub.name.split(/\s+/)[0], 'i').test(n)), `plan now: [${mutated.names.join(', ')}]`);
    const shorthand = `${sub.name.toLowerCase()} ${sub.weight} x ${sub.reps} @2`;
    logged += 1; await h.logSet(shorthand, logged); loggedSets.push({ ...parseShorthand(shorthand), sub: true });
    logged += 1; await h.logSet(shorthand, logged); loggedSets.push({ ...parseShorthand(shorthand), sub: true });
    const benchLeft = await page.evaluate(() => {
      const p = window.getActivePlannedSession();
      return !p.exercises.some((e, i) => i >= p.index && /bench press/i.test(e.canonicalName || e.name));
    });
    h.beat('bench-left-remaining-work', benchLeft, 'Bench Press no longer in remaining work');
    // The former `stateCheck('pin-agrees-after-swap', true, …)` asserted a literal and
    // proved nothing (owner P1, 2026-08-03). Both the canonical remaining list AND the
    // visible session pin are now compared against the expectation derived from the
    // frozen declaration, so a wrong store and a pin faithfully rendering it both fail.
    const expectation = await proveRemainingWork(page, h, {
      SC, loggedSets, sub: { ...sub, sourceName: 'Bench Press' }, label: 'post-swap',
    });
    const pinText = await page.locator('#session-pin').innerText().catch(() => '');
    // The pin must name the EXACT expected current lift. Checking only for a retired
    // name let a blank pin, or a pin naming the wrong lift, pass (owner P1, 2026-08-03).
    const pinCmp = pinMatchesExpectation(pinText, expectation);
    h.stateCheck('pin-agrees-after-swap', pinCmp.ok,
      pinCmp.ok
        ? `the visible pin names the expected current lift "${expectation.nextUp}" and nothing retired or complete`
        : `${pinCmp.problems.join('; ')} — pin: "${pinText.replace(/\s+/g, ' ').slice(0, 160)}"`);

    h.setPhase('eligible_question');
    const open = await h.settleReply('any tips for keeping my lower back safe on the remaining lifts?');
    h.note('open-turn', `reply length ${open.length}`);

    h.setPhase('logging_tail');
    for (const s of SC.postBenchSets) { logged += 1; await h.logSet(s, logged); loggedSets.push(parseShorthand(s)); }
    await h.snap('06-workout-logged.png');
    return { logged, loggedSets, substitution: { ...sub, sourceLift: 'BEN01', sourceName: 'Bench Press', sourceRegex: /bench press/i } };
  },

  // Session 2 — conversational correction: the "No" never becomes a skip, the two
  // corrections yield ONE bounded proposal, generic "yes" binds only the fresh
  // proposal, a repeated "yes" duplicates nothing.
  async 2({ page, SC, h }) {
    h.setPhase('logging');
    let logged = 0;
    const loggedSets = [];
    for (const s of SC.preBenchSets) { logged += 1; await h.logSet(s, logged); loggedSets.push(parseShorthand(s)); }
    const st = await planState(page);
    h.beat('bench-current', /bench press/i.test(st.names[st.index] || ''), `current lift: "${st.names[st.index] || ''}"`);

    // The opening open question — also the legitimate live-provider turn.
    h.setPhase('eligible_question');
    const opening = await h.settleReply(SC.openingAsk);
    h.note('opening-reply', opening.slice(0, 160));

    // Each correction must stay honest: no skip, no mutation, no subject change,
    // no unrelated historical Bench concern, no false "noted" claim. The product's
    // fail-closed clarify lane satisfies every one of these.
    h.setPhase('substitution_ask');
    for (const [label, phrase] of [['first-correction', SC.correction1], ['second-correction', SC.correction2]]) {
      const reply = await h.settleReply(phrase);
      const st2 = await planState(page);
      const honest = /bench press/i.test(st2.names[st2.index] || '')
        && st2.names.some(n => /bench press/i.test(n))
        && !/i've noted|has been (swapped|replaced)/i.test(reply)
        && !/last (week|time|session)|historically|your history/i.test(reply)
        && /bench|substitute|swap|replace|unavailable|taken/i.test(reply);
      h.beat(`${label}-honest-no-skip`, honest,
        `plan current "${st2.names[st2.index] || ''}"; reply: "${reply.slice(0, 140)}"`);
    }
    // The unavailability statement the product's own clarify asks for stages the
    // ONE bounded proposal, which the corrections then KEEP.
    await markBubblesSeen(page);   // the statement's own bubbles are the unmarked ones
    await h.say(SC.unavailabilityStatement);
    const sub = await assertStagedProposal(page, h, { sourceRegex: /bench press/i });
    h.beat('one-proposal-staged-and-kept', /replace bench press with/i.test(sub.line),
      `proposal after "${SC.unavailabilityStatement}": "${sub.line.slice(0, 140)}"`);
    await h.snap('04-corrected-proposal.png');

    h.setPhase('prescription_question');
    const howMuch = await h.settleReply(SC.prescriptionAsk);
    assertGroundedPrescription(h, howMuch, sub, 'bench press', /back squat|overhead press|romanian deadlift/i);

    // Conversational acceptance — binds ONLY the fresh current-session proposal.
    h.setPhase('replacement');
    await h.say(SC.conversationalAccept);
    await expect.poll(async () => (await planState(page)).names.some(n => /bench press/i.test(n)), { timeout: 30000 }).toBe(false);
    await h.markMutation();
    const mutated = await planState(page);
    h.beat('conversational-accept-one-mutation', mutated.names.some(n => new RegExp(sub.name.split(/\s+/)[0], 'i').test(n)),
      `plan after "Yes use that": [${mutated.names.join(', ')}]`);
    // A repeated "yes" must mutate nothing further. The proposal is already
    // CONSUMED, so the product may legitimately answer nothing at all — the probe
    // is state-based (plan unchanged now; zero duplicate item_outcome durably,
    // verified in the common section), never reply-based.
    const namesBefore = mutated.names.join('|');
    await h.say(SC.repeatedAccept);
    await page.waitForTimeout(4000);
    const afterRepeat = await planState(page);
    h.beat('repeated-yes-mutates-nothing', afterRepeat.names.join('|') === namesBefore,
      `plan unchanged after repeated "${SC.repeatedAccept}"`);

    const shorthand = `${sub.name.toLowerCase()} ${sub.weight} x ${sub.reps} @2`;
    h.setPhase('logging_tail');
    logged += 1; await h.logSet(shorthand, logged); loggedSets.push({ ...parseShorthand(shorthand), sub: true });
    logged += 1; await h.logSet(shorthand, logged); loggedSets.push({ ...parseShorthand(shorthand), sub: true });
    for (const s of SC.postBenchSets) { logged += 1; await h.logSet(s, logged); loggedSets.push(parseShorthand(s)); }
    await h.snap('06-workout-logged.png');
    return { logged, loggedSets, substitution: { ...sub, sourceLift: 'BEN01', sourceName: 'Bench Press', sourceRegex: /bench press/i } };
  },

  // Session 3 — the replacement SECOND in a multi-exercise batch; an unrelated
  // off-plan exercise stays a legitimate insertion.
  async 3({ page, SC, h }) {
    h.setPhase('logging');
    let logged = 0;
    const loggedSets = [];
    for (const s of SC.preBenchSets) { logged += 1; await h.logSet(s, logged); loggedSets.push(parseShorthand(s)); }
    const st = await planState(page);
    h.beat('bench-current', /bench press/i.test(st.names[st.index] || ''), `current lift: "${st.names[st.index] || ''}"`);

    h.setPhase('substitution_ask');
    await markBubblesSeen(page);   // the ask's own bubbles are the unmarked ones
    await h.say(SC.substitutionAsk);
    const sub = await assertStagedProposal(page, h, { sourceRegex: /bench press/i });
    h.beat('substitution-lane', /replace bench press with/i.test(sub.line), `proposal: "${sub.line.slice(0, 160)}"`);
    await h.snap('04-substitution-proposal.png');

    // The batch: a DIFFERENT valid planned exercise first, the replacement second —
    // one submission. The binder must bind the replacement to the Bench slot and the
    // seated row to its own slot, inferring nothing from position or similarity.
    h.setPhase('replacement');
    const replacementLine = `${sub.name.toLowerCase()} ${sub.weight} x ${sub.reps} @2`;
    await h.say(`${SC.batchFirstLine}\n${replacementLine}`);
    await expect.poll(() => h.loggedCount(), { timeout: 30000 }).toBe(logged + 2);
    logged += 2;
    loggedSets.push(parseShorthand(SC.batchFirstLine));
    loggedSets.push({ ...parseShorthand(replacementLine), sub: true });
    await expect.poll(async () => (await planState(page)).names.some(n => /bench press/i.test(n)), { timeout: 20000 }).toBe(false);
    await h.markMutation();
    const mutated = await planState(page);
    h.beat('batch-binds-replacement-to-source-slot',
      mutated.names.some(n => new RegExp(sub.name.split(/\s+/)[0], 'i').test(n)) && !mutated.names.some(n => /bench press/i.test(n)),
      `plan after batch: [${mutated.names.join(', ')}]`);

    // The genuinely unrelated off-plan exercise, separately — a legitimate insertion,
    // never a substitution (the plan keeps the replacement AND all other slots).
    const namesBefore = (await planState(page)).names.slice();
    logged += 1; await h.logSet(SC.offPlanLine, logged); loggedSets.push(parseShorthand(SC.offPlanLine));
    const namesAfterOffPlan = (await planState(page)).names;
    h.beat('off-plan-stays-insertion',
      namesBefore.every(n => namesAfterOffPlan.includes(n)),
      `plan slots preserved around the off-plan set: [${namesAfterOffPlan.join(', ')}]`);

    // Complete the replacement slot's second set (the immutable accepted grain is
    // two sets; the batch supplied only the first).
    logged += 1; await h.logSet(replacementLine, logged); loggedSets.push({ ...parseShorthand(replacementLine), sub: true });

    // Canonical remaining-work answer — state truth, not chat memory.
    // Canonical remaining-work answer — state truth, not chat memory, and NOT the old
    // circular check. That version read client state and passed when the reply repeated
    // it, so a wrong state and a faithful reply agreed and both were wrong. Both are now
    // compared against the expectation derived from the frozen declaration, and the
    // exact next-up lift is asserted rather than left unchecked (owner P1, 2026-08-03).
    h.setPhase('remaining_question');
    const left = await h.settleReply(SC.remainingAsk);
    const expectation = await proveRemainingWork(page, h, {
      SC, loggedSets, sub: { ...sub, sourceName: 'Bench Press' }, reply: left, label: 'remaining-answer',
    });
    const observedNext = await page.evaluate(() => {
      const r = window.remainingPlannedExercises ? window.remainingPlannedExercises() : [];
      const first = r[0];
      return first ? (first.canonicalName || first.name || String(first)) : null;
    });
    const nk = (v) => String(v || '').trim().toLowerCase().replace(/[-\s]+/g, ' ');
    h.stateCheck('next-up-exact', nk(observedNext) === nk(expectation.nextUp),
      `next up is "${observedNext}"; the declaration expects "${expectation.nextUp}"`);

    h.setPhase('eligible_question');
    const open = await h.settleReply('any tips for keeping my grip strong through these last sets?');
    h.note('open-turn', `reply length ${open.length}`);

    h.setPhase('logging_tail');
    for (const s of SC.finishingSets) { logged += 1; await h.logSet(s, logged); loggedSets.push(parseShorthand(s)); }
    await h.snap('06-workout-logged.png');
    return { logged, loggedSets, substitution: { ...sub, sourceLift: 'BEN01', sourceName: 'Bench Press', sourceRegex: /bench press/i } };
  },

  // Session 4 — honest incompleteness: one planned lift left unfinished, an early
  // natural end, NO effort data, clean teardown.
  async 4({ page, SC, h }) {
    h.setPhase('logging');
    let logged = 0;
    const loggedSets = [];
    for (const s of SC.completedSets) { logged += 1; await h.logSet(s, logged); loggedSets.push(parseShorthand(s)); }
    const st = await planState(page);
    h.beat('unfinished-lift-still-pending', SC.unfinishedLiftRegex.test(st.names[st.index] || ''),
      `current (unfinished) lift: "${st.names[st.index] || ''}"`);

    h.setPhase('eligible_question');
    const open = await h.settleReply('how should I plan around a day like this when I run out of steam?');
    h.note('open-turn', `reply length ${open.length}`);

    // The early end, in Dale's words. The closeout must report remaining work
    // HONESTLY — never fabricate completion, never call the unfinished lift a
    // substitution contradiction.
    h.setPhase('closeout');
    const endReply = await h.settleReply(SC.endEarlyStatement);
    const fabricated = /all (done|complete)|every (lift|exercise) (done|complete)|finished everything/i.test(endReply);
    // The card's honest exchange: the end-early statement draws the remaining-work
    // acknowledgment ("… Bicep Curl remains in the plan."), and the SAVE is then
    // staged by the plain finish word — the same lane every session uses. The
    // acknowledgment must name the unfinished lift rather than fabricate completion.
    h.beat('honest-remaining-work',
      !fabricated && SC.unfinishedLiftRegex.test(endReply),
      `end-early reply: "${endReply.slice(0, 160)}"`);
    return { logged, loggedSets, substitution: null };
  },

  // Session 5 — referent drift under the evening clock: the pressing exercise is
  // already COMPLETE, the fresh proposal targets Seated Row, and the prescription
  // answer must use the fresh proposal, never the completed press.
  async 5({ page, SC, h }) {
    h.setPhase('logging');
    let logged = 0;
    const loggedSets = [];
    for (const s of SC.preSubSets) { logged += 1; await h.logSet(s, logged); loggedSets.push(parseShorthand(s)); }
    const st = await planState(page);
    h.beat('seated-row-current-press-complete', /seated row/i.test(st.names[st.index] || ''),
      `current lift after the completed press: "${st.names[st.index] || ''}"`);

    h.setPhase('substitution_ask');
    await markBubblesSeen(page);   // the ask's own bubbles are the unmarked ones
    await h.say(SC.substitutionAsk);
    const sub = await assertStagedProposal(page, h, { sourceRegex: /seated row/i });
    h.beat('substitution-lane', /replace seated row with/i.test(sub.line), `proposal: "${sub.line.slice(0, 160)}"`);
    await h.snap('04-substitution-proposal.png');

    h.setPhase('prescription_question');
    const howMuch = await h.settleReply(SC.prescriptionAsk);
    // The F-SB2 drift probe proper: the completed press must not answer.
    assertGroundedPrescription(h, howMuch, sub, 'seated row', SC.driftRegex);
    h.beat('no-referent-drift-to-completed-press', !SC.driftRegex.test(howMuch), `reply: "${howMuch.slice(0, 160)}"`);
    await h.snap('05-how-much.png');

    h.setPhase('replacement');
    await page.locator('#thread-messages .replacement-approve-btn').last().click();
    await expect.poll(async () => (await planState(page)).names.some(n => /seated row/i.test(n)), { timeout: 20000 }).toBe(false);
    await h.markMutation();
    const shorthand = `${sub.name.toLowerCase()} ${sub.weight} x ${sub.reps} @2`;
    logged += 1; await h.logSet(shorthand, logged); loggedSets.push({ ...parseShorthand(shorthand), sub: true });
    logged += 1; await h.logSet(shorthand, logged); loggedSets.push({ ...parseShorthand(shorthand), sub: true });

    h.setPhase('eligible_question');
    const open = await h.settleReply('anything I should watch for training this late in the evening?');
    h.note('open-turn', `reply length ${open.length}`);

    h.setPhase('logging_tail');
    for (const s of SC.finishingSets) { logged += 1; await h.logSet(s, logged); loggedSets.push(parseShorthand(s)); }
    await h.snap('06-workout-logged.png');
    return { logged, loggedSets, substitution: { ...sub, sourceLift: 'SR01', sourceName: 'Seated Row', sourceRegex: /seated row/i } };
  },
};

// ── cross-session teardown and inheritance (F-SB4 card; owner P1 2026-08-03) ────
// The card requires Session 2 to prove stale/superseded/cross-session proposal state
// cannot participate, and Session 4 to prove the next session cannot inherit logs,
// proposal, or pending state. Neither was exercised: each scenario ended at its own
// scorecard and the process was torn down, and a FRESH PROCESS proves harness
// isolation, not product teardown.
//
// This proves the product's own teardown, in the SAME browser context, and performs NO
// second workout write: the durable write already happened, and the transition below is
// a reload plus one non-writing conversational turn.
//
// It adds NO scorecard. Every result routes through the existing state-agreement
// (condition 10) and declared-conversation (condition 8) evidence.
async function proveTeardownAndNoInheritance(page, h, { base }) {
  const SNAPSHOT_KEY = 'atlas_session_snapshot_v1';   // src/app/store.js

  // 1. The live store and the persisted snapshot, immediately after closeout.
  const afterCloseout = await page.evaluate((key) => {
    let snap = null;
    try { const raw = localStorage.getItem(key); snap = raw ? JSON.parse(raw) : null; } catch { snap = 'unreadable'; }
    return {
      log: window.getSessionLog ? window.getSessionLog().length : -1,
      completed: window.getSessionCompleted ? (window.getSessionCompleted() || []).length : -1,
      plan: window.getActivePlannedSession ? Boolean(window.getActivePlannedSession()) : null,
      writeIdentity: window.atlasCurrentWriteIdentity ? window.atlasCurrentWriteIdentity() : null,
      snapshot: snap,
    };
  }, SNAPSHOT_KEY);
  const snapAfter = afterCloseout.snapshot;
  const snapshotCarriesSession = Boolean(snapAfter && snapAfter !== 'unreadable'
    && ((Array.isArray(snapAfter.sessionLog) && snapAfter.sessionLog.length)
      || snapAfter.activePlannedSession || snapAfter.pendingReplacement || snapAfter.pendingSetRevision));
  h.stateCheck('closeout-clears-live-store',
    afterCloseout.log === 0 && afterCloseout.completed === 0 && afterCloseout.plan === false,
    `after closeout: ${afterCloseout.log} logged sets, ${afterCloseout.completed} completed, plan ${afterCloseout.plan ? 'still active' : 'cleared'}`);
  h.stateCheck('closeout-clears-persisted-snapshot', !snapshotCarriesSession,
    snapshotCarriesSession
      ? `the persisted snapshot still carries ${(snapAfter.sessionLog || []).length} sets, plan ${Boolean(snapAfter.activePlannedSession)}, pendingReplacement ${Boolean(snapAfter.pendingReplacement)}, pendingSetRevision ${Boolean(snapAfter.pendingSetRevision)}`
      : 'the persisted snapshot carries no logs, plan, or pending state');

  // 2. ONE bounded fresh-session transition in the SAME browser context. A reload is
  //    the product's real next-session entry point and writes nothing.
  //
  //    The reload restarts bubble indexing at 0. The finished session's evidence was
  //    already snapshotted in 13a, so the collector is reset here — otherwise a fresh
  //    bubble would overwrite the record of a completed-session bubble at the same
  //    index and corrupt the very evidence this proof is meant to leave intact.
  bubbleRecords = {};
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');

  const inherited = await page.evaluate((key) => {
    let snap = null;
    try { const raw = localStorage.getItem(key); snap = raw ? JSON.parse(raw) : null; } catch { snap = 'unreadable'; }
    const thread = document.getElementById('thread-messages');
    return {
      log: window.getSessionLog ? window.getSessionLog().length : -1,
      completed: window.getSessionCompleted ? (window.getSessionCompleted() || []).length : -1,
      plan: window.getActivePlannedSession ? Boolean(window.getActivePlannedSession()) : null,
      sessionIdField: (document.getElementById('log-session-id') || {}).value || '',
      writeIdentity: window.atlasCurrentWriteIdentity ? window.atlasCurrentWriteIdentity() : null,
      proposalControls: thread ? thread.querySelectorAll('.replacement-approve-btn').length : -1,
      proposalLines: thread ? thread.querySelectorAll('.replacement-proposal-line').length : -1,
      openReviewCards: thread ? thread.querySelectorAll('.review:not(.done)').length : -1,
      closeoutCards: document.querySelectorAll('.closeout-confirm').length,
      snapshotPendingReplacement: Boolean(snap && snap !== 'unreadable' && snap.pendingReplacement),
      snapshotPendingSetRevision: Boolean(snap && snap !== 'unreadable' && snap.pendingSetRevision),
    };
  }, SNAPSHOT_KEY);

  // 3. Nothing from the finished session may participate in the fresh one.
  const checks = [
    ['no-inherited-logs', inherited.log === 0, `${inherited.log} logged sets carried into the fresh session`],
    ['no-inherited-completed-state', inherited.completed === 0, `${inherited.completed} completed entries carried over`],
    ['no-inherited-plan', inherited.plan === false, `an active plan ${inherited.plan ? 'was' : 'was not'} inherited`],
    ['no-inherited-workout-identity', inherited.sessionIdField === '', `#log-session-id reads "${inherited.sessionIdField}"`],
    ['no-inherited-write-correlation', inherited.writeIdentity === null, `undo/write identity ${inherited.writeIdentity ? 'survived the transition' : 'did not survive'}`],
    ['no-inherited-pending-replacement', inherited.snapshotPendingReplacement === false && inherited.proposalControls === 0,
      `${inherited.proposalControls} approve control(s), snapshot pendingReplacement ${inherited.snapshotPendingReplacement}`],
    ['no-inherited-pending-set-revision', inherited.snapshotPendingSetRevision === false,
      `snapshot pendingSetRevision ${inherited.snapshotPendingSetRevision}`],
    ['no-inherited-proposal-state', inherited.proposalLines === 0, `${inherited.proposalLines} proposal line(s) rendered in the fresh thread`],
    ['no-inherited-preview-state', inherited.openReviewCards === 0 && inherited.closeoutCards === 0,
      `${inherited.openReviewCards} open review card(s), ${inherited.closeoutCards} closeout card(s)`],
  ];
  for (const [id, ok, detail] of checks) h.stateCheck(id, ok, detail);

  // 4. A single non-writing conversational turn, to prove the fresh session's own
  //    coaching path does not resurrect the finished session's work. It never saves.
  const opener = await settleReply(page, 'what should I train today?');
  h.beat('fresh-session-conversation-is-clean', opener.length > 0,
    `fresh-session opening reply (${opener.length} chars) — no workout write performed in this transition`);
  h.note('teardown', `fresh-session transition complete: ${checks.filter(c => c[1]).length}/${checks.length} inheritance checks clean`);
}

let child = null;
let base = null;
let stateBase = null;
let artDir = null;
let serverStdout = '';
const timeline = [];
const note = (step, detail) => timeline.push({ at: new Date().toISOString(), step, detail });

async function readJson(url, what) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url);
      const body = await res.json().catch(() => null);
      if (!res.ok) { const e = new Error(`HTTP ${res.status}${body && body.error ? ` — ${body.error}` : ''}`); e.status = res.status; throw e; }
      if (body && body.error) throw new Error(String(body.error));
      return body;
    } catch (error) {
      lastError = error;
      if (error.status === 403 || error.status === 400 || error.status === 409) throw error; // refusals are answers, not transients
      const quota = /quota/i.test(String(error && error.message));
      await new Promise(r => setTimeout(r, quota ? 30000 : 1000 * attempt));
    }
  }
  throw new Error(`rehearsal: ${what} failed after 4 attempts — ${lastError && lastError.message}`);
}

const serverState = () => readJson(`${stateBase}/`, 'harness state read');
const durableRows = (sessionId) => readJson(`${stateBase}/durable-rows?session_id=${encodeURIComponent(sessionId)}`, 'durable row read');
const snap = async (page, name) => page.screenshot({ path: path.join(artDir, name), fullPage: true });

// The session-start boundary is crossed at the FIRST composer submission, recorded
// BEFORE the click so a submission that dies is still a submission. The marker is
// READ BACK through the canonical reader before the click and every identity field
// must match THIS run exactly — path existence is not evidence: an empty, partial,
// malformed, stale, or foreign-run marker exists and would permit submission while
// later reading as NOT STARTED, skipping a streak reset the counting rule requires
// (Codex P2, PR #1252; read-back hardening per owner instruction 2026-08-03).
let sessionStartMarked = false;
async function say(page, text) {
  await page.locator('#workout-text').fill(text);
  if (!sessionStartMarked) {
    const boundary = { run_id: RUN_ID, purpose: RUN_PURPOSE, rehearsal_session_number: SESSION_NUMBER, source_sha: SOURCE.head_sha };
    markRunStarted(artDir, boundary);
    const verified = verifyRunStartMarker(artDir, boundary);
    if (!verified.ok) {
      throw new Error(`rehearsal: refusing to submit the first athlete turn — ${verified.reason}`);
    }
    sessionStartMarked = true;
    note('session-start', 'BOUNDARY CROSSED — first synthetic athlete turn submitted (marker verified by read-back)');
  }
  await page.locator('#preview-btn').click();
  note('say', text);
  // P1-4: a turn that does not go through settleReply (the substitution ask, the
  // unavailability statement, a logged set) still renders Atlas bubbles, and any
  // completed-mutation claim in them must reach the sweep.
  await sweepAtlasBubbles(page);
}

const loggedCount = (page) => page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : -1));
async function logSet(page, text, expectAfter) {
  await say(page, text);
  await expect.poll(() => loggedCount(page), { timeout: 30000 }).toBe(expectAfter);
}

// ── Reply settlement (F-SB4B corrective, owner instruction 2026-08-03) ───────────
// THE DEFECT THIS REPLACES. The previous probe read the WHOLE thread's innerText and
// sliced the new content off by byte offset: `now.slice(before.length)`. That is only
// valid while every character before the new reply is immutable, and in this client it
// is not — `appendAtlasBubble` calls `hideHomeEmpty()`, the 'Thinking…' placeholder is
// replaced by '' before `typeOut` starts, and `innerText` is layout-derived, so text
// EARLIER in the thread can shrink. When the prefix shrinks, `slice(before.length)`
// overshoots into the middle of the reply and returns its tail. That is exactly the
// Session 2 capture of "ve." — a trailing fragment of a reply the server had served in
// full (the coach-turn shadow recorded message_len 167 and 321 on those turns).
//
// The replacement never slices. It selects the ONE new Atlas bubble this turn created
// and reads that element's own text, so nothing before it can shift the reading.
//
// COMPLETION, not brief stability. Text that has stopped changing for 750 ms is not
// proof that rendering FINISHED — `typeOut` renders character by character, so any
// pause inside it looks identical to the end. Settlement therefore prefers an
// AUTHORITATIVE completion signal: the reply the server actually served for this turn,
// captured from the network. The bubble is settled when it contains that whole served
// message. Stability alone is the fallback for a turn that legitimately serves no
// message (a deterministic/outage reply), and the settlement MODE is recorded so
// evidence never conflates "proven complete" with "looked quiet for a moment".
//
// Timeouts are UNCHANGED and no retry is added: hiding provider latency behind a longer
// wait would convert a real product problem into a slow green. What changes is that a
// timeout now reports WHY — still thinking, still typing, or served-but-unrendered —
// so the next occurrence is diagnosable instead of opaque.
// The phase the run is currently in, shared with the module-level helpers so a captured
// message can be attributed to the beat that produced it.
const currentPhaseRef = { value: 'setup' };
// P1-5: coach responses whose body could not be parsed into a message. A settle that
// cannot see the served reply must FAIL CLOSED rather than fall back on stability —
// treating unreadable capture as "no message was served" reopens the partial-render
// false green precisely when the authoritative signal is missing.
const coachCaptureFailures = { count: 0 };
// EVERY Atlas bubble this run rendered, as a per-element LIFECYCLE record.
//
// The earlier sweep recorded each index once and advanced past it. `say()` sweeps
// immediately after submitting, so a bubble created asynchronously was routinely
// captured while it still read `Thinking…`; when that element later became the real
// reply, every later sweep SKIPPED it, and the final visible message never entered the
// claim record at all (owner P1, 2026-08-03). Records are now re-read on every sweep:
// the phase is bound at first observation — the turn that created the bubble — while
// the text and timestamp track the FINAL rendered state.
let bubbleRecords = {};
// A Node-side counter incremented on every ingest, so a boundary can record where in the
// report stream it was taken. That is what distinguishes "reported later because it
// happened later" from "reported later because the flush was still pending".
let bubbleIngestSeq = 0;

// The page REPORTS its own text changes (see rehearsal-bubble-observer.js). Node stamps
// each report on receipt, so the timestamp is on the same clock as `saveResponses` and
// cannot be assigned retroactively by a later sweep.
function onBubblesObserved(batch) {
  const now = Date.now();
  for (const item of (Array.isArray(batch) ? batch : [])) {
    bubbleIngestSeq += 1;
    ingestLiveObservation(bubbleRecords, item, {
      phase: currentPhaseRef.value, nowMs: now, ingestSeq: bubbleIngestSeq, thinkingMarker: THINKING,
    });
  }
}

// A boundary READS the page's logical clock at its OWN instant. That value — not a
// wall-clock time and not a drain certificate taken elsewhere — is what orders a DOM
// change against the boundary. A drain is attempted first purely to reduce pending
// work, and its success must be PROVEN by the postcondition the flush returns: a
// missing function, a rejected callback, or an unverified state leaves `drained:false`
// (owner P1, 2026-08-03). Ordering never depends on it.
async function takeBoundary(page) {
  let drained = false;
  let atChangeSeq = null;
  try {
    const flushed = await page.evaluate(() => (typeof window.__atlasBubbleFlush === 'function'
      ? window.__atlasBubbleFlush() : null));
    drained = Boolean(flushed && flushed.ok === true && flushed.pending === false);
  } catch { drained = false; }
  try {
    const state = await page.evaluate(() => (typeof window.__atlasBubbleState === 'function'
      ? window.__atlasBubbleState() : null));
    if (state && Number.isFinite(state.changeSeq)) atChangeSeq = state.changeSeq;
  } catch { atChangeSeq = null; }
  return makeBoundary({ atMs: Date.now(), atChangeSeq, ingestSeq: bubbleIngestSeq, drained });
}

// The logical clock AT THE INSTANT a live write response is observed. Read inside the
// response listener so the boundary carries evidence valid at its own moment, instead of
// borrowing a certificate from the pre-click drain.
let liveWriteChangeSeq = null;

// A RECONCILER, not the collector. It can fill in a bubble the observer never reported,
// and such a record is marked retroactive so the claim decisions fail closed on it. It
// never improves a live timestamp.
// It DRAINS FIRST, and reads the collector's own state at the same instant it reads the
// text (F-SB4B corrective 4). Sweeping without a drain made the sweep race the flush it
// is supposed to reconcile: `say()` sweeps the moment it submits, so a change the
// observer had already seen was swept before its report landed and the record was marked
// `retroactive` forever — the live report that followed could not clear a mark on text
// the sweep had itself written. Session 1 lost seven messages to that race.
//
// The drain and both reads happen in ONE page evaluation, so `quiet` describes the very
// instant the texts were taken rather than some earlier moment. A drain that cannot
// prove its postcondition, a collector that still holds an undelivered change, or a
// missing flush hook all yield `quiet:false`, and the reducer then declines to downgrade
// an existing live record while still filling in any bubble it has never seen.
async function sweepAtlasBubbles(page) {
  const swept = await page.evaluate(async () => {
    let flushed = null;
    try {
      flushed = typeof window.__atlasBubbleFlush === 'function' ? await window.__atlasBubbleFlush() : null;
    } catch { flushed = null; }
    // Read the text SYNCHRONOUSLY after the flush resolves, then the collector's state,
    // so `pending` and the text describe the same instant.
    const texts = Array.from(document.querySelectorAll('#thread-messages .chat-bubble-atlas'))
      .map(e => String(e.innerText || ''));
    let state = null;
    try {
      state = typeof window.__atlasBubbleState === 'function' ? window.__atlasBubbleState() : null;
    } catch { state = null; }
    return {
      texts,
      quiet: Boolean(flushed && flushed.ok === true) && Boolean(state) && state.pending === false,
    };
  }).catch(() => ({ texts: [], quiet: false }));
  reconcileSweep(bubbleRecords, swept.texts, {
    phase: currentPhaseRef.value, nowMs: Date.now(), thinkingMarker: THINKING,
    collectorQuiet: swept.quiet,
  });
  if (!swept.quiet) note('sweep', `collector not quiet at sweep — existing live records left for their pending reports (${swept.texts.length} bubble(s))`);
  return swept.texts.length;
}
const THINKING = 'Thinking…';
const SETTLE_TIMEOUT_MS = 90000;
const STABLE_MS = 750;

// Server-served coach replies for this run, in arrival order. Filled by the response
// listener installed in the test. Only the LENGTH and a normalized copy are used for
// matching; nothing here reaches an artifact.
const servedReplies = [];
// EVERY visible Atlas message this run settled, with the phase it landed in and when.
// This is the CLAIM SWEEP's input: condition 9 used to trust a literal `false`, so the
// sweep must now be a real observation (owner P1, 2026-08-03). Phase and timestamp come
// from the harness, so a claim can be placed relative to the actual mutation.
// Derived from bubbleRecords at read time — see sweepAtlasBubbles.
// The boundary at which the plan mutation actually became true, taken by the driver at
// the moment the source lift leaves the plan — after an awaited observer drain. null
// until then, and null for a scenario with no substitution, both of which make ANY
// completed-mutation claim unsupported.
let mutationBoundary = null;
const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

// Mark every bubble that exists NOW, so the turn's own bubbles are exactly the unmarked
// ones afterwards. Returns the marked count purely so the caller can prove the mark took.
// See rehearsal-bubble-observer.js for why counting and indexing are both unsafe here.
async function markBubblesSeen(page) {
  return page.evaluate(markExistingBubblesScript, SEEN_ATTR);
}

async function settleReply(page, question) {
  const newBubbles = page.locator(NEW_BUBBLE_SELECTOR);
  const servedBefore = servedReplies.length;
  const captureFailuresBefore = coachCaptureFailures.count;

  // Precondition, asserted rather than assumed: nothing is unmarked before the turn, so
  // anything unmarked afterwards was produced BY this turn.
  await markBubblesSeen(page);
  const strays = await newBubbles.count();
  if (strays !== 0) {
    throw new Error(`rehearsal: ${strays} bubble(s) were unmarked before the turn — the turn's own reply could not be identified`);
  }

  await say(page, question);

  // 1. THE turn's own bubble, by IDENTITY. The thread evicts its oldest bubble past
  // MAX_BUBBLES, so a count can stay flat while the reply renders, and an index can
  // address a different turn's bubble entirely.
  await expect.poll(() => newBubbles.count(), { timeout: SETTLE_TIMEOUT_MS, intervals: [250] })
    .toBeGreaterThan(0);
  const mine = newBubbles.first();

  // 2. Settle it.
  let settled = '';
  let mode = null;
  let stableSince = null;
  let lastSeen = null;
  let lastDiagnosis = 'no observation yet';
  const DIAGNOSIS = {
    thinking: 'the bubble still showed Thinking… — the request had not returned',
    empty: 'the bubble was empty — rendering had not begun',
    growing: 'the bubble text was still growing — typeOut had not finished',
    'partial-render': 'the bubble stopped changing while still shorter than the reply the server served — a partial render, not a settled one (this is the "ve." class)',
    'capture-failed': 'a coach response for this turn could not be parsed, so the served reply is unknown; settlement fails closed rather than trusting quiet',
  };
  try {
    await expect.poll(async () => {
      const text = norm(await mine.innerText().catch(() => ''));
      if (text !== lastSeen) { lastSeen = text; stableSince = Date.now(); }
      // The DECISION is the scorecard module's pure, unit-bitten function; this poll
      // only OBSERVES. One authority for what "settled" means.
      const outcome = classifySettlement({
        text,
        servedMessages: servedReplies.slice(servedBefore),
        stableForMs: stableSince === null ? 0 : Date.now() - stableSince,
        stableThresholdMs: STABLE_MS,
        thinkingMarker: THINKING,
        // P1-5: an unreadable coach response during THIS turn must not be mistaken for
        // a path that genuinely serves no message.
        captureFailed: coachCaptureFailures.count > captureFailuresBefore,
      });
      if (isSettled(outcome)) { settled = text; mode = outcome; return true; }
      lastDiagnosis = DIAGNOSIS[outcome] || `settlement refused (${outcome})`;
      return false;
    }, { timeout: SETTLE_TIMEOUT_MS, intervals: [250] }).toBe(true);
  } catch (e) {
    throw new Error(`rehearsal: reply never settled for "${String(question).slice(0, 60)}" after ${SETTLE_TIMEOUT_MS / 1000}s — ${lastDiagnosis}`);
  }
  note('settle', `mode=${mode} chars=${settled.length}`);
  await sweepAtlasBubbles(page);   // P1-4: every bubble, by element identity
  return settled;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test.describe.configure({ mode: 'serial' });

// The default credential-free lane collects this file but must never run it: without
// the operator command's envelope the spec SKIPS — no hook runs, no server spawns, the
// lane stays green and write-free. Only `npm run atlas:rehearsal-session` sets the flag.
test.skip(process.env.ATLAS_REHEARSAL_RUN !== '1',
  'rehearsal sessions run only through `npm run atlas:rehearsal-session -- --session=N --model-up`');

// A clock-declaring scenario (Session 5) runs the BROWSER in its declared timezone;
// the fake clock itself installs per-page before the first navigation.
const DECLARED_CLOCK = (SCENARIOS[SESSION_NUMBER] || {}).clock || null;
if (DECLARED_CLOCK) test.use({ timezoneId: DECLARED_CLOCK.timezoneId });

// The controlled local-evening instant: today's date IN THE TARGET ZONE at the
// declared local hour — an instant whose UTC calendar date is the following day.
function eveningInstant(tz, hour, minute) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const probe = new Date(`${today}T12:00:00Z`);
  const zonedHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(probe));
  const offsetHours = 12 - zonedHour; // e.g. PDT: 12Z renders as 05 → offset 7
  return new Date(Date.parse(`${today}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`) + offsetHours * 3600000);
}

test.beforeAll(async () => {
  if (!RUN_ID || !ATHLETE_ID || !ARTIFACT_DIR) {
    throw new Error('rehearsal: run it through `npm run atlas:rehearsal-session` — the run/athlete ids and artifact dir are minted there, never here.');
  }
  if (!SCENARIOS[SESSION_NUMBER]) {
    throw new Error(`rehearsal: session ${SESSION_NUMBER} has no declared scenario yet — scenarios are declared before their first run, never improvised.`);
  }
  artDir = ARTIFACT_DIR;
  fs.mkdirSync(artDir, { recursive: true });

  // The child environment is CONSTRUCTED, never inherited (`...process.env` absent).
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    ...pickNetworkPassthrough(),
    ATLAS_GATE_KEY: GATE_KEY,
    // The combined rehearsal posture, EXPLICIT — the recorded design. Inheritance can
    // never reach this file (playwright.config.js scrubs the live flag), so these two
    // lines are the only way this server goes live, and they only exist here.
    ATLAS_GATE_SANDBOX_LIVE: '1',
    ATLAS_GATE_LEDGER_SANDBOX: '1',
    ATLAS_GATE_MODEL_UP: '1',
    // The canonical trace + turn-write-proof formats. Log-only: no Sheet, no new tab.
    ATLAS_INTERACTION_TRACE: 'shadow',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
  if (process.env.GEMINI_COACH_MODEL) childEnv.GEMINI_COACH_MODEL = process.env.GEMINI_COACH_MODEL;
  assertNoWorkbookId(childEnv);

  child = spawn(process.execPath, [path.join(__dirname, 'gate-server.js')],
    { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gate-server did not report its ports within ${GATE_STARTUP_TIMEOUT_MS / 1000}s`)), GATE_STARTUP_TIMEOUT_MS);
    let stderr = '';
    child.stdout.on('data', d => {
      serverStdout += String(d);
      const app = serverStdout.match(/GATE_PORT=(\d+)/);
      const st = serverStdout.match(/GATE_STATE_PORT=(\d+)/);
      if (app && st) { clearTimeout(timer); resolve({ app: app[1], state: st[1] }); }
    });
    child.stderr.on('data', d => { stderr += String(d); process.stderr.write(`[gate-server] ${d}`); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`gate-server exited early (${code}): ${stderr.slice(-2000)}`)); });
  });
  base = `http://127.0.0.1:${ports.app}`;
  stateBase = `http://127.0.0.1:${ports.state}`;
  note('boot', `combined rehearsal posture up; workbook last6 ${SANDBOX_SPREADSHEET_ID_LAST6}`);
});

test.afterAll(async () => {
  // Always persist the server's own output — an aborted run's evidence matters MOST.
  try {
    if (artDir) {
      const redacted = serverStdout.split(SANDBOX_SPREADSHEET_ID).join(`…${SANDBOX_SPREADSHEET_ID_LAST6}`);
      fs.writeFileSync(path.join(artDir, 'server-log.txt'), redacted);
    }
  } catch { /* best-effort */ }
  if (child) child.kill('SIGTERM');
});

test('F-SB4B rehearsal session: one owner-pattern workout through the real browser to the sandbox', async ({ page }) => {
  test.setTimeout(1200000);
  const SC = SCENARIOS[SESSION_NUMBER];
  const beats = [];
  const beat = (id, ok, detail) => { beats.push({ id, ok: ok === true, detail: detail || '' }); note(`beat:${id}`, `${ok === true ? 'ok' : 'FAILED'} ${detail || ''}`); };
  const stateChecks = [];
  const stateCheck = (id, ok, detail) => stateChecks.push({ id, ok: ok === true, detail: detail || '' });

  // Coach-response capture for the live-provider proof (source === 'gemini' on the
  // eligible open turn is the only accepted marker).
  let currentPhase = 'setup';
  currentPhaseRef.value = 'setup';
  // Client-side failures are EVIDENCE: a swallowed render exception can silently
  // eat a closeout preview. Captured to the artifact dir, never inferred.
  const pageErrors = [];
  page.on('pageerror', (err) => { pageErrors.push(`[pageerror] ${err && err.message}\n${(err && err.stack || '').split('\n').slice(0, 6).join('\n')}`); });
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(`[console.error] ${msg.text().slice(0, 500)}`); });
  const coachResponses = [];
  // Save-route capture for the W1 proof fields: every preview runs test_mode:true and
  // must answer sheet_written:false + no_write_confirmed:true; the ONE live write
  // answers sheet_write:'success'. Observed from the real network, never inferred.
  // BOTH save routes are captured — the closeout may write through /api/log-workout
  // OR the transactional /api/complete-workout (state-dependent), and the latter
  // nests its body one level deeper; a capture that watched only one route scored
  // the write UNPROVEN on runs that took the other (found on live iteration 5).
  // A body that cannot be parsed is recorded as capture_failed — distinguishable
  // from "no request", and never counted as a proven write (fail-closed).
  const saveResponses = [];
  page.on('response', async (res) => {
    const phase = currentPhase;
    const url = res.url();
    if (/\/api\/(log-workout|complete-workout)\b/.test(url)) {
      const endpoint = url.includes('complete-workout') ? 'complete-workout' : 'log-workout';
      try {
        const body = await res.json();
        const layers = [body, body && body.data, body && body.data && body.data.data]
          .filter(l => l && typeof l === 'object');
        const data = layers.find(l => 'test_mode' in l || 'sheet_write' in l || 'sheet_written' in l) || null;
        const record = {
          phase,
          at: Date.now(),
          endpoint,
          status: res.status(),
          test_mode: data ? data.test_mode : undefined,
          sheet_written: data ? data.sheet_written : undefined,
          no_write_confirmed: data ? data.no_write_confirmed : undefined,
          sheet_write: data ? data.sheet_write : undefined,
          capture_failed: data ? false : true,
        };
        saveResponses.push(record);
        // THE WRITE BOUNDARY'S OWN INSTANT. Read the page's logical clock here, as the
        // successful live write is observed — not before the click and not after the
        // save settles. A certificate from either of those instants would be a
        // transplant (owner P1, 2026-08-03).
        if (record.capture_failed !== true && record.test_mode !== true
          && record.sheet_write === 'success' && liveWriteChangeSeq === null) {
          try {
            const st = await page.evaluate(() => (typeof window.__atlasBubbleState === 'function'
              ? window.__atlasBubbleState() : null));
            if (st && Number.isFinite(st.changeSeq)) liveWriteChangeSeq = st.changeSeq;
          } catch { liveWriteChangeSeq = null; }
        }
      } catch {
        saveResponses.push({ phase, at: Date.now(), endpoint, status: null, capture_failed: true });
      }
      return;
    }
    if (!/\/api\/coach\/(chat|ask|message)\b/.test(url)) return;
    // EVERY coach response is classified through the scorecard's pure, unit-bitten
    // function. An object-shaped body with no usable message — {source:'gemini'},
    // {message:null}, {message:''}, {message:123} — previously recorded neither a served
    // message nor a failure, so settlement granted stability and treated MISSING
    // evidence as proof the path served none (owner P1, 2026-08-03).
    let parsed = null;
    let parseFailed = false;
    try { parsed = await res.json(); } catch { parseFailed = true; }
    const data = (parsed && parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
    coachResponses.push({
      phase,
      source: data && typeof data.source === 'string' ? data.source : null,
      model: data && typeof data.model === 'string' ? data.model : null,
    });
    const capture = classifyCoachResponseCapture({ status: res.status(), body: parsed, parseFailed });
    if (capture.outcome === 'served') servedReplies.push(capture.message);
    else if (capture.outcome === 'capture-failed') {
      coachCaptureFailures.count += 1;
      note('coach-capture-failed', capture.reason);
    }
  });

  // ── 1. Open the real built client; prove no pre-seeded identity ───────────────
  if (SC.clock) {
    const t = eveningInstant(SC.clock.timezoneId, SC.clock.localEveningHour, SC.clock.localEveningMinute);
    await page.clock.install({ time: t });
    note('clock', `controlled ${SC.clock.timezoneId} evening installed: ${t.toISOString()}`);
  }
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  // The bubble-lifecycle observer, installed BEFORE any application script and on every
  // navigation (so the fresh-session transition is covered too). It reports changed
  // bubbles; Node stamps them on receipt.
  await page.exposeFunction('__atlasBubbleObserved', onBubblesObserved);
  await page.addInitScript(bubbleObserverInitScript, {
    flushMs: OBSERVER_FLUSH_MS,
    threadId: 'thread-messages',
    bubbleSelector: '.chat-bubble-atlas',
    callbackName: '__atlasBubbleObserved',
    flushName: '__atlasBubbleFlush',
    stateName: '__atlasBubbleState',
  });
  // The staged-proposal observer, installed on the same terms: before any application
  // script and on every navigation, so the ONE proposal each scenario stages is
  // recorded complete at the instant it is staged.
  await page.addInitScript(stagedProposalObserverScript, STAGED_PROPOSALS_KEY);
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');
  await snap(page, '01-client-open.png');
  // The shell tag is baked into the bundle and rendered into #shell-version at load
  // (app.js populateBuildInfo) — the DOM is the observable, not a window global.
  const shellBuild = await page.evaluate(() => (document.getElementById('shell-version')?.textContent || '').trim());
  const idBefore = await page.evaluate(() => document.getElementById('log-session-id').value);
  const preseedClean = idBefore === '';
  beat('no-preseeded-identity', preseedClean, `#log-session-id before acceptance: "${idBefore}"`);

  // ── 2. Accept the declared six-exercise plan through the ONE acceptance boundary ─
  currentPhase = 'acceptance';
  const started = await page.evaluate((plan) => window.atlasAcceptPlan({
    id: 'work_day', label: 'Work', why_today: 'F-SB4B rehearsal.', exercises: plan,
  }), SC.plan);
  beat('plan-accepted', Boolean(started && started.started), `atlasAcceptPlan started=${started && started.started}`);
  // The SERVER allocates the identity at acceptance; the client adopts it (PR #1246).
  let workoutId = '';
  await expect.poll(async () => {
    workoutId = await page.evaluate(() => document.getElementById('log-session-id').value.trim());
    return workoutId;
  }, { timeout: 30000 }).toMatch(/^\d{8}-(AM|PM)-\d{2}$/i);
  const planSessionId = await page.evaluate(() => (window.getActivePlannedSession() || {}).session_id || '');
  beat('server-allocated-identity-adopted', workoutId !== '' && planSessionId === workoutId,
    `adopted ${workoutId}; plan carries ${planSessionId}`);
  await expect(page.locator('#session-pin')).toBeVisible({ timeout: 20000 });
  await snap(page, '02-plan-accepted.png');

  // ── 3–8. The scenario's DECLARED conversation flow (per-session driver) ───────
  const h = {
    setPhase: (p) => { currentPhase = p; currentPhaseRef.value = p; },
    // Drained before stamping: any completed-mutation claim already visible is ingested
    // first, so it cannot be inverted across this boundary.
    markMutation: async () => { if (mutationBoundary === null) mutationBoundary = await takeBoundary(page); },
    beat, stateCheck, note,
    say: (t) => say(page, t),
    logSet: (t, n) => logSet(page, t, n),
    settleReply: (q) => settleReply(page, q),
    snap: (name) => snap(page, name),
    loggedCount: () => loggedCount(page),
  };
  const flow = await DRIVERS[SESSION_NUMBER]({ page, SC, h });
  const sub = flow.substitution; // null when the scenario declares no substitution
  const subName = sub ? sub.name : '';
  const subWeight = sub ? sub.weight : null;
  const subReps = sub ? sub.reps : null;

  // Pre-approval: the acceptance checkpoint has already durably recorded the PLAN
  // (plan_accepted + ledger v1 rows — an authorized write, PR #1246), so the identity
  // is readable. What must NOT exist before the visible approval is any LOG or EFFORT
  // row: the workout record itself.
  let preState = null;
  try { preState = await durableRows(workoutId); } catch (e) { preState = e.status === 403 ? { log_cleaned: { rows: [] }, effort: { rows: [] } } : null; }
  const noWorkoutRowsPreApproval = Boolean(preState)
    && preState.log_cleaned.rows.length === 0 && preState.effort.rows.length === 0;
  beat('no-write-before-approval', noWorkoutRowsPreApproval,
    preState ? `pre-approval durable state: ${preState.log_cleaned.rows.length} log, ${preState.effort.rows.length} effort rows` : 'pre-approval durable state unreadable');

  // ── 9. Effort (when declared), preview, ONE approval, the durable write ───────
  currentPhase = 'closeout';
  if (SC.effort) {
    await page.evaluate(e => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('effort-duration', e.duration); set('effort-active-cal', e.active); set('effort-total-cal', e.total);
      set('effort-avg-hr', e.avg); set('effort-peak-hr', e.peak);
    }, SC.effort);
  } else {
    beat('no-effort-supplied', true, 'no Apple Watch/effort data entered — absence must not fail the write (declared by the scenario)');
  }
  // A driver that already spoke the natural end-early statement (Session 4) has
  // initiated the closeout; saying "done" again would double-trigger it.
  if (!flow.closeoutInitiated) await say(page, 'done');
  try {
    await expect(page.locator('.closeout-confirm')).toHaveCount(1, { timeout: 60000 });
  } catch (err) {
    // Failure evidence: the exact rendered thread tail, preserved before rethrow.
    const tail = await page.locator('#thread-messages').innerText().catch(() => '(unreadable)');
    fs.writeFileSync(path.join(artDir, 'closeout-failure-thread.txt'), tail.slice(-4000));
    fs.writeFileSync(path.join(artDir, 'closeout-failure-pageerrors.txt'), pageErrors.join('\n\n') || '(no page errors captured)');
    const clientState = await page.evaluate(() => ({
      plan: (() => { const pl = window.getActivePlannedSession(); return pl ? { index: pl.index, accepted: pl.accepted, plan_version: pl.plan_version, session_id: pl.session_id, exercises: pl.exercises.map(e => ({ name: e.canonicalName || e.name, sets: e.sets, accepted_set_count: e.accepted_set_count })) } : null; })(),
      log: window.getSessionLog ? window.getSessionLog().map(x => ({ ex: x.exercise || x.name, w: x.weight, r: x.reps })) : null,
      completed: window.getSessionCompleted ? window.getSessionCompleted() : null,
      canonical: window.getCanonicalSession ? (() => { try { const c = window.getCanonicalSession(); return c ? { index: c.index, items: (c.exercises || []).map(e => ({ name: e.canonicalName || e.name })) } : null; } catch { return 'threw'; } })() : null,
    })).catch(() => null);
    fs.writeFileSync(path.join(artDir, 'closeout-failure-state.json'), JSON.stringify(clientState, null, 2));
    await snap(page, '07-closeout-failure.png');
    throw err;
  }
  const previewText = await page.locator('.closeout-confirm').innerText();
  if (sub) {
    const previewNamesSource = sub.sourceRegex.test(previewText);
    beat('preview-no-source-remains', !previewNamesSource || !/remain/i.test(previewText),
      previewNamesSource ? `preview mentions ${sub.sourceName} — checking it is not as remaining work` : `preview clean of ${sub.sourceName}`);
  } else {
    beat('preview-honest-incomplete', !/all (sets|lifts|exercises) (are )?(done|complete)|finished everything/i.test(previewText),
      `incomplete-session preview must not fabricate completion: "${previewText.slice(0, 160)}"`);
  }
  const saveControl = page.locator('.review:not(.done) .rv-save');
  await expect(saveControl).toBeVisible({ timeout: 40000 });
  await snap(page, '07-preview.png');
  // Drain before the click purely to shrink the pending set. It is NOT the write
  // boundary's evidence: that is read inside the response listener at the write's own
  // instant, because a drain certificate from this instant cannot be transplanted onto
  // a later one (owner P1, 2026-08-03).
  await takeBoundary(page);
  await saveControl.click();
  await expect(page.locator('.review.done')).toBeVisible({ timeout: 300000 });
  const savedLabel = await page.locator('.review.done .rv-saved-txt').innerText().catch(() => '');
  const stuckSaving = /saving…/i.test(savedLabel);
  await snap(page, '08-saved.png');

  // ── 10. Durable state, session-filtered ──────────────────────────────────────
  let d = null;
  await expect.poll(async () => {
    try { d = await durableRows(workoutId); } catch { return -1; }
    return d.log_cleaned.rows.length;
  }, { timeout: 240000, intervals: [8000, 12000, 15000, 20000] }).toBe(SC.expected.log_rows);

  // Repeat-approval probe with AFFIRMATIVE evidence, never a hardcoded flag (owner
  // P1, 2026-08-03): a disabled control's .click() can dispatch nothing, so "zero new
  // rows" alone may mean no second attempt ever happened. A one-shot listener proves
  // whether the click DISPATCHED; the save-route network capture proves whether the
  // write handler was INVOKED. The two honest outcomes:
  //   handler-invoked          — the click dispatched or a second live save request
  //                              was observed; the write path itself must dedup;
  //   refused-disabled-control — the control was disabled, provably dispatched
  //                              nothing, and issued no request: the approval gate
  //                              explicitly refusing the repeat.
  // Anything else is 'no-op-unproven' and the scorecard refuses it as evidence.
  // The repeat window counts EVERY save-route response (parsed or capture_failed):
  // any response during the probe proves the handler acted, even if its body was
  // unreadable — while a capture_failed entry can never prove write SUCCESS below.
  const liveWritesBefore = saveResponses.length;
  const repeatClick = await page.evaluate(() => {
    const b = document.getElementById('approve-btn');
    if (!b) return { control_present: false, disabled_at_click: null, dispatched: false };
    let dispatched = false;
    const seen = () => { dispatched = true; };
    b.addEventListener('click', seen, { once: true });
    const disabled = b.disabled === true;
    b.click();
    b.removeEventListener('click', seen);
    return { control_present: true, disabled_at_click: disabled, dispatched };
  });
  await page.waitForTimeout(2500);
  const liveWritesAfter = saveResponses.length;
  // Classification is the scorecard module's PURE, bitten function — a DOM dispatch
  // alone (the probe's own listener firing) is NOT application evidence: a
  // neutralized approval handler leaves the dispatch observable while nothing
  // happens, so the enabled path demands an OBSERVED second live save request
  // (owner contract review, PR #1254).
  const repeatOutcome = classifyRepeatApprovalProbe({
    control_present: repeatClick.control_present,
    disabled_at_click: repeatClick.disabled_at_click,
    dispatched: repeatClick.dispatched,
    live_saves_before: liveWritesBefore,
    live_saves_after: liveWritesAfter,
  });
  note('repeat-approval', `outcome=${repeatOutcome} (control=${repeatClick.control_present}, disabled=${repeatClick.disabled_at_click}, dispatched=${repeatClick.dispatched}, live saves ${liveWritesBefore}→${liveWritesAfter})`);
  // Zero additional durable rows across ALL FOUR tabs — a repeat that leaked a plan
  // or ledger row would hide behind a log/effort-only diff.
  const dRetry = await durableRows(workoutId);
  const dupRows = (dRetry.log_cleaned.rows.length - d.log_cleaned.rows.length)
    + (dRetry.effort.rows.length - d.effort.rows.length)
    + (dRetry.session_plans.rows.length - d.session_plans.rows.length)
    + (dRetry.session_plan_sets.rows.length - d.session_plan_sets.rows.length);
  d = dRetry;

  // Foreign-identity probe: the verifier must refuse an identity this process never wrote.
  let foreignStatus = 0;
  try { await durableRows('20260101-AM-01'); foreignStatus = 200; } catch (e) { foreignStatus = e.status || 0; }

  // ── 11. Weekly summary through the live app ──────────────────────────────────
  const weeklyRes = await fetch(`${base}/api/summary/weekly`, { headers: { 'x-atlas-api-key': GATE_KEY } });
  let weeklyBody = null; try { weeklyBody = await weeklyRes.json(); } catch { weeklyBody = null; }
  // A non-200 must preserve the exact served error (the F-SB4 card's "previously
  // observed 500" rule: preserve the exception, classify, never guess).
  const weeklyErrorDetail = weeklyRes.status === 200 ? '' : String((weeklyBody && (weeklyBody.error || weeklyBody.message)) || '(no error body)').slice(0, 300);

  // ── 12. Trace ↔ turn-write-proof join ────────────────────────────────────────
  const parseMarker = (marker) => serverStdout.split('\n').filter(l => l.includes(marker))
    .map(l => { try { return JSON.parse(l.slice(l.indexOf(marker) + marker.length).trim()); } catch { return null; } }).filter(Boolean);
  const traces = parseMarker('[interaction-trace]');
  const proofs = parseMarker('[turn-write-proof]');
  // The record's proof fields live under `proof` (services/turnCorrelation.js
  // buildWriteProofRecord); the live write carries sheet_write:'success' there.
  const liveProof = proofs.find(p => p && p.proof && p.proof.sheet_write === 'success') || proofs[proofs.length - 1] || null;
  const proofTurn = liveProof ? liveProof.turn_id : null;
  const joined = Boolean(proofTurn) && traces.some(t => t.turn_id === proofTurn);

  // ── 13. Review-tool adjudication against the SANDBOX (read-only) ─────────────
  await new Promise(r => setTimeout(r, 45000)); // the adjudicator reads 8 tabs right after the durable polls — give it its own quota window
  const review = spawnSync(process.execPath, ['scripts/atlas-review-live.js', '--json', `--workout-session=${workoutId}`], {
    cwd: path.join(__dirname, '..', '..', '..'),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      ...pickNetworkPassthrough(),
      GOOGLE_SHEETS_ID: SANDBOX_SPREADSHEET_ID, // the read-only adjudicator reads the SANDBOX for this run
      GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
    },
    encoding: 'utf8', timeout: 240000,
  });
  let reviewJson = null;
  try { reviewJson = JSON.parse(review.stdout.slice(review.stdout.indexOf('{'))); } catch { reviewJson = null; }
  const reviewCriteria = reviewJson && Array.isArray(reviewJson.criteria) ? reviewJson.criteria : [];
  const reviewFailed = reviewCriteria.filter(c => (c.verdict || c.status) === 'FAIL').map(c => c.id || c.name);
  // Credit is granted ONLY on a fully affirmative adjudication: process success,
  // overall PASS, nonempty criteria, and an unambiguous correlation naming exactly
  // this run's workout identity. An empty or partial-UNKNOWN result previously slipped
  // through as found_exact_session:true (Codex P1, PR #1252) — an UNKNOWN is never a
  // pass, and zero criteria is the all-UNKNOWN class, not a clean bill.
  const reviewAllUnknown = reviewCriteria.length === 0
    || (reviewJson && reviewJson.overall === 'UNKNOWN')
    || reviewCriteria.every(c => (c.verdict || c.status) === 'UNKNOWN');
  const reviewCorr = (reviewJson && reviewJson.log_correlation) || null;
  const reviewCorrIds = reviewCorr && Array.isArray(reviewCorr.distinct_session_ids)
    ? reviewCorr.distinct_session_ids.map(s => String(s).trim()) : [];
  const reviewFound = review.status === 0
    && Boolean(reviewJson)
    && reviewJson.overall === 'PASS'
    && reviewCriteria.length > 0
    && Boolean(reviewCorr)
    && reviewCorr.ambiguous !== true
    && reviewCorrIds.length > 0
    && reviewCorrIds.every(id => id === workoutId);
  // Session 5 (declared): a TEXT run and the --json run must state the same verdict.
  if (SC.reviewTextAgreement) {
    await new Promise(r => setTimeout(r, 45000)); // the adjudicator reads 8 tabs; give the text run its own quota window
    const textRun = spawnSync(process.execPath, ['scripts/atlas-review-live.js', `--workout-session=${workoutId}`], {
      cwd: path.join(__dirname, '..', '..', '..'),
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        ...pickNetworkPassthrough(),
        GOOGLE_SHEETS_ID: SANDBOX_SPREADSHEET_ID,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
      },
      encoding: 'utf8', timeout: 240000,
    });
    const overallLine = (textRun.stdout || '').split('\n').map(l => l.trim()).find(l => /^Overall:/.test(l)) || '';
    const textOverall = (overallLine.match(/\b(PASS|FAIL|UNKNOWN)\b/) || [])[1] || null;
    beat('review-text-json-agree', Boolean(reviewJson) && textOverall === reviewJson.overall,
      `text run says "${overallLine || '(no Overall line)'}" vs json overall ${reviewJson && reviewJson.overall}`);
  }

  // ── 13a. PRESERVE this session's visible evidence BEFORE any teardown ────────
  // The teardown below reloads the app, which destroys the completed workout's thread.
  // Deriving the write-claim verdict from the post-reload page would let an unsupported
  // save claim in the ORIGINAL thread vanish and condition 9 pass (owner P1,
  // 2026-08-03). Both claim verdicts are computed from evidence captured here; the
  // fresh session's thread is separate evidence and never a replacement carrier.
  // Drain, so the snapshot carries every report the page had pending.
  await takeBoundary(page);
  await sweepAtlasBubbles(page);
  const originalVisibleMessages = recordsToMessages(bubbleRecords);

  // ── 13b. Cross-session teardown and inheritance (declared scenarios only) ────
  // Runs AFTER every durable read AND after the evidence above is preserved, and
  // performs no second workout write.
  if (SC.proveTeardown) {
    currentPhase = 'teardown';
    await proveTeardownAndNoInheritance(page, h, { base });
  }

  // ── 14. Assemble observations for the frozen scorecard ───────────────────────
  const finalState = await serverState();
  const spIdx = { pv: sessionPlansColumns.indexOf('plan_version'), ev: sessionPlansColumns.indexOf('event_type') };
  const spsIdx = {
    item: sessionPlanSetsColumns.indexOf('plan_item_id'), seal: sessionPlanSetsColumns.indexOf('closeout_write_id'),
    count: sessionPlanSetsColumns.indexOf('target_set_count'), src: sessionPlanSetsColumns.indexOf('recommendation_source'),
  };
  const spRows = d.session_plans.rows;
  const eventCounts = {};
  for (const r of spRows) eventCounts[String(r[spIdx.ev] || '')] = (eventCounts[String(r[spIdx.ev] || '')] || 0) + 1;
  const spsRows = d.session_plan_sets.rows;
  const seals = [...new Set(spsRows.map(r => String(r[spsIdx.seal] || '').trim()))];
  const acceptedRows = spsRows.filter(r => String(r[spsIdx.src] || '') === 'accepted');
  const acceptedItems = [...new Set(acceptedRows.map(r => String(r[spsIdx.item] || '')))];
  // The accepted grain is the DECLARED PLAN's, per item. Each scenario used to repeat
  // the plan's item count and its one shared set count as a separate literal pair in
  // `expected`, which restated `SC.plan` in a second place, flattened every slot to a
  // single number, and could drift from the plan it was copied from. `SC.plan` is the
  // one authority, and matching each accepted item against ITS OWN declared count is
  // strictly stronger than matching every item against one literal (F-SB4B
  // corrective 3).
  const acceptedLiftIdx = sessionPlanSetsColumns.indexOf('planned_lift_code');
  const declaredSetCount = new Map(SC.plan.map(p => [String(p.lift_code).toUpperCase(), p.target_sets]));
  const grainOk = acceptedItems.length === SC.plan.length
    && acceptedRows.every((r) => {
      const want = declaredSetCount.get(String(r[acceptedLiftIdx] || '').trim().toUpperCase());
      return want != null && Number(r[spsIdx.count]) === want;
    });
  const logSidIdx = logCleanedColumns.indexOf('session_id');
  const effSidIdx = effortColumns.indexOf('session_id');
  const foreignRows = d.log_cleaned.rows.filter(r => String(r[logSidIdx]).trim() !== workoutId).length
    + d.effort.rows.filter(r => String(r[effSidIdx]).trim() !== workoutId).length
    + spRows.filter(r => String(r[sessionPlansColumns.indexOf('session_id')]).trim() !== workoutId).length
    + spsRows.filter(r => String(r[sessionPlanSetsColumns.indexOf('session_id')]).trim() !== workoutId).length;
  // The substituted outcome must BIND: one row, attached to the accepted SOURCE
  // slot's plan_item_id, planned=<source lift>, and a performed_lift_code that is a
  // real different lift — the same code the substitute's own Log_Cleaned rows carry.
  // A row that merely says outcome=substituted proves nothing about WHICH slot or
  // WHAT was performed (Codex P1, PR #1252). A scenario declaring NO substitution
  // (Session 4) must show ZERO substituted outcomes.
  const substitutedOutcomes = spRows.filter(r => String(r[spIdx.ev]) === 'item_outcome'
    && String(r[sessionPlansColumns.indexOf('outcome')] || '') === 'substituted');
  const spItemIdx = sessionPlansColumns.indexOf('plan_item_id');
  const spPlannedIdx = sessionPlansColumns.indexOf('planned_lift_code');
  const spPerformedIdx = sessionPlansColumns.indexOf('performed_lift_code');
  const spsPlannedIdx = sessionPlanSetsColumns.indexOf('planned_lift_code');
  const logExIdx = logCleanedColumns.indexOf('exercise');
  const logCanonIdx = logCleanedColumns.indexOf('canonical_exercise');
  const logLiftIdx = logCleanedColumns.indexOf('lift_code');
  const subNameLc = nameKey(subName);
  const nonSubDeclaredNames = new Set(flow.loggedSets.filter(x => !x.sub).map(x => x.name));
  const subLogRows = !sub ? [] : d.log_cleaned.rows.filter(r => {
    const names = [nameKey(r[logCanonIdx]), nameKey(r[logExIdx])];
    if (names.includes(subNameLc)) return true;
    return Number(r[logCleanedColumns.indexOf('weight')]) === subWeight
      && Number(r[logCleanedColumns.indexOf('reps')]) === subReps
      && !names.some(n => nonSubDeclaredNames.has(n));
  });
  const subLogLiftCodes = [...new Set(subLogRows.map(r => String(r[logLiftIdx] || '').trim().toUpperCase()).filter(Boolean))];
  if (sub) {
    const sourceItemIds = [...new Set(acceptedRows
      .filter(r => String(r[spsPlannedIdx] || '').trim().toUpperCase() === sub.sourceLift)
      .map(r => String(r[spsIdx.item] || '').trim()))];
    const oRow = substitutedOutcomes[0] || [];
    // IDENTITY, not agreement. Every durable surface is compared against the identity
    // captured from the accepted proposal BEFORE these rows were read, so a wrong lift
    // code repeated consistently across Log_Cleaned, the outcome and the ledger can no
    // longer satisfy itself (owner P1, 2026-08-03).
    const revLiftIdx = sessionPlanSetsColumns.indexOf('planned_lift_code');
    const revSrcIdx = sessionPlanSetsColumns.indexOf('recommendation_source');
    const revItemIdx = sessionPlanSetsColumns.indexOf('plan_item_id');
    const identityCmp = compareReplacementIdentity(
      {
        replacementLiftCode: sub.replacementLiftCode,
        sourceLiftCode: sub.sourceLift,
        // CAPTURED from the live plan before mutation — never `sourceItemIds`, which is
        // derived from the very accepted rows this comparison is checking (owner P1).
        sourcePlanItemId: sub.sourcePlanItemId,
      },
      {
        logLiftCodes: subLogLiftCodes,
        outcomePerformedLiftCode: String(oRow[spPerformedIdx] || '').trim(),
        outcomePlannedLiftCode: String(oRow[spPlannedIdx] || '').trim(),
        outcomePlanItemId: String(oRow[spItemIdx] || '').trim(),
        acceptedSourcePlanItemIds: sourceItemIds,
        ledgerRevisionLiftCodes: spsRows
          .filter(r => String(r[revSrcIdx] || '').trim() !== 'accepted')
          .map(r => String(r[revLiftIdx] || '').trim()),
        ledgerRevisionPlanItemIds: spsRows
          .filter(r => String(r[revSrcIdx] || '').trim() !== 'accepted')
          .map(r => String(r[revItemIdx] || '').trim()),
      },
    );
    const outcomeBound = substitutedOutcomes.length === 1 && identityCmp.ok;
    beat('one-substituted-outcome', outcomeBound,
      outcomeBound
        ? `one substituted item_outcome; every durable surface agrees with the identity captured before mutation (lift ${String(sub.replacementLiftCode).toUpperCase()}, slot ${sub.sourcePlanItemId})`
        : `${substitutedOutcomes.length} substituted item_outcome row(s); source slot ${sourceItemIds.join('/') || '(none)'}; ${identityCmp.problems.join('; ')}`);
  } else {
    beat('zero-substituted-outcomes', substitutedOutcomes.length === 0,
      `${substitutedOutcomes.length} substituted item_outcome row(s) for a scenario declaring none`);
  }
  // Session 5 (declared): under the controlled evening clock the browser's UTC
  // calendar date is the FOLLOWING day, while every durable row carries the
  // Pacific-LOCAL date — attribution stays exact regardless of the divergence.
  if (SC.clock) {
    const dates = await page.evaluate(() => {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      return {
        local: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        utc: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
      };
    });
    beat('evening-clock-utc-next-day', dates.utc > dates.local,
      `browser local ${dates.local} vs UTC ${dates.utc}`);
    const dateIdx = {
      log: logCleanedColumns.indexOf('date_clean'),
      sp: sessionPlansColumns.indexOf('session_date'),
      sps: sessionPlanSetsColumns.indexOf('session_date'),
    };
    const allRowDates = [
      ...d.log_cleaned.rows.map(r => String(r[dateIdx.log] || '').trim()),
      ...spRows.map(r => String(r[dateIdx.sp] || '').trim()),
      ...spsRows.map(r => String(r[dateIdx.sps] || '').trim()),
    ];
    beat('rows-carry-local-date', allRowDates.length > 0 && allRowDates.every(x => x === dates.local),
      `${allRowDates.length} dated rows; distinct [${[...new Set(allRowDates)].join(', ')}] vs local ${dates.local}`);
  }
  let eligible = coachResponses.filter(r => r.phase === 'eligible_question');
  let gemini = eligible.filter(r => r.source === 'gemini');
  if (gemini.length === 0) {
    // One bounded retry with a second genuine open question: a single turn can
    // legitimately resolve deterministically (or the provider can hiccup) without
    // the posture being down. The scorecard still requires a REAL gemini-tagged
    // turn — this only offers one more legitimate chance to observe it.
    currentPhase = 'eligible_question';
    await settleReply(page, 'one more thing — anything I should focus on for recovery tonight?');
    eligible = coachResponses.filter(r => r.phase === 'eligible_question');
    gemini = eligible.filter(r => r.source === 'gemini');
  }

  // The AUTHORITATIVE write boundary: when the one live write actually succeeded.
  const liveWriteBoundary = (() => {
    const live = saveResponses.filter(r => r.capture_failed !== true && r.test_mode !== true && r.sheet_write === 'success');
    if (!live.length) return null;
    // The response time AND the logical clock read at that same instant. When the clock
    // read failed, `atChangeSeq` is null and every collector claim at or after the write
    // is `uncertain` — fail closed, never a borrowed certificate.
    return makeBoundary({ atMs: live[0].at, atChangeSeq: liveWriteChangeSeq, drained: false });
  })();
  // THE CLAIM SWEEP — derived, never a constant. The previous value was a literal
  // `false` justified as "asserted per-beat pre-acceptance", but the per-beat checks
  // covered only selected phrases in selected phases, so condition 9 could not fail.
  // Now every visible message this run settled is swept against the completed-mutation
  // patterns and placed relative to the moment the mutation actually became true
  // (owner P1, 2026-08-03). It fails closed on missing messages or missing timing.
  const mutationSweep = detectUnsupportedMutationWording({ messages: originalVisibleMessages, mutationBoundary });
  // Prose is not a clock. The old verdict scanned the thread up to the first literal
  // "done", and Session 4 deliberately says "I'm done for today" BEFORE the save — so
  // every later pre-write message was discarded and an unsupported save claim in that
  // window vanished (owner P1, 2026-08-03). Write claims are now timed against the live
  // write itself, and fail closed without it.
  const writeSweep = detectUnsupportedWriteClaim({ messages: originalVisibleMessages, liveWriteBoundary });
  const claims = {
    unsupported_mutation_wording: mutationSweep.unsupported,
    unsupported_write_claim: writeSweep.unsupported,
    detail: [mutationSweep.detail, writeSweep.detail].filter(Boolean).join(' | '),
  };
  note('claim-sweep', `${originalVisibleMessages.length} visible messages; mutation ${mutationBoundary === null ? 'never' : `recorded (drained=${mutationBoundary.drained})`}; live write ${liveWriteBoundary === null ? 'NOT observed' : `observed (drained=${liveWriteBoundary.drained})`}; unsupported mutation=${mutationSweep.unsupported} write=${writeSweep.unsupported}; coach-capture failures ${coachCaptureFailures.count}`);

  const observations = {
    run_purpose: RUN_PURPOSE, session_number: SESSION_NUMBER, run_id: RUN_ID, athlete_id: ATHLETE_ID,
    workout_session_id: workoutId, workout_id_preseeded: !preseedClean,
    source: { ...SOURCE },
    model: {
      posture: /GATE_MODEL_POSTURE=model-up/.test(serverStdout) ? 'model-up' : 'model-down',
      provider_reachable: finalState.provider_reachable === true,
      coach_model: finalState.coach_model || '',
      live_provider_turn_observed: gemini.length > 0,
    },
    sandbox: {
      rehearsal_live: finalState.rehearsal_live === true,
      sandbox_last6: finalState.sandbox_last6 || '',
      declared_last6: SANDBOX_SPREADSHEET_ID_LAST6,
      preflight_ok: finalState.sandbox_preflight && finalState.sandbox_preflight.ok === true,
      preflight_checks: (finalState.sandbox_preflight && finalState.sandbox_preflight.checks) || [],
      child_carried_workbook_id: false, // assertNoWorkbookId threw otherwise, before boot
    },
    ui: { real_browser: true, shell_build: shellBuild },
    provenance: {
      request_origin: await page.evaluate(() => (navigator.webdriver === true ? 'playwright' : 'athlete_ui')),
      real_index_js: Boolean(finalState.ledger_sandbox !== undefined),
    },
    scenario: { id: SC.id, beats, expected: SC.expected },
    claims,
    state_agreement: stateChecks.concat([
      { id: 'adopted-id-everywhere', ok: planSessionId === workoutId, detail: `plan ${planSessionId} vs field ${workoutId}` },
    ]),
    durable: {
      session_plans: { event_counts: Object.entries(eventCounts).map(([event, count]) => ({ event, count })) },
      session_plan_sets: (() => {
        // The FULL scenario-declared ledger multiset (owner P1, 2026-08-03): accepted
        // v1 grain per item, the substitution revisions bound to the accepted Bench
        // slot carrying the replacement's own durable lift code, same-set supersession
        // keys, engine-validated chain, one seal, nothing extra. The replacement lift
        // code comes from the substitute's own Log_Cleaned rows — durable evidence,
        // never invented here.
        const cmp = compareLedgerToDeclaration(spsRows, {
          accepted: SC.plan.map(p => ({
            lift: p.lift_code, set_count: p.target_sets,
            weight: p.target_weight, reps: p.target_reps, rir: p.target_rir,
          })),
          revisions: !sub ? null : {
            source_lift: sub.sourceLift,
            // The captured proposal identity, NOT a code derived from the durable rows
            // this comparison is checking (owner P1, 2026-08-03).
            replacement_lift: String(sub.replacementLiftCode || '').toUpperCase(),
            rows: 2, set_indexes: [1, 2],
            source: 'live_revision', plan_version: 2,
            weight: subWeight, reps: subReps,
            rir: null, // asserted only when the proposal carries one; the engine's RIR is optional
          },
          // Every durable row — accepted and revision — must carry the contract's
          // reliable confidence; revision target_set_count is bound inside the
          // comparator to the immutable accepted grain (owner contract review, #1254).
          confidence: 'reliable',
        });
        return {
          row_count: spsRows.length, distinct_seals: seals.filter(s => s !== '').length,
          blank_seals: spsRows.filter(r => String(r[spsIdx.seal] || '').trim() === '').length,
          accepted_grain_ok: grainOk,
          grain_detail: `${acceptedItems.length} accepted items of ${SC.plan.length} declared; ${SC.plan.map((p) => {
            const got = [...new Set(acceptedRows
              .filter(r => String(r[acceptedLiftIdx] || '').trim().toUpperCase() === String(p.lift_code).toUpperCase())
              .map(r => String(r[spsIdx.count])))].join('/') || '(no rows)';
            return `${p.lift_code} declared ${p.target_sets} got ${got}`;
          }).join('; ')}`,
          declared_multiset_ok: cmp.ok,
          multiset_detail: cmp.ok ? '' : cmp.problems.slice(0, 6).join('; '),
        };
      })(),
      log_cleaned: (() => {
        // Content, not cardinality (Codex P1, PR #1252): every durable row must match a
        // declared set on lift name + weight + reps + RIR, one-for-one. The declared
        // multiset is exactly what the DRIVER logged — the scenario's shorthand plus
        // any substitute sets carrying the PROPOSAL's own numbers.
        const declaredSets = flow.loggedSets.map(x => ({ ...x }));
        const wIdx = logCleanedColumns.indexOf('weight');
        const rIdx = logCleanedColumns.indexOf('reps');
        const rirIdx = logCleanedColumns.indexOf('rir');
        const remaining = [...declaredSets];
        const unmatched = [];
        for (const row of d.log_cleaned.rows) {
          const names = [nameKey(row[logCanonIdx]), nameKey(row[logExIdx])];
          const i = remaining.findIndex(sSet => (sSet.sub
            ? !names.some(n => nonSubDeclaredNames.has(n))
            : names.includes(sSet.name))
            && Number(row[wIdx]) === sSet.weight && Number(row[rIdx]) === sSet.reps && Number(row[rirIdx]) === sSet.rir);
          if (i >= 0) remaining.splice(i, 1);
          else unmatched.push(`${names[0] || names[1]} ${row[wIdx]}x${row[rIdx]}@${row[rirIdx]}`);
        }
        const contentOk = d.log_cleaned.rows.length === SC.expected.log_rows
          && remaining.length === 0 && unmatched.length === 0;
        return {
          row_count: d.log_cleaned.rows.length,
          rows_match_declaration: contentOk,
          detail: contentOk
            ? `${d.log_cleaned.rows.length} rows, each matching a declared set on lift/weight/reps/RIR`
            : `undeclared rows: [${unmatched.join('; ') || 'none'}]; declared sets unmatched: ${remaining.length}`,
        };
      })(),
      effort: { row_count: d.effort.rows.length },
      foreign_rows: foreignRows,
      foreign_id_probe_status: foreignStatus,
    },
    write: (() => {
      // Proof classification uses PARSED responses only; a capture_failed entry can
      // never prove a preview or a successful write (fail-closed).
      const previews = saveResponses.filter(r => r.capture_failed !== true && r.test_mode === true);
      const lives = saveResponses.filter(r => r.capture_failed !== true && r.test_mode !== true);
      const lastPreview = previews[previews.length - 1] || null;
      const firstLive = lives[0] || null;
      return {
        preview_seen: previews.length > 0,
        preview_no_write_confirmed: Boolean(lastPreview
          && lastPreview.sheet_written === false && lastPreview.no_write_confirmed === true)
          && noWorkoutRowsPreApproval,
        preview_before_write: Boolean(lastPreview && firstLive && lastPreview.at < firstLive.at),
        approvals_clicked: 1,
        write_success: Boolean(firstLive && firstLive.sheet_write === 'success')
          && d.log_cleaned.rows.length === SC.expected.log_rows,
        repeat_attempted: repeatOutcome !== 'no-op-unproven',
        repeat_outcome: repeatOutcome,
        duplicate_rows: dupRows,
      };
    })(),
    closeout: {
      fully_verified: seals.filter(s => s !== '').length === 1
        && spsRows.every(r => String(r[spsIdx.seal] || '').trim() !== ''),
      ui_stuck_saving: stuckSaving, final_state_ok: savedLabel.trim().length > 0, detail: savedLabel.trim(),
    },
    trace: { join_ok: joined, turn_id: proofTurn, detail: `${traces.length} traces, ${proofs.length} proofs` },
    review: { found_exact_session: reviewFound, all_unknown: reviewAllUnknown, failed_criteria: reviewFailed },
    weekly: { status: weeklyRes.status, valid_body: Boolean(weeklyBody && typeof weeklyBody === 'object' && !weeklyBody.error), detail: weeklyErrorDetail },
    guard: {
      ensure_tab_calls: (finalState.ensure_tab_calls || []).length,
      refusals: (finalState.refusals || []).length,
      seal_updates: (finalState.updates || []).filter(u => u.live === true && !u.failed).length,
    },
    artifacts: { swept: false, leaks: [], files: [] },
  };

  // ── 15. Privacy sweep + hashes over REAL bytes, then score ───────────────────
  const forbidden = [
    { kind: 'workbook_id', re: new RegExp(SANDBOX_SPREADSHEET_ID, 'i') },
    { kind: 'private_key', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
    { kind: 'service_account_email', re: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? new RegExp(String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null },
    { kind: 'provider_key', re: process.env.GEMINI_API_KEY ? new RegExp(String(process.env.GEMINI_API_KEY).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null },
  ].filter(f => f.re);
  fs.writeFileSync(path.join(artDir, 'server-log.txt'),
    serverStdout.split(SANDBOX_SPREADSHEET_ID).join(`…${SANDBOX_SPREADSHEET_ID_LAST6}`));
  fs.writeFileSync(path.join(artDir, 'evidence.json'), JSON.stringify({
    run: { RUN_ID, ATHLETE_ID, SESSION_NUMBER, workout_session_id: workoutId },
    workbook_last6: SANDBOX_SPREADSHEET_ID_LAST6, timeline, observations,
  }, null, 2));
  const files = [];
  const leaks = [];
  for (const name of fs.readdirSync(artDir)) {
    const full = path.join(artDir, name);
    if (!fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    for (const f of forbidden) if (f.re.test(buf.toString('latin1'))) leaks.push(`${f.kind} in ${name}`);
    files.push({ name, sha256: sha256(buf), bytes: buf.length });
  }
  observations.artifacts = { swept: true, leaks, files };

  const scorecard = scoreRehearsalRun(observations);
  const scorecardJson = JSON.stringify(scorecard, null, 2);
  const scorecardMd = renderMarkdown(scorecard);
  for (const [label, text] of [['scorecard.json', scorecardJson], ['SCORECARD.md', scorecardMd]]) {
    const leak = forbidden.find(f => f.re.test(text));
    expect(leak, `${label} would publish a forbidden value (${leak && leak.kind})`).toBeUndefined();
  }
  fs.writeFileSync(path.join(artDir, 'scorecard.json'), scorecardJson);
  fs.writeFileSync(path.join(artDir, 'SCORECARD.md'), scorecardMd);

  const notPassing = scorecard.conditions.filter(c => c.status !== 'PASS');
  if (notPassing.length) {
    console.error('\n[rehearsal] conditions not passing:');
    for (const c of notPassing) console.error(`  ${c.status}  ${c.id} — ${c.detail}`);
  }
  expect(scorecard.overall, notPassing.map(c => `${c.id}=${c.status}`).join(', ') || 'see SCORECARD.md').toBe('PASS');
  if (RUN_PURPOSE === REHEARSAL_SESSION) {
    expect(scorecard.rehearsal_eligible, 'a passing rehearsal session must publish rehearsal_eligible=true').toBe(true);
  } else {
    expect(scorecard.rehearsal_eligible, 'a non-qualifying run must publish rehearsal_eligible=false').toBe(false);
  }
});
