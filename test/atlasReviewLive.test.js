'use strict';

// F09C — deterministic fixtures for scripts/atlas-review-live.js (READ-ONLY latest-live-test
// reviewer). Pure-function tests only: no Sheets client, no network. Proves newest-session
// selection, the Session_Plans/Effort joins, build-change detection, and — critically — that
// each trust criterion is PASS / FAIL / UNKNOWN with UNKNOWN meaning MISSING EVIDENCE, never a
// false green. Includes the v141-shaped failure (only server rows, unlinked).

const test = require('node:test');
const assert = require('node:assert/strict');

const rl = require('../scripts/atlas-review-live');

const DAY = '2026-07-16';
function at(min) { return `${DAY}T18:${String(min).padStart(2, '0')}:00.000Z`; }

// A full Flight_Recorder record with blank defaults; override what a case needs.
function fe(over = {}) {
  return Object.assign({
    captured_at: at(0), flight_session_id: 'FR-A', seq: 0, app_version: 'v143', device_id: 'dev-1',
    route: 'logger', event_type: 'user_action', user_input: '', user_action: '',
    ui_snapshot_json: '', session_state_json: '', api_endpoint: '', request_summary: '',
    response_summary: '', decision_summary_json: '', shadow_refs_json: '', error: '', latency_ms: ''
  }, over);
}

function corpora(over = {}) {
  return Object.assign({
    Flight_Recorder: [], Brain_Shadow: [], Intent_Shadow: [], Log_Cleaned: [],
    Bug_Reports: [], Session_Plans: [], Effort: []
  }, over);
}

function verdictOf(review, id) {
  const c = (review.criteria || []).find(x => x.id === id);
  return c ? c.verdict : undefined;
}

// A healthy, fully-captured session: client events + linked server rows + confirm that
// matches the logged rows + a set-level plan + effort + a verified write.
function healthyCorpora() {
  const S = 'FR-HEALTHY';
  return corpora({
    Flight_Recorder: [
      fe({ flight_session_id: S, seq: 1, captured_at: at(1), event_type: 'screen_rendered' }),
      fe({ flight_session_id: S, seq: 2, captured_at: at(2), event_type: 'user_input', user_input: 'bench 225 5/2' }),
      fe({ flight_session_id: S, seq: 3, captured_at: at(3), event_type: 'card_rendered', ui_snapshot_json: JSON.stringify({ visible_cards: ['preview'] }) }),
      fe({ flight_session_id: S, seq: 4, captured_at: at(4), event_type: 'session_state_changed', session_state_json: JSON.stringify({ pending_set_count: 3 }) }),
      fe({ flight_session_id: S, seq: 5, captured_at: at(5), event_type: 'api_response', api_endpoint: 'POST /api/log-workout', response_summary: '200 OK', latency_ms: 120 }),
      fe({ flight_session_id: S, seq: 6, captured_at: at(6), event_type: 'coach_message_rendered', ui_snapshot_json: JSON.stringify({ coach_message: 'Logged 3 sets of Bench Press.' }) })
    ],
    Log_Cleaned: [
      { session_id: 'W1', date_clean: DAY, exercise: 'Bench Press', set_number: '1', weight: '225', reps: '5', rir: '2' },
      { session_id: 'W1', date_clean: DAY, exercise: 'Bench Press', set_number: '2', weight: '225', reps: '5', rir: '2' },
      { session_id: 'W1', date_clean: DAY, exercise: 'Bench Press', set_number: '3', weight: '225', reps: '5', rir: '2' }
    ],
    Effort: [{ session_id: 'W1', date: DAY, duration: '45', active_calories: '300' }],
    Session_Plans: [{ session_id: 'W1', session_date: DAY, planned_lift_code: 'BEN01', target_weight: '225', target_reps: '5', target_rir: '2' }]
  });
}

