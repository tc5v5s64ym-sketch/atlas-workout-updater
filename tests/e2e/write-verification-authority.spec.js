const { test, expect } = require('@playwright/test');

// C3 — ONE WRITE-VERIFICATION AUTHORITY, and it costs no Sheets read.
//
// Two things used to decide whether a successful Save was verified: the append's own
// `updates` receipt (which the server already had and forwarded but never adjudicated),
// and a separate `GET /api/log-workout/verify-range` read-back the client fired afterwards.
// The receipt wins — it is produced by the append itself, and it is free. The read-back
// cost one metered Sheets read at closeout, the exact instant the 2026-08-05 qualifying
// session hit its 429s.
//
// This spec proves the CLIENT half at the only level where it can be proved: whether the
// browser makes the request. Every case counts the real network calls the page issues.
//
//   1. verdict verified   → no read-back at all, and the write still shows as verified;
//   2. verdict inconclusive → still no read-back, and (#1627) no saved claim
//      either: a negative answer from the authority must not be laundered by
//      re-asking a weaker source, nor softened by a success claim with a note
//      appended afterwards;
//   3. no verdict (a deployment older than this field) → the read-back fallback runs, and
//      runs exactly once.
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
        sheet_write: 'success', sheet_written: true,
        session_id: body.session_id || SESSION,
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
  // The verification note is what the client appends after the write settles; waiting for
  // it is what makes "no read-back was requested" a real observation rather than a race.
  // Attached, not visible: the logger panel is not the surface the conversational flow
  // shows, but the note is the client's verification output all the same.
  await page.locator('#logger-status .parser-status').waitFor({ state: 'attached' });
}

test('an adjudicated receipt verifies the write with no read-back request', async ({ page }) => {
  const capture = {};
  await saveOneSet(page, capture, {
    verified: true, authority: 'append_receipt', reason: null,
    range: APPENDED_RANGE, rows_written: 1, rows_submitted: 1,
  });

  await expect(page.locator('#logger-status')).toContainText('Verified in Sheet');
  expect(capture.verifyRangeRequests).toEqual([]);
});

test('an inconclusive receipt is reported as such — it is never re-asked of the read-back', async ({ page }) => {
  // #1627 supersedes the note-only handling this test originally pinned:
  // an unverified verdict of any reason now gates the saved claim itself,
  // not just appends an inconclusive note after a "Workout written" claim.
  // The read-back prohibition below is unchanged — the negative answer is
  // still never laundered by re-asking a weaker source.
  const capture = {};
  await saveOneSetExpectingGate(page, capture, {
    verified: false, authority: 'append_receipt', reason: 'row_count_disagrees_with_request',
    range: APPENDED_RANGE, rows_written: 3, rows_submitted: 1,
  });

  await expect(page.locator('#logger-status')).toContainText('Not saved');
  await expect(page.locator('#logger-status')).toContainText('row_count_disagrees_with_request');
  await expect(page.locator('#logger-status')).not.toContainText('Workout written to Google Sheets');
  await expect(page.locator('#logger-status')).not.toContainText('Verified in Sheet');
  await expect(page.locator('#logger-status .status-msg.error')).toHaveAttribute('data-atlas-state', 'write-unverified');
  const review = page.locator('.review').last();
  await expect(review).not.toHaveClass(/done/);
  await expect(review.locator('.rv-saved')).toBeHidden();
  expect(capture.writeRequests).toHaveLength(1);
  expect(capture.verifyRangeRequests).toEqual([]);
});

// #1627 — the gated path: the verdict is present but unverified, so the
// handler must not reach the success status at all. Unlike saveOneSet
// above, this path never calls reportWriteVerification, so there is no
// .parser-status note to wait for — the error status itself is the wait.
async function saveOneSetExpectingGate(page, capture, verification) {
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
  await expect(page.locator('#logger-status')).toContainText('Not saved');
}

test('#1627: a wrong_tab receipt never claims a save — not in prose, not on the review card', async ({ page }) => {
  const capture = {};
  await saveOneSetExpectingGate(page, capture, {
    verified: false, authority: 'append_receipt', reason: 'wrong_tab',
    range: 'Wrong_Tab!A200:L202', rows_written: 1, rows_submitted: 1,
  });

  // The logger prose itself must not claim a save, and the status must
  // carry the new marker (not write-confirmed) with the verdict's reason.
  await expect(page.locator('#logger-status')).not.toContainText('Workout written to Google Sheets');
  await expect(page.locator('#logger-status')).toContainText('wrong_tab');
  await expect(page.locator('#logger-status .status-msg.error')).toHaveAttribute('data-atlas-state', 'write-unverified');

  // The review card must not wear Saved, and its Save must stay available
  // (the error observer resets it) — the preview was not torn down.
  const review = page.locator('.review').last();
  await expect(review).not.toHaveClass(/done/);
  await expect(review.locator('.rv-saved')).toBeHidden();
  await expect(review.locator('.rv-note')).toContainText('Nothing');
  await expect(review.locator('.rv-save')).toHaveText('Save workout');
  await expect(review.locator('.rv-save')).toBeEnabled();

  // One append, no automatic retry, and no read-back laundering the
  // negative verdict into a verification.
  expect(capture.writeRequests).toHaveLength(1);
  expect(capture.verifyRangeRequests).toEqual([]);
});

test('a server that publishes no verdict still gets the read-back — exactly once', async ({ page }) => {
  const capture = {};
  await saveOneSet(page, capture, null);

  await expect(page.locator('#logger-status')).toContainText('Verified in Sheet');
  expect(capture.verifyRangeRequests.length).toBe(1);
  const url = new URL(capture.verifyRangeRequests[0]);
  expect(url.searchParams.get('range')).toBe(APPENDED_RANGE);
  expect(url.searchParams.get('session_id')).toBe(SESSION);
});
