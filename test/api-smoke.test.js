const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nstub\\n-----END PRIVATE KEY-----';

const logRows = [
  ['2026-06-01', 'SESSION-OLD', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '205', '5', '3', 'old bench'],
  ['2026-06-10', 'SESSION-NEW', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '225', '5', '2', 'top set'],
  ['2026-06-10', 'SESSION-NEW', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '2', '215', '6', '2', 'backoff'],
  ['2026-06-10', 'SESSION-NEW', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '315', '3', '2', '']
];

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench'],
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'squat|squats']
];

const fakeSheetsState = {
  appendCalls: []
};

const fakeSheets = {
  appendRows: async (tabName, rows) => {
    fakeSheetsState.appendCalls.push({ tabName, rows });
    throw new Error('appendRows should not be called by endpoint smoke tests');
  },
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async tabName => {
    if (tabName === 'Log_Cleaned') return logRows;
    if (tabName === 'Effort') return [];
    return [];
  },
  getSheetRows: async tabName => {
    if (tabName === 'Log_Cleaned') return logRows;
    if (tabName === 'Effort') return [];
    return [];
  },
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort'
};

const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = {
  id: sheetsPath,
  filename: sheetsPath,
  loaded: true,
  exports: fakeSheets
};

const { app } = require('../index');

let server;
let baseUrl;

test.before(async () => {
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
});

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(path.startsWith('/api') ? { 'x-atlas-api-key': process.env.ATLAS_API_KEY } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { response, body };
}

test('api smoke: health returns service status', async () => {
  const { response, body } = await requestJson('/health');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.service, 'atlas-workout-updater');
});

test('api smoke: routes include last-session endpoint', async () => {
  const { response, body } = await requestJson('/routes');
  const paths = body.data.routes.map(route => route.path);

  assert.equal(response.status, 200);
  assert.ok(paths.includes('/api/exercises/last-session'));
});

test('api smoke: last-session reaches literal handler', async () => {
  const { response, body } = await requestJson('/api/exercises/last-session?exercise=Bench%20Press');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.message, 'Last session sets');
  assert.equal(body.data.exercise, 'Bench Press');
  assert.equal(body.data.session_id, 'SESSION-NEW');
  assert.equal(body.data.date, '2026-06-10');
  assert.deepEqual(body.data.sets.map(set => [set.set_number, set.weight, set.reps, set.rir]), [
    ['1', '225', '5', '2'],
    ['2', '215', '6', '2']
  ]);
});

test('api smoke: parse-workout-text dry-run proves no write', async () => {
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({
      text: 'Bench 225 5/2',
      test_mode: true
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.parsed.intent, 'log_sets');
  assert.deepEqual(body.data.parsed.sets.map(set => [set.weight, set.reps, set.rir]), [[225, 5, 2]]);
});

test('api smoke: log-workout test_mode returns dry-run proof without append', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-DRY-RUN',
      date: '2026-06-11',
      test_mode: true,
      log_rows: [
        {
          exercise: 'Bench Press',
          set_number: 1,
          weight: 225,
          reps: 5,
          rir: 2,
          notes: 'endpoint smoke dry-run'
        }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_write, 'skipped');
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.log_rows_preview[0][3], 'Bench Press');
  assert.equal(body.data.log_rows_preview[0][5], 'BEN01');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: recommend-next returns stable read shape', async () => {
  const { response, body } = await requestJson('/api/recommend/next/BEN01');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.liftCode, 'BEN01');
  assert.ok(body.data.recommendation);
  assert.ok(body.data.rule_decision);
});
