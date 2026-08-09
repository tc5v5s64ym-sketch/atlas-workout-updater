'use strict';

// THE WRITE-ADMISSION CONTROL — one control, one meaning, one place.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §3.10 (the table), §5.3
// ("The write freeze — one bounded control authority"), §6.2 P8–P13.
//
// OWNER RULING D7 — APPROVED 2026-08-09. PERMANENT Atlas safety infrastructure,
// NOT a migration bridge, and carrying NO SUNSET. `S4` deletes the shadow write,
// the sweep, the repair worker, the divergence consumers and the receipt seam; it
// does NOT delete this. Its permanent consumer is `CLAUDE.md`'s standing rule
// "Any production data-integrity anomaly freezes writes immediately", which Atlas
// had no mechanism to execute before this file existed.
//
// The ruling is narrow, and these bounds are part of it:
//   • ONE single-row write-admission control, governing exactly one question —
//     may the seven beginWrite routes write?
//   • the runtime holds SELECT and nothing else; only the Supabase project owner
//     may mutate the row;
//   • NOT a feature-flag framework: no name column, no per-feature rows, no
//     second controlled behaviour, no second mechanism and no fallback;
//   • preview → approve → write is unchanged, and no workout-data authority moves.
//
// ── THE AUTHORIZATION RULE ───────────────────────────────────────────────────
//
// A write proceeds ONLY when THIS request successfully reads EXACTLY ONE VALID row
// saying `frozen = false`. Every one of these is FROZEN for that request:
//
//     a query error · a timeout · no result · a missing row ·
//     a malformed row · more than one row · an unreachable database
//
// There is no cache and no remembered permission, so an owner UPDATE takes effect
// on the NEXT REQUEST of every running instance, old and new, with no deploy and
// no restart (§6.2 P8). A previously observed `frozen = false` may NEVER authorize
// a later request after a failed read — that is the exact race the control exists
// to close, and an earlier "last value read successfully" rule failed OPEN in it.
//
// §5.3 permits retaining a prior `frozen = true` across a failed read. This module
// deliberately keeps no such state, because it would change nothing: a failed read
// already refuses. Less state, same posture.
//
// ── THERE IS NO LOCAL OVERRIDE ───────────────────────────────────────────────
//
// No environment variable, no file, no header and no request field can open writes
// while the row says frozen. One would be a second authority over the same
// question, which §2 forbids. The only two inputs are the row and the read's
// success.

const supabaseAdapter = require('./supabaseAdapter');

// The bound on a single indexed single-row SELECT on an already-open pooled
// connection (§5.3: "it fails only when Supabase is genuinely unreachable, not
// under ordinary load"). A CONSTANT, not a setting: a knob here would be one more
// thing that decides whether a write is admitted. Exceeding it is a timeout, and a
// timeout is frozen.
const FREEZE_READ_TIMEOUT_MS = 2500;

// ── ARMING, AND WHY IT IS NOT A BYPASS ───────────────────────────────────────
//
// The control is ARMED exactly when the runtime Supabase role is configured — the
// same dormancy rule every other Supabase component already follows, and the
// reason `S3` can merge and deploy before the owner applies the migration (§5.3,
// owner gate 2: "The PR may merge before this"). Unarmed, the seven routes behave
// exactly as the pre-S3 build does, which is what §6.2 P12 proves.
//
// Unarmed is NOT an override, and the latch below is what makes that true rather
// than merely stated. Once a process has observed the runtime role configured, the
// control stays armed for the life of that process. Clearing the connection string
// afterwards therefore does not disarm it — the read simply fails, and a failed
// read is frozen. Arming is monotonic and remembers only "this control is live",
// never "writes were open", so it can add refusals and can never remove one.
//
// Removing the connection string for real is a Render environment change, which is
// a redeploy and an owner action; it is not something a request can do.
let armedLatch = false;

function isArmed() {
  if (armedLatch) return true;
  if (supabaseAdapter.isConfigured('app')) {
    armedLatch = true;
    return true;
  }
  return false;
}

// A row is VALID only if it has the exact shape §3.10 declares. Anything else is
// a row this control does not recognise, and it must not act confident about one.
function rowIsValid(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.id !== true) return false;                    // the CHECK (id) single-row key
  if (typeof row.frozen !== 'boolean') return false;    // the control itself
  if (typeof row.reason !== 'string' || row.reason === '') return false;
  if (typeof row.set_by !== 'string' || row.set_by === '') return false;
  return true;
}

function refusal(code, detail = null) {
  return { open: false, armed: true, code, detail };
}

