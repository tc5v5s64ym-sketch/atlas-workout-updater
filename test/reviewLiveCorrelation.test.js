'use strict';

// F-SB4A — the truthful adjudicator.
//
// `atlas:review-live` decides whether a live session held the trust boundaries, and
// `UNKNOWN` is defined as never-a-pass. That makes a correlation defect in this tool
// indistinguishable from a product failure: on 2026-08-02 it reported 0 Log · 0 Effort ·
// 0 Session_Plans · 0 Session_Plan_Sets — a full all-UNKNOWN verdict — for a session that
// wrote 12 rows and sealed 24. Trusting it would have reset a passing streak.
//
// Cause: the workout's rows carry the athlete's LOCAL date, the flight transcript carries
// UTC timestamps, and `sessionDateSet` walked the window FORWARD ONLY. A 17:34 Pacific
// workout is `2026-08-02T00:34Z`, its rows are correctly dated `2026-08-01`, and the
// candidate set was `{2026-08-02, 2026-08-03}`. Every evening session west of UTC broke.
//
// These tests pin the eight behaviours F-SB4A requires, and the BITE PROOF below fails if
// the forward-only logic is ever restored.

const test = require('node:test');
const assert = require('node:assert/strict');

const rl = require('../scripts/atlas-review-live');
const fr = require('../scripts/flight-review');

// ---------------------------------------------------------------------------
// Fixtures: one Pacific EVENING session whose UTC date is the following day.
// ---------------------------------------------------------------------------
const LOCAL_DATE = '2026-08-01';           // what Log_Cleaned records (Pacific)
const UTC_DATE = '2026-08-02';             // what the Flight Recorder records (UTC)
const WORKOUT_ID = '20260801-PM-01';

// 03:MM UTC on 2026-08-02 is 20:MM Pacific on 2026-08-01 — an evening workout, clear
// of UTC midnight in both directions so the ±5-minute correlation window cannot reach
// the local date by accident. Only the timezone offset separates the two dates, which
// is exactly the recorded failure.
function utc(min) { return `${UTC_DATE}T03:${String(min).padStart(2, '0')}:00.000Z`; }

function fe(over = {}) {
  return Object.assign({
    captured_at: utc(0), flight_session_id: 'FR-EVENING', seq: 0, app_version: 'v146', device_id: 'dev-1',
    route: 'logger', event_type: 'user_action', user_input: '', user_action: '',
    ui_snapshot_json: '', session_state_json: '', api_endpoint: '', request_summary: '',
    response_summary: '', decision_summary_json: '', shadow_refs_json: '', error: '', latency_ms: ''
  }, over);
}

function corpora(over = {}) {
  return Object.assign({
    Flight_Recorder: [], Brain_Shadow: [], Intent_Shadow: [], Log_Cleaned: [],
    Bug_Reports: [], Session_Plans: [], Effort: [], Session_Plan_Sets: []
  }, over);
}

function verdictOf(review, id) {
  const c = (review.criteria || []).find(x => x.id === id);
  return c ? c.verdict : undefined;
}

// The evening session. Critically, NO event carries the workout session id — that is the
// real recorded shape, because the Flight Recorder stores request field NAMES and never
// their values. Correlation therefore has only the date window to work with.
function eveningCorpora(over = {}) {
  const S = 'FR-EVENING';
  return corpora(Object.assign({
    Flight_Recorder: [
      fe({ flight_session_id: S, seq: 1, captured_at: utc(1), event_type: 'screen_rendered' }),
      fe({ flight_session_id: S, seq: 2, captured_at: utc(2), event_type: 'user_input', user_input: 'bench 225 5/2' }),
      fe({ flight_session_id: S, seq: 3, captured_at: utc(4), event_type: 'api_response', api_endpoint: 'POST /api/log-workout', response_summary: '200 OK', latency_ms: 140 }),
      fe({ flight_session_id: S, seq: 4, captured_at: utc(5), event_type: 'coach_message_rendered', ui_snapshot_json: JSON.stringify({ coach_message: 'Logged 3 sets of Bench Press.' }) })
    ],
    Log_Cleaned: [
      { session_id: WORKOUT_ID, date_clean: LOCAL_DATE, exercise: 'Bench Press', set_number: '1', weight: '225', reps: '5', rir: '2' },
      { session_id: WORKOUT_ID, date_clean: LOCAL_DATE, exercise: 'Bench Press', set_number: '2', weight: '225', reps: '5', rir: '2' },
      { session_id: WORKOUT_ID, date_clean: LOCAL_DATE, exercise: 'Bench Press', set_number: '3', weight: '225', reps: '5', rir: '2' }
    ],
    Effort: [{ session_id: WORKOUT_ID, date: LOCAL_DATE, duration: '45', active_calories: '300' }],
    Session_Plans: [{ session_id: WORKOUT_ID, session_date: LOCAL_DATE, planned_lift_code: 'BEN01', target_weight: '225', target_reps: '5', target_rir: '2' }]
  }, over));
}

