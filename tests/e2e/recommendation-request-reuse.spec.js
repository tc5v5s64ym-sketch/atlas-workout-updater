const { test, expect } = require('@playwright/test');

// C4 — THE SAME QUESTION, ASKED ONCE.
//
// The captured manifest shows `GET /api/recommend/next/{code}` issued TWICE for every lift,
// with identical parameters, because both sets of a pair were logged at the same load:
//
//     …/SQ01?intentId=work_day&w=225&reps=5&rir=2   @  8.2 s  and  @ 10.1 s
//     …/OHP01?…w=110&reps=6&rir=2                   @ 10.7 s  and  @ 11.8 s
//     …and RDL01, IDB01, SR01, BC01 the same.
//
// Between each pair sit only test_mode previews and observation writes — nothing that can
// change the answer. Six reads for six answers already on screen, against a 60-per-minute
// quota.
//
// This spec counts the requests the browser really makes, and it pins BOTH halves of the
// rule, because only the first half saves reads and only the second half keeps it honest:
//
//   1. logging the same set twice asks once;
//   2. logging a DIFFERENT set asks again — the weight is in the URL;
//   3. after a live Save the same question is asked again — the Save changed the answer.

const TEST_KEY = 'playwright-test-key';
const SESSION = 'PW-E2E-SESSION';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

// The parser echoes back whatever weight the text carried, so a "different set" really is
// different all the way to the recommendation URL.
function setsFromText(text) {
  const m = String(text || '').match(/(\d+)\s+(\d+)\/(\d+)/);
  if (!m) return [{ weight: 225, reps: 5, rir: 2 }];
  return [{ weight: Number(m[1]), reps: Number(m[2]), rir: Number(m[3]) }];
}

async function openApp(page, capture) {
  capture.recommendUrls = [];
  capture.writes = [];
  await page.route('**/health', r => r.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const body = req.method() === 'POST' && req.postData() ? req.postDataJSON() : null;

    if (path.startsWith('/api/recommend/next/')) {
      capture.recommendUrls.push(path + url.search);
      return route.fulfill(json({
        status: 'success',
        data: { liftCode: path.split('/').pop(), recommendation: 'hold', next_target: { weight: 225, reps: 5, sets: 3 } },
      }));
    }
    if (path === '/api/parse-workout-text') {
      return route.fulfill(json({
        status: 'success',
        data: {
          // The dry-run proof. It is what excuses this request from stepping the inputs
          // epoch, so a preview between two identical questions does not force a re-ask.
          test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
          parsed: {
            intent: 'log_sets', raw_name: 'bench', canonical_name: 'Bench Press',
            exercise: 'Bench Press', sets: setsFromText(body?.text),
          },
        },
      }));
    }
    if (path === '/api/log-workout' && req.method() === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        const preview = (body.log_rows || []).map(r => [
          r.date_clean || '2026-06-12', r.session_id || SESSION, r.exercise, r.exercise,
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
          sheet_write: 'success', sheet_written: true, write_authority: 'supabase_transaction', session_id: body.session_id || SESSION,
          log_rows_written: (body.log_rows || []).length,
          logAppendedRange: 'Log_Cleaned!A200:L201',
          log_write_verification: {
            verified: true, authority: 'append_receipt', reason: null,
            range: 'Log_Cleaned!A200:L201', rows_written: (body.log_rows || []).length,
            rows_submitted: (body.log_rows || []).length,
          },
        },
      }));
    }
    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] } }));
    }
    if (path === '/api/session/compile') {
      return route.fulfill(json({ status: 'success', data: { workout_text: 'bench 225 5/2' } }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), TEST_KEY);
  await page.goto('/app/');
}

async function logSet(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible({ timeout: 15_000 });
}

const asked = (capture, code) => capture.recommendUrls.filter(u => u.includes(`/${code}?`) || u.endsWith(`/${code}`)).length;

test('logging the same set twice asks the engine once; a different set asks again', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture, 'BEN01'), { timeout: 10_000 }).toBe(1);
  const first = capture.recommendUrls[capture.recommendUrls.length - 1];

  // The identical set again. Nothing between the two questions can change the answer: the
  // parser preview and the closeout preview both carry the dry-run proof.
  await logSet(page, 'bench 225 5/2');
  await page.waitForTimeout(1200);
  expect(asked(capture, 'BEN01')).toBe(1);

  // A DIFFERENT set is a different question — the weight is in the URL.
  await logSet(page, 'bench 235 5/2');
  await expect.poll(() => asked(capture, 'BEN01'), { timeout: 10_000 }).toBe(2);
  expect(capture.recommendUrls[capture.recommendUrls.length - 1]).not.toBe(first);
  expect(capture.recommendUrls[capture.recommendUrls.length - 1]).toContain('w=235');
});

test('a live Save makes the same question worth asking again', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture, 'BEN01'), { timeout: 10_000 }).toBe(1);
  const beforeSave = capture.recommendUrls[capture.recommendUrls.length - 1];

  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await expect(page.locator('.review')).toBeVisible({ timeout: 15_000 });
  await page.locator('.rv-save').click();
  await expect.poll(() => capture.writes.length, { timeout: 10_000 }).toBe(1);

  // The Save wrote Log_Cleaned — a tab the engine reads. Asking the same question again is
  // now a DIFFERENT question, and the answer must come from the server.
  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => capture.recommendUrls.filter(u => u === beforeSave).length, { timeout: 10_000 })
    .toBeGreaterThan(1);
});
