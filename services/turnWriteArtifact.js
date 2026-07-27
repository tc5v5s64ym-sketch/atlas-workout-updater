'use strict';

// Reviewable turn→write artifact (#1165 slice 3).
//
// Reads the two bounded log records already emitted by the Phase-4 correlation seam:
//   [interaction-trace]  — the read-only coach turn's canonical trace summary
//   [turn-write-proof]   — each write attempt correlated to that turn
// and joins them ONLY on the existing canonical turn_id.
//
// This consumer is deliberately distrustful of its input. Deployment logs are not a trusted
// object channel, so every accepted field is rebuilt under a closed whitelist and bounded again.
// Pairing capabilities, payload fingerprints, rows, prompts, prose, Sheet ids, and arbitrary
// nested data have no output path.
//
// Honest seal presentation is load-bearing. A seal can report sheet_written:true while
// sealed_ok:false (`seal_proof_mismatch`); that is a failed/mismatched seal, never a successfully
// sealed write. A successful new stamp and an idempotent already-sealed replay are distinct.
//
// Pure and deterministic: no I/O, clock, network, Sheets, or app mutation. The CLI wrapper owns
// file/stdin reads and rendering.

const {
  MAX_OUTSTANDING_PAIRINGS,
  MAX_WRITES_PER_PAIRING,
  PROOF_KEYS,
  PROOF_PROJECTIONS,
} = require('./turnCorrelation');
const { STAGES, STAGE_STATUSES } = require('./interactionTrace');
const { logCleanedColumns, effortColumns } = require('../config/columns');

const INTERACTION_TRACE_MARKER = '[interaction-trace]';
const TURN_WRITE_PROOF_MARKER = '[turn-write-proof]';
const SCHEMA_VERSION = 1;
const MAX_INPUT_LINES = 10_000;
const MAX_RECORDS = 500;
const MAX_REJECTIONS = 200;
const MAX_ARTIFACT_STRING_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 128;

const STAGE_SET = new Set(STAGES);
const STAGE_STATUS_SET = new Set(STAGE_STATUSES);
const PROJECTED_PROOF_KEYS = Object.freeze(Object.entries(PROOF_PROJECTIONS)
  .flatMap(([envelope, fields]) => fields.map((field) => `${envelope}_${field}`)));
