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
const { logCleanedColumns } = require('../config/columns');

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

// ─── #1173 item 2 — the closeout proof envelopes ──────────────────────────────
//
// The all-rows-duplicate branch in index.js correlates when `ledger_seal` or
// `session_plans_closeout` is present, because with the Session Plan lanes enabled that branch
// really can append the Session_Plans closeout event and stamp the Session_Plan_Sets seal — the
// sealed sidecar write the Phase-4 trace exists to capture. But NEITHER envelope was in
// PROOF_KEYS, and both are nested objects that the scalar-only copier drops regardless, so the
// emitted record reported zero rows and no seal evidence at all: a trigger with no evidence.
//
// The fix is bounded scalar PROJECTIONS — flattened, closed-whitelist, never a pass-through. The
// envelopes carry fields that must NOT be published: the seal's `conflicting_write_ids` (array)
// and `diagnostics` (object), its `error` (an arbitrary exception message), and the closeout's
// `reason` (also `e.message`). A closed projection excludes all of those by default.

// Every fixture below is an envelope shape the producing code can ACTUALLY return, copied from
// `sealCloseout` / `sessionPlanCapture._envelope` rather than composed by hand. Codex
// (r3649648870) caught the first draft combining a successful stamp's `sheet_written:true` +
// `sealed:5` with the all-sealed branch's `reason:'all_sealed'` — a combination `sealCloseout`
// cannot produce, so the test proved the projection against a state that never occurs.

// The LIVE successful stamp (sessionPlanSetsStore, end of sealCloseout). Note: no `reason`.
const SEAL_STAMPED = Object.freeze({
  sheet_written: true, no_write_confirmed: false, sealed: 5, already_sealed: 2, sealed_ok: true, column: 'X',
});
// The idempotent all-already-sealed replay. Note: sheet_written FALSE and sealed 0 — this is the
// shape that carries `reason:'all_sealed'`.
const SEAL_ALL_SEALED = Object.freeze({
  sheet_written: false, no_write_confirmed: true, sealed: 0, already_sealed: 7, sealed_ok: true, reason: 'all_sealed',
});

test('buildWriteProofRecord: projects a LIVE STAMPED seal as bounded scalars', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID,
    sessionId: SESSION,
    route: '/api/log-workout',
    proof: { sheet_write: 'skipped_duplicate', log_rows_written: 0, ledger_seal: { ...SEAL_STAMPED } },
  });
  // The seal really did write — that is the whole justification for correlating this branch, and
  // before this projection the record could not show it at all.
  assert.equal(record.proof.ledger_seal_sheet_written, true);
  assert.equal(record.proof.ledger_seal_sealed, 5);
  assert.equal(record.proof.ledger_seal_already_sealed, 2);
  assert.equal(record.proof.ledger_seal_sealed_ok, true);
  assert.equal(record.proof.ledger_seal_no_write_confirmed, false);
  // A successful stamp carries no `reason`, so none may be invented for it.
  assert.ok(!('ledger_seal_reason' in record.proof));
  // `column` is a real scalar on that envelope but is not whitelisted — closed by default.
  assert.ok(!('ledger_seal_column' in record.proof));
  // The nested envelope itself must never survive — project, never pass through.
  assert.ok(!('ledger_seal' in record.proof), 'the nested envelope must not be carried');
});

test('buildWriteProofRecord: projects the idempotent all-sealed replay distinguishably', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID, sessionId: SESSION, route: '/api/log-workout',
    proof: { ledger_seal: { ...SEAL_ALL_SEALED } },
  });
  // Verified but wrote nothing — a reviewer must be able to tell this from a fresh stamp.
  assert.equal(record.proof.ledger_seal_sealed_ok, true);
  assert.equal(record.proof.ledger_seal_sheet_written, false);
  assert.equal(record.proof.ledger_seal_sealed, 0);
  assert.equal(record.proof.ledger_seal_already_sealed, 7);
  assert.equal(record.proof.ledger_seal_reason, 'all_sealed');
});

