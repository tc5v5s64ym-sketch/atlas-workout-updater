'use strict';

// Unit coverage for scripts/flight-review.js — the READ-ONLY test-evidence
// extractor. Pure-function tests only: no Sheets client, no network, no live app.
// Proves session grouping, cross-tab correlation (shadow lanes by time window;
// logs by workout session_id then date), and each of the six anomaly detectors,
// plus that the header-aware parser survives column-order drift and missing
// headers. Nothing here writes to a sheet or exercises the IO shell.

const test = require('node:test');
const assert = require('node:assert/strict');

const fr = require('../scripts/flight-review');

const WINDOW = { windowMs: 5 * 60000, now: '2026-07-06T00:00:00.000Z', source: 'test' };

function iso(min, sec = 0) {
  return new Date(Date.UTC(2026, 6, 6, 12, min, sec)).toISOString();
}

function emptyCorpora(over = {}) {
  return Object.assign({
    Flight_Recorder: [], Brain_Shadow: [], Intent_Shadow: [], Log_Cleaned: [], Bug_Reports: []
  }, over);
}

test('rowsToRecords: uses the sheet header when present (survives column reorder)', () => {
  // A real header is full-width; reorder two columns to prove the header — not
  // positional fallback — drives the mapping.
  const header = fr.KNOWN_COLUMNS.Flight_Recorder.slice();
  [header[6], header[7]] = [header[7], header[6]]; // swap event_type <-> user_input
  const dataRow = fr.KNOWN_COLUMNS.Flight_Recorder.map(() => '');
  dataRow[0] = '2026-07-06T12:00:00Z';
  dataRow[1] = 'sess-1';
  dataRow[6] = 'hello';        // now the user_input slot
  dataRow[7] = 'user_input';   // now the event_type slot
  const recs = fr.rowsToRecords([header, dataRow], fr.KNOWN_COLUMNS.Flight_Recorder);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].flight_session_id, 'sess-1');
  assert.equal(recs[0].user_input, 'hello');
  assert.equal(recs[0].event_type, 'user_input');
});

test('rowsToRecords: falls back to known columns positionally when no header', () => {
  const rows = [['2026-07-06T12:00:00Z', 'sess-1', '3', 'v1', 'dev', 'home', 'user_input']];
  const recs = fr.rowsToRecords(rows, fr.KNOWN_COLUMNS.Flight_Recorder);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].flight_session_id, 'sess-1');
  assert.equal(recs[0].route, 'home');
  assert.equal(recs[0].event_type, 'user_input');
});

test('extractStatusCode / statusClass', () => {
  assert.equal(fr.extractStatusCode('500 Internal'), 500);
  assert.equal(fr.extractStatusCode('{status:409}'), 409);
  assert.equal(fr.extractStatusCode('ok'), null);
  assert.equal(fr.statusClass(503), '5xx');
  assert.equal(fr.statusClass(404), '4xx');
  assert.equal(fr.statusClass(200), '2xx');
});

test('deepCollectSessionIds: walks JSON and free text, excludes the flight id', () => {
  const out = new Set();
  fr.deepCollectSessionIds({ activePlannedSession: { session_id: '20260706-PM-01' }, note: 'see 20260706-PM-02' }, 'flight-x', out, 0);
  assert.ok(out.has('20260706-PM-01'));
  assert.ok(out.has('20260706-PM-02'));
});

test('groupBySession: groups, orders by seq, buckets missing ids', () => {
  const flight = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Flight_Recorder,
    [iso(1), 'S1', '2', '', '', 'home', 'user_action'],
    [iso(0), 'S1', '1', '', '', 'home', 'screen_rendered'],
    [iso(2), '', '1', '', '', 'home', 'error']
  ], fr.KNOWN_COLUMNS.Flight_Recorder);
  const { sessions, noSession } = fr.groupBySession(flight);
  assert.equal(sessions.length, 1);
  assert.equal(noSession.length, 1);
  assert.equal(sessions[0].events[0].seq, '1'); // ordered by seq
});

test('correlateByTime: shadow entries inside the window only', () => {
  const session = { first_at_ms: Date.parse(iso(10)), last_at_ms: Date.parse(iso(20)) };
  const shadow = [
    { captured_at: iso(9) },   // 1 min before → inside ±5
    { captured_at: iso(15) },  // inside
    { captured_at: iso(40) }   // way after → excluded
  ];
  const near = fr.correlateByTime(session, shadow, WINDOW.windowMs);
  assert.equal(near.length, 2);
});

