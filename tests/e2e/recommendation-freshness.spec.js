const { test, expect } = require('@playwright/test');

// C4 FRESHNESS — the two ways a reused recommendation could be stale.
//
// `tests/e2e/recommendation-request-reuse.spec.js` proves the reuse SAVES the reads it
// claims. This file proves it is safe, against the two holes the exact-head review found in
// the cache identity:
//
//   A. MUTATION RACE. The inputs epoch steps when a non-GET SETTLES. Between issuing a Save
//      and its response the epoch still reads pre-write, so a key of (URL, epoch) alone
//      could hand back an answer computed before the athlete's own write — during exactly
//      the window where it matters most.
//   B. DAY ROLLOVER. `recommendNextSet` decides staleness against the effective current
//      day, and the identity carried neither a day nor any expiry, so an answer could
//      outlive the day it was computed in.
//
// Both are now part of the identity: the owner's day is in the key, and no hit is allowed
// while anything that might mutate is unresolved. What must NOT change is the reuse a
// `test_mode` preview survives — that is the whole read saving, and it is asserted here too.
//
// Every case counts the requests the browser really makes. The server stays the winning
// authority throughout: nothing here computes a recommendation, it only decides whether to
// ask again.

const TEST_KEY = 'playwright-test-key';
const SESSION = 'PW-E2E-SESSION';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

function setsFromText(text) {
  const m = String(text || '').match(/(\d+)\s+(\d+)\/(\d+)/);
  if (!m) return [{ weight: 225, reps: 5, rir: 2 }];
  return [{ weight: Number(m[1]), reps: Number(m[2]), rir: Number(m[3]) }];
}

/**
 * @param {object} control
 *   control.holdWrite  — when true, the live Save hangs until `release()` is called, so the
 *                        "mutation in flight" window can be observed rather than raced.
 *   control.failWrite  — when true, the live Save answers 500 (a mutation that did not settle
 *                        cleanly must not leave reuse enabled on a maybe-written sheet).
 *   control.abortLiveWrite   — when true, the live Save fails at TRANSPORT (no HTTP status).
 *                        A live write is never retried, so this is the ambiguous case: it
 *                        must still invalidate.
 *   control.abortFirstPreview — when true, the FIRST preview attempt fails at transport. The
 *                        client retries a `test_mode` preview exactly once, and the retry
 *                        carries the dry-run proof, so the reuse must survive.
 */
