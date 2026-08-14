const { test, expect } = require('@playwright/test');

// C3/S4 — ONE WRITE-VERIFICATION AUTHORITY, and it costs no Sheets read.
//
// The Supabase transaction receipt decides whether a successful Save was verified.
// The retired `GET /api/log-workout/verify-range` fallback read an asynchronous Sheets
// mirror and could make a good workout depend on quota or mirror timing.
//
// This spec proves the CLIENT half at the only level where it can be proved: whether the
// browser makes the request. Every case counts the real network calls the page issues.
//
//   1. verdict verified   → no read-back at all, and the write still shows as verified;
//   2. verdict inconclusive → still no read-back. A negative answer from the authority must
//      not be laundered by re-asking a weaker source;
//   3. no verdict → no read-back and no verification claim.
//
// In every case exactly ONE verification path runs for one successful Save.

const TEST_KEY = 'playwright-test-key';
const DATE = '2026-06-12';
const SESSION = 'PW-E2E-SESSION';
const APPENDED_RANGE = 'Log_Cleaned!A200:L202';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

/**
 * @param {object|null} verification what the server returns as `log_write_verification`;
 *                                   null models a deployment that predates the field.
 */
async function mockApis(page, capture, verification) {
  capture.writeRequests = [];
  capture.verifyRangeRequests = [];

  await page.route('**/health', r => r.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body = method === 'POST' && req.postData() ? req.postDataJSON() : null;

    if (path === '/api/parse-workout-text') {
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
    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        const preview = (body.log_rows || []).map(r => [
          r.date_clean || DATE, r.session_id || SESSION, r.exercise, r.exercise,
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
      capture.writeRequests.push(body);
      const rows = (body.log_rows || []).length;
      const data = {
        sheet_write: 'success', sheet_written: true, write_authority: 'supabase_transaction',
        session_id: body.session_id || SESSION,
        write_id: body.write_id,
        log_rows_written: rows,
        logAppendedRange: APPENDED_RANGE,
      };
      if (verification) data.log_write_verification = verification;
      return route.fulfill(json({ status: 'success', data }));
    }
    if (path === '/api/log-workout/verify-range') {
      capture.verifyRangeRequests.push(req.url());
      return route.fulfill(json({ status: 'success', data: { verified: true } }));
    }
    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] } }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function saveOneSet(page, capture, verification) {
  await mockApis(page, capture, verification);
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), TEST_KEY);
  await page.goto('/app/');

  await page.locator('#workout-text').fill('bench 225 5/2');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();

  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await expect(page.locator('.review')).toBeVisible();

  await page.locator('.rv-save').click();
  await expect.poll(() => capture.writeRequests.length).toBe(1);
  await expect(page.locator('#logger-status')).toContainText('Workout saved.');
}

test('an adjudicated receipt verifies the write with no read-back request', async ({ page }) => {
  const capture = {};
  await saveOneSet(page, capture, {
    verified: true, authority: 'supabase_transaction', reason: null,
    range: null, rows_written: 1, rows_submitted: 1,
  });

  await expect(page.locator('#logger-status')).toContainText('Verified ✓');
  expect(capture.verifyRangeRequests).toEqual([]);
});

test('an inconclusive receipt is reported as such — it is never re-asked of the read-back', async ({ page }) => {
  const capture = {};
  await saveOneSet(page, capture, {
    verified: false, authority: 'supabase_transaction', reason: 'row_count_disagrees_with_request',
    range: null, rows_written: 3, rows_submitted: 1,
  });

  await expect(page.locator('#logger-status')).toContainText('verification was inconclusive');
  await expect(page.locator('#logger-status')).toContainText('row_count_disagrees_with_request');
  await expect(page.locator('#logger-status')).not.toContainText('Verified ✓');
  expect(capture.verifyRangeRequests).toEqual([]);
});

test('a server that publishes no verdict makes no verification claim and performs no fallback read', async ({ page }) => {
  const capture = {};
  await saveOneSet(page, capture, null);

  await expect(page.locator('#logger-status')).not.toContainText('Verified ✓');
  await expect(page.locator('#logger-status')).not.toContainText('verification was inconclusive');
  expect(capture.verifyRangeRequests).toEqual([]);
});