test('healthy session (post-F10D shape: sealed ledger + finalized closeout) → every trust criterion PASS, overall PASS', () => {
  // F10D: overall PASS now requires the seal criterion too — the fully-healthy
  // corpus is the post-enablement shape. The pre-enablement (tab absent) shape is
  // covered below and is UNKNOWN overall, never a false PASS.
  const review = rl.reviewCorpora(sealedHealthyCorpora(), { now: at(9) });
  assert.equal(review.session.flight_session_id, 'FR-HEALTHY');
  assert.equal(review.session.mode, 'linked');
  assert.equal(verdictOf(review, 'client_replay'), 'PASS');
  assert.equal(verdictOf(review, 'session_linkage'), 'PASS');
  assert.equal(verdictOf(review, 'no_server_errors'), 'PASS');
  assert.equal(verdictOf(review, 'confirm_matches_actual'), 'PASS');
  assert.equal(verdictOf(review, 'plan_captured'), 'PASS');
  assert.equal(verdictOf(review, 'write_verified'), 'PASS');
  assert.equal(verdictOf(review, 'ledger_sealed'), 'PASS');
  assert.equal(review.overall, 'PASS');
});

test('v141 shape (only unlinked server rows) → client_replay FAIL, linkage FAIL, overall FAIL (never a false green)', () => {
  const c = corpora({
    Flight_Recorder: [
      // Server api_response rows with BLANK flight_session_id (unlinked) — no client events.
      fe({ flight_session_id: '', seq: '', app_version: 'v141', captured_at: at(1), event_type: 'api_response', api_endpoint: 'POST /api/coach/message', response_summary: '200 OK' }),
      fe({ flight_session_id: '', seq: '', app_version: 'v141', captured_at: at(2), event_type: 'api_response', api_endpoint: 'POST /api/log-workout', response_summary: '200 OK' })
    ]
  });
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(review.session.mode, 'server-only');
  assert.equal(verdictOf(review, 'client_replay'), 'FAIL');
  assert.equal(verdictOf(review, 'session_linkage'), 'FAIL');
  assert.equal(review.overall, 'FAIL');
});

test('a coaching-notes 503 during the session → no_server_errors FAIL', () => {
  const c = healthyCorpora();
  c.Flight_Recorder.push(fe({ flight_session_id: 'FR-HEALTHY', seq: 7, captured_at: at(7), event_type: 'api_response', api_endpoint: 'POST /api/coaching-notes', response_summary: '503 Service Unavailable' }));
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'no_server_errors'), 'FAIL');
  assert.equal(review.overall, 'FAIL');
});

test('rejected preview (no write, no log rows) → write_verified UNKNOWN (not FAIL), overall not PASS', () => {
  const S = 'FR-REJECT';
  const c = corpora({
    Flight_Recorder: [
      fe({ flight_session_id: S, seq: 1, captured_at: at(1), event_type: 'user_input', user_input: 'bench 225 5/2' }),
      fe({ flight_session_id: S, seq: 2, captured_at: at(2), event_type: 'card_rendered', ui_snapshot_json: JSON.stringify({ visible_cards: ['review'] }) }),
      fe({ flight_session_id: S, seq: 3, captured_at: at(3), event_type: 'api_response', api_endpoint: 'POST /api/log-workout', response_summary: '200 OK', request_summary: '{test_mode} dry-run' })
    ]
    // No Log_Cleaned rows → nothing was written (owner rejected the preview).
  });
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'client_replay'), 'PASS');
  assert.equal(verdictOf(review, 'write_verified'), 'UNKNOWN');
  assert.notEqual(review.overall, 'PASS', 'missing write evidence keeps overall away from a false PASS');
});

test('no Session_Plans rows → plan_captured UNKNOWN (missing evidence, not a false pass or fail)', () => {
  const c = healthyCorpora();
  c.Session_Plans = [];
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'plan_captured'), 'UNKNOWN');
  const planCrit = review.criteria.find(x => x.id === 'plan_captured');
  assert.equal(planCrit.missing, true);
});

test('Session_Plans rows without set-level targets → plan_captured UNKNOWN (F10A gap surfaced honestly)', () => {
  const c = healthyCorpora();
  // Header-only Session_Plans (no target weight/reps/rir) — the finding-#8 shape.
  c.Session_Plans = [{ session_id: 'W1', session_date: DAY, planned_lift_code: 'BEN01', event_type: 'plan_accepted', closeout_status: '' }];
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'plan_captured'), 'UNKNOWN');
});

