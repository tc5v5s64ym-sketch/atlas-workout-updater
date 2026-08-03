'use strict';

// Durable-session mode for scripts/atlas-review-live.js — the F-SB4B truthful-
// adjudicator completion (F-SB4A precedent). When the caller names an exact workout
// identity and the Flight Recorder holds NO session, the review adjudicates the four
// durable tabs directly instead of returning an empty UNKNOWN with zero criteria.
// These tests prove both directions: a fully-evidenced durable session earns PASS
// through the declared criteria set, and every guard against a silent or dishonest
// entry into the mode holds — auto-selection never enters it, a --session request
// for a missing transcript never enters it, a transcript-bearing corpus never enters
// it, and missing durable evidence stays UNKNOWN, never PASS.

const test = require('node:test');
const assert = require('node:assert/strict');

const rl = require('../scripts/atlas-review-live');

const DAY = '2026-08-03';
const WID = '20260803-AM-01';
function at(min) { return `${DAY}T18:${String(min).padStart(2, '0')}:00.000Z`; }

function corpora(over = {}) {
  return Object.assign({
    Flight_Recorder: [], Brain_Shadow: [], Intent_Shadow: [], Log_Cleaned: [],
    Bug_Reports: [], Session_Plans: [], Effort: []
  }, over);
}

function ledgerRow(over = {}) {
  return Object.assign({
    idempotency_key: 'k', session_id: WID, session_date: DAY, plan_version: '1',
    plan_item_id: 'pi_b', planned_lift_code: 'BEN01', set_index: '1', target_set_count: '2',
    target_weight: '225', target_reps: '5', target_rir: '2', recommendation_source: 'accepted',
    supersedes_key: '', confidence: 'reliable', closeout_write_id: 'wr_20260803_1',
    recorded_at: at(0), _row: 2
  }, over);
}

// The rehearsal-shaped durable evidence: log rows, effort, plan events with a
// finalized closeout, and a fully sealed one-id ledger. NO Flight Recorder rows.
function durableCorpora() {
  return corpora({
    Log_Cleaned: [
      { session_id: WID, date_clean: DAY, exercise: 'Back Squat', set_number: '1', weight: '225', reps: '5', rir: '2' },
      { session_id: WID, date_clean: DAY, exercise: 'Back Squat', set_number: '2', weight: '225', reps: '5', rir: '2' }
    ],
    Effort: [{ session_id: WID, date: DAY, duration: '52:10', active_calories: '412' }],
    Session_Plans: [
      { session_id: WID, session_date: DAY, event_type: 'plan_accepted', plan_item_id: 'pi_b', planned_lift_code: 'BEN01' },
      { session_id: WID, session_date: DAY, event_type: 'session_closeout', closeout_status: 'finalized' }
    ],
    Session_Plan_Sets: [
      ledgerRow({ idempotency_key: 'k1', set_index: '1', _row: 2 }),
      ledgerRow({ idempotency_key: 'k2', set_index: '2', _row: 3 })
    ]
  });
}

function verdictOf(review, id) {
  const c = (review.criteria || []).find(x => x.id === id);
  return c ? c.verdict : undefined;
}

test('durable-session: explicit id + empty recorder + full durable evidence → overall PASS through the declared set', () => {
  const review = rl.reviewCorpora(durableCorpora(), { now: at(9), workoutSessionIds: [WID] });
  assert.equal(review.session.mode, 'durable-session');
  assert.equal(review.session.flight_session_id, null);
  assert.deepEqual(review.session.workout_session_ids, [WID]);
  assert.equal(verdictOf(review, 'correlation_identity'), 'PASS');
  assert.equal(verdictOf(review, 'durable_rows_attributed'), 'PASS');
  assert.equal(verdictOf(review, 'plan_captured'), 'PASS');
  assert.equal(verdictOf(review, 'ledger_sealed'), 'PASS');
  assert.equal(review.criteria.length, 4, 'the declared durable criteria set is exactly four');
  assert.equal(review.overall, 'PASS');
  assert.equal(review.log_correlation.basis, 'explicit_session_id');
  assert.deepEqual(review.log_correlation.distinct_session_ids, [WID]);
  assert.equal(review.session.log_rows, 2);
  assert.equal(review.session.effort_rows, 1);
  assert.equal(review.session.ledger_rows, 2);
});