async function openApp(page, capture, control = {}) {
  capture.recommendUrls = [];
  capture.writes = [];
  capture.previewAttempts = 0;
  capture.releaseWrite = null;

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
        data: {
          liftCode: path.split('/').pop(),
          recommendation: `answer #${capture.recommendUrls.length}`,
          next_target: { weight: 225, reps: 5, sets: 3 },
        },
      }));
    }
    if (path === '/api/parse-workout-text') {
      return route.fulfill(json({
        status: 'success',
        data: {
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
        capture.previewAttempts += 1;
        // A TRANSPORT failure — aborted, so the client sees no HTTP status at all. That is
        // the only failure shape the client retries, and it retries a preview exactly once.
        if (control.abortFirstPreview && capture.previewAttempts === 1) return route.abort('failed');
        const preview = (body.log_rows || []).map(r => [
          r.date_clean || '2026-06-12', r.session_id || SESSION, r.exercise, r.exercise,
          'Chest', 'BEN01', r.set_number, r.weight, r.reps, r.rir, r.notes, '',
        ]);
        return route.fulfill(json({
          status: 'success',
          data: {
            // The W1–W3 dry-run proof. This is what lets reuse survive a preview.
            test_mode: true, sheet_write: 'skipped', sheet_written: false,
            no_write_confirmed: true, warnings: [], auto_matches: [], pending_exercises: [],
            rule_flags: [], log_rows_preview: preview,
          },
        }));
      }
      capture.writes.push(body);
      if (control.holdWrite) {
        await new Promise(resolve => { capture.releaseWrite = resolve; });
      }
      if (control.abortLiveWrite) return route.abort('failed');
      if (control.failWrite) {
        return route.fulfill(json({ status: 'error', message: 'sheet unavailable' }, 500));
      }
      return route.fulfill(json({
        status: 'success',
        data: {
          sheet_write: 'success', sheet_written: true, write_authority: 'supabase_transaction', session_id: body.session_id || SESSION,
          write_id: body.write_id,
          log_rows_written: (body.log_rows || []).length,
          logAppendedRange: 'Log_Cleaned!A200:L201',
          log_write_verification: {
            verified: true, authority: 'supabase_transaction', reason: null,
            range: null, rows_written: (body.log_rows || []).length,
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
  if (control.clockScript) await page.addInitScript(control.clockScript);
  await page.goto('/app/');
}

// COUNT THE QUESTION, NOT THE TRAFFIC. A closeout fires a bare `/api/recommend/next/{code}`
// sweep and the post-Save verdict strip fires another — both legitimate, both different
// questions. What these tests are about is the PARAMETERISED question a logged set asks, so
// that exact URL is what is counted.
const SET_QUESTION = '/api/recommend/next/BEN01?w=225&reps=5&rir=2';
const asked = capture => capture.recommendUrls.filter(u => u === SET_QUESTION).length;

async function logSet(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible({ timeout: 15_000 });
}

async function startSave(page) {
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await expect(page.locator('.review')).toBeVisible({ timeout: 15_000 });
  await page.locator('.rv-save').click();
}

// ── A. the mutation race ────────────────────────────────────────────────────
test('no cached answer is served while a live write is still in flight', async ({ page }) => {
  const capture = {};
  await openApp(page, capture, { holdWrite: true });

  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(1);

  // Start the Save and leave it hanging: the write is issued, unresolved, and the inputs
  // epoch has NOT stepped yet. This is the whole window the race lives in.
  await startSave(page);
  await expect.poll(() => capture.writes.length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => Boolean(capture.releaseWrite), { timeout: 10_000 }).toBe(true);

  // The same question, asked mid-write. It must reach the server, not the cache.
  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(2);

  await page.evaluate(() => {});      // let the page settle before releasing
  await capture.releaseWrite();
});

test('the same question after the write settles reaches the server too', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(1);

  await startSave(page);
  await expect.poll(() => capture.writes.length, { timeout: 10_000 }).toBe(1);
  await expect(page.locator('.review.done')).toBeVisible({ timeout: 10_000 });

  // The Save wrote Log_Cleaned — a tab the engine reads — so the epoch stepped and the
  // identical question is a different question now.
  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(2);
});

test('a FAILED write also forces the next question to the server', async ({ page }) => {
  const capture = {};
  await openApp(page, capture, { failWrite: true });

  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(1);

  await startSave(page);
  await expect.poll(() => capture.writes.length, { timeout: 10_000 }).toBe(1);

  // A write that answered 500 proves nothing about whether rows landed. Treating it as
  // "no change" would be the optimistic reading, and the wrong one.
  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(2);
});

// ── B. the day rollover ─────────────────────────────────────────────────────
//
// The clock is moved forward a day INSIDE the page before it loads, then advanced by
// overriding Date at runtime — the recommendation identity must not survive the transition.
test('an answer does not survive the owner-day rollover', async ({ page }) => {
  const capture = {};
  await openApp(page, capture, {
    clockScript: () => {
      // A controllable "today": the page reads it through Date, and the test advances it.
      const RealDate = Date;
      let offsetMs = 0;
      window.__advanceDay = () => { offsetMs += 24 * 60 * 60 * 1000; };
      // eslint-disable-next-line no-global-assign
      window.Date = class extends RealDate {
        constructor(...args) {
          if (args.length === 0) super(RealDate.now() + offsetMs);
          else super(...args);
        }
        static now() { return RealDate.now() + offsetMs; }
      };
    },
  });

  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(1);

  // Same question, same day, nothing written: reused, no new request.
  await logSet(page, 'bench 225 5/2');
  await page.waitForTimeout(1200);
  expect(asked(capture)).toBe(1);

  // Midnight passes. The engine's staleness reasoning is now against a different day, so
  // the identical URL is a different question and must be asked again.
  await page.evaluate(() => window.__advanceDay());
  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(2);
});

// ── C. one settlement verdict per logical request ───────────────────────────
//
// The client retries a `test_mode` preview once when it fails at TRANSPORT (the live
// cold-start case: the instance is waking, mobile Safari kills the hanging fetch with no
// HTTP status). That retry re-enters `api()`, and the attempt that handed off must not
// settle the epoch a second time from its own empty result — the attempt that actually got
// an answer owns the verdict. Otherwise a proven no-write is thrown away and the reuse C4
// depends on is invalidated by a network hiccup.
test('a transport-retried preview keeps its dry-run proof, and the reuse survives', async ({ page }) => {
  const capture = {};
  await openApp(page, capture, { abortFirstPreview: true });

  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(1);

  // Build the review WITHOUT saving. This is the `test_mode` dry-run preview of
  // /api/log-workout — the only client call that carries `retryTransport`. Its first
  // attempt is aborted at transport, so reaching the review panel at all proves the retry
  // ran and succeeded. The 1.5 s backoff is why this waits longer than the others.
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await expect(page.locator('.review')).toBeVisible({ timeout: 25_000 });
  expect(capture.previewAttempts, 'the aborted attempt and its retry').toBeGreaterThan(1);

  // Two transport attempts, ONE logical request, and the answer it finally got carried the
  // W1–W3 dry-run proof — so nothing a recommendation reads can have changed. Before the
  // fix the outer attempt settled a second time with its own empty result and stepped the
  // epoch anyway, so this identical question went back to the server for nothing.
  await logSet(page, 'bench 225 5/2');
  await page.waitForTimeout(1500);
  expect(asked(capture)).toBe(1);
  expect(capture.writes.length, 'nothing was saved live').toBe(0);
});

test('an AMBIGUOUS live write — failed at transport, never retried — still invalidates', async ({ page }) => {
  const capture = {};
  await openApp(page, capture, { abortLiveWrite: true });

  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(1);

  await startSave(page);
  await expect.poll(() => capture.writes.length, { timeout: 10_000 }).toBe(1);

  // A live write is never transport-retried, so this settles with no response at all. It
  // proves nothing about whether rows landed, and the pessimistic reading is the only
  // honest one: the next identical question must reach the server.
  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 15_000 }).toBe(2);
});

// ── the reuse that must NOT be lost ─────────────────────────────────────────
test('a dry-run preview proves it wrote nothing, and reuse survives it', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page, 'bench 225 5/2');
  await expect.poll(() => asked(capture), { timeout: 10_000 }).toBe(1);

  // Several previews — each a POST that settles with no_write_confirmed + sheet_written
  // false. None of them may cost a re-ask, or the whole C4 saving disappears.
  await logSet(page, 'bench 225 5/2');
  await logSet(page, 'bench 225 5/2');
  await page.waitForTimeout(1200);
  expect(asked(capture)).toBe(1);
  expect(capture.writes.length).toBe(0);
});
