'use strict';

// LIVE SESSION READ BUDGET — the trace-derived guard.
//
// This replaces `test/sessionReadBudget.test.js` as the AUTHORITY for the session read
// budget. That file's hand-authored `ownerPatternSequence` measured 46 reads for a
// complete session and PR #1271 merged on it; the authorized non-counting debug run then
// measured 116 observable reads, a rolling-60s peak of 87, and 429s. The sequence was the
// defect. It survives only as a smaller unit scenario and authorizes nothing.
//
// The sequence here is `test/fixtures/liveSessionManifest.json` — the exact client request
// manifest captured from that failed run: 113 `/api` requests, in order, with their real
// multiplicity. Repeated requests are not compressed, no request is dropped, and no
// "representative" call stands in for several. `test/helpers/liveSessionHarness.js` turns
// it into a driveable sequence and nothing about the ordering is invented.
//
// Reads are counted at the googleapis boundary — every `values.get`, `values.batchGet` and
// `spreadsheets.get`, first attempts and retries alike — so nothing above that layer can
// under-report.

const test = require('node:test');
const assert = require('node:assert/strict');

const BUDGET = 50;              // peak reads per rolling 60s. Google's real limit is 60.
const GOOGLE_LIMIT = 60;

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
process.env.ATLAS_INTENT_ROUTER = 'shadow';
process.env.ATLAS_COACH_ENGINE = 'hybrid';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_IDEMPOTENCY_FILE = require('node:path').join(
  require('node:os').tmpdir(), 'atlas-live-session-read-budget-idempotency.json');
// The qualifying ledger posture the combined rehearsal sets
// (`tests/e2e/gate/gate-server.js`). Set before index.js loads;
// SESSION_PLAN_SETS_WRITE_ENABLED is captured at module load.
process.env.ATLAS_SESSION_PLANS_WRITE = '1';
process.env.SESSION_PLAN_SETS_WRITE_ENABLED = '1';

const {
  logCleanedColumns, effortColumns, deloadStateColumns,
  sessionPlansColumns, sessionPlanSetsColumns, constraintsColumns,
} = require('../config/columns');

const LOG_HEADER = [...logCleanedColumns];
const EFFORT_HEADER = [...effortColumns];
const DELOAD_HEADER = [...deloadStateColumns];
const PLANS_HEADER = [...sessionPlansColumns];
const PLAN_SETS_HEADER = [...sessionPlanSetsColumns];

const harness = require('./helpers/liveSessionHarness');
const { LIFTS, SESSION_ID, liveSessionSequence, manifestEndpointCounts, MANIFEST } = harness;

const CATALOG = [
  ['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
  ...LIFTS.map(l => [l.name, l.name, 'x', l.code]),
];

function historyRows() {
  const rows = [LOG_HEADER];
  for (let session = 1; session <= 6; session++) {
    for (const lift of LIFTS) {
      for (let set = 1; set <= 3; set++) {
        rows.push([`2026-07-${String(10 + session).padStart(2, '0')}`, `202607${10 + session}-PM-01`,
          lift.name, lift.name, 'x', lift.code, String(set), String(lift.w), String(lift.reps), '2', '',
          String(lift.w * lift.reps)]);
      }
    }
  }
  return rows;
}

let SHEET = {};
function resetSheet() {
  SHEET = {
    Log_Cleaned: historyRows(),
    Effort: [EFFORT_HEADER],
    Deload_State: [DELOAD_HEADER, ['2026-08-01T00:00:00.000Z', 'NORMAL', '', '', '', '', '']],
    Session_Plans: [PLANS_HEADER],
    Session_Plan_Sets: [PLAN_SETS_HEADER],
    Exercise_Catalog: CATALOG,
    Constraints: [[...constraintsColumns]],
    Coaching_Notes: [['date', 'note']],
  };
}
resetSheet();

function valuesForRange(range) {
  const text = String(range || '');
  const bang = text.indexOf('!');
  const tab = bang === -1 ? text : text.slice(0, bang);
  const spec = bang === -1 ? '' : text.slice(bang + 1);
  const rows = SHEET[tab];
  if (!rows) return { error: new Error(`Unable to parse range: ${text}`) };
  if (/^1:1$/.test(spec)) return { values: [rows[0]] };
  const a1 = /^([A-Z]+)(\d*):([A-Z]+)(\d*)$/.exec(spec);
  if (!a1) return { values: rows };
  const col = (letters) => letters.split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  const [, c1, r1, c2, r2] = a1;
  const first = r1 ? Number(r1) - 1 : 0;
  const last = r2 ? Number(r2) : rows.length;
  return { values: rows.slice(first, last).map(row => row.slice(col(c1), col(c2) + 1)) };
}

// ── the measurement point ────────────────────────────────────────────────────
const reads = [];
let countingOn = false;
function recordRead(api, ranges) {
  if (countingOn) reads.push({ at: Date.now(), api, ranges });
}

const fakeSheetsClient = {
  spreadsheets: {
    get: async () => {
      recordRead('spreadsheets.get', ['spreadsheet metadata']);
      return { data: { sheets: Object.keys(SHEET).map(title => ({ properties: { title, sheetId: 1 } })) } };
    },
    batchUpdate: async () => ({ data: {} }),
    values: {
      get: async ({ range }) => {
        recordRead('values.get', [range]);
        const out = valuesForRange(range);
        if (out.error) throw out.error;
        return { data: { values: out.values } };
      },
      batchGet: async ({ ranges }) => {
        recordRead('values.batchGet', ranges);
        const valueRanges = [];
        for (const range of ranges) {
          const out = valuesForRange(range);
          if (out.error) throw out.error;
          valueRanges.push({ range, values: out.values });
        }
        return { data: { valueRanges } };
      },
      append: async ({ range, requestBody }) => {
        const tab = String(range).split('!')[0];
        if (!SHEET[tab]) SHEET[tab] = [];
        for (const row of requestBody.values) SHEET[tab].push(row.map(v => (v == null ? '' : String(v))));
        const n = requestBody.values.length;
        const last = SHEET[tab].length;
        return { data: { updates: { updatedRows: n, updatedRange: `${tab}!A${last - n + 1}:Z${last}` } } };
      },
      update: async () => ({ data: {} }),
      batchUpdate: async ({ requestBody }) => {
        let totalUpdatedCells = 0;
        for (const entry of requestBody?.data || []) {
          const [tab, spec] = String(entry.range).split('!');
          const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(spec || '');
          const rows = SHEET[tab];
          if (!m || !rows) continue;
          const col = m[1].split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
          const firstRow = Number(m[2]);
          (entry.values || []).forEach((rowValues, i) => {
            const sheetRow = rows[firstRow - 1 + i];
            if (!sheetRow) return;
            rowValues.forEach((value, j) => { sheetRow[col + j] = String(value == null ? '' : value); });
            totalUpdatedCells += rowValues.length;
          });
        }
        return { data: { totalUpdatedCells } };
      },
    }
  }
};

const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, loaded: true,
  exports: { google: { auth: { GoogleAuth: class { async getClient() { return {}; } } }, sheets: () => fakeSheetsClient } }
};
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true,
  exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
};

