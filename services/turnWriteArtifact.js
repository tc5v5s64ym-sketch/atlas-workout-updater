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
// A LINE cap does not bound memory, and this consumer advertised one as though it did.
// `text.split()` materializes every line of the input before MAX_INPUT_LINES is applied, so a
// multi-million-line capture — or a single pathological line — could exhaust memory or kill the
// process before the advertised limit ever took effect, producing no artifact at all rather than
// the intended partial one. The character bound is applied BEFORE the split, and generously: at
// ~512 bytes per record it admits far more than MAX_INPUT_LINES worth of real records, so it
// truncates only inputs the line cap was already going to refuse.
const MAX_INPUT_CHARS = 8_000_000;
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
// `no_ledger:true` and `already_sealed:0`. `write_disabled` is deliberately NOT a member: it names
// why a run was DRY, not what the ledger read found, so it can never substantiate a live seal.
const VERIFIED_EMPTY_SEAL_REASONS = new Set(['tab_missing', 'no_rows']);
// …and the dry reason a PROJECTED `ledger_seal` can actually carry. On its confirmed-empty
// branches the tab probe and the row read both SUCCEEDED and found nothing to stamp, so the
// outcome is verified even though the lane never wrote — a distinct state from
// `verified_no_new_seal`, which is the same finding proven against a lane that COULD have written.
//
// `test_mode` is deliberately EXCLUDED even though `sealCloseout` can emit it, because no producer
// can put it here. `sealCloseout` takes `test_mode` from its opts, and the only two calls whose
// result becomes `ledger_seal` pass `{}` (index.js:3257 duplicate branch, :3404 success path), so
// their dry reason is always `write_disabled`. The one call that does pass `{test_mode:true}`
// (:3093) is assigned to `ledger_seal_preview`, which stays on the preview HTTP body and is not in
// this consumer's projected key set at all. Admitting `test_mode` would therefore accept a tuple
// that is internally consistent but IMPOSSIBLE — a live write (`test_mode:false`) whose seal claims
// it was skipped for a dry run — and let it reach `verified_empty_dry_run` and `complete`. That is
// the fabricated-record class this consumer exists to reject (Codex P2, this PR).
const DRY_RUN_SEAL_REASONS = new Set(['write_disabled']);
// Routes whose live success proof is a PER-TAB append: one value per contract column, a positive
// row count per tab, and the append range Google returned for it. `/api/complete-workout` verifies
// those exact row counts against the ranges before returning, exactly as `/api/log-workout` does,
// so both are held to the same range-backed tuple rather than a generic positive scalar.
const PER_TAB_APPEND_ROUTES = new Set(['/api/log-workout', '/api/complete-workout']);
// The ONLY route that emits either sidecar envelope. `ledger_seal` is attached at index.js:3258,
// 3261 and 3423; `session_plans_closeout` at 3255 and 3424. `/api/complete-workout`,
// `/api/log-modality` and `/api/bodyweight` never attach either one, so seal or closeout evidence
// arriving on those routes did not come from a producer — pairing the two envelopes does not make
// such a record real, it only makes it internally consistent.
const SIDECAR_EVIDENCE_ROUTES = new Set(['/api/log-workout']);
// …and only on the two BODIES that attach them. `/api/log-workout` attaches a sidecar pair on the
// normal success (index.js:3413-3426) and on the correlated all-rows-duplicate branch
// (index.js:3238-3264) — nowhere else. Never on a preview, and never on `blocked_schema_drift`,
// which the shared header-drift guard raises at index.js:456 long before a seal is attempted. The
// route alone is not the producer's condition: a `blocked_schema_drift` record carrying a fresh
// seal reached `write_confirmed` with no issues, because a positive seal is a positive write.
const SIDECAR_EVIDENCE_STATES = new Set(['success', 'skipped_duplicate']);
// Log_Cleaned / Effort row evidence can only come from a route that appends to those tabs.
// `/api/log-modality` writes to Modality_Log and `/api/bodyweight` to Bodyweight, and neither
// success body carries a row count at all (index.js:1407-1423, 2024-2036). A generic-route record
// claiming Log rows is fabricated, and republishing the number would have the artifact report a
// write to a tab that route never touched — so the fields are dropped, not merely ignored.
// A producer fact is a CONJUNCTION — route AND state AND write attempt AND branch — and enforcing
// one conjunct looks exactly like enforcing all of them. Five consecutive review rounds were that
// same mistake, each one dimension narrower than the last. So the gate is a per-key map derived by
// reading every emitter, not a special case for whichever field was last flagged.
//
// `allowed(route, state, attempt)` answers: can THIS body have carried THIS field? A key with no entry is
// unconstrained — deliberately, because inventing a constraint from a pattern rather than from an
// emitter is how a false negative gets created, and on this consumer a wrongly-dropped field costs
// real write evidence.
const IMPOSSIBLE_FIELD_RULES = Object.freeze({
  // Log_Cleaned / Effort row evidence can only come from a route that appends to those tabs.
  // `/api/log-modality` writes to Modality_Log and `/api/bodyweight` to Bodyweight, and neither
  // success body carries a row count at all (index.js:1407-1423, 2024-2036).
  log_rows_written: (route) => PER_TAB_APPEND_ROUTES.has(route),
  effort_rows_written: (route) => PER_TAB_APPEND_ROUTES.has(route),
  // NO production emitter anywhere in the repository. It survives only in the PROOF_KEYS whitelist
  // (turnCorrelation.js:188), so a record carrying it is fabricated by definition — and it was a
  // term in `anyPositiveWriteSignal`, meaning that signal had a branch only fabricated input could
  // ever reach.
  rows_appended: () => false,
  // `/api/log-workout` only: the all-rows-duplicate body (index.js:3246) and the success body
  // (index.js:3427).
  skipped_duplicates: (route) => route === '/api/log-workout',
  // `/api/log-workout` only (index.js:3130 preview, 3363 partial, 3418 success). Response
  // bookkeeping about formatting an Effort row, which no other route does.
  effortWritten: (route, state) => route === '/api/log-workout' && EFFORT_WRITTEN_STATES.has(state),
  // Emitted by every write body EXCEPT `/api/log-workout`'s success, which omits it entirely
  // (index.js:3413-3421) — the same asymmetry the main-write predicate already relies on.
  sheet_written: (route, state) => !(route === '/api/log-workout' && state === 'success'),
  // NO top-level emitter. The real flag is nested inside the seal envelope and reaches this
  // consumer only as the projected `ledger_seal_dry_run`; a bare `dry_run` is a second
  // `rows_appended` — whitelisted upstream, produced by nothing.
  dry_run: () => false,
  // Emitted only beside `sheet_write:'skipped'` — the four preview/dry-run bodies (index.js:1367,
  // 1975, 3129, 2750) — and beside `blocked_schema_drift` (index.js:457-458). A live success,
  // partial, unverified or duplicate body never carries it.
  no_write_confirmed: (route, state) => state === 'skipped' || state === 'blocked_schema_drift',
  // Set inside `if (idempotency.enabled)` on live bodies only. A preview registers no write, so it
  // carries neither.
  duplicate_write: (route, state, attempt) => attempt > 0,
  idempotency_status: (route, state, attempt) => attempt > 0,
});
// State/attempt constraints for keys whose route allowance is not the whole conjunction. Kept
// beside the map rather than folded into it so each predicate stays a single readable producer
// fact: `effortWritten` appears on /api/log-workout's preview, partial and success bodies
// (index.js:3130, 3363, 3418) and NOT on the correlated all-rows-duplicate body, whose fields are
// listed exhaustively at index.js:3238-3247.
const EFFORT_WRITTEN_STATES = new Set(['skipped', 'partial', 'success']);
const NULLABLE_PROOF_KEYS = new Set([
  'ledger_seal_updated_cells',
  // `sealCloseout` returns `would_seal:null` when the ledger is unreadable while the seal lane is
  // in dry-run posture (sessionPlanSetsStore.js:256-258, 271-273), and the projection carries the
  // scalar. Rejecting it discarded the WHOLE record — including a committed main Log/Effort proof —
  // so this is a false negative, not a false green: the seal itself still fails closed below.
  'ledger_seal_would_seal',
  'session_plans_closeout_plan_version',
]);
const TRACE_INTENT_TYPES = new Set(['set', 'block', 'plan', 'coach_chat', 'coach_ask']);
const TRACE_SOURCES = new Set(['coach_message', 'coach_chat', 'coach_ask']);
const SAFE_STATE_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
// `session_id` is never published (see `_writeArtifact`), so it needs no shape at all — it is
// retained ONLY for the internal cross-session comparison. An earlier version gated it on an
// "opaque identifier" character class and nulled anything else as `unpublishable`. That was a false
// negative of my own making: a producer-valid id containing a space — which the contract permits,
// since it requires only a bounded trimmed string — was discarded, its turn marked non-reviewable,
// and two DIFFERENT such ids could no longer raise `conflicting_sessions`, which is the one thing
// the value is kept for. Bounded and capability-free is the whole requirement.
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
  if (!_isBoundedString(value, 40) || !ISO_8601.test(value) || Number.isNaN(Date.parse(value))) return false;
  // The regex and `Date.parse` together are NOT enough. `Date.parse` NORMALIZES an out-of-range day
  // inside an in-range month rather than refusing it — `2026-02-30T09:00:00.000Z` parses cleanly and
  // becomes March 2 — so without this the consumer accepts a timestamp naming a day no calendar has
  // and then reports a different day than the record states. Month 13 and hour 25 are already NaN;
  // the day of month was the one field that normalized silently.
  //
  // Deliberately NOT a `toISOString()` round-trip, which would be the obvious tightening and a false
  // negative: the trace contract accepts the no-millisecond form (services/interactionTrace.js:97)
  // and `recorded_at` passes a caller-supplied string straight through (turnCorrelation.js:944), so
  // a round-trip would discard records the producers really emit — and on this consumer a discarded
  // record takes its committed write proof with it (rule 5). Validate the calendar day only, which
  // is format- and offset-independent.
  //
  // `Date.UTC` is avoided for the month length because it maps years 0-99 to 1900-1999, which would
  // apply the wrong leap rule to a four-digit year like 0050.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
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
  // not the absent field that W2 reads as a live write). The genuinely nullable keys are listed in
  // NULLABLE_PROOF_KEYS, each justified against its emitter there; rejecting any of them discards a
  // real record. Keep that set and the published contract in
  // docs/verification/ISSUE_1165_SLICE_3_ARTIFACT.md in step — this comment previously named only
  // two keys after a third was added, and a stale count here is what invites a later "tightening"
  // to reintroduce a whole-record false negative.
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
    // Bounded and capability-free, AND already trimmed. The producer stores
    // `_isNonEmptyString(p.sessionId) ? String(p.sessionId).trim() : null` (turnCorrelation.js:942),
    // so it never emits a padded id and never emits a whitespace-only one — that becomes `null`,
    // which this consumer reads as `absent` and reports via `session_missing`. Accepting `'   '`
    // here let malformed log input present a producer-impossible id as `present` and sail through
    // as a complete artifact, bypassing the very issue the null case exists to raise.
    if (!_isBoundedString(sessionId, MAX_SESSION_ID_LENGTH)
      || _containsCapability(sessionId)
      || sessionId !== sessionId.trim()
      || sessionId.trim().length === 0) return null;
    sessionIdentity = 'present';
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
    // The app SENDS an unquoted range (`${tabName}!A1`, sheets.js:123), but Google RETURNS
    // canonical A1 in `updatedRange`, which single-quotes any sheet name that needs it — a space,
    // a leading digit, and so on — and doubles an embedded apostrophe. Accept either form for the
    // configured name. This cannot create a false green: the exact tab, the exact contract column
    // span, and the exact row count are all still required; it only tolerates Google's own quoting,
    // which otherwise strips the range evidence off a genuine append.
    const bareTab = _escapeForRegExp(expectedTab);
    const quotedTab = _escapeForRegExp(`'${String(expectedTab).replace(/'/g, "''")}'`);
    const match = new RegExp(`^(?:${bareTab}|${quotedTab})!A([1-9]\\d{0,6}):${expectedLastColumn}([1-9]\\d{0,6})$`).exec(value);
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

  // Drop Log/Effort tab evidence a generic route cannot have produced, and remember that it was
  // there. Retained as a flag rather than a rejection: the record's own join and its genuine
  // main-write proof stay reviewable, but nothing fabricated is republished.
  const impossibleFields = [];
  for (const [key, allowed] of Object.entries(IMPOSSIBLE_FIELD_RULES)) {
    if (!Object.prototype.hasOwnProperty.call(proof, key)) continue;
    if (allowed(record.route, proof.sheet_write, pairing.write_attempt)) continue;
    impossibleFields.push(key);
    delete proof[key];
  }
  if (!PER_TAB_APPEND_ROUTES.has(record.route)) {
    rangeEvidence.log = false;
    rangeEvidence.effort = false;
  }

  if (!Array.isArray(record.withheld_evidence)) return null;
  const withheldEvidence = [];
  const seenWithheld = new Set();
  for (const key of record.withheld_evidence) {
    if (!ALLOWED_WITHHELD_KEYS.has(key) || seenWithheld.has(key)) return null;
    if (Object.prototype.hasOwnProperty.call(proof, key)) return null;
    seenWithheld.add(key);
    withheldEvidence.push(key);
  }

  // All FOUR preview correlation producers emit the same body:
  // `test_mode:true, sheet_write:'skipped', sheet_written:false, no_write_confirmed:true`.
  //   `/api/log-modality`     index.js:1372  (isPreview: true)
  //   `/api/bodyweight`       index.js:1978  (isPreview: true)
  //   `/api/complete-workout` index.js:2784  (isPreview: testMode — a VARIABLE, and its dry-run
  //                                          block at :2748-2751 sets no_write_confirmed:true and
  //                                          sheet_write:'skipped' on the correlated body)
  //   `/api/log-workout`      index.js:3152  (isPreview: true)
  // Grepping for the literal `isPreview: true` finds only three of them and is how this inventory
  // was first written down wrong — the tuple below was right anyway, but the rationale was not.
  //
  // `sheet_write` is part of that tuple, so an attempt-zero record without it — or carrying another
  // state — is a shape no producer emits, not a lost field, and is rejected like any other
  // malformed record.
  if (pairing.write_attempt === 0
    && (pairing.established_at_preview !== true
      || pairing.payload_bound !== false
      || proof.test_mode !== true
      || proof.sheet_write !== 'skipped'
      || proof.sheet_written !== false
      || proof.no_write_confirmed !== true)) {
    return null;
  }

  // …and the CONVERSE, which is the same producer fact read the other way. `write_attempt` is
  // `rec.writeIds.indexOf(writeId) + 1` (turnCorrelation.js:551), so a positive attempt exists only
  // where a LIVE write registered a write_id, while the tuple above is emitted solely through
  // `isPreview`, which yields attempt 0. A record carrying the complete preview tuple at a positive
  // attempt is a shape no producer can emit — and it was reaching `no_write_confirmed` with no
  // issues and an overall `complete` status: a fabricated non-write presented as a reviewable write.
  //
  // Rejected rather than flagged, matching the attempt-zero gate directly above: this is one
  // producer fact with two directions, and the two directions should fail the same way.
  if (pairing.write_attempt > 0
    && proof.test_mode === true
    && proof.sheet_write === 'skipped'
    && proof.sheet_written === false
    && proof.no_write_confirmed === true) {
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
    impossible_fields: impossibleFields,
  };
}

