'use strict';

// Stub the Supabase workout authority so an in-process test never opens a
// database connection — and so the routes under test run their REAL code.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// The S4 cutover made `atlas.logged_sets`, `atlas.session_effort`, the two plan
// ledgers and `atlas.write_receipts` the authority for the workout hot path. The
// suite used to control all of that by stubbing `sheets.js`, because Google Sheets
// was the authority; stubbing `sheets.js` now controls the tabs Atlas still writes
// (Coaching_Notes, Constraints, Modality_Log, Bodyweight) and nothing else.
//
// So this helper does for the workout authority exactly what
// `stubExerciseCatalog.js` does for the catalog: require.cache injection performed
// BEFORE `../index` is loaded, with an in-memory store behind it.
//
// ── WHAT IT IS AND IS NOT ────────────────────────────────────────────────────
//
// IT IS A TEST DOUBLE FOR THE DATABASE, and only that. Every route, every guard,
// every proof field and every response shape is the real one — the substitution
// happens at the one seam `services/workoutAuthority.js` already defines, which is
// the same seam production uses. What a test asserts is what Atlas decided to
// write, which is what these suites were always really asserting.
//
// IT IS NOT A PROOF OF THE DATABASE'S BEHAVIOUR. Transaction atomicity, the
// receipt state machine's reclaim rule, the foreign keys and the least-privilege
// grants are proven against a real from-empty Postgres in `test-pg/`, which is the
// level-correct place for them. This double deliberately implements the SAME
// observable contract so a test cannot pass here and fail there, but a proof that
// needs a database belongs in a proof that has one.
//
// IT DOES NOT WRITE TO THE SHEETS STUB. That is the point of the cutover: a
// workout write issues no Google Sheets call, and a double that quietly appended to
// the sheets fixture would hide exactly the property `test/allSheets429.test.js`
// exists to hold.
//
// Usage, before requiring the app under test:
//
//     require('./helpers/stubWorkoutAuthority').installWorkoutAuthorityStub();
//     const { app } = require('../index');

const path = require('node:path');

const AUTHORITY_PATH = require.resolve(path.join(__dirname, '..', '..', 'services', 'workoutAuthority.js'));
const RECEIPTS_PATH = require.resolve(path.join(__dirname, '..', '..', 'services', 'writeReceipts.js'));
const COACHING_INPUTS_PATH = require.resolve(path.join(__dirname, '..', '..', 'services', 'coachingInputsAuthority.js'));

// Same reasoning as stubExerciseCatalog.js: index.js loads dotenv, so a developer
// machine with a populated `.env` would otherwise have the suite connect to the
// real Supabase project. Blanking the role variables makes any unstubbed path fail
// fast and loudly instead of silently reaching the network.
const ROLE_VARS = ['ATLAS_SUPABASE_APP_URL', 'ATLAS_SUPABASE_READONLY_URL',
  'ATLAS_SUPABASE_MIGRATE_URL', 'ATLAS_SUPABASE_REBUILD_URL'];

function neutralizeSupabaseEnv() {
  for (const name of ROLE_VARS) delete process.env[name];
  process.env.ATLAS_SUPABASE_SHADOW_WRITE = '0';
}

// A FIXTURE ROW MAY BE AN OBJECT, not a cell array. Several suites declare prior
// history as normalized row objects because their route parses either shape, so the
// double must carry both without assuming Array.prototype.slice exists.
function copyRow(row) {
  if (Array.isArray(row)) return row.slice();
  if (row && typeof row === 'object') return { ...row };
  return row;
}

const LOG_SESSION_COL = 1;
const LOG_EXERCISE_COL = 2;
const LOG_SET_NUMBER_COL = 6;
const EFFORT_SESSION_COL = 1;
// Session_Plans / Session_Plan_Sets both carry session_id second and the
// idempotency key first, and the set ledger's seal is its last column.
const PLAN_KEY_COL = 0;
const PLAN_SESSION_COL = 1;
const PLAN_SET_SEAL_COL = 14;

function norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// ── THE SHEETS FALLBACK, and why it is opt-in rather than automatic ──────────
//
// Most suites declare their workout fixture inside their fake `sheets.js`, as
// `getSheetRows('Log_Cleaned')` / `('Effort')` — that is where the data lived when
// Sheets was the authority. Reading those fixtures at call time means the cutover
// changes a line per file and no test's DATA changes, which is the same trick
// `stubExerciseCatalog.js` uses.
//
// It is OPT-IN because one class of test must never have it: the all-Sheets-429
// proofs assert that a workout issues ZERO synchronous Google Sheets calls, and a
// double that quietly read the sheets fixture would issue exactly the calls those
// proofs exist to forbid. Those suites seed rows here directly instead.
//
// WRITES NEVER FALL BACK, under any option. A Save writes to this store and
// nowhere else, because a Save writes to Supabase and nowhere else.
let sheetsFallback = false;

// A FIXTURE THAT REFUSES TO BE READ IS AN UNREADABLE AUTHORITY, and the error is
// rethrown rather than swallowed. In fallback mode this fixture IS the double's
// storage, so a suite that arms a read failure on it is arming a read failure on
// the authority — which is exactly the fail-closed branch those suites exist to
// drive. Swallowing it would turn every one of them into a silent empty read.
async function sheetsRows(tab) {
  let sheets;
  try {
    // Required lazily so the suite's own require.cache injection wins.
    sheets = require(path.join(__dirname, '..', '..', 'sheets.js'));
  } catch {
    return [];
  }
  if (typeof sheets.getSheetRows !== 'function') return [];
  const rows = await sheets.getSheetRows(tab);
  return Array.isArray(rows) ? rows.map((row) => (Array.isArray(row) ? row.slice() : row)) : [];
}

// ── TWO LAYERS, READ TOGETHER ────────────────────────────────────────────────
//
// PRIOR HISTORY is the suite's fixture, re-read on every access and never copied
// in. Suites REPLACE that fixture between assertions — "now the athlete's last
// session was a year ago" — so a double that copied it once, or merged it
// cumulatively, would answer from history the test had already retracted.
//
// WHAT THE DOUBLE ITSELF WROTE is the second layer: a Save's rows, a plan-ledger
// append, a seal. Those exist nowhere but here, because the point of the cutover is
// that a workout write issues no Google Sheets call.
//
// A read is the FIXTURE FIRST, then the written layer, with any fixture row the
// double has its own copy of dropped. Two properties fall out of that order, and
// both matter:
//
//   CHRONOLOGY holds. Prior history precedes this session's Saves, so a caller
//   asking for the most recent N rows gets the ones that just landed — the opposite
//   order would hide every new Save behind a `slice(-n)`.
//
//   THE WRITTEN COPY WINS. A seal writes a stamped copy of a ledger row into the
//   written layer; dropping the fixture's unstamped twin is what makes the stamp
//   visible, without the double ever writing back into a suite's fixture.
//
// Identity is the whole row for the workout concepts and the idempotency key for the
// two plan ledgers, which is exactly what the real primary keys are.
function keyOf(kind, row) {
  if (!Array.isArray(row)) return JSON.stringify(row);
  if (kind === 'planEvents' || kind === 'planSets') return String(row[PLAN_KEY_COL] || '');
  return JSON.stringify(row);
}

// THE WRITTEN LAYER IS NEVER DEDUPLICATED AGAINST ITSELF. Only the fixture is
// filtered, and only against what the double already holds. A suite that seeds two
// rows sharing an idempotency key is describing a MALFORMED ledger on purpose — the
// chain validator has to see it and refuse the seal — so collapsing that pair here
// would delete the defect the test exists to catch.
function dedupe(kind, written, fixture) {
  const owned = new Set(written.map((row) => keyOf(kind, row)));
  const kept = fixture.filter((row) => !owned.has(keyOf(kind, row)));
  return [...kept, ...written].map(copyRow);
}

async function layered(kind, tab) {
  const fixture = sheetsFallback ? await sheetsRows(tab) : [];
  return dedupe(kind, store[kind], fixture);
}

