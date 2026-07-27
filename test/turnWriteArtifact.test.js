'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  INTERACTION_TRACE_MARKER,
  TURN_WRITE_PROOF_MARKER,
  parseTurnWriteLines,
  buildTurnWriteArtifact,
  formatTurnWriteArtifact,
} = require('../services/turnWriteArtifact');

const TURN_A = 'turn:2026-07-26T08:00:00.000Z_1_aaaaaa';
const TURN_B = 'turn:2026-07-26T08:01:00.000Z_2_bbbbbb';
const SESSION = 'session-2026-07-26-a';

function trace(overrides = {}) {
  return {
    turn_id: TURN_A,
    started_at: '2026-07-26T08:00:00.000Z',
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

function proof(overrides = {}) {
  return {
    schema_version: 1,
    turn_id: TURN_A,
    session_id: SESSION,
    route: '/api/log-workout',
    recorded_at: '2026-07-26T08:02:00.000Z',
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
      write_id: 'write-b',
      // Every live success carries these: the routes refuse an append without a write_id, so
      // beginWrite is always enabled and the success body sets both (index.js:3440-3443).
      duplicate_write: false,
      idempotency_status: 'completed',
      logAppendedRange: 'Log_Cleaned!A2:L4',
      log_rows_written: 3,
      effort_rows_written: 0,
      effortWritten: false,
    },
    withheld_evidence: [],
    ...overrides,
  };
}

function line(marker, record) {
  return `2026-07-26T08:05:00Z ${marker} ${JSON.stringify(record)}`;
}

describe('turnWriteArtifact — parsing and canonical turn join', () => {
  it('joins interaction trace and write proof on the existing canonical turn_id', () => {
    const input = [
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n');
    const artifact = buildTurnWriteArtifact(input);

    assert.equal(artifact.schema_version, 1);
    assert.equal(artifact.status, 'complete');
    assert.equal(artifact.summary.joined_turns, 1);
    assert.equal(artifact.summary.reviewable_turns, 1);
    assert.equal(artifact.turns[0].turn_id, TURN_A);
    assert.equal(artifact.turns[0].trace.valid, true);
    assert.equal(artifact.turns[0].writes.length, 1);
    assert.equal(artifact.turns[0].reviewable, true);
  });

  it('is independent of log completion order', () => {
    const proofFirst = buildTurnWriteArtifact([
      line(TURN_WRITE_PROOF_MARKER, proof()),
      line(INTERACTION_TRACE_MARKER, trace()),
    ].join('\n'));
    const traceFirst = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));

    assert.deepEqual(proofFirst.turns, traceFirst.turns);
    assert.deepEqual(proofFirst.summary, traceFirst.summary);
  });

  it('never joins a proof to a different turn', () => {
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({ turn_id: TURN_B })),
    ].join('\n'));

    assert.equal(artifact.status, 'partial');
    assert.equal(artifact.summary.joined_turns, 0);
    assert.equal(artifact.summary.trace_only_turns, 1);
    assert.equal(artifact.summary.proof_only_turns, 1);
    assert.equal(artifact.summary.reviewable_turns, 0);
  });

  it('fails the whole artifact closed when a rejected marker cannot be assigned to a turn', () => {
    const artifact = buildTurnWriteArtifact([
      `${TURN_WRITE_PROOF_MARKER} not-json`,
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));

    assert.equal(artifact.summary.reviewable_turns, 1);
    assert.equal(artifact.summary.rejected_records, 1);
    assert.equal(artifact.status, 'partial');
  });

  it('fails reviewability closed when one canonical turn contains cross-session proofs', () => {
    const otherSession = proof({
      session_id: 'session-2026-07-26-b',
      recorded_at: '2026-07-26T08:03:00.000Z',
      pairing: { ...proof().pairing, write_attempt: 2 },
      proof: { ...proof().proof, write_id: 'write-other-session' },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
      line(TURN_WRITE_PROOF_MARKER, otherSession),
    ].join('\n'));

    assert.ok(artifact.turns[0].issues.includes('conflicting_sessions'));
    assert.equal(artifact.turns[0].reviewable, false);
    assert.equal(artifact.status, 'partial');
  });

  it('fails reviewability closed when the joined proof has no session identity', () => {
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({ session_id: null })),
    ].join('\n'));

    assert.ok(artifact.turns[0].issues.includes('session_missing'));
    assert.equal(artifact.turns[0].reviewable, false);
    assert.equal(artifact.status, 'partial');
  });

  it('retains the legitimate seal retry as a second bounded write attempt', () => {
    const retry = proof({
      recorded_at: '2026-07-26T08:03:00.000Z',
      pairing: { ...proof().pairing, write_attempt: 2, effort_transition: true },
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        no_write_confirmed: false,
        write_id: 'write-b-retry',
        rows_appended: 0,
        closeout_fully_verified: true,
        ledger_seal_sheet_written: true,
        ledger_seal_no_write_confirmed: false,
        ledger_seal_sealed: 3,
        ledger_seal_already_sealed: 0,
        ledger_seal_sealed_ok: true,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
      line(TURN_WRITE_PROOF_MARKER, retry),
    ].join('\n'));

    assert.equal(artifact.turns[0].writes.length, 2);
    assert.deepEqual(artifact.turns[0].writes.map((w) => w.pairing.write_attempt), [1, 2]);
    assert.equal(artifact.turns[0].writes[1].seal.state, 'sealed');
    assert.equal(artifact.turns[0].writes[1].seal.successfully_sealed, true);
  });

  it('treats the expected write_attempt:0 preview record as preview evidence, not a rejected live write', () => {
    const preview = proof({
      recorded_at: '2026-07-26T08:01:00.000Z',
      pairing: {
        established_at_preview: true,
        write_attempt: 0,
        previewed_write_id_match: null,
        payload_bound: false,
        effort_transition: false,
      },
      proof: {
        test_mode: true,
        sheet_write: 'skipped',
        sheet_written: false,
        no_write_confirmed: true,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, preview),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));

    assert.equal(artifact.status, 'complete');
    assert.equal(artifact.summary.rejected_records, 0);
    assert.equal(artifact.turns[0].previews.length, 1);
    assert.equal(artifact.turns[0].writes.length, 1);
    assert.equal(artifact.turns[0].previews[0].proof_state, 'no_write_confirmed');
    assert.equal(artifact.turns[0].reviewable, true);
  });

  it('keeps an effort-bearing preview on its explicit no-write proof', () => {
    const preview = proof({
      pairing: {
        established_at_preview: true,
        write_attempt: 0,
        previewed_write_id_match: null,
        payload_bound: false,
        effort_transition: false,
      },
      proof: {
        test_mode: true,
        sheet_write: 'skipped',
        sheet_written: false,
        no_write_confirmed: true,
        effortWritten: true,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, preview),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));

    assert.equal(artifact.turns[0].previews[0].proof_state, 'no_write_confirmed');
    assert.equal(artifact.turns[0].previews[0].reviewable, true);
    assert.equal(artifact.status, 'complete');
  });

  it('rejects a trace whose claimed missing list disagrees with its canonical stages', () => {
    const parsed = parseTurnWriteLines(line(
      INTERACTION_TRACE_MARKER,
      trace({ missing: [] }),
    ));
    assert.equal(parsed.traces.length, 0);
    assert.equal(parsed.rejected_count, 1);
  });

  it('does not turn malformed or duplicate marker lines into a false green', () => {
    const parsed = parseTurnWriteLines([
      `${INTERACTION_TRACE_MARKER} not-json`,
      line(INTERACTION_TRACE_MARKER, { turn_id: 'not-a-turn', valid: true }),
      line(TURN_WRITE_PROOF_MARKER, { turn_id: TURN_A, proof: { sheet_written: true } }),
      'ordinary application log line',
    ].join('\n'));

    assert.equal(parsed.traces.length, 0);
    assert.equal(parsed.proofs.length, 0);
    assert.equal(parsed.rejected.length, 3);
    const artifact = buildTurnWriteArtifact(parsed);
    assert.equal(artifact.status, 'empty');
    assert.equal(artifact.summary.reviewable_turns, 0);
  });
});

