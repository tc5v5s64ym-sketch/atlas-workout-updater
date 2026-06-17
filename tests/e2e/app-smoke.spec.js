const { test, expect } = require('@playwright/test');

const TEST_KEY = 'playwright-test-key';
const TEST_SESSION = 'PW-E2E-SESSION';
const TEST_DATE = '2026-06-12';

const BENCH_SETS = [
  { weight: 225, reps: 5, rir: 2 },
  { weight: 225, reps: 5, rir: 2 },
  { weight: 225, reps: 5, rir: 2 }
];

const BENCH_ROWS = BENCH_SETS.map((set, index) => ([
  TEST_DATE,
  TEST_SESSION,
  'Bench Press',
  'Bench Press',
  'Chest',
  'BEN01',
  index + 1,
  set.weight,
  set.reps,
  set.rir,
  '',
  set.weight * set.reps
]));

function json(body, status = 200) {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  };
}

async function mockAtlasApis(page, capture = {}) {
  capture.parseRequests = capture.parseRequests || [];
  capture.previewRequests = capture.previewRequests || [];
  capture.writeRequests = capture.writeRequests || [];

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData()
      ? request.postDataJSON()
      : null;

    if (path === '/api/parse-workout-text') {
      capture.parseRequests.push(body);
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true,
          sheet_written: false,
          no_write_confirmed: true,
          warnings: [],
          parsed: {
            intent: 'log_sets',
            raw_name: 'bench',
            canonical_name: 'Bench Press',
            exercise: 'Bench Press',
            sets: BENCH_SETS
          }
        }
      }));
    }

    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        capture.previewRequests.push(body);
        return route.fulfill(json({
          status: 'success',
          data: {
            test_mode: true,
            sheet_write: 'skipped',
            sheet_written: false,
            no_write_confirmed: true,
            warnings: [],
            auto_matches: ['bench -> Bench Press'],
            pending_exercises: [],
            rule_flags: [],
            log_rows_preview: BENCH_ROWS
          }
        }));
      }

      capture.writeRequests.push(body);
      return route.fulfill(json({
        status: 'success',
        data: {
          sheet_write: 'success',
          sheet_written: true,
          log_rows_written: 3,
          logAppendedRange: 'Log_Cleaned!A200:L202'
        }
      }));
    }

    if (path === '/api/log-workout/verify-range') {
      return route.fulfill(json({ status: 'success', data: { verified: true } }));
    }

    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({
        status: 'success',
        data: {
          exercises: [
            { canonical_name: 'Bench Press', lift_code: 'BEN01' },
            { canonical_name: 'Back Squat', lift_code: 'SQ01' },
            { canonical_name: 'Lat Pulldown', lift_code: 'LPD01' }
          ]
        }
      }));
    }

    if (path === '/api/progress/summary') {
      return route.fulfill(json({
        ok: true,
        data: {
          total_sessions: 42,
          average_sessions_per_week: 3.2,
          total_sets: 510,
          current_week_sessions: 3,
          weekly_streak: 4,
          streak_target_per_week: 3,
          sessions_by_week: [
            { week_start: '2026-05-18', sessions: 3 },
            { week_start: '2026-05-25', sessions: 4 },
            { week_start: '2026-06-01', sessions: 3 },
            { week_start: '2026-06-08', sessions: 3 }
          ]
        }
      }));
    }

    if (path === '/api/plan/intent-recommendation') {
      return route.fulfill(json({
        status: 'success',
        data: {
          todays_read: {
            recommended_label: 'Push',
            recommended_reason: 'Bench is ready for clean repeat work.',
            // Per scoreIntents: readiness lives under todays_read.patterns.
            patterns: [
              { pattern: 'push', label: 'Pressing', status: 'ready', daysSince: 3, detail: '3 days since last session' },
              { pattern: 'pull', label: 'Pulling', status: 'fresh', daysSince: 7, detail: '7 days since last session' },
              { pattern: 'lower', label: 'Lower body', status: 'fatigued', daysSince: 1, detail: 'Trained yesterday — last effort @1 RIR' },
              { pattern: 'core', label: 'Core', status: 'unknown', daysSince: null, detail: 'No training data' }
            ]
          },
          intents: [
            {
              label: 'Push', focus: 'Bench + OHP', recommended: true,
              why_today: ['Pressing patterns are fresh', 'Last bench moved at RIR 2'],
              data_points: [{ label: 'Weekly load', value: '1.1× baseline', context: 'moderate' }],
              exercises: [{ exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 225, target_reps: 5, target_sets: 3, target_rir: 2 }]
            },
            { label: 'Pull', focus: 'Rows + lats', recommended: false }
          ]
        }
      }));
    }

    if (path === '/api/plan/today') {
      return route.fulfill(json({ status: 'success', data: { title: 'Bench day', rows: [] } }));
    }

    if (path === '/api/coaching/insights') {
      return route.fulfill(json({ status: 'success', data: { insights: [] } }));
    }

    if (path === '/api/summary/weekly') {
      return route.fulfill(json({ status: 'success', data: { sessions: 3, total_volume: 12500 } }));
    }

    if (path === '/api/history/recent') {
      return route.fulfill(json({ status: 'success', data: { sessions: [] } }));
    }

    if (path === '/api/prs/recent') {
      return route.fulfill(json({ status: 'success', data: { prs: [] } }));
    }

    if (path === '/api/stalls') {
      return route.fulfill(json({ status: 'success', data: { stalls: [] } }));
    }

    if (path === '/api/coach/message') {
      // Default deployment has no GEMINI_API_KEY, so the endpoint hands back
      // message:null and the client renders its deterministic templated note.
      return route.fulfill(json({ status: 'success', data: { message: null, configured: false } }));
    }

    if (path.startsWith('/api/recommend/next/')) {
      return route.fulfill(json({
        status: 'success',
        data: {
          liftCode: 'BEN01',
          exercise_name: 'Bench Press',
          recommendation: 'Hold 225 and build cleaner 5s.',
          last_working_sets: [{ weight: 225, reps: 5, rir: 2 }],
          next_target: { weight: 225, reps: 5, sets: 3 },
          reasoning: 'Dry-run mock recommendation.',
          sessions_analyzed: 3
        }
      }));
    }

    // End-of-session compile: reconstruct the workout from the conversation.
    if (path === '/api/session/compile') {
      return route.fulfill(json({ status: 'success', data: { workout_text: 'bench 225 5/2 x3' } }));
    }

    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function openApp(page, capture = {}) {
  await mockAtlasApis(page, capture);
  await page.addInitScript(key => {
    localStorage.setItem('atlas_api_key', key);
  }, TEST_KEY);
  await page.goto('/app/');
}

