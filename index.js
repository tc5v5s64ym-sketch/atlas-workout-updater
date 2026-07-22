// dotenv is a local-dev convenience only — Render (and any production host) injects
// env vars directly. Guard the require so a missing dotenv never blocks app load.
try { require('dotenv').config(); } catch { /* dotenv not installed — env injected by the host */ }

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  appendRows,
  readRange,
  deleteRowsByRange,
  validateConfig,
  getExerciseCatalog,
  getEffortSessionIds,
  getLogCompositeKeys,
  getSheetRows: getSheetRowsRaw,
  getHeaderRow,
  getSpreadsheetTabs,
  getSafeSpreadsheetConfig = () => ({ canVerify: false, source: 'GOOGLE_SHEETS_ID' }),
  logSheetName,
  effortSheetName
} = require('./sheets');
const {
  normalizeLogRow: normalizeAnalyticsLogRow,
  buildSessionSummary,
  recommendNextSet,
  buildBodyweightHistory,
  previewTestRows,
  scoreIntents,
  detectSwap,
  localTodayIso
} = require('./services/analytics');
const { classifySubstitution } = require('./services/substitutionIntent');
const { inferPrescribedPairs } = require('./services/planMatcher');
const { isConstraintMessage } = require('./services/constraintDetector');
const { recommendSubstitute } = require('./services/substitutionRecommender');
const { scoreSubstitutionQuality } = require('./services/substitutionQuality');
const { buildRecommendation, parseRecommendationConstraints } = require('./services/recommendationPipeline');
const { getProfileGoal } = require('./services/profileGoal');
const { normalizeTrainingGoal } = require('./services/trainingKnowledge');
const { computeBenchmark, resolveWorkingWeight } = require('./services/exerciseBenchmark');
const { detectTrend } = require('./services/trendDetector');
// One-Brain coaching engine (shadow only; gated by ATLAS_COACH_ENGINE=hybrid).
const { buildIntentEnvelope } = require('./services/intentEnvelope');
const { assembleState, defaultReaders } = require('./services/stateAssembly');
const { orchestrate } = require('./services/coachOrchestrator');
const { validateCoachingDecision } = require('./services/coachingDecision');
const { buildRunners } = require('./services/coachRunners');
const { planBrianOverride, applyBrianOverride, planBrianPickOverride, applyBrianPickOverride } = require('./services/coachEnginePromotion');
const { foldJustLoggedSet } = require('./services/ephemeralSetFold');
const { summarizeBrianDecision, summarizeLegacyRecommendation } = require('./services/coachDecisionSummary');
const { observeBrainOrchestration, observeBrainFailure } = require('./services/brainShadow');
// PR-GATEA1 — evidence provenance: classify each shadow event as athlete_ui /
// synthetic / unknown so a fresh GATE-A window can count only genuine athlete
// traffic. Telemetry only; evidenceForRequest is TOTAL (never throws).
const { evidenceForRequest } = require('./services/evidenceProvenance');
const { computeReadiness } = require('./services/readinessSignal');
const { applyBarbellLoadabilityToExercises, applyBarbellLoadability } = require('./services/barbellLoadabilitySurface');
const {
  evaluateCurrentDeload,
} = require('./services/deloadEngine');
// eslint-disable-next-line no-unused-vars -- roundLoad imported here; phase-2 deload wiring will use it
const { selectProtocol, roundLoad, computePrescription } = require('./services/deloadProtocols');
const {
  beginWrite,
  peekWrite,
  completeWrite,
  failWrite,
  normalizeWriteId
} = require('./services/idempotency');
const { normalizeDate, parseNumber, calculateQualityScore, qualityScoreBreakdown } = require('./services/validation');
const {
  createCorsMiddleware,
  createRateLimiter,
  createRequestContext,
  requireApiKey: requireApiKeyMiddleware,
  timingSafeStringEqual
} = require('./middleware');
const { success: standardSuccess, error: standardError } = require('./response');
const sessionModule = require('./services/session');
const { createTtlCache } = require('./services/cache');
const { parseWorkoutScreenshot } = require('./services/vision');
const coach = require('./services/coach');
const coachPolish = require('./services/coachPolish');
const { normalizeExerciseKey, generateLiftCode, makeLiftCodeRegistry, buildExerciseCatalogMap, enrichLogRow, closestExerciseMatches } = require('./services/exerciseEnrichment');
const { normalizeDurationString } = require('./services/duration');
const { buildWorkoutTextParseDryRunResponse, canonicalizeExerciseName } = require('./services/workoutTextParser');
const { applyFirstExercise } = require('./services/planFirstExercise');
const { recognizeModalityInput } = require('./services/multiModalityParser');
const { toModalityLogRow } = require('./services/modalityLogRow');
const { resolveExercise } = require('./services/exerciseResolver');
const { applyUnresolvedLiftGate } = require('./services/unresolvedLiftGate');
const { applyFullConsumptionGate } = require('./services/fullConsumptionGate');
const registerReadRoutes = require('./routes/reads');
const registerCoachOpsRoutes = require('./routes/coachOps');
const registerSessionPlanRoutes = require('./routes/sessionPlans');
// F10D — closeout confirmation + ledger seal (dry-run until the owner enables
// SESSION_PLAN_SETS_WRITE_ENABLED; the store gates every write internally).
const { sealCloseout, readLedgerRows } = require('./services/sessionPlanSetsStore');
const { buildCloseoutSummary, boundCloseoutContextItems } = require('./services/closeoutSummary');
// F10D (Codex P1, PR #1069) — the finalized Session_Plans closeout event records
// INSIDE the one approved write, with proof, instead of a client fire-and-forget.
const { captureCloseout } = require('./services/sessionPlanCapture');
const { validateLogRowsBounds } = require('./rules/validationRules');
const { evaluateSessionSafety } = require('./rules/safetyRules');
const { holdUntilClean } = require('./rules/progressionRules');

async function runStartupDiagnostics() {
  // Telemetry-capture visibility — make inactive capture obvious at boot (no secrets, just
  // flag state). Coach_Shadow AND its Coach_Response companion capture require
  // ATLAS_INTERACTION_TRACE=shadow; the server Flight_Recorder api_response lane requires
  // ATLAS_FLIGHT_RECORDER. Both default to inert, so a silent config gap is visible here.
  try {
    const { isShadowEnabled } = require('./services/interactionTraceShadow');
    const { isFlightRecorderEnabled } = require('./services/flightRecorder');
    const shadow = isShadowEnabled();
    console.log(JSON.stringify({
      event: 'telemetry_capture',
      coach_shadow_and_response: shadow ? 'active' : 'inactive',
      coach_qa_shadow: shadow ? 'active' : 'inactive', // /api/coach/chat + /api/coach/ask coverage (same flag)
      interaction_trace: shadow ? 'shadow' : 'off',
      flight_recorder: isFlightRecorderEnabled() ? 'active' : 'inactive',
    }));
  } catch (_) { /* diagnostic must never block boot */ }
  try {
    const tabs = await getSpreadsheetTabs();
    console.log(JSON.stringify({ event: 'startup_diagnostics', ok: true, tabs_present: tabs.length, required_env: ['ATLAS_API_KEY','GOOGLE_SHEETS_ID','GOOGLE_SERVICE_ACCOUNT_EMAIL','GOOGLE_PRIVATE_KEY','OPENAI_API_KEY'] }));
  } catch (error) {
    console.log(JSON.stringify({ event: 'startup_diagnostics', ok: false, error: error.message }));
  }
}

const atlasApiKey = process.env.ATLAS_API_KEY;

if (!atlasApiKey) {
  throw new Error('Missing ATLAS_API_KEY in environment.');
}


const uploadDir = '/tmp/uploads';
fs.mkdirSync(uploadDir, { recursive: true });

const imageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const safeOriginal = path.basename(file.originalname || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${safeOriginal}`);
    }
  }),
  limits: {
    fileSize: 10 * 1024 * 1024,
    // Bound multipart text fields too — `log_rows_json` is a field, not a file, so
    // `fileSize` does not cap it. Keep a multi-megabyte field from ever reaching
    // JSON.parse (512 KB is far above a real session's ~tens of KB).
    fieldSize: 512 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!imageMimeTypes.has(file.mimetype)) {
      return cb(new Error('Only image/png, image/jpeg, image/jpg, and image/webp files are accepted.'));
    }
    return cb(null, true);
  }
});

const app = express();
app.set('trust proxy', 1);

app.use(createCorsMiddleware());

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(createRequestContext);

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      requestId: req.requestId,
      duration_ms: duration
    };
    console.log(JSON.stringify(logEntry));
  });
  next();
}

app.use(requestLogger);
// Read-only + approve-before-save web UI. Static assets are public; every
// data call the UI makes still goes through /api and requires the API key.
app.use('/app', express.static(path.join(__dirname, 'public')));
app.use('/api', createRateLimiter({
  name: 'api',
  windowMs: Number(process.env.ATLAS_API_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.ATLAS_API_RATE_LIMIT_MAX || 300)
}));
// A dedicated, tight limiter on the credential-checking login route bounds
// brute-force attempts independently of the general /api budget. logout/status
// carry no secret so they ride the general limiter only.
app.use(['/api/session/login'], createRateLimiter({
  name: 'session_login',
  windowMs: Number(process.env.ATLAS_LOGIN_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.ATLAS_LOGIN_RATE_LIMIT_MAX || 10)
}));
// Session login/logout/status bypass the API-key gate: login authenticates by the
// credential in its body (or the legacy header) and mints the cookie; logout only
// clears it; status only reports enabled/authenticated. Everything else under /api
// still requires the key OR a valid session cookie.
app.use('/api', requireApiKeyMiddleware(atlasApiKey, {
  publicPaths: ['/api/session/login', '/api/session/logout', '/api/session/status']
}));
app.use(['/api/parse-workout-image', '/api/complete-workout'], createRateLimiter({
  name: 'vision_upload',
  windowMs: Number(process.env.ATLAS_VISION_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.ATLAS_VISION_RATE_LIMIT_MAX || 20)
}));
app.use(['/api/log-workout', '/api/bodyweight', '/api/log-workout/undo-last', '/api/coaching-notes', '/api/constraints', '/api/log-modality', '/api/bug-report'], createRateLimiter({
  name: 'write',
  windowMs: Number(process.env.ATLAS_WRITE_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.ATLAS_WRITE_RATE_LIMIT_MAX || 60)
}));
// Flight Recorder ingest gets its OWN limiter bucket — best-effort debug telemetry
// (the client flushes every ~10s) must NEVER draw from the trust-write budget above and
// 429 a real set-log / undo. Generous default headroom; still bounded against runaway.
app.use(['/api/flight/ingest'], createRateLimiter({
  name: 'flight_ingest',
  windowMs: Number(process.env.ATLAS_FLIGHT_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.ATLAS_FLIGHT_RATE_LIMIT_MAX || 600)
}));
const { execSync } = require('child_process');

const deploymentTimestamp = new Date().toISOString();
// Prefer the commit Render injects at runtime (RENDER_GIT_COMMIT) so the deployed
// SHA is reported even when the runtime container has no .git; fall back to a local
// `git describe` for dev, then 'unknown'.
let gitVersion = (process.env.RENDER_GIT_COMMIT || '').trim();
if (!gitVersion) {
  try { gitVersion = execSync('git describe --always --dirty', { encoding: 'utf8' }).trim(); } catch (_) { /* not a git repo or no tags */ }
}
if (!gitVersion) gitVersion = 'unknown';

// Flight Recorder (docs/FLIGHT_RECORDER_SPEC.md) — server-side API-flow capture. OBSERVE-ONLY
// and flag-gated (ATLAS_FLIGHT_RECORDER, default OFF): when off this middleware is a pure
// pass-through and traffic is byte-identical. When on, it records one best-effort
// `api_response` row per served /api request (never /api/flight/*) to the optional
// Flight_Recorder tab on the server's OWN sheet — so a sandbox server records to the sandbox
// tab and a production server to production. It NEVER reads or mutates the response, never
// blocks the request (records on 'finish', fire-and-forget), and writes no workout/trust tab.
// Simulation traffic (x-atlas-simulation header, set by scripts/sim/harness.js) is never
// persisted to a non-sandbox sheet (isolation guard in recordApiFlow), so a simulation can
// never write into the production Flight_Recorder — even a read-only sim pointed at prod.
const { isFlightRecorderEnabled, recordApiFlow } = require('./services/flightRecorder');
app.use((req, res, next) => {
  try {
    if (!isFlightRecorderEnabled()) return next();
    const flightPath = req.path || '';
    if (!flightPath.startsWith('/api/') || flightPath.startsWith('/api/flight/')) return next();
    const flightStartedAt = Date.now();
    const isSimulation = /^(1|true|on|yes)$/i.test(String(req.get('x-atlas-simulation') || '').trim());
    res.on('finish', () => {
      try {
        const body = req.body;
        const requestBody = (req.method !== 'GET' && body && typeof body === 'object' && !Array.isArray(body)) ? body : null;
        recordApiFlow({
          method: req.method,
          path: flightPath,
          latency_ms: Date.now() - flightStartedAt,
          response_summary: String(res.statusCode),
          request_body: requestBody,
          flight_session_id: req.get('x-atlas-flight-session') || '',
          device_id: req.get('x-atlas-device-id') || '',
          app_version: gitVersion,
          decision_summary: res.locals ? res.locals.flightRecorderDecisionSummary : null,
          is_simulation: isSimulation
        }, { sheetIsSandbox: getSafeSpreadsheetConfig(process.env.NODE_ENV).isSandboxSheet === true });
      } catch (_) { /* observe-only: telemetry must never surface to the served request */ }
    });
    return next();
  } catch (_) {
    return next();
  }
});
const { readBuildInfo } = require('./services/buildInfo');
const { buildServerStatus: buildAtlasStatus } = require('./services/atlasStatus');
// In-memory pending exercises collected from complete-workout responses
const pendingExercisesMemory = [];
// TODO(persistence-layer): replace in-memory pending exercises/cache with durable storage.
// TODO(db-migration): introduce real relational DB-backed write path with transactions.
// TODO(websocket-live-sync): stream ingestion/status updates to clients.
// TODO(gpt-integration-layer): separate model orchestration and prompt policy from HTTP layer.
// TODO(mobile-client): add API compatibility/versioning strategy for mobile app consumers.

// A single dashboard load fans out across ~8 read endpoints, each re-reading the
// full Log_Cleaned / Effort tabs. Cache those full reads for a short window and
// drop the cache on every successful live write/delete (invalidateSheetRowsCache),
// so a write is immediately visible to the next read.
//
// Only the log and effort full reads are cached. Everything routed through
// getSheetRowsRaw — other tabs (e.g. Bodyweight) and, critically, the undo
// handler's pre-delete read-back — always hits the sheet live and is never cached.
const SHEET_ROWS_TTL_MS = 30 * 1000;
let sheetRowsCache = createTtlCache(SHEET_ROWS_TTL_MS);

// DoS ceiling for a single logged-set append (a real session is well under it).
// Enforced on the multipart /api/complete-workout write path (parsedLogRows) and
// shared as the source of truth by the post-write verify-range read-back and the
// undo-last delete, which MUST accept the same span the write produces — otherwise a
// legitimate multi-set session closeout (>10 rows in one write) succeeds yet cannot
// be verified or undone. (The JSON /api/log-workout path does not yet enforce this
// same cap on log_rows.length — tracked in BACKLOG.md; unreachable for one session.)
const MAX_LOG_ROWS = 200;

async function getSheetRows(tabName) {
  if (tabName !== logSheetName && tabName !== effortSheetName) {
    return getSheetRowsRaw(tabName);
  }
  const cached = sheetRowsCache.get(tabName);
  if (cached) return cached;
  const rows = await getSheetRowsRaw(tabName);
  sheetRowsCache.set(tabName, rows);
  return rows;
}

function invalidateSheetRowsCache() {
  // A fresh cache instance is the simplest correct clear — createTtlCache closes
  // over a private Map, so swapping the reference drops every entry at once.
  sheetRowsCache = createTtlCache(SHEET_ROWS_TTL_MS);
}

// Read/analytics routes (Remediation PR-16) — extracted verbatim into an Express
// Router. Mounted after the global /api middleware; the shared sheet-rows cache is
// injected so writes still invalidate what these reads see.
app.use(registerReadRoutes({ getSheetRows }));
app.use(registerCoachOpsRoutes({ getSheetRows }));
// Session_Plans capture routes (Decision Desk #952 → Option A, PR-E) — explicit,
// feature-flagged (ATLAS_SESSION_PLANS_WRITE, default OFF) sidecar endpoints. Global
// /api auth + rate limiting run before this router; it writes only the Session_Plans
// tab (never Log_Cleaned/Effort). No client calls this yet (PR-F wires the client).
app.use(registerSessionPlanRoutes({ getSheetRows, logSheetName, effortSheetName }));

const { routeDefinitions } = require('./config/routes');
// eslint-disable-next-line no-unused-vars -- exerciseCatalogColumns unused in this file; imported for catalog-audit route (Phase 0 PR-06)
const { logCleanedColumns, logRowFieldAliases, effortColumns, exerciseCatalogColumns, effortRowFieldAliases, modalityLogColumns } = require('./config/columns');
// eslint-disable-next-line no-unused-vars -- requiredSheetTabs, optionalSheetTabs unused here; used in startup health-check via buildSheetContractStatus
const { requiredSheetTabs, optionalSheetTabs, buildSheetContractStatus, validateHeaderRow } = require('./config/sheetContract');

// --- Header-drift guard (trust-critical write protection) --------------------
// Atlas appends rows to Google Sheets purely by column position. If the owner
// hand-edits the sheet and reorders a column, every future write would silently
// land in the wrong field and corrupt the permanent record. Before any live
// append we read row 1 of each target tab and confirm it still matches the
// column contract; on mismatch we refuse the write instead of misrouting data.

async function checkSheetHeaderContract(tabName, expectedColumns, aliases) {
  const header = await getHeaderRow(tabName);
  // An empty header row (uninitialized tab) is not a drift signal — appendRows
  // will seed it. Only a populated, mismatched header blocks the write.
  if (!Array.isArray(header) || header.length === 0) {
    return { ok: true, tab: tabName, mismatches: [] };
  }
  const { ok, mismatches } = validateHeaderRow(header, expectedColumns, aliases);
  return { ok, tab: tabName, mismatches };
}

// Returns an array of failed contracts (empty = all good). Reads only the tabs
// a given write will actually touch.
async function assertWriteHeaderContracts({ checkLog, checkEffort }) {
  const failures = [];
  if (checkLog) {
    const result = await checkSheetHeaderContract(logSheetName, logCleanedColumns, logRowFieldAliases);
    if (!result.ok) failures.push(result);
  }
  if (checkEffort) {
    const result = await checkSheetHeaderContract(effortSheetName, effortColumns, effortRowFieldAliases);
    if (!result.ok) failures.push(result);
  }
  return failures;
}

function schemaDriftDetails(failures) {
  return {
    sheet_write: 'blocked_schema_drift',
    sheet_written: false,
    no_write_confirmed: true,
    header_mismatches: failures.map(f => ({ tab: f.tab, mismatches: f.mismatches }))
  };
}

function schemaDriftMessage(failures) {
  const tabs = failures.map(f => f.tab).join(', ');
  return `Sheet header does not match the expected column contract (${tabs}); write blocked to prevent misrouted data. Restore the original column order and retry.`;
}

function ensureNotes(value) {
  return value === undefined || value === null ? '' : value;
}

function calculateVolumeCalc(weight, reps) {
  const weightValue = Number(weight);
  const repsValue = Number(reps);
  if (!Number.isFinite(weightValue) || !Number.isFinite(repsValue)) {
    return '';
  }
  return weightValue * repsValue;
}

function normalizeLogRowObject(row, topLevelSessionId, topLevelDate) {
  const result = {
    date_clean: row.date_clean || row.dateClean || row.date || topLevelDate,
    session_id: row.session_id || row.sessionId || topLevelSessionId,
    exercise: row.exercise,
    canonical_exercise: row.canonical_exercise || row.canonicalExercise,
    muscle_group: row.muscle_group || row.muscleGroup,
    lift_code: row.lift_code || row.liftCode,
    set_number: row.set_number || row.setNumber || row.set,
    weight: row.weight,
    reps: row.reps,
    rir: row.rir,
    notes: ensureNotes(row.notes)
  };

  // volume_calc (column 12) is always derived server-side from weight × reps.
  // A client-supplied volume_calc/volume is never trusted — it could disagree
  // with weight × reps and silently corrupt anything that reads the column.
  // (BACKLOG ME-4.)
  result.volume_calc = calculateVolumeCalc(result.weight, result.reps);

  // RIR is OPTIONAL (owner 2026-06-25: "log it however"). The lifter can log a set
  // with just weight × reps — Atlas never invents a rating they didn't give, and a
  // missing RIR is a valid blank cell, not a malformed row. weight/reps (and the
  // identity fields) remain required so a genuinely garbled row is still rejected.
  // A blank RIR is normalized to '' so column 10 stays present and in order; the
  // progression/PR engines already treat a blank RIR as "no signal" (NaN-filtered).
  for (const field of ['date_clean', 'session_id', 'exercise', 'set_number', 'weight', 'reps']) {
    if (result[field] === undefined || result[field] === null || result[field] === '') {
      throw new Error(`Missing required log row field: ${field}`);
    }
  }
  if (result.rir === undefined || result.rir === null) result.rir = '';

  return result;
}

// F08 / CLIENT-4: a closeout writes ONE session under ONE canonical date. On
// /api/complete-workout the Effort row already uses the resolved session date
// unconditionally, but a Log row honours its own `date_clean` first — so a
// client-stamped per-row date (today's auto-fill) would split Log_Cleaned from
// the Effort row when the session is dated from a screenshot or a backdated
// manual entry. Force every Log row onto the resolved session date. Only stamps
// the rows being written now — no historical rewrite. Handles the client object
// shape and the Log_Cleaned array shape (date at index 0).
function withCanonicalSessionDate(row, sessionDate) {
  if (Array.isArray(row)) {
    const copy = row.slice();
    copy[0] = sessionDate;
    return copy;
  }
  if (row && typeof row === 'object') {
    return { ...row, date_clean: sessionDate, dateClean: undefined, date: undefined };
  }
  return row;
}

function logRowArrayToObject(row) {
  if (!Array.isArray(row) || (row.length !== logCleanedColumns.length && row.length !== logCleanedColumns.length - 1)) {
    throw new Error(`Each log row must contain ${logCleanedColumns.length - 1} or ${logCleanedColumns.length} values in Log_Cleaned column order.`);
  }

  return {
    date_clean: row[0],
    session_id: row[1],
    exercise: row[2],
    canonical_exercise: row[3],
    muscle_group: row[4],
    lift_code: row[5],
    set_number: row[6],
    weight: row[7],
    reps: row[8],
    rir: row[9],
    notes: ensureNotes(row[10]),
    // Always derived from weight × reps — a client-supplied column-12 value is
    // never trusted on the write path (BACKLOG ME-4).
    volume_calc: calculateVolumeCalc(row[7], row[8])
  };
}

function normalizeLogRow(row, topLevelSessionId, topLevelDate) {
  if (Array.isArray(row)) {
    return logRowArrayToObject(row);
  }

  if (row && typeof row === 'object') {
    return normalizeLogRowObject(row, topLevelSessionId, topLevelDate);
  }

  throw new Error('Each log row must be an object or an array.');
}

function normalizeEffortRow(row) {
  if (Array.isArray(row)) {
    if (row.length !== effortColumns.length) {
      throw new Error(`effort_row must contain ${effortColumns.length} values in Effort column order.`);
    }
    return row;
  }

  if (row && typeof row === 'object') {
    return effortColumns.map(column => {
      const aliases = effortRowFieldAliases[column] || [column];
      for (const alias of aliases) {
        if (Object.prototype.hasOwnProperty.call(row, alias)) {
          return row[alias];
        }
      }
      if (column === 'notes') {
        return '';
      }
      throw new Error(`Missing required effort row field: ${column}`);
    });
  }

  throw new Error('effort_row must be an object or an array.');
}

// eslint-disable-next-line no-unused-vars -- exported helper; callers may use it post-Phase 1 ES module conversion
function formatLogRows(logRows) {
  return logRows.map(normalizeLogRow);
}

function validateEffortRowBounds(row) {
  // row is in effortColumns order: [date, session_id, duration, active_calories, total_calories, average_hr, peak_hr, location, notes]
  // Matches the bounds already enforced by /api/complete-workout via normalizeAndValidateParsedMetrics.
  validateNumberField('active_calories', row[3], 1, 3000);
  validateNumberField('total_calories', row[4], 1, 4000);
  validateNumberField('average_hr', row[5], 40, 220);
  if (row[6] !== null && row[6] !== undefined && row[6] !== '') {
    validateNumberField('peak_hr', row[6], 40, 230);
  }
}

function formatEffortRow(effortRow) {
  const row = normalizeEffortRow(effortRow);
  validateEffortRowBounds(row);
  return row;
}



function logRowObjectToArray(rowObj) {
  return logCleanedColumns.map(column => {
    if (column === 'notes') {
      return ensureNotes(rowObj.notes);
    }
    return rowObj[column];
  });
}



function getLocalDateString(dateTime = new Date()) {
  const year = dateTime.getFullYear();
  const month = String(dateTime.getMonth() + 1).padStart(2, '0');
  const day = String(dateTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeDateCandidate(value) {
  if (value === undefined || value === null) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const slashMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!slashMatch) {
    return '';
  }
  const [, monthRaw, dayRaw, year] = slashMatch;
  const month = String(Number(monthRaw)).padStart(2, '0');
  const day = String(Number(dayRaw)).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toDateOnly(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return getLocalDateString();
  }
  return normalizeDateCandidate(value) || String(value).trim();
}

function resolveWorkoutDate({ manualDate, screenshotDate } = {}) {
  if (manualDate !== undefined && manualDate !== null && String(manualDate).trim() !== '') {
    return toDateOnly(manualDate);
  }
  return normalizeDateCandidate(screenshotDate) ||
    getLocalDateString();
}

// Plausibility window for a screenshot-sourced workout date (live incident
// 2026-07-02: the vision model returned 2020-06-28 for a yearless "June 28"
// watch header — June 28 is a Sunday in both 2020 and 2026, so it weekday-matched
// a wrong year that passed every format check and was saved to the sheet). A
// syntactically valid date is NOT evidence the year was actually printed on the
// screenshot. Deterministic guard: accept only dates within a generous real-usage
// window — up to 2 days ahead (timezones) and up to 400 days back (importing
// anything from the last ~13 months). Anything outside is treated as ambiguous:
// today-fallback + the review card's warning and date picker, never silently used.
const SCREENSHOT_DATE_MAX_FUTURE_DAYS = 2;
const SCREENSHOT_DATE_MAX_PAST_DAYS = 400;
function isPlausibleScreenshotDate(isoDate, todayIso = getLocalDateString()) {
  if (!isoDate) return false;
  const d = new Date(`${isoDate}T00:00:00`);
  const t = new Date(`${todayIso}T00:00:00`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(t.getTime())) return false;
  const diffDays = (d.getTime() - t.getTime()) / 86400000;
  return diffDays <= SCREENSHOT_DATE_MAX_FUTURE_DAYS && diffDays >= -SCREENSHOT_DATE_MAX_PAST_DAYS;
}

// Partition formatted Log_Cleaned rows into those NOT yet on the sheet ("new") and
// those already present ("duplicates"), keyed by session_id‖exercise‖set_number —
// the exact identity the live append dedups on. Shared by BOTH the dry-run preview
// and the live write so the preview shows EXACTLY the rows the write will append,
// never more (the closeout "30 previewed / 22 written, Bench dropped" trust failure).
// `existingLogKeys` are the lowercased composite keys returned by getLogCompositeKeys.
function partitionLogRowsByExisting(formattedRows, existingLogKeys) {
  const existing = new Set(Array.isArray(existingLogKeys) ? existingLogKeys : []);
  const newRows = [];
  const skippedDuplicates = [];
  formattedRows.forEach((row, index) => {
    // formatted row order follows logCleanedColumns: session_id=1, exercise=2, set_number=6
    const sid = String(row[1] || '').trim().toLowerCase();
    const ex = String(row[2] || '').trim().toLowerCase();
    const setn = String(row[6] || '').trim().toLowerCase();
    if (existing.has(`${sid}||${ex}||${setn}`)) skippedDuplicates.push({ index, row });
    else newRows.push(row);
  });
  return { newRows, skippedDuplicates };
}

const { generateSessionId, nextAvailableSessionId } = require('./services/sessionId');

function isTestModeEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

// A test_mode value is unambiguous only when it is omitted (absent = live write,
// INVARIANT W2), a real boolean, or the string "true"/"false" (case/space-
// insensitive). Any other value — 1, "yes", "on", "TRUE!" — previously fell
// through isTestModeEnabled as a SILENT LIVE write; reject it so the trust loop
// fails closed on ambiguous input instead of writing to the permanent record
// (BACKLOG WRITE-6). The documented "absent = live" default is preserved.
function isAmbiguousTestMode(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return false;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v !== 'true' && v !== 'false';
  }
  return true; // numbers, arrays, objects — never an intended flag
}

const AMBIGUOUS_TEST_MODE_MESSAGE =
  'test_mode must be true, false, or omitted. Ambiguous values (e.g. 1, "yes") are rejected so a preview is never silently treated as a live write.';

// Validate + normalize a workout date to YYYY-MM-DD. Returns '' when the value is
// not a real calendar date. Accepts YYYY-MM-DD and MM/DD/YYYY (matching the
// parser's leniency via normalizeDateCandidate), and additionally rejects a
// syntactically-plausible-but-impossible date (e.g. 2026-13-45) via a round-trip
// check. Without this, /api/log-workout accepted an unparseable `date` and wrote
// it verbatim into the date_clean column (unlike /api/log-modality, which already
// format-guards). The Effort/undo/analytics layers all key on a clean date.
function normalizeWorkoutDateStrict(value) {
  const norm = normalizeDateCandidate(value); // '' | 'YYYY-MM-DD'
  if (!norm) return '';
  const [y, m, d] = norm.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
  return norm;
}

function buildEffortRowFromParsedMetrics(parsedMetrics, formFields) {
  const dateValue = resolveWorkoutDate({
    manualDate: formFields.date,
    screenshotDate: formFields.screenshot_date ?? parsedMetrics?.date
  });
  const sessionId = formFields.session_id || generateSessionId(dateValue);

  // If notes not provided, use workoutType when available
  const notes = (formFields.notes && String(formFields.notes).trim()) ? String(formFields.notes) : (parsedMetrics?.workoutType ? String(parsedMetrics.workoutType) : '');

  const effortRow = [
    dateValue,
    sessionId,
    parsedMetrics?.duration ?? '',
    parsedMetrics?.activeCalories ?? '',
    parsedMetrics?.totalCalories ?? '',
    parsedMetrics?.averageHR ?? '',
    parsedMetrics?.peakHR ?? '',
    formFields.location || '',
    notes
  ];

  return { effortRow, sessionId, dateValue };
}



function validateNumberField(name, rawValue, min, max) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    throw new Error(`${name} is required`);
  }
  const num = Number(rawValue);
  if (!Number.isFinite(num) || Number.isNaN(num)) {
    throw new Error(`${name} must be a number`);
  }
  if (num < min || num > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return num;
}

function normalizeAndValidateParsedMetrics(parsedMetrics) {
  if (!parsedMetrics || typeof parsedMetrics !== 'object') {
    throw new Error('parsed_metrics is required');
  }

  const normalized = {};
  // duration (required) -> normalize to HH:MM:SS
  normalized.duration = normalizeDurationString(parsedMetrics.duration);

  // numeric validations (required)
  normalized.activeCalories = validateNumberField('activeCalories', parsedMetrics.activeCalories, 1, 3000);
  normalized.totalCalories = validateNumberField('totalCalories', parsedMetrics.totalCalories, 1, 4000);
  normalized.averageHR = validateNumberField('averageHR', parsedMetrics.averageHR, 40, 220);
  // peakHR is optional: allow missing but warn; if present, validate range
  if (parsedMetrics.peakHR === null || parsedMetrics.peakHR === undefined || parsedMetrics.peakHR === '') {
    normalized.peakHR = '';
    // indicate missing peakHR as a warning (caller will surface warnings)
    // we'll push a specific warning below after building warnings array
  } else {
    normalized.peakHR = validateNumberField('peakHR', parsedMetrics.peakHR, 40, 230);
  }
  normalized.workoutType = parsedMetrics.workoutType ?? null;

  const warnings = [];
  if (normalized.totalCalories < normalized.activeCalories) {
    warnings.push('totalCalories is less than activeCalories');
  }
  if (typeof normalized.peakHR === 'number' &&
      typeof normalized.averageHR === 'number' &&
      normalized.peakHR < normalized.averageHR) {
    warnings.push('peakHR is less than averageHR');
  }

  if (parsedMetrics.peakHR === null || parsedMetrics.peakHR === undefined || parsedMetrics.peakHR === '') {
    warnings.push('peakHR missing from parsed screenshot');
  }

  return { normalized, warnings };
}

function parseJsonFormField(rawValue, fieldName) {
  if (!rawValue) return null;
  if (typeof rawValue === 'object') return rawValue;
  try {
    return JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`${fieldName} is not valid JSON: ${error.message}`);
  }
}

function normalizeManualEffortMetrics(formFields) {
  const effort = parseJsonFormField(formFields.effort_json || formFields.effort, 'effort_json') || {};
  const parsedMetrics = {
    duration: effort.duration ?? formFields.duration,
    activeCalories: effort.activeCalories ?? effort.active_calories ?? formFields.activeCalories ?? formFields.active_calories,
    totalCalories: effort.totalCalories ?? effort.total_calories ?? formFields.totalCalories ?? formFields.total_calories,
    averageHR: effort.averageHR ?? effort.average_hr ?? effort.avg_hr ?? formFields.averageHR ?? formFields.average_hr ?? formFields.avg_hr,
    peakHR: effort.peakHR ?? effort.peak_hr ?? formFields.peakHR ?? formFields.peak_hr,
    workoutType: effort.workoutType ?? effort.workout_type ?? formFields.workout_type
  };
  return normalizeAndValidateParsedMetrics(parsedMetrics);
}

// Effort placeholder used when a screenshot can't be read (e.g. Gemini 429 /
// timeout) but there ARE logged sets to save. The workout is saved without
// effort data instead of failing the whole request; the effort row lands with
// blank metrics (date + session_id only) so session linkage and duplicate
// protection stay intact. buildEffortRowFromParsedMetrics coerces these to ''.
const EMPTY_EFFORT_METRICS = Object.freeze({
  duration: '',
  activeCalories: '',
  totalCalories: '',
  averageHR: '',
  peakHR: '',
  workoutType: null
});

// Owner-specified copy shown when the screenshot effort parse fails but the
// logged sets are still saved.
const SCREENSHOT_UNREADABLE_MESSAGE =
  "I couldn't read effort from the screenshot. I can still save the workout without effort data.";

async function enrichAndFormatLogRows(logRows, topLevelSessionId, topLevelDate, catalogMap = null) {
  // Hard bounds before anything else — including the catalog fetch. A 2250-lb
  // typo must never reach the sheet, and implausible input shouldn't cost an
  // API call either.
  const normalizedForBounds = logRows.map(row => normalizeLogRow(row, topLevelSessionId, topLevelDate));
  const boundErrors = validateLogRowsBounds(normalizedForBounds);
  if (boundErrors.length > 0) {
    const detail = boundErrors.map(e => `row ${e.row_index + 1}: ${e.error}`).join('; ');
    throw new Error(`Implausible set values rejected — ${detail}`);
  }

  if (!catalogMap || !(catalogMap instanceof Map)) {
    const catalogRows = await getExerciseCatalog();
    catalogMap = buildExerciseCatalogMap(catalogRows);
  }
  const warnings = [];
  const auto_matches = [];
  const pending_exercises = [];
  const enrichedRowObjects = [];

  // Use a registry so that *generated* lift codes (the fallback case only) are unique
  // within this batch of log rows. Pre-claim in sorted-by-name order for determinism
  // (same input set of names => same assigned codes, independent of row order in payload).
  const liftCodeRegistry = makeLiftCodeRegistry();
  const preClaimItems = (logRows || []).map(row => {
    const rowObj = normalizeLogRow(row, topLevelSessionId, topLevelDate);
    return { rowObj, normKey: normalizeExerciseKey(rowObj.exercise || '') };
  }).sort((a, b) => a.normKey.localeCompare(b.normKey));
  for (const item of preClaimItems) {
    // Trigger generate claims (if any) for this name in stable order. Result discarded.
    enrichLogRow({ ...item.rowObj }, catalogMap, liftCodeRegistry);
  }

  const formattedRows = logRows.map(row => {
    const rowObj = normalizeLogRow(row, topLevelSessionId, topLevelDate);
    const result = enrichLogRow(rowObj, catalogMap, liftCodeRegistry);
    const enriched = result.enriched;
    enrichedRowObjects.push(enriched);
    if (result.autoMatch) auto_matches.push(result.autoMatch);
    const rowWarnings = result.warnings || null;
    if (rowWarnings) {
      for (const w of rowWarnings) {
        warnings.push(w);
      }
      // If unknown exercise, add to pending_exercises
      for (const w of rowWarnings) {
        if (w && String(w).startsWith('Unknown exercise:')) {
          const suggestions = closestExerciseMatches(rowObj.exercise, catalogMap, 3);
          pending_exercises.push({
            exercise: rowObj.exercise,
            suggested_canonical_name: suggestions[0]?.canonical_exercise || rowObj.exercise,
            suggested_lift_code: enriched.lift_code || '',
            closest_matches: suggestions,
            reason: 'No Exercise_Catalog match'
          });
        }
      }
    }
    return logRowObjectToArray(enriched);
  });

  return { formattedRows, warnings, pending_exercises, auto_matches, enrichedRowObjects };
}

app.get('/', (req, res) => {
  return standardSuccess(req, res, 'Atlas backend is running', {
    service: 'atlas-workout-updater',
    message: 'Atlas backend is running'
  });
});

app.get('/health', (req, res) => {
  return standardSuccess(req, res, 'Health check passed', { service: 'atlas-workout-updater' });
});

app.get('/routes', (req, res) => {
  return standardSuccess(req, res, 'Available routes', { routes: routeDefinitions });
});

app.get('/version', (req, res) => {
  // pr + commit_subject come from build-info.json (captured at build time); they
  // let the in-app badge show "PR #461" instead of only a SHA. Absent → null.
  const build = readBuildInfo();
  return standardSuccess(req, res, 'Service version', {
    version: gitVersion,
    deployed_at: deploymentTimestamp,
    pr: build.pr != null ? build.pr : null,
    commit_subject: build.subject || null,
    endpoints: routeDefinitions
  });
});

// Atlas Control Tower (F04B) — public, redacted, READ-ONLY operational status.
// Registered here alongside /, /health, /routes, /version so it stays outside the
// /api auth mount (no browser API key required). It composes only bounded, safe
// facts (build/version, env-presence flags, the checked-out campaign plan + test
// ledger); it never runs an authenticated sheet read or LLM call, never writes,
// and can never emit a secret, sheet ID/range, or workout/health data — the
// bounded schema is a closed whitelist in services/atlasStatus.js. Contract:
// docs/ATLAS_OPERATIONS_CONTRACT.md.
app.get('/.well-known/atlas-status.json', (req, res) => {
  try {
    const build = readBuildInfo();
    const status = buildAtlasStatus({
      deployed_commit: gitVersion,
      app_version: build.pr != null ? `PR #${build.pr}` : null,
      deployed_at: deploymentTimestamp
    });
    res.set('Cache-Control', 'public, max-age=15');
    return res.type('application/json').json(status);
  } catch (_) {
    // Fail honest, not green: an assembler fault degrades to an explicit unknown.
    res.set('Cache-Control', 'no-store');
    return res.status(200).type('application/json').json({
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      generated_by: 'endpoint',
      overall_status: 'unknown',
      status_reason_codes: ['STATUS_ASSEMBLY_FAILED']
    });
  }
});

