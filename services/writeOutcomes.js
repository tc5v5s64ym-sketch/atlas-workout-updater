'use strict';

// #1780 — Durable operation identity: Write_Outcomes ledger (design-proof
// Part 2, owner-approved Candidate B, issue #1780 + #1764 comment 6897178508).
//
// WHY THIS EXISTS. The in-memory/file receipt store (services/idempotency.js)
// is best-effort: it dies on a free-plan restart, and a crashed process may
// hold a receipt only in memory. After such a loss the current schema leaves
// byte-identical surviving state for "never committed" and "saved then
// undone" — no in-schema signal can answer "was this save reverted?" (the
// design proof, paired-history captures). The ledger is the durable answer:
// one Write_Outcomes tab plus permanent per-generation named-range markers,
// committed atomically with the data in ONE spreadsheets.batchUpdate.
//
// PROTOCOL (one deliberate save or undo = one operation):
//   1. The client mints an operation ID BEFORE the first submission —
//      `atlas-op-v1:<cutover-UUIDv4>:<operation-UUIDv4>` — preserves it
//      client-side and reuses it on transport retries. A deliberate
//      identical second save gets a NEW ID. Same ID with a different
//      payload is refused.
//   2. The commit is ONE batchUpdate: the data mutations (appendCells /
//      deleteDimension) + one outcome row on Write_Outcomes + one
//      addNamedRange marker `atlas_receipt_commit_<G+1>`, where G is the
//      generation read at prepare time. Google applies a batchUpdate
//      atomically, so a failure commits nothing.
//   3. THE FENCE. Markers are permanent and their names are unique per
//      generation. A request prepared at generation G commits marker G+1;
//      if another commit landed first, that name already exists and Google
//      rejects the whole batch — the delayed request commits nothing and
//      must re-prepare. That is how a delayed request is rejected by the
//      permanent markers after an undo lands.
//   4. READ BACK before returning success: the outcome row must be present
//      with the matching payload hash, or the commit fails closed.
//   5. A retry reconciles from the ledger: the same ID with the same
//      payload replays the committed/reverted outcome without writing; a
//      different payload is refused; an undo of an already-reverted save
//      answers already-reverted without writing a second undo row.
//
// FAIL CLOSED, EVERYWHERE. Corrupt or missing outcomes, marker-range
// mismatch, header mismatch, workbook disagreement, oversized evidence —
// all refuse the commit and write nothing. Oversized evidence (over the
// 45,000-char prototype ceiling) is refused with a clear error; data and
// receipt are NEVER split into separate API calls to get around it.
//
// LIVE GATE (probe 7). The design proof ran against Google's documented
// contract, not a live mutation test. The named-range duplicate-name
// rejection and the batch atomicity this module relies on MUST be exercised
// against the SANDBOX workbook in E2E before the mechanism is called proven
// live; a sandbox failure of the fence contract stops the build. This module
// is fake-backed in-tree until that leg runs (coordinator/Dale route — this
// VM has no Sheets credentials).
//
// SCOPE. This module owns the ledger mechanism. Writer wiring (which routes
// mint and commit operation IDs) is a separate slice; the module takes the
// Sheets client as a parameter so tests drive the real sheets.js against a
// modeled fake.

const crypto = require('node:crypto');