test('buildWriteProofRecord: projects the closeout event envelope as bounded scalars', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID,
    sessionId: SESSION,
    route: '/api/log-workout',
    // The exact `_envelope('written', true, …)` shape, `plan_version` and null `reason` included.
    proof: {
      session_plans_closeout: {
        status: 'written', captured: true, written: 1, skipped: 0,
        plan_version: 'pv_3f2504e0-4f89-41d3-9a0c-0305e82c3301', reason: null,
      },
    },
  });
  assert.equal(record.proof.session_plans_closeout_status, 'written');
  assert.equal(record.proof.session_plans_closeout_captured, true);
  assert.equal(record.proof.session_plans_closeout_written, 1);
  assert.equal(record.proof.session_plans_closeout_skipped, 0);
  assert.ok(!('session_plans_closeout' in record.proof));
  // plan_version IS projected: it is hashed into sessionPlanEvents.idempotencyKey, so it is the
  // event's row discriminator. Without it, a session with more than one accepted plan version
  // leaves the record unable to say WHICH session_closeout row this was — and the slice-3 artifact
  // join could not substantiate its own turn→closeout claim. (Excluded in the first draft as "a
  // plan token rather than write proof"; being the discriminator is what makes it write proof.)
  assert.equal(record.proof.session_plans_closeout_plan_version, 'pv_3f2504e0-4f89-41d3-9a0c-0305e82c3301');
});

// Codex P1 (r3649675188) — projecting plan_version without bounding it made the record a
// pass-through for arbitrary client text. `closeoutPlanVersion` accepts ANY string matching
// /^pv_.+/ straight from the request body (index.js:2842), `sessionPlanCapture` echoes it, and the
// scalar filter imposes no length or vocabulary bound — so a corrupted client could push most of
// the 1 MB body limit into the `[turn-write-proof]` line. Genuine tokens are `pv_` + a UUID
// (src/app/planAcceptance.js mintId), a fixed 39-char shape, so requiring it costs nothing real.

const VALID_PV = 'pv_3f2504e0-4f89-41d3-9a0c-0305e82c3301';

test('buildWriteProofRecord: a canonical pv_ UUID projects', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID, sessionId: SESSION, route: '/api/log-workout',
    proof: { session_plans_closeout: { status: 'written', captured: true, plan_version: VALID_PV } },
  });
  assert.equal(record.proof.session_plans_closeout_plan_version, VALID_PV);
});

test('buildWriteProofRecord: a malformed plan_version is NOT projected, and never reaches the record', () => {
  const smuggled = `pv_${'PRIVATE-NOTE-'.repeat(200)}`;
  for (const bad of [
    smuggled,                       // arbitrary text behind a valid-looking prefix
    'pv_not-a-uuid',
    'pv_',
    `pv_${'a'.repeat(4096)}`,       // unbounded
    'plan_v1',                      // no prefix
    `${VALID_PV} `,                 // padded
    `${VALID_PV}x`,                 // suffixed
    VALID_PV.replace('-', ''),      // wrong UUID shape
  ]) {
    const record = tc.buildWriteProofRecord({
      turnId: TURN_ID, sessionId: SESSION, route: '/api/log-workout',
      proof: { session_plans_closeout: { status: 'written', captured: true, written: 1, plan_version: bad } },
    });
    assert.ok(
      !('session_plans_closeout_plan_version' in record.proof),
      `plan_version ${JSON.stringify(bad).slice(0, 40)} must not project`,
    );
    // The rest of the envelope still projects — one bad field costs its own key, not the evidence.
    assert.equal(record.proof.session_plans_closeout_captured, true);
    assert.equal(record.proof.session_plans_closeout_written, 1);
  }
  // And the smuggled text must appear nowhere in the serialized record.
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID, sessionId: SESSION, route: '/api/log-workout',
    proof: { session_plans_closeout: { status: 'written', captured: true, plan_version: smuggled } },
  });
  assert.ok(!JSON.stringify(record).includes('PRIVATE-NOTE'), 'no smuggled text in the record');
});

test('buildWriteProofRecord: every projected string is length-bounded, whatever the field', () => {
  // The structural backstop for the root cause Codex named: the scalar filter bounds no string
  // length. `ledger_seal.reason` is fixed-vocabulary TODAY (verified by enumeration), but that is a
  // property of code that could change, so the projection must not rely on it alone.
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID, sessionId: SESSION, route: '/api/log-workout',
    proof: { ledger_seal: { sealed_ok: false, reason: `x${'LEAK'.repeat(2000)}` } },
  });
  assert.ok(!('ledger_seal_reason' in record.proof), 'an over-long projected string is dropped');
  assert.equal(record.proof.ledger_seal_sealed_ok, false, 'its bounded siblings still project');
  assert.ok(!JSON.stringify(record).includes('LEAKLEAK'));
});

test('buildWriteProofRecord: a null plan_version projects as null, never as absent-so-assumed', () => {
  // `_envelope` defaults plan_version to null (e.g. the no_plan / disabled paths), and null is a
  // scalar, so it must come through as an explicit null rather than being silently omitted.
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID, sessionId: SESSION, route: '/api/log-workout',
    proof: { session_plans_closeout: { status: 'disabled', captured: false, written: 0, skipped: 0, plan_version: null } },
  });
  assert.ok('session_plans_closeout_plan_version' in record.proof);
  assert.equal(record.proof.session_plans_closeout_plan_version, null);
});