// Durable owner session (F04C). These three routes are in the auth publicPaths so
// they bypass the x-atlas-api-key gate: login authenticates by the credential in
// its body (never persisted) and mints a signed HttpOnly cookie; logout clears it;
// status reports enabled/authenticated without exposing anything. Sessions are
// active ONLY when ATLAS_SESSION_SECRET is set — until then login returns 503 and
// the app keeps using the legacy header, so nothing breaks before it is provisioned.
app.post('/api/session/login', (req, res) => {
  const secret = sessionModule.sessionSecret();
  if (!secret) {
    return standardError(req, res, 'Durable sessions are not enabled on this server', { session: 'disabled' }, 503);
  }
  const provided = (req.body && typeof req.body === 'object' ? req.body.api_key : null) || req.header('x-atlas-api-key');
  if (!timingSafeStringEqual(provided, atlasApiKey)) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized', requestId: req.requestId });
  }
  const { token, maxAgeMs } = sessionModule.issueToken(secret);
  res.setHeader('Set-Cookie', sessionModule.buildSetCookie(token, { maxAgeMs, secure: sessionModule.isSecureRequest(req) }));
  return standardSuccess(req, res, 'Session established', {
    session: 'active',
    expires_in_days: Math.round(maxAgeMs / 86400000)
  });
});

app.post('/api/session/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionModule.buildClearCookie({ secure: sessionModule.isSecureRequest(req) }));
  return standardSuccess(req, res, 'Session cleared', { session: 'cleared' });
});

app.get('/api/session/status', (req, res) => {
  const secret = sessionModule.sessionSecret();
  const payload = secret
    ? sessionModule.verifySession(sessionModule.parseCookies(req.header('cookie'))[sessionModule.COOKIE_NAME], secret, Date.now())
    : null;
  return standardSuccess(req, res, 'Session status', {
    sessions_enabled: Boolean(secret),
    authenticated: Boolean(payload),
    expires_at: payload ? new Date(payload.exp).toISOString() : null
  });
});

// GET /api/pending-exercises
app.get('/api/pending-exercises', (req, res) => {
  const deduped = [];
  const seen = new Set();
  for (const item of pendingExercisesMemory) {
    const key = String(item.exercise || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return standardSuccess(req, res, 'Pending exercises endpoint', { pending_exercises: deduped });
});

// POST /api/suggest-substitute — deterministic substitute recommendation for an
// unavailable exercise. Returns the best known alternative when the user message
// signals a constraint (busy, unavailable, etc.) and a known substitute exists.
// AC3: also returns next_target prescription for the substitute so the client can
// populate the replacement exercise slot instead of leaving weight/reps/sets null.
// READ-ONLY: reads Log_Cleaned for prescription history, no LLM, no writes.
// Body: { message: string, current_exercise: string }
// Response: { recommendation: { recommendation, quality, reason, next_target } | null }
app.post('/api/suggest-substitute', async (req, res) => {
  const { message, current_exercise: currentExercise, intent, remaining_plan: remainingPlan } = req.body || {};
  // The client's deterministic classifier may signal an EXPLICIT substitution request
  // ("I don't want to do squats, give me something else") that carries no constraint
  // keyword — `intent:'substitute'` authorizes the recommendation directly. Absent it,
  // the original constraint-message gate (busy/taken/unavailable) is unchanged.
  const explicitSubstitute = intent === 'substitute';
  if ((!message && !explicitSubstitute) || !currentExercise) {
    return standardSuccess(req, res, 'No recommendation', { recommendation: null });
  }
  if (!explicitSubstitute && !isConstraintMessage(message)) {
    return standardSuccess(req, res, 'Not a constraint message', { recommendation: null });
  }
  // CONTEXT-AWARE: the client passes the remaining planned exercises (esp. the next
  // slot) so the recommender skips a substitute that would be redundant back-to-back
  // (same exercise / alias / unilateral-bilateral variant / same movement family).
  const avoid = Array.isArray(remainingPlan) ? remainingPlan.filter(x => typeof x === 'string' && x.trim()).slice(0, 30) : [];
  const rec = recommendSubstitute(currentExercise, { avoid });
  if (!rec) {
    return standardSuccess(req, res, 'No substitute found', { recommendation: null });
  }
  // AC3: fetch the substitute's prescription from logged history so the replacement
  // slot gets weight/reps/sets instead of null. Best-effort — a missing prescription
  // (no history for the substitute) is non-fatal; the client treats null gracefully.
  // generateLiftCode derives the short Sheets lift_code (e.g. "RDL01") used to match
  // Log_Cleaned rows — NOT exercise_id from the KB, which is a different namespace.
  let next_target = null;
  try {
    const code = generateLiftCode(rec.recommendation);
    if (code) {
      const allLog = await getSheetRows(logSheetName);
      const prescription = recommendNextSet(allLog, code);
      next_target = (prescription && prescription.next_target) || null;
    }
  } catch { /* best-effort */ }
  if (next_target && Number.isFinite(next_target.weight) && next_target.weight > 0) {
    const snapped = applyBarbellLoadability(
      { target_weight: next_target.weight, exercise: rec.recommendation }
    );
    next_target = {
      ...next_target,
      weight: snapped.target_weight,
      ...(snapped.loadability_note && { loadability_note: snapped.loadability_note }),
    };
  }
  return standardSuccess(req, res, 'Substitute recommendation', {
    recommendation: { ...rec, next_target }
  });
});

// POST /api/session/compile — extract logged sets from conversation history.
// Called by the frontend when the lifter says "log it" at the end of a
// conversational session. Gemini reads the chat turns and returns the sets in
// Atlas slash notation so the normal parse → preview → approve flow can run.
// READ-ONLY: no Sheets access, no writes.
app.post('/api/session/compile', async (req, res) => {
  const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];
  if (!history.length) {
    return standardError(req, res, "history array required — log some sets in the chat first, then say 'log it'", null, 400);
  }
  if (!coach.isConfigured()) {
    return standardSuccess(req, res, 'Session compile unavailable — Gemini not configured', {
      workout_text: null, configured: false
    });
  }
  try {
    const { workout_text } = await coach.compileSessionFromHistory(history);
    return standardSuccess(req, res, 'Session compiled', { workout_text });
  } catch (error) {
    console.log(JSON.stringify({ event: 'session_compile_error', error: error.message }));
    return standardSuccess(req, res, 'Session compile failed', {
      workout_text: null, error: error.message
    });
  }
});

// GET /api/coaching-notes — return all notes from the Coaching_Notes tab.
// READ-ONLY. Returns empty array when the tab does not exist yet.
app.get('/api/coaching-notes', async (req, res) => {
  try {
    const rows = await getSheetRows('Coaching_Notes').catch(() => []);
    const notes = rows
      .map(row => Array.isArray(row)
        ? { date: row[0] || null, note: row[1] || null }
        : { date: (row && row.date) || null, note: (row && row.note) || null })
      .filter(n => n.note);
    return standardSuccess(req, res, 'Coaching notes', { notes });
  } catch (err) {
    return standardSuccess(req, res, 'Coaching notes', { notes: [] });
  }
});

// POST /api/coaching-notes — append a coaching note to the Coaching_Notes tab.
// Requires { note: string, write_id: string }. write_id is required for
// idempotency (retry safety). Returns sheet_written: true on success.
app.post('/api/coaching-notes', async (req, res) => {
  const note = req.body && typeof req.body.note === 'string' ? req.body.note.trim() : '';
  const writeId = req.body && typeof req.body.write_id === 'string' ? req.body.write_id.trim() : '';
  if (!note) return standardError(req, res, 'note string is required', null, 400);
  if (!writeId) return standardError(req, res, 'write_id is required', null, 400);

  const idempotency = beginWrite(writeId, { endpoint: '/api/coaching-notes' });

  if (idempotency.duplicate) {
    const record = idempotency.record || {};
    const original = record.response || {};
    return standardSuccess(req, res,
      record.status === 'completed'
        ? 'Duplicate write_id; coaching note was already saved.'
        : 'Duplicate write_id; coaching note write is in progress.',
      { ...original, duplicate_write: true, write_id: idempotency.write_id, sheet_written: false }
    );
  }

  const tabs = await getSpreadsheetTabs().catch(() => []);
  if (!tabs.includes('Coaching_Notes')) {
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, 'Coaching_Notes tab not found — create it in Google Sheets first (columns: date, note)', null, 503);
  }

  // F09I: stamp the owner's LOCAL day (ATLAS_TIMEZONE), not the UTC day — an evening-Pacific
  // note was being dated tomorrow. localTodayIso falls back to UTC until the zone is set.
  const dateStr = localTodayIso();
  try {
    await appendRows('Coaching_Notes', [[dateStr, note.slice(0, 200)]]);
    invalidateSheetRowsCache();
    const responseBody = { sheet_written: true, note_written: true, date: dateStr, note: note.slice(0, 200) };
    if (idempotency.enabled) {
      responseBody.write_id = idempotency.write_id;
      responseBody.duplicate_write = false;
      completeWrite(idempotency.write_id, idempotency.token, responseBody);
    }
    return standardSuccess(req, res, 'Coaching note saved', responseBody);
  } catch (err) {
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, 'Failed to save coaching note', err.message, 500);
  }
});

// Structured-constraint vocabulary. A constraint is a durable, typed rule the
// lifter has approved — distinct from a free-text coaching note. Both stores
// coexist; this one adds structure (kind/target/rule) on top.
const CONSTRAINT_KINDS = ['injury', 'equipment', 'preference'];
const CONSTRAINT_RULES = ['avoid', 'limit', 'substitute'];

// GET /api/constraints — return all structured constraints from the Constraints tab.
// READ-ONLY. Returns empty array when the tab does not exist yet.
app.get('/api/constraints', async (req, res) => {
  try {
    const rows = await getSheetRows('Constraints').catch(() => []);
    const constraints = rows
      .map(row => Array.isArray(row)
        ? { date: row[0] || null, kind: row[1] || null, target: row[2] || null, rule: row[3] || null, note: row[4] || null }
        : {
            date: (row && row.date) || null,
            kind: (row && row.kind) || null,
            target: (row && row.target) || null,
            rule: (row && row.rule) || null,
            note: (row && row.note) || null
          })
      .filter(c => c.kind && c.target && c.rule);
    return standardSuccess(req, res, 'Constraints', { constraints });
  } catch (err) {
    return standardSuccess(req, res, 'Constraints', { constraints: [] });
  }
});

// POST /api/constraints — append a structured constraint to the Constraints tab.
// Requires { kind, target, rule, write_id }; note is optional. kind and rule must
// come from the fixed vocabularies above. write_id is required for idempotency.
app.post('/api/constraints', async (req, res) => {
  const body = req.body || {};
  const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
  const target = typeof body.target === 'string' ? body.target.trim() : '';
  const rule = typeof body.rule === 'string' ? body.rule.trim().toLowerCase() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const writeId = typeof body.write_id === 'string' ? body.write_id.trim() : '';

  if (!CONSTRAINT_KINDS.includes(kind)) {
    return standardError(req, res, `kind must be one of: ${CONSTRAINT_KINDS.join(', ')}`, null, 400);
  }
  if (!target) return standardError(req, res, 'target string is required', null, 400);
  if (!CONSTRAINT_RULES.includes(rule)) {
    return standardError(req, res, `rule must be one of: ${CONSTRAINT_RULES.join(', ')}`, null, 400);
  }
  if (!writeId) return standardError(req, res, 'write_id is required', null, 400);

  const idempotency = beginWrite(writeId, { endpoint: '/api/constraints' });

  if (idempotency.duplicate) {
    const record = idempotency.record || {};
    const original = record.response || {};
    return standardSuccess(req, res,
      record.status === 'completed'
        ? 'Duplicate write_id; constraint was already saved.'
        : 'Duplicate write_id; constraint write is in progress.',
      { ...original, duplicate_write: true, write_id: idempotency.write_id, sheet_written: false }
    );
  }

  const tabs = await getSpreadsheetTabs().catch(() => []);
  if (!tabs.includes('Constraints')) {
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, 'Constraints tab not found — create it in Google Sheets first (columns: date, kind, target, rule, note)', null, 503);
  }

  // F09I: owner's LOCAL day (ATLAS_TIMEZONE), not UTC — see coaching-notes above.
  const dateStr = localTodayIso();
  const cleanTarget = target.slice(0, 100);
  const cleanNote = note.slice(0, 200);
  try {
    await appendRows('Constraints', [[dateStr, kind, cleanTarget, rule, cleanNote]]);
    invalidateSheetRowsCache();
    const responseBody = {
      sheet_written: true,
      constraint_written: true,
      date: dateStr,
      constraint: { kind, target: cleanTarget, rule, note: cleanNote }
    };
    if (idempotency.enabled) {
      responseBody.write_id = idempotency.write_id;
      responseBody.duplicate_write = false;
      completeWrite(idempotency.write_id, idempotency.token, responseBody);
    }
    return standardSuccess(req, res, 'Constraint saved', responseBody);
  } catch (err) {
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, 'Failed to save constraint', err.message, 500);
  }
});

// POST /api/log-modality — persist a NON-slash modality entry (timed hold /
// steady cardio / cardio interval / circuit) to the Modality_Log tab (PR 486
// slice 4b). The engine owns the structured fields: the route re-recognizes the
// raw `text` server-side via recognizeModalityInput (the client never supplies the
// numbers) and normalizes units into the Modality_Log column contract.
//
// Trust loop: `test_mode` is honored exactly like /api/log-workout — test_mode
// true → dry-run preview, no write, proof fields (sheet_written:false,
// no_write_confirmed:true); test_mode absent/false → live write (the approve→write
// step after the slice-3 dry-run preview). Live writes require write_id for
// idempotency and 503 until the optional tab exists. This route NEVER touches
// Log_Cleaned / Effort or the slash-notation resistance path.
app.post('/api/log-modality', async (req, res) => {
  const payload = req.body || {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return standardError(req, res, 'Invalid JSON payload. A JSON object is required.', null, 400);
  }
  const text = typeof payload.text === 'string' ? payload.text : '';
  const session_id = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  const date = typeof payload.date === 'string' ? payload.date.trim() : '';
  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
  if (isAmbiguousTestMode(payload.test_mode)) {
    return standardError(req, res, AMBIGUOUS_TEST_MODE_MESSAGE, null, 400);
  }
  const testMode = isTestModeEnabled(payload.test_mode);
  const writeId = payload.write_id;

  if (!text.trim()) return standardError(req, res, 'text is required.', null, 400);
  if (!session_id) return standardError(req, res, 'session_id is required.', null, 400);
  if (!date) return standardError(req, res, 'date is required.', null, 400);
  // Light input hardening (review #517): `date` lands verbatim in Modality_Log, so
  // reject an obviously-malformed value rather than persist it (keeps downstream
  // analytics clean). YYYY-MM-DD only.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return standardError(req, res, 'date must be in YYYY-MM-DD format.', null, 400);
  }

  // Engine owns the structured record. Slash-notation sets are NOT ours — the
  // recognizer returns null for them, so they route to /api/log-workout instead.
  const record = recognizeModalityInput(text);
  if (!record) {
    return standardError(req, res, 'Not a recognized modality input (cardio / interval / circuit / timed hold). Slash-notation sets log via /api/log-workout.', null, 422);
  }
  const row = toModalityLogRow(record, { date, session_id, notes });
  // Defense-in-depth (review #517): `toModalityLogRow` returns null only for an
  // unknown modality — unreachable today since `record` is one of the four
  // recognized modalities — but guard explicitly so a null can never reach an
  // append. Make the invariant loud rather than silently write a bad row.
  if (!row) {
    return standardError(req, res, 'Could not build a modality row from the recognized input.', null, 422);
  }

  if (testMode) {
    return standardSuccess(req, res, 'log-modality dry-run', {
      test_mode: true,
      sheet_write: 'skipped',
      sheet_written: false,
      no_write_confirmed: true,
      modality: record.modality,
      modality_record: record,
      modality_row_preview: row
    }, 200);
  }

  // Live writes carry a write_id so a lost-response retry is deduplicated instead
  // of appending the same row twice.
  if (!normalizeWriteId(writeId)) {
    return standardError(req, res, 'write_id is required', null, 400);
  }

  const idempotency = beginWrite(writeId, { endpoint: '/api/log-modality', session_id, date });
  if (idempotency.duplicate) {
    const rec = idempotency.record || {};
    const original = rec.response || {};
    return standardSuccess(req, res,
      rec.status === 'completed'
        ? 'Duplicate write_id; modality was already saved.'
        : 'Duplicate write_id; modality write is in progress.',
      { ...original, duplicate_write: true, write_id: idempotency.write_id, sheet_written: false },
      rec.status === 'completed' ? 200 : 409
    );
  }

  const tabs = await getSpreadsheetTabs().catch(() => []);
  if (!tabs.includes('Modality_Log')) {
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, `Modality_Log tab not found — create it in Google Sheets first (columns: ${modalityLogColumns.join(', ')})`, null, 503);
  }

  try {
    const appendResponse = await appendRows('Modality_Log', [row]);
    invalidateSheetRowsCache();
    const responseBody = {
      message: 'Modality logged successfully.',
      test_mode: false,
      sheet_write: 'success',
      sheet_written: true,
      modality_written: true,
      modality: record.modality,
      appendedRange: appendResponse.data.updates?.updatedRange,
      modality_row: row
    };
    if (idempotency.enabled) {
      responseBody.write_id = idempotency.write_id;
      responseBody.duplicate_write = false;
      responseBody.idempotency_status = 'completed';
      completeWrite(idempotency.write_id, idempotency.token, responseBody);
    }
    return standardSuccess(req, res, 'log-modality processed', responseBody, 200);
  } catch (err) {
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, 'Failed to append modality data', process.env.NODE_ENV === 'production' ? null : err.message, 500);
  }
});

