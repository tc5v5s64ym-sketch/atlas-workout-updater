const { test, expect } = require('@playwright/test');

// PR-I2 reproduction — the primary Coach's Pick canary typed two explicit plan
// mutations that were WRONGLY intercepted by the coach lane:
//   "Swapping seated row for bent over row"  → hit the standing challenge reply
//   "I don't want to do leg extensions"      → produced a coach early-stop message
// Both must be handled DETERMINISTICALLY, never leaking to the coach chat endpoint.
//
// Production trust fix FR-20260723031748 refined the swap half: a NAMED replacement
// ("swap X for Y") is no longer an immediate in-place mutation — it stages ONE gated
// proposal (source stays, replacement not active) that the athlete approves before the
// plan changes. So the gerund-swap test now asserts the proposal card appears (still
// deterministic, still no chat call), the plan is untouched pre-approval, and Approve
// applies the swap. The explicit DECLINE half is a skip and stays immediate.

const TEST_KEY = 'playwright-test-key';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

async function mockPlanMutation(page, capture) {
  capture.chatCalls = capture.chatCalls || [];

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;

    if (path === '/api/plan/intent-recommendation') {
      return route.fulfill(json({
        status: 'success',
        data: {
          todays_read: { recommended_label: 'Pull', recommended_reason: 'Back and hinge focus today.' },
          intents: [{
            label: 'Pull', focus: 'Rows + posterior chain', recommended: true,
            exercises: [
              { exercise: 'Seated Row', lift_code: 'ROW01', target_weight: 140, target_reps: 10, target_sets: 3, target_rir: 2 },
              { exercise: 'Leg Extension', lift_code: 'LEX01', target_weight: 90, target_reps: 12, target_sets: 3, target_rir: 2 },
            ],
          }],
        },
      }));
    }

    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({
        status: 'success',
        data: { exercises: [
          { canonical_name: 'Seated Row', lift_code: 'ROW01' },
          { canonical_name: 'Bent Over Row', lift_code: 'ROW02' },
          { canonical_name: 'Leg Extension', lift_code: 'LEX01' },
        ] },
      }));
    }

    // Read-only prescription source for a gated replacement proposal (the swap's
    // authoritative target load). ROW02 = Bent Over Row.
    if (path.startsWith('/api/recommend/next/')) {
      return route.fulfill(json({ next_target: { weight: 135, reps: 10, sets: 3, rir: 2 }, target_rir: 2 }));
    }

    // The coach lanes must NOT be reached for a deterministic mutation. Record any
    // call so the test can prove the mutation never leaked to the coach.
    if (path === '/api/coach/chat') {
      capture.chatCalls.push(route.request().postDataJSON());
      return route.fulfill(json({ status: 'success', data: { message: "Let's keep pushing — you've got this.", configured: true } }));
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
  await mockPlanMutation(page, capture);
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
}

async function submit(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
}

test('a gerund swap ("Swapping X for Y") stages a GATED proposal — no chat, no mutation until Approve', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Engage Coach's Pick (sets the engaged suggestion so an explicit mutation has a
  // plan to act on — no "Start this plan" click needed, mirroring the canary flow).
  await submit(page, 'What are we doing today?');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').first().locator('.workout-plan-name').first()).toHaveText('Seated Row');

  await submit(page, 'Swapping seated row for bent over row');

  // Deterministic PROPOSAL in the thread (production trust fix FR-20260723031748):
  // one coherent "Replace Seated Row with Bent Over Row …" line — NOT a coach reply,
  // and NOT an immediate "Swapped" mutation.
  const proposal = page.locator('#thread-messages .replacement-proposal-line').last();
  await expect(proposal).toContainText('Replace Seated Row with Bent Over Row');
  await expect(proposal).toContainText('135 lb'); // the read-only engine prescription, not invented
  expect(capture.chatCalls).toHaveLength(0);

  // Pre-approval boundary: the source is STILL the active slot; nothing was swapped.
  await expect(page.locator('#active-session-banner')).toContainText('Seated Row');

  // Approve → the swap applies exactly once, and the banner re-points to the replacement.
  await page.locator('#thread-messages .replacement-approve-btn').last().click();
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('Replaced Seated Row with Bent Over Row');
  await expect(page.locator('#active-session-banner')).toContainText('Bent Over Row');
  expect(capture.chatCalls).toHaveLength(0);
});

test('an explicit decline ("I don\'t want to do leg extensions") deterministically skips the named slot', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await submit(page, 'What are we doing today?');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').first().locator('.workout-plan-name').first()).toHaveText('Seated Row');

  await submit(page, "I don't want to do leg extensions");

  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('Skipped');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('Leg Extension');
  expect(capture.chatCalls).toHaveLength(0);
});
