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
 *   - the model posture is explicit and asserted (see MODEL POSTURE below) — the
 *     default harness is model-DOWN and fails closed rather than run mislabeled;
 *   - Playwright drives the UI with navigator.webdriver=true, so the client itself
 *     marks every request synthetic (x-atlas-request-origin: playwright) per the
 *     live-testing playbook — the run can never masquerade as owner activity.
 *
 * Prints GATE_PORT=<port> on stdout once listening (dynamic port; parallel-safe).
 */

// ── The harness is the ONLY authority on this process's environment ──────────────
//
// index.js line 3 runs `require('dotenv').config()`. dotenv never OVERRIDES a
// variable that already exists, which made every `delete process.env.X` below read
// as safe — but a DELETED variable is not an existing one, so dotenv SET each of
// them again from a local `.env`, after the deletes and before the first request.
//
// Measured on main, in a directory whose `.env` carries GEMINI_API_KEY: this
// "no LLM key" harness answered GET /api/coach/health with configured:true and made
// a real outbound call to generativelanguage.googleapis.com. Every other delete in
// this file was restored the same way — the five telemetry flags AND the two ledger
// write-enable flags, so the default posture silently claimed dry-run while the
// write-enable flags were on.
//
// One winner, not a reconciliation: dotenv is require-cache neutralized here, BEFORE
// index.js can load it, so nothing may repopulate what this file decides. The harness
// wants no `.env` value at all — every variable it needs is either set explicitly
// below or passed by the spawning spec's `env`. Both this file and index.js resolve
// `dotenv` to the same node_modules path, so this single cache entry covers both.
try {
  const dotenvPath = require.resolve('dotenv');
  require.cache[dotenvPath] = {
    id: dotenvPath,
    filename: dotenvPath,
    loaded: true,
    exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
  };
} catch { /* dotenv not installed — nothing to neutralize */ }

process.env.ATLAS_API_KEY = process.env.ATLAS_GATE_KEY || 'playwright-gate-key';

// ── SHEETS POSTURE — default in-memory; TEMPORARY sandbox-live for F-SB4B ───────
//
// DEFAULT (flag absent): `sheets.js` is replaced in-process by the in-memory stub
//   further down. No Google client can initialize, so nothing COULD reach a workbook.
//   Every existing gate spec runs here and is byte-identical to before this block.
//
// SANDBOX-LIVE (ATLAS_GATE_SANDBOX_LIVE=1): the REAL `sheets.js` is loaded against the
//   repository-declared sandbox workbook so the F-SB4B owner-pattern rehearsal can prove
//   durable writes through the real client, the real routes, and a real Google Sheet.
//   TEMPORARY F-SB4B machinery, restored in rehearsal form from the proven Stage A
//   implementation (built PR #1227, sunset PR #1234) under the owner resolution recorded
//   in docs/ATLAS_V1_EXECUTION_PLAN.md (F-SB4B, 2026-08-03). Named for F-SB4C removal:
//   this posture block, the write guard, the sandbox preflight, and the durable-row
//   verifier all leave in the F-SB4C completion PR.
//
// The ambient GOOGLE_SHEETS_ID is NEVER inherited in either mode. That is the single
// most dangerous value in this file: an operator shell here resolves it to a NON-sandbox
// workbook, so inheriting it would point a write-enabled browser run at production. It is
// therefore ASSIGNED from config/sandboxSheet.js — the one declared literal — and then
// re-verified after `sheets.js` has captured it, because assignment alone is not proof.
const SANDBOX_LIVE = process.env.ATLAS_GATE_SANDBOX_LIVE === '1';
const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6 } = require('../../../config/sandboxSheet');