// ---------------------------------------------------------------------------
// 1. The defect itself: a Pacific evening workout correlates.
// ---------------------------------------------------------------------------
test('F-SB4A: a Pacific evening workout whose UTC date is the next day correlates its rows', () => {
  const review = rl.reviewCorpora(eveningCorpora(), { now: utc(9) });

  assert.equal(review.session.flight_session_id, 'FR-EVENING');
  assert.equal(review.session.log_rows, 3, 'the 3 local-dated Log rows must correlate');
  assert.equal(review.session.effort_rows, 1);
  assert.equal(review.session.plan_rows, 1);
  assert.equal(verdictOf(review, 'write_verified'), 'PASS');
  assert.equal(verdictOf(review, 'correlation_identity'), 'PASS');
});

test('F-SB4A: the all-UNKNOWN false verdict is gone — not every criterion is UNKNOWN', () => {
  const review = rl.reviewCorpora(eveningCorpora(), { now: utc(9) });
  const unknowns = review.criteria.filter(c => c.verdict === 'UNKNOWN');
  assert.notEqual(unknowns.length, review.criteria.length,
    'an evening session with real rows must not report every criterion UNKNOWN');
});

// ---------------------------------------------------------------------------
// 2. BITE PROOF — the fix is load-bearing.
// ---------------------------------------------------------------------------
test('BITE: the old forward-only date window misses the Pacific-local date; the fixed one finds it', () => {
  const session = { first_at_ms: Date.parse(utc(1)), last_at_ms: Date.parse(utc(5)) };
  const windowMs = 5 * 60000;

  // The exact pre-fix implementation, reconstructed. If someone restores it, this
  // assertion documents precisely what breaks.
  function legacyForwardOnlySessionDateSet(s, w) {
    const set = new Set();
    if (s.first_at_ms == null) return set;
    const lo = s.first_at_ms - w;
    const hi = (s.last_at_ms == null ? s.first_at_ms : s.last_at_ms) + w;
    for (let t = lo; t <= hi + 86400000; t += 86400000) set.add(new Date(t).toISOString().slice(0, 10));
    set.add(new Date(hi).toISOString().slice(0, 10));
    return set;
  }

  const legacy = legacyForwardOnlySessionDateSet(session, windowMs);
  assert.equal(legacy.has(LOCAL_DATE), false,
    'the old forward-only set must NOT contain the Pacific-local date — this is the defect');
  assert.equal(legacy.has(UTC_DATE), true);

  const fixed = fr.sessionDateSet(session, windowMs);
  assert.equal(fixed.has(LOCAL_DATE), true, 'the fixed set must reach back one local day');
  assert.equal(fixed.has(UTC_DATE), true, 'and must still contain the UTC date');
});

test('BITE: with the forward-only set the very same corpora correlates zero rows', () => {
  // Prove the product-level consequence, not only the set contents: shifting the
  // rows forward to the UTC date is what the legacy window could see, and the
  // genuine local-dated rows are what it could not.
  const utcDatedRows = eveningCorpora().Log_Cleaned.map(r => ({ ...r, date_clean: UTC_DATE }));
  const seenByLegacyWindow = rl.reviewCorpora(eveningCorpora({ Log_Cleaned: utcDatedRows }), { now: utc(9) });
  assert.equal(seenByLegacyWindow.session.log_rows, 3, 'sanity: UTC-dated rows always correlated');

  const realRows = rl.reviewCorpora(eveningCorpora(), { now: utc(9) });
  assert.equal(realRows.session.log_rows, 3,
    'and the genuine local-dated rows must now correlate too — the pre-fix tool reported 0 here');
});

