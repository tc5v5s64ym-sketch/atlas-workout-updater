'use strict';

// CloseoutTransaction — canonical contract (Phase 2 Work item 2; charter row in
// docs/CANONICAL_CONTRACTS.md).
//
// Pure / deterministic. No I/O at call time beyond the static contract JSON.
// No LLM, no Sheets, no write path, no route.
//
// The atomic session-closeout write as ONE proven transaction — its three legs:
//   • log_rows   → the logged SETS the write appends to Log_Cleaned
//   • effort_row → the single Effort row (or null)
//   • seal       → the plan CLOSEOUT (Session_Plans seal counts)
// carried together with the trust-loop PROOF envelope. It DESCRIBES the existing
// write at POST /api/complete-workout and POST /api/log-workout (index.js); it
// adds no write capability, stays entirely inside preview→approve→write, and
// changes no proof field. It is ratified read-only here and is NOT yet wired
// (hence its staged entry in config/wiring-allowlist.json); Phase 5g (H-17)
// consumes it.
//
// The three legs mirror services/closeoutSummary.js buildCloseoutSummary output
// (rows_to_write.{log,effort} + rows_to_seal.{count,already_sealed});
// `fromCloseoutSummary` is the tested boundary adapter over that summary + a proof
// object. The proof-field invariants are ENCODED as validator rules, verbatim from
// docs/INVARIANTS.md §2:
//   • W1 dry-run (test_mode true): sheet_written=false, no_write_confirmed=true,
//     sheet_write != 'success', and nothing written (log_rows_written null-or-0,
//     logAppendedRange null).
//   • W3 live success (test_mode false, sheet_write 'success'): sheet_written=true,
//     log_rows_written an integer > 0, logAppendedRange a non-empty A1 range,
//     no_write_confirmed=false.
//
// Public API:
//   buildCloseoutTransaction(params)     → transaction object (does NOT validate)
//   validateCloseoutTransaction(tx)      → { valid, errors[] }  (total, never throws)
//   fromCloseoutSummary(summary, opts)   → canonical transaction from a
//                                          closeoutSummary output + { test_mode, proof }
//   SCHEMA_VERSION, SHEET_WRITE_STATES

const path = require('node:path');
const fs   = require('node:fs');

const CONTRACT_FILE = path.join(__dirname, '..', 'config', 'coaching', 'contracts', 'closeout-transaction.contract.json');

const SCHEMA_VERSION = 1;

// Strict ISO-8601 calendar date (YYYY-MM-DD) — the session date is a date, not a
// timestamp; tighter than Date.parse, which also accepts "June 30 2026".
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function _isIsoDate(v) { return typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)); }