describe('turnWriteArtifact — honest seal and closeout evidence', () => {
  it('classifies sheet_written:true plus sealed_ok:false as seal_proof_mismatch, never success', () => {
    const mismatched = proof({
      proof: {
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        closeout_fully_verified: false,
        ledger_seal_sheet_written: true,
        ledger_seal_sealed: 3,
        ledger_seal_sealed_ok: false,
        ledger_seal_reason: 'seal_proof_mismatch',
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, mismatched),
    ].join('\n'));
    const seal = artifact.turns[0].writes[0].seal;

    assert.equal(seal.state, 'seal_proof_mismatch');
    assert.equal(seal.successfully_sealed, false);
    assert.equal(artifact.turns[0].reviewable, false);
    assert.ok(artifact.turns[0].issues.includes('seal_proof_mismatch'));
  });

  it('rejects contradictory positive-write and explicit no-write proof', () => {
    const contradictions = [
      {
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        no_write_confirmed: true,
        rows_appended: 1,
      },
      {
        sheet_write: 'skipped',
        sheet_written: false,
        no_write_confirmed: true,
        rows_appended: 3,
      },
    ];

    for (const contradictoryProof of contradictions) {
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({ proof: contradictoryProof })),
      ].join('\n'));
      const write = artifact.turns[0].writes[0];

      assert.equal(write.proof_state, 'contradictory');
      assert.equal(write.reviewable, false);
      assert.ok(write.issues.includes('write_proof_contradictory'));
      assert.equal(artifact.status, 'partial');
    }
  });

  it('requires test_mode:true before accepting explicit no-write proof', () => {
    for (const testMode of [false, undefined]) {
      const claimedNoWrite = {
        sheet_write: 'skipped',
        sheet_written: false,
        no_write_confirmed: true,
      };
      if (testMode !== undefined) claimedNoWrite.test_mode = testMode;
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({ proof: claimedNoWrite })),
      ].join('\n'));
      const write = artifact.turns[0].writes[0];

      assert.notEqual(write.proof_state, 'no_write_confirmed');
      assert.equal(write.reviewable, false);
      assert.equal(artifact.status, 'partial');
    }
  });

  it('requires positive row evidence instead of trusting a bare live success token', () => {
    const bareSuccess = proof({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: false,
        log_rows_written: 0,
        effort_rows_written: 0,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, bareSuccess),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.proof_state, 'insufficient');
    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('write_proof_insufficient'));
    assert.equal(artifact.status, 'partial');
  });

  it('requires append-range evidence for a successful live log-workout row count', () => {
    const countWithoutRange = proof({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        log_rows_written: 1,
        effort_rows_written: 0,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, countWithoutRange),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.proof_state, 'insufficient');
    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('write_proof_insufficient'));
    assert.equal(artifact.status, 'partial');
  });

  it('does not treat effort formatting bookkeeping as live append proof', () => {
    const bookkeepingOnly = proof({
      proof: {
        test_mode: false,
        effortWritten: true,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, bookkeepingOnly),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.proof_state, 'insufficient');
    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('write_proof_insufficient'));
    assert.equal(artifact.status, 'partial');
  });

  it('does not let a non-success live log state bypass the W3 proof tuple', () => {
    const incoherentSkip = proof({
      proof: {
        test_mode: false,
        sheet_write: 'skipped',
        sheet_written: true,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, incoherentSkip),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.proof_state, 'contradictory');
    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('write_proof_contradictory'));
    assert.equal(artifact.status, 'partial');
  });

  it('requires a coherent success state on every generic live-write route', () => {
    for (const route of ['/api/complete-workout', '/api/log-modality', '/api/bodyweight']) {
      const blockedButPositive = proof({
        route,
        proof: {
          test_mode: false,
          sheet_write: 'blocked_schema_drift',
          sheet_written: true,
          rows_appended: 1,
        },
      });
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, blockedButPositive),
      ].join('\n'));
      const write = artifact.turns[0].writes[0];

      assert.equal(write.proof_state, 'contradictory', route);
      assert.equal(write.reviewable, false, route);
      assert.ok(write.issues.includes('write_proof_contradictory'), route);
      assert.equal(artifact.status, 'partial', route);
    }
  });

  it('binds live Log and Effort counts to the correct tab, columns, and row span', () => {
    const invalidRanges = [
      {
        logAppendedRange: 'Log_Cleaned!A2:L2',
        log_rows_written: 3,
        effort_rows_written: 0,
      },
      {
        logAppendedRange: 'Effort!A2:L4',
        log_rows_written: 3,
        effort_rows_written: 0,
      },
      {
        log_rows_written: 0,
        effortAppendedRange: 'Log_Cleaned!A2:K2',
        effort_rows_written: 1,
      },
      {
        log_rows_written: 0,
        effortAppendedRange: 'Effort!A2:K3',
        effort_rows_written: 1,
      },
    ];

    for (const invalidRange of invalidRanges) {
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({
          proof: {
            test_mode: false,
            sheet_write: 'success',
            duplicate_write: false,
            idempotency_status: 'completed',
            ...invalidRange,
          },
        })),
      ].join('\n'));
      const write = artifact.turns[0].writes[0];

      assert.equal(write.proof_state, 'insufficient', JSON.stringify(invalidRange));
      assert.equal(write.reviewable, false, JSON.stringify(invalidRange));
      assert.equal(artifact.status, 'partial', JSON.stringify(invalidRange));
    }
  });

  it('accepts the canonical nine-column Effort append range and rejects a wider one', () => {
    // config/columns.js effortColumns has nine values, so a real one-row Effort append
    // reports Effort!A<n>:I<n>. A noncanonical wider span is not that write.
    const canonical = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          log_rows_written: 0,
          effortAppendedRange: 'Effort!A100:I100',
          effort_rows_written: 1,
        },
      })),
    ].join('\n'));
    const canonicalWrite = canonical.turns[0].writes[0];

    assert.equal(canonicalWrite.proof_state, 'write_confirmed');
    assert.equal(canonicalWrite.reviewable, true);
    assert.equal(canonical.status, 'complete');

    const wider = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          log_rows_written: 0,
          effortAppendedRange: 'Effort!A100:K100',
          effort_rows_written: 1,
        },
      })),
    ].join('\n'));
    const widerWrite = wider.turns[0].writes[0];

    assert.equal(widerWrite.proof_state, 'insufficient');
    assert.equal(widerWrite.reviewable, false);
    assert.equal(wider.status, 'partial');
  });

  it('requires every positive tab count to carry its own matching range proof', () => {
    // One tab being range-backed must never substantiate the other tab's positive count.
    const mixed = [
      {
        logAppendedRange: 'Log_Cleaned!A2:L3',
        log_rows_written: 2,
        effortAppendedRange: 'Log_Cleaned!A100:I100',
        effort_rows_written: 1,
      },
      {
        logAppendedRange: 'Log_Cleaned!A2:L3',
        log_rows_written: 2,
        effort_rows_written: 1,
      },
      {
        log_rows_written: 2,
        effortAppendedRange: 'Effort!A100:I100',
        effort_rows_written: 1,
      },
    ];

    for (const partialRangeProof of mixed) {
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({
          proof: {
            test_mode: false,
            sheet_write: 'success',
            duplicate_write: false,
            idempotency_status: 'completed',
            ...partialRangeProof,
          },
        })),
      ].join('\n'));
      const write = artifact.turns[0].writes[0];

      assert.equal(write.proof_state, 'insufficient', JSON.stringify(partialRangeProof));
      assert.equal(write.reviewable, false, JSON.stringify(partialRangeProof));
      assert.equal(artifact.status, 'partial', JSON.stringify(partialRangeProof));
    }

    const bothBacked = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          logAppendedRange: 'Log_Cleaned!A2:L3',
          log_rows_written: 2,
          effortAppendedRange: 'Effort!A100:I100',
          effort_rows_written: 1,
        },
      })),
    ].join('\n'));

    assert.equal(bothBacked.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(bothBacked.status, 'complete');
  });

  it('distinguishes a newly stamped seal from an idempotent already-sealed replay', () => {
    const stamped = proof({
      proof: {
        ledger_seal_sheet_written: true,
        ledger_seal_no_write_confirmed: false,
        ledger_seal_sealed: 4,
        ledger_seal_already_sealed: 0,
        ledger_seal_sealed_ok: true,
      },
    });
    const replay = proof({
      recorded_at: '2026-07-26T08:03:00.000Z',
      pairing: { ...proof().pairing, write_attempt: 2 },
      proof: {
        ledger_seal_sheet_written: false,
        ledger_seal_no_write_confirmed: true,
        ledger_seal_sealed: 0,
        ledger_seal_already_sealed: 4,
        ledger_seal_sealed_ok: true,
        ledger_seal_reason: 'all_sealed',
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, stamped),
      line(TURN_WRITE_PROOF_MARKER, replay),
    ].join('\n'));

    assert.equal(artifact.turns[0].writes[0].seal.state, 'sealed');
    assert.equal(artifact.turns[0].writes[0].seal.new_seal_write, true);
    assert.equal(artifact.turns[0].writes[1].seal.state, 'already_sealed');
    assert.equal(artifact.turns[0].writes[1].seal.new_seal_write, false);
  });

  it('never lets a sidecar seal or closeout substantiate an unbacked main append', () => {
    // A seal/closeout is an independent sidecar write. It can make a duplicate-branch turn
    // reviewable on its own, but a CLAIMED live main append that fails its own per-tab W3 tuple
    // must stay unproved.
    const unbackedMainWrites = [
      {
        // Positive Log count, no Log range — rescued by a genuine fresh seal stamp.
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          log_rows_written: 1,
          effort_rows_written: 0,
          ledger_seal_sheet_written: true,
          ledger_seal_sealed: 3,
          ledger_seal_already_sealed: 0,
          ledger_seal_sealed_ok: true,
        },
      },
      {
        // Positive Effort count, no Effort range — rescued by a written closeout row.
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          log_rows_written: 0,
          effort_rows_written: 1,
          session_plans_closeout_status: 'written',
          session_plans_closeout_captured: true,
          session_plans_closeout_written: 1,
          session_plans_closeout_skipped: 0,
          session_plans_closeout_plan_version: 'pv_7c9e6679-7425-40de-944b-e07fc1f90ae7',
        },
      },
    ];

    for (const unbacked of unbackedMainWrites) {
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof(unbacked)),
      ].join('\n'));
      const write = artifact.turns[0].writes[0];

      assert.equal(write.proof_state, 'insufficient', JSON.stringify(unbacked.proof));
      assert.equal(write.reviewable, false, JSON.stringify(unbacked.proof));
      assert.equal(artifact.status, 'partial', JSON.stringify(unbacked.proof));
    }

    // Control: the real all-rows-duplicate branch has no main-write claim at all, so its sidecar
    // seal remains the legitimate evidence that makes the turn reviewable.
    const sidecarOnly = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'skipped_duplicate',
          log_rows_written: 0,
          effort_rows_written: 0,
          skipped_duplicates: 3,
          closeout_fully_verified: true,
          ledger_seal_sheet_written: true,
          ledger_seal_no_write_confirmed: false,
          ledger_seal_sealed: 3,
          ledger_seal_already_sealed: 0,
          ledger_seal_sealed_ok: true,
        },
      })),
    ].join('\n'));

    assert.equal(sidecarOnly.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(sidecarOnly.status, 'complete');
  });

  it('rejects a seal reason that contradicts the rest of the seal tuple', () => {
    // Every reason the real emitter produces describes a NON-stamping outcome; a genuine fresh
    // stamp carries no reason at all (services/sessionPlanSetsStore.js).
    for (const reason of ['all_sealed', 'no_rows', 'tab_missing', 'ledger_read_failed', 'conflicting_seal']) {
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({
          proof: {
            ledger_seal_sheet_written: true,
            ledger_seal_sealed: 3,
            ledger_seal_already_sealed: 0,
            ledger_seal_sealed_ok: true,
            ledger_seal_reason: reason,
          },
        })),
      ].join('\n'));
      const write = artifact.turns[0].writes[0];

      assert.equal(write.seal.state, 'seal_proof_mismatch', reason);
      assert.equal(write.seal.successfully_sealed, false, reason);
      assert.equal(write.reviewable, false, reason);
      assert.equal(artifact.status, 'partial', reason);
    }

    // A reason outside the emitter's fixed vocabulary cannot reach the artifact at all.
    const foreignReason = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          ledger_seal_sheet_written: true,
          ledger_seal_sealed: 3,
          ledger_seal_already_sealed: 0,
          ledger_seal_sealed_ok: true,
          ledger_seal_reason: 'not_an_emitter_reason',
        },
      })),
    ].join('\n'));

    assert.equal(foreignReason.turns[0].writes.length, 0, 'the record is rejected, not reflected');
    assert.equal(foreignReason.status, 'partial');
    assert.ok(!JSON.stringify(foreignReason).includes('not_an_emitter_reason'));
  });

  it('requires the complete producer tuple for every positive seal state', () => {
    // Same absent-means-unknown rule as verified_no_new_seal, applied to its siblings. The real
    // all_sealed replay carries no_write_confirmed:true; the real fresh stamp carries
    // no_write_confirmed:false. A partial tuple substantiates neither.
    const partialReplay = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
          effort_rows_written: 0,
          closeout_fully_verified: true,
          ledger_seal_sheet_written: false,
          ledger_seal_sealed: 0,
          ledger_seal_already_sealed: 4,
          ledger_seal_sealed_ok: true,
        },
      })),
    ].join('\n'));

    assert.notEqual(partialReplay.turns[0].writes[0].seal.state, 'already_sealed');
    assert.equal(partialReplay.turns[0].writes[0].seal.successfully_sealed, false);
    assert.equal(partialReplay.status, 'partial');

    const partialStamp = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
          effort_rows_written: 0,
          closeout_fully_verified: true,
          ledger_seal_sheet_written: true,
          ledger_seal_sealed: 4,
          ledger_seal_already_sealed: 0,
          ledger_seal_sealed_ok: true,
        },
      })),
    ].join('\n'));

    assert.notEqual(partialStamp.turns[0].writes[0].seal.state, 'sealed');
    assert.equal(partialStamp.status, 'partial');

    // Both complete producer shapes stay exactly as classified.
    const completeReplay = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
          effort_rows_written: 0,
          closeout_fully_verified: true,
          ledger_seal_sheet_written: false,
          ledger_seal_no_write_confirmed: true,
          ledger_seal_sealed: 0,
          ledger_seal_already_sealed: 4,
          ledger_seal_sealed_ok: true,
          ledger_seal_reason: 'all_sealed',
        },
      })),
    ].join('\n'));
    assert.equal(completeReplay.turns[0].writes[0].seal.state, 'already_sealed');
    assert.equal(completeReplay.status, 'complete');

    const completeStamp = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
          effort_rows_written: 0,
          closeout_fully_verified: true,
          ledger_seal_sheet_written: true,
          ledger_seal_no_write_confirmed: false,
          ledger_seal_sealed: 4,
          ledger_seal_already_sealed: 0,
          ledger_seal_sealed_ok: true,
        },
      })),
    ].join('\n'));
    assert.equal(completeStamp.turns[0].writes[0].seal.state, 'sealed');
    assert.equal(completeStamp.status, 'complete');
  });

  it('requires the route verdict whenever seal or closeout evidence is present', () => {
    // Both emitting branches attach closeout_fully_verified whenever they attach ledger_seal, so
    // its absence beside seal/closeout evidence is unknown, not an implicit positive verdict.
    const noVerdict = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
          effort_rows_written: 0,
          ledger_seal_sheet_written: true,
          ledger_seal_no_write_confirmed: false,
          ledger_seal_sealed: 4,
          ledger_seal_already_sealed: 0,
          ledger_seal_sealed_ok: true,
        },
      })),
    ].join('\n'));
    const write = noVerdict.turns[0].writes[0];

    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('closeout_verdict_missing'));
    assert.equal(noVerdict.status, 'partial');

    // A plain main write with NO seal/closeout evidence does not need the verdict at all.
    const plain = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));
    assert.equal(plain.status, 'complete');
  });

  it('rejects a written closeout whose counts contradict the producer invariant', () => {
    // writeSessionCloseout appends exactly one event and _envelope always emits both counts, so a
    // written result must carry skipped:0. The skipped branch already enforces the converse.
    for (const counts of [
      { session_plans_closeout_written: 1, session_plans_closeout_skipped: 1 },
      { session_plans_closeout_written: 1 },
    ]) {
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({
          proof: {
            test_mode: false,
            sheet_write: 'success',
            duplicate_write: false,
            idempotency_status: 'completed',
            logAppendedRange: 'Log_Cleaned!A2:L4',
            log_rows_written: 3,
            effort_rows_written: 0,
            closeout_fully_verified: true,
            session_plans_closeout_status: 'written',
            session_plans_closeout_captured: true,
            session_plans_closeout_plan_version: 'pv_7c9e6679-7425-40de-944b-e07fc1f90ae7',
            ...counts,
          },
        })),
      ].join('\n'));
      const write = artifact.turns[0].writes[0];

      assert.notEqual(write.closeout.state, 'written', JSON.stringify(counts));
      assert.ok(write.issues.includes('closeout_not_reviewable'), JSON.stringify(counts));
      assert.equal(artifact.status, 'partial', JSON.stringify(counts));
    }
  });

  it('never reflects an arbitrary CLI source label', () => {
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));
    const unsafeSource = 'Bench Press 225 x 5 @ RIR 2.log';

    assert.ok(
      !formatTurnWriteArtifact(artifact, { source: unsafeSource }).includes('Bench Press'),
      'workout prose in a filename must not be echoed',
    );
    assert.ok(
      !formatTurnWriteArtifact(artifact, { source: 'Log_Cleaned!A2:L4.log' }).includes('Log_Cleaned!A2:L4'),
      'a Sheet range in a filename must not be echoed',
    );
    // An opaque source label is still shown, and directory components are not published.
    assert.ok(formatTurnWriteArtifact(artifact, { source: 'stdin' }).includes('stdin'));
    const fromPath = formatTurnWriteArtifact(artifact, { source: '/srv/private-deploy/atlas.log' });
    assert.ok(fromPath.includes('atlas.log'));
    assert.ok(!fromPath.includes('private-deploy'), 'directory components are not published');
  });

  it('treats an incomplete successful-seal tuple as indeterminate', () => {
    // Every real no-new-seal shape carries the complete tuple: sheet_written:false,
    // no_write_confirmed:true, sealed:0. A lone sealed_ok:true substantiates nothing.
    const bareSealedOk = proof({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        logAppendedRange: 'Log_Cleaned!A2:L4',
        log_rows_written: 3,
        effort_rows_written: 0,
        ledger_seal_sealed_ok: true,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, bareSealedOk),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.seal.state, 'indeterminate');
    assert.equal(write.seal.successfully_sealed, false);
    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('seal_not_verified'));
    assert.equal(artifact.status, 'partial');

    // The producer's REAL verified-empty-seal shape (tab_missing / no_rows) is complete and
    // must stay a non-issue.
    const verifiedEmpty = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
          effort_rows_written: 0,
          closeout_fully_verified: true,
          ledger_seal_sheet_written: false,
          ledger_seal_no_write_confirmed: true,
          ledger_seal_sealed: 0,
          ledger_seal_already_sealed: 0,
          ledger_seal_sealed_ok: true,
          ledger_seal_no_ledger: true,
          ledger_seal_reason: 'no_rows',
        },
      })),
    ].join('\n'));

    assert.equal(verifiedEmpty.turns[0].writes[0].seal.state, 'verified_no_new_seal');
    assert.equal(verifiedEmpty.status, 'complete');
  });

  it('rejects null for proof fields whose producers never emit null', () => {
    // The blanket null acceptance bypassed every field-specific shape check. Real routes normalize
    // test_mode to a boolean, so a present null is a malformed producer shape, not an absent field.
    const nulledTestMode = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: null,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
          effort_rows_written: 0,
        },
      })),
    ].join('\n'));

    assert.equal(nulledTestMode.turns[0].writes.length, 0, 'the malformed record is rejected');
    assert.equal(nulledTestMode.status, 'partial');

    // The two fields their producers DO emit as null must still be accepted, or a real record
    // would be discarded: sessionPlanSetsStore emits updated_cells:null on an unreadable count,
    // and the closeout projection's own validator explicitly permits a null plan_version.
    const legitimateNulls = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        proof: {
          test_mode: false,
          sheet_write: 'success',
          duplicate_write: false,
          idempotency_status: 'completed',
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
          effort_rows_written: 0,
          ledger_seal_sheet_written: true,
          ledger_seal_sealed: 0,
          ledger_seal_sealed_ok: false,
          ledger_seal_reason: 'seal_proof_mismatch',
          ledger_seal_expected_cells: 2,
          ledger_seal_updated_cells: null,
          session_plans_closeout_status: 'written',
          session_plans_closeout_captured: true,
          session_plans_closeout_written: 1,
          session_plans_closeout_skipped: 0,
          session_plans_closeout_plan_version: null,
        },
      })),
    ].join('\n'));

    assert.equal(legitimateNulls.turns[0].writes.length, 1, 'a real record is retained, not rejected');
    const retained = legitimateNulls.turns[0].writes[0];
    assert.equal(retained.seal.state, 'seal_proof_mismatch');
    assert.equal(retained.closeout.state, 'written_unidentified');
  });

  it('honors the route\'s negative closeout_fully_verified verdict', () => {
    // closeoutVerification in index.js returns false for a planned closeout with no ledger rows
    // even when the seal reports sealed_ok:true and the Session_Plans event was written. That
    // verdict is the route's own authoritative judgment and cannot be ignored.
    const routeSaysUnverified = proof({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        logAppendedRange: 'Log_Cleaned!A2:L4',
        log_rows_written: 3,
        effort_rows_written: 0,
        ledger_seal_sealed_ok: true,
        ledger_seal_no_ledger: true,
        session_plans_closeout_status: 'written',
        session_plans_closeout_captured: true,
        session_plans_closeout_written: 1,
        session_plans_closeout_skipped: 0,
        session_plans_closeout_plan_version: 'pv_7c9e6679-7425-40de-944b-e07fc1f90ae7',
        closeout_fully_verified: false,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, routeSaysUnverified),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('closeout_not_verified'));
    assert.equal(artifact.status, 'partial');

    // The same shape with the route's POSITIVE verdict stays reviewable.
    const routeSaysVerified = proof({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        logAppendedRange: 'Log_Cleaned!A2:L4',
        log_rows_written: 3,
        effort_rows_written: 0,
        ledger_seal_sheet_written: true,
        ledger_seal_no_write_confirmed: false,
        ledger_seal_sealed: 2,
        ledger_seal_already_sealed: 0,
        ledger_seal_sealed_ok: true,
        session_plans_closeout_status: 'written',
        session_plans_closeout_captured: true,
        session_plans_closeout_written: 1,
        session_plans_closeout_skipped: 0,
        session_plans_closeout_plan_version: 'pv_7c9e6679-7425-40de-944b-e07fc1f90ae7',
        closeout_fully_verified: true,
      },
    });
    const verified = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, routeSaysVerified),
    ].join('\n'));

    assert.equal(verified.turns[0].writes[0].reviewable, true);
    assert.equal(verified.status, 'complete');
  });

  it('never publishes a session id that is not an opaque identifier', () => {
    // Neither the server nor the client constrains session_id beyond "nonempty, bounded, trimmed",
    // so it can carry workout prose or a Sheet range. The join must survive without republishing it.
    for (const unsafeSession of ['Bench Press 225 lb x 5 @ RIR 2', 'Log_Cleaned!A2:L4']) {
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({ session_id: unsafeSession })),
      ].join('\n'));

      const serialized = JSON.stringify(artifact);
      assert.ok(!serialized.includes(unsafeSession), `raw session id leaked: ${unsafeSession}`);
      assert.ok(!formatTurnWriteArtifact(artifact).includes(unsafeSession), 'leaked in human output');
      // The record is RETAINED — losing the join would be its own failure — but the unusable
      // identity makes it non-reviewable.
      assert.equal(artifact.turns[0].writes.length, 1, unsafeSession);
      assert.equal(artifact.turns[0].reviewable, false, unsafeSession);
      assert.equal(artifact.status, 'partial', unsafeSession);
    }

    // A normal opaque session id is still published verbatim and stays reviewable.
    const safe = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));

    assert.equal(safe.turns[0].writes[0].session_id, SESSION);
    assert.equal(safe.status, 'complete');
  });

  it('never borrows the main write boolean as seal-local write evidence', () => {
    // `ledger_seal_sheet_written` is the ONLY evidence that the independent sidecar write happened.
    // A successful main append says nothing about the seal.
    const borrowed = proof({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        logAppendedRange: 'Log_Cleaned!A2:L4',
        log_rows_written: 3,
        effort_rows_written: 0,
        sheet_written: true,
        ledger_seal_sealed: 3,
        ledger_seal_already_sealed: 0,
        ledger_seal_sealed_ok: true,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, borrowed),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.notEqual(write.seal.state, 'sealed');
    assert.equal(write.seal.successfully_sealed, false);
    assert.equal(write.seal.new_seal_write, false);
    assert.equal(write.seal.sheet_written, null, 'the main write boolean is not imported');
    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('seal_not_verified'));
    assert.equal(artifact.status, 'partial');
  });

  it('retains and classifies the route\'s real seal_error outcome', () => {
    // index.js emits `ledger_seal.reason:'seal_error'` with `sealed_ok:false` and no
    // `sheet_written` when sealCloseout throws. The artifact must be able to REVIEW that failure,
    // not reject the whole record and lose the join.
    const sealError = proof({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        logAppendedRange: 'Log_Cleaned!A2:L4',
        log_rows_written: 3,
        effort_rows_written: 0,
        ledger_seal_sealed_ok: false,
        ledger_seal_reason: 'seal_error',
        closeout_fully_verified: false,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, sealError),
    ].join('\n'));

    assert.equal(artifact.turns[0].writes.length, 1, 'the real record is retained, not rejected');
    const write = artifact.turns[0].writes[0];
    assert.equal(write.seal.state, 'failed');
    assert.equal(write.seal.reason, 'seal_error');
    assert.equal(write.seal.successfully_sealed, false);
    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('seal_not_verified'));
    assert.equal(artifact.status, 'partial');
  });

  it('rejects a positive new-seal count when the seal says no Sheet row was written', () => {
    const impossible = proof({
      proof: {
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        rows_appended: 1,
        ledger_seal_sheet_written: false,
        ledger_seal_sealed: 2,
        ledger_seal_already_sealed: 0,
        ledger_seal_sealed_ok: true,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, impossible),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.seal.state, 'seal_proof_mismatch');
    assert.equal(write.seal.successfully_sealed, false);
    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('seal_proof_mismatch'));
    assert.equal(artifact.status, 'partial');
  });

  it('rejects mismatch-only seal count fields on an otherwise successful seal', () => {
    const contradictoryCounts = proof({
      proof: {
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        rows_appended: 1,
        ledger_seal_sheet_written: true,
        ledger_seal_sealed: 3,
        ledger_seal_already_sealed: 0,
        ledger_seal_sealed_ok: true,
        ledger_seal_expected_cells: 2,
        ledger_seal_updated_cells: 2,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, contradictoryCounts),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.seal.state, 'seal_proof_mismatch');
    assert.equal(write.seal.successfully_sealed, false);
    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('seal_proof_mismatch'));
    assert.equal(artifact.status, 'partial');
  });

  it('rejects contradictory mismatch/no-write/dry-run metadata on a claimed successful seal', () => {
    for (const contradictory of [
      { ledger_seal_reason: 'seal_proof_mismatch' },
      { ledger_seal_no_write_confirmed: true },
      { ledger_seal_dry_run: true },
    ]) {
      const claimedSuccess = proof({
        proof: {
          test_mode: false,
          sheet_write: 'skipped_duplicate',
          duplicate_write: true,
          ledger_seal_sheet_written: true,
          ledger_seal_sealed: 3,
          ledger_seal_already_sealed: 0,
          ledger_seal_sealed_ok: true,
          ...contradictory,
        },
      });
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, claimedSuccess),
      ].join('\n'));
      const write = artifact.turns[0].writes[0];

      assert.equal(write.seal.state, 'seal_proof_mismatch');
      assert.equal(write.seal.successfully_sealed, false);
      assert.equal(write.reviewable, false);
      assert.equal(artifact.status, 'partial');
    }
  });

  it('carries bounded closeout evidence and its row discriminator', () => {
    const closeout = proof({
      proof: {
        sheet_write: 'skipped_duplicate',
        sheet_written: false,
        session_plans_closeout_status: 'written',
        session_plans_closeout_captured: true,
        session_plans_closeout_written: 1,
        session_plans_closeout_skipped: 0,
        session_plans_closeout_plan_version: 'pv_3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, closeout),
    ].join('\n'));
    const summary = artifact.turns[0].writes[0].closeout;

    assert.equal(summary.state, 'written');
    assert.equal(summary.plan_version, 'pv_3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('refuses to call a written closeout reviewable when its row discriminator is absent', () => {
    const unidentified = proof({
      proof: {
        sheet_write: 'skipped_duplicate',
        sheet_written: false,
        session_plans_closeout_status: 'written',
        session_plans_closeout_captured: true,
        session_plans_closeout_written: 1,
        session_plans_closeout_skipped: 0,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, unidentified),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.closeout.state, 'written_unidentified');
    assert.equal(write.reviewable, false);
    assert.equal(artifact.status, 'partial');
  });

  it('also requires the row discriminator for an idempotently skipped closeout', () => {
    const unidentified = proof({
      proof: {
        sheet_write: 'skipped_duplicate',
        sheet_written: false,
        duplicate_write: true,
        session_plans_closeout_status: 'skipped',
        session_plans_closeout_captured: true,
        session_plans_closeout_written: 0,
        session_plans_closeout_skipped: 1,
      },
    });
    const identified = proof({
      recorded_at: '2026-07-26T08:03:00.000Z',
      pairing: { ...proof().pairing, write_attempt: 2 },
      proof: {
        ...unidentified.proof,
        write_id: 'write-closeout-replay',
        session_plans_closeout_plan_version: 'pv_3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, unidentified),
      line(TURN_WRITE_PROOF_MARKER, identified),
    ].join('\n'));

    assert.equal(artifact.turns[0].writes[0].closeout.state, 'already_captured_unidentified');
    assert.equal(artifact.turns[0].writes[0].reviewable, false);
    assert.equal(artifact.turns[0].writes[1].closeout.state, 'already_captured');
    assert.equal(artifact.status, 'partial');
  });

  it('requires positive skip evidence before accepting an already-captured closeout', () => {
    const zeroEvidence = proof({
      proof: {
        sheet_write: 'skipped_duplicate',
        sheet_written: false,
        duplicate_write: true,
        session_plans_closeout_status: 'skipped',
        session_plans_closeout_captured: true,
        session_plans_closeout_written: 0,
        session_plans_closeout_skipped: 0,
        session_plans_closeout_plan_version: 'pv_3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, zeroEvidence),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.closeout.state, 'indeterminate');
    assert.equal(write.reviewable, false);
    assert.ok(write.issues.includes('closeout_not_reviewable'));
    assert.equal(artifact.status, 'partial');
  });

  it('distinguishes validation-withheld evidence from genuinely absent evidence', () => {
    const withheld = proof({
      proof: {
        session_plans_closeout_status: 'written',
        session_plans_closeout_captured: true,
        session_plans_closeout_written: 1,
      },
      withheld_evidence: ['session_plans_closeout_plan_version'],
    });
    const absent = proof({
      recorded_at: '2026-07-26T08:03:00.000Z',
      pairing: { ...proof().pairing, write_attempt: 2 },
      proof: {
        session_plans_closeout_status: 'no_plan',
        session_plans_closeout_captured: false,
      },
      withheld_evidence: [],
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, withheld),
      line(TURN_WRITE_PROOF_MARKER, absent),
    ].join('\n'));

    assert.equal(artifact.turns[0].writes[0].closeout.plan_version_state, 'withheld');
    assert.equal(artifact.turns[0].writes[1].closeout.plan_version_state, 'absent');
    assert.ok(artifact.turns[0].writes[0].issues.includes('evidence_withheld'));
  });
});

describe('turnWriteArtifact — bounded, leakage-safe review surface', () => {
  it('rejects noncanonical turn IDs before they can join or reach artifact output', () => {
    const privateTurnId = 'turn:private-coach-prompt';
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace({ turn_id: privateTurnId })),
      line(TURN_WRITE_PROOF_MARKER, proof({ turn_id: privateTurnId })),
    ].join('\n'));
    const serialized = JSON.stringify(artifact);

    assert.equal(artifact.status, 'empty');
    assert.equal(artifact.summary.joined_turns, 0);
    assert.equal(artifact.summary.rejected_records, 2);
    assert.ok(!serialized.includes(privateTurnId));
  });

  it('emits trace metadata only from the fixed production vocabularies', () => {
    const privateIntent = 'athlete said shoulder hurts';
    const privateSource = 'Log_Cleaned!A2:L99';
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace({
        intent_type: privateIntent,
        source: privateSource,
      })),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));
    const serialized = JSON.stringify(artifact);

    assert.equal(artifact.status, 'complete');
    assert.equal(artifact.turns[0].trace.intent_type, null);
    assert.equal(artifact.turns[0].trace.source, null);
    assert.ok(!serialized.includes(privateIntent));
    assert.ok(!serialized.includes(privateSource));
  });

  it('re-whitelists untrusted log input and never emits pairings, fingerprints, rows, prose, or secrets', () => {
    const capability = 'pair:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const fingerprint = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const hostile = proof({
      pairing_token: capability,
      payload_fingerprint: fingerprint,
      prompt: 'private coach prompt',
      proof: {
        sheet_written: true,
        rows_appended: 1,
        log_rows: [['Bench Press', 225, 5]],
        notes: 'private workout note',
        token: capability,
        fingerprint,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, { ...trace(), prompt: 'private trace prompt' }),
      line(TURN_WRITE_PROOF_MARKER, hostile),
    ].join('\n'));
    const serialized = JSON.stringify(artifact);

    for (const banned of [
      capability,
      fingerprint,
      'private coach prompt',
      'private trace prompt',
      'private workout note',
      'Bench Press',
    ]) {
      assert.ok(!serialized.includes(banned), `artifact must not contain ${banned}`);
    }
    assert.equal(artifact.turns[0].writes[0].proof.rows_appended, 1);
  });

  it('omits a capability or fingerprint embedded inside a client-controlled proof string', () => {
    const capability = 'pair:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const fingerprint = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    for (const reason of [`failed with ${capability}`, `identity ${fingerprint} mismatch`]) {
      const parsed = parseTurnWriteLines([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({ proof: { sheet_written: false, reason } })),
      ].join('\n'));
      const artifact = buildTurnWriteArtifact(parsed);

      assert.equal(parsed.proofs.length, 1);
      assert.ok(!Object.prototype.hasOwnProperty.call(parsed.proofs[0].proof, 'reason'));
      assert.equal(artifact.summary.reviewable_turns, 0);
      assert.ok(!JSON.stringify(artifact).includes(reason));
    }
  });

  it('rejects a capability-shaped turn id instead of reflecting it through the artifact', () => {
    const capability = `pair:${'a'.repeat(32)}`;
    const poisonedTurnId = `turn:${capability}`;
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace({ turn_id: poisonedTurnId })),
      line(TURN_WRITE_PROOF_MARKER, proof({ turn_id: poisonedTurnId })),
    ].join('\n'));
    const json = JSON.stringify(artifact);

    assert.equal(artifact.summary.rejected_records, 2);
    assert.equal(artifact.summary.reviewable_turns, 0);
    assert.ok(!json.includes(capability));
    assert.equal(artifact.status, 'empty');
  });

  it('rejects fractional proof counts instead of treating them as positive write evidence', () => {
    const parsed = parseTurnWriteLines(line(
      TURN_WRITE_PROOF_MARKER,
      proof({ proof: { sheet_written: false, rows_appended: 0.5 } }),
    ));

    assert.equal(parsed.proofs.length, 0);
    assert.equal(parsed.rejected_count, 1);
  });

  it('requires positive write or explicit no-write evidence before a joined record is reviewable', () => {
    const emptyProof = proof({ proof: {} });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, emptyProof),
    ].join('\n'));

    assert.equal(artifact.turns[0].writes[0].proof_state, 'insufficient');
    assert.equal(artifact.turns[0].writes[0].reviewable, false);
    assert.equal(artifact.status, 'partial');

    const noWrite = proof({
      proof: {
        test_mode: true,
        sheet_write: 'skipped',
        sheet_written: false,
        no_write_confirmed: true,
      },
    });
    const noWriteArtifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, noWrite),
    ].join('\n'));
    assert.equal(noWriteArtifact.turns[0].writes[0].proof_state, 'no_write_confirmed');
    assert.equal(noWriteArtifact.turns[0].writes[0].reviewable, true);
  });

  it('never treats explicit unverified or partial append states as a confirmed write', () => {
    for (const sheetWrite of ['unverified', 'partial']) {
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({
          proof: {
            sheet_write: sheetWrite,
            sheet_written: true,
            rows_appended: 1,
          },
        })),
      ].join('\n'));
      const write = artifact.turns[0].writes[0];

      assert.equal(write.proof_state, sheetWrite);
      assert.equal(write.reviewable, false);
      assert.equal(artifact.status, 'partial');
    }
  });

  it('omits client-controlled proof strings that can carry arbitrary prose', () => {
    const hostile = proof({
      proof: {
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        rows_appended: 1,
        write_id: 'private coach prompt',
        reason: 'private workout note',
        log_appended_range: 'private trace prose',
        effortAppendedRange: 'private secret prose',
      },
    });
    const parsed = parseTurnWriteLines(line(TURN_WRITE_PROOF_MARKER, hostile));
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, hostile),
    ].join('\n'));
    const emittedProof = artifact.turns[0].writes[0].proof;

    assert.equal(parsed.proofs.length, 1, 'one unsafe optional string must not erase safe proof');
    assert.equal(emittedProof.sheet_write, 'success');
    assert.equal(emittedProof.rows_appended, 1);
    for (const key of ['write_id', 'reason', 'log_appended_range', 'effortAppendedRange']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(emittedProof, key));
    }
    assert.ok(!JSON.stringify(artifact).includes('private'));
  });

  it('treats sealed_ok:true plus sheet_written:true without a positive sealed count as indeterminate', () => {
    const inconsistent = proof({
      proof: {
        sheet_written: true,
        ledger_seal_sheet_written: true,
        ledger_seal_sealed_ok: true,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, inconsistent),
    ].join('\n'));
    const write = artifact.turns[0].writes[0];

    assert.equal(write.seal.state, 'indeterminate');
    assert.equal(write.seal.successfully_sealed, false);
    assert.equal(write.reviewable, false);
  });

  it('fails reviewability closed when preview establishment or payload binding is absent', () => {
    const unbound = proof({
      pairing: {
        established_at_preview: true,
        write_attempt: 1,
        previewed_write_id_match: null,
        payload_bound: false,
        effort_transition: false,
      },
    });
    const artifact = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, unbound),
    ].join('\n'));

    assert.equal(artifact.turns[0].writes[0].authorization, 'preview_only_unbound');
    assert.equal(artifact.turns[0].writes[0].reviewable, false);
    assert.equal(artifact.turns[0].reviewable, false);
  });

  it('bounds accepted input and per-turn write attempts', () => {
    const lines = [line(INTERACTION_TRACE_MARKER, trace())];
    for (let i = 1; i <= 20; i += 1) {
      lines.push(line(TURN_WRITE_PROOF_MARKER, proof({
        recorded_at: `2026-07-26T08:${String(i).padStart(2, '0')}:00.000Z`,
        pairing: { ...proof().pairing, write_attempt: i },
        proof: { sheet_written: true, write_id: `write-${i}` },
      })));
    }
    const artifact = buildTurnWriteArtifact(lines.join('\n'));

    assert.ok(artifact.turns[0].writes.length <= 5);
    assert.ok(artifact.summary.rejected_records >= 15);
    assert.equal(artifact.turns[0].reviewable, false, 'overflow is visible and cannot be a false green');
  });
});

