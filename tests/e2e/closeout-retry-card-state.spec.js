const { test, expect } = require('@playwright/test');

// ── The review card must never imply the workout was lost ─────────────────────
//
// When a session closeout writes its rows but the plan-ledger seal cannot be
// verified, app.js keeps the write ALIVE for a retry: the rows are committed, a
// fresh write_id is staged, #approve-btn is re-enabled and relabelled 'Retry ledger
// seal', and #logger-status gets a `warn` saying the sets are safe.
//
// The review card is what the owner actually looks at, and it did not hear any of
// that. Its #logger-status observer matched only `.status-msg.ok` and
// `.status-msg.error`, so on the `warn` it kept its pre-save body — including the
// note "Nothing's saved yet · this is the only save". That sentence was now FALSE.
// The owner saw a card telling him nothing had been saved, next to a button asking
// him to act, with nothing anywhere saying his sets were already in the sheet, and
// reported the session as lost.
//
// F-SB1-B fixed half of it — the button label is mirrored from #approve-btn, so the
// card no longer sits on 'Saving…'. This covers the other half: the card must state
// the two facts that are true, and must NOT go `done` (which would hide the retry
// and claim a verification that did not happen).
//
// The card keys off `data-atlas-state="rows-written-ledger-unverified"`, never the
// message prose — `warn` is also how a parse failure and an unrecognized exercise
// are reported, and those happen before any write, where the original note is true.
// The last test in this file is that distinction.

const TEST_KEY = 'playwright-test-key';
const TEST_SESSION = 'PW-E2E-SESSION';
const TEST_DATE = '2026-06-12';

const BENCH_SETS = [
  { weight: 225, reps: 5, rir: 2 },
  { weight: 225, reps: 5, rir: 2 },
  { weight: 225, reps: 5, rir: 2 }
];

const benchRows = (session) => BENCH_SETS.map((set, index) => ([
  TEST_DATE, session, 'Bench Press', 'Bench Press', 'Chest', 'BEN01',
  index + 1, set.weight, set.reps, set.rir, '', set.weight * set.reps
]));

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

// `capture.closeoutVerified` drives the write response:
//   false → rows committed, seal unverified, RETRYABLE (the state under test)
//   true  → the ordinary fully-verified save
// A test flips it between writes to drive the retry-then-succeed path.
async function mockAtlasApis(page, capture) {
  capture.writeRequests = capture.writeRequests || [];
  capture.closeoutVerified = capture.closeoutVerified ?? false;

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData() ? request.postDataJSON() : null;

    if (path === '/api/parse-workout-text') {
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
          parsed: { intent: 'log_sets', raw_name: 'bench', canonical_name: 'Bench Press', exercise: 'Bench Press', sets: BENCH_SETS }
        }
      }));
    }

    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        return route.fulfill(json({
          status: 'success',
          data: {
            test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true,
            warnings: [], auto_matches: ['bench -> Bench Press'], pending_exercises: [], rule_flags: [],
            log_rows_preview: benchRows(body.session_id || TEST_SESSION)
          }
        }));
      }
      capture.writeRequests.push(body);
      const data = {
        sheet_write: 'success',
        sheet_written: true,
        session_id: body.session_id || TEST_SESSION,
        log_rows_written: 3,
        logAppendedRange: 'Log_Cleaned!A200:L202',
      };
      if (!capture.closeoutVerified) {
        // The rows landed. The seal did not verify, and it is RETRYABLE — the shape
        // `closeoutSealIsRetryable` reads: a seal that is not a confirmed no-ledger
        // success. This is what a transient Sheets read failure produces.
        data.closeout_fully_verified = false;
        data.ledger_seal = { sealed: 0, already_sealed: 0, sealed_ok: false, reason: 'ledger_read_failed' };
      } else {
        data.closeout_fully_verified = true;
      }
      return route.fulfill(json({ status: 'success', data }));
    }

    if (path === '/api/log-workout/verify-range') {
      return route.fulfill(json({ status: 'success', data: { verified: true } }));
    }

    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] } }));
    }

    if (path === '/api/progress/summary') {
      return route.fulfill(json({ ok: true, data: { total_sessions: 42, average_sessions_per_week: 3.2, total_sets: 510, current_week_sessions: 3, weekly_streak: 4, streak_target_per_week: 3, sessions_by_week: [] } }));
    }

    if (path === '/api/plan/intent-recommendation') {
      return route.fulfill(json({
        status: 'success',
        data: {
          todays_read: { recommended_label: 'Push', recommended_reason: 'Bench is ready.', patterns: [] },
          intents: [{ label: 'Push', focus: 'Accessories', recommended: true, why_today: ['Pressing is fresh'], exercises: [{ exercise: 'Pallof Press', lift_code: 'PAL01', target_weight: 65, target_reps: 15, target_sets: 3, target_rir: 2 }] }]
        }
      }));
    }

    if (path.startsWith('/api/recommend/next/')) {
      return route.fulfill(json({ status: 'success', data: { liftCode: 'BEN01', exercise_name: 'Bench Press', recommendation: 'Hold 225.', last_working_sets: [{ weight: 225, reps: 5, rir: 2 }], next_target: { weight: 225, reps: 5, sets: 3 }, reasoning: 'mock', sessions_analyzed: 3 } }));
    }

    if (path === '/api/coach/message') {
      return route.fulfill(json({ status: 'success', data: { message: null, configured: false } }));
    }

    if (path === '/api/session/compile') {
      return route.fulfill(json({ status: 'success', data: { workout_text: 'bench 225 5/2 x3' } }));
    }

    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function openApp(page, capture) {
  await mockAtlasApis(page, capture);
  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
}

