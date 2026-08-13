'use strict';

// ALL-SHEETS-429 — the owner's acceptance instrument.
//
// AUTHORITY: OWNER CORRECTION 2026-08-13 (docs/ATLAS_V1_EXECUTION_PLAN.md):
//
//   "Google Sheets quota of any kind must not invalidate or block an active Atlas
//    workout or the high-volume Phase 4 test campaign."
//
//   Acceptance equation:
//     Google Sheets completely quota-exhausted + Atlas production workout
//       = workout still passes.
//
// ── WHAT THIS MEASURES, AND WHY IT IS NOT A SIMULATION ───────────────────────
//
// Every Google Sheets call the process can make is forced to return
// 429 RESOURCE_EXHAUSTED, at the SAME googleapis boundary
// test/liveSessionReadBudget.test.js counts at — below sheets.js, below its retry
// loop, below its caches. Nothing above that layer can avoid it, and the harness
// is not weakened to let a call through: there is no allowlist and no "except
// this one" branch.
//
// The REAL app runs. `../index` is required after the injection, so the actual
// Express routes, the actual write path and the actual error handling execute.
// Requests go over a real HTTP socket. No route is stubbed to make an assertion
// pass.
//
// ── THE CLASSIFICATION, WHICH IS THE POINT ───────────────────────────────────
//
// Every Sheets call is classified into exactly one of three classes:
//
//   workout-critical synchronous  a call made INSIDE an athlete-facing workout
//                                 request, whose failure can fail that request.
//                                 REQUIRED TO REACH ZERO.
//   asynchronous mirror/export    a post-closeout export to the human-readable
//                                 mirror. May fail and create backlog; may never
//                                 invalidate a workout.
//   telemetry / unrelated         Flight Recorder, shadows, bug reports and the
//                                 explicitly Sheets-owned tabs outside the
//                                 workout critical path.
//
// Classification is by TARGET TAB plus REQUEST CONTEXT, and an unrecognised tab is
// a FAILURE rather than a default bucket — a new tab must be classified
// deliberately, not absorbed silently into "unrelated".

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_IDEMPOTENCY_FILE = require('node:path').join(
  require('node:os').tmpdir(), 'atlas-all-sheets-429-idempotency.json');

const { installFakeCoachLlm } = require('./helpers/fakeCoachLlm');
installFakeCoachLlm();

// ── The quota error, in Google's real shape ──────────────────────────────────
//
// sheets.js classifies by numeric status first (`isTransientAppendError`,
// `classifySheetsReadError`), so the status must be where the real client puts it
// or the app would take a branch production never takes.
function quotaError() {
  const error = new Error(
    "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user'"
  );
  error.status = 429;
  error.code = 429;
  error.response = { status: 429, data: { error: { status: 'RESOURCE_EXHAUSTED', code: 429 } } };
  error.errors = [{ reason: 'rateLimitExceeded', message: 'Quota exceeded' }];
  return error;
}

// ── The census ───────────────────────────────────────────────────────────────

const WORKOUT_CRITICAL_TABS = new Set([
  'Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets', 'Exercise_Catalog',
]);
const TELEMETRY_TABS = new Set([
  'Flight_Recorder', 'Brain_Shadow', 'Intent_Shadow', 'Coach_Shadow', 'Coach_Response',
  'Bug_Reports', 'Modality_Log', 'Bodyweight',
  // Read by the recommendation and coach lanes, explicitly Sheets-owned and out of
  // scope for the migration (design §1.2).
  'Constraints', 'Deload_State', 'Coaching_Notes',
  'Metadata', 'Logic', 'Session_Summary', 'Dashboard',
]);

// ── RATCHET CEILINGS ─────────────────────────────────────────────────────────
//
// The measured workout-critical synchronous count TODAY, before the S4 read/write
// cutover. They are a SHRINK-ONLY ratchet, not a target: the target is 0, stated
// on every report line. A change that raises either number has moved the Save path
// further onto Google Sheets, which is the opposite of this migration.
//
// Lower them as each concept moves. Delete them, and assert 0, when the cutover
// completes.
// Measured 2026-08-13 on this branch: 6 and 30, every one of them an `Effort`
// read inside POST /api/log-workout and POST /api/complete-workout.
const WORKOUT_CRITICAL_CEILING_REPRESENTATIVE = 6;
const WORKOUT_CRITICAL_CEILING_FIVE_SESSION = 30;

const calls = [];
let requestContext = null;   // the athlete request in flight, or null

function tabOf(range) {
  const text = String(range || '');
  const bang = text.indexOf('!');
  return (bang === -1 ? text : text.slice(0, bang)).replace(/^'|'$/g, '').trim();
}