if (SANDBOX_LIVE) {
  // Assigned, never inherited. `sheets.js` reads this at module load, so it must be set
  // before the require below — and before index.js — or the capture takes the wrong id.
  process.env.GOOGLE_SHEETS_ID = SANDBOX_SPREADSHEET_ID;
  // The service account must come from the operator's environment. dotenv is neutralized
  // above, so there is no file path by which these could arrive; if the operator did not
  // export them, the preflight refuses to start rather than serve a half-configured run.
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    console.error('GATE_POSTURE_ERROR: ATLAS_GATE_SANDBOX_LIVE=1 requires GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY in the spawning environment.');
    process.exit(2);
  }
} else {
  process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
  // Not a real key — sheets.js is fully stubbed below, so this is never parsed; it
  // only satisfies config validation. No PEM header, so secret scans stay quiet.
  process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
}
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
// ── MODEL POSTURE — exactly two modes, both explicit, neither ever inferred ──────
//
// MODEL-DOWN (default, flag absent): the provider is unavailable BY CONSTRUCTION.
//   The three provider keys are deleted, dotenv can no longer restore them (above),
//   and the assertion after the app loads EXITS the harness rather than serve a
//   spec a mislabeled server. Every coach surface takes its deterministic fallback,
//   which is what the F10S/F10D specs already assume and what keeps them repeatable.
//
// MODEL-UP (ATLAS_GATE_MODEL_UP=1): opt-in only. Model-up is never inferred from a
//   key merely being present — that inference IS the defect this block fixes. The
//   keys are left intact, and a MISSING key is a hard failure, because a run that
//   calls itself model-up must never quietly degrade into a model-down run. The key
//   comes from the SPAWNING environment, never from `.env` (neutralized above): one
//   rule, no exceptions, so there is no path by which a stray file changes a posture.
//
// Note what this flag does NOT do: it does not PROVE model-up. Proof is a property
// of the run, not the harness — /api/coach/health must report configured AND ok with
// the expected model, and an eligible coach turn must show an unambiguous
// live-provider source. A configured-but-unreachable provider reports ok:false and
// so can never satisfy that bar (absence of outage wording is not proof).
const MODEL_UP = process.env.ATLAS_GATE_MODEL_UP === '1';
const PROVIDER_KEYS = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
if (!MODEL_UP) for (const key of PROVIDER_KEYS) delete process.env[key];
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

// ── The F-SB4B REHEARSAL posture is BOTH flags together ─────────────────────────
// Stage A refused this combination outright, because the ledger posture then required
// materializing a Session_Plan_Sets tab and creating a tab in a real workbook is
// owner-reserved. That blocker is resolved: the OWNER created both plan-ledger tabs in
// the sandbox workbook (recorded in the execution plan, F-SB4B resolution 2026-08-03),
// so the combined posture no longer creates anything — the preflight below REQUIRES
// both tabs to already exist with exact contract headers and refuses to serve
// otherwise. The two write-enable flags set above are the harness process's own
// environment, never a production configuration change. `ensureSheetTab` still always
// refuses in the write guard, so this posture remains structurally incapable of a
// schema change. TEMPORARY — leaves with the rest of the F-SB4B machinery at F-SB4C.
const REHEARSAL_LIVE = SANDBOX_LIVE && LEDGER_SANDBOX;
// Exactly ONE live posture exists: the combined rehearsal. The Stage A standalone
// sandbox-live posture stays sunset — restoring it would be a second live mode with no
// consumer, which is exactly the surface the smallest-necessary rule forbids.
if (SANDBOX_LIVE && !LEDGER_SANDBOX) {
  console.error('GATE_POSTURE_ERROR: ATLAS_GATE_SANDBOX_LIVE=1 requires ATLAS_GATE_LEDGER_SANDBOX=1 — the F-SB4B rehearsal posture is the combined one; the Stage A standalone live posture was sunset and is not restored.');
  process.exit(2);
}

