'use strict';

// Guard-bite coverage for services/turnWriteArtifact.js.
//
// Rule 8: a guard is only real if it bites. A mutation sweep over the consumer — delete each
// production check in turn, run the focused suite — found that 52 of its 91 checks were proven by
// existing tests and 39 were not. A second, differential pass classified those 39: for each, does a
// CONSTRUCTIBLE input exist whose artifact output changes when the guard is removed? Where the
// answer is yes, the check is load-bearing and untested, and the case belongs here.
//
// The production logic was right throughout — every guard already behaved as its comment claimed.
// What was missing was the proof, and an unproven guard is what lets a later "simplification"
// delete a real check silently.
//
// Each test asserts the behavior that DIFFERS when its guard is removed, and carries the positive
// producer control beside it, so it fails for the intended reason rather than by coincidence.
//
// A note on how the first differential corpus was wrong, because it is the same defect this file
// exists to prevent: it varied many fields per record, so a probe aimed at (say) the sheet_write
// vocabulary was usually rejected for an unrelated malformed field before ever reaching that check,
// and 19 load-bearing guards read as redundant. Every probe below varies EXACTLY ONE field from a
// valid producer shape.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildTurnWriteArtifact } = require('../services/turnWriteArtifact');
const { MAX_WRITES_PER_PAIRING } = require('../services/turnCorrelation');

const TURN = 'turn:2026-07-27T09:00:00.000Z_1_aaaaaa';
const SESSION = 'session-2026-07-27-a';

function trace(overrides = {}) {
  return {
    turn_id: TURN,
    started_at: '2026-07-27T09:00:00.000Z',
    valid: true,
    intent_type: 'set',
    source: 'coach_message',
    stages: [
      { stage: 'intent', status: 'ok' },
      { stage: 'session_snapshot', status: 'ok' },
      { stage: 'engine_decision', status: 'ok' },
      { stage: 'coaching_strategy', status: 'ok' },
      { stage: 'model_response', status: 'ok' },
      { stage: 'validator_result', status: 'ok' },
      { stage: 'rendered_output', status: 'ok' },
    ],
    missing: ['parser', 'knowledge_retrieval', 'write_proof'],
    ...overrides,
  };
}

// A live /api/log-workout success: the shape the route actually emits.
function proofRecord(overrides = {}, proofOverrides = {}) {
  const record = {
    schema_version: 1,
    turn_id: TURN,
    session_id: SESSION,
    route: '/api/log-workout',
    recorded_at: '2026-07-27T09:00:02.000Z',
    pairing: {
      established_at_preview: true,
      write_attempt: 1,
      previewed_write_id_match: null,
      payload_bound: true,
      effort_transition: false,
    },
    proof: {
      test_mode: false,
      sheet_write: 'success',
      duplicate_write: false,
      idempotency_status: 'completed',
      logAppendedRange: 'Log_Cleaned!A2:L4',
      log_rows_written: 3,
      effort_rows_written: 0,
      ...proofOverrides,
    },
    withheld_evidence: [],
    ...overrides,
  };
  for (const [key, value] of Object.entries(proofOverrides)) {
    if (value === undefined) delete record.proof[key];
  }
  return record;
}

// The all-rows-duplicate branch, which index.js correlates only when a seal or closeout envelope
// exists (index.js:3276).
const SEAL_REPLAY = {
  ledger_seal_sealed_ok: true,
  ledger_seal_sheet_written: false,
  ledger_seal_no_write_confirmed: true,
  ledger_seal_sealed: 0,
  ledger_seal_already_sealed: 4,
  ledger_seal_reason: 'all_sealed',
};
const CLOSEOUT_SKIPPED = {
  session_plans_closeout_status: 'skipped',
  session_plans_closeout_captured: true,
  session_plans_closeout_written: 0,
  session_plans_closeout_skipped: 1,
  session_plans_closeout_plan_version: 'pv_11111111-2222-3333-4444-555555555555',
};
const DUPLICATE_SCALARS = {
  test_mode: false,
  sheet_write: 'skipped_duplicate',
  sheet_written: false,
  duplicate_write: true,
  log_rows_written: 0,
  skipped_duplicates: 3,
  idempotency_status: 'completed',
  closeout_fully_verified: true,
  logAppendedRange: undefined,
  effort_rows_written: undefined,
};

