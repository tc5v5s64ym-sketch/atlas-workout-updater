'use strict';

// Atlas Flight Recorder — PR-FR1 unit coverage for the PURE core of
// services/flightRecorder (docs/FLIGHT_RECORDER_SPEC.md). Proves the row builder maps
// to the column contract position-by-position, that secrets are redacted and oversized
// payloads truncated before they can become a row, that the flag gate is default-OFF,
// that the capped ring is newest-first, and that every public function is TOTAL (never
// throws on junk). Pure module test — no app boot, no network, no Sheets (this PR wires
// nothing to a runtime path).

const test = require('node:test');
const assert = require('node:assert/strict');

const flightRecorder = require('../services/flightRecorder');
const { flightRecorderColumns } = require('../config/columns');
const { optionalSheetTabs } = require('../config/sheetContract');

// Column indices (kept in sync with flightRecorderColumns) for readable assertions.
const COL = flightRecorderColumns.reduce((acc, name, i) => { acc[name] = i; return acc; }, {});

function reset() { flightRecorder._resetForTesting(); }

function baseEvent(overrides = {}) {
  return {
    captured_at: '2026-07-05T12:00:00.000Z',
    flight_session_id: 'FR-2026-07-05-abc123',
    seq: 7,
    app_version: 'v107',
    device_id: 'dev-xyz',
    route: 'logger',
    event_type: 'api_response',
    api_endpoint: 'POST /api/coach/chat',
    latency_ms: 812,
    ...overrides
  };
}

test('contract: builder emits exactly one cell per column, in order', () => {
  const row = flightRecorder.buildFlightRow(baseEvent());
  assert.equal(row.length, flightRecorderColumns.length, 'row width matches the column contract');
  assert.equal(row.length, 18, 'the MVP schema is 18 columns');
});

test('Flight_Recorder is declared as an OPTIONAL tab (never required)', () => {
  assert.ok(optionalSheetTabs.includes('Flight_Recorder'));
  assert.equal(flightRecorder.FLIGHT_RECORDER_TAB, 'Flight_Recorder');
});

test('buildFlightRow maps scalar + JSON fields to the right positions', () => {
  const row = flightRecorder.buildFlightRow(baseEvent({
    user_input: 'skip leg extension',
    user_action: 'tap: Preview',
    ui_snapshot: { active_card: 'coach_pick', visible_tiles: ['streak'], toast: null },
    session_state: { activePlannedSession: { index: 2 }, sessionCompleted: false },
    request_summary: 'POST /api/coach/chat {message}',
    response_summary: '200 { reply, plan_edit }',
    decision_summary: { decision_type: 'modify_workout', confidence_tier: 'high' },
    shadow_refs: { intent: { created: true, route: 'composer', count: 1 } },
    error: ''
  }));

  assert.equal(row[COL.captured_at], '2026-07-05T12:00:00.000Z');
  assert.equal(row[COL.flight_session_id], 'FR-2026-07-05-abc123');
  assert.equal(row[COL.seq], 7);
  assert.equal(row[COL.app_version], 'v107');
  assert.equal(row[COL.device_id], 'dev-xyz');
  assert.equal(row[COL.route], 'logger');
  assert.equal(row[COL.event_type], 'api_response');
  assert.equal(row[COL.user_input], 'skip leg extension');
  assert.equal(row[COL.user_action], 'tap: Preview');
  assert.equal(row[COL.api_endpoint], 'POST /api/coach/chat');
  assert.equal(row[COL.request_summary], 'POST /api/coach/chat {message}');
  assert.equal(row[COL.response_summary], '200 { reply, plan_edit }');
  assert.equal(row[COL.latency_ms], 812);

  // JSON-in-cells columns round-trip to the source objects.
  assert.deepEqual(JSON.parse(row[COL.ui_snapshot_json]), { active_card: 'coach_pick', visible_tiles: ['streak'], toast: null });
  assert.deepEqual(JSON.parse(row[COL.session_state_json]), { activePlannedSession: { index: 2 }, sessionCompleted: false });
  assert.deepEqual(JSON.parse(row[COL.decision_summary_json]), { decision_type: 'modify_workout', confidence_tier: 'high' });
  assert.deepEqual(JSON.parse(row[COL.shadow_refs_json]), { intent: { created: true, route: 'composer', count: 1 } });
});

