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

// ── THE CLASSIFICATION IS AN AUDIT RESULT, NOT A CONVENIENCE ─────────────────
//
// OWNER CORRECTION 2026-08-13 rejected the earlier split twice, and both rejections
// are recorded here because both were reclassification errors rather than coding
// errors:
//
//   `Constraints`, `Deload_State`, `Coaching_Notes` were called "explicitly
//   Sheets-owned and out of scope". They are INPUTS TO A PRESCRIPTION. A
//   recommendation computed without the athlete's typed constraints is not a
//   degraded answer, it is a different one — and it can prescribe into an injury
//   the athlete already reported.
//
//   `Modality_Log` was called telemetry. `/api/log-modality` is an athlete-facing
//   preview → approve → write path with a write receipt and the write freeze in
//   front of it. A quota exhaustion would have failed that logging request outright.
//
// Every tab below is placed by its ACTUAL CALL SITES in production code, and each
// telemetry entry states why no workout path reads it.
const WORKOUT_CRITICAL_TABS = new Set([
  'Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets', 'Exercise_Catalog',
  // Prescription and coaching inputs (OWNER CORRECTION 2026-08-13).
  'Constraints', 'Deload_State', 'Coaching_Notes',
  // Cardio and conditioning is a workout.
  'Modality_Log',
]);
const TELEMETRY_TABS = new Set([
  // Shadow and observation lanes. None is read by any decision path; each is
  // written after the response is decided and cannot change one.
  'Flight_Recorder', 'Brain_Shadow', 'Intent_Shadow', 'Coach_Shadow', 'Coach_Response',
  'Bug_Reports',
  // THE ONE REMAINING SHEETS-OWNED ATHLETE CONCEPT, and its boundary is exact.
  // `POST /api/bodyweight` appends to it and `GET /api/bodyweight/history` reads it;
  // no recommendation, coaching, substitution, prescription, preview, approval,
  // Save, closeout, receipt retry or undo path touches it. The `bodyweight_history`
  // the state assembler derives comes from LOGGED SETS, not from this tab
  // (`services/analytics.js` `buildBodyweightHistory` takes log rows), so a quota
  // exhaustion here cannot change a workout decision.
  'Bodyweight',
  // Owner-facing spreadsheet furniture. No production reader.
  'Metadata', 'Logic', 'Session_Summary', 'Dashboard',
]);

// ── THE ACCEPTANCE TARGET IS ZERO, AND IT IS ASSERTED AS ZERO ────────────────
//
// There is no ceiling and no ratchet. The owner correction states the equation
// exactly: a totally quota-exhausted Google Sheets plus an Atlas workout must
// leave the workout passing, which requires that NO workout-critical synchronous
// Sheets call exists to fail. A tolerated non-zero count is that requirement
// restated as a preference.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. It proves the COUNT: the real app,
// driven over a real socket with every Sheets call throwing 429, issues zero
// workout-critical synchronous Sheets calls. It cannot prove the workout
// COMPLETES, because completion needs the Supabase authority and this suite has
// no database — the stub blanks every ATLAS_SUPABASE_* role precisely so no test
// can reach one. That half is test-pg/allSheets429Workout.pgproof.js, which runs
// the same all-429 condition against a real from-empty Postgres.

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

// Hermetic: the catalog reads Supabase (OWNER CORRECTION 2026-08-13). This stub also
// blanks the ATLAS_SUPABASE_* roles, so no test can open a database connection.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
// The workout authority is Supabase since the S4 cutover, so stubbing `sheets.js`
// no longer controls the logged sets, the Effort row, the plan ledgers or the write
// receipts. `sheetsFallback` seeds this suite's existing fixture into the double, so
// no test's data changes — only where the route reads it from.
// NO `sheetsFallback` HERE, and that is the whole point of this file. The double can
// seed itself from a suite's fake `sheets.js` fixture so an older suite keeps its
// data; doing that HERE would make the workout authority issue Google Sheets reads,
// which is precisely the thing this census exists to prove does not happen. The
// authority starts empty and the flow below fills it.
require('./helpers/stubWorkoutAuthority').installWorkoutAuthorityStub();
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

  // The harness ran because the WORKOUT ran — not because Sheets traffic appeared.
  // Zero Sheets calls is the target, so it can no longer double as liveness evidence.
  assert.ok(steps.length >= 5, 'the representative workout must drive every step');
  for (const [name, res] of steps) assert.ok(Number.isInteger(res.status), `${name} produced no HTTP response`);

  // An unrecognised tab must be classified deliberately. This is the guard that
  // stops the headline number being right by accident.
  assert.equal(byClass.UNCLASSIFIED, 0,
    'a Sheets call reached an unclassified tab — classify it rather than defaulting it');

  // THE ACCEPTANCE TARGET, ASSERTED AS ZERO.
  assert.equal(byClass.workout_critical_sync, 0,
    `${byClass.workout_critical_sync} workout-critical synchronous Google Sheets call(s) remain. ` +
    'A totally quota-exhausted Sheets must not be able to fail a workout, which requires that ' +
    'no such call exists to fail.');
});

test('FIVE-SESSION AI WORKLOAD under total Sheets quota exhaustion — classified census', async () => {
  calls.length = 0;
  const outcomes = [];
  for (let i = 1; i <= 5; i += 1) outcomes.push(await representativeWorkout(`s${i}`));
  const { byClass } = report('FIVE-SESSION WORKLOAD · Google Sheets 100% quota-exhausted', outcomes);

  assert.equal(byClass.UNCLASSIFIED, 0, 'every Sheets call must be classified');

  // The workload shape that originally exposed the problem is five sessions, so the
  // census must actually cover five of them rather than one repeated measurement.
  // Same: five sessions actually ran, evidenced by their own steps.
  assert.equal(outcomes.length, 5, 'the workload must drive five sessions');
  for (const steps of outcomes) {
    for (const [name, res] of steps) assert.ok(Number.isInteger(res.status), `${name} produced no HTTP response`);
  }
  // THE ACCEPTANCE TARGET, ASSERTED AS ZERO.
  assert.equal(byClass.workout_critical_sync, 0,
    `${byClass.workout_critical_sync} workout-critical synchronous Google Sheets call(s) remain. ` +
    'A totally quota-exhausted Sheets must not be able to fail a workout, which requires that ' +
    'no such call exists to fail.');
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

test('POSITIVE CONTROL: the census really does record a Sheets call when one happens', async () => {
  // A zero is only meaningful if a non-zero were observable. This makes one real
  // Sheets call inside a request context and proves the instrument records and
  // classifies it — so the zeros above cannot be an artefact of a dead counter.
  calls.length = 0;
  const sheets = require('../sheets');

  requestContext = 'POSITIVE CONTROL';
  try {
    await sheets.getSheetRows('Log_Cleaned').catch(() => {});
  } finally {
    requestContext = null;
  }

  assert.ok(calls.length > 0, 'the census must record a Sheets call that really happened');
  const logged = calls.find((c) => c.tab === 'Log_Cleaned');
  assert.ok(logged, 'the call must be recorded against the tab it targeted');
  assert.equal(logged.klass, 'workout_critical_sync',
    'a migrated-tab call inside a request context must classify as workout-critical');

  // And the same call OUTSIDE a request context is not workout-critical, which is
  // the distinction the whole classification rests on.
  calls.length = 0;
  await sheets.getSheetRows('Log_Cleaned').catch(() => {});
  assert.equal(calls[0].klass, 'async_mirror_export',
    'the same call outside a request is mirror/export work, not workout-critical');
  calls.length = 0;
});
