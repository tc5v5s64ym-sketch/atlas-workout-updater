const { test, expect } = require('@playwright/test');

// F07 / CLIENT-3 — an older, slow dry-run/preview response must never overwrite a newer
// request's pending write. A set logs into the buffer; "done" opens the closeout dry-run.
// Here two closeout dry-runs overlap and are resolved OUT OF ORDER (newer first, stale older
// last). The stale older response must be dropped, so the pending write — and what Approve
// writes — stays bound to the NEWER preview. Each submit mints its own write_id, so the
// write's write_id is the identity proof of which preview survived. RED before the seq guard
// (the late older response clobbers pendingWrite), GREEN after.

const TEST_KEY = 'playwright-test-key';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

async function openApp(page, capture) {
  capture.previewRequests = [];
  capture.writeRequests = [];
  capture.gates = []; // one resolver per held dry-run, in arrival order

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
          parsed: { intent: 'log_sets', raw_name: 'bench', canonical_name: 'Bench Press', exercise: 'Bench Press', sets: [{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 5, rir: 2 }] },
        },
      }));
    }
    if (path === '/api/session/compile') {
      return route.fulfill(json({ status: 'success', data: { workout_text: 'bench 225 5/2 x3' } }));
    }
    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        capture.previewRequests.push(body);
        await new Promise(res => capture.gates.push(res)); // hold until the test releases it
        const preview = (body.log_rows || []).map(r => [r.date_clean, r.session_id, r.exercise, r.exercise, 'Chest', 'BEN01', r.set_number, r.weight, r.reps, r.rir, r.notes, '']);
        return route.fulfill(json({ status: 'success', data: { test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true, warnings: [], auto_matches: [], pending_exercises: [], rule_flags: [], log_rows_preview: preview } }));
      }
      capture.writeRequests.push(body);
      return route.fulfill(json({ status: 'success', data: { sheet_write: 'success', sheet_written: true, log_rows_written: (body.log_rows || []).length, logAppendedRange: 'Log_Cleaned!A200:L202' } }));
    }
    if (path === '/api/log-workout/verify-range') return route.fulfill(json({ status: 'success', data: { verified: true } }));
    if (path === '/api/catalog/exercises') return route.fulfill(json({ status: 'success', data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] } }));
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), TEST_KEY);
  await page.goto('/app/');
}

async function submitForm(page) {
  await page.evaluate(() => document.getElementById('logger-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
}

test('a stale dry-run response is ignored; Approve writes the NEWER preview', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Log a set into the buffer (conversational — no dry-run yet).
  await page.locator('#workout-text').fill('bench 225 5/2 x3');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();

  // "done" opens closeout dry-run A (held). While it is in flight the closeout state stays
  // primed, so a second submit opens dry-run B (held) — two overlapping previews.
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.previewRequests.length).toBe(1);

  // A second "done" while dry-run A is still in flight (the preview button is disabled during
  // A's dry-run, so drive the form event directly) opens dry-run B.
  await page.evaluate(() => { document.getElementById('workout-text').value = 'done'; });
  await submitForm(page);
  await expect.poll(() => capture.previewRequests.length).toBe(2);

  const writeIdA = capture.previewRequests[0].write_id;
  const writeIdB = capture.previewRequests[1].write_id;
  expect(writeIdA).toBeTruthy();
  expect(writeIdB).toBeTruthy();
  expect(writeIdA).not.toBe(writeIdB);

  // Resolve OUT OF ORDER: newer (B) first, then the stale older (A) last.
  capture.gates[1]();
  capture.gates[0]();

  // The review card's Save drives the same gated #approve-btn (the panel itself is hidden).
  await expect(page.locator('#approve-btn')).toBeEnabled();
  await page.locator('.rv-save').last().click();

  await expect.poll(() => capture.writeRequests.length).toBe(1);
  // The write carries the NEWER preview's write_id — the stale response did not win.
  expect(capture.writeRequests[0].write_id).toBe(writeIdB);
});
