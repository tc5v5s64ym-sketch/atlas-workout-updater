'use strict';

// THE FREEZE, THROUGH THE REAL ROUTES.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §3.10, §5.3.
// Gates: §6.2 P10 (all seven fail closed with NO side effect, proven PER ROUTE —
// not on one representative), P11 (control loss cannot reopen writes), P12
// (dormant), and P13's auth negative for the receipt migration seam.
// Owner ruling D7 — APPROVED 2026-08-09.
//
// The real Express app, the real routes, the real services/writeFreeze.js. Only
// Google Sheets, the Supabase adapter and the vision parser are stubbed — the
// Sheets stub is what makes "no side effect" MEASURED rather than asserted: every
// append, delete and cell update is counted, and a frozen request must produce none.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.ATLAS_SESSION_SECRET = 'test-session-secret-for-the-cookie-negative';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_IDEMPOTENCY_FILE = require('node:path').join(
  require('node:os').tmpdir(), `atlas-write-freeze-routes-${process.pid}.json`);

// ── the Sheets stub: every mutation is COUNTED ───────────────────────────────
const sheetCalls = { append: [], delete: [], update: [] };
// DATA ROWS ONLY. sheets.js:784-790 slices the header off before returning, and
// the undo handler maps sheet row N to index N-2 on that basis — a stub that kept
// the header shifted every row by one and made undo refuse for the wrong reason.
// Sheet row 2 is therefore index 0.
const LOG_ROWS = [
  ['2026-08-09', '20260809-AM-01', 'Back Squat', 'Back Squat', 'legs', 'SQ01', 1, 225, 5, 2, '', 1125],
];
const fakeSheets = {
  validateConfig: () => {},
  // sheets.js:664-696 returns the RAW googleapis response, so the stub must too —
  // index.js reads `response.data.updates`. A stub that returned the inner object
  // made the Save path 500, and a P12 comparison of two identical ERROR responses
  // would prove nothing about the dormant write path.
  appendRows: async (tabName, rows) => {
    sheetCalls.append.push({ tabName, rows });
    const last = 1 + rows.length;
    return { data: { updates: { updatedRows: rows.length, updatedRange: `${tabName}!A2:L${last}` } } };
  },
  deleteRowsByRange: async (...args) => { sheetCalls.delete.push(args); return { rowsDeleted: 1 }; },
  updateColumnCells: async (...args) => { sheetCalls.update.push(args); return { updatedCells: 1 }; },
  getExerciseCatalog: async () => [
    ['exercise', 'muscle_group', 'lift_code', 'canonical_exercise'],
    ['back squat', 'legs', 'SQ01', 'Back Squat'],
  ],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async (name) => (name === 'Log_Cleaned' ? LOG_ROWS.map((r) => [...r]) : []),
  getSpreadsheetTabs: async () => [
    'Log_Cleaned', 'Effort', 'Coaching_Notes', 'Constraints', 'Modality_Log', 'Bodyweight',
    'Session_Plans', 'Session_Plan_Sets',
  ],
  invalidateTabCache: () => {},
  ensureSheetTab: async () => {},
  readRange: async () => [],
  runWithReadContext: (fn) => fn(),
  declareRequestRanges: () => {},
  currentRequestIdentity: () => null,
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
  isTransientReadError: () => false,
  isTransientAppendError: () => false,
  classifySheetsReadError: () => 'unknown',
  sheetsReadFailureClass: () => 'unknown',
  confirmTabMissing: async () => false,
  getHeaderRow: async () => [],
  getSafeSpreadsheetConfig: () => ({}),
};
require.cache[require.resolve('../sheets')] = {
  id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets,
};