// These top-level proof strings are genuine response fields, but their server contract permits
// arbitrary client text (`write_id`) or prose (`reason`), or a future tab/range string. The
// artifact does not need them: write_attempt is the bounded attempt identity and numeric/boolean
// fields carry the positive proof. Exclude them rather than attempting to redact untrusted prose.
const OMITTED_UNSAFE_STRING_KEYS = new Set([
  'reason',
  'write_id',
  'log_appended_range',
  'effort_appended_range',
  'logAppendedRange',
  'effortAppendedRange',
]);
const ALLOWED_PROOF_KEYS = new Set([
  ...PROOF_KEYS.filter((key) => !OMITTED_UNSAFE_STRING_KEYS.has(key)),
  ...PROJECTED_PROOF_KEYS,
]);
const ALLOWED_WITHHELD_KEYS = new Set(PROJECTED_PROOF_KEYS);
// `appendRows` sends exactly one value per contract column, so Google reports an updatedRange
// ending at that many columns. Derive the expected last column from the column contract itself
// rather than hard-coding a letter, so a schema migration cannot silently widen what counts as
// W3 proof (Log_Cleaned = 12 columns -> L; Effort = 9 columns -> I).
const _lastColumnLetter = (columnCount) => String.fromCharCode('A'.charCodeAt(0) + columnCount - 1);
const LOG_LAST_COLUMN = _lastColumnLetter(logCleanedColumns.length);
const EFFORT_LAST_COLUMN = _lastColumnLetter(effortColumns.length);
// The tab NAME is configurable (`sheets.js`: LOG_SHEET_NAME / EFFORT_SHEET_NAME), and the real
// append routes use the configured name, so Google returns that name in `updatedRange`. Reading
// the same env with the same defaults keeps a default deployment identical while not calling
// every genuine append on an overridden deployment insufficient. Resolved once at module load —
// this stays a pure, deterministic consumer.
const LOG_TAB_NAME = process.env.LOG_SHEET_NAME || 'Log_Cleaned';
const EFFORT_TAB_NAME = process.env.EFFORT_SHEET_NAME || 'Effort';
const _escapeForRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BOOLEAN_PROOF_KEYS = new Set([
  'test_mode', 'sheet_written', 'no_write_confirmed', 'dry_run', 'duplicate_write',
  'effortWritten', 'closeout_fully_verified',
  'ledger_seal_sheet_written', 'ledger_seal_no_write_confirmed', 'ledger_seal_dry_run',
  'ledger_seal_sealed_ok', 'ledger_seal_no_ledger', 'ledger_seal_read_failed',
  'session_plans_closeout_captured',
]);
const NUMBER_PROOF_KEYS = new Set([
  'rows_appended', 'log_rows_written', 'effort_rows_written', 'skipped_duplicates',
  'ledger_seal_sealed', 'ledger_seal_already_sealed', 'ledger_seal_would_seal',
  'ledger_seal_expected_cells', 'ledger_seal_updated_cells',
  'session_plans_closeout_written', 'session_plans_closeout_skipped',
]);
const WRITE_ROUTES = new Set([
  '/api/log-workout',
  '/api/complete-workout',
  '/api/log-modality',
  '/api/bodyweight',
]);
const SHEET_WRITE_STATES = new Set([
  'blocked_schema_drift',
  'partial',
  'skipped',
  'skipped_duplicate',
  'skipped_duplicate_in_progress',
  'success',
  'unverified',
]);
const IDEMPOTENCY_STATES = new Set(['completed', 'failed', 'in_progress', 'unknown']);
const CLOSEOUT_STATES = new Set([
  'disabled',
  'error',
  'header_mismatch',
  'no_plan',
  'skipped',
  'tab_missing',
  'written',
]);
// The seal emitter's closed reason vocabulary (services/sessionPlanSetsStore.js `sealCloseout`).
// EVERY one describes a NON-stamping outcome — a dry run, a verified no-op, a failure, or a proof
// mismatch. A genuine fresh stamp returns no `reason` field at all. So a reason presented beside a
// positive stamp claim is an impossible tuple, not a successful seal, and a reason outside this
// vocabulary is not something the producer can emit.
const SEAL_REASONS = new Set([
  'test_mode',
  'write_disabled',
  'ledger_read_failed',
  'tab_missing',
  'no_rows',
  'conflicting_seal',
  'malformed_chain',
  'all_sealed',
  'seal_proof_mismatch',
  // `sealCloseout` is not the only producer: when it THROWS, the route itself synthesizes
  // `{sealed_ok:false, reason:'seal_error'}` (index.js, both the duplicate and normal branches).
  // Omitting it would make the artifact reject that entire real record and lose the join, so a
  // genuine seal failure could not be reviewed through this tool at all.
  'seal_error',
]);
// The only two `sealCloseout` outcomes that reach `verified_no_new_seal`; both also carry
// `no_ledger:true` and `already_sealed:0`.
const VERIFIED_EMPTY_SEAL_REASONS = new Set(['tab_missing', 'no_rows']);
// Routes whose live success proof is a PER-TAB append: one value per contract column, a positive
// row count per tab, and the append range Google returned for it. `/api/complete-workout` verifies
// those exact row counts against the ranges before returning, exactly as `/api/log-workout` does,
// so both are held to the same range-backed tuple rather than a generic positive scalar.
const PER_TAB_APPEND_ROUTES = new Set(['/api/log-workout', '/api/complete-workout']);
const NULLABLE_PROOF_KEYS = new Set([
  'ledger_seal_updated_cells',
  'session_plans_closeout_plan_version',
]);
const TRACE_INTENT_TYPES = new Set(['set', 'block', 'plan', 'coach_chat', 'coach_ask']);
const TRACE_SOURCES = new Set(['coach_message', 'coach_chat', 'coach_ask']);
const SAFE_STATE_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
// Neither the server nor the client constrains `session_id` beyond "nonempty, bounded, trimmed"
// (index.js; src/app/turnCorrelation.js validSessionId), so it is free text as far as any contract
// goes and can carry workout prose or a Sheet range. There is no producer shape to validate
// against, so the artifact publishes only ids that ARE opaque identifiers — no whitespace, no `!`
// or `:` — and treats anything else as unpublishable rather than reflecting it. The record is
// still retained: dropping a real join would be its own failure (cf. the `seal_error` lesson).
const OPAQUE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CANONICAL_TURN_ID_RE = /^turn:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_([0-9]{1,6})_([a-z0-9]{1,6})$/;
const PAIRING_TOKEN_RE = /pair:[a-f0-9]{32}/;
const FINGERPRINT_RE = /(?:sha256:)?[a-f0-9]{64}/i;
const PLAN_VERSION_RE = /^pv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function _isPlainObject(value) {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function _isBoundedString(value, max = MAX_ARTIFACT_STRING_LENGTH) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function _isIso8601(value) {
  return _isBoundedString(value, 40) && ISO_8601.test(value) && !Number.isNaN(Date.parse(value));
}

function _isCanonicalTurnId(value) {
  if (typeof value !== 'string' || value.length > 128) return false;
  const match = CANONICAL_TURN_ID_RE.exec(value);
  if (!match) return false;
  const sequence = Number(match[2]);
  return sequence >= 0
    && sequence < 1_000_000
    && !Number.isNaN(Date.parse(match[1]))
    && new Date(match[1]).toISOString() === match[1];
}

function _containsCapability(value) {
  return typeof value === 'string' && (PAIRING_TOKEN_RE.test(value) || FINGERPRINT_RE.test(value));
}

function _sanitizeTrace(record) {
  if (!_isPlainObject(record)
    || !_isCanonicalTurnId(record.turn_id)
    || _containsCapability(record.turn_id)) return null;
  if (!_isIso8601(record.started_at) || typeof record.valid !== 'boolean') return null;
  if (!Array.isArray(record.stages) || record.stages.length > STAGES.length) return null;
  if (!Array.isArray(record.missing) || record.missing.length > STAGES.length) return null;

  const stages = [];
  const seenStages = new Set();
  let lastStageIndex = -1;
  for (const entry of record.stages) {
    if (!_isPlainObject(entry) || !STAGE_SET.has(entry.stage) || !STAGE_STATUS_SET.has(entry.status)) return null;
    const stageIndex = STAGES.indexOf(entry.stage);
    if (seenStages.has(entry.stage) || stageIndex <= lastStageIndex) return null;
    seenStages.add(entry.stage);
    lastStageIndex = stageIndex;
    stages.push({ stage: entry.stage, status: entry.status });
  }

  const missing = [];
  const seenMissing = new Set();
  for (const stage of record.missing) {
    if (!STAGE_SET.has(stage) || seenMissing.has(stage)) return null;
    seenMissing.add(stage);
    missing.push(stage);
  }
  const expectedMissing = STAGES.filter((stage) => !seenStages.has(stage));
  if (missing.length !== expectedMissing.length
    || missing.some((stage, index) => stage !== expectedMissing[index])) {
    return null;
  }

  const intentType = record.intent_type === null || record.intent_type === undefined
    ? null
    : (TRACE_INTENT_TYPES.has(record.intent_type)
      ? record.intent_type
      : null);
  const source = record.source === null || record.source === undefined
    ? null
    : (TRACE_SOURCES.has(record.source)
      ? record.source
      : null);

  return {
    turn_id: String(record.turn_id).trim(),
    started_at: record.started_at,
    valid: record.valid,
    intent_type: intentType,
    source,
    stages,
    missing,
  };
}

function _validProofValue(key, value) {
  // Nullability is PER KEY, not global. A blanket `null` allowance would bypass every shape check
  // below and admit producer shapes no route can emit (a present-but-null `test_mode` is malformed,
  // not the absent field that W2 reads as a live write). Only these two are genuinely emitted as
  // null: `sealCloseout` reports `updated_cells:null` when the response count is unreadable, and
  // the closeout projection's own validator explicitly permits a null `plan_version`. Rejecting
  // either would discard a real record.
  if (value === null) return NULLABLE_PROOF_KEYS.has(key);
  if (BOOLEAN_PROOF_KEYS.has(key)) return typeof value === 'boolean';
  if (NUMBER_PROOF_KEYS.has(key)) return Number.isSafeInteger(value) && value >= 0;
  if (key === 'sheet_write') return SHEET_WRITE_STATES.has(value);
  if (key === 'idempotency_status') return IDEMPOTENCY_STATES.has(value);
  if (key === 'ledger_seal_reason') {
    return typeof value === 'string' && SAFE_STATE_TOKEN.test(value) && SEAL_REASONS.has(value);
  }
  if (key === 'session_plans_closeout_status') return CLOSEOUT_STATES.has(value);
  if (key === 'session_plans_closeout_plan_version') return PLAN_VERSION_RE.test(value);
  return _isBoundedString(value) && !_containsCapability(value);
}

function _sanitizeProof(record) {
  if (!_isPlainObject(record)
    || record.schema_version !== 1
    || !_isCanonicalTurnId(record.turn_id)
    || _containsCapability(record.turn_id)) return null;
  let sessionId = record.session_id;
  let sessionIdentity = 'absent';
  if (sessionId !== null) {
    if (!_isBoundedString(sessionId, MAX_SESSION_ID_LENGTH) || _containsCapability(sessionId)) return null;
    if (OPAQUE_SESSION_ID.test(sessionId)) {
      sessionIdentity = 'present';
    } else {
      // Keep the join, publish nothing. `unpublishable` is deliberately distinct from `absent`:
      // an identity that exists but cannot be shown is not the same as one that was never recorded.
      sessionIdentity = 'unpublishable';
      sessionId = null;
    }
  }
  if (!_isBoundedString(record.route, 64) || !WRITE_ROUTES.has(record.route)) return null;
  if (!_isIso8601(record.recorded_at) || !_isPlainObject(record.pairing) || !_isPlainObject(record.proof)) return null;

  const pairing = record.pairing;
  if (typeof pairing.established_at_preview !== 'boolean'
    || !Number.isInteger(pairing.write_attempt)
    || pairing.write_attempt < 0
    || pairing.write_attempt > MAX_WRITES_PER_PAIRING
    || (pairing.previewed_write_id_match !== null && typeof pairing.previewed_write_id_match !== 'boolean')
    || typeof pairing.payload_bound !== 'boolean'
    || typeof pairing.effort_transition !== 'boolean') {
    return null;
  }

  const proof = {};
  for (const key of ALLOWED_PROOF_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record.proof, key)) continue;
    const value = record.proof[key];
    if (!_validProofValue(key, value)) return null;
    proof[key] = value;
  }
  const hasBoundAppendRange = (keys, expectedTab, expectedLastColumn, expectedRows) => keys.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(record.proof, key)) return false;
    const value = record.proof[key];
    if (typeof value !== 'string'
      || value.length > MAX_ARTIFACT_STRING_LENGTH
      || !Number.isSafeInteger(expectedRows)
      || expectedRows <= 0
      || _containsCapability(value)) return false;
    const match = new RegExp(`^${_escapeForRegExp(expectedTab)}!A([1-9]\\d{0,6}):${expectedLastColumn}([1-9]\\d{0,6})$`).exec(value);
    if (!match) return false;
    const firstRow = Number(match[1]);
    const lastRow = Number(match[2]);
    return lastRow >= firstRow && (lastRow - firstRow + 1) === expectedRows;
  });
  // Range values are intentionally never emitted. These fixed booleans let the consumer enforce
  // W3's proof tuple without reflecting a tab/range string from the untrusted log stream.
  const rangeEvidence = {
    log: hasBoundAppendRange(
      ['logAppendedRange', 'log_appended_range'],
      LOG_TAB_NAME,
      LOG_LAST_COLUMN,
      proof.log_rows_written,
    ),
    effort: hasBoundAppendRange(
      ['effortAppendedRange', 'effort_appended_range'],
      EFFORT_TAB_NAME,
      EFFORT_LAST_COLUMN,
      proof.effort_rows_written,
    ),
  };

  if (!Array.isArray(record.withheld_evidence)) return null;
  const withheldEvidence = [];
  const seenWithheld = new Set();
  for (const key of record.withheld_evidence) {
    if (!ALLOWED_WITHHELD_KEYS.has(key) || seenWithheld.has(key)) return null;
    if (Object.prototype.hasOwnProperty.call(proof, key)) return null;
    seenWithheld.add(key);
    withheldEvidence.push(key);
  }

  if (pairing.write_attempt === 0
    && (pairing.established_at_preview !== true
      || pairing.payload_bound !== false
      || proof.test_mode !== true
      || proof.sheet_written !== false
      || proof.no_write_confirmed !== true)) {
    return null;
  }

  return {
    schema_version: 1,
    turn_id: String(record.turn_id).trim(),
    session_id: sessionId,
    session_identity: sessionIdentity,
    route: record.route,
    recorded_at: record.recorded_at,
    pairing: {
      established_at_preview: pairing.established_at_preview,
      write_attempt: pairing.write_attempt,
      previewed_write_id_match: pairing.previewed_write_id_match,
      payload_bound: pairing.payload_bound,
      effort_transition: pairing.effort_transition,
    },
    proof,
    range_evidence: rangeEvidence,
    withheld_evidence: withheldEvidence,
  };
}