function duplicateRecord(proofOverrides = {}) {
  return proofRecord({}, { ...DUPLICATE_SCALARS, ...proofOverrides });
}

function lines(...records) {
  return records
    .map((record) => (typeof record === 'string'
      ? record
      : `2026-07-27T09:00:05Z ${record.schema_version === undefined ? '[interaction-trace]' : '[turn-write-proof]'} ${JSON.stringify(record)}`))
    .join('\n');
}

const build = (...records) => buildTurnWriteArtifact(lines(...records));
const firstWrite = (artifact) => artifact.turns[0].writes[0];

// A record the consumer rejected outright never becomes a write, and the turn reports the loss.
function assertRejected(artifact, why) {
  assert.equal(artifact.summary.rejected_records, 1, why);
  assert.equal(artifact.turns[0].writes.length, 0, why);
  assert.ok(artifact.turns[0].issues.includes('rejected_write_record'), why);
  assert.equal(artifact.status, 'partial', why);
}

// Every rejection test needs this beside it: the same record, unmutated, must survive.
function assertControlAccepted(artifact) {
  assert.equal(artifact.summary.rejected_records, 0, 'control record must not be rejected');
  assert.equal(artifact.turns[0].writes.length, 1, 'control record must produce a write');
  assert.equal(firstWrite(artifact).proof_state, 'write_confirmed');
  assert.equal(artifact.status, 'complete');
}

describe('turnWriteArtifact guards — interaction trace validation', () => {
  it('rejects a trace whose started_at is not an ISO timestamp', () => {
    const artifact = build(trace({ started_at: 'yesterday' }), proofRecord());
    assert.equal(artifact.turns[0].join_status, 'proof_only');
    assert.ok(artifact.turns[0].issues.includes('trace_missing'));
    assert.notEqual(artifact.status, 'complete');

    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a trace whose valid flag is not a boolean', () => {
    const artifact = build(trace({ valid: 'yes' }), proofRecord());
    assert.equal(artifact.turns[0].join_status, 'proof_only');
    assert.ok(artifact.turns[0].issues.includes('trace_missing'));
  });

  it('rejects a trace whose stages are out of canonical order or repeated', () => {
    const ordered = trace().stages;
    const reversed = build(trace({ stages: ordered.slice().reverse() }), proofRecord());
    assert.equal(reversed.turns[0].join_status, 'proof_only', 'reversed stages are not a producible trace');

    const repeated = build(
      trace({ stages: [...ordered, { stage: 'intent', status: 'ok' }] }),
      proofRecord(),
    );
    assert.equal(repeated.turns[0].join_status, 'proof_only', 'a repeated stage is not producible');

    // CONTROL — the real emitter's ascending, unique stage list.
    assert.equal(build(trace(), proofRecord()).turns[0].join_status, 'joined');
  });

  it('flags a trace the producer marked invalid rather than reporting it reviewable', () => {
    const artifact = build(trace({ valid: false }), proofRecord());
    assert.ok(artifact.turns[0].issues.includes('trace_invalid'));
    assert.equal(artifact.turns[0].reviewable, false);
    assert.notEqual(artifact.status, 'complete');

    assertControlAccepted(build(trace(), proofRecord()));
  });
});

