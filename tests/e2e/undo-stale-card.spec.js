const { test, expect } = require('@playwright/test');

// CLIENT-1 (audit 2026-07-07 / PR-0D) — Undo on a stale review card must never
// delete a NEWER write.
//
// Repro: save workout A (range A200), keep training, save workout B (range A300).
// Card A stays in the thread with a live "Undo". Tapping it used to call the
// global window.atlasUndoLastWrite(), which always operated on the newest write
// (lastWrite = B) — so the lifter's latest workout was deleted while the UI said
// the OLD card was undone.
//
// The fix binds each card's write identity at save time and (a) strips the Undo
// affordance from every older saved card when a newer write confirms, and
// (b) refuses at the request layer if a card's bound identity no longer matches
// the current lastWrite. Either way the server undo can never target write B
// from card A. The server undo contract (W4/W5/W7) is untouched.

const TEST_KEY = 'playwright-test-key';
const TEST_SESSION = 'PW-E2E-SESSION';
const TEST_DATE = '2026-06-12';

const BENCH_SETS = [
  { weight: 225, reps: 5, rir: 2 },
  { weight: 225, reps: 5, rir: 2 },
  { weight: 225, reps: 5, rir: 2 }
];

const benchRows = (session) => BENCH_SETS.map((set, index) => ([
  TEST_DATE, session, 'Bench Press', 'Bench Press', 'Chest', 'BEN01',
  index + 1, set.weight, set.reps, set.rir, '', set.weight * set.reps
]));

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

async function mockAtlasApis(page, capture) {
  capture.writeRequests = capture.writeRequests || [];
  capture.undoRequests = capture.undoRequests || [];
  // Each live write gets a distinct appended range so the test can tell which
  // write an undo request actually targeted.
  capture.writeRanges = ['Log_Cleaned!A200:L202', 'Log_Cleaned!A300:L302'];

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData() ? request.postDataJSON() : null;

    if (path === '/api/parse-workout-text') {
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
          parsed: { intent: 'log_sets', raw_name: 'bench', canonical_name: 'Bench Press', exercise: 'Bench Press', sets: BENCH_SETS }
        }
      }));
    }

    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        return route.fulfill(json({
          status: 'success',
          data: {
            test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true,
            warnings: [], auto_matches: ['bench -> Bench Press'], pending_exercises: [], rule_flags: [],
            log_rows_preview: benchRows(body.session_id || TEST_SESSION)
          }
        }));
      }
      const range = capture.writeRanges[capture.writeRequests.length] || 'Log_Cleaned!A999:L999';
      capture.writeRequests.push(body);
      return route.fulfill(json({
        status: 'success',
        data: { sheet_write: 'success', sheet_written: true, log_rows_written: 3, logAppendedRange: range }
      }));
    }

    if (path === '/api/log-workout/undo-last' && method === 'POST') {
      capture.undoRequests.push(body);
      return route.fulfill(json({ status: 'success', data: { deleted: true } }));
    }

    if (path === '/api/log-workout/verify-range') {
      return route.fulfill(json({ status: 'success', data: { verified: true } }));
    }

    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] } }));
    }

    if (path === '/api/progress/summary') {
      return route.fulfill(json({ ok: true, data: { total_sessions: 42, average_sessions_per_week: 3.2, total_sets: 510, current_week_sessions: 3, weekly_streak: 4, streak_target_per_week: 3, sessions_by_week: [] } }));
    }

    if (path === '/api/plan/intent-recommendation') {
      return route.fulfill(json({
        status: 'success',
        data: {
          todays_read: { recommended_label: 'Push', recommended_reason: 'Bench is ready.', patterns: [] },
          // Non-overlapping with the logged bench sets: the F10D acceptance
          // boundary gates sets FROM an unaccepted displayed plan, and these
          // undo-mechanics scenarios log freeform.
          intents: [{ label: 'Push', focus: 'Accessories', recommended: true, why_today: ['Pressing is fresh'], exercises: [{ exercise: 'Pallof Press', lift_code: 'PAL01', target_weight: 65, target_reps: 15, target_sets: 3, target_rir: 2 }] }]
        }
      }));
    }

    if (path.startsWith('/api/recommend/next/')) {
      return route.fulfill(json({ status: 'success', data: { liftCode: 'BEN01', exercise_name: 'Bench Press', recommendation: 'Hold 225.', last_working_sets: [{ weight: 225, reps: 5, rir: 2 }], next_target: { weight: 225, reps: 5, sets: 3 }, reasoning: 'mock', sessions_analyzed: 3 } }));
    }

    if (path === '/api/coach/message') {
      return route.fulfill(json({ status: 'success', data: { message: null, configured: false } }));
    }

    if (path === '/api/session/compile') {
      return route.fulfill(json({ status: 'success', data: { workout_text: 'bench 225 5/2 x3' } }));
    }

    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function openApp(page, capture) {
  await mockAtlasApis(page, capture);
  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
}

