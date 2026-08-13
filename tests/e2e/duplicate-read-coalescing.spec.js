const { test, expect } = require('@playwright/test');

// C2 — THE APP MUST NOT ASK THE SAME QUESTION TWICE AT THE SAME MOMENT.
//
// The 2026-08-05 qualifying session's request manifest shows the app-open fan-out issuing
// two identical reads, milliseconds apart, with nothing written between them:
//
//     GET /api/coaching/insights            @ 1.7 s   and   @ 2.6 s
//     GET /api/plan/intent-recommendation   @ 2.2 s   and   @ 2.6 s
//
// Each pair is two cards wanting the same answer: loadDashboard/loadCoaching and
// loadWeeklyCoach for the insights, loadDashboard and loadCoachPlan for the recommendation.
// Against a 60-read-per-minute quota, that is two reads spent on an answer the app already
// had in flight.
//
// The fix is coalescing, not caching: a second caller joins a request that is STILL IN
// FLIGHT, and nothing is remembered once the response arrives. For that to be a guarantee
// rather than a race, every consumer in the bootstrap fan-out has to start in the same tick,
// which is why loadDashboard now starts its below-fold group up front.
//
// This spec counts the requests the browser really makes. It is the guard the corrected
// client manifest in test/helpers/liveSessionHarness.js rests on — a harness that replays
// HTTP cannot observe browser-side coalescing, so it is proved here or not at all.

const TEST_KEY = 'playwright-test-key';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

async function openApp(page, capture, { slowMs = 0, withSave = false } = {}) {
  capture.paths = [];
  capture.writes = [];
  capture.urls = [];
  await page.route('**/health', r => r.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    capture.paths.push(path);
    capture.urls.push(path + url.search);
    // A real server does not answer instantly. Without a delay every request would have
    // completed before the next began, and coalescing would be untestable — and, more to
    // the point, meaningless. This models the latency the live session actually had.
    if (slowMs) await new Promise(resolve => setTimeout(resolve, slowMs));
    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({
        status: 'success',
        data: { exercises: withSave ? [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] : [] },
      }));
    }
    if (withSave && path === '/api/session/compile') {
      return route.fulfill(json({ status: 'success', data: { workout_text: 'bench 225 5/2' } }));
    }
    if (withSave && path === '/api/parse-workout-text') {
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
          parsed: {
            intent: 'log_sets', raw_name: 'bench', canonical_name: 'Bench Press',
            exercise: 'Bench Press', sets: [{ weight: 225, reps: 5, rir: 2 }],
          },
        },
      }));
    }
    if (withSave && path === '/api/log-workout' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      if (body?.test_mode === true || body?.test_mode === 'true') {
        const preview = (body.log_rows || []).map(r => [
          r.date_clean || '2026-06-12', r.session_id || 'PW-E2E', r.exercise, r.exercise,
          'Chest', 'BEN01', r.set_number, r.weight, r.reps, r.rir, r.notes, '',
        ]);
        return route.fulfill(json({
          status: 'success',
          data: {
            test_mode: true, sheet_write: 'skipped', sheet_written: false,
            no_write_confirmed: true, warnings: [], auto_matches: [], pending_exercises: [],
            rule_flags: [], log_rows_preview: preview,
          },
        }));
      }
      capture.writes.push(body);
      return route.fulfill(json({
        status: 'success',
        data: {
          sheet_write: 'success', sheet_written: true, write_authority: 'supabase_transaction',
          session_id: body.session_id || 'PW-E2E',
          log_rows_written: (body.log_rows || []).length,
          logAppendedRange: 'Log_Cleaned!A200:L200',
          log_write_verification: {
            verified: true, authority: 'append_receipt', reason: null,
            range: 'Log_Cleaned!A200:L200', rows_written: 1, rows_submitted: 1,
          },
        },
      }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), TEST_KEY);
  await page.goto('/app/');
}

const count = (capture, path) => capture.paths.filter(p => p === path).length;

// The two stall queries are NOT duplicates and are deliberately left alone: the dashboard
// asks for a 3-session threshold and the post-Save verdict strip asks for the default.
// Different questions with different answers — coalescing them would change what the
// athlete is shown.
function assertStalls(urls) {
  expect(urls.filter(u => u === '/api/stalls?minSessions=3').length).toBe(2);  // one per fan-out
  expect(urls.filter(u => u === '/api/stalls').length).toBe(1);                // the verdict strip
}

test('the app-open fan-out asks for each shared read exactly once', async ({ page }) => {
  const capture = {};
  await openApp(page, capture, { slowMs: 150 });

  // Wait for the fan-out to settle: the dashboard's own below-fold cards are the last of it.
  await expect.poll(() => count(capture, '/api/summary/weekly'), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(1000);

  expect(count(capture, '/api/plan/intent-recommendation')).toBe(1);
  expect(count(capture, '/api/coaching/insights')).toBe(1);

  // And the fan-out really did happen — a spec that silently loaded nothing would pass the
  // two assertions above for the wrong reason.
  expect(count(capture, '/api/progress/summary')).toBe(1);
  expect(count(capture, '/api/summary/weekly')).toBe(1);
  expect(count(capture, '/api/report/weekly')).toBe(1);
  expect(count(capture, '/api/plan/today')).toBe(1);
});

// THE OTHER HALF OF THE CONTRACT: this is coalescing, not caching. Nothing is remembered
// once a response arrives, so the next fan-out asks again — which is exactly what must
// happen after a Save, because the Save changed the answer. A cache would have shown the
// athlete their pre-write dashboard.
test('the post-Save refresh asks again — nothing was remembered from app open', async ({ page }) => {
  const capture = {};
  await openApp(page, capture, { slowMs: 60, withSave: true });

  await expect.poll(() => count(capture, '/api/plan/intent-recommendation'), { timeout: 10_000 })
    .toBe(1);
  await expect.poll(() => count(capture, '/api/coaching/insights'), { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(400);

  await page.locator('#workout-text').fill('bench 225 5/2');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await expect(page.locator('.review')).toBeVisible({ timeout: 15_000 });
  await page.locator('.rv-save').click();
  await expect.poll(() => capture.writes.length, { timeout: 10_000 }).toBe(1);

  // The post-Save dashboard refresh is a NEW fan-out at a NEW moment: each shared read is
  // asked again, exactly once — coalesced within the refresh, not carried over from open.
  await expect.poll(() => count(capture, '/api/plan/intent-recommendation'), { timeout: 10_000 })
    .toBe(2);
  await page.waitForTimeout(600);
  expect(count(capture, '/api/plan/intent-recommendation')).toBe(2);
  expect(count(capture, '/api/coaching/insights')).toBe(2);
  // The post-Save verdict strip also wants the PR list the dashboard refresh just asked
  // for — 0.8 s apart in the captured manifest. Two fan-outs, two requests, not three.
  expect(count(capture, '/api/prs/recent')).toBe(2);
  // NOT a duplicate, and deliberately left alone: the dashboard asks
  // /api/stalls?minSessions=3 and the verdict strip asks /api/stalls. Different questions
  // with different answers — coalescing them would change what the athlete is shown.
  const stalls = capture.urls.filter(u => u.startsWith('/api/stalls'));
  assertStalls(stalls);
});
