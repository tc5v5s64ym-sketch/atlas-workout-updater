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
  getRecentRows,
  getSheetRows: getSheetRowsRaw,
  getHeaderRow,
  getSpreadsheetTabs,
  ensureSheetTab,
  logSheetName,
  effortSheetName
} = require('./sheets');
const {
  normalizeLogRow: normalizeAnalyticsLogRow,
  buildSessionSummary,
  computeExerciseProgress,
  computeMuscleGroupVolume,
  searchSessions,
  detectRecentPrs,
  recommendNextSet,
  buildBodyweightHistory,
  previewTestRows,
  detectStalls,
  suggestDeloads,
  computeFatigueStatus,
  buildWeeklyReport,
  buildProgressSummary,
  buildExerciseDetail,
  buildRecentSessions,
  buildMuscleGroupReadiness,
  scoreIntents,
  detectSwap
} = require('./services/analytics');
const { classifySubstitution } = require('./services/substitutionIntent');
const { inferPrescribedPairs } = require('./services/planMatcher');
const { assessLayoff } = require('./services/layoffGuard');
const { isConstraintMessage } = require('./services/constraintDetector');
const { recommendSubstitute } = require('./services/substitutionRecommender');
const { scoreSubstitutionQuality } = require('./services/substitutionQuality');
const { detectExtraWork } = require('./services/extraWorkDetector');
const { buildRecommendation, parseRecommendationConstraints } = require('./services/recommendationPipeline');
const { getProfileGoal } = require('./services/profileGoal');
const { normalizeTrainingGoal } = require('./services/trainingKnowledge');
const { computeBenchmark, resolveWorkingWeight } = require('./services/exerciseBenchmark');
const { detectTrend } = require('./services/trendDetector');
const { computeReadiness } = require('./services/readinessSignal');
const { enrichCoachFacts } = require('./services/liveIntelligence');
const { planStateFromContext, buildSessionCloseAnswer } = require('./services/sessionPlanExecutor');
const { buildSessionQuestionAnswer, buildSessionAdviceFallback, answerBareShorthand, isBareSessionShorthand, answerPlannedLiftQuestion, answerTotalRepsQuestion } = require('./services/sessionQuestionAnswer');
const { isTirednessExpression, buildTirednessRecoveryAnswer } = require('./services/recoveryRouting');
const { applyBarbellLoadabilityToExercises, applyBarbellLoadability } = require('./services/barbellLoadabilitySurface');
const {
  evaluateCurrentDeload,
  beginDeload,
  recordDeloadSession,
  resolvePostDeload
} = require('./services/deloadEngine');
const { readCurrentDeloadState } = require('./services/deloadState');
const { selectProtocol, roundLoad, computePrescription } = require('./services/deloadProtocols');
const {
  beginWrite,
  completeWrite,
  failWrite,
  normalizeWriteId
} = require('./services/idempotency');
const { normalizeDate, parseNumber, calculateQualityScore, qualityScoreBreakdown } = require('./services/validation');
const {
  createCorsMiddleware,
  createRateLimiter,
  createRequestContext,
  requireApiKey: requireApiKeyMiddleware
} = require('./middleware');
const { success: standardSuccess, error: standardError } = require('./response');
const { createTtlCache } = require('./services/cache');
const { parseWorkoutScreenshot } = require('./services/vision');
const coach = require('./services/coach');
const trainingSME = require('./services/trainingSME');
const coachPolish = require('./services/coachPolish');
const { normalizeExerciseKey, generateLiftCode, makeLiftCodeRegistry, buildExerciseCatalogMap, enrichLogRow, closestExerciseMatches } = require('./services/exerciseEnrichment');
const { normalizeDurationString } = require('./services/duration');
const { buildWorkoutTextParseDryRunResponse } = require('./services/workoutTextParser');
const { recognizeModalityInput } = require('./services/multiModalityParser');
const { toModalityLogRow } = require('./services/modalityLogRow');
const { resolveExercise } = require('./services/exerciseResolver');
const { analyzeSetSequence, assessNextMoveConflict } = require('./services/setEffortSignals');
const { effortNote: buildEffortNote, rerouteNote: buildRerouteNote } = require('./services/setEffortCopy');
const { renderSetVoice, findForbiddenContradictions, renderSubstitutionVoice, findSubstitutionContradictions } = require('./services/coachVoiceRenderer');
const { gradeStimulus } = require('./services/stimulusGovernor');
const { profileForGoal, modalityCategoryFor } = require('./services/trainingIntelligenceAdapter');
const { routeNextMove } = require('./services/fatigueRouter');
const { assessRecoveryDeload } = require('./services/recoveryDeloadSelection');
const { patternFor } = require('./services/movementPattern');
const { musclesFor } = require('./services/muscleCoverage');
const { BUG_REPORT_TAB, BUG_REPORT_COLUMNS, buildBugReportRow } = require('./services/bugReport');
const trainingStore = require('./services/trainingStore');
const { validateLogRowsBounds } = require('./rules/validationRules');
const { evaluateSessionSafety } = require('./rules/safetyRules');
const { holdUntilClean } = require('./rules/progressionRules');

