'use strict';

// Turn-correlation SESSION RESOLUTION — the capture-creation shape, wired client↔server.
//
// The defect (filed from rehearsal run fsb4b-s1-20261028T161326-AB4F5C, Session 1
// FAIL 24/25, trace_write_join "1 traces, 0 proofs"): PR #1328 fixed capture
// RETENTION — a captured turn is no longer erased by a later no-response completion.
// This run lost the join one link earlier: no capture was ever CREATED. Every
// set-logged handler was revoked at the responseMayContinue() gate or
// watchdog-cancelled before it could dispatch a coach call, so the client held no
// turn to claim at the closeout preview, no pairing was minted, and a successful,
// closeout-verified write emitted no [turn-write-proof]. The passing run cleared
// the same cadence by ~26–100 ms margins; whether the join held was a race.
//
// Two links are repaired here, and this file pins both against the REAL modules:
//
//   1. CAPTURE LANDING (client). A turn ticket that is revoked by a newer
//      submission before its response lands can never complete authoritatively,
//      and its presented response — real coaching the athlete saw, carrying a
//      server-issued turn id — was dropped entirely. Such a completion now FILLS
//      the session's claimable turn when the session holds none. It never
//      overwrites a capture, never disturbs an active preview, and never
//      resurrects a turn a presented turnless response deliberately retired.
//
//   2. SESSION RESOLUTION (server). When the client holds no captured turn at
//      preview, it may ask the server to resolve the claim against the latest
//      turn the SERVER ITSELF registered for that exact session. The registry —
//      not the client — remains the authority: resolution can only ever name a
//      turn this server issued, for this session, inside the same freshness
//      window, and the pairing it mints is payload-bound exactly like a claimed
//      one. A session with no registered turn resolves to nothing.
//
// REPAIR (post-review, hosted E2E): resolution as first shipped was a BLANKET
// fallback — beginPreview staged resolve_latest_turn whenever the client held
// no capture. That broke the pending-clarification contract pinned by
// tests/e2e/pending-clarification-resolve.spec.js (UNMODIFIED): when set
// coaching FAILED, or when no coach interaction ever happened (a stalled
// pre-message recommendation; deterministic logging only), the closeout
// preview and write must carry NO correlation — and in the failed shape a
// blanket claim could attribute a write to a turn whose coaching failed,
// which the claimed path can never do. Resolution is therefore GATED on
// positive client-side evidence that a coach response was actually PRESENTED
// in the session (coachResponsePresented, recorded by completeTurnResponse
// whenever a completion carries response headers, and by every capture/fill).
// A failed coach call completes its ticket with NO response (the caller's
// finally passes null) and a stalled lane never completes with a response at
// all, so neither records evidence and neither can resolve. The pins below
// that assumed blanket resolution were re-scoped to establish that evidence
// first, through the same revoked-completion point the chat lane uses; the
// diagnosed run itself is pinned end to end in the final test, where the
// presented tips response lands through the FILL and is claimed directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The write-proof record is shadow-gated like the packet/trace shadow; the join this
// file proves exists only with the shadow on.
process.env.ATLAS_INTERACTION_TRACE = 'shadow';

const server = require('../services/turnCorrelation');
const { logCleanedColumns } = require('../config/columns');

const ROOT = path.join(__dirname, '..');
const CLIENT_PATH = path.join(ROOT, 'src', 'app', 'turnCorrelation.js');