// GET /api/plan/today
// Returns next-set recommendations for all distinct lift codes trained in the
// last 60 days, ordered by most recently trained first. Used by the dashboard
// "Today's Plan" card.
app.get('/api/plan/today', async (req, res) => {
  try {
    const allLog = await getSheetRows(logSheetName);
    // Find distinct lift codes that have been trained at all
    const liftCodes = [...new Set(
      allLog
        .map(row => String(row[5] || '').trim())
        .filter(code => code && code !== 'lift_code' && /[a-zA-Z]/.test(code))
    )];

    // Build recommendations in parallel for all lift codes
    const recommendations = liftCodes
      .map(code => recommendNextSet(allLog, code))
      .filter(r => r.next_target !== null)
      .sort((a, b) => {
        // Sort by most recent session date (last_working_sets last date)
        const dateA = a.last_working_sets?.length ? a.last_working_sets[a.last_working_sets.length - 1].date_clean : '';
        const dateB = b.last_working_sets?.length ? b.last_working_sets[b.last_working_sets.length - 1].date_clean : '';
        return String(dateB).localeCompare(String(dateA));
      })
      .slice(0, 12); // cap at 12 lifts for dashboard

    // One-Brain engine gate — same shadow/promotion pattern already shipped for
    // GET /api/recommend/next/:liftCode (docs/COACHING_ENGINE_ARCHITECTURE.md),
    // looped per lift already selected for the card (post-slice, so orchestration
    // never runs on a lift the dashboard won't show). `hybrid` = shadow attach
    // only (observation, never changes the response). `brian` = if Brian returns
    // a valid, answered `progression` decision for that lift, its numbers DRIVE
    // next_target/reasoning/recommendation for that entry; any error/invalid/
    // clarification (or an active deload — the predefined protocol always wins)
    // falls back to that entry's legacy value untouched. Default (unset/legacy)
    // leaves the response byte-identical to today. Snapshot + deload state are
    // computed once and shared across lifts (not re-read per lift). Each lift's
    // own try/catch so one lift's orchestrator failure can never affect another's
    // or fail the request — it only ever falls back to legacy for that entry.
    // No write path / trust-loop / proof-field touch.
    const coachEngineMode = process.env.ATLAS_COACH_ENGINE;
    if ((coachEngineMode === 'hybrid' || coachEngineMode === 'brian') && recommendations.length) {
      try {
        const asOf = new Date().toISOString();
        const [activeDeload, snapshot] = await Promise.all([
          evaluateCurrentDeload({ logRows: allLog }),
          assembleState({
            asOf,
            readers: { ...defaultReaders(), getLogRows: async () => allLog },
          }),
        ]);
        for (const rec of recommendations) {
          try {
            const envelope = buildIntentEnvelope({
              type: 'progression_review',
              constraints: { target_lift: rec.liftCode },
              source: 'api',
              asOf,
            });
            // Capture the legacy prescription BEFORE any brian override mutates it.
            const legacySummary = summarizeLegacyRecommendation(rec);
            const t0 = Date.now();
            const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
            const validation = validateCoachingDecision(brian);
            const ms = Date.now() - t0;
            // Brain ORCHESTRATOR shadow (services/brainShadow). TOTAL — never affects
            // the served response. Records EVERY orchestration for this lift — win OR
            // decline/invalid — so the flip blocker's reviewable record exists.
            try {
              observeBrainOrchestration({
                route: '/api/plan/today', liftCode: rec.liftCode, mode: coachEngineMode,
                decision: brian, validation, legacy: legacySummary, ms,
                evidence: evidenceForRequest(req),
              });
            } catch (_) { /* brain-shadow must never affect the response */ }
            if (brian && validation.valid) {
              // hybrid attaches a trimmed SUMMARY (never the raw decision) to the
              // wire; brian keeps the full decision it drives from.
              rec.brian = coachEngineMode === 'hybrid' ? summarizeBrianDecision(brian) : brian;
            }
            if (coachEngineMode === 'brian') {
              const plan = planBrianOverride(rec, brian, validation, activeDeload);
              if (plan.eligible) {
                applyBrianOverride(rec, plan);
                rec.engine_source = { mode: 'brian', driven_by: 'brian' };
              } else {
                rec.engine_source = { mode: 'brian', driven_by: 'legacy', reason: plan.reason };
              }
            }
          } catch (_) {
            // The Brain CRASHED for this lift — record the failure the empty catch
            // used to swallow, then fall back to legacy exactly as before.
            try {
              observeBrainFailure({ route: '/api/plan/today', liftCode: rec.liftCode, mode: coachEngineMode, reason: 'orchestrator_error', evidence: evidenceForRequest(req) });
            } catch (_) { /* brain-shadow must never affect the response */ }
            if (coachEngineMode === 'brian') {
              rec.engine_source = { mode: 'brian', driven_by: 'legacy', reason: 'orchestrator_error' };
            }
          }
        }
      } catch (_) {
        // Snapshot/deload assembly itself failed — record one failure so the crash
        // is visible, then leave every entry at its legacy value, exactly as if the
        // flag were unset.
        try {
          observeBrainFailure({ route: '/api/plan/today', mode: coachEngineMode, reason: 'assembly_error', evidence: evidenceForRequest(req) });
        } catch (_) { /* brain-shadow must never affect the response */ }
      }
    }

    return standardSuccess(req, res, 'Today\'s training plan', { recommendations });
  } catch (error) {
    return standardError(req, res, 'Failed to build today\'s plan', error.message, 500);
  }
});

// GET /api/plan/intent-recommendation
app.get('/api/plan/intent-recommendation', async (req, res) => {
  try {
    const [allLog, allEffort] = await Promise.all([
      getSheetRows(logSheetName),
      getSheetRows(effortSheetName)
    ]);
    // A workout-generation request routes here (authoritative pipeline) with its structured
    // constraints as query params. `focus` is honored only where the engine already supports
    // it — upper_body maps to the existing upperOnly scope; other focuses are accepted but
    // the legacy engine does not act on them ("preserve when already supported").
    const upperOnly = req.query.upperOnly === 'true' || req.query.scope === 'upper'
      || req.query.focus === 'upper_body' || req.query.focus === 'upper';
    const result = scoreIntents(allLog, allEffort, {
      goal: req.query.goal ? normalizeTrainingGoal(req.query.goal) : getProfileGoal(),
      ...(upperOnly && { upperOnly }),
    });

    // One-Brain engine gate — the Coach's Pick promotion (owner-approved
    // 2026-07-02), same staged pattern as /api/recommend/next and
    // /api/plan/today. `hybrid` = shadow attach only (`result.brian`, a
    // validated best_workout decision; response otherwise byte-identical).
    // `brian` = if Brian returns a valid, answered `workout` decision with
    // prescribed numbers, its blocks REPLACE the recommended intent's exercise
    // list (numbers verbatim; labels/why_today/other intents/todays_read stay
    // legacy); anything else falls back to the untouched legacy result. No
    // separate deload guard: buildSession is itself deload-aware (it applies
    // the predefined protocol to its blocks). Runs BEFORE the barbell
    // loadability pass so that display rule applies uniformly to whichever
    // engine produced the numbers. Default (unset/legacy) = byte-identical.
    // Everything inside its own try/catch — an engine failure can never alter
    // or fail the legacy response. No write path / trust-loop touch.
    const coachEngineMode = process.env.ATLAS_COACH_ENGINE;
    if ((coachEngineMode === 'hybrid' || coachEngineMode === 'brian') && result) {
      try {
        const asOf = new Date().toISOString();
        const snapshot = await assembleState({
          asOf,
          readers: { ...defaultReaders(), getLogRows: async () => allLog },
        });
        const envelope = buildIntentEnvelope({
          type: 'best_workout',
          constraints: upperOnly ? { focus: 'upper_body' } : {},
          source: 'api',
          asOf,
        });
        // Capture the legacy recommended intent BEFORE any brian override mutates it.
        const recIntentBefore = Array.isArray(result.intents) ? result.intents.find(i => i && i.recommended === true) : null;
        const legacySummary = recIntentBefore
          ? { recommended_label: typeof recIntentBefore.label === 'string' ? recIntentBefore.label : null,
              exercise_count: Array.isArray(recIntentBefore.exercises) ? recIntentBefore.exercises.length : null }
          : null;
        const t0 = Date.now();
        const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
        const validation = validateCoachingDecision(brian);
        const ms = Date.now() - t0;
        // Brain ORCHESTRATOR shadow (services/brainShadow). TOTAL — never affects the
        // served response. Records EVERY orchestration — win OR decline/invalid.
        try {
          observeBrainOrchestration({
            route: '/api/plan/intent-recommendation', mode: coachEngineMode,
            decision: brian, validation, legacy: legacySummary, ms, evidence: evidenceForRequest(req),
          });
        } catch (_) { /* brain-shadow must never affect the response */ }
        if (brian && validation.valid) {
          // hybrid attaches a trimmed SUMMARY (never the raw decision) to the wire.
          result.brian = coachEngineMode === 'hybrid' ? summarizeBrianDecision(brian) : brian;
        }
        if (coachEngineMode === 'brian') {
          const plan = planBrianPickOverride(result, brian, validation);
          if (plan.eligible) {
            applyBrianPickOverride(result, plan);
            result.engine_source = { mode: 'brian', driven_by: 'brian' };
          } else {
            result.engine_source = { mode: 'brian', driven_by: 'legacy', reason: plan.reason };
          }
        }
      } catch (_) {
        // The Brain CRASHED — record the failure the empty catch used to swallow,
        // then fall back to legacy exactly as before.
        try {
          observeBrainFailure({ route: '/api/plan/intent-recommendation', mode: coachEngineMode, reason: 'orchestrator_error', evidence: evidenceForRequest(req) });
        } catch (_) { /* brain-shadow must never affect the response */ }
        if (coachEngineMode === 'brian') {
          result.engine_source = { mode: 'brian', driven_by: 'legacy', reason: 'orchestrator_error' };
        }
      }
    }

    // Requested FIRST exercise ("Plan me a workout but have it start with back squats"):
    // make the recommended intent LEAD with it. Authoritative-only — a resolved target comes
    // from the deterministic engine (recommendNextSet); if history can't support a load the
    // injected entry carries an EXPLICIT unresolved-load state (never a fabricated number).
    // Runs BEFORE the barbell snap so an injected/reordered weight gets the same loadability
    // rule. Read-only: reorders/annotates the already-built recommendation.
    const firstExerciseRaw = typeof req.query.firstExercise === 'string' ? req.query.firstExercise.trim() : '';
    if (firstExerciseRaw && result) {
      let name = firstExerciseRaw;
      let code = null;
      let target = null;
      try { const c = canonicalizeExerciseName(firstExerciseRaw); if (c && c.canonicalName) name = c.canonicalName; } catch (_) { /* keep raw */ }
      try { code = generateLiftCode(name) || null; } catch (_) { code = null; }
      if (code) {
        try {
          const r = recommendNextSet(allLog, code);
          if (r && r.next_target) target = { ...r.next_target, rir: r.target_rir != null ? r.target_rir : null };
        } catch (_) { target = null; }
      }
      applyFirstExercise(result, { name, code, target });
    }

    // P0 AC12: snap each intent's BARBELL target weights to loadable plate totals
    // (45 lb bar, 5 lb jumps) + attach a short note, gated on barbell equipment
    // classification. Read-only — this is the recommendation/composer surface, not
    // the write path; the lifter still logs what they actually do. Applies after
    // the engine gate so Brian-driven numbers get the same loadability snap the
    // legacy numbers do (a uniform display rule, recorded via engine_source).
    if (result && Array.isArray(result.intents)) {
      for (const intent of result.intents) {
        if (intent && Array.isArray(intent.exercises)) {
          intent.exercises = applyBarbellLoadabilityToExercises(intent.exercises);
        }
      }
    }
    return standardSuccess(req, res, 'Intent recommendation', result);
  } catch (error) {
    return standardError(req, res, 'Failed to build intent recommendation', error.message, 500);
  }
});

// GET /api/recommendation/preview — READ-ONLY deterministic recommendation preview.
// Runs intent → rule policy → lift history → recommendation → short (templated) explanation.
// Returns only the public payload; never raw sheet rows / analytics internals, and never writes.
app.get('/api/recommendation/preview', async (req, res) => {
  try {
    const [allLog, allEffort] = await Promise.all([
      getSheetRows(logSheetName),
      getSheetRows(effortSheetName)
    ]);
    const rec = buildRecommendation({
      sessionText: req.query.text || req.query.sessionText,
      explicitGoal: req.query.goal,
      userProfileGoal: req.query.profileGoal || getProfileGoal(),
      liftCode: req.query.liftCode,
      exerciseName: req.query.exercise,
      logRows: allLog,
      effortRows: allEffort,
      constraints: parseRecommendationConstraints(req.query)
    });
    // Optional Gemini polish: natural wording, locked numbers enforced by the field-aware
    // validator. Degrades to the deterministic templated explanation on any failure/drift.
    let coachExplanation = rec.coachExplanation;
    if (coachExplanation) {
      try {
        coachExplanation = await coachPolish.polishCoachExplanation(coachExplanation, rec.llmBrief && rec.llmBrief.lockedNumbers);
      } catch { coachExplanation = rec.coachExplanation; }
    }
    const payload = {
      intent: rec.intent,
      source: rec.source,
      recommendation: rec.recommendation,
      reasonCodes: rec.reasonCodes,
      safetyFlags: rec.safetyFlags,
      llmBrief: rec.llmBrief,
      coachExplanation
    };
    if (rec.weightGuidance) payload.weightGuidance = rec.weightGuidance;
    return standardSuccess(req, res, 'Recommendation preview', payload);
  } catch (error) {
    return standardError(req, res, 'Failed to build recommendation preview', error.message, 500);
  }
});

// Optional just-logged set from the query (?w=&reps=&rir=). Under session-level
// save the set the lifter just did is not in the sheet yet, so the in-workout
// recommendation must anchor on it. Returns null unless a valid weight+reps pair
// is present — absent/invalid params preserve the history-only recommendation.
function parseJustLoggedSet(query) {
  if (!query || typeof query !== 'object') return null;
  const weight = Number(query.w);
  const reps = Number(query.reps);
  if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(reps) || reps <= 0) return null;
  const rirRaw = query.rir;
  const rirNum = Number(rirRaw);
  const rir = (rirRaw === '' || rirRaw == null || !Number.isFinite(rirNum)) ? null : rirNum;
  return { weight, reps, rir };
}

// GET /api/recommend/next/:liftCode
app.get('/api/recommend/next/:liftCode', async (req, res) => {

  const liftCode = String(req.params.liftCode || '').trim();
  if (!liftCode) {
    return standardError(req, res, 'liftCode is required in path', null, 400);
  }

  const justLoggedSet = parseJustLoggedSet(req.query);

  // Recovery-intent passthrough (?intentId=recovery_pump|deload_reset). The client
  // has sent this since BUG-20260629-204817 (public/app.js fetchReaction) and the
  // engine honors options.intentId (services/analytics.js), but this route never
  // read the param — so a Recovery/Pump session still got a normal-day target RIR
  // and an add-load "move to X" card (the -204817 recurrence). Whitelisted to the
  // two recovery objectives only: other intents keep today's behavior unchanged.
  const rawIntentId = String(req.query.intentId || '');
  const intentId = ['recovery_pump', 'deload_reset'].includes(rawIntentId) ? rawIntentId : null;

  try {
    const allLog = await getSheetRows(logSheetName);
    const recommendation = recommendNextSet(allLog, liftCode, {
      ...(justLoggedSet ? { justLoggedSet } : {}),
      ...(intentId ? { intentId } : {})
    });
    // Deload is no longer a query-flag override — it is driven by the engine's
    // persisted training state (Deload_State). Attach the engine's decision so a
    // consumer can see an active deload or an offer/recommendation. The protocol
    // numbers come from the engine; nothing is invented here.
    recommendation.deload = await evaluateCurrentDeload({ logRows: allLog });
    // On an ACTIVE deload, the next-set card must reflect the protocol, not a
    // normal day: cut the load by the protocol's load_multiplier and show the
    // protocol's target RIR. Weight + RIR only — the set count and the non-deload
    // path are untouched. (The card RIR is the top-level target_rir; app.js:1126.)
    const activeDeload = recommendation.deload;
    if (activeDeload && activeDeload.in_deload === true && activeDeload.protocol) {
      const nt = recommendation.next_target;
      const prescription = nt
        ? computePrescription(activeDeload.protocol, { working_weight: nt.weight })
        : null;
      // When next_target.weight is missing/non-positive, prescription is null and
      // neither weight nor target_rir is applied (old code set target_rir unconditionally).
      // This is intentional: surfacing a deload RIR without a deload weight is confusing.
      if (prescription) {
        nt.weight = prescription.weight;
        recommendation.target_rir = prescription.target_rir;
      }
    }
    const normalizedRows = allLog
      .filter(row => Array.isArray(row) && String(row[0] || '') !== 'date_clean')
      .map(normalizeAnalyticsLogRow);
    recommendation.rule_decision = holdUntilClean(normalizedRows, liftCode);
    recommendation.benchmark = computeBenchmark(liftCode, allLog);
    recommendation.working_weight = resolveWorkingWeight(liftCode, allLog);
    recommendation.trend = detectTrend(liftCode, allLog);
    // deviationHistory has no production caller yet — passes empty array (monitoring/none).
    recommendation.readiness_signal = computeReadiness(recommendation.trend, []);

    // One-Brain engine gate. `hybrid` = shadow attach only (observation, never
    // changes the response). `brian` = One-Brain Promotion PR 1: if Brian
    // returns a valid, answered `progression` decision, its numbers DRIVE
    // next_target/reasoning/recommendation; any error/invalid/clarification
    // (or an active deload — the predefined protocol always wins) falls back
    // to the legacy response untouched. Default (unset/legacy) leaves the
    // response byte-identical to today. Own try/catch so a coach-engine
    // failure can NEVER fail the request — it only ever falls back to legacy.
    // No write path / trust-loop / proof-field touch. docs/COACHING_ENGINE_ARCHITECTURE.md.
    const coachEngineMode = process.env.ATLAS_COACH_ENGINE;
    if (coachEngineMode === 'hybrid' || coachEngineMode === 'brian') {
      try {
        const asOf = new Date().toISOString();
        const envelope = buildIntentEnvelope({
          type: 'progression_review',
          constraints: { target_lift: liftCode },
          source: 'api',
          asOf,
        });
        // Reuse the already-fetched log rows (allLog) instead of re-reading them;
        // keep the real deload/profile readers so the snapshot stays complete.
        // In-workout, FOLD the just-logged set into the rows first (it is not
        // in the sheet yet under session-level save) so the snapshot the
        // Orchestrator sees is truthful — the decision then consumes the
        // fresh set, and the fold flag below lifts the just_logged_anchor
        // guard. A set the fold rejects (no date/numbers) leaves the rows
        // unchanged and the guard in force.
        const foldedRows = justLoggedSet
          ? foldJustLoggedSet(allLog, liftCode, justLoggedSet, asOf)
          : allLog;
        const ephemeralSetFolded = foldedRows !== allLog && foldedRows.length === allLog.length + 1;
        const snapshot = await assembleState({
          asOf,
          readers: { ...defaultReaders(), getLogRows: async () => foldedRows },
        });
        // Capture the legacy prescription BEFORE any brian override mutates it.
        const legacySummary = summarizeLegacyRecommendation(recommendation);
        const t0 = Date.now();
        const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
        const validation = validateCoachingDecision(brian);
        const ms = Date.now() - t0;
        // Brain ORCHESTRATOR shadow (services/brainShadow). TOTAL — never affects the
        // served response. Records EVERY orchestration — win OR decline/invalid.
        try {
          observeBrainOrchestration({
            route: '/api/recommend/next', liftCode, mode: coachEngineMode,
            decision: brian, validation, legacy: legacySummary, ms, evidence: evidenceForRequest(req),
          });
        } catch (_) { /* brain-shadow must never affect the response */ }
        if (brian && validation.valid) {
          // hybrid attaches a trimmed SUMMARY (never the raw decision) to the wire.
          recommendation.brian = coachEngineMode === 'hybrid' ? summarizeBrianDecision(brian) : brian;
        }
        if (coachEngineMode === 'brian') {
          const plan = planBrianOverride(recommendation, brian, validation, activeDeload, { justLoggedSet, ephemeralSetFolded });
          if (plan.eligible) {
            applyBrianOverride(recommendation, plan);
            recommendation.engine_source = { mode: 'brian', driven_by: 'brian' };
          } else {
            recommendation.engine_source = { mode: 'brian', driven_by: 'legacy', reason: plan.reason };
          }
        }
      } catch (_) {
        // The Brain CRASHED — record the failure the empty catch used to swallow.
        // Must never affect the response beyond the brian-mode metadata — hybrid's
        // shadow attach is simply omitted; brian mode falls back.
        try {
          observeBrainFailure({ route: '/api/recommend/next', liftCode, mode: coachEngineMode, reason: 'orchestrator_error', evidence: evidenceForRequest(req) });
        } catch (_) { /* brain-shadow must never affect the response */ }
        if (coachEngineMode === 'brian') {
          recommendation.engine_source = { mode: 'brian', driven_by: 'legacy', reason: 'orchestrator_error' };
        }
      }
    }

    return standardSuccess(req, res, 'Recommendation generated', recommendation);
  } catch (error) {
    return standardError(req, res, 'Failed to compute recommendation', error.message, 500);
  }
});

