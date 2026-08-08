'use strict';

// The S2 shadow-write lane. TEMPORARY — S4 deletes this module and proves it absent.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.2, §7.1.
//
// ── THE ONE RULE THIS MODULE EXISTS TO KEEP ───────────────────────────────────
// GOOGLE SHEETS REMAINS THE LIVE AUTHORITY FOR EVERY READ AND EVERY WRITE.
// The shadow write runs AFTER the athlete-facing response has been decided. It
// never changes a response, a status code, a proof field, or a visible claim, and
// a shadow failure is never surfaced to the athlete.
//
// Two mechanisms enforce that, not one:
//   1. Every entry point is FIRE-AND-FORGET. It returns a synchronous descriptor,
//      never a promise the caller can await into the response path, and the work
//      itself is deferred to a later tick with setImmediate.
//   2. Every entry point is TOTAL. Nothing it does can throw into its caller —
//      not a configuration error, not an unparseable session id, not a dead
//      database. The worst case is a logged failure and a divergence row.
//
// ── AND THE ONE THING IT IS NOT ───────────────────────────────────────────────
// THIS LANE IS NOT THE COMPLETENESS AUTHORITY (§5.2). If the process dies after
// the Sheets write succeeds and before either the shadow write or its divergence
// row lands, Supabase lacks the rows AND the open-divergence count still reads
// zero. Nothing here can close that gap, because the gap is precisely "the dying
// process did not get to write anything". The reconciliation sweep
// (services/migrationSweep.js) is the completeness authority: it depends on no
// in-flight state and no record a crashed process was meant to write. The inline
// divergence below is an OPTIMISATION that reports a known failure sooner.

const adapter = require('./supabaseAdapter');
const contract = require('./migrationRowContract');

// In-flight shadow work, so a test can await the lane instead of racing it. It is
// not a queue and nothing waits on it in production.
const inFlight = new Set();

const counters = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };

function log(event, fields) {
  try {
    console.log(JSON.stringify({ level: 'info', module: 'migrationShadow', event, ...fields }));
  } catch {
    /* logging must never throw into the write path */
  }
}

function warn(event, fields) {
  try {
    console.warn(JSON.stringify({ level: 'warn', module: 'migrationShadow', event, ...fields }));
  } catch {
    /* logging must never throw into the write path */
  }
}

// The inline divergence: best-effort by definition. It runs only when the shadow
// write already failed, so its own failure cannot make anything worse — and it is
// never relied on, because the sweep re-derives the same fact from Sheets.
//
// EVERY AFFECTED ROW GETS ITS OWN RECORD, under its REAL concept and its REAL
// export identity key. An earlier version keyed the whole failure on the session
// id under a hardcoded `logged_sets` concept, which was wrong three ways and the
// third was a false green:
//
//   1. an Effort-only failure was filed under the wrong concept;
//   2. a failed BATCH recorded only its first row, silently dropping the rest;
//   3. worst — a session id is not a logged_sets identity key, so the repair
//      worker's re-comparison looked for a row that cannot exist, found nothing
//      on either side, read that as "absent in both stores", and CLOSED the
//      divergence while the Sheets rows were still missing from Supabase.
//
// Keying on the real identity makes the re-comparison mean what it says, and it
// costs nothing: the identity comes from the same row contract the sweep uses,
// over the same cell arrays that were handed to the append.
async function recordInlineDivergences(rows, { writeId, route, error }) {
  for (const row of rows) {
    try {
      await adapter.openDivergence({
        concept: row.concept,
        identityKey: row.identityKey,
        sessionId: row.sessionId || null,
        writeId: writeId || null,
        route: route || null,
        reason: 'shadow_write_failed',
        detectedBy: 'inline_shadow',
        // A SHAPE, not a value: the failure class, never the workout.
        comparison: { error_class: classifyError(error) },
      });
    } catch (err) {
      warn('inline_divergence_failed', { concept: row.concept, error: err.message });
    }
  }
}

function classifyError(error) {
  const message = String((error && error.message) || error || '');
  if (/SUPABASE_NOT_CONFIGURED/.test(String(error && error.code))) return 'not_configured';
  if (/SESSION_ID_UNPARSEABLE/.test(String(error && error.code))) return 'session_id_unparseable';
  if (/violates foreign key/i.test(message)) return 'foreign_key_violation';
  if (/violates unique/i.test(message)) return 'unique_violation';
  if (/violates check/i.test(message)) return 'check_violation';
  if (/timeout|ECONNREFUSED|ENOTFOUND|terminating connection/i.test(message)) return 'unavailable';
  return 'unknown';
}

// Map the cell arrays being mirrored to the rows a failure must record. A row
// whose identity cannot be derived is SKIPPED rather than filed under a
// fabricated key — the sweep finds it from Sheets regardless, which is exactly
// why the inline record is an optimisation and not the authority.
function identitiesFor(concept, cellRows) {
  const out = [];
  for (const cells of cellRows || []) {
    if (!cells) continue;
    const row = contract.rowFromSheet(concept, cells);
    const identityKey = contract.identityKey(concept, row);
    // An all-blank composite key ("||" with nothing either side) identifies no row.
    if (!identityKey || identityKey.replace(/\|/g, '').trim() === '') continue;
    out.push({ concept, identityKey, sessionId: contract.sessionIdOf(concept, row) });
  }
  return out;
}

