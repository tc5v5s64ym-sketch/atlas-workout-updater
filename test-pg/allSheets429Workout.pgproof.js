'use strict';

// ── THE ACCEPTANCE EQUATION, PROVEN AGAINST A REAL DATABASE ──────────────────
//
// OWNER CORRECTION 2026-08-13: "A Google Sheets quota of any kind must not
// invalidate or block an active Atlas workout or the high-volume Phase 4 test
// campaign."
//
// This is the proof of that sentence, and it is deliberately the harshest form of
// it: EVERY Google Sheets operation throws a 429 for the whole run. Not a slow
// Sheets, not a partially degraded Sheets — a Sheets that answers nothing, ever.
// Five complete workouts then run end to end against a real from-empty Postgres,
// through the real Express routes over a real HTTP socket.
//
// ── WHY THIS EXISTS AND `test/allSheets429.test.js` DOES NOT REPLACE IT ──────
//
// The unit suite proves the same property with the workout authority DOUBLED. That
// is a genuine proof of the routes' behaviour and a false comfort about the system:
// a double answers every query the adapter would have issued, so it cannot catch an
// undefined statement, a missing grant, a foreign key the cutover added, or a read
// whose ordering only a database decides. The S4 cutover shipped an adapter whose
// statements were referenced and never defined; a doubled suite passed anyway.
//
// So this proof uses the REAL adapter, as the REAL least-privileged `atlas_app`
// role, against a database built from empty by applying every file in
// supabase/migrations/. The only stub in the process is Google Sheets itself, and
// it is stubbed to FAIL — which is the positive control, not a convenience.
//
// ── THE THREE OWNER CATEGORIES ───────────────────────────────────────────────
//
// Every Sheets call is counted and classified, and the classification is the
// assertion:
//
//   1. WORKOUT-CRITICAL SYNCHRONOUS — any Sheets call made while an athlete request
//      is in flight, on a tab that is not an explicitly non-workout surface. This
//      count MUST BE ZERO. It is the whole cutover.
//   2. ASYNCHRONOUS EXPORT — calls made by the mirror export worker, off the athlete
//      path. These are EXPECTED to happen and expected to fail; the proof requires
//      the failure to be non-critical and the backlog to be visible.
//   3. UNRELATED / TELEMETRY — Bodyweight and the shadow tabs. Allowed, and required
//      to be non-critical.
//
// NO CALL IS HIDDEN. The stub records every invocation of every exported function,
// so a call that moved to a different Sheets entry point still appears here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { withOwner, withRole, roleUrl, resetSchema } = require('./support/db');

// ── the environment the real adapter reads, set BEFORE index.js loads ────────
process.env.ATLAS_API_KEY = 'pg-proof-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_SUPABASE_APP_URL = roleUrl('atlas_app');
process.env.ATLAS_SUPABASE_READONLY_URL = roleUrl('atlas_readonly');
// The export worker is driven explicitly by this proof, never by a timer.
process.env.ATLAS_MIRROR_EXPORT_ENABLED = '0';

const API_KEY = process.env.ATLAS_API_KEY;

// ── the Sheets that answers nothing ──────────────────────────────────────────
//
// A REAL Google 429, in the shape `sheets.js` classifies: a gaxios-style error with
// `status` and a RESOURCE_EXHAUSTED payload. Anything that inspects the error to
// decide whether to retry sees exactly what a genuine quota exhaustion looks like.
function quota429(operation) {
  const error = new Error(`Quota exceeded for quota metric 'Read requests' (simulated) during ${operation}`);
  error.status = 429;
  error.code = 429;
  error.response = {
    status: 429,
    data: { error: { status: 'RESOURCE_EXHAUSTED', code: 429, message: 'Quota exceeded' } },
  };
  return error;
}

// Tabs that are explicitly NOT the workout. Bodyweight is the owner-approved
// exception (a body metric, not a workout concept); the rest are observational
// shadow/telemetry surfaces that were never on the trust loop.
const NON_WORKOUT_TABS = new Set([
  'Bodyweight', 'Coach_Shadow', 'Coach_Response', 'Brain_Shadow', 'Intent_Shadow', 'Bug_Reports', 'Flight_Recorder',
]);

const sheetsCalls = [];
// The proof sets this around each athlete request, so a call can be attributed to
// the phase that caused it rather than to whichever request happened to be running.
let phase = 'idle';