// Session-level flow helpers. Logging a set coaches it in-thread (a readback)
// with NO Save/preview/approve surface; the single review card appears only on
// an explicit END trigger ("done").
async function logSet(page, text = 'bench 225 5/2 x3') {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
}

async function endSession(page) {
  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await expect(page.locator('.review')).toBeVisible();
}

async function runToReview(page, text = 'bench 225 5/2 x3') {
  await logSet(page, text);
  await endSession(page);
}

// The Coach hamburger opens the side panel (drawer); navigation happens by
// tapping a Views row there, which routes through the existing tab controls.
async function openDrawerNav(page, tab) {
  await page.locator('#coach-menu-btn').click();
  await expect(page.locator('#coach-drawer')).toBeVisible();
  await page.locator(`#coach-drawer .drawer-nav-row[data-tab="${tab}"]`).click();
  await expect(page.locator('#coach-drawer')).toBeHidden();
}

test('Coach shell loads with guarded preview state', async ({ page }) => {
  await openApp(page);

  await expect(page.locator('body')).toHaveAttribute('data-surface', 'coach');
  // Minimal Grok/Gemini-style home: empty-state hero + Suggested Workout tiles.
  await expect(page.locator('#coach-empty')).toBeVisible();
  await expect(page.locator('.coach-empty-tagline')).toContainText("Let's get stronger");
  await expect(page.locator('#workout-text')).toBeVisible();
  await expect(page.locator('#suggested-tiles .suggest-tile')).toHaveCount(2);
  await expect(page.locator('#preview-panel')).toBeHidden();
  await expect(page.locator('#approve-btn')).toBeDisabled();
});

test('Suggested Workout types out the why-today rationale', async ({ page }) => {
  await openApp(page);

  await page.locator('.suggest-tile[data-suggest="workout"]').click();
  const bubble = page.locator('#thread-messages .chat-bubble-atlas').first();
  await expect(bubble).toContainText("Today's read: Push");
  // The richer note surfaces the engine's reasoning, readiness, and numbers.
  await expect(bubble).toContainText('Why today:');
  await expect(bubble).toContainText('Pressing patterns are fresh');
  await expect(bubble).toContainText('Readiness:');
  await expect(bubble).toContainText('Weekly load: 1.1× baseline');

  // Structured workout block: bold exercise name + RIR-safe compact set lines.
  await expect(bubble.locator('.workout-plan-name')).toHaveText('Bench Press');
  const setLines = bubble.locator('.workout-plan-set');
  await expect(setLines).toHaveCount(3);                 // target_sets: 3
  await expect(setLines.first()).toHaveText('225lbs 5/2'); // {weight}lbs {reps}/{rir} — RIR never dropped
});

test('Suggested Workout uses the Gemini plan voice when available', async ({ page }) => {
  await openApp(page);
  // Override just the coach endpoint to return a configured plan message.
  await page.route('**/api/coach/message', route => route.fulfill(json({
    status: 'success',
    data: { message: "Heads up — you're at 1.5× your usual load, so today is blood flow, not max effort.", configured: true, kind: 'plan' }
  })));

  await page.locator('.suggest-tile[data-suggest="workout"]').click();
  const bubble = page.locator('#thread-messages .chat-bubble-atlas').first();
  await expect(bubble).toContainText("Today's read: Push");
  await expect(bubble).toContainText('today is blood flow, not max effort'); // Gemini prose
  await expect(bubble.locator('.workout-plan-name')).toHaveText('Bench Press'); // exercises still shown
  await expect(bubble).not.toContainText('Why today:');                       // templated bullets replaced
});

test('Suggested Workout shows /? when the engine gives no RIR — never a bare set line', async ({ page }) => {
  await openApp(page);
  // Override the plan endpoint with an exercise that has no target_rir.
  // Registered after openApp, so this handler wins for this path.
  await page.route('**/api/plan/intent-recommendation', route => route.fulfill(json({
    status: 'success',
    data: {
      todays_read: { recommended_label: 'Pull', recommended_reason: 'Clean pull work.' },
      intents: [{
        label: 'Pull', focus: 'Face pulls', recommended: true,
        exercises: [{ exercise: 'Face Pull', lift_code: 'FAC01', target_weight: 50, target_reps: 15, target_sets: 3 }]
      }]
    }
  })));

  await page.locator('.suggest-tile[data-suggest="workout"]').click();
  const bubble = page.locator('#thread-messages .chat-bubble-atlas').first();
  const setLines = bubble.locator('.workout-plan-set');
  // Exact text match proves RIR is never dropped: "/?" when missing, never a bare "50lbs 15".
  await expect(setLines).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(setLines.nth(i)).toHaveText('50lbs 15/?');
});

test('Chat: a non-loggable question gets a coach reply in-thread and never writes', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Make the parser report "no sets" so the message is treated as a question,
  // not a workout to log. (Registered after openApp, so it wins.)
  await page.route('**/api/parse-workout-text', route => route.fulfill(json({
    status: 'success',
    data: {
      test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
      parsed: { intent: 'needs_clarification', message: 'Could not find sets.' }
    }
  })));

  let chatBody = null;
  await page.route('**/api/coach/chat', route => {
    chatBody = route.request().postDataJSON();
    return route.fulfill(json({
      status: 'success',
      data: { message: 'Your bench has been flat for 3 sessions — try 5×5 at 225 this week.', configured: true, source: 'gemini' }
    }));
  });

  await page.locator('#workout-text').fill('how is my bench trending?');
  await page.locator('#preview-btn').click();

  // The question shows as the lifter's bubble; Atlas answers in-thread.
  await expect(page.locator('#thread-messages')).toContainText('how is my bench trending?');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('flat for 3 sessions');

  // The chat request carried the message — and NOTHING was written or previewed.
  expect(chatBody).toMatchObject({ message: 'how is my bench trending?' });
  await expect(page.locator('#preview-panel')).toBeHidden();
  expect(capture.writeRequests).toHaveLength(0);
});

