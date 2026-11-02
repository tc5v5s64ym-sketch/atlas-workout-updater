const { test, expect } = require('@playwright/test');

// #1628 — a complete-workout save that lands part of the write and then
// fails the Effort append must NOT end as "Already logged" with the Effort
// row still missing. The client surfaces the component-level partial state
// (Effort missing, nothing fully saved) and keys the retry to the missing
// component only: a fresh-id, effort-only write with the same
// session/date/effort.
//
// The network is stubbed, but the browser runs the real preview → approve
// path: a manual effort-only preview stages the write, the approve tap
// issues the live complete-workout write, and the repair tap issues the
// second one. Every case counts the real multipart requests the page issues.
//
// The manual effort-only preview is the UI-reachable complete-workout
// lane; it shares the approve branch with the screenshot lane, whose
// screenshot → effort-only transformation is pinned at unit level in
// test/partialWriteRepair.test.js. The stubbed live partial stands in for
// the server partial the screenshot-with-rows API path produces
// (sheet_write 'partial', sheet_written true, effort_written false).
//
//   1. original partial (500, details sheet_write 'partial') → partial
//      status, no saved claim, repair tap succeeds with a fresh write_id,
//      empty log rows, and the same session;
//   2. duplicate echo of a partial original (skipped_duplicate,
//      original_effort_written false) → the same partial status, NOT
//      already-logged, and the same repair tap succeeds.
//
// Same-id duplicate refusal is unchanged by this fix and is not re-tested
// here: the repair is deliberately a NEW write_id, the path the server
// already accepts for an effort-only resubmission.

const TEST_KEY = 'playwright-test-key';
const DATE = '2026-06-12';
const SESSION = 'PW-PARTIAL-SESSION';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

function multipartField(raw, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(raw || '').match(new RegExp(`name="${escaped}"\\r?\\n\\r?\\n([^\\r\\n]*)`));
  return match ? match[1] : null;
}

const PARSED_EFFORT = {
  duration: '00:42:00', activeCalories: 410, totalCalories: 520, averageHR: 148, peakHR: 171,
  workoutType: 'Traditional Strength Training',
};

function previewBody() {
  return {
    status: 'success',
    data: {
      status: 'ok',
      message: 'complete-workout processed',
      data: {
        session_id: SESSION, date: DATE, date_source: 'manual',
        test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true,
        effort_only: true,
        rows_to_write: [],
        parsed_effort: PARSED_EFFORT,
        duplicate_check: { duplicate_session: false, duplicate_log_rows: 0 },
      },
      warnings: [], pending_exercises: [],
    },
  };
}

function effortSuccessBody() {
  return {
    status: 'success',
    data: {
      status: 'ok',
      message: 'complete-workout processed',
      data: {
        session_id: SESSION, date: DATE, test_mode: false,
        effort_only: true, sheet_written: true, sheet_write: 'success',
        log_rows_written: 0, effort_written: true, effort_rows_written: 1,
        duplicate_check: { duplicate_session: false, duplicate_log_rows: 0 },
        effort_source: 'manual', parsed_effort: PARSED_EFFORT,
      },
    },
  };
}