function _emptyParsed() {
  return {
    traces: [],
    proofs: [],
    rejected: [],
    rejected_count: 0,
  };
}

function parseTurnWriteLines(text) {
  const parsed = _emptyParsed();
  if (typeof text !== 'string' || text.length === 0) return parsed;

  const reject = (reason, marker, lineNumber, turnId = null) => {
    parsed.rejected_count += 1;
    if (parsed.rejected.length < MAX_REJECTIONS) {
      parsed.rejected.push({ reason, marker, line: lineNumber, turn_id: turnId });
    }
  };

  const lines = text.split(/\r?\n/);
  const acceptedLimit = Math.min(lines.length, MAX_INPUT_LINES);
  if (lines.length > MAX_INPUT_LINES) {
    reject('input_line_limit', null, MAX_INPUT_LINES + 1);
  }

  for (let i = 0; i < acceptedLimit; i += 1) {
    const raw = lines[i];
    const traceAt = raw.indexOf(INTERACTION_TRACE_MARKER);
    const proofAt = raw.indexOf(TURN_WRITE_PROOF_MARKER);
    if (traceAt === -1 && proofAt === -1) continue;
    if (traceAt !== -1 && proofAt !== -1) {
      reject('multiple_markers', null, i + 1);
      continue;
    }

    const marker = traceAt !== -1 ? INTERACTION_TRACE_MARKER : TURN_WRITE_PROOF_MARKER;
    const at = traceAt !== -1 ? traceAt : proofAt;
    const json = raw.slice(at + marker.length).trim();
    let source;
    try {
      source = JSON.parse(json);
    } catch (_) {
      reject('malformed_json', marker, i + 1);
      continue;
    }

    const turnId = _isPlainObject(source) && _isCanonicalTurnId(source.turn_id)
      ? source.turn_id
      : null;
    const sanitized = marker === INTERACTION_TRACE_MARKER
      ? _sanitizeTrace(source)
      : _sanitizeProof(source);
    if (!sanitized) {
      reject('invalid_record', marker, i + 1, turnId);
      continue;
    }

    const totalAccepted = parsed.traces.length + parsed.proofs.length;
    if (totalAccepted >= MAX_RECORDS) {
      reject('record_limit', marker, i + 1, sanitized.turn_id);
      continue;
    }
    if (marker === INTERACTION_TRACE_MARKER) parsed.traces.push(sanitized);
    else parsed.proofs.push(sanitized);
  }
  return parsed;
}

