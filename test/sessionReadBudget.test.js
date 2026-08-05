'use strict';

// SESSION READ BUDGET — the outcome test for F-SB4B.
//
// WHAT FAILED. Qualifying session 1 (2026-08-05, run fsb4b-s1-20260805T122822-04E1C5)
// exhausted its own Google Sheets read quota mid-session and died at closeout.
// `scripts/reconstruct-session-reads.js` over that run's server log measures the demand:
// 78 read attempts, 0 of them retries, and a peak rolling-60s window of 78 — the entire
// session inside ONE minute against a 60/minute quota. The session was over budget on
// its own demand, not on retry amplification.
//
// WHY THE EXISTING GUARD COULD NOT SEE IT. `docs/READ_BUDGET.md` and
// `test/sheets-adapter-reads.test.js` budget reads PER SAVE and count sheets.js helper
// calls. A per-save budget cannot express "a complete session must fit in a minute", and
// a helper-call count cannot see that ONE batchGet now carries what used to be six
// requests. So this file measures the only thing Google's quota actually meters:
// **requests to the Sheets API, in a rolling 60-second window, across a complete
// owner-pattern session**.
//
// HOW IT IS MEASURED, AND WHY THAT IS HONEST.
//   • The count is taken at the googleapis boundary — every `values.get` and every
//     `values.batchGet` the process issues. Nothing above that layer can under-report:
//     a helper that starts reading tomorrow is counted whether or not anyone lists it.
//   • The REAL `sheets.js` and the REAL Express app run. Only `googleapis` is faked, so
//     the batching, the request context, the catalog cache and every handler in the
//     chain are the production ones.
//   • The request sequence is the LITERAL sequence of API calls from the failed run's
//     server log, in order (static asset and health requests dropped — they reach no
//     handler that reads). It is not a representative sample; it is that session.
//   • EVERY request must answer 2xx. A request that 400s early performs no reads, and a
//     sequence of early rejections would produce a beautiful, meaningless budget.
//     `assertSequenceGenuine` refuses that.
//   • The counterfactual tests are the real anti-false-green. The same sequence is re-run
//     with batching disabled, with the catalog cache disabled, and with both disabled;
//     each must BREAK the budget, and the both-disabled run must reproduce the original
//     failure. If this sequence ever stops genuinely exercising the read paths, those
//     tests stop failing-as-required and this file goes red.
//
// MEASURED, on this sequence (see the calibration test below):
//     batching + cache   36   ← the shipped behaviour, against a budget of 50
//     batching only      58   ← catalog cache removed
//     cache only         53   ← batching removed
//     neither            76   ← the pre-change behaviour; the failed run measured 78

const test = require('node:test');
const assert = require('node:assert/strict');

const BUDGET = 50;           // peak reads per rolling 60s. Google's limit is 60/min.
const CATALOG_REQUESTS = 1;  // Exercise_Catalog, for the whole measured window.

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
// The posture the failed session ran under — both shadow lanes on. They are read
// sources, so measuring with them off would understate the session's real demand.
process.env.ATLAS_INTENT_ROUTER = 'shadow';
process.env.ATLAS_COACH_ENGINE = 'hybrid';
// This file replays a full session several times over (the measured run plus two
// counterfactuals) inside one rate-limit window. The HTTP rate limiter is not what is
// under test, and a 429 would silently REMOVE reads and flatter the budget, so it is
// lifted here. Nothing else about the request path is altered.
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';

