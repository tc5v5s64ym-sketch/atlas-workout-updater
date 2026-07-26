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
  isWellFormedTurnId,
} = require('./turnCorrelation');
const { STAGES, STAGE_STATUSES } = require('./interactionTrace');

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
const SAFE_STATE_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
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

function _containsCapability(value) {
  return typeof value === 'string' && (PAIRING_TOKEN_RE.test(value) || FINGERPRINT_RE.test(value));
}

function _sanitizeTrace(record) {
  if (!_isPlainObject(record) || !isWellFormedTurnId(record.turn_id)) return null;
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
    : (_isBoundedString(record.intent_type, 64) && !_containsCapability(record.intent_type)
      ? record.intent_type
      : null);
  const source = record.source === null || record.source === undefined
    ? null
    : (_isBoundedString(record.source, 64) && !_containsCapability(record.source)
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
  if (value === null) return true;
  if (BOOLEAN_PROOF_KEYS.has(key)) return typeof value === 'boolean';
  if (NUMBER_PROOF_KEYS.has(key)) return Number.isSafeInteger(value) && value >= 0;
  if (key === 'sheet_write') return SHEET_WRITE_STATES.has(value);
  if (key === 'idempotency_status') return IDEMPOTENCY_STATES.has(value);
  if (key === 'ledger_seal_reason') return typeof value === 'string' && SAFE_STATE_TOKEN.test(value);
  if (key === 'session_plans_closeout_status') return CLOSEOUT_STATES.has(value);
  if (key === 'session_plans_closeout_plan_version') return PLAN_VERSION_RE.test(value);
  return _isBoundedString(value) && !_containsCapability(value);
}

function _sanitizeProof(record) {
  if (!_isPlainObject(record) || record.schema_version !== 1 || !isWellFormedTurnId(record.turn_id)) return null;
  if (record.session_id !== null
    && (!_isBoundedString(record.session_id, MAX_SESSION_ID_LENGTH) || _containsCapability(record.session_id))) {
    return null;
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
    session_id: record.session_id,
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

    const turnId = _isPlainObject(source) && isWellFormedTurnId(source.turn_id)
      ? String(source.turn_id).trim()
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
  const sheetWritten = typeof proof.ledger_seal_sheet_written === 'boolean'
    ? proof.ledger_seal_sheet_written
    : (typeof proof.sheet_written === 'boolean' ? proof.sheet_written : null);
  const sealedOk = typeof proof.ledger_seal_sealed_ok === 'boolean'
    ? proof.ledger_seal_sealed_ok
    : null;
  const sealed = typeof proof.ledger_seal_sealed === 'number' ? proof.ledger_seal_sealed : null;
  const alreadySealed = typeof proof.ledger_seal_already_sealed === 'number'
    ? proof.ledger_seal_already_sealed
    : null;

  let state = 'absent';
  if (sealedOk === false && sheetWritten === true) state = 'seal_proof_mismatch';
  else if (sealedOk === false) state = 'failed';
  else if (sealedOk === true && sheetWritten === true && sealed > 0) state = 'sealed';
  else if (sealedOk === true && sheetWritten === true) state = 'indeterminate';
  else if (sealedOk === true && sheetWritten === false && sealed === 0 && alreadySealed > 0) state = 'already_sealed';
  else if (sealedOk === true) state = 'verified_no_new_seal';
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
  if (status === 'written' && captured === true && written > 0) {
    state = planVersionWithheld || !hasPlanVersion || proof[planVersionKey] === null
      ? 'written_unidentified'
      : 'written';
  } else if (status === 'skipped' && captured === true) {
    state = planVersionWithheld || !hasPlanVersion || proof[planVersionKey] === null
      ? 'already_captured_unidentified'
      : 'already_captured';
  }
  else if (status === 'error' || status === 'tab_missing' || status === 'header_mismatch') state = 'failed';
  else if (status === 'disabled') state = 'disabled';
  else if (status === 'no_plan') state = 'no_plan';
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

function _proofState(proof, seal, closeout) {
  if (proof.sheet_write === 'unverified') return 'unverified';
  if (proof.sheet_write === 'partial') return 'partial';
  if (proof.sheet_write === 'skipped_duplicate_in_progress') return 'idempotency_in_progress';

  // The explicit W1 no-write tuple outranks incidental response bookkeeping such as
  // effortWritten:true on a preview (which means an effort row was formatted, not appended).
  if (proof.no_write_confirmed === true && proof.sheet_written === false) {
    return 'no_write_confirmed';
  }

  const positiveWrite = proof.sheet_written === true
    || proof.sheet_write === 'success'
    || proof.effortWritten === true
    || (typeof proof.rows_appended === 'number' && proof.rows_appended > 0)
    || (typeof proof.log_rows_written === 'number' && proof.log_rows_written > 0)
    || (typeof proof.effort_rows_written === 'number' && proof.effort_rows_written > 0)
    || seal.new_seal_write
    || closeout.state === 'written';
  if (positiveWrite) return 'write_confirmed';

  if (proof.duplicate_write === true
    || proof.sheet_write === 'skipped_duplicate'
    || (typeof proof.skipped_duplicates === 'number' && proof.skipped_duplicates > 0)) {
    return 'idempotent_no_write';
  }
  return 'insufficient';
}

function _writeArtifact(record) {
  const authorization = _authorization(record.pairing);
  const seal = _sealSummary(record.proof, record.withheld_evidence);
  const closeout = _closeoutSummary(record.proof, record.withheld_evidence);
  const proofState = _proofState(record.proof, seal, closeout);
  const issues = [];
  if (authorization !== 'preview_payload_bound') issues.push('authorization_unbound');
  if (proofState === 'insufficient') issues.push('write_proof_insufficient');
  else if (proofState === 'unverified') issues.push('write_proof_unverified');
  else if (proofState === 'partial') issues.push('write_proof_partial');
  else if (proofState === 'idempotency_in_progress') issues.push('write_proof_in_progress');
  if (record.withheld_evidence.length > 0) issues.push('evidence_withheld');
  if (seal.state === 'seal_proof_mismatch') issues.push('seal_proof_mismatch');
  else if (seal.state === 'failed' || seal.state === 'withheld' || seal.state === 'indeterminate') {
    issues.push('seal_not_verified');
  }
  if (closeout.state === 'failed'
    || closeout.state === 'written_unidentified'
    || closeout.state === 'already_captured_unidentified'
    || closeout.state === 'withheld') {
    issues.push('closeout_not_reviewable');
  }

  return {
    session_id: record.session_id,
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
  const proofState = _proofState(record.proof, seal, closeout);
  const issues = [];
  if (proofState !== 'no_write_confirmed') issues.push('preview_no_write_proof_missing');
  if (record.withheld_evidence.length > 0) issues.push('evidence_withheld');
  return {
    session_id: record.session_id,
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

function sanitizeArtifactSource(value) {
  if (!_isBoundedString(value, 512) || _containsCapability(value) || /[\r\n\0]/.test(value)) return null;
  return value;
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