test('Chat: a coach outage falls back to a deterministic reply, still no write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await page.route('**/api/parse-workout-text', route => route.fulfill(json({
    status: 'success',
    data: {
      test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
      parsed: { intent: 'needs_clarification', message: 'Could not find sets.' }
    }
  })));
  // Coach unconfigured / down → message:null. The chat must not dead-end.
  await page.route('**/api/coach/chat', route => route.fulfill(json({
    status: 'success', data: { message: null, configured: false }
  })));

  await page.locator('#workout-text').fill('hey');
  await page.locator('#preview-btn').click();

  // Deterministic greeting fallback — points the lifter at logging without
  // reading as a format correction. The chat is never a dead end.
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('Log your sets');
  expect(capture.writeRequests).toHaveLength(0);
});

test('Chat: propose_edit updates the preview row and still requires approve to write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Seed a row into the preview table via the global addSetRow function
  await page.evaluate(() => addSetRow({ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 }));

  // Parser returns no-sets → message goes to chat
  await page.route('**/api/parse-workout-text', route => route.fulfill(json({
    status: 'success',
    data: {
      test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
      parsed: { intent: 'needs_clarification', message: 'Could not find sets.' }
    }
  })));

  // Coach returns prose + a structured edit
  await page.route('**/api/coach/chat', route => route.fulfill(json({
    status: 'success',
    data: {
      message: 'Changed set 1 to 235 lbs — looks like a solid bump.',
      propose_edit: { action: 'update_set', index: 0, weight: 235, reps: 5, rir: 2 },
      configured: true,
      source: 'gemini'
    }
  })));

  await page.locator('#workout-text').fill('change set 1 to 235');
  await page.locator('#preview-btn').click();

  // Prose typed out in Atlas bubble
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('solid bump');
  // Edit-applied note visible below the reply
  await expect(page.locator('.edit-applied-note')).toBeVisible();
  // Row 0 weight updated to 235
  await expect(page.locator('.set-weight').first()).toHaveValue('235');
  // Approve button still disabled — lifter must re-preview before saving
  await expect(page.locator('#approve-btn')).toBeDisabled();
  // Zero writes fired
  expect(capture.writeRequests).toHaveLength(0);
});

test('Session preview: logging then "done" renders a no-write review card from mocked APIs', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await logSet(page);
  // Logging a set coaches it — no write, and no preview/Save surface at all.
  await expect(page.locator('#thread-messages')).toContainText('bench 225 5/2 x3');
  await expect(page.locator('#preview-panel')).toBeHidden();
  await expect(page.locator('.save-inline-btn')).toHaveCount(0);
  expect(capture.writeRequests).toHaveLength(0);
  expect(capture.previewRequests).toHaveLength(0);   // no dry-run during logging — client-side coaching

  await endSession(page);
  // The single review card lists the compiled workout. The dry-run proved
  // no-write safety (test_mode + write_id) and still nothing is written.
  const review = page.locator('.review');
  await expect(review).toContainText('Bench Press');
  await expect(review.locator('.rv-tot')).toContainText('3 sets');
  expect(capture.parseRequests.some(r => r && r.text === 'bench 225 5/2 x3' && r.test_mode === true)).toBe(true);
  expect(capture.previewRequests).toHaveLength(1);
  expect(capture.previewRequests[0]).toMatchObject({ test_mode: 'true' });
  expect(capture.previewRequests[0].write_id).toBeTruthy();
  expect(capture.writeRequests).toHaveLength(0);
});

test('Session review surfaces the substitution verdict as a read-only note, and Save still writes once', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Override only the dry-run: classify the logged lift as an abandoned swap.
  // The live-write branch falls through to the default mock unchanged.
  await page.route('**/api/log-workout', async route => {
    const req = route.request();
    const body = req.method() === 'POST' && req.postData() ? req.postDataJSON() : null;
    if (body && (body.test_mode === true || body.test_mode === 'true')) {
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true,
          sheet_write: 'skipped',
          sheet_written: false,
          no_write_confirmed: true,
          warnings: [], auto_matches: [], pending_exercises: [], rule_flags: [],
          log_rows_preview: BENCH_ROWS,
          substitutions: [{
            classification: 'abandoned',
            decision: 'warn',
            reason_code: 'pattern_abandoned',
            prescribed: { name: 'Back Squat' },
            logged: { name: 'Bench Press' },
            muscle_overlap: 0,
            evidence: []
          }]
        }
      }));
    }
    return route.fallback();   // live write handled by the default mock
  });

  await runToReview(page);

  // Engine verdict surfaces. Gemini is unconfigured in CI (coach/message → null),
  // so the templated fallback line renders — proving the fallback path works.
  const note = page.locator('.sub-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('objective untrained');
  await expect(note).toHaveClass(/sub-warn/);
  expect(capture.writeRequests).toHaveLength(0);   // displaying the verdict never writes

  // Approval still works with the note present — Save drives the single write.
  await page.locator('.rv-save').click();
  await expect(page.locator('#logger-status')).toContainText('Workout written to Google Sheets');
  expect(capture.writeRequests).toHaveLength(1);
  expect(capture.writeRequests[0].test_mode).toBeUndefined();
});

test('Approve: the review card Save sends write_id only after the dry-run and shows success', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await runToReview(page);

  const previewWriteId = capture.previewRequests[0].write_id;
  await expect(page.locator('#approve-btn')).toBeEnabled();
  // The review card's Save is the write CTA; it drives the same gated #approve-btn.
  const saveBtn = page.locator('.rv-save');
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  await expect(page.locator('#logger-status')).toContainText('Workout written to Google Sheets');
  await expect(page.locator('#logger-status')).toContainText('Verified in Sheet');
  expect(capture.writeRequests).toHaveLength(1);
  expect(capture.writeRequests[0].write_id).toBe(previewWriteId);
  expect(capture.writeRequests[0].test_mode).toBeUndefined();
});