function _authorization(pairing) {
  if (pairing.established_at_preview && pairing.payload_bound) return 'preview_payload_bound';
  if (pairing.established_at_preview) return 'preview_only_unbound';
  return 'unestablished';
}

function _sealSummary(proof, withheldEvidence) {
  const withheld = withheldEvidence.some((key) => key.startsWith('ledger_seal_'));
  const hasSeal = Object.keys(proof).some((key) => key.startsWith('ledger_seal_'));
  // SEAL-LOCAL ONLY. `ledger_seal_sheet_written` is the sole evidence that the independent sidecar
  // write happened; the main write's `sheet_written` describes a different write and must never be
  // borrowed to substantiate a seal. Absent means unknown, not false.
  const sheetWritten = typeof proof.ledger_seal_sheet_written === 'boolean'
    ? proof.ledger_seal_sheet_written
    : null;
  const sealedOk = typeof proof.ledger_seal_sealed_ok === 'boolean'
    ? proof.ledger_seal_sealed_ok
    : null;
  const sealed = typeof proof.ledger_seal_sealed === 'number' ? proof.ledger_seal_sealed : null;
  const alreadySealed = typeof proof.ledger_seal_already_sealed === 'number'
    ? proof.ledger_seal_already_sealed
    : null;
  const hasMismatchCounts = Object.prototype.hasOwnProperty.call(proof, 'ledger_seal_expected_cells')
    || Object.prototype.hasOwnProperty.call(proof, 'ledger_seal_updated_cells');
  const claimsMismatch = proof.ledger_seal_reason === 'seal_proof_mismatch';
  const claimsNoSealWrite = proof.ledger_seal_no_write_confirmed === true
    || proof.ledger_seal_dry_run === true;
  const claimsPositiveSealWrite = sheetWritten === true || sealed > 0;
  // Any reason at all describes an outcome that did NOT stamp a row, so it cannot coexist with a
  // positive stamp claim. A genuine fresh stamp carries no reason.
  const reasonContradictsStamp = SEAL_REASONS.has(proof.ledger_seal_reason) && claimsPositiveSealWrite;
  // `no_ledger` and `read_failed` are emitted ONLY on non-stamping outcomes; neither the fresh
  // stamp nor the all-sealed replay ever carries them, so their presence rules both out.
  const hasNonStampingFlag = proof.ledger_seal_no_ledger === true
    || proof.ledger_seal_read_failed === true;

  let state = 'absent';
  if (claimsMismatch) state = 'seal_proof_mismatch';
  else if (reasonContradictsStamp) state = 'seal_proof_mismatch';
  else if (sealedOk === true && claimsNoSealWrite && claimsPositiveSealWrite) state = 'seal_proof_mismatch';
  else if (sealedOk === false && sheetWritten === true) state = 'seal_proof_mismatch';
  else if (sealedOk === false) state = 'failed';
  else if (sealedOk === true && hasMismatchCounts) state = 'seal_proof_mismatch';
  else if (sealedOk === true && sheetWritten === false && sealed > 0) state = 'seal_proof_mismatch';
  // A positive stamp count with no seal-local write evidence substantiates nothing: the real
  // emitter always reports `sheet_written` on the stamping path.
  else if (sealedOk === true && sealed > 0 && sheetWritten !== true) state = 'indeterminate';
  // EVERY positive seal state requires its producer's COMPLETE tuple, not just the fields that
  // happen to look affirmative — absent means unknown here as everywhere else. The three shapes
  // below are exactly what `sealCloseout` returns; `column` is deliberately NOT required because
  // the ledger_seal projection does not carry it, so it never reaches this consumer.
  //
  // Fresh stamp: sheet_written:true, no_write_confirmed:false, sealed>0, and the sibling
  // already_sealed count, which the producer always emits beside `sealed`.
  else if (sealedOk === true
    && sheetWritten === true
    && sealed > 0
    && proof.ledger_seal_no_write_confirmed === false
    && Number.isSafeInteger(alreadySealed)
    && !hasNonStampingFlag) {
    state = 'sealed';
  }
  else if (sealedOk === true && sheetWritten === true) state = 'indeterminate';
  // Idempotent replay: the producer always stamps this path with reason:'all_sealed'. Other
  // non-writing outcomes share these booleans and counts, so the discriminator is what separates
  // them — the path must never be inferred from counts alone.
  else if (sealedOk === true
    && sheetWritten === false
    && proof.ledger_seal_no_write_confirmed === true
    && sealed === 0
    && alreadySealed > 0
    && proof.ledger_seal_reason === 'all_sealed'
    && !hasNonStampingFlag) {
    state = 'already_sealed';
  }
  // Verified empty seal: only `tab_missing` and `no_rows` reach it, and both carry no_ledger:true,
  // already_sealed:0, and their own reason. A shape missing those is not a producible outcome.
  else if (sealedOk === true
    && sheetWritten === false
    && proof.ledger_seal_no_write_confirmed === true
    && sealed === 0
    && alreadySealed === 0
    && proof.ledger_seal_no_ledger === true
    && VERIFIED_EMPTY_SEAL_REASONS.has(proof.ledger_seal_reason)) {
    state = 'verified_no_new_seal';
  }
  else if (sealedOk === true) state = 'indeterminate';
  else if (withheld) state = 'withheld';
  else if (hasSeal) state = 'indeterminate';

  return {
    state,
    successfully_sealed: state === 'sealed' || state === 'already_sealed',
    new_seal_write: state === 'sealed',
    sheet_written: sheetWritten,
    sealed_ok: sealedOk,
    sealed,
    already_sealed: alreadySealed,
    reason: typeof proof.ledger_seal_reason === 'string' ? proof.ledger_seal_reason : null,
  };
}

