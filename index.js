const dotenv = require('dotenv');
dotenv.config();

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
  getSpreadsheetTabs,
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
  scoreIntents
} = require('./services/analytics');
const { buildRecommendation, parseRecommendationConstraints } = require('./services/recommendationPipeline');
const {
  beginWrite,
  completeWrite,
  failWrite
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
const { normalizeExerciseKey, generateLiftCode, buildExerciseCatalogMap, enrichLogRow, closestExerciseMatches } = require('./services/exerciseEnrichment');
const { normalizeDurationString } = require('./services/duration');
const { buildWorkoutTextParseDryRunResponse } = require('./services/workoutTextParser');
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
    fileSize: 10 * 1024 * 1024
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
app.use(['/api/log-workout', '/api/bodyweight', '/api/log-workout/undo-last', '/api/coaching-notes'], createRateLimiter({
  name: 'write',
  windowMs: Number(process.env.ATLAS_WRITE_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.ATLAS_WRITE_RATE_LIMIT_MAX || 60)
}));
const { execSync } = require('child_process');

const deploymentTimestamp = new Date().toISOString();
let gitVersion = 'unknown';
try { gitVersion = execSync('git describe --always --dirty', { encoding: 'utf8' }).trim(); } catch (_) { /* not a git repo or no tags */ }
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
const { logCleanedColumns, logRowFieldAliases, effortColumns, exerciseCatalogColumns, effortRowFieldAliases } = require('./config/columns');
const { requiredSheetTabs, optionalSheetTabs, buildSheetContractStatus } = require('./config/sheetContract');



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
    notes: ensureNotes(row.notes),
    volume_calc: row.volume_calc ?? row.volumeCalc ?? row.volume
  };

  if (result.volume_calc === undefined || result.volume_calc === null || result.volume_calc === '') {
    result.volume_calc = calculateVolumeCalc(result.weight, result.reps);
  }

  for (const field of ['date_clean', 'session_id', 'exercise', 'set_number', 'weight', 'reps', 'rir']) {
    if (result[field] === undefined || result[field] === null || result[field] === '') {
      throw new Error(`Missing required log row field: ${field}`);
    }
  }

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
    volume_calc: row[11] === undefined || row[11] === null || row[11] === '' ? calculateVolumeCalc(row[7], row[8]) : row[11]
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

  const formattedRows = logRows.map(row => {
    const rowObj = normalizeLogRow(row, topLevelSessionId, topLevelDate);
    const result = enrichLogRow(rowObj, catalogMap);
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
  return standardSuccess(req, res, 'Service version', {
    version: gitVersion,
    deployed_at: deploymentTimestamp,
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
app.post('/api/coach/message', async (req, res) => {
  const facts = req.body && req.body.facts;
  if (!facts || typeof facts !== 'object') {
    return standardError(req, res, 'facts object is required', null, 400);
  }
  const kind = req.body.kind === 'plan' ? 'plan' : 'set';
  if (!coach.isConfigured()) {
    return standardSuccess(req, res, 'Coach voice unavailable — use templated fallback', {
      message: null, configured: false, model: coach.coachModel()
    });
  }
  try {
    const message = kind === 'plan'
      ? await coach.generatePlanMessage(facts)
      : await coach.generateCoachMessage(facts);
    return standardSuccess(req, res, 'Coach message', { message, configured: true, model: coach.coachModel(), source: 'gemini', kind });
  } catch (error) {
    // Degrade gracefully: tell the client to use its templated fallback rather
    // than surfacing an error in the chat.
    return standardSuccess(req, res, 'Coach generation failed — use templated fallback', {
      message: null, configured: true, model: coach.coachModel(), error: error.message
    });
  }
});

// Assemble a compact, read-only training snapshot for the chat coach from the
// deterministic engine — recent sessions, movement-pattern readiness, today's
// recommended focus, and stalled lifts. Bounded here and bounded again in
// coach.sanitizeChatContext. The lifter's current preview rows (if any) ride
// along from the client so "is this set good?" can be answered in context.
function buildChatContext(logRows, effortRows, clientContext, coachingNotes) {
  const intents = scoreIntents(logRows, effortRows);
  const recent = buildRecentSessions(logRows, effortRows, { limit: 5 });
  const stalls = detectStalls(logRows);
  const read = intents.todays_read || {};
  const cc = clientContext && typeof clientContext === 'object' ? clientContext : {};
  const sessions = recent.sessions || [];
  return {
    recommended_label: read.recommended_label || null,
    recommended_focus: read.recommended_reason || null,
    readiness: (read.patterns || []).map(p => ({ pattern: p.label || p.pattern, status: p.status, detail: p.detail })),
    recent_sessions: sessions.map(s => ({
      date: s.date, exercises: s.exercises, sets: s.sets_count, volume: s.total_volume
    })),
    stalls: stalls.map(s => ({ exercise: s.exercise || s.liftCode, weight: s.last_best_weight, sessions_stalled: s.sessions_stalled })),
    current_preview: Array.isArray(cc.current_preview) ? cc.current_preview : [],
    current_plan: Array.isArray(cc.current_plan) ? cc.current_plan : [],
    session_count: sessions.length,
    coaching_notes: Array.isArray(coachingNotes) ? coachingNotes.slice(0, 10) : []
  };
}

// POST /api/coach/chat — free-form, two-way coaching chat. READ-ONLY: it reads
// recent training to ground the reply and never writes to Google Sheets. Body:
// { message: string, history?: [{role,text}], context?: { current_preview } }.
// When Gemini is unconfigured or fails, returns message:null so the client shows
// a deterministic fallback — the chat is never blocked by an LLM outage.
app.post('/api/coach/chat', async (req, res) => {
  const message = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    return standardError(req, res, 'message string is required', null, 400);
  }
  if (!coach.isConfigured()) {
    return standardSuccess(req, res, 'Coach chat unavailable — Gemini not configured', {
      message: null, configured: false, model: coach.coachModel()
    });
  }
  try {
    const [allLog, allEffort, notesRows] = await Promise.all([
      getSheetRows(logSheetName),
      getSheetRows(effortSheetName),
      getSheetRows('Coaching_Notes').catch(() => [])
    ]);
    const coachingNotes = notesRows
      .map(row => Array.isArray(row) ? { date: row[0] || null, note: row[1] || null } : { date: row.date || null, note: row.note || null })
      .filter(n => n.note);
    const context = buildChatContext(allLog, allEffort, req.body && req.body.context, coachingNotes);
    const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];
    const { reply, propose_edit, propose_note } = await coach.generateChatReply({ message, context, history });
    return standardSuccess(req, res, 'Coach chat reply', {
      message: reply, propose_edit: propose_edit || null, propose_note: propose_note || null, configured: true, model: coach.coachModel(), source: 'gemini'
    });
  } catch (error) {
    // Degrade gracefully — the client shows a templated fallback, never an error bubble.
    return standardSuccess(req, res, 'Coach chat failed — use fallback', {
      message: null, configured: true, model: coach.coachModel(), error: error.message
    });
  }
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
    const result = scoreIntents(allLog, allEffort);
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
      userProfileGoal: req.query.profileGoal,
      liftCode: req.query.liftCode,
      exerciseName: req.query.exercise,
      logRows: allLog,
      effortRows: allEffort,
      constraints: parseRecommendationConstraints(req.query)
    });
    const payload = {
      intent: rec.intent,
      source: rec.source,
      recommendation: rec.recommendation,
      reasonCodes: rec.reasonCodes,
      safetyFlags: rec.safetyFlags,
      llmBrief: rec.llmBrief,
      coachExplanation: rec.coachExplanation
    };
    if (rec.weightGuidance) payload.weightGuidance = rec.weightGuidance;
    return standardSuccess(req, res, 'Recommendation preview', payload);
  } catch (error) {
    return standardError(req, res, 'Failed to build recommendation preview', error.message, 500);
  }
});

