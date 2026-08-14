'use strict';

// ── THE MIRROR EXPORT WORKER — the proofs that do not need a database ─────────
//
// AUTHORITY: `docs/SUPABASE_HOT_PATH_MIGRATION.md` §5.4 and gates §6.3 P14a-P14i.
//
// WHAT THIS FILE PROVES, and what it deliberately leaves to `test-pg/`:
//
//   HERE — the worker's ORCHESTRATION and its declared decisions: the pre-write
//   range refusal (P14d), whole-tab identity verification (P14c), the no-Effort-row
//   allocation rule (P14g), the classified-failure policy and its bounded backoff
//   (P14i), acknowledgement under the claim-token guard, re-export after a mutation
//   (P14f), and the idempotent destination (P14a's observable half — the same
//   session rewrites the same cells rather than appending).
//
//   test-pg/ — the properties that ARE the database: two different sessions
//   allocating disjoint blocks concurrently, the exclusion constraint rejecting an
//   overlap, `FOR UPDATE SKIP LOCKED` claim behaviour, and the grants. A double
//   cannot prove those and this file does not pretend to.
//
// The adapter and `sheets.js` are doubled; `services/sheetsMirrorExport.js` runs for
// real. Every refusal asserted below is the module's own decision, not the double's.

const test = require('node:test');
const assert = require('node:assert/strict');

const ADAPTER_PATH = require.resolve('../services/supabaseAdapter');
const SHEETS_PATH = require.resolve('../sheets');
const AUTHORITY_PATH = require.resolve('../services/workoutAuthority');

// ── the doubled Google Sheet ─────────────────────────────────────────────────
//
// One array per tab, index 0 being the header row, exactly as `readRange` returns
// it. `updateRangeValues` writes by ABSOLUTE ADDRESS — which is the property under
// test — so the fake grows the array to reach the address rather than appending.
const sheet = {};
const sheetCalls = [];
let sheetsFailure = null;

function resetSheet() {
  sheet.Log_Cleaned = [['date_clean', 'session_id', 'exercise', 'canonical', 'muscle', 'lift', 'set', 'w', 'r', 'rir', 'notes', 'vol']];
  sheet.Effort = [['date', 'session_id', 'duration', 'ac', 'tc', 'ahr', 'phr', 'loc', 'notes']];
  sheet.Session_Plans = [['idempotency_key', 'session_id', 'session_date', 'pv', 'event_type', 'pi', 'ord', 'lift', 'mp', 'outcome', 'plc', 'cs', 'ra']];
  sheet.Session_Plan_Sets = [['idempotency_key', 'session_id', 'session_date', 'pv', 'pi', 'lift', 'idx', 'tsc', 'tw', 'tr', 'trir', 'src', 'sk', 'conf', 'cwid', 'ra']];
  sheetCalls.length = 0;
  sheetsFailure = null;
}

const fakeSheets = {
  readRange: async (rangeA1) => {
    const tab = String(rangeA1).split('!')[0];
    sheetCalls.push(['readRange', tab]);
    if (sheetsFailure === 'read') throw new Error('Quota exceeded (simulated 429)');
    return (sheet[tab] || []).map((row) => row.slice());
  },
  updateRangeValues: async (tab, startRow, rows) => {
    sheetCalls.push(['updateRangeValues', tab, startRow, rows.length]);
    if (sheetsFailure === 'write') throw new Error('Quota exceeded (simulated 429)');
    const target = sheet[tab];
    while (target.length < startRow - 1) target.push([]);
    for (let i = 0; i < rows.length; i += 1) target[startRow - 1 + i] = rows[i].slice();
    return { data: { updatedRows: rows.length } };
  },
  // Present so a stray call is loud rather than silently undefined.
  appendRows: async () => { throw new Error('the mirror export must never append'); },
};

// ── the doubled Supabase authority ───────────────────────────────────────────
const db = {
  sessions: new Map(),   // session_id -> export state
  cursors: { Log_Cleaned: 2, Effort: 2, Session_Plans: 2, Session_Plan_Sets: 2 },
  allocations: new Map(),// session_id -> { tab -> block }
  rows: { Log_Cleaned: [], Effort: [], Session_Plans: [], Session_Plan_Sets: [] },
};
let tokenSeq = 0;

