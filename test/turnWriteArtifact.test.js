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
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
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
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
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
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
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
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
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
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
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
            logAppendedRange: 'Log_Cleaned!A2:L4',
            log_rows_written: 3,
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
        logAppendedRange: 'Log_Cleaned!A2:L4',
        log_rows_written: 3,
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
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
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
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
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
          logAppendedRange: 'Log_Cleaned!A2:L4',
          log_rows_written: 3,
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
        logAppendedRange: 'Log_Cleaned!A2:L4',
        log_rows_written: 3,
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
        logAppendedRange: 'Log_Cleaned!A2:L4',
        log_rows_written: 3,
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
        logAppendedRange: 'Log_Cleaned!A2:L4',
        log_rows_written: 3,
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
        logAppendedRange: 'Log_Cleaned!A2:L4',
        log_rows_written: 3,
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