test('After save: the review card flips to Saved with an Undo, and is the single confirmation', async ({ page }) => {
  await openApp(page);
  await runToReview(page);
  await page.locator('.rv-save').click();

  // The legacy proof card stays hidden; the review card itself confirms.
  await expect(page.locator('#logger-status')).toBeHidden();
  const review = page.locator('.review');
  await expect(review).toHaveClass(/done/);
  await expect(review.locator('.rv-saved')).toBeVisible();
  await expect(review.locator('.rv-saved')).toContainText('Saved to your sheet');
  await expect(review.locator('.rv-undo')).toBeVisible();   // the single Undo affordance
  await expect(page.locator('.save-inline-btn')).toHaveCount(0);
});

test('Review card Edit opens the collapsed "Edit rows" panel', async ({ page }) => {
  await openApp(page);
  await runToReview(page);
  const editor = page.locator('#parsed-rows-editor');
  await expect(editor).toBeVisible();                        // present after the compile preview…
  await expect(editor.locator('.parsed-rows-summary')).toHaveText('Edit rows');
  await expect(editor.locator('#sets-table')).toBeHidden();  // …collapsed by default
  await page.locator('.rv-edit').click();                    // the review's Edit opens it
  await expect(editor.locator('#sets-table')).toBeVisible();
});

test('Editing after the review invalidates the stale write approval', async ({ page }) => {
  await openApp(page);
  await runToReview(page);
  await expect(page.locator('#approve-btn')).toBeEnabled();
  await expect(page.locator('.rv-save')).toBeEnabled();

  // Typing a new set invalidates the previewed write — the gate closes and the
  // review's Save mirrors it, so a stale write can't fire.
  await page.locator('#workout-text').fill('bench 225 5/2 x3 plus laterals');

  await expect(page.locator('#approve-btn')).toBeDisabled();
  await expect(page.locator('.rv-save')).toBeDisabled();
});

test('Mobile viewport keeps the Coach composer and review card usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);

  await expect(page.locator('#workout-text')).toBeVisible();
  await expect(page.locator('#preview-btn')).toBeVisible();

  await runToReview(page);

  await expect(page.locator('#coach-thread')).toBeVisible();
  await expect(page.locator('.review')).toBeVisible();
});

test('Guardrail: mid-workout sets coach with no Save/preview/approve and zero writes; one review + one write on done', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Set-by-set path: two logged messages.
  await logSet(page, 'bench 225 5/2 x3');
  await logSet(page, 'bench 225 5/2 x3');

  // The whole mid-workout exchange exposes no write surface and writes nothing.
  await expect(page.locator('#thread-messages .readback')).toHaveCount(2);
  await expect(page.locator('#preview-panel')).toBeHidden();
  await expect(page.locator('#approve-btn')).not.toBeVisible();
  await expect(page.locator('.save-inline-btn')).toHaveCount(0);
  await expect(page.locator('.review')).toHaveCount(0);
  expect(capture.writeRequests).toHaveLength(0);
  expect(capture.previewRequests).toHaveLength(0);

  // The single review appears only on the explicit end trigger; then one write.
  await endSession(page);
  await expect(page.locator('.review')).toHaveCount(1);
  await page.locator('.rv-save').click();
  await expect(page.locator('.review.done')).toBeVisible();
  expect(capture.writeRequests).toHaveLength(1);
});

test('Guardrail (bulk): a whole workout in one message writes nothing; one review + one write on done', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Bulk path: a single message carrying the workout, then "done".
  await logSet(page, 'bench 225 5/2, 225 5/2, 225 5/2');
  await expect(page.locator('#thread-messages .readback')).toHaveCount(1);
  await expect(page.locator('#preview-panel')).toBeHidden();
  await expect(page.locator('.save-inline-btn')).toHaveCount(0);
  await expect(page.locator('.review')).toHaveCount(0);
  expect(capture.writeRequests).toHaveLength(0);
  expect(capture.previewRequests).toHaveLength(0);

  await endSession(page);
  await expect(page.locator('.review')).toHaveCount(1);
  await page.locator('.rv-save').click();
  await expect(page.locator('.review.done')).toBeVisible();
  expect(capture.writeRequests).toHaveLength(1);
});

test('Effort end trigger: review shows the compiled session (not zero) + watch metrics + one Save/Edit', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Log a set conversationally — it accumulates in the session buffer.
  await logSet(page, 'bench 225 5/2 x3');
  expect(capture.writeRequests).toHaveLength(0);

  // Open the manual-effort form via the + menu and fill it.
  await page.locator('#composer-attach').click();
  await page.locator('#attach-manual').click();
  await page.locator('#effort-duration').fill('47:12');
  await page.locator('#effort-active-cal').fill('412');
  await page.locator('#effort-total-cal').fill('520');
  await page.locator('#effort-avg-hr').fill('142');
  await page.locator('#effort-peak-hr').fill('168');
  await page.locator('#preview-btn').click();

  // The SINGLE review card shows the compiled session (NOT zero) and the watch
  // metrics — built from the session buffer, not a flaky compile.
  const review = page.locator('.review');
  await expect(review).toBeVisible();
  await expect(review).toContainText('Bench Press');
  await expect(review.locator('.rv-tot')).toContainText('3 sets');     // compiled, not "0 exercises"
  await expect(review.locator('.rv-effort')).toContainText('142');     // Avg HR from the watch metrics
  // Exactly one Save + one Edit, and NO leftover legacy effort save panel.
  await expect(page.locator('.rv-save')).toHaveCount(1);
  await expect(page.locator('.rv-edit')).toHaveCount(1);
  await expect(page.locator('.effort-save-btn')).toHaveCount(0);
  expect(capture.writeRequests).toHaveLength(0);
});

test('Progress surface renders the Today screen from mocked data without crashing', async ({ page }) => {
  await openApp(page);

  await openDrawerNav(page, 'dashboard'); // hamburger → drawer → Today

  await expect(page.locator('body')).toHaveAttribute('data-surface', 'progress');
  // Above the fold: hero pick + readiness strip
  await expect(page.locator('#todays-pick')).toContainText('Today: Push');
  // renderTodaysPick prefers the intent's why_today reasons when present.
  await expect(page.locator('#todays-pick')).toContainText('Pressing patterns are fresh');
  // Raw pattern names map through FRIENDLY_PATTERN_LABELS (Pressing → Push)
  await expect(page.locator('#todays-read')).toContainText('Push');
  await expect(page.locator('#todays-read')).toContainText('Ready');
  // Below the fold: glance-card content is in the DOM even while collapsed
  await expect(page.locator('#progress-snapshot')).toContainText('42');
  await expect(page.locator('#intent-grid')).toContainText('Bench + OHP');
});

