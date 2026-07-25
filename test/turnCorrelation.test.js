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
// The failure modes, plus the honest no-claim case:
//   absent           → no claim; not an error (a write without correlation is legal)
//   malformed        → shape/format/length rejected before any lookup
//   unknown          → well-formed but never issued (or already evicted) → rejected
//   session_mismatch → issued, but under a DIFFERENT session → rejected (contamination)
//   stale            → issued, same session, but outside the freshness window → rejected
//   unpaired         → a live write on a turn no preview ever paired → rejected (#1173 item 1)
//   pairing_mismatch → a pairing exists, but the presented token is wrong/absent → rejected
//   pairing_exhausted→ one pairing replayed past its write cap → rejected
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

// A request body carrying the write identity the server fingerprints at preview and re-checks
// on the live write (#1173 item 1, Codex P1). Overrides let a test vary exactly one field.
function payloadWith(extra = {}) {
  return {
    session_id: SESSION,
    date: '2026-07-25',
    log_rows: [{ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2, set_number: 1 }],
    ...extra,
  };
}

// ─── the claim envelope ───────────────────────────────────────────────────────

test('resolveCorrelation: a valid, fresh, same-session claim resolves ok', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // A turn's FIRST legal claim is its preview — that is where the pairing is established
  // (#1173 item 1). A bare live claim on an unpaired turn is covered below as `unpaired`.
  const r = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } },
    { sessionId: SESSION, nowMs: now + 1000, isPreview: true },
  );
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
  const { pairing_token } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } },
    { sessionId: SESSION, nowMs: now, isPreview: true },
  );
  // The case this protects is a real slow save, so prove it on the LIVE write at the exact edge.
  const r = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID, pairing_token } },
    { sessionId: SESSION, nowMs: now + tc.DEFAULT_MAX_AGE_MS, writeId: 'w-1' },
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

// ─── PREVIEW-ESTABLISHED PAIRING (#1173 item 1) ───────────────────────────────
//
// #1172 shipped first-write-wins: with no prior binding, a turn bound to whichever write
// correlated FIRST. That left the CLIENT choosing which write became "the authorized one",
// so a record established only "this turn exists in this session" — and worse, a turn id
// attached to the wrong same-session write LOCKED THE LEGITIMATE WRITE OUT, turning a client
// bug into LOST evidence rather than wrong evidence.
//
// The replacement: the PREVIEW establishes the pairing, and only the write that presents that
// preview's server-minted token may correlate. The prerequisite #1173 flagged was checked
// against src/app/app.js and the answer is NO — `write_id` is shared between preview and
// approve on exactly ONE of five write paths (/api/log-workout, app.js:6960 → 7506), is
// withheld from the dry-run by design on the two /api/complete-workout paths (app.js:7113),
// is minted only after the preview on modality and bodyweight (app.js:6133, 7790), and is
// DELIBERATELY RE-MINTED mid-flow on the documented seal retry even where it is shared
// (app.js:7563-7568). So the pairing key is a dedicated server-minted token, and the
// previewed write_id is recorded as corroborating evidence only, never as a gate.
//
// What these pin is the honest property — "this turn previewed this write, and this write
// presented that preview's token" — not cryptographic authorization, which no client
// round-trip can deliver.

const PREVIEW = { isPreview: true };

test('a preview establishes a pairing and mints an opaque server-owned token', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const r = tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1, isPreview: true });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
  assert.ok(tc.isWellFormedPairingToken(r.pairing_token), `token must be well-formed, got ${r.pairing_token}`);
  // The token is the whole point: it must not be derivable from the turn id the client
  // already holds from the response header.
  assert.ok(!r.pairing_token.includes(TURN_ID));
  assert.equal(r.pairing.established_at_preview, true);
  assert.equal(r.pairing.write_attempt, 0, 'a preview is not a write attempt');
});

test('a live write with NO established pairing is refused (unpaired) — first-write-wins is gone', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // Exactly the #1172 behaviour: a well-formed, fresh, same-session claim on a real write.
  // It used to bind and resolve ok. It must now be refused, because no preview established it.
  const r = tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1, writeId: 'w-1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unpaired');
  assert.equal(r.turn_id, null);
});

test('the live write presenting the preview\'s token correlates, and is stamped attempt 1', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const r = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID, pairing_token } },
    { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.turn_id, TURN_ID);
  assert.equal(r.pairing.write_attempt, 1);
});

