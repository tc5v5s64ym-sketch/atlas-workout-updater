'use strict';

// Atlas Flight Recorder — PR-FR3 coverage: the client batch INGEST handler
// (services/flightRecorder.recordClientBatch) and the pure helpers of the self-contained
// client capture module (public/flightRecorder.js). Proves flag-off = zero writes, that a
// batch appends to Flight_Recorder ONLY in one call, sandbox/production isolation for
// sim-marked batches, redaction, the per-batch cap, and that the client builder/redactor/
// flush-trigger behave. No browser/DOM needed — the client file's DOM wiring only runs in a
// real browser; its pure helpers are exported for tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const flightRecorder = require('../services/flightRecorder');
const client = require('../public/flightRecorder');

const FLAG = 'ATLAS_FLIGHT_RECORDER';
const originalLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => { console.log = originalLog; });

function withFlag(value, fn) {
  const original = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try { return fn(); }
  finally {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  }
}

function setup() {
  const appended = [];
  flightRecorder._resetForTesting({ append: async (tab, rows) => { appended.push({ tab, rows }); } });
  return appended;
}
function tick() { return new Promise(r => setImmediate(r)); }

function batch(n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({ captured_at: '2026-07-05T12:00:0' + (i % 10) + '.000Z', seq: i, event_type: 'user_action', user_action: 'tap ' + i, route: 'logger' });
  }
  return { flight_session_id: 'FR-abc', device_id: 'dev-1', app_version: 'v108', events };
}

// ── recordClientBatch (server ingest handler) ──────────────────────────────────────

test('flag OFF → recordClientBatch writes NOTHING (disabled-flag proof)', async () => {
  const appended = setup();
  const r = withFlag(undefined, () => flightRecorder.recordClientBatch(batch(3), { sheetIsSandbox: true }));
  assert.deepEqual(r, { enabled: false, written: 0 });
  await tick();
  assert.equal(appended.length, 0);
});

test('flag ON → one append of the whole batch to Flight_Recorder ONLY', async () => {
  const appended = setup();
  const r = withFlag('1', () => flightRecorder.recordClientBatch(batch(3), { sheetIsSandbox: false }));
  assert.deepEqual(r, { enabled: true, written: 3 });
  await tick();
  assert.equal(appended.length, 1, 'one appendRows call for the whole batch');
  assert.equal(appended[0].tab, 'Flight_Recorder');
  assert.equal(appended[0].rows.length, 3);
  // Session fields applied to each row; event_type/action preserved.
  const row0 = appended[0].rows[0];
  assert.equal(row0[1], 'FR-abc');          // flight_session_id
  assert.equal(row0[3], 'v108');            // app_version
  assert.equal(row0[4], 'dev-1');           // device_id
  assert.equal(row0[6], 'user_action');     // event_type
  assert.ok(!['Log_Cleaned', 'Effort', 'Modality_Log'].includes(appended[0].tab));
});

test('ISOLATION: a sim-marked client batch is NEVER persisted to a non-sandbox sheet', async () => {
  const appended = setup();
  const r = withFlag('1', () => flightRecorder.recordClientBatch(batch(2), { sheetIsSandbox: false, isSimulation: true }));
  assert.equal(r.written, 0);
  assert.equal(r.isolated, true);
  await tick();
  assert.equal(appended.length, 0, 'sim batch never writes to a non-sandbox sheet');
  assert.equal(flightRecorder.getFlightRecorderLog().count, 2, 'but the events are still ringed');
});

test('ISOLATION: a sim-marked batch DOES persist when the server IS the sandbox sheet', async () => {
  const appended = setup();
  withFlag('1', () => flightRecorder.recordClientBatch(batch(2), { sheetIsSandbox: true, isSimulation: true }));
  await tick();
  assert.equal(appended.length, 1);
  assert.equal(appended[0].rows.length, 2);
});

test('per-batch cap: at most MAX_INGEST_EVENTS rows', async () => {
  const appended = setup();
  const r = withFlag('1', () => flightRecorder.recordClientBatch(batch(flightRecorder.MAX_INGEST_EVENTS + 50), { sheetIsSandbox: true }));
  assert.equal(r.written, flightRecorder.MAX_INGEST_EVENTS);
  await tick();
  assert.equal(appended[0].rows.length, flightRecorder.MAX_INGEST_EVENTS);
});

test('redaction: a secret in a client event is scrubbed server-side', async () => {
  const appended = setup();
  withFlag('1', () => flightRecorder.recordClientBatch({
    flight_session_id: 'FR-x',
    events: [{ event_type: 'user_input', user_input: 'my key AIzaABCDEFGH12345678', route: 'logger' }]
  }, { sheetIsSandbox: true }));
  await tick();
  const row = appended[0].rows[0];
  assert.ok(!/AIzaABCDEFGH12345678/.test(row[7]), 'secret scrubbed in user_input column');
});

test('TOTAL: malformed payloads never throw and write nothing', async () => {
  setup();
  withFlag('1', () => {
    assert.doesNotThrow(() => flightRecorder.recordClientBatch(null, {}));
    assert.doesNotThrow(() => flightRecorder.recordClientBatch('nope', {}));
    assert.doesNotThrow(() => flightRecorder.recordClientBatch({ events: 'x' }, {}));
    const r = flightRecorder.recordClientBatch({ events: [] }, { sheetIsSandbox: true });
    assert.equal(r.written, 0);
  });
});

// ── public/flightRecorder.js pure helpers ──────────────────────────────────────────