// GET /api/session/:sessionId/summary
app.get('/api/session/:sessionId/summary', async (req, res) => {

  const sessionId = String(req.params.sessionId || '').trim();
  if (!sessionId) {
    return standardError(req, res, 'sessionId is required in path', null, 400);
  }

  try {
    const allLog = await getSheetRows(logSheetName);
    const allEffort = await getSheetRows(effortSheetName);
    const summary = buildSessionSummary(allLog, allEffort, sessionId);
    return standardSuccess(req, res, 'Session summary', summary);
  } catch (error) {
    return standardError(req, res, 'Failed to build session summary', error.message, 500);
  }
});

// GET /api/session/:sessionId
app.get('/api/session/:sessionId', async (req, res) => {

  const sessionId = String(req.params.sessionId || '').trim();
  if (!sessionId) {
    return standardError(req, res, 'sessionId is required in path', null, 400);
  }

  try {
    const recentLog = await getSheetRows(logSheetName);
    const recentEffort = await getSheetRows(effortSheetName);

    const sessionLogRows = recentLog
      .filter(row => String(row[1] || '').trim().toLowerCase() === sessionId.toLowerCase())
      .map(row => ({
        date_clean: row[0],
        session_id: row[1],
        exercise: row[2],
        canonical_exercise: row[3],
        muscle_group: row[4],
        lift_code: row[5],
        set_number: row[6],
        weight: row[7],
        reps: row[8],
        rir: row[9],
        notes: row[10]
      }));

    const effortRow = recentEffort.find(row => String(row[1] || '').trim().toLowerCase() === sessionId.toLowerCase());
    const effort = effortRow ? {
      date: effortRow[0],
      session_id: effortRow[1],
      duration: effortRow[2],
      active_calories: effortRow[3],
      total_calories: effortRow[4],
      average_hr: effortRow[5],
      peak_hr: effortRow[6],
      location: effortRow[7],
      notes: effortRow[8]
    } : null;

    return res.json({ status: 'ok', data: { session_id: sessionId, log_rows: sessionLogRows, effort } });
  } catch (error) {
    return standardError(req, res, 'Failed to fetch session data', error.message, 500);
  }
});

app.post('/api/bodyweight', async (req, res) => {

  const { date, weight, notes } = req.body || {};
  if (isAmbiguousTestMode(req.body?.test_mode)) {
    return standardError(req, res, AMBIGUOUS_TEST_MODE_MESSAGE, null, 400);
  }
  const testMode = isTestModeEnabled(req.body?.test_mode);
  const writeId = req.body?.write_id;
  if (!date) {
    return standardError(req, res, 'date is required', null, 400);
  }

  const weightValue = parseNumber(weight);
  if (weightValue === null) {
    return standardError(req, res, 'weight is required and must be a number', null, 400);
  }

  const normalizedDate = normalizeDate(date);
  if (!normalizedDate) {
    return standardError(req, res, 'date must be a valid YYYY-MM-DD value', null, 400);
  }

  try {
    const tabs = await getSpreadsheetTabs();
    if (!tabs.includes('Bodyweight')) {
      return standardError(req, res, 'Bodyweight tab is missing. Cannot append bodyweight entry.', null, 400);
    }
    const entry = { date: normalizedDate, weight: weightValue, notes: notes || '' };
    if (testMode) {
      return standardSuccess(req, res, 'Bodyweight dry-run', {
        test_mode: true,
        sheet_write: 'skipped',
        sheet_written: false,
        no_write_confirmed: true,
        entry_preview: entry
      });
    }

    // Live writes must carry a write_id so a lost-response retry is deduplicated
    // instead of appending the same entry twice. Dry-runs (above) are exempt.
    if (!normalizeWriteId(writeId)) {
      return standardError(req, res, 'write_id is required', null, 400);
    }

    const idempotency = beginWrite(writeId, {
      endpoint: '/api/bodyweight',
      date: normalizedDate,
      weight: weightValue
    });

    if (idempotency.duplicate) {
      const record = idempotency.record || {};
      const original = record.response || {};
      const duplicateBody = {
        ...original,
        duplicate_write: true,
        write_id: idempotency.write_id,
        idempotency_status: record.status || 'unknown',
        sheet_write: record.status === 'completed' ? 'skipped_duplicate' : 'skipped_duplicate_in_progress',
        sheet_written: false,
        original_sheet_write: original.sheet_write || null,
        original_completed_at: record.completed_at || null
      };
      const message = record.status === 'completed'
        ? 'Duplicate write_id; original bodyweight entry was already processed.'
        : 'Duplicate write_id; original bodyweight entry is already in progress.';
      return standardSuccess(req, res, message, duplicateBody, record.status === 'completed' ? 200 : 409);
    }

    // Tracks whether the row is already on the sheet. Once it flips true the
    // idempotency record must never be released (failWrite) — a released record
    // lets a retried write_id append the same entry a second time. Mirrors the
    // committed-guard in /api/complete-workout.
    let writeCommitted = false;
    try {
      await appendRows('Bodyweight', [[normalizedDate, weightValue, notes || '']]);
      writeCommitted = true;
      const responseBody = {
        entry,
        test_mode: false,
        sheet_write: 'success',
        sheet_written: true
      };
      if (idempotency.enabled) {
        responseBody.write_id = idempotency.write_id;
        responseBody.duplicate_write = false;
        responseBody.idempotency_status = 'completed';
        completeWrite(idempotency.write_id, idempotency.token, responseBody);
      }
      return standardSuccess(req, res, 'Bodyweight entry appended', responseBody);
    } catch (error) {
      if (idempotency.enabled) {
        if (writeCommitted) {
          // The row landed but post-append processing threw. Record the write as
          // completed so a retried write_id replays this state instead of
          // appending again (never failWrite a committed write).
          completeWrite(idempotency.write_id, idempotency.token, {
            entry,
            test_mode: false,
            sheet_write: 'success',
            sheet_written: true,
            write_id: idempotency.write_id,
            duplicate_write: false,
            idempotency_status: 'completed',
            post_processing_error: true
          });
        } else {
          failWrite(idempotency.write_id, idempotency.token);
        }
      }
      throw error;
    }
  } catch (error) {
    return standardError(req, res, 'Failed to append bodyweight entry', error.message, 500);
  }
});

app.get('/api/bodyweight/history', async (req, res) => {

  const days = parseInt(req.query.days || '30', 10);
  if (Number.isNaN(days) || days <= 0) {
    return standardError(req, res, 'days must be a positive integer', null, 400);
  }

  try {
    const tabs = await getSpreadsheetTabs();
    if (!tabs.includes('Bodyweight')) {
      return standardError(req, res, 'Bodyweight tab is missing. Cannot read history.', null, 400);
    }
    const allRows = await getSheetRows('Bodyweight');
    const history = buildBodyweightHistory(allRows, days);
    return standardSuccess(req, res, 'Bodyweight history', history);
  } catch (error) {
    return standardError(req, res, 'Failed to fetch bodyweight history', error.message, 500);
  }
});

app.post('/api/admin/preview-test-rows', async (req, res) => {
  try {
    const logRows = await getSheetRows(logSheetName);
    const effortRows = await getSheetRows(effortSheetName);
    const preview = previewTestRows(logRows, effortRows);
    return standardSuccess(req, res, 'Preview test rows', preview);
  } catch (error) {
    return standardError(req, res, 'Failed to preview test rows', error.message, 500);
  }
});

app.post('/api/parse-workout-text', (req, res) => {
  const t0 = Date.now();
  try {
    const responseBody = buildWorkoutTextParseDryRunResponse(req.body);
    // D7(a) refuse-and-ask (Decision Desk #942): at the per-line orchestration
    // boundary — after the parser resolved the recognized lines and with the KB
    // resolver in hand, before the client assembles preview rows — withhold any set
    // line whose exercise NEITHER the parser NOR the KB recognizes (needs_clarification,
    // zero rows), while KB-known parser-narrow lifts (Front Squat / Cable Fly) keep
    // logging. Read-only: only the dry-run parse shape changes — never a write, proof
    // field, schema, or the parser grammar (resolveExercise is injected so the
    // KB→parser decoupling holds and parser goldens stay untouched).
    responseBody.parsed = applyUnresolvedLiftGate(responseBody.parsed, resolveExercise);
    // F05 full-consumption / ambiguous-@ gate (PARSE-4, PARSE-5): after the parser
    // resolved the line, refuse-and-ask instead of silently dropping a mixed-notation
    // set group or logging a 2 lb "@N" barbell. Read-only, needs the ORIGINAL text
    // (parsed has already discarded the unconsumed tokens); only the dry-run parse
    // shape changes — never a write, proof field, schema, or the parser grammar.
    responseBody.parsed = applyFullConsumptionGate(responseBody.parsed, req.body && req.body.text);
    // Unify exercise identity: the parser's internal catalog is narrower than the
    // KB, so a real lift (e.g. Cable Fly) is flagged `unknown_exercise` even though
    // the KB recognizes it. Attach the KB identity so the client's "didn't catch
    // that lift" warning isn't split-brain with the confirmation card / voice that
    // already recognized it. Additive + read-only — no parser grammar, write, or
    // proof-field change (test_mode/sheet_written/no_write_confirmed untouched).
    try {
      const p = responseBody.parsed;
      if (p && p.intent === 'log_sets') {
        const hit = resolveExercise(p.canonical_name || p.exercise || p.raw_name || '');
        if (hit && hit.confident) {
          responseBody.kb_identity = { exercise_id: hit.exercise_id, name: hit.name, confidence: hit.confidence };
        }
      }
    } catch (_) { /* best-effort; recognition must never break the dry-run */ }
    // Multi-modality recognition (PR 486 slice 3): attach recognized non-slash
    // modality metadata (timed holds / steady cardio / intervals / circuits) to
    // the DRY-RUN preview so the client can show what was understood. Additive +
    // read-only: the slash-notation resistance parser still owns any `log_sets`
    // claim (the recognizer returns null for slash input, and we never attach
    // when the resistance parser claimed sets), nothing is written, and the
    // dry-run proof fields (test_mode/sheet_written/no_write_confirmed) are
    // untouched. No parser-grammar change.
    try {
      const p = responseBody.parsed;
      if (!(p && p.intent === 'log_sets')) {
        const modality = recognizeModalityInput(String(req.body?.text || ''));
        if (modality) responseBody.modality = modality;
      }
    } catch (_) { /* best-effort; recognition must never break the dry-run */ }
    console.log(`[parse-workout-text] ok ${Date.now() - t0}ms`);
    return standardSuccess(req, res, 'parse-workout-text processed', responseBody, 200);
  } catch (error) {
    console.error(`[parse-workout-text] error ${Date.now() - t0}ms: ${error.message}`);
    return standardError(req, res, error.message, null, 400);
  }
});

