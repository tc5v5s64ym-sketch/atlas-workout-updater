const { test, expect } = require('@playwright/test');

// PR-I reproduction — the canary found that the explicit Session_Plans capture
// lane never fires from the REAL primary Coach's Pick flow (unit/structural tests
// only proved the code EXISTS, never that acceptance is reachable and POSTs
// /api/session-plans/accept). After the composer-chat simplification the plan-card
// "Start this plan" button is retired; acceptance now fires when the first set is
// logged from the displayed pick. This browser-level spec drives the exact
// production entry point — "What are we doing today?" → log a set — and asserts the
// acceptance boundary is real.

const TEST_KEY = 'playwright-test-key';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

// Minimal mock surface for the Coach's Pick flow + the Session_Plans sidecar. Any
// POST to /api/session-plans/* is recorded so the test can prove (or disprove) that
// the acceptance boundary fired.
async function mockCoachPick(page, capture, opts = {}) {
  capture.sessionPlanPosts = capture.sessionPlanPosts || [];
  capture.intentCalls = 0;

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData() ? request.postDataJSON() : null;

    if (path.startsWith('/api/session-plans/')) {
      capture.sessionPlanPosts.push({ path, body });
      return route.fulfill(json({
        status: 'ok',
        data: { session_plans: { captured: true, status: 'written', written: (body && body.items ? body.items.length : 1) } }
      }));
    }

    if (path === '/api/plan/intent-recommendation') {
      capture.intentCalls++;
      // Simulate the dashboard's startup fetch returning NO pick (network hiccup /
      // cold engine) while the later Coach's Pick fetch succeeds: the acceptance gate
      // must accept the DISPLAYED pick, not the empty dashboard cache.
      if (opts.emptyFirstIntent && capture.intentCalls === 1) {
        return route.fulfill(json({ status: 'success', data: { todays_read: {}, intents: [] } }));
      }
      return route.fulfill(json({
        status: 'success',
        data: {
          todays_read: { recommended_label: 'Push', recommended_reason: 'Bench is ready for clean repeat work.' },
          intents: [
            {
              label: 'Push', focus: 'Bench + OHP', recommended: true,
              why_today: ['Pressing patterns are fresh'],
              exercises: [{ exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 225, target_reps: 5, target_sets: 3, target_rir: 2 }]
            }
          ]
        }
      }));
    }

    if (path === '/api/coach/message') {
      return route.fulfill(json({ status: 'success', data: { message: null, configured: false } }));
    }

    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function openApp(page, capture, opts = {}) {
  await mockCoachPick(page, capture, opts);
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
}

async function askCoachPick(page) {
  await page.locator('#workout-text').fill('What are we doing today?');
  await page.locator('#preview-btn').click();
}

test('primary Coach\'s Pick renders the plan card, display-only (no "Start this plan" button)', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await askCoachPick(page);

  const bubble = page.locator('#thread-messages .chat-bubble-atlas').first();
  await expect(bubble.locator('.workout-plan-name')).toHaveText('Bench Press');

  // The plan card is display-only now: no acceptance button renders, and merely
  // showing the pick never accepts (no /accept POST fires).
  await expect(bubble.locator('.start-this-plan-btn')).toHaveCount(0);
  expect(capture.sessionPlanPosts.filter(p => p.path === '/api/session-plans/accept')).toHaveLength(0);
});

test('logging a set from the Coach\'s Pick auto-accepts — POSTs /api/session-plans/accept with an accepted plan identity', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await askCoachPick(page);
  const bubble = page.locator('#thread-messages .chat-bubble-atlas').first();
  await expect(bubble.locator('.workout-plan-name')).toHaveText('Bench Press');

  // The acceptance boundary the canary flagged: merely RENDERING the Coach's Pick
  // card is not acceptance — no /accept POST fires until a set is logged from it.
  expect(capture.sessionPlanPosts.filter(p => p.path === '/api/session-plans/accept')).toHaveLength(0);

  // Logging the first set from the displayed pick silently accepts the plan.
  await page.locator('#workout-text').fill('Bench Press 225 5/2');
  await page.locator('#preview-btn').click();

  // It creates and persists the accepted plan identity via the server call.
  await expect.poll(() => capture.sessionPlanPosts.filter(p => p.path === '/api/session-plans/accept').length).toBeGreaterThan(0);

  const accept = capture.sessionPlanPosts.find(p => p.path === '/api/session-plans/accept');
  expect(accept.body.plan_version).toMatch(/^pv_/);
  expect(Array.isArray(accept.body.items)).toBe(true);
  expect(accept.body.items.length).toBeGreaterThan(0);
  expect(accept.body.items[0].plan_item_id).toMatch(/^pi_/);
  expect(accept.body.items[0].planned_lift_code).toBe('BEN01');
  // The removed authority stays removed: with no established identity the client
  // sends NO session_id — never a derived `${date}-{AM|PM}-01`. The server
  // allocates and its response names the identity.
  expect(accept.body.session_id).toBeUndefined();
});

test('auto-accept uses the DISPLAYED pick even when the dashboard intent cache was empty', async ({ page }) => {
  // Regression (Codex P1 on the button removal): the acceptance gate reads the
  // displayed plan from lastIntentData. The Coach's Pick fetch does not go through
  // loadDashboard, so if the dashboard's startup fetch returned no pick, logging must
  // STILL accept the displayed pick — never skip acceptance (train outside the ledger).
  const capture = {};
  await openApp(page, capture, { emptyFirstIntent: true });

  // Let the dashboard's startup intent fetch (the empty one) land first, so the coach
  // fetch below is deterministically the second call — the one that carries the pick.
  await expect.poll(() => capture.intentCalls).toBeGreaterThanOrEqual(1);

  await askCoachPick(page);
  const bubble = page.locator('#thread-messages .chat-bubble-atlas').first();
  await expect(bubble.locator('.workout-plan-name')).toHaveText('Bench Press');
  expect(capture.sessionPlanPosts.filter(p => p.path === '/api/session-plans/accept')).toHaveLength(0);

  // Logging the first set accepts the DISPLAYED pick — proving the gate's source was
  // synced to the coach's fetch, not left on the empty dashboard cache.
  await page.locator('#workout-text').fill('Bench Press 225 5/2');
  await page.locator('#preview-btn').click();

  await expect.poll(() => capture.sessionPlanPosts.filter(p => p.path === '/api/session-plans/accept').length).toBeGreaterThan(0);
  const accept = capture.sessionPlanPosts.find(p => p.path === '/api/session-plans/accept');
  expect(accept.body.items[0].planned_lift_code).toBe('BEN01');
});