test('durable-session: the out-of-scope transcript criteria are DECLARED, not silently dropped', () => {
  const review = rl.reviewCorpora(durableCorpora(), { now: at(9), workoutSessionIds: [WID] });
  assert.deepEqual(review.out_of_scope,
    ['client_replay', 'session_linkage', 'no_server_errors', 'confirm_matches_actual', 'write_verified']);
  for (const id of review.out_of_scope) {
    assert.equal(verdictOf(review, id), undefined, `${id} must not appear as a hidden verdict`);
  }
});

test('durable-session: no durable rows at all → UNKNOWN, never PASS', () => {
  const review = rl.reviewCorpora(corpora({ Session_Plan_Sets: [] }), { now: at(9), workoutSessionIds: [WID] });
  assert.equal(review.session.mode, 'durable-session');
  assert.equal(verdictOf(review, 'correlation_identity'), 'UNKNOWN');
  assert.equal(verdictOf(review, 'durable_rows_attributed'), 'UNKNOWN');
  assert.equal(review.overall, 'UNKNOWN');
});

test('durable-session: rows for a DIFFERENT identity never attach — exact id only, no date fallback', () => {
  const c = durableCorpora();
  for (const tab of ['Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets']) {
    for (const r of c[tab]) r.session_id = '20260803-PM-09';
  }
  const review = rl.reviewCorpora(c, { now: at(9), workoutSessionIds: [WID] });
  assert.equal(review.session.log_rows, 0);
  assert.equal(review.session.ledger_rows, 0);
  assert.equal(review.overall, 'UNKNOWN', 'same-date rows under another identity must not vouch for this one');
});

test('durable-session: a seal defect propagates as FAIL (the same fail-closed evaluator)', () => {
  const c = durableCorpora();
  c.Session_Plan_Sets[1].closeout_write_id = '';  // partially sealed
  const review = rl.reviewCorpora(c, { now: at(9), workoutSessionIds: [WID] });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'FAIL');
  assert.equal(review.overall, 'FAIL');
});

test('durable-session: unreadable ledger tab stays UNKNOWN (never inferred)', () => {
  const c = durableCorpora();
  delete c.Session_Plan_Sets;
  const review = rl.reviewCorpora(c, { now: at(9), workoutSessionIds: [WID] });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'UNKNOWN');
  assert.equal(review.overall, 'UNKNOWN');
});

test('guard: auto-selection with no explicit id keeps the empty-recorder UNKNOWN result unchanged', () => {
  const review = rl.reviewCorpora(durableCorpora(), { now: at(9) });
  assert.equal(review.session, null);
  assert.equal(review.overall, 'UNKNOWN');
  assert.equal(review.criteria.length, 0);
  assert.match(review.reason, /no Flight Recorder sessions found/);
});

test('guard: --session requesting a missing transcript never mode-switches, even with a workout id', () => {
  const review = rl.reviewCorpora(durableCorpora(), { now: at(9), session: 'FR-NOPE', workoutSessionIds: [WID] });
  assert.equal(review.session, null);
  assert.equal(review.overall, 'UNKNOWN');
  assert.match(review.reason, /requested session FR-NOPE not found/);
});

test('guard: a corpus WITH Flight Recorder sessions keeps the transcript-first mode', () => {
  const c = durableCorpora();
  c.Flight_Recorder = [{
    captured_at: at(1), flight_session_id: 'FR-A', seq: 1, app_version: 'v146', device_id: 'd',
    route: 'logger', event_type: 'user_input', user_input: 'squat 225 x 5', user_action: '',
    ui_snapshot_json: '', session_state_json: '', api_endpoint: '', request_summary: '',
    response_summary: '', decision_summary_json: '', shadow_refs_json: '', error: '', latency_ms: ''
  }];
  const review = rl.reviewCorpora(c, { now: at(9), workoutSessionIds: [WID] });
  assert.notEqual(review.session.mode, 'durable-session');
  assert.equal(review.session.flight_session_id, 'FR-A');
});

test('text and JSON agree: renderHuman names the mode, the identity, and the declared scope', () => {
  const review = rl.reviewCorpora(durableCorpora(), { now: at(9), workoutSessionIds: [WID] });
  const out = rl.renderHuman(review);
  assert.match(out, /durable-session — no Flight Recorder transcript/);
  assert.ok(out.includes(WID));
  assert.match(out, /transcript criteria out of scope in this mode: client_replay/);
  assert.match(out, /Overall:\s+✅ PASS/);
  assert.match(out, /UNKNOWN = missing evidence, never a pass/);
});