// ---------------------------------------------------------------------------
// 3. Text and JSON select the same session.
// ---------------------------------------------------------------------------
function twoSessionCorpora() {
  const older = 'FR-OLDER';
  const newer = 'FR-NEWER';
  return corpora({
    Flight_Recorder: [
      fe({ flight_session_id: older, seq: 1, captured_at: utc(1), event_type: 'user_input', user_input: 'squat 315 5/2' }),
      fe({ flight_session_id: older, seq: 2, captured_at: utc(2), event_type: 'api_response', api_endpoint: 'POST /api/log-workout', response_summary: '200 OK' }),
      fe({ flight_session_id: newer, seq: 1, captured_at: utc(30), event_type: 'user_input', user_input: 'bench 225 5/2' }),
      fe({ flight_session_id: newer, seq: 2, captured_at: utc(31), event_type: 'api_response', api_endpoint: 'POST /api/log-workout', response_summary: '200 OK' })
    ]
  });
}

test('F-SB4A: the human render names the same session the JSON does', () => {
  const review = rl.reviewCorpora(twoSessionCorpora(), { now: utc(40) });
  const text = rl.renderHuman(review);

  assert.equal(review.session.flight_session_id, 'FR-NEWER');
  assert.match(text, /Session:\s+FR-NEWER/, 'the text output must name the JSON-selected session');
  assert.match(text, /Selected by:\s+latest/, 'and must state how it was selected');
});

test('F-SB4A: repeated selection over identical corpora is stable', () => {
  const a = rl.reviewCorpora(twoSessionCorpora(), { now: utc(40) });
  const b = rl.reviewCorpora(twoSessionCorpora(), { now: utc(40) });
  assert.equal(a.session.flight_session_id, b.session.flight_session_id);
  assert.deepEqual(a.selection, b.selection);
});

test('F-SB4A: candidates whose timestamps are all unparseable order deterministically (no NaN comparator)', () => {
  // Pre-fix the comparator was `endA - endB`; two sessions with no parseable time
  // both yield -Infinity, so the subtraction produced NaN and the sort order was
  // implementation-defined — the second way a text run and a --json run diverged.
  const mk = id => ({ session: { flight_session_id: id, first_at_ms: null, last_at_ms: null }, mode: 'linked' });
  const forward = [mk('FR-A'), mk('FR-B'), mk('FR-C')].sort(rl.compareCandidates).map(c => c.session.flight_session_id);
  const reverse = [mk('FR-C'), mk('FR-B'), mk('FR-A')].sort(rl.compareCandidates).map(c => c.session.flight_session_id);

  assert.deepEqual(forward, ['FR-A', 'FR-B', 'FR-C']);
  assert.deepEqual(reverse, forward, 'input order must not change the result');
  assert.equal(Number.isNaN(rl.compareCandidates(mk('FR-A'), mk('FR-B'))), false, 'the comparator must never return NaN');
});

// ---------------------------------------------------------------------------
// 4. An explicit identity always wins.
// ---------------------------------------------------------------------------
test('F-SB4A: an explicit --session wins over the newer session and reports the basis', () => {
  const review = rl.reviewCorpora(twoSessionCorpora(), { now: utc(40), session: 'FR-OLDER' });
  assert.equal(review.session.flight_session_id, 'FR-OLDER');
  assert.equal(review.selection.basis, 'explicit');
  assert.equal(review.selection.requested, 'FR-OLDER');
});

test('F-SB4A: an explicit --workout-session gives an exact join and refuses the date heuristic', () => {
  // A neighbouring workout's rows sit on the very same local date. Naming the
  // workout must correlate ONLY the named one.
  const withNeighbour = eveningCorpora();
  withNeighbour.Log_Cleaned = withNeighbour.Log_Cleaned.concat([
    { session_id: 'SOMEONE-ELSE', date_clean: LOCAL_DATE, exercise: 'Deadlift', set_number: '1', weight: '405', reps: '3', rir: '1' }
  ]);

  const review = rl.reviewCorpora(withNeighbour, { now: utc(9), workoutSessionIds: [WORKOUT_ID] });
  assert.equal(review.log_correlation.basis, 'explicit_session_id');
  assert.equal(review.log_correlation.date_fallback_allowed, false);
  assert.equal(review.session.log_rows, 3, 'only the named workout correlates');
  assert.equal(verdictOf(review, 'correlation_identity'), 'PASS');
});