describe('turnWriteArtifact guards — write-proof record validation', () => {
  it('rejects a proof record whose schema_version is not 1', () => {
    assertRejected(build(trace(), proofRecord({ schema_version: 2 })), 'schema_version 2 is not this contract');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a proof record whose route is not a known write route', () => {
    assertRejected(build(trace(), proofRecord({ route: '/api/undo' })), 'undo is not a correlated write route');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a proof record whose recorded_at is not an ISO timestamp', () => {
    assertRejected(build(trace(), proofRecord({ recorded_at: 'just now' })), 'recorded_at must be ISO 8601');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a session_id longer than the bounded producer contract', () => {
    assertRejected(build(trace(), proofRecord({ session_id: 'x'.repeat(200) })), 'session_id is bounded');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a write_attempt above the cap the producer refuses to exceed', () => {
    // turnCorrelation.js:836 REFUSES a further attempt, so an attempt beyond the cap is a shape no
    // producer can emit — unlike the preview history, where the registry merely evicts.
    assertRejected(
      build(trace(), proofRecord({
        pairing: { ...proofRecord().pairing, write_attempt: MAX_WRITES_PER_PAIRING + 4 },
      })),
      'a write attempt past the cap is producer-impossible',
    );

    // CONTROL — the highest attempt the producer CAN emit is still accepted.
    const atCap = build(trace(), proofRecord({
      pairing: { ...proofRecord().pairing, write_attempt: MAX_WRITES_PER_PAIRING },
    }));
    assert.equal(atCap.summary.rejected_records, 0);
    assert.equal(atCap.turns[0].writes.length, 1);
  });

  it('rejects a pairing whose boolean fields are not booleans', () => {
    assertRejected(
      build(trace(), proofRecord({ pairing: { ...proofRecord().pairing, payload_bound: 'true' } })),
      'payload_bound is a boolean in every emitted pairing',
    );
    assertRejected(
      build(trace(), proofRecord({ pairing: { ...proofRecord().pairing, effort_transition: 2 } })),
      'effort_transition is a boolean in every emitted pairing',
    );
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a proof whose boolean field carries a non-boolean', () => {
    assertRejected(build(trace(), proofRecord({}, { test_mode: 'false' })), 'a string is not the W2 flag');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a sheet_write state outside the emitted vocabulary', () => {
    assertRejected(build(trace(), proofRecord({}, { sheet_write: 'committed' })), 'committed is not an emitted state');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects an idempotency_status outside the emitted vocabulary', () => {
    assertRejected(build(trace(), proofRecord({}, { idempotency_status: 'done' })), 'done is not an emitted status');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a closeout status outside the emitted vocabulary', () => {
    assertRejected(
      build(trace(), proofRecord({}, { ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, session_plans_closeout_status: 'ok' })),
      'ok is not a closeout status any producer emits',
    );

    // CONTROL — the same record with the real status is accepted and reviewed.
    const control = build(trace(), proofRecord({}, {
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, closeout_fully_verified: true,
    }));
    assert.equal(control.summary.rejected_records, 0);
    assert.equal(control.turns[0].writes.length, 1);
  });

  it('rejects a plan_version that is not the producer identity shape', () => {
    assertRejected(
      build(trace(), proofRecord({}, {
        ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, session_plans_closeout_plan_version: 'Log_Cleaned!A2:L4',
      })),
      'a Sheet range is not a plan version',
    );

    const control = build(trace(), proofRecord({}, {
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, closeout_fully_verified: true,
    }));
    assert.equal(control.summary.rejected_records, 0);
  });
});

describe('turnWriteArtifact guards — withheld evidence', () => {
  it('rejects a withheld_evidence that is not an array', () => {
    // Without this the consumer iterates a non-iterable and throws, taking the whole run down.
    assertRejected(build(trace(), proofRecord({ withheld_evidence: 'ledger_seal_sealed' })), 'must be an array');
    assert.doesNotThrow(() => build(trace(), proofRecord({ withheld_evidence: 5 })));
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a withheld key outside the projection, and a repeated one', () => {
    assertRejected(build(trace(), proofRecord({ withheld_evidence: ['not_a_key'] })), 'not a projected key');
    assertRejected(
      build(trace(), proofRecord({ withheld_evidence: ['ledger_seal_sealed', 'ledger_seal_sealed'] })),
      'a key cannot be withheld twice',
    );

    // CONTROL — a single genuinely projected key is accepted and reported as withheld.
    const control = build(trace(), proofRecord({ withheld_evidence: ['ledger_seal_sealed'] }));
    assert.equal(control.summary.rejected_records, 0);
    assert.ok(firstWrite(control).issues.includes('evidence_withheld'));
  });

  it('rejects a key claimed both withheld and present', () => {
    assertRejected(
      build(trace(), proofRecord({ withheld_evidence: ['ledger_seal_sealed'] }, {
        ...SEAL_REPLAY, ledger_seal_sealed: 0,
      })),
      'evidence cannot be both withheld and supplied',
    );
  });
});