const WRITE_OUTCOMES_TAB = 'Write_Outcomes';
const WRITE_OUTCOMES_HEADER = [
  'operation_id',
  'kind',
  'payload_hash',
  'target_operation_id',
  'evidence_json',
];
const OPERATION_ID_PREFIX = 'atlas-op-v1';
const MARKER_PREFIX = 'atlas_receipt_commit_';
const EVIDENCE_MAX_CHARS = 45000;
const OUTCOME_KINDS = new Set(['save', 'undo']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYLOAD_HASH_RE = /^[0-9a-f]{64}$/;
// The marker points at Write_Outcomes!A1: first row, first column, one cell.
const MARKER_GRID_RANGE = { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 };
const COMMIT_ATTEMPTS = 3;

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function ledgerError(code, message) {
  return new LedgerError(code, message);
}

// ── Operation IDs ─────────────────────────────────────────────────────────

function mintOperationId(cutoverId) {
  if (typeof cutoverId !== 'string' || !UUID_V4.test(cutoverId)) {
    throw ledgerError('cutover_unconfigured',
      'Write_Outcomes cutover is not configured: ATLAS_WRITE_OUTCOMES_CUTOVER_ID must be a UUIDv4. No operation ID can be minted without an epoch.');
  }
  return `${OPERATION_ID_PREFIX}:${cutoverId}:${crypto.randomUUID()}`;
}

function parseOperationId(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length !== 3) return null;
  if (parts[0] !== OPERATION_ID_PREFIX) return null;
  if (!UUID_V4.test(parts[1]) || !UUID_V4.test(parts[2])) return null;
  return { version: 'v1', cutoverId: parts[1], operationUuid: parts[2] };
}

function isOperationId(value) {
  return parseOperationId(value) !== null;
}

// The cutover epoch, supplied by the deploy sequence that creates the tab
// (ATLAS_WRITE_OUTCOMES_CUTOVER_ID). Fail closed when it is unset: minting
// an ID under no epoch would strand the operation outside every cutover.
function getCutoverId(env = process.env) {
  const cutoverId = env && typeof env.ATLAS_WRITE_OUTCOMES_CUTOVER_ID === 'string'
    ? env.ATLAS_WRITE_OUTCOMES_CUTOVER_ID.trim()
    : '';
  if (!UUID_V4.test(cutoverId)) {
    throw ledgerError('cutover_unconfigured',
      'Write_Outcomes cutover is not configured: ATLAS_WRITE_OUTCOMES_CUTOVER_ID must be a UUIDv4.');
  }
  return cutoverId;
}

// ── Payload hashing ───────────────────────────────────────────────────────