// Log a set (conversational readback), then "done" to raise the review card, then Save.
async function logAndSave(page) {
  await page.locator('#workout-text').fill('bench 225 5/2 x3');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await page.locator('.review:not(.done)').last().locator('.rv-save').click();
  await expect(page.locator('.review.done').last()).toBeVisible();
}

test('CLIENT-1: a newer write confirms → the older saved card loses its live Undo', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logAndSave(page);                       // write A → Log_Cleaned!A200:L202
  const cardA = page.locator('.review').nth(0);
  await expect(cardA).toHaveClass(/done/);
  await expect(cardA.locator('.rv-undo')).toBeVisible();   // A is the newest → undoable

  await logAndSave(page);                       // write B → Log_Cleaned!A300:L302
  await expect(page.locator('.review')).toHaveCount(2);
  const cardB = page.locator('.review').nth(1);
  await expect(cardB).toHaveClass(/done/);

  expect(capture.writeRequests).toHaveLength(2);

  // The stale card A no longer offers a live Undo; only the newest card B does.
  await expect(cardA.locator('.rv-undo')).toHaveCount(0);
  await expect(cardB.locator('.rv-undo')).toBeVisible();
});

test('CLIENT-1: the identity guard refuses an undo bound to a superseded write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logAndSave(page);                       // write A → A200
  await logAndSave(page);                       // write B → A300 (now the current lastWrite)
  expect(capture.writeRequests).toHaveLength(2);

  // Directly exercise the guard: an Undo call carrying write A's identity must be
  // refused (no server request) now that write B is the latest write.
  const staleResult = await page.evaluate(async () => {
    await window.atlasUndoLastWrite({ log_appended_range: 'Log_Cleaned!A200:L202', session_id: 'PW-E2E-SESSION' });
    return true;
  });
  expect(staleResult).toBe(true);
  // No undo request went to the server for the superseded identity…
  expect(capture.undoRequests).toHaveLength(0);
  // …and the current (newest) write is still undoable with a matching identity.
  await page.evaluate(async () => {
    await window.atlasUndoLastWrite({ log_appended_range: 'Log_Cleaned!A300:L302', session_id: 'PW-E2E-SESSION' });
  });
  expect(capture.undoRequests).toHaveLength(1);
  expect(capture.undoRequests[0].log_appended_range).toBe('Log_Cleaned!A300:L302');
});

test('CLIENT-1: single-save undo still works unchanged (no regression)', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logAndSave(page);                       // write A → A200
  await page.locator('.review').nth(0).locator('.rv-undo').click();

  await expect.poll(() => capture.undoRequests.length).toBe(1);
  expect(capture.undoRequests[0].log_appended_range).toBe('Log_Cleaned!A200:L202');
  expect(capture.undoRequests[0].confirm_delete).toBe(true);
});
