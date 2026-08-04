'use strict';

// ── Drift SHADOW — Soul Plan PR-B5a Part 2a (DARK, default OFF) ────────────────
//
// Makes persisted Session_Plans history available to the pure drift detector in a
// dark, OBSERVABLE production path. Nothing here reaches the athlete: the result is
// never passed to the LLM, never changes selectCoachMode, never triggers challenge,
// never alters coach copy or session execution, and never blocks the chat reply.
//
// Gated behind ATLAS_DRIFT_SHADOW (default OFF):
//   OFF ⇒ inert — observeDrift returns immediately, ZERO Session_Plans reads.
//   ON  ⇒ read finalized-only history + deload state, run detectDrift, emit ONE
//         structured [drift-shadow] diagnostic line (the same safe observation
//         mechanism services/intentShadow already uses — no new Sheet/endpoint).
//
// READ BUDGET: the finalized history + deload state are TTL-CACHED (services/cache),
// so across a burst of chat turns the cost is bounded to ≤1 refresh per window —
// NEVER an uncached per-message read. logRows + memory_patterns are REUSED from the
// reads the chat path already performs (no extra read for those).
//
// SEMANTICS (drift input = authoritative CLOSED history only): finalized only;
// abandoned/open/error excluded (the reader's finalizedOnly projection); completion
// derives from explicit item outcomes; a substituted item counts its performed lift;
// unknown movement patterns never manufacture a streak (the detector); thin history
// never fires (the detector's floor); an active deload OR a real layoff suppresses.
//
// FAIL CLOSED: missing tab, header mismatch, malformed rows, or read failure ⇒ no
// history, evaluated:false — never a fabricated drift signal. Touches NO write path
// and never reads Log_Cleaned/Effort here.

const { createTtlCache } = require('./cache');
const { sessionPlansColumns } = require('./../config/columns');
const { readFinalizedPlannedVsCompleted } = require('./sessionPlanReader');
const { detectDrift } = require('./driftSignal');
const store = require('./sessionPlanStore');
const sheetsLib = require('./../sheets');
const { readCurrentDeloadState } = require('./deloadState');

const SESSION_PLANS_TAB = store.SESSION_PLANS_TAB;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — collapses a chat burst to ≤1 refresh
const CACHE_KEY = 'drift_inputs';

// A1 last column for the frozen 13-column contract (A..M) — the exact-header read.
function _lastCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }
const FULL_RANGE = `${SESSION_PLANS_TAB}!A:${_lastCol(sessionPlansColumns.length)}`;

function _consoleEmit(diag) { try { console.log(`[drift-shadow] ${JSON.stringify(diag)}`); } catch { /* log-only */ } }

let _cache = createTtlCache(CACHE_TTL_MS);
let _deps = {
  readRange: (r) => sheetsLib.readRange(r),
  readDeload: () => readCurrentDeloadState(),
  emit: _consoleEmit,
};

function isEnabled() {
  const v = process.env.ATLAS_DRIFT_SHADOW;
  return v === '1' || v === 'true' || v === 'on';
}

// Exact position-by-position match to the frozen 13-column header.
function _headerOk(header) {
  return Array.isArray(header) && header.length === sessionPlansColumns.length
    && sessionPlansColumns.every((c, i) => String(header[i] == null ? '' : header[i]).trim() === c);
}