function resetDb() {
  db.sessions.clear();
  db.allocations.clear();
  db.cursors = { Log_Cleaned: 2, Effort: 2, Session_Plans: 2, Session_Plan_Sets: 2 };
  db.rows = { Log_Cleaned: [], Effort: [], Session_Plans: [], Session_Plan_Sets: [] };
  tokenSeq = 0;
}

function seedSession(sessionId, { closed = true } = {}) {
  db.sessions.set(sessionId, {
    session_id: sessionId,
    session_date: '2026-08-13',
    sheets_exported_at: null,
    sheets_export_attempts: 0,
    sheets_export_error: null,
    sheets_export_state: 'queued',
    sheets_export_next_attempt_at: null,
    export_claim_token: null,
    closed,
  });
}

const fakeAdapter = {
  claimExportSession: async () => {
    for (const s of db.sessions.values()) {
      if (!s.closed) continue;
      if (s.sheets_exported_at) continue;
      if (s.sheets_export_state === 'blocked') continue;
      if (s.sheets_export_next_attempt_at && s.sheets_export_next_attempt_at > new Date()) continue;
      tokenSeq += 1;
      s.export_claim_token = `tok-${tokenSeq}`;
      return {
        session_id: s.session_id,
        session_date: s.session_date,
        export_claim_token: s.export_claim_token,
        sheets_export_attempts: s.sheets_export_attempts,
        sheets_export_state: s.sheets_export_state,
      };
    }
    return null;
  },
  allocateMirrorBlocks: async (sessionId, rowCountsByTab) => {
    const existing = db.allocations.get(sessionId);
    // A re-export REUSES its reservation — reallocating would move the session's
    // rows and strand the block it already wrote into (P14b(a)).
    if (existing) return existing;
    const blocks = {};
    for (const [tab, count] of Object.entries(rowCountsByTab)) {
      if (!count) continue;
      const start = db.cursors[tab];
      db.cursors[tab] = start + count;
      blocks[tab] = { tab, start_row: start, row_count: count, end_row: start + count - 1 };
    }
    db.allocations.set(sessionId, blocks);
    return blocks;
  },
  acknowledgeExport: async (sessionId, token) => {
    const s = db.sessions.get(sessionId);
    if (!s || s.export_claim_token !== token) return false;
    s.sheets_exported_at = new Date();
    s.sheets_export_attempts += 1;
    s.sheets_export_error = null;
    s.sheets_export_state = 'queued';
    s.sheets_export_next_attempt_at = null;
    s.export_claim_token = null;
    return true;
  },
  recordExportFailure: async (sessionId, token, { error, state, nextAttemptAt }) => {
    const s = db.sessions.get(sessionId);
    if (!s || s.export_claim_token !== token) return null;
    s.sheets_export_attempts += 1;
    s.sheets_export_error = error;
    s.sheets_export_state = state;
    s.sheets_export_next_attempt_at = nextAttemptAt;
    s.export_claim_token = null;
    return { session_id: sessionId, ...s };
  },
  exportBacklog: async () => {
    const owed = [...db.sessions.values()].filter((s) => s.closed && !s.sheets_exported_at);
    return {
      sessions_owed: owed.filter((s) => s.sheets_export_state !== 'blocked').length,
      sessions_blocked: owed.filter((s) => s.sheets_export_state === 'blocked').length,
      oldest_session_id: owed.filter((s) => s.sheets_export_state !== 'blocked')[0]?.session_id || null,
      oldest_session_date: '2026-08-13',
    };
  },
  listBlockedExports: async () => [...db.sessions.values()]
    .filter((s) => s.sheets_export_state === 'blocked')
    .map((s) => ({ ...s })),
};

