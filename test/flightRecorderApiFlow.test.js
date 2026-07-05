'use strict';

// Atlas Flight Recorder — PR-FR2 unit coverage for SERVER-SIDE API-flow recording
// (services/flightRecorder.recordApiFlow) and the sandbox/production isolation guard.
// Proves:
//   * flag OFF → zero writes anywhere (the required disabled-flag proof);
//   * flag ON → one best-effort append to Flight_Recorder ONLY, never a workout/trust tab;
//   * SIMULATION traffic is NEVER persisted to a non-sandbox sheet (the required
//     sim-writes-only-to-sandbox / never-production proof), while still ringed in memory;
//   * real (non-sim) traffic records regardless of which sheet the server points at;
//   * request bodies are redacted + summarized; persistence is TOTAL (a throw never surfaces).
// Also proves the simulation harness MARKS its requests (x-atlas-simulation), which is what
// lets the server-side guard identify sim traffic. Pure: append is injected, no Sheets/network.

const test = require('node:test');
const assert = require('node:assert/strict');

const flightRecorder = require('../services/flightRecorder');
const harness = require('../scripts/sim/harness');

const FLAG = 'ATLAS_FLIGHT_RECORDER';

// Silence the per-record console line.
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

// Reset the recorder with a spying append; return the captured calls.
function setup() {
  const appended = [];
  flightRecorder._resetForTesting({ append: async (tab, rows) => { appended.push({ tab, rows }); } });
  return appended;
}

// Let the fire-and-forget _persistRows microtask settle.
function tick() { return new Promise(r => setImmediate(r)); }

const baseFlow = {
  method: 'POST',
  path: '/api/coach/chat',
  latency_ms: 812,
  response_summary: '200',
  request_body: { message: 'what should I bench next?' },
  app_version: 'abc1234'
};

test('flag OFF → recordApiFlow is a no-op and writes NOTHING (disabled-flag proof)', async () => {
  const appended = setup();
  const result = withFlag(undefined, () => flightRecorder.recordApiFlow(baseFlow, { sheetIsSandbox: true }));
  assert.equal(result, undefined, 'no event returned when disabled');
  await tick();
  assert.equal(appended.length, 0, 'zero Flight Recorder writes when the flag is off');
  assert.equal(flightRecorder.getFlightRecorderLog().count, 0, 'nothing ringed either');
});

test('flag ON, real traffic → one append to Flight_Recorder ONLY (never a workout/trust tab)', async () => {
  const appended = setup();
  const event = withFlag('1', () => flightRecorder.recordApiFlow(baseFlow, { sheetIsSandbox: false }));
  assert.ok(event, 'an event is returned');
  assert.equal(event.event_type, 'api_response');
  assert.equal(event.api_endpoint, 'POST /api/coach/chat');
  await tick();
  assert.equal(appended.length, 1, 'exactly one row appended');
  assert.equal(appended[0].tab, flightRecorder.FLIGHT_RECORDER_TAB);
  assert.equal(appended[0].tab, 'Flight_Recorder');
  // Never a workout/trust tab.
  for (const call of appended) {
    assert.ok(!['Log_Cleaned', 'Effort', 'Modality_Log'].includes(call.tab), `must not write ${call.tab}`);
  }
  // The row carries the endpoint + latency.
  const row = appended[0].rows[0];
  assert.equal(row.length, 18);
  assert.equal(row[6], 'api_response');           // event_type
  assert.equal(row[11], 'POST /api/coach/chat');  // api_endpoint
  assert.equal(row[17], 812);                     // latency_ms
});

test('ISOLATION: simulation traffic is NEVER persisted to a non-sandbox sheet', async () => {
  const appended = setup();
  const event = withFlag('1', () => flightRecorder.recordApiFlow(
    { ...baseFlow, is_simulation: true },
    { sheetIsSandbox: false }   // e.g. a production or unknown sheet
  ));
  assert.ok(event, 'still returned (kept in the in-memory ring)');
  await tick();
  assert.equal(appended.length, 0, 'sim traffic must not write to a non-sandbox sheet (never production)');
  assert.equal(flightRecorder.getFlightRecorderLog().count, 1, 'but it IS retained in the in-memory ring');
});