test('client redactString scrubs secret-shaped values', () => {
  assert.ok(client.redactString('sk-proj-ABCDEFGH12345678').includes('[REDACTED]'));
  assert.ok(client.redactString('AIzaABCDEFGH12345678').includes('[REDACTED]'));
  assert.ok(client.redactString('Bearer abcdef012345.tok.value').includes('[REDACTED]'));
  assert.equal(client.redactString(null), '');
  assert.equal(client.redactString('felt heavy today'), 'felt heavy today', 'non-secret text untouched');
});

test('client truncate caps long strings', () => {
  const out = client.truncate('y'.repeat(5000), 2000);
  assert.ok(out.length < 5000);
  assert.ok(out.endsWith('...[truncated]'));
});

test('client shouldFlush: at threshold, on error, on bug_marker', () => {
  assert.equal(client.shouldFlush(client.FLUSH_AT, 'user_action'), true);
  assert.equal(client.shouldFlush(client.FLUSH_AT - 1, 'user_action'), false);
  assert.equal(client.shouldFlush(0, 'error'), true);
  assert.equal(client.shouldFlush(0, 'bug_marker'), true);
  assert.equal(client.shouldFlush(1, 'screen_rendered'), false);
});

test('client buildClientEvent maps type/fields/ctx and redacts user_input', () => {
  const now = new Date('2026-07-05T12:00:00.000Z');
  const ev = client.buildClientEvent('user_input',
    { user_input: 'log it — token sk-proj-ABCDEFGH12345678', route: 'logger', ui_snapshot: { active_card: 'preview' } },
    { flightSessionId: 'FR-1', deviceId: 'dev-1', appVersion: 'v108', seq: 4, now });
  assert.equal(ev.captured_at, '2026-07-05T12:00:00.000Z');
  assert.equal(ev.flight_session_id, 'FR-1');
  assert.equal(ev.seq, 4);
  assert.equal(ev.event_type, 'user_input');
  assert.equal(ev.route, 'logger');
  assert.ok(ev.user_input.includes('[REDACTED]'), 'secret scrubbed client-side');
  assert.ok(!/sk-proj-ABCDEFGH12345678/.test(ev.user_input));
  assert.deepEqual(ev.ui_snapshot, { active_card: 'preview' });
});

test('client ATLAS_EVENT_MAP maps to valid taxonomy event types', () => {
  const valid = new Set(flightRecorder.EVENT_TYPES);
  for (const name of Object.keys(client.ATLAS_EVENT_MAP)) {
    assert.ok(valid.has(client.ATLAS_EVENT_MAP[name]), `${name} → a known event type`);
  }
});

// DOM wiring (review #857): the atlas:* events are dispatched on `document` with
// bubbles:false, so the recorder must subscribe on `document` — a window listener would
// silently never fire, killing card_rendered / coach_message_rendered / session_state_changed.
test('client subscribes to atlas:* events on document, not window', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'flightRecorder.js'), 'utf8');
  assert.match(src, /document\.addEventListener\(name,/, 'atlas:* events must be bound on document');
  assert.doesNotMatch(src, /window\.addEventListener\(name,/, 'must NOT bind atlas:* events on window (they would never fire)');
  // Corroborate the premise this fix rests on: every atlas:* dispatch is on document.
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(appSrc, /window\.dispatchEvent\(new CustomEvent\('atlas:/, 'atlas:* events are dispatched on document, not window');
});

// ── FR4: Settings → Debug UX ────────────────────────────────────────────────────────

test('FR4: markIssue / getSessionId are TOTAL and inert when the recorder is off', () => {
  // In node there is no active browser session → inert, never throws.
  assert.equal(typeof client.markIssue, 'function');
  assert.equal(typeof client.getSessionId, 'function');
  assert.equal(client.getSessionId(), null);
  const r = client.markIssue('something looks wrong');
  assert.deepEqual(r, { ok: false, reason: 'inactive' });
});

test('FR4: the Debug card exists in index.html with all controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const id of ['flight-enabled', 'flight-session-id', 'flight-refresh-btn', 'flight-copy-btn', 'flight-mark-form', 'flight-mark-note', 'flight-result']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} must exist in the Settings Debug card`);
  }
});

test('FR4: the client wires the Debug controls and emits a bug_marker', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'flightRecorder.js'), 'utf8');
  assert.match(src, /getElementById\('flight-refresh-btn'\)/, 'refresh button wired');
  assert.match(src, /getElementById\('flight-copy-btn'\)/, 'copy button wired');
  assert.match(src, /getElementById\('flight-mark-form'\)/, 'mark form wired');
  assert.match(src, /'\/api\/flight\/recent'/, 'debug UX reads the recent endpoint');
  assert.match(src, /record\(_active, 'bug_marker'/, 'mark issue emits a bug_marker event');
  assert.match(src, /wireDebugUi\(\)/, 'the debug UX is booted');
});

// Rate-limit isolation (review #857): best-effort telemetry must NEVER draw from the
// trust-write budget and 429 a real set-log / undo. /api/flight/ingest gets its own bucket.
test('ingest has its OWN rate-limiter bucket, separate from the trust-write budget', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // The shared 'write' limiter's path array must NOT include the ingest route.
  const writeBlock = src.slice(0, src.indexOf("name: 'write'"));
  const writeArray = writeBlock.slice(writeBlock.lastIndexOf('app.use(['));
  assert.ok(writeArray.includes('/api/log-workout'), 'located the write limiter path array');
  assert.ok(!writeArray.includes('/api/flight/ingest'), 'ingest is NOT in the trust-write bucket');
  // A dedicated flight_ingest limiter registers /api/flight/ingest.
  assert.match(src, /app\.use\(\['\/api\/flight\/ingest'\],\s*createRateLimiter\(\{\s*name:\s*'flight_ingest'/, 'ingest has its own flight_ingest limiter');
});