// JSON with sorted keys at every depth, so the same payload hashes the same
// no matter what order its keys were built in. undefined-valued keys are
// dropped and undefined array items read as null, matching JSON.stringify.
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function canonicalPayloadHash(payload) {
  if (payload === undefined) {
    throw ledgerError('payload_unhashable', 'A ledger payload is required: the same operation ID with a different payload must be refused, and there is no payload to compare.');
  }
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

// ── Outcome rows ──────────────────────────────────────────────────────────

function encodeOutcomeRow({ operationId, kind, payloadHash, targetOperationId, evidence }) {
  if (!isOperationId(operationId)) {
    throw ledgerError('operation_id_invalid', `Not an operation ID: ${String(operationId)}`);
  }
  if (!OUTCOME_KINDS.has(kind)) {
    throw ledgerError('outcome_kind_invalid', `Outcome kind must be 'save' or 'undo', got ${String(kind)}`);
  }
  if (typeof payloadHash !== 'string' || !PAYLOAD_HASH_RE.test(payloadHash)) {
    throw ledgerError('payload_hash_invalid', 'payload_hash must be a 64-hex SHA-256 digest.');
  }
  let target = '';
  if (targetOperationId !== null && targetOperationId !== undefined && targetOperationId !== '') {
    if (!isOperationId(targetOperationId)) {
      throw ledgerError('operation_id_invalid', `Not an operation ID: ${String(targetOperationId)}`);
    }
    target = targetOperationId;
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw ledgerError('evidence_invalid', 'Outcome evidence must be a JSON object.');
  }
  const evidenceJson = JSON.stringify(evidence);
  if (evidenceJson.length > EVIDENCE_MAX_CHARS) {
    throw ledgerError('evidence_oversize',
      `evidence_json is ${evidenceJson.length} chars, over the ${EVIDENCE_MAX_CHARS}-char ceiling. The save is refused rather than split across API calls; shorten the note or save and try again.`);
  }
  return [operationId, kind, payloadHash, target, evidenceJson];
}

function decodeOutcomeRow(row, sheetRow) {
  const corrupt = (detail) => ledgerError('outcome_row_corrupt',
    `Write_Outcomes row ${sheetRow} is corrupt: ${detail}. The ledger cannot be trusted, so every commit is refused.`);
  if (!Array.isArray(row) || row.length !== 5) throw corrupt(`expected 5 cells, got ${Array.isArray(row) ? row.length : typeof row}`);
  const [operationId, kind, payloadHash, targetRaw, evidenceJson] = row.map((c) => (c === null || c === undefined ? '' : String(c)));
  if (!isOperationId(operationId)) throw corrupt(`operation_id ${JSON.stringify(operationId)} is not an operation ID`);
  if (!OUTCOME_KINDS.has(kind)) throw corrupt(`kind ${JSON.stringify(kind)} is not 'save' or 'undo'`);
  if (!PAYLOAD_HASH_RE.test(payloadHash)) throw corrupt('payload_hash is not a 64-hex digest');
  let targetOperationId = null;
  if (targetRaw !== '') {
    if (!isOperationId(targetRaw)) throw corrupt(`target_operation_id ${JSON.stringify(targetRaw)} is not an operation ID`);
    targetOperationId = targetRaw;
  }
  let evidence;
  try {
    evidence = JSON.parse(evidenceJson);
  } catch (_) {
    throw corrupt('evidence_json is not valid JSON');
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw corrupt('evidence_json is not a JSON object');
  return { operationId, kind, payloadHash, targetOperationId, evidence, sheetRow };
}

function validateWriteOutcomesHeader(headerRow) {
  const row = Array.isArray(headerRow) ? headerRow.map((c) => String(c == null ? '' : c)) : [];
  const matches = row.length === WRITE_OUTCOMES_HEADER.length
    && WRITE_OUTCOMES_HEADER.every((cell, i) => row[i] === cell);
  if (!matches) {
    throw ledgerError('write_outcomes_header_mismatch',
      `Write_Outcomes header is not the immutable cutover header (${WRITE_OUTCOMES_HEADER.join(', ')}). The tab may belong to another cutover; every commit is refused.`);
  }
}

// ── Lookup ────────────────────────────────────────────────────────────────

// The durable answer for one operation ID, read from the ledger rows alone:
//   null — no outcome row: the operation never committed (or the ledger predates it).
//   { status: 'committed' } — its save row stands, no undo targets it.
//   { status: 'reverted', revertedBy } — an undo row targets its save row.
//   { kind: 'undo', status: 'reverted' } — the row IS an undo: the undo committed.
// Fail closed (throw) on any ledger inconsistency: duplicate rows for one
// ID, an undo with no save to target, a second undo for one save. A ledger
// in that state cannot answer honestly, so it answers nothing.
function lookupOutcome(rows, operationId) {
  if (!isOperationId(operationId)) {
    throw ledgerError('operation_id_invalid', `Not an operation ID: ${String(operationId)}`);
  }
  const decoded = (Array.isArray(rows) ? rows : []).map((row, i) => decodeOutcomeRow(row, i + 2));
  // Global consistency first: an undo whose target has no save row anywhere
  // in the ledger is corrupt no matter which operation is being looked up —
  // under this protocol an undo commits only against a save row that exists,
  // so an orphan can only come from corruption or an out-of-band edit. A
  // ledger in that state answers nothing.
  const saveIds = new Set(decoded.filter((r) => r.kind === 'save').map((r) => r.operationId));
  for (const row of decoded) {
    if (row.kind === 'undo' && !saveIds.has(row.targetOperationId)) {
      throw ledgerError('outcome_row_corrupt',
        `Write_Outcomes holds an undo (${row.operationId}) targeting ${row.targetOperationId}, but no save row for that target exists. The ledger is inconsistent, so every commit is refused.`);
    }
  }
  const own = decoded.filter((r) => r.operationId === operationId);
  if (own.length > 1) {
    throw ledgerError('outcome_row_corrupt',
      `Write_Outcomes holds ${own.length} rows for ${operationId}. One operation commits exactly once; the ledger is inconsistent, so every commit is refused.`);
  }
  const targeting = decoded.filter((r) => r.kind === 'undo' && r.targetOperationId === operationId);
  if (own.length === 0) {
    if (targeting.length > 0) {
      throw ledgerError('outcome_row_corrupt',
        `Write_Outcomes holds an undo targeting ${operationId} but no save row for it. The ledger is inconsistent, so every commit is refused.`);
    }
    return null;
  }
  if (own[0].kind === 'undo') {
    return { ...own[0], status: 'reverted' };
  }
  if (targeting.length > 1) {
    throw ledgerError('outcome_row_corrupt',
      `Write_Outcomes holds ${targeting.length} undos targeting ${operationId}. One save is undone at most once; the ledger is inconsistent, so every commit is refused.`);
  }
  if (targeting.length === 1) {
    return { ...own[0], status: 'reverted', revertedBy: targeting[0].operationId };
  }
  return { ...own[0], status: 'committed', revertedBy: null };
}

// ── Markers ───────────────────────────────────────────────────────────────

function parseMarkerGeneration(name) {
  if (typeof name !== 'string') return null;
  const m = name.match(/^atlas_receipt_commit_(\d+)$/);
  return m ? Number(m[1]) : null;
}

function nextMarkerName(markerNames) {
  let max = 0;
  for (const name of Array.isArray(markerNames) ? markerNames : []) {
    const gen = parseMarkerGeneration(name);
    if (gen !== null && gen > max) max = gen;
  }
  return `${MARKER_PREFIX}${max + 1}`;
}

function markerRangeFor(sheetId) {
  return { sheetId, ...MARKER_GRID_RANGE };
}

// ── Atomic commit request builder (pure) ──────────────────────────────────

function toCellData(value) {
  if (value === null || value === undefined) return { userEnteredValue: { stringValue: '' } };
  if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
  if (typeof value === 'number' && Number.isFinite(value)) return { userEnteredValue: { numberValue: value } };
  return { userEnteredValue: { stringValue: String(value) } };
}

// One batchUpdate request list: data appends + caller raw requests (e.g. an
// undo's deleteDimension) + the outcome row + the generation marker. The
// caller commits it with sheets.commitAtomicBatch; Google applies the whole
// list or nothing, so a failed commit writes no data and no outcome.
function buildAtomicCommit({ sheetIds, dataAppends = [], dataRequests = [], outcomeRow, markerName }) {
  const ids = sheetIds instanceof Map ? sheetIds : new Map(Object.entries(sheetIds || {}));
  const outcomesSheetId = ids.get(WRITE_OUTCOMES_TAB);
  if (!Number.isInteger(outcomesSheetId)) {
    throw ledgerError('unknown_tab', `No sheetId for ${WRITE_OUTCOMES_TAB}: the tab must exist before a commit is built.`);
  }
  if (typeof markerName !== 'string' || !markerName) {
    throw ledgerError('marker_missing', 'A commit needs its generation marker name: without it the fence cannot reject a delayed request.');
  }
  if (!Array.isArray(outcomeRow) || outcomeRow.length !== 5) {
    throw ledgerError('outcome_row_corrupt', 'A commit needs a complete 5-cell outcome row.');
  }
  const requests = [];
  for (const append of dataAppends) {
    const sheetId = ids.get(append.tab);
    if (!Number.isInteger(sheetId)) {
      throw ledgerError('unknown_tab', `No sheetId for tab ${String(append.tab)}: the tab must exist before a commit is built.`);
    }
    const rows = Array.isArray(append.rows) ? append.rows : [];
    if (rows.length === 0) continue;
    requests.push({
      appendCells: {
        sheetId,
        rows: rows.map((row) => (Array.isArray(row) ? row : [row]).map(toCellData)),
        fields: 'userEnteredValue',
      },
    });
  }
  for (const req of dataRequests) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      throw ledgerError('data_request_invalid', 'A data request in an atomic commit must be a batchUpdate request object.');
    }
    requests.push(req);
  }
  requests.push({
    appendCells: {
      sheetId: outcomesSheetId,
      rows: [outcomeRow.map(toCellData)],
      fields: 'userEnteredValue',
    },
  });
  requests.push({
    addNamedRange: {
      namedRange: { name: markerName, range: markerRangeFor(outcomesSheetId) },
    },
  });
  return requests;
}