// Cached, fail-closed load of the drift inputs. Returns
// { ok, reason, history, sessions_considered, deloadState }. ONE Session_Plans read
// (header + data in a single range) + one best-effort deload read, per TTL window.
async function _loadInputs() {
  const cached = _cache.get(CACHE_KEY);
  if (cached) return cached;
  let result;
  try {
    const raw = await _deps.readRange(FULL_RANGE); // header + data — ONE read
    const rows = Array.isArray(raw) ? raw : [];
    const header = rows[0] || [];
    if (!header.length) {
      result = { ok: false, reason: 'tab_missing', history: [], sessions_considered: 0, deloadState: null };
    } else if (!_headerOk(header)) {
      result = { ok: false, reason: 'header_mismatch', history: [], sessions_considered: 0, deloadState: null };
    } else {
      const history = readFinalizedPlannedVsCompleted(rows.slice(1)); // finalized-only, fail-closed fold
      let deloadState = null;
      try { deloadState = await _deps.readDeload(); } catch { deloadState = null; }
      result = { ok: true, reason: null, history, sessions_considered: history.length, deloadState };
    }
  } catch (e) {
    // The ONE read-failure authority decides this, not a local message regex. The
    // regex this replaced also matched "not found" and "does not exist", so a missing
    // SPREADSHEET or a revoked service account was reported as `tab_missing` — a
    // deployment misconfiguration presented as an absent optional tab. Both outcomes
    // are still fail-closed (`ok:false` ⇒ evaluated:false, no fabricated signal); the
    // difference is whether the diagnostic tells the owner the truth.
    const reason = sheetsLib.isTabMissingError(e) ? 'tab_missing' : 'read_error';
    result = { ok: false, reason, history: [], sessions_considered: 0, deloadState: null };
  }
  _cache.set(CACHE_KEY, result);
  return result;
}

// PURE: fold the read result + drift result into the owner-specified diagnostic
// shape. A suppressed detector result (deload/layoff) surfaces as suppressed_reason
// with drifting:false and no evidence; a failed/disabled read is evaluated:false.
function buildDiagnostic({ readResult, driftResult }) {
  const rr = readResult || {};
  const dr = driftResult || null;
  if (!rr.ok || !dr) {
    return {
      evaluated: false,
      drifting: false,
      kind: null,
      evidence: null,
      sessions_considered: rr.sessions_considered || 0,
      suppressed_reason: rr.ok ? null : (rr.reason || 'unavailable'),
    };
  }
  const suppressed = dr.evidence && typeof dr.evidence === 'object' && dr.evidence.suppressed
    ? String(dr.evidence.suppressed) : null;
  return {
    evaluated: true,
    drifting: dr.drifting === true,
    kind: dr.kind || null,
    evidence: suppressed ? null : (dr.evidence || null),
    sessions_considered: rr.sessions_considered || 0,
    suppressed_reason: suppressed,
  };
}

// Fire-and-forget DARK observation. Gated + TOTAL: OFF ⇒ no read, no work, no emit.
// Never throws, never blocks the caller, never influences the reply/mode/copy. The
// returned promise is for TESTS to await; production callers do not await it.
function observeDrift({ logRows, memoryPatterns, asOf } = {}) {
  if (!isEnabled()) return Promise.resolve();
  return Promise.resolve()
    .then(async () => {
      const readResult = await _loadInputs();
      let driftResult = null;
      if (readResult.ok) {
        driftResult = detectDrift(
          Array.isArray(logRows) ? logRows : [],
          readResult.history,
          Array.isArray(memoryPatterns) ? memoryPatterns : [],
          { asOf: typeof asOf === 'string' ? asOf : null, deloadState: readResult.deloadState }
        );
      }
      _deps.emit(buildDiagnostic({ readResult, driftResult }));
    })
    .catch(() => { /* dark shadow — a failure must never surface */ });
}

function _resetForTesting(deps = {}) {
  _cache = createTtlCache(CACHE_TTL_MS);
  _deps = {
    readRange: typeof deps.readRange === 'function' ? deps.readRange : (r) => sheetsLib.readRange(r),
    readDeload: typeof deps.readDeload === 'function' ? deps.readDeload : (() => readCurrentDeloadState()),
    emit: typeof deps.emit === 'function' ? deps.emit : _consoleEmit,
  };
}

module.exports = { isEnabled, buildDiagnostic, observeDrift, _resetForTesting, CACHE_TTL_MS, FULL_RANGE, SESSION_PLANS_TAB };