test('a live write presenting a WRONG or absent token is refused (pairing_mismatch)', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW });

  const bad = [
    undefined,                              // the #1172 client: turn id only
    null,
    '',
    'pair:deadbeefdeadbeefdeadbeefdeadbeef', // well-formed but never minted
    'not-a-token',
    42,
    {},
    `pair:${'a'.repeat(4096)}`,              // unbounded → refused, never compared
  ];
  for (const pairing_token of bad) {
    const claim = { turn_id: TURN_ID };
    if (pairing_token !== undefined) claim.pairing_token = pairing_token;
    const r = tc.resolveCorrelation({ correlation: claim }, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' });
    assert.equal(r.ok, false, `token ${JSON.stringify(pairing_token)} must not resolve`);
    assert.equal(r.reason, 'pairing_mismatch', `token ${JSON.stringify(pairing_token)} → ${r.reason}`);
    assert.equal(r.turn_id, null);
  }
});

test('an idempotent retry of the SAME write still correlates, and does not advance the attempt', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const claim = { correlation: { turn_id: TURN_ID, pairing_token } };
  assert.equal(tc.resolveCorrelation(claim, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' }).ok, true);
  const retry = tc.resolveCorrelation(claim, { sessionId: SESSION, nowMs: now + 3, writeId: 'w-1' });
  assert.equal(retry.ok, true, 'the same logical write must not be silently dropped on retry');
  assert.equal(retry.pairing.write_attempt, 1, 'a replay of the same write_id is the same attempt');
});

test('the documented seal RETRY keeps its correlation — a fresh write_id is not a lockout', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const claim = { correlation: { turn_id: TURN_ID, pairing_token } };
  // First approval: rows commit, but closeout_fully_verified came back false.
  assert.equal(tc.resolveCorrelation(claim, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' }).ok, true);
  // app.js:7563-7568 re-mints the write_id and re-enables Save for the SAME staged write.
  // Under #1172's first-write-wins this was `write_mismatch` — the legitimate retry lost its
  // evidence. It must now correlate, and be visibly the SECOND attempt.
  const retry = tc.resolveCorrelation(claim, { sessionId: SESSION, nowMs: now + 3, writeId: 'w-2' });
  assert.equal(retry.ok, true, 'the seal retry must not be locked out');
  assert.equal(retry.pairing.write_attempt, 2, 'a reviewer must see this is a second write, not the first');
});

test('one pairing cannot be replayed without bound (pairing_exhausted)', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const claim = { correlation: { turn_id: TURN_ID, pairing_token } };
  for (let i = 0; i < tc.MAX_WRITES_PER_PAIRING; i += 1) {
    const r = tc.resolveCorrelation(claim, { sessionId: SESSION, nowMs: now + 2 + i, writeId: `w-${i}` });
    assert.equal(r.ok, true, `attempt ${i + 1} must resolve`);
  }
  const over = tc.resolveCorrelation(claim, { sessionId: SESSION, nowMs: now + 99, writeId: 'w-over' });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'pairing_exhausted');
  assert.equal(over.turn_id, null);
});

// Codex P2 on this PR (r3649520140). The first cut superseded the pairing on every preview,
// last-completion-wins. But two previews for the SAME turn can overlap, and the client keeps
// whichever response it considers newest by INITIATION order (`previewRequestSeq` / `submitSeq`,
// src/app/app.js:6416, 6881) — it discards a superseded response even if that response arrived
// last. So when the older request's handler finishes last, the registry held the older token
// while the client held the newer one, and the approved write lost its correlation to
// `pairing_mismatch`. The server cannot know the client's initiation order, so it must not
// pretend to: it keeps a BOUNDED SET of the turn's outstanding preview tokens instead.
//
// This costs nothing in claim strength: every outstanding pairing belongs to the SAME turn, and
// each is independently payload-bound, so accepting any of them cannot mis-attribute a write.

test('overlapping previews: the newer token survives even when the older request finishes last', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // Preview B (the one the client will keep) resolves first...
  const newer = tc.resolveCorrelation(payloadWith({ correlation: { turn_id: TURN_ID } }), { sessionId: SESSION, nowMs: now + 1, ...PREVIEW });
  // ...then preview A, initiated earlier, finishes late. It must not evict B.
  const older = tc.resolveCorrelation(payloadWith({ correlation: { turn_id: TURN_ID } }), { sessionId: SESSION, nowMs: now + 2, ...PREVIEW });
  assert.notEqual(newer.pairing_token, older.pairing_token, 'each preview mints its own pairing');

  const live = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID, pairing_token: newer.pairing_token } }),
    { sessionId: SESSION, nowMs: now + 3, writeId: 'w-1' },
  );
  assert.equal(live.ok, true, 'the token the client kept must still correlate');
});