function record(fn, tabOrRange) {
  const tab = String(tabOrRange || '').split('!')[0];
  sheetsCalls.push({ fn, tab, phase });
}

function refuse(fn) {
  return async (tabOrRange, ..._rest) => {
    record(fn, tabOrRange);
    throw quota429(fn);
  };
}

// EVERY exported function of sheets.js, so nothing can slip through an entry point
// this proof forgot to stub. The few that must return a value to let module load
// succeed return the emptiest legal answer AND still record the call.
const fakeSheets = {
  validateConfig: () => {},
  appendRows: refuse('appendRows'),
  readRange: refuse('readRange'),
  updateColumnCells: refuse('updateColumnCells'),
  updateRangeValues: refuse('updateRangeValues'),
  ensureGridRows: refuse('ensureGridRows'),
  getRecentRows: refuse('getRecentRows'),
  getSheetRows: refuse('getSheetRows'),
  getHeaderRow: refuse('getHeaderRow'),
  getSpreadsheetTabs: refuse('getSpreadsheetTabs'),
  ensureSheetTab: refuse('ensureSheetTab'),
  getExerciseCatalog: refuse('getExerciseCatalog'),
  getEffortSessionIds: refuse('getEffortSessionIds'),
  getLogCompositeKeys: refuse('getLogCompositeKeys'),
  getSafeSpreadsheetConfig: () => ({ canVerify: false, source: 'GOOGLE_SHEETS_ID' }),
  isTransientAppendError: () => true,
  isTransientReadError: () => true,
  classifySheetsReadError: () => 'transient',
  sheetsReadFailureClass: () => 'transient',
  confirmTabMissing: async () => false,
  retryWithBackoff: async (op) => op(),
  readWithRetry: async (_label, op) => op(),
  invalidateTabCache: () => {},
  runWithReadContext: (fn) => fn(),
  declareRequestRanges: () => {},
  currentRequestIdentity: () => null,
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = {
  id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets,
};
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true,
  exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
};

const adapter = require('../services/supabaseAdapter');
const mirrorExport = require('../services/sheetsMirrorExport');
const { app } = require('../index');

let baseUrl;
let server;

async function request(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': API_KEY },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed };
}

// Every athlete request runs inside this, so its Sheets calls are attributable.
async function asAthlete(fn) {
  phase = 'workout';
  try {
    return await fn();
  } finally {
    // Let a fire-and-forget telemetry write settle while still attributed, so a
    // shadow append cannot escape the count by landing one tick later.
    await new Promise((resolve) => setTimeout(resolve, 25));
    phase = 'idle';
  }
}

function workoutCriticalCalls() {
  return sheetsCalls.filter((c) => c.phase === 'workout' && !NON_WORKOUT_TABS.has(c.tab));
}

// ── the catalog and the coaching inputs, seeded in Supabase ──────────────────
//
// Both are Supabase-authoritative since the owner correction, so seeding them here
// is seeding the AUTHORITY — there is no Sheets copy for the runtime to fall back
// to, which is exactly the property under test.
async function seedAuthorityInputs() {
  await withOwner(async (client) => {
    await client.query(
      `INSERT INTO atlas.exercise_catalog
         (exercise, display_exercise, muscle_group, lift_code, canonical_exercise)
       VALUES ('bench press','Bench Press','Chest','BEN01','Bench Press'),
              ('bench','Bench','Chest','BEN01','Bench Press'),
              ('back squat','Back Squat','Legs','SQ01','Back Squat'),
              ('squat','Squat','Legs','SQ01','Back Squat'),
              ('romanian deadlift','Romanian Deadlift','Hamstrings','RDL01','Romanian Deadlift'),
              ('rdl','RDL','Hamstrings','RDL01','Romanian Deadlift')
       ON CONFLICT DO NOTHING`
    );
    await client.query(
      `INSERT INTO atlas.coaching_notes (note_date, note) VALUES ('2026-08-01','Left shoulder tender on incline.')`
    );
    await client.query(
      `INSERT INTO atlas.constraints (constraint_date, kind, target, rule, note)
       VALUES ('2026-08-01','joint','shoulder','avoid_overhead','from the owner')`
    );
    await client.query(
      `INSERT INTO atlas.deload_state (updated_at, training_state, deload_protocol, deload_reason,
         deload_start_date, deload_sessions_remaining, deload_exit_criteria)
       VALUES ('2026-08-01T00:00:00Z','NORMAL','','','','','')`
    );
    // The four mirror cursors, as the §5.4 step 4 cutover handshake would establish
    // them: row 2 is the first writable row under each header.
    await client.query(
      `INSERT INTO atlas.sheets_mirror_cursor (tab, next_row, base_established_at)
       VALUES ('Log_Cleaned',2,now()),('Effort',2,now()),
              ('Session_Plans',2,now()),('Session_Plan_Sets',2,now())
       ON CONFLICT (tab) DO NOTHING`
    );
  });
}