async function loadClient() {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}-${Math.random()}`);
}

const TURN_A = 'turn:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TURN_B = 'turn:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// The diagnosed run's tips turn, as registered server-side at
// 2026-10-28T16:14:17.881Z (interaction trace in the run's server log).
const TURN_TIPS = 'turn:2026-10-28T16:14:13.992Z_2_xu3lk8';
const SESSION_A = '20261028-PM-04';
const SESSION_B = '20261028-PM-05';
const PROVISIONAL = '20261028-PM-03';
const WRITE_ID = 'write-session-resolution-1';

function deterministicIds() {
  let n = 0;
  return () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function headersFrom(map) {
  return {
    get(name) {
      const key = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
    },
  };
}

function fakeResponse() {
  return {
    headersSent: false,
    _h: {},
    setHeader(k, v) { this._h[String(k).toLowerCase()] = v; },
  };
}

function logRow(sessionId) {
  const row = new Array(logCleanedColumns.length).fill('');
  row[logCleanedColumns.indexOf('session_id')] = sessionId || SESSION_A;
  return row;
}

function writePayload(correlation, sessionId) {
  const sid = sessionId || SESSION_A;
  return {
    session_id: sid,
    date: '2026-10-28',
    log_rows: [logRow(sid)],
    correlation,
  };
}

// Present a coach response in the session WITHOUT landing a capture: the
// response's ticket is revoked by a newer submission before it completes (the
// chat lane's exact shape — getChatReply completes the ticket after its
// response lands, whenever that is), and the response carries no turn id to
// capture (the /api/coach/ask shape in getChatReply, which completes the
// ticket with smeHeaders that may carry no turn id at all). The completion
// records presented-response evidence and nothing else: no fill, no capture,
// no block. This is the minimum honest setup for a resolution preview under
// the gated design — a session that never presented a response cannot use it
// (see the gating pins at the end of this file).
async function presentRevokedTurnlessResponse(client, sessionId) {
  const presented = client.beginTurnResponse({ sessionId });
  const revoker = client.beginTurnResponse({ sessionId });
  assert.equal(client.completeTurnResponse(revoker, null), false);
  assert.equal(client.completeTurnResponse(presented, headersFrom({})), false);
}

// Drive one full preview → mint → approve → write round-trip and assert the proof.
async function assertWriteProves(client, preview, sessionId) {
  const sid = sessionId || SESSION_A;
  const previewResolution = server.resolveCorrelation(writePayload(preview.correlation, sid), {
    sessionId: sid,
    isPreview: true,
    writeId: WRITE_ID,
    previewedWriteId: WRITE_ID,
  });
  assert.equal(previewResolution.ok, true, `preview claim must resolve (got ${previewResolution.reason})`);
  assert.match(previewResolution.pairing_token, /^pair:[a-f0-9]{32}$/);

  const pairingRes = fakeResponse();
  server.attachPairingToResponse(pairingRes, previewResolution.pairing_token, previewResolution.turn_id);
  assert.equal(client.completePreview(preview, headersFrom(pairingRes._h)), true);

  const claim = client.approvalClaim(preview);
  assert.ok(claim, 'the approval must carry the staged preview claim');
  const liveResolution = server.resolveCorrelation(writePayload(claim, sid), {
    sessionId: sid,
    writeId: WRITE_ID,
  });
  assert.equal(liveResolution.ok, true, `live claim must resolve (got ${liveResolution.reason})`);
  assert.equal(liveResolution.pairing.payload_bound, true);

  const record = server.recordWriteProof({
    turnId: liveResolution.turn_id,
    sessionId: sid,
    route: '/api/log-workout',
    proof: { test_mode: false, sheet_write: 'success', write_id: WRITE_ID },
    pairing: liveResolution.pairing,
  });
  assert.ok(record, 'the write must emit its turn-write-proof record');
  assert.equal(record.pairing.established_at_preview, true);
  return record;
}

test('creation: a coach response revoked before completion still lands its turn when the session holds none', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  // The coach turn opens server-side and its id rides the response header back.
  const coachRes = fakeResponse();
  assert.equal(server.attachTurnToResponse(coachRes, TURN_A, SESSION_A), TURN_A);

  // The athlete keeps logging while the coach response is in flight: the next
  // set-logged submission revokes the chat ticket's authority, then settles with
  // no selected response of its own.
  const chatTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  const setTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(setTicket, null), false);

  // The presented coach response now completes, but its ticket is no longer
  // authoritative, so it is NOT accepted as the selected response. On the shipped
  // client its turn was dropped with it — the session reached closeout holding
  // nothing at all (diagnostic snapshot empty, preview null).
  assert.equal(client.completeTurnResponse(chatTicket, headersFrom(coachRes._h)), false);

  // The response WAS presented, so its turn lands as the session's claimable
  // state, and the closeout write proves against it end to end.
  const preview = client.beginPreview({ sessionId: SESSION_A });
  assert.ok(preview, 'the closeout preview must have the landed turn to claim');
  assert.equal(preview.turnId, TURN_A);
  const record = await assertWriteProves(client, preview);
  assert.equal(record.turn_id, TURN_A);

  server._resetForTesting();
});

test('creation: a revoked completion never overwrites a capture or disturbs an active preview', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  // An accepted interaction captures TURN_A and a preview is minted from it.
  const coachTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(coachTicket, headersFrom({ 'x-atlas-turn-id': TURN_A })), true);
  const preview = client.beginPreview({ sessionId: SESSION_A });
  const pairingRes = fakeResponse();
  server.issueTurn(TURN_A, SESSION_A);
  const minted = server.resolveCorrelation(writePayload(preview.correlation), {
    sessionId: SESSION_A, isPreview: true, writeId: WRITE_ID, previewedWriteId: WRITE_ID,
  });
  assert.equal(minted.ok, true);
  server.attachPairingToResponse(pairingRes, minted.pairing_token, minted.turn_id);
  assert.equal(client.completePreview(preview, headersFrom(pairingRes._h)), true);

  // A later coach response is revoked by a set-logged submission and completes
  // late, carrying a DIFFERENT turn. The fill must not touch the capture the
  // active preview was minted from.
  const lateTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  const setTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(setTicket, null), false);
  assert.equal(client.completeTurnResponse(lateTicket, headersFrom({ 'x-atlas-turn-id': TURN_B })), false);
  assert.deepEqual(client.approvalClaim(preview), {
    turn_id: TURN_A,
    initiation_nonce: preview.initiation_nonce,
    pairing_token: minted.pairing_token,
  }, 'the active preview must keep its claim across a revoked late completion');

  // And with the preview retired, the capture is still TURN_A — the revoked
  // completion did not replace it behind the preview's back either.
  assert.equal(client.retirePreview(preview), true);
  const next = client.beginPreview({ sessionId: SESSION_A });
  assert.equal(next.turnId, TURN_A);

  server._resetForTesting();
});

test('creation: a revoked completion cannot resurrect a turn a presented turnless response retired', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  const coachTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(coachTicket, headersFrom({ 'x-atlas-turn-id': TURN_A })), true);

  // A stale coach response is still in flight when a NEWER selected response
  // presents and establishes no turn — the designed erasure: the conversation
  // has moved past every earlier turn.
  const staleTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  const newerTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(newerTicket, headersFrom({})), false);

  // The stale response now lands, revoked, carrying its old turn. Resurrecting
  // it would let closeout claim exactly the superseded turn the erasure retired.
  assert.equal(client.completeTurnResponse(staleTicket, headersFrom({ 'x-atlas-turn-id': TURN_B })), false);
  assert.equal(client.beginPreview({ sessionId: SESSION_A }), null,
    'a deliberately retired session must produce neither a claimed nor a resolved preview');

  server._resetForTesting();
});

test('resolution: a session with only set-logged tickets claims the server latest turn at preview and the write proves', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  // A coach turn happened server-side (the tips question) and was registered
  // for this session. The client never captured it: every lane that could have
  // committed the capture was a set-logged ticket settling with no response.
  const coachRes = fakeResponse();
  assert.equal(server.attachTurnToResponse(coachRes, TURN_A, SESSION_A), TURN_A);
  const setTicketA = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(setTicketA, null), false);
  const setTicketB = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.cancelTurnResponse(setTicketB), true);
  assert.deepEqual(client.diagnosticSnapshot(), [], 'the client holds no turn state at all');

  // RE-SCOPED (gated resolution): the original pin staged a resolution preview
  // from this capture-less, response-less state — the blanket fallback the
  // pending-clarification contract forbids. Resolution now requires evidence
  // that a coach response was presented in this session, so the chain gains
  // the one link the contract permits: a coach response WAS presented here
  // (revoked before completion, carrying no turn to capture — the SME/chat
  // shape), which records evidence but still no capture.
  await presentRevokedTurnlessResponse(client, SESSION_A);
  assert.deepEqual(client.diagnosticSnapshot(), [{
    session_id: SESSION_A, turn_id: null, active_initiation: null, retired_count: 0,
  }], 'presented evidence is recorded, but the client still holds no turn to claim');

  // The closeout preview therefore asks the server to resolve the session's
  // authoritative turn state instead of presenting a capture it does not hold.
  const preview = client.beginPreview({ sessionId: SESSION_A });
  assert.ok(preview, 'a capture-less session must still be able to stage a preview');
  assert.equal(preview.turnId, null, 'no turn is claimed before the server answers');
  assert.equal(preview.correlation.turn_id, undefined);
  assert.equal(preview.correlation.resolve_latest_turn, true);

  // The server resolves its own latest registration, mints the pairing, and the
  // client adopts the echoed turn — the write then proves, payload-bound.
  const record = await assertWriteProves(client, preview);
  assert.equal(record.turn_id, TURN_A);
  assert.equal(preview.turnId, TURN_A, 'the preview adopts the server-resolved turn');
  assert.ok(server.recentWriteProofs().some(r => r.turn_id === TURN_A && r.route === '/api/log-workout'));

  server._resetForTesting();
});

test('resolution: the latest registered turn wins, and a stale latest turn fails closed', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  const T0 = 1_700_000_000_000;
  server.issueTurn(TURN_A, SESSION_A, { nowMs: T0 });
  server.issueTurn(TURN_B, SESSION_A, { nowMs: T0 + 60_000 });

  // RE-SCOPED (gated resolution): a presented coach response establishes the
  // evidence the resolution preview requires; the server-side selection and
  // staleness semantics below are unchanged.
  await presentRevokedTurnlessResponse(client, SESSION_A);
  const preview = client.beginPreview({ sessionId: SESSION_A });
  const resolved = server.resolveCorrelation(writePayload(preview.correlation), {
    sessionId: SESSION_A, isPreview: true, writeId: WRITE_ID, nowMs: T0 + 120_000,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.turn_id, TURN_B, 'resolution names the session latest turn, never an older one');

  // The latest turn is also the FRESHEST: if it is stale, every turn for the
  // session is staler, so resolution fails closed instead of reaching back.
  server._resetForTesting();
  server.issueTurn(TURN_A, SESSION_A, { nowMs: T0 });
  const stale = server.resolveCorrelation(
    writePayload({ resolve_latest_turn: true, initiation_nonce: 'init:00000001-0000-4000-8000-000000000000' }),
    { sessionId: SESSION_A, isPreview: true, nowMs: T0 + server.DEFAULT_MAX_AGE_MS + 1 },
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');

  server._resetForTesting();
});

test('resolution: a capture landing mid-preview supersedes the resolution preview', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();
  server.issueTurn(TURN_A, SESSION_A);
  server.issueTurn(TURN_B, SESSION_A);

  // RE-SCOPED (gated resolution): presented-response evidence first, as in
  // every resolution pin — the supersession semantics below are unchanged.
  await presentRevokedTurnlessResponse(client, SESSION_A);
  const preview = client.beginPreview({ sessionId: SESSION_A });
  assert.equal(preview.correlation.resolve_latest_turn, true);

  // A real coach interaction lands while the resolution preview is in flight:
  // its capture is newer authority than a pending resolution, exactly as it is
  // over a claimed preview.
  const coachTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(coachTicket, headersFrom({ 'x-atlas-turn-id': TURN_B })), true);
  const pairingRes = fakeResponse();
  server.attachPairingToResponse(pairingRes, `pair:${'a'.repeat(32)}`, TURN_A);
  assert.equal(client.completePreview(preview, headersFrom(pairingRes._h)), false,
    'a superseded resolution preview cannot complete');
  assert.equal(client.approvalClaim(preview), null);

  const claimed = client.beginPreview({ sessionId: SESSION_A });
  assert.equal(claimed.turnId, TURN_B);

  server._resetForTesting();
});

test('resolution: attacks stay rejected', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();
  server.issueTurn(TURN_A, SESSION_A);
  const NONCE = 'init:00000001-0000-4000-8000-000000000000';
  const resolutionClaim = { resolve_latest_turn: true, initiation_nonce: NONCE };

  // Cross-session: turns exist, but none for THIS session.
  const cross = server.resolveCorrelation(writePayload(resolutionClaim, SESSION_B), {
    sessionId: SESSION_B, isPreview: true, writeId: WRITE_ID,
  });
  assert.equal(cross.ok, false, 'resolution is scoped to the exact session');

  // No registered turn anywhere for the session: nothing to resolve.
  server._resetForTesting();
  const none = server.resolveCorrelation(writePayload(resolutionClaim), {
    sessionId: SESSION_A, isPreview: true, writeId: WRITE_ID,
  });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'unknown');
  server.issueTurn(TURN_A, SESSION_A);

  // A live write can never resolve: it must present a token its preview minted.
  const live = server.resolveCorrelation(writePayload(resolutionClaim), {
    sessionId: SESSION_A, writeId: WRITE_ID,
  });
  assert.equal(live.ok, false);
  assert.equal(live.reason, 'malformed');

  // The marker is exact: a string "true" is not a resolution claim.
  const stringMarker = server.resolveCorrelation(
    writePayload({ resolve_latest_turn: 'true', initiation_nonce: NONCE }),
    { sessionId: SESSION_A, isPreview: true, writeId: WRITE_ID },
  );
  assert.equal(stringMarker.ok, false);
  assert.equal(stringMarker.reason, 'malformed');

  // A claim that NAMES a turn is judged as a claim, marker or not: a fabricated
  // id resolves to nothing, and the genuine id mints through the claimed path.
  const forged = server.resolveCorrelation(
    writePayload({ turn_id: TURN_B, resolve_latest_turn: true, initiation_nonce: NONCE }),
    { sessionId: SESSION_A, isPreview: true, writeId: WRITE_ID },
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.reason, 'unknown');
  const claimed = server.resolveCorrelation(
    writePayload({ turn_id: TURN_A, resolve_latest_turn: true, initiation_nonce: NONCE }),
    { sessionId: SESSION_A, isPreview: true, writeId: WRITE_ID, previewedWriteId: WRITE_ID },
  );
  assert.equal(claimed.ok, true, 'a named turn takes the claimed path; the marker is ignored');

  // The provisional registration is reachable only through the explicit
  // preview-session-resolution gate — never by merely naming it.
  server._resetForTesting();
  server.issueTurn(TURN_A, PROVISIONAL);
  const ungated = server.resolveCorrelation(
    writePayload({ ...resolutionClaim, provisional_session_id: PROVISIONAL }),
    { sessionId: SESSION_A, isPreview: true, writeId: WRITE_ID },
  );
  assert.equal(ungated.ok, false, 'an ungated provisional name resolves nothing');

  // Client side: a resolution preview whose response carries a token but no
  // turn to adopt can never complete or be claimed. (RE-SCOPED for the gate:
  // the preview is staged from presented-response evidence, not from nothing.)
  await presentRevokedTurnlessResponse(client, SESSION_A);
  const preview = client.beginPreview({ sessionId: SESSION_A });
  assert.ok(preview && preview.correlation.resolve_latest_turn === true);
  assert.equal(client.completePreview(preview, headersFrom({ 'x-atlas-turn-pairing': `pair:${'b'.repeat(32)}` })), false);
  assert.equal(client.approvalClaim(preview), null);

  server._resetForTesting();
});

test('resolution: the provisional handshake mints through the existing adoption gate and rebinds the turn', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  // The session's coach turn was registered under the provisional id the
  // conversation ran under; the write payload's session is the server-allocated
  // identity the preview resolves to.
  server.issueTurn(TURN_A, PROVISIONAL);

  // RE-SCOPED (gated resolution): the provisional session also needs
  // presented-response evidence before its preview may resolve.
  await presentRevokedTurnlessResponse(client, PROVISIONAL);
  const preview = client.beginPreview({
    sessionId: PROVISIONAL,
    provisionalSessionId: PROVISIONAL,
  });
  assert.ok(preview);
  assert.equal(preview.correlation.resolve_latest_turn, true);
  assert.equal(preview.correlation.provisional_session_id, PROVISIONAL);

  const resolved = server.resolveCorrelation(writePayload(preview.correlation, SESSION_A), {
    sessionId: SESSION_A,
    isPreview: true,
    writeId: WRITE_ID,
    previewedWriteId: WRITE_ID,
    allowPreviewSessionResolution: true,
  });
  assert.equal(resolved.ok, true, `provisional resolution must mint (got ${resolved.reason})`);
  assert.equal(resolved.turn_id, TURN_A);

  // The turn is now bound to the resolved session: the client migrates its
  // staged preview and the live write under the resolved identity proves.
  const pairingRes = fakeResponse();
  server.attachPairingToResponse(pairingRes, resolved.pairing_token, resolved.turn_id);
  assert.equal(client.completePreview(preview, headersFrom(pairingRes._h)), true);
  assert.equal(client.resolvePreviewSession(preview, SESSION_A), true);
  const claim = client.approvalClaim(preview);
  assert.ok(claim);
  const live = server.resolveCorrelation(writePayload(claim, SESSION_A), {
    sessionId: SESSION_A, writeId: WRITE_ID,
  });
  assert.equal(live.ok, true, `the rebound write must resolve (got ${live.reason})`);
  assert.equal(live.pairing.payload_bound, true);

  server._resetForTesting();
});

test('resolution: a migrated-away provisional session cannot resolve, and an erased session cannot either', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  // A claimed preview migrates from the provisional id to the resolved one:
  // the vacated id must not go fishing for turns afterwards.
  client.captureTurn({ sessionId: PROVISIONAL, turnId: TURN_A });
  const preview = client.beginPreview({
    sessionId: PROVISIONAL,
    provisionalSessionId: PROVISIONAL,
  });
  const pairingRes = fakeResponse();
  server.issueTurn(TURN_A, PROVISIONAL);
  const minted = server.resolveCorrelation(writePayload(preview.correlation, PROVISIONAL), {
    sessionId: PROVISIONAL, isPreview: true, writeId: WRITE_ID, previewedWriteId: WRITE_ID,
  });
  assert.equal(minted.ok, true);
  server.attachPairingToResponse(pairingRes, minted.pairing_token, minted.turn_id);
  assert.equal(client.completePreview(preview, headersFrom(pairingRes._h)), true);
  assert.equal(client.resolvePreviewSession(preview, SESSION_A), true);
  assert.equal(client.beginPreview({ sessionId: PROVISIONAL }), null,
    'the vacated provisional session retains no capability — claimed or resolved');

  // A session whose capture was retired by a presented turnless response is
  // likewise closed to resolution, even though the server still holds its turn.
  const erased = createTurnCorrelation({ randomUUID: deterministicIds() });
  const coachTicket = erased.beginTurnResponse({ sessionId: SESSION_B });
  assert.equal(erased.completeTurnResponse(coachTicket, headersFrom({ 'x-atlas-turn-id': TURN_B })), true);
  const turnless = erased.beginTurnResponse({ sessionId: SESSION_B });
  assert.equal(erased.completeTurnResponse(turnless, headersFrom({})), false);
  assert.equal(erased.beginPreview({ sessionId: SESSION_B }), null,
    'a deliberately retired capture blocks resolution as it blocks claiming');

  server._resetForTesting();
});

test('gating: failed set coaching presents no coach response — no fill, no resolution, no preview', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  // The pending-clarification spec's failed-coaching shape, at module level:
  // the set-logged handler's /api/coach/message call FAILED (503). In
  // getLlmCoachingMessage the rejected request never reaches the
  // completeTurnResponse call inside that function — the ticket is completed
  // only by the atlas:set-logged listener's finally, with NO response (null).
  // Nothing was presented, so nothing may be claimed or resolved, even though
  // this pin registers a server turn for the session to prove the block is
  // the client gate, not the server's ignorance.
  server.issueTurn(TURN_A, SESSION_A);
  const setTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(setTicket, null), false);
  assert.deepEqual(client.diagnosticSnapshot(), [], 'a no-response completion creates no session state');
  assert.equal(client.beginPreview({ sessionId: SESSION_A }), null,
    'a session whose only coach call failed stages no correlation at preview');

  // The same shape when an error response IS the selected response: it
  // presents no turn, so it fills nothing and — as a presented turnless
  // completion on a session holding a capture — it retires claimability
  // instead of opening resolution.
  const clientB = createTurnCorrelation({ randomUUID: deterministicIds() });
  clientB.captureTurn({ sessionId: SESSION_B, turnId: TURN_B });
  const errorTicket = clientB.beginTurnResponse({ sessionId: SESSION_B });
  assert.equal(clientB.completeTurnResponse(errorTicket, headersFrom({})), false);
  assert.equal(clientB.beginPreview({ sessionId: SESSION_B }), null,
    'a presented error/no-turn response retires the session; it never opens resolution');

  server._resetForTesting();
});

test('gating: a stalled pre-message lane presents nothing — closeout stages no correlation', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  // The spec's stalled shape: the set-logged handler stalls in the
  // recommendation read that precedes /api/coach/message, so NO coach call
  // ever happens (messageCalls stays 0). The handler's ticket is settled only
  // by the watchdog cancel and by later handlers' null completions — every
  // completion presents no response. A server-registered turn (registered
  // here deliberately) is not enough: with no presented response in the
  // session, the gate keeps the preview uncorrelated.
  server.issueTurn(TURN_A, SESSION_A);
  const stalled = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.cancelTurnResponse(stalled), true, 'the watchdog settles the stalled ticket');
  const later = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(later, null), false);
  assert.deepEqual(client.diagnosticSnapshot(), [], 'no presented response, no session state');
  assert.equal(client.beginPreview({ sessionId: SESSION_A }), null,
    'a session with no presented coach response stages no correlation at preview');

  server._resetForTesting();
});

test('diagnosed chain: the tips chat turn, revoked by set-logged dispatches, lands by fill and the write proves', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  // Run fsb4b-s1-20261028T161326-AB4F5C, traced from code (see PR body):
  // the session's one completed coach interaction was the tips question via
  // the CHAT lane. That lane is ticketed, not a direct capture: the
  // atlas:chat-message listener (coach-conversation.js) begins a turn ticket,
  // getChatReply races /api/coach/ask first (13 ms, no usable answer, ticket
  // NOT completed there) and then completes the ticket with the
  // /api/coach/chat response headers when that call returns. The server
  // registered the turn when the chat call completed (16:14:17.881).
  const chatRes = fakeResponse();
  assert.equal(server.attachTurnToResponse(chatRes, TURN_TIPS, SESSION_A), TURN_TIPS);
  const chatTicket = client.beginTurnResponse({ sessionId: SESSION_A });

  // While /api/coach/chat was in flight (16:14:13.992–16:14:17.881), an
  // Incline DB Press set-logged dispatch began its own ticket (its
  // /api/recommend/next reaction read starts at 16:14:14.089 in the server
  // log), revoking the chat ticket's authority. That handler then died at
  // the responseMayContinue gate — it never dispatched a coach call — and
  // its ticket settled with no response.
  const inclineTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(inclineTicket, null), false);

  // The chat response now completes, revoked: not accepted as the selected
  // response, but it WAS presented (the athlete read the tips), so its turn
  // lands as the session's claimable state through the fill.
  assert.equal(client.completeTurnResponse(chatTicket, headersFrom(chatRes._h)), false);
  assert.deepEqual(client.diagnosticSnapshot(), [{
    session_id: SESSION_A, turn_id: TURN_TIPS, active_initiation: null, retired_count: 0,
  }], 'the presented tips turn is the session claimable state');

  // The subsequent Seated Row and Bicep Curl set-logged events each begin a
  // ticket and settle it with no response (revoked at the gate, or
  // watchdog-cancelled during the Sheets 429 storm; the run's server log
  // holds zero /api/coach/message calls). Under #1328 semantics those null
  // completions retire only their own tickets — the filled turn survives.
  const seatedTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(seatedTicket, null), false);
  const bicepTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.cancelTurnResponse(bicepTicket), true);

  // Closeout: the preview CLAIMS the filled tips turn directly — no
  // resolution marker is involved — and the write emits its proof.
  const preview = client.beginPreview({ sessionId: SESSION_A });
  assert.ok(preview, 'the closeout preview must claim the filled tips turn');
  assert.equal(preview.turnId, TURN_TIPS);
  assert.equal(preview.correlation.turn_id, TURN_TIPS);
  assert.equal(preview.correlation.resolve_latest_turn, undefined);
  const record = await assertWriteProves(client, preview);
  assert.equal(record.turn_id, TURN_TIPS);
  assert.ok(server.recentWriteProofs().some(r => r.turn_id === TURN_TIPS && r.route === '/api/log-workout'));

  server._resetForTesting();
});