test('History groups sessions by week with per-week totals, dropping phantom 0-set rows', async ({ page }) => {
  await openApp(page);
  const fmt = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = fmt(new Date());
  const older = new Date(); older.setDate(older.getDate() - 9); // always a strictly earlier week
  const olderDate = fmt(older);
  await page.route('**/api/sessions/recent', route => route.fulfill(json({
    status: 'success',
    data: {
      sessions: [
        { date: today, session_id: today.replace(/-/g, '') + '-AM-01', exercises: ['Bench Press', 'Incline DB Press', 'Lat Pulldown', 'Face Pull'], sets_count: 12, total_volume: 8420 },
        { date: olderDate, session_id: olderDate.replace(/-/g, '') + '-PM-01', exercises: ['Deadlift', 'Row'], sets_count: 8, total_volume: 14270 },
        // Phantom 0-set row — must be dropped from the list and the weekly total.
        { date: today, session_id: today.replace(/-/g, '') + '-PM-09', exercises: [], sets_count: 0, total_volume: 0 }
      ]
    }
  })));

  await openDrawerNav(page, 'history'); // hamburger → drawer → History

  // Week grouping: "This week" first, with a per-week total reflecting only the
  // real session (the phantom 0-set row is excluded), then one earlier week.
  const headers = page.locator('.session-week-header');
  await expect(headers.first()).toContainText('This week');
  await expect(headers.first()).toContainText('1 session');
  await expect(headers.first()).toContainText('8,420 lb');
  await expect(headers).toHaveCount(2);

  // Today card: weekday/date label, stats, truncated exercise summary.
  const todayCard = page.locator('.session-item').first();
  await expect(todayCard.locator('.session-when')).toContainText(', ');
  await expect(todayCard.locator('.session-stats')).toContainText('12 sets');
  await expect(todayCard.locator('.session-exercises')).toContainText('+1 more');
  // Only the two real sessions render — the phantom 0-set row is gone.
  await expect(page.locator('.session-item')).toHaveCount(2);
});

test('Tapping a session expands to exactly what was logged, grouped by exercise', async ({ page }) => {
  await openApp(page);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sid = today.replace(/-/g, '') + '-AM-01';
  await page.route('**/api/sessions/recent', route => route.fulfill(json({
    status: 'success',
    data: { sessions: [{ date: today, session_id: sid, exercises: ['Bench Press', 'Lat Pulldown'], sets_count: 4, total_volume: 5000 }] }
  })));
  await page.route('**/api/session/**/summary', route => route.fulfill(json({
    status: 'success',
    data: {
      quality_score: 72,
      sets: [
        { exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 4, notes: '' },
        { exercise: 'Bench Press', set_number: 2, weight: 225, reps: 5, rir: 2, notes: 'felt heavy' },
        { exercise: 'Lat Pulldown', set_number: 1, weight: 170, reps: 8, rir: 2, notes: '' }
      ],
      effort: { duration: '47:00', active_calories: 410, average_hr: 142, peak_hr: 168 }
    }
  })));

  await openDrawerNav(page, 'history'); // hamburger → drawer → History
  await page.locator('.session-item').first().locator('.session-summary').click();

  // Grouped by exercise, each set in the coach shorthand, notes inline.
  await expect(page.locator('.session-ex-name').first()).toHaveText('Bench Press');
  await expect(page.locator('.session-ex-set').first()).toHaveText('135 × 10 @4');
  await expect(page.locator('.session-ex-set').nth(1)).toContainText('225 × 5 @2 · felt heavy');
  await expect(page.locator('.session-ex-name').nth(1)).toHaveText('Lat Pulldown');
  // No 6-column table anymore.
  await expect(page.locator('.session-detail-slot table')).toHaveCount(0);
  await expect(page.locator('.session-effort-detail')).toContainText('avg HR 142');
});

test('Session quality info button reveals the score breakdown popover', async ({ page }) => {
  await openApp(page);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sid = today.replace(/-/g, '') + '-AM-01';
  await page.route('**/api/sessions/recent', route => route.fulfill(json({
    status: 'success',
    data: { sessions: [{ date: today, session_id: sid, exercises: ['Bench Press'], sets_count: 1, total_volume: 1350 }] }
  })));
  await page.route('**/api/session/**/summary', route => route.fulfill(json({
    status: 'success',
    data: {
      quality_score: 75,
      quality_breakdown: [
        { id: 'volume',      label: 'Volume',      points: 22, maxPoints: 30, description: '9 sets — good output' },
        { id: 'intensity',   label: 'Intensity',   points: 20, maxPoints: 25, description: 'Avg 1.5 RIR — leaving little in reserve' },
        { id: 'effort',      label: 'Effort',      points: 16, maxPoints: 25, description: '42 min · 118 bpm avg · 390 cal' },
        { id: 'balance',     label: 'Balance',     points: 7,  maxPoints: 10, description: '3 exercises — good variety' },
        { id: 'progression', label: 'Progression', points: 10, maxPoints: 10, description: 'New best on Bench Press' }
      ],
      sets: [{ exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 4, notes: '' }],
      effort: { duration: '42:00', average_hr: 118 }
    }
  })));

  await openDrawerNav(page, 'history'); // hamburger → drawer → History
  await page.locator('.session-item').first().locator('.session-summary').click();

  await expect(page.locator('.session-quality')).toContainText('Session quality: 75 / 100');
  const info = page.locator('.quality-info-btn');
  await expect(info).toBeVisible();

  // Popover is hidden until tapped.
  const popover = page.locator('.quality-popover');
  await expect(popover).not.toBeVisible();

  await info.click();
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('How we scored this');
  // Each criterion shows its label and points.
  await expect(page.locator('.quality-criterion')).toHaveCount(5);
  await expect(popover).toContainText('Volume');
  await expect(popover).toContainText('22 / 30');
  await expect(popover).toContainText('New best on Bench Press');
  // Full-score criteria get the "full" class.
  await expect(page.locator('.quality-criterion.full')).toHaveCount(1); // Progression = 10/10

  // Tapping outside closes it.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(popover).not.toBeVisible();
});