test('outstanding pairings are bounded — the oldest is evicted, not kept forever', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const tokens = [];
  for (let i = 0; i < tc.MAX_OUTSTANDING_PAIRINGS + 1; i += 1) {
    tokens.push(tc.resolveCorrelation(
      payloadWith({ correlation: { turn_id: TURN_ID } }), { sessionId: SESSION, nowMs: now + i, ...PREVIEW },
    ).pairing_token);
  }
  // The oldest fell out of the window.
  const evicted = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID, pairing_token: tokens[0] } }),
    { sessionId: SESSION, nowMs: now + 50, writeId: 'w-1' },
  );
  assert.equal(evicted.ok, false);
  assert.equal(evicted.reason, 'pairing_mismatch');
  // Every one still in the bounded set works.
  for (const token of tokens.slice(1)) {
    const r = tc.resolveCorrelation(
      payloadWith({ correlation: { turn_id: TURN_ID, pairing_token: token } }),
      { sessionId: SESSION, nowMs: now + 51, writeId: 'w-1' },
    );
    assert.equal(r.ok, true, 'an outstanding pairing must still correlate');
  }
});

// ─── the payload gate: proving WHICH write, not merely "a write" (Codex P1) ────
//
// Codex P1 on this PR (r3649520130) refuted the first cut's headline claim, and it was right.
// A valid token attached to a DIFFERENT same-session live payload was accepted, and the only
// corroboration was a client-minted `previewedWriteId` that four of five write paths never send
// at preview. So the record established "this turn previewed something, and this write presented
// its token" while the module, plan and commit all claimed "this turn previewed THIS write".
//
// The fix is a SERVER-COMPUTED preview identity — a fingerprint of the write identity the server
// itself received at preview (session_id + date + log_rows) which the live payload must satisfy.
// It depends on nothing the client mints, so it holds on every route rather than one of five.
//
// Deliberately EXCLUDED from the identity: `write_id` (re-minted on the seal retry,
// app.js:7566), `effort_row` (deleted on that same retry, app.js:7567), and `test_mode` (the one
// field that always differs between a preview and its approve). Including any of them would
// refuse the legitimate retry — the lockout this whole item exists to remove.

test('a valid token on a DIFFERENT payload is refused (payload_mismatch)', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID } }), { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  // Same turn, same session, genuine token — but a different workout. This is the exact hole
  // Codex found: it used to resolve ok and record the wrong write against this turn.
  const other = payloadWith({
    correlation: { turn_id: TURN_ID, pairing_token },
    log_rows: [{ exercise: 'Squat', weight: 315, reps: 3, rir: 1, set_number: 1 }],
  });
  const r = tc.resolveCorrelation(other, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload_mismatch');
  assert.equal(r.turn_id, null);
});

test('a different date or session in the payload is also refused', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID } }), { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const shiftedDate = payloadWith({ correlation: { turn_id: TURN_ID, pairing_token }, date: '2026-07-26' });
  assert.equal(tc.resolveCorrelation(shiftedDate, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' }).reason, 'payload_mismatch');
});

test('the seal RETRY still matches — write_id, effort_row and test_mode are outside the identity', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // The preview carries test_mode, a write_id, and an effort row.
  const { pairing_token } = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID }, test_mode: 'true', write_id: 'w-1', effort_row: ['2026-07-25', SESSION, 3600] }),
    { sessionId: SESSION, nowMs: now + 1, isPreview: true, previewedWriteId: 'w-1' },
  );
  // The approve drops test_mode. The seal retry then re-mints write_id and deletes effort_row
  // (app.js:7566-7567). All three must be irrelevant to the identity, or the retry is locked out.
  const retry = payloadWith({ correlation: { turn_id: TURN_ID, pairing_token }, write_id: 'w-2' });
  const r = tc.resolveCorrelation(retry, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-2' });
  assert.equal(r.ok, true, 'the documented seal retry must never be locked out by the payload gate');
  assert.equal(r.pairing.payload_bound, true);
  assert.equal(r.pairing.previewed_write_id_match, false, 'and the re-mint is still visibly recorded');
});

