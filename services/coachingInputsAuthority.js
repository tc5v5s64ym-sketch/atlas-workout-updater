'use strict';

// THE COACHING-INPUT AUTHORITY — Supabase, for the three inputs the engine reasons
// over that are not themselves workout rows.
//
// AUTHORITY: OWNER CORRECTION 2026-08-13, recorded in
// `docs/ATLAS_V1_EXECUTION_PLAN.md`:
//
//   "Do not accept Coaching_Notes, Constraints, Deload_State, Exercise_Catalog, or
//    any other data needed for recommendations, coaching, substitutions,
//    prescriptions, preview, approval, save, closeout, receipt retry, or undo as a
//    synchronous Google Sheets dependency."
//
// ── WHY THE EARLIER READING WAS REJECTED ─────────────────────────────────────
//
// Every call site wrapped its Sheets read in `.catch(() => [])`, so a quota
// exhaustion produced a 200 with weaker grounding rather than a failure. That
// looked like graceful degradation, and it is not: a recommendation computed
// without the athlete's typed constraints is not a softer answer, it is a DIFFERENT
// answer — one that can prescribe into an injury the athlete already reported. The
// acceptance equation is that a totally quota-exhausted Google Sheets leaves the
// workout passing, and passing means the same coaching decision.
//
// So all three moved, and NO SHEETS FALLBACK SURVIVES. There is no second reader,
// no cache holding a stale copy, and no freshness clock — the questions those
// mechanisms answered ("how old is our copy of a tab") do not exist when there is
// no upstream tab.
//
// ── THE SHAPE IS THE SHEETS SHAPE, DELIBERATELY ──────────────────────────────
//
// Each read returns header-stripped cell arrays in the owner-approved column order
// of `config/columns.js`, which is exactly what `getSheetRows(tab)` returned. Dozens
// of consumers parse that shape — the coach grounding lane, the state assembler, the
// substitution previewer, the deload state machine — and none of them changes.

const {
  coachingNotesColumns, constraintsColumns, deloadStateColumns,
} = require('../config/columns');

function adapterModule() {
  // Required lazily so a test can inject its own through require.cache, matching
  // the pattern every other Supabase seam in this repository uses.
  return require('./supabaseAdapter');
}

function cell(value) {
  return value == null ? '' : String(value);
}

/**
 * Coaching notes as `Coaching_Notes` cell rows: `[date, note]`, oldest first.
 *
 * FAIL LOUD, NOT SILENT. This throws when the authority is unreadable, and no
 * caller may convert that throw into an empty result.
 *
 * THE OLD "STILL DEGRADES" NOTE HERE WAS WRONG, and it is removed rather than
 * softened. It said a coaching reply without notes is still a reply, so the
 * grounding lane could carry on — which is precisely the reading OWNER CORRECTION
 * 2026-08-13 rejected in the header above. A reply computed without the athlete's
 * notes is not a weaker reply, it is a different one, and it is indistinguishable
 * to the athlete from a well-grounded one. It also mis-cited the Constitution: the
 * rule that a read outage must not fail a WRITE says nothing about answering a read
 * from data the store declined to give.
 *
 * Callers therefore refuse the turn. There is one store, it is Supabase, and it is
 * the store the workout already cannot proceed without — so there is no surface on
 * which "unreadable" should read as "empty".
 */
async function coachingNoteRows({ adapter } = {}) {
  const rows = await (adapter || adapterModule()).coachingNotes();
  return rows.map((row) => [cell(row.note_date), cell(row.note)]);
}

/** Append one coaching note. `date` is the owner's LOCAL day, stamped by the route. */
async function appendCoachingNote({ date, note, writeId = null }, { adapter } = {}) {
  return (adapter || adapterModule()).appendCoachingNote({ date, note, writeId });
}

/** Typed constraints as `Constraints` cell rows: `[date, kind, target, rule, note]`. */
async function constraintRows({ adapter } = {}) {
  const rows = await (adapter || adapterModule()).constraints();
  return rows.map((row) => [
    cell(row.constraint_date), cell(row.kind), cell(row.target), cell(row.rule), cell(row.note),
  ]);
}

/** Append one typed constraint. */
async function appendConstraint(record, { adapter } = {}) {
  return (adapter || adapterModule()).appendConstraint(record);
}

/**
 * The deload state machine's rows, as `Deload_State` cell rows, oldest first.
 *
 * APPEND-ONLY SYSTEM STATE. The current state is the newest row; the history is
 * what makes the state machine auditable. `services/deloadState.js` already reads
 * it that way and is unchanged.
 */
async function deloadStateRows({ adapter } = {}) {
  const rows = await (adapter || adapterModule()).deloadStateRows();
  return rows.map((row) => deloadStateColumns.map((column) => cell(row[column])));
}

/** Append one deload-state record, as its cell row. */
async function appendDeloadState(cells, { adapter } = {}) {
  return (adapter || adapterModule()).appendDeloadStateRow(
    deloadStateColumns.map((_, i) => cell(cells[i]))
  );
}

module.exports = {
  coachingNoteRows,
  appendCoachingNote,
  constraintRows,
  appendConstraint,
  deloadStateRows,
  appendDeloadState,
  // Re-exported so a consumer can name the contract it parses without reaching past
  // this seam into config/columns.js for a tab that no longer exists.
  coachingNotesColumns,
  constraintsColumns,
  deloadStateColumns,
};
