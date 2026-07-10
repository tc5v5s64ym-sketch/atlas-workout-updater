const { test, expect } = require('@playwright/test');

// PR-I2 reproduction — the primary Coach's Pick canary typed two explicit plan
// mutations that were WRONGLY intercepted by the coach lane:
//   "Swapping seated row for bent over row"  → hit the standing challenge reply
//   "I don't want to do leg extensions"      → produced a coach early-stop message
// Both should deterministically mutate the engaged plan (a gerund swap verb and an
// explicit decline of a NAMED exercise). This browser spec drives the real UI —
// engage Coach's Pick, then type each command — and asserts the plan mutates in
// the thread (a "Swapped …" / "Skipped …" narration) and that the coach chat
// endpoint is NEVER reached for these deterministic commands.

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

test('a gerund swap ("Swapping X for Y") deterministically substitutes the plan slot', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Engage Coach's Pick (sets the engaged suggestion so an explicit mutation has a
  // plan to act on — no "Start this plan" click needed, mirroring the canary flow).
  await submit(page, 'What are we doing today?');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').first().locator('.workout-plan-name').first()).toHaveText('Seated Row');

  await submit(page, 'Swapping seated row for bent over row');

  // Deterministic substitution narration in the thread — NOT a coach reply.
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('Swapped');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('Bent Over Row');
  // The active-session banner reflects the swapped current slot.
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
