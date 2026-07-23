const { test, expect } = require('@playwright/test');

// Production trust failure FR-20260723031748-ux7ogmwp (deployed commit 523042e):
// during a live session the athlete typed a DIRECT replacement command —
//   "Let's remove back squats and change it out for bench press"
// — and Atlas split it into (1) an immediate one-sided SKIP of the source
// ("Skipped Back Squat. Next up: Romanian Deadlift.") and (2) unrelated free-form
// chat. The atomic intent "Replace Back Squat with Bench Press" was lost, and the
// follow-ups ("No let's do bench press", "what weight should I put on the bar")
// drew broad Bench Press benchmark challenges instead of resolving the swap.
//
// The fix treats an explicit replacement ATOMICALLY as ONE gated proposal:
//   • the source stays and the replacement is NOT active until approval;
//   • ONE coherent "Replace X with Y — <prescription>" proposal is presented;
//   • a weight question is answered from the proposal (proposed load, not active),
//     never a benchmark challenge and never an invented number;
//   • "No let's do bench press" APPROVES (it rejects Atlas's confusion, not the
//     bench); approval removes exactly the source and inserts exactly the
//     replacement in the same slot, once; reject leaves the plan unchanged.
//
// This browser spec drives the REAL UI end-to-end (proposal card + session state)
// and proves the coach chat endpoint is NEVER reached for the deterministic swap.

const TEST_KEY = 'playwright-test-key';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

async function mockLegDay(page, capture) {
  capture.chatCalls = capture.chatCalls || [];
  capture.recommendCalls = capture.recommendCalls || [];

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;

    if (path === '/api/plan/intent-recommendation') {
      return route.fulfill(json({
        status: 'success',
        data: {
          todays_read: { recommended_label: 'Legs', recommended_reason: 'Squat + hinge focus today.' },
          intents: [{
            label: 'Legs', focus: 'Squat + posterior chain', recommended: true,
            exercises: [
              { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 3, target_rir: 2 },
              { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 185, target_reps: 8, target_sets: 3, target_rir: 2 },
            ],
          }],
        },
      }));
    }

    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({
        status: 'success',
        data: { exercises: [
          { canonical_name: 'Back Squat', lift_code: 'SQ01' },
          { canonical_name: 'Bench Press', lift_code: 'BEN01' },
          { canonical_name: 'Romanian Deadlift', lift_code: 'RDL01' },
          { canonical_name: 'Leg Press', lift_code: 'LEP01' },
        ] },
      }));
    }

    // Read-only prescription source for the gated proposal. BEN01 = Bench Press, LEP01 = Leg
    // Press. The real route wraps next_target / target_rir in the standard { status, data }
    // envelope — mirror it exactly (a top-level next_target would hide the production read bug).
    if (path.startsWith('/api/recommend/next/')) {
      capture.recommendCalls.push(path);
      const weight = path.includes('LEP01') ? 260 : 175;
      return route.fulfill(json({ status: 'success', data: { next_target: { weight, reps: 9, sets: 3, rir: 2 }, target_rir: 2 } }));
    }

    // The coach chat lane must NEVER be reached for the deterministic swap or its
    // follow-ups — record any call so the test can prove the swap never leaked.
    if (path === '/api/coach/chat') {
      capture.chatCalls.push(route.request().postDataJSON());
      return route.fulfill(json({ status: 'success', data: { message: 'Why only 175 for bench?', configured: true } }));
    }
    if (path === '/api/coach/message') {
      return route.fulfill(json({ status: 'success', data: { message: null, configured: false } }));
    }
    if (path === '/api/parse-workout-text') {
      return route.fulfill(json({ status: 'success', data: { test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [], parsed: { intent: 'needs_clarification', message: 'Could not find sets.' } } }));
    }

    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function openApp(page, capture) {
  await mockLegDay(page, capture);
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
}

async function submit(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
}

async function engageLegDay(page) {
  await submit(page, 'What are we doing today?');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').first().locator('.workout-plan-name').first()).toHaveText('Back Squat');
}

const lastProposal = page => page.locator('#thread-messages .replacement-proposal-line').last();
const lastAtlas = page => page.locator('#thread-messages .chat-bubble-atlas').last();