// GET /api/recommend/next/:liftCode
app.get('/api/recommend/next/:liftCode', async (req, res) => {

  const liftCode = String(req.params.liftCode || '').trim();
  if (!liftCode) {
    return standardError(req, res, 'liftCode is required in path', null, 400);
  }

  try {
    const allLog = await getSheetRows(logSheetName);
    const recommendation = recommendNextSet(allLog, liftCode);
    const normalizedRows = allLog
      .filter(row => Array.isArray(row) && String(row[0] || '') !== 'date_clean')
      .map(normalizeAnalyticsLogRow);
    recommendation.rule_decision = holdUntilClean(normalizedRows, liftCode);
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

    try {
      await appendRows('Bodyweight', [[normalizedDate, weightValue, notes || '']]);
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
      if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
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
  try {
    const responseBody = buildWorkoutTextParseDryRunResponse(req.body);
    return standardSuccess(req, res, 'parse-workout-text processed', responseBody, 200);
  } catch (error) {
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
    return res.status(400).json({ error: `log_rows_json is not valid JSON: ${err.message}` });
  }

  if (!Array.isArray(parsedLogRows)) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'log_rows_json must be a JSON array' });
  }

  const effortOnly = parsedLogRows.length === 0;
  if (effortOnly && !req.file && !hasManualEffortMetrics) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Workout rows are required unless a screenshot or manual effort data is provided.' });
  }

  try {
    // 1) Parse image to get effort metrics
    const visionResult = req.file
      ? await parseWorkoutScreenshot(req.file.path)
      : { status: 'manual_effort', parsed_metrics: null };

    // 2) Validate parsed effort metrics (required before any writes)
    let normalizedMetrics;
    let metricWarnings = [];
    try {
      const result = req.file
        ? normalizeAndValidateParsedMetrics(visionResult.parsed_metrics)
        : normalizeManualEffortMetrics(formFields);
      normalizedMetrics = result.normalized;
      metricWarnings = result.warnings || [];
    } catch (error) {
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: `Parsed metrics validation failed: ${error.message}` });
    }

    // 3) Determine session/date
    const dateValue = resolveWorkoutDate({
      manualDate: formFields.date,
      screenshotDate: visionResult.parsed_metrics?.date
    });

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
        return res.status(400).json({ error: `Log rows validation/enrichment failed: ${error.message}` });
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

      try {
        if (rowsToWrite.length > 0) {
          await appendRows(logSheetName, rowsToWrite);
        }
        await appendRows(effortSheetName, [effortRow]);
        effortWritten = true;
        invalidateSheetRowsCache();
      } catch (error) {
        if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
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
        effort_source: req.file ? 'screenshot' : 'manual',
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
    }

    return standardSuccess(req, res, 'complete-workout processed', responseBody, 200);
  } catch (error) {
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
    return standardError(req, res, 'Failed to complete workout ingestion', { error: error.message, safeWrite: true }, 500);
  } finally {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
  }
});

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
  try {
    const logResult = await enrichAndFormatLogRows(log_rows, session_id, date);
    formattedLogRows = logResult.formattedRows;
    warnings = logResult.warnings || [];
    pendingExercisesForPreview = logResult.pending_exercises || [];
    autoMatchesForPreview = logResult.auto_matches || [];
    ruleFlags = evaluateSessionSafety(logResult.enrichedRowObjects || [], payload.notes || '');
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
    return standardSuccess(req, res, 'log-workout processed', previewBody, 200);
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

  // The two appends are split so a failure between them cannot release the
  // idempotency record while rows are already on the sheet. Log append fails
  // → nothing was written, failWrite is safe, a retry starts clean. Effort
  // append fails AFTER the log append → the write_id is recorded as completed
  // with a partial result, so a retried write_id replays that honest partial
  // response instead of appending the log rows a second time.
  let logResponse;
  try {
    console.log(JSON.stringify({
      event: 'append_log_rows',
      tab: logSheetName,
      row_count: formattedLogRows.length,
      session_id,
      requestId: req.requestId
    }));
    logResponse = await appendRows(logSheetName, formattedLogRows);
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
      console.error('❌ Effort append failed after log rows were written:', error);
      invalidateSheetRowsCache();
      const partialBody = {
        message: 'Log rows were appended but the effort row failed to write. Retrying this write_id will not append the log rows again — use undo-last or add the effort separately.',
        logAppendedRange: logResponse.data.updates?.updatedRange,
        log_rows_written: Number(logResponse.data.updates?.updatedRows || 0),
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
      logAppendedRange: logResponse.data.updates?.updatedRange,
      log_rows_written: Number(logResponse.data.updates?.updatedRows || 0),
      effortWritten: Boolean(formattedEffortRow),
      test_mode: false,
      sheet_write: 'success'
    };
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
    console.error('❌ Failed to append workout data:', error);
    if (idempotency.enabled) failWrite(idempotency.write_id, idempotency.token);
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