test('buildWriteProofRecord: a FAILED seal is projected honestly, never softened', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID,
    sessionId: SESSION,
    route: '/api/log-workout',
    proof: {
      ledger_seal: { sheet_written: false, sealed: 0, already_sealed: 0, sealed_ok: false, reason: 'ledger_read_failed' },
      session_plans_closeout: { status: 'error', captured: false, written: 0 },
      closeout_fully_verified: false,
    },
  });
  assert.equal(record.proof.ledger_seal_sealed_ok, false);
  assert.equal(record.proof.ledger_seal_reason, 'ledger_read_failed');
  assert.equal(record.proof.session_plans_closeout_captured, false);
  assert.equal(record.proof.closeout_fully_verified, false);
});

test('buildWriteProofRecord: the projection is CLOSED — diagnostics, ids and error text never survive', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID,
    sessionId: SESSION,
    route: '/api/log-workout',
    proof: {
      ledger_seal: {
        sealed_ok: false,
        reason: 'conflicting_seal',
        // Arrays and objects: droppable by shape.
        conflicting_write_ids: ['w-someone-elses-closeout'],
        diagnostics: { plan_item_id: 'pi_dip', set_index: 2 },
        // A scalar, but an ARBITRARY exception string — index.js wraps a seal throw as
        // { reason:'seal_error', error: String(error.message) }. Excluded by not being listed.
        error: 'Sheets API 403 for spreadsheet 1AbCdEfGhIjKlMnOpQrStUvWxYz',
      },
      session_plans_closeout: {
        status: 'error',
        captured: false,
        // Also an arbitrary message (`e.message` in sessionPlanCapture._capture).
        reason: 'revision collision on 1AbCdEfGhIjKlMnOpQrStUvWxYz',
      },
    },
  });
  for (const banned of [
    'ledger_seal_conflicting_write_ids', 'ledger_seal_diagnostics', 'ledger_seal_error',
    'session_plans_closeout_reason',
  ]) {
    assert.ok(!(banned in record.proof), `${banned} must not survive the projection`);
  }
  const serialized = JSON.stringify(record);
  for (const secret of ['1AbCdEfGhIjKlMnOpQrStUvWxYz', 'w-someone-elses-closeout', 'pi_dip', 'Sheets API 403']) {
    assert.ok(!serialized.includes(secret), `record must not carry "${secret}"`);
  }
  // The honest verdict still comes through.
  assert.equal(record.proof.ledger_seal_sealed_ok, false);
  assert.equal(record.proof.ledger_seal_reason, 'conflicting_seal');
});

test('buildWriteProofRecord: a non-object or absent envelope projects nothing, and never throws', () => {
  for (const ledger_seal of [null, undefined, 'sealed', 42, [], true]) {
    const record = tc.buildWriteProofRecord({
      turnId: TURN_ID, sessionId: SESSION, route: '/api/log-workout',
      proof: { sheet_written: true, ledger_seal },
    });
    assert.ok(record, `must still build for ledger_seal=${JSON.stringify(ledger_seal)}`);
    assert.equal(record.proof.sheet_written, true, 'the flat proof keys are unaffected');
    for (const key of Object.keys(record.proof)) {
      assert.ok(!key.startsWith('ledger_seal_'), `no seal projection for ${JSON.stringify(ledger_seal)}`);
    }
    assert.ok(!('ledger_seal' in record.proof));
  }
});

test('buildWriteProofRecord: a nested value INSIDE a projected envelope is dropped, not serialized', () => {
  const record = tc.buildWriteProofRecord({
    turnId: TURN_ID, sessionId: SESSION, route: '/api/log-workout',
    // `sealed` is whitelisted, but an object on it must still be refused by the scalar filter —
    // the whitelist says WHICH fields, the scalar filter says WHAT SHAPE. Both must hold.
    proof: { ledger_seal: { sealed: { rows: [['Bench Press', 225]] }, sealed_ok: true } },
  });
  assert.ok(!('ledger_seal_sealed' in record.proof), 'a nested value on a whitelisted field is dropped');
  assert.equal(record.proof.ledger_seal_sealed_ok, true, 'its scalar siblings still project');
  assert.ok(!JSON.stringify(record).includes('Bench Press'));
});