test('the exact production sequence: a direct replacement stages ONE proposal, never a one-sided skip', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await engageLegDay(page);

  // The production repro, verbatim.
  await submit(page, "Let's remove back squats and change it out for bench press");

  // ONE coherent proposal — NOT "Skipped Back Squat", NOT a free-form challenge.
  await expect(lastProposal(page)).toContainText('Replace Back Squat with Bench Press');
  await expect(lastProposal(page)).toContainText('175 lb');              // read-only engine prescription
  const thread = await page.locator('#thread-messages').innerText();
  expect(thread).not.toContain('Skipped Back Squat');                    // never the one-sided skip
  expect(capture.chatCalls).toHaveLength(0);                             // never leaked to the coach

  // Pre-approval boundary: Back Squat is STILL the active slot; the replacement is not active.
  await expect(page.locator('#active-session-banner')).toContainText('Back Squat');

  // Follow-up "what weight should I put on the bar" → answered from the PROPOSAL
  // (proposed load, not-active, ask-approval), never a benchmark challenge / invented number.
  await submit(page, 'what weight should I put on the bar');
  await expect(lastAtlas(page)).toContainText('proposed replacement');
  await expect(lastAtlas(page)).toContainText('175');
  await expect(lastAtlas(page)).toContainText('not active yet');
  expect(capture.chatCalls).toHaveLength(0);
  // Still not applied — the source remains active until an explicit approval.
  await expect(page.locator('#active-session-banner')).toContainText('Back Squat');

  // "No let's do bench press" is an APPROVAL (it rejects Atlas's confusion, not the bench).
  await submit(page, "No let's do bench press");
  await expect(lastAtlas(page)).toContainText('Replaced Back Squat with Bench Press');
  await expect(page.locator('#active-session-banner')).toContainText('Bench Press');
  expect(capture.chatCalls).toHaveLength(0);
});

test('Approve button applies the swap exactly once (in-place, same position)', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await engageLegDay(page);

  await submit(page, 'swap back squats for bench press');
  await expect(lastProposal(page)).toContainText('Replace Back Squat with Bench Press');
  await expect(page.locator('#active-session-banner')).toContainText('Back Squat'); // not yet applied

  await page.locator('#thread-messages .replacement-approve-btn').last().click();
  await expect(lastAtlas(page)).toContainText('Replaced Back Squat with Bench Press');
  await expect(page.locator('#active-session-banner')).toContainText('Bench Press');

  // Idempotent: the Approve button is disabled after one tap, so a re-tap is a no-op.
  await expect(page.locator('#thread-messages .replacement-approve-btn').last()).toBeDisabled();
  expect(capture.chatCalls).toHaveLength(0);
});

test('a stale card whose proposal was superseded does NOT apply the newer swap (Codex P1)', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await engageLegDay(page);

  // Stage proposal A (Back Squat → Bench Press) — do NOT approve it.
  await submit(page, 'replace back squats with bench press');
  await expect(lastProposal(page)).toContainText('Replace Back Squat with Bench Press');

  // Stage proposal B (Romanian Deadlift → Leg Press). It supersedes A in the store, but card A
  // is still visible and enabled.
  await submit(page, 'replace romanian deadlift with leg press');
  await expect(lastProposal(page)).toContainText('Replace Romanian Deadlift with Leg Press');

  // Tap the STALE card A's Approve. It must be a no-op — it must NOT apply proposal B, and it
  // must NOT apply A either (A was superseded). The plan stays intact.
  const approves = page.locator('#thread-messages .replacement-approve-btn');
  await approves.nth(0).click(); // card A (the older, superseded one)
  await expect(page.locator('#active-session-banner')).toContainText('Back Squat'); // nothing swapped
  const threadAfterStale = await page.locator('#thread-messages').innerText();
  expect(threadAfterStale).not.toContain('Replaced Romanian Deadlift'); // card A never applied B
  expect(threadAfterStale).not.toContain('Replaced Back Squat');         // and never applied A

  // Tapping the LIVE card B applies exactly proposal B (RDL → Leg Press); Back Squat untouched.
  await approves.nth(1).click();
  await expect(lastAtlas(page)).toContainText('Replaced Romanian Deadlift with Leg Press');
  const finalPlan = await page.evaluate(() => window.getActivePlannedSession().exercises.map(e => e.canonicalName || e.name));
  expect(finalPlan).toContain('Back Squat');   // the superseded source is still present
  expect(finalPlan).toContain('Leg Press');    // B applied
  expect(finalPlan).not.toContain('Romanian Deadlift');
  expect(capture.chatCalls).toHaveLength(0);
});

test('Keep it (reject) leaves the plan exactly as it was — source stays, replacement never inserted', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await engageLegDay(page);

  await submit(page, 'replace back squats with bench press');
  await expect(lastProposal(page)).toContainText('Replace Back Squat with Bench Press');

  await page.locator('#thread-messages .replacement-reject-btn').last().click();
  await expect(lastAtlas(page)).toContainText('Kept Back Squat as-is');
  // The source is untouched; the replacement was never inserted.
  await expect(page.locator('#active-session-banner')).toContainText('Back Squat');
  const thread = await page.locator('#thread-messages').innerText();
  expect(thread).not.toContain('Replaced Back Squat');
  expect(capture.chatCalls).toHaveLength(0);
});
