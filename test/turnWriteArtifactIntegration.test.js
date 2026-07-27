'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const traceShadow = require('../services/interactionTraceShadow');
const correlation = require('../services/turnCorrelation');
const {
  buildTurnWriteArtifact,
  INTERACTION_TRACE_MARKER,
  TURN_WRITE_PROOF_MARKER,
} = require('../services/turnWriteArtifact');

const TURN_ID = 'turn:2026-07-26T09:00:00.000Z_1_abcdef';
const SESSION_ID = 'session-artifact-integration';
const INITIATION = 'init:11111111-1111-4111-8111-111111111111';
const ORIGINAL_ENV = process.env.ATLAS_INTERACTION_TRACE;

test.afterEach(() => {
  traceShadow._resetForTesting();
  correlation._resetForTesting();
  if (ORIGINAL_ENV === undefined) delete process.env.ATLAS_INTERACTION_TRACE;
  else process.env.ATLAS_INTERACTION_TRACE = ORIGINAL_ENV;
});

test('real trace and correlation emitters produce one leakage-safe reviewable join', () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  traceShadow._resetForTesting();
  correlation._resetForTesting();

  const emitted = [];
  const originalLog = console.log;
  console.log = (...parts) => {
    const rendered = parts.map(String).join(' ');
    if (rendered.includes(INTERACTION_TRACE_MARKER) || rendered.includes(TURN_WRITE_PROOF_MARKER)) {
      emitted.push(rendered);
    }
  };

  let pairingToken;
  try {
    const turn = traceShadow.beginTurn({
      turnId: TURN_ID,
      asOf: '2026-07-26T09:00:00.000Z',
      intentType: 'set',
      source: 'coach_message',
    });
    turn.stage('intent', 'ok');
    turn.stage('session_snapshot', 'ok');
    turn.stage('engine_decision', 'ok');
    turn.stage('coaching_strategy', 'ok');
    turn.stage('model_response', 'ok');
    turn.stage('validator_result', 'ok');
    turn.stage('rendered_output', 'ok');
    assert.equal(turn.finish().valid, true);

    correlation.issueTurn(TURN_ID, SESSION_ID, { nowMs: 1_000 });
    const previewPayload = {
      session_id: SESSION_ID,
      date: '2026-07-26',
      test_mode: true,
      write_id: 'write-artifact-1',
      log_rows: [['2026-07-26', SESSION_ID, 'Bench Press', 225, 5, 2]],
      correlation: {
        turn_id: TURN_ID,
        initiation_nonce: INITIATION,
        retire_initiation_nonces: [],
      },
    };
    const preview = correlation.resolveCorrelation(previewPayload, {
      sessionId: SESSION_ID,
      nowMs: 1_001,
      isPreview: true,
      previewedWriteId: 'write-artifact-1',
    });
    assert.equal(preview.ok, true);
    pairingToken = preview.pairing_token;
    correlation.recordWriteProof({
      turnId: preview.turn_id,
      sessionId: SESSION_ID,
      route: '/api/log-workout',
      recordedAt: '2026-07-26T09:01:00.000Z',
      pairing: preview.pairing,
      proof: {
        test_mode: true,
        sheet_write: 'skipped',
        sheet_written: false,
        no_write_confirmed: true,
      },
    });

    const livePayload = {
      session_id: SESSION_ID,
      date: '2026-07-26',
      write_id: 'write-artifact-1',
      log_rows: [['2026-07-26', SESSION_ID, 'Bench Press', 225, 5, 2]],
      correlation: {
        turn_id: TURN_ID,
        pairing_token: pairingToken,
        initiation_nonce: INITIATION,
      },
    };
    const live = correlation.resolveCorrelation(livePayload, {
      sessionId: SESSION_ID,
      nowMs: 1_002,
      writeId: 'write-artifact-1',
    });
    assert.equal(live.ok, true);
    assert.equal(live.pairing.payload_bound, true);

    correlation.recordWriteProof({
      turnId: live.turn_id,
      sessionId: SESSION_ID,
      route: '/api/log-workout',
      recordedAt: '2026-07-26T09:02:00.000Z',
      pairing: live.pairing,
      proof: {
        test_mode: false,
        sheet_write: 'success',
        write_id: 'write-artifact-1',
        logAppendedRange: 'Log_Cleaned!A2:L2',
        log_rows_written: 1,
        effort_rows_written: 0,
        effortWritten: false,
      },
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(emitted.filter((entry) => entry.includes(INTERACTION_TRACE_MARKER)).length, 1);
  assert.equal(emitted.filter((entry) => entry.includes(TURN_WRITE_PROOF_MARKER)).length, 2);

  const artifact = buildTurnWriteArtifact(emitted.join('\n'));
  assert.equal(artifact.status, 'complete');
  assert.equal(artifact.summary.reviewable_turns, 1);
  assert.equal(artifact.turns[0].turn_id, TURN_ID);
  assert.equal(artifact.turns[0].previews.length, 1);
  assert.equal(artifact.turns[0].writes.length, 1);
  assert.equal(artifact.turns[0].writes[0].authorization, 'preview_payload_bound');
  assert.equal(artifact.turns[0].writes[0].proof_state, 'write_confirmed');

  const serialized = JSON.stringify(artifact);
  assert.ok(!serialized.includes(pairingToken), 'the pairing capability never reaches the artifact');
  assert.ok(!serialized.includes('Bench Press'), 'workout rows never reach the artifact');
});
