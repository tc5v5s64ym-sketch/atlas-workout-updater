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
            { label: 'Push', focus: 'Bench + OHP', recommended: true },
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
  await expect(page.locator('#todays-pick')).toContainText('Bench is ready for clean repeat work.');
  // Raw pattern names map through FRIENDLY_PATTERN_LABELS (Pressing → Push)
  await expect(page.locator('#todays-read')).toContainText('Push');
  await expect(page.locator('#todays-read')).toContainText('Ready');
  // Below the fold: glance-card content is in the DOM even while collapsed
  await expect(page.locator('#progress-snapshot')).toContainText('42');
  await expect(page.locator('#intent-grid')).toContainText('Bench + OHP');
});
