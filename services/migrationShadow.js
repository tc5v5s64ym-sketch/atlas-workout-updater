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
async function recordInlineDivergence({ concept, identityKey, sessionId, writeId, route, error }) {
  try {
    await adapter.openDivergence({
      concept,
      identityKey,
      sessionId: sessionId || null,
      writeId: writeId || null,
      route: route || null,
      reason: 'shadow_write_failed',
      detectedBy: 'inline_shadow',
      // A SHAPE, not a value: the failure class, never the workout.
      comparison: { error_class: classifyError(error) },
    });
  } catch (err) {
    warn('inline_divergence_failed', { concept, error: err.message });
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

// The single deferral point. `describe` names the work for the log and for the
// divergence row; `run` performs it. Nothing here can reject into the caller.
function dispatch(describe, run) {
  // Wrapped, so "total" is a property of the code rather than an argument about
  // it. Every caller is a route that has ALREADY committed rows to Google Sheets
  // and decided its response; a synchronous throw from here would be caught by
  // that route's own error handling and could turn a successful Save into a
  // reported failure. Nothing below is expected to throw — and that is exactly
  // the kind of expectation this catch exists to stop relying on.
  try {
    return dispatchUnguarded(describe, run);
  } catch (error) {
    counters.failed += 1;
    warn('shadow_dispatch_failed', { ...describe, error: error && error.message });
    return { shadow: 'dispatch_failed' };
  }
}

function dispatchUnguarded(describe, run) {
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
          warn('shadow_write_failed', { ...describe, error: error.message, error_class: classifyError(error) });
          await recordInlineDivergence({ ...describe, error });
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

function shadowSave({ sessionId, logCells = [], effortCells = null, route = null, writeId = null }) {
  if (!sessionId || (logCells.length === 0 && !effortCells)) return { shadow: 'nothing_to_mirror' };
  return dispatch(
    { concept: 'logged_sets', identityKey: String(sessionId), sessionId, writeId, route },
    () => adapter.shadowSave({ sessionId, logCells, effortCells })
  );
}

function shadowPlanEvents(cellRows, { route = null } = {}) {
  const rows = Array.isArray(cellRows) ? cellRows : [];
  if (rows.length === 0) return { shadow: 'nothing_to_mirror' };
  return dispatch(
    {
      concept: 'session_plan_events',
      identityKey: String(rows[0][0] || 'unknown'),
      sessionId: rows[0][1] || null,
      route,
    },
    () => adapter.shadowPlanEvents(rows)
  );
}

function shadowPlanSetRows(cellRows, { route = null } = {}) {
  const rows = Array.isArray(cellRows) ? cellRows : [];
  if (rows.length === 0) return { shadow: 'nothing_to_mirror' };
  return dispatch(
    {
      concept: 'session_plan_set_recommendations',
      identityKey: String(rows[0][0] || 'unknown'),
      sessionId: rows[0][1] || null,
      route,
    },
    () => adapter.shadowPlanSetRows(rows)
  );
}

function shadowPlanSetSeal(sessionId, closeoutWriteId, { route = null } = {}) {
  if (!sessionId || !closeoutWriteId) return { shadow: 'nothing_to_mirror' };
  return dispatch(
    {
      concept: 'session_plan_set_recommendations',
      identityKey: `seal:${sessionId}`,
      sessionId,
      writeId: closeoutWriteId,
      route,
    },
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
  _drain,
  _counters,
};
