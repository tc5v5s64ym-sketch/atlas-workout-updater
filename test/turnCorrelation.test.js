'use strict';

// #1165 — cross-route turn↔write correlation seam (Phase 4 critical path).
//
// The coach turn's canonical `turn_id` is minted on a READ-ONLY route
// (/api/coach/message|chat|ask are declared readOnly/writeCapable:false in
// config/routes.js). The write it authorizes lands later, on a DIFFERENT request to a
// DIFFERENT route. Nothing carried the id across that boundary, so the InteractionTrace
// could never populate its `write_proof` stage — the gap the 2026-07-25 Golden Session
// recorded as architectural (docs/verification/PHASE_4_GOLDEN_SESSION_EVIDENCE_2026-07-25.md).
//
// This module is that seam, and these tests pin its TRUST boundary. The client-carried
// correlation claim is explicitly NON-AUTHORITATIVE: the client may assert a turn id, but
// the SERVER decides whether it is real, fresh, and its own. Every way that can go wrong
// must fail CLOSED — drop the correlation, never associate write proof with an id the
// server did not issue for this session.
//
// The four failure modes the concern names, plus the honest no-claim case:
//   absent          → no claim; not an error (a write without correlation is legal)
//   malformed       → shape/format/length rejected before any lookup
//   unknown         → well-formed but never issued (or already evicted) → rejected
//   session_mismatch→ issued, but under a DIFFERENT session → rejected (contamination)
//   stale           → issued, same session, but outside the freshness window → rejected
//
// A rejected claim must NEVER block or alter the write itself: correlation is telemetry
// riding alongside the trust loop, never part of it.

const test = require('node:test');
const assert = require('node:assert/strict');

const tc = require('../services/turnCorrelation');

const SESSION = '20260725-AM-01';
const OTHER_SESSION = '20260725-PM-02';
// The canonical minted shape (services/interactionTraceShadow.mintTurnId):
//   turn:<ISO-8601>_<seq>_<rand>
const TURN_ID = 'turn:2026-07-25T00:00:00.000Z_1_ab12cd';

function reset() { tc._resetForTesting(); }

// ─── the claim envelope ───────────────────────────────────────────────────────

test('resolveCorrelation: a valid, fresh, same-session claim resolves ok', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const r = tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.turn_id, TURN_ID);
});

test('resolveCorrelation: absent claim is not an error, and carries no id', () => {
  reset();
  for (const payload of [{}, { correlation: undefined }, { correlation: null }, null, undefined]) {
    const r = tc.resolveCorrelation(payload, { sessionId: SESSION, nowMs: 1 });
    assert.equal(r.ok, false, `payload ${JSON.stringify(payload)} must not resolve`);
    assert.equal(r.reason, 'absent');
    assert.equal(r.turn_id, null);
  }
});

test('resolveCorrelation: malformed claims are rejected before any registry lookup', () => {
  reset();
  const now = 1_000_000;
  // Issue nothing at all — a malformed claim must be rejected on shape alone, so these
  // must NOT report `unknown` (which would mean the format gate let them through).
  const malformed = [
    { correlation: 'turn:2026-07-25T00:00:00.000Z_1_ab12cd' }, // not an object
    { correlation: [] },                                        // array is not an object
    { correlation: {} },                                        // no turn_id
    { correlation: { turn_id: '' } },
    { correlation: { turn_id: '   ' } },
    { correlation: { turn_id: 42 } },
    { correlation: { turn_id: null } },
    { correlation: { turn_id: {} } },
    { correlation: { turn_id: 'flight:FR-20260725-abc' } },     // wrong prefix for a TURN id
    { correlation: { turn_id: 'session:20260725-AM-01' } },
    { correlation: { turn_id: 'turn:' } },                      // prefix with no token
    { correlation: { turn_id: 'nope' } },
    { correlation: { turn_id: `turn:${'x'.repeat(1024)}` } },   // unbounded → rejected
  ];
  for (const payload of malformed) {
    const r = tc.resolveCorrelation(payload, { sessionId: SESSION, nowMs: now });
    assert.equal(r.ok, false, `${JSON.stringify(payload)} must not resolve`);
    assert.equal(r.reason, 'malformed', `${JSON.stringify(payload)} must be malformed, got ${r.reason}`);
    assert.equal(r.turn_id, null);
  }
});

test('resolveCorrelation: a well-formed id the server never issued is rejected (unknown)', () => {
  reset();
  const r = tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown');
  assert.equal(r.turn_id, null);
});

// ─── cross-session contamination ──────────────────────────────────────────────

test('resolveCorrelation: an id issued under another session is rejected (session_mismatch)', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, OTHER_SESSION, { nowMs: now });
  const r = tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'session_mismatch');
  assert.equal(r.turn_id, null);
});

test('resolveCorrelation: a write with no session identity cannot claim any correlation', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  for (const sessionId of [undefined, null, '', '   ']) {
    const r = tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId, nowMs: now + 1 });
    assert.equal(r.ok, false, `sessionId ${JSON.stringify(sessionId)} must not resolve`);
    assert.equal(r.reason, 'session_mismatch');
  }
});

// ─── freshness ────────────────────────────────────────────────────────────────

test('resolveCorrelation: a claim outside the freshness window is rejected (stale)', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const r = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } },
    { sessionId: SESSION, nowMs: now + tc.DEFAULT_MAX_AGE_MS + 1 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale');
  assert.equal(r.turn_id, null);
});

