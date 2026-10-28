'use strict';

// Turn-correlation RETENTION — the deterministic-logging shape, wired client↔server.
//
// The defect (PR #1325's filed product finding, from rehearsal run
// fsb4b-s1-20261028T060125-0939CE): the server emits a [turn-write-proof] record only
// when the client presents a captured coach turn at preview and the preview's pairing
// token at write. But the client erased its captured turn whenever ANY later turn
// ticket completed unaccepted — including a set-logged ticket that completed with no
// selected response at all (the deterministic lane: offline, a rejected request, a
// watchdog timeout, or a reaction served without a coach call). A session whose sets
// were logged deterministically after one accepted coach interaction therefore
// reached its closeout preview with no turn to claim, and a successful, durable-exact
// write emitted no proof. Whether the trace↔write join held became a function of
// conversation shape, not of the save.
//
// This file proves the repaired shape end to end against the REAL server module
// (services/turnCorrelation.js): a turn captured by an accepted interaction survives
// a no-response set-logged completion, is claimed at preview, mints a real pairing,
// and the live write presenting that pairing emits the proof record — while forged,
// cross-session, superseded, and token-mismatched claims still resolve to nothing.

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
const SESSION_A = '20261028-AM-01';
const SESSION_B = '20261028-AM-02';
const WRITE_ID = 'write-retention-1';

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

function logRow() {
  const row = new Array(logCleanedColumns.length).fill('');
  row[logCleanedColumns.indexOf('session_id')] = SESSION_A;
  return row;
}

function writePayload(correlation) {
  return {
    session_id: SESSION_A,
    date: '2026-10-28',
    log_rows: [logRow()],
    correlation,
  };
}

test('retention: a turn captured by an accepted interaction survives deterministic set-logging and the write proves', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();

  // The coach turn opens server-side and its id rides the response header back.
  const coachRes = fakeResponse();
  assert.equal(server.attachTurnToResponse(coachRes, TURN_A, SESSION_A), TURN_A);
  assert.equal(coachRes._h['x-atlas-turn-id'], TURN_A);

  // The client captures the turn from the accepted interaction's selected response.
  const coachTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(coachTicket, headersFrom(coachRes._h)), true);

  // Sets are then logged through the deterministic lane: the set-logged ticket
  // completes with NO selected response. On the shipped client this erased the
  // captured turn; the preview below is where that loss became visible.
  const setTicket = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(setTicket, null), false);

  // Closeout: the preview claims the retained turn…
  const preview = client.beginPreview({ sessionId: SESSION_A });
  assert.ok(preview, 'the closeout preview must still have the captured turn to claim');
  assert.equal(preview.turnId, TURN_A);

  // …the server mints a real pairing against its registry…
  const previewResolution = server.resolveCorrelation(writePayload(preview.correlation), {
    sessionId: SESSION_A,
    isPreview: true,
    writeId: WRITE_ID,
    previewedWriteId: WRITE_ID,
  });
  assert.equal(previewResolution.ok, true, `preview claim must resolve (got ${previewResolution.reason})`);
  assert.match(previewResolution.pairing_token, /^pair:[a-f0-9]{32}$/);

  // …the client completes the same initiation with the pairing headers…
  const pairingRes = fakeResponse();
  server.attachPairingToResponse(pairingRes, previewResolution.pairing_token, previewResolution.turn_id);
  assert.equal(client.completePreview(preview, headersFrom(pairingRes._h)), true);

  // …and the live write presents the claim: the server resolves it payload-bound
  // and emits the [turn-write-proof] record the Flight_Recorder join consumes.
  const claim = client.approvalClaim(preview);
  assert.ok(claim, 'the approval must carry the staged preview claim');
  const liveResolution = server.resolveCorrelation(writePayload(claim), {
    sessionId: SESSION_A,
    writeId: WRITE_ID,
  });
  assert.equal(liveResolution.ok, true, `live claim must resolve (got ${liveResolution.reason})`);
  assert.equal(liveResolution.pairing.payload_bound, true);

  const record = server.recordWriteProof({
    turnId: liveResolution.turn_id,
    sessionId: SESSION_A,
    route: '/api/log-workout',
    proof: { test_mode: false, sheet_write: 'success', write_id: WRITE_ID },
    pairing: liveResolution.pairing,
  });
  assert.ok(record, 'the write must emit its turn-write-proof record');
  assert.equal(record.turn_id, TURN_A);
  assert.equal(record.pairing.established_at_preview, true);
  assert.ok(server.recentWriteProofs().some(r => r.turn_id === TURN_A && r.route === '/api/log-workout'));

  server._resetForTesting();
});

