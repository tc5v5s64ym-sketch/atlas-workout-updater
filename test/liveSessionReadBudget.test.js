'use strict';

// LIVE SESSION READ BUDGET — the compressed stress simulation over the captured manifest.
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
const fs = require('node:fs');
const path = require('node:path');

// The acceptance bound for the COMPRESSED SIMULATION below. Google's real limit is 60; 50
// leaves room for a session that drifts. Meeting it is not a rolling-minute verdict on
// production — see the guard's own comment, and docs/READ_BUDGET.md.
const BUDGET = 50;
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

// THE COACH LLM IS PINNED, and that is part of the measurement, not a convenience.
//
// `/api/coach/chat` branches on whether a Gemini key is configured: configured, it grounds
// the reply with ONE batchGet over Coaching_Notes + Constraints + Log_Cleaned; unconfigured,
// it answers from client context and reads nothing. Production runs configured — and the
// captured session came from production — so the configured branch is the one the budget
// must model, and it is the more expensive of the two.
//
// Before this, the branch was decided by whatever `GEMINI_API_KEY` happened to be in the
// runner's environment: 46 reads with a key present, 45 without, and a real network call to
// Gemini on any machine that had one. Installed BEFORE index.js so the app never sees the
// ambient value. See test/helpers/fakeCoachLlm.js.
const { installFakeCoachLlm, geminiCallCount } = require('./helpers/fakeCoachLlm');
installFakeCoachLlm();

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
const { SESSION_DATE } = harness;
const {
  LIFTS, SESSION_ID, liveSessionSequence, manifestEndpointCounts, correctionLedger, MANIFEST,
} = harness;

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

// ── the VIRTUAL CLOCK ────────────────────────────────────────────────────────
//
// The captured session ran for 70.945 s. Driving its 113 requests back to back — as this
// harness used to — is not the same session: every request lands inside ONE rolling minute
// that live timing spread across seventy seconds, and the server's 30-second row cache never
// expires, where a real session expires it twice over. The first inflates the peak, the
// second deflates the total, and neither is the captured run.
//
// So the ORIGINAL timing is replayed, on a clock the test owns. `Date.now()` reports the
// current request's captured `offset_ms`; the suite still finishes in about a second because
// nothing actually waits. The row cache reads `Date.now()` (`services/cache.js`), so it
// expires exactly where it would have during the captured session, and every read attempt is
// stamped with its simulated time so `peakRollingMinute` measures a real rolling minute.
//
// `REAL_NOW` is the untouched clock, kept for anything that must measure wall time — the
// `settle()` deadline above would never expire against a clock that only moves when a
// request is dispatched.
const REAL_NOW = Date.now;
let virtualNow = REAL_NOW();
let virtualClockOn = false;
Date.now = () => (virtualClockOn ? virtualNow : REAL_NOW());

/** Move the simulated clock to `offsetMs` into the session. Never moves backwards. */
function setVirtualOffset(baseMs, offsetMs) {
  virtualNow = baseMs + offsetMs;
}

// ── the measurement point ────────────────────────────────────────────────────
const reads = [];
let countingOn = false;
function recordRead(api, ranges) {
  if (countingOn) reads.push({ at: Date.now(), api, ranges });
}