// liveMode: 'partial' → first live write returns the 500 partial;
//           'duplicate' → first live write returns the duplicate echo.
// Every later live write returns the effort-only success.
async function mockApis(page, capture, liveMode) {
  capture.previews = [];
  capture.liveWrites = [];
  let liveCount = 0;

  await page.route('**/health', r => r.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();

    if (path === '/api/complete-workout' && method === 'POST') {
      const raw = req.postData() || '';
      const isPreview = multipartField(raw, 'test_mode') === 'true';
      if (isPreview) {
        capture.previews.push(raw);
        return route.fulfill(json(previewBody()));
      }
      liveCount += 1;
      capture.liveWrites.push({
        raw,
        writeId: multipartField(raw, 'write_id'),
        sessionId: multipartField(raw, 'session_id'),
        logRowsJson: multipartField(raw, 'log_rows_json'),
        effortJson: multipartField(raw, 'effort_json'),
      });
      if (liveCount === 1 && liveMode === 'partial') {
        return route.fulfill(json({
          status: 'error',
          message: 'Effort row append failed after log rows were written.',
          details: {
            session_id: SESSION, date: DATE, sheet_write: 'partial', sheet_written: true,
            log_rows_written: 0, effort_written: false,
          },
        }, 500));
      }
      if (liveCount === 1 && liveMode === 'duplicate') {
        return route.fulfill(json({
          status: 'success',
          data: {
            status: 'ok',
            message: 'Duplicate write_id; original complete-workout was already processed.',
            data: {
              duplicate_write: true, idempotency_status: 'completed',
              sheet_write: 'skipped_duplicate', sheet_written: false,
              original_sheet_written: true, original_log_rows_written: 0,
              original_effort_written: false, original_completed_at: '2026-06-12T00:00:00.000Z',
            },
          },
        }));
      }
      return route.fulfill(json(effortSuccessBody()));
    }
    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] } }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function stageEffortPreview(page, capture, liveMode) {
  await mockApis(page, capture, liveMode);
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), TEST_KEY);
  await page.goto('/app/');

  await page.evaluate(({ session, date }) => {
    document.querySelector('input[name="effort-mode"][value="manual"]').checked = true;
    document.getElementById('log-date').value = date;
    document.getElementById('log-session-id').value = session;
    const values = {
      'effort-duration': '00:42:00',
      'effort-active-cal': '410',
      'effort-total-cal': '520',
      'effort-avg-hr': '148',
      'effort-peak-hr': '171',
    };
    for (const [id, value] of Object.entries(values)) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.getElementById('effort-preview-btn').click();
  }, { session: SESSION, date: DATE });
  await expect.poll(() => capture.previews.length).toBe(1);
  await expect(page.locator('#approve-btn')).toBeEnabled();
  await expect(page.locator('#approve-btn')).toHaveText('Write Effort to Google Sheets');
}

async function expectPartialState(page) {
  await expect(page.locator('#logger-status')).toContainText('Partially saved');
  await expect(page.locator('#logger-status')).toContainText('Effort row is missing');
  await expect(page.locator('#logger-status')).not.toContainText('Workout written to Google Sheets');
  await expect(page.locator('#logger-status')).not.toContainText('Effort written to Google Sheets');
  await expect(page.locator('#logger-status')).not.toContainText('Already logged');
  await expect(page.locator('#logger-status .status-msg.error')).toHaveAttribute('data-atlas-state', 'write-partial');
  await expect(page.locator('#approve-btn')).toBeEnabled();
  await expect(page.locator('#approve-btn')).toHaveText('Write Effort to Google Sheets');
}

async function expectRepairSucceeds(page, capture) {
  await page.evaluate(() => document.getElementById('approve-btn').click());
  await expect.poll(() => capture.liveWrites.length).toBe(2);
  await expect(page.locator('#logger-status')).toContainText('Effort written to Google Sheets');
  await expect(page.locator('#approve-btn')).toHaveText('Written ✓');

  const [first, repair] = capture.liveWrites;
  expect(repair.writeId).not.toBe(first.writeId);
  expect(repair.sessionId).toBe(SESSION);
  expect(JSON.parse(repair.logRowsJson)).toEqual([]);
  expect(repair.effortJson).toBeTruthy();
  // Manual effort travels snake_case (collectManualEffort); the screenshot
  // conversion (effortJsonFromParsedEffort) is camelCase and is pinned at
  // unit level. Either way the repair carries the same effort values.
  const effort = JSON.parse(repair.effortJson);
  expect(effort.active_calories ?? effort.activeCalories).toBe(410);
  expect(effort.total_calories ?? effort.totalCalories).toBe(520);
}

test('#1628: an original partial write surfaces as partial, then the effort-only repair completes it', async ({ page }) => {
  const capture = {};
  await stageEffortPreview(page, capture, 'partial');

  await page.evaluate(() => document.getElementById('approve-btn').click());
  await expect.poll(() => capture.liveWrites.length).toBe(1);
  await expectPartialState(page);

  await expectRepairSucceeds(page, capture);
});

test('#1628: a duplicate echo of a partial original is partial, not already-logged, then the repair completes it', async ({ page }) => {
  const capture = {};
  await stageEffortPreview(page, capture, 'duplicate');

  await page.evaluate(() => document.getElementById('approve-btn').click());
  await expect.poll(() => capture.liveWrites.length).toBe(1);
  await expectPartialState(page);

  await expectRepairSucceeds(page, capture);
});
