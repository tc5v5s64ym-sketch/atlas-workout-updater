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
  appendCalls: [],
  // Set to true only inside tests that intentionally exercise the live-write branch.
  // Default false ensures dry-run tests trip the throw guard if appendRows fires unexpectedly.
  allowAppend: false,
  deleteCalls: []
};

const fakeSheets = {
  appendRows: async (tabName, rows) => {
    fakeSheetsState.appendCalls.push({ tabName, rows });
    if (!fakeSheetsState.allowAppend) {
      throw new Error('appendRows should not be called by endpoint smoke tests');
    }
    return { data: { updates: { updatedRange: `${tabName}!A100:K100`, updatedRows: rows.length } } };
  },
  deleteRowsByRange: async (tabName, startIndex, endIndex) => {
    fakeSheetsState.deleteCalls.push({ tabName, startIndex, endIndex });
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

test('api smoke: routes include key endpoints and write metadata', async () => {
  const { response, body } = await requestJson('/routes');
  const routes = body.data.routes;
  const paths = routes.map(route => route.path);
  const routeByPath = new Map(routes.map(route => [route.path, route]));

  assert.equal(response.status, 200);
  assert.ok(paths.includes('/api/exercises/last-session'));
  assert.ok(paths.includes('/api/parse-workout-text'));
  assert.ok(paths.includes('/api/log-workout'));
  assert.ok(paths.includes('/api/complete-workout'));
  assert.equal(routeByPath.get('/api/parse-workout-text').readOnly, true);
  assert.equal(routeByPath.get('/api/parse-workout-text').writeCapable, false);
  assert.equal(routeByPath.get('/api/log-workout').readOnly, false);
  assert.equal(routeByPath.get('/api/log-workout').writeCapable, true);
  assert.equal(routeByPath.get('/api/complete-workout').readOnly, false);
  assert.equal(routeByPath.get('/api/complete-workout').writeCapable, true);
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
  fakeSheetsState.appendCalls.length = 0;
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
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: parse-workout-text clarification does not create rows', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({
      text: 'Press 135 8/2',
      test_mode: true
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.parsed.intent, 'needs_clarification');
  assert.match(body.data.parsed.message, /Which press/i);
  assert.equal(body.data.parsed.sets, undefined);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: parse-workout-text refuses excessive Dale repeat', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({
      text: 'Lats 170 8/2 x99',
      test_mode: true
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.parsed.intent, 'needs_clarification');
  assert.ok((body.data.parsed.sets?.length || 0) <= 10);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
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

test('api smoke: log-workout invalid payload errors without append', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-INVALID',
      test_mode: true,
      log_rows: [
        {
          exercise: 'Bench Press',
          set_number: 1,
          weight: 225,
          reps: 5,
          rir: 2
        }
      ]
    })
  });

  assert.equal(response.status, 400);
  assert.equal(body.status, 'error');
  assert.match(body.message, /date is required/i);
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

test('api smoke: plan-today returns stable read shape', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/plan/today');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.ok(Array.isArray(body.data.recommendations));
  assert.ok(body.data.recommendations.some(item => item.liftCode === 'BEN01'));
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

// Missing test_mode currently means live-write branch.
// This test pins the current behavior: absent test_mode = real append to Log_Cleaned.
// A future PR may add an explicit confirm_write gate, but this task does not change that contract.
test('api smoke: live log-workout without test_mode appends one row to Log_Cleaned', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;

  try {
    const { response, body } = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'LIVE-WRITE-SMOKE-01',
        date: '2026-06-11',
        // test_mode intentionally omitted — this exercises the live-write branch
        log_rows: [
          {
            exercise: 'Bench Press',
            set_number: 1,
            weight: 135,
            reps: 10,
            rir: 5,
            notes: ''
          }
        ]
      })
    });

    // Response must indicate success with confirmed write
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.data.sheet_write, 'success');
    assert.ok(body.data.log_rows_written > 0, `log_rows_written must be > 0, got ${body.data.log_rows_written}`);

    // Exactly one appendRows call — no effort row, so only the log append fires
    assert.equal(fakeSheetsState.appendCalls.length, 1);

    const call = fakeSheetsState.appendCalls[0];

    // Must target the log tab, not Effort
    assert.equal(call.tabName, 'Log_Cleaned');

    // Exactly one row appended
    assert.equal(call.rows.length, 1);

    const row = call.rows[0];

    // 12-column contract (logCleanedColumns order):
    // [0] date_clean  [1] session_id  [2] exercise  [3] canonical_exercise
    // [4] muscle_group  [5] lift_code  [6] set_number  [7] weight
    // [8] reps  [9] rir  [10] notes  [11] volume_calc
    assert.equal(row.length, 12);
    assert.equal(row[0], '2026-06-11');           // date
    assert.equal(row[1], 'LIVE-WRITE-SMOKE-01');  // session_id
    assert.equal(row[3], 'Bench Press');           // canonical_exercise
    assert.equal(row[4], 'Chest');                 // muscle_group
    assert.equal(row[5], 'BEN01');                 // lift_code
    assert.equal(Number(row[6]), 1);               // set_number
    assert.equal(Number(row[7]), 135);             // weight — Bench 135 10/5
    assert.equal(Number(row[8]), 10);              // reps  — Bench 135 10/5
    assert.equal(Number(row[9]), 5);               // rir   — Bench 135 10/5
    assert.equal(Number(row[11]), 1350);           // volume_calc = 135 * 10
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