const fakeAuthority = {
  loggedSetRows: async ({ sessionId = null } = {}) => db.rows.Log_Cleaned
    .filter((r) => !sessionId || String(r[1]).toLowerCase() === String(sessionId).toLowerCase())
    .map((r) => r.slice()),
  effortRows: async () => db.rows.Effort.map((r) => r.slice()),
  planEventRows: async ({ sessionId = null } = {}) => db.rows.Session_Plans
    .filter((r) => !sessionId || String(r[1]).toLowerCase() === String(sessionId).toLowerCase())
    .map((r) => r.slice()),
  planSetRows: async ({ sessionId = null } = {}) => db.rows.Session_Plan_Sets
    .filter((r) => !sessionId || String(r[1]).toLowerCase() === String(sessionId).toLowerCase())
    .map((r) => r.slice()),
};

for (const [p, exports_] of [[ADAPTER_PATH, fakeAdapter], [SHEETS_PATH, fakeSheets], [AUTHORITY_PATH, fakeAuthority]]) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports_ };
}

const exporter = require('../services/sheetsMirrorExport');

// ── fixtures ─────────────────────────────────────────────────────────────────
const S1 = '20260813-AM-01';
const S2 = '20260813-AM-02';

function logRow(sessionId, exercise, setNumber) {
  const row = new Array(12).fill('');
  row[0] = '2026-08-13'; row[1] = sessionId; row[2] = exercise; row[6] = String(setNumber);
  return row;
}
function effortRow(sessionId) {
  const row = new Array(9).fill('');
  row[0] = '2026-08-13'; row[1] = sessionId; row[2] = '45';
  return row;
}
function closeoutRow(sessionId, key) {
  const row = new Array(13).fill('');
  row[0] = key; row[1] = sessionId; row[2] = '2026-08-13'; row[4] = 'session_closeout';
  return row;
}

function seedWorkout(sessionId, { withEffort = true, sets = 2 } = {}) {
  seedSession(sessionId);
  for (let i = 1; i <= sets; i += 1) db.rows.Log_Cleaned.push(logRow(sessionId, 'Bench Press', i));
  if (withEffort) db.rows.Effort.push(effortRow(sessionId));
  db.rows.Session_Plans.push(closeoutRow(sessionId, `co-${sessionId}`));
}

test.beforeEach(() => { resetSheet(); resetDb(); });

// ── the happy path, and the destination it writes to ─────────────────────────

test('a closed session is exported into its allocated block and acknowledged', async () => {
  seedWorkout(S1);
  const pass = await exporter.runExportPass();

  assert.equal(pass.results.length, 1);
  assert.equal(pass.results[0].exported, true, JSON.stringify(pass.results[0]));
  assert.ok(db.sessions.get(S1).sheets_exported_at, 'the session is marked exported');
  assert.equal(db.sessions.get(S1).sheets_export_error, null);

  // The rows landed at the allocated address, under the header.
  assert.equal(sheet.Log_Cleaned[1][1], S1);
  assert.equal(sheet.Log_Cleaned[2][1], S1);
  assert.equal(sheet.Effort[1][1], S1);

  // NEVER BY APPEND. The whole idempotency mechanism is the deterministic address.
  assert.ok(!sheetCalls.some((c) => c[0] === 'appendRows'), 'the export must not append');
});

test('P14g: a session with no Effort row receives no Effort allocation and the cursor does not move', async () => {
  seedWorkout(S1, { withEffort: false });
  const before = db.cursors.Effort;
  const pass = await exporter.runExportPass();

  assert.equal(pass.results[0].exported, true);
  assert.equal(db.cursors.Effort, before, 'the Effort cursor must not advance for a session with no Effort row');
  assert.equal(db.allocations.get(S1).Effort, undefined, 'no Effort block is reserved');
  assert.equal(sheet.Effort.length, 1, 'the Effort tab still holds only its header');
});

test('P14b(a): a re-export reuses its allocation and rewrites the same cells, never a second copy', async () => {
  seedWorkout(S1);
  await exporter.runExportPass();
  const firstBlock = { ...db.allocations.get(S1).Log_Cleaned };
  const rowsAfterFirst = sheet.Log_Cleaned.length;

  // Any post-export mutation returns the session to the queue (P14f). Drive the
  // second export over the same session.
  const s = db.sessions.get(S1);
  s.sheets_exported_at = null;
  s.sheets_export_state = 'queued';
  await exporter.runExportPass();

  assert.deepEqual({ ...db.allocations.get(S1).Log_Cleaned }, firstBlock, 'the reservation is stable');
  assert.equal(sheet.Log_Cleaned.length, rowsAfterFirst, 'a re-export adds no rows — it overwrites its own cells');
  assert.equal(db.sessions.get(S1).sheets_exported_at !== null, true);
});