test('PROOF_PROJECTIONS: every projected key is namespaced, so none can collide with a flat proof key', () => {
  const flat = new Set(tc.PROOF_KEYS);
  for (const [envelope, fields] of Object.entries(tc.PROOF_PROJECTIONS)) {
    for (const field of fields) {
      const projected = `${envelope}_${field}`;
      assert.ok(!flat.has(projected), `${projected} would collide with a top-level proof key`);
    }
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

test('initiation retirement: B tombstones A before either response can establish completion-order authority', () => {
  reset();
  const now = 1_000_000;
  const initiationA = 'init:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const initiationB = 'init:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });

  // B completes first and explicitly retires A, even though A has not completed yet.
  const b = tc.resolveCorrelation(
    { correlation: {
      turn_id: TURN_ID,
      initiation_nonce: initiationB,
      retire_initiation_nonces: [initiationA],
    } },
    { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  assert.equal(b.ok, true);

  // A's late completion must not mint a token or revive an older preview.
  const lateA = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID, initiation_nonce: initiationA } },
    { sessionId: SESSION, nowMs: now + 2, ...PREVIEW },
  );
  assert.equal(lateA.ok, false);
  assert.equal(lateA.reason, 'superseded');
  assert.equal(lateA.pairing_token, undefined);

  const liveB = tc.resolveCorrelation(
    { correlation: {
      turn_id: TURN_ID,
      initiation_nonce: initiationB,
      pairing_token: b.pairing_token,
    } },
    { sessionId: SESSION, nowMs: now + 3, writeId: 'w-b' },
  );
  assert.equal(liveB.ok, true);
});

test('initiation retirement: A completing first is removed when B explicitly supersedes it', () => {
  reset();
  const now = 1_000_000;
  const initiationA = 'init:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const initiationB = 'init:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });

  const a = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID, initiation_nonce: initiationA } },
    { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  assert.equal(a.ok, true);

  const b = tc.resolveCorrelation(
    { correlation: {
      turn_id: TURN_ID,
      initiation_nonce: initiationB,
      retire_initiation_nonces: [initiationA],
    } },
    { sessionId: SESSION, nowMs: now + 2, ...PREVIEW },
  );
  assert.equal(b.ok, true);

  const staleA = tc.resolveCorrelation(
    { correlation: {
      turn_id: TURN_ID,
      initiation_nonce: initiationA,
      pairing_token: a.pairing_token,
    } },
    { sessionId: SESSION, nowMs: now + 3, writeId: 'w-a' },
  );
  assert.equal(staleA.ok, false);
  assert.equal(staleA.reason, 'superseded');
});

test('initiation retirement: malformed or over-broad retirement fails closed without retiring a valid pairing', () => {
  reset();
  const now = 1_000_000;
  const initiationA = 'init:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const a = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID, initiation_nonce: initiationA } },
    { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );

  for (const retire_initiation_nonces of [
    'not-an-array',
    ['not-a-nonce'],
    Array.from({ length: 100 }, (_, i) => `init:${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`),
  ]) {
    const bad = tc.resolveCorrelation(
      { correlation: {
        turn_id: TURN_ID,
        initiation_nonce: 'init:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        retire_initiation_nonces,
      } },
      { sessionId: SESSION, nowMs: now + 2, ...PREVIEW },
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'malformed');
  }

  const stillValid = tc.resolveCorrelation(
    { correlation: {
      turn_id: TURN_ID,
      initiation_nonce: initiationA,
      pairing_token: a.pairing_token,
    } },
    { sessionId: SESSION, nowMs: now + 3, writeId: 'w-a' },
  );
  assert.equal(stillValid.ok, true, 'a rejected retirement claim must not mutate registry state');
});

test('initiation retirement: a genuine token cannot be relabelled with another initiation nonce', () => {
  reset();
  const now = 1_000_000;
  const initiationA = 'init:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const initiationB = 'init:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const a = tc.resolveCorrelation(
    { correlation: { turn_id: TURN_ID, initiation_nonce: initiationA } },
    { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const forged = tc.resolveCorrelation(
    { correlation: {
      turn_id: TURN_ID,
      initiation_nonce: initiationB,
      pairing_token: a.pairing_token,
    } },
    { sessionId: SESSION, nowMs: now + 2, writeId: 'w-forged' },
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.reason, 'pairing_mismatch');
});

// Codex sixth round P1 (r3649604170). A PREVIEW record reported `payload_bound: true` merely
// because an identity was computable — before any live payload existed to compare. The record
// therefore published the write-level match on a preview-only flow, contradicting the comment on
// the very line that produced it. A computable identity at preview is a CAPABILITY, not a match.

test('a PREVIEW record never claims payload_bound — no live payload has been compared yet', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // A fully computable identity: session_id + log_rows are both present.
  const preview = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID } }), { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  assert.equal(preview.ok, true);
  assert.equal(preview.pairing.established_at_preview, true, 'the pairing IS established');
  assert.equal(preview.pairing.payload_bound, false, 'but nothing has been payload-matched yet');
  assert.equal(preview.pairing.write_attempt, 0);

  // Only the live match may claim it.
  const live = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID, pairing_token: preview.pairing_token } }),
    { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' },
  );
  assert.equal(live.pairing.payload_bound, true, 'the live write that matched may');
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

