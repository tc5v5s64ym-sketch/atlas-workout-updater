const { test, expect } = require('@playwright/test');

// PR-I3 (canary find, 2026-07-10) — the canary reported the "Done with this
// exercise" (completed) and "End session" (finalized closeout) boundaries were
// never exercised. Both controls already exist; they live in the active-session
// banner, which is COLLAPSED by default (owner UX directive 2026-07-03) behind the
// always-visible session pin. This spec pins the VERIFIED reachability:
//   - "End session" is present whenever a session is active (reachable via the pin);
//   - "Done with this exercise" is reachable for the current accepted item once it
//     holds performed-set evidence — which, given the plan cursor auto-advances past
//     a just-logged item, is the FINAL planned exercise (see BACKLOG: mid-plan Done
//     reachability is an open owner design decision).

const TEST_KEY = 'playwright-test-key';
const SETS = [{ weight: 140, reps: 10, rir: 2 }, { weight: 140, reps: 10, rir: 2 }, { weight: 140, reps: 10, rir: 2 }];

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

function rowsFor(name, code) {
  return SETS.map((s, i) => (['2026-06-12', 'PW', name, name, 'Back', code, i + 1, s.weight, s.reps, s.rir, '', s.weight * s.reps]));
}

async function mockApis(page, capture) {
  capture.sessionPlanPosts = capture.sessionPlanPosts || [];

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData() ? request.postDataJSON() : null;

    if (path.startsWith('/api/session-plans/')) {
      capture.sessionPlanPosts.push({ path, body });
      return route.fulfill(json({ status: 'ok', data: { session_plans: { captured: true, status: 'written' } } }));
    }

    if (path === '/api/plan/intent-recommendation') {
      return route.fulfill(json({
        status: 'success',
        data: {
          todays_read: { recommended_label: 'Pull', recommended_reason: 'Back focus today.' },
          intents: [{
            label: 'Pull', focus: 'Rows', recommended: true,
            exercises: [
              { exercise: 'Seated Row', lift_code: 'ROW01', target_weight: 140, target_reps: 10, target_sets: 3, target_rir: 2 },
              { exercise: 'Leg Extension', lift_code: 'LEX01', target_weight: 90, target_reps: 12, target_sets: 3, target_rir: 2 },
            ],
          }],
        },
      }));
    }

    if (path === '/api/parse-workout-text') {
      const text = ((body && body.text) || '').toLowerCase();
      const isLeg = text.includes('leg extension');
      const name = isLeg ? 'Leg Extension' : 'Seated Row';
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
          parsed: { intent: 'log_sets', raw_name: name.toLowerCase(), canonical_name: name, exercise: name, sets: SETS },
        },
      }));
    }

    if (path === '/api/log-workout' && method === 'POST') {
      const rows = (body && Array.isArray(body.log_rows) && body.log_rows.length) ? body.log_rows : rowsFor('Seated Row', 'ROW01');
      const name = rows[0] && rows[0][2] === 'Leg Extension' ? 'Leg Extension' : (rows[0] && rows[0][2]) || 'Seated Row';
      const code = name === 'Leg Extension' ? 'LEX01' : 'ROW01';
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true,
          warnings: [], auto_matches: [], pending_exercises: [], rule_flags: [], log_rows_preview: rowsFor(name, code),
        },
      }));
    }

    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: [{ canonical_name: 'Seated Row', lift_code: 'ROW01' }, { canonical_name: 'Leg Extension', lift_code: 'LEX01' }] } }));
    }
    if (path === '/api/coach/message') {
      return route.fulfill(json({ status: 'success', data: { message: null, configured: false } }));
    }

    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function openApp(page, capture) {
  await mockApis(page, capture);
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
}

async function logSet(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
}

test('End session and the completed boundary are reachable in the active-session UI via the session pin', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Engage + accept the Coach's Pick so the plan carries identity.
  await page.locator('#workout-text').fill('What are we doing today?');
  await page.locator('#preview-btn').click();
  const startBtn = page.locator('#thread-messages .chat-bubble-atlas').first().locator('.start-this-plan-btn');
  await expect(startBtn).toBeVisible();
  await startBtn.click();
  await expect.poll(() => capture.sessionPlanPosts.filter(p => p.path === '/api/session-plans/accept').length).toBeGreaterThan(0);

  // Log both planned exercises. The cursor auto-advances past Seated Row; logging
  // the final exercise (Leg Extension) leaves it current WITH performed evidence.
  await logSet(page, 'seated row 140 10/2 x3');
  await logSet(page, 'leg extension 90 12/2 x3');

  // The session pin is the always-visible control; tapping it expands the banner.
  const pin = page.locator('#session-pin');
  await expect(pin).toBeVisible();
  await pin.click();

  const banner = page.locator('#active-session-banner');
  await expect(banner).toBeVisible();
  // "End session" (finalized closeout affordance) is always present for an active session.
  await expect(banner.getByText('End session', { exact: true })).toBeVisible();
  // "Done with this exercise" (the explicit completed boundary) is reachable for the
  // final planned item, which retains its evidence.
  await expect(banner.locator('.start-done-btn')).toBeVisible();
  await expect(banner.locator('.start-done-btn')).toHaveText('Done with this exercise');

  // Tapping it emits the explicit completed outcome (the CLICK is authoritative —
  // logging never auto-completed it).
  await banner.locator('.start-done-btn').click();
  await expect.poll(() => capture.sessionPlanPosts.filter(p => p.path === '/api/session-plans/outcome' && p.body && p.body.item && p.body.item.outcome === 'completed').length).toBeGreaterThan(0);
});