app.post('/api/parse-workout-image', upload.single('image'), async (req, res) => {

  if (!req.file) {
    return standardError(req, res, 'image file is required in multipart/form-data under field name image', null, 400);
  }

  try {
    const formFields = req.body || {};
    const visionResult = await parseWorkoutScreenshot(req.file.path);

    // Prepare parsed object for the response; attempt to normalize duration for display.
    const parsedForResponse = { ...visionResult.parsed_metrics };
    try {
      parsedForResponse.duration = normalizeDurationString(visionResult.parsed_metrics.duration);
    } catch (err) {
      // leave original duration if normalization fails; this endpoint only previews
      parsedForResponse.duration = visionResult.parsed_metrics.duration;
    }

    // Parse-only endpoint: build the effort row for the response preview, but never
    // write it. Saving effort requires explicit owner approval via the
    // approve-before-save flow (/api/complete-workout). sheet_write is always 'skipped'.
    const { effortRow, sessionId, dateValue } = buildEffortRowFromParsedMetrics(parsedForResponse, formFields);
    const sheetWrite = 'skipped';

    const responseBody = {
      status: visionResult.status,
      parsed: parsedForResponse,
      filename: req.file.filename,
      size: req.file.size,
      session_id: sessionId,
      date: dateValue,
      effort_row: effortRow,
      sheet_write: sheetWrite
    };

    return standardSuccess(req, res, 'parse-workout-image processed', responseBody, 200);
  } catch (error) {
    return standardError(req, res, 'OpenAI Vision parsing failed', { provider: 'openai-vision', error: error.message, safeWrite: true }, 500);
  } finally {
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
});


app.post('/api/complete-workout', upload.single('image'), async (req, res) => {

  const formFields = req.body || {};
  if (isAmbiguousTestMode(formFields.test_mode)) {
    return standardError(req, res, AMBIGUOUS_TEST_MODE_MESSAGE, null, 400);
  }
  const testMode = isTestModeEnabled(formFields.test_mode);
  const writeId = formFields.write_id;
  const hasManualEffortMetrics = Boolean(formFields.effort_json || formFields.effort || formFields.duration);
  let idempotency = { enabled: false, write_id: null, token: null };
  // CR-1 guard: once the sheet append succeeds the idempotency record must never
  // be released (failWrite) — a released record lets a retried write_id append a
  // second time. writeCommitted flips true after the append; liveWriteRecorded
  // flips true once the full response is recorded via completeWrite.
  let writeCommitted = false;
  let liveWriteRecorded = false;

  if (!req.file && !hasManualEffortMetrics) {
    return standardError(req, res, 'image file or manual effort metrics are required for complete-workout preview/write', null, 400);
  }

  // log_rows_json is required
  if (!formFields.log_rows_json) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'log_rows_json is required in multipart/form-data' });
  }

  let parsedLogRows;
  try {
    parsedLogRows = JSON.parse(formFields.log_rows_json);
  } catch (err) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    return standardError(req, res, 'log_rows_json is not valid JSON', process.env.NODE_ENV === 'production' ? null : err.message, 400);
  }

  if (!Array.isArray(parsedLogRows)) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'log_rows_json must be a JSON array' });
  }

  // Bound the array so an oversized payload can't drive unbounded row-by-row
  // enrichment (DoS). A real session is well under this; MAX_LOG_ROWS is a generous
  // ceiling (module-level: verify-range and undo-last share it — see its definition).
  if (parsedLogRows.length > MAX_LOG_ROWS) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    return standardError(req, res, `log_rows_json exceeds the ${MAX_LOG_ROWS}-row limit`, null, 400);
  }

  const effortOnly = parsedLogRows.length === 0;
  if (effortOnly && !req.file && !hasManualEffortMetrics) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Workout rows are required unless a screenshot or manual effort data is provided.' });
  }

  try {
    // 1) Parse image to get effort metrics.
    //
    // Graceful degrade: a screenshot parse failure (e.g. Gemini 429 / timeout)
    // must NOT sink the whole save. If there are logged sets, save them WITHOUT
    // effort data and tell the owner. Only an effort-only request (no rows) has
    // nothing left to save, so that case returns an honest 422 — never a 500.
    let visionResult;
    let screenshotUnreadable = false;
    if (req.file) {
      try {
        visionResult = await parseWorkoutScreenshot(req.file.path);
      } catch (error) {
        console.warn('⚠️ Screenshot effort parse failed; degrading:', error.message);
        if (effortOnly) {
          if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
          return standardError(
            req,
            res,
            "I couldn't read effort from the screenshot, and there are no logged sets to save without it.",
            process.env.NODE_ENV === 'production' ? null : error.message,
            422
          );
        }
        screenshotUnreadable = true;
        visionResult = { status: 'screenshot_unreadable', parsed_metrics: null };
      }
    } else {
      visionResult = { status: 'manual_effort', parsed_metrics: null };
    }

    // 2) Validate parsed effort metrics (required before any writes)
    let normalizedMetrics;
    let metricWarnings = [];
    try {
      if (screenshotUnreadable) {
        // No effort to validate — save the sets with a blank effort row.
        normalizedMetrics = { ...EMPTY_EFFORT_METRICS };
        metricWarnings = [SCREENSHOT_UNREADABLE_MESSAGE];
      } else {
        const result = req.file
          ? normalizeAndValidateParsedMetrics(visionResult.parsed_metrics)
          : normalizeManualEffortMetrics(formFields);
        normalizedMetrics = result.normalized;
        metricWarnings = result.warnings || [];
      }
    } catch (error) {
      // B3 effort-import isolation: a screenshot that PARSED but produced invalid
      // or incomplete effort metrics (e.g. missing activeCalories) must not poison
      // the workout save. If there are logged sets, degrade exactly like an
      // unreadable screenshot — save the sets with a blank effort row and surface
      // the specific owner-facing copy — instead of 400ing the whole request and
      // losing the exercise rows. Manual effort entry and effort-only requests
      // still fail honestly: there's nothing to fall back to (no sets to save) and
      // a manual value the owner typed should be corrected, not silently dropped.
      if (req.file && !effortOnly) {
        console.warn('⚠️ Screenshot effort metrics invalid; degrading to save sets without effort:', error.message);
        screenshotUnreadable = true;
        normalizedMetrics = { ...EMPTY_EFFORT_METRICS };
        metricWarnings = [SCREENSHOT_UNREADABLE_MESSAGE];
        // Converge with the throw-based degrade (line ~3026), which sets
        // parsed_metrics to null: discard the REJECTED screenshot's fields so its
        // date can't flow into resolveWorkoutDate / buildEffortRowFromParsedMetrics
        // on a no-manual-date save. Source-date handling for screenshots is B5's
        // scope, not B3's — both degrade paths must behave identically here.
        visionResult.parsed_metrics = null;
      } else if (req.file && effortOnly) {
        // Effort-only screenshot whose metrics parsed but were invalid/out-of-range:
        // there are no logged sets to fall back to, so fail closed — but with the
        // SAME 422 + specific owner copy as the unreadable-screenshot effort-only
        // branch above, so a "parsed but unusable" screenshot isn't handed a vaguer
        // error than an unreadable one. Manual effort-only (no file) keeps the 400
        // below — that's form-field validation, which surfaces its own field errors.
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
        return standardError(
          req,
          res,
          "I couldn't read usable effort from the screenshot, and there are no logged sets to save without it.",
          process.env.NODE_ENV === 'production' ? null : error.message,
          422
        );
      } else {
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
        return standardError(req, res, 'Parsed metrics validation failed', process.env.NODE_ENV === 'production' ? null : error.message, 400);
      }
    }

    // 3) Determine session/date — track the source so the preview can surface a
    // warning when the date fell back to today (screenshot date not visible /
    // not extractable) and the user needs to correct it before approving. A
    // screenshot date OUTSIDE the plausibility window (see isPlausibleScreenshotDate;
    // the vision model can weekday-match a wrong year onto a yearless header) is
    // REJECTED: never used for the save, reported via screenshot_date_rejected so
    // the review card can say what was seen and why it wasn't trusted.
    const screenshotDateRaw = visionResult.parsed_metrics?.date;
    const screenshotDateNormalized = normalizeDateCandidate(screenshotDateRaw);
    const screenshotDateUsable = screenshotDateNormalized && isPlausibleScreenshotDate(screenshotDateNormalized);
    const screenshotDateRejected = (screenshotDateNormalized && !screenshotDateUsable) ? screenshotDateNormalized : null;
    const manualDateRaw = formFields.date;
    const dateValue = resolveWorkoutDate({
      manualDate: manualDateRaw,
      screenshotDate: screenshotDateUsable ? screenshotDateNormalized : null
    });
    const dateSource = (manualDateRaw !== undefined && manualDateRaw !== null && String(manualDateRaw).trim() !== '')
      ? 'manual'
      : screenshotDateUsable ? 'screenshot' : 'today_fallback';

    // 4) Check duplicate session protection — fetch existing IDs first so we
    // can auto-increment the counter when two sessions share the same day/period.
    let existingEffortSessionIds;
    try {
      existingEffortSessionIds = await getEffortSessionIds();
    } catch (error) {
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
      return standardError(req, res, 'Failed to validate duplicate session.', null, 500);
    }

    // If the client supplied a session_id, honour it (explicit beats implicit).
    // A supplied id that already exists is still a duplicate (same data sent twice).
    //
    // WRITE-2: when the client omits a session_id (server-minted), a retry with the
    // SAME write_id must REUSE the id stamped into the prior idempotency record
    // instead of minting a fresh one. A freshly-minted id on retry would slip past
    // the composite-key (Log) and duplicate-session (Effort) dedupes and double-write
    // the whole workout. The client's explicit id always wins; a first attempt (no
    // prior record) mints fresh as before.
    let sessionId;
    let sessionIdReused = false;
    if (formFields.session_id) {
      sessionId = formFields.session_id;
    } else {
      const priorRecord = normalizeWriteId(writeId) ? peekWrite(writeId) : null;
      // Only reuse the minted id for a NON-completed prior attempt (failed or a
      // stale/in-progress reservation that beginWrite will downgrade) — that is the
      // retry path that actually writes, where reuse keeps the dedupes effective. A
      // COMPLETED record must instead fall through to beginWrite's idempotency
      // replay (200 skipped_duplicate); reusing its id here would trip the
      // duplicate-session hard-stop below and 409 a successful, already-saved
      // workout on a lost-response retry.
      const priorMintedSessionId = priorRecord
        && priorRecord.status !== 'completed'
        && priorRecord.metadata
        && priorRecord.metadata.session_id;
      if (priorMintedSessionId) {
        sessionId = priorMintedSessionId;
        sessionIdReused = true;
      } else {
        sessionId = nextAvailableSessionId(dateValue, existingEffortSessionIds);
      }
    }

    // A client-supplied id OR a reused server-minted id that already exists in Effort
    // is a duplicate session (never double-write the Effort tab). A freshly-minted id
    // is next-available by construction, so it is never already in the list.
    const duplicateSession = (Boolean(formFields.session_id) || sessionIdReused) &&
      existingEffortSessionIds.map(id => id.toLowerCase()).includes(String(sessionId).toLowerCase());
    // A duplicate effort session HARD-STOPS the live write (never double-write the
    // Effort tab). But a DRY-RUN preview must not fail closed — it continues to the
    // normal preview, which reports `duplicate_check.duplicate_session: true` (below) so
    // the client shows a graceful "already saved" note instead of a red "Preview failed".
    // This is the re-used-screenshot case: same screenshot → same screenshot-date
    // session_id → that session is already in Effort.
    if (duplicateSession && !testMode) {
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
      return standardError(req, res, 'Duplicate session.', null, 409);
    }

    // 5) Enrich and format log rows using existing catalog logic
    let formattedLogRows = [];
    let enrichWarnings = [];
    let pendingExercises = [];
    let autoMatches = [];
    let completeRuleFlags = [];
    if (!effortOnly) {
      try {
        // fetch catalog once and pass the map to the enricher to ensure consistent lookup
        const catalogRows = await getExerciseCatalog();
        const catalogMap = buildExerciseCatalogMap(catalogRows);
        // F08 / CLIENT-4: stamp the resolved canonical session date onto every Log
        // row so Log_Cleaned can never diverge from the Effort row (which already
        // uses dateValue) on a screenshot-dated or backdated closeout. Applies to
        // the dry-run preview AND the live write — the preview shows exactly what
        // Approve writes.
        const sessionDatedLogRows = parsedLogRows.map(row => withCanonicalSessionDate(row, dateValue));
        const enrichResult = await enrichAndFormatLogRows(sessionDatedLogRows, sessionId, dateValue, catalogMap);
        formattedLogRows = enrichResult.formattedRows;
        enrichWarnings = enrichResult.warnings || [];
        pendingExercises = enrichResult.pending_exercises || [];
        autoMatches = enrichResult.auto_matches || [];
        completeRuleFlags = evaluateSessionSafety(enrichResult.enrichedRowObjects || [], formFields.notes || '');
        // store pending exercises in memory (dedupe by exercise)
        for (const pe of pendingExercises) {
          const key = String(pe.exercise || '').trim().toLowerCase();
          if (!key) continue;
          const exists = pendingExercisesMemory.some(e => String(e.exercise || '').trim().toLowerCase() === key);
          if (!exists) pendingExercisesMemory.push(pe);
        }
      } catch (error) {
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
        return standardError(req, res, 'Log rows validation/enrichment failed', process.env.NODE_ENV === 'production' ? null : error.message, 400);
      }
    }

    // 6) Build effort_row from normalized metrics. `date` (the guarded dateValue)
    // always wins inside the builder; pass only a plausibility-checked screenshot
    // date as the fallback so a rejected (weekday-matched wrong-year) date can
    // never reach an Effort row through any path.
    const { effortRow } = buildEffortRowFromParsedMetrics(normalizedMetrics, {
      date: dateValue,
      screenshot_date: screenshotDateUsable ? screenshotDateNormalized : null,
      session_id: sessionId,
      location: formFields.location,
      notes: formFields.notes
    });

    // 7) Duplicate protection for Log_Cleaned rows (session_id + exercise + set_number)
    const rowsToWrite = [];
    const skippedDuplicates = [];
    if (!effortOnly) {
      const existingLogKeys = await getLogCompositeKeys();
      const intendedKeys = formattedLogRows.map(row => {
        // formatted row order follows logCleanedColumns
        const sid = String(row[1] || '').trim().toLowerCase();
        const ex = String(row[2] || '').trim().toLowerCase();
        const setn = String(row[6] || '').trim().toLowerCase();
        return `${sid}||${ex}||${setn}`;
      });

      for (let i = 0; i < formattedLogRows.length; i += 1) {
        const key = intendedKeys[i];
        if (existingLogKeys.includes(key)) {
          skippedDuplicates.push({ index: i, row: formattedLogRows[i] });
        } else {
          rowsToWrite.push(formattedLogRows[i]);
        }
      }
    }

    let logRowsWritten = 0;
    let effortRowsWritten = 0;
    let logAppendedRange = null;
    let effortAppendedRange = null;
    let effortWritten = false;
    if (!testMode) {
      // Live writes must carry a write_id so a lost-response retry is deduplicated
      // instead of appending the same session twice. Dry-runs never write, so they
      // are exempt (the preview path above never reaches here).
      if (!normalizeWriteId(writeId)) {
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
        return standardError(req, res, 'write_id is required', null, 400);
      }
      // Idempotency guard: a retried write_id must never append a second time.
      // Mirrors the /api/log-workout contract (beginWrite → completeWrite/failWrite).
      idempotency = beginWrite(writeId, {
        endpoint: '/api/complete-workout',
        session_id: sessionId,
        date: dateValue,
        log_rows_count: rowsToWrite.length,
        effort_only: effortOnly
      });

      if (idempotency.duplicate) {
        const record = idempotency.record || {};
        const originalData = (record.response && record.response.data) || {};
        const duplicateData = {
          ...originalData,
          duplicate_write: true,
          write_id: idempotency.write_id,
          idempotency_status: record.status || 'unknown',
          sheet_write: record.status === 'completed' ? 'skipped_duplicate' : 'skipped_duplicate_in_progress',
          sheet_written: false,
          original_sheet_written: originalData.sheet_written === true,
          original_log_rows_written: originalData.log_rows_written ?? null,
          original_effort_written: originalData.effort_written === true,
          original_completed_at: record.completed_at || null
        };
        // F02 / WRITE-1: an original write whose Sheets append proof was never
        // verified must NOT be replayed as a save on retry. The rows may be on the
        // sheet, but the proof was inconsistent — so a retried write_id keeps
        // failing closed with the unverified state instead of returning the
        // skipped_duplicate success shape the client accepts as saved.
        if (originalData.sheet_write === 'unverified' || originalData.proof_mismatch === true) {
          if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
          return standardError(
            req, res,
            'Duplicate write_id; the original complete-workout append proof was unverified and cannot be confirmed as saved.',
            { ...duplicateData, sheet_write: 'unverified', proof_mismatch: true },
            500
          );
        }
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
        const dupMessage = record.status === 'completed'
          ? 'Duplicate write_id; original complete-workout was already processed.'
          : 'Duplicate write_id; original complete-workout is already in progress.';
        return standardSuccess(req, res, dupMessage, { status: 'ok', message: dupMessage, data: duplicateData }, record.status === 'completed' ? 200 : 409);
      }

      // Header-drift guard: confirm the target tabs still match the column
      // contract before any append. A mismatch releases the write_id (nothing
      // was written) and refuses the write.
      try {
        const headerFailures = await assertWriteHeaderContracts({
          checkLog: rowsToWrite.length > 0,
          checkEffort: true
        });
        if (headerFailures.length > 0) {
          if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
          if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
          return standardError(req, res, schemaDriftMessage(headerFailures), schemaDriftDetails(headerFailures), 409);
        }
      } catch (error) {
        console.error('❌ Failed to validate sheet header contract:', error);
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
        if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
        return standardError(req, res, 'Failed to validate sheet header contract.', null, 500);
      }

      try {
        if (rowsToWrite.length > 0) {
          const logResponse = await appendRows(logSheetName, rowsToWrite);
          logAppendedRange = logResponse?.data?.updates?.updatedRange || null;
          logRowsWritten = Number(logResponse?.data?.updates?.updatedRows || 0);
          // Log rows have landed. From here a failure must never release the
          // write_id (a retry would re-append these rows) — mark the write
          // committed so the catch records a partial completion instead.
          writeCommitted = true;
        }
        const effortResponse = await appendRows(effortSheetName, [effortRow]);
        effortAppendedRange = effortResponse?.data?.updates?.updatedRange || null;
        effortRowsWritten = Number(effortResponse?.data?.updates?.updatedRows || 0);
        effortWritten = true;
        writeCommitted = true;
        invalidateSheetRowsCache();
      } catch (error) {
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
        if (idempotency.enabled && writeCommitted) {
          // The log rows are already on the sheet but the effort append (or a
          // later step) threw. Record the write as completed with a partial body
          // so a retried write_id replays this state instead of re-appending the
          // log rows. Mirrors /api/log-workout's partial-write contract.
          invalidateSheetRowsCache();
          const partialData = {
            session_id: sessionId,
            date: dateValue,
            write_id: idempotency.write_id,
            duplicate_write: false,
            idempotency_status: 'completed',
            sheet_write: 'partial',
            sheet_written: true,
            log_rows_written: logRowsWritten,
            logAppendedRange,
            // Report what actually landed: normally false here (the effort append
            // is what threw), but use the flag so an unlikely throw from a later
            // step after a successful effort append can't understate the row.
            effort_written: effortWritten,
            post_processing_error: true
          };
          completeWrite(idempotency.write_id, idempotency.token, {
            status: 'ok',
            message: 'complete-workout log rows written; effort append failed',
            data: partialData
          });
          liveWriteRecorded = true;
          return standardError(req, res, 'Effort row append failed after log rows were written.', partialData, 500);
        }
        if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
        return standardError(req, res, 'Failed to append workout data.', null, 500);
      }

      // F02 / WRITE-1: a success response must never claim a write the Sheets
      // append response did not confirm. Verify the authoritative append proof
      // (exact range + row count per tab). The rows have already landed here, so
      // record the write committed (a retry must not re-append) and surface the
      // anomaly instead of reporting 'success' — a proof mismatch freezes the
      // save into an explicit unverified state rather than a false success.
      const logProofOk = rowsToWrite.length === 0
        ? true
        : (!!logAppendedRange && logRowsWritten === rowsToWrite.length);
      const effortProofOk = !!effortAppendedRange && effortRowsWritten === 1;
      if (!logProofOk || !effortProofOk) {
        const unverified = {
          session_id: sessionId,
          date: dateValue,
          write_id: idempotency.write_id,
          duplicate_write: false,
          idempotency_status: 'completed',
          sheet_write: 'unverified',
          sheet_written: true,
          log_rows_written: logRowsWritten,
          logAppendedRange,
          expected_log_rows: rowsToWrite.length,
          effort_written: effortWritten,
          effort_rows_written: effortRowsWritten,
          effortAppendedRange,
          proof_mismatch: true
        };
        if (idempotency.enabled) {
          completeWrite(idempotency.write_id, idempotency.token, {
            status: 'error',
            message: 'complete-workout append proof missing or inconsistent',
            data: unverified
          });
          liveWriteRecorded = true;
        }
        return standardError(req, res, 'Workout write could not be verified against the Sheets append proof.', unverified, 500);
      }
    }

    const duplicateWarnings = skippedDuplicates.length > 0 ? [`${skippedDuplicates.length} log row(s) skipped due to duplicate session_id+exercise+set_number`] : [];
    const combinedWarnings = [...new Set([...(metricWarnings || []), ...(enrichWarnings || []), ...duplicateWarnings])];

    // logCleanedColumns order: date[0] session[1] exercise[2] canonical[3]
    // muscle[4] lift_code[5] set_number[6] weight[7] reps[8] rir[9] notes[10]
    const completeSessionBest = {};
    for (const row of formattedLogRows) {
      const lc = String(row[5] || '').trim().toUpperCase();
      const w  = parseNumber(row[7]);
      if (!lc || lc === 'UNKNOWN' || !w || w <= 0) continue;
      if (!completeSessionBest[lc] || w > completeSessionBest[lc].weight) {
        completeSessionBest[lc] = { weight: w, exercise: String(row[3] || row[2] || lc) };
      }
    }
    const completeQualityMetrics = {
      totalSets: formattedLogRows.length,
      effortDuration: normalizedMetrics.duration,
      averageHR: normalizedMetrics.averageHR,
      activeCalories: normalizedMetrics.activeCalories,
      uniqueExercisesCount: new Set(formattedLogRows.map(r => String(r[2] || '').toLowerCase())).size,
      validationWarnings: combinedWarnings,
      setsWithRir: formattedLogRows.map(r => parseNumber(r[9])).filter(v => v !== null && Number.isFinite(v)),
      sessionBestByLift: completeSessionBest,
      historicalBestByLift: {}
    };
    const qualityScore = calculateQualityScore(completeQualityMetrics);
    const qualityBreakdown = qualityScoreBreakdown(completeQualityMetrics);

    const responseBody = {
      status: 'ok',
      message: 'complete-workout processed',
      data: {
        session_id: sessionId,
        date: dateValue,
        date_source: dateSource,
        // The implausible screenshot date the guard refused to use (e.g. a
        // weekday-matched wrong year) — lets the review card say what was seen
        // and why it wasn't trusted. Absent when no date was rejected.
        ...(screenshotDateRejected ? { screenshot_date_rejected: screenshotDateRejected } : {}),
        test_mode: testMode,
        effort_only: effortOnly,
        sheet_written: !testMode && effortWritten,
        sheet_write: testMode ? 'skipped' : 'success',
        log_rows_written: testMode ? 0 : logRowsWritten,
        effort_written: effortWritten,
        duplicate_check: {
          duplicate_session: duplicateSession,
          duplicate_log_rows: skippedDuplicates.length
        },
        effort_source: req.file ? (screenshotUnreadable ? 'screenshot_unreadable' : 'screenshot') : 'manual',
        screenshot_unreadable: screenshotUnreadable,
        parsed_effort: normalizedMetrics,
        quality_score: qualityScore,
        quality_breakdown: qualityBreakdown
      }
    };

    if (combinedWarnings.length > 0) responseBody.warnings = combinedWarnings;
    if (completeRuleFlags.length > 0) responseBody.data.rule_flags = completeRuleFlags;

    // F02 / WRITE-1: report the authoritative per-tab append proof on the live
    // write (dry runs never append, so they carry no range/count proof).
    if (!testMode) {
      responseBody.data.logAppendedRange = logAppendedRange;
      responseBody.data.effortAppendedRange = effortAppendedRange;
      responseBody.data.effort_rows_written = effortRowsWritten;
    }

    if (testMode) {
      responseBody.test_mode = true;
      responseBody.data.no_write_confirmed = true;
      responseBody.data.sheet_write = 'skipped';
      responseBody.data.effort_row = effortRow;
      responseBody.data.log_rows_preview = formattedLogRows;
      responseBody.data.rows_to_write = rowsToWrite;
      responseBody.data.rows_skipped = skippedDuplicates.map(s => s.row);
      responseBody.data.enrichment = formattedLogRows.map(row => ({
        exercise: row[2],
        canonical_exercise: row[3],
        muscle_group: row[4],
        lift_code: row[5]
      }));
    }

    // include pending_exercises and auto_matches when present
    if (pendingExercises.length > 0) responseBody.pending_exercises = pendingExercises;
    if (autoMatches.length > 0) responseBody.auto_matches = autoMatches;

    // Record the completed live write so a retried write_id replays this exact
    // response instead of appending again. Dry runs never touch idempotency state.
    if (!testMode && idempotency.enabled) {
      responseBody.data.write_id = idempotency.write_id;
      responseBody.data.duplicate_write = false;
      responseBody.data.idempotency_status = 'completed';
      completeWrite(idempotency.write_id, idempotency.token, responseBody);
      liveWriteRecorded = true;
    }

    return standardSuccess(req, res, 'complete-workout processed', responseBody, 200);
  } catch (error) {
    if (idempotency.enabled) {
      if (writeCommitted && !liveWriteRecorded) {
        // Rows are already on the sheet but the response post-processing threw.
        // Record the write as completed so a retried write_id replays this state
        // instead of appending a second time (never failWrite a committed write).
        completeWrite(idempotency.write_id, idempotency.token, {
          status: 'ok',
          message: 'complete-workout written; response post-processing failed',
          data: {
            write_id: idempotency.write_id,
            sheet_written: true,
            idempotency_status: 'completed',
            post_processing_error: true
          }
        });
      } else if (!writeCommitted) {
        failWrite(idempotency.write_id, idempotency.token);
      }
    }
    return standardError(req, res, 'Failed to complete workout ingestion', { error: error.message, safeWrite: true }, 500);
  } finally {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
  }
});

