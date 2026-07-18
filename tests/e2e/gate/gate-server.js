'use strict';
/*
 * F10S-GATE harness server — the REAL Atlas app (index.js: real routes, real parser,
 * real trust loop, real proof fields) with the Google Sheets client replaced
 * IN-PROCESS by an in-memory stub BEFORE the app loads (the same require.cache
 * seam the api-smoke suite has always used).
 *
 * Non-destructive by construction:
 *   - no Google credentials are loaded — the env below is stub-only and sheets.js
 *     never initializes googleapis, so there is no client that COULD reach a sheet;
 *   - every append lands in this process's memory, inspectable at GET /__gate/state
 *     so the rerun transcript can show exactly what the app "wrote";
 *   - no LLM key is present, so every coach surface uses its deterministic fallback;
 *   - Playwright drives the UI with navigator.webdriver=true, so the client itself
 *     marks every request synthetic (x-atlas-request-origin: playwright) per the
 *     live-testing playbook — the run can never masquerade as owner activity.
 *
 * Prints GATE_PORT=<port> on stdout once listening (dynamic port; parallel-safe).
 */

process.env.ATLAS_API_KEY = process.env.ATLAS_GATE_KEY || 'playwright-gate-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// Not a real key — sheets.js is fully stubbed below, so this is never parsed; it
// only satisfies config validation. No PEM header, so secret scans stay quiet.
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
// Deterministic coach voice + zero outbound calls: no LLM key may reach the app,
// even if a dev shell exported one. index.js's dotenv load never overrides these.
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
// Pin every behavior/telemetry flag to the deterministic baseline. An inherited
// shadow-persistence flag (e.g. ATLAS_FLIGHT_RECORDER=1 in a live-validation
// shell) would make the real middleware append telemetry rows through the stub
// and spuriously trip the gate's zero-appends evidence (Codex P2, PR #1067).
delete process.env.ATLAS_FLIGHT_RECORDER;
delete process.env.ATLAS_INTENT_ROUTER;
delete process.env.ATLAS_BRAIN_SHADOW_PERSIST;
delete process.env.ATLAS_DRIFT_SHADOW;
delete process.env.ATLAS_COACH_ENGINE;
// F10D-3: two postures from one harness.
//  - DEFAULT (flag absent): the ledger write-enable flags stay absent — every
//    Session_Plan_Sets/Session_Plans lane is dry-run, exactly as production is
//    configured before the owner's F10D enablement. The F10S-GATE spec runs here
//    and proves ZERO appends / ZERO updates end-to-end.
//  - LEDGER SANDBOX (ATLAS_GATE_LEDGER_SANDBOX=1): the same in-memory stub with
//    the two flags ON and a stubbed Session_Plan_Sets tab present, so the F10D
//    closeout spec proves accept-checkpoint → single confirmation → approved
//    seal end-to-end. Nothing real is reachable in either posture — sheets.js
//    is replaced in-process below, and no Google client ever initializes.
const LEDGER_SANDBOX = process.env.ATLAS_GATE_LEDGER_SANDBOX === '1';
if (LEDGER_SANDBOX) {
  process.env.SESSION_PLAN_SETS_WRITE_ENABLED = '1';
  process.env.ATLAS_SESSION_PLANS_WRITE = '1';
} else {
  delete process.env.SESSION_PLAN_SETS_WRITE_ENABLED;
  delete process.env.ATLAS_SESSION_PLANS_WRITE;
}

const { logCleanedColumns, effortColumns, sessionPlanSetsColumns, sessionPlansColumns } = require('../../../config/columns');

