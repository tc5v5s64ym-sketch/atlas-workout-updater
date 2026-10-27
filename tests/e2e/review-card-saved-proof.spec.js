const { test, expect } = require('@playwright/test');

// ── QA-3: the review card may claim "Saved" only on proof from its own write ──
//
// Live incident (2026-10-26): an Overhead Press preview card flipped to
// "✓ Saved to your sheet" although ZERO rows were written, on a
// POST /api/log-workout that returned 200. Two client mechanisms allowed it,
// and this spec pins both shut:
//
//   (a) The card's #logger-status observer called markReviewSaved() on ANY
//       `.status-msg.ok` — including ok statuses from unrelated actions (a
//       later "log it" compile writes 'Compiling session from conversation…'
//       as `.ok`). No write was required at all. The card now keys off the
//       `data-atlas-state` marker, the same discipline the ledger-unverified
//       warn already uses (see closeout-retry-card-state.spec.js): only an ok
//       carrying `write-confirmed` may mark the card saved.
//
//   (b) The approve handler waived its rows-written proof for the duplicate
//       response shape. The server's all-rows-duplicate lane completes with
//       log_rows_written: 0 and returns 200, so a zero-append outcome was
//       displayed as a save. The handler now tags that outcome
//       `already-logged`, and the card surfaces its true state — the workout
//       IS in the log, but this save wrote nothing — never `done`.
//
// The write outcomes below are the server's real response shapes (pinned at
// the route in test/logWorkoutDuplicateOutcomeSheets.test.js).
//
// S3 backport (PR #1313 → s3-maintenance): the fixtures carry S3's Sheets-lane
// fields (no `write_authority` — S3 never emits it), and the saved claim text
// is S3's "Saved to your sheet".

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

// `capture.writeOutcome` selects the LIVE write response shape:
//   'saved'         → the ordinary proven save (rows written by this write)
//   'all-duplicate' → 200, completed, ZERO rows written (the incident shape)
//   'dup-echo'      → a duplicate replay whose echo carries the original
//                     write's rows-written count (a lost-response retry)
async function mockAtlasApis(page, capture) {
  capture.writeRequests = capture.writeRequests || [];
  capture.writeOutcome = capture.writeOutcome || 'saved';

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
      const base = {
        session_id: body.session_id || TEST_SESSION,
        write_id: body.write_id,
        idempotency_status: 'completed',
        closeout_fully_verified: true,
      };
      if (capture.writeOutcome === 'seal-unverified') {
        // Rows committed, plan-ledger seal unverified and RETRYABLE — the
        // F10D shape `closeoutSealIsRetryable` reads (see the sibling spec).
        return route.fulfill(json({
          status: 'success',
          data: {
            ...base,
            duplicate_write: false,
            sheet_write: 'success', sheet_written: true,
            log_rows_written: 3, effort_rows_written: 0,
            closeout_fully_verified: false,
            ledger_seal: { sealed: 0, already_sealed: 0, sealed_ok: false, reason: 'ledger_read_failed' },
          }
        }));
      }
      if (capture.writeOutcome === 'all-duplicate') {
        return route.fulfill(json({
          status: 'success',
          data: {
            ...base,
            duplicate_write: true, all_rows_duplicate: true,
            sheet_write: 'skipped_duplicate', sheet_written: false,
            original_sheet_write: 'success',
            log_rows_written: 0, effort_rows_written: 0, skipped_duplicates: 3,
          }
        }));
      }
      if (capture.writeOutcome === 'dup-echo') {
        return route.fulfill(json({
          status: 'success',
          data: {
            ...base,
            duplicate_write: true,
            sheet_write: 'skipped_duplicate', sheet_written: false,
            original_sheet_write: 'success',
            log_rows_written: 3, effort_rows_written: 0,
          }
        }));
      }
      return route.fulfill(json({
        status: 'success',
        data: {
          ...base,
          duplicate_write: false,
          sheet_write: 'success', sheet_written: true,
          log_rows_written: 3, effort_rows_written: 0,
        }
      }));
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

// Raise a review card and leave it UNSAVED.
async function raiseCard(page) {
  await page.locator('#workout-text').fill('bench 225 5/2 x3');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  const review = page.locator('.review').last();
  await expect(review).toBeVisible();
  await expect(review.locator('.rv-note')).toContainText('Nothing');
  return review;
}

async function logAndSave(page) {
  const review = await raiseCard(page);
  await review.locator('.rv-save').click();
  return review;
}

// Inject a status into #logger-status directly — the thing under test in the
// first and last tests is the observer's DISCRIMINATION, not any one emitter
// (the closeout-retry spec establishes this technique for the warn marker).
// The genuine end-to-end paths are covered by the save tests between them.
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

test('QA-3 (a): an UNMARKED ok from an unrelated action never flips an unsaved card to Saved', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  const review = await raiseCard(page);

  // The incident shape: a later "log it" compile writes this exact `.ok`.
  await putStatus(page, 'ok', 'Compiling session from conversation…');
  await expect(page.locator('#logger-status .status-msg.ok')).toBeVisible();
  await expect(review).not.toHaveClass(/done/);
  await expect(review.locator('.rv-note')).toContainText('Nothing');

  // Even an ok whose PROSE claims a save must not flip the card — the marker,
  // not the wording, is the proof. (The pre-fix observer flipped on both.)
  await putStatus(page, 'ok', 'Workout saved. ✓');
  await expect(review).not.toHaveClass(/done/);
  await expect(review.locator('.rv-saved')).toBeHidden();
  await expect(review.locator('.rv-note')).toContainText('Nothing');

  // The positive control: the SAME prose WITH the write-confirmed marker flips
  // it — proving the assertions above are not passing against a dead observer.
  await putStatus(page, 'ok', 'Workout saved. ✓', 'write-confirmed');
  await expect(review).toHaveClass(/done/);
  await expect(review.locator('.rv-saved')).toBeVisible();

  expect(capture.writeRequests).toHaveLength(0);
});