// ── the Supabase adapter stub: the ONLY thing the freeze control reads ───────
//
// `readWriteFreeze` is what every test below steers. `isConfigured` is what arms
// the control, and the dormant block proves the read is never issued while it is
// false. The shadow lane stays off throughout, so nothing here writes.
const supabaseState = { configured: false, rows: [], throws: null, readCount: 0 };
const fakeAdapter = {
  isConfigured: () => supabaseState.configured,
  isShadowWriteEnabled: () => false,
  readWriteFreeze: async () => {
    supabaseState.readCount += 1;
    if (supabaseState.throws) throw supabaseState.throws;
    return supabaseState.rows;
  },
  close: async () => {},
  ROLE_ENV: {}, SQL: {}, INSTANCE_ID: 'test', ROUTE_EFFECT_AUTHORITY: {},
};
require.cache[require.resolve('../services/supabaseAdapter')] = {
  id: require.resolve('../services/supabaseAdapter'),
  filename: require.resolve('../services/supabaseAdapter'), loaded: true, exports: fakeAdapter,
};
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true,
  exports: {
    parseWorkoutScreenshot: async () => ({
      parsed_metrics: {
        date: '2026-08-09', duration: '00:42:00', activeCalories: 410, totalCalories: 520,
        averageHR: 148, peakHR: 171, workoutType: 'Traditional Strength Training',
      },
    }),
  },
};

const writeFreeze = require('../services/writeFreeze');
const { peekWrite, resetIdempotencyStore } = require('../services/idempotency');
const session = require('../services/session');
// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
const { app } = require('../index');

const OPEN_ROW = { id: true, frozen: false, reason: 'dormant', set_by: 'migration:S3', set_at: new Date() };
const FROZEN_ROW = { id: true, frozen: true, reason: 'cutover window — §5.5 step 1', set_by: 'dale', set_at: new Date() };

function dormant() {
  supabaseState.configured = false;
  supabaseState.rows = [];
  supabaseState.throws = null;
  writeFreeze.__resetArmingForTests();
}
function armed(rows, throws = null) {
  supabaseState.configured = true;
  supabaseState.rows = rows;
  supabaseState.throws = throws;
  writeFreeze.__resetArmingForTests();
}