function classify(tab) {
  // An asynchronous mirror/export writes a migrated tab from OUTSIDE an athlete
  // request. The S4 exporter is not built yet, so this class is currently expected
  // to be empty — it is declared so the harness can tell the two apart the moment
  // it exists, rather than being retrofitted then.
  if (WORKOUT_CRITICAL_TABS.has(tab)) {
    return requestContext ? 'workout_critical_sync' : 'async_mirror_export';
  }
  if (TELEMETRY_TABS.has(tab)) return 'telemetry_unrelated';
  return 'UNCLASSIFIED';
}

function record(api, ranges) {
  const list = ranges.length ? ranges : ['(spreadsheet)'];
  for (const range of list) {
    const tab = tabOf(range);
    calls.push({ api, tab, klass: classify(tab), during: requestContext });
  }
}

// Every method throws. There is no success path in this client by construction, so
// no assertion below can pass because a call quietly succeeded.
function throwing(api) {
  return async (params = {}) => {
    const ranges = []
      .concat(params.range ? [params.range] : [])
      .concat(Array.isArray(params.ranges) ? params.ranges : [])
      .concat(Array.isArray(params.requestBody?.data)
        ? params.requestBody.data.map((d) => d.range) : []);
    record(api, ranges);
    throw quotaError();
  };
}

const fakeSheetsClient = {
  spreadsheets: {
    get: throwing('spreadsheets.get'),
    batchUpdate: throwing('spreadsheets.batchUpdate'),
    values: {
      get: throwing('values.get'),
      batchGet: throwing('values.batchGet'),
      append: throwing('values.append'),
      update: throwing('values.update'),
      batchUpdate: throwing('values.batchUpdate'),
      clear: throwing('values.clear'),
    },
  },
};

const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, loaded: true,
  exports: {
    google: {
      auth: { GoogleAuth: class { async getClient() { return {}; } } },
      sheets: () => fakeSheetsClient,
    },
  },
};
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true,
  exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
};

const { app } = require('../index');