// The coaching inputs read through the same two layers, from the tab each concept
// used to live in. A suite that declared its constraints as a `Constraints` fixture
// keeps exactly the constraints it had.
async function allCoachingNotes() { return layered('coachingNotes', 'Coaching_Notes'); }
async function allConstraints() { return layered('constraints', 'Constraints'); }
async function allDeloadState() { return layered('deloadState', 'Deload_State'); }
async function allModality() { return layered('modality', 'Modality_Log'); }

// The in-memory authority. One object per install, so a suite's state cannot leak
// into the next file.
function createStore(seed = {}) {
  return {
    // Cell rows, in the owner-approved column order — the same shape the routes
    // build and the same shape `workoutAuthority` returns.
    loggedSets: (seed.loggedSets || []).map(copyRow),
    effort: (seed.effort || []).map(copyRow),
    planEvents: (seed.planEvents || []).map(copyRow),
    planSets: (seed.planSets || []).map(copyRow),
    // The write_id each logged set was written under, parallel to `loggedSets`.
    // Supabase stores it as a column; undo deletes by it.
    loggedSetWriteIds: (seed.loggedSets || []).map(() => null),
    // THE COACHING INPUTS, which moved to Supabase with OWNER CORRECTION 2026-08-13.
    // Coaching notes, typed constraints and the deload state are prescription inputs;
    // cardio is a workout. All four are read and written through this double for the
    // same reason the workout rows are — stubbing `sheets.js` no longer controls them.
    coachingNotes: (seed.coachingNotes || []).map(copyRow),
    constraints: (seed.constraints || []).map(copyRow),
    deloadState: (seed.deloadState || []).map(copyRow),
    modality: (seed.modality || []).map(copyRow),
    // What the routes actually asked the authority to do, for assertions.
    calls: {
      saves: [], undos: [], planEventAppends: [], planSetAppends: [], seals: [],
      coachingNotes: [], constraints: [], deloadState: [], modality: [],
    },
    // Set by a test to make the authority unreadable, so a fail-closed branch can
    // be driven exactly as an outage would drive it.
    failReads: null,
    failWrites: null,
    // Set by a test to make `sealPlanSets` report a count that disagrees with what
    // it stamped, so the seal's proof check can be driven.
    sealCountOverride: null,
    // The same instrument for the SAVE. The route claims success only when the rows
    // the transaction reports match the rows it asked for, and a proof whose failure
    // branch is never exercised is a comment. There is no other way to produce the
    // disagreement: a real transaction cannot commit a different number of rows than
    // it inserted, which is exactly why this is a test instrument and not a shape the
    // production adapter can emit.
    saveCountOverride: null,
  };
}

let store = createStore();

function assertReadable() {
  if (store.failReads) throw new Error(store.failReads);
}

function assertWritable() {
  if (store.failWrites) throw new Error(store.failWrites);
}

// ── The authority double ─────────────────────────────────────────────────────

async function allLoggedSets() { return layered('loggedSets', 'Log_Cleaned'); }
async function allEffort() { return layered('effort', 'Effort'); }
async function allPlanEvents() { return layered('planEvents', 'Session_Plans'); }
async function allPlanSets() { return layered('planSets', 'Session_Plan_Sets'); }

