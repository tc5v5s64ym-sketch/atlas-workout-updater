const { test, expect } = require('@playwright/test');

// F-SB3 — SUBSTITUTION TRUTH (owner ruling 2026-08-02), the required regression proof:
// Dale's exact flow through the REAL browser path against the real built shell.
//
// Workout session 20260801-PM-01, Flight Recorder FR-20260802025836-l7hey0gz. The save
// itself was correct — 18 Log_Cleaned rows, closeout_fully_verified:true. What failed is
// that Atlas VISIBLY CLAIMED A SUBSTITUTION IT NEVER PERFORMED:
//
//   "Understood. You're substituting Bench Press with Incline Dumbbell Press."
//   "Okay, I've noted the substitution. Since you're opting for Incline Dumbbell Press,
//    what weight and reps were you planning for that?"
//
// The durable ledger disagreed on every point: 6 plan_accepted events and ZERO item_outcome
// events; no performed_lift_code of IDB01 anywhere; BEN01's Session_Plan_Sets prescription
// untouched; 3 performed IDB01 rows recorded as an INSERTED exercise. Bench Press stayed
// pending, the final preview still read "Still on your plan: Bench Press", and the closeout
// sealed over the contradiction.
//
// Two root causes, both proven here:
//   1. the turn never reached the substitution lane at all — `looksLikeSessionRequest`
//      claimed "The bench is taken at the gym so plan give me a substitute workout" on the
//      word "plan"; and
//   2. routing success is not mutation success. Even routed, the engine lanes recommended
//      WITHOUT a bounded proposal, so nothing could be accepted, answered, or recorded.
//
// This spec drives the whole A–E lifecycle end to end and asserts the ledger sidecar the
// coach prose is supposed to agree with.

// The route table, the acceptance boundary and the submit helper are the SHARED
// coach-lane plumbing (tests/e2e/support/coach-lane-harness.js) — this spec supplies
// only its own fixture, so the accepted-session shape has one home rather than one
// copy per spec.
const {
  installCoachLaneMocks, submit, acceptPlanByLogging, outcomePosts,
} = require('./support/coach-lane-harness');

const TEST_KEY = 'playwright-test-key';
const ROW_SETS = [{ weight: 200, reps: 10, rir: 1 }, { weight: 200, reps: 10, rir: 1 }];
const IDB_SETS = [{ weight: 90, reps: 10, rir: 2 }];

const FIXTURE = {
  plan: {
    label: 'Push', focus: 'Press + row', recommended_label: 'Push',
    recommended_reason: 'Press focus today.',
    exercises: [
      { exercise: 'Seated Row', lift_code: 'SR01', target_weight: 200, target_reps: 10, target_sets: 2, target_rir: 1 },
      { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185, target_reps: 8, target_sets: 2, target_rir: 2 },
    ],
  },
  catalog: [
    { canonical_name: 'Seated Row', lift_code: 'SR01' },
    { canonical_name: 'Bench Press', lift_code: 'BEN01' },
    { canonical_name: 'Incline Dumbbell Press', lift_code: 'IDB01' },
  ],
  // The DETERMINISTIC substitute recommender's answer. It owns the substitute AND its
  // prescription — the model owns neither.
  substitute: {
    recommendation: 'Incline Dumbbell Press', quality: 'excellent',
    reason: 'Same horizontal press pattern with dumbbells',
    next_target: { weight: 90, reps: 10, sets: 2, rir: 2 },
  },
  parses: [
    { match: /incline.*\d+\s*\/\s*\d+/i,
      parsed: { intent: 'log_sets', raw_name: 'incline db press', canonical_name: 'Incline Dumbbell Press', exercise: 'Incline Dumbbell Press', sets: IDB_SETS } },
    { match: /\d+\s*\/\s*\d+/,
      parsed: { intent: 'log_sets', raw_name: 'seated row', canonical_name: 'Seated Row', exercise: 'Seated Row', sets: ROW_SETS } },
  ],
  logPreview: [['2026-08-01', 'PW', 'Seated Row', 'Seated Row', 'Back', 'SR01', 1, 200, 10, 1, '', 2000]],
  chatMessage: "Understood. You're substituting Bench Press with Incline Dumbbell Press.",
};