// Keywords that indicate an equipment or availability constraint forced the swap.
// Matching any word here causes buildSubstitutionPreviews to synthesize a transient
// equipment constraint so the classifier can upgrade to equipment_constraint_honored.
const EQUIPMENT_REASON_RE = /\b(platforms?|racks?|machines?|equipment|unavailable|occupied|broken|closed)\b/i;
function reasonIsEquipmentConstraint(reason) {
  return typeof reason === 'string' && EQUIPMENT_REASON_RE.test(reason);
}

// Build substitution-intent previews for any logged lift that differs from the
// prescribed one supplied by the client. READ-ONLY: reads log history (for the
// baseline-vs-judge decision) and the Constraints tab to classify; never writes,
// never touches the trust loop. Returns [] when no prescribed pairs are given.
//
// `prescribedList` entries: { logged_exercise, exercise, lift_code?, reason? }
//   logged_exercise — the logged lift to pair against (matched case-insensitively
//                     to the enriched row's exercise / canonical_exercise)
//   exercise        — the prescribed lift name
//   lift_code       — optional prescribed lift code (history lookup key)
//   reason          — optional human reason text (e.g. "platform busy")
//
// The engine emits the decision; the voice layer only words it later.
async function buildSubstitutionPreviews(prescribedList, enrichedLoggedRows, ruleFlags) {
  // First occurrence of each distinct logged lift, keyed by both raw and canonical name.
  const loggedByName = new Map();
  for (const r of (enrichedLoggedRows || [])) {
    const logged = { name: r.canonical_exercise || r.exercise || '', lift_code: r.lift_code || null };
    for (const k of [r.exercise, r.canonical_exercise]) {
      const key = String(k || '').trim().toLowerCase();
      if (key && !loggedByName.has(key)) loggedByName.set(key, logged);
    }
  }

  // Pain signal reuses the safety rules already evaluated for this preview.
  const painFlag = Array.isArray(ruleFlags) && ruleFlags.some(f => f && f.rule_id === 'pain_flag');

  // Lazy reads — only reached when prescribed pairs are present.
  const [allLog, constraintRows] = await Promise.all([
    getSheetRows(logSheetName).catch(() => []),
    getSheetRows('Constraints').catch(() => [])
  ]);
  const constraints = (constraintRows || [])
    .map(row => Array.isArray(row)
      ? { date: row[0] || null, kind: row[1] || null, target: row[2] || null, rule: row[3] || null, note: row[4] || null }
      : { date: row.date || null, kind: row.kind || null, target: row.target || null, rule: row.rule || null, note: row.note || null })
    .filter(c => c.kind && c.target && c.rule);

  const out = [];
  for (const p of prescribedList) {
    if (!p || typeof p !== 'object') continue;
    const prescribedName = String(p.exercise || '').trim();
    const loggedKey = String(p.logged_exercise || '').trim().toLowerCase();
    if (!prescribedName || !loggedKey) continue;
    const logged = loggedByName.get(loggedKey);
    if (!logged) continue;
    // Only classify genuine swaps — identical prescribed/logged is not a substitution.
    if (!detectSwap(prescribedName, logged.name).swapped) continue;
    const prescribedLiftCode = p.lift_code ? String(p.lift_code).trim().toLowerCase() : null;
    const history = prescribedLiftCode
      ? allLog.filter(row => String(row[5] || '').toLowerCase() === prescribedLiftCode)
      : [];
    const reasonConstraints = reasonIsEquipmentConstraint(p.reason)
      ? [{ kind: 'equipment', target: prescribedName, rule: 'substitute' }]
      : [];
    const sub = classifySubstitution({
      prescribed: { name: prescribedName, lift_code: p.lift_code || null },
      logged,
      constraints: reasonConstraints.length ? [...constraints, ...reasonConstraints] : constraints,
      painFlag,
      history
    });
    // Attach the stimulus-quality tier (excellent/acceptable/poor/unknown) so the
    // coach can word the swap accurately and never assert "good swap" the engine
    // can't back. Pure, deterministic — same prescribed/logged the classifier saw.
    sub.quality = scoreSubstitutionQuality(prescribedName, logged.name).quality;
    out.push(p.reason ? { ...sub, reason: String(p.reason).trim().slice(0, 200) } : sub);
  }
  return out;
}

// F10D — the one approval's verification verdict (Codex P1, PR #1068). The seal
// must be OK, and a PLANNED closeout (client-declared items) that found NO ledger
// rows is NOT verified — once the write flag is on, a lost acceptance checkpoint
// or missing tab must never masquerade as a fully verified closeout. A freestyle
// session (no declared items) with no ledger is verified-empty, and a dry-run
// seal (owner gate closed) leaves nothing pending to verify.
function closeoutVerification(ledgerSeal, closeoutContext, sessionPlansCloseout) {
  if (!ledgerSeal) return undefined;
  // The Session_Plans closeout event must have recorded (or be genuinely
  // inapplicable: no accepted plan, or its capture lane disabled) — a failed or
  // missing-tab event capture is an unverified closeout (Codex P1, PR #1069).
  const ev = sessionPlansCloseout || null;
  const eventOk = !ev || ev.captured === true || ev.status === 'disabled' || ev.status === 'no_plan';
  if (!eventOk) return false;
  if (ledgerSeal.dry_run === true) return true;
  const ctx = closeoutContext && typeof closeoutContext === 'object' ? closeoutContext : {};
  const plannedItems = boundCloseoutContextItems(ctx.items).length > 0;
  if (ledgerSeal.no_ledger === true && plannedItems) return false;
  return ledgerSeal.sealed_ok === true;
}

// The accepted plan's opaque pv_ token from the client closeout context; '' when
// absent or malformed (a freestyle session, or junk — either way: no event).
function closeoutPlanVersion(closeoutContext) {
  const ctx = closeoutContext && typeof closeoutContext === 'object' ? closeoutContext : {};
  const pv = String(ctx.plan_version == null ? '' : ctx.plan_version).trim();
  return /^pv_.+/.test(pv) ? pv : '';
}

// Record the finalized closeout event for an accepted plan, failure-isolated to
// an honest envelope (never a throw). '' plan_version → { status: 'no_plan' }.
async function recordCloseoutEvent(session_id, session_date, closeoutContext) {
  const pv = closeoutPlanVersion(closeoutContext);
  if (!pv) return { status: 'no_plan', captured: false };
  try {
    return await captureCloseout({ session_id, session_date, plan_version: pv }, 'finalized');
  } catch (error) {
    return { status: 'error', captured: false, reason: String((error && error.message) || error) };
  }
}

app.post('/api/log-workout', async (req, res) => {

  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return standardError(req, res, 'Invalid JSON payload. A JSON object is required.', null, 400);
  }

  const { session_id, date, log_rows, effort_row } = payload;
  if (isAmbiguousTestMode(payload.test_mode)) {
    return standardError(req, res, AMBIGUOUS_TEST_MODE_MESSAGE, null, 400);
  }
  const testMode = isTestModeEnabled(payload.test_mode);
  const writeId = payload.write_id;

  if (!session_id) {
    return standardError(req, res, 'session_id is required.', null, 400);
  }

  if (!date) {
    return standardError(req, res, 'date is required.', null, 400);
  }

  // Reject an unparseable date rather than write it into date_clean verbatim.
  const workoutDate = normalizeWorkoutDateStrict(date);
  if (!workoutDate) {
    return standardError(req, res, 'date must be a valid calendar date (YYYY-MM-DD).', null, 400);
  }

  if (log_rows === undefined) {
    return standardError(req, res, 'log_rows is required.', null, 400);
  }

  if (!Array.isArray(log_rows)) {
    return standardError(req, res, 'log_rows must be an array.', null, 400);
  }

  if (log_rows.length === 0) {
    return standardError(req, res, 'log_rows must be a non-empty array.', null, 400);
  }

  // Bound the batch size on the JSON path too — MAX_LOG_ROWS was enforced only on
  // the multipart /api/complete-workout path, so a single JSON write of >200 rows
  // would append yet be un-verifiable and un-undoable (both cap at MAX_LOG_ROWS).
  if (log_rows.length > MAX_LOG_ROWS) {
    return standardError(req, res, `log_rows exceeds the ${MAX_LOG_ROWS}-row limit.`, null, 400);
  }

  if (effort_row !== undefined && !Array.isArray(effort_row) && !(effort_row && typeof effort_row === 'object')) {
    return standardError(req, res, 'effort_row must be an array or object when provided.', null, 400);
  }

  let formattedLogRows;
  let warnings = [];
  let pendingExercisesForPreview = [];
  let autoMatchesForPreview = [];
  let ruleFlags = [];
  let enrichedRowObjects = [];
  try {
    const logResult = await enrichAndFormatLogRows(log_rows, session_id, workoutDate);
    formattedLogRows = logResult.formattedRows;
    warnings = logResult.warnings || [];
    pendingExercisesForPreview = logResult.pending_exercises || [];
    autoMatchesForPreview = logResult.auto_matches || [];
    enrichedRowObjects = logResult.enrichedRowObjects || [];
    ruleFlags = evaluateSessionSafety(enrichedRowObjects, payload.notes || '');
  } catch (error) {
    return standardError(req, res, error.message, null, 400);
  }

  let formattedEffortRow = null;
  if (effort_row !== undefined) {
    try {
      formattedEffortRow = formatEffortRow(effort_row);
    } catch (error) {
      return standardError(req, res, error.message, null, 400);
    }
  }

  if (testMode) {
    // ME-13: history-aware safety guards (rirDrift + the e1RM typo guard) run on
    // the dry-run preview only. They need the lift's logged history, and surfacing
    // them before the owner approves is exactly where a fatigue-drift / mistyped-
    // weight caution is useful. Best-effort: a history read failure must never block
    // the preview — the row-local ruleFlags computed above still stand. The live-write
    // path is intentionally left untouched (no extra Sheets read on the write hot path).
    try {
      const historyRows = (await getSheetRows(logSheetName)).map(normalizeAnalyticsLogRow);
      ruleFlags = evaluateSessionSafety(enrichedRowObjects, payload.notes || '', historyRows);
    } catch { /* keep the row-local ruleFlags already computed above */ }

    // Substitution-intent classification (read-only). Best-effort: a failure here
    // must never block a dry-run preview, and it never changes the no-write proof.
    let substitutions = [];
    const prescribedList = Array.isArray(payload.prescribed) ? [...payload.prescribed] : [];
    // Infer additional prescribed pairs from any active planned session.
    // plan_exercises: [{name, lift_code?}] supplied by the client when a plan is active.
    // Pairs are merged after explicit skip-notation pairs so explicit wiring wins.
    if (Array.isArray(payload.plan_exercises) && payload.plan_exercises.length > 0) {
      try {
        const loggedNames = enrichedRowObjects.map(r => ({
          name: r.canonical_exercise || r.exercise || '',
          lift_code: r.lift_code || null,
        }));
        const inferredPairs = inferPrescribedPairs(payload.plan_exercises, loggedNames);
        const explicitExercises = new Set(
          prescribedList.map(p => String(p.exercise || '').toLowerCase())
        );
        for (const pair of inferredPairs) {
          if (!explicitExercises.has(String(pair.exercise || '').toLowerCase())) {
            prescribedList.push(pair);
          }
        }
      } catch { /* best-effort — inference failure must never block a dry-run preview */ }
    }
    if (prescribedList.length > 0) {
      try {
        substitutions = await buildSubstitutionPreviews(prescribedList, enrichedRowObjects, ruleFlags);
      } catch (error) {
        substitutions = [];
      }
    }

    // Mirror the live-write row-level dedup in the dry-run so the preview shows
    // EXACTLY the rows the live write will append — never more. Without this the
    // preview promised rows the write then silently skipped (the closeout "30
    // previewed / 22 written, Bench Press dropped entirely" trust failure). Best
    // effort: a read failure must never block a dry-run, so fall back to the raw
    // rows — the live write still applies the authoritative dedup before any append.
    let previewLogRows = formattedLogRows;
    let previewSkippedDuplicates = 0;
    try {
      const existingLogKeys = await getLogCompositeKeys();
      const partition = partitionLogRowsByExisting(formattedLogRows, existingLogKeys);
      previewLogRows = partition.newRows;
      previewSkippedDuplicates = partition.skippedDuplicates.length;
    } catch (error) {
      console.error('⚠️ Preview duplicate check failed; previewing all rows (the live write still dedups):', error);
      previewLogRows = formattedLogRows;
      previewSkippedDuplicates = 0;
    }

    // F10D — the closeout confirmation. Presence-gated on closeout_context: the
    // per-message logging previews never send it and are byte-identical to before.
    // The summary composes the two truths (recommendation ledger + staged actuals)
    // and echoes the EXACT rows the approved write will append; the seal preview
    // reports what the approval would stamp. An unreadable ledger is flagged
    // honestly — never presented as "no stored plan".
    let closeoutSummary = null;
    let ledgerSealPreview = null;
    if (payload.closeout_context !== undefined) {
      const ctx = payload.closeout_context && typeof payload.closeout_context === 'object' ? payload.closeout_context : {};
      const ledger = await readLedgerRows(session_id);
      try {
        ledgerSealPreview = await sealCloseout({ session_id }, normalizeWriteId(writeId) || 'closeout-preview', { test_mode: true });
      } catch (_) { ledgerSealPreview = null; }
      // Display names for code-only items (a skipped slot has no client name; the
      // confirmation must never show the owner a bare lift code). Best-effort — a
      // catalog read failure only costs names, never the summary.
      let codeToName = {};
      try {
        const catalogRows = await getExerciseCatalog();
        const header = ((catalogRows && catalogRows[0]) || []).map(c => String(c || '').trim().toLowerCase());
        const codeIdx = header.findIndex(v => ['lift code', 'lift_code', 'liftcode'].includes(v));
        const nameIdx = header.findIndex(v => ['canonical_exercise', 'canonical exercise', 'canonical_name', 'canonical name', 'exercise'].includes(v));
        if (codeIdx !== -1 && nameIdx !== -1) {
          for (let i = 1; i < catalogRows.length; i += 1) {
            const code = String((catalogRows[i] || [])[codeIdx] || '').trim();
            const nm = String((catalogRows[i] || [])[nameIdx] || '').trim();
            if (code && nm && !codeToName[code]) codeToName[code] = nm;
          }
        }
      } catch (_) { codeToName = {}; }
      closeoutSummary = buildCloseoutSummary({
        session: { session_id, session_date: workoutDate },
        ledgerRows: ledger === null ? [] : ledger,
        items: boundCloseoutContextItems(ctx.items),
        actualRows: enrichedRowObjects,
        logRowsPreview: previewLogRows,
        effortRowPreview: formattedEffortRow,
        sealPreview: ledgerSealPreview,
        codeToName,
      });
      if (ledger === null) closeoutSummary.ledger_read_failed = true;
    }

    const previewBody = {
      test_mode: true,
      sheet_write: 'skipped',
      sheet_written: false,
      no_write_confirmed: true,
      effortWritten: Boolean(formattedEffortRow),
      log_rows_preview: previewLogRows
    };
    if (closeoutSummary) {
      previewBody.closeout_summary = closeoutSummary;
      if (ledgerSealPreview) previewBody.ledger_seal_preview = ledgerSealPreview;
    }
    if (previewSkippedDuplicates > 0) previewBody.skipped_duplicates = previewSkippedDuplicates;
    if (formattedEffortRow) previewBody.effort_row_preview = formattedEffortRow;
    if (warnings.length > 0) previewBody.warnings = [...new Set(warnings)];
    if (pendingExercisesForPreview.length > 0) previewBody.pending_exercises = pendingExercisesForPreview;
    if (autoMatchesForPreview.length > 0) previewBody.auto_matches = autoMatchesForPreview;
    if (ruleFlags.length > 0) previewBody.rule_flags = ruleFlags;
    if (substitutions.length > 0) previewBody.substitutions = substitutions;
    return standardSuccess(req, res, 'log-workout processed', previewBody, 200);
  }

  // Live writes must carry a write_id so a lost-response retry is deduplicated
  // instead of appending the same rows twice. Dry-runs (above) never write, so
  // they are exempt.
  if (!normalizeWriteId(writeId)) {
    return standardError(req, res, 'write_id is required', null, 400);
  }

  const idempotency = beginWrite(writeId, {
    endpoint: '/api/log-workout',
    session_id,
    date: workoutDate,
    log_rows_count: formattedLogRows.length,
    effort_row_present: Boolean(formattedEffortRow)
  });

  if (idempotency.duplicate) {
    const record = idempotency.record || {};
    const original = record.response || {};
    const duplicateBody = {
      ...original,
      duplicate_write: true,
      write_id: idempotency.write_id,
      idempotency_status: record.status || 'unknown',
      sheet_write: record.status === 'completed' ? 'skipped_duplicate' : 'skipped_duplicate_in_progress',
      sheet_written: false,
      original_sheet_write: original.sheet_write || null,
      original_completed_at: record.completed_at || null
    };

    const message = record.status === 'completed'
      ? 'Duplicate write_id; original write was already processed.'
      : 'Duplicate write_id; original write is already in progress.';

    return standardSuccess(req, res, message, duplicateBody, record.status === 'completed' ? 200 : 409);
  }

  if (formattedEffortRow) {
    let existingEffortSessionIds;
    try {
      existingEffortSessionIds = await getEffortSessionIds();
    } catch (error) {
      console.error('❌ Failed to check duplicate session IDs:', error);
      if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
      return standardError(req, res, 'Failed to validate duplicate session.', null, 500);
    }

    if (existingEffortSessionIds.map(id => id.toLowerCase()).includes(String(session_id).toLowerCase())) {
      if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
      return standardError(req, res, 'Duplicate session.', null, 409);
    }
  }

  // Row-level duplicate guard for Log_Cleaned (session_id + exercise + set_number).
  // The write_id guard above only catches a replay of the SAME write_id; it does
  // not stop a re-previewed save, which mints a fresh write_id (public/app.js
  // regenerates it per preview) while reusing the stable session_id. Without this
  // filter, re-approving an already-saved workout (e.g. after a failed effort
  // import forces a re-preview) appends the same rows again under one session_id —
  // the "49 sets / 51,390 lb" duplication from the 2026-06-26 playtest. Mirrors the
  // proven row-level dedup already used by /api/complete-workout, so legitimate new
  // rows still append and only exact (session‖exercise‖set) duplicates are skipped.
  // Uses the SAME partition helper as the dry-run preview above, so what the
  // preview showed and what the write appends can never diverge.
  let rowsToWrite = formattedLogRows;
  let skippedDuplicates = [];
  try {
    const existingLogKeys = await getLogCompositeKeys();
    const partition = partitionLogRowsByExisting(formattedLogRows, existingLogKeys);
    rowsToWrite = partition.newRows;
    skippedDuplicates = partition.skippedDuplicates;
  } catch (error) {
    console.error('❌ Failed to check for duplicate log rows:', error);
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, 'Failed to validate duplicate log rows.', null, 500);
  }

  // Every intended log row is already on the sheet for this session. When there
  // is no new Effort row, append nothing and replay an idempotent "already
  // logged" response. When a valid new Effort row is present, continue so the
  // Effort append can repair the missing tab without duplicating Log_Cleaned.
  if (rowsToWrite.length === 0 && !formattedEffortRow) {
    const duplicateBody = {
      message: 'All rows were already logged for this session; nothing appended.',
      test_mode: false,
      sheet_write: 'skipped_duplicate',
      sheet_written: false,
      original_sheet_write: 'success',
      duplicate_write: true,
      all_rows_duplicate: true,
      log_rows_written: 0,
      skipped_duplicates: skippedDuplicates.length
    };
    // F10D — a fresh-write_id closeout retry may still need to SEAL: the rows were
    // appended by the earlier approval, but a seal failure there left the ledger
    // unbound. The seal is idempotent (already-stamped rows skip; a different
    // stamp fails closed), so attempting it here lets a retry HEAL an unsealed
    // closeout without ever re-appending a row.
    if (payload.closeout_context !== undefined) {
      const eventResult = await recordCloseoutEvent(session_id, workoutDate, payload.closeout_context);
      duplicateBody.session_plans_closeout = eventResult;
      try {
        const seal = await sealCloseout({ session_id }, normalizeWriteId(writeId), {});
        duplicateBody.ledger_seal = seal;
        duplicateBody.closeout_fully_verified = closeoutVerification(seal, payload.closeout_context, eventResult);
      } catch (error) {
        duplicateBody.ledger_seal = { sealed_ok: false, reason: 'seal_error', error: String((error && error.message) || error) };
        duplicateBody.closeout_fully_verified = false;
      }
    }
    if (idempotency.enabled) {
      duplicateBody.write_id = idempotency.write_id;
      duplicateBody.idempotency_status = 'completed';
      completeWrite(idempotency.write_id, idempotency.token, duplicateBody);
    }
    return standardSuccess(req, res, duplicateBody.message, duplicateBody, 200);
  }

  // Header-drift guard: confirm the target tabs still match the column contract
  // before any append. A mismatch releases the write_id (nothing was written)
  // and refuses the write rather than misroute values into the wrong columns.
  try {
    const headerFailures = await assertWriteHeaderContracts({
      checkLog: rowsToWrite.length > 0,
      checkEffort: Boolean(formattedEffortRow)
    });
    if (headerFailures.length > 0) {
      if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
      return standardError(req, res, schemaDriftMessage(headerFailures), schemaDriftDetails(headerFailures), 409);
    }
  } catch (error) {
    console.error('❌ Failed to validate sheet header contract:', error);
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, 'Failed to validate sheet header contract.', null, 500);
  }

  // The two appends are split so a failure between them cannot release the
  // idempotency record while rows are already on the sheet. Log append fails
  // → nothing was written, failWrite is safe, a retry starts clean. Effort
  // append fails AFTER the log append → the write_id is recorded as completed
  // with a partial result, so a retried write_id replays that honest partial
  // response instead of appending the log rows a second time.
  let logResponse = null;
  if (rowsToWrite.length > 0) {
    try {
      console.log(JSON.stringify({
        event: 'append_log_rows',
        tab: logSheetName,
        row_count: rowsToWrite.length,
        skipped_duplicates: skippedDuplicates.length,
        session_id,
        requestId: req.requestId
      }));
      logResponse = await appendRows(logSheetName, rowsToWrite);
      console.log(JSON.stringify({
        event: 'append_log_rows_success',
        tab: logSheetName,
        row_count: Number(logResponse.data.updates?.updatedRows || 0),
        range: logResponse.data.updates?.updatedRange,
        session_id,
        requestId: req.requestId
      }));
    } catch (error) {
      console.error('❌ Failed to append workout data:', error);
      if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
      return standardError(req, res, 'Failed to append workout data', process.env.NODE_ENV === 'production' ? null : error.message, 500);
    }
  }

  let effortResponse = null;
  if (formattedEffortRow) {
    try {
      console.log(JSON.stringify({
        event: 'append_effort_row',
        tab: effortSheetName,
        row_count: 1,
        session_id,
        requestId: req.requestId
      }));
      effortResponse = await appendRows(effortSheetName, [formattedEffortRow]);
      console.log(JSON.stringify({
        event: 'append_effort_row_success',
        tab: effortSheetName,
        row_count: Number(effortResponse.data.updates?.updatedRows || 0),
        range: effortResponse.data.updates?.updatedRange,
        session_id,
        requestId: req.requestId
      }));
    } catch (error) {
      console.error('❌ Effort append failed:', error);
      invalidateSheetRowsCache();
      const logRowsWritten = Number(logResponse?.data?.updates?.updatedRows || 0);
      const partialBody = {
        message: logRowsWritten > 0
          ? 'Log rows were appended but the effort row failed to write. Retrying this write_id will not append the log rows again — use undo-last or add the effort separately.'
          : 'Log rows were already present and the effort row failed to write. Retrying with a new write_id can try the Effort append again without duplicating log rows.',
        logAppendedRange: logResponse?.data?.updates?.updatedRange || null,
        log_rows_written: logRowsWritten,
        effort_rows_written: 0,
        effortWritten: false,
        test_mode: false,
        sheet_write: 'partial',
        sheet_written: true
      };
      if (idempotency.enabled) {
        partialBody.write_id = idempotency.write_id;
        partialBody.duplicate_write = false;
        partialBody.idempotency_status = 'completed';
        completeWrite(idempotency.write_id, idempotency.token, partialBody);
      }
      return standardError(req, res, 'Effort row append failed after log rows were written.', partialBody, 500);
    }
  }

  // F10D — seal the recommendation ledger under the SAME approved write_id (the
  // shared closeout_write_id). The Log/Effort appends above are already committed,
  // so a seal failure must NEVER fail the response, release the write_id, or claim
  // a fully verified closeout — it is reported honestly and a retry can heal it
  // (the seal is idempotent; the all-duplicate lane above re-attempts it).
  // Dry-run while the owner gate is closed: the store returns the no-write proof.
  let ledgerSeal = null;
  let sessionPlansCloseout = null;
  if (payload.closeout_context !== undefined) {
    // The finalized closeout EVENT records under this same approval (with the
    // capture layer's proof envelope), then the set-ledger SEAL binds the rows.
    sessionPlansCloseout = await recordCloseoutEvent(session_id, workoutDate, payload.closeout_context);
    try {
      ledgerSeal = await sealCloseout({ session_id }, idempotency.write_id || normalizeWriteId(writeId), {});
    } catch (error) {
      ledgerSeal = { sealed_ok: false, reason: 'seal_error', error: String((error && error.message) || error) };
    }
  }

  try {
    invalidateSheetRowsCache();

    const responseBody = {
      message: 'Workout data appended successfully.',
      logAppendedRange: logResponse?.data?.updates?.updatedRange || null,
      log_rows_written: Number(logResponse?.data?.updates?.updatedRows || 0),
      effort_rows_written: Number(effortResponse?.data?.updates?.updatedRows || 0),
      effortWritten: Boolean(formattedEffortRow),
      test_mode: false,
      sheet_write: 'success'
    };
    if (ledgerSeal) {
      responseBody.ledger_seal = ledgerSeal;
      if (sessionPlansCloseout) responseBody.session_plans_closeout = sessionPlansCloseout;
      responseBody.closeout_fully_verified = closeoutVerification(ledgerSeal, payload.closeout_context, sessionPlansCloseout);
    }
    if (skippedDuplicates.length > 0) {
      responseBody.skipped_duplicates = skippedDuplicates.length;
    }
    if (effortResponse) {
      responseBody.effortAppendedRange = effortResponse.data.updates?.updatedRange;
    }
    if (warnings.length > 0) {
      responseBody.warnings = [...new Set(warnings)];
    }
    if (ruleFlags.length > 0) {
      responseBody.rule_flags = ruleFlags;
    }

    if (idempotency.enabled) {
      responseBody.write_id = idempotency.write_id;
      responseBody.duplicate_write = false;
      responseBody.idempotency_status = 'completed';
      completeWrite(idempotency.write_id, idempotency.token, responseBody);
    }

    return standardSuccess(req, res, 'log-workout processed', responseBody, 200);
  } catch (error) {
    console.error('❌ Failed to finalize workout response after append:', error);
    // The log (and any effort) rows are already on the sheet by this point, so
    // releasing the idempotency record would let a retried write_id re-append.
    // Record the write as completed instead (never failWrite a committed write).
    if (idempotency.enabled) {
      completeWrite(idempotency.write_id, idempotency.token, {
        message: 'Workout data appended; response finalization failed.',
        log_rows_written: Number(logResponse?.data?.updates?.updatedRows || 0),
        effort_rows_written: Number(effortResponse?.data?.updates?.updatedRows || 0),
        effortWritten: Boolean(formattedEffortRow),
        test_mode: false,
        sheet_write: 'success',
        write_id: idempotency.write_id,
        duplicate_write: false,
        idempotency_status: 'completed'
      });
    }
    return standardError(req, res, 'Failed to append workout data', process.env.NODE_ENV === 'production' ? null : error.message, 500);
  }
});