test('correlateLogs: session_id match beats date fallback and both are tagged', () => {
  const session = { first_at_ms: Date.parse(iso(0)), last_at_ms: Date.parse(iso(5)) };
  const logs = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Log_Cleaned,
    ['2026-07-06', '20260706-PM-01', 'Bench', 'Bench', 'chest', 'BENCH', '1', '225', '5', '2', '', '1125'],
    ['2026-07-06', '20260706-PM-09', 'Squat', 'Squat', 'legs', 'SQUAT', '1', '315', '5', '2', '', '1575']
  ], fr.KNOWN_COLUMNS.Log_Cleaned);
  const ids = new Set(['20260706-PM-01']);
  const dateSet = fr.sessionDateSet(session, WINDOW.windowMs);
  const out = fr.correlateLogs(session, logs, ids, dateSet);
  const byMatch = out.reduce((m, x) => { m[x.match] = (m[x.match] || 0) + 1; return m; }, {});
  assert.equal(byMatch.session_id, 1);
  assert.equal(byMatch.date_window, 1); // the other row still matches on date
});

test('anomaly: 4xx/5xx responses flagged', () => {
  const flight = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Flight_Recorder,
    // captured_at, sid, seq, ver, dev, route, type, uin, uact, ui, sess, endpoint, req, resp, dec, shadow, error, latency
    [iso(0), 'S1', '1', '', '', 'home', 'api_response', '', '', '', '', 'POST /api/log-workout', '', '500 err', '', '', '', '120']
  ], fr.KNOWN_COLUMNS.Flight_Recorder);
  const { sessions } = fr.groupBySession(flight);
  const ev = fr.buildSessionEvidence(sessions[0], emptyCorpora(), WINDOW);
  assert.ok(ev.anomalies.some(a => a.type === 'http_error_response' && a.severity === 'error'));
});

test('anomaly: coach not answering a question', () => {
  const flight = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Flight_Recorder,
    [iso(0), 'S1', '1', '', '', 'coach', 'user_input', 'What should I do for chest today?', '', '', '', '', '', '', '', '', '', ''],
    [iso(1), 'S1', '2', '', '', 'coach', 'coach_message_rendered', '', '', JSON.stringify({ coach_message: "Ready when you are — tap a card." }), '', '', '', '', '', '', '', '']
  ], fr.KNOWN_COLUMNS.Flight_Recorder);
  const { sessions } = fr.groupBySession(flight);
  const ev = fr.buildSessionEvidence(sessions[0], emptyCorpora(), WINDOW);
  assert.ok(ev.anomalies.some(a => a.type === 'coach_not_answering'));
});

test('anomaly: repeated idle coach messages', () => {
  const idle = JSON.stringify({ coach_message: 'Standing by — let me know.' });
  const flight = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Flight_Recorder,
    [iso(0), 'S1', '1', '', '', 'home', 'coach_message_rendered', '', '', idle, '', '', '', '', '', '', '', ''],
    [iso(1), 'S1', '2', '', '', 'home', 'coach_message_rendered', '', '', idle, '', '', '', '', '', '', '', '']
  ], fr.KNOWN_COLUMNS.Flight_Recorder);
  const { sessions } = fr.groupBySession(flight);
  const ev = fr.buildSessionEvidence(sessions[0], emptyCorpora(), WINDOW);
  assert.ok(ev.anomalies.some(a => a.type === 'repeated_idle_coach_messages'));
});

test('anomaly: repeated completed exercise (duplicate logged set)', () => {
  const flight = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Flight_Recorder,
    [iso(0), 'S1', '1', '', '', 'home', 'session_state_changed', '', '', '', JSON.stringify({ session_id: '20260706-PM-01' }), '', '', '', '', '', '', '']
  ], fr.KNOWN_COLUMNS.Flight_Recorder);
  const logs = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Log_Cleaned,
    ['2026-07-06', '20260706-PM-01', 'Bench', 'Bench', 'chest', 'BENCH', '1', '225', '5', '2', '', '1125'],
    ['2026-07-06', '20260706-PM-01', 'Bench', 'Bench', 'chest', 'BENCH', '1', '225', '5', '2', '', '1125']
  ], fr.KNOWN_COLUMNS.Log_Cleaned);
  const { sessions } = fr.groupBySession(flight);
  const ev = fr.buildSessionEvidence(sessions[0], emptyCorpora({ Log_Cleaned: logs }), WINDOW);
  assert.ok(ev.anomalies.some(a => a.type === 'repeated_completed_exercise'));
});