test('the identity is insensitive to key order, so a re-serialized payload still matches', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID }, session_id: SESSION, date: '2026-07-25', log_rows: [{ exercise: 'Bench Press', weight: 225, reps: 5 }] },
    { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const reordered = {
    log_rows: [{ reps: 5, exercise: 'Bench Press', weight: 225 }],
    date: '2026-07-25',
    session_id: SESSION,
    correlation: { pairing_token, turn_id: TURN_ID },
  };
  assert.equal(tc.resolveCorrelation(reordered, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' }).ok, true);
});

test('a preview with no computable identity binds UNBOUND, and never claims otherwise', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // A route whose payload carries no log_rows identity (the seam is wired only to
  // /api/log-workout today; this is the honest degradation for anything else).
  const { pairing_token, pairing } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID }, session_id: SESSION },
    { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  assert.equal(pairing.payload_bound, false, 'an unbound pairing must say so at preview');

  const r = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID, pairing_token }, session_id: SESSION },
    { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' },
  );
  // It still correlates — a turn-level join is real evidence — but the record must never
  // report payload_bound:true, because nothing checked which write this was.
  assert.equal(r.ok, true);
  assert.equal(r.pairing.payload_bound, false, 'absent a payload gate the record must under-claim');
});

test('a pairing is refused across sessions and past the freshness window', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const claim = { correlation: { turn_id: TURN_ID, pairing_token } };

  // A valid token is NOT a bypass of the earlier gates: session and freshness still decide
  // first, so a leaked token cannot contaminate another session or revive a dead turn.
  const cross = tc.resolveCorrelation(claim, { sessionId: OTHER_SESSION, nowMs: now + 2, writeId: 'w-1' });
  assert.equal(cross.ok, false);
  assert.equal(cross.reason, 'session_mismatch');

  const late = tc.resolveCorrelation(claim, { sessionId: SESSION, nowMs: now + tc.DEFAULT_MAX_AGE_MS + 1, writeId: 'w-1' });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'stale');
});

test('a re-preview cannot keep a turn alive past its own freshness window', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // Establishing a pairing must not refresh the turn's issuance anchor — otherwise a client
  // could preview in a loop and correlate a write to a conversation that had moved on.
  const late = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } },
    { sessionId: SESSION, nowMs: now + tc.DEFAULT_MAX_AGE_MS + 1, ...PREVIEW },
  );
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'stale');
});

test('a preview claim is still subject to every earlier gate', () => {
  reset();
  const now = 1_000_000;
  // Never issued.
  assert.equal(tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now, ...PREVIEW }).reason, 'unknown');
  // Malformed.
  assert.equal(tc.resolveCorrelation({ correlation: { turn_id: 'nope' } }, { sessionId: SESSION, nowMs: now, ...PREVIEW }).reason, 'malformed');
  // Wrong session.
  tc.issueTurn(TURN_ID, OTHER_SESSION, { nowMs: now });
  assert.equal(tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now, ...PREVIEW }).reason, 'session_mismatch');
  // And none of those may leave a pairing behind that a later write could claim.
  assert.equal(tc.resolveCorrelation({ correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1, writeId: 'w-1' }).ok, false);
});

test('first-write-wins is retired, not merely bypassed', () => {
  // The reason it produced no longer exists, so no caller can fall back to it.
  assert.equal(tc.REASONS.WRITE_MISMATCH, undefined);
  assert.ok(!Object.values(tc.REASONS).includes('write_mismatch'));
});

// ─── the previewed write_id: recorded evidence, never a gate ──────────────────

test('the previewed write_id corroborates the approve without ever gating it', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // /api/log-workout is the one path whose dry-run really carries the write_id it will
  // later approve with (app.js:6960 → 7506), so the server can corroborate the pairing.
  const { pairing_token } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } },
    { sessionId: SESSION, nowMs: now + 1, isPreview: true, previewedWriteId: 'w-1' },
  );
  const claim = { correlation: { turn_id: TURN_ID, pairing_token } };

  const matched = tc.resolveCorrelation(claim, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' });
  assert.equal(matched.ok, true);
  assert.equal(matched.pairing.previewed_write_id_match, true);

  // The seal retry's fresh write_id is recorded as a NON-match — and still correlates,
  // because corroboration is evidence for the reviewer, not a gate.
  const remint = tc.resolveCorrelation(claim, { sessionId: SESSION, nowMs: now + 3, writeId: 'w-2' });
  assert.equal(remint.ok, true, 'a non-matching write_id must never cost the correlation');
  assert.equal(remint.pairing.previewed_write_id_match, false);
});