// ── Fence detection ───────────────────────────────────────────────────────

// Google rejects a duplicate named-range name with a 400 naming the range.
// That rejection is the fence firing: another commit took this generation,
// so the delayed request must re-prepare, never blindly retry the same
// batch. The match is deliberately narrow — anything else is an ordinary
// batch failure (ambiguous ones propagate for ledger reconciliation) — and
// the exact live wording is confirmed by probe 7.
function fenceRejectionFromError(error) {
  if (!error) return false;
  const status = Number(
    error.status != null ? error.status
      : (error.response && error.response.status != null) ? error.response.status
        : NaN
  );
  if (status !== 400) return false;
  const message = String((error && error.message) || '');
  return /named range/i.test(message) && /already exists/i.test(message);
}

// ── Sheet access (through the real sheets.js; injectable for tests) ───────

async function ensureWriteOutcomes(sheets) {
  await sheets.ensureSheetTab(WRITE_OUTCOMES_TAB, WRITE_OUTCOMES_HEADER);
  const header = await sheets.getHeaderRow(WRITE_OUTCOMES_TAB);
  validateWriteOutcomesHeader(header);
  return { tab: WRITE_OUTCOMES_TAB, header };
}

async function readOutcomeRows(sheets) {
  return sheets.getSheetRows(WRITE_OUTCOMES_TAB);
}