const authority = {
  async occupiedSessionIds(sessionDate) {
    assertReadable();
    const prefix = String(sessionDate || '').replace(/-/g, '');
    const ids = new Set();
    for (const row of await allLoggedSets()) ids.add(String(row[LOG_SESSION_COL] || '').trim());
    for (const row of await allEffort()) ids.add(String(row[EFFORT_SESSION_COL] || '').trim());
    for (const row of await allPlanEvents()) ids.add(String(row[PLAN_SESSION_COL] || '').trim());
    // Scoped to the date, exactly as the indexed query is: the allocator asks only
    // about the day it is allocating into.
    return [...ids].filter((id) => id && (!prefix || id.startsWith(prefix)));
  },

  async existingSetIdentities(sessionId) {
    assertReadable();
    const sid = norm(sessionId);
    const keys = new Set();
    for (const row of await allLoggedSets()) {
      if (norm(row[LOG_SESSION_COL]) !== sid) continue;
      keys.add(`${norm(row[LOG_EXERCISE_COL])}||${norm(row[LOG_SET_NUMBER_COL])}`);
    }
    return keys;
  },

  async sessionHasEffort(sessionId) {
    assertReadable();
    const sid = norm(sessionId);
    return (await allEffort()).some((row) => norm(row[EFFORT_SESSION_COL]) === sid);
  },

  async loggedSetRows({ sessionId = null, limit = null } = {}) {
    assertReadable();
    let rows = await allLoggedSets();
    if (sessionId) rows = rows.filter((row) => norm(row[LOG_SESSION_COL]) === norm(sessionId));
    if (Number.isFinite(limit)) rows = rows.slice(-limit);
    return rows;
  },

  async effortRows({ limit = null } = {}) {
    assertReadable();
    const rows = await allEffort();
    return Number.isFinite(limit) ? rows.slice(-limit) : rows;
  },

  async planEventRows({ sessionId = null } = {}) {
    assertReadable();
    const rows = await allPlanEvents();
    return sessionId ? rows.filter((row) => norm(row[PLAN_SESSION_COL]) === norm(sessionId)) : rows;
  },

  async planSetRows({ sessionId = null } = {}) {
    assertReadable();
    const rows = await allPlanSets();
    return sessionId ? rows.filter((row) => norm(row[PLAN_SESSION_COL]) === norm(sessionId)) : rows;
  },

  async appendPlanEvents(cellRows) {
    assertWritable();
    store.calls.planEventAppends.push(cellRows.map(copyRow));
    const existing = await allPlanEvents();
    let inserted = 0;
    let skipped = 0;
    for (const row of cellRows) {
      const key = String(row[PLAN_KEY_COL] || '');
      // `idempotency_key` is the primary key, so a repeat is refused by the
      // database rather than by a read-then-compare. Same verdict here.
      if (existing.some((prior) => String(prior[PLAN_KEY_COL] || '') === key)) { skipped += 1; continue; }
      store.planEvents.push(row.slice());
      existing.push(row.slice());
      inserted += 1;
    }
    return { inserted, skipped };
  },

  async appendPlanSetRows(cellRows) {
    assertWritable();
    store.calls.planSetAppends.push(cellRows.map(copyRow));
    const existing = await allPlanSets();
    let inserted = 0;
    let skipped = 0;
    for (const row of cellRows) {
      const key = String(row[PLAN_KEY_COL] || '');
      if (existing.some((prior) => String(prior[PLAN_KEY_COL] || '') === key)) { skipped += 1; continue; }
      store.planSets.push(row.slice());
      existing.push(row.slice());
      inserted += 1;
    }
    return { inserted, skipped };
  },

  async sealPlanSets(sessionId, closeoutWriteId) {
    assertWritable();
    store.calls.seals.push({ sessionId, closeoutWriteId });
    // Over BOTH layers, because a session's ledger rows may be prior history the
    // suite declared in its fixture. A stamped copy is written into the written
    // layer, where it shadows the unstamped fixture row on every later read — the
    // double never writes back into a suite's fixture.
    const rows = await allPlanSets();
    const ownByKey = new Map(store.planSets.map((row) => [String(row[PLAN_KEY_COL] || ''), row]));
    let sealed = 0;
    for (const row of rows) {
      if (norm(row[PLAN_SESSION_COL]) !== norm(sessionId)) continue;
      // `closeout_write_id IS NULL` is what makes "never re-seal" atomic in the
      // real statement; the same predicate decides here.
      if (String(row[PLAN_SET_SEAL_COL] || '').trim() !== '') continue;
      const key = String(row[PLAN_KEY_COL] || '');
      const own = ownByKey.get(key);
      if (own) {
        own[PLAN_SET_SEAL_COL] = closeoutWriteId;
      } else {
        const stamped = copyRow(row);
        stamped[PLAN_SET_SEAL_COL] = closeoutWriteId;
        store.planSets.push(stamped);
        ownByKey.set(key, stamped);
      }
      sealed += 1;
    }
    // A DELIBERATE UNDER-REPORT, for the one case that cannot be produced any other
    // way: the authority stamping a different number of rows from the number the
    // caller decided to stamp. The seal's proof is that those two agree, and a proof
    // whose failure branch is never exercised is a comment.
    return store.sealCountOverride == null ? sealed : store.sealCountOverride;
  },

  async saveWorkout({ sessionId, writeId, logCells = [], effortCells = null }) {
    assertWritable();
    store.calls.saves.push({
      sessionId, writeId,
      logCells: logCells.map(copyRow),
      effortCells: effortCells ? effortCells.slice() : null,
    });
    // ATOMIC BY CONSTRUCTION, exactly as the transaction is: everything below
    // happens after the last thing that can throw.
    //
    // The duplicate checks read BOTH layers: a set already in the suite's prior
    // history is a duplicate exactly as one this session already wrote is.
    const priorSets = await allLoggedSets();
    const priorEffort = await allEffort();
    let setsWritten = 0;
    let setsSkipped = 0;
    const staged = [];
    for (const cells of logCells) {
      const key = `${norm(cells[LOG_EXERCISE_COL])}||${norm(cells[LOG_SET_NUMBER_COL])}`;
      const duplicate = priorSets.some((row) =>
        norm(row[LOG_SESSION_COL]) === norm(sessionId)
        && `${norm(row[LOG_EXERCISE_COL])}||${norm(row[LOG_SET_NUMBER_COL])}` === key);
      if (duplicate) { setsSkipped += 1; continue; }
      staged.push(cells.slice());
    }
    let effortWritten = false;
    if (effortCells && !priorEffort.some((row) => norm(row[EFFORT_SESSION_COL]) === norm(sessionId))) {
      effortWritten = true;
    }

    for (const row of staged) {
      store.loggedSets.push(row);
      store.loggedSetWriteIds.push(writeId || null);
      setsWritten += 1;
    }
    if (effortWritten) store.effort.push(effortCells.slice());

    return {
      session_id: sessionId,
      write_id: writeId,
      // The override lets a test report a count that disagrees with what was
      // written, so the route's fail-closed proof check can be driven.
      log_rows_written: store.saveCountOverride == null ? setsWritten : store.saveCountOverride,
      log_rows_skipped_duplicate: setsSkipped,
      effort_written: effortWritten,
    };
  },

  async modalityRows() {
    assertReadable();
    return allModality();
  },

  async appendModality(cells, writeId = null) {
    assertWritable();
    store.calls.modality.push({ cells: copyRow(cells), writeId });
    store.modality.push(copyRow(cells));
    return { inserted: 1 };
  },

  async undoSave(sessionId, writeId) {
    assertWritable();
    store.calls.undos.push({ sessionId, writeId });
    let deleted = 0;
    for (let i = store.loggedSets.length - 1; i >= 0; i -= 1) {
      if (norm(store.loggedSets[i][LOG_SESSION_COL]) !== norm(sessionId)) continue;
      if (String(store.loggedSetWriteIds[i] || '') !== String(writeId || '')) continue;
      store.loggedSets.splice(i, 1);
      store.loggedSetWriteIds.splice(i, 1);
      deleted += 1;
    }
    return { rows_deleted: deleted };
  },
};