describe('turnWriteArtifact — human and CLI artifact', () => {
  it('formats complete, partial, and empty outcomes without calling an absence complete', () => {
    const complete = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));
    assert.match(formatTurnWriteArtifact(complete, { source: 'render.log' }), /1 reviewable turn/);

    const empty = buildTurnWriteArtifact('');
    const output = formatTurnWriteArtifact(empty, { source: 'empty.log' });
    assert.match(output, /No joined turn\/write evidence/);
    assert.doesNotMatch(output, /complete/i);
  });

  it('never reflects a capability or fingerprint supplied as an artifact source label', () => {
    const complete = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));
    const capability = 'pair:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const fingerprint = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    assert.ok(!formatTurnWriteArtifact(complete, { source: capability }).includes(capability));
    assert.ok(!formatTurnWriteArtifact(complete, { source: fingerprint }).includes(fingerprint));
  });

  it('CLI emits the machine artifact and exits non-zero on an empty false-green input', () => {
    const script = path.join(__dirname, '..', 'scripts', 'atlas-turn-write-artifact.js');
    const fullPath = path.join(os.tmpdir(), `atlas-turn-write-${process.pid}.log`);
    const emptyPath = path.join(os.tmpdir(), `atlas-turn-write-empty-${process.pid}.log`);
    fs.writeFileSync(fullPath, [
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));
    fs.writeFileSync(emptyPath, 'ordinary app log\n');
    try {
      const out = execFileSync('node', [script, fullPath, '--json'], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      assert.equal(parsed.status, 'complete');
      assert.equal(parsed.summary.reviewable_turns, 1);

      const empty = spawnSync(process.execPath, [script, emptyPath, '--json'], { encoding: 'utf8' });
      assert.notEqual(empty.status, 0);
      assert.equal(JSON.parse(empty.stdout).status, 'empty');
    } finally {
      fs.unlinkSync(fullPath);
      fs.unlinkSync(emptyPath);
    }
  });
});