test('newest session is selected by time; older ones are counted, not reviewed', () => {
  const c = corpora({
    Flight_Recorder: [
      fe({ flight_session_id: 'FR-OLD', seq: 1, captured_at: '2026-07-15T18:00:00.000Z', event_type: 'user_input', user_input: 'old' }),
      fe({ flight_session_id: 'FR-NEW', seq: 1, captured_at: at(1), event_type: 'user_input', user_input: 'new' })
    ]
  });
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(review.session.flight_session_id, 'FR-NEW');
  assert.equal(review.other_session_count, 1);
});

test('P1: the NEWEST session wins even when it is only unlinked server rows and OLDER linked sessions exist', () => {
  // The exact v141 shape in a cumulative tab: an older HEALTHY linked session plus a newer
  // BROKEN session that recorded only unlinked server rows. The review must pick the newest
  // (broken) one — never silently review the older good session and report a false green.
  const c = corpora({
    Flight_Recorder: [
      fe({ flight_session_id: 'FR-OLDGOOD', seq: 1, captured_at: '2026-07-14T18:00:00.000Z', event_type: 'user_input', user_input: 'old good' }),
      fe({ flight_session_id: 'FR-OLDGOOD', seq: 2, captured_at: '2026-07-14T18:01:00.000Z', event_type: 'api_response', api_endpoint: 'POST /api/log-workout', response_summary: '200 OK' }),
      fe({ flight_session_id: '', seq: '', app_version: 'v141', captured_at: at(1), event_type: 'api_response', api_endpoint: 'POST /api/log-workout', response_summary: '200 OK' }),
      fe({ flight_session_id: '', seq: '', app_version: 'v141', captured_at: at(2), event_type: 'api_response', api_endpoint: 'POST /api/coach/message', response_summary: '200 OK' })
    ]
  });
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(review.session.mode, 'server-only', 'reviews the NEWEST (broken) session, not the older linked one');
  assert.equal(verdictOf(review, 'client_replay'), 'FAIL');
  assert.equal(review.overall, 'FAIL');
  assert.equal(review.other_session_count, 1, 'the older linked session is counted, not reviewed');
});

test('clusterUnlinked splits unlinked rows into distinct sessions on a time gap', () => {
  const rows = [
    fe({ flight_session_id: '', captured_at: '2026-07-14T18:00:00.000Z', event_type: 'api_response' }),
    fe({ flight_session_id: '', captured_at: '2026-07-14T18:05:00.000Z', event_type: 'api_response' }),
    // > 30-min gap → a new cluster.
    fe({ flight_session_id: '', captured_at: '2026-07-16T18:00:00.000Z', event_type: 'api_response' })
  ];
  const clusters = rl.clusterUnlinked(rows);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].events.length, 2);
  assert.equal(clusters[1].events.length, 1);
});

test('--session selects a specific session; a missing one is reported, not faked', () => {
  const c = corpora({
    Flight_Recorder: [
      fe({ flight_session_id: 'FR-OLD', seq: 1, captured_at: '2026-07-15T18:00:00.000Z', event_type: 'user_input', user_input: 'old' }),
      fe({ flight_session_id: 'FR-NEW', seq: 1, captured_at: at(1), event_type: 'user_input', user_input: 'new' })
    ]
  });
  assert.equal(rl.reviewCorpora(c, { session: 'FR-OLD' }).session.flight_session_id, 'FR-OLD');
  const missing = rl.reviewCorpora(c, { session: 'FR-NOPE' });
  assert.equal(missing.session, null);
  assert.equal(missing.overall, 'UNKNOWN');
});

test('build change within a session is detected (the split-build caveat)', () => {
  const S = 'FR-SPLIT';
  const c = corpora({
    Flight_Recorder: [
      fe({ flight_session_id: S, seq: 1, captured_at: at(1), app_version: 'v141', event_type: 'user_input', user_input: 'a' }),
      fe({ flight_session_id: S, seq: 2, captured_at: at(2), app_version: 'v143', event_type: 'user_input', user_input: 'b' })
    ]
  });
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(review.build_change.detected, true);
  assert.deepEqual(review.build_change.versions, ['v141', 'v143']);
});

test('empty corpora → no session, overall UNKNOWN, never throws', () => {
  const review = rl.reviewCorpora(corpora(), { now: at(9) });
  assert.equal(review.session, null);
  assert.equal(review.overall, 'UNKNOWN');
});