// ── The coaching-input double ────────────────────────────────────────────────
//
// Coaching notes, typed constraints and the deload state. Same two-layer read as
// the workout concepts, and the same FAIL-CLOSED contract as the real seam: an
// unreadable authority THROWS, because OWNER CORRECTION 2026-08-13 forbids
// presenting a failed read as "no constraints" or "not in a deload". A test drives
// that branch with `failWorkoutAuthorityReads`, exactly as it drives an unreadable
// workout read.
const coachingInputs = {
  async coachingNoteRows() {
    assertReadable();
    return (await allCoachingNotes()).map((row) => [cellOf(row, 0), cellOf(row, 1)]);
  },

  async appendCoachingNote({ date, note, writeId = null }) {
    assertWritable();
    store.calls.coachingNotes.push({ date, note, writeId });
    store.coachingNotes.push([String(date == null ? '' : date), String(note == null ? '' : note)]);
    return { inserted: 1 };
  },

  async constraintRows() {
    assertReadable();
    return (await allConstraints()).map((row) => [0, 1, 2, 3, 4].map((i) => cellOf(row, i)));
  },

  async appendConstraint({ date, kind, target, rule, note = '', writeId = null }) {
    assertWritable();
    store.calls.constraints.push({ date, kind, target, rule, note, writeId });
    store.constraints.push([date, kind, target, rule, note].map((v) => String(v == null ? '' : v)));
    return { inserted: 1 };
  },

  async deloadStateRows() {
    assertReadable();
    return (await allDeloadState()).map((row) => DELOAD_COLUMN_COUNT_RANGE.map((i) => cellOf(row, i)));
  },

  async appendDeloadState(cells) {
    assertWritable();
    store.calls.deloadState.push(copyRow(cells));
    store.deloadState.push(DELOAD_COLUMN_COUNT_RANGE.map((i) => String(cells[i] == null ? '' : cells[i])));
    return { inserted: 1 };
  },
};