// POST /api/log-workout/undo-last
// Deletes a specific row range from Log_Cleaned that was just appended by /api/log-workout.
// Requires the exact range string returned in the write response (log_appended_range),
// a matching session_id, and an explicit confirm_delete: true flag.
// Performs a read-back check before deleting to verify session_id ownership.
app.post('/api/log-workout/undo-last', async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return standardError(req, res, 'Invalid JSON payload.', null, 400);
  }

  const { log_appended_range, session_id, rows_to_delete, confirm_delete, write_id } = payload;

  if (confirm_delete !== true) {
    return standardError(req, res, 'confirm_delete must be true to proceed with deletion.', null, 400);
  }
  if (!log_appended_range || typeof log_appended_range !== 'string') {
    return standardError(req, res, 'log_appended_range is required.', null, 400);
  }
  if (!session_id || typeof session_id !== 'string') {
    return standardError(req, res, 'session_id is required.', null, 400);
  }

  // Parse A1 range: TabName!A{startRow}:{col}{endRow}
  const rangeMatch = log_appended_range.match(/^([^!]+)!A(\d+):[A-Z]+(\d+)$/);
  if (!rangeMatch) {
    return standardError(req, res, `log_appended_range is not a valid A1 range (expected e.g. Log_Cleaned!A847:L847), got "${log_appended_range}".`, null, 400);
  }

  const rangeTab = rangeMatch[1];
  const startRow = Number(rangeMatch[2]); // 1-indexed, inclusive
  const endRow = Number(rangeMatch[3]);   // 1-indexed, inclusive
  const rowSpan = endRow - startRow + 1;

  if (rangeTab !== logSheetName) {
    return standardError(req, res, `log_appended_range must target "${logSheetName}", got "${rangeTab}".`, null, 400);
  }
  // Undo the inverse of a single write: the range may span up to the same
  // MAX_LOG_ROWS a single /api/log-workout append can produce. A tighter cap here
  // silently broke undo for a full multi-set session closeout (>10 rows in one write).
  if (rowSpan < 1 || rowSpan > MAX_LOG_ROWS) {
    return standardError(req, res, `Row span must be between 1 and ${MAX_LOG_ROWS}, got ${rowSpan}.`, null, 400);
  }
  if (Number(rows_to_delete) !== rowSpan) {
    return standardError(req, res, `rows_to_delete (${rows_to_delete}) does not match range row span (${rowSpan}).`, null, 400);
  }

  const idempotency = beginWrite(write_id, {
    endpoint: '/api/log-workout/undo-last',
    session_id,
    log_appended_range,
    rows_to_delete: rowSpan
  });

  if (idempotency.duplicate) {
    const record = idempotency.record || {};
    const original = record.response || {};
    const duplicateBody = {
      duplicate_write: true,
      write_id: idempotency.write_id,
      idempotency_status: record.status || 'unknown',
      sheet_write: record.status === 'completed' ? 'skipped_duplicate' : 'skipped_duplicate_in_progress',
      sheet_written: false,
      rows_deleted: 0,
      original_deleted_range: original.deleted_range || null,
      original_rows_deleted: original.rows_deleted ?? null,
      original_completed_at: record.completed_at || null
    };
    const message = record.status === 'completed'
      ? 'Duplicate write_id; original undo was already processed.'
      : 'Duplicate write_id; original undo is already in progress.';
    return standardSuccess(req, res, message, duplicateBody, record.status === 'completed' ? 200 : 409);
  }

  // Read back rows before deleting to verify session_id ownership. This is a
  // safety read — it must reflect the live sheet, never a cached snapshot.
  let allRows;
  try {
    allRows = await getSheetRowsRaw(logSheetName);
  } catch (error) {
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, 'Failed to read sheet rows for verification.', null, 500);
  }

  const normalizedExpected = String(session_id).trim().toLowerCase();
  for (let r = startRow; r <= endRow; r++) {
    // allRows is 0-indexed with header excluded: sheet row 2 → allRows[0], row N → allRows[N-2]
    const dataIndex = r - 2;
    const row = allRows[dataIndex];
    if (!row || row.every(cell => String(cell) === '')) {
      if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
      return standardError(
        req, res,
        `Target sheet row ${r} is missing or empty — cannot verify session_id ownership. Undo aborted — no rows were deleted.`,
        null, 409
      );
    }
    const rowSessionId = String(row[1] || '').trim();
    if (rowSessionId.toLowerCase() !== normalizedExpected) {
      if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
      return standardError(
        req, res,
        `session_id mismatch at sheet row ${r}: expected "${session_id}", found "${rowSessionId}". Undo aborted — no rows were deleted.`,
        null, 409
      );
    }
  }

  // All rows verified — proceed with deletion
  try {
    const startIndex = startRow - 1; // 0-based inclusive
    const endIndex = endRow;         // 0-based exclusive
    await deleteRowsByRange(logSheetName, startIndex, endIndex);
    invalidateSheetRowsCache();
  } catch (error) {
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, 'Failed to delete rows from sheet.', null, 500);
  }

  const responseBody = {
    deleted_range: log_appended_range,
    rows_deleted: rowSpan,
    sheet_write: 'success',
    sheet_written: true
  };
  if (idempotency.enabled) {
    responseBody.write_id = idempotency.write_id;
    responseBody.duplicate_write = false;
    responseBody.idempotency_status = 'completed';
    completeWrite(idempotency.write_id, idempotency.token, responseBody);
  }

  return standardSuccess(req, res, 'Rows deleted', responseBody);
});

// GET /api/log-workout/verify-range
// Read-only post-write verification. Reads back the exact appended range from
// Log_Cleaned and confirms session_id ownership + row count.
// Only targets Log_Cleaned; rejects any other tab to prevent data fishing.
app.get('/api/log-workout/verify-range', async (req, res) => {
  const { range, session_id, expected_rows } = req.query;

  if (!range || typeof range !== 'string') {
    return standardError(req, res, 'range query param is required.', null, 400);
  }
  if (!session_id || typeof session_id !== 'string') {
    return standardError(req, res, 'session_id query param is required.', null, 400);
  }

  const rangeMatch = range.match(/^([^!]+)!A(\d+):[A-Z]+(\d+)$/);
  if (!rangeMatch) {
    return standardError(req, res, `range is not a valid A1 range (expected e.g. Log_Cleaned!A847:L847), got "${range}".`, null, 400);
  }

  const rangeTab = rangeMatch[1];
  const startRow = Number(rangeMatch[2]);
  const endRow = Number(rangeMatch[3]);
  const rowSpan = endRow - startRow + 1;

  if (rangeTab !== logSheetName) {
    return standardError(req, res, `range must target "${logSheetName}", got "${rangeTab}".`, null, 400);
  }
  // Verify the exact range a single write appended: it may span up to the same
  // MAX_LOG_ROWS that write accepts. A tighter cap here 400'd the post-write
  // read-back for any multi-set session logging >10 rows in one write.
  if (rowSpan < 1 || rowSpan > MAX_LOG_ROWS) {
    return standardError(req, res, `Row span must be between 1 and ${MAX_LOG_ROWS}, got ${rowSpan}.`, null, 400);
  }

  if (expected_rows !== undefined) {
    const expectedCount = Number(expected_rows);
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount !== rowSpan) {
      return standardError(req, res, `expected_rows (${expected_rows}) does not match range row span (${rowSpan}).`, null, 400);
    }
  }

  let rows;
  try {
    rows = await readRange(range);
  } catch (error) {
    console.error('❌ Readback verification — sheet read error:', error);
    return standardError(req, res, 'Readback verification failed: sheet read error.', null, 500);
  }

  if (rows.length === 0) {
    return standardError(req, res, `Readback found no rows at range "${range}".`, null, 409);
  }
  if (rows.length !== rowSpan) {
    return standardError(req, res, `Readback row count mismatch: expected ${rowSpan}, found ${rows.length}.`, null, 409);
  }

  const normalizedExpected = String(session_id).trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const rowSessionId = String(rows[i][1] || '').trim().toLowerCase();
    if (rowSessionId !== normalizedExpected) {
      return standardError(
        req, res,
        `session_id mismatch at row ${i + 1}: expected "${session_id}", found "${rows[i][1] || '(empty)'}".`,
        null, 409
      );
    }
  }

  return standardSuccess(req, res, 'Readback verified', {
    verified: true,
    rows_found: rows.length,
    range
  });
});

app.use((req, res) => {
  return standardError(req, res, 'Route not found', { path: req.originalUrl }, 404);
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return standardError(req, res, 'File too large. Max size is 10MB.', null, 413);
  }

  // An oversized multipart text field (e.g. log_rows_json past the 512 KB fieldSize
  // cap) must return a clean 4xx like the file-size path, not fall through to 500.
  if (err && err.code === 'LIMIT_FIELD_VALUE') {
    return standardError(req, res, 'Request field too large.', null, 413);
  }

  if (err && err.message && /^Only image\/(png|jpeg|jpg|webp)/.test(err.message)) {
    return standardError(req, res, err.message, null, 400);
  }

  // Body-parser failures are CLIENT errors, not server faults. express.json()
  // throws a SyntaxError (err.type 'entity.parse.failed', err.status 400) on
  // malformed JSON and 'entity.too.large' (413) past the size limit. Without
  // this they fell through to the 500 branch below — a misleading server-error
  // status for a bad request.
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400))) {
    return standardError(req, res, 'Malformed JSON body.', null, 400);
  }
  if (err && err.type === 'entity.too.large') {
    return standardError(req, res, 'Request body too large.', null, 413);
  }

  console.error('Unhandled error:', err);
  return standardError(
    req,
    res,
    process.env.NODE_ENV === 'production' ? 'Internal server error' : 'Unhandled error',
    process.env.NODE_ENV === 'production' ? undefined : err.message || err,
    500
  );
});

// public/ is gitignored Vite build output (PR-22), regenerated from src/app/ by
// an npm `prestart` hook -- but `prestart` only fires when this process is
// launched via `npm start`. If the host's start command bypasses npm's
// lifecycle (e.g. a platform Start Command of `node index.js`), that hook
// never runs. This is the last line of defense: build it here if it's
// missing, so express.static('public') below is never silently empty.
function ensurePublicBuilt() {
  const indexHtmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexHtmlPath)) return;
  console.log('[startup] public/ is missing -- running `npm run build` before serving...');
  execSync('npm run build', { cwd: __dirname, stdio: 'inherit' });
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error('public/index.html still missing after `npm run build` -- cannot serve the frontend.');
  }
}

function startServer() {
  ensurePublicBuilt();
  validateConfig();
  runStartupDiagnostics();

  const port = process.env.PORT || 3000;
  return app.listen(port, () => {
    console.log(`Atlas Workout Updater listening on port ${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