// ── Sheet fixture ────────────────────────────────────────────────────────────
// Column layouts follow .claude/rules/sheet-schemas.md exactly, so the handlers parse
// real rows rather than shapes that happen to survive.
const LOG_HEADER = ['date_clean', 'session_id', 'exercise', 'canonical_exercise', 'muscle_group', 'lift_code', 'set_number', 'weight', 'reps', 'rir', 'notes', 'volume_calc'];
const EFFORT_HEADER = ['date', 'session_id', 'duration', 'active_calories', 'total_calories', 'average_hr', 'peak_hr', 'location', 'notes'];
const DELOAD_HEADER = ['updated_at', 'training_state', 'deload_protocol', 'deload_reason', 'deload_start_date', 'deload_sessions_remaining', 'deload_exit_criteria'];
const PLANS_HEADER = ['idempotency_key', 'session_id', 'session_date', 'plan_version', 'event_type', 'plan_item_id', 'planned_order', 'planned_lift_code', 'movement_pattern', 'outcome', 'performed_lift_code', 'closeout_status', 'recorded_at'];
const PLAN_SETS_HEADER = ['idempotency_key', 'session_id', 'session_date', 'plan_version', 'plan_item_id', 'set_number', 'planned_lift_code', 'planned_weight', 'planned_reps', 'planned_rir', 'source', 'endorsement', 'performed_weight', 'performed_reps', 'performed_rir', 'recorded_at'];

const CATALOG = [
  ['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
  ['Back Squat', 'Back Squat', 'Legs', 'SQ01'],
  ['Overhead Press', 'Overhead Press', 'Shoulders', 'OHP01'],
  ['RDL', 'RDL', 'Hamstrings', 'RDL01'],
  ['Incline DB Press', 'Incline DB Press', 'Chest', 'IDB01'],
  ['Seated Row', 'Seated Row', 'Back', 'SR01'],
  ['Bicep Curl', 'Bicep Curl', 'Arms', 'BC01'],
];

function historyRows() {
  const rows = [LOG_HEADER];
  const lifts = [['Back Squat', 'SQ01', 225, 5], ['Overhead Press', 'OHP01', 110, 6], ['RDL', 'RDL01', 235, 5],
    ['Incline DB Press', 'IDB01', 55, 8], ['Seated Row', 'SR01', 205, 10], ['Bicep Curl', 'BC01', 35, 15]];
  for (let session = 1; session <= 6; session++) {
    for (const [name, code, weight, reps] of lifts) {
      for (let set = 1; set <= 3; set++) {
        rows.push([`2026-07-${String(10 + session).padStart(2, '0')}`, `202607${10 + session}-PM-01`,
          name, name, 'x', code, String(set), String(weight), String(reps), '2', '', String(weight * reps)]);
      }
    }
  }
  return rows;
}

// Mutable sheet state — appends land here so a read-after-write sees them.
let SHEET = {};
function resetSheet() {
  SHEET = {
    Log_Cleaned: historyRows(),
    Effort: [EFFORT_HEADER],
    Deload_State: [DELOAD_HEADER, ['2026-08-01T00:00:00.000Z', 'NORMAL', '', '', '', '', '']],
    Session_Plans: [PLANS_HEADER],
    Session_Plan_Sets: [PLAN_SETS_HEADER],
    Exercise_Catalog: CATALOG,
    Constraints: [['date', 'kind', 'target', 'rule', 'note']],
    Coaching_Notes: [['date', 'note']],
  };
}
resetSheet();

/** Slice the fixture for an A1 range. Column spans are honoured; row spans are not
 *  needed by any declared range beyond the header probes, which are handled here. */
function valuesForRange(range) {
  const text = String(range || '');
  const bang = text.indexOf('!');
  const tab = bang === -1 ? text : text.slice(0, bang);
  const spec = bang === -1 ? '' : text.slice(bang + 1);
  const rows = SHEET[tab];
  if (!rows) {
    const err = new Error(`Unable to parse range: ${text}`);
    return { error: err };
  }
  if (/^1:1$/.test(spec)) return { values: [rows[0]] };
  const a1 = /^([A-Z]+)(\d*):([A-Z]+)(\d*)$/.exec(spec);
  if (!a1) return { values: rows };
  const col = (letters) => letters.split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  const [, c1, r1, c2, r2] = a1;
  const start = col(c1); const end = col(c2);
  const first = r1 ? Number(r1) - 1 : 0;
  const last = r2 ? Number(r2) : rows.length;
  return { values: rows.slice(first, last).map(row => row.slice(start, end + 1)) };
}

// ── Fake googleapis: the measurement point ───────────────────────────────────
const reads = [];   // { at, kind, ranges }
let countingOn = false;

function recordRead(kind, ranges) {
  if (countingOn) reads.push({ at: Date.now(), kind, ranges });
}

const fakeSheetsClient = {
  spreadsheets: {
    get: async () => ({ data: { sheets: Object.keys(SHEET).map(title => ({ properties: { title, sheetId: 1 } })) } }),
    batchUpdate: async () => ({ data: {} }),
    values: {
      get: async ({ range }) => {
        recordRead('get', [range]);
        const out = valuesForRange(range);
        if (out.error) throw out.error;
        return { data: { values: out.values } };
      },
      // ONE quota unit, N ranges. Returns valueRanges positionally, as the real API does.
      batchGet: async ({ ranges }) => {
        recordRead('batchGet', ranges);
        const valueRanges = [];
        for (const range of ranges) {
          const out = valuesForRange(range);
          if (out.error) throw out.error;   // the real API rejects the WHOLE batch
          valueRanges.push({ range, values: out.values });
        }
        return { data: { valueRanges } };
      },
      append: async ({ range, requestBody }) => {
        const tab = String(range).split('!')[0];
        if (!SHEET[tab]) SHEET[tab] = [];
        for (const row of requestBody.values) SHEET[tab].push(row.map(v => (v == null ? '' : String(v))));
        return { data: { updates: { updatedRows: requestBody.values.length, updatedRange: `${tab}!A2:Z2` } } };
      },
      update: async () => ({ data: {} }),
      batchUpdate: async () => ({ data: { totalUpdatedCells: 1 } }),
    }
  }
};

const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, loaded: true,
  exports: { google: { auth: { GoogleAuth: class { async getClient() { return {}; } } }, sheets: () => fakeSheetsClient } }
};