test('resolveCorrelation: a claim exactly at the window edge is still accepted', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const r = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } },
    { sessionId: SESSION, nowMs: now + tc.DEFAULT_MAX_AGE_MS },
  );
  assert.equal(r.ok, true, 'the boundary must be inclusive, so a legitimate slow write is not dropped');
});

test('a replayed stale id cannot be revived by re-claiming it', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const late = now + tc.DEFAULT_MAX_AGE_MS + 1;
  assert.equal(tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: late }).reason, 'stale');
  // A second attempt must not resolve either — reading must never refresh the record.
  const again = tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: late + 1 });
  assert.equal(again.ok, false);
  assert.ok(again.reason === 'stale' || again.reason === 'unknown');
});

// ─── registry hygiene (bounded, like coachDiscussionReferent) ─────────────────

test('issueTurn: ignores junk and never grows on it', () => {
  reset();
  tc.issueTurn('', SESSION, { nowMs: 1 });
  tc.issueTurn(TURN_ID, '', { nowMs: 1 });
  tc.issueTurn(null, null, { nowMs: 1 });
  tc.issueTurn('not-a-turn-id', SESSION, { nowMs: 1 });
  assert.equal(tc._sizeForTesting(), 0);
});

test('the registry is bounded by a hard entry cap', () => {
  reset();
  const now = 1_000_000;
  for (let i = 0; i < tc.MAX_ENTRIES + 50; i += 1) {
    tc.issueTurn(`turn:2026-07-25T00:00:00.000Z_${i}_abcdef`, SESSION, { nowMs: now + i });
  }
  assert.ok(tc._sizeForTesting() <= tc.MAX_ENTRIES, `registry must stay capped, got ${tc._sizeForTesting()}`);
});

test('expired entries are evicted, so the registry cannot grow without bound', () => {
  reset();
  tc.issueTurn(TURN_ID, SESSION, { nowMs: 0 });
  // A much-later write sweeps the expired entry.
  tc.issueTurn('turn:2026-07-25T09:00:00.000Z_2_zzzzzz', SESSION, { nowMs: tc.DEFAULT_MAX_AGE_MS * 10 });
  assert.equal(tc._sizeForTesting(), 1);
});

// ─── the write-proof record: bounded, verbatim proof, no payload leakage ──────

test('buildWriteProofRecord: carries the existing W1–W3 proof fields VERBATIM', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID,
    sessionId: SESSION,
    route: '/api/log-workout',
    proof: {
      test_mode: false,
      sheet_write: 'success',
      sheet_written: true,
      no_write_confirmed: false,
      write_id: 'w-123',
      log_appended_range: 'Log_Cleaned!A847:L849',
      rows_appended: 3,
    },
  });
  assert.equal(record.turn_id, TURN_ID);
  assert.equal(record.session_id, SESSION);
  assert.equal(record.route, '/api/log-workout');
  // Proof fields are COPIED, never reshaped or renamed — invariants W1–W3 are owner-reserved.
  assert.equal(record.proof.sheet_write, 'success');
  assert.equal(record.proof.sheet_written, true);
  assert.equal(record.proof.no_write_confirmed, false);
  assert.equal(record.proof.test_mode, false);
  assert.equal(record.proof.write_id, 'w-123');
  assert.equal(record.proof.log_appended_range, 'Log_Cleaned!A847:L849');
});

test('buildWriteProofRecord: preserves the dry-run proof pair exactly', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID,
    sessionId: SESSION,
    route: '/api/log-workout',
    proof: { test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true },
  });
  assert.equal(record.proof.sheet_written, false);
  assert.equal(record.proof.no_write_confirmed, true);
  assert.equal(record.proof.test_mode, true);
});

test('buildWriteProofRecord: is a CLOSED whitelist — no rows, prose, or unknown fields survive', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID,
    sessionId: SESSION,
    route: '/api/log-workout',
    proof: {
      sheet_write: 'success',
      sheet_written: true,
      // Everything below is exactly what must NEVER reach a durable telemetry record.
      log_rows: [['2026-07-25', SESSION, 'Bench Press', 225, 5, 2]],
      effort_row: ['2026-07-25', SESSION, 3600, 400],
      notes: 'felt strong today',
      prompt: 'you are Atlas...',
      message: 'Nice work on that top set.',
      api_key: 'secret-key',
      spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
      request_body: { anything: 'at all' },
    },
  });
  const proofKeys = Object.keys(record.proof);
  for (const banned of ['log_rows', 'effort_row', 'notes', 'prompt', 'message', 'api_key', 'spreadsheetId', 'request_body']) {
    assert.ok(!proofKeys.includes(banned), `${banned} must not survive into the write-proof record`);
  }
  const serialized = JSON.stringify(record);
  for (const secret of ['felt strong today', 'you are Atlas', 'secret-key', '1AbCdEfGhIjKlMnOpQrStUvWxYz', 'Bench Press']) {
    assert.ok(!serialized.includes(secret), `record must not carry "${secret}"`);
  }
});

test('buildWriteProofRecord: refuses to build without a resolved turn id', () => {
  for (const turnId of [null, undefined, '', 'not-a-turn-id']) {
    assert.equal(
      tc.buildWriteProofRecord({ turnId, sessionId: SESSION, route: '/api/log-workout', proof: { sheet_written: true } }),
      null,
      `an unresolved id (${JSON.stringify(turnId)}) must never produce a correlation record`,
    );
  }
});