function _closeoutSummary(proof, withheldEvidence) {
  const planVersionKey = 'session_plans_closeout_plan_version';
  const hasPlanVersion = Object.prototype.hasOwnProperty.call(proof, planVersionKey);
  const planVersionWithheld = withheldEvidence.includes(planVersionKey);
  const hasCloseout = Object.keys(proof).some((key) => key.startsWith('session_plans_closeout_'));
  const status = typeof proof.session_plans_closeout_status === 'string'
    ? proof.session_plans_closeout_status
    : null;
  const captured = typeof proof.session_plans_closeout_captured === 'boolean'
    ? proof.session_plans_closeout_captured
    : null;
  const written = typeof proof.session_plans_closeout_written === 'number'
    ? proof.session_plans_closeout_written
    : null;
  const skipped = typeof proof.session_plans_closeout_skipped === 'number'
    ? proof.session_plans_closeout_skipped
    : null;

  let state = 'absent';
  // `writeSessionCloseout` appends exactly ONE event and `_envelope` always emits both counts, so
  // a written result must carry `skipped:0` — the same producer invariant the skipped branch below
  // already enforces in the other direction.
  if (status === 'written' && captured === true && written === 1 && skipped === 0) {
    state = planVersionWithheld || !hasPlanVersion || proof[planVersionKey] === null
      ? 'written_unidentified'
      : 'written';
  } else if (status === 'skipped' && captured === true && written === 0 && skipped === 1) {
    state = planVersionWithheld || !hasPlanVersion || proof[planVersionKey] === null
      ? 'already_captured_unidentified'
      : 'already_captured';
  }
  else if (status === 'error' || status === 'tab_missing' || status === 'header_mismatch') state = 'failed';
  // `disabled` and `no_plan` are non-capture outcomes: their producers emit captured:false with
  // zero-or-absent counts (sessionPlanCapture.js `_envelope`; index.js `recordCloseoutEvent`).
  // A contradictory sibling field means the envelope is not one of those outcomes.
  else if ((status === 'disabled' || status === 'no_plan')
    && captured === false
    && (written === null || written === 0)
    && (skipped === null || skipped === 0)) {
    state = status;
  }
  else if (planVersionWithheld) state = 'withheld';
  else if (hasCloseout) state = 'indeterminate';

  return {
    state,
    status,
    captured,
    written,
    skipped,
    plan_version: hasPlanVersion ? proof[planVersionKey] : null,
    plan_version_state: planVersionWithheld ? 'withheld' : (hasPlanVersion ? 'present' : 'absent'),
  };
}