// Log a set, close the session out ("done" raises the review card), then Save.
async function logAndSave(page) {
  await page.locator('#workout-text').fill('bench 225 5/2 x3');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await page.locator('.review:not(.done)').last().locator('.rv-save').click();
}

test('unverified closeout: the card says the sets ARE saved, and never that nothing was saved', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await logAndSave(page);

  const review = page.locator('.review').last();
  await expect(review).toHaveClass(/rows-written/);

  const note = review.locator('.rv-note');
  await expect(note).toBeVisible();
  // The claim that made a real session read as lost.
  await expect(note).not.toContainText('Nothing');
  // …replaced by the two facts that are true.
  await expect(note).toContainText('saved to the sheet');
  await expect(note).toContainText('retry');
  expect(capture.writeRequests).toHaveLength(1);
});

test('unverified closeout: the card is NOT marked done — the retry stays reachable and no verification is claimed', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await logAndSave(page);

  const review = page.locator('.review').last();
  // `done` would hide `.rv-act` (killing the retry) and reveal "✓ Saved to your
  // sheet" — a claim that the plan-ledger verification succeeded. It did not.
  await expect(review).not.toHaveClass(/done/);
  await expect(review.locator('.rv-saved')).toBeHidden();
  await expect(review.locator('.rv-act')).toBeVisible();
});

test('unverified closeout: the Save button reads Retry ledger seal and is tappable, never stuck on Saving…', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await logAndSave(page);

  const saveBtn = page.locator('.review').last().locator('.rv-save');
  await expect(saveBtn).toBeEnabled();
  await expect(saveBtn).toHaveText('Retry ledger seal');
  await expect(saveBtn).not.toHaveText('Saving…');
});

test('unverified closeout: a successful retry completes the card, and appends no duplicate rows', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await logAndSave(page);

  const review = page.locator('.review').last();
  await expect(review).toHaveClass(/rows-written/);

  // The seal comes back verified on the retry.
  capture.closeoutVerified = true;
  await review.locator('.rv-save').click();

  await expect(review).toHaveClass(/done/);
  await expect(review.locator('.rv-saved')).toBeVisible();
  await expect(review.locator('.rv-saved')).toContainText('Saved to your sheet');

  // Two requests, and the retry carries a FRESH write_id — replaying the first id
  // would just replay the recorded failure. The server's duplicate lane is what
  // keeps the rows from doubling; the client's job is to not reuse the id.
  expect(capture.writeRequests).toHaveLength(2);
  expect(capture.writeRequests[1].write_id).not.toBe(capture.writeRequests[0].write_id);
});

