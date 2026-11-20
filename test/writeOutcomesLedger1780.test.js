'use strict';

// #1780 [P1] Durable operation identity: Write_Outcomes ledger (design-proof
// Part 2, owner-approved Candidate B).
//
// Failing-first probes for the ledger mechanism, issue acceptance Q3–Q6
// (Q7, the live-Sheets fence check, is a pre-merge acceptance gate that
// cannot run from this VM — no Sheets credentials — and is NOT covered here).
//
// Part A: pure ledger functions — no Sheets. Part B: the commit/lookup
// orchestrator against a FULLY MODELED fake Sheets client, with the REAL
// sheets.js and the REAL services/writeOutcomes.js (only `googleapis`
// faked, the #1764 test pattern). Appends push rows, deletes splice them,
// named ranges persist — so save -> undo -> restart -> retry runs through
// the real mechanism with real state transitions. Each probe asserts the
// FIXED outcome, so every probe FAILS at the s3 head (no ledger module)
// until the build lands.
//
// The ledger is the durable authority. The in-memory/file receipt store
// (services/idempotency.js) is best-effort and dies on a free-plan restart;
// after such a restart the ONLY thing that can answer "was this save
// reverted?" is the Write_Outcomes tab. That is what Q3 proves.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const writeOutcomes = require('../services/writeOutcomes');

const CUTOVER = '11111111-2222-4333-8444-555555555555';

function opId(operationUuid) {
  return `atlas-op-v1:${CUTOVER}:${operationUuid}`;
}

function payloadFor(sessionId, rows) {
  return { session_id: sessionId, tab: 'Log_Cleaned', rows };
}

// ── Part A: operation IDs ─────────────────────────────────────────────────

test('#1780 Part A: mintOperationId embeds the cutover and a fresh UUID; distinct IDs per call', () => {
  const a = writeOutcomes.mintOperationId(CUTOVER);
  const b = writeOutcomes.mintOperationId(CUTOVER);
  assert.match(a, /^atlas-op-v1:11111111-2222-4333-8444-555555555555:[0-9a-f-]{36}$/);
  assert.notEqual(a, b, 'two mints are never the same operation');
  assert.equal(writeOutcomes.parseOperationId(a).cutoverId, CUTOVER);
  assert.equal(writeOutcomes.parseOperationId(a).operationUuid.length, 36);
  assert.equal(writeOutcomes.isOperationId(a), true);
});

test('#1780 Part A: mintOperationId refuses a missing or malformed cutover — no ID without an epoch', () => {
  assert.throws(() => writeOutcomes.mintOperationId(''), /cutover/i);
  assert.throws(() => writeOutcomes.mintOperationId('not-a-uuid'), /cutover/i);
  assert.throws(() => writeOutcomes.mintOperationId('11111111-2222-3333-8444-555555555555'), /cutover/i);
  assert.throws(() => writeOutcomes.mintOperationId(null), /cutover/i);
});

test('#1780 Part A: parse/isOperationId reject garbage instead of guessing', () => {
  assert.equal(writeOutcomes.parseOperationId('atlas-op-v1:bad:also-bad'), null);
  assert.equal(writeOutcomes.parseOperationId('write-1234'), null);
  assert.equal(writeOutcomes.parseOperationId(''), null);
  assert.equal(writeOutcomes.parseOperationId(null), null);
  assert.equal(writeOutcomes.isOperationId('atlas-op-v1:bad:also-bad'), false);
  assert.equal(writeOutcomes.isOperationId(undefined), false);
});

// ── Part A: payload hash ──────────────────────────────────────────────────

test('#1780 Part A: canonicalPayloadHash is stable across key order and sensitive to values', () => {
  const h1 = writeOutcomes.canonicalPayloadHash({ b: 2, a: { d: 4, c: 3 } });
  const h2 = writeOutcomes.canonicalPayloadHash({ a: { c: 3, d: 4 }, b: 2 });
  assert.equal(h1, h2, 'key order must not change the hash');
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.notEqual(h1, writeOutcomes.canonicalPayloadHash({ b: 2, a: { d: 5, c: 3 } }));
  assert.notEqual(h1, writeOutcomes.canonicalPayloadHash({ b: 2 }));
});

// ── Part A: outcome rows ──────────────────────────────────────────────────