let _contract = null;
function _loadContract() {
  if (!_contract) _contract = Object.freeze(JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')));
  return _contract;
}
function _resetForTesting() { _contract = null; }

function _isPlainObject(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null; // reject Date/RegExp/Map/class instances
}
function _isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function _isNonNegInt(v) { return Number.isInteger(v) && v >= 0; }

// ─── builder ──────────────────────────────────────────────────────────────────

/**
 * Assemble a CloseoutTransaction. Stamps schema_version; defaults session_date to
 * null, log_rows to [], effort_row to null; normalizes seal (counts→0) and the
 * proof envelope (log_rows_written/logAppendedRange→null). `test_mode` is NOT
 * invented — it passes through, so an unspecified mode fails validation (fail
 * closed) rather than silently reading as a live write (W2). Does NOT validate.
 */
function buildCloseoutTransaction(params) {
  const p = _isPlainObject(params) ? params : {};
  const s = _isPlainObject(p.seal) ? p.seal : {};
  const pr = _isPlainObject(p.proof) ? p.proof : {};
  return {
    schema_version: SCHEMA_VERSION,
    session_id:     p.session_id,
    session_date:   p.session_date != null ? p.session_date : null,
    test_mode:      p.test_mode,
    log_rows:       Array.isArray(p.log_rows) ? p.log_rows : [],
    effort_row:     p.effort_row != null ? p.effort_row : null,
    seal: {
      count:          s.count != null ? s.count : 0,
      already_sealed: s.already_sealed != null ? s.already_sealed : 0,
    },
    proof: {
      sheet_write:        pr.sheet_write,
      sheet_written:      pr.sheet_written,
      no_write_confirmed: pr.no_write_confirmed,
      log_rows_written:   pr.log_rows_written != null ? pr.log_rows_written : null,
      logAppendedRange:   pr.logAppendedRange != null ? pr.logAppendedRange : null,
    },
  };
}

// ─── validator (total; never throws) ────────────────────────────────────────────

function validateCloseoutTransaction(tx) {
  if (!_isPlainObject(tx)) return { valid: false, errors: ['transaction: must be an object'] };

  let contract;
  try { contract = _loadContract(); }
  catch (e) { return { valid: false, errors: [`contract load failed: ${e.message}`] }; }
  const writeStates = new Set(contract.sheet_write_states);
  const SUCCESS = contract.live_success_state;

  const errors = [];
  const _has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

  if (tx.schema_version !== SCHEMA_VERSION) errors.push(`schema_version: must be ${SCHEMA_VERSION}`);

  if (!_isNonEmptyString(tx.session_id)) errors.push('session_id: must be a non-empty string');

  // session_date: present (explicit-null); null or a strict ISO-8601 date.
  if (!_has(tx, 'session_date')) errors.push('session_date: must be present (null or an ISO-8601 date)');
  else if (tx.session_date !== null && !_isIsoDate(tx.session_date)) errors.push('session_date: must be a strict ISO-8601 date (YYYY-MM-DD) or null');

  if (typeof tx.test_mode !== 'boolean') errors.push('test_mode: must be a boolean (explicit; absent is never assumed)');

  // log_rows: an array of plain DATA objects (the Log_Cleaned rows the write
  // appends). Column shape is owned by config/columns.js — not re-validated here;
  // this contract owns the TRANSACTION envelope, not the row schema.
  if (!Array.isArray(tx.log_rows)) {
    errors.push('log_rows: must be an array');
  } else {
    tx.log_rows.forEach((r, i) => { if (!_isPlainObject(r)) errors.push(`log_rows[${i}]: must be a plain object`); });
  }

  // effort_row: present (explicit-null); null or a plain DATA object.
  if (!_has(tx, 'effort_row')) errors.push('effort_row: must be present (null or an object)');
  else if (tx.effort_row !== null && !_isPlainObject(tx.effort_row)) errors.push('effort_row: must be a plain object or null');

  // seal: { count, already_sealed } — non-negative integers.
  if (!_isPlainObject(tx.seal)) {
    errors.push('seal: must be an object { count, already_sealed }');
  } else {
    if (!_isNonNegInt(tx.seal.count)) errors.push('seal.count: must be an integer >= 0');
    if (!_isNonNegInt(tx.seal.already_sealed)) errors.push('seal.already_sealed: must be an integer >= 0');
  }

  // proof envelope
  const proof = tx.proof;
  if (!_isPlainObject(proof)) {
    errors.push('proof: must be an object');
    return { valid: false, errors }; // later rules assume the proof shape
  }
  if (!writeStates.has(proof.sheet_write)) errors.push(`proof.sheet_write: must be one of ${contract.sheet_write_states.join(', ')}`);
  if (typeof proof.sheet_written !== 'boolean') errors.push('proof.sheet_written: must be a boolean');
  if (typeof proof.no_write_confirmed !== 'boolean') errors.push('proof.no_write_confirmed: must be a boolean');

  if (!_has(proof, 'log_rows_written')) errors.push('proof.log_rows_written: must be present (null or an integer >= 0)');
  else if (proof.log_rows_written !== null && !_isNonNegInt(proof.log_rows_written)) errors.push('proof.log_rows_written: must be an integer >= 0 or null');

  if (!_has(proof, 'logAppendedRange')) errors.push('proof.logAppendedRange: must be present (null or a non-empty string)');
  else if (proof.logAppendedRange !== null && !_isNonEmptyString(proof.logAppendedRange)) errors.push('proof.logAppendedRange: must be a non-empty string or null');

  // Bail before the invariant rules if the proof shape is broken — they assume it.
  if (errors.length) return { valid: false, errors };

  // ── Invariant W1 — dry-run never writes (docs/INVARIANTS.md §2) ──
  if (tx.test_mode === true) {
    if (proof.sheet_written !== false) errors.push('W1: dry-run (test_mode true) requires proof.sheet_written=false');
    if (proof.no_write_confirmed !== true) errors.push('W1: dry-run (test_mode true) requires proof.no_write_confirmed=true');
    if (proof.sheet_write === SUCCESS) errors.push("W1: dry-run (test_mode true) must not report sheet_write='success'");
    if (proof.log_rows_written !== null && proof.log_rows_written !== 0) errors.push('W1: dry-run wrote nothing — proof.log_rows_written must be null or 0');
    if (proof.logAppendedRange !== null) errors.push('W1: dry-run wrote nothing — proof.logAppendedRange must be null');
  }

  // ── Invariant W3 — live writes require proof fields (docs/INVARIANTS.md §2) ──
  if (tx.test_mode === false && proof.sheet_write === SUCCESS) {
    if (proof.sheet_written !== true) errors.push('W3: a successful live write requires proof.sheet_written=true');
    if (!(Number.isInteger(proof.log_rows_written) && proof.log_rows_written > 0)) errors.push('W3: a successful live write requires proof.log_rows_written to be an integer > 0');
    if (!_isNonEmptyString(proof.logAppendedRange)) errors.push('W3: a successful live write requires a non-empty proof.logAppendedRange (A1 range)');
    if (proof.no_write_confirmed !== false) errors.push('W3: a confirmed live write requires proof.no_write_confirmed=false');
  }

  return { valid: errors.length === 0, errors };
}

// ─── boundary adapter: closeoutSummary output + proof → CloseoutTransaction ──────

// Convert a services/closeoutSummary.js buildCloseoutSummary output (which carries
// rows_to_write.{log,effort} and rows_to_seal.{count,already_sealed}) plus the
// write mode and proof envelope into a canonical CloseoutTransaction. This is the
// single boundary Phase 5g crosses: the summary is the assembled preview, the proof
// comes from the write route response; together they are the one proven transaction.
// Pure; validates clean for a well-formed summary + proof.
function fromCloseoutSummary(summary, { test_mode, proof } = {}) {
  const s = _isPlainObject(summary) ? summary : {};
  const rtw = _isPlainObject(s.rows_to_write) ? s.rows_to_write : {};
  const rts = _isPlainObject(s.rows_to_seal) ? s.rows_to_seal : {};
  return buildCloseoutTransaction({
    session_id:   s.session_id,
    session_date: _isNonEmptyString(s.session_date) ? s.session_date : null,
    test_mode,
    log_rows:     Array.isArray(rtw.log) ? rtw.log : [],
    effort_row:   rtw.effort != null ? rtw.effort : null,
    seal: {
      count:          rts.count != null ? rts.count : 0,
      already_sealed: rts.already_sealed != null ? rts.already_sealed : 0,
    },
    proof,
  });
}

module.exports = {
  SCHEMA_VERSION,
  buildCloseoutTransaction,
  validateCloseoutTransaction,
  fromCloseoutSummary,
  get SHEET_WRITE_STATES() { return [..._loadContract().sheet_write_states]; },
  _resetForTesting,
};