// SCRIPTED COACH (ATLAS_GATE_COACH_SCRIPT=1) — an opt-in COACH-PROSE posture, default OFF.
//
// This is NOT a third model posture: it calls nothing outbound, so it is model-DOWN by
// the definition above and reports as such. The default model-down harness takes every
// coach surface's deterministic fallback, which cannot prove a guard that acts on MODEL
// PROSE, because a down model produces none. This posture makes the model an adversary
// the spec controls:
// `services/coach` is require-cache stubbed to report configured and to return whatever
// reply the harness has armed via the state server's `/arm-coach-reply`. It calls nothing
// outbound — there is still no key and no provider client — so it is not "model-up"; it is
// a scripted stand-in whose only purpose is to feed the real route a known bad reply and
// prove the real server-side grounding rejects it before the browser renders it.
//
// Flag absent → this block does not run and the harness is byte-identical to before.
const COACH_SCRIPT = process.env.ATLAS_GATE_COACH_SCRIPT === '1';
const scriptedCoach = { reply: null };
if (COACH_SCRIPT) {
  const coachPath = require.resolve('../../../services/coach');
  require.cache[coachPath] = {
    id: coachPath, filename: coachPath, loaded: true,
    exports: {
      isConfigured: () => true,
      coachModel: () => 'scripted-gate-coach',
      generateCoachMessage: async () => null,
      generatePlanMessage: async () => null,
      generateChatReply: async () => ({ reply: scriptedCoach.reply }),
      findRegisterViolations: () => [],
      looksLikePrClaim: () => false,
      sanitizeFacts: (f) => f,
      sanitizeChatContext: (c) => c,
    },
  };
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
  failNextSeal: false, // sandbox: armed via the state server; the next seal attempt throws once
  losePlanSetRows: false, // sandbox: armed via the state server; Session_Plan_Sets appends report
                          // success but never materialize — a LOST accept checkpoint
  visionCalls: [],   // every stubbed vision parse (the F10D screenshot scenario's evidence)
  refusals: []       // sandbox-live: every guard refusal (always a canary FAILURE, never a pass)
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
    // Unless the LOST-CHECKPOINT knob is armed: the append is still recorded and still
    // reports success to its caller, but the rows never land — so the closeout seal
    // later reads an empty ledger for a session that DID declare planned items. That
    // is the exact state the owner hit on Stage B workout 1 (F-SB1).
    if (tabName === 'Session_Plan_Sets' && !state.losePlanSetRows) {
      for (const r of rows) state.planSetRows.push([...r]);
    }
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

// ── TEMPORARY F-SB4B write guard (sunset: F-SB4C) ───────────────────────────────
// SANDBOX-LIVE only: the REAL adapter, wrapped in a guard NARROWER than the app.
// Restored in rehearsal form from the proven Stage A guard (PR #1227). It fails CLOSED:
//
//   • every mutating call re-checks `isSandboxSheet` at CALL TIME, so even if something
//     could change the resolved workbook mid-run, the write is refused, not attempted;
//   • appends are allowed ONLY to the rehearsal's authorized tabs. Stage A wrote
//     Log_Cleaned and Effort; the F-SB4B rehearsal adds Session_Plans and
//     Session_Plan_Sets — the two tabs the OWNER created for it (recorded resolution
//     2026-08-03) — and ONLY under the combined REHEARSAL_LIVE posture. A shadow or
//     telemetry append is refused, so a flag flipped anywhere cannot widen the blast
//     radius;
//   • `ensureSheetTab` ALWAYS refuses. Creating a tab is a schema change, and this
//     harness must be structurally incapable of one, not merely uninstructed;
//   • `deleteRowsByRange` ALWAYS refuses — the rehearsal adds bounded rows and never
//     deletes sandbox data (the owner-created tabs and their rows are owner property);
//   • `updateColumnCells` refuses EXCEPT the one cell class the product under test
//     must stamp: the Session_Plan_Sets closeout-seal column, REHEARSAL_LIVE only.
//     The store it serves touches only the blank closeout_write_id cell of the current
//     session's rows and fails closed on a conflicting seal, so prior rows cannot be
//     rewritten through this opening.
//
// A refusal is recorded AND thrown. Recording alone would let a silent product retry
// hide it; throwing alone would leave no evidence. The scorecard treats any refusal as
// a hard failure — a refusal means production tried something this rehearsal is not
// allowed to do; that is a finding, never a pass.
const WRITABLE_TABS = new Set(REHEARSAL_LIVE
  ? ['Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets']
  : ['Log_Cleaned', 'Effort']);
const SEAL_COL_LETTER = (() => {
  let n = sessionPlanSetsColumns.indexOf('closeout_write_id') + 1;
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
})();

function buildGuardedSheets() {
  const real = require('../../../sheets');

  function assertSandboxNow(operation, tabName) {
    const cfg = real.getSafeSpreadsheetConfig('test');
    if (cfg.isSandboxSheet !== true || cfg.id !== SANDBOX_SPREADSHEET_ID) {
      const why = `resolved workbook is not the declared sandbox (last6 ${cfg.idLast6 || 'none'})`;
      state.refusals.push({ at: new Date().toISOString(), operation, tabName: tabName || null, reason: why });
      throw new Error(`GATE_SANDBOX_GUARD: refused ${operation} — ${why}`);
    }
  }

  function refuse(operation, tabName, reason) {
    state.refusals.push({ at: new Date().toISOString(), operation, tabName: tabName || null, reason });
    throw new Error(`GATE_SANDBOX_GUARD: refused ${operation} — ${reason}`);
  }

  return {
    ...real,
    appendRows: async (tabName, rows) => {
      assertSandboxNow('appendRows', tabName);
      if (!WRITABLE_TABS.has(tabName)) {
        refuse('appendRows', tabName, `tab is outside the rehearsal's authorized write set (${[...WRITABLE_TABS].join(', ')})`);
      }
      // Recorded BEFORE the call: an append that throws after Google committed it must
      // still appear in the evidence, or the transcript would under-report a real write.
      const entry = { at: new Date().toISOString(), tabName, rows: rows.map(r => [...r]), live: true };
      state.appendCalls.push(entry);
      const result = await real.appendRows(tabName, rows);
      entry.updated_range = result && result.data && result.data.updates
        ? result.data.updates.updatedRange : null;
      return result;
    },
    updateColumnCells: async (tabName, columnLetter, cells) => {
      assertSandboxNow('updateColumnCells', tabName);
      if (!(REHEARSAL_LIVE && tabName === 'Session_Plan_Sets' && columnLetter === SEAL_COL_LETTER)) {
        refuse('updateColumnCells', tabName,
          `only the Session_Plan_Sets seal column (${SEAL_COL_LETTER}) may be stamped, and only under the combined rehearsal posture`);
      }
      const entry = { at: new Date().toISOString(), tabName, columnLetter, cells: cells.map(c => ({ ...c })), live: true };
      state.updateCalls.push(entry);
      return real.updateColumnCells(tabName, columnLetter, cells);
    },
    ensureSheetTab: async (tabName) => {
      state.ensureTabCalls.push(tabName);
      refuse('ensureSheetTab', tabName, 'creating or ensuring a tab is a schema change and is owner-reserved');
    },
    deleteRowsByRange: async (...args) => {
      refuse('deleteRowsByRange', args && args[0], 'the rehearsal never deletes existing sandbox data');
    },
  };
}

// ── The Sheets adapter the app will see ─────────────────────────────────────────
// DEFAULT: the in-memory stub above (unchanged, and the only mode every permanent
// gate spec uses). SANDBOX-LIVE: the guarded real adapter — TEMPORARY F-SB4B.
require.cache[sheetsPath] = {
  id: sheetsPath,
  filename: sheetsPath,
  loaded: true,
  exports: SANDBOX_LIVE ? buildGuardedSheets() : fakeSheets,
};

// The vision LLM is likewise replaced in-process: no key exists here (deleted
// above), so the real module could only fail — the stub returns a DETERMINISTIC
// synthetic Apple-Watch-style parse so the F10D screenshot-closeout scenario can
// prove the parsed effort riding the single confirmation. The parse itself is
// not under test; the closeout ROUTING is. Every call is recorded as evidence.
const realVision = require('../../../services/vision');
const visionPath = require.resolve('../../../services/vision');
require.cache[visionPath] = {
  id: visionPath, filename: visionPath, loaded: true,
  exports: {
    ...realVision,
    parseWorkoutScreenshot: async imagePath => {
      state.visionCalls.push({ at: new Date().toISOString(), imagePath: String(imagePath || '') });
      // The REAL module's parsed_metrics contract is camelCase (see
      // services/vision.js normalizeParsedMetrics) — the stub must match it.
      return {
        status: 'parsed',
        parsed_metrics: {
          date: '2026-07-18',
          duration: '48:22',
          activeCalories: 389,
          totalCalories: 512,
          averageHR: 131,
          peakHR: 168,
        },
      };
    },
  },
};

const { app } = require('../../../index.js');

// ── Posture assertion — a harness that CLAIMS a posture must BE in it ─────────────
// Loading the app is the only window in which anything could repopulate the
// environment, so the claim is checked here rather than trusted. Failure exits
// non-zero; every spec's spawn handler rejects on an early exit, so a mislabeled
// harness surfaces as a loud gate failure instead of a quietly mislabeled run.
const modelPosture = MODEL_UP ? 'model-up' : 'model-down';
const modelUpProof = { model: null, reachable: false };

// MODEL-DOWN is proven by absence: no provider key can be reached, so no call is made.
function assertModelDown() {
  const present = PROVIDER_KEYS.filter(key => process.env[key]);
  if (present.length) {
    console.error(`GATE_POSTURE_ERROR: model-down harness has provider key(s) present after app load: ${present.join(', ')}`);
    process.exit(2);
  }
}

// MODEL-UP is proven by REACHABILITY, never by key presence. A present-but-expired key,
// a bad GEMINI_COACH_MODEL, a quota block, or an unreachable provider would each leave
// the coach routes silently taking their deterministic fallbacks while the harness
// advertised model-up — the same unbacked claim this file exists to remove, just moved.
// So the posture is not published until the provider actually answers.
//
// `pingGemini` calls the SAME model `coachModel()` resolves, so a successful ping proves
// both legs the harness can prove: configured AND reachable, with the expected model. The
// third leg — an eligible coach turn showing an unambiguous live-provider source — is a
// property of the RUN, and stays the consuming spec's obligation.
async function assertModelUp() {
  // Contradictory by construction: the scripted stub REPLACES services/coach, so no
  // provider is reachable however many keys are present. Serving that as "model-up"
  // would be the same lie in a new costume, so refuse the combination outright.
  if (COACH_SCRIPT) {
    console.error('GATE_POSTURE_ERROR: ATLAS_GATE_MODEL_UP=1 with ATLAS_GATE_COACH_SCRIPT=1 — a scripted coach calls no provider and can never be a model-up run.');
    process.exit(2);
  }
  const coach = require('../../../services/coach');
  if (!coach.isConfigured()) {
    console.error('GATE_POSTURE_ERROR: ATLAS_GATE_MODEL_UP=1 but the coach reports unconfigured — a model-up run may not degrade into a model-down one.');
    process.exit(2);
  }
  try {
    await coach.pingGemini({ timeoutMs: 10000 });
  } catch (error) {
    console.error(`GATE_POSTURE_ERROR: ATLAS_GATE_MODEL_UP=1 but the provider is not reachable, so model-up is unproven: ${error && error.message}`);
    process.exit(2);
  }
  modelUpProof.model = coach.coachModel();
  modelUpProof.reachable = true;
}

// ── TEMPORARY F-SB4B SANDBOX PREFLIGHT (sunset: F-SB4C) ─────────────────────────
// Restored in rehearsal form from the proven Stage A preflight (PR #1227). Every check
// is a precondition for a REAL write and runs before `app.listen`, so a browser can
// never attach to a server whose workbook has not been verified. Any failure exits
// non-zero; the spec's spawn handler rejects on an early exit, so an unverified sandbox
// surfaces as a loud refusal rather than a quiet production write.
//
// The FIRST check is the resolved id compared against the declared literal. Assignment
// happens at the top of this file, but `sheets.js` captured the value at its own module
// load, so this reads back what the adapter ACTUALLY holds.
//
// What changed from Stage A, per the recorded 2026-08-03 resolution: the plan-ledger
// tabs must now be PRESENT with EXACT contract headers (the owner created them; the
// rehearsal proves Session_Plans / Session_Plan_Sets truth against them), and the two
// ledger write-enable flags are the posture rather than a violation. Telemetry
// persistence stays off — synthetic rows must never land in the shadow evidence tabs.
const { PREFLIGHT_QUOTA_ATTEMPTS, PREFLIGHT_QUOTA_BACKOFF_MS } = require('./rehearsal-child-env');
const sandboxPreflight = { checks: [], ok: false };

async function assertSandboxLive() {
  const sheets = require('../../../sheets');
  const record = (name, ok, detail) => {
    sandboxPreflight.checks.push({ name, ok: ok === true, detail: detail || null });
    if (ok !== true) {
      console.error(`GATE_SANDBOX_ERROR: ${name} — ${detail || 'failed'}`);
      process.exit(2);
    }
  };

  const cfg = sheets.getSafeSpreadsheetConfig('test');
  record('safe_spreadsheet_config_resolves', cfg.canVerify === true,
    'getSafeSpreadsheetConfig could not resolve a workbook id');
  record('resolved_workbook_is_declared_sandbox', cfg.id === SANDBOX_SPREADSHEET_ID,
    `resolved workbook last6 ${cfg.idLast6 || 'none'} != declared sandbox last6 ${SANDBOX_SPREADSHEET_ID_LAST6}`);
  record('is_sandbox_sheet_true', cfg.isSandboxSheet === true,
    'getSafeSpreadsheetConfig().isSandboxSheet is not true');

  // Production fingerprint — the same predicate the telemetry classifier uses.
  const { isProductionRuntime } = require('../../../services/evidenceProvenance');
  const productionRuntime = isProductionRuntime({
    nodeEnv: process.env.NODE_ENV,
    isSandboxSheet: cfg.isSandboxSheet === true,
  });
  record('production_fingerprint_false', productionRuntime === false,
    'the runtime fingerprints as production');

  // Reachability, retried with FLAT bounded backoff (a read-quota rejection is a
  // transient environment condition, not an unreachable sandbox). Reads only.
  let tabs = [];
  let lastError = null;
  for (let attempt = 1; attempt <= PREFLIGHT_QUOTA_ATTEMPTS; attempt += 1) {
    try {
      tabs = await sheets.getSpreadsheetTabs();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const quota = /quota|rate limit|429/i.test(String(error && error.message));
      if (attempt < PREFLIGHT_QUOTA_ATTEMPTS) {
        await new Promise(r => setTimeout(r, quota ? PREFLIGHT_QUOTA_BACKOFF_MS : 2000 * attempt));
      }
    }
  }
  if (lastError) {
    const quota = /quota/i.test(String(lastError.message));
    record('sandbox_reachable', false,
      `${quota ? 'Sheets READ QUOTA exhausted (transient — wait a minute and rerun)' : 'could not list tabs'}: ${lastError.message}`);
  }
  record('sandbox_reachable', Array.isArray(tabs) && tabs.length > 0,
    'the sandbox workbook returned no tabs');
  for (const tab of WRITABLE_TABS) {
    record(`tab_present_${tab}`, tabs.includes(tab),
      `required tab ${tab} is absent from the sandbox workbook`);
  }

  // Log_Cleaned / Effort headers: the workbook's header row holds DISPLAY LABELS
  // ("Set #") while config/columns.js holds contract field names, so the alias-aware
  // canonicalizer — the one production reads through — decides the match.
  const { canonicalizeHeaderName } = require('../../../scripts/flight-review');
  for (const [tab, contract] of [['Log_Cleaned', logCleanedColumns], ['Effort', effortColumns]]) {
    let header = [];
    try { header = await sheets.getHeaderRow(tab); } catch (error) {
      record(`header_readable_${tab}`, false, `${tab} header unreadable: ${error && error.message}`);
    }
    const known = new Set(contract);
    const mismatched = contract
      .map((col, i) => ({ col, at: i, got: canonicalizeHeaderName(header[i], known) }))
      .filter((x) => x.got !== x.col);
    record(`header_matches_contract_${tab}`, mismatched.length === 0,
      `${tab} header mismatch at ${mismatched.map((m) => `col ${m.at}: expected ${m.col}, got ${m.got}`).join('; ')}`);
    record(`header_covers_contract_${tab}`, header.length >= contract.length,
      `${tab} header has ${header.length} columns, fewer than the ${contract.length}-column contract`);
  }

  // Plan-ledger headers: EXACT, position by position — the same comparison the capture
  // layers make before every write, so a preflight pass means the product's own header
  // gates will pass for the same reason, not a looser one.
  for (const [tab, contract] of [['Session_Plans', sessionPlansColumns], ['Session_Plan_Sets', sessionPlanSetsColumns]]) {
    let header = [];
    try { header = await sheets.getHeaderRow(tab); } catch (error) {
      record(`header_readable_${tab}`, false, `${tab} header unreadable: ${error && error.message}`);
    }
    const exact = header.length >= contract.length
      && contract.every((col, i) => String(header[i] == null ? '' : header[i]).trim() === col);
    record(`header_exact_${tab}`, exact,
      `${tab} header does not exactly match the ${contract.length}-column contract`);
  }

  // The ledger write-enable flags ARE the combined posture — record them as facts.
  record('ledger_write_flags_on',
    process.env.SESSION_PLAN_SETS_WRITE_ENABLED === '1' && process.env.ATLAS_SESSION_PLANS_WRITE === '1',
    'the combined rehearsal posture requires both ledger write-enable flags in this process');

  // Telemetry persistence must be off, or the real adapter would append shadow rows to
  // the sandbox's Brain_Shadow / Intent_Shadow / Flight_Recorder tabs — writes this
  // rehearsal never authorized, and synthetic rows landing in evidence tabs.
  record('telemetry_persistence_off',
    !process.env.ATLAS_FLIGHT_RECORDER && !process.env.ATLAS_BRAIN_SHADOW_PERSIST,
    'a telemetry persistence flag is set');

  sandboxPreflight.ok = true;
}

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
  // Harness control: lose every Session_Plan_Sets append from here on. The accept
  // checkpoint still succeeds from the app's point of view; the rows simply are not
  // there at closeout. This is the ONLY way to reach `no_ledger` with the write flag
  // on, and it is a distinct failure from /fail-next-seal — that one breaks the seal
  // call, this one leaves nothing for a working seal to bind.
  if (String(req.url || '').startsWith('/lose-plan-set-rows')) {
    state.losePlanSetRows = true;
    res.end(JSON.stringify({ armed: true }));
    return;
  }
  // Harness control (scripted-coach posture only): arm the exact prose the stubbed model
  // will return on the next chat turn, so a spec can feed the real route a known
  // fabrication. Refused unless the posture is explicitly enabled.
  if (String(req.url || '').startsWith('/arm-coach-reply')) {
    if (!COACH_SCRIPT) {
      res.statusCode = 409;
      res.end(JSON.stringify({ armed: false, error: 'ATLAS_GATE_COACH_SCRIPT=1 required' }));
      return;
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    scriptedCoach.reply = u.searchParams.get('reply') || null;
    res.end(JSON.stringify({ armed: true }));
    return;
  }
  // TEMPORARY F-SB4B durable-row verifier (sunset: F-SB4C), restored in rehearsal form
  // from the proven Stage A verifier. READ-ONLY, sandbox-live only, on the HARNESS port —
  // never the Express app, so no permanent product endpoint exposing sheet rows exists
  // for a temporary test. The rehearsal must check what the WORKBOOK holds, not what the
  // app believes it wrote — those are the same claim twice otherwise.
  //
  // ISOLATION IS STRUCTURAL HERE (recorded instruction, rule 5): the verifier answers
  // ONLY for the session_id it is given — the identity the SERVER allocated at
  // acceptance and the client adopted — so a prior rehearsal's rows, the owner's setup
  // rows, and every other session's rows are invisible to the caller by construction.
  // It reports per-tab totals alongside, so a scorecard can additionally prove its
  // session ADDED exactly its declared rows without reading anyone else's content.
  if (String(req.url || '').startsWith('/durable-rows')) {
    if (!REHEARSAL_LIVE) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: 'the combined rehearsal posture (ATLAS_GATE_SANDBOX_LIVE=1 + ATLAS_GATE_LEDGER_SANDBOX=1) is required' }));
      return;
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    const wantSession = String(u.searchParams.get('session_id') || '').trim();
    if (!wantSession) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'session_id is required — the verifier answers only for one session identity' }));
      return;
    }
    (async () => {
      const real = require('../../../sheets');
      const colLetter = (i) => {
        let n = i + 1; let s = '';
        while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
        return s;
      };
      // AT MOST TWO Sheets read requests per tab: the session-id column, then ONE
      // contiguous range spanning the matched rows (appends are consecutive). The
      // Sheets limit that bites is read REQUESTS per minute, not payload.
      async function readSession(tab, contract) {
        const idx = contract.indexOf('session_id');
        if (idx < 0) throw new Error(`durable verifier: session_id not in the ${tab} contract`);
        const col = await real.readRange(`${tab}!${colLetter(idx)}:${colLetter(idx)}`);
        const ids = Array.isArray(col) ? col.map(r => String((r && r[0]) || '').trim()) : [];
        const hits = [];
        for (let i = 0; i < ids.length; i += 1) if (ids[i] === wantSession) hits.push(i + 1);
        const total = Math.max(0, ids.length - 1); // data rows, header excluded
        if (hits.length === 0) return { rows: [], total };
        const span = await real.readRange(`${tab}!A${hits[0]}:${colLetter(contract.length - 1)}${hits[hits.length - 1]}`);
        // Re-filter the span: a non-contiguous layout must never let a neighbouring
        // session's row ride along into this session's evidence.
        const rows = (Array.isArray(span) ? span : [])
          .filter(r => Array.isArray(r) && String(r[idx] || '').trim() === wantSession);
        return { rows, total };
      }
      try {
        const [log, effort, plans, planSets] = await Promise.all([
          readSession('Log_Cleaned', logCleanedColumns),
          readSession('Effort', effortColumns),
          readSession('Session_Plans', sessionPlansColumns),
          readSession('Session_Plan_Sets', sessionPlanSetsColumns),
        ]);
        res.end(JSON.stringify({
          sandbox_last6: SANDBOX_SPREADSHEET_ID_LAST6,
          session_id: wantSession,
          log_cleaned: log, effort, session_plans: plans, session_plan_sets: planSets,
        }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: `durable verifier read failed: ${error && error.message}` }));
      }
    })();
    return;
  }
  res.end(JSON.stringify({
    appends: state.appendCalls,
    deletes: state.deleteCalls,
    ensure_tab_calls: state.ensureTabCalls,
    updates: state.updateCalls,
    plan_set_rows: state.planSetRows,
    plan_set_rows_lost: state.losePlanSetRows,
    vision_calls: state.visionCalls,
    ledger_sandbox: LEDGER_SANDBOX,
    // The harness's posture claim, read from the live environment at request time so
    // the transcript records what was TRUE, not what was intended. `model-down` is
    // backed by key absence; `model-up` is backed by a provider that ANSWERED before
    // this server ever listened — `provider_reachable` is never true on assumption.
    // `coach_scripted` marks the stubbed stand-in, which is model-down (nothing
    // outbound) with the coach module replaced.
    model_posture: modelPosture,
    provider_key_present: PROVIDER_KEYS.some(key => Boolean(process.env[key])),
    provider_reachable: modelUpProof.reachable,
    coach_model: modelUpProof.model,
    coach_scripted: COACH_SCRIPT,
    // The sheets posture, stated as what is TRUE rather than what was intended.
    google_client_initialized: SANDBOX_LIVE,
    sheets_stubbed_in_memory: !SANDBOX_LIVE,
    sandbox_live: SANDBOX_LIVE,
    rehearsal_live: REHEARSAL_LIVE,
    sandbox_last6: SANDBOX_LIVE ? SANDBOX_SPREADSHEET_ID_LAST6 : null,
    sandbox_preflight: sandboxPreflight,
    refusals: state.refusals,
    ledger_write_flags_off: !process.env.SESSION_PLAN_SETS_WRITE_ENABLED && !process.env.ATLAS_SESSION_PLANS_WRITE,
    telemetry_persistence_off: !process.env.ATLAS_FLIGHT_RECORDER && !process.env.ATLAS_BRAIN_SHADOW_PERSIST
  }));
});