let server; let baseUrl;
test.before(async () => {
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

async function post(path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function postForm(path, form, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', body: form, headers: { 'x-atlas-api-key': 'test-api-key', ...headers },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── THE SEVEN beginWrite ROUTES, each with a genuinely valid live-write body ──
//
// Valid on purpose: a request rejected for a bad body would 4xx with no append
// whether or not the freeze exists, and would prove nothing about the freeze.
function completeWorkoutForm(writeId) {
  const form = new FormData();
  form.append('log_rows_json', JSON.stringify([]));
  form.append('write_id', writeId);
  form.append('date', '2026-08-09');
  form.append('image', new Blob(['watch'], { type: 'image/png' }), 'watch.png');
  return form;
}

const ROUTES = [
  {
    name: '/api/coaching-notes',
    liveStatus: 200,
    send: (id) => post('/api/coaching-notes', { note: 'felt strong today', write_id: id }),
  },
  {
    name: '/api/constraints',
    liveStatus: 200,
    send: (id) => post('/api/constraints', { kind: 'injury', target: 'left knee', rule: 'avoid', write_id: id }),
  },
  {
    name: '/api/log-modality',
    liveStatus: 200,
    send: (id) => post('/api/log-modality', {
      text: '8 x 400m / 90 sec RPE 8', session_id: '20260809-AM-01', date: '2026-08-09', write_id: id,
    }),
  },
  {
    name: '/api/bodyweight',
    liveStatus: 200,
    send: (id) => post('/api/bodyweight', { date: '2026-08-09', weight: 182.4, write_id: id }),
  },
  {
    name: '/api/complete-workout',
    liveStatus: 200,
    send: (id) => postForm('/api/complete-workout', completeWorkoutForm(id)),
  },
  {
    name: '/api/log-workout',
    liveStatus: 200,
    send: (id) => post('/api/log-workout', {
      session_id: '20260809-AM-01', date: '2026-08-09', write_id: id,
      log_rows: [{ exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 }],
    }),
  },
  {
    name: '/api/log-workout/undo-last',
    liveStatus: 200,
    send: (id) => post('/api/log-workout/undo-last', {
      log_appended_range: 'Log_Cleaned!A2:L2', session_id: '20260809-AM-01',
      rows_to_delete: 1, confirm_delete: true, write_id: id,
    }),
  },
];

function resetCounters() {
  sheetCalls.append.length = 0;
  sheetCalls.delete.length = 0;
  sheetCalls.update.length = 0;
  supabaseState.readCount = 0;
}

/* ══════════ §6.2 P10 — all seven fail closed, with ZERO side effects ══════════ */

for (const route of ROUTES) {
  test(`P10 — ${route.name} refuses with an explicit 503 and no side effect while frozen`, async () => {
    armed([FROZEN_ROW]);
    resetIdempotencyStore();
    resetCounters();

    const writeId = `frozen-${route.name.replace(/\W+/g, '-')}`;
    const { status, body } = await route.send(writeId);

    assert.equal(status, 503, `${route.name} must refuse with 503: ${JSON.stringify(body)}`);
    assert.equal(body.status, 'error');
    assert.equal(body.details.error_code, 'writes_frozen');
    assert.equal(body.details.freeze_state, 'frozen');
    assert.equal(body.details.freeze_reason, 'cutover window — §5.5 step 1',
      'the refusal states its reason — never a silent drop');
    assert.equal(body.details.sheet_written, false);
    assert.equal(body.details.no_write_confirmed, true);

    // NO SIDE EFFECT, measured on all three of P10's named surfaces.
    assert.deepEqual(sheetCalls.append, [], 'no Sheets append');
    assert.deepEqual(sheetCalls.delete, [], 'no Sheets delete');
    assert.deepEqual(sheetCalls.update, [], 'no Sheets cell update');
    assert.equal(peekWrite(writeId), null, 'no receipt claimed — the write_id stays completely fresh');
    // The shadow lane is off and could not have run: nothing reached beginWrite.
    assert.equal(supabaseState.readCount, 1, 'exactly one freeze read for the request');
  });
}

test('P10 — a refused write_id is still usable afterwards; a freeze consumes nothing', async () => {
  armed([FROZEN_ROW]);
  resetIdempotencyStore();
  const writeId = 'reusable-after-freeze';
  assert.equal((await post('/api/coaching-notes', { note: 'a', write_id: writeId })).status, 503);

  armed([OPEN_ROW]);
  resetCounters();
  const second = await post('/api/coaching-notes', { note: 'a', write_id: writeId });
  assert.equal(second.status, 200, 'the same write_id must write normally once the freeze lifts');
  assert.equal(second.body.data.duplicate_write, false);
  assert.equal(sheetCalls.append.length, 1);
});

/* ══════════ §6.2 P11 — control loss cannot reopen writes ══════════ */

for (const route of ROUTES) {
  test(`P11 — ${route.name} refuses when the freeze read FAILS`, async () => {
    armed([], new Error('connection terminated unexpectedly'));
    resetIdempotencyStore();
    resetCounters();

    const { status, body } = await route.send(`readfail-${route.name.replace(/\W+/g, '-')}`);
    assert.equal(status, 503, `${route.name} must refuse a write it cannot prove is permitted`);
    assert.equal(body.details.error_code, 'writes_frozen');
    assert.equal(body.details.freeze_state, 'read_failed');
    assert.equal(body.details.freeze_reason, null, 'a failed read reports no owner reason it never read');
    assert.deepEqual(sheetCalls.append, [], 'no Sheets append');
    assert.deepEqual(sheetCalls.delete, [], 'no Sheets delete');
  });
}

test('P11 — an instance that has NEVER read the row successfully refuses from its first request', async () => {
  armed([], new Error('ECONNREFUSED'));
  resetIdempotencyStore();
  resetCounters();
  const { status } = await post('/api/log-workout', {
    session_id: '20260809-AM-01', date: '2026-08-09', write_id: 'never-read-ok',
    log_rows: [{ exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 }],
  });
  assert.equal(status, 503);
  assert.deepEqual(sheetCalls.append, []);
});

test('P11 — the row VANISHING mid-life refuses; a previously open read authorizes nothing later', async () => {
  armed([OPEN_ROW]);
  resetIdempotencyStore();
  resetCounters();
  assert.equal((await post('/api/coaching-notes', { note: 'first', write_id: 'vanish-1' })).status, 200);

  supabaseState.rows = [];                       // the row is deleted under a live process
  const { status, body } = await post('/api/coaching-notes', { note: 'second', write_id: 'vanish-2' });
  assert.equal(status, 503);
  assert.equal(body.details.freeze_state, 'row_missing');
  assert.equal(sheetCalls.append.length, 1, 'only the first, admitted write appended');
});

/* ══════════ §6.2 P12 — dormant, and equal to the admitted path ══════════ */

test('P12 — while dormant the control issues NO freeze read at all', async () => {
  dormant();
  resetIdempotencyStore();
  resetCounters();
  const { status } = await post('/api/coaching-notes', { note: 'dormant', write_id: 'dormant-read-count' });
  assert.equal(status, 200);
  assert.equal(supabaseState.readCount, 0,
    'an unconfigured runtime performs no Supabase work whatsoever — this build is inert until the owner configures it');
});

// Volatile per-response fields cannot be compared and are not part of the claim.
function normalize(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  delete clone.requestId;
  delete clone.duration_ms;
  const strip = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (/(_at|_at_ms|timestamp|session_id|write_id|turn_id|_ms)$/.test(key)) delete node[key];
      else strip(node[key]);
    }
  };
  strip(clone);
  return clone;
}

for (const route of ROUTES) {
  test(`P12 — ${route.name} answers identically dormant and armed-open`, async () => {
    dormant();
    resetIdempotencyStore();
    resetCounters();
    const whileDormant = await route.send(`p12-dormant-${route.name.replace(/\W+/g, '-')}`);
    const dormantAppends = sheetCalls.append.map((c) => c.tabName);

    armed([OPEN_ROW]);
    resetIdempotencyStore();
    resetCounters();
    const whileOpen = await route.send(`p12-open-${route.name.replace(/\W+/g, '-')}`);
    const openAppends = sheetCalls.append.map((c) => c.tabName);

    // PINNED, so the comparison can never silently degrade into "two identical
    // 500s". An earlier version of this stub returned the wrong appendRows shape
    // and this test passed by comparing two error bodies.
    assert.equal(whileDormant.status, route.liveStatus,
      `${route.name} must take its real live-write path here, not an error branch: ${JSON.stringify(whileDormant.body)}`);
    assert.equal(whileOpen.status, whileDormant.status, `${route.name} status must not change`);
    assert.deepEqual(normalize(whileOpen.body), normalize(whileDormant.body),
      `${route.name} athlete-facing body must not change when the control runs and admits`);
    assert.deepEqual(openAppends, dormantAppends, `${route.name} must write the same rows either way`);
  });
}

/* ══════════ §6.2 P13 — the receipt migration seam's auth negatives ══════════ */

test('P13 — the seam is INERT while writes are open: both routes refuse with no side effect', async () => {
  armed([OPEN_ROW]);
  for (const path of ['/api/migration/receipts/export', '/api/migration/receipts/import']) {
    const { status, body } = await post(path, { records: [] });
    assert.equal(status, 403, `${path} must be inert outside a frozen window`);
    assert.equal(body.details.error_code, 'migration_seam_closed');
    assert.equal(body.details.freeze_state, 'open');
  }
});

test('P13 — the seam refuses when the freeze read FAILS, exactly like the write routes', async () => {
  armed([], new Error('connection terminated unexpectedly'));
  const { status, body } = await post('/api/migration/receipts/export', {});
  assert.equal(status, 403);
  assert.equal(body.details.freeze_state, 'read_failed');
});

test('P13 — THE AUTH NEGATIVE: a valid session cookie with no x-atlas-api-key is refused while frozen', async () => {
  armed([FROZEN_ROW]);
  const { token } = session.issueToken(process.env.ATLAS_SESSION_SECRET);

  // The ordinary /api middleware ADMITS this request — that is the whole point of
  // the finding. Proven here rather than assumed: the same cookie reaches a normal
  // /api route successfully.
  const control = await fetch(`${baseUrl}/api/session/status`, {
    headers: { cookie: `${session.COOKIE_NAME}=${token}` },
  });
  assert.equal(control.status, 200, 'the cookie really is a valid /api credential');

  const res = await fetch(`${baseUrl}/api/migration/receipts/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `${session.COOKIE_NAME}=${token}` },
    body: '{}',
  });
  const body = await res.json();
  assert.equal(res.status, 403,
    'a browser session must never replace live duplicate-write safety state, even inside the window');
  assert.equal(body.details.freeze_state, 'api_key_required');

  // And the import direction, which is the one that MUTATES.
  const importRes = await fetch(`${baseUrl}/api/migration/receipts/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `${session.COOKIE_NAME}=${token}` },
    body: JSON.stringify({ records: [] }),
  });
  assert.equal(importRes.status, 403);
});