// Every atlas_receipt_commit_* marker must point at Write_Outcomes!A1. A
// marker pointing anywhere else is a corrupt fence: fail closed.
async function readMarkerNames(sheets, writeOutcomesSheetId) {
  const named = await sheets.getNamedRanges();
  const names = [];
  for (const entry of Array.isArray(named) ? named : []) {
    const name = entry && typeof entry.name === 'string' ? entry.name : '';
    const gen = parseMarkerGeneration(name);
    if (gen === null) continue;
    const range = (entry && entry.range) || {};
    const ok = range.sheetId === writeOutcomesSheetId
      && range.startRowIndex === 0 && range.endRowIndex === 1
      && range.startColumnIndex === 0 && range.endColumnIndex === 1;
    if (!ok) {
      throw ledgerError('marker_range_mismatch',
        `Marker ${name} does not point at ${WRITE_OUTCOMES_TAB}!A1. The fence cannot be trusted, so every commit is refused.`);
    }
    names.push(name);
  }
  return names;
}

async function lookupOperation(sheets, operationId) {
  await ensureWriteOutcomes(sheets);
  const rows = await readOutcomeRows(sheets);
  return lookupOutcome(rows, operationId);
}

// ── Prepare / commit ──────────────────────────────────────────────────────

async function prepareOperation(sheets, args) {
  const {
    cutoverId, operationId, kind, payload,
    targetOperationId = null, legacyTarget = false,
    evidence = {}, dataAppends = [], dataRequests = [],
  } = args || {};
  const parsed = parseOperationId(operationId);
  if (!parsed) {
    throw ledgerError('operation_id_invalid', `Not an operation ID: ${String(operationId)}`);
  }
  if (parsed.cutoverId !== cutoverId) {
    throw ledgerError('operation_id_cutover_mismatch',
      `Operation ${operationId} belongs to cutover ${parsed.cutoverId}, not the configured cutover ${cutoverId}. An operation minted under another epoch cannot commit here.`);
  }
  if (!OUTCOME_KINDS.has(kind)) {
    throw ledgerError('outcome_kind_invalid', `Outcome kind must be 'save' or 'undo', got ${String(kind)}`);
  }
  // A legacy undo is refused before any sheet access: pre-cutover rows carry
  // no operation ID, so no ledger row can ever prove which save an undo
  // targets — the #1763 posture (ambiguous legacy undo stays refused).
  if (legacyTarget === true) {
    throw ledgerError('legacy_undo_refused',
      'Undo refused: the target rows predate the Write_Outcomes cutover and carry no operation ID, so the undo cannot prove which save it reverts.');
  }
  if (kind === 'undo' && !isOperationId(targetOperationId)) {
    throw ledgerError('undo_without_target', 'An undo commits against a target operation ID: without one there is nothing to revert.');
  }
  if (kind === 'save' && targetOperationId !== null && targetOperationId !== undefined && targetOperationId !== '') {
    throw ledgerError('undo_without_target', 'A save carries no target operation ID: only an undo targets another operation.');
  }

  await ensureWriteOutcomes(sheets);
  const sheetIds = await sheets.getSpreadsheetSheetIds();
  const rows = await readOutcomeRows(sheets);
  const payloadHash = canonicalPayloadHash(payload);

  // Reconciliation first: the same ID with the same payload replays its
  // committed/reverted outcome and writes nothing. The same ID with a
  // different payload is refused — it is either a client bug or a replay
  // attack on another operation's identity.
  const existing = lookupOutcome(rows, operationId);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw ledgerError('operation_id_payload_mismatch',
        `Operation ${operationId} already committed with a different payload. The same ID with different data is refused.`);
    }
    return { replay: existing, operationId, kind, payloadHash, markerName: null, requests: null, tabs: [] };
  }

  if (kind === 'undo') {
    const target = lookupOutcome(rows, targetOperationId);
    if (!target) {
      throw ledgerError('undo_target_missing',
        `Undo refused: no committed save with operation ID ${targetOperationId} exists in the ledger.`);
    }
    if (target.kind !== 'save') {
      throw ledgerError('undo_target_missing',
        `Undo refused: ${targetOperationId} is not a save, so there is nothing to revert.`);
    }
    if (target.status === 'reverted') {
      // The save is already undone: the undo's effect already stands, so
      // this undo answers already-reverted and writes no second undo row.
      return {
        replay: { ...target, status: 'reverted' },
        alreadyReverted: true,
        operationId, kind, payloadHash, markerName: null, requests: null, tabs: [],
      };
    }
  }

  const writeOutcomesSheetId = sheetIds.get(WRITE_OUTCOMES_TAB);
  const markerNames = await readMarkerNames(sheets, writeOutcomesSheetId);
  const markerName = nextMarkerName(markerNames);
  // The marker rides in the evidence so a replayed answer can name the
  // commit that established it. It is ledger metadata, not payload: the
  // payload hash is computed from the payload alone.
  const outcomeRow = encodeOutcomeRow({
    operationId,
    kind,
    payloadHash,
    targetOperationId: kind === 'undo' ? targetOperationId : null,
    evidence: { ...evidence, marker: markerName },
  });
  const requests = buildAtomicCommit({ sheetIds, dataAppends, dataRequests, outcomeRow, markerName });
  const tabs = [...new Set([
    ...dataAppends.map((a) => a.tab),
    WRITE_OUTCOMES_TAB,
  ])];
  return { replay: null, operationId, kind, payloadHash, markerName, requests, tabs };
}