async function runStartupDiagnostics() {
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
app.use('/api', requireApiKeyMiddleware(atlasApiKey, { publicPaths: [] }));
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
const { readBuildInfo } = require('./services/buildInfo');
// In-memory pending exercises collected from complete-workout responses
const pendingExercisesMemory = [];
// TODO(persistence-layer): replace in-memory pending exercises/cache with durable storage.
// TODO(db-migration): introduce real relational DB-backed write path with transactions.
// TODO(websocket-live-sync): stream ingestion/status updates to clients.
// TODO(gpt-integration-layer): separate model orchestration and prompt policy from HTTP layer.
// TODO(mobile-client): add API compatibility/versioning strategy for mobile app consumers.
const catalogCache = createTtlCache(60 * 1000);

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

const { routeDefinitions } = require('./config/routes');
const { logCleanedColumns, logRowFieldAliases, effortColumns, exerciseCatalogColumns, effortRowFieldAliases, modalityLogColumns } = require('./config/columns');
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



function buildExerciseCatalogEntries(rows) {
  if (!rows.length) return [];

  const header = rows[0].map(cell => String(cell || '').trim().toLowerCase());
  const exerciseIndex = header.findIndex(value => ['exercise', 'exercise_name', 'exercise name'].includes(value));
  const canonicalNameIndex = header.findIndex(value => ['canonical_name', 'canonical name', 'canonicalname', 'canonical_exercise', 'canonical exercise', 'canonicalexercise'].includes(value));
  const muscleGroupIndex = header.findIndex(value => ['muscle_group', 'muscle group', 'musclegroup'].includes(value));
  const liftCodeIndex = header.findIndex(value => ['lift code', 'lift_code', 'liftcode'].includes(value));
  const variantsIndex = header.findIndex(value => ['original_variants', 'original variants', 'originalvariant', 'original variant'].includes(value));

  if (canonicalNameIndex === -1 && exerciseIndex === -1) {
    throw new Error('Exercise_Catalog header must include Exercise or Canonical_Name.');
  }

  const entries = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const exerciseName = exerciseIndex === -1 ? '' : String(row[exerciseIndex] || '').trim();
    const canonicalName = String(row[canonicalNameIndex] || exerciseName).trim();
    if (!canonicalName) continue;

    const muscleGroup = String(row[muscleGroupIndex] || '').trim();
    const liftCode = String(row[liftCodeIndex] || '').trim();
    const variants = variantsIndex !== -1
      ? String(row[variantsIndex] || '')
          .split(/[,;|]/)
          .map(v => String(v).trim())
          .filter(Boolean)
      : [];

    entries.push({
      canonical_name: canonicalName,
      exercise: exerciseName || canonicalName,
      muscle_group: muscleGroup,
      lift_code: liftCode,
      variants
    });
  }

  return entries;
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

const { generateSessionId, nextAvailableSessionId } = require('./services/sessionId');

function isTestModeEnabled(value) {
  return String(value || '').toLowerCase() === 'true';
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

// GET /api/history/recent
app.get('/api/history/recent', async (req, res) => {

  const limit = Number(req.query.limit) || 5;
  const exerciseFilter = req.query.exercise ? String(req.query.exercise).toLowerCase() : null;

  try {
    const recentLog = await getRecentRows(logSheetName, Math.max(100, limit * 20));
    const recentEffort = await getRecentRows(effortSheetName, Math.max(limit, 20));

    let filteredLog = recentLog;
    if (exerciseFilter) {
      filteredLog = recentLog.filter(r => String(r[2] || '').toLowerCase() === exerciseFilter);
    }

    if (req.query.exclude_test === 'true') {
      filteredLog = filteredLog.filter(r => !/test/i.test(String(r[10] || '')));
    }
    const filteredEffort = req.query.exclude_test === 'true'
      ? recentEffort.filter(r => !/test/i.test(String(r[8] || '')))
      : recentEffort;

    const recent_sets = filteredLog.slice(-limit).map(row => ({
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

    const sessionMap = new Map();
    for (const row of [...recent_sets].reverse()) {
      if (!sessionMap.has(row.session_id)) {
        sessionMap.set(row.session_id, { session_id: row.session_id, date: row.date_clean });
      }
    }
    const recent_sessions = Array.from(sessionMap.values()).reverse().slice(-limit);
    // Like recent_sets above: the sheet appends downward, so the newest rows
    // are at the END of the window — take the tail, keep sheet order.
    const recent_effort = filteredEffort.slice(-limit).map(row => ({
      date: row[0],
      session_id: row[1],
      duration: row[2],
      active_calories: row[3],
      total_calories: row[4],
      average_hr: row[5],
      peak_hr: row[6],
      location: row[7],
      notes: row[8]
    }));

    return res.json({ status: 'ok', data: { recent_sessions, recent_sets, recent_effort } });
  } catch (error) {
    return standardError(req, res, 'Failed to fetch history', error.message, 500);
  }
});

// GET /api/exercises/last-session?exercise=Back+Squat
// Returns the sets from the most recent session that included this exercise.
// Used by the logger to show "last time" hints without a full reload.
app.get('/api/exercises/last-session', async (req, res) => {
  const exercise = String(req.query.exercise || '').trim();
  if (!exercise) return standardError(req, res, 'exercise query param required', null, 400);

  try {
    const allLog = await getSheetRows(logSheetName);
    const lowerExercise = exercise.toLowerCase();
    // Find all rows where exercise or canonical_exercise matches (substring)
    const matchingRows = allLog.filter(row => {
      const ex = String(row[2] || '').toLowerCase();
      const canonical = String(row[3] || '').toLowerCase();
      return ex.includes(lowerExercise) || canonical.includes(lowerExercise);
    });
    if (!matchingRows.length) {
      return standardSuccess(req, res, 'No prior sets for this exercise', { sets: [], session_id: null, date: null });
    }
    // Find the most recent session containing this exercise
    const sortedRows = matchingRows.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
    const lastSessionId = String(sortedRows[0][1] || '');
    const sessionRows = lastSessionId
      ? matchingRows.filter(row => String(row[1] || '') === lastSessionId)
      : [sortedRows[0]];
    const sets = sessionRows.map(row => ({
      set_number: String(row[6] || ''),
      weight: String(row[7] || ''),
      reps: String(row[8] || ''),
      rir: String(row[9] || ''),
      notes: String(row[10] || '')
    }));
    return standardSuccess(req, res, 'Last session sets', {
      exercise,
      session_id: lastSessionId,
      date: String(sortedRows[0][0] || ''),
      sets
    });
  } catch (error) {
    return standardError(req, res, 'Failed to fetch last session', error.message, 500);
  }
});

// GET /api/exercises/:liftCode
app.get('/api/exercises/:liftCode', async (req, res) => {

  const liftCode = String(req.params.liftCode || '').trim().toLowerCase();
  if (!liftCode) return standardError(req, res, 'liftCode is required in path', null, 400);

  try {
    const allLog = await getRecentRows(logSheetName, 1000);
    const matching = allLog.filter(row => String(row[5] || '').toLowerCase() === liftCode);

    const exerciseNames = [...new Set(matching.map(r => r[2]))];
    const totalSets = matching.length;
    const workingSets = matching.filter(r => Number(r[7]) > 0);
    const rowToSet = r => ({
      date_clean: r[0],
      session_id: r[1],
      exercise: r[2],
      canonical_exercise: r[3],
      muscle_group: r[4],
      lift_code: r[5],
      set_number: r[6],
      weight: r[7],
      reps: r[8],
      rir: r[9],
      notes: r[10]
    });

    const bestWeightRow = workingSets.reduce((best, r) => {
      const w = Number(r[7]);
      if (!Number.isFinite(w)) return best;
      if (!best || w > Number(best[7])) return r;
      return best;
    }, null);
    const bestVolumeRow = workingSets.reduce((best, r) => {
      const w = Number(r[7]);
      const reps = Number(r[8]);
      if (!Number.isFinite(w) || !Number.isFinite(reps)) return best;
      const volume = w * reps;
      const bestVolume = best ? Number(best[7]) * Number(best[8]) : -1;
      if (!best || volume > bestVolume) return r;
      return best;
    }, null);
    const estimated1RM = workingSets.reduce((max, r) => {
      const w = Number(r[7]);
      const reps = Number(r[8]);
      if (!Number.isFinite(w) || !Number.isFinite(reps)) return max;
      return Math.max(max, w * (1 + reps / 30));
    }, 0);

    const recentWorkingSets = matching.filter(r => Number(r[7]) > 0).slice(-10).map(rowToSet);

    return res.json({ status: 'ok', data: {
      liftCode: liftCode.toUpperCase(),
      exerciseNames,
      totalSets,
      bestWeightSet: bestWeightRow ? rowToSet(bestWeightRow) : null,
      bestVolumeSet: bestVolumeRow ? rowToSet(bestVolumeRow) : null,
      estimated1RM,
      recentWorkingSets
    } });
  } catch (error) {
    return standardError(req, res, 'Failed to fetch exercise detail', error.message, 500);
  }
});

app.get('/api/exercises/:liftCode/progress', async (req, res) => {

  const liftCode = String(req.params.liftCode || '').trim();
  if (!liftCode) {
    return standardError(req, res, 'liftCode is required in path', null, 400);
  }

  try {
    const allLog = await getSheetRows(logSheetName);
    const progress = computeExerciseProgress(allLog, liftCode);
    return standardSuccess(req, res, 'Exercise progress', progress);
  } catch (error) {
    return standardError(req, res, 'Failed to fetch exercise progress', error.message, 500);
  }
});

// GET /api/exercises/:liftCode/detail
// Combined single-call exercise detail: names, session count, last 5 sessions,
// best recent set (30-day window), volume trend, and current recommendation.
app.get('/api/exercises/:liftCode/detail', async (req, res) => {
  const liftCode = String(req.params.liftCode || '').trim();
  if (!liftCode) return standardError(req, res, 'liftCode is required in path', null, 400);
  try {
    const detail = await trainingStore.getExerciseDetail(liftCode, { rowLimit: 1000 });
    return standardSuccess(req, res, 'Exercise detail', detail);
  } catch (error) {
    return standardError(req, res, 'Failed to fetch exercise detail', error.message, 500);
  }
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

app.get('/api/volume/muscle-groups', async (req, res) => {

  const days = parseInt(req.query.days || '14', 10);
  if (Number.isNaN(days) || days <= 0) {
    return standardError(req, res, 'days must be a positive integer', null, 400);
  }

  try {
    const allLog = await getSheetRows(logSheetName);
    const groups = computeMuscleGroupVolume(allLog, days);
    return standardSuccess(req, res, 'Muscle group volume summary', { days, groups });
  } catch (error) {
    return standardError(req, res, 'Failed to fetch muscle group volume', error.message, 500);
  }
});

app.get('/api/search/sessions', async (req, res) => {

  const filters = {
    exercise: req.query.exercise,
    liftCode: req.query.liftCode,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    muscleGroup: req.query.muscleGroup
  };

  try {
    const allLog = await getSheetRows(logSheetName);
    const result = searchSessions(allLog, filters);
    return standardSuccess(req, res, 'Session search results', result);
  } catch (error) {
    return standardError(req, res, 'Failed to search sessions', error.message, 500);
  }
});

// GET /api/catalog/exercises
app.get('/api/catalog/exercises', async (req, res) => {

  try {
    const cached = catalogCache.get('catalog:rows');
    const rows = cached || await getExerciseCatalog();
    if (!cached) catalogCache.set('catalog:rows', rows);
    const exercises = buildExerciseCatalogEntries(rows);
    return standardSuccess(req, res, 'Exercise catalog entries', { exercises });
  } catch (error) {
    return standardError(req, res, 'Failed to read Exercise_Catalog', error.message, 500);
  }
});

// GET /api/catalog/search
app.get('/api/catalog/search', async (req, res) => {

  const query = String(req.query.q || '').trim();
  if (!query) {
    return standardError(req, res, 'Query param q is required', null, 400);
  }

  try {
    const cached = catalogCache.get('catalog:rows');
    const rows = cached || await getExerciseCatalog();
    if (!cached) catalogCache.set('catalog:rows', rows);
    const exercises = buildExerciseCatalogEntries(rows);
    const lowerQuery = query.toLowerCase();
    const results = exercises.filter(entry => {
      return entry.canonical_name.toLowerCase().includes(lowerQuery)
        || entry.lift_code.toLowerCase().includes(lowerQuery)
        || entry.variants.some(v => v.toLowerCase().includes(lowerQuery));
    });
    return standardSuccess(req, res, 'Catalog search results', { query, results });
  } catch (error) {
    return standardError(req, res, 'Failed to search Exercise_Catalog', error.message, 500);
  }
});

// GET /api/health/sheets
app.get('/api/health/sheets', async (req, res) => {

  try {
    const tabs = await getSpreadsheetTabs();
    const contractStatus = buildSheetContractStatus(tabs);
    const status = Object.entries(contractStatus.required).reduce((acc, [tab, exists]) => {
      acc[tab] = { exists };
      return acc;
    }, {});
    const optional = Object.entries(contractStatus.optional).reduce((acc, [tab, exists]) => {
      acc[tab] = { exists, required: false };
      return acc;
    }, {});
    return standardSuccess(req, res, 'Google Sheets health check', {
      tabs: status,
      optionalTabs: optional,
      availableTabs: tabs,
      missingRequiredTabs: contractStatus.missingRequiredTabs
    });
  } catch (error) {
    return standardError(req, res, 'Failed to verify Google Sheets tabs', error.message, 500);
  }
});

// GET /api/health/openai
app.get('/api/health/openai', (req, res) => {
  return standardSuccess(req, res, 'OpenAI health check', { configured: Boolean(process.env.OPENAI_API_KEY) });
});

// GET /api/health/gemini
app.get('/api/health/gemini', (req, res) => {
  return standardSuccess(req, res, 'Gemini health check', {
    configured: coach.isConfigured(),
    model: coach.coachModel()
  });
});

// POST /api/coach/message — turn deterministic facts into coach prose via
// Gemini. body.kind selects the voice: "set" (default) reacts to a logged set;
// "plan" explains why today's recommended session fits. READ-ONLY: this endpoint
// never touches Google Sheets. When Gemini is unconfigured or fails, it returns
// message:null so the client falls back to its templated copy — never blocked.
// Deterministic set-effort signals (Training Intelligence PR 477 wiring). Reads
// the client-provided set sequence + remaining planned queue and runs the pure
// engine (services/setEffortSignals.js) to produce short engine-backed copy: a
// per-set effort note and, when the next planned move shares a fatigued prime
// mover, a suggestion-only reroute line. Computed independent of Gemini so the
// copy survives an LLM outage; this route never writes, so proof fields /
// Log_Cleaned are untouched. The LLM never sees or words these here (that is
// PR 484) — this is the deterministic floor only.
// Resolve a planned-queue item to its exercise name (string or object), mirroring
// setEffortSignals' exerciseNameOf so the fatigue-router wiring reads the same shape.
function nextExerciseName(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') {
    return String(item.name || item.canonicalName || item.exercise || item.canonical_exercise || '').trim();
  }
  return '';
}

// Tiny adapter (PR 484/485): map the ALREADY-COMPUTED live verdicts (trend +
// readiness_signal) into the recovery/deload SELECTION engine's signal snapshot.
// Deliberately conservative — only confident verdicts become signals, and a single
// signal never converges (the engine needs a stack), so weak/ambiguous evidence
// stays silent. No new deload math; the engine owns the decision. `loads_feel_hard`
// is the milder readiness tier — a moderate warning that must STACK with a
// performance signal before recovery_reload, and it never trips the strong deload
// trigger (which needs subjective_fatigue/high_soreness).
function deriveRecoverySignals(rec, profile) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const trend = r.trend && typeof r.trend === 'object' ? r.trend : {};
  const readiness = r.readiness_signal && typeof r.readiness_signal === 'object' ? r.readiness_signal : {};
  const declining = trend.trend === 'declining' && (trend.confidence === 'high' || trend.confidence === 'medium');
  const likelyFatigue = readiness.signal === 'likely_fatigue' && (readiness.confidence === 'high' || readiness.confidence === 'medium');
  const possibleFatigue = readiness.signal === 'possible_fatigue';
  return {
    profile: profile || null,
    performance_decline: declining,
    subjective_fatigue: likelyFatigue,
    loads_feel_hard: possibleFatigue && !likelyFatigue,
  };
}

function computeSetEffortExtras(rawFacts) {
  // voiceBase is the deterministic Coach Voice Renderer output WITHOUT the prose
  // contradiction check (candidateProse is finalized per response path below). null
  // when there is no weighted/RIR signal to read.
  const out = { effort_note: null, reroute: null, voiceBase: null, set_grade: null, next_move_advisory: null, recovery_advisory: null };
  try {
    const todaySets = Array.isArray(rawFacts.todaySets) ? rawFacts.todaySets : [];
    // Only analyze the current weighted/RIR workflow: at least one set must carry
    // a finite weight or RIR. Empty/cardio-shaped input is left alone.
    const hasSignal = todaySets.some(s => s && (Number.isFinite(Number(s.weight)) || Number.isFinite(Number(s.rir))));
    if (!hasSignal) return out;
    const rec = rawFacts.rec && typeof rawFacts.rec === 'object' ? rawFacts.rec : {};
    const exerciseName = rawFacts.exerciseName || rec.exercise_name || '';
    const analysis = analyzeSetSequence(todaySets, {
      exerciseName,
      targetRir: rec.target_rir,
    });
    if (!analysis) return out;

    // Profile-aware Stimulus Governor grade (PR 484 wiring slice 2 — read-only fact).
    // Grades the hardest logged set by the user's PROFILE + the exercise MODALITY
    // (via the slice-1 adapter), so the same RIR reads differently for a strength vs
    // a general-fitness lifter. Additive only — it does NOT change the existing
    // `voiceBase`/message here; a later slice words it. Best-effort; engine-vocab out.
    try {
      const workRirs = todaySets.map(s => Number(s && s.rir)).filter(Number.isFinite);
      const grade = gradeStimulus({
        profile: profileForGoal(getProfileGoal()),
        modalityCategory: modalityCategoryFor(exerciseName),
        rir: workRirs.length ? Math.min(...workRirs) : null,
        target_rir: rec.target_rir,
        is_heavy_compound: !!analysis.is_compound,
      });
      if (grade) {
        out.set_grade = {
          profile: grade.rule.profile,
          effort_interpretation: grade.effort_interpretation,
          progression_verdict: grade.progression_verdict,
          fatigue_signal: grade.fatigue_signal,
        };
      }
    } catch (_) { /* grade is best-effort; never block the reaction */ }
    out.effort_note = buildEffortNote(analysis);
    // Reroute only when a remaining planned queue exists (engine also guards this).
    const queue = Array.isArray(rawFacts.planned_queue) ? rawFacts.planned_queue : [];
    let conflict = null;
    if (queue.length) {
      conflict = assessNextMoveConflict(analysis, queue);
      const line = buildRerouteNote(conflict);
      if (conflict && conflict.conflict && line) {
        out.reroute = {
          type: conflict.suggestion && conflict.suggestion.type,
          next_exercise: conflict.next_exercise,
          reason_codes: conflict.reason_codes,
          line,
        };
      }
    }
    // PR 484 fatigue-router voicing slice — generalize the next-move read beyond the
    // pressing-specific `reroute` above (PR 477). Feeds the slice-2 governor
    // `fatigue_signal` + the just-logged pattern/muscles + the planned next move
    // (pattern/muscles/modality) into the read-only fatigue router (PR 483) to surface
    // a cross-pattern / cross-modality next-move SUGGESTION the coach can word.
    // GATED so the two systems never contradict: only emitted when the pressing
    // reroute did NOT fire (out.reroute null) and the router returns a non-'keep'
    // action. Best-effort; engine vocab only; never auto-applies or writes.
    if (!out.reroute && queue.length && out.set_grade && out.set_grade.fatigue_signal) {
      const nextName = nextExerciseName(queue[0]);
      if (nextName) {
        const jm = analysis.muscles || {};
        const nMus = musclesFor(nextName) || {};
        // NOTE: the router's `block_pr` branch needs BOTH `repeated_rir0` and
        // `is_pr_attempt`, but there is no live PR-attempt signal at this set-reaction
        // call site yet — so that branch is inert here regardless. Both inputs are
        // omitted (the router treats them as falsy) rather than computing a dead
        // `repeated_rir0`; wiring real PR intent is a future slice (see BACKLOG).
        const advisory = routeNextMove({
          justLogged: {
            pattern: analysis.pattern || null,
            muscles: [...(jm.primary || []), ...(jm.secondary || [])],
            fatigue_signal: out.set_grade.fatigue_signal,
          },
          nextMove: {
            pattern: patternFor(nextName).pattern || null,
            muscles: [...(nMus.primary || []), ...(nMus.secondary || [])],
            modalityCategory: modalityCategoryFor(nextName),
          },
          // A heavy lower-body compound just logged gates the cardio-after-legs case.
          heavy_lower_block_done: !!analysis.is_compound && ['squat', 'hinge'].includes(analysis.pattern),
        });
        if (advisory && advisory.action && advisory.action !== 'keep') {
          out.next_move_advisory = {
            action: advisory.action,
            reason: advisory.reason || null,
            target: advisory.target || null,
            next_exercise: nextName,
            next_modality: modalityCategoryFor(nextName) || null,
          };
        }
      }
    }

    // PR 484 recovery/deload SELECTION voicing (engine: assessRecoveryDeload, PR 485).
    // CONSERVATIVE by construction: the tiny adapter derives signals only from
    // already-computed live verdicts, the convergence engine under-triggers (no
    // deload from one bad day), and we surface ONLY the recovery-oriented decisions
    // (deload / recovery_reload). Stay SILENT for normal / micro_adjustment (too
    // weak) and for taper / complete_rest (no live test-date / illness signal — never
    // fabricated), and when a deload is ALREADY active (the existing `deload` fact
    // owns that voice). Read-only context; the coach words it cautiously, no numbers.
    try {
      const deloadActive = rec.deload && rec.deload.in_deload === true;
      if (!deloadActive) {
        const sel = assessRecoveryDeload(deriveRecoverySignals(rec, profileForGoal(getProfileGoal())));
        if (sel && (sel.decision === 'deload' || sel.decision === 'recovery_reload')) {
          out.recovery_advisory = {
            decision: sel.decision,
            recovery_state: sel.recovery_state,
            converged_signals: sel.converged_signals,
            rationale: sel.rationale,
            deload_style: sel.deload_style,
          };
        }
      }
    } catch (_) { /* best-effort — a recovery read must never block the reaction */ }
    // Deterministic set-feedback voice (Coach Voice Renderer slice 1). The engine
    // decides the coaching MEANING; the prose contradiction check is applied per
    // response path in finalizeSetVoice (the candidate prose differs LLM-up vs
    // LLM-down). recVerdict comes from the recommendation engine's effort verdict.
    out.voiceBase = renderSetVoice({
      analysis,
      conflict,
      recVerdict: rec.effort_verdict || null,
      candidateProse: '',
    });
  } catch (_) {
    // Best-effort — a signal failure must never block the coach response.
  }
  return out;
}

// Finalize the deterministic voice against the candidate prose for THIS response
// path and decide whether the generic/LLM prose may speak. The engine wins: when a
// non-neutral fatigue/underdose signal is present, or the prose contradicts a
// reason code, the prose is suppressed (message → null) so it can never dilute or
// contradict the engine's read. Returns { message, voice } (voice null when there
// is no set-effort signal). Read-only — never writes.
function finalizeSetVoice(message, voiceBase) {
  if (!voiceBase) return { message, voice: null };
  const contradictions = findForbiddenContradictions(voiceBase.reason_codes, message);
  const suppress = voiceBase.suppress_generic_prose || contradictions.length > 0;
  return {
    message: suppress ? null : message,
    voice: { ...voiceBase, contradictions },
  };
}

// Finalize BOTH the set-effort voice and the substitution-pivot voice (Coach Voice
// Renderer slice 2) against the candidate prose for THIS response path. The
// deterministic engine wins: the LLM prose is suppressed (message → null) when a
// non-neutral set signal owns the reaction OR the prose contradicts a set reason
// code (finalizeSetVoice), OR the swap is a good pivot whose deterministic line
// owns the acknowledgement / the prose would lecture it. Returns
// { message, voice, sub_voice }. Read-only — never writes.
function finalizeCoachVoice(message, voiceBase, subVoiceBase) {
  const setFin = finalizeSetVoice(message, voiceBase);
  let outMessage = setFin.message;
  let sub_voice = null;
  if (subVoiceBase) {
    const goodPivot = subVoiceBase.severity === 'pivot';
    const contradictions = findSubstitutionContradictions(goodPivot, message);
    sub_voice = { ...subVoiceBase, contradictions };
    if (subVoiceBase.suppress_generic_prose || contradictions.length > 0) outMessage = null;
  }
  return { message: outMessage, voice: setFin.voice, sub_voice };
}

app.post('/api/coach/message', async (req, res) => {
  const rawFacts = req.body && req.body.facts;
  if (!rawFacts || typeof rawFacts !== 'object') {
    return standardError(req, res, 'facts object is required', null, 400);
  }
  const kind = req.body.kind === 'plan' ? 'plan' : 'set';
  // Engine-backed extras are deterministic and Gemini-independent — compute them
  // up front so they ride along on every response path below (incl. LLM-down).
  // voiceBase is the deterministic Coach Voice Renderer read; finalizeSetVoice
  // applies the prose contradiction check per path and rides `voice` along too.
  const computed = kind === 'set'
    ? computeSetEffortExtras(rawFacts)
    : { effort_note: null, reroute: null, voiceBase: null, set_grade: null, next_move_advisory: null, recovery_advisory: null };
  const effortExtras = { effort_note: computed.effort_note, reroute: computed.reroute, set_grade: computed.set_grade, next_move_advisory: computed.next_move_advisory, recovery_advisory: computed.recovery_advisory };
  const voiceBase = computed.voiceBase;
  // Substitution-pivot voice (slice 2). Read straight from the client-provided swap;
  // only the classification/quality/logged-name fields are consulted. Best-effort —
  // a bad shape just yields a neutral voice and changes nothing.
  const subVoiceBase = (rawFacts.substitution && typeof rawFacts.substitution === 'object')
    ? renderSubstitutionVoice({ substitution: rawFacts.substitution, candidateProse: '' })
    : null;
  if (!coach.isConfigured()) {
    const fin = finalizeCoachVoice(null, voiceBase, subVoiceBase);
    return standardSuccess(req, res, 'Coach voice unavailable — use templated fallback', {
      message: fin.message, voice: fin.voice, sub_voice: fin.sub_voice, configured: false, model: coach.coachModel(), ...effortExtras
    });
  }

  // Server-side intelligence enrichment: when a liftCode is present compute
  // working_weight, trend, readiness_signal, deviation, and evidence_context
  // from the lift's history. Failure is best-effort — never blocks the response.
  let facts = rawFacts;
  if (rawFacts.liftCode) {
    try {
      const allLog = await getSheetRows(logSheetName);
      facts = enrichCoachFacts(rawFacts, allLog);
    } catch (_) {
      // Keep client facts as-is if Sheets read or enrichment fails.
    }
  }

  // Plan voice: derive the return-after-layoff signal from the log server-side so
  // a "volume pulled back" claim can only come from the engine, never the client.
  // Always overwrite facts.layoff (engine value or null) so a client cannot inject
  // one; on a read failure it stays null and the coach simply won't mention it.
  // volume_reduced must reflect the *recommended* session the client narrates —
  // scoreIntents only caps the training intents (build_strength / build_muscle /
  // fix_blind_spots / balanced), so it is true only when the recommended intent
  // actually carries the returning_from_layoff cut.
  if (kind === 'plan') {
    let layoffFact = null;
    try {
      const [allLog, allEffort] = await Promise.all([
        getSheetRows(logSheetName),
        getSheetRows(effortSheetName),
      ]);
      const layoff = assessLayoff(allLog);
      if (layoff.returning_from_layoff) {
        const rec = scoreIntents(allLog, allEffort, { goal: getProfileGoal() });
        const top = rec.intents.find(i => i.recommended);
        const volume_reduced = !!(top && Array.isArray(top.reason_codes) &&
          top.reason_codes.includes('returning_from_layoff'));
        layoffFact = {
          severity: layoff.severity,
          days_since_last_session: layoff.days_since_last_session,
          volume_reduced,
        };
      }
    } catch (_) {
      // Best-effort — omit the layoff signal if the read fails.
    }
    facts = { ...facts, layoff: layoffFact };
  }

  // PR 484 slice 3: let the set-reaction coach WORD the profile-aware Stimulus
  // Governor grade (computed read-only in slice 2). The model only words this
  // engine verdict — sanitizeFacts bounds it to controlled enums and the prompt
  // forbids inventing numbers. ALWAYS overwrite (engine value or null) so a
  // client-supplied `stimulus_grade` can never reach the coach — engine-only.
  facts = { ...facts, stimulus_grade: kind === 'set' ? (computed.set_grade || null) : null };

  // PR 484 fatigue-router voicing: let the set-reaction coach WORD the cross-pattern
  // next-move SUGGESTION (computed read-only above, gated to not collide with the
  // pressing reroute). sanitizeFacts bounds the action to the router's vocabulary and
  // the prompt forbids inventing numbers / auto-applying. ALWAYS overwrite (engine
  // value or null) so a client-supplied advisory can never reach the coach.
  facts = { ...facts, next_move_advisory: kind === 'set' ? (computed.next_move_advisory || null) : null };

  // PR 484 recovery/deload voicing: let the set-reaction coach WORD the conservative
  // recovery SELECTION (computed read-only above; under-triggered + recovery-oriented
  // only). sanitizeFacts bounds the decision to the engine's recovery vocabulary and
  // the prompt forbids commanding a deload / inventing numbers. ALWAYS overwrite
  // (engine value or null) so a client-supplied advisory can never reach the coach.
  facts = { ...facts, recovery_advisory: kind === 'set' ? (computed.recovery_advisory || null) : null };

  try {
    const message = kind === 'plan'
      ? await coach.generatePlanMessage(facts)
      : await coach.generateCoachMessage(facts);
    // Deterministic engine controls the coaching meaning: suppress the LLM prose
    // when it contradicts (or would speak over) a non-neutral set-effort signal.
    const fin = finalizeCoachVoice(message, voiceBase, subVoiceBase);
    return standardSuccess(req, res, 'Coach message', { message: fin.message, voice: fin.voice, sub_voice: fin.sub_voice, configured: true, model: coach.coachModel(), source: 'gemini', kind, ...effortExtras });
  } catch (error) {
    // Degrade gracefully: tell the client to use its templated fallback rather
    // than surfacing an error in the chat.
    const fin = finalizeCoachVoice(null, voiceBase, subVoiceBase);
    return standardSuccess(req, res, 'Coach generation failed — use templated fallback', {
      message: fin.message, voice: fin.voice, sub_voice: fin.sub_voice, configured: true, model: coach.coachModel(), error: error.message, ...effortExtras
    });
  }
});

// Assemble a compact, read-only training snapshot for the chat coach from the
// deterministic engine — recent sessions, movement-pattern readiness, today's
// recommended focus, stalled lifts, and under-coverage gaps. Bounded here and
// bounded again in coach.sanitizeChatContext. The lifter's current preview rows
// (if any) ride along from the client so "is this set good?" can be answered.
function buildChatContext(logRows, effortRows, clientContext, coachingNotes, constraints) {
  const intents = scoreIntents(logRows, effortRows);
  const recent = buildRecentSessions(logRows, effortRows, { limit: 5 });
  const stalls = detectStalls(logRows);
  const read = intents.todays_read || {};
  const cc = clientContext && typeof clientContext === 'object' ? clientContext : {};
  const sessions = recent.sessions || [];

  // Lazily required to avoid a load-time cycle possibility; under-coverage is
  // a read-only data layer with no dependency on index.js.
  const { computeUnderCoverage } = require('./services/underCoverage');
  const muscle_gaps = computeUnderCoverage(logRows)
    .filter(r => r.status === 'under')
    .sort((a, b) => (a.currentEffectiveSets - a.targetRange.min) - (b.currentEffectiveSets - b.targetRange.min))
    .slice(0, 6)
    .map(r => ({ muscle: r.muscle, currentEffectiveSets: r.currentEffectiveSets, targetMin: r.targetRange.min }));

  // Coach memory: compute recurring patterns for any lift that shows one.
  // Empty-pattern results are filtered out, so context stays compact.
  const { detectPatterns } = require('./services/coachMemory');
  const { buildSubstitutionHistory } = require('./services/substitutionHistory');
  const substitutionHistory = buildSubstitutionHistory(logRows);
  const COL_LIFT_IDX = 5;
  const uniqueLifts = [...new Set((Array.isArray(logRows) ? logRows : []).map(r => r[COL_LIFT_IDX]).filter(Boolean))];
  const memory_patterns = uniqueLifts
    .map(liftCode => {
      const liftSubHistory = substitutionHistory.filter(e => String(e.liftCode).toUpperCase() === String(liftCode).toUpperCase());
      return { liftCode, ...detectPatterns(liftCode, logRows, { substitutionHistory: liftSubHistory }) };
    })
    .filter(item => item.patterns.length > 0)
    .slice(0, 5);

  // Session plan state: remaining = planned - completed. Only emitted when the
  // client explicitly sends plan_completed — if it's absent, plan_state stays
  // null so the coach isn't told "all exercises still outstanding" using stale
  // data. Frontend wiring (PR 358) is required before this becomes non-null.
  // The gate lives in planStateFromContext so the LLM-down session-close fallback
  // (Step 377) decides "is there an authoritative session state?" identically.
  const plan_state = planStateFromContext(cc);

  // Unprogrammed / extra-work signal for the LIVE session: prescribed = today's
  // plan (current_plan.sets = target sets), logged = the live preview grouped to
  // per-exercise set counts. Both are "now", so no stale-session mismatch. The
  // engine (detectExtraWork) decides; missing target_sets are never guessed.
  const previewRows = Array.isArray(cc.current_preview) ? cc.current_preview : [];
  const loggedCounts = new Map();
  for (const r of previewRows) {
    const name = r && (r.exercise || r.canonical_exercise || r.name);
    const clean = name ? String(name).trim() : '';
    if (!clean) continue;
    const key = clean.toLowerCase();
    loggedCounts.set(key, { exercise: clean, sets: (loggedCounts.get(key)?.sets || 0) + 1 });
  }
  const prescribedForExtra = (Array.isArray(cc.current_plan) ? cc.current_plan : [])
    .map(e => (e && typeof e === 'object'
      ? { exercise: String(e.name || e.exercise || '').trim(), target_sets: typeof e.sets === 'number' ? e.sets : undefined }
      : { exercise: String(e || '').trim() }))
    .filter(e => e.exercise);
  // Gate on a real prescribed plan: with no plan there is nothing to exceed, so
  // detectExtraWork([], logged) would wrongly flag every logged lift as an
  // "extra_exercise". No plan → no-extra shape (sanitizeChatContext → null).
  const extra_work = prescribedForExtra.length > 0
    ? detectExtraWork(prescribedForExtra, [...loggedCounts.values()])
    : { extra_sets: [], extra_exercises: [], has_extra: false };

  return {
    recommended_label: read.recommended_label || null,
    recommended_focus: read.recommended_reason || null,
    readiness: (read.patterns || []).map(p => ({ pattern: p.label || p.pattern, status: p.status, detail: p.detail })),
    recent_sessions: sessions.map(s => ({
      date: s.date, exercises: s.exercises, sets: s.sets_count, volume: s.total_volume,
      lift_sets: s.lift_sets || {}
    })),
    stalls: stalls.map(s => ({ exercise: s.exercise || s.liftCode, weight: s.last_best_weight, sessions_stalled: s.sessions_stalled })),
    muscle_gaps,
    memory_patterns,
    plan_state,
    current_preview: Array.isArray(cc.current_preview) ? cc.current_preview : [],
    current_plan: Array.isArray(cc.current_plan) ? cc.current_plan : [],
    extra_work,
    session_count: sessions.length,
    coaching_notes: Array.isArray(coachingNotes) ? coachingNotes.slice(0, 10) : [],
    constraints: Array.isArray(constraints) ? constraints.slice(0, 12) : []
  };
}

// POST /api/coach/chat — free-form, two-way coaching chat. READ-ONLY: it reads
// recent training to ground the reply and never writes to Google Sheets. Body:
// { message: string, history?: [{role,text}], context?: { current_preview } }.
// When Gemini is unconfigured or fails, returns message:null so the client shows
// a deterministic fallback — the chat is never blocked by an LLM outage.
// True when the chat client context carries an active session (a previewed lift or a
// planned lift). Used to gate the engine-fill Sheets read so it only happens during a
// real session, never on a bare-shorthand message typed with no active workout.
function hasActiveSessionContext(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  return (Array.isArray(c.current_preview) && c.current_preview.length > 0)
    || (Array.isArray(c.current_plan) && c.current_plan.length > 0);
}

// Engine target for a lift name, used by the LLM-down chat fallback. Resolves the
// lift code from the name and reads the same recommendNextSet the "Next" card uses,
// so a deterministic answer reports the exact numbers the engine already owns.
function recommendTargetForLift(liftName, logRows) {
  const code = generateLiftCode(liftName);
  if (!code) return null;
  const rec = recommendNextSet(Array.isArray(logRows) ? logRows : [], code);
  if (!rec || !rec.next_target) return null;
  return {
    exercise_name: rec.exercise_name || liftName,
    weight: rec.next_target.weight ?? null,
    reps: rec.next_target.reps ?? null,
    sets: rec.next_target.sets ?? null,
    rir: rec.target_rir ?? null,
    reasoning: rec.reasoning || null
  };
}

// Gemini timeout for the interactive coach chat. Higher than coach.js's 8s default
// because the chat client waits 15s (CHAT_REPLY_TIMEOUT_MS) — a slow-but-successful
// reply should land rather than be aborted early and dead-end on "Coach unavailable".
const COACH_CHAT_TIMEOUT_MS = 12000;

// GET /api/coach/health — READ-ONLY coach LLM connectivity probe. No Sheets, no
// writes. Surfaces WHY coaching degrades to deterministic templates: returns
// { configured, model, ok, reason } so the owner can distinguish a missing key,
// bad model id (404), bad key (401/403), quota (429), or timeout — instead of the
// silent "Coach is unavailable" fallback.
app.get('/api/coach/health', async (req, res) => {
  const configured = coach.isConfigured();
  const model = coach.coachModel();
  if (!configured) {
    return standardSuccess(req, res, 'coach health', { configured: false, model, ok: false, reason: 'GEMINI_API_KEY not set' });
  }
  try {
    await coach.pingGemini();
    return standardSuccess(req, res, 'coach health', { configured: true, model, ok: true, reason: null });
  } catch (error) {
    return standardSuccess(req, res, 'coach health', { configured: true, model, ok: false, reason: error.message });
  }
});

app.post('/api/coach/chat', async (req, res) => {
  const message = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    return standardError(req, res, 'message string is required', null, 400);
  }
  const clientCtx = req.body && req.body.context;
  const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];

  // P0 follow-up (2026-06-21): BARE in-session shorthand ("RIR?", "Reps?",
  // "How much?", "How many sets?") is answered deterministically from the CURRENT
  // lift — whether or not Gemini is up — so the lifter gets the current-lift fact,
  // not generic education. Ambiguous current lift → ask which one. No active lift
  // context → returns null so the normal flow (SME education) still applies.
  // Context-only (no Sheets/LLM): the live plan/preview already carries the target.
  let bare = answerBareShorthand(message, clientCtx);
  // Preview-of-unplanned-lift parity (#452 follow-up): when the current lift is in an
  // active PREVIEW that isn't in current_plan, the preview row carries sets:null, so
  // the context-only attempt above can't answer a bare "how many sets?" and would drop
  // to the LLM. Engine-fill via recommendNextSet — the SAME resolveTarget the named-lift
  // fallback (deterministicAnswer) uses — so the lifter gets the deterministic target,
  // not an LLM guess. Gated to bare shorthand during an active session that the context
  // couldn't answer, so the Sheets read is rare (not on every chat message).
  if (!bare && isBareSessionShorthand(message) && hasActiveSessionContext(clientCtx)) {
    const bareLog = await getSheetRows(logSheetName).catch(() => []);
    bare = answerBareShorthand(message, clientCtx, (liftName) => recommendTargetForLift(liftName, bareLog));
  }
  if (bare) {
    return standardSuccess(req, res, bare.kind === 'clarify'
      ? 'Coach chat — clarify which lift'
      : 'Coach chat — deterministic engine answer', {
      message: bare.text, configured: coach.isConfigured(), model: coach.coachModel(), source: 'engine'
    });
  }

  // Plan-first answer (2026-06-21): when the lifter NAMES a lift that is in today's
  // plan/preview and asks its prescribed value ("what's the RIR for bench?", "how
  // many reps for bench?"), answer from the CURRENT PLAN — before Gemini, which
  // would otherwise narrate from history. The current plan beats history and
  // generic education for "today's" prescription. Deferred (null) for past-tense
  // ("...last time?"), unnamed-lift ("what is RIR?"), or off-plan lifts, so
  // education / history / clarification routing is untouched. Context-only: no
  // Sheets, no LLM, no invented numbers.
  // "Total?" (reps total) — answer the ENGINE-computed planned total (sets × reps),
  // worded as planned, before Gemini. Otherwise the LLM multiplies the numbers
  // itself and mis-tenses the result as completed work ("you've done 45 reps" for
  // a lift not yet logged). Resolves the lift from the recent turns, so a bare
  // "total?" follow-up works. Context-only: no Sheets, no LLM, no invented numbers.
  const totalReps = answerTotalRepsQuestion(message, { history, clientContext: clientCtx });
  if (totalReps) {
    return standardSuccess(req, res, 'Coach chat — planned total answer', {
      message: totalReps, configured: coach.isConfigured(), model: coach.coachModel(), source: 'engine'
    });
  }

  const planned = answerPlannedLiftQuestion(message, clientCtx);
  if (planned) {
    return standardSuccess(req, res, 'Coach chat — current plan answer', {
      message: planned, configured: coach.isConfigured(), model: coach.coachModel(), source: 'engine'
    });
  }

  // Slice 3 — recovery routing: when the lifter SAYS they're tired/cooked/drained,
  // the deterministic engine owns the reply and routes on the actual recovery state,
  // so the LLM never defaults to motivation hype. Grounded below (configured path)
  // from computeFatigueStatus + readiness + days-since; here it only flags the intent.
  const tired = isTirednessExpression(message);

  // Deterministic, LLM-free answer used whenever the Gemini coach is unavailable
  // (unconfigured / errored / timed out / empty) so the lifter is never dead-ended.
  // Step 377: a session-close question ("are we done?") answers from plan_state.
  // P0 follow-up (2026-06): in-session shorthand ("RIR?", "reps?", "how much")
  // answers from the engine's recommendation for the lift in question, so an LLM
  // outage no longer turns workout-state questions into "Coach is unavailable".
  // logRowsForTarget supplies recommendNextSet history; [] when Sheets weren't read.
  const deterministicAnswer = (logRowsForTarget) => {
    const close = buildSessionCloseAnswer(message, planStateFromContext(clientCtx));
    if (close) return close;
    const valueAnswer = buildSessionQuestionAnswer(message, {
      history,
      clientContext: clientCtx,
      resolveTarget: (liftName) => recommendTargetForLift(liftName, logRowsForTarget)
    });
    if (valueAnswer) return valueAnswer;
    return buildSessionAdviceFallback(message, {
      history,
      clientContext: clientCtx,
      resolveTarget: (liftName) => recommendTargetForLift(liftName, logRowsForTarget)
    });
  };

  if (!coach.isConfigured()) {
    // No Sheets read on the unconfigured path — answer from client context only.
    // A tired lifter still gets recovery routing (no engine signals available here,
    // so the safe no-numbers recovery line), never a dead-end or hype.
    const answer = tired
      ? buildTirednessRecoveryAnswer({ readiness: Array.isArray(clientCtx && clientCtx.readiness) ? clientCtx.readiness : null })
      : deterministicAnswer([]);
    return standardSuccess(req, res, answer
      ? 'Coach chat unavailable — deterministic engine answer'
      : 'Coach chat unavailable — Gemini not configured', {
      message: answer, configured: false, model: coach.coachModel(),
      ...(answer ? { source: 'engine' } : {})
    });
  }

  let allLog = [];
  let chatError = null;
  try {
    const [logR, allEffort, notesRows, constraintRows] = await Promise.all([
      getSheetRows(logSheetName),
      getSheetRows(effortSheetName),
      getSheetRows('Coaching_Notes').catch(() => []),
      getSheetRows('Constraints').catch(() => [])
    ]);
    allLog = logR;
    const coachingNotes = notesRows
      .map(row => Array.isArray(row) ? { date: row[0] || null, note: row[1] || null } : { date: row.date || null, note: row.note || null })
      .filter(n => n.note);
    const constraints = constraintRows
      .map(row => Array.isArray(row)
        ? { date: row[0] || null, kind: row[1] || null, target: row[2] || null, rule: row[3] || null, note: row[4] || null }
        : { date: row.date || null, kind: row.kind || null, target: row.target || null, rule: row.rule || null, note: row.note || null })
      .filter(c => c.kind && c.target && c.rule);
    const context = buildChatContext(allLog, allEffort, clientCtx, coachingNotes, constraints);
    // Slice 3 — recovery routing owns a tired lifter's reply, grounded in the real
    // recovery state (weekly-load fatigue, days since last session, fatigued
    // patterns). Deterministic + read-only; the LLM is bypassed so it can't hype.
    if (tired) {
      const recoveryReply = buildTirednessRecoveryAnswer({
        fatigueStatus: computeFatigueStatus(allLog),
        readiness: context.readiness,
        daysSinceLastSession: assessLayoff(allLog).days_since_last_session,
      });
      return standardSuccess(req, res, 'Coach chat — recovery routing', {
        message: recoveryReply, configured: true, model: coach.coachModel(), source: 'engine'
      });
    }
    // Chat is interactive and the client waits 15s (CHAT_REPLY_TIMEOUT_MS), so give
    // Gemini more than the 8s default before aborting — a merely-SLOW (not-down)
    // response then lands instead of being killed early and dead-ending the lifter
    // on "Coach is unavailable." Stays under the client budget with network margin.
    const { reply, propose_edit, propose_note, propose_constraint, propose_plan_edit } =
      await coach.generateChatReply({ message, context, history }, { timeoutMs: COACH_CHAT_TIMEOUT_MS });
    const hasReply = Boolean(reply && String(reply).trim());
    // Return the Gemini result when it has usable prose OR carries a structured
    // proposal (edit/note/constraint) — a proposal must never be dropped just
    // because the prose came back empty. Only a truly empty result (no prose, no
    // proposal) falls through to the deterministic engine fallback below.
    if (hasReply || propose_edit || propose_note || propose_constraint || propose_plan_edit) {
      return standardSuccess(req, res, 'Coach chat reply', {
        message: hasReply ? reply : null, propose_edit: propose_edit || null, propose_note: propose_note || null, propose_constraint: propose_constraint || null, propose_plan_edit: propose_plan_edit || null, configured: true, model: coach.coachModel(), source: 'gemini'
      });
    }
    // Empty reply and no proposal → fall through to the deterministic fallback below.
  } catch (error) {
    // Degrade gracefully — never an error bubble. Fall through to the deterministic
    // fallback. allLog may be populated (throw came from Gemini after the read) or
    // empty (the Sheets read itself failed); the fallback handles both.
    chatError = error.message;
  }
  const answer = deterministicAnswer(allLog);
  return standardSuccess(req, res, answer
    ? 'Coach chat — deterministic engine answer'
    : 'Coach chat failed — use fallback', {
    message: answer, configured: true, model: coach.coachModel(),
    ...(answer ? { source: 'engine' } : (chatError ? { error: chatError } : {}))
  });
});

// POST /api/coach/ask — on-demand training SME answer. Deterministic and LLM-FREE:
// routes a training question to structured knowledge cards. READ-ONLY (no Sheets, no
// writes). Logging-shaped input returns depth "log_only" with answer:null so the chat
// stays quiet and practical during logging. Body: { message: string }.
app.post('/api/coach/ask', async (req, res) => {
  const message = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    return standardError(req, res, 'message string is required', null, 400);
  }
  const result = trainingSME.buildTrainingSMEAnswer({ question: message });
  // Optional Gemini polish: natural wording, numbers locked. Degrades to the deterministic
  // card-grounded answer when Gemini is unconfigured, slow, or drifts a number.
  let answer = result.answer;
  if (answer) {
    try { answer = await coachPolish.polishSmeAnswer(answer); } catch { answer = result.answer; }
  }
  return standardSuccess(req, res, 'Training SME answer', {
    depth: result.depth,
    answer,
    cards: result.cards,
    confidenceLevel: result.confidenceLevel,
    source: 'training_sme'
  });
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
  const { message, current_exercise: currentExercise } = req.body || {};
  if (!message || !currentExercise) {
    return standardSuccess(req, res, 'No recommendation', { recommendation: null });
  }
  if (!isConstraintMessage(message)) {
    return standardSuccess(req, res, 'Not a constraint message', { recommendation: null });
  }
  const rec = recommendSubstitute(currentExercise);
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

  const dateStr = new Date().toISOString().slice(0, 10);
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

  const dateStr = new Date().toISOString().slice(0, 10);
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

// GET /api/debug/config
app.get('/api/debug/config', (req, res) => {
  return standardSuccess(req, res, 'Safe debug configuration', {
    serviceName: 'atlas-workout-updater',
    environment: process.env.NODE_ENV || 'development',
    sheetTabs: {
      logSheetName,
      effortSheetName
    },
    apiKeyAuthEnabled: Boolean(process.env.ATLAS_API_KEY),
    openAiKeyConfigured: Boolean(process.env.OPENAI_API_KEY)
  });
});

// POST /api/bug-report — dev-only state capture sink. The browser builds the
// diagnostic payload; the server redacts it again before appending so secrets do
// not land in the sheet even if a client accidentally includes them.
app.post('/api/bug-report', async (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const row = buildBugReportRow(payload);
    await ensureSheetTab(BUG_REPORT_TAB, BUG_REPORT_COLUMNS);
    await appendRows(BUG_REPORT_TAB, [row]);
    return standardSuccess(req, res, 'Bug report saved', {
      bug_id: row[1],
      tab: BUG_REPORT_TAB
    }, 201);
  } catch (error) {
    return standardError(req, res, 'Failed to save bug report', error.message, 500);
  }
});

// GET /api/schema/log
app.get('/api/schema/log', (req, res) => {
  return standardSuccess(req, res, 'Log_Cleaned schema', {
    schema: ['Date_Clean', 'Session ID', 'Exercise', 'Canonical_Exercise', 'Muscle_Group', 'Lift Code', 'Set #', 'Weight', 'Reps', 'RIR', 'Notes', 'Volume_Calc']
  });
});

// GET /api/schema/effort
app.get('/api/schema/effort', (req, res) => {
  return standardSuccess(req, res, 'Effort schema', {
    schema: ['Date', 'Session ID', 'Duration', 'Active Calories', 'Total Calories', 'Average HR', 'Peak HR', 'Location', 'Notes']
  });
});

// GET /api/schema/complete-workout
app.get('/api/schema/complete-workout', (req, res) => {
  return standardSuccess(req, res, 'Complete-workout multipart schema', {
    required: ['log_rows_json'],
    required_for_screenshot_flow: ['image'],
    required_for_effort_only_flow: ['image or manual effort fields'],
    optional: ['session_id', 'date', 'location', 'notes', 'test_mode', 'effort_json']
  });
});

// GET /api/sessions/recent — list recent sessions with aggregated data (MUST be before /:sessionId)
app.get('/api/sessions/recent', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 15));
  try {
    const result = await trainingStore.getRecentSessions({ limit });
    return standardSuccess(req, res, 'Recent sessions', result);
  } catch (err) {
    return standardError(req, res, 'Failed to load recent sessions', err);
  }
});

