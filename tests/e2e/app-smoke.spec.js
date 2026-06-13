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
            patterns: [
              { pattern: 'Pressing', label: 'Pressing', status: 'ready', detail: 'Ready' },
              { pattern: 'Pulling', label: 'Pulling', status: 'fresh', detail: 'Fresh' }
            ]
          },
          intents: [
            {
              label: 'Push', focus: 'Bench + OHP', recommended: true,
              why_today: ['Pressing patterns are fresh', 'Last bench moved at RIR 2'],
              data_points: [{ label: 'Weekly load', value: '1.1× baseline', context: 'moderate' }],
              exercises: [{ exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 225, target_reps: 5, target_sets: 3 }]
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
          recommendation: 'Hold 225 and build cleaner 5s.',
          last_working_sets: [{ weight: 225, reps: 5, rir: 2 }],
          next_target: { weight: 225, reps: 5, sets: 3 },
          reasoning: 'Dry-run mock recommendation.',
          sessions_analyzed: 3
        }
      }));
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

async function runPreview(page) {
  await page.locator('#workout-text').fill('bench 225 5/2 x3');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#preview-panel')).toBeVisible();
  await expect(page.locator('#preview-content')).toContainText('DRY-RUN');
  await expect(page.locator('#preview-content')).toContainText('test_mode: true');
  await expect(page.locator('#preview-content')).toContainText('sheet_written: false');
  await expect(page.locator('#preview-content')).toContainText('no_write_confirmed: true');
  await expect(page.locator('#preview-content')).toContainText('Bench Press');
}

test('Coach shell loads with guarded preview state', async ({ page }) => {
  await openApp(page);

  await expect(page.locator('body')).toHaveAttribute('data-surface', 'coach');
  // Minimal Grok/Gemini-style home: empty-state hero + Suggested Workout tiles.
  await expect(page.locator('#coach-empty')).toBeVisible();
  await expect(page.locator('.coach-empty-tagline')).toContainText('Log a workout, or just ask');
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
  await expect(bubble).toContainText('Bench Press');
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
  await expect(bubble).toContainText('Bench Press');                          // exercises still shown
  await expect(bubble).not.toContainText('Why today:');                       // templated bullets replaced
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

  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('Log a set like');
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

test('Preview flow renders a no-write review card from mocked APIs', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);

  await runPreview(page);

  await expect(page.locator('#thread-messages')).toContainText('bench 225 5/2 x3');
  await expect(page.locator('#preview-content')).toContainText('3 sets to write');
  await expect(page.locator('#preview-content')).toContainText('Bench Press ×3');
  await expect(page.locator('#preview-content')).toContainText('bench -> Bench Press');
  expect(capture.parseRequests).toHaveLength(1);
  expect(capture.parseRequests[0]).toMatchObject({ text: 'bench 225 5/2 x3', test_mode: true });
  expect(capture.previewRequests).toHaveLength(1);
  expect(capture.previewRequests[0]).toMatchObject({ test_mode: 'true' });
  expect(capture.previewRequests[0].write_id).toBeTruthy();
});

test('Approve flow sends write_id only after preview and shows success', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  await runPreview(page);

  const previewWriteId = capture.previewRequests[0].write_id;
  await expect(page.locator('#approve-btn')).toBeEnabled();
  // The coaching bubble's inline "Save to Sheets" is the primary write CTA in
  // the redesigned home; it drives the same gated #approve-btn.
  const saveBtn = page.locator('.save-inline-btn');
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  await expect(page.locator('#logger-status')).toContainText('Workout written to Google Sheets');
  await expect(page.locator('#logger-status')).toContainText('Verified in Sheet');
  expect(capture.writeRequests).toHaveLength(1);
  expect(capture.writeRequests[0].write_id).toBe(previewWriteId);
  expect(capture.writeRequests[0].test_mode).toBeUndefined();
});

test('After save: proof card hidden, inline Saved is the single confirmation', async ({ page }) => {
  await openApp(page);
  await runPreview(page);
  const saveBtn = page.locator('.save-inline-btn');
  await saveBtn.click();

  // The verbose "Workout written ✓ / Undo / Verified" card collapses (kept in
  // the DOM for the proof + signal, but not shown).
  await expect(page.locator('#logger-status')).toBeHidden();
  // The inline button is the single confirmation — no second bubble, no Undo.
  await expect(saveBtn).toHaveText('Saved ✓');
  await expect(page.locator('#thread-messages .chat-bubble-atlas')).toHaveCount(1);
  await expect(page.locator('.coach-undo-link')).toHaveCount(0);
});