test('QA-3: a proven save marks the card Saved through the real approve path', async ({ page }) => {
  const capture = { writeOutcome: 'saved' };
  await openApp(page, capture);
  const review = await logAndSave(page);

  await expect(review).toHaveClass(/done/);
  await expect(review.locator('.rv-saved')).toBeVisible();
  await expect(review.locator('.rv-saved')).toContainText('Saved to your sheet');
  await expect(page.locator('#logger-status .status-msg.ok')).toHaveAttribute('data-atlas-state', 'write-confirmed');
  expect(capture.writeRequests).toHaveLength(1);
});

test('QA-3 (b): an all-duplicate save (200, zero rows written) shows Already logged — never Saved', async ({ page }) => {
  const capture = { writeOutcome: 'all-duplicate' };
  await openApp(page, capture);
  const review = await logAndSave(page);

  // The write WAS accepted by the server and the workout IS in the log — from
  // an earlier write. This save appended nothing, so the card must not wear
  // the Saved claim.
  await expect(review).not.toHaveClass(/done/);
  await expect(review).toHaveClass(/already-logged/);
  await expect(review.locator('.rv-saved')).toBeHidden();
  const note = review.locator('.rv-note');
  await expect(note).toContainText('Already logged');
  await expect(note).toContainText('nothing new');
  await expect(note).not.toContainText('Nothing’s saved yet');
  const saveBtn = review.locator('.rv-save');
  await expect(saveBtn).toBeDisabled();
  await expect(saveBtn).toHaveText('Already logged');
  await expect(page.locator('#logger-status .status-msg.ok')).toHaveAttribute('data-atlas-state', 'already-logged');
  expect(capture.writeRequests).toHaveLength(1);
});

test('QA-3 (b): a duplicate replay whose echo proves the original rows DOES mark the card Saved', async ({ page }) => {
  const capture = { writeOutcome: 'dup-echo' };
  await openApp(page, capture);
  const review = await logAndSave(page);

  // The retried write_id replays, and its own response carries the original
  // write's log_rows_written: 3 — proof from that card's own write response
  // that rows were written for that write.
  await expect(review).toHaveClass(/done/);
  await expect(review.locator('.rv-saved')).toBeVisible();
  await expect(review.locator('.rv-saved')).toContainText('Saved to your sheet');
  expect(capture.writeRequests).toHaveLength(1);
});

test('QA-3 × F10D: a seal retry landing in the all-duplicate lane still completes a rows-written card', async ({ page }) => {
  const capture = { writeOutcome: 'seal-unverified' };
  await openApp(page, capture);
  const review = await logAndSave(page);

  // First approval: rows committed, seal unverified — the card holds claim (1)
  // and the retry stays reachable.
  await expect(review).toHaveClass(/rows-written/);
  await expect(review).not.toHaveClass(/done/);

  // The retry's REAL server shape is the all-rows-duplicate lane (zero
  // re-appends, seal re-attempted, closeout verified) — not a fresh success
  // body. For THIS card the already-logged verdict completes the save it
  // already proved; it must not strand the card in the already-logged state.
  capture.writeOutcome = 'all-duplicate';
  await review.locator('.rv-save').click();

  await expect(review).toHaveClass(/done/);
  await expect(review.locator('.rv-saved')).toBeVisible();
  await expect(review.locator('.rv-saved')).toContainText('Saved to your sheet');
  expect(capture.writeRequests).toHaveLength(2);
  expect(capture.writeRequests[1].write_id).not.toBe(capture.writeRequests[0].write_id);
});

test('QA-3: an unmarked ok reporting an undo still reads as Undone after a proven save', async ({ page }) => {
  const capture = { writeOutcome: 'saved' };
  await openApp(page, capture);
  const review = await logAndSave(page);
  await expect(review).toHaveClass(/done/);

  // handleUndoLastWrite's status carries no marker; its prose is the signal,
  // exactly as before — the proof gating must not strand the undo reading.
  await putStatus(page, 'ok', 'Last write undone.');
  await expect(review.locator('.rv-saved-txt')).toContainText('Undone');
});