function _proofState(proof, seal, closeout, route, rangeEvidence = {}) {
  if (proof.sheet_write === 'unverified') return 'unverified';
  if (proof.sheet_write === 'partial') return 'partial';
  if (proof.sheet_write === 'skipped_duplicate_in_progress') return 'idempotency_in_progress';

  const claimsSuccess = proof.sheet_write === 'success';
  const logRowsWritten = typeof proof.log_rows_written === 'number' && proof.log_rows_written > 0;
  const effortRowsWritten = typeof proof.effort_rows_written === 'number' && proof.effort_rows_written > 0;
  // Every positive tab count must carry its OWN matching range. One range-backed tab must never
  // substantiate the other tab's unbacked count on the same response.
  const rangeBackedLogWorkoutWrite = (logRowsWritten || effortRowsWritten)
    && (!logRowsWritten || rangeEvidence.log === true)
    && (!effortRowsWritten || rangeEvidence.effort === true);
  const isPerTabAppend = PER_TAB_APPEND_ROUTES.has(route);
  // `/api/complete-workout` appends Effort UNCONDITIONALLY (index.js:2585) and gates success on
  // `effort_rows_written === 1` plus an Effort range (index.js:2643), so a log-only success is
  // unreachable there. `/api/log-workout` has no such requirement — an effort-less log append is
  // its ordinary shape.
  const perTabWrite = route === '/api/complete-workout'
    ? (proof.effort_rows_written === 1
      && rangeEvidence.effort === true
      && (!logRowsWritten || rangeEvidence.log === true))
    : rangeBackedLogWorkoutWrite;
  // `/api/log-modality` and `/api/bodyweight` emit `sheet_write:'success'` with
  // `sheet_written:true` and NO row-count field (index.js:1407-1423, 2024-2036), so a count can
  // never substitute for the write flag on those routes.
  const genericMainWrite = proof.sheet_written === true;
  // CLASSIFICATION and CONTRADICTION are different questions. A row count cannot *substantiate* a
  // generic-route write, but any append indicator still CONTRADICTS an explicit no-write claim —
  // `no_write_confirmed:true` beside `rows_appended:3` is impossible however the route classifies.
  const anyPositiveWriteSignal = proof.sheet_written === true
    || (typeof proof.rows_appended === 'number' && proof.rows_appended > 0)
    || logRowsWritten
    || effortRowsWritten;
  const mainWrite = claimsSuccess && (isPerTabAppend ? perTabWrite : genericMainWrite);
  const positiveWrite = mainWrite
    || seal.new_seal_write
    || closeout.state === 'written';

  // `/api/log-workout` has one live main-write success shape. A non-success state cannot use
  // generic row/sheet signals to bypass its range-backed W3 tuple, and an explicit false write
  // flag cannot coexist with a claimed range-backed success.
  if (proof.test_mode !== true
    && ((!claimsSuccess && anyPositiveWriteSignal)
      || (claimsSuccess
        && proof.sheet_written === false
        && (isPerTabAppend ? perTabWrite : genericMainWrite)))) {
    return 'contradictory';
  }

  // A proof cannot simultaneously claim the explicit W1 no-write guarantee and a real append.
  // `effortWritten` is intentionally excluded: on a preview it means an effort row was formatted,
  // not appended, and the explicit no-write tuple remains authoritative for that real route shape.
  if (proof.no_write_confirmed === true && (positiveWrite || claimsSuccess || anyPositiveWriteSignal)) return 'contradictory';
  if (proof.test_mode === true && (positiveWrite || claimsSuccess)) return 'contradictory';

  // A CLAIMED live main write must substantiate itself. The seal and the closeout event are
  // independent sidecar writes: on the all-rows-duplicate branch — which claims no main write at
  // all — their own positive evidence legitimately makes the turn reviewable. But they describe a
  // different write, so they must never stand in for a main append whose own W1–W3 tuple (for
  // `/api/log-workout`, the per-tab range binding) does not hold.
  if (claimsSuccess && !mainWrite) return 'insufficient';

  // The explicit W1 no-write tuple outranks incidental response bookkeeping such as
  // effortWritten:true on a preview (which means an effort row was formatted, not appended).
  if (proof.test_mode === true
    && proof.no_write_confirmed === true
    && proof.sheet_written === false) {
    return 'no_write_confirmed';
  }

  // `effortWritten` is response bookkeeping, not W3 append proof: the preview path can set it
  // after formatting an Effort row while the explicit no-write tuple confirms nothing appended.
  // A live attempt must therefore satisfy the same positive tuple above; this boolean alone can
  // never substantiate a write.
  if (positiveWrite) return 'write_confirmed';

  // The all-rows-duplicate closeout path is the ONLY correlated duplicate producer — an ordinary
  // early replay is never recorded at all (index.js records this branch only when a seal or
  // closeout envelope exists). It emits the whole tuple, so no single duplicate or replay signal
  // may stand in for the others.
  if (proof.test_mode === false
    && proof.sheet_write === 'skipped_duplicate'
    && proof.sheet_written === false
    && proof.duplicate_write === true
    && proof.log_rows_written === 0
    && typeof proof.skipped_duplicates === 'number'
    && proof.skipped_duplicates > 0) {
    return 'idempotent_no_write';
  }
  return 'insufficient';
}

