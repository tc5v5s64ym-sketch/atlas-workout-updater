'use strict';

// F-SB4B trace_write_join live-proof bites (TEMPORARY; sunset: F-SB4C). Proves
// scorecard condition 19 can never again pass on a PREVIEW proof: the spec
// selected the join proof as the first sheet_write:'success' proof OR the
// last proof of any kind, and a preview emits a [turn-write-proof] record for
// the same turn_id with sheet_write 'skipped' — so a run with a preview but
// no live write joined "on the live write turn" that never happened (the
// C93176 family). An independent audit reproduced the spec computation
// verbatim: preview-proof-only evidence → trace_write_join PASS. The
// selection now lives in tests/e2e/gate/rehearsal-write-proof-join.js with
// NO fallback; these bites pin it at that seam and end-to-end through the
// real scorecard condition.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isLiveWriteProof, selectLiveWriteProof, evaluateTraceWriteJoin } = require('../tests/e2e/gate/rehearsal-write-proof-join');
const { CONDITIONS, PASS, FAIL } = require('../tests/e2e/gate/rehearsal-scorecard');

const TURN = 'turn:2026-10-29T11:00:43.548Z_4_ad9g64';
const OTHER_TURN = 'turn:2026-10-29T11:02:10.100Z_7_zz99xx';

// Record shapes mirror the real [turn-write-proof] lines in the rehearsal
// artifacts (services/turnCorrelation.js buildWriteProofRecord): outcome
// under `proof`, attempt ordinal under the top-level `pairing`. All 50 real
// records carry pairing.write_attempt as an integer — 0/skipped for the
// preview, 1/success for the live write, no other combination.
function previewProof(turnId = TURN) {
  return {
    schema_version: 1, turn_id: turnId, session_id: '20261029-AM-01', route: '/api/log-workout',
    recorded_at: '2026-10-29T11:00:44.000Z',
    pairing: { established_at_preview: true, write_attempt: 0, previewed_write_id_match: null, payload_bound: false, effort_transition: false },
    proof: { test_mode: true, sheet_write: 'skipped' },
  };
}
function liveProof(turnId = TURN) {
  return {
    schema_version: 1, turn_id: turnId, session_id: '20261029-AM-01', route: '/api/log-workout',
    recorded_at: '2026-10-29T11:00:55.000Z',
    pairing: { established_at_preview: true, write_attempt: 1, previewed_write_id_match: true, payload_bound: true, effort_transition: false },
    proof: { test_mode: false, sheet_write: 'success' },
  };
}
const traceOn = (turnId) => ({ turn_id: turnId });

describe('isLiveWriteProof — the gate', () => {
  it('accepts the real live-write shape (sheet_write success, write_attempt 1)', () => {
    assert.equal(isLiveWriteProof(liveProof()), true);
  });

  it('refuses the preview shape (sheet_write skipped, write_attempt 0, same turn_id)', () => {
    assert.equal(isLiveWriteProof(previewProof()), false);
  });

  it('refuses a success outcome claimed on a preview attempt (write_attempt 0)', () => {
    const r = liveProof(); r.pairing.write_attempt = 0;
    assert.equal(isLiveWriteProof(r), false);
  });

  it('refuses a live attempt whose write was skipped', () => {
    const r = previewProof(); r.pairing.write_attempt = 1;
    assert.equal(isLiveWriteProof(r), false);
  });

  it('judges on sheet_write alone when the attempt field is absent (never fabricates one)', () => {
    const r = liveProof(); delete r.pairing;
    assert.equal(isLiveWriteProof(r), true);
    const p = previewProof(); delete p.pairing;
    assert.equal(isLiveWriteProof(p), false);
  });

  it('refuses absent or malformed records', () => {
    for (const bad of [null, undefined, 'proof', 42, {}, { proof: null }, { proof: {} }, { proof: { sheet_write: 1 } }]) {
      assert.equal(isLiveWriteProof(bad), false, JSON.stringify(bad));
    }
  });
});

describe('selectLiveWriteProof — no fallback', () => {
  it('returns null for a preview-only proof set (the audited defect input)', () => {
    assert.equal(selectLiveWriteProof([previewProof()]), null);
  });

  it('returns null for an empty or non-array proof set', () => {
    assert.equal(selectLiveWriteProof([]), null);
    assert.equal(selectLiveWriteProof(null), null);
    assert.equal(selectLiveWriteProof(undefined), null);
  });

  it('selects the live proof, not the last proof, when both exist', () => {
    const live = liveProof();
    assert.equal(selectLiveWriteProof([previewProof(), live]), live);
    assert.equal(selectLiveWriteProof([live, previewProof(OTHER_TURN)]), live);
  });
});

describe('evaluateTraceWriteJoin — the condition-19 observation', () => {
  it('does NOT join on a preview-only proof set even when a trace carries the same turn_id', () => {
    const v = evaluateTraceWriteJoin({ traces: [traceOn(TURN)], proofs: [previewProof()] });
    assert.equal(v.join_ok, false);
    assert.equal(v.turn_id, null);
  });

  it('joins when a live proof exists and a trace carries its turn_id', () => {
    const v = evaluateTraceWriteJoin({ traces: [traceOn(TURN)], proofs: [previewProof(), liveProof()] });
    assert.equal(v.join_ok, true);
    assert.equal(v.turn_id, TURN);
  });

  it('does not join when the live proof turn has no trace', () => {
    const v = evaluateTraceWriteJoin({ traces: [traceOn(OTHER_TURN)], proofs: [liveProof()] });
    assert.equal(v.join_ok, false);
    assert.equal(v.turn_id, TURN);
  });

  it('does not join with no proofs at all (unchanged zero-proofs behaviour)', () => {
    const v = evaluateTraceWriteJoin({ traces: [traceOn(TURN)], proofs: [] });
    assert.equal(v.join_ok, false);
    assert.equal(v.turn_id, null);
  });

  it('keeps the recorded detail shape (counts of traces and proofs)', () => {
    const v = evaluateTraceWriteJoin({ traces: [traceOn(TURN), traceOn(OTHER_TURN)], proofs: [previewProof(), liveProof()] });
    assert.equal(v.detail, '2 traces, 2 proofs');
  });
});

describe('scorecard condition 19 — end to end through the real condition', () => {
  const condition = CONDITIONS.find((c) => c.id === 'trace_write_join');
  assert.ok(condition, 'trace_write_join condition must exist');

  it('FAILs on preview-proof-only evidence (the audit reproduction)', () => {
    const obs = { trace: evaluateTraceWriteJoin({ traces: [traceOn(TURN)], proofs: [previewProof()] }) };
    assert.equal(condition.evaluate(obs).status, FAIL);
  });

  it('PASSes on a live proof joined to its trace', () => {
    const obs = { trace: evaluateTraceWriteJoin({ traces: [traceOn(TURN)], proofs: [previewProof(), liveProof()] }) };
    const r = condition.evaluate(obs);
    assert.equal(r.status, PASS);
    assert.match(r.detail, new RegExp(TURN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