describe('turnWriteArtifact guards — seal presentation', () => {
  it('reports an explicit seal_proof_mismatch reason as a mismatch, not merely unverified', () => {
    // The reason must be decisive ON ITS OWN. Pairing it with a positive stamp claim would prove
    // nothing: the "any reason contradicts a stamp" arm below already catches that shape, so the
    // test would pass with this check deleted. The mismatch here claims no seal write at all, so
    // only the explicit reason distinguishes it from an ordinary unverified seal.
    const artifact = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: true,
      ledger_seal_sheet_written: false,
      ledger_seal_sealed: 0,
      ledger_seal_already_sealed: 0,
      ledger_seal_reason: 'seal_proof_mismatch',
      closeout_fully_verified: true,
    }));
    const write = firstWrite(artifact);
    assert.equal(write.seal.state, 'seal_proof_mismatch');
    assert.equal(write.seal.successfully_sealed, false);
    assert.ok(write.issues.includes('seal_proof_mismatch'));

    // CONTROL — the same tuple without the mismatch reason is a genuine fresh stamp.
    const control = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: true,
      ledger_seal_sheet_written: true,
      ledger_seal_no_write_confirmed: false,
      ledger_seal_sealed: 2,
      ledger_seal_already_sealed: 0,
      closeout_fully_verified: true,
    }));
    assert.equal(firstWrite(control).seal.state, 'sealed');
  });

  it('reports sealed_ok:false beside a positive seal write as a mismatch, not a plain failure', () => {
    const artifact = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: false,
      ledger_seal_sheet_written: true,
      closeout_fully_verified: true,
    }));
    assert.equal(firstWrite(artifact).seal.state, 'seal_proof_mismatch');

    // CONTROL — a failure that claims no seal write is the milder `failed`.
    const control = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: false,
      ledger_seal_sheet_written: false,
      closeout_fully_verified: true,
    }));
    assert.equal(firstWrite(control).seal.state, 'failed');
  });

  it('requires the no_ledger flag and its own reason before calling a seal verified_no_new_seal', () => {
    const withoutFlag = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: true,
      ledger_seal_sheet_written: false,
      ledger_seal_no_write_confirmed: true,
      ledger_seal_sealed: 0,
      ledger_seal_already_sealed: 0,
      ledger_seal_reason: 'no_rows',
      closeout_fully_verified: true,
    }));
    assert.notEqual(firstWrite(withoutFlag).seal.state, 'verified_no_new_seal');

    const wrongReason = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: true,
      ledger_seal_sheet_written: false,
      ledger_seal_no_write_confirmed: true,
      ledger_seal_sealed: 0,
      ledger_seal_already_sealed: 0,
      ledger_seal_no_ledger: true,
      ledger_seal_reason: 'write_disabled',
      closeout_fully_verified: true,
    }));
    assert.notEqual(firstWrite(wrongReason).seal.state, 'verified_no_new_seal');

    // CONTROL — both outcomes that genuinely reach it.
    for (const reason of ['tab_missing', 'no_rows']) {
      const control = build(trace(), proofRecord({}, {
        ledger_seal_sealed_ok: true,
        ledger_seal_sheet_written: false,
        ledger_seal_no_write_confirmed: true,
        ledger_seal_sealed: 0,
        ledger_seal_already_sealed: 0,
        ledger_seal_no_ledger: true,
        ledger_seal_reason: reason,
        closeout_fully_verified: true,
      }));
      assert.equal(firstWrite(control).seal.state, 'verified_no_new_seal', reason);
    }
  });
});