test('P13 — an unauthenticated request never reaches the seam at all', async () => {
  armed([FROZEN_ROW]);
  const res = await fetch(`${baseUrl}/api/migration/receipts/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 401, 'the ordinary middleware still fails closed first');
});

test('P13 — with the API key AND a proven freeze, export returns the live snapshot', async () => {
  armed([FROZEN_ROW]);
  resetIdempotencyStore();

  // A receipt minted BEFORE the freeze must still be in the map afterwards.
  armed([OPEN_ROW]);
  assert.equal((await post('/api/coaching-notes', { note: 'pre-freeze', write_id: 'seam-export-1' })).status, 200);
  armed([FROZEN_ROW]);

  const { status, body } = await post('/api/migration/receipts/export', {});
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.data.process_id, 'every export carries the process identity the runbook compares');
  assert.equal(typeof body.data.persist_disabled, 'boolean');
  assert.ok(body.data.disk_vs_map, 'the disk-vs-map completeness evidence travels with the snapshot');
  const ids = body.data.records.map((r) => r.write_id);
  assert.ok(ids.includes('seam-export-1'), 'the live map is what is exported');

  // Repeated exports report the SAME process id — the invariant the handover checks.
  const again = await post('/api/migration/receipts/export', {});
  assert.equal(again.body.data.process_id, body.data.process_id);
});

test('P13 — import REPLACES the live map of the already-running process', async () => {
  armed([FROZEN_ROW]);
  resetIdempotencyStore();

  const carried = {
    write_id: 'carried-across-the-boundary',
    status: 'completed',
    created_at_ms: Date.now(),
    created_at: new Date().toISOString(),
    metadata: { endpoint: '/api/log-workout' },
    response: { sheet_write: 'success', log_rows_written: 3 },
  };
  const { status, body } = await post('/api/migration/receipts/import', { records: [carried] });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.applied, true);
  assert.deepEqual(body.data.accepted, ['carried-across-the-boundary']);

  // THE PROOF THAT MATTERS: the LIVE decider now sees a record this process never
  // loaded from disk. peekWrite is the same function the routes consult.
  const seen = peekWrite('carried-across-the-boundary');
  assert.ok(seen, 'the restored record must be visible to the live process');
  assert.equal(seen.status, 'completed');
  assert.deepEqual(seen.response, { sheet_write: 'success', log_rows_written: 3 });
});

test('P13 — a rejected record aborts the whole import and changes nothing', async () => {
  armed([FROZEN_ROW]);
  resetIdempotencyStore();

  const good = {
    write_id: 'good-one', status: 'completed', created_at_ms: Date.now(),
    metadata: {}, response: { sheet_write: 'success' },
  };
  const bad = { write_id: 'bad-one', status: 'nonsense', created_at_ms: Date.now() };

  const { status, body } = await post('/api/migration/receipts/import', { records: [good, bad] });
  assert.equal(status, 422);
  assert.equal(body.details.applied, false);
  assert.equal(body.details.rejected[0].reason, 'status_invalid');
  assert.equal(peekWrite('good-one'), null,
    'a partial replacement would silently delete duplicate protection for the rejected ids');
});
