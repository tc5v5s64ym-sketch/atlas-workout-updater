const { test, expect } = require('@playwright/test');

// PR-I (item 3) — the full Session_Plans client lifecycle, browser-level, against the
// real built shell (public/, byte-identical to the deployed production assets). Drives
// the exact owner canary: render Coach's Pick → Start this plan → log a set → Done with
// <exercise> → substitute one item → skip one item → End session, and asserts every
// sidecar call fires with a consistent session_id + plan_version and the expected
// immutable plan_item_id values. No real key, no writes (flag-independent — the mocked
// server records the payloads the client produces).

const TEST_KEY = 'playwright-test-key';
const SETS = [{ weight: 140, reps: 10, rir: 2 }, { weight: 140, reps: 10, rir: 2 }, { weight: 140, reps: 10, rir: 2 }];
// The identity the mocked server "allocates" for the acceptance — an arbitrary
// fixed value (no wall-clock dependency); the client must ADOPT it and address
// every later lifecycle call with it.
const ALLOCATED_SID = '20260612-PM-03';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

async function mockApis(page, capture) {
  capture.posts = capture.posts || [];
  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const m = req.method();
    const body = m === 'POST' && req.postData() ? req.postDataJSON() : null;

    if (path.startsWith('/api/session-plans/')) {
      capture.posts.push({ path, body });
      // The accept contract: the server allocates the session identity when the
      // client (correctly) sends none, and reports the identity it wrote under.
      const data = { session_plans: { captured: true, status: 'written' } };
      if (path === '/api/session-plans/accept') data.session_id = (body && body.session_id) || ALLOCATED_SID;
      return route.fulfill(json({ status: 'ok', data }));
    }
    if (path === '/api/plan/intent-recommendation') {
      return route.fulfill(json({ status: 'success', data: {
        todays_read: { recommended_label: 'Pull', recommended_reason: 'Full pull day.' },
        intents: [{ label: 'Pull', focus: 'Rows + posterior + press', recommended: true, why_today: ['Fresh'],
          exercises: [
            { exercise: 'Seated Row', lift_code: 'ROW01', target_weight: 140, target_reps: 10, target_sets: 3, target_rir: 2 },
            { exercise: 'Leg Extension', lift_code: 'LEX01', target_weight: 90, target_reps: 12, target_sets: 3, target_rir: 2 },
            { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 95, target_reps: 8, target_sets: 3, target_rir: 2 },
          ] }] } }));
    }
    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: [
        { canonical_name: 'Seated Row', lift_code: 'ROW01' },
        { canonical_name: 'Leg Extension', lift_code: 'LEX01' },
        { canonical_name: 'Overhead Press', lift_code: 'OHP01' },
        { canonical_name: 'Leg Press', lift_code: 'LEP01' },
      ] } }));
    }
    // Read-only prescription source for a gated replacement proposal (LEP01 = Leg Press).
    // The real route wraps next_target / target_rir in the standard { status, data } envelope.
    if (path.startsWith('/api/recommend/next/')) {
      return route.fulfill(json({ status: 'success', data: { next_target: { weight: 200, reps: 12, sets: 3, rir: 2 }, target_rir: 2 } }));
    }
    if (path === '/api/parse-workout-text') {
      // Only a slash-set log parses; swap/skip commands must FAIL parsing so the submit
      // handler routes them to the deterministic mutation lane (not log them as sets).
      const text = ((body && (body.text || body.workout_text)) || '');
      if (/\d+\s*\/\s*\d+/.test(text)) {
        return route.fulfill(json({ status: 'success', data: { test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
          parsed: { intent: 'log_sets', raw_name: 'seated row', canonical_name: 'Seated Row', exercise: 'Seated Row', sets: SETS } } }));
      }
      return route.fulfill(json({ status: 'success', data: { test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
        parsed: { intent: 'needs_clarification', message: 'no sets' } } }));
    }
    if (path === '/api/log-workout' && m === 'POST') {
      return route.fulfill(json({ status: 'success', data: { test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true,
        warnings: [], auto_matches: [], pending_exercises: [], rule_flags: [],
        log_rows_preview: SETS.map((s, i) => (['2026-06-12', 'PW', 'Seated Row', 'Seated Row', 'Back', 'ROW01', i + 1, s.weight, s.reps, s.rir, '', s.weight * s.reps])) } }));
    }
    if (path === '/api/coach/message') return route.fulfill(json({ status: 'success', data: { message: null, configured: false } }));
    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function submit(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
}

