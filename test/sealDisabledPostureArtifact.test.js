'use strict';

// #1165 — the review artifact must be able to reach `complete` in the OWNER-GATED posture.
//
// Production acceptance run 2026-07-28 (deployed build 5c64938533ce) closed the cross-route
// correlation seam: one canonical turn_id retrieved the coach turn, its valid trace, its preview
// proof, and its live write proof. The consumer still returned `partial`, and the reason was not in
// the run. `SESSION_PLAN_SETS_WRITE_ENABLED=0` — the owner-gated F10D default and the CURRENT
// required posture — makes `sealCloseout` take its dry path, and the dry path drops the outcome
// classification the live path emits:
//
//   live,  confirmed-empty ledger → { sealed_ok: true,  reason: 'tab_missing' | 'no_rows' }
//   dry,   confirmed-empty ledger → { …dryProof, would_seal: 0, already_sealed: 0, no_ledger: true }
//                                    ↑ no sealed_ok at all; `reason` stays 'write_disabled'
//
// The consumer reads absent as unknown — correctly — so `sealed_ok: null` falls through every
// discriminating branch of `_sealSummary` to the terminal `indeterminate`, which raises
// `seal_not_verified`, which clears `reviewable`, which forces `status: "partial"`. While the flag
// is 0 the reviewability bar is therefore unreachable BY CONSTRUCTION.
//
// The epistemic state is identical in both rows above: the tab probe and the row read both
// SUCCEEDED and confirmed there is nothing to stamp. Only the emitted tuple differs. So the repair
// belongs at BOTH ends — the producer emits the verified outcome it already knows, and the consumer
// learns to accept that exact dry tuple — and at neither end alone:
//
//   consumer-only would have to treat `sealed_ok: null` as verified, inverting the artifact's
//   absent-means-unknown rule and letting a genuinely unknown seal read as confirmed;
//   producer-only cannot clear it, because `reason` stays 'write_disabled', which sits outside
//   VERIFIED_EMPTY_SEAL_REASONS — a distinction test/turnWriteArtifactGuards.test.js deliberately
//   pins, and which must keep holding.
//
// `would_seal: 0` is the load-bearing discriminator. A dry run with rows genuinely PENDING a stamp
// (`would_seal > 0`, services/sessionPlanSetsStore.js:319) is not verified and must stay
// unreviewable. That shape is also unreachable in this posture: the checkpoint writers gate on the
// same flag (:102), so while it is 0 the ledger is never populated and the confirmed-empty branches
// are the only ones a seal can take.
//
// Evidence here is SANITIZED and BOUNDED — synthetic records in the producer's exact shape. No raw
// production log, no session identifier, no write id, no append range, no prose.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTurnWriteArtifact } = require('../services/turnWriteArtifact');