test('#1780 Part A: encodeOutcomeRow produces the exact 5-column row; decode round-trips it', () => {
  const id = opId(crypto.randomUUID());
  const evidence = { v: 1, status: 'committed', tabs: ['Log_Cleaned'], rows: 2 };
  const row = writeOutcomes.encodeOutcomeRow({
    operationId: id,
    kind: 'save',
    payloadHash: writeOutcomes.canonicalPayloadHash(payloadFor('S1', [[1]])),
    targetOperationId: null,
    evidence,
  });
  assert.equal(row.length, 5);
  assert.equal(row[0], id);
  assert.equal(row[1], 'save');
  assert.match(row[2], /^[0-9a-f]{64}$/);
  assert.equal(row[3], '');
  assert.equal(JSON.parse(row[4]).status, 'committed');
  const decoded = writeOutcomes.decodeOutcomeRow(row, 2);
  assert.equal(decoded.operationId, id);
  assert.equal(decoded.kind, 'save');
  assert.equal(decoded.evidence.status, 'committed');
  assert.equal(decoded.targetOperationId, null);
});

test('#1780 Part A: encodeOutcomeRow refuses bad kind, bad hash, and oversized evidence', () => {
  const id = opId(crypto.randomUUID());
  const hash = writeOutcomes.canonicalPayloadHash({ x: 1 });
  assert.throws(() => writeOutcomes.encodeOutcomeRow({
    operationId: id, kind: 'delete', payloadHash: hash, targetOperationId: null, evidence: {},
  }), (err) => err && err.code === 'outcome_kind_invalid');
  assert.throws(() => writeOutcomes.encodeOutcomeRow({
    operationId: id, kind: 'save', payloadHash: 'not-a-hash', targetOperationId: null, evidence: {},
  }), (err) => err && err.code === 'payload_hash_invalid');
  assert.throws(() => writeOutcomes.encodeOutcomeRow({
    operationId: id, kind: 'save', payloadHash: hash, targetOperationId: null,
    evidence: { v: 1, note: 'x'.repeat(45000) },
  }), (err) => err && err.code === 'evidence_oversize');
});

test('#1780 Part A: decodeOutcomeRow fails closed on corrupt rows', () => {
  const id = opId(crypto.randomUUID());
  const hash = writeOutcomes.canonicalPayloadHash({ x: 1 });
  const good = writeOutcomes.encodeOutcomeRow({
    operationId: id, kind: 'save', payloadHash: hash, targetOperationId: null, evidence: { v: 1 },
  });
  // The machine-readable contract is the error code; the message is human text.
  const corrupt = (err) => err && err.code === 'outcome_row_corrupt';
  assert.throws(() => writeOutcomes.decodeOutcomeRow(good.slice(0, 4), 2), corrupt);
  assert.throws(() => writeOutcomes.decodeOutcomeRow([...good.slice(0, 4), 'not json'], 2), corrupt);
  assert.throws(() => writeOutcomes.decodeOutcomeRow([id, 'save', 'zz', '', '{}'], 2), corrupt);
  assert.throws(() => writeOutcomes.decodeOutcomeRow(['not-an-op', 'save', hash, '', '{}'], 2), corrupt);
});

test('#1780 Part A: validateWriteOutcomesHeader accepts the exact header and nothing else', () => {
  writeOutcomes.validateWriteOutcomesHeader(
    ['operation_id', 'kind', 'payload_hash', 'target_operation_id', 'evidence_json']);
  assert.throws(() => writeOutcomes.validateWriteOutcomesHeader(
    ['operation_id', 'kind', 'payload_hash', 'target_operation_id']), /header/i);
  assert.throws(() => writeOutcomes.validateWriteOutcomesHeader(
    ['operation_id', 'kind', 'payload_hash', 'target_operation_id', 'evidence', 'extra']), /header/i);
  assert.throws(() => writeOutcomes.validateWriteOutcomesHeader(
    ['operation_id', 'kind', 'payload_hash', 'target_operation_id', 'evidence_json ']), /header/i);
});

// ── Part A: lookup ────────────────────────────────────────────────────────

function saveRowFor(id, hash, evidence = { v: 1, status: 'committed' }) {
  return writeOutcomes.encodeOutcomeRow({
    operationId: id, kind: 'save', payloadHash: hash, targetOperationId: null, evidence,
  });
}

function undoRowFor(id, targetId, hash, evidence = { v: 1, status: 'reverted' }) {
  return writeOutcomes.encodeOutcomeRow({
    operationId: id, kind: 'undo', payloadHash: hash, targetOperationId: targetId, evidence,
  });
}

test('#1780 Part A: lookupOutcome — absent, committed, reverted', () => {
  const a = opId(crypto.randomUUID());
  const u = opId(crypto.randomUUID());
  const hash = writeOutcomes.canonicalPayloadHash({ x: 1 });
  assert.equal(writeOutcomes.lookupOutcome([], a), null);
  assert.equal(writeOutcomes.lookupOutcome([saveRowFor(a, hash)], a).status, 'committed');
  const rows = [saveRowFor(a, hash), undoRowFor(u, a, writeOutcomes.canonicalPayloadHash({ undo: a }))];
  const found = writeOutcomes.lookupOutcome(rows, a);
  assert.equal(found.status, 'reverted');
  assert.equal(found.revertedBy, u);
});

