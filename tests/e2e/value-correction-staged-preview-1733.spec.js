const { test, expect } = require('@playwright/test');

// #1733 (Fable fix 7, B-14 / B-write-5) — a typed correction at a staged
// preview is confirmed then lost.
//
// The athlete logs Bench 135x8, finishes (the closeout preview stages the
// table at 135), then types a value correction ("Typo. 140."). The
// deterministic correction lane rewrites the buffer 135 → 140 and the coach
// confirms "135 → 140" — but the staged table still shows 135, and the next
// re-preview collects it and stages the stale write, so Save writes 135 to
// Log_Cleaned. The fix: rebuild the staged table from the buffer when a value
// correction changes it (hand-edits fold back first, per F06), so the
// re-preview stages the corrected rows and the write carries 140.
//
// Probe shape (mirrors propose-edit-buffer-poisoning-1732.spec.js): the
// parser stub answers needs_clarification for the correction text, so the
// submit falls into the deterministic correction lane exactly as in
// production — never a re-parse, never the coach.

const TEST_KEY = 'playwright-test-key';
const DATE = '2026-06-12';
const SESSION = 'PW-E2E-SESSION';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

// The parser stub answers from the typed text: '135' → the athlete's honest
// 135x8; anything else (including the "Typo. 140." correction) →
// needs_clarification, so a correction routes to the deterministic lane.
function rowsFor(text) {
  if (/135/.test(text)) return [{ weight: 135, reps: 8, rir: 1 }];
  return null;
}

async function mockApis(page, capture) {
  capture.writeRequests = capture.writeRequests || [];
  await page.route('**/health', r => r.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body = method === 'POST' && req.postData() ? req.postDataJSON() : null;

    if (path === '/api/parse-workout-text') {
      const rows = rowsFor(body?.text || '');
      if (!rows) {
        return route.fulfill(json({
          status: 'success',
          data: {
            test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
            parsed: { intent: 'needs_clarification', message: 'Could not find sets.' },
          },
        }));
      }
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
          parsed: { intent: 'log_sets', raw_name: 'bench', canonical_name: 'Bench Press', exercise: 'Bench Press', sets: rows },
        },
      }));
    }
    if (path === '/api/coach/chat') {
      return route.fulfill({
        ...json({
          status: 'success',
          data: { message: 'Noted.', configured: true, source: 'gemini' },
        }),
        headers: { 'x-atlas-turn-id': 'turn:playwright-1733-b-write-5' },
      });
    }
    if (path === '/api/session/compile') {
      return route.fulfill(json({ status: 'success', data: { workout_text: 'bench 135 8' } }));
    }
    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        const preview = (body.log_rows || []).map(r => [r.date_clean || DATE, r.session_id || SESSION, r.exercise, r.exercise, 'Chest', 'BEN01', r.set_number, r.weight, r.reps, r.rir, r.notes, '']);
        return route.fulfill(json({ status: 'success', data: { test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true, warnings: [], auto_matches: [], pending_exercises: [], rule_flags: [], log_rows_preview: preview } }));
      }
      capture.writeRequests.push(body);
      return route.fulfill(json({ status: 'success', data: { sheet_write: 'success', sheet_written: true, log_rows_written: (body.log_rows || []).length, logAppendedRange: 'Log_Cleaned!A200:L202' } }));
    }
    if (path === '/api/log-workout/verify-range') return route.fulfill(json({ status: 'success', data: { verified: true } }));
    if (path === '/api/catalog/exercises') return route.fulfill(json({ status: 'success', data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] } }));
    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function openApp(page, capture) {
  await mockApis(page, capture);
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), TEST_KEY);
  await page.goto('/app/');
}

async function logSet(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
}

async function endSession(page) {
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await expect(page.locator('.review')).toBeVisible();
}

async function expandEditor(page) {
  await page.locator('#parsed-rows-editor').evaluate(el => { el.open = true; });
}

const cell = (page, i, cls) => page.locator('#sets-table tbody tr').nth(i).locator(cls);

test('B-write-5: a typed correction at a staged preview reaches the write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // The athlete's honest set logs into the session buffer; the closeout
  // stages the editable preview table from that buffer.
  await logSet(page, 'bench 135 8');
  await endSession(page);
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(1);
  await expandEditor(page);
  await expect(cell(page, 0, '.set-weight')).toHaveValue('135');
  await expect(cell(page, 0, '.set-reps')).toHaveValue('8');

  // The typed value correction. The deterministic lane rewrites the buffer
  // and the coach confirms from the buffer's own post-correction values.
  await page.locator('#workout-text').fill('Typo. 140.');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages')).toContainText('✓ Corrected Bench Press: 135 → 140 on 1 set.');

  // The fix: the staged table is rebuilt from the corrected buffer — the
  // confirmed 140 is what the table shows, not the pre-correction 135.
  await expect(cell(page, 0, '.set-weight')).toHaveValue('140');
  await expect(cell(page, 0, '.set-reps')).toHaveValue('8');

  // Re-preview (the submit invalidated the staged write, per the trust
  // loop) and save: the write carries the corrected value.
  await page.locator('#preview-btn').click();
  await expect(page.locator('.review')).toBeVisible();
  await expect(cell(page, 0, '.set-weight')).toHaveValue('140');

  await page.locator('.rv-save').click();
  await expect.poll(() => capture.writeRequests.length).toBe(1);
  expect(capture.writeRequests[0].log_rows.length).toBe(1);
  expect(String(capture.writeRequests[0].log_rows[0].weight)).toBe('140');
});