describe('turnWriteArtifact guards — write classification', () => {
  it('will not confirm a claimed live success whose test_mode flag is absent', () => {
    // All four success producers emit test_mode explicitly, so an absent flag is a lost tuple
    // member — not permission to assume the write was live.
    const artifact = build(trace(), proofRecord({}, { test_mode: undefined }));
    assert.equal(firstWrite(artifact).proof_state, 'insufficient');
    assert.notEqual(artifact.status, 'complete');

    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('requires the complete W1 tuple before reporting no_write_confirmed', () => {
    const artifact = build(trace(), proofRecord({}, {
      test_mode: true,
      no_write_confirmed: true,
      sheet_write: 'skipped',
      sheet_written: undefined,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
    }));
    assert.notEqual(firstWrite(artifact).proof_state, 'no_write_confirmed');

    // CONTROL — the real dry-run tuple, which carries the explicit false write flag.
    const control = build(trace(), proofRecord({}, {
      test_mode: true,
      no_write_confirmed: true,
      sheet_written: false,
      sheet_write: 'skipped',
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
    }));
    assert.equal(firstWrite(control).proof_state, 'no_write_confirmed');
  });

  it('requires the duplicate branch scalars before reporting idempotent_no_write', () => {
    const noSkippedCount = build(trace(), duplicateRecord({
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, skipped_duplicates: undefined,
    }));
    assert.equal(firstWrite(noSkippedCount).proof_state, 'insufficient');

    const zeroSkipped = build(trace(), duplicateRecord({
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, skipped_duplicates: 0,
    }));
    assert.equal(firstWrite(zeroSkipped).proof_state, 'insufficient');

    // CONTROL — the real correlated duplicate.
    const control = build(trace(), duplicateRecord({ ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED }));
    assert.equal(firstWrite(control).proof_state, 'idempotent_no_write');
  });

  it('requires sidecar evidence before reporting idempotent_no_write, and accepts EITHER envelope', () => {
    // This is the case the previously-published test claimed to cover and did not: its negative
    // record was missing the idempotency status and the verdict as well, so it failed on those and
    // never reached the sidecar gate at all. With the whole scalar tuple present and only the
    // sidecar evidence absent, the gate is the only thing standing between this record and a
    // fully reviewable verdict.
    const noSidecar = build(trace(), duplicateRecord());
    assert.equal(firstWrite(noSidecar).proof_state, 'insufficient');
    assert.equal(noSidecar.turns[0].reviewable, false);

    // CONTROL — index.js:3276 gates on `ledger_seal || session_plans_closeout`, so EITHER envelope
    // alone is a genuine correlated duplicate. Requiring both would discard a real record whose
    // projection carried only one.
    const sealOnly = build(trace(), duplicateRecord(SEAL_REPLAY));
    assert.equal(firstWrite(sealOnly).proof_state, 'idempotent_no_write');

    const closeoutOnly = build(trace(), duplicateRecord(CLOSEOUT_SKIPPED));
    assert.equal(firstWrite(closeoutOnly).proof_state, 'idempotent_no_write');
  });

  it('flags a preview record that does not reach the no-write proof', () => {
    const preview = proofRecord({
      pairing: {
        established_at_preview: true,
        write_attempt: 0,
        previewed_write_id_match: null,
        payload_bound: false,
        effort_transition: false,
      },
    }, {
      test_mode: true,
      sheet_write: 'skipped',
      sheet_written: false,
      no_write_confirmed: true,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
    });

    // CONTROL — the real preview body is reviewable with no issues.
    const control = build(trace(), preview, proofRecord());
    assert.deepEqual(control.turns[0].previews[0].issues, []);
    assert.equal(control.turns[0].previews[0].proof_state, 'no_write_confirmed');

    // A preview whose no-write tuple does not hold must say so rather than passing quietly.
    const broken = JSON.parse(JSON.stringify(preview));
    broken.proof.effortWritten = true;
    broken.proof.rows_appended = 2;
    const artifact = build(trace(), broken, proofRecord());
    assert.ok(artifact.turns[0].previews[0].issues.includes('preview_no_write_proof_missing'));
    assert.equal(artifact.turns[0].previews[0].reviewable, false);
  });
});

describe('turnWriteArtifact guards — turn assembly and parsing', () => {
  it('reports conflicting traces for the same turn', () => {
    const artifact = build(trace(), trace({ intent_type: 'plan' }), proofRecord());
    assert.ok(artifact.turns[0].issues.includes('conflicting_traces'));
    assert.equal(artifact.turns[0].reviewable, false);

    // CONTROL — a byte-identical repeat is deduplicated, not called conflicting.
    const repeated = build(trace(), trace(), proofRecord());
    assert.ok(!repeated.turns[0].issues.includes('conflicting_traces'));
    assert.equal(repeated.status, 'complete');
  });

  it('reports a turn with no write proof at all', () => {
    const artifact = build(trace());
    assert.ok(artifact.turns[0].issues.includes('write_proof_missing'));
    assert.equal(artifact.turns[0].join_status, 'trace_only');
    assert.equal(artifact.turns[0].reviewable, false);

    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('surfaces a rejected record against the turn it belonged to', () => {
    // Without this the turn shows only what survived, and evidence loss reads as absence.
    const artifact = build(trace(), proofRecord(), proofRecord({ recorded_at: 'nope' }));
    assert.ok(artifact.turns[0].issues.includes('rejected_write_record'));
    assert.equal(artifact.summary.rejected_records, 1);
    assert.equal(artifact.turns[0].reviewable, false);

    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('reports two records claiming the same write attempt', () => {
    // Byte-identical repeats are deduplicated, so the differentiating shape is two records that
    // claim the same attempt while differing elsewhere — one of them is not what the producer,
    // which issues each attempt once, can have emitted.
    const artifact = build(
      trace(),
      proofRecord(),
      proofRecord({ recorded_at: '2026-07-27T09:00:09.000Z' }),
    );
    assert.ok(artifact.turns[0].issues.includes('duplicate_write_attempt'));
    assert.equal(artifact.turns[0].reviewable, false);

    // CONTROL — distinct attempts on the same turn are an ordinary retry, not a duplicate.
    const retry = build(
      trace(),
      proofRecord(),
      proofRecord({
        recorded_at: '2026-07-27T09:00:09.000Z',
        pairing: { ...proofRecord().pairing, write_attempt: 2 },
      }),
    );
    assert.ok(!retry.turns[0].issues.includes('duplicate_write_attempt'));
    assert.equal(retry.status, 'complete');
  });

  it('stops accepting records at the bounded record limit', () => {
    const { MAX_RECORDS } = require('../services/turnWriteArtifact');
    const records = [];
    for (let i = 0; i <= MAX_RECORDS; i += 1) {
      const turnId = `turn:2026-07-27T09:00:00.000Z_${i}_aaaaaa`;
      records.push(proofRecord({ turn_id: turnId }));
    }
    const artifact = buildTurnWriteArtifact(lines(...records));
    assert.ok(artifact.summary.rejected_records > 0, 'the overflowing record is counted, not dropped silently');
    assert.ok(artifact.summary.proofs_seen <= MAX_RECORDS);

    // CONTROL — one under the limit is accepted whole with nothing rejected.
    const under = buildTurnWriteArtifact(lines(...records.slice(0, MAX_RECORDS)));
    assert.equal(under.summary.rejected_records, 0);
    assert.equal(under.summary.proofs_seen, MAX_RECORDS);
  });

  it('stops reading at the bounded input line limit', () => {
    const { MAX_INPUT_LINES } = require('../services/turnWriteArtifact');
    const filler = new Array(MAX_INPUT_LINES).fill('unrelated deployment log line').join('\n');
    const artifact = buildTurnWriteArtifact(`${filler}\n${lines(trace(), proofRecord())}`);
    assert.ok(artifact.summary.rejected_records > 0, 'truncated input is reported, not silently complete');
    assert.notEqual(artifact.status, 'complete');

    // CONTROL — the same records inside the limit parse cleanly.
    assertControlAccepted(buildTurnWriteArtifact(lines(trace(), proofRecord())));
  });

  it('rejects a single log line carrying both markers', () => {
    const both = `2026-07-27T09:00:05Z [interaction-trace] [turn-write-proof] ${JSON.stringify(trace())}`;
    const artifact = buildTurnWriteArtifact(lines(trace(), proofRecord(), both));
    assert.equal(artifact.summary.rejected_records, 1, 'an ambiguous line is not silently skipped');
    assert.notEqual(artifact.status, 'complete');

    assertControlAccepted(build(trace(), proofRecord()));
  });
});
