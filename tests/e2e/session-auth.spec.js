const { test, expect } = require('@playwright/test');

// F04C server-authoritative auth — red-first browser tests (owner directive 2026-07-16).
// The old client GUESSED whether its HttpOnly cookie was valid (a synchronous localStorage
// flag), producing split-brain auth: Settings said "connected" while Coach said "Set your
// API key." These specs pin the server-authoritative contract:
//   • The client never pre-blocks a protected read on a synchronous flag.
//   • It attempts the request with the session cookie; the SERVER decides.
//   • "Connect Atlas in Settings" appears ONLY after a real 401 / a sessions-enabled status
//     reporting authenticated:false — never a "Set your API key" prompt.
//   • A status timeout / abort / network failure leaves the app optimistic (a connection
//     message at worst), never a key prompt.
//   • Settings and Coach never disagree — both derive from one server auth state.
//
// Each test is RED against the pre-redesign flag model (a cookie-only reopen showed
// "Set your API key", a status timeout logged the owner out) and GREEN after it.

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

// A plan with exercises so Coach's Pick renders the plan card on success.
const PLAN = {
  status: 'success',
  data: {
    todays_read: { recommended_label: 'Pull', recommended_reason: 'Back focus today.' },
    intents: [{
      label: 'Pull', focus: 'Rows', recommended: true,
      exercises: [
        { exercise: 'Seated Row', lift_code: 'ROW01', target_weight: 140, target_reps: 10, target_sets: 3, target_rir: 2 },
      ],
    }],
  },
};

// Boot the app with fully controllable server auth. `status` is the /api/session/status
// payload (data object). `statusDelayMs` delays that probe (>4000 exercises the 4s abort).
// `statusAbort` fails the probe outright. `protectedStatus` is the HTTP status every
// protected read returns (200 → PLAN; 401 → unauthorized). `seedKey` seeds a legacy key.
async function setup(page, opts = {}) {
  const {
    seedKey = false,
    status = null,
    statusDelayMs = 0,
    statusAbort = false,
    protectedStatus = 200,
  } = opts;

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  // Catch-all for protected reads. Registered FIRST so the specific status route below
  // (registered LAST) wins — Playwright matches last-registered-first.
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (protectedStatus === 401) return route.fulfill(json({ message: 'unauthorized' }, 401));
    if (path === '/api/plan/intent-recommendation') return route.fulfill(json(PLAN));
    if (path === '/api/coach/message') return route.fulfill(json({ status: 'success', data: { message: null, configured: false } }));
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  await page.route('**/api/session/status', async route => {
    if (statusAbort) return route.abort('failed');
    if (statusDelayMs) await new Promise(r => setTimeout(r, statusDelayMs));
    try { await route.fulfill(json({ status: 'success', data: status || {} })); } catch (_) { /* client aborted */ }
  });

  if (seedKey) await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), 'pw-key');
  await page.goto('/app/');
}

async function askCoach(page) {
  await page.locator('#workout-text').fill('What are we doing today?');
  await page.locator('#preview-btn').click();
}

// The plan card renders on a successful (authenticated) Coach's Pick; its exercise
// name is the visible proof the coach suggested a plan (the "Start this plan" button
// was retired — logging a set is now what accepts the plan).
const planCard = page => page.locator('#thread-messages .chat-bubble-atlas .workout-plan-name').first();

test('cookie-only reload (no local key) — Coach suggests, never prompts for a key', async ({ page }) => {
  // Valid cookie, NO localStorage key. Under the old flag model isConnected() was
  // false (no flag, empty key) → "Set your API key". Server-authoritative: the status
  // probe confirms authenticated → Coach reads the plan.
  await setup(page, { seedKey: false, status: { sessions_enabled: true, authenticated: true } });
  await askCoach(page);

  await expect(planCard(page)).toBeVisible();
  await expect(page.locator('#thread-messages')).not.toContainText('Set your API key');
  await expect(page.locator('#thread-messages')).not.toContainText('Connect Atlas');
  // Settings agrees — server-confirmed connected.
  await expect(page.locator('#settings-status')).toContainText('Atlas connected on this device.');
});

test('delayed session-status — a slow probe still resolves connected, no key prompt', async ({ page }) => {
  await setup(page, { seedKey: false, status: { sessions_enabled: true, authenticated: true }, statusDelayMs: 800 });
  await askCoach(page);

  await expect(planCard(page)).toBeVisible();
  await expect(page.locator('#thread-messages')).not.toContainText('Set your API key');
});

test('status timeout then a successful protected read — optimistic attempt suggests', async ({ page }) => {
  // The status probe aborts (never returns) → serverAuthState stays optimistic 'unknown'.
  // The reads must be ATTEMPTED anyway; the 200 confirms auth and Coach suggests. Old flag
  // model: a timed-out probe left the owner "not connected" → false key prompt.
  await setup(page, { seedKey: false, statusAbort: true, protectedStatus: 200 });
  await askCoach(page);

  await expect(planCard(page)).toBeVisible();
  await expect(page.locator('#thread-messages')).not.toContainText('Set your API key');
  await expect(page.locator('#thread-messages')).not.toContainText('Connect Atlas');
});

test('genuine 401 (sessions-enabled negative status) — prompts to Connect, not to set a key', async ({ page }) => {
  await setup(page, { seedKey: false, status: { sessions_enabled: true, authenticated: false }, protectedStatus: 401 });
  await askCoach(page);

  // Coach shows the connect prompt (from the server-confirmed negative), never a key prompt.
  await expect(page.locator('#thread-messages')).toContainText('Connect Atlas in Settings');
  await expect(page.locator('#thread-messages')).not.toContainText('Set your API key');
  // The dashboard's above-fold placeholder is the connect prompt too.
  await expect(page.locator('#todays-pick')).toContainText('Connect Atlas in Settings');
});

test('optimistic attempt that hits a real 401 — Coach catch shows Connect, not a key prompt', async ({ page }) => {
  // Status aborts (optimistic 'unknown'), so Coach ATTEMPTS the read — which 401s. The
  // catch must distinguish that real 401 and prompt to connect (directive #4).
  await setup(page, { seedKey: false, statusAbort: true, protectedStatus: 401 });
  await askCoach(page);

  await expect(page.locator('#thread-messages')).toContainText('Connect Atlas in Settings');
  await expect(page.locator('#thread-messages')).not.toContainText('Set your API key');
});

test('Settings and Coach never disagree — connected', async ({ page }) => {
  await setup(page, { seedKey: false, status: { sessions_enabled: true, authenticated: true } });
  await askCoach(page);

  await expect(page.locator('#settings-status')).toContainText('Atlas connected on this device.');
  await expect(page.locator('#settings-status')).not.toContainText('Connect Atlas');
  await expect(planCard(page)).toBeVisible();
  await expect(page.locator('#thread-messages')).not.toContainText('Set your API key');
});

test('Settings and Coach never disagree — disconnected', async ({ page }) => {
  await setup(page, { seedKey: false, status: { sessions_enabled: true, authenticated: false }, protectedStatus: 401 });
  await askCoach(page);

  // Both surfaces say "Connect Atlas"; neither says "Set your API key". They agree.
  await expect(page.locator('#settings-status')).toContainText('Connect Atlas');
  await expect(page.locator('#thread-messages')).toContainText('Connect Atlas in Settings');
  await expect(page.locator('#settings-status')).not.toContainText('Set your API key');
  await expect(page.locator('#thread-messages')).not.toContainText('Set your API key');
});
