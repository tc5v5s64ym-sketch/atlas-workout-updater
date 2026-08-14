'use strict';

// THE WORKOUT AUTHORITY — Supabase, for the migrated hot-path concepts.
//
// AUTHORITY: OWNER INSTRUCTION 2026-08-07 (Supabase hot-path migration), PR S4 —
// the cutover; design `docs/SUPABASE_HOT_PATH_MIGRATION.md` §5.4, §5.5.
//
// ── WHY THIS MODULE EXISTS, RATHER THAN CALLS SPREAD THROUGH index.js ────────
//
// `index.js` is a high-risk file (`.claude/rules/high-risk-files.md`) and the Save
// path is its most dangerous surface. The cutover replaces four kinds of Google
// Sheets call there — session identity, duplicate detection, the append pair, and
// undo — and doing that inline would scatter transaction handling and row-shape
// conversion across a 4,000-line file.
//
// So the seam is one module with FOUR operations, each answering exactly the
// question the Sheets call it replaces answered, in the SAME shape the caller
// already consumes. `index.js` changes at the call site and nowhere else.
//
// ── WHAT MOVED, AND WHAT THAT BUYS ───────────────────────────────────────────
//
//   getEffortSessionIds() + getLogCompositeKeys()  ->  occupiedSessionIds()
//   getLogCompositeKeys()  (row dedup)             ->  existingSetIdentities()
//   appendRows(Log) + appendRows(Effort)           ->  saveWorkout()
//   deleteRowsByRange(Log)                         ->  undoSave()
//
// The append PAIR is the important one. Two Sheets appends could half-succeed —
// log rows on the sheet, Effort row missing, and a partial session for a later
// read to misinterpret. One Supabase transaction cannot: either the whole Save
// commits or none of it does (§6.3 P12). That is a property Sheets could never
// provide, not merely a faster version of the same thing.
//
// ── WHAT IS PRESERVED EXACTLY ────────────────────────────────────────────────
//
// `preview -> approve -> write` is untouched: a dry run still returns before any
// of this is reached, and `test_mode` absent still means a live write. The write
// receipt, the lost-response retry and the read-back proof keep their contracts —
// this module changes WHERE a row lands, never WHO may write it or what proof the
// caller must publish.

const contract = require('./migrationRowContract');

function adapterModule() {
  // Required lazily so a test can inject its own via require.cache, matching the
  // pattern every other seam in this repository uses.
  return require('./supabaseAdapter');
}

/**
 * Session ids already occupied on a date — the allocator's whole input.
 *
 * REPLACES a union of two whole-column Sheets reads (`Effort!B:B` plus
 * `Log_Cleaned!B:G`), which existed because a tab cannot be queried. A table can,
 * so this is one indexed lookup scoped to the date being allocated.
 *
 * FAIL CLOSED is preserved and is the whole point: the caller refuses to mint an
 * id when this throws, because an unreadable durable record cannot prove a slot is
 * free, and minting into an occupied slot merges two real workouts irreversibly.
 *
 * @param {string} sessionDate  `YYYY-MM-DD`
 * @returns {Promise<string[]>}
 */
async function occupiedSessionIds(sessionDate, { adapter } = {}) {
  return (adapter || adapterModule()).sessionIdsForDate(sessionDate);
}

/**
 * The identity keys a session already holds, as a Set of `exercise||set_number`,
 * lower-cased.
 *
 * REPLACES `getLogCompositeKeys()`, which returned `sid||exercise||set_number`
 * for the WHOLE tab because a tab cannot be filtered. This is scoped to one
 * session, so the caller compares within the session it is writing — the same
 * decision, from a smaller and more precise answer.
 */
async function existingSetIdentities(sessionId, { adapter } = {}) {
  return (adapter || adapterModule()).loggedSetIdentitiesForSession(sessionId);
}

/**
 * Does this session already carry an Effort row? The duplicate-session guard.
 *
 * REPLACES pulling every session id out of the `Effort` tab and scanning it. The
 * question was always about ONE session; a tab simply could not answer a
 * predicate, so the caller fetched the column and did the work itself.
 */
async function sessionHasEffort(sessionId, { adapter } = {}) {
  return (adapter || adapterModule()).effortExistsForSession(sessionId);
}

