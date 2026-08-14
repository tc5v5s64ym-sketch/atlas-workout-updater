const { test, expect } = require('@playwright/test');

// F06 / CLIENT-2 — a correction the lifter makes in the closeout preview must stay
// authoritative when another set is logged before Save. Sets log conversationally into a
// buffer; each closeout rebuilds the editable preview table from that buffer
// (buildRowsFromSessionLog). Before the fix, logging another set fired emitSetLogged, which
// wiped the edited table while the buffer kept the ORIGINAL value — so the next closeout
// silently reverted the edit. RED before, GREEN after the buffer reconciliation. Also
// asserts Save writes exactly the final preview (the edit reaches the sheet, not the parser
// value).

const TEST_KEY = 'playwright-test-key';
const DATE = '2026-06-12';
const SESSION = 'PW-E2E-SESSION';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

// N bench sets @ 225 x5 RIR2 from the trailing "xN" (default 1). The parser ALWAYS returns
// 225 — any 230 that reaches the write came from the preserved edit, never the parser.
function benchSets(text) {
  const m = String(text || '').match(/x\s*(\d+)/i);
  const n = m ? Number(m[1]) : 1;
  return Array.from({ length: n }, () => ({ weight: 225, reps: 5, rir: 2 }));
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
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
          parsed: { intent: 'log_sets', raw_name: 'bench', canonical_name: 'Bench Press', exercise: 'Bench Press', sets: benchSets(body?.text) },
        },
      }));
    }
    if (path === '/api/session/compile') {
      return route.fulfill(json({ status: 'success', data: { workout_text: 'bench 225 5/2 x3' } }));
    }
    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        const preview = (body.log_rows || []).map(r => [r.date_clean || DATE, r.session_id || SESSION, r.exercise, r.exercise, 'Chest', 'BEN01', r.set_number, r.weight, r.reps, r.rir, r.notes, '']);
        return route.fulfill(json({ status: 'success', data: { test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true, warnings: [], auto_matches: [], pending_exercises: [], rule_flags: [], log_rows_preview: preview } }));
      }
      capture.writeRequests.push(body);
      return route.fulfill(json({ status: 'success', data: { sheet_write: 'success', sheet_written: true, write_authority: 'supabase_transaction', log_rows_written: (body.log_rows || []).length, logAppendedRange: 'Log_Cleaned!A200:L202' } }));
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

test('a closeout-preview edit survives logging another set, and reaches the write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page, 'bench 225 5/2 x3');
  await endSession(page);

  // The closeout rebuilt the editable preview from the buffer — three 225 rows. Correct set 1.
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(3);
  await expandEditor(page);
  await cell(page, 0, '.set-weight').fill('230');

  // Log another set. emitSetLogged wipes the edited table; the fix folds the 230 into the
  // buffer first, so the next closeout keeps it instead of reverting to the parser's 225.
  await logSet(page, 'bench 225 5/2 x1');
  await endSession(page);

  await expect(page.locator('#sets-table tbody tr')).toHaveCount(4);
  await expandEditor(page);
  await expect(cell(page, 0, '.set-weight')).toHaveValue('230'); // preserved edit
  await expect(cell(page, 1, '.set-weight')).toHaveValue('225'); // untouched buffer row

  // Save writes exactly the final preview — the edited 230, not the parsed 225.
  await page.locator('.rv-save').click();
  await expect.poll(() => capture.writeRequests.length).toBe(1);
  expect(capture.writeRequests[0].log_rows.length).toBe(4);
  expect(capture.writeRequests[0].log_rows[0].weight).toBe('230');
});

test('a middle-row edit is preserved by identity (set number), not by list position', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page, 'bench 225 5/2 x3');
  await endSession(page);
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(3);

  // All three rows share the exercise "Bench Press", so only the set number distinguishes
  // them — edit set 2's reps to 8.
  await expandEditor(page);
  await cell(page, 1, '.set-reps').fill('8');

  await logSet(page, 'bench 225 5/2 x1');
  await endSession(page);
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(4);
  await expandEditor(page);

  await expect(cell(page, 0, '.set-reps')).toHaveValue('5'); // untouched
  await expect(cell(page, 1, '.set-reps')).toHaveValue('8'); // the corrected middle row
  await expect(cell(page, 2, '.set-reps')).toHaveValue('5'); // untouched
  await expect(cell(page, 3, '.set-reps')).toHaveValue('5'); // the new set
});

test('a renamed exercise (and its numeric edits) survive logging another set', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page, 'bench 225 5/2 x3');
  await endSession(page);
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(3);

  // Rename set 1's EXERCISE and correct its weight. The gap keyed the buffer lookup on the
  // already-edited name, so the row missed its entry and BOTH edits were dropped (this is the
  // unknown-lift "check the name before saving" flow).
  await expandEditor(page);
  await cell(page, 0, '.set-exercise').fill('Incline Bench Press');
  await cell(page, 0, '.set-weight').fill('230');

  await logSet(page, 'bench 225 5/2 x1');
  await endSession(page);
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(4);
  await expandEditor(page);

  await expect(cell(page, 0, '.set-exercise')).toHaveValue('Incline Bench Press'); // name preserved
  await expect(cell(page, 0, '.set-weight')).toHaveValue('230');                   // and its numeric edit

  await page.locator('.rv-save').click();
  await expect.poll(() => capture.writeRequests.length).toBe(1);
  expect(capture.writeRequests[0].log_rows[0].exercise).toBe('Incline Bench Press');
  expect(capture.writeRequests[0].log_rows[0].weight).toBe('230');
});