// Codex second-round P1 (r3649542461). The first payload gate covered only
// session_id + date + log_rows — a default-ALLOW list. But `/api/log-workout` also APPENDS
// `effort_row` (index.js:2930) and drives the closeout capture + ledger seal from
// `closeout_context` (index.js:3172, 3320), so a live request could change either while keeping
// the three covered fields and still be reported `payload_bound: true`. The identity is now
// default-DENY — the whole payload minus a documented exclusion list — so a field added to the
// payload in future is bound automatically instead of silently unbound.

test('a CHANGED effort_row is refused — it is appended, so it is part of the write', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID }, effort_row: ['2026-07-25', SESSION, 3600, 400] }),
    { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const swapped = payloadWith({
    correlation: { turn_id: TURN_ID, pairing_token },
    effort_row: ['2026-07-25', SESSION, 7200, 900],
  });
  const r = tc.resolveCorrelation(swapped, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload_mismatch');
});

test('a CHANGED closeout_context is refused — it drives the capture and the seal', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID }, closeout_context: { plan_version: 'pv_1', items: [] } }),
    { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  const swapped = payloadWith({
    correlation: { turn_id: TURN_ID, pairing_token },
    closeout_context: { plan_version: 'pv_2', items: [] },
  });
  assert.equal(
    tc.resolveCorrelation(swapped, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' }).reason,
    'payload_mismatch',
  );
});

test('the identity is default-DENY: a field the preview never carried is refused', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID } }), { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  // Whatever this field does, the previewed write did not include it. A default-allow list would
  // have accepted it silently; that is the class of gap the second-round P1 found.
  const extra = payloadWith({ correlation: { turn_id: TURN_ID, pairing_token }, plan_exercises: [{ name: 'Squat' }] });
  assert.equal(
    tc.resolveCorrelation(extra, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' }).reason,
    'payload_mismatch',
  );
});

test('the excluded fields really are excluded: test_mode, write_id and the token itself', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID }, test_mode: 'true', write_id: 'w-1' }),
    { sessionId: SESSION, nowMs: now + 1, isPreview: true, previewedWriteId: 'w-1' },
  );
  // The approve deletes test_mode (app.js:7507), may re-mint write_id (7566), and carries a
  // correlation envelope that necessarily differs. None may cost the correlation.
  const approve = payloadWith({ correlation: { turn_id: TURN_ID, pairing_token }, write_id: 'w-9' });
  const r = tc.resolveCorrelation(approve, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-9' });
  assert.equal(r.ok, true);
  assert.equal(r.pairing.payload_bound, true);
});

// Codex third round P1 (r3649557072). Permitting the effort-dropped digest unconditionally let
// the VERY FIRST live request silently omit the previewed Effort append and still be reported
// `payload_bound: true` — it never performed the write that was previewed. The real retry is
// distinguishable and Codex named the distinguisher: app.js only deletes `effort_row` AFTER a
// first live write committed rows and came back `closeout_fully_verified:false` (app.js:7563-7567),
// so by then this same pairing has already accepted an EXACT-identity write. The relaxed
// comparison is gated on exactly that pairing state, and the transition is recorded.