// P1 from review of 6800f99. The retry state is deliberately non-`done`, which keeps
// the card's Edit button live — and `handlePreviewReady` replaces any
// `.review:not(.done)` with a freshly built card. So editing and re-previewing from
// the retry state handed the owner a brand-new card reading "Nothing's saved yet"
// over rows that were already committed: the exact false claim this PR removes,
// restored one tap later.
//
// The fix holds the fact at session scope, not card scope. This drives the real
// re-preview through the real app.
test('unverified closeout: a re-preview cannot resurrect the "nothing saved yet" claim', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await logAndSave(page);

  await expect(page.locator('.review').last()).toHaveClass(/rows-written/);

  // Re-preview exactly as the owner would after tapping Edit: change the rows and
  // send them again. handlePreviewReady tears the card down and rebuilds it.
  await page.locator('#workout-text').fill('bench 235 5/2 x3');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();

  // The REBUILT card. The rows from the first save are still in the sheet, so the
  // claim it must not make is still the same claim.
  const rebuilt = page.locator('.review').last();
  await expect(rebuilt).toBeVisible();
  await expect(rebuilt).toHaveClass(/rows-written/);
  await expect(rebuilt.locator('.rv-note')).not.toContainText('Nothing');
  await expect(rebuilt.locator('.rv-note')).toContainText('saved to the sheet');
});

// The other direction, and the reason the fact is cleared rather than latched
// forever: a NEW session has committed nothing. Leaking the flag across a reset
// would tell the owner his new sets were already saved before he had saved them —
// the same lie, inverted.
test('a new session starts clean: the committed-rows state never leaks forward', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await logAndSave(page);
  await expect(page.locator('.review').last()).toHaveClass(/rows-written/);

  await page.evaluate(() => document.dispatchEvent(new CustomEvent('atlas:session-reset')));

  await page.locator('#workout-text').fill('bench 245 5/2 x3');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();

  const fresh = page.locator('.review').last();
  await expect(fresh).toBeVisible();
  await expect(fresh).not.toHaveClass(/rows-written/);
  await expect(fresh.locator('.rv-note')).toContainText('Nothing');
});

// THE BITE for keying off the state attribute rather than the `warn` kind.
//
// app.js emits `warn` for at least eleven different outcomes — a parse failure, an
// unrecognized exercise name, an unreadable effort screenshot, "nothing new to log"
// — and every one of them happens BEFORE any write, where the card's original
// "Nothing's saved yet" note is exactly right. Only the marked one means the rows
// are committed. A card that matched `.status-msg.warn` alone would tell the owner
// his sets were safe when nothing had been written, which is the same lie as the
// original defect pointing the other way.
//
// Both statuses are injected directly into #logger-status here, because the thing
// under test is the observer's DISCRIMINATION, not any one warn-producing code path.
// Driving it through a real emitter would prove the discriminator only for whichever
// path was chosen, and would go vacuous the day that path stops emitting `warn`.
// Injecting the two shapes side by side isolates the actual contract. The genuine
// end-to-end path is covered by the four tests above.
async function putStatus(page, kind, text, state) {
  await page.evaluate(({ kind, text, state }) => {
    const box = document.getElementById('logger-status');
    box.innerHTML = '';
    const div = document.createElement('div');
    div.className = `status-msg ${kind}`;
    div.textContent = text;
    if (state) div.setAttribute('data-atlas-state', state);
    box.appendChild(div);
  }, { kind, text, state });
}

test('an UNMARKED warn must not claim the sets are saved; the marked one must', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Raise a review card and leave it unsaved.
  await page.locator('#workout-text').fill('bench 225 5/2 x3');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  const review = page.locator('.review').last();
  await expect(review).toBeVisible();
  await expect(review.locator('.rv-note')).toContainText('Nothing');

  // A pre-write warn, carrying no state marker. Nothing has been written.
  await putStatus(page, 'warn', "I don't recognize \"bnech\" — check the exercise name before it's saved.");
  await expect(page.locator('#logger-status .status-msg.warn')).toBeVisible();
  await expect(review).not.toHaveClass(/rows-written/);
  await expect(review.locator('.rv-note')).toContainText('Nothing');

  // The same kind, now carrying the state marker — and only now may the card move.
  // Asserting the positive here is what stops the bite from passing against a card
  // that simply ignores every warn.
  await putStatus(page, 'warn', 'Workout written ✓ — ledger unverified.', 'rows-written-ledger-unverified');
  await expect(review).toHaveClass(/rows-written/);
  await expect(review.locator('.rv-note')).not.toContainText('Nothing');

  expect(capture.writeRequests).toHaveLength(0);
});