test('renderHuman is TOTAL and leaks no raw workout content', () => {
  const out = rl.renderHuman(rl.reviewCorpora(healthyCorpora(), { now: at(9) }));
  assert.match(out, /Overall:/);
  assert.match(out, /Trust criteria:/);
  // The human summary reports counts + endpoints, never a raw logged weight like "225 5/2".
  assert.doesNotMatch(out, /225 5\/2/);
});

test('correlateSidecar matches by session_id then by date', () => {
  const rows = [
    { session_id: 'W1', session_date: '2099-01-01' },
    { session_id: 'ZZ', session_date: DAY },
    { session_id: 'ZZ', session_date: '1999-01-01' }
  ];
  const matched = rl.correlateSidecar(rows, new Set(['w1']), new Set([DAY]));
  assert.equal(matched.length, 2);
  assert.equal(matched[0].match, 'session_id');
  assert.equal(matched[1].match, 'date');
});

test('planRowHasSetTarget is true only with a set-level prescription', () => {
  assert.equal(rl.planRowHasSetTarget({ target_weight: '225' }), true);
  assert.equal(rl.planRowHasSetTarget({ target_reps: '5' }), true);
  assert.equal(rl.planRowHasSetTarget({ planned_lift_code: 'BEN01', closeout_status: 'finalized' }), false);
  assert.equal(rl.planRowHasSetTarget({}), false);
});

// ── F10D — the Session_Plan_Sets seal criterion ─────────────────────────────────
// PASS only for one-id fully-sealed valid history agreeing with the finalized
// closeout; unreadable/absent evidence is UNKNOWN (never inferred); pre-closeout
// unsealed checkpoints are UNKNOWN; every mixed/conflicting/partial/malformed/
// disagreeing state is FAIL with exact evidence.

function ledgerRow(over = {}) {
  return Object.assign({
    idempotency_key: 'k', session_id: 'W1', session_date: DAY, plan_version: '1',
    plan_item_id: 'pi_b', planned_lift_code: 'BEN01', set_index: '1', target_set_count: '3',
    target_weight: '225', target_reps: '5', target_rir: '2', recommendation_source: 'accepted',
    supersedes_key: '', confidence: 'reliable', closeout_write_id: 'wr_20260716_1',
    recorded_at: at(0), _row: 2
  }, over);
}

function sealedLedger() {
  return [
    ledgerRow({ idempotency_key: 'k1', set_index: '1', _row: 2 }),
    ledgerRow({ idempotency_key: 'k2', set_index: '2', _row: 3 }),
    ledgerRow({ idempotency_key: 'k3', set_index: '3', _row: 4 }),
  ];
}

function finalizedEventRow() {
  return { session_id: 'W1', session_date: DAY, event_type: 'session_closeout', closeout_status: 'finalized' };
}

function sealedHealthyCorpora() {
  const c = healthyCorpora();
  c.Session_Plans.push(finalizedEventRow());
  c.Session_Plan_Sets = sealedLedger();
  return c;
}

test('F10D seal: fully sealed one-id ledger matching the finalized closeout → PASS with evidence range; overall PASS', () => {
  const review = rl.reviewCorpora(sealedHealthyCorpora(), { now: at(9) });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'PASS');
  const c = review.criteria.find(x => x.id === 'ledger_sealed');
  assert.match(c.detail, /All 3 of 3 correlated ledger row\(s\) sealed under one closeout_write_id/);
  assert.match(c.detail, /Session_Plan_Sets!A2:P4/, 'the exact evidence range is included');
  assert.equal(review.session.ledger_rows, 3);
  assert.equal(review.overall, 'PASS');
});

test('F10D seal: tab absent/unreadable → UNKNOWN (never inferred), explicitly the pre-enablement state', () => {
  const review = rl.reviewCorpora(healthyCorpora(), { now: at(9) });  // no Session_Plan_Sets key
  assert.equal(verdictOf(review, 'ledger_sealed'), 'UNKNOWN');
  const c = review.criteria.find(x => x.id === 'ledger_sealed');
  assert.equal(c.missing, true);
  assert.match(c.detail, /absent or unreadable/);
  assert.match(c.detail, /never inferred/);
  assert.equal(review.overall, 'UNKNOWN', 'a healthy pre-enablement session is UNKNOWN overall — not a false PASS');
});

