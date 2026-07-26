'use strict';

// #1165 INTEGRATION — the correlation seam through the REAL /api/log-workout route, with
// sheets stubbed in memory. The unit tests (test/turnCorrelation.test.js) prove the module;
// this file proves the WIRING, which is where the historical failure actually lives: the
// coach turn ends on a read-only route, so unless the write route really resolves and emits,
// write_proof stays absent no matter how correct the helper is.
//
// Proves, through the served route:
//   • a valid claim (server-issued, same session, fresh) emits ONE correlation record whose
//     proof fields match the response body verbatim;
//   • the dry-run path correlates too, carrying the W1–W3 no-write proof;
//   • every fail-closed case (unknown / cross-session / stale / malformed / absent) emits
//     NOTHING — and the write still succeeds unchanged, because correlation is telemetry
//     riding alongside the trust loop, never part of it.
//
// And, for #1173 item 1 (preview-established binding, replacing first-write-wins):
//   • the real dry-run hands back a pairing token on its own header, never in the body;
//   • the live write that presents it correlates, stamped with its attempt and — on
//     /api/log-workout, the one path whose dry-run carries the write_id it will approve with —
//     with the previewed-write_id corroboration;
//   • a live write with NO pairing, or a forged token, correlates NOTHING and still writes its
//     rows unchanged (the exact claim #1172 used to accept via first-write-wins);
//   • the pairing header is CORS-exposed, or a browser would hide it and the round-trip would
//     silently never happen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { logCleanedColumns, effortColumns, sessionPlansColumns } = require('../config/columns');
const { resetIdempotencyStore } = require('../services/idempotency');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
// The correlation record is shadow-gated exactly like the packet/trace shadow, so the
// integration must run with the shadow ON — otherwise it would prove only that a disabled
// feature stays silent.
process.env.ATLAS_INTERACTION_TRACE = 'shadow';

const state = {
  appends: [],
  failEffortAppend: false,
  proofMismatchTab: null,
  logCompositeKeys: [],
  existingEffortSessionIds: [],
};