test('missing fields become blank cells, never a crash', () => {
  const row = flightRecorder.buildFlightRow({ event_type: 'screen_rendered', route: 'home' });
  assert.equal(row.length, 18);
  assert.equal(row[COL.event_type], 'screen_rendered');
  assert.equal(row[COL.route], 'home');
  assert.equal(row[COL.user_input], '');
  assert.equal(row[COL.ui_snapshot_json], '');       // absent object → blank
  assert.equal(row[COL.session_state_json], '');
  assert.equal(row[COL.seq], '');                     // absent number → blank
  assert.equal(row[COL.latency_ms], '');
});

test('empty objects/arrays serialize to blank, not "{}"/"[]"', () => {
  const row = flightRecorder.buildFlightRow(baseEvent({ ui_snapshot: {}, shadow_refs: {} }));
  assert.equal(row[COL.ui_snapshot_json], '');
  assert.equal(row[COL.shadow_refs_json], '');
});

test('non-finite numbers become blank cells (never NaN/Infinity)', () => {
  assert.equal(flightRecorder.buildFlightRow(baseEvent({ seq: NaN }))[COL.seq], '');
  assert.equal(flightRecorder.buildFlightRow(baseEvent({ latency_ms: Infinity }))[COL.latency_ms], '');
  assert.equal(flightRecorder.buildFlightRow(baseEvent({ seq: '7' }))[COL.seq], '', 'string seq is not a number → blank');
});

test('REDACTION: secret-shaped values are scrubbed before they become a row', () => {
  const row = flightRecorder.buildFlightRow(baseEvent({
    user_input: 'my key is sk-proj-ABCDEFGH12345678 and AIzaABCDEFGH12345678',
    request_summary: 'Authorization: Bearer abcdef012345.token.value',
    ui_snapshot: { note: 'sk-proj-ABCDEFGH12345678' }
  }));
  assert.ok(!/sk-proj-ABCDEFGH12345678/.test(row[COL.user_input]), 'openai key scrubbed');
  assert.ok(!/AIzaABCDEFGH12345678/.test(row[COL.user_input]), 'gemini key scrubbed');
  assert.ok(row[COL.user_input].includes('[REDACTED]'));
  assert.ok(!/Bearer abcdef012345/.test(row[COL.request_summary]), 'bearer token scrubbed');
  assert.ok(!/sk-proj-ABCDEFGH12345678/.test(row[COL.ui_snapshot_json]), 'secret in a nested JSON cell scrubbed too');
});

test('REDACTION: secret-shaped KEYS are dropped from JSON cells', () => {
  const row = flightRecorder.buildFlightRow(baseEvent({
    session_state: { api_key: 'super-secret', authorization: 'Bearer zzz', activePlannedSession: { index: 1 } }
  }));
  const parsed = JSON.parse(row[COL.session_state_json]);
  assert.equal(parsed.api_key, '[REDACTED]');
  assert.equal(parsed.authorization, '[REDACTED]');
  assert.deepEqual(parsed.activePlannedSession, { index: 1 }, 'non-secret state survives');
});

test('TRUNCATION: an oversized JSON cell is capped well under the Sheets per-cell limit', () => {
  // Many moderate keys: the payload stays large AFTER redaction (each value is under the
  // redactor's own per-string cap), so it exercises the JSON-cell cap, not the inner one.
  const huge = {};
  for (let i = 0; i < 80; i++) huge['k' + i] = 'x'.repeat(500);
  const row = flightRecorder.buildFlightRow(baseEvent({ ui_snapshot: huge }));
  assert.ok(row[COL.ui_snapshot_json].length <= flightRecorder.MAX_CELL_CHARS + 20, 'capped near MAX_CELL_CHARS');
  assert.ok(row[COL.ui_snapshot_json].endsWith('...[truncated]'));
});

test('TRUNCATION: an oversized scalar text field is capped', () => {
  const row = flightRecorder.buildFlightRow(baseEvent({ user_input: 'y'.repeat(9000) }));
  assert.ok(row[COL.user_input].length < 9000);
  assert.ok(row[COL.user_input].endsWith('...[truncated]'));
});

