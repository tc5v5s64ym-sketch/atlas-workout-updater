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
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// Not a real key — sheets.js is fully stubbed below, so this is never parsed; it
// only satisfies config validation. No PEM header, so secret scans stay quiet.
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
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
  visionCalls: []    // every stubbed vision parse (the F10D screenshot scenario's evidence)
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
  res.end(JSON.stringify({
    appends: state.appendCalls,
    deletes: state.deleteCalls,
    ensure_tab_calls: state.ensureTabCalls,
    updates: state.updateCalls,
    plan_set_rows: state.planSetRows,
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
    google_client_initialized: false,
    sheets_stubbed_in_memory: true
  }));
});

// The posture is PROVEN before a single port is published, so a spec can never attach
// to a harness whose advertised posture has not been verified. Model-down proves itself
// synchronously and makes no call; only model-up awaits the provider.
(async () => {
  if (MODEL_UP) await assertModelUp(); else assertModelDown();

  const server = app.listen(0, () => {
    stateServer.listen(0, () => {
      // The spec parses these lines to find the dynamic ports. The posture line is
      // printed first so a rerun transcript records which model posture served it,
      // and model-up carries the model that actually answered.
      console.log(`GATE_MODEL_POSTURE=${modelPosture}${MODEL_UP ? ` model=${modelUpProof.model}` : ''}`);
      console.log(`GATE_STATE_PORT=${stateServer.address().port}`);
      console.log(`GATE_PORT=${server.address().port}`);
    });
  });
})();