// GET /api/sessions/:sessionId — fetch all log rows for a session (for correction pre-fill)
app.get('/api/sessions/:sessionId', async (req, res) => {

  const sessionId = String(req.params.sessionId || '').trim();
  if (!sessionId) return standardError(req, res, 'sessionId is required', null, 400);

  try {
    const allLog = await getSheetRows(logSheetName);
    const sessionRows = allLog.filter(row => String(row[1] || '').trim() === sessionId);
    if (!sessionRows.length) {
      return standardError(req, res, `No rows found for session "${sessionId}"`, null, 404);
    }
    const rows = sessionRows.map(row => ({
      date_clean: String(row[0] || ''),
      session_id: String(row[1] || ''),
      exercise: String(row[2] || ''),
      canonical_exercise: String(row[3] || ''),
      muscle_group: String(row[4] || ''),
      lift_code: String(row[5] || ''),
      set_number: String(row[6] || ''),
      weight: String(row[7] || ''),
      reps: String(row[8] || ''),
      rir: String(row[9] || ''),
      notes: String(row[10] || '')
    }));
    return standardSuccess(req, res, 'Session rows', {
      session_id: sessionId,
      date: rows[0]?.date_clean || '',
      set_count: rows.length,
      rows
    });
  } catch (error) {
    return standardError(req, res, 'Failed to fetch session', error.message, 500);
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
    const upperOnly = req.query.upperOnly === 'true' || req.query.scope === 'upper';
    const result = scoreIntents(allLog, allEffort, {
      goal: req.query.goal ? normalizeTrainingGoal(req.query.goal) : getProfileGoal(),
      ...(upperOnly && { upperOnly }),
    });
    // P0 AC12: snap each intent's BARBELL target weights to loadable plate totals
    // (45 lb bar, 5 lb jumps) + attach a short note, gated on barbell equipment
    // classification. Read-only — this is the recommendation/composer surface, not
    // the write path; the lifter still logs what they actually do.
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

  try {
    const allLog = await getSheetRows(logSheetName);
    const recommendation = recommendNextSet(allLog, liftCode, {
      ...(justLoggedSet ? { justLoggedSet } : {})
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
    return standardSuccess(req, res, 'Recommendation generated', recommendation);
  } catch (error) {
    return standardError(req, res, 'Failed to compute recommendation', error.message, 500);
  }
});

// GET /api/summary/weekly
app.get('/api/summary/weekly', async (req, res) => {

  try {
    const recentLog = await getRecentRows(logSheetName, 1000);
    const recentEffort = await getRecentRows(effortSheetName, 1000);
    const today = new Date();
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 6);
    const isoSevenDaysAgo = sevenDaysAgo.toISOString().slice(0, 10);

    const sessions = new Map();
    let totalSets = 0;
    let totalVolume = 0;
    const muscleGroupBreakdown = {};

    const logRows = recentLog
      .filter(row => {
        const date = String(row[0] || '');
        return date >= isoSevenDaysAgo;
      })
      .filter(row => Number(row[7]) > 0);

    logRows.forEach(row => {
      totalSets += 1;
      const weight = Number(row[7]);
      const reps = Number(row[8]);
      const volume = Number.isFinite(weight) && Number.isFinite(reps) ? weight * reps : 0;
      totalVolume += volume;
      const muscleGroup = String(row[4] || 'Unknown');
      muscleGroupBreakdown[muscleGroup] = (muscleGroupBreakdown[muscleGroup] || 0) + volume;

      const sessionId = String(row[1] || '').trim();
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { session_id: sessionId, date: row[0], sets: 0, volume: 0 });
      }
      const session = sessions.get(sessionId);
      session.sets += 1;
      session.volume += volume;
    });

    const effortSummary = recentEffort
      .filter(row => {
        const date = String(row[0] || '');
        return date >= isoSevenDaysAgo;
      })
      .map(row => ({
        date: row[0],
        session_id: row[1],
        duration: row[2],
        active_calories: row[3],
        total_calories: row[4],
        average_hr: row[5],
        peak_hr: row[6],
        location: row[7],
        notes: row[8]
      }));

    const highlights = [];
    if (totalSets > 0) {
      highlights.push(`Completed ${totalSets} working sets across ${sessions.size} sessions.`);
    }
    if (totalVolume > 0) {
      highlights.push(`Accumulated ${Math.round(totalVolume)} total volume this week.`);
    }
    const topMuscleGroup = Object.entries(muscleGroupBreakdown).sort((a, b) => b[1] - a[1])[0];
    if (topMuscleGroup) {
      highlights.push(`Top muscle group: ${topMuscleGroup[0]} with ${Math.round(topMuscleGroup[1])} volume.`);
    }

    return standardSuccess(req, res, 'Weekly summary', {
      sessions: Array.from(sessions.values()),
      totalSets,
      totalVolume,
      muscleGroupBreakdown,
      effortSummary,
      highlights
    });
  } catch (error) {
    return standardError(req, res, 'Failed to build weekly summary', error.message, 500);
  }
});