// Vision is stubbed only so no screenshot path reaches a provider; it performs no reads.
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true,
  exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
};

const sheets = require('../sheets');
const { app } = require('../index');

let server; let baseUrl;
test.before(async () => {
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

// ── the owner-pattern sequence ───────────────────────────────────────────────
const SESSION_DATE = '2026-08-05';
const SESSION_ID = '20260805-PM-01';
const PLAN_VERSION = 'pv_qualifying_1';
const LIFTS = [
  { name: 'Back Squat', code: 'SQ01', w: 225, reps: 5 },
  { name: 'Overhead Press', code: 'OHP01', w: 110, reps: 6 },
  { name: 'RDL', code: 'RDL01', w: 235, reps: 5 },
  { name: 'Incline DB Press', code: 'IDB01', w: 55, reps: 8 },
  { name: 'Seated Row', code: 'SR01', w: 205, reps: 10 },
  { name: 'Bicep Curl', code: 'BC01', w: 35, reps: 15 },
];

const call = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { method, path, status: res.status, body: await res.json().catch(() => null) };
};

const sessionRef = { session_id: SESSION_ID, session_date: SESSION_DATE, plan_version: PLAN_VERSION };
const planItems = LIFTS.map((lift, i) => ({
  plan_item_id: `pi_${lift.code.toLowerCase()}`, planned_lift_code: lift.code, planned_order: i + 1,
}));
const observe = (message) => ['POST', '/api/debug/intent-observe', { message, request_origin: 'athlete_ui', app_version: 'test' }];
const setRows = (lift, set) => [{ exercise: lift.name, set_number: set, weight: lift.w, reps: lift.reps, rir: 2 }];

/**
 * The failed run's API sequence, in order — app open, plan acceptance, then six lifts
 * logged two sets each with a recommendation, a coach reaction and a composer observation
 * between them, and the plan events that fired partway through.
 *
 * Static assets, `/version` and `/health` are omitted: they reach no handler that reads a
 * sheet, and the log's four reads attributed to `GET /app/` are the request logger's
 * next-completed-request attribution of concurrent API reads, not reads that route made.
 *
 * This is deliberately the WHOLE sequence, not a representative slice. A compressed
 * version of it measured 47 reads with batching disabled — under budget — which would
 * have let test 1 pass on a session that never reproduced the failure.
 */
function ownerPatternSequence() {
  const steps = [
    // App open: the client's opening fan-out.
    ['GET', '/api/session/status'],
    ['GET', '/api/flight/recent'],
    ['GET', '/api/catalog/exercises'],
    ['GET', '/api/report/weekly'],
    ['GET', '/api/plan/intent-recommendation'],
    ['GET', '/api/plan/intent-recommendation'],
    ['GET', '/api/progress/summary'],
    ['GET', '/api/plan/today'],
    ['GET', '/api/prs/recent'],
    ['GET', '/api/stalls?minSessions=3'],
    ['GET', '/api/coaching/insights'],
    ['GET', '/api/coaching/insights'],
    ['GET', '/api/summary/weekly'],
    ['GET', '/api/history/recent?limit=10'],
    // Plan acceptance, then the first composer turn.
    ['POST', '/api/session-plans/accept', { ...sessionRef, items: planItems }],
    observe('starting squats'),
    ['POST', '/api/parse-workout-text', { text: '225 5/2', test_mode: true }],
    ['GET', '/api/exercises/last-session?exercise=Back%20Squat'],
    ['GET', '/api/plan/today'],
  ];
  LIFTS.forEach((lift, index) => {
    for (const set of [1, 2]) {
      // Save is preview-then-write, and each half is its OWN HTTP request with its own
      // reads (docs/READ_BUDGET.md). Measuring only the preview would understate every
      // logged set by a whole request.
      steps.push(['POST', '/api/log-workout', {
        date: SESSION_DATE, session_id: SESSION_ID, test_mode: true, log_rows: setRows(lift, set),
      }]);
      steps.push(['POST', '/api/log-workout', {
        date: SESSION_DATE, session_id: SESSION_ID, log_rows: setRows(lift, set),
        write_id: `w_${lift.code}_${set}`,   // idempotency key the live half requires
      }]);
      steps.push(['GET', `/api/recommend/next/${lift.code}?intentId=work_day&w=${lift.w}&reps=${lift.reps}&rir=2`]);
      steps.push(['POST', '/api/coach/message', {
        kind: 'set', facts: { exercise: lift.name, lift_code: lift.code, weight: lift.w, reps: lift.reps, rir: 2, set_number: set },
      }]);
      steps.push(observe(`${lift.name} ${lift.w} ${lift.reps}/2`));
      steps.push(['POST', '/api/parse-workout-text', { text: `${lift.w} ${lift.reps}/2`, test_mode: true }]);
      if (set === 1) steps.push(['GET', `/api/exercises/last-session?exercise=${encodeURIComponent(lift.name)}`]);
    }
    // The plan events the owner triggered mid-session, at the points they occurred.
    if (index === 0) {
      steps.push(['POST', '/api/session-plan-sets/accept', {
        ...sessionRef,
        items: planItems.map(item => ({
          ...item, target_set_count: 2, set_index: 1, set_number: 1,
          planned_weight: 100, planned_reps: 5, planned_rir: 2, source: 'accepted_plan',
        })),
      }]);
    }
    if (index === 2) {
      steps.push(['POST', '/api/log-modality', { text: '20 min bike intervals', session_id: SESSION_ID, date: SESSION_DATE, test_mode: true }]);
      steps.push(['POST', '/api/suggest-substitute', { exercise: 'RDL', reason: 'equipment' }]);
    }
    if (index === 3) {
      steps.push(['POST', '/api/session-plans/outcome', {
        ...sessionRef,
        item: {
          plan_item_id: planItems[index].plan_item_id, outcome: 'completed',
          planned_lift_code: LIFTS[index].code, performed_lift_code: LIFTS[index].code,
        },
      }]);
      steps.push(['POST', '/api/session-plan-sets/revision', {
        ...sessionRef,
        revision: {
          plan_item_id: planItems[index].plan_item_id, target_set_count: 2, set_index: 2, set_number: 2, plan_version: 2,
          planned_lift_code: LIFTS[index].code, planned_weight: 60, planned_reps: 8, planned_rir: 2,
          recommendation_source: 'live_revision', endorsement: 'user_endorsed',
        },
      }]);
      steps.push(['POST', '/api/coach/ask', { message: 'should I add weight?' }]);
      steps.push(['POST', '/api/coach/chat', { message: 'how am I tracking today?' }]);
    }
  });
  return steps;
}

function assertSequenceGenuine(results) {
  const throttled = results.filter(r => r.status === 429);
  assert.equal(throttled.length, 0,
    'a rate-limited request performs no reads, which would flatter the budget');
  // EVERY request must succeed, not merely the ones currently known to read. A request
  // that 4xx's early performs no reads, so a sequence of early rejections would produce a
  // beautiful, meaningless budget. Requiring 2xx across the board also means a handler
  // that starts reading tomorrow is already being driven, not skipped.
  const failures = results.filter(r => r.status < 200 || r.status >= 300);
  assert.equal(failures.length, 0,
    `a request that never reached its handler makes the budget meaningless — ${
      JSON.stringify(failures.slice(0, 3).map(f => ({ path: f.path, status: f.status, body: f.body })), null, 2)}`);
}

/** Where the reads went — printed on a budget failure so the cause is visible, not guessed. */
function breakdown(records) {
  const byRange = new Map();
  for (const record of records) {
    const key = record.kind === 'batchGet' ? `batchGet[${record.ranges.length}]` : record.ranges[0];
    byRange.set(key, (byRange.get(key) || 0) + 1);
  }
  return [...byRange.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} × ${k}`).join('\n  ');
}

/** The worst rolling-60s window of API read requests — the number Google meters. */
function peakRollingMinute(records) {
  const stamps = records.map(r => r.at).sort((a, b) => a - b);
  let peak = 0; let start = 0;
  for (let end = 0; end < stamps.length; end++) {
    while (stamps[end] - stamps[start] >= 60_000) start++;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

const catalogReads = () => reads.filter(r => r.ranges.some(range => String(range).startsWith('Exercise_Catalog'))).length;

/** Wait until no new read has been recorded for `quietMs`, so deferred reads are counted. */
async function settle({ quietMs = 600, maxMs = 15_000 } = {}) {
  const deadline = Date.now() + maxMs;
  let seen = -1;
  while (reads.length !== seen && Date.now() < deadline) {
    seen = reads.length;
    await new Promise(resolve => setTimeout(resolve, quietMs));
  }
}

/**
 * Run the whole sequence with counting on, from a cold cache and a fresh sheet.
 *
 * `coldCatalogPerRequest` reproduces the pre-change catalog behaviour by clearing the
 * cache between requests. It is done from the DRIVER rather than by replacing
 * `sheets.getExerciseCatalog`, because the consumers destructure that function at
 * require time — patching the module property would leave them on the real one and the
 * counterfactual would quietly measure nothing.
 */
async function runSession({ coldCatalogPerRequest = false } = {}) {
  resetSheet();
  sheets._resetExerciseCatalogCache();
  reads.length = 0;
  countingOn = true;
  const results = [];
  for (const [method, path, body] of ownerPatternSequence()) {
    if (coldCatalogPerRequest) sheets._resetExerciseCatalogCache();
    results.push(await call(method, path, body));
  }
  // Intent-observe is fire-and-forget: its reads are issued AFTER the response, and the
  // shadow classifier takes ~500 ms. A fixed drain silently drops them — and a budget
  // that omits a read source is exactly the false green this file exists to prevent — so
  // wait until the read stream has genuinely gone quiet.
  await settle();
  countingOn = false;
  return {
    results, total: reads.length, peak: peakRollingMinute(reads),
    catalog: catalogReads(), breakdown: breakdown(reads),
  };
}

// ── 1. the budget holds on the complete session ──────────────────────────────
test('a complete owner-pattern session fits inside the session read budget', async () => {
  const run = await runSession();
  assertSequenceGenuine(run.results);
  assert.ok(run.total > 0, 'the sequence must actually read the sheet');
  assert.ok(run.peak <= BUDGET,
    `peak rolling-60s reads ${run.peak} exceeds the ${BUDGET} budget (total ${run.total}); ` +
    `the failed session measured 78 — see scripts/reconstruct-session-reads.js\n  ${run.breakdown}`);
});

// ── 2. Exercise_Catalog is ONE request for the whole window ──────────────────
test('Exercise_Catalog costs exactly one request across the measured session', async () => {
  const run = await runSession();
  assertSequenceGenuine(run.results);
  assert.equal(run.catalog, CATALOG_REQUESTS,
    `Exercise_Catalog must be read once per TTL window, got ${run.catalog}`);
});

// ── 3. counterfactual: individual range requests break the budget ────────────
//
// This is the test that stops the budget from being satisfied by a weak sequence. With
// the batch disabled every declared range costs its own request again — exactly the
// pre-change shape — and the session must go OVER budget. If it does not, the sequence
// is not exercising the read paths and test 1 proved nothing.
test('restoring individual range requests breaks the session budget', async () => {
  const realDeclare = sheets.declareRequestRanges;
  sheets.declareRequestRanges = () => {};   // no declaration ⇒ no batch ⇒ one request per range
  try {
    const run = await runSession();
    assertSequenceGenuine(run.results);
    assert.ok(run.peak > BUDGET,
      `without batching the session must exceed the ${BUDGET} budget, but peaked at ${run.peak}. ` +
      'Either the sequence stopped exercising the read paths, or batching is no longer what keeps it under.' +
      `\n  ${run.breakdown}`);
  } finally {
    sheets.declareRequestRanges = realDeclare;
  }
});

// ── 4. counterfactual: per-request catalog reads break the budget ────────────
test('restoring per-request Exercise_Catalog reads breaks the session budget', async () => {
  const run = await runSession({ coldCatalogPerRequest: true });
  assertSequenceGenuine(run.results);
  assert.ok(run.catalog > CATALOG_REQUESTS,
    'precondition: a cold cache per request must actually re-read the catalog');
  assert.ok(run.peak > BUDGET,
    `without the catalog cache the session must exceed the ${BUDGET} budget, but peaked at ${run.peak}` +
    `\n  ${run.breakdown}`);
});

// ── 4b. the harness reproduces the original failure ──────────────────────────
//
// The strongest available check that this sequence is the real thing: with BOTH
// mechanisms off it must land where the failed session landed — over Google's actual
// 60/minute read limit. A sequence that cannot reproduce the outage cannot prove it fixed.
test('with both mechanisms disabled the sequence reproduces the original quota failure', async () => {
  const realDeclare = sheets.declareRequestRanges;
  sheets.declareRequestRanges = () => {};
  try {
    const run = await runSession({ coldCatalogPerRequest: true });
    assertSequenceGenuine(run.results);
    assert.ok(run.peak > 60,
      `the pre-change behaviour must exceed Google's 60/min read limit, as the failed session did ` +
      `at 78; this harness measured ${run.peak}\n  ${run.breakdown}`);
  } finally {
    sheets.declareRequestRanges = realDeclare;
  }
});