test('anomaly: session confirm mismatch (claimed sets != logged rows)', () => {
  const confirm = JSON.stringify({ coach_message: 'Logged 5 sets — session saved.' });
  const flight = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Flight_Recorder,
    [iso(0), 'S1', '1', '', '', 'home', 'session_state_changed', '', '', '', JSON.stringify({ session_id: '20260706-PM-01' }), '', '', '', '', '', '', ''],
    [iso(1), 'S1', '2', '', '', 'home', 'coach_message_rendered', '', '', confirm, '', '', '', '', '', '', '', '']
  ], fr.KNOWN_COLUMNS.Flight_Recorder);
  const logs = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Log_Cleaned,
    ['2026-07-06', '20260706-PM-01', 'Bench', 'Bench', 'chest', 'BENCH', '1', '225', '5', '2', '', '1125']
  ], fr.KNOWN_COLUMNS.Log_Cleaned);
  const { sessions } = fr.groupBySession(flight);
  const ev = fr.buildSessionEvidence(sessions[0], emptyCorpora({ Log_Cleaned: logs }), WINDOW);
  assert.ok(ev.anomalies.some(a => a.type === 'session_confirm_mismatch'));
});

test('anomaly: missing session id on a write-path call', () => {
  const flight = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Flight_Recorder,
    [iso(0), 'S1', '1', '', '', 'home', 'api_response', '', '', '', '', 'POST /api/log-workout', '', '200 ok', '', '', '', '90']
  ], fr.KNOWN_COLUMNS.Flight_Recorder);
  const { sessions } = fr.groupBySession(flight);
  const ev = fr.buildSessionEvidence(sessions[0], emptyCorpora(), WINDOW);
  assert.ok(ev.anomalies.some(a => a.type === 'missing_session_id'));
});

test('buildReport + renderMarkdown: end-to-end shape, brain/intent correlation, no throw', () => {
  const flight = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Flight_Recorder,
    [iso(0), 'S1', '1', '', '', 'coach', 'user_input', 'log 225 5/2 bench', '', '', JSON.stringify({ session_id: '20260706-PM-01' }), '', '', '', '', '', '', ''],
    [iso(1), 'S1', '2', '', '', 'coach', 'api_response', '', '', '', '', 'POST /api/log-workout', '', '200', '', '', '', '75']
  ], fr.KNOWN_COLUMNS.Flight_Recorder);
  const brain = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Brain_Shadow,
    [iso(1), 'coach', 'BENCH', 'hybrid', 'TRUE', '', 'set_recommendation', 'ok', 'high', 'FALSE', 'TRUE', 'FALSE', '', '', '40', '']
  ], fr.KNOWN_COLUMNS.Brain_Shadow);
  const intent = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Intent_Shadow,
    [iso(1), 'log 225 5/2 bench', 'log_intent', '0.98', '[]', '[]', 'TRUE', '30', 'chat', 'composer', '', '', '']
  ], fr.KNOWN_COLUMNS.Intent_Shadow);
  const logs = fr.rowsToRecords([
    fr.KNOWN_COLUMNS.Log_Cleaned,
    ['2026-07-06', '20260706-PM-01', 'Bench', 'Bench', 'chest', 'BENCH', '1', '225', '5', '2', '', '1125']
  ], fr.KNOWN_COLUMNS.Log_Cleaned);

  const corpora = emptyCorpora({ Flight_Recorder: flight, Brain_Shadow: brain, Intent_Shadow: intent, Log_Cleaned: logs });
  const report = fr.buildReport(corpora, Object.assign({ spreadsheetId: 'TEST', rowCounts: {} }, WINDOW));
  assert.equal(report.session_count, 1);
  assert.equal(report.read_only, true);
  const s = report.sessions[0];
  assert.equal(s.brain_shadow_near.length, 1);
  assert.equal(s.intent_shadow_near.length, 1);
  assert.equal(s.workout_rows_written.length, 1);
  assert.equal(s.workout_rows_written[0].match, 'session_id');
  const md = fr.renderMarkdown(report);
  assert.match(md, /Atlas Flight Review/);
  assert.match(md, /Session `S1`/);
});