test('Parsed-rows editor is a collapsed "Edit rows" panel, open on demand', async ({ page }) => {
  await openApp(page);
  await runPreview(page);
  const editor = page.locator('#parsed-rows-editor');
  await expect(editor).toBeVisible();                        // present after preview…
  await expect(editor.locator('.parsed-rows-summary')).toHaveText('Edit rows');
  await expect(editor.locator('#sets-table')).toBeHidden();  // …but collapsed by default
  await editor.locator('.parsed-rows-summary').click();
  await expect(editor.locator('#sets-table')).toBeVisible(); // expands on tap
});

test('Editing after preview invalidates stale write approval', async ({ page }) => {
  await openApp(page);
  await runPreview(page);
  await expect(page.locator('#approve-btn')).toBeEnabled();

  await page.locator('#workout-text').fill('bench 225 5/2 x3 plus laterals');

  await expect(page.locator('#preview-panel')).toBeHidden();
  await expect(page.locator('#approve-btn')).toBeDisabled();
  await expect(page.locator('#preview-gate-note')).toContainText('Run a preview above');
});

test('Mobile viewport keeps the Coach composer and preview usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);

  await expect(page.locator('#workout-text')).toBeVisible();
  await expect(page.locator('#preview-btn')).toBeVisible();

  await runPreview(page);

  await expect(page.locator('#coach-thread')).toBeVisible();
  await expect(page.locator('#preview-panel')).toBeVisible();
});

test('Progress surface renders the Today screen from mocked data without crashing', async ({ page }) => {
  await openApp(page);

  await page.locator('.surface-btn[data-surface="progress"]').click();

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

test('History groups sessions under Today / Past with clean cards', async ({ page }) => {
  await openApp(page);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.route('**/api/sessions/recent', route => route.fulfill(json({
    status: 'success',
    data: {
      sessions: [
        { date: today, session_id: today.replace(/-/g, '') + '-AM-01', exercises: ['Bench Press', 'Incline DB Press', 'Lat Pulldown', 'Face Pull'], sets_count: 12, total_volume: 8420 },
        { date: '2026-06-09', session_id: '20260609-PM-01', exercises: ['Deadlift', 'Row'], sets_count: 8, total_volume: 14270 }
      ]
    }
  })));

  await page.locator('.surface-btn[data-surface="progress"]').click();
  await page.locator('[data-tab="history"]').click();

  const headers = page.locator('.session-group-header');
  await expect(headers.nth(0)).toHaveText('Today');
  await expect(headers.nth(1)).toHaveText('Past sessions');

  // Today card: friendly label, stats, and a truncated exercise summary.
  const todayCard = page.locator('.session-item').first();
  await expect(todayCard.locator('.session-when')).toHaveText('Morning session');
  await expect(todayCard.locator('.session-stats')).toContainText('12 sets');
  await expect(todayCard.locator('.session-exercises')).toContainText('+1 more');
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
      quality_score: 4,
      sets: [
        { exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 4, notes: '' },
        { exercise: 'Bench Press', set_number: 2, weight: 225, reps: 5, rir: 2, notes: 'felt heavy' },
        { exercise: 'Lat Pulldown', set_number: 1, weight: 170, reps: 8, rir: 2, notes: '' }
      ],
      effort: { duration: '47:00', active_calories: 410, average_hr: 142, peak_hr: 168 }
    }
  })));

  await page.locator('.surface-btn[data-surface="progress"]').click();
  await page.locator('[data-tab="history"]').click();
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
      quality_score: 4,
      quality_breakdown: [
        { label: '10 or more sets', met: true },
        { label: '30 or more minutes', met: false },
        { label: 'Average heart rate 100+', met: true },
        { label: '3 or more exercises', met: true },
        { label: 'No data warnings', met: true }
      ],
      sets: [{ exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 4, notes: '' }],
      effort: { duration: '20:00', average_hr: 142 }
    }
  })));

  await page.locator('.surface-btn[data-surface="progress"]').click();
  await page.locator('[data-tab="history"]').click();
  await page.locator('.session-item').first().locator('.session-summary').click();

  await expect(page.locator('.session-quality')).toContainText('Session quality: 4 / 5');
  const info = page.locator('.quality-info-btn');
  await expect(info).toBeVisible();

  // Popover is hidden until tapped.
  const popover = page.locator('.quality-popover');
  await expect(popover).not.toBeVisible();

  await info.click();
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('How we scored this');
  // The one unmet criterion is rendered with the unmet modifier.
  await expect(page.locator('.quality-criterion.unmet')).toHaveText(/30 or more minutes/);
  await expect(page.locator('.quality-criterion.met')).toHaveCount(4);

  // Tapping outside closes it.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(popover).not.toBeVisible();
});