// ── 5. Deload_State is never served stale ────────────────────────────────────
//
// The budget must not be bought with a cached training state. Deload_State is batched
// with the request that consumes it and cached for NO longer than that request, so a
// begin / advance / resolve is visible to the very next recommendation.
test('a deload state change is visible to the next recommendation request', async () => {
  resetSheet();
  sheets._resetExerciseCatalogCache();
  const stateSeenBy = async (lift = LIFTS[0]) => {
    const res = await call('GET', `/api/recommend/next/${lift.code}?intentId=work_day&w=${lift.w}&reps=${lift.reps}&rir=2`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body?.data?.deload ?? res.body?.deload ?? null;
  };

  const before = await stateSeenBy();
  assert.equal(before?.in_deload, false, 'precondition: the session starts outside a deload');

  // begin — appended straight to the sheet, exactly as the lifecycle does.
  SHEET.Deload_State.push(['2026-08-05T10:00:00.000Z', 'DELOAD_ACTIVE', 'volume_cut_40', 'fatigue', '2026-08-05', '2', '']);
  const during = await stateSeenBy();
  assert.equal(during?.in_deload, true,
    'the recommendation after begin read a stale Deload_State — a cached training state is exactly what must never happen');

  // advance — still active, one session left.
  SHEET.Deload_State.push(['2026-08-05T11:00:00.000Z', 'DELOAD_ACTIVE', 'volume_cut_40', 'fatigue', '2026-08-05', '1', '']);
  assert.equal((await stateSeenBy())?.in_deload, true, 'advance must remain visible as an active deload');

  // resolve — back to NORMAL.
  SHEET.Deload_State.push(['2026-08-05T12:00:00.000Z', 'NORMAL', '', '', '', '', '']);
  assert.equal((await stateSeenBy())?.in_deload, false,
    'the recommendation after resolve is still reporting a deload — Deload_State was served from a cache');
});

// ── 6. the cache contract the budget rests on ────────────────────────────────
test('the Exercise_Catalog cache expires, single-flights, and never serves a stale value', async () => {
  sheets._resetExerciseCatalogCache();
  resetSheet();
  countingOn = true;
  reads.length = 0;

  let clock = 1_000_000;
  const now = () => clock;

  const first = await sheets.getExerciseCatalog({ now });
  assert.deepEqual(first, CATALOG);
  assert.equal(reads.length, 1, 'the first call reads');

  await sheets.getExerciseCatalog({ now });
  assert.equal(reads.length, 1, 'a call inside the TTL does not read');

  // Bounded TTL: no more than 60 seconds.
  assert.ok(sheets.CATALOG_CACHE_TTL_MS <= 60_000, 'the catalog TTL must not exceed 60s');
  clock += sheets.CATALOG_CACHE_TTL_MS;
  await sheets.getExerciseCatalog({ now });
  assert.equal(reads.length, 2, 'an expired entry is discarded and re-read, never reused');

  // Single-flight: simultaneous misses cost ONE request.
  sheets._resetExerciseCatalogCache();
  reads.length = 0;
  await Promise.all([0, 1, 2, 3, 4].map(() => sheets.getExerciseCatalog({ now })));
  assert.equal(reads.length, 1, 'five simultaneous misses must produce one Sheets request');

  countingOn = false;
});

// ── 7. a failed refresh propagates; it never falls back and never fabricates ──
test('a failed catalog refresh throws with its read-failure class and serves no stale value', async () => {
  sheets._resetExerciseCatalogCache();
  resetSheet();
  let clock = 2_000_000;
  const now = () => clock;

  await sheets.getExerciseCatalog({ now });          // warm
  clock += sheets.CATALOG_CACHE_TTL_MS;              // expire

  const good = SHEET.Exercise_Catalog;
  delete SHEET.Exercise_Catalog;                     // the refresh will now fail
  try {
    await assert.rejects(() => sheets.getExerciseCatalog({ now }),
      /Unable to parse range/,
      'an expired entry must never be served after a failed refresh');
  } finally {
    SHEET.Exercise_Catalog = good;
  }

  // …and it never fabricates an empty catalog out of the failure.
  const recovered = await sheets.getExerciseCatalog({ now });
  assert.deepEqual(recovered, CATALOG, 'the next successful read returns the real catalog');
});