test('full Session_Plans lifecycle fires accept + completed/substituted/skipped outcomes + finalized closeout with one identity', async ({ page }) => {
  const capture = {};
  await mockApis(page, capture);
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), TEST_KEY);
  await page.goto('/app/');

  // 1) render Coach's Pick (display-only — no "Start this plan" button).
  await submit(page, 'What are we doing today?');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').first().locator('.workout-plan-name').first()).toBeVisible();

  // 2) log Seated Row — logging the first set from the displayed pick silently
  //    accepts the plan (minting identity), then commits the set.
  await submit(page, 'seated row 140 10/2 x3');
  await expect.poll(() => capture.posts.filter(p => p.path === '/api/session-plans/accept').length).toBeGreaterThan(0);
  const accept = capture.posts.find(p => p.path === '/api/session-plans/accept').body;
  const [A, B, C] = accept.items.map(it => it.plan_item_id); // Seated Row, Leg Extension, Overhead Press
  // No established identity exists at acceptance, so the client sends NO session_id
  // (the old client-minted `${date}-{AM|PM}-01` here is the removed authority) and
  // must ADOPT the server-allocated identity for the whole lifecycle.
  expect(accept.session_id).toBeUndefined();
  const SID = ALLOCATED_SID, PV = accept.plan_version;
  expect(PV).toMatch(/^pv_/); for (const id of [A, B, C]) expect(id).toMatch(/^pi_/);
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();

  // then tap "Done with Seated Row" (mid-plan completed boundary).
  await page.locator('#session-pin').click();
  const done = page.locator('#active-session-banner .start-done-btn');
  await expect(done).toHaveText('Done with Seated Row');
  await done.click();

  // 3) substitute Leg Extension → Leg Press. A NAMED replacement is now a GATED proposal
  //    (production trust fix FR-20260723031748): typing the swap stages ONE proposal — the
  //    plan is NOT mutated until the athlete approves — so the substituted outcome fires on
  //    APPROVAL, not on the command. Approve the proposal, then wait for the outcome (each
  //    mutation is a fire-and-forget sidecar; sequencing the waits keeps the flow deterministic).
  await submit(page, 'swap leg extension for leg press');
  await expect(page.locator('#thread-messages .replacement-proposal-line').last()).toContainText('Leg Press');
  await page.locator('#thread-messages .replacement-approve-btn').last().click();
  await expect.poll(() => capture.posts.filter(p => p.path === '/api/session-plans/outcome' && p.body?.item?.outcome === 'substituted').length).toBeGreaterThan(0);
  // 4) skip Overhead Press — wait for the skipped outcome.
  await submit(page, 'skip overhead press');
  await expect.poll(() => capture.posts.filter(p => p.path === '/api/session-plans/outcome' && p.body?.item?.outcome === 'skipped').length).toBeGreaterThan(0);

  // 5) End session (finalized closeout) via the banner (stays expanded).
  await expect(page.locator('#active-session-banner')).toBeVisible();
  await page.locator('#active-session-banner').getByText('End session', { exact: true }).click();

  // Assert every lifecycle call fired with a consistent identity.
  const byKind = (path, pred) => (capture.posts.find(p => p.path === path && (!pred || pred(p.body))) || {}).body;
  await expect.poll(() => capture.posts.filter(p => p.path === '/api/session-plans/closeout').length).toBeGreaterThan(0);

  const completed = byKind('/api/session-plans/outcome', b => b.item?.outcome === 'completed');
  const substituted = byKind('/api/session-plans/outcome', b => b.item?.outcome === 'substituted');
  const skipped = byKind('/api/session-plans/outcome', b => b.item?.outcome === 'skipped');
  const closeout = byKind('/api/session-plans/closeout', b => b.closeout_status === 'finalized');

  expect(completed, 'completed outcome fired').toBeTruthy();
  expect(substituted, 'substituted outcome fired').toBeTruthy();
  expect(skipped, 'skipped outcome fired').toBeTruthy();
  expect(closeout, 'finalized closeout fired').toBeTruthy();

  // Identity: the right plan_item_id per outcome.
  expect(completed.item.plan_item_id).toBe(A);
  expect(substituted.item.plan_item_id).toBe(B);
  expect(substituted.item.performed_lift_code).toBe('LEP01');
  expect(skipped.item.plan_item_id).toBe(C);

  // One session identity across the whole lifecycle.
  for (const b of [completed, substituted, skipped, closeout]) {
    expect(b.session_id).toBe(SID);
    expect(b.plan_version).toBe(PV);
  }
});