test('effort_row REMOVAL is permitted only AFTER an exact-identity write on the same pairing', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const closeout = { plan_version: 'pv_1', items: [] };
  const effort = ['2026-07-25', SESSION, 3600, 400];
  const { pairing_token } = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID }, test_mode: 'true', write_id: 'w-1', effort_row: effort, closeout_context: closeout }),
    { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );

  // The FIRST live write drops effort. That is NOT the documented retry — it is a client mutation
  // on the initial approval, and the previewed Effort append never happens.
  const droppedFirst = payloadWith({ correlation: { turn_id: TURN_ID, pairing_token }, write_id: 'w-1', closeout_context: closeout });
  const early = tc.resolveCorrelation(droppedFirst, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' });
  assert.equal(early.ok, false, 'an effort drop before any exact write must not claim an exact binding');
  assert.equal(early.reason, 'payload_mismatch');

  // The real first approve matches exactly.
  const exact = payloadWith({ correlation: { turn_id: TURN_ID, pairing_token }, write_id: 'w-1', effort_row: effort, closeout_context: closeout });
  const first = tc.resolveCorrelation(exact, { sessionId: SESSION, nowMs: now + 3, writeId: 'w-1' });
  assert.equal(first.ok, true);
  assert.equal(first.pairing.effort_transition, false, 'an exact match is not a transition');

  // NOW the documented retry is legal: effort deleted, write_id re-minted (app.js:7566-7567).
  const retry = payloadWith({ correlation: { turn_id: TURN_ID, pairing_token }, write_id: 'w-2', closeout_context: closeout });
  const ok = tc.resolveCorrelation(retry, { sessionId: SESSION, nowMs: now + 4, writeId: 'w-2' });
  assert.equal(ok.ok, true, 'the documented retry must not be locked out');
  assert.equal(ok.pairing.payload_bound, true);
  assert.equal(ok.pairing.effort_transition, true, 'and the reviewer must see it was the relaxed match');

  // Still only removal: dropping effort AND altering the closeout context is refused even now.
  const overreach = payloadWith({
    correlation: { turn_id: TURN_ID, pairing_token },
    write_id: 'w-3',
    closeout_context: { plan_version: 'pv_2', items: [] },
  });
  assert.equal(
    tc.resolveCorrelation(overreach, { sessionId: SESSION, nowMs: now + 5, writeId: 'w-3' }).reason,
    'payload_mismatch',
    'the permitted transition is effort REMOVAL alone, not a licence to change anything else',
  );
});

// ─── row-level session identity (Codex third round P1, r3649557069) ────────────
//
// `normalizeLogRowObject` (index.js:449) resolves each row's session as
// `row.session_id || row.sessionId || topLevelSessionId` — a row-level id WINS. And an array
// `effort_row` is passed through verbatim (index.js:541-545), so its session column is
// client-controlled too. Comparing only the top-level session let a request write rows under
// session B while the correlation record named session A: cross-session contamination inside the
// evidence itself. Every EXPLICIT row-level session identity must match the bound session.

test('a log row naming a DIFFERENT session is refused (session_mismatch)', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  for (const key of ['session_id', 'sessionId']) {
    const rogue = payloadWith({
      correlation: { turn_id: TURN_ID },
      log_rows: [
        { exercise: 'Bench Press', weight: 225, reps: 5, set_number: 1 },
        { exercise: 'Bench Press', weight: 225, reps: 5, set_number: 2, [key]: OTHER_SESSION },
      ],
    });
    // Refused at PREVIEW, so no pairing is left behind for a live write to find either.
    const preview = tc.resolveCorrelation(rogue, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW });
    assert.equal(preview.ok, false, `row-level ${key} must not establish a pairing`);
    assert.equal(preview.reason, 'session_mismatch');
    // And refused on a live write.
    const live = tc.resolveCorrelation(rogue, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' });
    assert.equal(live.ok, false, `row-level ${key} must not correlate`);
    assert.equal(live.reason, 'session_mismatch');
  }
});

// Codex seventh round P1 (r3649614757). `_renderSessionValue` trimmed before comparing, which made
// the GATE more permissive than the WRITE PATH: `normalizeLogRowObject` keeps the truthy value
// as-is, and positional Log rows and Effort rows are written verbatim. So `'S1 '` passed the gate
// as `'S1'` while the row was appended under `'S1 '`, and the record named `'S1'` — the exact
// cross-session evidence mismatch this gate exists to prevent. Padded values are now REFUSED
// rather than normalized, at every level, because equivalence-by-trim is not a property the write
// path has.

test('a PADDED session value is refused everywhere — the write path does not trim', () => {
  reset();
  const now = 1_000_000;
  const padded = `${SESSION} `;
  const shapes = {
    'object log row': { log_rows: [{ exercise: 'Bench Press', weight: 225, reps: 5, set_number: 1, session_id: padded }] },
    'positional log row': { log_rows: [positionalRow(padded)] },
    'array effort_row': { effort_row: ['2026-07-25', padded, 3600, 400, 500, 130, 165, 'Gym', ''] },
    'object effort_row': { effort_row: { date: '2026-07-25', session_id: padded, duration: 3600 } },
  };
  for (const [label, extra] of Object.entries(shapes)) {
    reset();
    tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
    const rogue = payloadWith({ correlation: { turn_id: TURN_ID }, ...extra });
    assert.equal(
      tc.resolveCorrelation(rogue, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).reason,
      'session_mismatch',
      `${label}: a padded session must be refused, not trimmed into a match`,
    );
  }
});

test('a PADDED top-level session is refused too — the same defect, one level up', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // /api/log-workout destructures session_id without trimming (index.js:2865), so a padded
  // top-level session is written verbatim into every row while the record would name the
  // trimmed form. Codex named the row-level half; this is the same class above it.
  const r = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID } }),
    { sessionId: `${SESSION} `, nowMs: now + 1, ...PREVIEW },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'session_mismatch');
});