function _writeArtifact(record) {
  const authorization = _authorization(record.pairing);
  const seal = _sealSummary(record.proof, record.withheld_evidence);
  const closeout = _closeoutSummary(record.proof, record.withheld_evidence);
  const proofState = _proofState(record.proof, seal, closeout, record.route, record.range_evidence);
  const issues = [];
  if (authorization !== 'preview_payload_bound') issues.push('authorization_unbound');
  if (proofState === 'insufficient') issues.push('write_proof_insufficient');
  else if (proofState === 'unverified') issues.push('write_proof_unverified');
  else if (proofState === 'partial') issues.push('write_proof_partial');
  else if (proofState === 'idempotency_in_progress') issues.push('write_proof_in_progress');
  else if (proofState === 'contradictory') issues.push('write_proof_contradictory');
  if (record.withheld_evidence.length > 0) issues.push('evidence_withheld');
  if (seal.state === 'seal_proof_mismatch') issues.push('seal_proof_mismatch');
  else if (seal.state === 'failed' || seal.state === 'withheld' || seal.state === 'indeterminate') {
    issues.push('seal_not_verified');
  }
  if (closeout.state === 'failed'
    || closeout.state === 'indeterminate'
    || closeout.state === 'written_unidentified'
    || closeout.state === 'already_captured_unidentified'
    || closeout.state === 'withheld') {
    issues.push('closeout_not_reviewable');
  }
  // The route's OWN verdict. `closeoutVerification` (index.js) returns false for a failed event
  // capture, and for a planned closeout whose ledger is missing, even when the seal reports
  // sealed_ok:true and the Session_Plans event was written. That is the route explicitly flagging
  // an unverified closeout; the artifact must never reclassify it as verified.
  if (record.proof.closeout_fully_verified === false) issues.push('closeout_not_verified');
  // …and REQUIRED, not merely honored when present. Both emitting branches attach the verdict
  // whenever they attach `ledger_seal`, so its absence beside seal or closeout evidence is unknown
  // evidence rather than an implicit positive verdict. A plain main write carries no such evidence
  // and needs no verdict.
  else if ((seal.state !== 'absent' || closeout.state !== 'absent')
    && record.proof.closeout_fully_verified !== true) {
    issues.push('closeout_verdict_missing');
  }

  return {
    session_id: record.session_id,
    session_identity: record.session_identity,
    route: record.route,
    recorded_at: record.recorded_at,
    pairing: { ...record.pairing },
    authorization,
    proof_state: proofState,
    proof: { ...record.proof },
    withheld_evidence: [...record.withheld_evidence],
    seal,
    closeout,
    issues,
    reviewable: issues.length === 0,
  };
}

function _previewArtifact(record) {
  const seal = _sealSummary(record.proof, record.withheld_evidence);
  const closeout = _closeoutSummary(record.proof, record.withheld_evidence);
  const proofState = _proofState(record.proof, seal, closeout, record.route, record.range_evidence);
  const issues = [];
  if (proofState !== 'no_write_confirmed') issues.push('preview_no_write_proof_missing');
  if (record.withheld_evidence.length > 0) issues.push('evidence_withheld');
  return {
    session_id: record.session_id,
    session_identity: record.session_identity,
    route: record.route,
    recorded_at: record.recorded_at,
    pairing: { ...record.pairing },
    proof_state: proofState,
    proof: { ...record.proof },
    withheld_evidence: [...record.withheld_evidence],
    issues,
    reviewable: issues.length === 0,
  };
}

