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
// That 78 is a LOWER BOUND, not a total. It is a values-read count from the old logging
// surface, which emitted no line for `spreadsheets.get`; the archived log cannot contain
// those calls and re-parsing it can never recover them. The complete pre-change figure is
// this harness's 137, measured through the real handlers in the qualifying ledger posture,
// with every metered method counted and the request-scoped mechanism fully disabled.
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
//   • The count is taken at the googleapis boundary — every `values.get`, every
//     `values.batchGet` AND every `spreadsheets.get`. All three are metered against the
//     read quota, and `spreadsheets.get` is on live session paths (getSpreadsheetTabs
//     backs closeoutFinality / sessionPlanStore / sessionPlanSetsStore; confirmTabMissing
//     issues one per unresolved range). Counting only the values methods reported a
//     values-read total as if it were the read total. Nothing above this layer can
//     under-report: a helper that starts reading tomorrow is counted regardless.
//   • The REAL `sheets.js` and the REAL Express app run. Only `googleapis` is faked, so
//     the batching, the request context, the catalog cache and every handler in the
//     chain are the production ones.
//   • It runs the QUALIFYING LEDGER POSTURE — ATLAS_SESSION_PLANS_WRITE=1 and
//     SESSION_PLAN_SETS_WRITE_ENABLED=1, the two flags the combined rehearsal sets. With
//     them off the session has no plan capture, no checkpoint writes and a dry-run seal —
//     a materially cheaper session than the one that failed, so the budget would describe
//     the wrong thing. Two posture bites refuse it.
//   • Every LEDGER operation must have genuinely captured. These routes answer HTTP 200
//     while reporting `status: 'error', captured: false` in the BODY, so an all-2xx
//     sequence proves nothing about them — and one really was failing that way.
//   • The request sequence is the LITERAL sequence of API calls from the failed run's
//     server log, in order (static asset and health requests dropped — they reach no
//     handler that reads). It is not a representative sample; it is that session —
//     including twelve real set-log Saves and the FINAL CLOSEOUT Save carrying the
//     production `closeout_context`, which is the branch that actually died live and the
//     only one that reaches recordCloseoutEvent / sealCloseout.
//   • EVERY request must answer 2xx AND every live Save must really have written. A
//     request that 400s early performs no reads, and a Save answering 200 as a duplicate
//     skips its append and most of its reads — a stale on-disk idempotency store alone
//     moved the reported budget from 53 to 27. `assertSequenceGenuine` refuses both, and
//     `assertCloseoutGenuine` refuses a closeout that did not seal.
//   • The counterfactual tests are the real anti-false-green, and they disable the
//     COMPLETE request-scoped mechanism, not merely the declarations. Disabling only
//     `declareRequestRanges` left same-range dedup and request-scoped metadata running, so
//     "cache only" was not cache-only and "neither" was not neither. A separate test
//     proves the no-context run genuinely restores repeated metadata and repeated
//     same-range requests, so the mutation is known to bite.
//
// MEASURED, on this sequence, in the qualifying ledger posture. "Request context" means
// the WHOLE request-scoped mechanism — declared batchGet, same-range dedup, and
// request-scoped spreadsheet metadata — not just the declarations:
//     request context + catalog cache   46   ← shipped, against a budget of 50
//     request context, cold catalog     60   ← catalog cache removed
//     no request context + cache       123   ← request context removed
//     neither                          137   ← the complete pre-change counterfactual.
//                                              Compare against THIS, not the archived 78
//                                              (a values-read lower bound from the old
//                                              logging surface; the live run was also cut
//                                              short by the quota it had exhausted).
//
// The margin is FOUR reads. That is deliberate headroom against Google's real 60/min
// limit, not slack: the measurement is deterministic, so a change that adds even a few
// requests to a session turns this file red — which is the point.

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
// The write_id idempotency store PERSISTS TO DISK and rehydrates on first use — correct
// production behaviour (a restart must not re-run a committed write), and a trap for this
// harness. A write_id left on the real store by an earlier process makes every Save answer
// `skipped_duplicate`, which reads FAR fewer ranges and reports a budget of 27 for a
// session that actually costs 53. That is the same false green the closeout omission
// produced. So the store is redirected to a scratch file and reset before every run, and
// `assertSequenceGenuine` fails on any Save that did not really write.
process.env.ATLAS_IDEMPOTENCY_FILE = require('node:path').join(
  require('node:os').tmpdir(), 'atlas-session-read-budget-idempotency.json');
// THE QUALIFYING LEDGER POSTURE. F-SB4B qualifying runs the combined rehearsal
// (`ATLAS_GATE_SANDBOX_LIVE=1` + `ATLAS_GATE_LEDGER_SANDBOX=1`), and in that posture
// `tests/e2e/gate/gate-server.js` sets BOTH of these (:142-143). They are two separate
// gates: ATLAS_SESSION_PLANS_WRITE controls the Session_Plans event capture,
// SESSION_PLAN_SETS_WRITE_ENABLED controls the Session_Plan_Sets checkpoint/seal lane.
//
// Measuring with them off measures a CHEAPER session than the one whose quota failure
// this budget exists to prevent: no capture, no checkpoint writes, a dry-run seal, and
// fewer reads. So they are on here.
//
// This is not a production-write authorization and changes no owner-frozen configuration.
// googleapis is fully faked in this file — no Google client is reachable — and the same
// pattern is already used by the gate harness and by test/sessionPlanSetsCapture.js.
// SESSION_PLAN_SETS_WRITE_ENABLED is captured at MODULE LOAD, so it must be set before
// index.js / sessionPlanCapture / sessionPlanSetsStore are required.
process.env.ATLAS_SESSION_PLANS_WRITE = '1';
process.env.SESSION_PLAN_SETS_WRITE_ENABLED = '1';

// ── Sheet fixture ────────────────────────────────────────────────────────────
// Column layouts follow .claude/rules/sheet-schemas.md exactly, so the handlers parse
// real rows rather than shapes that happen to survive.
// Headers are taken from `config/columns.js`, the schema authority, rather than copied.
// A hand-written Session_Plan_Sets header in an earlier head was simply WRONG — invented
// column names that the real capture layer would never produce — and a fixture that does
// not match the contract cannot prove a ledger write.
const {
  logCleanedColumns, effortColumns, deloadStateColumns,
  sessionPlansColumns, sessionPlanSetsColumns, constraintsColumns,
} = require('../config/columns');