function _emptyParsed() {
  return {
    traces: [],
    proofs: [],
    rejected: [],
    rejected_count: 0,
    rejected_turn_ids: new Set(),
    unattributed_rejections: 0,
  };
}

function parseTurnWriteLines(text, opts = {}) {
  const parsed = _emptyParsed();
  if (typeof text !== 'string' || text.length === 0) return parsed;

  const reject = (reason, marker, lineNumber, turnId = null) => {
    parsed.rejected_count += 1;
    // A loss that cannot name its turn must not be filed only against the whole run. Truncation,
    // the record cap and a malformed line all discard evidence that MIGHT have belonged to any
    // turn present, so every included turn has to fail closed — otherwise a turn keeps
    // `reviewable:true` while some of its own evidence is missing, which is the overstatement this
    // module exists to prevent. (Fixing attribution for rejections that DO carry a turn_id and
    // stopping there was the same blast-radius miss one round earlier.)
    if (turnId === null) parsed.unattributed_rejections += 1;
    if (parsed.rejected.length < MAX_REJECTIONS) {
      parsed.rejected.push({ reason, marker, line: lineNumber, turn_id: turnId });
    } else if (turnId !== null) {
      // The DETAIL list is capped; the attribution must not be. Past the cap a rejected record
      // used to lose its turn_id, so `rejected.some(...)` could no longer fail that turn closed and
      // it reported `reviewable:true` with no issues while the global status said `partial`.
      parsed.rejected_turn_ids.add(turnId);
    }
  };

  // Truncate at a line boundary before splitting, and REPORT it: a silent cut would be a partial
  // artifact presented as a whole one, which is the failure this module exists to prevent.
  // A caller that bounded its own READ must say so. Character length cannot detect it: a byte
  // ceiling on a multibyte capture stops short of EOF while decoding to FEWER than MAX_INPUT_CHARS
  // characters, so the check below never fires and a truncated input reports `complete` with zero
  // rejections — a partial artifact presented as a whole one, which is the one thing this module
  // exists to prevent.
  if (opts.truncated === true) reject('input_size_limit', null, 0);

  let bounded = text;
  if (text.length > MAX_INPUT_CHARS) {
    const cut = text.lastIndexOf('\n', MAX_INPUT_CHARS);
    bounded = text.slice(0, cut > 0 ? cut : MAX_INPUT_CHARS);
    reject('input_size_limit', null, 0);
  }

  const lines = bounded.split(/\r?\n/);
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
  // Verified empty DRY run: the seal lane was owner-disabled (or the caller asked for a dry run)
  // AND the ledger read succeeded and confirmed nothing to stamp. The producer's COMPLETE dry
  // tuple is required, exactly as every positive state above requires its own — absent still means
  // unknown here, so a seal that merely omits `sealed_ok` never reaches this branch.
  //
  // `would_seal === 0` is the load-bearing discriminator, and the only field that separates this
  // from the dry run that found rows genuinely PENDING a stamp
  // (services/sessionPlanSetsStore.js:321). That one is NOT verified: the rows are unsealed and the
  // lane declined to seal them. `sealed === null` is required for the same reason — the dry path
  // never emits a stamp count, so a present one is not this outcome.
  else if (sealedOk === true
    && sheetWritten === false
    && proof.ledger_seal_no_write_confirmed === true
    && proof.ledger_seal_dry_run === true
    && proof.ledger_seal_would_seal === 0
    && sealed === null
    && alreadySealed === 0
    && proof.ledger_seal_no_ledger === true
    && DRY_RUN_SEAL_REASONS.has(proof.ledger_seal_reason)) {
    state = 'verified_empty_dry_run';
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
  const claimsSuccess = proof.sheet_write === 'success';
  const logRowsWritten = typeof proof.log_rows_written === 'number' && proof.log_rows_written > 0;
  const effortRowsWritten = typeof proof.effort_rows_written === 'number' && proof.effort_rows_written > 0;
  // Every positive tab count must carry its OWN matching range. One range-backed tab must never
  // substantiate the other tab's unbacked count on the same response.
  const rangeBackedLogWorkoutWrite = (logRowsWritten || effortRowsWritten)
    && (!logRowsWritten || rangeEvidence.log === true)
    && (!effortRowsWritten || rangeEvidence.effort === true);
  const isPerTabAppend = PER_TAB_APPEND_ROUTES.has(route);
  // BOTH per-tab success bodies emit BOTH counts as numbers on every live write:
  // `/api/complete-workout` at index.js:2723 (log — an explicit 0 on an effort-only completion)
  // and :2745 (effort); `/api/log-workout` at index.js:3416-3417. So an ABSENT count means the
  // projection lost part of the producer tuple, NOT that zero rows were intended. Without this,
  // a missing count vacuously satisfies the "every positive count carries its range" clauses
  // below and a truncated record reads as a confirmed write.
  const hasBothRowCounts = Number.isSafeInteger(proof.log_rows_written)
    && proof.log_rows_written >= 0
    && Number.isSafeInteger(proof.effort_rows_written)
    && proof.effort_rows_written >= 0;
  // `/api/complete-workout` appends Effort UNCONDITIONALLY (index.js:2585) and gates success on
  // `effort_rows_written === 1` plus an Effort range (index.js:2643), so a log-only success is
  // unreachable there. `/api/log-workout` has no such requirement — an effort-less log append is
  // its ordinary shape.
  // `sheet_written` is required on complete-workout and ONLY there: that route emits
  // `sheet_written: !testMode && effortWritten` on every success (index.js:2721) and the field is
  // in PROOF_KEYS, so absence is a lost projection field rather than a negative. `/api/log-workout`
  // emits no `sheet_written` at all on its success body (index.js:3413-3421), so requiring it there
  // would reject that route's ordinary live success — this tightening must not be generalized.
  const perTabWrite = hasBothRowCounts && (route === '/api/complete-workout'
    ? (proof.sheet_written === true
      && proof.effort_rows_written === 1
      && rangeEvidence.effort === true
      && (!logRowsWritten || rangeEvidence.log === true))
    : rangeBackedLogWorkoutWrite);
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
  // All four success producers emit `test_mode` explicitly — index.js:1409, 2026 and 3419 as a
  // literal false, and 2719 as `testMode`, which a success implies is false because :2722 sends
  // 'skipped' otherwise. So an ABSENT flag on a claimed success is a lost tuple member, not a live
  // write to be assumed: absent means unknown here as everywhere else.
  // The live-success IDEMPOTENCY tuple. All four write routes REFUSE an append without a
  // `write_id` (index.js:1382, 1988, 2507, 3160), so `beginWrite` always returns `enabled:true`
  // on a live write and every success body sets `duplicate_write:false` +
  // `idempotency_status:'completed'` (index.js:1417-1420, 2030-2033, 2771-2772, 3440-3443). A
  // replay never reaches `'success'` — it returns a skipped_duplicate body instead. So on a
  // claimed success these are producer-tuple members like any other: absent means unknown, and
  // `duplicate_write:true` or a non-completed status is impossible outright.
  //
  // `write_id` itself is deliberately NOT required: it is excluded from the published proof keys
  // as client-controlled free text, so it never reaches this consumer and requiring it would
  // reject every real record.
  const liveIdempotencyTuple = proof.duplicate_write === false
    && proof.idempotency_status === 'completed';
  const mainWrite = claimsSuccess
    && proof.test_mode === false
    && liveIdempotencyTuple
    && (isPerTabAppend ? perTabWrite : genericMainWrite);
  const positiveWrite = mainWrite
    || seal.new_seal_write
    || closeout.state === 'written';
  // The all-rows-duplicate producer (index.js:3237-3267) always emits this whole tuple, and the
  // SIDECAR GATE is load-bearing: index.js:3276 correlates the branch only when a seal or closeout
  // envelope exists. It is an OR, matching the producer's own condition rather than the strictest
  // one that condition satisfies.
  const duplicateTupleHolds = proof.test_mode === false
    && proof.sheet_write === 'skipped_duplicate'
    && proof.sheet_written === false
    && proof.duplicate_write === true
    && proof.log_rows_written === 0
    && typeof proof.skipped_duplicates === 'number'
    && proof.skipped_duplicates > 0
    && proof.idempotency_status === 'completed'
    && typeof proof.closeout_fully_verified === 'boolean'
    && (seal.state !== 'absent' || closeout.state !== 'absent');

  // STATE-INDEPENDENT IMPOSSIBILITIES, diagnosed BEFORE any terminal-state classification.
  // These two tuples are impossible whatever `sheet_write` claims, so a corrupted record must not
  // be allowed to hide behind its own claimed state.
  //
  // `effortWritten` is intentionally excluded from the signal: on a preview it means an effort row
  // was formatted, not appended, and the explicit no-write tuple stays authoritative there.
  if (proof.no_write_confirmed === true
    && (positiveWrite || claimsSuccess || anyPositiveWriteSignal)) return 'contradictory';
  // A dry run appends nothing (W2), so ANY positive append signal beside it is impossible — not
  // merely unsubstantiated. The narrower `positiveWrite` missed `sheet_written:true` and bare
  // counts on a non-success dry run, because it needs a success claim this path never makes.
  if (proof.test_mode === true
    && (positiveWrite || claimsSuccess || anyPositiveWriteSignal)) return 'contradictory';

  // A third state-independent impossibility, this one PRODUCER-SPECIFIC rather than broad.
  // `partial` (index.js:2605-2606, 3356-3366) and `unverified` (:2645-2658) both report
  // `sheet_written:true` beside their committed append evidence — the rows really are on the sheet,
  // which is exactly what makes those states worth reviewing. So `sheet_written:false` beside a
  // positive count cannot be either of them.
  //
  // Scoped to those two states ON PURPOSE, and they are the only producible ones with this shape.
  // The scoping was originally justified by the in-progress duplicate, on the grounds that it sets
  // `sheet_written:false` while spreading the original's counts. That justification was wrong: all
  // four `skipped_duplicate_in_progress` emitters (index.js:2005, 2527, 3179, 3538) return from the
  // early idempotency branch BEFORE any `recordTurnWriteProof` call, so the state never reaches
  // this consumer at all. The scope stands on `partial` and `unverified` alone, which genuinely do
  // arrive carrying `sheet_written:true` and committed counts.
  if ((proof.sheet_write === 'partial' || proof.sheet_write === 'unverified')
    && proof.sheet_written === false
    && (logRowsWritten || effortRowsWritten
      || (typeof proof.rows_appended === 'number' && proof.rows_appended > 0))) {
    return 'contradictory';
  }

  // Terminal states are classified only AFTER the impossibility checks above.
  if (proof.sheet_write === 'unverified') return 'unverified';
  if (proof.sheet_write === 'partial') return 'partial';
  if (proof.sheet_write === 'skipped_duplicate_in_progress') return 'idempotency_in_progress';

  // `/api/log-workout` has one live main-write success shape. A non-success state cannot use
  // generic row/sheet signals to bypass its range-backed W3 tuple, and an explicit false write
  // flag cannot coexist with a claimed range-backed success.
  // Both arms use `anyPositiveWriteSignal`, NOT the classification predicates: tightening what
  // COUNTS AS a write must never weaken what is DIAGNOSED as impossible. A success claiming
  // `sheet_written:false` beside real append evidence is a corrupted record however the route
  // classifies it, and stays `contradictory` even when it also fails the complete-tuple check —
  // otherwise the narrower predicate silently downgrades it to the milder `insufficient`.
  //
  // This arm stays BELOW the terminal returns on purpose: the genuine `partial` (index.js:3356-3367)
  // and `unverified` (index.js:2645-2659) bodies really do carry `sheet_written:true` with a
  // positive log count, so hoisting it would call every real one of those contradictory and discard
  // exactly the records that most need reviewing. (This rationale previously also cited the
  // in-progress duplicate, which cannot reach the consumer — see the note above. The two remaining
  // states carry it on their own.)
  if (proof.test_mode !== true
    && ((!claimsSuccess && anyPositiveWriteSignal)
      || (claimsSuccess && proof.sheet_written === false && anyPositiveWriteSignal))) {
    return 'contradictory';
  }

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
  // A duplicate-state record must substantiate ITSELF before its sidecar may confirm anything. A
  // positive seal is a positive write, so this return fired before the duplicate tuple was ever
  // reached: a `skipped_duplicate` record omitting the entire tuple still read as a complete,
  // reviewable confirmed write on the strength of its seal alone.
  if (proof.sheet_write === 'skipped_duplicate' && !duplicateTupleHolds) return 'insufficient';
  if (positiveWrite) return 'write_confirmed';

  // The all-rows-duplicate closeout path is the ONLY correlated duplicate producer — an ordinary
  // early replay is never recorded at all (index.js records this branch only when a seal or
  // closeout envelope exists). It emits the whole tuple, so no single duplicate or replay signal
  // may stand in for the others.
  // The SIDECAR GATE is load-bearing: index.js:3276 correlates this branch only when
  // `duplicateBody.ledger_seal || duplicateBody.session_plans_closeout` exists. Both are set
  // together inside the closeout_context block (:3253-3263, including its catch), which also sets
  // `closeout_fully_verified`, and :3265-3267 adds `idempotency_status:'completed'`. A bare
  // duplicate that wrote nothing is never recorded at all — so the minimal scalar tuple with no
  // sidecar evidence is producer-impossible, and it reached `idempotent_no_write` unchallenged
  // because ABSENT seal/closeout evidence raises no downstream issue of its own.
  //
  // The gate is an OR, matching the producer exactly rather than requiring both envelopes: a
  // projection that dropped one of them must not turn a real duplicate into an unreviewable one.
  if (duplicateTupleHolds) return 'idempotent_no_write';
  return 'insufficient';
}

// Producer-shape issues that apply to EVERY correlated record, preview or write. Shared rather
// than duplicated: the two builders drifting apart is exactly how a rule ends up enforced on one
// path and not its sibling.
function _producerShapeIssues(record, seal, closeout) {
  const issues = [];
  // Log/Effort tab evidence a generic route cannot have produced was dropped during sanitize;
  // report that it was there rather than letting the record read as an ordinary clean write.
  if (record.impossible_fields.length > 0) issues.push('impossible_fields_for_route');
  const hasSidecarEvidence = seal.state !== 'absent' || closeout.state !== 'absent';
  if (!SIDECAR_EVIDENCE_ROUTES.has(record.route) && hasSidecarEvidence) {
    issues.push('sidecar_evidence_impossible_for_route');
  } else if (hasSidecarEvidence
    && (record.pairing.write_attempt === 0
      || !SIDECAR_EVIDENCE_STATES.has(record.proof.sheet_write))) {
    // The route is necessary but not sufficient. Only the success body and the correlated
    // all-rows-duplicate body attach a sidecar pair, and neither is a preview. A record claiming a
    // fresh seal beside `blocked_schema_drift` reached `write_confirmed` with no issues at all,
    // because a positive seal counts as a positive write.
    issues.push('sidecar_evidence_impossible_for_state');
  }
  // The verdict cannot stand alone either: it is attached only INSIDE those sidecar blocks
  // (index.js:3259, 3262, 3425), so a record carrying it with neither envelope claims a closeout
  // was verified while naming nothing that was verified.
  if (record.proof.closeout_fully_verified !== undefined && !hasSidecarEvidence) {
    issues.push('closeout_verdict_unsupported');
  }
  return issues;
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
  // Seal evidence is REQUIRED wherever closeout evidence exists. Both correlated closeout branches
  // attach `ledger_seal` whenever they attach `session_plans_closeout` (index.js:3253-3263, and
  // 3399-3407 where the closeout is attached only inside `if (ledgerSeal)`), so a closeout with no
  // seal projection at all is lost producer evidence — and it is precisely the shape that would
  // conceal a failed or indeterminate seal behind a healthy-looking closeout. `withheld` is not
  // `absent`: a seal whose projection failed validation is already reported by `seal_not_verified`.
  if (closeout.state !== 'absent' && seal.state === 'absent') issues.push('seal_evidence_missing');
  // …and the CONVERSE, which the producer guarantees just as strongly. `/api/log-workout` is the
  // only route that emits `ledger_seal` at all (index.js:3258, 3261, 3423), and at every one of
  // those sites `session_plans_closeout` was ALREADY assigned from `recordCloseoutEvent` — which
  // always returns an object, so it is never falsy — before the seal was attempted: on the
  // duplicate branch unconditionally ahead of the try (:3252), and on the success path inside the
  // same `closeout_context` block (:3401). A seal with no closeout projection is therefore lost
  // producer evidence in exactly the way a closeout with no seal is, and it is the shape that
  // would let a truncated or fabricated seal-only record read as fully reviewable.
  //
  // Enforcing only the closeout-implies-seal direction was an asymmetry with no producer behind
  // it. The bidirectional fact was established while auditing fixtures and applied only to the
  // tests; this is the same rule reaching the consumer it was derived for.
  if (seal.state !== 'absent' && closeout.state === 'absent') issues.push('closeout_evidence_missing');
  // …and neither envelope belongs on a route that cannot produce one at all. Requiring the pair
  // together makes a fabricated record internally consistent; it does not make it producible. A
  // well-formed seal + closeout pair on `/api/bodyweight` satisfied every check above and reported
  // a turn complete with `seal.state === 'sealed'`.
  for (const issue of _producerShapeIssues(record, seal, closeout)) issues.push(issue);
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
    // The session id is NEVER published. `OPAQUE_SESSION_ID` proves only that a value has no
    // whitespace, `!` or `:` — it cannot prove the value is an identifier, because the producer
    // imposes no shape at all: the routes and the client require a bounded trimmed string and
    // nothing more. Compact workout text (`BenchPress225x5RIR2`) or a bare tab name passes that
    // character class, and publishing it put exactly the prose this consumer claims to withhold
    // into a deployment-log artifact. `session_identity` reports whether an id was recorded, the
    // canonical `turn_id` locates the turn, and cross-session contamination is still detected —
    // that comparison runs on the retained record, not on anything emitted.
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
  for (const issue of _producerShapeIssues(record, seal, closeout)) issues.push(issue);
  return {
    // Never published — see the note in `_writeArtifact`.
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

function buildTurnWriteArtifact(input, opts = {}) {
  const parsed = typeof input === 'string' ? parseTurnWriteLines(input, opts) : input;
  const safeParsed = _isPlainObject(parsed) ? parsed : _emptyParsed();
  const traces = Array.isArray(safeParsed.traces) ? safeParsed.traces : [];
  const proofs = Array.isArray(safeParsed.proofs) ? safeParsed.proofs : [];
  const rejected = Array.isArray(safeParsed.rejected) ? safeParsed.rejected : [];
  const rejectedTurnIds = safeParsed.rejected_turn_ids instanceof Set
    ? safeParsed.rejected_turn_ids
    : new Set();
  const unattributedRejections = Number.isInteger(safeParsed.unattributed_rejections)
    ? safeParsed.unattributed_rejections
    : 0;
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
    const previewRecords = allProofRecords.filter((record) => record.pairing.write_attempt === 0);
    let proofRecords = allProofRecords.filter((record) => record.pairing.write_attempt > 0);
    const issues = [];

    if (traceRecords.length > 1) issues.push('conflicting_traces');
    // NO cap on accumulated preview history. The two registry limits look alike but are not the
    // same kind of bound, and only one of them bounds what can be EMITTED:
    //   * `writeIds` REFUSES — `if (rec.writeIds.length >= MAX_WRITES_PER_PAIRING) return miss(...)`
    //     (turnCorrelation.js:836). A sixth correlated write attempt never happens, so a sixth
    //     write-proof record cannot exist and the cap below is a genuine impossibility check.
    //   * `pairings` EVICT — `while (rec.pairings.length > MAX_OUTSTANDING_PAIRINGS) shift()`
    //     (:790). A ninth preview IS accepted; only the oldest entry leaves memory, and its log
    //     line was emitted long before. MAX_OUTSTANDING_PAIRINGS is a concurrency/memory bound on
    //     the live registry, not a limit on a turn's emitted history.
    // Applying the concurrency cap here truncated genuine records and made a valid turn
    // permanently partial. Input volume is already bounded by MAX_INPUT_LINES and MAX_RECORDS.
    if (proofRecords.length > MAX_WRITES_PER_PAIRING) {
      rejectedCount += proofRecords.length - MAX_WRITES_PER_PAIRING;
      proofRecords = proofRecords.slice(0, MAX_WRITES_PER_PAIRING);
      issues.push('write_attempt_overflow');
    }
    const sessionIds = new Set(allProofRecords
      .map((record) => record.session_id)
      .filter((sessionId) => sessionId !== null));
    if (allProofRecords.some((record) => record.session_identity === 'absent')) issues.push('session_missing');
    if (sessionIds.size > 1) issues.push('conflicting_sessions');
    const attempts = proofRecords.map((record) => record.pairing.write_attempt);
    if (new Set(attempts).size !== attempts.length) issues.push('duplicate_write_attempt');
    if (rejected.some((entry) => entry && entry.turn_id === turnId)
      || rejectedTurnIds.has(turnId)) issues.push('rejected_write_record');
    if (unattributedRejections > 0) issues.push('evidence_loss_unattributed');

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

function formatTurnWriteArtifact(artifact) {
  const a = _isPlainObject(artifact) ? artifact : buildTurnWriteArtifact('');
  const lines = ['Atlas turn/write review artifact'];
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

// The CLI's source label is GONE, for the same reason the session id is. A filename has no
// identifier contract either, so a character class over it proves only the absence of certain
// punctuation — never that the value is safe to publish. `BenchPress225x5RIR2.jsonl` passed the old
// predicate and was echoed into both the JSON and the human output, recreating exactly the
// prose-disclosure this consumer had just removed one field earlier. There is nothing to validate
// against, so nothing is emitted.

module.exports = {
  INTERACTION_TRACE_MARKER,
  TURN_WRITE_PROOF_MARKER,
  SCHEMA_VERSION,
  MAX_INPUT_LINES,
  MAX_INPUT_CHARS,
  MAX_RECORDS,
  MAX_WRITES_PER_TURN: MAX_WRITES_PER_PAIRING,
  parseTurnWriteLines,
  buildTurnWriteArtifact,
  formatTurnWriteArtifact,
};