test('a preview that carried no write_id reports the match as unknown, never as true', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // The four other write paths: the dry-run carries no write_id at all.
  const { pairing_token } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const r = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID, pairing_token } },
    { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.pairing.previewed_write_id_match, null, 'absent evidence must read null, never true');
});

// ─── the record carries the binding, so a reviewer can see it was preview-established ──

test('buildWriteProofRecord: carries the server-owned pairing block, and only scalars', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID,
    sessionId: SESSION,
    route: '/api/log-workout',
    proof: { sheet_write: 'success', sheet_written: true },
    pairing: {
      established_at_preview: true,
      write_attempt: 2,
      previewed_write_id_match: false,
      payload_bound: true,
      // Server-owned or not, anything unrecognised or non-scalar is dropped.
      token: 'pair:deadbeefdeadbeefdeadbeefdeadbeef',
      identity: 'a1b2c3d4e5f6',
      nested: { rows: [['Bench Press', 225]] },
    },
  });
  assert.equal(record.pairing.established_at_preview, true);
  assert.equal(record.pairing.write_attempt, 2);
  assert.equal(record.pairing.previewed_write_id_match, false);
  assert.equal(record.pairing.payload_bound, true);
  // The identity fingerprint is derived from workout content — it stays internal, exactly like
  // the token, so neither the log nor the artifact ever carries it.
  assert.ok(!('identity' in record.pairing), 'the payload fingerprint must never reach the record');
  assert.ok(!JSON.stringify(record).includes('a1b2c3d4e5f6'));
  // The token is a live capability for the rest of the window — it must never be logged.
  assert.ok(!('token' in record.pairing), 'the pairing token must never reach the record');
  assert.ok(!('nested' in record.pairing));
  assert.ok(!JSON.stringify(record).includes('deadbeef'), 'no token material in the record');
  assert.ok(!JSON.stringify(record).includes('Bench Press'));
});

test('buildWriteProofRecord: an unpaired record can never claim it was preview-established', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID,
    sessionId: SESSION,
    route: '/api/log-workout',
    proof: { sheet_written: true },
  });
  // No pairing evidence ⇒ every flag must read its under-claiming default, never true and
  // never absent-so-assumed.
  assert.equal(record.pairing.established_at_preview, false);
  assert.equal(record.pairing.write_attempt, 0);
  assert.equal(record.pairing.previewed_write_id_match, null);
  assert.equal(record.pairing.payload_bound, false);
});

// ─── the pairing token's own shape gate ───────────────────────────────────────

test('isWellFormedPairingToken: accepts only the minted shape, bounded', () => {
  reset();
  tc.issueTurn(TURN_ID, SESSION, { nowMs: 1 });
  const { pairing_token } = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID } }, { sessionId: SESSION, nowMs: 2, isPreview: true },
  );
  assert.equal(tc.isWellFormedPairingToken(pairing_token), true);
  for (const bad of [
    null, undefined, '', '   ', 42, {}, [],
    'pair:', 'pair:xyz', 'pair:DEADBEEFDEADBEEFDEADBEEFDEADBEEF', // uppercase is not the minted shape
    'turn:2026-07-25T00:00:00.000Z_1_ab12cd',                      // a turn id is not a token
    `pair:${'0'.repeat(31)}`, `pair:${'0'.repeat(33)}`,            // wrong length
    `pair:${'0'.repeat(32)} `,
  ]) {
    assert.equal(tc.isWellFormedPairingToken(bad), false, `${JSON.stringify(bad)} must not be well-formed`);
  }
});

test('the pairing registry stays bounded — a pairing rides its turn entry and dies with it', () => {
  reset();
  const now = 1_000_000;
  for (let i = 0; i < tc.MAX_ENTRIES + 50; i += 1) {
    const id = `turn:2026-07-25T00:00:00.000Z_${i}_abcdef`;
    tc.issueTurn(id, SESSION, { nowMs: now + i });
    tc.resolveCorrelation({ correlation: { turn_id: id } }, { sessionId: SESSION, nowMs: now + i, isPreview: true });
  }
  assert.ok(tc._sizeForTesting() <= tc.MAX_ENTRIES, `registry must stay capped, got ${tc._sizeForTesting()}`);
});