// ── producer harness: the same require.cache sheets stub the store suite uses ──
const state = { tabs: ['Session_Plan_Sets'], rows: [], updates: [] };
const fakeSheets = {
  getSpreadsheetTabs: async () => state.tabs.slice(),
  getSheetRows: async (tab) => {
    if (!state.tabs.includes(tab)) throw new Error('tab missing');
    return state.rows.slice();
  },
  appendRows: async () => ({ data: { updates: { updatedRange: null, updatedRows: 0 } } }),
  readRange: async () => [['idempotency_key']],
  updateColumnCells: async (tab, column, cells) => {
    state.updates.push({ tab, column, cells });
    return { data: { totalUpdatedCells: cells.length } };
  },
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const storePath = require.resolve('../services/sessionPlanSetsStore');
function loadStore({ writeEnabled }) {
  delete require.cache[storePath];
  const prev = process.env.SESSION_PLAN_SETS_WRITE_ENABLED;
  process.env.SESSION_PLAN_SETS_WRITE_ENABLED = writeEnabled ? '1' : '0';
  try {
    return require(storePath);
  } finally {
    if (prev === undefined) delete process.env.SESSION_PLAN_SETS_WRITE_ENABLED;
    else process.env.SESSION_PLAN_SETS_WRITE_ENABLED = prev;
  }
}

const SESSION = { session_id: 'session-fixture-a' };

// Rows are built by the real ledger builder, so a fixture can never diverge from the shape
// `sealCloseout` parses and validates.
function ledgerRowsFor(sessionId) {
  const ledger = require('../services/sessionPlanLedger');
  return ledger.buildAcceptedRows(
    { session_id: sessionId, session_date: '2026-07-18' },
    [{
      plan_item_id: `pi_${sessionId}`,
      planned_lift_code: 'DIP01',
      target_set_count: 3,
      target_weight: 65,
      target_reps: 5,
      target_rir: 2,
    }],
    { recordedAt: 't' },
  );
}

// ── PRODUCER ──────────────────────────────────────────────────────────────────

test('#1165 producer: a confirmed-absent tab in the disabled posture is a VERIFIED empty seal', async () => {
  state.tabs = [];
  state.rows = [];
  state.updates = [];
  const store = loadStore({ writeEnabled: false });
  const r = await store.sealCloseout(SESSION, 'w-close-fixture');

  // W1–W3 dry-run proof is unchanged and stays intact.
  assert.equal(r.sheet_written, false);
  assert.equal(r.no_write_confirmed, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.reason, 'write_disabled');
  assert.equal(r.no_ledger, true);
  assert.equal(r.would_seal, 0);
  assert.equal(r.already_sealed, 0);
  assert.equal(state.updates.length, 0, 'a dry run never writes');

  // The probe SUCCEEDED and confirmed there is nothing to seal — the same fact the live path
  // reports as sealed_ok:true. Absent is not the honest encoding of a verified outcome.
  assert.equal(r.sealed_ok, true, 'confirmed-empty dry run must report its verified outcome');
});

test('#1165 producer: a session with no ledger rows in the disabled posture is a VERIFIED empty seal', async () => {
  state.tabs = ['Session_Plan_Sets'];
  state.rows = ledgerRowsFor('session-fixture-b');
  state.updates = [];
  const store = loadStore({ writeEnabled: false });
  const r = await store.sealCloseout(SESSION, 'w-close-fixture');

  assert.equal(r.sheet_written, false);
  assert.equal(r.no_write_confirmed, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.no_ledger, true);
  assert.equal(r.would_seal, 0);
  assert.equal(r.already_sealed, 0);
  assert.equal(state.updates.length, 0, 'a dry run never writes');
  assert.equal(r.sealed_ok, true, 'confirmed-empty dry run must report its verified outcome');
});

test('#1165 producer: a dry run with rows PENDING a stamp stays unverified', async () => {
  // The discriminator, held from the other side. This shape is unreachable while the flag is 0
  // (the checkpoint writers gate on it too), but it must never become verified by construction.
  state.tabs = ['Session_Plan_Sets'];
  state.rows = ledgerRowsFor(SESSION.session_id);
  state.updates = [];
  const store = loadStore({ writeEnabled: false });
  const r = await store.sealCloseout(SESSION, 'w-close-fixture');

  assert.equal(r.dry_run, true);
  assert.ok(r.would_seal > 0, 'rows are genuinely pending a stamp');
  assert.notEqual(r.sealed_ok, true, 'a pending stamp is not a verified seal');
});

// ── CONSUMER ──────────────────────────────────────────────────────────────────

const TURN = 'turn:2026-07-27T09:00:00.000Z_1_aaaaaa';

function traceRecord() {
  return {
    turn_id: TURN,
    started_at: '2026-07-27T09:00:00.000Z',
    valid: true,
    intent_type: 'block',
    source: 'coach_message',
    stages: [
      { stage: 'intent', status: 'ok' },
      { stage: 'session_snapshot', status: 'ok' },
      { stage: 'engine_decision', status: 'ok' },
      { stage: 'coaching_strategy', status: 'ok' },
      { stage: 'model_response', status: 'skipped' },
      { stage: 'validator_result', status: 'skipped' },
      { stage: 'rendered_output', status: 'ok' },
    ],
    missing: ['parser', 'knowledge_retrieval', 'write_proof'],
  };
}

// The live-write record the 2026-07-28 production run emitted, field for field, with the identifier
// and range replaced by fixtures. `ledger_seal_sealed_ok` is the one field under repair, so it is
// supplied by the caller rather than baked in.
function writeRecord(sealOverrides = {}) {
  return {
    schema_version: 1,
    turn_id: TURN,
    session_id: 'session-fixture-a',
    route: '/api/log-workout',
    recorded_at: '2026-07-27T09:00:02.000Z',
    pairing: {
      established_at_preview: true,
      write_attempt: 1,
      previewed_write_id_match: true,
      payload_bound: true,
      effort_transition: false,
    },
    proof: {
      test_mode: false,
      sheet_write: 'success',
      duplicate_write: false,
      log_rows_written: 4,
      effort_rows_written: 0,
      effortWritten: false,
      logAppendedRange: 'Log_Cleaned!A2:L5',
      idempotency_status: 'completed',
      closeout_fully_verified: true,
      ledger_seal_sheet_written: false,
      ledger_seal_no_write_confirmed: true,
      ledger_seal_dry_run: true,
      ledger_seal_already_sealed: 0,
      ledger_seal_would_seal: 0,
      ledger_seal_no_ledger: true,
      ledger_seal_reason: 'write_disabled',
      session_plans_closeout_status: 'written',
      session_plans_closeout_captured: true,
      session_plans_closeout_written: 1,
      session_plans_closeout_skipped: 0,
      session_plans_closeout_plan_version: 'pv_11111111-2222-3333-4444-555555555555',
      ...sealOverrides,
    },
    withheld_evidence: [],
  };
}

function build(...records) {
  return buildTurnWriteArtifact(records
    .map((record) => `2026-07-27T09:00:05Z ${record.schema_version === undefined ? '[interaction-trace]' : '[turn-write-proof]'} ${JSON.stringify(record)}`)
    .join('\n'));
}

test('#1165 consumer: the owner-gated posture reaches `complete`, not `seal_not_verified`', () => {
  const artifact = build(traceRecord(), writeRecord({ ledger_seal_sealed_ok: true }));
  const write = artifact.turns[0].writes[0];

  // The correlation this issue was filed for is intact either way — pinned so a seal regression
  // cannot be mistaken for a join regression.
  assert.equal(artifact.turns[0].join_status, 'joined');
  assert.equal(artifact.summary.rejected_records, 0);
  assert.equal(write.proof_state, 'write_confirmed');
  assert.equal(write.authorization, 'preview_payload_bound');

  assert.notEqual(write.seal.state, 'indeterminate', 'a verified empty dry run is not indeterminate');
  assert.ok(!write.issues.includes('seal_not_verified'), 'the lane is owner-disabled, not unverified');
  assert.equal(write.reviewable, true);
  assert.equal(artifact.turns[0].reviewable, true);
  assert.equal(artifact.status, 'complete');
});

test('#1165 consumer: a seal with no sealed_ok at all stays unverified', () => {
  // The producer half held from the consumer side: absent means unknown. The consumer must never
  // infer the verified outcome the producer failed to emit.
  const artifact = build(traceRecord(), writeRecord());
  const write = artifact.turns[0].writes[0];
  assert.equal(write.seal.sealed_ok, null);
  assert.ok(write.issues.includes('seal_not_verified'), 'absent is unknown, never verified');
  assert.equal(write.reviewable, false);
});

test('#1165 consumer: a live write whose seal claims `test_mode` is not producible, so it stays unverified', () => {
  // Codex P2 on this PR. `sealCloseout` can emit `reason:'test_mode'`, but nothing can carry it
  // HERE: the two calls whose result becomes `ledger_seal` pass `{}` (index.js:3257, :3404), and
  // the one that passes `{test_mode:true}` (:3093) lands in `ledger_seal_preview`, which this
  // consumer never projects. A live write (`test_mode:false`) whose seal says it was skipped for a
  // dry run is internally consistent and still impossible — exactly the fabricated shape that must
  // not reach `verified_empty_dry_run`.
  const artifact = build(traceRecord(), writeRecord({
    ledger_seal_sealed_ok: true,
    ledger_seal_reason: 'test_mode',
  }));
  const write = artifact.turns[0].writes[0];
  assert.notEqual(write.seal.state, 'verified_empty_dry_run');
  assert.ok(write.issues.includes('seal_not_verified'));
  assert.equal(write.reviewable, false);
  assert.notEqual(artifact.status, 'complete');
});

test('#1165 consumer: a dry run with rows PENDING a stamp stays unverified', () => {
  const artifact = build(traceRecord(), writeRecord({
    ledger_seal_sealed_ok: true,
    ledger_seal_would_seal: 2,
    ledger_seal_no_ledger: undefined,
  }));
  const write = artifact.turns[0].writes[0];
  assert.ok(write.issues.includes('seal_not_verified'), 'a pending stamp is not a verified seal');
  assert.equal(write.reviewable, false);
});