// ── undo-last tests ─────────────────────────────────────────────────────────
// All undo tests use the fake Sheets layer; no real Google Sheets access occurs.
// logRows fixture (sheet-row mapping, header is row 1):
//   sheet row 2 → logRows[0]: SESSION-OLD, Bench Press
//   sheet row 3 → logRows[1]: SESSION-NEW, Bench Press (top set)
//   sheet row 4 → logRows[2]: SESSION-NEW, Bench Press (backoff)
//   sheet row 5 → logRows[3]: SESSION-NEW, Back Squat

test('api smoke: undo-last rejects missing log_appended_range with 400', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'SESSION-NEW',
      rows_to_delete: 1,
      confirm_delete: true
    })
  });

  assert.equal(response.status, 400);
  assert.equal(body.status, 'error');
  assert.deepEqual(fakeSheetsState.deleteCalls, []);
});

test('api smoke: undo-last rejects wrong tab with 400', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Effort!A1:L1',
      session_id: 'SESSION-NEW',
      rows_to_delete: 1,
      confirm_delete: true
    })
  });

  assert.equal(response.status, 400);
  assert.equal(body.status, 'error');
  assert.match(body.message, /Log_Cleaned/);
  assert.deepEqual(fakeSheetsState.deleteCalls, []);
});

test('api smoke: undo-last rejects rows_to_delete mismatch with 400', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Log_Cleaned!A847:L847', // span = 1
      session_id: 'SESSION-NEW',
      rows_to_delete: 2,                           // mismatch
      confirm_delete: true
    })
  });

  assert.equal(response.status, 400);
  assert.equal(body.status, 'error');
  assert.match(body.message, /rows_to_delete/);
  assert.deepEqual(fakeSheetsState.deleteCalls, []);
});

test('api smoke: undo-last returns 409 and does not delete on session_id mismatch', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  // Sheet row 2 → logRows[0] → SESSION-OLD; we claim SESSION-NEW → mismatch
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Log_Cleaned!A2:L2',
      session_id: 'SESSION-NEW',
      rows_to_delete: 1,
      confirm_delete: true
    })
  });

  assert.equal(response.status, 409);
  assert.equal(body.status, 'error');
  assert.match(body.message, /session_id mismatch/i);
  assert.deepEqual(fakeSheetsState.deleteCalls, []);
});

test('api smoke: undo-last returns 409 and does not delete when target row is missing', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  // Sheet row 6 is beyond logRows (which only covers rows 2–5), so allRows[4] is undefined
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Log_Cleaned!A6:L6',
      session_id: 'SESSION-NEW',
      rows_to_delete: 1,
      confirm_delete: true
    })
  });

  assert.equal(response.status, 409);
  assert.equal(body.status, 'error');
  assert.match(body.message, /missing or empty/i);
  assert.deepEqual(fakeSheetsState.deleteCalls, []);
});

test('api smoke: undo-last happy path deletes one Log_Cleaned row and returns rows_deleted: 1', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  // Sheet row 3 → logRows[1] → SESSION-NEW; ownership verified → delete proceeds
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Log_Cleaned!A3:L3',
      session_id: 'SESSION-NEW',
      rows_to_delete: 1,
      confirm_delete: true
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.rows_deleted, 1);
  assert.equal(body.data.deleted_range, 'Log_Cleaned!A3:L3');

  // Exactly one deleteRowsByRange call with correct 0-based indices
  // sheet row 3 → startIndex=2 (inclusive), endIndex=3 (exclusive)
  assert.equal(fakeSheetsState.deleteCalls.length, 1);
  const call = fakeSheetsState.deleteCalls[0];
  assert.equal(call.tabName, 'Log_Cleaned');
  assert.equal(call.startIndex, 2);
  assert.equal(call.endIndex, 3);
});
