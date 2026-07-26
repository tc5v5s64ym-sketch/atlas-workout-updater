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
      sheet_written: true,
      no_write_confirmed: false,
      write_id: 'write-b',
      rows_appended: 3,
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

  it('distinguishes a newly stamped seal from an idempotent already-sealed replay', () => {
    const stamped = proof({
      proof: {
        ledger_seal_sheet_written: true,
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

  it('rejects a capability or fingerprint embedded inside an otherwise allowed proof string', () => {
    const capability = 'pair:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const fingerprint = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    for (const reason of [`failed with ${capability}`, `identity ${fingerprint} mismatch`]) {
      const parsed = parseTurnWriteLines([
        line(INTERACTION_TRACE_MARKER, trace()),
        line(TURN_WRITE_PROOF_MARKER, proof({ proof: { sheet_written: false, reason } })),
      ].join('\n'));
      const artifact = buildTurnWriteArtifact(parsed);

      assert.equal(parsed.proofs.length, 0);
      assert.equal(artifact.summary.reviewable_turns, 0);
      assert.ok(!JSON.stringify(artifact).includes(reason));
    }
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