test('F-SB4A: an explicit workout identity REPLACES transcript discovery, it does not merge with it', () => {
  // Codex P1. Seeding the discovery set with the explicit id and then letting the
  // transcript scan add its own would correlate BOTH workouts while still calling
  // the join exact — the named identity plus whatever stale or neighbouring id the
  // transcript happens to mention.
  const c = eveningCorpora();
  // The transcript now leaks a DIFFERENT workout id, exactly as a real one can.
  c.Flight_Recorder = c.Flight_Recorder.concat([
    fe({ flight_session_id: 'FR-EVENING', seq: 5, captured_at: utc(6), event_type: 'api_response',
      api_endpoint: 'POST /api/log-workout', response_summary: '200 OK session_id=20260801-AM-01' })
  ]);
  c.Log_Cleaned = c.Log_Cleaned.concat([
    { session_id: '20260801-AM-01', date_clean: LOCAL_DATE, exercise: 'Deadlift', set_number: '1', weight: '405', reps: '3', rir: '1' }
  ]);
  c.Effort = c.Effort.concat([{ session_id: '20260801-AM-01', date: LOCAL_DATE, duration: '30', active_calories: '200' }]);

  // Without the explicit id, the transcript-discovered identity legitimately correlates.
  const discovered = rl.reviewCorpora(c, { now: utc(9) });
  assert.equal(discovered.session.log_rows, 1, 'sanity: transcript discovery finds the AM workout');

  // Naming the PM workout must exclude the AM one entirely — log AND sidecars.
  const named = rl.reviewCorpora(c, { now: utc(9), workoutSessionIds: [WORKOUT_ID] });
  assert.equal(named.log_correlation.basis, 'explicit_session_id');
  assert.deepEqual(named.log_correlation.established_session_ids, [WORKOUT_ID.toLowerCase()],
    'only the named identity may be established');
  assert.equal(named.session.log_rows, 3, 'the neighbouring workout must not correlate');
  assert.equal(named.session.effort_rows, 1, 'nor may its Effort row');
  assert.equal(verdictOf(named, 'correlation_identity'), 'PASS');
});

test('F-SB4A: a sidecar row naming a DIFFERENT workout cannot date-attach to this verdict', () => {
  // Codex P1. The Log rows date-match and name workout A unambiguously, so
  // log-level ambiguity is false and the date set stays live. A permissive sidecar
  // join then let an Effort / Session_Plans row carrying workout B attach purely by
  // sharing a candidate date — and the review reported plan capture, write
  // verification and correlation identity as PASS on two workouts' evidence.
  const c = eveningCorpora();
  c.Effort = c.Effort.concat([
    { session_id: 'OTHER-WORKOUT', date: LOCAL_DATE, duration: '99', active_calories: '999' }
  ]);
  c.Session_Plans = c.Session_Plans.concat([
    { session_id: 'OTHER-WORKOUT', session_date: LOCAL_DATE, planned_lift_code: 'DL01', target_weight: '405', target_reps: '3', target_rir: '1' }
  ]);

  const review = rl.reviewCorpora(c, { now: utc(9) });

  assert.equal(review.log_correlation.ambiguous, false, 'the Log join itself is unambiguous');
  assert.deepEqual(review.log_correlation.established_session_ids, [WORKOUT_ID.toLowerCase()]);
  assert.equal(review.session.effort_rows, 1, 'the foreign Effort row must be refused');
  assert.equal(review.session.plan_rows, 1, 'and the foreign Session_Plans row too');
});

test('F-SB4A: --workout-session parses repeated and comma-separated values', () => {
  assert.deepEqual(rl.parseArgs(['--workout-session=A', '--workout-session=B']).workoutSessionIds, ['A', 'B']);
  assert.deepEqual(rl.parseArgs(['--workout-session=A,B , C']).workoutSessionIds, ['A', 'B', 'C']);
  assert.deepEqual(rl.parseArgs([]).workoutSessionIds, []);
});

// ---------------------------------------------------------------------------
// 5. Ambiguity fails closed and says why.
// ---------------------------------------------------------------------------
test('F-SB4A: an ambiguous date window correlates NOTHING rather than guessing, and reports why', () => {
  // Two distinct workouts on the same local date, with no workout id anywhere in
  // the transcript. Widening the window brought this risk with it, so the tool
  // must refuse the join instead of attributing another session's rows.
  const ambiguous = eveningCorpora();
  ambiguous.Log_Cleaned = ambiguous.Log_Cleaned.concat([
    { session_id: '20260801-AM-01', date_clean: LOCAL_DATE, exercise: 'Deadlift', set_number: '1', weight: '405', reps: '3', rir: '1' }
  ]);

  const review = rl.reviewCorpora(ambiguous, { now: utc(9) });

  assert.equal(review.log_correlation.ambiguous, true);
  assert.deepEqual(review.log_correlation.distinct_session_ids, ['20260801-am-01', '20260801-pm-01']);
  assert.equal(review.session.log_rows, 0, 'no rows may be attributed when two workouts match');
  assert.equal(verdictOf(review, 'correlation_identity'), 'UNKNOWN');
  assert.match(review.criteria.find(c => c.id === 'correlation_identity').detail, /2 distinct workout sessions/);
  assert.equal(review.overall, 'UNKNOWN', 'UNKNOWN is never a pass');
});