const fakeSheets = {
  appendRows: async (tab, rows) => {
    if (tab === 'Effort' && state.failEffortAppend) throw new Error('Simulated Effort append failure');
    state.appends.push({ tab, rows: rows.map(r => [...r]) });
    return {
      data: {
        updates: {
          updatedRange: `${tab}!A100:L${99 + rows.length}`,
          updatedRows: state.proofMismatchTab === tab ? 0 : rows.length,
        },
      },
    };
  },
  readRange: async (range) => {
    if (String(range).startsWith('Session_Plans!')) return [[...sessionPlansColumns]];
    return [];
  },
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => ([
    ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
    ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench'],
  ]),
  getEffortSessionIds: async () => [...state.existingEffortSessionIds],
  getLogCompositeKeys: async () => [...state.logCompositeKeys],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getHeaderRow: async tab => {
    if (tab === 'Log_Cleaned') return [...logCleanedColumns];
    if (tab === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => [
    'Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Bodyweight', 'Modality_Log',
  ],
  ensureSheetTab: async () => ({ existed: true }),
  getSafeSpreadsheetConfig: () => ({ sheetId: 'stub-sheet', configured: true }),
  isTransientAppendError: () => false,
  retryWithBackoff: async fn => fn(),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const tc = require('../services/turnCorrelation');
const { app } = require('../index');

const SESSION_ID = 'TC-INT-1';
const OTHER_SESSION = 'TC-INT-2';
const TURN_ID = 'turn:2026-07-25T12:00:00.000Z_7_int001';

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function logRows() {
  return [{ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2, set_number: 1 }];
}

async function postWrite(body) {
  const res = await fetch(`${baseUrl}/api/log-workout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function postMultipart(path, form) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'x-atlas-api-key': 'test-api-key' },
    body: form,
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

// #1173 item 1 — run the real dry-run through the route to obtain the pairing token the
// server hands back, exactly as the client will in slice 2.
async function previewForToken(extra) {
  const res = await postWrite(dryRunPayload(extra));
  return { ...res, pairingToken: res.headers.get(tc.PAIRING_TOKEN_HEADER) };
}

// A dry-run keeps every assertion write-free while still exercising the identical
// correlation seam (the resolve → record path is shared by both returns).
function dryRunPayload(extra) {
  return {
    session_id: SESSION_ID,
    date: '2026-07-25',
    test_mode: true,
    log_rows: logRows(),
    ...extra,
  };
}

test('a valid claim correlates the dry-run W1–W3 proof to the turn', async () => {
  tc._resetForTesting();
  tc.issueTurn(TURN_ID, SESSION_ID);

  const { status, body } = await postWrite(dryRunPayload({ correlation: { turn_id: TURN_ID } }));
  assert.equal(status, 200);
  assert.equal(body.data.no_write_confirmed, true, 'the dry-run proof must be intact');
  assert.equal(body.data.sheet_written, false);

  const records = tc.recentWriteProofs();
  assert.equal(records.length, 1, 'exactly one correlation record');
  const rec = records[0];
  assert.equal(rec.turn_id, TURN_ID);
  assert.equal(rec.session_id, SESSION_ID);
  assert.equal(rec.route, '/api/log-workout');
  // The proof is the ROUTE's, copied verbatim — this is the join the Phase-4 gate asked for.
  assert.equal(rec.proof.no_write_confirmed, true);
  assert.equal(rec.proof.sheet_written, false);
  assert.equal(rec.proof.test_mode, true);
  // The row previews on that body are arrays and must not survive into the record.
  assert.ok(!('log_rows_preview' in rec.proof));
  assert.ok(!JSON.stringify(rec).includes('Bench Press'), 'no workout data in the record');
});

test('fail-closed: a claim the server never issued correlates nothing, and the write is unaffected', async () => {
  tc._resetForTesting(); // nothing issued
  const { status, body } = await postWrite(dryRunPayload({ correlation: { turn_id: TURN_ID } }));
  assert.equal(status, 200, 'the write must still succeed');
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(tc.recentWriteProofs().length, 0, 'an unknown id must correlate nothing');
});

test('fail-closed: a turn issued for ANOTHER session cannot be claimed (no contamination)', async () => {
  tc._resetForTesting();
  tc.issueTurn(TURN_ID, OTHER_SESSION);
  const { status } = await postWrite(dryRunPayload({ correlation: { turn_id: TURN_ID } }));
  assert.equal(status, 200);
  assert.equal(tc.recentWriteProofs().length, 0, 'cross-session correlation must never be recorded');
});

test('fail-closed: a stale turn cannot be claimed', async () => {
  tc._resetForTesting();
  // Issued far enough in the past that the claim is outside the freshness window.
  tc.issueTurn(TURN_ID, SESSION_ID, { nowMs: Date.now() - (tc.DEFAULT_MAX_AGE_MS + 60_000) });
  const { status } = await postWrite(dryRunPayload({ correlation: { turn_id: TURN_ID } }));
  assert.equal(status, 200);
  assert.equal(tc.recentWriteProofs().length, 0, 'a stale turn must correlate nothing');
});

test('fail-closed: malformed and absent claims correlate nothing, and never break the write', async () => {
  for (const correlation of [undefined, null, 'turn:whatever', {}, { turn_id: 'nope' }, { turn_id: 12 }]) {
    tc._resetForTesting();
    tc.issueTurn(TURN_ID, SESSION_ID);
    const payload = dryRunPayload({});
    if (correlation !== undefined) payload.correlation = correlation;
    const { status, body } = await postWrite(payload);
    assert.equal(status, 200, `write must succeed for ${JSON.stringify(correlation)}`);
    assert.equal(body.data.no_write_confirmed, true);
    assert.equal(tc.recentWriteProofs().length, 0, `must correlate nothing for ${JSON.stringify(correlation)}`);
  }
});

test('a PARTIAL write correlates too — committed rows must never go unjoined', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);
  // The preview must carry the effort row the approve will write — app.js:6962 sets
  // `payload.effort_row` at preview time whenever there is one. An effort row that appeared only
  // on the live request would be an unpreviewed Effort append, which the payload gate refuses.
  const effortRow = ['2026-07-25', SESSION_ID, 3600, 400, 500, 130, 165, 'Gym', ''];
  const { pairingToken } = await previewForToken({ correlation: { turn_id: TURN_ID }, effort_row: effortRow });

  state.failEffortAppend = true;
  const { status, body } = await postWrite({
    session_id: SESSION_ID,
    date: '2026-07-25',
    write_id: 'wid-int-partial',
    log_rows: logRows(),
    effort_row: effortRow,
    correlation: { turn_id: TURN_ID, pairing_token: pairingToken },
  });
  state.failEffortAppend = false;

  assert.equal(status, 500, 'a partial write is reported as an error with an authoritative proof');
  const data = body.data || body.details || body;
  assert.equal(data.sheet_write, 'partial');
  assert.equal(data.sheet_written, true, 'log rows ARE committed on this path');

  // The whole point: rows landed, so this turn really did write. It must be joinable.
  const records = tc.recentWriteProofs();
  assert.equal(records.length, 2, 'the preview record, then the partial write record');
  const rec = records[1];
  assert.equal(rec.turn_id, TURN_ID);
  assert.equal(rec.proof.sheet_write, 'partial');
  assert.equal(rec.proof.sheet_written, true);
  assert.equal(rec.pairing.established_at_preview, true);
  assert.equal(rec.pairing.write_attempt, 1);
});

test('a live write correlates its success proof, including the appended range', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);
  // The write_id the dry-run carries is the one the approve will use (app.js:6960 → 7506),
  // so the server can corroborate the pairing — the check that makes the record's claim
  // "this turn authorized THIS write" rather than "some write in this session".
  const { pairingToken } = await previewForToken({ correlation: { turn_id: TURN_ID }, write_id: 'wid-int-1' });
  assert.ok(pairingToken, 'the dry-run response must hand the client its pairing token');

  const { status, body } = await postWrite({
    session_id: SESSION_ID,
    date: '2026-07-25',
    write_id: 'wid-int-1',
    log_rows: logRows(),
    correlation: { turn_id: TURN_ID, pairing_token: pairingToken },
  });
  assert.equal(status, 200);
  assert.equal(body.data.sheet_write, 'success');

  const records = tc.recentWriteProofs();
  assert.equal(records.length, 2);
  const rec = records[1];
  assert.equal(rec.turn_id, TURN_ID);
  assert.equal(rec.proof.sheet_write, 'success');
  // The appended range is the write's identity and the undo's authority — the single most
  // useful thing to have joined to the turn.
  assert.equal(rec.proof.logAppendedRange, body.data.logAppendedRange);
  assert.ok(!JSON.stringify(rec).includes('stub-sheet'), 'no Sheet ID in the record');
  assert.equal(rec.pairing.established_at_preview, true);
  assert.equal(rec.pairing.previewed_write_id_match, true, 'this really is the previewed write');
});

// ─── #1173 item 1 — the binding is established at preview, through the real route ───────

test('the pairing token never appears in the response BODY, only in its own header', async () => {
  tc._resetForTesting();
  tc.issueTurn(TURN_ID, SESSION_ID);
  const { body, headers, pairingToken } = await previewForToken({ correlation: { turn_id: TURN_ID } });
  assert.ok(pairingToken, 'the header must carry the token');
  assert.equal(headers.get(tc.PAIRING_TOKEN_HEADER), pairingToken);
  // Every coach and preview body shape is pinned by tests, and the token is a live
  // capability — it belongs in a header, and must never be logged into the record either.
  assert.ok(!JSON.stringify(body).includes(pairingToken), 'the token must not reach the response body');
  assert.ok(!JSON.stringify(tc.recentWriteProofs()).includes(pairingToken), 'nor the correlation record');
});

test('the EMITTED preview record does not claim a payload match (Codex P1)', async () => {
  tc._resetForTesting();
  tc.issueTurn(TURN_ID, SESSION_ID);
  await previewForToken({ correlation: { turn_id: TURN_ID } });

  // This is the record a reviewer actually reads, so the honesty has to hold in the emitted
  // artifact and not only in the resolver's return value.
  const records = tc.recentWriteProofs();
  assert.equal(records.length, 1);
  assert.equal(records[0].pairing.established_at_preview, true);
  assert.equal(records[0].pairing.payload_bound, false, 'no live payload has been compared yet');
  assert.equal(records[0].pairing.effort_transition, false);
  assert.equal(records[0].proof.no_write_confirmed, true, 'and it still carries the W1–W3 no-write proof');
});

test('fail-closed: a live write with NO pairing correlates nothing, and still succeeds', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);

  // Exactly what #1172 accepted: a fresh, same-session, well-formed turn id on a live write,
  // with no preview behind it. It used to bind first-write-wins; it must now correlate nothing.
  const { status, body } = await postWrite({
    session_id: SESSION_ID,
    date: '2026-07-25',
    write_id: 'wid-int-unpaired',
    log_rows: logRows(),
    correlation: { turn_id: TURN_ID },
  });
  assert.equal(status, 200, 'correlation must never block or alter a write');
  assert.equal(body.data.sheet_write, 'success');
  assert.equal(body.data.log_rows_written, 1, 'the rows are written exactly as without a claim');
  assert.equal(tc.recentWriteProofs().length, 0, 'an unpaired live write must correlate nothing');
});

test('fail-closed: a forged pairing token correlates nothing, and still succeeds', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);
  await previewForToken({ correlation: { turn_id: TURN_ID } });
  const before = tc.recentWriteProofs().length;

  const { status, body } = await postWrite({
    session_id: SESSION_ID,
    date: '2026-07-25',
    write_id: 'wid-int-forged',
    log_rows: logRows(),
    // Well-formed but never minted — the registry, not the format, is the authority.
    correlation: { turn_id: TURN_ID, pairing_token: 'pair:deadbeefdeadbeefdeadbeefdeadbeef' },
  });
  assert.equal(status, 200);
  assert.equal(body.data.sheet_write, 'success');
  assert.equal(tc.recentWriteProofs().length, before, 'a forged token must add no record');
});

test('fail-closed: a valid token on a DIFFERENT workout correlates nothing (Codex P1)', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);
  const { pairingToken } = await previewForToken({ correlation: { turn_id: TURN_ID } });
  const before = tc.recentWriteProofs().length;

  // Same turn, same session, GENUINE token — but not the workout that was previewed. Before the
  // server-computed payload identity this resolved ok and attributed the wrong write to the turn.
  const { status, body } = await postWrite({
    session_id: SESSION_ID,
    date: '2026-07-25',
    write_id: 'wid-int-otherwork',
    log_rows: [{ exercise: 'Bench Press', weight: 315, reps: 1, rir: 0, set_number: 1 }],
    correlation: { turn_id: TURN_ID, pairing_token: pairingToken },
  });
  assert.equal(status, 200, 'correlation must never block or alter a write');
  assert.equal(body.data.sheet_write, 'success');
  assert.equal(body.data.log_rows_written, 1, 'the unrelated workout is written exactly as normal');
  assert.equal(tc.recentWriteProofs().length, before, 'a mismatched payload must add no record');
});

test('fail-closed: a FIRST live write that drops the previewed effort row correlates nothing', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);
  // The preview stages an Effort append. The first approve silently omits it — so the write that
  // happens is NOT the write that was previewed, and it is not the documented seal retry either
  // (that only follows a committed write, app.js:7563-7567). It must not be recorded as bound.
  const { pairingToken } = await previewForToken({
    correlation: { turn_id: TURN_ID },
    write_id: 'wid-int-seal-1',
    effort_row: ['2026-07-25', SESSION_ID, 3600, 400, 500, 130, 165, 'Gym', ''],
  });
  const before = tc.recentWriteProofs().length;

  const { status, body } = await postWrite({
    session_id: SESSION_ID,
    date: '2026-07-25',
    write_id: 'wid-int-seal-2',
    log_rows: logRows(),
    correlation: { turn_id: TURN_ID, pairing_token: pairingToken },
  });
  assert.equal(status, 200, 'correlation must never block or alter a write');
  assert.equal(body.data.sheet_write, 'success');
  assert.equal(tc.recentWriteProofs().length, before, 'the dropped Effort append must cost the correlation');
  // The transition itself (effort removal AFTER an exact write) is unit-covered in
  // test/turnCorrelation.test.js; exercising it end-to-end needs the duplicate-closeout branch,
  // i.e. the Session Plan lanes and a seal fixture — #1173 item 3's harness, not this file's.
});

test('a live write that names another session in a ROW correlates nothing (Codex P1)', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);
  // A row-level session_id WINS at write time (index.js:449), so this row lands under
  // OTHER_SESSION while the record would have named SESSION_ID. Refused outright.
  const rows = [{ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2, set_number: 1, session_id: OTHER_SESSION }];
  const { pairingToken } = await previewForToken({ correlation: { turn_id: TURN_ID }, log_rows: rows });
  assert.equal(pairingToken, null, 'a rogue row session must not even establish a pairing');
  assert.equal(tc.recentWriteProofs().length, 0, 'and it must record nothing');
});

// ─── #1173 item 2 — the duplicate-closeout branch, through the real route ──────
//
// Codex (r3649648870) was right that unit tests calling buildWriteProofRecord directly cannot
// prove this: the historical failure is `index.js` emitting a duplicate-closeout record from the
// ACTUAL seal/capture envelopes, which can still break through wiring while a helper suite stays
// green. This exercises the real branch with the envelopes the real producers return.

test('the duplicate-closeout branch projects the seal and closeout envelopes it actually produced', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  // Every intended log row is already on the sheet and there is no new Effort row — the
  // all-rows-duplicate branch. Composite key format is `sid||exercise||set_number`, lowercased
  // (index.js partitionLogRowsByExisting).
  state.logCompositeKeys = [`${SESSION_ID.toLowerCase()}||bench press||1`];
  tc.issueTurn(TURN_ID, SESSION_ID);

  // A canonical accepted-plan token (`pv_` + UUID, as src/app/planAcceptance.js mints them) —
  // the projection validates the shape, so a made-up token would be dropped and prove nothing.
  const closeout = { plan_version: 'pv_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', items: [] };
  const { pairingToken } = await previewForToken({ correlation: { turn_id: TURN_ID }, closeout_context: closeout });

  const { status, body } = await postWrite({
    session_id: SESSION_ID,
    date: '2026-07-25',
    write_id: 'wid-int-dupe',
    log_rows: logRows(),
    closeout_context: closeout,
    correlation: { turn_id: TURN_ID, pairing_token: pairingToken },
  });
  state.logCompositeKeys = [];

  assert.equal(status, 200);
  assert.equal(body.data.all_rows_duplicate, true, 'this must really be the duplicate branch');
  assert.equal(body.data.log_rows_written, 0, 'and it appended no log rows');
  // The branch still attempted both sidecar writes — which is exactly why it correlates.
  assert.ok(body.data.ledger_seal, 'the branch attempted the ledger seal');
  assert.ok(body.data.session_plans_closeout, 'and the Session_Plans closeout event');

  const records = tc.recentWriteProofs();
  const rec = records[records.length - 1];
  // THE POINT: before the projections this record carried log_rows_written:0 and no seal evidence
  // whatsoever, so it could not prove the sidecar write the trigger was added to capture.
  // Asserted against the SERVED body rather than hardcoded, so the record cannot drift from it.
  assert.equal(rec.proof.ledger_seal_sheet_written, body.data.ledger_seal.sheet_written);
  assert.equal(rec.proof.ledger_seal_dry_run, body.data.ledger_seal.dry_run);
  assert.equal(rec.proof.ledger_seal_reason, body.data.ledger_seal.reason);
  assert.equal(rec.proof.session_plans_closeout_status, body.data.session_plans_closeout.status);
  assert.equal(rec.proof.session_plans_closeout_captured, body.data.session_plans_closeout.captured);
  assert.equal(rec.proof.session_plans_closeout_written, body.data.session_plans_closeout.written);
  // Project, never pass through: the flattened keys arrive, the nested envelopes never do.
  assert.ok(!('ledger_seal' in rec.proof), 'the nested envelope must not be carried');
  assert.ok(!('session_plans_closeout' in rec.proof));
  // The plan version IS carried — it is the closeout event's row discriminator (hashed into
  // sessionPlanEvents.idempotencyKey), so without it the artifact join cannot say WHICH
  // session_closeout row this record refers to.
  assert.equal(rec.proof.session_plans_closeout_plan_version, closeout.plan_version);

  // HONEST LIMIT of this harness: both lanes are OFF here, so the seal is a dry-run
  // (`dry_run:true`, `reason:'write_disabled'`) and the capture reports `status:'disabled'`. That
  // proves the WIRING and the projection faithfully, not a live stamp. The lanes-ON seal-fixture
  // case — where ledger_seal_sheet_written is genuinely true — is #1173 item 3.
  assert.equal(rec.proof.ledger_seal_dry_run, true, 'lanes off ⇒ dry-run seal, stated not implied');
  assert.equal(rec.proof.session_plans_closeout_captured, false, 'lanes off ⇒ nothing captured');
});

test('the pairing header is exposed to CORS clients, or a browser would hide it', async () => {
  // Same failure the turn-id header had: not CORS-safelisted, so a cross-origin frontend
  // would read null and the round-trip would silently never happen.
  const res = await fetch(`${baseUrl}/api/log-workout`, {
    method: 'OPTIONS',
    headers: { 'x-atlas-api-key': 'test-api-key' },
  });
  const exposed = String(res.headers.get('access-control-expose-headers') || '').toLowerCase();
  assert.ok(exposed.includes(tc.TURN_ID_HEADER), `turn id header must stay exposed, got "${exposed}"`);
  assert.ok(exposed.includes(tc.PAIRING_TOKEN_HEADER), `pairing header must be exposed, got "${exposed}"`);
});

test('the real modality and bodyweight preview/write routes round-trip the exact initiated claim', async () => {
  for (const routeCase of [
    {
      route: '/api/log-modality',
      preview: {
        text: 'run 5 km in 30 minutes',
        session_id: SESSION_ID,
        date: '2026-07-25',
        test_mode: true,
      },
      writeId: 'wid-modality-correlation',
      appendedTab: 'Modality_Log',
    },
    {
      route: '/api/bodyweight',
      preview: {
        session_id: SESSION_ID,
        date: '2026-07-25',
        weight: 180,
        notes: 'morning',
        test_mode: 'true',
      },
      writeId: 'wid-bodyweight-correlation',
      appendedTab: 'Bodyweight',
    },
  ]) {
    tc._resetForTesting();
    resetIdempotencyStore();
    state.appends.length = 0;
    tc.issueTurn(TURN_ID, SESSION_ID);
    const initiation = `init:${routeCase.appendedTab === 'Bodyweight'
      ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}`;
    const previewPayload = {
      ...routeCase.preview,
      correlation: { turn_id: TURN_ID, initiation_nonce: initiation },
    };
    const preview = await postJson(routeCase.route, previewPayload);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.headers.get(tc.TURN_ID_HEADER), TURN_ID);
    const pairingToken = preview.headers.get(tc.PAIRING_TOKEN_HEADER);
    assert.ok(tc.isWellFormedPairingToken(pairingToken));

    const livePayload = {
      ...routeCase.preview,
      write_id: routeCase.writeId,
      correlation: {
        turn_id: TURN_ID,
        initiation_nonce: initiation,
        pairing_token: pairingToken,
      },
    };
    delete livePayload.test_mode;
    const live = await postJson(routeCase.route, livePayload);
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.ok(state.appends.some(a => a.tab === routeCase.appendedTab),
      `${routeCase.route} must execute its real append path`);

    const record = tc.recentWriteProofs().at(-1);
    assert.equal(record.route, routeCase.route);
    assert.equal(record.pairing.payload_bound, true);
    assert.equal(record.proof.sheet_written, true);
  }
});

test('the real multipart effort-only preview/write route binds the server-normalized payload', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);

  const initiation = 'init:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const effort = JSON.stringify({
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training',
  });
  const previewForm = new FormData();
  previewForm.append('session_id', SESSION_ID);
  previewForm.append('date', '2026-07-25');
  previewForm.append('log_rows_json', JSON.stringify([]));
  previewForm.append('effort_json', effort);
  previewForm.append('test_mode', 'true');
  previewForm.append('correlation', JSON.stringify({
    turn_id: TURN_ID,
    initiation_nonce: initiation,
  }));
  const preview = await postMultipart('/api/complete-workout', previewForm);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.headers.get(tc.TURN_ID_HEADER), TURN_ID);
  const pairingToken = preview.headers.get(tc.PAIRING_TOKEN_HEADER);
  assert.ok(tc.isWellFormedPairingToken(pairingToken));

  const liveForm = new FormData();
  liveForm.append('session_id', SESSION_ID);
  liveForm.append('date', '2026-07-25');
  liveForm.append('log_rows_json', JSON.stringify([]));
  liveForm.append('effort_json', effort);
  liveForm.append('write_id', 'wid-complete-correlation');
  liveForm.append('correlation', JSON.stringify({
    turn_id: TURN_ID,
    initiation_nonce: initiation,
    pairing_token: pairingToken,
  }));
  const live = await postMultipart('/api/complete-workout', liveForm);
  assert.equal(live.status, 200, JSON.stringify(live.body));
  assert.ok(state.appends.some(a => a.tab === 'Effort'), 'the real Effort append must run');

  const record = tc.recentWriteProofs().at(-1);
  assert.equal(record.route, '/api/complete-workout');
  assert.equal(record.pairing.payload_bound, true);
  assert.equal(record.proof.sheet_written, true);
});

test('the real multipart route reuses one pairing when retry completes before the original attempt', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);

  const initiation = 'init:56565656-5656-4656-8656-565656565656';
  const effort = JSON.stringify({
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training',
  });
  const makePreview = () => {
    const form = new FormData();
    form.append('session_id', SESSION_ID);
    form.append('date', '2026-07-25');
    form.append('log_rows_json', JSON.stringify([]));
    form.append('effort_json', effort);
    form.append('test_mode', 'true');
    form.append('correlation', JSON.stringify({
      turn_id: TURN_ID,
      initiation_nonce: initiation,
    }));
    return form;
  };

  // Equivalent server completion order to a transport retry returning first while the
  // original request keeps running and reaches pairing establishment afterward.
  const retryResponse = await postMultipart('/api/complete-workout', makePreview());
  const lateOriginal = await postMultipart('/api/complete-workout', makePreview());
  assert.equal(retryResponse.status, 200, JSON.stringify(retryResponse.body));
  assert.equal(lateOriginal.status, 200, JSON.stringify(lateOriginal.body));
  const retainedToken = retryResponse.headers.get(tc.PAIRING_TOKEN_HEADER);
  assert.ok(tc.isWellFormedPairingToken(retainedToken));
  assert.equal(lateOriginal.headers.get(tc.PAIRING_TOKEN_HEADER), retainedToken,
    'the real route must return the same capability for duplicate attempts of one initiation');

  const liveForm = new FormData();
  liveForm.append('session_id', SESSION_ID);
  liveForm.append('date', '2026-07-25');
  liveForm.append('log_rows_json', JSON.stringify([]));
  liveForm.append('effort_json', effort);
  liveForm.append('write_id', 'wid-multipart-preview-transport-retry');
  liveForm.append('correlation', JSON.stringify({
    turn_id: TURN_ID,
    initiation_nonce: initiation,
    pairing_token: retainedToken,
  }));
  const live = await postMultipart('/api/complete-workout', liveForm);
  assert.equal(live.status, 200, JSON.stringify(live.body));
  assert.ok(state.appends.some(a => a.tab === 'Effort'), 'the approved write still reaches the real append path');
  const record = tc.recentWriteProofs().at(-1);
  assert.equal(record.pairing.payload_bound, true);
  assert.equal(record.proof.sheet_written, true);
});

test('the real multipart route rejects a changed oversized retry when exact equality cannot be established', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);

  const initiation = 'init:78787878-7878-4878-8878-787878787878';
  const effort = JSON.stringify({
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training',
  });
  const makePreview = notes => {
    const form = new FormData();
    form.append('session_id', SESSION_ID);
    form.append('date', '2026-07-25');
    form.append('log_rows_json', JSON.stringify([]));
    form.append('effort_json', effort);
    form.append('notes', notes);
    form.append('test_mode', 'true');
    form.append('correlation', JSON.stringify({
      turn_id: TURN_ID,
      initiation_nonce: initiation,
    }));
    return form;
  };

  const first = await postMultipart('/api/complete-workout', makePreview('A'.repeat(210_000)));
  const changed = await postMultipart('/api/complete-workout', makePreview('B'.repeat(210_000)));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.ok(tc.isWellFormedPairingToken(first.headers.get(tc.PAIRING_TOKEN_HEADER)));
  assert.equal(Boolean(changed.headers.get(tc.PAIRING_TOKEN_HEADER)), false,
    'a distinct oversized multipart retry must not receive the established capability');
  assert.equal(changed.body.data.test_mode, true,
    'correlation rejection must leave the underlying preview response unchanged');
  assert.equal(state.appends.length, 0, 'both requests are still dry-run previews');
});

test('the real multipart route records a correlated partial proof after Log rows commit and Effort append fails', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);

  const initiation = 'init:abababab-abab-4bab-8bab-abababababab';
  const effort = JSON.stringify({
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training',
  });
  const rows = JSON.stringify(logRows());
  const previewForm = new FormData();
  previewForm.append('session_id', SESSION_ID);
  previewForm.append('date', '2026-07-25');
  previewForm.append('log_rows_json', rows);
  previewForm.append('effort_json', effort);
  previewForm.append('test_mode', 'true');
  previewForm.append('correlation', JSON.stringify({
    turn_id: TURN_ID,
    initiation_nonce: initiation,
  }));
  const preview = await postMultipart('/api/complete-workout', previewForm);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const pairingToken = preview.headers.get(tc.PAIRING_TOKEN_HEADER);
  assert.ok(tc.isWellFormedPairingToken(pairingToken));

  state.failEffortAppend = true;
  try {
    const liveForm = new FormData();
    liveForm.append('session_id', SESSION_ID);
    liveForm.append('date', '2026-07-25');
    liveForm.append('log_rows_json', rows);
    liveForm.append('effort_json', effort);
    liveForm.append('write_id', 'wid-complete-partial-correlation');
    liveForm.append('correlation', JSON.stringify({
      turn_id: TURN_ID,
      initiation_nonce: initiation,
      pairing_token: pairingToken,
    }));
    const live = await postMultipart('/api/complete-workout', liveForm);
    assert.equal(live.status, 500, JSON.stringify(live.body));
    assert.equal(live.body?.details?.sheet_write, 'partial');

    const records = tc.recentWriteProofs();
    assert.equal(records.length, 2, 'preview and committed partial write must both be joinable');
    const record = records[1];
    assert.equal(record.route, '/api/complete-workout');
    assert.equal(record.pairing.payload_bound, true);
    assert.equal(record.proof.sheet_write, 'partial');
    assert.equal(record.proof.sheet_written, true);
  } finally {
    state.failEffortAppend = false;
  }
});

test('the real multipart route records a correlated unverified proof after append proof mismatch', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);

  const initiation = 'init:cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  const effort = JSON.stringify({
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training',
  });
  const rows = JSON.stringify(logRows());
  const previewForm = new FormData();
  previewForm.append('session_id', SESSION_ID);
  previewForm.append('date', '2026-07-25');
  previewForm.append('log_rows_json', rows);
  previewForm.append('effort_json', effort);
  previewForm.append('test_mode', 'true');
  previewForm.append('correlation', JSON.stringify({
    turn_id: TURN_ID,
    initiation_nonce: initiation,
  }));
  const preview = await postMultipart('/api/complete-workout', previewForm);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const pairingToken = preview.headers.get(tc.PAIRING_TOKEN_HEADER);
  assert.ok(tc.isWellFormedPairingToken(pairingToken));

  state.proofMismatchTab = 'Log_Cleaned';
  try {
    const liveForm = new FormData();
    liveForm.append('session_id', SESSION_ID);
    liveForm.append('date', '2026-07-25');
    liveForm.append('log_rows_json', rows);
    liveForm.append('effort_json', effort);
    liveForm.append('write_id', 'wid-complete-unverified-correlation');
    liveForm.append('correlation', JSON.stringify({
      turn_id: TURN_ID,
      initiation_nonce: initiation,
      pairing_token: pairingToken,
    }));
    const live = await postMultipart('/api/complete-workout', liveForm);
    assert.equal(live.status, 500, JSON.stringify(live.body));
    assert.equal(live.body?.details?.sheet_write, 'unverified');

    const records = tc.recentWriteProofs();
    assert.equal(records.length, 2, 'preview and committed unverified write must both be joinable');
    const record = records[1];
    assert.equal(record.route, '/api/complete-workout');
    assert.equal(record.pairing.payload_bound, true);
    assert.equal(record.proof.sheet_write, 'unverified');
    assert.equal(record.proof.sheet_written, true);
  } finally {
    state.proofMismatchTab = null;
  }
});

test('the real blank-session effort-only route adopts the server-resolved session before approval', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  state.existingEffortSessionIds = ['20260725-AM-01', '20260725-PM-01'];
  tc.issueTurn(TURN_ID, SESSION_ID);

  const initiation = 'init:dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const effort = JSON.stringify({
    duration: '00:30:00',
    activeCalories: 250,
    totalCalories: 330,
    averageHR: 142,
    peakHR: 165,
    workoutType: 'Outdoor Run',
  });
  const previewForm = new FormData();
  previewForm.append('date', '2026-07-25');
  previewForm.append('log_rows_json', JSON.stringify([]));
  previewForm.append('effort_json', effort);
  previewForm.append('test_mode', 'true');
  previewForm.append('correlation', JSON.stringify({
    turn_id: TURN_ID,
    initiation_nonce: initiation,
    provisional_session_id: SESSION_ID,
  }));
  const preview = await postMultipart('/api/complete-workout', previewForm);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const resolvedSessionId = preview.body?.data?.data?.session_id;
  assert.match(resolvedSessionId, /^20260725-(?:AM|PM)-02$/);
  const pairingToken = preview.headers.get(tc.PAIRING_TOKEN_HEADER);
  assert.ok(tc.isWellFormedPairingToken(pairingToken),
    'the server-resolved preview must return a usable pairing');

  const liveForm = new FormData();
  liveForm.append('session_id', resolvedSessionId);
  liveForm.append('date', '2026-07-25');
  liveForm.append('log_rows_json', JSON.stringify([]));
  liveForm.append('effort_json', effort);
  liveForm.append('write_id', 'wid-complete-resolved-correlation');
  liveForm.append('correlation', JSON.stringify({
    turn_id: TURN_ID,
    initiation_nonce: initiation,
    pairing_token: pairingToken,
  }));
  const live = await postMultipart('/api/complete-workout', liveForm);
  state.existingEffortSessionIds = [];
  assert.equal(live.status, 200, JSON.stringify(live.body));

  const record = tc.recentWriteProofs().at(-1);
  assert.equal(record.session_id, resolvedSessionId);
  assert.equal(record.pairing.payload_bound, true);
  assert.equal(record.proof.sheet_written, true);
});

test('the real multipart route lets newer blank-session preview B retire A before adopting a different resolved session', async () => {
  tc._resetForTesting();
  resetIdempotencyStore();
  state.appends.length = 0;
  state.existingEffortSessionIds = ['20260725-AM-01', '20260725-PM-01'];
  tc.issueTurn(TURN_ID, SESSION_ID);

  const initiationA = 'init:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const initiationB = 'init:ffffffff-ffff-4fff-8fff-ffffffffffff';
  const effortA = JSON.stringify({
    duration: '00:30:00',
    activeCalories: 250,
    totalCalories: 330,
    averageHR: 142,
    peakHR: 165,
    workoutType: 'Outdoor Run',
  });
  const effortB = JSON.stringify({
    duration: '00:45:00',
    activeCalories: 360,
    totalCalories: 470,
    averageHR: 151,
    peakHR: 174,
    workoutType: 'Traditional Strength Training',
  });

  try {
    const previewAForm = new FormData();
    previewAForm.append('date', '2026-07-25');
    previewAForm.append('log_rows_json', JSON.stringify([]));
    previewAForm.append('effort_json', effortA);
    previewAForm.append('test_mode', 'true');
    previewAForm.append('correlation', JSON.stringify({
      turn_id: TURN_ID,
      initiation_nonce: initiationA,
      provisional_session_id: SESSION_ID,
    }));
    const previewA = await postMultipart('/api/complete-workout', previewAForm);
    assert.equal(previewA.status, 200, JSON.stringify(previewA.body));
    const resolvedSessionA = previewA.body?.data?.data?.session_id;
    const pairingA = previewA.headers.get(tc.PAIRING_TOKEN_HEADER);
    assert.match(resolvedSessionA, /^20260725-(?:AM|PM)-02$/);
    assert.ok(tc.isWellFormedPairingToken(pairingA));

    state.existingEffortSessionIds.push(resolvedSessionA);
    const previewBForm = new FormData();
    previewBForm.append('date', '2026-07-25');
    previewBForm.append('log_rows_json', JSON.stringify([]));
    previewBForm.append('effort_json', effortB);
    previewBForm.append('test_mode', 'true');
    previewBForm.append('correlation', JSON.stringify({
      turn_id: TURN_ID,
      initiation_nonce: initiationB,
      provisional_session_id: SESSION_ID,
      retire_initiation_nonces: [initiationA],
    }));
    const previewB = await postMultipart('/api/complete-workout', previewBForm);
    assert.equal(previewB.status, 200, JSON.stringify(previewB.body));
    const resolvedSessionB = previewB.body?.data?.data?.session_id;
    const pairingB = previewB.headers.get(tc.PAIRING_TOKEN_HEADER);
    assert.notEqual(resolvedSessionB, resolvedSessionA,
      'the occupied A identity must force B to resolve a distinct session');
    assert.ok(tc.isWellFormedPairingToken(pairingB),
      'B must correlate after retiring A against the shared provisional session');

    const staleA = tc.resolveCorrelation({
      session_id: resolvedSessionA,
      date: '2026-07-25',
      effort_metrics: JSON.parse(effortA),
      correlation: {
        turn_id: TURN_ID,
        initiation_nonce: initiationA,
        pairing_token: pairingA,
      },
    }, {
      sessionId: resolvedSessionA,
      writeId: 'wid-stale-a',
    });
    assert.equal(staleA.reason, 'superseded');

    const liveBForm = new FormData();
    liveBForm.append('session_id', resolvedSessionB);
    liveBForm.append('date', '2026-07-25');
    liveBForm.append('log_rows_json', JSON.stringify([]));
    liveBForm.append('effort_json', effortB);
    liveBForm.append('write_id', 'wid-newer-b');
    liveBForm.append('correlation', JSON.stringify({
      turn_id: TURN_ID,
      initiation_nonce: initiationB,
      pairing_token: pairingB,
    }));
    const liveB = await postMultipart('/api/complete-workout', liveBForm);
    assert.equal(liveB.status, 200, JSON.stringify(liveB.body));
    const record = tc.recentWriteProofs().at(-1);
    assert.equal(record.session_id, resolvedSessionB);
    assert.equal(record.pairing.payload_bound, true);
    assert.equal(record.proof.sheet_written, true);
  } finally {
    state.existingEffortSessionIds = [];
  }
});