// `Deload_State` is seven columns. Held as a range rather than a require of
// `config/columns.js` so the double has no opinion about the contract — it only
// needs to know how wide a row is.
const DELOAD_COLUMN_COUNT_RANGE = [0, 1, 2, 3, 4, 5, 6];

// A fixture row may be a cell array OR a normalized object, so a cell read has to
// tolerate both — the same reason `copyRow` does.
function cellOf(row, index) {
  if (Array.isArray(row)) return row[index] == null ? '' : String(row[index]);
  return '';
}

// ── The receipt double ───────────────────────────────────────────────────────
//
// The SAME contract `services/writeReceipts.js` publishes: claim, replay, lost
// response, no duplicate, token guard, retryable failure, and the server-minted
// session id a retry recovers. A receipt is bound to one route for its whole life,
// as the real claim statement enforces, so a collision is a refusal here too.

const receipts = new Map();
let receiptsUnavailable = null;

function normalizeWriteId(writeId) {
  if (writeId === undefined || writeId === null) return null;
  const normalized = String(writeId).trim();
  return normalized || null;
}

function toRecord(row) {
  if (!row) return null;
  return {
    write_id: row.write_id,
    route: row.route,
    status: row.status,
    session_id: row.session_id || null,
    attempt: row.attempt,
    response: row.response || null,
    completed_at: row.completed_at || null,
  };
}

const receiptStore = {
  async beginWrite(writeId, metadata = {}) {
    const id = normalizeWriteId(writeId);
    if (!id) return { enabled: false, write_id: null };
    const route = metadata && metadata.endpoint ? String(metadata.endpoint) : null;
    if (!route) throw new Error('[write-receipts stub] beginWrite requires metadata.endpoint');
    if (receiptsUnavailable) {
      return { enabled: true, unavailable: true, write_id: id, reason: receiptsUnavailable };
    }

    const existing = receipts.get(id);
    if (existing && existing.route !== route) {
      // A route collision withholds the stored record, so no caller can replay a
      // foreign route's body as if it were its own.
      return { enabled: true, duplicate: true, write_id: id, record: null, route_conflict: true, reason: 'route_conflict' };
    }
    if (existing && existing.status !== 'failed') {
      return { enabled: true, duplicate: true, write_id: id, record: toRecord(existing), route_conflict: false };
    }

    const token = `${id}:${receipts.size}:${Math.random().toString(36).slice(2)}`;
    const sessionId = metadata && metadata.session_id ? String(metadata.session_id).trim() : '';
    const record = {
      write_id: id,
      route,
      status: 'in_progress',
      // A retry preserves the session id a prior attempt minted; it is never
      // overwritten once present, exactly as `persistReceiptSessionId` refuses to.
      session_id: (existing && existing.session_id) || sessionId || null,
      attempt: existing ? (existing.attempt || 1) + 1 : 1,
      token,
      response: null,
      completed_at: null,
    };
    receipts.set(id, record);
    return { enabled: true, duplicate: false, write_id: id, token, attempt: record.attempt, session_id: record.session_id };
  },

  async persistSessionId(writeId, token, sessionId) {
    const record = receipts.get(normalizeWriteId(writeId));
    if (!record || record.token !== token || record.session_id) return false;
    record.session_id = String(sessionId).trim();
    return true;
  },

  async completeWrite(writeId, token, response = {}) {
    const record = receipts.get(normalizeWriteId(writeId));
    if (!record || record.token !== token) return false;
    record.status = 'completed';
    record.response = { ...response };
    record.completed_at = new Date().toISOString();
    return true;
  },

  async failWrite(writeId, token) {
    const record = receipts.get(normalizeWriteId(writeId));
    if (!record || record.token !== token) return false;
    record.status = 'failed';
    // Invalidated in the same step, so a late completion cannot resurrect a
    // released attempt.
    record.token = null;
    return true;
  },

  async peekWrite(writeId) {
    return toRecord(receipts.get(normalizeWriteId(writeId)) || null);
  },

  normalizeWriteId,
};

