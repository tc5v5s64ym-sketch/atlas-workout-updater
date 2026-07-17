const { test, expect } = require('@playwright/test');

// F09B / FR-REPLAY-1 — the client Flight Recorder must capture the owner-visible replay
// (what the athlete TYPED, what Atlas SHOWED, and the PENDING state at each step) for a
// COOKIE-authenticated owner. Production v141 recorded ONLY server api_response rows because
// the client recorder gated activation on a raw localStorage `atlas_api_key` that the F04C
// cookie migration had already REMOVED — so it never activated, and the server rows had no
// client-session / seq / device linkage (requestHeaders() returns {} while inactive).
//
// RED before the fix: cookie-only (no localStorage key) → recorder inert → zero /api/flight/
// ingest calls and no x-atlas-flight-session header on app calls. GREEN after: the recorder
// authenticates the enabled-check via the session cookie, activates, captures the client
// events, and stamps every app /api call with the flight-session headers.

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

// Boot the app as a cookie-authenticated owner with NO localStorage key (the production
// state post-F04C). `flightEnabled` drives the /api/flight/recent flag; `authenticated`
// drives the session-status probe.
async function setup(page, capture, opts = {}) {
  const { flightEnabled = true, authenticated = true } = opts;
  capture.ingests = [];
  capture.appHeaders = [];
  capture.writes = [];

  await page.route('**/health', r => r.fulfill(json({ status: 'ok' })));

  // Catch-all for the app flow. Registered FIRST so the specific routes below (registered
  // LAST) win — Playwright matches last-registered-first. Records headers so we can prove
  // the flight-session linkage rides on a real app call.
  await page.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    capture.appHeaders.push({ path, headers: req.headers() });
    const body = method === 'POST' && req.postData() ? req.postDataJSON() : null;

    if (path === '/api/parse-workout-text') {
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
          parsed: { intent: 'log_sets', raw_name: 'bench', canonical_name: 'Bench Press', exercise: 'Bench Press', sets: [{ weight: 225, reps: 5, rir: 2 }] },
        },
      }));
    }
    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        const preview = (body.log_rows || []).map(r => [r.date_clean || '2026-06-12', r.session_id || 'PW', r.exercise, r.exercise, 'Chest', 'BEN01', r.set_number, r.weight, r.reps, r.rir, r.notes, '']);
        return route.fulfill(json({ status: 'success', data: { test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true, warnings: [], auto_matches: [], pending_exercises: [], rule_flags: [], log_rows_preview: preview } }));
      }
      capture.writes.push(body);
      return route.fulfill(json({ status: 'success', data: { sheet_write: 'success', sheet_written: true, log_rows_written: (body.log_rows || []).length, logAppendedRange: 'Log_Cleaned!A200:L202' } }));
    }
    if (path === '/api/log-workout/verify-range') return route.fulfill(json({ status: 'success', data: { verified: true } }));
    if (path === '/api/catalog/exercises') return route.fulfill(json({ status: 'success', data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] } }));
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  // Flight endpoints (registered AFTER the catch-all so they win).
  await page.route('**/api/flight/recent', r => r.fulfill(json({ status: 'success', data: { enabled: flightEnabled === true, entries: [] } })));
  await page.route('**/api/flight/ingest', route => {
    let body = null;
    try { body = route.request().postDataJSON(); } catch (_) { body = null; }
    capture.ingests.push(body);
    return route.fulfill(json({ status: 'success', data: { enabled: true, written: (body && body.events || []).length } }));
  });

  // Cookie-authenticated owner, sessions enabled.
  await page.route('**/api/session/status', r => r.fulfill(json({ status: 'success', data: { sessions_enabled: true, authenticated: authenticated === true } })));

  // NO seedKey — the raw key is gone after the F04C migration.
  await page.goto('/app/');
}

async function logSet(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
}

// Force the tail flush the way the browser does on backgrounding/unload.
async function flush(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
}

function allEvents(capture) {
  return capture.ingests.filter(Boolean).flatMap(b => (b && Array.isArray(b.events)) ? b.events : []);
}

test('cookie-only owner + flag ON → client replay is captured with real session linkage', async ({ page }) => {
  const capture = {};
  await setup(page, capture, { flightEnabled: true, authenticated: true });

  // The recorder must ACTIVATE from the cookie-authenticated enabled-check (no local key).
  await page.waitForFunction(
    () => !!(window.atlasFlightRecorder && window.atlasFlightRecorder.getSessionId()),
    null, { timeout: 5000 },
  );
  const sessionId = await page.evaluate(() => window.atlasFlightRecorder.getSessionId());
  expect(sessionId).toMatch(/^FR-/);

  // Owner-like flow: log a set, then Done → the in-thread review (confirmation) card.
  await logSet(page, 'bench 225 5/2');
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await expect(page.locator('.review')).toBeVisible();

  await flush(page);
  await expect.poll(() => capture.ingests.length, { timeout: 5000 }).toBeGreaterThan(0);

  const events = allEvents(capture);

  // What the athlete TYPED.
  const inputs = events.filter(e => e.event_type === 'user_input');
  expect(inputs.some(e => String(e.user_input || '').includes('bench 225 5/2'))).toBe(true);
  expect(inputs.some(e => String(e.user_input || '').includes('done'))).toBe(true);

  // What Atlas SHOWED (a card/coach render carrying a ui snapshot).
  expect(events.some(e => e.event_type === 'card_rendered' || e.event_type === 'coach_message_rendered')).toBe(true);

  // The PENDING state at some step (the store-derived session snapshot — the evidence v141 lacked).
  const withPending = events.find(e => e.session_state && typeof e.session_state.pending_set_count === 'number' && e.session_state.pending_set_count > 0);
  expect(withPending, 'a session_state snapshot must record the pending captured sets').toBeTruthy();

  // Every event is stamped with the one stable, monotonic session identity.
  expect(events.every(e => String(e.flight_session_id || '') === sessionId)).toBe(true);
  const seqs = events.map(e => Number(e.seq)).filter(n => Number.isFinite(n));
  expect(seqs.length).toBeGreaterThan(0);

  // SERVER linkage restored: an app /api call carries the flight-session header keyed to this
  // session, so the server-side api_response rows can be stitched into the same transcript.
  const parseCall = capture.appHeaders.find(h => h.path === '/api/parse-workout-text');
  expect(parseCall, 'the parse call must have been made').toBeTruthy();
  expect(parseCall.headers['x-atlas-flight-session']).toBe(sessionId);
});

test('flag OFF → recorder stays inert (no ingest), default-off contract preserved', async ({ page }) => {
  const capture = {};
  await setup(page, capture, { flightEnabled: false, authenticated: true });

  await logSet(page, 'bench 225 5/2');
  await flush(page);

  // Give any (erroneous) ingest a chance to land, then assert none did.
  await page.waitForTimeout(300);
  expect(capture.ingests.length).toBe(0);
  const sessionId = await page.evaluate(() => window.atlasFlightRecorder && window.atlasFlightRecorder.getSessionId());
  expect(sessionId).toBeFalsy();
});