test('retention: forged, cross-session, superseded, and token-mismatched claims still resolve to nothing', async () => {
  const { createTurnCorrelation } = await loadClient();
  const client = createTurnCorrelation({ randomUUID: deterministicIds() });
  server._resetForTesting();
  server.issueTurn(TURN_A, SESSION_A);

  const NONCE_1 = 'init:00000001-0000-4000-8000-000000000000';
  const NONCE_2 = 'init:00000002-0000-4000-8000-000000000000';

  // Forged: a well-formed turn id this server never issued.
  const forged = server.resolveCorrelation(
    writePayload({ turn_id: TURN_B, initiation_nonce: NONCE_1 }),
    { sessionId: SESSION_A, isPreview: true, writeId: WRITE_ID },
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.reason, 'unknown');

  // Cross-session: the real turn claimed under another session.
  const crossSession = server.resolveCorrelation(
    writePayload({ turn_id: TURN_A, initiation_nonce: NONCE_1 }),
    { sessionId: SESSION_B, isPreview: true, writeId: WRITE_ID },
  );
  assert.equal(crossSession.ok, false);
  assert.equal(crossSession.reason, 'session_mismatch');

  // A real preview mints a pairing under NONCE_1…
  const minted = server.resolveCorrelation(
    writePayload({ turn_id: TURN_A, initiation_nonce: NONCE_1 }),
    { sessionId: SESSION_A, isPreview: true, writeId: WRITE_ID, previewedWriteId: WRITE_ID },
  );
  assert.equal(minted.ok, true);

  // …a live write presenting a different well-formed token is a pairing mismatch…
  const mismatched = server.resolveCorrelation(
    writePayload({ turn_id: TURN_A, initiation_nonce: NONCE_1, pairing_token: `pair:${'f'.repeat(32)}` }),
    { sessionId: SESSION_A, writeId: WRITE_ID },
  );
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, 'pairing_mismatch');

  // …and once a newer preview retires NONCE_1, the retired initiation's claim —
  // even carrying its genuine token — is superseded and resolves to nothing.
  const newer = server.resolveCorrelation(
    writePayload({
      turn_id: TURN_A,
      initiation_nonce: NONCE_2,
      retire_initiation_nonces: [NONCE_1],
    }),
    { sessionId: SESSION_A, isPreview: true, writeId: WRITE_ID, previewedWriteId: WRITE_ID },
  );
  assert.equal(newer.ok, true);
  const superseded = server.resolveCorrelation(
    writePayload({ turn_id: TURN_A, initiation_nonce: NONCE_1, pairing_token: minted.pairing_token }),
    { sessionId: SESSION_A, writeId: WRITE_ID },
  );
  assert.equal(superseded.ok, false);
  assert.equal(superseded.reason, 'superseded');

  // The client mirror: a preview minted from a capture that a newer accepted turn
  // superseded can never produce an approval claim.
  const responseA = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(responseA, headersFrom({ 'x-atlas-turn-id': TURN_A })), true);
  const stalePreview = client.beginPreview({ sessionId: SESSION_A });
  const responseB = client.beginTurnResponse({ sessionId: SESSION_A });
  assert.equal(client.completeTurnResponse(responseB, headersFrom({ 'x-atlas-turn-id': TURN_B })), true);
  assert.equal(client.approvalClaim(stalePreview), null);

  server._resetForTesting();
});