// --- Synthetic training history (no owner data) ---------------------------------
// Enough Log_Cleaned history that identity resolution, recommendations, and the
// engine's todays-read all have something real to chew on. Lift codes mirror the
// canonical catalog so enrichment resolves cleanly.
const logRows = [
  ['2026-07-10', 'GATE-H1', 'Romanian Deadlift', 'Romanian Deadlift', 'Hamstrings', 'RDL01', '1', '235', '6', '3', ''],
  ['2026-07-10', 'GATE-H1', 'Romanian Deadlift', 'Romanian Deadlift', 'Hamstrings', 'RDL01', '2', '235', '6', '3', ''],
  ['2026-07-10', 'GATE-H1', 'Romanian Deadlift', 'Romanian Deadlift', 'Hamstrings', 'RDL01', '3', '235', '5', '2', ''],
  ['2026-07-10', 'GATE-H1', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '225', '5', '2', ''],
  ['2026-07-10', 'GATE-H1', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '2', '225', '5', '2', ''],
  ['2026-07-12', 'GATE-H2', 'Overhead Press', 'Overhead Press', 'Shoulders', 'OHP01', '1', '110', '6', '2', ''],
  ['2026-07-12', 'GATE-H2', 'Overhead Press', 'Overhead Press', 'Shoulders', 'OHP01', '2', '110', '6', '2', ''],
  ['2026-07-12', 'GATE-H2', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '215', '5', '2', ''],
  ['2026-07-14', 'GATE-H3', 'Front Squat', 'Front Squat', 'Legs', 'FSQ01', '1', '175', '7', '2', '']
];

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Romanian Deadlift', 'Hamstrings', 'RDL01', 'Romanian Deadlift', 'romanian deadlift|rdl|rdls'],
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'back squat|squat|squats'],
  ['Front Squat', 'Legs', 'FSQ01', 'Front Squat', 'front squat'],
  ['Overhead Press', 'Shoulders', 'OHP01', 'Overhead Press', 'overhead press|ohp'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench']
];

const state = {
  appendCalls: [],   // every appendRows({ tabName, rows }) in arrival order
  deleteCalls: [],
  ensureTabCalls: [], // recorded, never acted on — no tab can be created here
  updateCalls: [],   // every updateColumnCells call (the seal stamp primitive)
  planSetRows: [],   // sandbox: the materialized Session_Plan_Sets tab (appends + seal stamps)
  failNextSeal: false // sandbox: armed via the state server; the next seal attempt throws once
};

// Rows appended DURING the run must be visible to the safety read-backs, exactly
// as the real sheet would be (composite-key dedup, duplicate-session guard).
function appendedRowsFor(tab) {
  return state.appendCalls.filter(c => c.tabName === tab).flatMap(c => c.rows);
}