test('Recovery board: per-pattern tiles sorted most-recovered first, tap asks the coach (no write)', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // The recovery board lives on the Today (dashboard) surface.
  await openDrawerNav(page, 'dashboard'); // hamburger → drawer → Today

  const board = page.locator('#pattern-board');
  await expect(board.locator('.pattern-tile')).toHaveCount(4);

  // Sorted by readiness rank (fresh → ready → recovering → fatigued → no-data),
  // days-since as the tiebreak — most-recovered / overdue patterns lead.
  const labels = board.locator('.pattern-tile-label');
  await expect(labels.nth(0)).toHaveText('Pulling');     // fresh, 7d
  await expect(labels.nth(1)).toHaveText('Pressing');    // ready, 3d
  await expect(labels.nth(2)).toHaveText('Lower body');  // fatigued
  await expect(labels.nth(3)).toHaveText('Core');        // no data

  // Status pills read from the backend status.
  await expect(board.locator('.pattern-tile').nth(0).locator('.pattern-pill')).toHaveText('Fresh');
  await expect(board.locator('.pattern-tile').nth(2).locator('.pattern-pill')).toHaveText('Fatigued');
  await expect(board.locator('.pattern-tile').nth(3).locator('.pattern-pill')).toHaveText('No data');

  // Coverage-gap flag: fresh+7d Pulling and never-trained Core are overdue; the
  // recently-trained ready/fatigued patterns are not.
  await expect(board.locator('.pattern-tile').nth(0).locator('.pattern-overdue')).toHaveCount(1);
  await expect(board.locator('.pattern-tile').nth(3).locator('.pattern-overdue')).toHaveCount(1);
  await expect(board.locator('.pattern-tile').nth(1).locator('.pattern-overdue')).toHaveCount(0);

  // Tapping a tile asks the coach for a session focused on that movement — a
  // read-only chat round-trip, never a write.
  let chatBody = null;
  await page.route('**/api/coach/chat', route => {
    chatBody = route.request().postDataJSON();
    return route.fulfill(json({ status: 'success', data: { message: 'Pull day it is.', configured: true } }));
  });

  // Expand the collapsed card, then tap the lead tile.
  await board.evaluate(el => { el.closest('details').open = true; });
  await board.locator('.pattern-tile').first().click();

  await expect.poll(() => chatBody && chatBody.message).toContain('pulling');

  // The tap must switch to the Coach surface so the reply is visible, not
  // orphaned under a hidden thread, and the reply lands in the thread.
  await expect(page.locator('body')).toHaveAttribute('data-surface', 'coach');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('Pull day it is.');

  expect(capture.writeRequests).toHaveLength(0);
});

test('Learn chip: an SME answer renders in-thread, read-only, no write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Deterministic SME endpoint (registered after openApp, so it wins for this path).
  let askBody = null;
  await page.route('**/api/coach/ask', route => {
    askBody = route.request().postDataJSON();
    return route.fulfill(json({
      status: 'success',
      data: {
        depth: 'compare_options',
        answer: 'Strength: heavier, lower reps, load-first.\nHypertrophy: moderate reps, add reps before load, closer to failure.',
        cards: ['strength_training', 'hypertrophy_training'],
        confidenceLevel: 'high',
        source: 'training_sme'
      }
    }));
  });

  await page.locator('.chip[data-ask="Explain strength vs hypertrophy"]').click();

  // The card-grounded answer lands in the thread, and the request carried the question.
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('add reps before load');
  await expect(page.locator('#thread-messages')).toContainText('Based on: strength training, hypertrophy training');
  expect(askBody).toMatchObject({ message: 'Explain strength vs hypertrophy' });

  // Pure read: nothing previewed, nothing written.
  await expect(page.locator('#preview-panel')).toBeHidden();
  expect(capture.writeRequests).toHaveLength(0);
  expect(capture.parseRequests).toHaveLength(0);
});

test('Learn chip: a topic with no card stays quiet (no lecture), still no write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await page.route('**/api/coach/ask', route => route.fulfill(json({
    status: 'success',
    data: { depth: 'log_only', answer: null, cards: [], confidenceLevel: null, source: 'training_sme' }
  })));

  await page.locator('.chip[data-ask="What is a deload?"]').click();

  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText("don't have a card on that yet");
  await expect(page.locator('#preview-panel')).toBeHidden();
  expect(capture.writeRequests).toHaveLength(0);
});

test('Composer: a training question is answered deterministically by the SME (no Gemini)', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  // Parser reports no sets → the message is treated as a question (routes to coach).
  await page.route('**/api/parse-workout-text', route => route.fulfill(json({
    status: 'success',
    data: { test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
      parsed: { intent: 'needs_clarification', message: 'Could not find sets.' } }
  })));

  let askBody = null;
  await page.route('**/api/coach/ask', route => {
    askBody = route.request().postDataJSON();
    return route.fulfill(json({ status: 'success', data: {
      depth: 'explain',
      answer: 'A deload is a planned easier week — reduce load, volume, or exercise stress to shed fatigue.',
      cards: ['deloads'], confidenceLevel: 'high', source: 'training_sme'
    } }));
  });

  // The Gemini coach must NOT run when the SME has a grounded answer.
  let chatCalled = false;
  await page.route('**/api/coach/chat', route => {
    chatCalled = true;
    return route.fulfill(json({ status: 'success', data: { message: '(gemini should not run)', configured: true } }));
  });

  await page.locator('#workout-text').fill('what is a deload?');
  await page.locator('#preview-btn').click();

  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('planned easier week');
  await expect(page.locator('#thread-messages')).toContainText('Based on: deloads');
  expect(askBody).toMatchObject({ message: 'what is a deload?' });
  expect(chatCalled).toBe(false);
  await expect(page.locator('#preview-panel')).toBeHidden();
  expect(capture.writeRequests).toHaveLength(0);
});