test('buildFlightRows preserves order and skips non-object entries', () => {
  const rows = flightRecorder.buildFlightRows([
    baseEvent({ seq: 1 }),
    null,
    'garbage',
    baseEvent({ seq: 2 })
  ]);
  assert.equal(rows.length, 2, 'junk entries dropped, never a throw');
  assert.equal(rows[0][COL.seq], 1);
  assert.equal(rows[1][COL.seq], 2);
});

test('flag gate: default OFF; reflects ATLAS_FLIGHT_RECORDER truthy values', () => {
  const original = process.env.ATLAS_FLIGHT_RECORDER;
  try {
    delete process.env.ATLAS_FLIGHT_RECORDER;
    assert.equal(flightRecorder.isFlightRecorderEnabled(), false, 'default OFF');
    for (const on of ['1', 'true', 'on']) {
      process.env.ATLAS_FLIGHT_RECORDER = on;
      assert.equal(flightRecorder.isFlightRecorderEnabled(), true, `enabled for ${on}`);
    }
    process.env.ATLAS_FLIGHT_RECORDER = '0';
    assert.equal(flightRecorder.isFlightRecorderEnabled(), false);
    process.env.ATLAS_FLIGHT_RECORDER = 'yes';
    assert.equal(flightRecorder.isFlightRecorderEnabled(), false, 'only 1/true/on count');
  } finally {
    if (original === undefined) delete process.env.ATLAS_FLIGHT_RECORDER;
    else process.env.ATLAS_FLIGHT_RECORDER = original;
  }
});

test('taxonomy: the 10 event types are exposed and recognized', () => {
  assert.equal(flightRecorder.EVENT_TYPES.length, 10);
  for (const t of ['screen_rendered', 'user_input', 'user_action', 'api_request', 'api_response',
    'coach_message_rendered', 'card_rendered', 'session_state_changed', 'error', 'bug_marker']) {
    assert.ok(flightRecorder.isKnownEventType(t), `${t} is a known event type`);
  }
  assert.equal(flightRecorder.isKnownEventType('not_a_type'), false);
});

test('ring: records newest-first and is capped at RING_MAX', () => {
  reset();
  for (let i = 0; i < flightRecorder.RING_MAX + 15; i++) {
    flightRecorder.recordEvent(baseEvent({ seq: i, event_type: 'user_action' }));
  }
  const log = flightRecorder.getFlightRecorderLog();
  assert.equal(log.count, flightRecorder.RING_MAX);
  assert.equal(log.entries.length, flightRecorder.RING_MAX);
  assert.equal(log.entries[0].seq, flightRecorder.RING_MAX + 14, 'newest first');
});

test('recordEvent stores a REDACTED copy and ignores junk', () => {
  reset();
  assert.equal(flightRecorder.recordEvent(null), undefined);
  assert.equal(flightRecorder.recordEvent('nope'), undefined);
  const stored = flightRecorder.recordEvent(baseEvent({ user_input: 'sk-proj-ABCDEFGH12345678' }));
  assert.ok(stored, 'a valid event is stored');
  assert.ok(!/sk-proj-ABCDEFGH12345678/.test(JSON.stringify(stored)), 'stored copy is redacted');
  assert.equal(flightRecorder.getFlightRecorderLog().count, 1);
});

test('getFlightRecorderLog aggregates counts by type and errors', () => {
  reset();
  flightRecorder.recordEvent(baseEvent({ event_type: 'api_response' }));
  flightRecorder.recordEvent(baseEvent({ event_type: 'api_response' }));
  flightRecorder.recordEvent(baseEvent({ event_type: 'error', error: 'boom' }));
  const { aggregates } = flightRecorder.getFlightRecorderLog();
  assert.equal(aggregates.total, 3);
  assert.equal(aggregates.by_type.api_response, 2);
  assert.equal(aggregates.by_type.error, 1);
  assert.equal(aggregates.errors, 1);
});

test('TOTAL: builder never throws on hostile input (circular refs, weird types)', () => {
  const circular = baseEvent();
  circular.ui_snapshot = {};
  circular.ui_snapshot.self = circular.ui_snapshot; // circular
  assert.doesNotThrow(() => flightRecorder.buildFlightRow(circular));
  assert.doesNotThrow(() => flightRecorder.buildFlightRow(undefined));
  assert.doesNotThrow(() => flightRecorder.buildFlightRow(42));
  assert.doesNotThrow(() => flightRecorder.buildFlightRow([]));
});
