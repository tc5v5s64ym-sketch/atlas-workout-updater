const { test, expect } = require('@playwright/test');

// #1732 (Fable fix 6, B-02 / B-write-8) — buffer poisoning: a model-applied
// edit value must not be marked user-typed.
//
// After a model PROPOSE_EDIT, logging one more honest set must NOT let the
// model's value replace the athlete's value in the session buffer. Before the
// fix, applyProposedEdit stamped each changed field `data-user-edited`, and
// the next log's reconcile (F06/CLIENT-2 fold-back) wrote the model value
// over the athlete's buffer entry — it then passed grounding as a 'fact' and
// was written at closeout. The fix: applyProposedEdit stops marking
// model-applied values as user-typed.
//
// Probe shape (mirrors preview-edit-preserve.spec.js + the #1737 B-plan-1
// accept-card test in app-smoke.spec.js): the athlete's message states NO
// number, so the model's 315x12 is entirely model-invented — the server
// resolver would drop it, so the coach reply is stubbed at the network
// layer, exactly as the #1737 tests stub it, to exercise the client's last
// line of defence.

const TEST_KEY = 'playwright-test-key';
const DATE = '2026-06-12';
const SESSION = 'PW-E2E-SESSION';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

// The parser stub answers from the typed text: '135' → the athlete's honest
// 135x8, '140' → the next honest set 140x10, anything else →
// needs_clarification (so a chat message routes to the coach).
function rowsFor(text) {
  if (/135/.test(text)) return [{ weight: 135, reps: 8, rir: 1 }];
  if (/140/.test(text)) return [{ weight: 140, reps: 10, rir: 1 }];
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
      // The model invents 315x12 for a message that states no number. The
      // turn-id header is required: without it the turn-correlation lane
      // never accepts the ticket and the accept card is never staged
      // (same header the #1737 B-plan-1 test sends).
      return route.fulfill({
        ...json({
          status: 'success',
          data: {
            message: 'That set looked strong — bumped it to 315 for 12.',
            propose_edit: { action: 'update_set', index: 0, weight: 315, reps: 12 },
            configured: true,
            source: 'gemini',
          },
        }),
        headers: { 'x-atlas-turn-id': 'turn:playwright-1732-b-write-8' },
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

test('B-write-8: a model edit value never replaces the athlete\u2019s honest set in the buffer', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // The athlete's honest set logs into the session buffer; the closeout
  // rebuilds the editable preview table from that buffer.
  await logSet(page, 'bench 135 8');
  await endSession(page);
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(1);
  await expandEditor(page);
  await expect(cell(page, 0, '.set-weight')).toHaveValue('135');
  await expect(cell(page, 0, '.set-reps')).toHaveValue('8');

  // The model proposes 315x12 for a message that states no number; accept it.
  // (Same staging as the #1737 B-plan-1 test: the edit applies to the preview
  // table on Accept, and the re-preview trust loop holds.)
  await page.locator('#workout-text').fill('how did that set look?');
  await page.locator('#preview-btn').click();
  await expect(page.locator('.propose-edit-accept-btn')).toBeVisible();
  await page.locator('.propose-edit-accept-btn').click();
  await expect(page.locator('.edit-applied-note')).toBeVisible();
  // The preview shows the model's value — the accept applied it to the table.
  await expect(cell(page, 0, '.set-weight')).toHaveValue('315');

  // Log one more honest set. The next closeout rebuilds from the buffer.
  await logSet(page, 'bench 140 10');
  await endSession(page);

  await expect(page.locator('#sets-table tbody tr')).toHaveCount(2);
  await expandEditor(page);
  // The athlete's honest 135x8 survives — the model's 315x12 never replaced
  // it in the buffer, so it never reaches the closeout write as a 'fact'.
  await expect(cell(page, 0, '.set-weight')).toHaveValue('135');
  await expect(cell(page, 0, '.set-reps')).toHaveValue('8');
  await expect(cell(page, 1, '.set-weight')).toHaveValue('140');

  // Save writes exactly the final preview — no 315 anywhere.
  await page.locator('.rv-save').click();
  await expect.poll(() => capture.writeRequests.length).toBe(1);
  expect(capture.writeRequests[0].log_rows.length).toBe(2);
  expect(capture.writeRequests[0].log_rows.map(r => String(r.weight))).toEqual(['135', '140']);
});