test('ISOLATION: simulation traffic DOES persist when the server IS the sandbox sheet', async () => {
  const appended = setup();
  withFlag('1', () => flightRecorder.recordApiFlow({ ...baseFlow, is_simulation: true }, { sheetIsSandbox: true }));
  await tick();
  assert.equal(appended.length, 1, 'sim writes are allowed to the sandbox Flight_Recorder');
  assert.equal(appended[0].tab, 'Flight_Recorder');
});

test('real (non-sim) traffic records regardless of sheet (production records to production)', async () => {
  const appended = setup();
  withFlag('1', () => flightRecorder.recordApiFlow(baseFlow, { sheetIsSandbox: false }));
  await tick();
  assert.equal(appended.length, 1, 'a real user request on a production server records to production Flight_Recorder');
});

test('request_summary is a SHAPE summary — top-level keys + size, never raw values', async () => {
  const appended = setup();
  withFlag('1', () => flightRecorder.recordApiFlow({
    ...baseFlow,
    // A log-workout-shaped body: workout content + a secret-shaped value.
    request_body: { message: 'felt heavy today', notes: 'tweaked my shoulder', token: 'sk-proj-ABCDEFGH12345678' }
  }, { sheetIsSandbox: true }));
  await tick();
  const requestSummary = appended[0].rows[0][12]; // request_summary column
  // Keys (the shape) are present...
  assert.ok(requestSummary.includes('message') && requestSummary.includes('notes'), 'top-level keys captured');
  assert.ok(/\(\d+ chars\)/.test(requestSummary), 'body size captured');
  // ...but NO field VALUES ever appear — not workout content, not the secret.
  assert.ok(!requestSummary.includes('felt heavy today'), 'workout content never emitted');
  assert.ok(!requestSummary.includes('tweaked my shoulder'), 'workout notes never emitted');
  assert.ok(!/sk-proj-ABCDEFGH12345678/.test(requestSummary), 'secret value never emitted');
});

test('GET with no body → blank request_summary', async () => {
  const appended = setup();
  withFlag('1', () => flightRecorder.recordApiFlow(
    { method: 'GET', path: '/api/plan/today', latency_ms: 40, response_summary: '200' },
    { sheetIsSandbox: true }
  ));
  await tick();
  assert.equal(appended[0].rows[0][12], '', 'no request body → blank summary');
  assert.equal(appended[0].rows[0][11], 'GET /api/plan/today');
});

test('TOTAL: a throwing append never surfaces and the ring still records', async () => {
  flightRecorder._resetForTesting({ append: async () => { throw new Error('tab missing / no creds'); } });
  let event;
  assert.doesNotThrow(() => {
    event = withFlag('1', () => flightRecorder.recordApiFlow(baseFlow, { sheetIsSandbox: true }));
  });
  assert.ok(event, 'the in-memory record still happens even when persistence throws');
  await tick(); // the rejection must be swallowed (no unhandled rejection)
  assert.equal(flightRecorder.getFlightRecorderLog().count, 1);
});

test('TOTAL: hostile input never throws', () => {
  setup();
  withFlag('1', () => {
    assert.doesNotThrow(() => flightRecorder.recordApiFlow(undefined, undefined));
    assert.doesNotThrow(() => flightRecorder.recordApiFlow(42, 42));
    assert.doesNotThrow(() => flightRecorder.recordApiFlow({ method: 'GET' }, null));
  });
});

// ── The other half of the isolation chain: the harness MARKS sim traffic ──────────
// The server-side guard can only identify simulation traffic because the harness sends
// the x-atlas-simulation header on every request. Prove it does.

test('harness: exposes the simulation header and stamps read requests with it', async () => {
  assert.deepEqual(harness.SIMULATION_HEADERS, { 'x-atlas-simulation': '1' });

  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push(init);
    return { status: 200, async text() { return JSON.stringify({ data: { message: 'ok' } }); } };
  };
  await harness.runScenario(
    { name: 'probe', endpoint: '/api/coach/chat', method: 'POST', prompt: 'hi' },
    { baseUrl: 'http://atlas.local', fetchImpl: fakeFetch, mode: 'read-only' }
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers['x-atlas-simulation'], '1', 'sim scenario request is marked');
});