// GET /api/progress/summary
app.get('/api/progress/summary', async (req, res) => {
  try {
    const summary = await trainingStore.getProgressSummary();
    return standardSuccess(req, res, 'Progress summary', summary);
  } catch (error) {
    return standardError(req, res, 'Failed to build progress summary', error.message, 500);
  }
});

// GET /api/report/weekly
// Returns a structured weekly training report using existing log data.
// Uses the prior period of equal length for PR/improvement comparisons.
// Optional ?days=N overrides the default 7-day lookback (range: 3–14).
app.get('/api/report/weekly', async (req, res) => {
  const rawDays = parseInt(req.query.days || '7', 10);
  if (Number.isNaN(rawDays) || rawDays < 3 || rawDays > 14) {
    return standardError(req, res, 'days must be an integer between 3 and 14', null, 400);
  }
  try {
    const report = await trainingStore.getWeeklyReportData({ days: rawDays, rowLimit: 1000 });
    return standardSuccess(req, res, 'Weekly report', report);
  } catch (error) {
    return standardError(req, res, 'Failed to build weekly report', error.message, 500);
  }
});

// GET /api/prs/recent
app.get('/api/prs/recent', async (req, res) => {

  try {
    const allLog = await getSheetRows(logSheetName);
    const prs = detectRecentPrs(allLog);
    return standardSuccess(req, res, 'Recent PRs', { prs });
  } catch (error) {
    return standardError(req, res, 'Failed to fetch recent PRs', error.message, 500);
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

// GET /api/coaching/insights
app.get('/api/coaching/insights', async (req, res) => {
  try {
    const allLog = await getSheetRows(logSheetName);
    const stalls = detectStalls(allLog, 3);
    const deloadSuggestions = suggestDeloads(allLog, 4);
    const fatigue = computeFatigueStatus(allLog);
    return standardSuccess(req, res, 'Coaching insights', {
      fatigue,
      stalls,
      deload_suggestions: deloadSuggestions
    });
  } catch (error) {
    return standardError(req, res, 'Failed to compute coaching insights', error.message, 500);
  }
});

// ---- Deload lifecycle (engine-driven, system-state) -------------------------
// These read/write the Deload_State tab via the deload engine. They are NOT
// logged sets: append-only system state, outside the preview→approve→write trust
// loop, no write_id (see CLAUDE.md "Deload_State tab"). Illegal lifecycle moves
// (begin while already deloading, advance when not deloading, resolve outside
// post-evaluation) are rejected by the state machine and surface as 409.

// GET /api/deload/status — the lifter's current training state.
app.get('/api/deload/status', async (req, res) => {
  try {
    const state = await readCurrentDeloadState();
    return standardSuccess(req, res, 'Deload status', { state });
  } catch (error) {
    return standardError(req, res, 'Failed to read deload status', error.message, 500);
  }
});

// A deload lifecycle error is a state-machine CONFLICT (illegal move) only when it
// matches these patterns; anything else (Sheets I/O, etc.) is infra, not a 409.
function isDeloadConflict(error) {
  return /Illegal training-state transition|not in a deload|not in POST_DELOAD_EVALUATION/i
    .test(error && error.message ? error.message : '');
}

// Deload_State is an optional tab and appendRows cannot create it — so a write
// lifecycle action needs the tab to exist, mirroring /api/constraints' 503.
const DELOAD_STATE_MISSING_MSG =
  'Deload_State tab not found — create it in Google Sheets first (columns: updated_at, training_state, deload_protocol, deload_reason, deload_start_date, deload_sessions_remaining, deload_exit_criteria)';

async function deloadStateTabPresent() {
  const tabs = await getSpreadsheetTabs().catch(() => []);
  return tabs.includes('Deload_State');
}

// Classify a lifecycle write failure: 409 for a genuine illegal move, else 500
// with a fixed message (raw error as the detail, never the user-facing message).
function sendDeloadError(req, res, error, friendlyConflict) {
  if (isDeloadConflict(error)) {
    return standardError(req, res, friendlyConflict, error.message, 409);
  }
  return standardError(req, res, 'Failed to update deload state', error.message, 500);
}

// POST /api/deload/begin — owner invokes a deload. The protocol is selected from
// the training focus (deterministic); nothing is invented.
app.post('/api/deload/begin', async (req, res) => {
  const body = req.body || {};
  const focus = typeof body.focus === 'string' ? body.focus : 'strength';
  const protocol = selectProtocol(focus);
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'owner invoked';
  const sessionsRaw = Number(body.sessions_remaining);
  const sessions_remaining = Number.isFinite(sessionsRaw) && sessionsRaw > 0
    ? Math.floor(sessionsRaw)
    : protocol.duration_min_exposures;
  const exit_criteria = typeof body.exit_criteria === 'string' && body.exit_criteria.trim()
    ? body.exit_criteria.trim().slice(0, 200)
    : protocol.exit;
  if (!(await deloadStateTabPresent())) {
    return standardError(req, res, DELOAD_STATE_MISSING_MSG, null, 503);
  }
  try {
    const state = await beginDeload({ protocol, reason, sessions_remaining, exit_criteria });
    return standardSuccess(req, res, 'Deload started', { state });
  } catch (error) {
    return sendDeloadError(req, res, error, 'Cannot start a deload from the current training state');
  }
});

// POST /api/deload/advance — record that a deload session was completed.
app.post('/api/deload/advance', async (req, res) => {
  if (!(await deloadStateTabPresent())) {
    return standardError(req, res, DELOAD_STATE_MISSING_MSG, null, 503);
  }
  try {
    const state = await recordDeloadSession({});
    return standardSuccess(req, res, 'Deload session recorded', { state });
  } catch (error) {
    return sendDeloadError(req, res, error, 'No active deload to advance');
  }
});

// POST /api/deload/resolve — close out the post-deload evaluation back to NORMAL.
app.post('/api/deload/resolve', async (req, res) => {
  if (!(await deloadStateTabPresent())) {
    return standardError(req, res, DELOAD_STATE_MISSING_MSG, null, 503);
  }
  try {
    const state = await resolvePostDeload({});
    return standardSuccess(req, res, 'Deload resolved', { state });
  } catch (error) {
    return sendDeloadError(req, res, error, 'No post-deload evaluation to resolve');
  }
});

// GET /api/stalls
app.get('/api/stalls', async (req, res) => {
  const minSessions = parseInt(req.query.minSessions || '3', 10);
  if (Number.isNaN(minSessions) || minSessions < 2) {
    return standardError(req, res, 'minSessions must be an integer >= 2', null, 400);
  }

  try {
    const allLog = await getSheetRows(logSheetName);
    const stalls = detectStalls(allLog, minSessions);
    return standardSuccess(req, res, 'Stall detection', { stalls, minSessions });
  } catch (error) {
    return standardError(req, res, 'Failed to detect stalls', error.message, 500);
  }
});


app.get('/api/debug/exercise-match', async (req, res) => {
  const input = String(req.query.q || '').trim();
  if (!input) return standardError(req, res, 'Query param q is required', null, 400);

  try {
    const catalogRows = await getExerciseCatalog();
    const catalogMap = buildExerciseCatalogMap(catalogRows);
    const normalized_key = normalizeExerciseKey(input);
    const match = catalogMap.get(normalized_key);
    if (match) {
      return standardSuccess(req, res, 'Exercise match debug', {
        input,
        normalized_key,
        catalog_match: true,
        canonical_exercise: match.canonical_exercise,
        muscle_group: match.muscle_group,
        lift_code: match.lift_code,
        warning: match.lift_code ? null : 'Lift code is blank for this catalog match.',
        closest_matches: []
      });
    }

    return standardSuccess(req, res, 'Exercise match debug', {
      input,
      normalized_key,
      catalog_match: false,
      canonical_exercise: '',
      muscle_group: '',
      lift_code: '',
      warning: null,
      closest_matches: closestExerciseMatches(input, catalogMap)
    });
  } catch (error) {
    return standardError(req, res, 'Failed to debug exercise match', error.message, 500);
  }
});

app.post('/api/parse-workout-text', (req, res) => {
  const t0 = Date.now();
  try {
    const responseBody = buildWorkoutTextParseDryRunResponse(req.body);
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
  // enrichment (DoS). A real session is well under this; 200 is a generous ceiling.
  const MAX_LOG_ROWS = 200;
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
    // not extractable) and the user needs to correct it before approving.
    const screenshotDateRaw = visionResult.parsed_metrics?.date;
    const manualDateRaw = formFields.date;
    const dateValue = resolveWorkoutDate({ manualDate: manualDateRaw, screenshotDate: screenshotDateRaw });
    const dateSource = (manualDateRaw !== undefined && manualDateRaw !== null && String(manualDateRaw).trim() !== '')
      ? 'manual'
      : normalizeDateCandidate(screenshotDateRaw) ? 'screenshot' : 'today_fallback';

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
    const sessionId = formFields.session_id
      ? formFields.session_id
      : nextAvailableSessionId(dateValue, existingEffortSessionIds);

    const duplicateSession = Boolean(formFields.session_id) &&
      existingEffortSessionIds.map(id => id.toLowerCase()).includes(String(sessionId).toLowerCase());
    if (duplicateSession) {
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
        const enrichResult = await enrichAndFormatLogRows(parsedLogRows, sessionId, dateValue, catalogMap);
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

    // 6) Build effort_row from normalized metrics
    const { effortRow } = buildEffortRowFromParsedMetrics(normalizedMetrics, {
      date: dateValue,
      screenshot_date: visionResult.parsed_metrics?.date,
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

    let logAppendCount = rowsToWrite.length;
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
          await appendRows(logSheetName, rowsToWrite);
          // Log rows have landed. From here a failure must never release the
          // write_id (a retry would re-append these rows) — mark the write
          // committed so the catch records a partial completion instead.
          writeCommitted = true;
        }
        await appendRows(effortSheetName, [effortRow]);
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
            log_rows_written: logAppendCount,
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
        test_mode: testMode,
        effort_only: effortOnly,
        sheet_written: !testMode && effortWritten,
        sheet_write: testMode ? 'skipped' : 'success',
        log_rows_written: testMode ? 0 : logAppendCount,
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

app.post('/api/log-workout', async (req, res) => {

  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return standardError(req, res, 'Invalid JSON payload. A JSON object is required.', null, 400);
  }

  const { session_id, date, log_rows, effort_row } = payload;
  const testMode = isTestModeEnabled(payload.test_mode);
  const writeId = payload.write_id;

  if (!session_id) {
    return standardError(req, res, 'session_id is required.', null, 400);
  }

  if (!date) {
    return standardError(req, res, 'date is required.', null, 400);
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
    const logResult = await enrichAndFormatLogRows(log_rows, session_id, date);
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

    const previewBody = {
      test_mode: true,
      sheet_write: 'skipped',
      sheet_written: false,
      no_write_confirmed: true,
      effortWritten: Boolean(formattedEffortRow),
      log_rows_preview: formattedLogRows
    };
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
    date,
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
  let rowsToWrite = formattedLogRows;
  let skippedDuplicates = [];
  try {
    const existingLogKeys = await getLogCompositeKeys();
    const intendedKeys = formattedLogRows.map(row => {
      // formatted row order follows logCleanedColumns: session_id=1, exercise=2, set_number=6
      const sid = String(row[1] || '').trim().toLowerCase();
      const ex = String(row[2] || '').trim().toLowerCase();
      const setn = String(row[6] || '').trim().toLowerCase();
      return `${sid}||${ex}||${setn}`;
    });
    const newRows = [];
    for (let i = 0; i < formattedLogRows.length; i += 1) {
      if (existingLogKeys.includes(intendedKeys[i])) {
        skippedDuplicates.push({ index: i, row: formattedLogRows[i] });
      } else {
        newRows.push(formattedLogRows[i]);
      }
    }
    rowsToWrite = newRows;
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
  if (rowSpan < 1 || rowSpan > 10) {
    return standardError(req, res, `Row span must be between 1 and 10, got ${rowSpan}.`, null, 400);
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
  if (rowSpan < 1 || rowSpan > 10) {
    return standardError(req, res, `Row span must be between 1 and 10, got ${rowSpan}.`, null, 400);
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

  console.error('Unhandled error:', err);
  return standardError(
    req,
    res,
    process.env.NODE_ENV === 'production' ? 'Internal server error' : 'Unhandled error',
    process.env.NODE_ENV === 'production' ? undefined : err.message || err,
    500
  );
});

function startServer() {
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