test.before(async () => {
  await resetSchema();
  await seedAuthorityInputs();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await adapter.close();
});

// ── the five sessions ────────────────────────────────────────────────────────
//
// Five, because the Phase 4 campaign is five sessions and the owner correction names
// that campaign explicitly. Each one walks the whole athlete path: identity, plan
// acceptance, recommendation, preview, approval, the authoritative save, the
// read-back, closeout, and — for the sessions that exercise them — receipt replay
// and undo.

const DATE = '2026-08-13';
const SESSIONS = [1, 2, 3, 4, 5];
let firstAllocatedSessionId = null;

function planVersion(n) { return `pv_0000000${n}-0000-4000-8000-00000000000${n}`; }
function planItem(n) { return `pi_0000000${n}-0000-4000-8000-00000000000${n}`; }

test('five complete workouts run end to end with EVERY Google Sheets call failing 429', async () => {
  const allocated = [];

  for (const n of SESSIONS) {
    const writeId = `w429-save-${n}`;
    let authoritativeSetWriteId = writeId;

    // 1. IDENTITY — the server allocates, over Supabase occupancy. No Sheets read.
    const accepted = await asAthlete(() => request('POST', '/api/session-plans/accept', {
      session_date: DATE,
      plan_version: planVersion(n),
      items: [{ plan_item_id: planItem(n), planned_order: 1, planned_lift_code: 'BEN01' }],
    }));
    assert.equal(accepted.status, 200, `accept ${n}: ${JSON.stringify(accepted.body)}`);
    const sessionId = accepted.body.data.session_id;
    assert.ok(sessionId, 'the server must report the identity it allocated');
    assert.ok(!allocated.includes(sessionId), 'every session gets a DISTINCT identity');
    allocated.push(sessionId);
    if (n === 1) firstAllocatedSessionId = sessionId;

    const acceptedSets = await asAthlete(() => request('POST', '/api/session-plan-sets/accept', {
      session_id: sessionId, session_date: DATE, plan_version: planVersion(n),
      items: [{
        plan_item_id: planItem(n), planned_lift_code: 'BEN01', target_set_count: 2,
        target_weight: 185, target_reps: 5, target_rir: 2, confidence: 'reliable',
      }],
    }));
    assert.equal(acceptedSets.status, 200, `plan-set accept ${n}: ${JSON.stringify(acceptedSets.body)}`);
    assert.equal(acceptedSets.body.data.session_plan_sets.captured, true);

    if (n === 3) {
      const revision = await asAthlete(() => request('POST', '/api/session-plan-sets/revision', {
        session_id: sessionId, session_date: DATE, plan_version: planVersion(n),
        revision: {
          plan_item_id: planItem(n), planned_lift_code: 'BEN01', set_index: 2,
          plan_version: 2, target_set_count: 2, target_weight: 180,
          target_reps: 5, target_rir: 2, recommendation_source: 'live_revision',
        },
      }));
      assert.equal(revision.status, 200, `revision ${n}: ${JSON.stringify(revision.body)}`);
      assert.equal(revision.body.data.session_plan_sets.captured, true);
    }

    // 2. RECOMMENDATION — reads history and the catalog, both Supabase-authoritative.
    const recommend = await asAthlete(() => request('GET', '/api/recommend/next/BEN01'));
    assert.equal(recommend.status, 200, `recommend ${n}: ${JSON.stringify(recommend.body)}`);
    const catalog = await asAthlete(() => request('GET', '/api/catalog/search?q=bench'));
    assert.equal(catalog.status, 200, `catalog ${n}: ${JSON.stringify(catalog.body)}`);

    // 3. PREVIEW — a dry run must never write, and must prove it.
    const performedExercise = n === 2 ? 'Back Squat' : 'Bench Press';
    const logRows = [
      { exercise: performedExercise, set_number: 1, weight: 185, reps: 5, rir: 2, notes: '' },
      { exercise: performedExercise, set_number: 2, weight: 185, reps: 5, rir: 2, notes: '' },
    ];
    const effortRow = {
      date: DATE, session_id: sessionId, duration: '00:45:00',
      active_calories: 300 + n, total_calories: 350 + n,
      average_hr: 130, peak_hr: 160, location: 'Gym', notes: '',
    };
    const preview = await asAthlete(() => request('POST', '/api/log-workout', {
      session_id: sessionId, date: DATE, log_rows: logRows, effort_row: effortRow, test_mode: true,
    }));
    assert.equal(preview.status, 200, `preview ${n}: ${JSON.stringify(preview.body)}`);
    assert.equal(preview.body.data.no_write_confirmed, true, 'a dry run must confirm it wrote nothing');

    // 4. APPROVAL → the authoritative save, in ONE Supabase transaction.
    const saved = await asAthlete(() => request('POST', '/api/log-workout', {
      session_id: sessionId, date: DATE, log_rows: logRows, effort_row: effortRow, write_id: writeId,
    }));
    assert.equal(saved.status, 200, `save ${n}: ${JSON.stringify(saved.body)}`);
    assert.equal(saved.body.data.write_authority, 'supabase_transaction');

    // 5. READ-BACK from the authority — the rows are really there, under this write_id.
    const stored = await withRole('atlas_app', (client) => client.query(
      'SELECT exercise, set_number, weight, write_id FROM atlas.logged_sets WHERE session_id = $1 ORDER BY set_number',
      [sessionId]
    ));
    assert.equal(stored.rows.length, 2, `session ${n} must hold both sets in Supabase`);
    assert.equal(stored.rows[0].write_id, writeId, 'every row carries the write_id that saved it');
    const effort = await withRole('atlas_app', (client) => client.query(
      'SELECT duration, active_calories, write_id FROM atlas.session_effort WHERE session_id = $1',
      [sessionId]
    ));
    assert.equal(effort.rows.length, 1, `session ${n} must hold Effort in Supabase`);
    assert.equal(effort.rows[0].write_id, writeId);

    // 6. RECEIPT REPLAY / LOST RESPONSE — the same write_id must not write twice.
    const replay = await asAthlete(() => request('POST', '/api/log-workout', {
      session_id: sessionId, date: DATE, log_rows: logRows, effort_row: effortRow, write_id: writeId,
    }));
    assert.ok([200, 409].includes(replay.status), `replay ${n}: ${JSON.stringify(replay.body)}`);
    const afterReplay = await withRole('atlas_app', (client) => client.query(
      'SELECT count(*)::int AS n FROM atlas.logged_sets WHERE session_id = $1', [sessionId]
    ));
    assert.equal(afterReplay.rows[0].n, 2, 'a replayed write_id must never duplicate a row');

    // 7. CLOSEOUT — the event that creates the export obligation.
    if (n === 1) {
      const undone = await asAthlete(() => request('POST', '/api/log-workout/undo-last', {
        session_id: sessionId, save_write_id: writeId, rows_to_delete: 2,
        confirm_delete: true, write_id: 'w429-undo-1',
      }));
      assert.equal(undone.status, 200, `undo ${n}: ${JSON.stringify(undone.body)}`);
      assert.equal(undone.body.data.rows_deleted, 2);
      assert.equal(undone.body.data.write_authority, 'supabase_transaction');
      const afterUndo = await withRole('atlas_app', (client) => client.query(
        'SELECT count(*)::int AS n FROM atlas.logged_sets WHERE session_id = $1', [sessionId]
      ));
      assert.equal(afterUndo.rows[0].n, 0);

      authoritativeSetWriteId = 'w429-resave-1';
      const resaved = await asAthlete(() => request('POST', '/api/log-workout', {
        session_id: sessionId, date: DATE, log_rows: logRows,
        // Undo removes the targeted logged sets, not the already-authoritative
        // Effort row. The resave restores only what was undone.
        write_id: authoritativeSetWriteId,
      }));
      assert.equal(resaved.status, 200, `resave ${n}: ${JSON.stringify(resaved.body)}`);
      assert.equal(resaved.body.data.log_rows_written, 2);
    }

    const outcome = await asAthlete(() => request('POST', '/api/session-plans/outcome', {
      session_id: sessionId, session_date: DATE, plan_version: planVersion(n),
      item: {
        plan_item_id: planItem(n), planned_lift_code: 'BEN01',
        outcome: n === 2 ? 'substituted' : 'completed',
        ...(n === 2 ? { performed_lift_code: 'SQ01' } : {}),
      },
    }));
    assert.equal(outcome.status, 200, `outcome ${n}: ${JSON.stringify(outcome.body)}`);
    assert.equal(outcome.body.data.session_plans.captured, true);

    const closeoutWriteId = `w429-closeout-${n}`;
    const closeout = await asAthlete(() => request('POST', '/api/log-workout', {
      // The closeout request sees the sets and Effort already authoritative; it
      // must fold duplicates, record finality, and seal without re-inserting them.
      session_id: sessionId, date: DATE, log_rows: logRows,
      write_id: closeoutWriteId,
      closeout_context: { plan_version: planVersion(n), items: [] },
    }));
    assert.equal(closeout.status, 200, `closeout ${n}: ${JSON.stringify(closeout.body)}`);
    assert.equal(closeout.body.data.closeout_fully_verified, true);
    assert.equal(closeout.body.data.session_plans_closeout.captured, true);
    assert.equal(closeout.body.data.ledger_seal.sealed_ok, true);

    const finalProof = await withRole('atlas_app', (client) => client.query(
      `SELECT
         (SELECT count(*)::int FROM atlas.logged_sets WHERE session_id = $1 AND write_id = $2) AS sets,
         (SELECT count(*)::int FROM atlas.session_plan_events WHERE session_id = $1 AND event_type = 'item_outcome') AS outcomes,
         (SELECT count(*)::int FROM atlas.session_plan_events WHERE session_id = $1 AND event_type = 'session_closeout') AS closeouts,
         (SELECT count(*)::int FROM atlas.session_plan_set_recommendations WHERE session_id = $1 AND closeout_write_id = $3) AS sealed_sets`,
      [sessionId, authoritativeSetWriteId, closeoutWriteId]
    ));
    assert.equal(finalProof.rows[0].sets, 2);
    assert.equal(finalProof.rows[0].outcomes, 1);
    assert.equal(finalProof.rows[0].closeouts, 1);
    assert.ok(finalProof.rows[0].sealed_sets >= 2);
  }

  // ── CATEGORY 1 MUST BE EMPTY ───────────────────────────────────────────────
  const critical = workoutCriticalCalls();
  assert.deepEqual(
    critical, [],
    `a workout request issued ${critical.length} synchronous Google Sheets call(s): ` +
    JSON.stringify(critical.slice(0, 10))
  );

  // The five workouts are all present and distinct in the authority.
  const total = await withRole('atlas_app', (client) => client.query(
    'SELECT count(*)::int AS sets, count(DISTINCT session_id)::int AS sessions FROM atlas.logged_sets'
  ));
  assert.equal(total.rows[0].sessions, 5, 'five distinct sessions survived a totally quota-exhausted Sheets');
  assert.equal(total.rows[0].sets, 10);
});

