'use strict';

// THE EXPORT WORKER'S CLOCK — the only thing that makes the mirror export run
// without a human.
//
// AUTHORITY: `docs/SUPABASE_HOT_PATH_MIGRATION.md` §5.4. The export is defined as
// ASYNCHRONOUS and after closeout, so it needs a driver that is not a request.
//
// ── WHY A TIMER AND NOT A REQUEST HOOK ───────────────────────────────────────
//
// The obvious cheap wiring — kick the exporter at the end of the closeout request —
// is exactly what the design forbids. It would put a whole-tab Google Sheets read
// and four `values.update` calls on the tail of an athlete request, which is the
// coupling OWNER CORRECTION 2026-08-13 exists to remove. Even fire-and-forget, it
// would tie the export rate to the athlete's request rate and make a quota storm
// coincide with the workout.
//
// So the driver is a plain interval, owned by the process, with no request in scope.
//
// ── IT IS OFF UNLESS THE OWNER TURNS IT ON ───────────────────────────────────
//
// `ATLAS_MIRROR_EXPORT_ENABLED=1` starts it; anything else leaves it inert. This is
// not timidity about an unfinished module — it is the standing rule that a process
// which writes a durable owner-visible Google Sheets surface starts only on an owner
// decision. The CLI (`npm run atlas:export-mirror`) is the owner-run consumer in the
// meantime and exercises exactly the same code path.
//
// A DISABLED SCHEDULER IS NOT A STALLED MIRROR IN SILENCE: `npm run atlas:status`
// reports the backlog and the oldest session owing an export either way.

const { runExportPass } = require('./sheetsMirrorExport');

// Long enough that a quiet gym day costs almost nothing, short enough that a
// finished workout reaches the sheet while the owner still cares. The backoff of a
// failing session is enforced by the queue predicate, not by this interval, so a
// short tick cannot defeat it.
const DEFAULT_INTERVAL_MS = 5 * 60_000;

let timer = null;
let running = false;

function isEnabled() {
  return String(process.env.ATLAS_MIRROR_EXPORT_ENABLED || '').trim() === '1';
}

/**
 * One tick. Never throws and never rejects: an unhandled rejection in a timer would
 * take down a process whose real job is serving the athlete, and a mirror failure
 * may not do that.
 *
 * Re-entrancy is refused rather than queued. A pass that overruns its interval means
 * Sheets is slow; starting a second pass beside it would double the read rate at the
 * exact moment that is most expensive.
 */
async function tick({ maxSessions } = {}) {
  if (running) return { skipped: 'already_running' };
  running = true;
  try {
    return await runExportPass(maxSessions ? { maxSessions } : {});
  } catch (error) {
    console.error('❌ Mirror export pass failed:', error && error.message);
    return { results: [], stopped: 'pass_threw', detail: error && error.message };
  } finally {
    running = false;
  }
}

/** Start the worker. A no-op when the owner has not enabled it, or when already started. */
function startMirrorExportScheduler({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (!isEnabled()) return { started: false, reason: 'disabled' };
  if (timer) return { started: false, reason: 'already_started' };
  timer = setInterval(() => { tick(); }, intervalMs);
  // Never hold the event loop open: the export is subordinate to the server's life,
  // not a reason to keep the process alive.
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[mirror-export] worker started, every ${Math.round(intervalMs / 1000)}s`);
  return { started: true, intervalMs };
}

function stopMirrorExportScheduler() {
  if (!timer) return { stopped: false };
  clearInterval(timer);
  timer = null;
  return { stopped: true };
}

module.exports = {
  startMirrorExportScheduler,
  stopMirrorExportScheduler,
  tick,
  isEnabled,
  DEFAULT_INTERVAL_MS,
};