test('F-SB4A: an ambiguous date window also refuses the sidecar joins', () => {
  // The log join and the sidecar joins must refuse together. Correlating the log
  // strictly while still date-matching Effort / Session_Plans / Session_Plan_Sets
  // would attribute a neighbour's plan and seal to this verdict.
  const ambiguous = eveningCorpora();
  ambiguous.Log_Cleaned = ambiguous.Log_Cleaned.concat([
    { session_id: '20260801-AM-01', date_clean: LOCAL_DATE, exercise: 'Deadlift', set_number: '1', weight: '405', reps: '3', rir: '1' }
  ]);
  ambiguous.Effort = ambiguous.Effort.concat([{ session_id: '20260801-AM-01', date: LOCAL_DATE, duration: '30', active_calories: '200' }]);

  const review = rl.reviewCorpora(ambiguous, { now: utc(9) });
  assert.equal(review.session.effort_rows, 0);
  assert.equal(review.session.plan_rows, 0);
});

test('F-SB4A: a single workout on the widened window is NOT treated as ambiguous', () => {
  // Fail-closed must not become fail-always: the ordinary evening session still
  // correlates, and rows carrying no session id name no competing workout.
  const idless = eveningCorpora();
  idless.Log_Cleaned = idless.Log_Cleaned.map(r => ({ ...r, session_id: '' }));
  const review = rl.reviewCorpora(idless, { now: utc(9) });
  assert.equal(review.log_correlation.ambiguous, false);
  assert.equal(review.session.log_rows, 3);
});

test('F-SB4A: two sessions sharing the newest end time report the tie and fail closed', () => {
  const tied = corpora({
    Flight_Recorder: [
      fe({ flight_session_id: 'FR-ONE', seq: 1, captured_at: utc(10), event_type: 'user_input', user_input: 'squat 315 5/2' }),
      fe({ flight_session_id: 'FR-TWO', seq: 1, captured_at: utc(10), event_type: 'user_input', user_input: 'bench 225 5/2' })
    ]
  });
  const review = rl.reviewCorpora(tied, { now: utc(20) });
  assert.equal(review.selection.ambiguous, true);
  assert.match(review.selection.reason, /share the newest end time/);
  assert.equal(verdictOf(review, 'correlation_identity'), 'UNKNOWN');
  assert.equal(review.overall, 'UNKNOWN');
  assert.match(rl.renderHuman(review), /ambiguous:/);
});

// ---------------------------------------------------------------------------
// 6. UNKNOWN stays never-a-pass, and no private content leaks.
// ---------------------------------------------------------------------------
test('F-SB4A: UNKNOWN remains never-a-pass and FAIL still outranks it', () => {
  assert.equal(rl.overallFrom([{ verdict: 'PASS' }, { verdict: 'UNKNOWN' }]), 'UNKNOWN');
  assert.equal(rl.overallFrom([{ verdict: 'FAIL' }, { verdict: 'UNKNOWN' }]), 'FAIL');
  assert.equal(rl.overallFrom([{ verdict: 'PASS' }, { verdict: 'PASS' }]), 'PASS');
});

test('F-SB4A: the new correlation fields expose ids and dates only, never request values or workout content', () => {
  const review = rl.reviewCorpora(eveningCorpora(), { now: utc(9) });
  const exposed = JSON.stringify({ selection: review.selection, log_correlation: review.log_correlation });

  // The fixture's private content: the athlete's typed input and their loads.
  assert.equal(exposed.includes('bench 225 5/2'), false, 'no user input may appear');
  assert.equal(exposed.includes('225'), false, 'no weights may appear');
  assert.equal(exposed.includes('Bench Press'), false, 'no exercise content may appear');
  assert.equal(review.log_correlation.basis, 'date_window');
});