test('a log row that repeats the bound session explicitly is fine', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const ok = payloadWith({
    correlation: { turn_id: TURN_ID },
    log_rows: [{ exercise: 'Bench Press', weight: 225, reps: 5, set_number: 1, session_id: SESSION }],
  });
  assert.equal(tc.resolveCorrelation(ok, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).ok, true);
});

// Codex fourth round P1 (r3649569662) — the third path, and the one I asked for. `log_rows` also
// accepts the POSITIONAL Log_Cleaned array form, and `logRowArrayToObject` (index.js:512) sets
// `session_id: row[1]` with NO top-level fallback at all. So a positional row's session is ALWAYS
// explicit, and skipping non-object rows left it entirely unchecked.

// A positional Log_Cleaned row: date_clean | session_id | exercise | … (12 columns, 11 also legal).
function positionalRow(sessionValue) {
  const row = new Array(logCleanedColumns.length).fill('');
  row[logCleanedColumns.indexOf('date_clean')] = '2026-07-25';
  row[logCleanedColumns.indexOf('session_id')] = sessionValue;
  row[logCleanedColumns.indexOf('exercise')] = 'Bench Press';
  row[logCleanedColumns.indexOf('set_number')] = 1;
  row[logCleanedColumns.indexOf('weight')] = 225;
  row[logCleanedColumns.indexOf('reps')] = 5;
  return row;
}

test('a POSITIONAL log row naming a different session is refused', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const rogue = payloadWith({ correlation: { turn_id: TURN_ID }, log_rows: [positionalRow(OTHER_SESSION)] });
  assert.equal(tc.resolveCorrelation(rogue, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).reason, 'session_mismatch');
  assert.equal(tc.resolveCorrelation(rogue, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' }).reason, 'session_mismatch');
});

test('a POSITIONAL log row carrying the bound session is fine', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const ok = payloadWith({ correlation: { turn_id: TURN_ID }, log_rows: [positionalRow(SESSION)] });
  assert.equal(tc.resolveCorrelation(ok, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).ok, true);
});

test('a POSITIONAL log row with an EMPTY session is refused — there is no fallback to inherit', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // Unlike the object form, `logRowArrayToObject` has no `|| topLevelSessionId`: an empty element 1
  // is WRITTEN as an empty session_id, so it is a different session, not an inherited one.
  for (const empty of ['', '   ', null, undefined]) {
    const rogue = payloadWith({ correlation: { turn_id: TURN_ID }, log_rows: [positionalRow(empty)] });
    assert.equal(
      tc.resolveCorrelation(rogue, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).reason,
      'session_mismatch',
      `positional session ${JSON.stringify(empty)} must fail closed`,
    );
  }
});

test('a PRESENT but non-string row session fails closed rather than being skipped', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // `normalizeLogRowObject` uses `row.session_id || row.sessionId || topLevel`, so any TRUTHY
  // value wins — including a number or an object. A string-only check silently skipped these.
  // '   ' belongs here, not with the falsy set below: whitespace is TRUTHY, so it WINS the `||`
  // chain and the row is written under a whitespace session — a different session, not an
  // inherited one. (This corrects my own first expectation, which the test caught.)
  for (const weird of [12345, true, { nested: 'x' }, ['a'], '   ']) {
    const rogue = payloadWith({
      correlation: { turn_id: TURN_ID },
      log_rows: [{ exercise: 'Bench Press', weight: 225, reps: 5, set_number: 1, session_id: weird }],
    });
    assert.equal(
      tc.resolveCorrelation(rogue, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).reason,
      'session_mismatch',
      `row session ${JSON.stringify(weird)} must fail closed`,
    );
  }
});

test('an object row with a FALSY session inherits the top level and is fine', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // Falsy ⇒ `normalizeLogRowObject` falls through to topLevelSessionId, which is already checked.
  // Note '   ' is NOT here — whitespace is truthy, so it wins the `||` and is a real mismatch.
  for (const falsy of ['', null, undefined, 0, false]) {
    const fine = payloadWith({
      correlation: { turn_id: TURN_ID },
      log_rows: [{ exercise: 'Bench Press', weight: 225, reps: 5, set_number: 1, session_id: falsy }],
    });
    assert.equal(
      tc.resolveCorrelation(fine, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).ok,
      true,
      `falsy row session ${JSON.stringify(falsy)} inherits and must not be refused`,
    );
  }
});