test('#1780 Part A: lookupOutcome fails closed on same-ID conflicting rows and orphan undos', () => {
  const a = opId(crypto.randomUUID());
  const u = opId(crypto.randomUUID());
  const h1 = writeOutcomes.canonicalPayloadHash({ x: 1 });
  const h2 = writeOutcomes.canonicalPayloadHash({ x: 2 });
  const corrupt = (err) => err && err.code === 'outcome_row_corrupt';
  assert.throws(() => writeOutcomes.lookupOutcome(
    [saveRowFor(a, h1), saveRowFor(a, h2)], a), corrupt);
  assert.throws(() => writeOutcomes.lookupOutcome(
    [saveRowFor(a, h1), saveRowFor(a, h1)], a), corrupt);
  assert.throws(() => writeOutcomes.lookupOutcome(
    [undoRowFor(u, a, h1)], a), corrupt);
  assert.throws(() => writeOutcomes.lookupOutcome(
    [undoRowFor(u, opId(crypto.randomUUID()), h1)], a), corrupt);
});

// ── Part A: markers ───────────────────────────────────────────────────────

test('#1780 Part A: nextMarkerName starts at 1, follows the max, ignores other names', () => {
  assert.equal(writeOutcomes.nextMarkerName([]), 'atlas_receipt_commit_1');
  assert.equal(writeOutcomes.nextMarkerName(['atlas_receipt_commit_1']), 'atlas_receipt_commit_2');
  assert.equal(writeOutcomes.nextMarkerName(
    ['atlas_receipt_commit_1', 'atlas_receipt_commit_3', 'some_other_range']), 'atlas_receipt_commit_4');
  assert.equal(writeOutcomes.parseMarkerGeneration('atlas_receipt_commit_12'), 12);
  assert.equal(writeOutcomes.parseMarkerGeneration('atlas_receipt_commit_x'), null);
  assert.equal(writeOutcomes.parseMarkerGeneration('other'), null);
});

// ── Part A: atomic commit request builder ─────────────────────────────────

test('#1780 Part A: buildAtomicCommit emits appendCells + outcome + marker in one request list', () => {
  const id = opId(crypto.randomUUID());
  const hash = writeOutcomes.canonicalPayloadHash(payloadFor('S1', [[1]]));
  const requests = writeOutcomes.buildAtomicCommit({
    sheetIds: new Map([['Log_Cleaned', 7], ['Write_Outcomes', 9]]),
    dataAppends: [{ tab: 'Log_Cleaned', rows: [['2026-11-18', 'S1', 'Back Squat', 1, 225, 5]] }],
    outcomeRow: writeOutcomes.encodeOutcomeRow({
      operationId: id, kind: 'save', payloadHash: hash, targetOperationId: null, evidence: { v: 1 },
    }),
    markerName: 'atlas_receipt_commit_1',
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].appendCells.sheetId, 7);
  assert.equal(requests[0].appendCells.rows[0][0].userEnteredValue.stringValue, '2026-11-18');
  assert.equal(requests[0].appendCells.rows[0][4].userEnteredValue.numberValue, 225);
  assert.equal(requests[1].appendCells.sheetId, 9);
  assert.equal(requests[1].appendCells.rows[0][0].userEnteredValue.stringValue, id);
  assert.equal(requests[2].addNamedRange.namedRange.name, 'atlas_receipt_commit_1');
  assert.deepEqual(requests[2].addNamedRange.namedRange.range, {
    sheetId: 9, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1,
  });
});

test('#1780 Part A: buildAtomicCommit refuses an unknown tab and a missing marker', () => {
  const id = opId(crypto.randomUUID());
  const hash = writeOutcomes.canonicalPayloadHash({ x: 1 });
  const outcomeRow = writeOutcomes.encodeOutcomeRow({
    operationId: id, kind: 'save', payloadHash: hash, targetOperationId: null, evidence: { v: 1 },
  });
  assert.throws(() => writeOutcomes.buildAtomicCommit({
    sheetIds: new Map([['Write_Outcomes', 9]]),
    dataAppends: [{ tab: 'Log_Cleaned', rows: [[1]] }],
    outcomeRow, markerName: 'atlas_receipt_commit_1',
  }), /sheetId|unknown tab/i);
  assert.throws(() => writeOutcomes.buildAtomicCommit({
    sheetIds: new Map([['Write_Outcomes', 9]]),
    dataAppends: [], outcomeRow, markerName: '',
  }), /marker/i);
});