async function mockApis(page, capture) {
  await installCoachLaneMocks(page, capture, FIXTURE);
}

const lastProposal = page => page.locator('#thread-messages .replacement-proposal-line').last();
const lastAtlas = page => page.locator('#thread-messages .chat-bubble-atlas').last();
const outcomes = capture => outcomePosts(capture);

async function acceptPlanByLoggingSeatedRow(page, capture) {
  const accept = await acceptPlanByLogging(page, capture, {
    ask: 'What are we doing today?', firstLiftName: 'Seated Row', firstSetText: 'seated row 200 10/1 x2',
  });
  const benchItem = accept.items.find(it => String(it.planned_lift_code).toUpperCase() === 'BEN01');
  expect(benchItem, 'the accepted plan carries Bench Press with an immutable item id').toBeTruthy();
  return benchItem.plan_item_id;
}

test("Dale's exact flow: the bench is taken → recommend → answer → accept by logging → one canonical substitution", async ({ page }) => {
  const capture = {};
  await mockApis(page, capture);
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), TEST_KEY);
  await page.goto('/app/');

  const benchItemId = await acceptPlanByLoggingSeatedRow(page, capture);
  const plansAfterAccept = capture.planRequests;

  // ── A. RECOMMENDATION ──────────────────────────────────────────────────────
  // The owner's verbatim turn. It was claimed by the generation classifier on the word
  // "plan", so he got today's plan read back at him instead of a bench alternative.
  await submit(page, 'The bench is taken at the gym so plan give me a substitute workout');

  // It reached the SUBSTITUTION lane — the deterministic recommender, about Bench Press.
  await expect.poll(() => capture.substituteCalls.length).toBe(1);
  expect(capture.substituteCalls[0].current_exercise).toBe('Bench Press');
  expect(capture.planRequests, 'never re-routed to session generation').toBe(plansAfterAccept);
  expect(capture.chatCalls, 'never leaked to the model').toHaveLength(0);

  // ONE coherent proposal carrying the ENGINE's prescription and the engine's reason.
  await expect(lastProposal(page)).toContainText('Replace Bench Press with Incline Dumbbell Press');
  await expect(lastProposal(page)).toContainText('90 lb');
  await expect(lastProposal(page)).toContainText('Same horizontal press pattern');

  // …and NO completed-mutation wording. These are the exact phrasings that beat the
  // server-side denylist on 2026-08-02.
  const afterProposal = await page.locator('#thread-messages').innerText();
  expect(afterProposal).not.toContain("I've noted the substitution");
  expect(afterProposal).not.toContain("You're substituting");
  expect(afterProposal).not.toMatch(/Swapped Bench Press|Replaced Bench Press/);

  // Requirement A: the plan is UNTOUCHED. Bench Press stays, and stays current.
  await expect(page.locator('#active-session-banner')).toContainText('Bench Press');
  expect(outcomes(capture), 'a recommendation writes no item_outcome').toHaveLength(0);

  // ── B. GROUNDED FOLLOW-UP (F-SB2, folded in) ───────────────────────────────
  // "Nice! How much should I lift?" reached /api/coach/chat with zero exercise identity on
  // 2026-08-02, so the model answered about Bench Press — a lift he had finished earlier.
  await submit(page, 'Nice! How much should I lift?');
  await expect(lastAtlas(page)).toContainText('Incline Dumbbell Press');
  await expect(lastAtlas(page)).toContainText('90');
  await expect(lastAtlas(page)).toContainText('not active yet');
  expect(capture.chatCalls, 'a numbers question is never handed to the model').toHaveLength(0);
  await expect(page.locator('#active-session-banner')).toContainText('Bench Press');

  // ── D. ACCEPTANCE BY LOGGING ───────────────────────────────────────────────
  // The owner's actual next action: he did the lift and logged it. On 2026-08-02 this
  // produced IDB01 INSERTED + BEN01 PENDING + a visible success claim.
  await submit(page, 'incline db press 90 10/2');

  // Exactly ONE canonical substitution outcome, binding IDB01 to the ORIGINAL BEN01 slot.
  await expect.poll(() => outcomes(capture).filter(p => p.body?.item?.outcome === 'substituted').length).toBe(1);
  const sub = outcomes(capture).find(p => p.body?.item?.outcome === 'substituted');
  expect(sub.body.item.plan_item_id, 'the ORIGINAL plan item is what was substituted').toBe(benchItemId);
  expect(String(sub.body.item.performed_lift_code).toUpperCase()).toBe('IDB01');

  // Bench Press leaves remaining work; the substitute satisfies its slot.
  const planNames = await page.evaluate(() => window.getActivePlannedSession().exercises.map(e => e.canonicalName || e.name));
  expect(planNames).toContain('Incline Dumbbell Press');
  expect(planNames).not.toContain('Bench Press');
  const remaining = await page.evaluate(() => window.remainingPlannedExercises && window.remainingPlannedExercises());
  if (remaining) expect(remaining).not.toContain('Bench Press');

  // ── the visible claim, at last ──────────────────────────────────────────────
  // The final preview must NOT read "Still on your plan: Bench Press" — the line the owner
  // actually saw while Atlas was telling him the swap had happened.
  await submit(page, 'log it');
  await expect(page.locator('#thread-messages')).toContainText('give it a look before it goes to your sheet');
  const closeoutThread = await page.locator('#thread-messages').innerText();
  expect(closeoutThread).not.toContain('Still on your plan: Bench Press');
  expect(capture.chatCalls, 'the whole substitution never touched the model').toHaveLength(0);
});