const sheets = require('../sheets');
const { resetIdempotencyStore } = require('../services/idempotency');
const { app } = require('../index');

let server; let baseUrl;
test.before(async () => {
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

async function call(method, url, body) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { method, url, path: url.split('?')[0], status: res.status, body: await res.json().catch(() => null) };
}

/** Wait until no new read has been recorded for `quietMs` — deferred reads must be counted. */
async function settle({ quietMs = 500, maxMs = 15_000 } = {}) {
  const deadline = Date.now() + maxMs;
  let seen = -1;
  while (reads.length !== seen && Date.now() < deadline) {
    seen = reads.length;
    await new Promise(resolve => setTimeout(resolve, quietMs));
  }
}

function peakRollingMinute(records) {
  const stamps = records.map(r => r.at).sort((a, b) => a - b);
  let peak = 0; let start = 0;
  for (let end = 0; end < stamps.length; end++) {
    while (stamps[end] - stamps[start] >= 60_000) start++;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

function breakdown(records) {
  const byKey = new Map();
  for (const r of records) {
    const key = r.api === 'values.batchGet' ? `batchGet[${r.ranges.length}]` : r.ranges[0];
    byKey.set(key, (byKey.get(key) || 0) + 1);
  }
  return [...byKey.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} × ${k}`).join('\n  ');
}

let runSeq = 0;
async function runLiveSession({ requestContext = true, coldCatalogPerRequest = false } = {}) {
  runSeq += 1;
  resetIdempotencyStore();
  resetSheet();
  sheets._resetExerciseCatalogCache();
  await settle({ quietMs: 250, maxMs: 4000 });
  reads.length = 0;
  countingOn = true;

  const results = [];
  const realRunWithReadContext = sheets.runWithReadContext;
  if (!requestContext) sheets.runWithReadContext = (fn) => fn();
  try {
    for (const [method, url, body] of liveSessionSequence({ runId: `r${runSeq}` })) {
      if (coldCatalogPerRequest) sheets._resetExerciseCatalogCache();
      results.push(await call(method, url, body));
    }
    await settle();
  } finally {
    sheets.runWithReadContext = realRunWithReadContext;
    countingOn = false;
  }

  return {
    results,
    total: reads.length,
    peak: peakRollingMinute(reads),
    breakdown: breakdown(reads),
    byApi: reads.reduce((acc, r) => { acc[r.api] = (acc[r.api] || 0) + 1; return acc; }, {}),
    catalog: reads.filter(r => r.ranges.some(x => String(x).startsWith('Exercise_Catalog'))).length,
    ledgerRows: {
      plans: SHEET.Session_Plans.map(r => [...r]),
      sets: SHEET.Session_Plan_Sets.map(r => [...r]),
      log: SHEET.Log_Cleaned.map(r => [...r]),
    },
  };
}

// ── fixture integrity: the manifest must be replayed, not summarised ─────────
test('the harness replays the live manifest exactly — nothing compressed, nothing dropped', () => {
  const sequence = liveSessionSequence();
  assert.equal(sequence.length, MANIFEST.requests.length,
    'every manifest request must be driven');

  const driven = new Map();
  for (const [method, url] of sequence) {
    const key = `${method} ${url.split('?')[0]}`;
    driven.set(key, (driven.get(key) || 0) + 1);
  }
  const expected = manifestEndpointCounts();
  for (const [endpoint, count] of expected) {
    assert.equal(driven.get(endpoint), count,
      `${endpoint} must be driven ${count}× as the live client did, got ${driven.get(endpoint)}`);
  }
  assert.equal(driven.size, expected.size, 'no endpoint may be added or omitted');

  // The shape the manifest actually shows, pinned so a future edit cannot quietly revert
  // to the twelve-live-Saves model the previous harness assumed.
  const saves = sequence.filter(([, url]) => url.split('?')[0] === '/api/log-workout');
  assert.equal(saves.length, 14, 'the live client issued fourteen /api/log-workout requests');
  assert.equal(saves.filter(([, , body]) => body && body.test_mode === true).length, 13,
    'thirteen of them are test_mode previews');
  const live = saves.filter(([, , body]) => body && !body.test_mode);
  assert.equal(live.length, 1, 'exactly one is a live write');
  assert.equal(live[0][2].log_rows.length, 12,
    'the live write carries all twelve rows — verify-range?expected_rows=12 in the manifest');
  assert.ok(live[0][2].closeout_context, 'the live write is the closeout');
});

// ── REPRODUCTION — required before any product correction is believed ────────
//
// A corrective is only meaningful if its guard fails on the defect. Measured on merged
// main (42ee7b3) this fixture peaks at exactly 60 reads in a rolling minute — AT Google's
// per-minute limit, and ten over the 50 budget. A session sitting exactly at the limit has
// zero headroom: the first retry tips it over, which is precisely what happened live.
//
// It reproduces the failure without its full magnitude, and the gap is stated rather than
// smoothed over. The live run measured 116 observable reads with a peak of 87, because
// (a) its retries were real and are not modelled here, and (b) a fake googleapis answers
// instantly, so 70.9s of live traffic compresses into about a second. This harness is
// therefore a LOWER BOUND on live demand. It is still the right authority: it is the real
// request manifest, and it already proves the session cannot fit.
//
// The threshold is `>= GOOGLE_LIMIT`, not `> GOOGLE_LIMIT`. An earlier version asserted
// `> 60` against a value that measures exactly 60 — a guard pinned to the boundary it sits
// on, which passed locally at 61 and failed in CI at 60. A flaky guard is worse than a
// weak one; this one states the fact that is true and stable.
test('REPRODUCTION: the live manifest cannot fit inside the read quota before correction', async () => {
  const run = await runLiveSession();
  assert.ok(run.total > 0, 'the sequence must actually read the sheet');
  assert.ok(run.peak >= GOOGLE_LIMIT,
    `the live manifest must reproduce the quota failure (peak >= ${GOOGLE_LIMIT}); measured ${run.peak}.\n` +
    `  If this stops failing, the fixture has stopped modelling the session that failed.\n  ${run.breakdown}`);
  assert.ok(run.peak > BUDGET,
    `and it must be over the ${BUDGET} budget; measured ${run.peak}`);
});

// ── the observe-only route must stay observe-only ────────────────────────────
//
// `/api/debug/intent-observe` declares itself observation-only: it classifies a message
// and appends a diagnostics row. It must perform NO Google Sheets read — not a workout
// lookup, not a ledger lookup, not an identity lookup.
//
// This is a contract guard, not a fix. No hidden read producer was found: the route reads
// nothing today, and exact request-scoped attribution shows zero reads from its sixteen
// calls. The twenty reads the earlier report attributed to it were an artefact of the
// reconstruction tool's next-completed-request heuristic and belonged to concurrent
// requests. The guard exists so that stays true.
test('POST /api/debug/intent-observe performs zero Sheets reads', async () => {
  resetSheet();
  resetIdempotencyStore();
  sheets._resetExerciseCatalogCache();
  await settle({ quietMs: 300, maxMs: 5000 });
  reads.length = 0;
  countingOn = true;
  let observed;
  try {
    observed = await call('POST', '/api/debug/intent-observe', {
      message: 'Back Squat 225 5/2', request_origin: 'athlete_ui', app_version: 'guard',
    });
    // The shadow lane is fire-and-forget, so a read it performs can land AFTER the
    // response. Waiting for quiet is what makes "zero" mean zero.
    await settle();
  } finally {
    countingOn = false;
  }
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  assert.deepEqual(reads.map(r => `${r.api} ${r.ranges.join(', ')}`), [],
    'an observation-only route must not read the athlete\'s data');
});

module.exports = { runLiveSession, BUDGET, GOOGLE_LIMIT, SESSION_ID };