test('Composer: a non-knowledge question falls through to the Gemini coach', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await page.route('**/api/parse-workout-text', route => route.fulfill(json({
    status: 'success',
    data: { test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
      parsed: { intent: 'needs_clarification', message: 'Could not find sets.' } }
  })));

  // SME has no card for a data question → log_only, no answer.
  await page.route('**/api/coach/ask', route => route.fulfill(json({
    status: 'success', data: { depth: 'log_only', answer: null, cards: [], confidenceLevel: null, source: 'training_sme' }
  })));

  let chatCalled = false;
  await page.route('**/api/coach/chat', route => {
    chatCalled = true;
    return route.fulfill(json({ status: 'success', data: { message: 'Your bench has been flat for 3 sessions.', configured: true } }));
  });

  await page.locator('#workout-text').fill('how is my bench trending?');
  await page.locator('#preview-btn').click();

  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('flat for 3 sessions');
  expect(chatCalled).toBe(true);
  expect(capture.writeRequests).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// PR 2 — End-of-session compile from the in-session buffer.
//
// The deload-session repro lost 2 of 6 exercises and re-asked for effort. PR 1
// fixed the misparse that caused the drop (two lifts collapsing onto one); this
// test locks in the compile behaviour: six DISTINCT lifts logged conversationally
// with RIR all survive to the single review card with RIR intact, effort is NOT
// re-asked, zero writes fire mid-workout, and exactly one write fires on Save.
// ---------------------------------------------------------------------------

const SESSION_EXERCISES = [
  { text: 'bench 225 5/2 x3',          name: 'Bench Press',    code: 'BEN01', mg: 'Chest',     rir: 2,  weight: 225, reps: 5 },
  { text: 'lateral raises 15 12/4 x3', name: 'Lateral Raises', code: 'LRA01', mg: 'Shoulders', rir: 4,  weight: 15,  reps: 12 },
  { text: 'shrugs 70 12/10 x3',        name: 'Shrug',          code: 'SHR01', mg: 'Back',      rir: 10, weight: 70,  reps: 12 },
  { text: 'lat pulldown 170 8/2 x3',   name: 'Lat Pulldown',   code: 'LAT01', mg: 'Back',      rir: 2,  weight: 170, reps: 8 },
  { text: 'face pulls 50 15/1 x3',     name: 'Face Pull',      code: 'FP01',  mg: 'Shoulders', rir: 1,  weight: 50,  reps: 15 },
  { text: 'hammer curl 30 10/3 x3',    name: 'Hammer Curl',    code: 'HC01',  mg: 'Arms',      rir: 3,  weight: 30,  reps: 10 }
];

function setsFor(ex) {
  return [0, 1, 2].map(() => ({ weight: ex.weight, reps: ex.reps, rir: ex.rir }));
}

// Parser + preview mocks that honour the typed exercise (instead of the default
// bench-only stubs), so the buffer accumulates six distinct lifts and the review
// echoes back exactly what was logged.
async function mockSixExerciseSession(page, capture) {
  const byName = new Map(SESSION_EXERCISES.map(e => [e.name, e]));

  await page.route('**/api/parse-workout-text', route => {
    const body = route.request().postDataJSON();
    capture.parseRequests.push(body);
    const ex = SESSION_EXERCISES.find(e => e.text === body.text);
    if (!ex) {
      return route.fulfill(json({ status: 'success', data: {
        test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
        parsed: { intent: 'needs_clarification', message: 'Could not find sets.' }
      } }));
    }
    return route.fulfill(json({ status: 'success', data: {
      test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
      parsed: { intent: 'log_sets', raw_name: ex.name, canonical_name: ex.name, exercise: ex.name, sets: setsFor(ex) }
    } }));
  });

  await page.route('**/api/log-workout', route => {
    const body = route.request().postDataJSON();
    const isPreview = body?.test_mode === true || body?.test_mode === 'true';
    if (isPreview) {
      capture.previewRequests.push(body);
      const preview = (body.log_rows || []).map(r => {
        const ex = byName.get(r.exercise) || { code: 'UNK01', mg: 'Unknown' };
        return [r.date_clean || '', r.session_id || '', r.exercise, r.exercise, ex.mg, ex.code,
          r.set_number, r.weight, r.reps, r.rir, r.notes || '', (Number(r.weight) || 0) * (Number(r.reps) || 0)];
      });
      return route.fulfill(json({ status: 'success', data: {
        test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true,
        warnings: [], auto_matches: [], pending_exercises: [], rule_flags: [], log_rows_preview: preview
      } }));
    }
    capture.writeRequests.push(body);
    return route.fulfill(json({ status: 'success', data: {
      sheet_write: 'success', sheet_written: true,
      log_rows_written: (body.log_rows || []).length, logAppendedRange: 'Log_Cleaned!A200:L217'
    } }));
  });
}

test('PR2: six typed lifts with RIR all survive the end-of-session compile; effort not re-asked; one write on Save', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await mockSixExerciseSession(page, capture);

  // Log all six lifts conversationally — each accumulates in the session buffer.
  // Assert the readback count grows by one per set instead of firing all six
  // back-to-back: under parallel CPU contention a set could be typed before the
  // prior readback (and its buffer entry) rendered, which raced this spec. This
  // web-first per-set wait keeps logging deterministic without a fixed delay.
  let loggedSets = 0;
  for (const ex of SESSION_EXERCISES) {
    await logSet(page, ex.text);
    loggedSets += 1;
    await expect(page.locator('#thread-messages .readback')).toHaveCount(loggedSets);
  }

  // Mid-workout: six coached readbacks, and nothing written or previewed.
  await expect(page.locator('#thread-messages .readback')).toHaveCount(6);
  expect(capture.writeRequests).toHaveLength(0);
  expect(capture.previewRequests).toHaveLength(0);

  // End trigger compiles the FULL session from the buffer into one review card.
  await endSession(page);
  const review = page.locator('.review');
  await expect(review).toBeVisible();

  // All six exercises survive (none dropped, none collapsed onto another).
  for (const ex of SESSION_EXERCISES) await expect(review).toContainText(ex.name);
  await expect(review.locator('.rv-en')).toHaveCount(6);
  await expect(review.locator('.rv-tot')).toContainText('6 exercises');
  await expect(review.locator('.rv-tot')).toContainText('18 sets');

  // RIR is intact per lift — including the distinct values, never flattened.
  await expect(review.locator('.rv-ex', { hasText: 'Shrug' })).toContainText('RIR 10');
  await expect(review.locator('.rv-ex', { hasText: 'Face Pull' })).toContainText('RIR 1');
  await expect(review.locator('.rv-ex', { hasText: 'Bench Press' })).toContainText('RIR 2');
  await expect(review.locator('.rv-es .rir')).toHaveCount(6);

  // Effort is NOT re-asked: no legacy effort-save panel; watch effort is an
  // optional add-on hint, not a demand to re-enter what was typed per set.
  await expect(page.locator('.effort-save-btn')).toHaveCount(0);
  await expect(review.locator('.rv-eff')).toContainText('+ add Apple Watch effort');

  // The dry-run proved no-write safety and still nothing is written.
  expect(capture.previewRequests).toHaveLength(1);
  expect(capture.previewRequests[0]).toMatchObject({ test_mode: 'true' });
  expect(capture.previewRequests[0].write_id).toBeTruthy();
  expect(capture.writeRequests).toHaveLength(0);

  // Exactly one write fires on Save — the single end-of-session write.
  await expect(review.locator('.rv-save')).toBeEnabled();
  await review.locator('.rv-save').click();
  await expect(page.locator('.review.done')).toBeVisible();
  expect(capture.writeRequests).toHaveLength(1);
  expect(capture.writeRequests[0].log_rows).toHaveLength(18);
});