// #1165 slice 3 — the complete-producer-tuple rule, applied to the six branches that still
// accepted a partial or impossible shape. Every case pairs the rejected shape with a POSITIVE
// CONTROL built from what the real producer actually emits, so the tightening cannot silently
// start discarding genuine records.
describe('turnWriteArtifact — complete producer tuples', () => {
  const COMPLETE_ROUTE = '/api/complete-workout';
  const STAMP = {
    ledger_seal_sheet_written: true,
    ledger_seal_no_write_confirmed: false,
    ledger_seal_sealed: 4,
    ledger_seal_already_sealed: 0,
    ledger_seal_sealed_ok: true,
  };

  const build = (overrides) => buildTurnWriteArtifact([
    line(INTERACTION_TRACE_MARKER, trace()),
    line(TURN_WRITE_PROOF_MARKER, proof(overrides)),
  ].join('\n'));

  it('requires the per-tab range-backed tuple on /api/complete-workout', () => {
    // A bare positive scalar is not the route's proof: the live route emits per-tab counts and
    // the append ranges whose exact row counts it verifies before returning.
    const bare = build({
      route: COMPLETE_ROUTE,
      proof: { sheet_write: 'success', sheet_written: true },
    });
    assert.equal(bare.turns[0].writes[0].proof_state, 'insufficient');
    assert.equal(bare.status, 'partial');

    // A positive count whose range names the wrong tab is equally unproved.
    const wrongTab = build({
      route: COMPLETE_ROUTE,
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        log_rows_written: 2,
        logAppendedRange: 'Effort!A100:L101',
        effort_rows_written: 0,
      },
    });
    assert.equal(wrongTab.turns[0].writes[0].proof_state, 'insufficient');

    // CONTROL — the real live log+effort completion.
    const logAndEffort = build({
      route: COMPLETE_ROUTE,
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A100:I100',
      },
    });
    assert.equal(logAndEffort.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(logAndEffort.status, 'complete');

    // `sheet_written` stays AUTHORITATIVE on this route. The Effort append is unconditional
    // (index.js:2585) and the success gate requires `effortRowsWritten === 1` (index.js:2643), so
    // every genuine success has `effortWritten:true` and therefore `sheet_written:true`. A success
    // claiming otherwise is a corrupted record, not a log-only completion.
    // Carries the COMPLETE Effort tuple, so the per-tab predicate is satisfied and `sheet_written`
    // is the only thing wrong — isolating that flag's authority rather than the Effort requirement.
    const successWithoutWriteFlag = build({
      route: COMPLETE_ROUTE,
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: false,
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A100:I100',
      },
    });
    assert.equal(successWithoutWriteFlag.turns[0].writes[0].proof_state, 'contradictory');
    assert.equal(successWithoutWriteFlag.status, 'partial');

    // CONTROL — the real EFFORT-ONLY completion. `logProofOk` is vacuously true when there are no
    // log rows (index.js:2640-2642), so a completion with only an Effort append is a genuine
    // producer shape and must stay reviewable under the per-tab rule.
    const effortOnly = build({
      route: COMPLETE_ROUTE,
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        log_rows_written: 0,
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A100:I100',
      },
    });
    assert.equal(effortOnly.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(effortOnly.status, 'complete');
  });

  it('requires the complete correlated duplicate tuple for idempotent_no_write', () => {
    // Ordinary early duplicate replays are never recorded; the only correlated producer is the
    // all-rows-duplicate closeout path, which emits the whole tuple.
    for (const partial of [
      { sheet_write: 'skipped_duplicate' },
      { duplicate_write: true },
      { skipped_duplicates: 3 },
    ]) {
      const artifact = build({ proof: { test_mode: false, ...partial } });
      assert.notEqual(
        artifact.turns[0].writes[0].proof_state, 'idempotent_no_write', JSON.stringify(partial),
      );
      assert.equal(artifact.status, 'partial', JSON.stringify(partial));
    }

    // CONTROL — the real duplicate body, with a seal replay and an already-captured closeout so
    // no sidecar write stands in for the duplicate classification itself.
    const real = build({
      proof: {
        test_mode: false,
        sheet_write: 'skipped_duplicate',
        sheet_written: false,
        duplicate_write: true,
        log_rows_written: 0,
        effort_rows_written: 0,
        skipped_duplicates: 3,
        closeout_fully_verified: true,
        ledger_seal_sheet_written: false,
        ledger_seal_no_write_confirmed: true,
        ledger_seal_sealed: 0,
        ledger_seal_already_sealed: 4,
        ledger_seal_sealed_ok: true,
        ledger_seal_reason: 'all_sealed',
        session_plans_closeout_status: 'skipped',
        session_plans_closeout_captured: true,
        session_plans_closeout_written: 0,
        session_plans_closeout_skipped: 1,
        session_plans_closeout_plan_version: 'pv_7c9e6679-7425-40de-944b-e07fc1f90ae7',
      },
    });
    assert.equal(real.turns[0].writes[0].proof_state, 'idempotent_no_write');
    assert.equal(real.status, 'complete');
  });

  it('requires the sibling already_sealed count on a fresh stamp', () => {
    const { ledger_seal_already_sealed: _omitted, ...withoutCount } = STAMP;
    const partial = build({ proof: { ...proof().proof, closeout_fully_verified: true, ...withoutCount } });
    assert.notEqual(partial.turns[0].writes[0].seal.state, 'sealed');
    assert.equal(partial.turns[0].writes[0].seal.new_seal_write, false);
    assert.equal(partial.status, 'partial');

    // CONTROL — the real stamp, including a nonzero already_sealed (rows pre-stamped by a retry).
    const complete = build({
      proof: {
        ...proof().proof,
        closeout_fully_verified: true,
        ...STAMP,
        ledger_seal_already_sealed: 2,
      },
    });
    assert.equal(complete.turns[0].writes[0].seal.state, 'sealed');
    assert.equal(complete.turns[0].writes[0].seal.new_seal_write, true);
    assert.equal(complete.status, 'complete');
  });

  it('requires the all_sealed discriminator on an idempotent replay', () => {
    const replayFields = {
      ledger_seal_sheet_written: false,
      ledger_seal_no_write_confirmed: true,
      ledger_seal_sealed: 0,
      ledger_seal_already_sealed: 4,
      ledger_seal_sealed_ok: true,
    };
    const noReason = build({ proof: { ...proof().proof, closeout_fully_verified: true, ...replayFields } });
    assert.notEqual(noReason.turns[0].writes[0].seal.state, 'already_sealed');
    assert.equal(noReason.turns[0].writes[0].seal.successfully_sealed, false);
    assert.equal(noReason.status, 'partial');

    // CONTROL — the real replay carries its discriminator.
    const withReason = build({
      proof: {
        ...proof().proof,
        closeout_fully_verified: true,
        ...replayFields,
        ledger_seal_reason: 'all_sealed',
      },
    });
    assert.equal(withReason.turns[0].writes[0].seal.state, 'already_sealed');
    assert.equal(withReason.turns[0].writes[0].seal.successfully_sealed, true);
    assert.equal(withReason.status, 'complete');
  });

  it('accepts only the reachable verified-no-new-seal outcomes', () => {
    const partial = build({
      proof: {
        ...proof().proof,
        closeout_fully_verified: true,
        ledger_seal_sheet_written: false,
        ledger_seal_no_write_confirmed: true,
        ledger_seal_sealed: 0,
        ledger_seal_sealed_ok: true,
      },
    });
    assert.notEqual(partial.turns[0].writes[0].seal.state, 'verified_no_new_seal');
    assert.equal(partial.status, 'partial');

    // CONTROLS — the two producer forms that genuinely reach this state.
    for (const reason of ['tab_missing', 'no_rows']) {
      const real = build({
        proof: {
          ...proof().proof,
          closeout_fully_verified: true,
          ledger_seal_sheet_written: false,
          ledger_seal_no_write_confirmed: true,
          ledger_seal_sealed: 0,
          ledger_seal_already_sealed: 0,
          ledger_seal_sealed_ok: true,
          ledger_seal_no_ledger: true,
          ledger_seal_reason: reason,
        },
      });
      assert.equal(real.turns[0].writes[0].seal.state, 'verified_no_new_seal', reason);
      assert.equal(real.status, 'complete', reason);
    }
  });

  it('pins closeout counts to the single-event producer shapes', () => {
    const closeoutBase = {
      ...proof().proof,
      closeout_fully_verified: true,
      // The correlated closeout branches always attach ledger_seal beside the closeout
      // (index.js:3253-3263, 3399-3407), so a faithful fixture carries the seal tuple too.
      ledger_seal_sealed_ok: true,
      ledger_seal_sheet_written: true,
      ledger_seal_no_write_confirmed: false,
      ledger_seal_sealed: 4,
      ledger_seal_already_sealed: 0,
      session_plans_closeout_captured: true,
      session_plans_closeout_plan_version: 'pv_7c9e6679-7425-40de-944b-e07fc1f90ae7',
    };
    // writeSessionCloseout appends exactly one event, so only 1/0 and 0/1 are producible.
    for (const counts of [
      { session_plans_closeout_status: 'written', session_plans_closeout_written: 2, session_plans_closeout_skipped: 0 },
      { session_plans_closeout_status: 'skipped', session_plans_closeout_written: 0, session_plans_closeout_skipped: 2 },
    ]) {
      const artifact = build({ proof: { ...closeoutBase, ...counts } });
      const state = artifact.turns[0].writes[0].closeout.state;
      assert.ok(state !== 'written' && state !== 'already_captured', JSON.stringify(counts));
      assert.equal(artifact.status, 'partial', JSON.stringify(counts));
    }

    // CONTROLS — both real single-event outcomes.
    const written = build({
      proof: {
        ...closeoutBase,
        session_plans_closeout_status: 'written',
        session_plans_closeout_written: 1,
        session_plans_closeout_skipped: 0,
      },
    });
    assert.equal(written.turns[0].writes[0].closeout.state, 'written');
    assert.equal(written.status, 'complete');

    const skipped = build({
      proof: {
        ...closeoutBase,
        session_plans_closeout_status: 'skipped',
        session_plans_closeout_written: 0,
        session_plans_closeout_skipped: 1,
      },
    });
    assert.equal(skipped.turns[0].writes[0].closeout.state, 'already_captured');
    assert.equal(skipped.status, 'complete');
  });
});