/**
 * Install both doubles. Call BEFORE requiring `../index`.
 *
 * @param {object}  [options]
 * @param {boolean} [options.sheetsFallback]  seed the store from the suite's fake
 *        `sheets.js` fixture on first access, so a suite that declared its workout
 *        data as `getSheetRows('Log_Cleaned')` keeps exactly the data it had. Never
 *        set it in a proof that counts Google Sheets calls.
 * @param {object}  [options.seed]  cell rows in the owner-approved column order:
 *        `{ loggedSets, effort, planEvents, planSets }`.
 */
function installWorkoutAuthorityStub(options = {}) {
  neutralizeSupabaseEnv();
  sheetsFallback = options.sheetsFallback === true;
  store = createStore(options.seed || {});
  receipts.clear();
  receiptsUnavailable = null;

  require.cache[AUTHORITY_PATH] = {
    id: AUTHORITY_PATH, filename: AUTHORITY_PATH, loaded: true, exports: authority,
  };
  require.cache[COACHING_INPUTS_PATH] = {
    id: COACHING_INPUTS_PATH, filename: COACHING_INPUTS_PATH, loaded: true,
    exports: {
      ...coachingInputs,
      // The column contracts are pure data the real module re-exports; the double
      // hands back the real ones rather than a copy that could drift.
      coachingNotesColumns: require('../../config/columns').coachingNotesColumns,
      constraintsColumns: require('../../config/columns').constraintsColumns,
      deloadStateColumns: require('../../config/columns').deloadStateColumns,
    },
  };
  require.cache[RECEIPTS_PATH] = {
    id: RECEIPTS_PATH, filename: RECEIPTS_PATH, loaded: true, exports: receiptStore,
  };
  return store;
}

/** Reset the rows and receipts between tests without re-installing the doubles. */
function resetWorkoutAuthorityStub(seed = {}) {
  store = createStore(seed);
  receipts.clear();
  receiptsUnavailable = null;
  return store;
}

/** The live store, for seeding and for assertions. */
function workoutAuthorityStore() {
  return store;
}

/** Make the authority unreadable / unwritable, so a fail-closed branch can run. */
function failWorkoutAuthorityReads(message) { store.failReads = message || null; }
function failWorkoutAuthorityWrites(message) { store.failWrites = message || null; }
/** Make the receipt authority unreadable, so the 503 refusal can be driven. */
function failWriteReceipts(reason) { receiptsUnavailable = reason || null; }

/**
 * Read a receipt without going through a route — the "was a receipt claimed at all"
 * question a test asks after a refusal. Synchronous on purpose: it reads the
 * double's own map, not a database.
 */
function peekWriteReceiptStub(writeId) {
  return toRecord(receipts.get(normalizeWriteId(writeId)) || null);
}

module.exports = {
  installWorkoutAuthorityStub,
  resetWorkoutAuthorityStub,
  workoutAuthorityStore,
  failWorkoutAuthorityReads,
  failWorkoutAuthorityWrites,
  failWriteReceipts,
  peekWriteReceiptStub,
  AUTHORITY_PATH,
  RECEIPTS_PATH,
};