// Race the read against the bound. The losing query is left to the pool — this
// process has already decided to refuse, and waiting for it would defeat the
// bound. `timed_out` is a refusal exactly like a thrown error.
async function readWithBound(adapter) {
  let timer = null;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`write_freeze read exceeded ${FREEZE_READ_TIMEOUT_MS}ms`);
      err.code = 'WRITE_FREEZE_READ_TIMEOUT';
      reject(err);
    }, FREEZE_READ_TIMEOUT_MS);
    // Never hold the event loop open for the bound alone.
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([adapter.readWriteFreeze(), bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// THE ONE ENTRY POINT. `route` is recorded for the operator log only; it changes
// no decision, because there is one control with one meaning and it is not
// per-route.
//
// Returns { open, armed, code, detail }. `open: true` is reachable by exactly two
// paths: the control is not armed, or this request read exactly one valid row
// saying frozen = false.
async function admitWrite(route, { adapter = supabaseAdapter } = {}) {
  if (!isArmed()) {
    // Dormant. Byte-identical to the pre-S3 build (§6.2 P12).
    return { open: true, armed: false, code: 'not_armed', detail: null };
  }

  let rows;
  try {
    rows = await readWithBound(adapter);
  } catch (error) {
    // A query error, a timeout, an unconfigured role, or an unreachable database.
    // All four are the same answer.
    return refusal(
      error && error.code === 'WRITE_FREEZE_READ_TIMEOUT' ? 'read_timeout' : 'read_failed',
      error && error.message ? String(error.message).slice(0, 200) : null
    );
  }

  if (!Array.isArray(rows)) return refusal('read_malformed', 'the freeze read did not return rows');
  if (rows.length === 0) return refusal('row_missing', 'atlas.write_freeze holds no row');
  if (rows.length > 1) {
    // Unreachable while the primary key holds — which is precisely why reaching it
    // means the table is not what this control was built against.
    return refusal('row_not_unique', `atlas.write_freeze holds ${rows.length} rows`);
  }

  const row = rows[0];
  if (!rowIsValid(row)) return refusal('row_malformed', 'atlas.write_freeze row does not match §3.10');

  if (row.frozen === true) {
    warn(route, 'frozen', row.reason);
    return { open: false, armed: true, code: 'frozen', detail: row.reason, set_by: row.set_by };
  }

  return { open: true, armed: true, code: 'open', detail: null };
}

// One structured line per refusal, so a freeze — or a control failure — is visible
// to an operator rather than only to the athlete. Logging must never throw into a
// write path.
function warn(route, code, detail) {
  try {
    console.warn(JSON.stringify({
      level: 'warn', module: 'writeFreeze', event: 'write_refused', route, code, detail,
    }));
  } catch {
    /* a log failure must never decide a write */
  }
}

// The athlete-facing refusal body. HTTP 503 with a STATED reason — never a silent
// drop and never an unverified success. The trust loop is suspended, not weakened:
// nothing was written, and the response says so in the same proof fields every
// other no-write answer uses.
function refusalBody(admission) {
  return {
    error_code: 'writes_frozen',
    freeze_state: admission.code,
    freeze_reason: admission.code === 'frozen' ? admission.detail : null,
    sheet_written: false,
    no_write_confirmed: true,
  };
}

const REFUSAL_MESSAGE =
  'Atlas writes are paused right now, so nothing was saved. Your workout is safe — try again once writes are open.';

// ── THE MIGRATION WINDOW, for the S3 receipt seam only (§5.3) ────────────────
//
// The seam's second condition: "a successful current-request read of
// atlas.write_freeze returning frozen = true, by the same fail-closed rule that
// gates the seven write routes". It is the SAME read and the SAME control — one
// mechanism, asked a different question — which is why this is four lines rather
// than a second implementation.
//
// `frozen` is the ONLY admitting code. Every other outcome refuses:
//   open        — the owner has not opened a migration window;
//   not_armed   — Supabase is unconfigured, so the seam is inert;
//   read_failed / read_timeout / row_missing / row_malformed / row_not_unique —
//                 the freeze read failed, and an unproven freeze authorizes nothing.
//
// This is the owner authorization itself, not a convenience: atlas_app holds
// SELECT only on that row, so the only principal that can put the system into the
// state where these routes answer at all is the Supabase project owner. The owner
// authorizes the seam by freezing — with a credential the server never holds, over
// a path that needs no deploy.
async function requireFrozenWindow(route, options = {}) {
  const admission = await admitWrite(route, options);
  if (admission.code === 'frozen') {
    return { allowed: true, code: 'frozen', detail: admission.detail };
  }
  return { allowed: false, code: admission.code, detail: admission.detail };
}

// TEST-ONLY. The arming latch is process state, and a suite that exercises both
// the dormant and the armed posture in one process needs to return to a known
// start. It clears arming only; it can never open a frozen write, because arming
// is re-established from the environment on the very next call.
function __resetArmingForTests() {
  armedLatch = false;
}

module.exports = {
  admitWrite,
  requireFrozenWindow,
  refusalBody,
  REFUSAL_MESSAGE,
  FREEZE_READ_TIMEOUT_MS,
  rowIsValid,
  __resetArmingForTests,
};