function buildTurnWriteArtifact(input) {
  const parsed = typeof input === 'string' ? parseTurnWriteLines(input) : input;
  const safeParsed = _isPlainObject(parsed) ? parsed : _emptyParsed();
  const traces = Array.isArray(safeParsed.traces) ? safeParsed.traces : [];
  const proofs = Array.isArray(safeParsed.proofs) ? safeParsed.proofs : [];
  const rejected = Array.isArray(safeParsed.rejected) ? safeParsed.rejected : [];
  let rejectedCount = Number.isInteger(safeParsed.rejected_count)
    ? safeParsed.rejected_count
    : rejected.length;

  const traceMap = new Map();
  for (const trace of traces) {
    if (!traceMap.has(trace.turn_id)) traceMap.set(trace.turn_id, []);
    const bucket = traceMap.get(trace.turn_id);
    const serialized = JSON.stringify(trace);
    if (!bucket.some((existing) => JSON.stringify(existing) === serialized)) bucket.push(trace);
  }

  const proofMap = new Map();
  for (const proof of proofs) {
    if (!proofMap.has(proof.turn_id)) proofMap.set(proof.turn_id, []);
    const bucket = proofMap.get(proof.turn_id);
    const serialized = JSON.stringify(proof);
    if (!bucket.some((existing) => JSON.stringify(existing) === serialized)) bucket.push(proof);
  }

  const turnIds = [...new Set([...traceMap.keys(), ...proofMap.keys()])].sort();
  const turns = [];
  for (const turnId of turnIds) {
    const traceRecords = traceMap.get(turnId) || [];
    const allProofRecords = (proofMap.get(turnId) || []).slice().sort((a, b) => (
      a.pairing.write_attempt - b.pairing.write_attempt
      || a.recorded_at.localeCompare(b.recorded_at)
      || String(a.proof.write_id || '').localeCompare(String(b.proof.write_id || ''))
    ));
    let previewRecords = allProofRecords.filter((record) => record.pairing.write_attempt === 0);
    let proofRecords = allProofRecords.filter((record) => record.pairing.write_attempt > 0);
    const issues = [];

    if (traceRecords.length > 1) issues.push('conflicting_traces');
    if (previewRecords.length > MAX_OUTSTANDING_PAIRINGS) {
      rejectedCount += previewRecords.length - MAX_OUTSTANDING_PAIRINGS;
      previewRecords = previewRecords.slice(0, MAX_OUTSTANDING_PAIRINGS);
      issues.push('preview_record_overflow');
    }
    if (proofRecords.length > MAX_WRITES_PER_PAIRING) {
      rejectedCount += proofRecords.length - MAX_WRITES_PER_PAIRING;
      proofRecords = proofRecords.slice(0, MAX_WRITES_PER_PAIRING);
      issues.push('write_attempt_overflow');
    }
    const sessionIds = new Set(allProofRecords
      .map((record) => record.session_id)
      .filter((sessionId) => sessionId !== null));
    if (allProofRecords.some((record) => record.session_identity === 'absent')) issues.push('session_missing');
    if (allProofRecords.some((record) => record.session_identity === 'unpublishable')) {
      issues.push('session_identity_unpublishable');
    }
    if (sessionIds.size > 1) issues.push('conflicting_sessions');
    const attempts = proofRecords.map((record) => record.pairing.write_attempt);
    if (new Set(attempts).size !== attempts.length) issues.push('duplicate_write_attempt');
    if (rejected.some((entry) => entry && entry.turn_id === turnId)) issues.push('rejected_write_record');

    const trace = traceRecords.length === 1 ? { ...traceRecords[0] } : null;
    const previews = previewRecords.map(_previewArtifact);
    const writes = proofRecords.map(_writeArtifact);
    if (!trace) issues.push(traceRecords.length === 0 ? 'trace_missing' : 'trace_ambiguous');
    if (writes.length === 0) issues.push('write_proof_missing');
    if (trace && trace.valid !== true) issues.push('trace_invalid');
    for (const preview of previews) {
      for (const issue of preview.issues) if (!issues.includes(issue)) issues.push(issue);
    }
    for (const write of writes) {
      for (const issue of write.issues) if (!issues.includes(issue)) issues.push(issue);
    }

    const joinStatus = trace && writes.length > 0
      ? 'joined'
      : (trace ? 'trace_only' : 'proof_only');
    turns.push({
      turn_id: turnId,
      join_status: joinStatus,
      trace,
      previews,
      writes,
      issues,
      reviewable: joinStatus === 'joined' && issues.length === 0 && writes.every((write) => write.reviewable),
    });
  }

  const reviewableTurns = turns.filter((turn) => turn.reviewable).length;
  const joinedTurns = turns.filter((turn) => turn.join_status === 'joined').length;
  const traceOnlyTurns = turns.filter((turn) => turn.join_status === 'trace_only').length;
  const proofOnlyTurns = turns.filter((turn) => turn.join_status === 'proof_only').length;
  const status = turns.length === 0
    ? 'empty'
    : (reviewableTurns === turns.length && rejectedCount === 0 ? 'complete' : 'partial');

  return {
    schema_version: SCHEMA_VERSION,
    status,
    summary: {
      traces_seen: traces.length,
      proofs_seen: proofs.length,
      joined_turns: joinedTurns,
      trace_only_turns: traceOnlyTurns,
      proof_only_turns: proofOnlyTurns,
      reviewable_turns: reviewableTurns,
      rejected_records: rejectedCount,
    },
    turns,
  };
}

function formatTurnWriteArtifact(artifact, opts = {}) {
  const a = _isPlainObject(artifact) ? artifact : buildTurnWriteArtifact('');
  const safeSource = sanitizeArtifactSource(opts.source);
  const source = safeSource ? ` (from ${safeSource})` : '';
  const lines = [`Atlas turn/write review artifact${source}`];
  if (a.status === 'empty') {
    lines.push('No joined turn/write evidence was found. Nothing is reviewable.');
    return lines.join('\n');
  }

  const summary = a.summary || {};
  lines.push(`${summary.reviewable_turns || 0} reviewable turn(s); ${summary.joined_turns || 0} joined turn(s).`);
  lines.push(`Status: ${a.status}. Rejected records: ${summary.rejected_records || 0}.`);
  for (const turn of a.turns || []) {
    lines.push(`- ${turn.turn_id}: ${turn.reviewable ? 'reviewable' : 'NOT REVIEWABLE'} (${turn.join_status})`);
    for (const write of turn.writes || []) {
      lines.push(`  attempt ${write.pairing.write_attempt}: authorization=${write.authorization}; seal=${write.seal.state}; closeout=${write.closeout.state}`);
    }
    if (turn.issues && turn.issues.length) lines.push(`  issues: ${turn.issues.join(', ')}`);
  }
  return lines.join('\n');
}

// The CLI's source label is a filename the operator chose, so it is free text on the same footing
// as `session_id` and the trace metadata: it can carry workout prose, a Sheet range, or a private
// path. Publish only a bare, opaque basename — directory components are dropped rather than
// reflected — and omit the label entirely when it is not one.
const OPAQUE_SOURCE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sanitizeArtifactSource(value) {
  if (!_isBoundedString(value, 512) || _containsCapability(value) || /[\r\n\0]/.test(value)) return null;
  const basename = value.split(/[/\\]/).pop();
  return OPAQUE_SOURCE_LABEL.test(basename) ? basename : null;
}

module.exports = {
  INTERACTION_TRACE_MARKER,
  TURN_WRITE_PROOF_MARKER,
  SCHEMA_VERSION,
  MAX_INPUT_LINES,
  MAX_RECORDS,
  MAX_WRITES_PER_TURN: MAX_WRITES_PER_PAIRING,
  parseTurnWriteLines,
  buildTurnWriteArtifact,
  formatTurnWriteArtifact,
  sanitizeArtifactSource,
};