const LOG_HEADER = [...logCleanedColumns];
const EFFORT_HEADER = [...effortColumns];
const DELOAD_HEADER = [...deloadStateColumns];
const PLANS_HEADER = [...sessionPlansColumns];
const PLAN_SETS_HEADER = [...sessionPlanSetsColumns];

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
    Constraints: [[...constraintsColumns]],
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
// Fails EVERY read of a range prefix until cleared, so a route can be driven against a
// realistic upstream outage. It must persist across attempts: `readWithRetry` retries a
// transient failure, so a one-shot injection is simply recovered from — correctly — and
// never reaches the route.
let failNextReadOf = null;

function recordRead(kind, ranges) {
  if (countingOn) reads.push({ at: Date.now(), kind, ranges });
}

const fakeSheetsClient = {
  spreadsheets: {
    // COUNTED. `spreadsheets.get` retrieves spreadsheet data, so Google meters it against
    // the same read quota as `values.get` — and it is on live session paths, not just
    // diagnostics: `getSpreadsheetTabs()` backs closeoutFinality.isSessionFinalized,
    // sessionPlanStore/_tabExists, sessionPlanSetsStore/_probeTab and the schema probes,
    // and `confirmTabMissing` issues one on every unresolved range. Counting only the
    // values methods would report a values-read total as if it were the read total.
    get: async () => {
      recordRead('metadata', ['spreadsheet metadata']);
      return { data: { sheets: Object.keys(SHEET).map(title => ({ properties: { title, sheetId: 1 } })) } };
    },
    batchUpdate: async () => ({ data: {} }),
    values: {
      get: async ({ range }) => {
        recordRead('get', [range]);
        if (failNextReadOf && String(range).startsWith(failNextReadOf.rangePrefix)) {
          throw failNextReadOf.error;
        }
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
      // Truthfully APPLIES the update and reports the real cell count. A fake that always
      // answered `totalUpdatedCells: 1` made the closeout seal fail `seal_proof_mismatch`
      // (expected 13, got 1) — a fixture defect that would have read as a product defect,
      // and the seal's proof field is exactly what must not be faked.
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

// Vision is stubbed only so no screenshot path reaches a provider; it performs no reads.
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
// The version the ACCEPTED checkpoints carry, and the exact identity the one revision
// declares. Both are properties of the sequence below, and the durable proof checks the
// rows against them rather than against "some row somewhere".
const ACCEPTED_PLAN_VERSION = 1;
const REVISION_IDENTITY = { plan_item_id: 'pi_idb01', set_index: 2, plan_version: 2 };

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
 * version of it measured under budget even with the mechanisms disabled, which would have
 * let the budget test pass on a session that never reproduced the failure.
 */
// The write_id idempotency store is process-level and deliberately survives a request,
// so replaying the sequence with the SAME ids would make every live write after the first
// run a `skipped_duplicate` — which reads FEWER ranges and would quietly understate the
// counterfactuals. Each run gets its own ids so every run performs real writes.
let runSeq = 0;

function ownerPatternSequence({ omitCloseout = false } = {}) {
  const runId = `r${runSeq}`;
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
      // ONE Save per logged set — twelve across the session, matching the failed run's
      // own log (`POST /api/log-workout` appears once per set, not twice). Each carries a
      // distinct write_id and performs a real append; the preview-then-write pair belongs
      // to the closeout, which is where the client actually renders a review card.
      steps.push(['POST', '/api/log-workout', {
        date: SESSION_DATE, session_id: SESSION_ID, log_rows: setRows(lift, set),
        write_id: `w_${runId}_${lift.code}_${set}`,
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
          planned_lift_code: LIFTS[index].code,
          // No performed_lift_code: the ledger accepts it only for a `substituted`
          // outcome. Sending it returned HTTP 200 carrying status:'error' — a ledger
          // operation failing silently inside a 2xx, which `assertLedgerGenuine` below
          // now refuses outright.
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
  // THE CLOSEOUT. The failed session died here, and this is the only branch that
  // reaches it: `/api/log-workout` activates `recordCloseoutEvent` + `sealCloseout` on
  // the PRESENCE of `closeout_context` (index.js:3292, :3456, :3602), which pulls in the
  // Session_Plans / Session_Plan_Sets metadata and ledger reads. Doubling ordinary set
  // previews does not exercise it. Shape follows the client's own payload
  // (src/app/app.js:7927 + closeoutContextItems).
  const closeoutContext = {
    plan_version: PLAN_VERSION,
    items: LIFTS.map((lift, i) => ({
      plan_item_id: planItems[i].plan_item_id,
      planned_lift_code: lift.code,
      performed_lift_code: lift.code,
      outcome: 'completed',
    })),
  };
  if (omitCloseout) return steps;
  // Preview first, then the approved write — the closeout is a Save like any other, and
  // the client sends the context on BOTH halves (test/closeoutConfirmWiring.test.js).
  steps.push(['POST', '/api/log-workout', {
    date: SESSION_DATE, session_id: SESSION_ID, test_mode: true,
    log_rows: setRows(LIFTS[LIFTS.length - 1], 3), closeout_context: closeoutContext,
  }]);
  steps.push(['POST', '/api/log-workout', {
    date: SESSION_DATE, session_id: SESSION_ID, write_id: `w_${runId}_closeout`,
    log_rows: setRows(LIFTS[LIFTS.length - 1], 3), closeout_context: closeoutContext,
  }]);
  return steps;
}

/** The final approved closeout Save in a run's results — the request that failed live. */
function closeoutResult(results) {
  return results[results.length - 1];
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

  // A 2xx Save is not proof of a Save. A duplicate write_id answers 200 while skipping the
  // append and most of its reads, so a stale idempotency store would report a fraction of
  // the real demand as if it were the budget. Every live Save must have actually written.
  const liveSaves = results.filter(r => r.path === '/api/log-workout' && !r.body?.data?.test_mode);
  const notWritten = liveSaves.filter(r => r.body?.data?.sheet_write !== 'success');
  assert.equal(notWritten.length, 0,
    `${notWritten.length} of ${liveSaves.length} live Saves did not write (${
      [...new Set(notWritten.map(r => r.body?.data?.sheet_write))].join(', ')
    }) — a skipped Save performs far fewer reads and would understate the budget`);
}

/**
 * Every ledger operation in the sequence must have genuinely captured.
 *
 * These routes answer HTTP 200 while reporting `status: 'error', captured: false` in the
 * body, so an all-2xx sequence proves nothing about them. One really was failing that way
 * — `/api/session-plans/outcome` rejecting a `performed_lift_code` on a `completed`
 * outcome — and the budget was being measured on a session whose plan events never landed.
 *
 * This covers the qualifying outcomes the ledger must show: acceptance events captured,
 * Session_Plan_Sets checkpoints written live (never `dry_run`), and revisions captured.
 */
// Exactly what this sequence must write, per route. Derived from the sequence itself:
// six plan items accepted, twelve checkpoints (six items × two sets), one revision, one
// item outcome.
const LEDGER_WRITES = {
  '/api/session-plans/accept': 6,
  '/api/session-plans/outcome': 1,
  '/api/session-plan-sets/accept': 12,
  '/api/session-plan-sets/revision': 1,
};
const SEAL_CELLS = 13;   // twelve accepted checkpoints + one revision

function assertLedgerGenuine(results) {
  const LEDGER_ROUTES = Object.keys(LEDGER_WRITES);
  const seen = [];
  for (const result of results) {
    if (!LEDGER_ROUTES.includes(result.path)) continue;
    const data = result.body?.data ?? {};
    const report = data.session_plans || data.session_plan_sets;
    assert.ok(report, `${result.path} returned no ledger report: ${JSON.stringify(data).slice(0, 200)}`);
    assert.notEqual(report.status, 'error',
      `${result.path} failed inside a 200: ${JSON.stringify(report)}`);
    assert.notEqual(report.status, 'disabled',
      `${result.path} was disabled — the qualifying posture enables both ledger flags: ${JSON.stringify(report)}`);
    assert.equal(report.captured, true, `${result.path} did not capture: ${JSON.stringify(report)}`);
    // EXACT cardinality for this declared sequence. `written > 0` accepted one acceptance
    // event instead of six, or one checkpoint instead of twelve — "some rows", not the
    // qualifying ledger. These counts are properties of the sequence above: six plan
    // items, twelve checkpoints (six items × two sets), one revision, one outcome.
    assert.equal(Number(report.written), LEDGER_WRITES[result.path],
      `${result.path} wrote ${report.written} rows, expected ${LEDGER_WRITES[result.path]}: ${JSON.stringify(report)}`);
    // The set-ledger lane must be LIVE, not a dry run — that is SESSION_PLAN_SETS_WRITE_ENABLED.
    if (data.session_plan_sets) {
      assert.notEqual(report.dry_run, true,
        `${result.path} ran dry — the qualifying posture enables the set-ledger lane: ${JSON.stringify(report)}`);
    }
    seen.push(result.path);
  }
  for (const route of LEDGER_ROUTES) {
    assert.ok(seen.includes(route), `the sequence must drive ${route}`);
  }
}

/**
 * The closeout must have actually CLOSED OUT. A generic 2xx is not enough: the branch is
 * presence-gated on `closeout_context`, so a payload that lost the field would still
 * answer 200 as an ordinary Save while skipping every read the closeout performs — the
 * exact false green this sequence exists to prevent.
 */
function assertCloseoutGenuine(results) {
  const closeout = closeoutResult(results);
  assert.equal(closeout.path, '/api/log-workout', 'the sequence must end on the closeout Save');
  assert.equal(closeout.status, 200, JSON.stringify(closeout.body));
  const data = closeout.body?.data ?? closeout.body ?? {};
  assert.equal(data.sheet_write, 'success', 'the closeout must be a real approved write');

  // POSITIVE outcomes, not field presence. Requiring only that `ledger_seal` and
  // `session_plans_closeout` are truthy and that `closeout_fully_verified` EXISTS would
  // pass on `sealed_ok: false`, `status: 'error'` and `closeout_fully_verified: false` —
  // i.e. on the exact settlement failure this is supposed to catch.
  assert.equal(data.closeout_fully_verified, true,
    'the closeout must be positively verified, not merely reported on');

  const seal = data.ledger_seal;
  assert.ok(seal, 'sealCloseout must have run — its absence means the closeout branch was skipped');
  assert.equal(seal.sealed_ok, true, `the ledger seal must succeed: ${JSON.stringify(seal)}`);
  // EXACT seal cardinality. "a successful live seal" passed while sealing fewer rows than
  // the ledger holds — the merge card claims 13 cells, so the guard must establish 13.
  assert.equal(Number(seal.sealed), SEAL_CELLS,
    `the seal must stamp all ${SEAL_CELLS} ledger rows, got ${seal.sealed}: ${JSON.stringify(seal)}`);
  assert.equal(Number(seal.already_sealed), 0,
    `nothing may be pre-sealed on a first closeout: ${JSON.stringify(seal)}`);
  // The qualifying posture has SESSION_PLAN_SETS_WRITE_ENABLED=1, so this is a LIVE seal
  // and must carry live-write proof. A dry-run seal here means the harness dropped back to
  // the cheaper posture and the measured budget no longer describes the qualifying session.
  assert.notEqual(seal.dry_run, true,
    `the qualifying posture enables the set-ledger lane — a dry-run seal means this harness ` +
    `is measuring a cheaper session than F-SB4B qualifying: ${JSON.stringify(seal)}`);
  assert.equal(seal.sheet_written, true, `a live seal must prove it wrote: ${JSON.stringify(seal)}`);

  const plans = data.session_plans_closeout;
  assert.ok(plans, 'recordCloseoutEvent must have run');
  // The QUALIFYING posture has ATLAS_SESSION_PLANS_WRITE=1, so the closeout event must be
  // genuinely CAPTURED. Accepting `status: 'disabled'` here would let the budget be
  // measured on a cheaper dry-run session than the one that actually failed.
  assert.notEqual(plans.status, 'disabled',
    'the qualifying posture enables ATLAS_SESSION_PLANS_WRITE — a disabled capture means ' +
    'this harness is measuring a cheaper session than F-SB4B qualifying');
  assert.notEqual(plans.status, 'error',
    `the Session_Plans closeout event must not error: ${JSON.stringify(plans)}`);
  assert.equal(plans.captured, true,
    `the Session_Plans closeout event must be captured: ${JSON.stringify(plans)}`);
  assert.equal(Number(plans.written), 1,
    `the closeout must write exactly one Session_Plans event, got ${plans.written}: ${JSON.stringify(plans)}`);
}

/**
 * The DURABLE rows, not the response envelopes.
 *
 * A response saying "written: 12" is the server's own claim. This reads what actually
 * landed in the sheet, under the identities the sequence declared, and checks that the
 * seal stamped every ledger row with the closeout's write id.
 */
function assertLedgerRowsGenuine(run) {
  const { results, ledgerRows } = run;
  const closeoutWriteId = closeoutResult(results).body?.data?.write_id;
  assert.ok(closeoutWriteId, 'the closeout must report the write id it sealed under');

  // ── Session_Plans ──────────────────────────────────────────────────────────
  const planRows = ledgerRows.plans.slice(1);
  const col = (row, name) => row[PLANS_HEADER.indexOf(name)];
  const accepted = planRows.filter(r => col(r, 'event_type') === 'plan_accepted');
  assert.equal(accepted.length, LEDGER_WRITES['/api/session-plans/accept'],
    `expected ${LEDGER_WRITES['/api/session-plans/accept']} plan_accepted rows, got ${accepted.length}`);
  const acceptedIds = accepted.map(r => col(r, 'plan_item_id'));
  assert.deepEqual([...acceptedIds].sort(), planItems.map(i => i.plan_item_id).sort(),
    'the accepted plan identities must be exactly the six the sequence accepted');
  assert.equal(new Set(acceptedIds).size, acceptedIds.length, 'no accepted identity may appear twice');
  for (const row of accepted) {
    assert.equal(col(row, 'session_id'), SESSION_ID);
    assert.equal(col(row, 'plan_version'), PLAN_VERSION);
  }

  const closeoutEvents = planRows.filter(r => col(r, 'event_type') === 'session_closeout');
  assert.equal(closeoutEvents.length, 1, 'exactly one Session_Plans closeout event');
  assert.equal(col(closeoutEvents[0], 'session_id'), SESSION_ID);
  assert.equal(col(closeoutEvents[0], 'plan_version'), PLAN_VERSION);

  // ── Session_Plan_Sets ──────────────────────────────────────────────────────
  //
  // Split by the SOURCE authority rather than counting the sheet as one population. The
  // revision deliberately re-uses one accepted (item, set) key, so a presence check over
  // all rows together could be satisfied by the revision while an accepted checkpoint was
  // missing — or by a revision attached to the wrong item, set or version.
  const setRows = ledgerRows.sets.slice(1);
  const setCol = (row, name) => row[PLAN_SETS_HEADER.indexOf(name)];
  assert.equal(setRows.length, SEAL_CELLS,
    `expected ${SEAL_CELLS} ledger rows (12 accepted + 1 revision), got ${setRows.length}`);

  const acceptedSets = setRows.filter(r => setCol(r, 'recommendation_source') === 'accepted');
  const revisionSets = setRows.filter(r => setCol(r, 'recommendation_source') === 'live_revision');
  assert.equal(acceptedSets.length + revisionSets.length, setRows.length,
    'every ledger row must be either an accepted checkpoint or a revision');

  // Exactly the twelve accepted identities, each exactly once, at the accepted version.
  assert.equal(acceptedSets.length, LEDGER_WRITES['/api/session-plan-sets/accept'],
    `expected ${LEDGER_WRITES['/api/session-plan-sets/accept']} accepted checkpoints, got ${acceptedSets.length}`);
  const expectedAccepted = planItems.flatMap(item => [1, 2].map(setIx => `${item.plan_item_id}#${setIx}`));
  const actualAccepted = acceptedSets.map(r => `${setCol(r, 'plan_item_id')}#${setCol(r, 'set_index')}`);
  assert.deepEqual([...actualAccepted].sort(), [...expectedAccepted].sort(),
    'the accepted checkpoints must be exactly the twelve declared item/set identities');
  assert.equal(new Set(actualAccepted).size, actualAccepted.length,
    'no accepted item/set identity may be checkpointed twice');
  for (const row of acceptedSets) {
    assert.equal(setCol(row, 'session_id'), SESSION_ID);
    assert.equal(String(setCol(row, 'plan_version')), String(ACCEPTED_PLAN_VERSION),
      `an accepted checkpoint must carry the accepted plan version: ${JSON.stringify(row)}`);
  }

  // Exactly one revision, under the identity the revision request declared.
  assert.equal(revisionSets.length, LEDGER_WRITES['/api/session-plan-sets/revision'],
    `expected exactly one revision row, got ${revisionSets.length}`);
  const revision = revisionSets[0];
  assert.equal(setCol(revision, 'session_id'), SESSION_ID);
  assert.equal(setCol(revision, 'plan_item_id'), REVISION_IDENTITY.plan_item_id,
    `the revision is attached to the wrong plan item: ${JSON.stringify(revision)}`);
  assert.equal(String(setCol(revision, 'set_index')), String(REVISION_IDENTITY.set_index),
    `the revision is attached to the wrong set: ${JSON.stringify(revision)}`);
  assert.equal(String(setCol(revision, 'plan_version')), String(REVISION_IDENTITY.plan_version),
    `the revision must carry the revised plan version: ${JSON.stringify(revision)}`);
  // A revision supersedes the checkpoint it replaces; the contract supplies that key.
  assert.ok(String(setCol(revision, 'supersedes_key') || '').trim(),
    `a revision must record the checkpoint it supersedes: ${JSON.stringify(revision)}`);

  // The seal stamps EVERY ledger row with the closeout write id. A row left unstamped, or
  // stamped under a different id, is a ledger the closeout did not actually finish.
  for (const row of setRows) {
    assert.equal(setCol(row, 'closeout_write_id'), closeoutWriteId,
      `a ledger row was not sealed under the closeout write id: ${JSON.stringify(row)}`);
  }
}

/** Every guard a published configuration must satisfy before its read count is believed. */
function assertQualifyingRunGenuine(run) {
  assertSequenceGenuine(run.results);
  assertLedgerGenuine(run.results);
  assertLedgerRowsGenuine(run);
  assertCloseoutGenuine(run.results);
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
/**
 * Run the sequence.
 *
 * `requestContext: false` disables the COMPLETE request-scoped mechanism, not just the
 * declarations. That distinction was wrong in an earlier head and it mislabelled every
 * counterfactual: `runWithReadContext` also deduplicates repeated same-range value reads
 * and reuses `getSpreadsheetTabs()` metadata for the life of the request, so disabling
 * only `declareRequestRanges` left both of those running. "cache only" was not
 * cache-only and "neither" was not neither.
 *
 * The middleware looks the function up on the module object at call time, so replacing it
 * with a pass-through is enough — `currentReadContext()` then returns null everywhere and
 * every read goes out on its own, exactly as it did before this PR. No production flag.
 */
async function runSession({ coldCatalogPerRequest = false, omitCloseout = false, requestContext = true } = {}) {
  runSeq += 1;
  resetIdempotencyStore();
  resetSheet();
  sheets._resetExerciseCatalogCache();
  reads.length = 0;
  countingOn = true;
  const results = [];
  const realRunWithReadContext = sheets.runWithReadContext;
  if (!requestContext) sheets.runWithReadContext = (fn) => fn();
  try {
    for (const [method, path, body] of ownerPatternSequence({ omitCloseout })) {
      if (coldCatalogPerRequest) sheets._resetExerciseCatalogCache();
      results.push(await call(method, path, body));
    }
    // Deferred reads (intent-observe) must land INSIDE the same posture, or a
    // no-context run would quietly finish under the context it was meant to be without.
    await settle();
  } finally {
    sheets.runWithReadContext = realRunWithReadContext;
  }
  countingOn = false;
  return {
    // The durable ledger AS THIS RUN LEFT IT. Snapshotted rather than read live, because
    // a later run resets the fixture — asserting run N's ledger against the sheet after
    // run N+1 compared mismatched state and failed for the wrong reason.
    ledgerRows: {
      plans: SHEET.Session_Plans.map(row => [...row]),
      sets: SHEET.Session_Plan_Sets.map(row => [...row]),
    },
    results, total: reads.length, peak: peakRollingMinute(reads),
    catalog: catalogReads(), breakdown: breakdown(reads),
    metadataReads: reads.filter(r => r.kind === 'metadata').length,
  };
}

// ── 1. the budget holds on the complete session ──────────────────────────────
test('a complete owner-pattern session fits inside the session read budget', async () => {
  const run = await runSession();
  assertQualifyingRunGenuine(run);
  assert.ok(run.total > 0, 'the sequence must actually read the sheet');
  assert.ok(run.peak <= BUDGET,
    `peak rolling-60s reads ${run.peak} exceeds the ${BUDGET} budget (total ${run.total}); ` +
    `the pre-change counterfactual is 137 — see scripts/reconstruct-session-reads.js for the ` +
    `archived run's 78, which is a values-read lower bound, not the complete total` +
    `\n  ${run.breakdown}`);
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
  // The COMPLETE request-scoped mechanism is disabled, not just the declarations: no
  // batch, no same-range dedup, no request-scoped metadata. That is the pre-change
  // transport. Disabling only declarations left dedup and metadata reuse running and
  // mislabelled this configuration.
  const run = await runSession({ requestContext: false });
  // The full guard set: the four published numbers must all come from sessions that
  // achieved the SAME workout and ledger outcome, differing only in read posture. A
  // ledger route can fail inside an HTTP 200 — this PR found exactly that — so a cheaper
  // failed session could otherwise be reported as a counterfactual read count.
  assertQualifyingRunGenuine(run);
  assert.ok(run.peak > BUDGET,
    `without the request context the session must exceed the ${BUDGET} budget, but peaked at ${run.peak}. ` +
    'Either the sequence stopped exercising the read paths, or the request context is no longer what keeps it under.' +
    `\n  ${run.breakdown}`);
});

// The mutation must genuinely BITE: without the request context the same range really is
// requested more than once inside a request, and the metadata read really does repeat.
/**
 * Prove the request context actually removes a SAME-REQUEST duplicate read.
 *
 * This drives ONE request in isolation — nothing else in flight, the read stream quiesced
 * before and after — so every recorded read provably belongs to that request. An earlier
 * version attributed reads with a process-global label set client-side just before
 * `fetch`; because some reads are deferred past the response, a late read from an earlier
 * request could be counted under the next one. A global mutable label is not an authority
 * for "same request", so it is gone.
 */
async function readsForOneRequest(method, path, { requestContext }) {
  resetSheet();
  resetIdempotencyStore();
  sheets._resetExerciseCatalogCache();
  await settle({ quietMs: 300, maxMs: 5000 });   // quiesce anything still in flight
  reads.length = 0;
  countingOn = true;
  const real = sheets.runWithReadContext;
  if (!requestContext) sheets.runWithReadContext = (fn) => fn();
  try {
    const result = await call(method, path);
    await settle({ quietMs: 400, maxMs: 8000 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  } finally {
    sheets.runWithReadContext = real;
    countingOn = false;
  }
  const perRange = new Map();
  for (const record of reads) {
    if (record.kind === 'batchGet') continue;
    const key = record.kind === 'metadata' ? 'spreadsheet metadata' : record.ranges[0];
    perRange.set(key, (perRange.get(key) || 0) + 1);
  }
  return perRange;
}

test('the request context removes a duplicate read issued twice by ONE request', async () => {
  // `/api/plan/today` reads Deload_State twice on its own: once for the plan and once
  // through the state snapshot. That is the duplication the request context collapses.
  const RANGE = 'Deload_State!A:Z';
  const without = await readsForOneRequest('GET', '/api/plan/today', { requestContext: false });
  const with_ = await readsForOneRequest('GET', '/api/plan/today', { requestContext: true });

  assert.equal(without.get(RANGE), 2,
    `without the request context ONE request must issue ${RANGE} twice; got ${without.get(RANGE)}`);
  assert.ok(!with_.get(RANGE),
    `with the request context that request must not issue ${RANGE} on its own at all ` +
    `(it rides in the batch); got ${with_.get(RANGE)}`);
});

test('the no-context run restores repeated metadata requests across the session', async () => {
  const withContext = await runSession();
  const withoutContext = await runSession({ requestContext: false });
  assertQualifyingRunGenuine(withContext);
  assertQualifyingRunGenuine(withoutContext);
  assert.ok(withoutContext.metadataReads > withContext.metadataReads,
    'disabling the request context must restore repeated spreadsheets.get calls; ' +
    `got ${withoutContext.metadataReads} without vs ${withContext.metadataReads} with`);
});

// ── 4. counterfactual: per-request catalog reads break the budget ────────────
test('restoring per-request Exercise_Catalog reads breaks the session budget', async () => {
  // Request context ON, catalog cache OFF — the catalog-cache-only counterfactual.
  const run = await runSession({ coldCatalogPerRequest: true });
  assertQualifyingRunGenuine(run);
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
  // Neither mechanism: no request context at all, and a cold catalog on every request.
  // This is the genuine pre-change transport.
  const run = await runSession({ requestContext: false, coldCatalogPerRequest: true });
  assertQualifyingRunGenuine(run);
  assert.ok(run.peak > 60,
    `the pre-change behaviour must exceed Google's 60/min read limit, as the live session did ` +
    `before its exhausted quota cut it short; this harness measured ${run.peak}\n  ${run.breakdown}`);
});

// ── 4c. MUTATION BITES — the guard must fail when the measurement is weakened ──
//
// Both of these omissions were live in an earlier head of this PR and neither turned the
// file red. A guard that cannot fail on its own blind spots is not a guard.

test('MUTATION: dropping metadata reads from the count understates the session', async () => {
  const run = await runSession();
  assertSequenceGenuine(run.results);

  const metadata = reads.filter(r => r.kind === 'metadata');
  assert.ok(metadata.length > 0,
    'spreadsheets.get must be OBSERVED and counted. It is metered against the same read ' +
    'quota as values.get and it is on live session paths — getSpreadsheetTabs backs ' +
    'closeoutFinality/sessionPlanStore/sessionPlanSetsStore, and confirmTabMissing issues ' +
    'one per unresolved range. Counting only the values methods reports a values-read ' +
    'total as if it were the read total.');

  // …and they are not decorative: excluding them measurably lowers the reported peak.
  const withoutMetadata = peakRollingMinute(reads.filter(r => r.kind !== 'metadata'));
  assert.ok(withoutMetadata < run.peak,
    `omitting metadata reads must change the answer, but the peak stayed at ${run.peak}`);
});

test('MUTATION: dropping the closeout Save makes the guard fail', async () => {
  // The branch that actually failed live is presence-gated on `closeout_context`. A
  // sequence without it still answers 2xx everywhere and still fits the budget — which is
  // exactly why the budget alone cannot be the whole proof.
  const run = await runSession({ omitCloseout: true });
  assertSequenceGenuine(run.results);   // still all-2xx: the weakened sequence looks fine
  assert.throws(() => assertCloseoutGenuine(run.results),
    /must end on the closeout Save|ledger_seal|closeout/i,
    'a sequence that never drives the closeout must FAIL the guard, not pass it quietly');

  // And the omission is material: the closeout costs real reads.
  const complete = await runSession();
  assert.ok(complete.peak > run.peak,
    `the closeout must cost measurable reads, but the peak was ${complete.peak} with it ` +
    `and ${run.peak} without`);
});

// ── 4d. ONE catalog cache authority, proven at the ROUTE ─────────────────────
//
// `routes/reads.js` used to own a SECOND 60 s TTL cache in front of
// `getExerciseCatalog()`. Two caches in series do not give one TTL: a route entry filled
// at t=59 from a 59-second-old sheets entry served the SAME source snapshot until t≈119,
// past the approved bound, and never attempted the refresh whose failure the contract
// requires be surfaced. The helper-level cache tests could not see that path, so the
// proof has to run through the live route.

test('the catalog ROUTE never serves a source snapshot older than one TTL', async () => {
  resetSheet();
  sheets._resetExerciseCatalogCache();

  const nameAt = async () => {
    const res = await call('GET', '/api/catalog/exercises');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const list = res.body?.data?.exercises ?? res.body?.exercises ?? [];
    return list.map(e => e.canonical_name);
  };

  assert.ok((await nameAt()).includes('Back Squat'), 'precondition: the route serves the catalog');

  // Replace the sheet's catalog, then age the sheets-layer cache past its TTL. With one
  // authority the very next route call must show the new source. With the route cache in
  // place this assertion failed: it kept serving the old snapshot well past 60 s.
  SHEET.Exercise_Catalog = [
    ['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
    ['Front Squat', 'Front Squat', 'Legs', 'FSQ01'],
  ];
  sheets._resetExerciseCatalogCache();   // stands in for the TTL expiring

  const after = await nameAt();
  assert.ok(after.includes('Front Squat'),
    'the route served a catalog snapshot the sheets-layer cache had already expired — ' +
    'a second route-level cache is extending the approved TTL');
  assert.ok(!after.includes('Back Squat'), 'the stale snapshot must be gone entirely');
});

test('a failed catalog refresh reaches the route as a classified failure, not stale data', async () => {
  resetSheet();
  sheets._resetExerciseCatalogCache();
  assert.ok((await (async () => {
    const r = await call('GET', '/api/catalog/exercises');
    return (r.body?.data?.exercises ?? []).map(e => e.canonical_name);
  })()).includes('Back Squat'), 'precondition: warm the cache through the route');

  // Expire it, then break the source. With no stale-after-expiry fallback anywhere in the
  // chain, the route must surface the upstream failure rather than replay what it had.
  sheets._resetExerciseCatalogCache();
  const good = SHEET.Exercise_Catalog;
  delete SHEET.Exercise_Catalog;
  try {
    const res = await call('GET', '/api/catalog/exercises');
    assert.ok(res.status >= 400,
      `a failed refresh must not be answered with stale catalog data; got ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  } finally {
    SHEET.Exercise_Catalog = good;
  }
});

// ── 4e. the closeout guard must bite on a FAILED settlement ──────────────────
//
// The previous head asserted that `ledger_seal` and `session_plans_closeout` were truthy
// and that `closeout_fully_verified` merely EXISTED. A seal reporting `sealed_ok: false`, a
// capture reporting `status: 'error'`, and `closeout_fully_verified: false` all passed —
// the exact settlement failures the guard is for. Each is now flipped individually.
test('MUTATION: a failed closeout settlement makes the guard red', async () => {
  const run = await runSession();
  assertQualifyingRunGenuine(run);   // the real one settles

  const mutate = (patch) => {
    const clone = run.results.map(r => ({ ...r, body: JSON.parse(JSON.stringify(r.body)) }));
    Object.assign(clone[clone.length - 1].body.data, patch);
    return clone;
  };

  const sealOk = { sealed_ok: true, sealed: SEAL_CELLS, already_sealed: 0, sheet_written: true };
  const failures = [
    ['the settlement verdict is false', { closeout_fully_verified: false }],
    ['the ledger seal failed', { ledger_seal: { ...sealOk, sealed_ok: false } }],
    ['the seal did not write', { ledger_seal: { ...sealOk, sheet_written: false } }],
    ['the seal stamped fewer rows than the ledger holds', { ledger_seal: { ...sealOk, sealed: SEAL_CELLS - 1 } }],
    ['rows were already sealed', { ledger_seal: { ...sealOk, already_sealed: 1 } }],
    ['the Session_Plans capture errored', { session_plans_closeout: { status: 'error', captured: true, reason: 'boom' } }],
    // The POSTURE bite: a `disabled` capture or a dry-run seal means the harness dropped
    // back to the cheaper non-qualifying posture. Accepting either would let the budget be
    // measured on a session that performs fewer reads than the one that actually failed.
    ['the Session_Plans capture was disabled', { session_plans_closeout: { status: 'disabled', captured: false, reason: null } }],
    ['the capture did not capture', { session_plans_closeout: { status: 'written', captured: false, reason: null } }],
    ['the set-ledger seal ran dry', { ledger_seal: { ...sealOk, dry_run: true, sheet_written: false } }],
  ];
  for (const [label, patch] of failures) {
    assert.throws(() => assertCloseoutGenuine(mutate(patch)), Error,
      `the guard must go red when ${label}`);
  }
});

// ── 4f. a transient refresh failure reaches the catalog route as a 503 ───────
//
// The PR claims the catalog cache's failure "propagates through the truthful 503
// classification from PR #1270". Deleting the fixture proves only the permanent /
// range_unresolved path. The class that actually took qualifying session 1 down was
// TRANSIENT — a read-quota rejection — so that is the one worth pinning.
test('a transient refresh failure after expiry reaches the catalog route as a retryable 503', async () => {
  resetSheet();
  sheets._resetExerciseCatalogCache();

  const names = async () => {
    const r = await call('GET', '/api/catalog/exercises');
    return { status: r.status, body: r.body, list: (r.body?.data?.exercises ?? []).map(e => e.canonical_name) };
  };
  assert.ok((await names()).list.includes('Back Squat'), 'precondition: warm the cache through the route');

  // Expire it, then hit the refresh with the REAL shape of a Sheets per-user read-quota
  // rejection: HTTP 403, PERMISSION_DENIED at the top level, userRateLimitExceeded nested.
  sheets._resetExerciseCatalogCache();
  failNextReadOf = {
    rangePrefix: 'Exercise_Catalog',
    error: Object.assign(new Error("Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user'"), {
      status: 403,
      response: { status: 403, data: { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'userRateLimitExceeded' }] } } },
    }),
  };

  // The retry ladder runs first and exhausts — that is the contract: bounded retry, then
  // the truthful class. `sleep` is not injectable through the route, so this costs the
  // real backoff, which is the price of proving the live path rather than a helper.
  const out = await names();
  assert.equal(out.status, 503,
    `a transient upstream read failure must be the retryable 503 from PR #1270, not a generic 4xx/5xx; got ${out.status}`);
  const payload = JSON.stringify(out.body);
  assert.match(payload, /upstream_read_unavailable/, 'the response must carry the upstream-read-unavailable reason');
  assert.match(payload, /"retryable":true/, 'the response must declare itself retryable');
  assert.equal(out.list.length, 0, 'a failed refresh must not be answered with stale catalog data');
  failNextReadOf = null;
});

// ── 4g. POSTURE BITE — the budget must be measured on the QUALIFYING posture ──
//
// F-SB4B qualifying runs the combined rehearsal, where `tests/e2e/gate/gate-server.js`
// sets ATLAS_SESSION_PLANS_WRITE=1 and SESSION_PLAN_SETS_WRITE_ENABLED=1. An earlier head
// of this file set neither, so it measured a session with no plan capture, no checkpoint
// writes and a dry-run seal — a materially cheaper session than the one that failed. This
// proves the guard now refuses that posture instead of quietly measuring it.
test('POSTURE: turning off the Session_Plans write gate makes the qualifying guard fail', async () => {
  const previous = process.env.ATLAS_SESSION_PLANS_WRITE;
  let disabled;
  // Read per call by sessionPlanCapture, so it can be flipped for one run.
  delete process.env.ATLAS_SESSION_PLANS_WRITE;
  try {
    disabled = await runSession();
  } finally {
    if (previous === undefined) delete process.env.ATLAS_SESSION_PLANS_WRITE;
    else process.env.ATLAS_SESSION_PLANS_WRITE = previous;
  }

  assertSequenceGenuine(disabled.results);   // the cheaper session still answers 2xx…
  assert.throws(() => assertCloseoutGenuine(disabled.results), /disabled|captured/i,
    '…but the guard must refuse it: a disabled capture is not the qualifying posture');

  // And it IS cheaper — which is exactly why accepting it would understate the budget.
  const qualifying = await runSession();
  assertQualifyingRunGenuine(qualifying);
  assert.ok(qualifying.peak > disabled.peak,
    `the qualifying posture must cost more than the disabled one; got ${qualifying.peak} vs ${disabled.peak}`);
});

// ── 4h. POSTURE BITE — the set-ledger flag ───────────────────────────────────
//
// SESSION_PLAN_SETS_WRITE_ENABLED is captured at MODULE LOAD
// (`services/sessionPlanSetsStore.js:31`), so it cannot be flipped mid-process for the
// already-loaded app. The bite is therefore in two halves, and neither half is a
// hand-made shape: first take the REAL envelope the capture layer produces with the flag
// off — reloading the module exactly as `test/sessionPlanSetsCapture.test.js` does — then
// feed that real envelope to the guards and require them to go red.
test('POSTURE: the shape SESSION_PLAN_SETS_WRITE_ENABLED=0 produces fails the qualifying guard', async () => {
  const storePath = require.resolve('../services/sessionPlanSetsStore');
  const capturePath = require.resolve('../services/sessionPlanSetsCapture');
  const savedStore = require.cache[storePath];
  const savedCapture = require.cache[capturePath];
  const previous = process.env.SESSION_PLAN_SETS_WRITE_ENABLED;

  let disabledEnvelope;
  try {
    delete require.cache[storePath];
    delete require.cache[capturePath];
    delete process.env.SESSION_PLAN_SETS_WRITE_ENABLED;
    const capture = require('../services/sessionPlanSetsCapture');
    disabledEnvelope = await capture.captureAcceptedPlan(
      { session_id: SESSION_ID, session_date: SESSION_DATE, plan_version: PLAN_VERSION },
      [{ plan_item_id: 'pi_sq01', planned_lift_code: 'SQ01', target_set_count: 2, target_weight: 225, target_reps: 5, target_rir: 2 }],
    );
  } finally {
    // Restore BOTH the env and the module registry, or every later test in this file
    // silently runs the disabled posture.
    if (previous === undefined) delete process.env.SESSION_PLAN_SETS_WRITE_ENABLED;
    else process.env.SESSION_PLAN_SETS_WRITE_ENABLED = previous;
    if (savedStore) require.cache[storePath] = savedStore; else delete require.cache[storePath];
    if (savedCapture) require.cache[capturePath] = savedCapture; else delete require.cache[capturePath];
  }

  // This is what the flag being off actually looks like — not an invented object.
  assert.equal(disabledEnvelope.captured, false, 'precondition: the disabled flag does not capture');
  assert.equal(disabledEnvelope.dry_run, true, 'precondition: the disabled flag runs dry');

  // Now require the guards to refuse it, on both the ledger routes and the closeout.
  const run = await runSession();
  assertLedgerGenuine(run.results);
  assertQualifyingRunGenuine(run);

  const withEnvelope = (path, envelope) => {
    const clone = run.results.map(r => ({ ...r, body: JSON.parse(JSON.stringify(r.body)) }));
    const target = clone.filter(r => r.path === path).pop();
    target.body.data.session_plan_sets = envelope;
    return clone;
  };
  assert.throws(() => assertLedgerGenuine(withEnvelope('/api/session-plan-sets/accept', disabledEnvelope)),
    /dry|captur|written/i,
    'a real disabled-flag envelope on a ledger route must fail the qualifying guard');

  const closeoutClone = run.results.map(r => ({ ...r, body: JSON.parse(JSON.stringify(r.body)) }));
  // Cardinality kept valid so ONLY the dry-run/live-write assertions can fire — otherwise
  // the seal-count guard trips first and this would not be testing the posture.
  closeoutClone[closeoutClone.length - 1].body.data.ledger_seal = {
    sealed_ok: true, sealed: SEAL_CELLS, already_sealed: 0,
    dry_run: true, sheet_written: false, no_write_confirmed: true,
  };
  assert.throws(() => assertCloseoutGenuine(closeoutClone), /dry-run|qualifying/i,
    'a dry-run seal — what the disabled flag produces at closeout — must fail the guard');
});

// ── 4i. MUTATION — the DURABLE ledger must be complete, not merely non-empty ──
//
// `written > 0` and "a successful live seal" passed while the ledger held one acceptance
// row instead of six, one checkpoint instead of twelve, no revision, or a row the seal
// never stamped. These drop exactly one thing each and require the guard to notice.
test('MUTATION: an incomplete durable ledger makes the qualifying guard red', async () => {
  const run = await runSession();
  assertLedgerRowsGenuine(run);   // the real ledger is complete

  const planIndex = (name) => PLANS_HEADER.indexOf(name);
  const setIndex = (name) => PLAN_SETS_HEADER.indexOf(name);
  const snapshot = {
    plans: run.ledgerRows.plans.map(r => [...r]),
    sets: run.ledgerRows.sets.map(r => [...r]),
  };
  const restore = () => {
    run.ledgerRows.plans = snapshot.plans.map(r => [...r]);
    run.ledgerRows.sets = snapshot.sets.map(r => [...r]);
  };

  const mutations = [
    ['one acceptance event is missing', () => {
      const i = run.ledgerRows.plans.findIndex(
        (r, index) => index > 0 && r[planIndex('event_type')] === 'plan_accepted');
      assert.ok(i > 0, 'the mutation must target a data row, never the header');
      run.ledgerRows.plans.splice(i, 1);
    }],
    ['the Session_Plans closeout event is missing', () => {
      const i = run.ledgerRows.plans.findIndex(
        (r, index) => index > 0 && r[planIndex('event_type')] === 'session_closeout');
      assert.ok(i > 0, 'the mutation must target a data row, never the header');
      run.ledgerRows.plans.splice(i, 1);
    }],
    ['one accepted set checkpoint is missing', () => {
      // Search DATA rows only. The previous version searched from index 0, and the header
      // row satisfied both conditions (`idempotency_key` is truthy, and its
      // recommendation-source cell holds the column NAME, not 'live_revision'), so it
      // deleted the header and went red for the wrong reason.
      const i = run.ledgerRows.sets.findIndex(
        (r, index) => index > 0 && r[setIndex('recommendation_source')] === 'accepted');
      assert.ok(i > 0, 'the mutation must target a data row, never the header');
      run.ledgerRows.sets.splice(i, 1);
    }],
    ['the revision is attached to the wrong plan item', () => {
      const i = run.ledgerRows.sets.findIndex(
        (r, index) => index > 0 && r[setIndex('recommendation_source')] === 'live_revision');
      run.ledgerRows.sets[i][setIndex('plan_item_id')] = 'pi_sq01';
    }],
    ['the revision is attached to the wrong set', () => {
      const i = run.ledgerRows.sets.findIndex(
        (r, index) => index > 0 && r[setIndex('recommendation_source')] === 'live_revision');
      run.ledgerRows.sets[i][setIndex('set_index')] = '1';
    }],
    ['the revision carries the accepted version instead of the revised one', () => {
      const i = run.ledgerRows.sets.findIndex(
        (r, index) => index > 0 && r[setIndex('recommendation_source')] === 'live_revision');
      run.ledgerRows.sets[i][setIndex('plan_version')] = String(ACCEPTED_PLAN_VERSION);
    }],
    ['the revision records no superseded checkpoint', () => {
      const i = run.ledgerRows.sets.findIndex(
        (r, index) => index > 0 && r[setIndex('recommendation_source')] === 'live_revision');
      run.ledgerRows.sets[i][setIndex('supersedes_key')] = '';
    }],
    ['an accepted checkpoint carries the wrong plan version', () => {
      const i = run.ledgerRows.sets.findIndex(
        (r, index) => index > 0 && r[setIndex('recommendation_source')] === 'accepted');
      run.ledgerRows.sets[i][setIndex('plan_version')] = '99';
    }],
    ['an accepted checkpoint is duplicated in place of another', () => {
      // The population is still 13 rows and every declared key still APPEARS — only the
      // split by source and the uniqueness check can catch this.
      const rows = run.ledgerRows.sets;
      const a = rows.findIndex((r, index) => index > 0 && r[setIndex('recommendation_source')] === 'accepted');
      const b = rows.findIndex((r, index) => index > a + 1 && r[setIndex('recommendation_source')] === 'accepted');
      rows[b][setIndex('plan_item_id')] = rows[a][setIndex('plan_item_id')];
      rows[b][setIndex('set_index')] = rows[a][setIndex('set_index')];
    }],
    ['the revision checkpoint is missing', () => {
      const i = run.ledgerRows.sets.findIndex(
        (r, index) => index > 0 && r[setIndex('recommendation_source')] === 'live_revision');
      run.ledgerRows.sets.splice(i, 1);
    }],
    ['one ledger row was never sealed', () => {
      run.ledgerRows.sets[1][setIndex('closeout_write_id')] = '';
    }],
    ['a row was sealed under a different write id', () => {
      run.ledgerRows.sets[1][setIndex('closeout_write_id')] = 'w_someone_else';
    }],
  ];

  for (const [label, mutate] of mutations) {
    restore();
    mutate();
    assert.throws(() => assertLedgerRowsGenuine(run), Error,
      `the guard must go red when ${label}`);
  }
  restore();
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