// ── THE AUTHORITATIVE READS ──────────────────────────────────────────────────
//
// These replace `getSheetRows('Log_Cleaned')` and `getSheetRows('Effort')` at
// every workout-critical call site: analytics, recommendation, history, session
// summary, read-back, the coach lanes and the read routes.
//
// THE SHAPE IS THE SHEETS SHAPE, DELIBERATELY. `getSheetRows` returned
// header-stripped arrays of cells in the owner-approved column order, and dozens
// of consumers parse exactly that. `migrationRowContract.sheetCellsFromRow` is the
// same mapping the export uses in the other direction, so the authority and its
// human-readable export can never disagree about what a column means — and no
// parse site changes.

/**
 * Logged sets, as `Log_Cleaned` cell rows (no header), newest-first when limited.
 *
 * @param {object} [opts]
 * @param {string} [opts.sessionId]  restrict to one session
 * @param {number} [opts.limit]      mirrors `getRecentRows(tab, maxRows)`
 */
async function loggedSetRows({ sessionId = null, limit = null, adapter } = {}) {
  const rows = await (adapter || adapterModule()).loggedSets({ sessionId, limit });
  return rows.map((row) => contract.sheetCellsFromRow('logged_sets', contract.rowFromSupabase('logged_sets', row)));
}

/** Effort, as `Effort` cell rows (no header). */
async function effortRows({ limit = null, adapter } = {}) {
  const rows = await (adapter || adapterModule()).sessionEffort({ limit });
  return rows.map((row) => contract.sheetCellsFromRow('session_effort', contract.rowFromSupabase('session_effort', row)));
}

/** Session plan events, as `Session_Plans` cell rows (no header). */
async function planEventRows({ sessionId = null, adapter } = {}) {
  const rows = await (adapter || adapterModule()).planEvents({ sessionId });
  return rows.map((row) => contract.sheetCellsFromRow('session_plan_events', contract.rowFromSupabase('session_plan_events', row)));
}

/** Session plan set recommendations, as `Session_Plan_Sets` cell rows (no header). */
async function planSetRows({ sessionId = null, adapter } = {}) {
  const rows = await (adapter || adapterModule()).planSetRows({ sessionId });
  return rows.map((row) => contract.sheetCellsFromRow('session_plan_set_recommendations', contract.rowFromSupabase('session_plan_set_recommendations', row)));
}

// ── THE PLAN LEDGER WRITERS ──────────────────────────────────────────────────
//
// Accepted plans, item outcomes, closeout, and plan set recommendations and their
// revisions are four of the seven migrated concepts. They took the SAME cell-array
// shape the `Session_Plans` / `Session_Plan_Sets` appends took, so callers keep
// building rows exactly as they did and only the destination changes.
//
// IDEMPOTENCY MOVES FROM A RACE TO A CONSTRAINT. Both tabs deduped by reading the
// whole tab, indexing `idempotency_key`, and comparing before appending — correct,
// but a read-then-write with a window between the two. `idempotency_key` is the
// primary key in Supabase, so the database refuses the duplicate outright and the
// count comes back as a skip.

/** Append plan events. Returns `{ inserted, skipped }` as COUNTS. */
async function appendPlanEvents(cellRows, { adapter } = {}) {
  const rows = cellRows.map((cells) => contract.rowFromSheet('session_plan_events', cells));
  const result = await (adapter || adapterModule()).appendPlanEvents(rows);
  return { inserted: result.inserted.length, skipped: result.skipped };
}

/** Append plan set recommendation rows. Returns `{ inserted, skipped }` as COUNTS. */
async function appendPlanSetRows(cellRows, { adapter } = {}) {
  const rows = cellRows.map((cells) => contract.rowFromSheet('session_plan_set_recommendations', cells));
  const result = await (adapter || adapterModule()).appendPlanSetRows(rows);
  return { inserted: result.inserted.length, skipped: result.skipped };
}

/**
 * Seal a session's plan set rows with the approved closeout write id.
 *
 * The ONE mutable column in the migrated workout schema, and the only place the
 * runtime updates a ledger row. It used to be a positional `batchUpdate` that
 * re-derived sheet rows from a fresh read; here it is a predicate.
 */
async function sealPlanSets(sessionId, closeoutWriteId, { adapter } = {}) {
  const result = await (adapter || adapterModule()).sealPlanSetsForSession(sessionId, closeoutWriteId);
  // A COUNT, because that is what the seal's proof compares. The caller decided how
  // many rows it intended to stamp and refuses to claim a verified closeout unless
  // exactly that many were stamped.
  return result.rows_sealed;
}