test('an effort_row naming a DIFFERENT session is refused, array or object form', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // Array form: positional, and the Effort contract is date | session_id | duration | …
  const rogueArray = payloadWith({
    correlation: { turn_id: TURN_ID },
    effort_row: ['2026-07-25', OTHER_SESSION, 3600, 400, 500, 130, 165, 'Gym', ''],
  });
  assert.equal(
    tc.resolveCorrelation(rogueArray, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).reason,
    'session_mismatch',
  );
  const rogueObject = payloadWith({
    correlation: { turn_id: TURN_ID },
    effort_row: { date: '2026-07-25', session_id: OTHER_SESSION, duration: 3600 },
  });
  assert.equal(
    tc.resolveCorrelation(rogueObject, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' }).reason,
    'session_mismatch',
  );
});

// Codex fifth round P1 (r3649591244) — the fourth shape, and the semantics here are the OPPOSITE
// of an object log row. `normalizeEffortRow` selects aliases by PROPERTY PRESENCE
// (`hasOwnProperty`, index.js:548-555), not truthiness, so a FALSY session_id is written VERBATIM
// to the Effort session column instead of inheriting the top level. Reusing the log-row truthiness
// rule here skipped exactly those values.

test('an object-form effort_row with a FALSY session is refused — presence, not truthiness', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  for (const falsy of ['', 0, false, null]) {
    const rogue = payloadWith({
      correlation: { turn_id: TURN_ID },
      effort_row: { date: '2026-07-25', session_id: falsy, duration: 3600 },
    });
    assert.equal(
      tc.resolveCorrelation(rogue, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).reason,
      'session_mismatch',
      `effort session ${JSON.stringify(falsy)} is written verbatim and must fail closed`,
    );
  }
});

test('the sessionId alias on an object-form effort_row is checked too', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  for (const bad of [OTHER_SESSION, '', 0]) {
    const rogue = payloadWith({
      correlation: { turn_id: TURN_ID },
      effort_row: { date: '2026-07-25', sessionId: bad, duration: 3600 },
    });
    assert.equal(
      tc.resolveCorrelation(rogue, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).reason,
      'session_mismatch',
      `effort sessionId ${JSON.stringify(bad)} must fail closed`,
    );
  }
});

test('the effort session is compared via the SAME alias normalization will select', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // Both aliases present. `effortRowFieldAliases.session_id` is ['session_id','sessionId'] and
  // normalization takes the FIRST present, so the value actually WRITTEN is the bound session —
  // this must not be refused on account of the ignored alias.
  const ok = payloadWith({
    correlation: { turn_id: TURN_ID },
    effort_row: { date: '2026-07-25', session_id: SESSION, sessionId: OTHER_SESSION, duration: 3600 },
  });
  assert.equal(
    tc.resolveCorrelation(ok, { sessionId: SESSION, nowMs: now + 1, ...PREVIEW }).ok,
    true,
    'the alias normalization ignores must not decide the correlation',
  );
  // And the reverse: the FIRST alias is the rogue one, so it IS what gets written.
  const rogue = payloadWith({
    correlation: { turn_id: TURN_ID },
    effort_row: { date: '2026-07-25', session_id: OTHER_SESSION, sessionId: SESSION, duration: 3600 },
  });
  assert.equal(
    tc.resolveCorrelation(rogue, { sessionId: SESSION, nowMs: now + 2, ...PREVIEW }).reason,
    'session_mismatch',
  );
});

test('a preview with NO effort_row cannot have one added by the live write', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  const { pairing_token } = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID } }), { sessionId: SESSION, nowMs: now + 1, ...PREVIEW },
  );
  // Removal is permitted; ADDITION is an unpreviewed Effort append and must never be.
  const added = payloadWith({
    correlation: { turn_id: TURN_ID, pairing_token },
    effort_row: ['2026-07-25', SESSION, 3600, 400],
  });
  assert.equal(
    tc.resolveCorrelation(added, { sessionId: SESSION, nowMs: now + 2, writeId: 'w-1' }).reason,
    'payload_mismatch',
  );
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

test('the seal RETRY still matches — write_id and test_mode are outside the identity', () => {
  reset();
  const now = 1_000_000;
  tc.issueTurn(TURN_ID, SESSION, { nowMs: now });
  // The preview carries test_mode and a write_id (no effort row here — the effort REMOVAL
  // transition has its own case, since it is legal only after an exact-identity write).
  const { pairing_token } = tc.resolveCorrelation(
    payloadWith({ correlation: { turn_id: TURN_ID }, test_mode: 'true', write_id: 'w-1' }),
    { sessionId: SESSION, nowMs: now + 1, isPreview: true, previewedWriteId: 'w-1' },
  );
  // The approve drops test_mode; the seal retry re-mints write_id (app.js:7566). Both must be
  // irrelevant to the identity, or the retry is locked out.
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