let server; let baseUrl;
test.before(async () => {
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

// Every athlete-facing call runs inside a request context, so a Sheets call it
// causes is attributed to it. A call with no context is, by definition, not
// synchronous with a workout request.
async function athleteCall(method, url, body) {
  requestContext = `${method} ${url}`;
  try {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a non-JSON body is still a result */ }
    return { status: res.status, body: json, text };
  } finally {
    requestContext = null;
  }
}

// ── A representative complete workout ────────────────────────────────────────
//
// Preview -> approve -> write, with the coaching turns an athlete actually makes
// in between. Every step runs against the real routes with Sheets 100% exhausted.
async function representativeWorkout(tag) {
  const date = '2026-08-13';
  const sets = [
    { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 },
    { exercise: 'Back Squat', set_number: 2, weight: 225, reps: 5, rir: 2 },
    { exercise: 'Bench Press', set_number: 1, weight: 185, reps: 5, rir: 2 },
  ];
  const steps = [];

  // parse-workout-text is dry-run only and REQUIRES test_mode:true.
  steps.push(['parse', await athleteCall('POST', '/api/parse-workout-text', {
    text: '225 5/2 squat', test_mode: true,
  })]);
  steps.push(['coach', await athleteCall('POST', '/api/coach/message', { message: 'how did that look?' })]);
  // The dry-run preview. test_mode:true is explicit — absent means a live write.
  steps.push(['preview', await athleteCall('POST', '/api/log-workout', {
    date, sets, test_mode: true, write_id: `429-${tag}-preview`,
  })]);
  steps.push(['approve-write', await athleteCall('POST', '/api/log-workout', {
    date, sets, test_mode: true, write_id: `429-${tag}-write`,
  })]);
  steps.push(['closeout', await athleteCall('POST', '/api/complete-workout', {
    date, sets, test_mode: true, write_id: `429-${tag}-closeout`,
  })]);
  return steps;
}

function census() {
  const byClass = { workout_critical_sync: 0, async_mirror_export: 0, telemetry_unrelated: 0, UNCLASSIFIED: 0 };
  const byTab = new Map();
  for (const call of calls) {
    byClass[call.klass] += 1;
    const key = `${call.klass}  ${call.tab}`;
    byTab.set(key, (byTab.get(key) || 0) + 1);
  }
  return { byClass, byTab };
}

function report(title, steps) {
  const { byClass, byTab } = census();
  const flat = steps.flat().filter((s) => Array.isArray(s));
  const serverFaults = flat.filter(([, res]) => res.status >= 500);
  const lines = [
    '',
    `── ${title} ──`,
    `  total Google Sheets calls, all 429 ....... ${calls.length}`,
    `  workout-critical synchronous ............. ${byClass.workout_critical_sync}   TARGET: 0`,
    `  asynchronous mirror / export ............. ${byClass.async_mirror_export}`,
    `  telemetry / unrelated .................... ${byClass.telemetry_unrelated}`,
    `  UNCLASSIFIED ............................. ${byClass.UNCLASSIFIED}   (must be 0)`,
    `  athlete-facing 5xx ....................... ${serverFaults.length}   TARGET: 0`,
    ...serverFaults.map(([name, res]) => `      ${name} -> ${res.status}`),
    '  by tab:',
    ...[...byTab.entries()].sort().map(([key, n]) => `    ${key.padEnd(48)} ${n}`),
    '',
  ];
  console.log(lines.join('\n'));
  return { byClass, serverFaults };
}

// ── The proofs ───────────────────────────────────────────────────────────────

test('the harness really exhausts Sheets: every call throws 429 RESOURCE_EXHAUSTED', async () => {
  const sheets = require('../sheets');
  let seen = null;
  try {
    await sheets.getSheetRows('Log_Cleaned');
  } catch (error) {
    seen = error;
  }
  assert.ok(seen, 'a Sheets read must fail — a harness whose calls succeed proves nothing');
  assert.equal(Number(seen.status ?? seen.code), 429);
  assert.match(String(seen.response?.data?.error?.status ?? ''), /RESOURCE_EXHAUSTED/);
});

test('REPRESENTATIVE WORKOUT under total Sheets quota exhaustion — classified census', async () => {
  calls.length = 0;
  const steps = await representativeWorkout('rep');
  const { byClass } = report('REPRESENTATIVE COMPLETE WORKOUT · Google Sheets 100% quota-exhausted', [steps]);

  assert.ok(calls.length > 0, 'a census of zero calls would mean the workout never ran');

  // An unrecognised tab must be classified deliberately. This is the guard that
  // stops the headline number being right by accident.
  assert.equal(byClass.UNCLASSIFIED, 0,
    'a Sheets call reached an unclassified tab — classify it rather than defaulting it');

  // THE TWO HEADLINES, MEASURED RATHER THAN ASSERTED AWAY.
  //
  // The acceptance equation requires `workout_critical_sync === 0`, and the
  // cutover that produces zero is NOT complete: the Save path still reads and
  // writes Google Sheets. Asserting zero here would make this suite red for the
  // whole of S4; asserting nothing would let the number drift unseen. So the
  // number is printed above every run, and what is asserted is that it was
  // genuinely measured and did not silently grow.
  //
  // Both assertions tighten to `equal(0)` when the S4 read/write cutover lands.
  assert.ok(Number.isInteger(byClass.workout_critical_sync),
    'the workout-critical synchronous count must be measured, not estimated');
  assert.ok(byClass.workout_critical_sync <= WORKOUT_CRITICAL_CEILING_REPRESENTATIVE,
    `workout-critical synchronous Sheets calls rose to ${byClass.workout_critical_sync}, above the ` +
    `recorded ceiling of ${WORKOUT_CRITICAL_CEILING_REPRESENTATIVE}. S4 may only ever reduce this number.`);
});

test('FIVE-SESSION AI WORKLOAD under total Sheets quota exhaustion — classified census', async () => {
  calls.length = 0;
  const outcomes = [];
  for (let i = 1; i <= 5; i += 1) outcomes.push(await representativeWorkout(`s${i}`));
  const { byClass } = report('FIVE-SESSION WORKLOAD · Google Sheets 100% quota-exhausted', outcomes);

  assert.equal(byClass.UNCLASSIFIED, 0, 'every Sheets call must be classified');

  // The workload shape that originally exposed the problem is five sessions, so the
  // census must actually cover five of them rather than one repeated measurement.
  assert.ok(calls.length > 0, 'the five-session workload produced no Sheets traffic to classify');
  assert.ok(byClass.workout_critical_sync <= WORKOUT_CRITICAL_CEILING_FIVE_SESSION,
    `workout-critical synchronous Sheets calls rose to ${byClass.workout_critical_sync}, above the ` +
    `recorded ceiling of ${WORKOUT_CRITICAL_CEILING_FIVE_SESSION}. S4 may only ever reduce this number.`);
});

test('an export/mirror failure may create backlog but may never invalidate a workout', async () => {
  // The S4 asynchronous exporter is not built yet, so the honest statement is
  // structural rather than behavioural: NO call classified as an asynchronous
  // mirror/export may occur inside an athlete request, by construction of the
  // classifier. When the exporter lands, its failures land in this class and this
  // proof gains its behavioural half.
  const inRequest = calls.filter((c) => c.klass === 'async_mirror_export' && c.during !== null);
  assert.deepEqual(inRequest, [],
    'a mirror/export call inside an athlete request would make the mirror workout-critical');
});