test('a recommendation the athlete never accepts leaves the plan and the ledger alone', async ({ page }) => {
  const capture = {};
  await mockApis(page, capture);
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), TEST_KEY);
  await page.goto('/app/');
  await acceptPlanByLoggingSeatedRow(page, capture);

  await submit(page, 'the bench is taken, I need a substitute');
  await expect(lastProposal(page)).toContainText('Replace Bench Press with Incline Dumbbell Press');

  // "Keep it" — the plan is left exactly as it was, and nothing was recorded.
  await page.locator('#thread-messages .replacement-reject-btn').last().click();
  await expect(lastAtlas(page)).toContainText('Kept Bench Press as-is');
  const planNames = await page.evaluate(() => window.getActivePlannedSession().exercises.map(e => e.canonicalName || e.name));
  expect(planNames).toContain('Bench Press');
  expect(planNames).not.toContain('Incline Dumbbell Press');
  expect(outcomes(capture)).toHaveLength(0);
});

test('an unrelated off-plan lift logged while a proposal is open stays an INSERTION', async ({ page }) => {
  const capture = {};
  await mockApis(page, capture);
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), TEST_KEY);
  await page.goto('/app/');
  await acceptPlanByLoggingSeatedRow(page, capture);

  await submit(page, 'the bench is taken, I need a substitute');
  await expect(lastProposal(page)).toContainText('Incline Dumbbell Press');

  // A different lift entirely — it must NOT silently satisfy the Bench Press slot.
  await submit(page, 'seated row 200 10/1 x2');
  await page.waitForTimeout(300);
  expect(outcomes(capture).filter(p => p.body?.item?.outcome === 'substituted')).toHaveLength(0);
  const planNames = await page.evaluate(() => window.getActivePlannedSession().exercises.map(e => e.canonicalName || e.name));
  expect(planNames).toContain('Bench Press');
});