function replayResult(prepared) {
  const outcome = prepared.replay;
  return {
    outcome: outcome.status,
    replayed: true,
    operationId: prepared.operationId,
    marker: (outcome.evidence && outcome.evidence.marker) || null,
    ...(outcome.revertedBy ? { revertedBy: outcome.revertedBy } : {}),
    ...(prepared.alreadyReverted ? { alreadyReverted: true } : {}),
  };
}

async function commitPrepared(sheets, prepared) {
  if (prepared.replay) return replayResult(prepared);
  let response;
  try {
    response = await sheets.commitAtomicBatch(prepared.requests, { tabs: prepared.tabs });
  } catch (error) {
    if (fenceRejectionFromError(error)) {
      throw ledgerError('fence_rejected',
        `The generation marker ${prepared.markerName} already exists: another commit landed after this request was prepared. The batch was refused atomically and nothing was written; re-prepare against the current generation.`);
    }
    throw error;
  }
  void response;
  // Read back before returning success: the outcome row must be present
  // with the matching payload hash, or the commit is not established.
  const rows = await readOutcomeRows(sheets);
  const found = lookupOutcome(rows, prepared.operationId);
  if (!found || found.payloadHash !== prepared.payloadHash) {
    throw ledgerError('outcome_not_found_after_commit',
      `The atomic commit returned, but no outcome row for ${prepared.operationId} with the matching payload hash reads back. The write is not established.`);
  }
  const expected = prepared.kind === 'undo' ? 'reverted' : 'committed';
  if (found.status !== expected) {
    throw ledgerError('outcome_not_found_after_commit',
      `The outcome row for ${prepared.operationId} reads back as ${found.status}, not ${expected}. The write is not established.`);
  }
  return {
    outcome: found.status,
    replayed: false,
    operationId: prepared.operationId,
    marker: prepared.markerName,
    ...(found.revertedBy ? { revertedBy: found.revertedBy } : {}),
  };
}