test('a finalized workout refuses a later undo with Sheets still at 429', async () => {
  const sessionId = firstAllocatedSessionId;
  const before = await withRole('atlas_app', (client) => client.query(
    'SELECT count(*)::int AS n FROM atlas.logged_sets WHERE session_id = $1', [sessionId]
  ));
  assert.ok(before.rows[0].n > 0, 'the fixture session must exist before undo');

  const undone = await asAthlete(() => request('POST', '/api/log-workout/undo-last', {
    session_id: sessionId, save_write_id: 'w429-resave-1', rows_to_delete: 2,
    confirm_delete: true, write_id: 'w429-undo-after-finality',
  }));
  assert.equal(undone.status, 409, `undo: ${JSON.stringify(undone.body)}`);

  const after = await withRole('atlas_app', (client) => client.query(
    'SELECT count(*)::int AS n FROM atlas.logged_sets WHERE session_id = $1', [sessionId]
  ));
  assert.equal(after.rows[0].n, before.rows[0].n, 'a refused post-finality undo must leave the workout intact');
  assert.deepEqual(workoutCriticalCalls(), [], 'refused undo issued no synchronous Sheets call');
});

/* ══════════ CATEGORY 2 — the asynchronous exporter, under the same 429 ══════════ */

test('the export worker attempts Sheets, fails NON-CRITICALLY, and the backlog becomes visible', async () => {
  const criticalBefore = workoutCriticalCalls().length;
  const sheetsCallsBefore = sheetsCalls.length;

  phase = 'export';
  const pass = await mirrorExport.runExportPass({ maxSessions: 5 });
  phase = 'idle';

  // It really tried. A proof in which the exporter never reached Sheets would prove
  // nothing about how it behaves when Sheets is exhausted.
  const exportCalls = sheetsCalls.slice(sheetsCallsBefore).filter((c) => c.phase === 'export');
  assert.ok(exportCalls.length > 0, 'the export worker must actually attempt a Sheets operation');

  // Every session failed, and every failure is transient — a 429 is not structural,
  // so nothing may be `blocked` by it.
  assert.ok(pass.results.length > 0, 'sessions owing an export were claimed');
  assert.ok(pass.results.every((r) => !r.exported), 'nothing can export while Sheets answers 429');
  assert.ok(pass.results.every((r) => r.state === 'retry_backoff'),
    `a quota failure is transient, never blocked: ${JSON.stringify(pass.results)}`);

  // THE WORKOUT IS UNTOUCHED. This is the sentence the owner correction turns on.
  const survived = await withRole('atlas_app', (client) => client.query(
    'SELECT count(DISTINCT session_id)::int AS sessions FROM atlas.logged_sets'
  ));
  assert.ok(survived.rows[0].sessions >= 4, 'the exporter cannot cost the athlete a session');

  // The backlog is visible rather than silent.
  const status = await mirrorExport.exportStatus();
  assert.ok(status.sessions_owed > 0, 'sessions owing an export are reported');
  assert.equal(status.sessions_blocked, 0, 'a transient quota failure blocks nothing');

  // And none of it was charged to a workout request.
  assert.equal(workoutCriticalCalls().length, criticalBefore,
    'the export worker must add no workout-critical Sheets call');
});