// Failure injection, used only by the retry-accounting guard below. `failNextReads` is the
// number of upcoming read calls that must fail transiently before the fake starts answering.
let failNextReads = 0;
function maybeFail() {
  if (failNextReads <= 0) return;
  failNextReads -= 1;
  const error = new Error('The service is currently unavailable.');
  error.code = 503;
  error.response = { status: 503 };
  throw error;
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
        maybeFail();
        const out = valuesForRange(range);
        if (out.error) throw out.error;
        return { data: { values: out.values } };
      },
      batchGet: async ({ ranges }) => {
        recordRead('values.batchGet', ranges);
        maybeFail();
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

// WHICH BRANCH DID THE ROUTE TAKE?
//
// A status alone does not say. `/api/suggest-substitute` answers 200 both when it reads
// history to recommend a swap AND when it early-returns "not a constraint message" — and
// the reconstructed body used to take the cheap branch, so the session was measured against
// a request it never made. A bounded signature makes the branch itself an assertion.
//
// Each entry extracts 1–3 STABLE facts from the response. Never a whole body (that would
// pin wording and churn), never nothing (that would pin only cardinality).
const BRANCH_SIGNATURE = {
  '/api/suggest-substitute': d => `recommendation:${d && d.recommendation ? 'present' : 'null'}`,
  '/api/parse-workout-text': d => `intent:${d && d.parsed ? (d.parsed.intent || 'none') : 'no-parse'}` +
    `|sets:${d && d.parsed && Array.isArray(d.parsed.sets) ? (d.parsed.sets.length > 0 ? 'some' : 'none') : 'none'}` +
    `|no_write:${d ? d.no_write_confirmed === true : false}`,
  '/api/log-workout': d => (d && d.test_mode === true
    ? `preview|no_write_confirmed:${d.no_write_confirmed === true}|wrote_nothing:${d.sheet_written === false}`
    : `live|sheet_write:${d && d.sheet_write}|verified:${d && d.log_write_verification && d.log_write_verification.verified}`),
  // `kind` echoes the branch the route took, `note_tier` the deterministic gate's verdict.
  // A body sending kind 'set' (as the reconstruction used to) reports a different kind here.
  '/api/coach/message': d => `kind:${(d && d.kind) || 'none'}|tier:${(d && d.note_tier) || 'none'}`,
  '/api/coach/chat': d => `served:${d && d.message ? 'yes' : 'no'}`,
  '/api/coach/ask': d => `depth:${(d && d.depth) || 'none'}`,
  '/api/debug/intent-observe': d => `observed:${d && d.observed !== false ? 'yes' : 'no'}`,
  '/api/log-modality': d => `no_write:${d ? d.no_write_confirmed === true : false}`,
  '/api/session-plans/accept': d => `captured:${d && d.session_plans && d.session_plans.captured}`,
  '/api/session-plans/outcome': d => `captured:${d && d.session_plans && d.session_plans.captured}`,
  '/api/session-plan-sets/accept': d => `captured:${d && d.session_plan_sets && d.session_plan_sets.captured}`,
  '/api/session-plan-sets/revision': d => `captured:${d && d.session_plan_sets && d.session_plan_sets.captured}`,
  '/api/log-workout/verify-range': d => `verified:${d && d.verified}`,
};

/** `STATUS signature` for one driven request, or `STATUS` where no signature is defined. */
function outcomeOf(result) {
  const sign = BRANCH_SIGNATURE[result.path];
  if (!sign) return String(result.status);
  let signature;
  try { signature = sign((result.body && result.body.data) || null); } catch (_) { signature = 'signature-threw'; }
  return `${result.status} ${signature}`;
}

/** Wait until no new read has been recorded for `quietMs` — deferred reads must be counted. */
async function settle({ quietMs = 500, maxMs = 15_000 } = {}) {
  const deadline = REAL_NOW() + maxMs;
  let seen = -1;
  while (reads.length !== seen && REAL_NOW() < deadline) {
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
/**
 * @param opts.compressed  Drive every request at offset 0 — the OLD behaviour, kept only so
 *   a guard can prove that compressing the timeline changes the answer. It is never the
 *   measurement.
 */
async function runLiveSession({
  requestContext = true, coldCatalogPerRequest = false, corrected = false, compressed = false,
} = {}) {
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
  // A fresh base each run, so one run's cache entries can never be live in the next.
  const base = REAL_NOW() + runSeq * 10 * 60_000;
  setVirtualOffset(base, 0);
  virtualClockOn = true;
  try {
    for (const [method, url, body, meta] of liveSessionSequence({ runId: `r${runSeq}`, corrected })) {
      // The request is dispatched AT its captured offset. Deferred work it triggers (the
      // fire-and-forget shadow appends) settles at that same simulated instant, which is
      // where the live run's own deferred work landed too — within milliseconds of its
      // request.
      setVirtualOffset(base, compressed ? 0 : (meta && meta.offsetMs) || 0);
      if (coldCatalogPerRequest) sheets._resetExerciseCatalogCache();
      results.push(await call(method, url, body));
    }
    // Anything still in flight settles at the end of the captured session, not beyond it.
    await settle();
  } finally {
    virtualClockOn = false;
    sheets.runWithReadContext = realRunWithReadContext;
    countingOn = false;
  }

  return {
    results,
    outcomes: results.map(r => `${r.method} ${r.path} -> ${outcomeOf(r)}`),
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
//
// THE CAPTURED EVIDENCE, written out as literals. This is deliberately a SECOND copy of the
// same facts, because `manifestEndpointCounts()` reads the manifest itself: derived from the
// fixture, it agrees with the fixture no matter what the fixture says, so deleting a request
// from the JSON would change both sides together and pass. Only an independent expectation
// can catch that, so the counts below come from the captured run and are transcribed here.
// Editing the fixture without editing this table is what fails.
const CAPTURED_TOTAL_REQUESTS = 113;
const CAPTURED_SPAN_MS = 70945;
const CAPTURED_ENDPOINT_COUNTS = [
  ['GET /api/catalog/exercises', 1],
  ['GET /api/coaching/insights', 3],
  ['GET /api/exercises/last-session', 6],
  ['GET /api/flight/recent', 1],
  ['GET /api/history/recent', 2],
  ['GET /api/log-workout/verify-range', 1],
  ['GET /api/plan/intent-recommendation', 3],
  ['GET /api/plan/today', 2],
  ['GET /api/progress/summary', 2],
  ['GET /api/prs/recent', 3],
  ['GET /api/recommend/next/BC01', 3],
  ['GET /api/recommend/next/IDB01', 3],
  ['GET /api/recommend/next/OHP01', 3],
  ['GET /api/recommend/next/RDL01', 3],
  ['GET /api/recommend/next/SQ01', 4],
  ['GET /api/recommend/next/SR01', 3],
  ['GET /api/report/weekly', 1],
  ['GET /api/session/status', 1],
  ['GET /api/stalls', 3],
  ['GET /api/summary/weekly', 3],
  ['POST /api/coach/ask', 1],
  ['POST /api/coach/chat', 1],
  ['POST /api/coach/message', 7],
  ['POST /api/debug/intent-observe', 16],
  ['POST /api/log-modality', 1],
  ['POST /api/log-workout', 14],
  ['POST /api/parse-workout-text', 15],
  ['POST /api/session-plan-sets/accept', 1],
  ['POST /api/session-plan-sets/revision', 2],
  ['POST /api/session-plans/accept', 1],
  ['POST /api/session-plans/outcome', 1],
  ['POST /api/suggest-substitute', 2],
];

test('the fixture still holds the captured session — no request added, removed or renamed', () => {
  assert.equal(MANIFEST.requests.length, CAPTURED_TOTAL_REQUESTS,
    'the captured run made exactly this many /api requests');
  assert.equal(MANIFEST.span_ms, CAPTURED_SPAN_MS, 'the captured run spanned exactly this long');
  assert.deepEqual(
    [...manifestEndpointCounts().entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    CAPTURED_ENDPOINT_COUNTS,
    'the fixture no longer matches the captured evidence — every difference must be a ' +
    'correction to what was captured, made deliberately, with the table above updated to match'
  );
});

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

// ── MEASURED STATE ──────────────────────────────────────────────────────────
//
// WHAT REPLAYING THE REAL TIMING COST THIS CLAIM — stated plainly, because it retires one.
//
// Under the collapsed timeline this harness used to run, the captured client measured a peak
// of 55 and the guard below asserted it "still overruns the budget of 50". Replaying the
// captured offsets, the captured client peaks at 46 — UNDER the budget. The overrun was an
// artefact of driving seventy seconds of traffic inside one rolling minute.
//
// SO THIS FIXTURE NO LONGER REPRODUCES THE LIVE FAILURE, and it is not made to. The live run
// measured 116 attempts with a peak of 87; the gap is the retries, which Google meters like
// any other request and which this harness does not model. Once the timeline is honest, the
// captured client's unretried demand simply is not over the limit — the quota storm was the
// retries compounding on top of it.
//
// What the captured client is still good for is the comparison, and that is what this guard
// keeps: the same requests, the same timing, the same server, with and without the client
// corrections. That difference is caused by the corrections and nothing else.
test('the captured client costs measurably more than the corrected one, same timing', async () => {
  const captured = await runLiveSession();
  const corrected = await runLiveSession({ corrected: true });
  assert.ok(captured.total > 0, 'the sequence must actually read the sheet');

  assert.equal(captured.peak, 46,
    `the published captured peak is 46; measured ${captured.peak}\n  ${captured.breakdown}`);
  assert.equal(captured.total, 56,
    `the published captured total is 56; measured ${captured.total}`);

  assert.ok(captured.peak > corrected.peak,
    `the corrections must reduce the worst minute: captured ${captured.peak}, corrected ` +
    `${corrected.peak}. Equal figures mean the corrections stopped removing requests.`);
  assert.ok(captured.total > corrected.total,
    `and the whole session: captured ${captured.total}, corrected ${corrected.total}`);

  // Both are below Google's limit here, and that is expected once retries are excluded —
  // asserted so nobody reads a passing suite as "the failing session now fits".
  assert.ok(captured.peak < GOOGLE_LIMIT,
    `unretried, the captured client is under Google's ${GOOGLE_LIMIT} — the live overrun was ` +
    `driven by retries this harness does not model, measured ${captured.peak}`);
});

// COMPRESSION IS NOT THE MEASUREMENT — and this proves it, rather than asserting it.
//
// The whole defect this replay fixes is that a collapsed timeline answers a different
// question. So the collapsed model is kept runnable for exactly one purpose: to show that it
// disagrees, and that the figures it produces would not be accepted.
test('collapsing the captured timing into one instant changes the answer and fails acceptance', async () => {
  const timed = await runLiveSession({ corrected: true });
  const collapsed = await runLiveSession({ corrected: true, compressed: true });

  // It changes the answer.
  assert.notEqual(collapsed.peak, timed.peak,
    'collapsing 70.9 s into one instant must change the rolling-minute peak; if it does ' +
    'not, the offsets are no longer being replayed and neither figure means anything');
  assert.ok(collapsed.peak > timed.peak,
    `collapsing inflates the peak by putting every request in one minute: collapsed ` +
    `${collapsed.peak} vs replayed ${timed.peak}`);

  // Its structural signature: every read inside one rolling minute, so peak IS total.
  assert.equal(collapsed.peak, collapsed.total,
    'a collapsed session has all its reads in one rolling minute, so peak equals total');

  // And it fails acceptance: the published figures are the replayed ones, so a collapsed
  // measurement cannot satisfy the guard that pins them. This is the assertion that bites
  // if the replay is ever removed — the acceptance test pins 39/48, and collapsed is 47/47.
  assert.notEqual(collapsed.peak, 39,
    'the acceptance guard pins the replayed peak of 39; a collapsed run must not be able ' +
    'to satisfy it');
  assert.ok(collapsed.total < timed.total,
    `collapsing also hides real reads — the 30-second row cache never expires inside one ` +
    `instant: collapsed total ${collapsed.total} vs replayed ${timed.total}`);
});

// ── the CORRECTED client ─────────────────────────────────────────────────────
//
// The budget is spent by the client that will actually run, and the corrective's whole
// point is that it must ASK FOR LESS. The captured manifest is the client BEFORE the
// corrections; the corrected sequence is that same manifest with each proven client change
// applied — see CLIENT_CORRECTIONS in the harness.
//
// The corrected list cannot be captured: running another live debug session is not
// authorized. It is derived instead, and the derivation is guarded — every correction must
// remove a request the captured manifest really contains, and must name the tests that
// prove the client no longer issues it. Nothing is dropped because "the fixture reads
// nothing there".
// EXACTLY what the corrected client no longer asks for, pinned as literals.
//
// Without this, the ledger check below is weaker than it looks: it proves a correction
// removes SOMETHING real and names a file that EXISTS, so a correction claiming to remove
// `/api/coach/message` — seven requests the client certainly still issues — would pass, and
// the budget would only get easier. A pinned list makes any change to what is removed fail
// until it is written down here, in front of the reviewer.
const REMOVED_BY_CORRECTIONS = [
  'GET /api/coaching/insights #1',
  'GET /api/log-workout/verify-range #0',
  'GET /api/plan/intent-recommendation #1',
  'GET /api/prs/recent #2',
  'GET /api/recommend/next/BC01 #1',
  'GET /api/recommend/next/IDB01 #1',
  'GET /api/recommend/next/OHP01 #1',
  'GET /api/recommend/next/RDL01 #1',
  'GET /api/recommend/next/SQ01 #1',
  'GET /api/recommend/next/SR01 #1',
];

test('every client correction removes a real captured request and names its guard', () => {
  const ledger = correctionLedger();
  assert.ok(ledger.length > 0, 'the corrected client must differ from the captured one');
  for (const correction of ledger) {
    assert.ok(correction.removed.length > 0,
      `${correction.id} removes nothing from the captured manifest — a correction that ` +
      'matches no real request is a comment, not a reduction');
    assert.ok(correction.why && correction.why.length > 20, `${correction.id} must say why`);
    assert.ok(correction.guards && correction.guards.length > 0,
      `${correction.id} must name the test(s) proving the client no longer issues it`);

    // The guard must actually be ABOUT the request it excuses. A filename that merely exists
    // proves nothing; a guard that never mentions the path it is cited for is not evidence
    // that the client stopped issuing it.
    const guardText = correction.guards.map(guard => {
      const full = path.join(__dirname, '..', guard);
      assert.ok(fs.existsSync(full), `${correction.id} names guard ${guard}, which does not exist`);
      return fs.readFileSync(full, 'utf8');
    }).join('\n');
    for (const removed of correction.removed) {
      const removedPath = removed.split(' ')[1].split(' #')[0];
      // The exact path, or its ROUTE FAMILY. `/api/recommend/next/{code}` is one rule proved
      // once — the lift code is just part of the URL key — so a guard that exercises BEN01
      // covers OHP01. Anything looser than the route would stop being a link at all.
      const family = removedPath.slice(0, removedPath.lastIndexOf('/') + 1);
      assert.ok(guardText.includes(removedPath) || guardText.includes(family),
        `${correction.id} removes ${removedPath}, but none of its guards ` +
        `(${correction.guards.join(', ')}) mentions that path or its route ${family} — ` +
        'the citation is not evidence');
    }
  }

  // And exactly these requests, no others.
  assert.deepEqual(ledger.flatMap(c => c.removed).sort(), REMOVED_BY_CORRECTIONS,
    'the set of removed requests changed. Every entry here is a request the live client made ' +
    'and the corrected client provably does not — update this list deliberately, or the ' +
    'budget below is measuring a session the client would still cause.');

  // The corrected sequence differs from the captured one ONLY by those removals — checked
  // by rebuilding it independently from the ledger's exact "METHOD path #occurrence" keys,
  // not by trusting the same filter the harness used.
  const captured = liveSessionSequence();
  const corrected = liveSessionSequence({ corrected: true });
  const removedKeys = new Set(ledger.flatMap(c => c.removed));
  assert.equal(removedKeys.size, ledger.reduce((n, c) => n + c.removed.length, 0),
    'two corrections must not claim the same request');

  const seen = new Map();
  const expected = captured.filter(([method, url]) => {
    const p = url.split('?')[0];
    const n = seen.get(p) || 0;
    seen.set(p, n + 1);
    return !removedKeys.has(`${method} ${p} #${n}`);
  });
  assert.equal(corrected.length, captured.length - removedKeys.size,
    'the corrected sequence may differ from the captured manifest only by the ledger');
  assert.deepEqual(corrected.map(([m, u]) => `${m} ${u}`), expected.map(([m, u]) => `${m} ${u}`),
    'order and multiplicity of every surviving request must be untouched');
});

// EVERY REQUEST'S STATUS AND BRANCH, pinned.
//
// The exact-head review found the reconstructed `/api/suggest-substitute` body taking a
// cheap early-return instead of the history-reading branch — invisible, because the route
// answers 200 either way and only `/api/log-workout` was ever asserted. These are the
// outcomes each route must produce, and a body that stops reaching its real branch changes
// one of them.
const EXPECTED_OUTCOMES = [
  'GET /api/catalog/exercises -> 200',
  'GET /api/coaching/insights -> 200',
  'GET /api/exercises/last-session -> 200',
  'GET /api/flight/recent -> 200',
  'GET /api/history/recent -> 200',
  'GET /api/plan/intent-recommendation -> 200',
  'GET /api/plan/today -> 200',
  'GET /api/progress/summary -> 200',
  'GET /api/prs/recent -> 200',
  'GET /api/recommend/next/BC01 -> 200',
  'GET /api/recommend/next/IDB01 -> 200',
  'GET /api/recommend/next/OHP01 -> 200',
  'GET /api/recommend/next/RDL01 -> 200',
  'GET /api/recommend/next/SQ01 -> 200',
  'GET /api/recommend/next/SR01 -> 200',
  'GET /api/report/weekly -> 200',
  'GET /api/session/status -> 200',
  'GET /api/stalls -> 200',
  'GET /api/summary/weekly -> 200',
  'POST /api/coach/ask -> 200 depth:coach_brief',
  'POST /api/coach/chat -> 200 served:yes',
  // kind 'block' is what the in-session client sends; the reconstruction used to send
  // 'set', which this line would report differently.
  'POST /api/coach/message -> 200 kind:block|tier:ack_only',
  'POST /api/debug/intent-observe -> 200 observed:yes',
  'POST /api/log-modality -> 200 no_write:true',
  'POST /api/log-workout -> 200 live|sheet_write:success|verified:true',
  'POST /api/log-workout -> 200 preview|no_write_confirmed:true|wrote_nothing:true',
  'POST /api/parse-workout-text -> 200 intent:log_sets|sets:some|no_write:true',
  'POST /api/session-plan-sets/accept -> 200 captured:true',
  'POST /api/session-plan-sets/revision -> 200 captured:true',
  'POST /api/session-plans/accept -> 200 captured:true',
  'POST /api/session-plans/outcome -> 200 captured:true',
  // The history-reading branch, not the early return. See the harness's body comment.
  'POST /api/suggest-substitute -> 200 recommendation:present',
];

test('every request in the session answers as expected, and takes the branch it should', async () => {
  const run = await runLiveSession({ corrected: true });
  assert.deepEqual([...new Set(run.outcomes)].sort(), EXPECTED_OUTCOMES,
    'a route answered differently, or took a different branch, than the session requires. ' +
    'A reconstructed request body that stops reaching its real branch shows up here — that ' +
    'is what this exists for.');

  // And every single driven request, not just one per distinct outcome.
  const unexpected = run.outcomes.filter(o => !EXPECTED_OUTCOMES.includes(o));
  assert.deepEqual(unexpected, [], 'every driven request must match a pinned outcome');
});

// THE ENVIRONMENT IS PART OF THE MEASUREMENT — so it is asserted, not assumed.
//
// The costly coach branch is reached only when the coach is configured. If that ever
// silently stops being true, every outcome above still passes except the one chat line, and
// the total quietly drops by one read — a budget that looks BETTER because it measured less.
// This pins the branch directly: the pinned model really answered, and the route really took
// the grounding path.
test('the session drives the CONFIGURED coach branch — the expensive one production runs', async () => {
  const coach = require('../services/coach');
  assert.equal(coach.isConfigured(), true,
    'the harness must present a configured coach; unconfigured, /api/coach/chat skips its ' +
    'grounding read and the budget measures a cheaper session than production runs');

  const before = geminiCallCount();
  const run = await runLiveSession({ corrected: true });
  assert.ok(geminiCallCount() > before,
    'no model call was served — the chat turn fell to the unconfigured path, so the ' +
    'grounding batchGet was never counted');

  assert.ok(run.outcomes.includes('POST /api/coach/chat -> 200 served:yes'),
    'the configured chat turn must answer with a message');

  // And the grounding read itself, by its exact ranges — the one read the two branches
  // disagree about.
  const grounding = reads.filter(r => r.ranges.length === 3
    && r.ranges.some(x => String(x).startsWith('Coaching_Notes'))
    && r.ranges.some(x => String(x).startsWith('Constraints'))
    && r.ranges.some(x => String(x).startsWith('Log_Cleaned')));
  assert.ok(grounding.length > 0,
    'the configured chat turn must perform its Coaching_Notes + Constraints + Log_Cleaned ' +
    'grounding read; without it the measurement is the unconfigured session');
});

// THE GUARD, and exactly what it does and does not establish.
//
// It measures a TRACE-DERIVED LOWER BOUND, not production. The session's captured timing is
// replayed on the virtual clock, so the rolling minute here is the session's real rolling
// minute and the 30-second row cache expires where it really would. What is still missing is
// the live run's RETRIES — Google meters them like any other request, and this harness does
// not model them at all. That omission only ever ADDS to the real number, which is what makes
// this figure a floor rather than a guess.
//
// So passing this proves the corrected client's worst captured minute costs 39 reads with
// retries excluded. It does not prove production fits its quota. The production verdict is
// the post-deploy non-counting debug run, and nothing here substitutes for it.
test(`corrected trace-derived lower bound <= ${BUDGET}; production budget not yet proven`, async () => {
  const run = await runLiveSession({ corrected: true });
  assert.ok(run.total > 0, 'the sequence must actually read the sheet');
  assert.ok(run.peak <= BUDGET,
    `OVER the trace-derived lower bound — corrected client measured ${run.peak}, bound ` +
    `${BUDGET}, Google's limit ${GOOGLE_LIMIT}. This is a lower bound, so exceeding it here ` +
    `means production certainly exceeds it too.\n  ${run.breakdown}`);

  // THE EXACT PUBLISHED FIGURES, pinned. Every number in docs/READ_BUDGET.md and the merge
  // card is one of these two, and both depend on the captured timing being replayed: drive
  // the same requests back to back instead and the peak reads 47, not 39. Pinning them is
  // what makes a silent return to a collapsed timeline fail here rather than quietly
  // re-publish a figure nobody re-derived.
  assert.equal(run.peak, 39,
    `the published corrected peak is 39; measured ${run.peak}. If this changed legitimately, ` +
    'every figure in docs/READ_BUDGET.md and the merge card must be re-derived and updated ' +
    'in the same change.');
  assert.equal(run.total, 48,
    `the published corrected total is 48; measured ${run.total}`);

  // The timeline really is spread. A session whose peak equals its total is one where every
  // request landed inside a single rolling minute — the collapsed model this replaced.
  assert.ok(run.peak < run.total,
    `peak (${run.peak}) must be strictly below total (${run.total}) once the captured 70.9 s ` +
    'of timing is replayed; equality means the offsets stopped being applied');

  // Every Save the manifest contains actually happened, and the closeout really wrote.
  // A budget met by failing requests would be no achievement at all.
  const saves = run.results.filter(r => r.path === '/api/log-workout');
  assert.equal(saves.length, 14, 'all fourteen Saves must have been driven');
  assert.deepEqual([...new Set(saves.map(r => r.status))], [200],
    `every Save must have succeeded: ${JSON.stringify(saves.filter(r => r.status !== 200))}`);
  // Twelve rows for THIS session — the sheet also holds the seeded history, so counting
  // rows alone would pass on the wrong evidence.
  const written = run.ledgerRows.log.slice(1).filter(row => row[1] === SESSION_ID);
  assert.equal(written.length, 12, 'the closeout wrote all twelve rows of this session');

  // THE CLOSEOUT REALLY SETTLED. This is the branch that died live, and it is also the
  // cheapest thing to accidentally stop measuring: a closeout that captured nothing, or
  // sealed as a dry run, is a materially cheaper session than the one that failed — so a
  // budget measured against it would be measuring the wrong session. Every field here is
  // the server's own verdict, not a re-derivation.
  const closeout = saves[saves.length - 1].body.data;
  assert.equal(closeout.closeout_fully_verified, true, JSON.stringify(closeout));
  assert.equal(closeout.ledger_seal.sealed_ok, true, 'the set ledger must have sealed');
  assert.equal(closeout.ledger_seal.sheet_written, true,
    'a LIVE seal — a dry-run seal would mean a cheaper session was measured');
  assert.ok(closeout.ledger_seal.sealed >= 12,
    `every accepted set must be sealed, saw ${closeout.ledger_seal.sealed}`);
  assert.equal(closeout.session_plans_closeout.captured, true,
    'the Session_Plans closeout event must be genuinely captured, not disabled');
  assert.equal(closeout.session_plans_closeout.status, 'written');

  // And the write-verification authority answered on the real Save, describing the real
  // append — so the budget number and the verification claim come from ONE outcome.
  assert.equal(closeout.log_write_verification.verified, true, JSON.stringify(closeout.log_write_verification));
  assert.equal(closeout.log_write_verification.authority, 'append_receipt');
  assert.equal(closeout.log_write_verification.range, closeout.logAppendedRange);
  assert.equal(closeout.log_write_verification.rows_written, 12);
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
  // START FROM A COLD ROW CACHE. index.js caches the full Log_Cleaned / Effort reads for 30
  // seconds, and counting at the googleapis boundary cannot see a read that a warm cache
  // answered — so with the cache warm this guard would pass even if the route DID read.
  // A live Save is the public way to invalidate it: after this, any read the route performs
  // must reach the API to be answered, and the count below means what it says.
  const priming = await call('POST', '/api/log-workout', {
    date: SESSION_DATE, session_id: 'GUARD-COLD-CACHE', write_id: `w_guard_cold_${runSeq}_x`,
    log_rows: [{ exercise: LIFTS[0].name, set_number: 1, weight: 100, reps: 5, rir: 2 }],
  });
  assert.equal(priming.status, 200, JSON.stringify(priming.body));
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

// ── the budget counts ATTEMPTS, not logical reads ───────────────────────────
//
// Google meters every request that reaches it, so a retried read costs two. The 2026-08-05
// session did not merely ask too often — its retries after the first 429 are part of why it
// measured 116 attempts. A budget that counted logical reads would understate exactly the
// traffic that broke it.
//
// The harness counts inside the fake googleapis client, so retries are counted by
// construction. This is what proves it: a read is made to fail transiently once, and BOTH
// the failed attempt and the successful retry must appear in the measurement.
test('a retried read is counted twice — the budget meters attempts', async () => {
  resetSheet();
  resetIdempotencyStore();
  sheets._resetExerciseCatalogCache();
  await settle({ quietMs: 250, maxMs: 4000 });

  reads.length = 0;
  countingOn = true;
  let response;
  try {
    failNextReads = 1;           // the first read this request makes fails transiently
    response = await call('GET', '/api/plan/today');
    await settle();
  } finally {
    failNextReads = 0;
    countingOn = false;
  }

  assert.equal(response.status, 200,
    `the retry ladder must have recovered: ${JSON.stringify(response.body)}`);
  assert.ok(reads.length >= 2,
    `a failed attempt AND its retry must both be counted, saw ${reads.length}: ` +
    JSON.stringify(reads.map(r => `${r.api} ${r.ranges.join(',')}`)));

  // The same range twice — the retry, not two different reads that happen to sum to two.
  const byRange = new Map();
  for (const read of reads) {
    const key = `${read.api} ${read.ranges.join('|')}`;
    byRange.set(key, (byRange.get(key) || 0) + 1);
  }
  assert.ok([...byRange.values()].some(n => n >= 2),
    'one read must appear twice — the attempt and its retry:\n  ' +
    [...byRange.entries()].map(([k, n]) => `${n} × ${k}`).join('\n  '));
});

// ── the evidence the server emits must be readable by the tool that reads it ─
//
// `sheets.js` writes one `[sheets-read]` line per metered attempt;
// `scripts/reconstruct-session-reads.js` is what turns those lines back into a session's
// read demand. Both were changed in this corrective, and each was tested only against
// hand-written input — so an emitter/parser mismatch could pass on both sides while the
// evidence pipeline produced nothing. This drives a REAL request and feeds the REAL lines it
// emitted to the REAL parser.
test('the lines sheets.js emits parse, and carry the timestamp the peak is computed from', async () => {
  const { reconstruct, peakRollingMinute } = require('../scripts/reconstruct-session-reads');

  resetSheet();
  resetIdempotencyStore();
  sheets._resetExerciseCatalogCache();
  await settle({ quietMs: 250, maxMs: 4000 });

  const captured = [];
  const realLog = console.log;
  console.log = (...args) => { captured.push(args.join(' ')); realLog(...args); };
  let response;
  try {
    response = await call('GET', '/api/plan/today');
    await settle();
  } finally {
    console.log = realLog;
  }
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const emitted = captured.filter(line => line.includes('[sheets-read]'));
  assert.ok(emitted.length > 0, 'the request must have emitted read evidence at all');

  const result = reconstruct(emitted.join('\n'));
  assert.equal(result.mode, 'structured',
    `the parser must read what the emitter wrote — it fell back to legacy on:\n  ${emitted[0]}`);
  assert.equal(result.attempts.length, emitted.length,
    'every emitted attempt must survive parsing');

  const rolling = peakRollingMinute(result.attempts);
  assert.equal(rolling.unstamped, 0,
    'an unstamped attempt is excluded from the rolling-60s peak, so the quota evidence ' +
    `would silently read as zero. Emitted line:\n  ${emitted[0]}`);
  assert.ok(rolling.peak > 0, 'and the peak must be a real number');

  // The attribution the corrective depends on: each attempt names the request that caused it.
  for (const attempt of result.attempts) {
    assert.equal(attempt.endpoint, 'GET /api/plan/today', JSON.stringify(attempt));
    assert.ok(attempt.request_id, 'each attempt must carry the request id that caused it');
  }

  // And the same line survives the harness prefix a gate run adds.
  const prefixed = reconstruct(emitted.map(line => `[gate-server] ${line}`).join('\n'));
  assert.equal(prefixed.mode, 'structured', 'a gate-server-prefixed log must parse identically');
  assert.equal(prefixed.attempts.length, result.attempts.length);
});

module.exports = { runLiveSession, BUDGET, GOOGLE_LIMIT, SESSION_ID };