// The single deferral point. `rows` names every row a failure must record;
// `run` performs the work. Nothing here can reject into the caller.
function dispatch(describe, rows, run) {
  // Wrapped, so "total" is a property of the code rather than an argument about
  // it. Every caller is a route that has ALREADY committed rows to Google Sheets
  // and decided its response; a synchronous throw from here would be caught by
  // that route's own error handling and could turn a successful Save into a
  // reported failure. Nothing below is expected to throw — and that is exactly
  // the kind of expectation this catch exists to stop relying on.
  try {
    return dispatchUnguarded(describe, rows, run);
  } catch (error) {
    counters.failed += 1;
    warn('shadow_dispatch_failed', { ...describe, error: error && error.message });
    return { shadow: 'dispatch_failed' };
  }
}

function dispatchUnguarded(describe, rows, run) {
  if (!adapter.isShadowWriteEnabled()) {
    counters.skipped += 1;
    return { shadow: 'disabled' };
  }
  counters.attempted += 1;
  const task = new Promise((resolve) => {
    setImmediate(() => {
      run()
        .then((result) => {
          counters.succeeded += 1;
          log('shadow_write_ok', { ...describe, result });
        })
        .catch(async (error) => {
          counters.failed += 1;
          warn('shadow_write_failed', {
            ...describe,
            affected_rows: rows.length,
            error: error.message,
            error_class: classifyError(error),
          });
          await recordInlineDivergences(rows, { ...describe, error });
        })
        .then(resolve, resolve);
    });
  });
  inFlight.add(task);
  task.then(() => inFlight.delete(task), () => inFlight.delete(task));
  return { shadow: 'scheduled' };
}

// ── Entry points ──────────────────────────────────────────────────────────────
//
// Each takes the EXACT cell arrays that were appended to Sheets, so the mirror is
// a projection of what was actually written rather than a second derivation of
// the same intent from the same inputs. A second derivation could agree with the
// engine and still disagree with the sheet.
//
// Each also derives, from those same arrays, the COMPLETE set of rows a failure
// must record — every row, under its own concept and its own export identity.

function shadowSave({ sessionId, logCells = [], effortCells = null, route = null, writeId = null }) {
  if (!sessionId || (logCells.length === 0 && !effortCells)) return { shadow: 'nothing_to_mirror' };
  // A Save spans TWO concepts. Filing an Effort failure under logged_sets would
  // send the repair worker looking in the wrong table.
  const rows = [
    ...identitiesFor('logged_sets', logCells),
    ...identitiesFor('session_effort', effortCells ? [effortCells] : []),
  ];
  return dispatch(
    { concept: 'workout_save', sessionId, writeId, route },
    rows,
    () => adapter.shadowSave({ sessionId, logCells, effortCells })
  );
}

function shadowPlanEvents(cellRows, { route = null } = {}) {
  const rows = Array.isArray(cellRows) ? cellRows : [];
  if (rows.length === 0) return { shadow: 'nothing_to_mirror' };
  return dispatch(
    { concept: 'session_plan_events', sessionId: rows[0][1] || null, route },
    identitiesFor('session_plan_events', rows),
    () => adapter.shadowPlanEvents(rows)
  );
}

function shadowPlanSetRows(cellRows, { route = null } = {}) {
  const rows = Array.isArray(cellRows) ? cellRows : [];
  if (rows.length === 0) return { shadow: 'nothing_to_mirror' };
  return dispatch(
    { concept: 'session_plan_set_recommendations', sessionId: rows[0][1] || null, route },
    identitiesFor('session_plan_set_recommendations', rows),
    () => adapter.shadowPlanSetRows(rows)
  );
}

function shadowPlanSetSeal(sessionId, closeoutWriteId, { route = null } = {}) {
  if (!sessionId || !closeoutWriteId) return { shadow: 'nothing_to_mirror' };
  // The seal is the ONE case with no row identity to record: it stamps a column
  // across every ledger row of a session, and the lane does not hold their keys.
  // Rather than invent one — the defect this rewrite removes — a seal failure
  // records NOTHING inline and is left entirely to the sweep, which compares
  // closeout_write_id per row and will open a content_mismatch for each row that
  // genuinely diverged. An honest silence beats a divergence keyed on a fiction.
  return dispatch(
    { concept: 'session_plan_set_recommendations', sessionId, writeId: closeoutWriteId, route },
    [],
    () => adapter.shadowSealPlanSets(sessionId, closeoutWriteId)
  );
}

// Test seam only: await every scheduled shadow task. Production never calls it —
// waiting on the shadow lane is exactly what this module refuses to let a
// response do.
async function _drain() {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
}

function _counters() {
  return { ...counters };
}

module.exports = {
  shadowSave,
  shadowPlanEvents,
  shadowPlanSetRows,
  shadowPlanSetSeal,
  classifyError,
  identitiesFor,
  _drain,
  _counters,
};