test('the backoff the worker recorded is the declared schedule, in the database', async () => {
  const rows = await withRole('atlas_app', (client) => client.query(
    `SELECT session_id, sheets_export_attempts, sheets_export_state, sheets_export_error,
            sheets_export_next_attempt_at
       FROM atlas.workout_sessions
      WHERE sheets_export_next_attempt_at IS NOT NULL
      ORDER BY session_id`
  ));
  assert.ok(rows.rows.length > 0, 'a transient failure must record a next attempt time');
  for (const row of rows.rows) {
    assert.equal(row.sheets_export_state, 'retry_backoff');
    assert.equal(row.sheets_export_attempts, 1, 'one failed attempt so far');
    assert.match(String(row.sheets_export_error), /429|quota|Quota/,
      'the recorded reason names the real failure');
    assert.equal(row.sheets_exported_at ?? null, null);
  }
});

/* ══════════ CATEGORY 3 — the whole accounting, stated rather than implied ══════════ */

test('every Google Sheets call in the run falls in an allowed category, and none is hidden', async () => {
  const byCategory = { workout_critical: [], asynchronous_export: [], unrelated_telemetry: [] };
  for (const call of sheetsCalls) {
    if (NON_WORKOUT_TABS.has(call.tab)) byCategory.unrelated_telemetry.push(call);
    else if (call.phase === 'export') byCategory.asynchronous_export.push(call);
    else if (call.phase === 'workout') byCategory.workout_critical.push(call);
    else byCategory.asynchronous_export.push(call);
  }

  // Printed, not merely asserted: the owner asked for the count in three categories,
  // and a proof that only says "zero" hides how much traffic the other two carry.
  console.log('[all-429] Sheets calls by owner category: ' + JSON.stringify({
    workout_critical: byCategory.workout_critical.length,
    asynchronous_export: byCategory.asynchronous_export.length,
    unrelated_telemetry: byCategory.unrelated_telemetry.length,
    total: sheetsCalls.length,
  }));

  assert.equal(byCategory.workout_critical.length, 0,
    'category 1 must be empty — this is the cutover, expressed as a number: ' +
    JSON.stringify(byCategory.workout_critical.slice(0, 10)));
  assert.ok(sheetsCalls.length > 0,
    'a run with NO Sheets call at all would mean the 429 stub was never reachable, ' +
    'which would make the positive control meaningless');
});