// ── P14d: the pre-write range refusal ────────────────────────────────────────

test('P14d: another session\'s row inside the allocated block refuses the write and blocks the session', async () => {
  seedWorkout(S1);
  // Seed the destination with a FOREIGN session's row before the export runs.
  sheet.Log_Cleaned[1] = logRow(S2, 'Back Squat', 1);
  const pass = await exporter.runExportPass();

  assert.equal(pass.results[0].exported, false);
  assert.equal(pass.results[0].reason, exporter.STRUCTURAL_RANGE_OCCUPIED);

  const s = db.sessions.get(S1);
  assert.equal(s.sheets_exported_at, null, 'a refused session is never marked exported');
  assert.equal(s.sheets_export_state, 'blocked', 'a structural failure leaves the queue immediately');
  assert.match(s.sheets_export_error, /mirror_range_occupied/);
  // NOTHING WAS WRITTEN — refusal, not partial overwrite.
  assert.deepEqual(sheet.Log_Cleaned[1], logRow(S2, 'Back Squat', 1), 'the occupant is untouched');
  assert.ok(!sheetCalls.some((c) => c[0] === 'updateRangeValues'), 'the worker wrote nothing at all');
});

test('P14i: a structurally blocked session is never claimed again and issues no further Sheets read', async () => {
  seedWorkout(S1);
  sheet.Log_Cleaned[1] = logRow(S2, 'Back Squat', 1);
  await exporter.runExportPass();
  assert.equal(db.sessions.get(S1).sheets_export_state, 'blocked');

  sheetCalls.length = 0;
  const second = await exporter.runExportPass();
  const third = await exporter.runExportPass();

  assert.equal(second.results.length, 0, 'a blocked session is not claimed');
  assert.equal(third.results.length, 0);
  // MEASURED IN READS, NOT INTENT. The expensive whole-tab read is what a retry
  // loop would cost, and the point of `blocked` is that it costs zero.
  assert.equal(sheetCalls.length, 0, 'a blocked session issues no whole-tab read on any later pass');
});

// ── P14c: whole-tab identity verification ────────────────────────────────────

test('P14c: a duplicate identity OUTSIDE the allocated range refuses acknowledgement', async () => {
  seedWorkout(S1, { sets: 1 });
  // A copy of this session's identity far below the block — invisible to a verifier
  // that reads only its own reservation.
  sheet.Log_Cleaned[40] = logRow(S1, 'Bench Press', 1);
  const pass = await exporter.runExportPass();

  assert.equal(pass.results[0].exported, false);
  assert.equal(pass.results[0].reason, exporter.STRUCTURAL_DUPLICATE_IDENTITY);

  const s = db.sessions.get(S1);
  assert.equal(s.sheets_exported_at, null, 'a tab holding two copies is not an exported session');
  assert.equal(s.sheets_export_state, 'blocked');
  assert.match(s.sheets_export_error, /mirror_duplicate_identity/);
  // The design forbids self-correction: no Sheets row is deleted to tidy this up.
  assert.equal(sheet.Log_Cleaned[40][1], S1, 'the duplicate is reported, never deleted');
});

// ── the classified transient failure and its bounded backoff ─────────────────

test('a transient Sheets failure is retry_backoff on the declared schedule, not blocked', async () => {
  seedWorkout(S1);
  sheetsFailure = 'write';
  const at = new Date('2026-08-13T12:00:00Z');
  const claim = await fakeAdapter.claimExportSession();
  const result = await exporter.exportClaimedSession(claim, { now: at });

  assert.equal(result.exported, false);
  assert.equal(result.state, 'retry_backoff');
  const s = db.sessions.get(S1);
  assert.equal(s.sheets_export_state, 'retry_backoff');
  assert.equal(s.sheets_exported_at, null);
  // First failure → attempts becomes 1 → 2 ^ 1 = 2 minutes.
  assert.equal(s.sheets_export_next_attempt_at.getTime() - at.getTime(), 2 * 60_000);
});