const fakeSheets = {
  appendRows: async (tabName, rows) => {
    state.appendCalls.push({ at: new Date().toISOString(), tabName, rows: rows.map(r => [...r]) });
    // Sandbox: Session_Plan_Sets appends MATERIALIZE, so the closeout seal can
    // stamp the very rows the accept checkpoint durably wrote (amendment A2).
    if (tabName === 'Session_Plan_Sets') for (const r of rows) state.planSetRows.push([...r]);
    return { data: { updates: { updatedRange: `${tabName}!A100:L${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async range => {
    if (!LEDGER_SANDBOX) return [];
    const r = String(range || '');
    // The capture layers validate exact headers before writing.
    if (r.startsWith('Session_Plans!')) return [[...sessionPlansColumns]];
    if (r.startsWith('Session_Plan_Sets!A1:A1')) return [[sessionPlanSetsColumns[0]]];
    if (r.startsWith('Session_Plan_Sets!')) return [[...sessionPlanSetsColumns]];
    return [];
  },
  updateColumnCells: async (tabName, columnLetter, cells) => {
    if (state.failNextSeal) {
      state.failNextSeal = false;
      state.updateCalls.push({ at: new Date().toISOString(), tabName, columnLetter, failed: true, cells: cells.map(c => ({ ...c })) });
      throw new Error('Simulated seal outage (armed via /fail-next-seal)');
    }
    state.updateCalls.push({ at: new Date().toISOString(), tabName, columnLetter, cells: cells.map(c => ({ ...c })) });
    if (tabName === 'Session_Plan_Sets') {
      const colIdx = columnLetter.charCodeAt(0) - 65;
      for (const c of cells) {
        const dataIdx = c.row - 2;
        if (state.planSetRows[dataIdx]) state.planSetRows[dataIdx][colIdx] = c.value;
      }
    }
    return { data: { totalUpdatedCells: cells.length } };
  },
  deleteRowsByRange: async (...args) => { state.deleteCalls.push(args); return { ok: true }; },
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => appendedRowsFor('Effort').map(r => String(r[1] || '')),
  // The REAL server's duplicate partition joins with '||' — the delimiter must
  // match or a retry's dedup never fires and rows re-append (F10D-RT heal lane).
  getLogCompositeKeys: async () =>
    appendedRowsFor('Log_Cleaned').map(r => `${r[1]}||${r[2]}||${r[6]}`.toLowerCase()),
  getRecentRows: async (tabName, maxRows = 100) => {
    if (tabName === 'Log_Cleaned') return logRows.concat(appendedRowsFor('Log_Cleaned')).slice(-maxRows);
    if (tabName === 'Effort') return appendedRowsFor('Effort').slice(-maxRows);
    return [];
  },
  getSheetRows: async tabName => {
    if (tabName === 'Log_Cleaned') return logRows.concat(appendedRowsFor('Log_Cleaned'));
    if (tabName === 'Effort') return appendedRowsFor('Effort');
    if (tabName === 'Session_Plans') return appendedRowsFor('Session_Plans');
    if (tabName === 'Session_Plan_Sets') return state.planSetRows.map(r => [...r]);
    return [];
  },
  getHeaderRow: async tabName => {
    if (tabName === 'Log_Cleaned') return [...logCleanedColumns];
    if (tabName === 'Effort') return [...effortColumns];
    if (LEDGER_SANDBOX && tabName === 'Session_Plan_Sets') return [...sessionPlanSetsColumns];
    return [];
  },
  getSpreadsheetTabs: async () => [
    'Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary',
    'Bodyweight', 'Coaching_Notes', 'Constraints', 'Deload_State', 'Modality_Log', 'Session_Plans',
    ...(LEDGER_SANDBOX ? ['Session_Plan_Sets'] : [])
  ],
  ensureSheetTab: async tabName => { state.ensureTabCalls.push(tabName); return { existed: true }; },
  getSafeSpreadsheetConfig: () => ({ sheetId: 'stub-sheet', configured: true }),
  isTransientAppendError: () => false,
  retryWithBackoff: async fn => fn(),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort'
};

const sheetsPath = require.resolve('../../../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const { app } = require('../../../index.js');

// Harness-only observability on its OWN server (the app's 404 catch-all is already
// registered, so a route added post-require would never match): what the app believes
// it wrote, for the transcript's write-evidence appendix.
const http = require('node:http');
const stateServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  // Harness control: arm a one-shot seal outage so the F10D spec can prove the
  // honest-partial report and the reachable idempotent retry.
  if (String(req.url || '').startsWith('/fail-next-seal')) {
    state.failNextSeal = true;
    res.end(JSON.stringify({ armed: true }));
    return;
  }
  res.end(JSON.stringify({
    appends: state.appendCalls,
    deletes: state.deleteCalls,
    ensure_tab_calls: state.ensureTabCalls,
    updates: state.updateCalls,
    plan_set_rows: state.planSetRows,
    ledger_sandbox: LEDGER_SANDBOX,
    google_client_initialized: false,
    sheets_stubbed_in_memory: true
  }));
});

const server = app.listen(0, () => {
  stateServer.listen(0, () => {
    // The spec parses these lines to find the dynamic ports.
    console.log(`GATE_STATE_PORT=${stateServer.address().port}`);
    console.log(`GATE_PORT=${server.address().port}`);
  });
});