test('PR7: a single logged set renders exactly one readback tile and one Next card — no duplicated plain-text block', async ({ page }) => {
  await openApp(page);

  await logSet(page);

  // Exactly one readback tile (the structured in-workout card).
  await expect(page.locator('#thread-messages .readback')).toHaveCount(1);

  // Exactly one Next prescription card — no second restatement block.
  await expect(page.locator('#thread-messages .nextp')).toHaveCount(1);

  // The thread must NOT contain a plain-text duplicate of the exercise name
  // outside of a structured card (the legacy renderer produced a bare
  // "Bench Press / 225lbs 5/2 x3 / Next: …" block as a second text node).
  const bubbles = page.locator('#thread-messages .chat-bubble-atlas');
  const count = await bubbles.count();
  for (let i = 0; i < count; i++) {
    const bubble = bubbles.nth(i);
    // Skip the structured readback itself — we're hunting for a duplicate bare-text copy.
    const isReadback = await bubble.locator('.readback').count();
    if (isReadback > 0) continue;
    // Any Atlas prose bubble should NOT restate the exercise line in legacy format.
    await expect(bubble).not.toContainText('Bench Press\n225lbs');
  }
});

// ---------------------------------------------------------------------------
// PR 6 — Next-exercise handoff + composer advance.
//
// After logging exercise N from a multi-exercise plan, the Atlas reply must
// name exercise N+1 in a ".next-exercise-handoff" line, the #workout-text
// placeholder must reflect N+1 (not a generic home hint), and the single-
// render invariant (one .readback, one .nextp) must still hold.
// ---------------------------------------------------------------------------

test('PR6: logging exercise N names N+1 in the reply and advances the composer placeholder', async ({ page }) => {
  await openApp(page);

  // Override /api/plan/today to return a two-exercise ordered plan:
  // Bench Press → Lat Pulldown (insertion order = plan order).
  await page.route('**/api/plan/today', route => route.fulfill(json({
    status: 'success',
    data: {
      recommendations: [
        { exercise_name: 'Bench Press', lift_code: 'BEN01', target_weight: 225, target_reps: 5, target_sets: 3, target_rir: 2 },
        { exercise_name: 'Lat Pulldown', lift_code: 'LPD01', target_weight: 170, target_reps: 8, target_sets: 3, target_rir: 2 }
      ]
    }
  })));

  // Log the first exercise (Bench Press = exercise 0 in the plan).
  await logSet(page, 'bench 225 5/2 x3');

  // The Atlas reply bubble must contain the next-exercise handoff line.
  const bubble = page.locator('#thread-messages .chat-bubble-atlas').last();
  await expect(bubble.locator('.next-exercise-handoff')).toBeVisible();
  await expect(bubble.locator('.next-exercise-handoff')).toContainText('Lat Pulldown');
  await expect(bubble.locator('.next-exercise-handoff')).toContainText('Moving on');

  // Single-render invariant: still exactly one .readback and one .nextp —
  // the handoff is an extra line in the SAME bubble, not a new block.
  await expect(page.locator('#thread-messages .readback')).toHaveCount(1);
  await expect(page.locator('#thread-messages .nextp')).toHaveCount(1);

  // The composer placeholder must now reflect the next exercise (Lat Pulldown),
  // not one of the generic home hints.
  const GENERIC_HINTS = [
    'Log a set or ask anything',
    'Try: Bench 225',
    'what should I train today',
    "how's my recovery",
    'log it'
  ];
  const placeholder = await page.locator('#workout-text').getAttribute('placeholder');
  // FIX 2: the placeholder is the next exercise's FULL prescription — each set
  // written out (reps/rir per set), bare weight, no "xN" — not just the name.
  expect(placeholder).toBe('Lat Pulldown 170 8/2 8/2 8/2');
  for (const hint of GENERIC_HINTS) {
    expect(placeholder).not.toContain(hint);
  }

  // Trust loop untouched: nothing written or previewed mid-session.
  await expect(page.locator('#preview-panel')).toBeHidden();
  await expect(page.locator('.review')).toHaveCount(0);
});

test('PR6: logging the last exercise in the plan shows no handoff (not fabricated)', async ({ page }) => {
  await openApp(page);

  // Plan with a single exercise — Bench Press is the only (and last) entry.
  await page.route('**/api/plan/today', route => route.fulfill(json({
    status: 'success',
    data: {
      recommendations: [
        { exercise_name: 'Bench Press', lift_code: 'BEN01', target_weight: 225, target_reps: 5, target_sets: 3, target_rir: 2 }
      ]
    }
  })));

  await logSet(page, 'bench 225 5/2 x3');

  // When the logged exercise is the last in the plan, no handoff div is rendered —
  // we never fabricate an exercise that isn't in the plan.
  const bubble = page.locator('#thread-messages .chat-bubble-atlas').last();
  await expect(bubble.locator('.next-exercise-handoff')).toHaveCount(0);

  // Single-render invariant still holds.
  await expect(page.locator('#thread-messages .readback')).toHaveCount(1);
});