/**
 * THE AUTHORITATIVE SAVE — one transaction.
 *
 * Takes the SAME cell arrays the Sheets append took, so the caller's row-building
 * code is unchanged and the owner-approved column order stays the one contract
 * both sides read. `migrationRowContract` is the single mapping, used in both
 * directions, so the authority and its human-readable export can never disagree
 * about what a column means.
 *
 * Returns a shape carrying what the caller published as write proof: how many
 * rows landed, and whether the Effort row landed. `appended_range` is deliberately
 * ABSENT — a range is a Sheets concept, and reporting a fabricated one would be a
 * false proof field. Callers publish the row counts and the session identity,
 * which are what the trust loop actually asserts.
 *
 * @param {object}   args
 * @param {string}   args.sessionId
 * @param {string}   args.writeId       stamped on every child row; makes undo exact
 * @param {Array[]}  [args.logCells]    12-cell `Log_Cleaned` rows
 * @param {Array}    [args.effortCells] one 9-cell `Effort` row, or null
 */
async function saveWorkout({ sessionId, writeId, logCells = [], effortCells = null }, { adapter } = {}) {
  const loggedSets = logCells.map((cells) => contract.rowFromSheet('logged_sets', cells));
  const effort = effortCells ? contract.rowFromSheet('session_effort', effortCells) : null;

  const result = await (adapter || adapterModule()).saveWorkout({
    sessionId, writeId, loggedSets, effort,
  });

  return {
    session_id: result.session_id,
    write_id: result.write_id,
    log_rows_written: result.sets_written,
    log_rows_skipped_duplicate: result.sets_skipped_duplicate,
    effort_written: result.effort_written,
  };
}

// ── CARDIO AND CONDITIONING ──────────────────────────────────────────────────
//
// `/api/log-modality` is an athlete-facing preview → approve → write path: it
// carries a write receipt, it passes the write freeze, and it logs a workout the
// athlete actually did. Its tab was classified as telemetry, which was an audit
// error — a Google Sheets quota exhaustion would have failed that request outright.
// OWNER CORRECTION 2026-08-13 moved it here with the rest of the workout.

/** Modality entries as `Modality_Log` cell rows (no header), oldest first. */
async function modalityRows({ adapter } = {}) {
  const rows = await (adapter || adapterModule()).modalityLogRows();
  return rows.map((row) => [
    row.entry_date, row.session_id, row.modality, row.exercise, row.duration_sec,
    row.distance_m, row.rounds, row.rest_sec, row.level, row.rpe, row.avg_hr, row.notes,
  ].map((value) => (value == null ? '' : String(value))));
}

/**
 * Append one modality entry, stamped with the receipt it was admitted under.
 *
 * Takes the SAME 12-cell row `services/modalityLogRow.js` already builds, so the
 * recognizer, the unit normalisation and the column contract are untouched — only
 * the destination changed.
 */
async function appendModality(cells, writeId = null, { adapter } = {}) {
  return (adapter || adapterModule()).appendModalityLogRow(
    cells.map((value) => (value == null ? '' : String(value))), writeId
  );
}

/**
 * Undo — deletes exactly the logged sets of ONE Save, by `(session_id, write_id)`.
 *
 * REPLACES `deleteRowsByRange`, which identified rows by POSITION. Position is not
 * identity: a row-shifting delete on a mirrored tab is incompatible with durable
 * export allocations (§5.6), and a range computed from a stale read could remove
 * a different Save's rows. `write_id` is stamped at insert, so this cannot.
 *
 * It also returns the session to the export queue in the same transaction, so a
 * mirror holding the undone rows cannot stay stale (§6.3 P14e).
 */
async function undoSave(sessionId, writeId, { adapter } = {}) {
  return (adapter || adapterModule()).undoSave(sessionId, writeId);
}

module.exports = {
  occupiedSessionIds,
  existingSetIdentities,
  sessionHasEffort,
  loggedSetRows,
  effortRows,
  planEventRows,
  planSetRows,
  appendPlanEvents,
  appendPlanSetRows,
  sealPlanSets,
  saveWorkout,
  undoSave,
  modalityRows,
  appendModality,
};