test('a session inside its backoff window is not claimed; it is claimed once the window passes', async () => {
  seedWorkout(S1);
  const s = db.sessions.get(S1);
  s.sheets_export_state = 'retry_backoff';
  s.sheets_export_next_attempt_at = new Date(Date.now() + 60_000);
  assert.equal((await exporter.runExportPass()).results.length, 0, 'still backing off');

  s.sheets_export_next_attempt_at = new Date(Date.now() - 1_000);
  const pass = await exporter.runExportPass();
  assert.equal(pass.results.length, 1, 'the window elapsed, so the session is due');
  assert.equal(pass.results[0].exported, true);
});

test('the attempt ceiling blocks rather than retrying forever', async () => {
  seedWorkout(S1);
  const s = db.sessions.get(S1);
  s.sheets_export_attempts = exporter.ATTEMPT_CEILING - 1; // the next failure reaches the ceiling
  sheetsFailure = 'write';
  const claim = await fakeAdapter.claimExportSession();
  const result = await exporter.exportClaimedSession(claim);

  assert.equal(result.state, 'blocked', 'at the ceiling a transient failure stops being retried');
  assert.equal(db.sessions.get(S1).sheets_export_next_attempt_at, null, 'a blocked session has no next attempt');
});

test('the declared backoff schedule is exactly 2, 4, 8, 16, 32, 60, 60 minutes', () => {
  const base = new Date('2026-08-13T00:00:00Z');
  const minutes = [1, 2, 3, 4, 5, 6, 7]
    .map((attempts) => (exporter.nextAttemptAt(attempts, base).getTime() - base.getTime()) / 60_000);
  assert.deepEqual(minutes, [2, 4, 8, 16, 32, 60, 60]);
});

// ── the acknowledgement guard ────────────────────────────────────────────────

test('a superseded worker cannot acknowledge: the claim token guard refuses it', async () => {
  seedWorkout(S1);
  const claim = await fakeAdapter.claimExportSession();
  // A replacement worker claims the same session, replacing the token.
  await fakeAdapter.claimExportSession();

  const result = await exporter.exportClaimedSession(claim);
  assert.equal(result.exported, false);
  assert.equal(result.reason, 'claim_superseded');
  assert.equal(db.sessions.get(S1).sheets_exported_at, null,
    'a stale observation may never mark a session exported');
});

// ── the athlete is never behind this ─────────────────────────────────────────

test('a total Sheets outage leaves the backlog growing and the workout untouched', async () => {
  seedWorkout(S1);
  seedWorkout(S2);
  sheetsFailure = 'read';

  const pass = await exporter.runExportPass();
  assert.equal(pass.results.length, 2);
  assert.ok(pass.results.every((r) => !r.exported), 'nothing exports during an outage');
  assert.ok(pass.results.every((r) => r.state === 'retry_backoff'), 'and nothing is blocked for it');

  // The authority still holds every row. THIS is the acceptance equation: a totally
  // quota-exhausted Google Sheets costs the mirror, never the workout.
  assert.equal(db.rows.Log_Cleaned.length, 4);
  assert.equal(db.rows.Effort.length, 2);
  const status = await exporter.exportStatus();
  assert.equal(status.sessions_owed, 2, 'the backlog is visible rather than silent');
  assert.equal(status.sessions_blocked, 0);
});

test('P14f: a post-export mutation returns the session to the queue and it re-exports', async () => {
  seedWorkout(S1);
  await exporter.runExportPass();
  assert.ok(db.sessions.get(S1).sheets_exported_at);

  // The runtime's `markSessionForReexport` shape: exported_at cleared, state queued.
  const s = db.sessions.get(S1);
  s.sheets_exported_at = null;
  s.sheets_export_state = 'queued';
  db.rows.Log_Cleaned.push(logRow(S1, 'Bench Press', 3));

  const pass = await exporter.runExportPass();
  assert.equal(pass.results[0].exported, true, 'a changed session is exported again');
});