// One deliberate save or undo, end to end. On a fence rejection the request
// re-prepares against the current generation (bounded): a concurrent commit
// that took the marker may have committed THIS operation already, in which
// case the re-prepare replays it instead of writing twice. After the bound
// the fence error stands — the caller retries the whole operation later.
async function commitOperation(sheets, args) {
  let lastFenceError = null;
  for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt++) {
    const prepared = await prepareOperation(sheets, args);
    if (prepared.replay) return replayResult(prepared);
    try {
      return await commitPrepared(sheets, prepared);
    } catch (error) {
      if (error && error.code === 'fence_rejected') {
        lastFenceError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastFenceError;
}

// #1780 — resolve a ledger operation_id carried by a writer route. Absent,
// the route takes the legacy path unchanged ({ operationId: null }). Present,
// the ledger path is mandatory: a malformed ID is a 400, an ID from another
// cutover is a 409, and an unconfigured cutover is a 500 — never a silent
// legacy fallback, which would write data the ledger cannot answer for.
// Pure: the caller answers the returned error with standardError.
function resolveLedgerOperationId(payload) {
  const raw = payload && typeof payload.operation_id === 'string' && payload.operation_id !== '' ? payload.operation_id : null;
  if (!raw) return { operationId: null, cutoverId: null };
  if (!isOperationId(raw)) {
    return { error: { status: 400, code: 'operation_id_invalid', message: 'operation_id is not a valid operation ID (atlas-op-v1:<cutover-UUID>:<operation-UUID>).' } };
  }
  let cutoverId;
  try {
    cutoverId = getCutoverId();
  } catch (error) {
    return { error: { status: 500, code: 'cutover_unconfigured', message: 'Write_Outcomes cutover is not configured; a ledger write cannot commit.' } };
  }
  if (parseOperationId(raw).cutoverId !== cutoverId) {
    return { error: { status: 409, code: 'operation_id_cutover_mismatch', message: 'operation_id belongs to another Write_Outcomes cutover and cannot commit here.' } };
  }
  return { operationId: raw, cutoverId };
}

module.exports = {
  WRITE_OUTCOMES_TAB,
  WRITE_OUTCOMES_HEADER,
  OPERATION_ID_PREFIX,
  MARKER_PREFIX,
  EVIDENCE_MAX_CHARS,
  LedgerError,
  mintOperationId,
  parseOperationId,
  isOperationId,
  getCutoverId,
  resolveLedgerOperationId,
  stableStringify,
  canonicalPayloadHash,
  encodeOutcomeRow,
  decodeOutcomeRow,
  validateWriteOutcomesHeader,
  lookupOutcome,
  parseMarkerGeneration,
  nextMarkerName,
  markerRangeFor,
  toCellData,
  buildAtomicCommit,
  fenceRejectionFromError,
  ensureWriteOutcomes,
  readMarkerNames,
  lookupOperation,
  prepareOperation,
  commitPrepared,
  commitOperation,
};