test('F10D seal: rowCounts readability signal wins — an unreadable tab with an empty corpus stays UNKNOWN', () => {
  const c = healthyCorpora();
  c.Session_Plan_Sets = [];
  const review = rl.reviewCorpora(c, { now: at(9), rowCounts: { Session_Plan_Sets: null } });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'UNKNOWN');
  assert.match(review.criteria.find(x => x.id === 'ledger_sealed').detail, /absent or unreadable/);
});

test('F10D seal: readable tab, zero correlated rows → UNKNOWN (freestyle / pre-F10D history), not FAIL', () => {
  const c = healthyCorpora();
  c.Session_Plan_Sets = [];
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'UNKNOWN');
  assert.match(review.criteria.find(x => x.id === 'ledger_sealed').detail, /No Session_Plan_Sets rows correlate/);
});

test('F10D seal: unsealed checkpoint rows with NO finalized closeout → UNKNOWN pre-closeout state, not a failure', () => {
  const c = healthyCorpora();
  c.Session_Plan_Sets = sealedLedger().map(r => Object.assign(r, { closeout_write_id: '' }));
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'UNKNOWN');
  assert.match(review.criteria.find(x => x.id === 'ledger_sealed').detail, /pre-closeout state/);
});

test('F10D seal: finalized closeout but ZERO sealed rows → FAIL (the tabs disagree)', () => {
  const c = healthyCorpora();
  c.Session_Plans.push(finalizedEventRow());
  c.Session_Plan_Sets = sealedLedger().map(r => Object.assign(r, { closeout_write_id: '' }));
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'FAIL');
  assert.match(review.criteria.find(x => x.id === 'ledger_sealed').detail, /finalized closeout but ZERO/);
  assert.equal(review.overall, 'FAIL');
});

test('F10D seal: partially sealed rows → FAIL naming the unsealed sheet rows', () => {
  const c = sealedHealthyCorpora();
  c.Session_Plan_Sets[2].closeout_write_id = '';
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'FAIL');
  const d = review.criteria.find(x => x.id === 'ledger_sealed').detail;
  assert.match(d, /Partially sealed: 2 of 3/);
  assert.match(d, /row 4/);
});

test('F10D seal: conflicting closeout_write_ids → FAIL', () => {
  const c = sealedHealthyCorpora();
  c.Session_Plan_Sets[1].closeout_write_id = 'wr_DIFFERENT_9';
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'FAIL');
  assert.match(review.criteria.find(x => x.id === 'ledger_sealed').detail, /Conflicting closeout_write_ids/);
});

test('F10D seal: sealed ledger with NO finalized Session_Plans closeout → FAIL (the tabs disagree)', () => {
  const c = healthyCorpora();           // no finalized event pushed
  c.Session_Plan_Sets = sealedLedger();
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'FAIL');
  assert.match(review.criteria.find(x => x.id === 'ledger_sealed').detail, /no finalized Session_Plans closeout/);
});

test('F10D seal: malformed revision chain (v2 with no supersedes) → FAIL with the diagnostic', () => {
  const c = sealedHealthyCorpora();
  c.Session_Plan_Sets.push(ledgerRow({
    idempotency_key: 'k4', set_index: '2', plan_version: '2', recommendation_source: 'live_revision',
    supersedes_key: '', target_weight: '215', _row: 5
  }));
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'FAIL');
  assert.match(review.criteria.find(x => x.id === 'ledger_sealed').detail, /Malformed revision chain/);
});

test('F10D seal: correlated rows spanning two workout session_ids → FAIL on identity disagreement', () => {
  const c = sealedHealthyCorpora();
  c.Session_Plan_Sets.push(ledgerRow({ idempotency_key: 'k9', session_id: 'W2', session_date: DAY, _row: 9 }));
  const review = rl.reviewCorpora(c, { now: at(9) });
  assert.equal(verdictOf(review, 'ledger_sealed'), 'FAIL');
  assert.match(review.criteria.find(x => x.id === 'ledger_sealed').detail, /session_ids/);
});
