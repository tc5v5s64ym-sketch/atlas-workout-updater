const { test, expect } = require('@playwright/test');

// F06 follow-up / CLIENT-2 sibling — a row the lifter creates with "+ Add set" in the
// closeout preview must survive logging another set and reach the approved write. Sets
// log conversationally into a buffer; each closeout rebuilds the editable table from that
// buffer (buildRowsFromSessionLog). reconcileSessionLogFromTable folds hand-EDITS of
// existing rows back into the buffer, but a manually ADDED row has no buffer entry, so it
// was skipped and lost on the next rebuild. RED before, GREEN after folding new rows in.

const TEST_KEY = 'playwright-test-key';
const DATE = '2026-06-12';
const SESSION = 'PW-E2E-SESSION';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

// The parser ALWAYS returns Bench Press @ 225 — anything else in the write came from a
// manually added row, never the parser.
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
      return route.fulfill(json({ status: 'success', data: { sheet_write: 'success', sheet_written: true, write_authority: 'supabase_transaction', log_rows_written: (body.log_rows || []).length, logAppendedRange: 'Log_Cleaned!A200:L204' } }));
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

async function addRow(page, { exercise, weight, reps, rir }) {
  await page.locator('#add-set-btn').click();
  const row = page.locator('#sets-table tbody tr').last();
  await row.locator('.set-exercise').fill(exercise);
  await row.locator('.set-weight').fill(String(weight));
  await row.locator('.set-reps').fill(String(reps));
  if (rir != null) await row.locator('.set-rir').fill(String(rir));
}

const rowValues = page => page.locator('#sets-table tbody tr').evaluateAll(trs =>
  trs.map(tr => ({
    exercise: tr.querySelector('.set-exercise').value,
    weight: tr.querySelector('.set-weight').value,
    reps: tr.querySelector('.set-reps').value,
  })));

test('a manually added "+ Add set" row (new exercise) survives logging another set and reaches the write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page, 'bench 225 5/2 x2');
  await endSession(page);
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(2);

  // + Add set a NEW exercise not in the buffer.
  await expandEditor(page);
  await addRow(page, { exercise: 'Cable Fly', weight: 30, reps: 12, rir: 2 });
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(3);

  // Log another set → the buffer rebuild. Before the fix the manual Cable Fly row is lost.
  await logSet(page, 'bench 225 5/2 x1');
  await endSession(page);
  await expandEditor(page);

  // The Cable Fly row must survive: 3 bench + 1 cable fly.
  const rows = await rowValues(page);
  const cable = rows.find(r => r.exercise === 'Cable Fly');
  expect(cable, 'the manually added Cable Fly row survived the rebuild').toBeTruthy();
  expect(cable.weight).toBe('30');
  expect(cable.reps).toBe('12');

  // Save writes exactly the final preview — including the manually added Cable Fly.
  await page.locator('.rv-save').click();
  await expect.poll(() => capture.writeRequests.length).toBe(1);
  const written = capture.writeRequests[0].log_rows;
  const writtenCable = written.find(r => r.exercise === 'Cable Fly');
  expect(writtenCable, 'the write payload contains the manually added row').toBeTruthy();
  expect(writtenCable.weight).toBe('30');
  // Final preview-to-write equality: the write is exactly the rows shown in the preview.
  expect(written.length).toBe(rows.length);
});

test('a manually added row for an EXISTING (duplicate) exercise also survives and reaches the write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page, 'bench 225 5/2 x2');
  await endSession(page);
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(2);

  // + Add set for Bench Press (already in the buffer) — a manual heavier top single at 245.
  await expandEditor(page);
  await addRow(page, { exercise: 'Bench Press', weight: 245, reps: 3, rir: 1 });
  await expect(page.locator('#sets-table tbody tr')).toHaveCount(3);

  await logSet(page, 'bench 225 5/2 x1');
  await endSession(page);
  await expandEditor(page);

  // The manual 245 bench must survive alongside the parser's 225 benches.
  const rows = await rowValues(page);
  const heavy = rows.find(r => r.exercise === 'Bench Press' && r.weight === '245');
  expect(heavy, 'the manually added 245 bench survived the rebuild').toBeTruthy();
  expect(heavy.reps).toBe('3');

  await page.locator('.rv-save').click();
  await expect.poll(() => capture.writeRequests.length).toBe(1);
  const written = capture.writeRequests[0].log_rows;
  const writtenHeavy = written.find(r => r.exercise === 'Bench Press' && r.weight === '245');
  expect(writtenHeavy, 'the write contains the manually added 245 bench').toBeTruthy();
  expect(written.length).toBe(rows.length);
});

test('removing a folded manual row via ✕ drops it for good — no resurrection, not in the write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page, 'bench 225 5/2 x2');
  await endSession(page);
  await expandEditor(page);
  await addRow(page, { exercise: 'Cable Fly', weight: 30, reps: 12, rir: 2 });

  // Log another set → Cable Fly is folded into the buffer; the closeout rebuilds it.
  await logSet(page, 'bench 225 5/2 x1');
  await endSession(page);
  await expandEditor(page);
  let rows = await rowValues(page);
  expect(rows.find(r => r.exercise === 'Cable Fly'), 'Cable Fly was folded + rebuilt').toBeTruthy();

  // Remove the (rebuilt) Cable Fly row via its ✕ button.
  const idx = await page.locator('#sets-table tbody tr').evaluateAll(trs =>
    trs.findIndex(tr => tr.querySelector('.set-exercise').value === 'Cable Fly'));
  expect(idx).toBeGreaterThanOrEqual(0);
  await page.locator('#sets-table tbody tr').nth(idx).locator('.remove-set').click();

  // Log another set and reopen — the removed Cable Fly must NOT resurrect on the rebuild.
  await logSet(page, 'bench 225 5/2 x1');
  await endSession(page);
  await expandEditor(page);
  rows = await rowValues(page);
  expect(rows.find(r => r.exercise === 'Cable Fly'), 'the removed manual row must not resurrect').toBeFalsy();

  // And the approved write must not contain the removed row.
  await page.locator('.rv-save').click();
  await expect.poll(() => capture.writeRequests.length).toBe(1);
  const written = capture.writeRequests[0].log_rows;
  expect(written.find(r => r.exercise === 'Cable Fly'), 'the removed row is absent from the write').toBeFalsy();
  expect(written.length).toBe(rows.length);
});