// Round 12 — five further complete-producer-tuple gaps, each verified against the reachable
// emitting path before being asserted. Four close false greens; the tab-name one closes a false
// NEGATIVE that would break any deployment using the documented sheet-name overrides.
describe('turnWriteArtifact — reachable producer paths', () => {
  const build = (overrides) => buildTurnWriteArtifact([
    line(INTERACTION_TRACE_MARKER, trace()),
    line(TURN_WRITE_PROOF_MARKER, proof(overrides)),
  ].join('\n'));

  it('requires the Effort tuple on every /api/complete-workout success', () => {
    // The Effort append is unconditional (index.js:2585) and the success gate requires
    // effort_rows_written === 1 plus an Effort range (index.js:2643), so a log-only success is
    // unreachable regardless of sheet_written and must fail closed on the per-tab predicate too.
    const logOnly = build({
      route: '/api/complete-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
        effort_rows_written: 0,
      },
    });
    assert.equal(logOnly.turns[0].writes[0].proof_state, 'insufficient');
    assert.equal(logOnly.status, 'partial');

    // CONTROLS — both reachable shapes: log+effort, and effort-only (logProofOk is vacuously
    // true with no log rows).
    const logAndEffort = build({
      route: '/api/complete-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A100:I100',
      },
    });
    assert.equal(logAndEffort.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(logAndEffort.status, 'complete');

    const effortOnly = build({
      route: '/api/complete-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        log_rows_written: 0,
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A100:I100',
      },
    });
    assert.equal(effortOnly.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(effortOnly.status, 'complete');
  });

  it('requires both emitted row counts on every per-tab append success', () => {
    // BOTH per-tab success bodies always emit BOTH counts as numbers on a live write:
    // /api/complete-workout at index.js:2723 (log, explicit 0 for effort-only) and :2745 (effort),
    // /api/log-workout at index.js:3416-3417. An ABSENT count therefore means the projection lost
    // part of the producer tuple, NOT that zero rows were intended — and absent must never read as
    // affirmative. Without this, a missing count vacuously satisfies the "positive counts carry
    // their range" clause and a truncated record is reviewable.
    const missingLogCount = build({
      route: '/api/complete-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A100:I100',
      },
    });
    assert.equal(missingLogCount.turns[0].writes[0].proof_state, 'insufficient');
    assert.equal(missingLogCount.status, 'partial');

    const missingEffortCount = build({
      route: '/api/log-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
      },
    });
    assert.equal(missingEffortCount.turns[0].writes[0].proof_state, 'insufficient');
    assert.equal(missingEffortCount.status, 'partial');

    // CONTROLS — the complete producer tuples, including the explicit zero each route really emits.
    const completeEffortOnly = build({
      route: '/api/complete-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        log_rows_written: 0,
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A100:I100',
      },
    });
    assert.equal(completeEffortOnly.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(completeEffortOnly.status, 'complete');

    const logWorkoutEffortless = build({
      route: '/api/log-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
        effort_rows_written: 0,
      },
    });
    assert.equal(logWorkoutEffortless.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(logWorkoutEffortless.status, 'complete');
  });

  it('keeps an explicit no-write flag beside positive append evidence contradictory', () => {
    // Tightening CLASSIFICATION must not weaken DIAGNOSIS. A success claiming sheet_written:false
    // beside real append evidence is a corrupted record whichever route emitted it, and stays
    // `contradictory` even when it also fails the newly required complete tuple — otherwise the
    // narrower per-tab predicate silently downgrades it to the milder `insufficient`.
    const completeWorkout = build({
      route: '/api/complete-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: false,
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
        effort_rows_written: 0,
      },
    });
    assert.equal(completeWorkout.turns[0].writes[0].proof_state, 'contradictory');
    assert.equal(completeWorkout.status, 'partial');

    const generic = build({
      route: '/api/log-modality',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: false,
        rows_appended: 3,
      },
    });
    assert.equal(generic.turns[0].writes[0].proof_state, 'contradictory');
    assert.equal(generic.status, 'partial');
  });

  it('diagnoses state-independent impossibilities before the terminal-state returns', () => {
    // `no_write_confirmed:true` beside real append evidence, and a dry run beside any of it, are
    // impossible WHATEVER `sheet_write` claims — so they must be caught before a terminal-state
    // classification lets a corrupted record hide behind its own claimed state.
    for (const state of ['partial', 'unverified', 'skipped_duplicate_in_progress']) {
      const denied = build({
        proof: {
          test_mode: false,
          sheet_write: state,
          no_write_confirmed: true,
          log_rows_written: 3,
          logAppendedRange: 'Log_Cleaned!A2:L4',
          effort_rows_written: 0,
        },
      });
      assert.equal(denied.turns[0].writes[0].proof_state, 'contradictory', state);
      assert.equal(denied.status, 'partial', state);
    }

    // CONTROLS — the genuine bodies really DO pair a non-success state with positive append
    // evidence, and must keep their own classification. `partial` (index.js:3356-3367) and
    // `unverified` (index.js:2645-2659) both carry sheet_written:true with a positive log count;
    // the in-progress duplicate spreads the original's counts (index.js:3170-3182). Calling any of
    // them contradictory would discard the records that most need reviewing.
    const realPartial = build({
      proof: {
        test_mode: false,
        sheet_write: 'partial',
        sheet_written: true,
        log_rows_written: 3,
        logAppendedRange: 'Log_Cleaned!A2:L4',
        effort_rows_written: 0,
      },
    });
    assert.equal(realPartial.turns[0].writes[0].proof_state, 'partial');

    const realUnverified = build({
      route: '/api/complete-workout',
      proof: {
        test_mode: false,
        sheet_write: 'unverified',
        sheet_written: true,
        log_rows_written: 3,
        logAppendedRange: 'Log_Cleaned!A2:L4',
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A9:I9',
      },
    });
    assert.equal(realUnverified.turns[0].writes[0].proof_state, 'unverified');

    const realInProgress = build({
      proof: {
        test_mode: false,
        sheet_write: 'skipped_duplicate_in_progress',
        sheet_written: false,
        duplicate_write: true,
        idempotency_status: 'in_progress',
        log_rows_written: 3,
      },
    });
    assert.equal(realInProgress.turns[0].writes[0].proof_state, 'idempotency_in_progress');
  });

  it('treats any positive append signal in a dry run as contradictory', () => {
    // A dry run appends nothing (W2), so `sheet_written:true` or a positive count beside
    // test_mode:true is impossible — not merely unsubstantiated. The narrower `positiveWrite`
    // missed both, because it needs a success claim it never gets on this path.
    for (const signal of [{ sheet_written: true }, { rows_appended: 2 }, { log_rows_written: 3 }]) {
      const artifact = build({
        proof: { test_mode: true, sheet_write: 'skipped', ...signal },
      });
      assert.equal(
        artifact.turns[0].writes[0].proof_state, 'contradictory', JSON.stringify(signal),
      );
      assert.equal(artifact.status, 'partial', JSON.stringify(signal));
    }

    // CONTROL — the real dry-run tuple appends nothing and stays reviewable.
    const dryRun = build({
      proof: {
        test_mode: true,
        sheet_write: 'skipped',
        sheet_written: false,
        no_write_confirmed: true,
      },
    });
    assert.equal(dryRun.turns[0].writes[0].proof_state, 'no_write_confirmed');
    assert.equal(dryRun.status, 'complete');
  });

  it('requires complete-workout’s authoritative write flag, and only there', () => {
    // `/api/complete-workout` emits `sheet_written: !testMode && effortWritten` (index.js:2721) on
    // every success, and the field is in PROOF_KEYS, so absence is a lost projection field rather
    // than a negative. Without requiring it, a truncated record keeps both counts and both ranges
    // and reads as a confirmed write.
    const truncated = build({
      route: '/api/complete-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A100:I100',
      },
    });
    assert.equal(truncated.turns[0].writes[0].proof_state, 'insufficient');
    assert.equal(truncated.status, 'partial');

    // CONTROL — the same record with the flag the producer really emits.
    const real = build({
      route: '/api/complete-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        sheet_written: true,
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A100:I100',
      },
    });
    assert.equal(real.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(real.status, 'complete');

    // ANTI-GENERALIZATION CONTROL — `/api/log-workout`'s success body (index.js:3413-3421) emits
    // NO `sheet_written` field at all. Requiring it there would reject that route's ordinary live
    // success, so this tightening is deliberately scoped to complete-workout alone.
    const logWorkout = build({
      route: '/api/log-workout',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
        effort_rows_written: 0,
      },
    });
    assert.equal(logWorkout.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(logWorkout.status, 'complete');
  });

  it('rejects an impossible write flag on the committed terminal states', () => {
    // `partial` (index.js:2605-2606, 3356-3366) and `unverified` (:2645-2658) both report
    // sheet_written:true beside their committed append evidence — the rows ARE on the sheet, which
    // is what makes those states worth reviewing. So sheet_written:false beside a positive count is
    // impossible there, and must be caught before the terminal return classifies it as ordinary.
    for (const state of ['partial', 'unverified']) {
      const corrupted = build({
        proof: {
          test_mode: false,
          sheet_write: state,
          sheet_written: false,
          log_rows_written: 3,
          logAppendedRange: 'Log_Cleaned!A2:L4',
        },
      });
      assert.equal(corrupted.turns[0].writes[0].proof_state, 'contradictory', state);
      assert.equal(corrupted.status, 'partial', state);
    }

    // CONTROLS — the genuine bodies keep their own classification.
    for (const state of ['partial', 'unverified']) {
      const genuine = build({
        proof: {
          test_mode: false,
          sheet_write: state,
          sheet_written: true,
          log_rows_written: 3,
          logAppendedRange: 'Log_Cleaned!A2:L4',
        },
      });
      const expected = state === 'partial' ? 'partial' : 'unverified';
      assert.equal(genuine.turns[0].writes[0].proof_state, expected, state);
    }

    // ANTI-GENERALIZATION CONTROL — the in-progress duplicate (index.js:3170-3182) sets
    // sheet_written:FALSE deliberately while spreading the original's counts, so that exact
    // combination is its real shape and must never be called contradictory.
    const inProgress = build({
      proof: {
        test_mode: false,
        sheet_write: 'skipped_duplicate_in_progress',
        sheet_written: false,
        duplicate_write: true,
        idempotency_status: 'in_progress',
        log_rows_written: 3,
      },
    });
    assert.equal(inProgress.turns[0].writes[0].proof_state, 'idempotency_in_progress');
  });

  it('requires seal evidence wherever closeout evidence is present', () => {
    // Both correlated closeout branches attach `ledger_seal` whenever they attach
    // `session_plans_closeout` (index.js:3253-3263 and 3399-3407; the normal branch only attaches
    // the closeout INSIDE `if (ledgerSeal)`), so closeout evidence with no seal at all is lost
    // producer evidence — and it is exactly the shape that would conceal a failed seal.
    const sealless = build({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        log_rows_written: 3,
        logAppendedRange: 'Log_Cleaned!A2:L4',
        effort_rows_written: 0,
        closeout_fully_verified: true,
        session_plans_closeout_status: 'written',
        session_plans_closeout_captured: true,
        session_plans_closeout_written: 1,
        session_plans_closeout_skipped: 0,
        session_plans_closeout_plan_version: 'pv_11111111-2222-3333-4444-555555555555',
      },
    });
    assert.ok(sealless.turns[0].issues.includes('seal_evidence_missing'));
    assert.equal(sealless.status, 'partial');

    // CONTROL — the same record with the seal the producer really attaches beside it.
    const withSeal = build({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        log_rows_written: 3,
        logAppendedRange: 'Log_Cleaned!A2:L4',
        effort_rows_written: 0,
        closeout_fully_verified: true,
        ledger_seal_sealed_ok: true,
        ledger_seal_sheet_written: true,
        ledger_seal_no_write_confirmed: false,
        ledger_seal_sealed: 4,
        ledger_seal_already_sealed: 0,
        session_plans_closeout_status: 'written',
        session_plans_closeout_captured: true,
        session_plans_closeout_written: 1,
        session_plans_closeout_skipped: 0,
        session_plans_closeout_plan_version: 'pv_11111111-2222-3333-4444-555555555555',
      },
    });
    assert.ok(!withSeal.turns[0].issues.includes('seal_evidence_missing'));
    assert.equal(withSeal.status, 'complete');

    // CONTROL — a plain main write carries no closeout evidence and needs no seal.
    const plain = build({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        log_rows_written: 3,
        logAppendedRange: 'Log_Cleaned!A2:L4',
        effort_rows_written: 0,
      },
    });
    assert.ok(!plain.turns[0].issues.includes('seal_evidence_missing'));
    assert.equal(plain.status, 'complete');
  });

  it('requires the emitted live-mode flag on a claimed main write', () => {
    // All four success producers emit test_mode explicitly — index.js:1409, 2026, and 3419 as a
    // literal false, and 2719 as `testMode`, which a success implies is false because :2722 sends
    // 'skipped' otherwise. So an absent flag on a claimed success is a lost tuple member.
    for (const [route, extra] of [
      ['/api/log-workout', { log_rows_written: 2, logAppendedRange: 'Log_Cleaned!A2:L3', effort_rows_written: 0 }],
      ['/api/log-modality', { sheet_written: true }],
    ]) {
      const truncated = build({ route, proof: { sheet_write: 'success', ...extra } });
      assert.equal(truncated.turns[0].writes[0].proof_state, 'insufficient', route);
      assert.equal(truncated.status, 'partial', route);

      // CONTROL — the producer's real body carries the flag.
      const real = build({ route, proof: {
        test_mode: false, sheet_write: 'success',
        duplicate_write: false, idempotency_status: 'completed', ...extra,
      } });
      assert.equal(real.turns[0].writes[0].proof_state, 'write_confirmed', route);
      assert.equal(real.status, 'complete', route);
    }
  });

  it('accepts the producer’s nullable would-seal evidence', () => {
    // `sealCloseout` genuinely returns `would_seal:null` when the ledger is unreadable while the
    // seal lane is in dry-run posture (sessionPlanSetsStore.js:256-258 and 271-273), and the
    // projection carries that scalar. Rejecting it discarded the WHOLE record — including a
    // committed main Log/Effort proof — so this is a false negative, not a false green.
    const artifact = build({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        log_rows_written: 3,
        logAppendedRange: 'Log_Cleaned!A2:L4',
        effort_rows_written: 0,
        closeout_fully_verified: false,
        ledger_seal_sealed_ok: false,
        ledger_seal_dry_run: true,
        ledger_seal_would_seal: null,
        ledger_seal_read_failed: true,
        ledger_seal_sealed: 0,
        ledger_seal_already_sealed: 0,
        ledger_seal_reason: 'ledger_read_failed',
      },
    });
    // The record must survive the join and be REPORTED, not silently dropped.
    assert.equal(artifact.turns.length, 1);
    assert.equal(artifact.turns[0].writes.length, 1);
    assert.equal(artifact.summary.rejected_records, 0);
    // It is still not a verified seal — a read failure fails closed.
    assert.equal(artifact.turns[0].writes[0].seal.state, 'failed');
    assert.ok(artifact.turns[0].issues.includes('seal_not_verified'));
  });

  it('does not cap accumulated preview history by the live-pairing concurrency bound', () => {
    // The two registry caps are NOT the same kind of limit, and only one of them bounds emitted
    // history:
    //   * writeIds REFUSES — `if (rec.writeIds.length >= MAX_WRITES_PER_PAIRING) return miss(...)`
    //     (turnCorrelation.js:836), so a 6th write attempt is never correlated and never logged.
    //   * pairings EVICT — `while (rec.pairings.length > MAX_OUTSTANDING_PAIRINGS) shift()`
    //     (:790), so a 9th preview IS accepted; only the oldest entry leaves memory. Its log line
    //     was already emitted. The registry's own comment says as much: "one per preview, oldest
    //     evicted", and writeIds bounds the turn "however many overlapping previews it accumulated".
    // Applying the concurrency cap to log history truncated real records and made a valid turn
    // permanently partial.
    const preview = (index) => proof({
      recorded_at: `2026-07-26T08:0${index}:00.000Z`,
      pairing: {
        established_at_preview: true,
        write_attempt: 0,
        previewed_write_id_match: null,
        payload_bound: false,
        effort_transition: false,
      },
      proof: {
        test_mode: true,
        sheet_write: 'skipped',
        sheet_written: false,
        no_write_confirmed: true,
      },
    });
    const nine = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      ...Array.from({ length: 9 }, (_, i) => line(TURN_WRITE_PROOF_MARKER, preview(i))),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));

    assert.ok(!nine.turns[0].issues.includes('preview_record_overflow'));
    assert.equal(nine.turns[0].previews.length, 9);
    assert.equal(nine.summary.rejected_records, 0);
    assert.equal(nine.status, 'complete');

    // CONTROL — the write-attempt cap is a REFUSAL, so more correlated attempts than the registry
    // can issue is genuinely impossible and must stay flagged. (An attempt NUMBER above the cap is
    // already rejected at sanitize time, so this exercises the count: six in-range records.)
    const sixAttempts = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      ...[1, 2, 3, 4, 5, 5].map((attempt, i) => line(TURN_WRITE_PROOF_MARKER, proof({
        recorded_at: `2026-07-26T08:1${i}:00.000Z`,
        pairing: {
          established_at_preview: true,
          write_attempt: attempt,
          previewed_write_id_match: null,
          payload_bound: true,
          effort_transition: false,
        },
      }))),
    ].join('\n'));
    assert.ok(sixAttempts.turns[0].issues.includes('write_attempt_overflow'));
    assert.equal(sixAttempts.status, 'partial');
  });

  it('requires the live-success idempotency tuple', () => {
    // All four live write routes REFUSE a write without a write_id (index.js:1382, 1988, 2507,
    // 3160), so beginWrite always returns enabled:true on an append and every success body sets
    // duplicate_write:false + idempotency_status:'completed' (index.js:1417-1420, 2030-2033,
    // 2771-2772, 3440-3443). A replay never reaches 'success' — it returns a skipped_duplicate
    // body instead. So on a claimed success these two are absent-means-unknown like any other
    // producer-tuple member, and a contradictory value is impossible outright.
    // Deliberately WITHOUT the idempotency tuple — each case below supplies (or corrupts) it.
    const base = {
      test_mode: false,
      sheet_write: 'success',
      log_rows_written: 2,
      logAppendedRange: 'Log_Cleaned!A100:L101',
      effort_rows_written: 0,
    };
    for (const broken of [
      {},
      { duplicate_write: false },
      { idempotency_status: 'completed' },
      { duplicate_write: true, idempotency_status: 'completed' },
      { duplicate_write: false, idempotency_status: 'in_progress' },
      { duplicate_write: false, idempotency_status: 'failed' },
    ]) {
      const artifact = build({ proof: { ...base, ...broken } });
      assert.equal(
        artifact.turns[0].writes[0].proof_state, 'insufficient', JSON.stringify(broken),
      );
      assert.equal(artifact.status, 'partial', JSON.stringify(broken));
    }

    // CONTROL — the real live-success tuple, on a per-tab route and a generic one.
    const perTab = build({
      proof: { ...base, duplicate_write: false, idempotency_status: 'completed' },
    });
    assert.equal(perTab.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(perTab.status, 'complete');

    const generic = build({
      route: '/api/log-modality',
      proof: {
        test_mode: false,
        sheet_write: 'success',
        sheet_written: true,
        duplicate_write: false,
        idempotency_status: 'completed',
      },
    });
    assert.equal(generic.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(generic.status, 'complete');
  });

  it('requires the gated sidecar tuple on a correlated duplicate', () => {
    // The all-rows-duplicate branch is correlated ONLY through the sidecar gate at
    // index.js:3276 — `if (duplicateBody.ledger_seal || duplicateBody.session_plans_closeout)`.
    // Both are set together inside the closeout_context block (:3253-3263, including its catch),
    // which also sets closeout_fully_verified, and :3265-3267 adds idempotency_status:'completed'.
    // So a bare duplicate that wrote nothing is never recorded at all: the minimal scalar tuple
    // with no sidecar evidence is a producer-impossible record, and it was reading as reviewable
    // because absent seal/closeout evidence raises no downstream issue.
    const duplicateBase = {
      test_mode: false,
      sheet_write: 'skipped_duplicate',
      sheet_written: false,
      duplicate_write: true,
      log_rows_written: 0,
      skipped_duplicates: 3,
    };
    const sidecar = {
      idempotency_status: 'completed',
      closeout_fully_verified: true,
      ledger_seal_sealed_ok: true,
      ledger_seal_sheet_written: true,
      ledger_seal_no_write_confirmed: false,
      ledger_seal_sealed: 4,
      ledger_seal_already_sealed: 0,
      session_plans_closeout_status: 'written',
      session_plans_closeout_captured: true,
      session_plans_closeout_written: 1,
      session_plans_closeout_skipped: 0,
      session_plans_closeout_plan_version: 'pv_11111111-2222-3333-4444-555555555555',
    };

    const bare = build({ proof: { ...duplicateBase } });
    assert.notEqual(bare.turns[0].writes[0].proof_state, 'idempotent_no_write');
    assert.equal(bare.status, 'partial');

    // Missing only the completed idempotency status, and missing only the verdict.
    const { idempotency_status: _s, ...noStatus } = sidecar;
    const noStatusArtifact = build({ proof: { ...duplicateBase, ...noStatus } });
    assert.notEqual(noStatusArtifact.turns[0].writes[0].proof_state, 'idempotent_no_write');

    const { closeout_fully_verified: _v, ...noVerdict } = sidecar;
    const noVerdictArtifact = build({ proof: { ...duplicateBase, ...noVerdict } });
    assert.notEqual(noVerdictArtifact.turns[0].writes[0].proof_state, 'idempotent_no_write');

    // CONTROL — the real correlated duplicate, which always carries the whole sidecar tuple.
    const real = build({ proof: { ...duplicateBase, ...sidecar } });
    assert.equal(real.turns[0].writes[0].proof_state, 'idempotent_no_write');
    assert.equal(real.status, 'complete');
  });

  it('requires the emitted preview state on an attempt-zero record', () => {
    // All THREE preview correlation producers — /api/log-modality (index.js:1372),
    // /api/bodyweight (:1978) and /api/log-workout (:3152) — emit sheet_write:'skipped' beside
    // the no-write tuple. (/api/complete-workout emits no preview correlation at all.) So a
    // preview record with that field absent, or set to another state, is a shape no producer
    // emits and must be rejected like any other malformed record.
    const previewPairing = {
      established_at_preview: true,
      write_attempt: 0,
      previewed_write_id_match: null,
      payload_bound: false,
      effort_transition: false,
    };
    for (const state of [undefined, 'skipped_duplicate', 'success']) {
      const malformed = { test_mode: true, sheet_written: false, no_write_confirmed: true };
      if (state !== undefined) malformed.sheet_write = state;
      const artifact = buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({ pairing: previewPairing, proof: malformed })),
        line(TURN_WRITE_PROOF_MARKER, proof()),
      ].join('\n'));
      assert.equal(artifact.summary.rejected_records, 1, String(state));
      assert.equal(artifact.status, 'partial', String(state));
    }

    // CONTROL — the real preview body stays accepted and reviewable beside a healthy live write.
    const real = buildTurnWriteArtifact([
      line(INTERACTION_TRACE_MARKER, trace()),
      line(TURN_WRITE_PROOF_MARKER, proof({
        pairing: previewPairing,
        proof: {
          test_mode: true,
          sheet_write: 'skipped',
          sheet_written: false,
          no_write_confirmed: true,
        },
      })),
      line(TURN_WRITE_PROOF_MARKER, proof()),
    ].join('\n'));
    assert.equal(real.summary.rejected_records, 0);
    assert.equal(real.status, 'complete');
  });

  it('requires the exact success fields on the generic write routes', () => {
    // index.js:1407-1423 and 2024-2036 both emit sheet_write:'success' with sheet_written:true and
    // never a row-count field, so a count cannot substitute for the write flag.
    for (const route of ['/api/log-modality', '/api/bodyweight']) {
      for (const fabricated of [{ rows_appended: 1 }, { log_rows_written: 2 }]) {
        const artifact = build({
          route,
          proof: {
            test_mode: false, sheet_write: 'success',
            duplicate_write: false, idempotency_status: 'completed', ...fabricated,
          },
        });
        assert.notEqual(
          artifact.turns[0].writes[0].proof_state, 'write_confirmed', `${route} ${JSON.stringify(fabricated)}`,
        );
        assert.equal(artifact.status, 'partial', `${route} ${JSON.stringify(fabricated)}`);
      }

      // CONTROL — the real success body.
      const real = build({
        route,
        proof: {
          test_mode: false, sheet_write: 'success', sheet_written: true,
          duplicate_write: false, idempotency_status: 'completed',
        },
      });
      assert.equal(real.turns[0].writes[0].proof_state, 'write_confirmed', route);
      assert.equal(real.status, 'complete', route);
    }
  });

  it('validates append ranges against the CONFIGURED tab names', () => {
    // sheets.js:6-7 — LOG_SHEET_NAME / EFFORT_SHEET_NAME are supported overrides used by the real
    // append routes, so Google returns the configured tab in updatedRange. Hard-coding the
    // defaults would call every genuine append on such a deployment insufficient.
    const originalLog = process.env.LOG_SHEET_NAME;
    const originalEffort = process.env.EFFORT_SHEET_NAME;
    process.env.LOG_SHEET_NAME = 'Log_Cleaned_V2';
    process.env.EFFORT_SHEET_NAME = 'Effort_V2';
    delete require.cache[require.resolve('../services/turnWriteArtifact')];
    try {
      const reloaded = require('../services/turnWriteArtifact');
      const artifact = reloaded.buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({
          proof: {
            test_mode: false,
            sheet_write: 'success',
            duplicate_write: false,
            idempotency_status: 'completed',
            log_rows_written: 2,
            logAppendedRange: 'Log_Cleaned_V2!A100:L101',
            effort_rows_written: 1,
            effortAppendedRange: 'Effort_V2!A100:I100',
          },
        })),
      ].join('\n'));

      assert.equal(artifact.turns[0].writes[0].proof_state, 'write_confirmed');
      assert.equal(artifact.status, 'complete');
    } finally {
      if (originalLog === undefined) delete process.env.LOG_SHEET_NAME;
      else process.env.LOG_SHEET_NAME = originalLog;
      if (originalEffort === undefined) delete process.env.EFFORT_SHEET_NAME;
      else process.env.EFFORT_SHEET_NAME = originalEffort;
      delete require.cache[require.resolve('../services/turnWriteArtifact')];
    }
  });

  it('accepts the quoted A1 form Google returns for tab names needing quotes', () => {
    // The app builds its append range unquoted (`${tabName}!A1`, sheets.js:123), but Google echoes
    // CANONICAL A1 in updatedRange, which single-quotes any sheet name containing a space — and
    // doubles an embedded apostrophe. So a deployment overriding the tab name to `Workout Log`
    // gets back `'Workout Log'!A100:L101` and its genuine append loses its range evidence.
    //
    // Accepting the quoted form cannot create a false green: the exact configured name, the exact
    // contract column span, and the exact row count are all still required. It only tolerates the
    // quoting Google itself applies.
    const originalLog = process.env.LOG_SHEET_NAME;
    const originalEffort = process.env.EFFORT_SHEET_NAME;
    process.env.LOG_SHEET_NAME = 'Workout Log';
    process.env.EFFORT_SHEET_NAME = "Dale's Effort";
    delete require.cache[require.resolve('../services/turnWriteArtifact')];
    try {
      const reloaded = require('../services/turnWriteArtifact');
      const quoted = reloaded.buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({
          proof: {
            test_mode: false,
            sheet_write: 'success',
            duplicate_write: false,
            idempotency_status: 'completed',
            log_rows_written: 2,
            logAppendedRange: "'Workout Log'!A100:L101",
            effort_rows_written: 1,
            effortAppendedRange: "'Dale''s Effort'!A100:I100",
          },
        })),
      ].join('\n'));
      assert.equal(quoted.turns[0].writes[0].proof_state, 'write_confirmed');
      assert.equal(quoted.status, 'complete');

      // NEGATIVE CONTROL — a DIFFERENT tab, quoted, must still fail. Tolerating the quoting must
      // not tolerate the wrong sheet.
      const wrongTab = reloaded.buildTurnWriteArtifact([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({
          proof: {
            test_mode: false,
            sheet_write: 'success',
            duplicate_write: false,
            idempotency_status: 'completed',
            log_rows_written: 2,
            logAppendedRange: "'Other Log'!A100:L101",
            effort_rows_written: 1,
            effortAppendedRange: "'Dale''s Effort'!A100:I100",
          },
        })),
      ].join('\n'));
      assert.equal(wrongTab.turns[0].writes[0].proof_state, 'insufficient');
    } finally {
      if (originalLog === undefined) delete process.env.LOG_SHEET_NAME;
      else process.env.LOG_SHEET_NAME = originalLog;
      if (originalEffort === undefined) delete process.env.EFFORT_SHEET_NAME;
      else process.env.EFFORT_SHEET_NAME = originalEffort;
      delete require.cache[require.resolve('../services/turnWriteArtifact')];
    }
  });

  it('still accepts the unquoted form for tab names that need no quoting', () => {
    // The default deployment must be completely unchanged by the quoting tolerance.
    const artifact = build({
      proof: {
        test_mode: false,
        sheet_write: 'success',
        duplicate_write: false,
        idempotency_status: 'completed',
        log_rows_written: 2,
        logAppendedRange: 'Log_Cleaned!A100:L101',
        effort_rows_written: 1,
        effortAppendedRange: 'Effort!A100:I100',
      },
    });
    assert.equal(artifact.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(artifact.status, 'complete');
  });

  it('rejects non-stamping seal flags on a positive seal state', () => {
    // sealCloseout sets no_ledger / read_failed only on non-stamping outcomes; its successful
    // stamp never does.
    for (const impossible of [{ ledger_seal_no_ledger: true }, { ledger_seal_read_failed: true }]) {
      const stamped = build({
        proof: {
          ...proof().proof,
          closeout_fully_verified: true,
          ledger_seal_sheet_written: true,
          ledger_seal_no_write_confirmed: false,
          ledger_seal_sealed: 4,
          ledger_seal_already_sealed: 0,
          ledger_seal_sealed_ok: true,
          ...impossible,
        },
      });
      assert.notEqual(stamped.turns[0].writes[0].seal.state, 'sealed', JSON.stringify(impossible));
      assert.equal(stamped.status, 'partial', JSON.stringify(impossible));

      const replayed = build({
        proof: {
          ...proof().proof,
          closeout_fully_verified: true,
          ledger_seal_sheet_written: false,
          ledger_seal_no_write_confirmed: true,
          ledger_seal_sealed: 0,
          ledger_seal_already_sealed: 4,
          ledger_seal_sealed_ok: true,
          ledger_seal_reason: 'all_sealed',
          ...impossible,
        },
      });
      assert.notEqual(replayed.turns[0].writes[0].seal.state, 'already_sealed', JSON.stringify(impossible));
      assert.equal(replayed.status, 'partial', JSON.stringify(impossible));
    }
  });

  it('enforces the disabled and no_plan closeout envelopes', () => {
    // _capture emits disabled as captured:false with zero counts (sessionPlanCapture.js:51-59,88);
    // recordCloseoutEvent emits no_plan as {status:'no_plan', captured:false} with no counts at all.
    for (const impossible of [
      { session_plans_closeout_status: 'disabled', session_plans_closeout_captured: true, session_plans_closeout_written: 99 },
      { session_plans_closeout_status: 'no_plan', session_plans_closeout_captured: true },
    ]) {
      const artifact = build({
        proof: { ...proof().proof, closeout_fully_verified: true, ledger_seal_sealed_ok: true, ledger_seal_sheet_written: true, ledger_seal_no_write_confirmed: false, ledger_seal_sealed: 4, ledger_seal_already_sealed: 0, ...impossible },
      });
      assert.equal(artifact.turns[0].writes[0].closeout.state, 'indeterminate', JSON.stringify(impossible));
      assert.equal(artifact.status, 'partial', JSON.stringify(impossible));
    }

    // CONTROLS — the real envelopes.
    const disabled = build({
      proof: {
        ...proof().proof,
        closeout_fully_verified: true,
        ledger_seal_sealed_ok: true, ledger_seal_sheet_written: true, ledger_seal_no_write_confirmed: false, ledger_seal_sealed: 4, ledger_seal_already_sealed: 0,
        session_plans_closeout_status: 'disabled',
        session_plans_closeout_captured: false,
        session_plans_closeout_written: 0,
        session_plans_closeout_skipped: 0,
      },
    });
    assert.equal(disabled.turns[0].writes[0].closeout.state, 'disabled');
    assert.equal(disabled.status, 'complete');

    const noPlan = build({
      proof: {
        ...proof().proof,
        closeout_fully_verified: true,
        ledger_seal_sealed_ok: true, ledger_seal_sheet_written: true, ledger_seal_no_write_confirmed: false, ledger_seal_sealed: 4, ledger_seal_already_sealed: 0,
        session_plans_closeout_status: 'no_plan',
        session_plans_closeout_captured: false,
      },
    });
    assert.equal(noPlan.turns[0].writes[0].closeout.state, 'no_plan');
    assert.equal(noPlan.status, 'complete');
  });
});