// The posture is PROVEN before a single port is published, so a spec can never attach
// to a harness whose advertised posture has not been verified. Model-down proves itself
// synchronously and makes no call; only model-up awaits the provider.
(async () => {
  if (MODEL_UP) await assertModelUp(); else assertModelDown();
  // The sandbox is PROVEN before a port is published — a browser can never attach to a
  // server whose workbook has not been verified (TEMPORARY F-SB4B; sunset: F-SB4C).
  if (SANDBOX_LIVE) await assertSandboxLive();

  const server = app.listen(0, () => {
    stateServer.listen(0, () => {
      // The spec parses these lines to find the dynamic ports. The posture line is
      // printed first so a rerun transcript records which model posture served it,
      // and model-up carries the model that actually answered.
      console.log(`GATE_MODEL_POSTURE=${modelPosture}${MODEL_UP ? ` model=${modelUpProof.model}` : ''}`);
      console.log(SANDBOX_LIVE
        ? `GATE_SHEETS_POSTURE=sandbox-live-guarded last6=${SANDBOX_SPREADSHEET_ID_LAST6}`
        : 'GATE_SHEETS_POSTURE=in-memory-stub');
      console.log(`GATE_STATE_PORT=${stateServer.address().port}`);
      console.log(`GATE_PORT=${server.address().port}`);
    });
  });
})();
