const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  appendRows,
  validateConfig,
  getExerciseCatalog,
  getEffortSessionIds,
  getLogCompositeKeys,
  getRecentRows,
  getSheetRows,
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
  computeFatigueStatus
} = require('./services/analytics');
const { normalizeDate, parseNumber, calculateQualityScore } = require('./services/validation');
const { createRequestContext, requireApiKey: requireApiKeyMiddleware } = require('./middleware');
const { success: standardSuccess, error: standardError } = require('./response');
const { createTtlCache } = require('./services/cache');
const { parseWorkoutScreenshot } = require('./services/vision');
const { normalizeExerciseKey, buildExerciseCatalogMap, enrichLogRow, closestExerciseMatches } = require('./services/exerciseEnrichment');
const { normalizeDurationString } = require('./services/duration');
const { buildWorkoutTextParseDryRunResponse } = require('./services/workoutTextParser');
const { validateLogRowsBounds } = require('./rules/validationRules');
const { evaluateSessionSafety } = require('./rules/safetyRules');
const { holdUntilClean } = require('./rules/progressionRules');

validateConfig();
(async () => {
  try {
    const tabs = await getSpreadsheetTabs();
    console.log(JSON.stringify({ event: 'startup_diagnostics', ok: true, tabs_present: tabs.length, required_env: ['ATLAS_API_KEY','GOOGLE_SHEETS_ID','GOOGLE_SERVICE_ACCOUNT_EMAIL','GOOGLE_PRIVATE_KEY','OPENAI_API_KEY'] }));
  } catch (error) {
    console.log(JSON.stringify({ event: 'startup_diagnostics', ok: false, error: error.message }));
  }
})();

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

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-atlas-api-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

app.use(express.json());
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
app.use('/api', requireApiKeyMiddleware(atlasApiKey, { publicPaths: [] }));
const { execSync } = require('child_process');

const deploymentTimestamp = new Date().toISOString();
// In-memory pending exercises collected from complete-workout responses
const pendingExercisesMemory = [];
// TODO(persistence-layer): replace in-memory pending exercises/cache with durable storage.
// TODO(db-migration): introduce real relational DB-backed write path with transactions.
// TODO(websocket-live-sync): stream ingestion/status updates to clients.
// TODO(gpt-integration-layer): separate model orchestration and prompt policy from HTTP layer.
// TODO(mobile-client): add API compatibility/versioning strategy for mobile app consumers.
const catalogCache = createTtlCache(60 * 1000);

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

function formatEffortRow(effortRow) {
  return normalizeEffortRow(effortRow);
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

function toDateOnly(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return String(value);
}

function formatDateForSessionId(dateValue) {
  const cleanDate = toDateOnly(dateValue).replace(/[^0-9]/g, '');
  if (!/^\d{8}$/.test(cleanDate)) {
    throw new Error(`Invalid date for session_id generation: ${dateValue}`);
  }
  return cleanDate;
}

function formatAmPmSuffix(dateTime = new Date()) {
  const hour = dateTime.getHours();
  return hour < 12 ? 'AM' : 'PM';
}

function generateSessionId(dateValue) {
  const formattedDate = formatDateForSessionId(dateValue);
  const suffix = formatAmPmSuffix();
  return `${formattedDate}-${suffix}-01`;
}

function isAutoWriteEnabled(value) {
  return String(value || '').toLowerCase() === 'true';
}

function isTestModeEnabled(value) {
  return String(value || '').toLowerCase() === 'true';
}

function buildEffortRowFromParsedMetrics(parsedMetrics, formFields) {
  const dateValue = toDateOnly(formFields.date);
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

const routeRegistry = [];
function registerRoute(method, path, handler, meta = {}) {
  routeRegistry.push({ path, methods: [method.toUpperCase()], ...meta });
  return app[method](path, handler);
}

app.get('/routes', (req, res) => {
  return standardSuccess(req, res, 'Available routes', { routes: routeDefinitions });
});

app.get('/version', (req, res) => {
  let gitVersion = 'unknown';
  try {
    gitVersion = execSync('git describe --always --dirty', { encoding: 'utf8' }).trim();
  } catch (err) {
    // ignore
  }

  return standardSuccess(req, res, 'Service version', {
    version: gitVersion,
    deployed_at: deploymentTimestamp,
    endpoints: routeDefinitions
  });
});

// GET /api/history/recent
registerRoute('get', '/api/history/recent', async (req, res) => {

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
    const recent_effort = filteredEffort.slice(0, limit).map(row => ({
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
registerRoute('get', '/api/catalog/exercises', async (req, res) => {

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
    required_for_manual_dry_run: ['test_mode=true', 'effort_json or manual effort fields'],
    optional: ['session_id', 'date', 'location', 'notes', 'test_mode', 'auto_write', 'effort_json']
  });
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
        .filter(code => code && code !== 'lift_code')
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
        sheet_written: false,
        no_write_confirmed: true,
        entry_preview: entry
      });
    }
    await appendRows('Bodyweight', [[normalizedDate, weightValue, notes || '']]);
    return standardSuccess(req, res, 'Bodyweight entry appended', { entry });
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
      // leave original duration if normalization fails; validation will catch issues when auto_write is enabled
      parsedForResponse.duration = visionResult.parsed_metrics.duration;
    }

    // Build an effort row to include in the response (may be overwritten if auto_write triggers a validated write)
    let { effortRow, sessionId, dateValue } = buildEffortRowFromParsedMetrics(parsedForResponse, formFields);

    let sheetWrite = 'skipped';
    let validationWarnings = [];

    if (isAutoWriteEnabled(formFields.auto_write)) {
      // Validate and normalize parsed metrics before attempting any write.
      let normalizedMetrics;
      try {
        const result = normalizeAndValidateParsedMetrics(visionResult.parsed_metrics);
        normalizedMetrics = result.normalized;
        validationWarnings = result.warnings || [];
      } catch (error) {
        return res.status(400).json({ error: `Parsed metrics validation failed: ${error.message}` });
      }

      // Rebuild effort row from normalized metrics so what's written is normalized
      ({ effortRow, sessionId, dateValue } = buildEffortRowFromParsedMetrics(normalizedMetrics, formFields));

      try {
        const existingEffortSessionIds = await getEffortSessionIds();
        const duplicate = existingEffortSessionIds
          .map(id => String(id).toLowerCase())
          .includes(String(sessionId).toLowerCase());

        if (!duplicate) {
          await appendRows(effortSheetName, [effortRow]);
          sheetWrite = 'success';
        }
      } catch (error) {
        sheetWrite = 'failed';
      }
    }

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

    if (validationWarnings.length > 0) {
      responseBody.warnings = validationWarnings;
    }

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
  const allowManualEffortDryRun = testMode && (formFields.effort_json || formFields.effort || formFields.duration);

  if (!req.file && !allowManualEffortDryRun) {
    return standardError(req, res, 'image file is required in multipart/form-data under field name image unless test_mode=true with manual effort metrics', null, 400);
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

  if (!Array.isArray(parsedLogRows) || parsedLogRows.length === 0) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'log_rows_json must be a non-empty JSON array' });
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
    const dateValue = toDateOnly(formFields.date);
    const sessionId = formFields.session_id || generateSessionId(dateValue);

    // 4) Check duplicate session protection
    let existingEffortSessionIds;
    try {
      existingEffortSessionIds = await getEffortSessionIds();
    } catch (error) {
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
      return standardError(req, res, 'Failed to validate duplicate session.', null, 500);
    }

    const duplicateSession = existingEffortSessionIds.map(id => id.toLowerCase()).includes(String(sessionId).toLowerCase());
    if (duplicateSession) {
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
      return standardError(req, res, 'Duplicate session.', null, 409);
    }

    // 5) Enrich and format log rows using existing catalog logic
    let formattedLogRows;
    let enrichWarnings = [];
    let pendingExercises = [];
    let autoMatches = [];
    let completeRuleFlags = [];
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

    // 6) Build effort_row from normalized metrics
    const { effortRow } = buildEffortRowFromParsedMetrics(normalizedMetrics, {
      date: dateValue,
      session_id: sessionId,
      location: formFields.location,
      notes: formFields.notes
    });

    // 7) Duplicate protection for Log_Cleaned rows (session_id + exercise + set_number)
    const existingLogKeys = await getLogCompositeKeys();
    const intendedKeys = formattedLogRows.map(row => {
      // formatted row order follows logCleanedColumns
      const sid = String(row[1] || '').trim().toLowerCase();
      const ex = String(row[2] || '').trim().toLowerCase();
      const setn = String(row[6] || '').trim().toLowerCase();
      return `${sid}||${ex}||${setn}`;
    });

    const rowsToWrite = [];
    const skippedDuplicates = [];
    for (let i = 0; i < formattedLogRows.length; i += 1) {
      const key = intendedKeys[i];
      if (existingLogKeys.includes(key)) {
        skippedDuplicates.push({ index: i, row: formattedLogRows[i] });
      } else {
        rowsToWrite.push(formattedLogRows[i]);
      }
    }

    let logAppendCount = rowsToWrite.length;
    let effortWritten = false;
    if (!testMode) {
      try {
        if (rowsToWrite.length > 0) {
          await appendRows(logSheetName, rowsToWrite);
        }
        await appendRows(effortSheetName, [effortRow]);
        effortWritten = true;
      } catch (error) {
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
        return standardError(req, res, 'Failed to append workout data.', null, 500);
      }
    }

    const duplicateWarnings = skippedDuplicates.length > 0 ? [`${skippedDuplicates.length} log row(s) skipped due to duplicate session_id+exercise+set_number`] : [];
    const combinedWarnings = [...new Set([...(metricWarnings || []), ...(enrichWarnings || []), ...duplicateWarnings])];

    const qualityScore = calculateQualityScore({
      totalSets: formattedLogRows.length,
      effortDuration: normalizedMetrics.duration,
      averageHR: normalizedMetrics.averageHR,
      uniqueExercisesCount: new Set(formattedLogRows.map(r => String(r[2] || '').toLowerCase())).size,
      validationWarnings: combinedWarnings
    });

    const responseBody = {
      status: 'ok',
      message: 'complete-workout processed',
      data: {
        session_id: sessionId,
        date: dateValue,
        test_mode: testMode,
        would_write: rowsToWrite.length > 0 || !duplicateSession,
        sheet_written: !testMode && effortWritten,
        log_rows_written: testMode ? 0 : logAppendCount,
        effort_written: effortWritten,
        duplicate_check: {
          duplicate_session: duplicateSession,
          duplicate_log_rows: skippedDuplicates.length
        },
        effort_source: req.file ? 'screenshot' : 'manual',
        parsed_effort: normalizedMetrics,
        quality_score: qualityScore
      }
    };

    if (combinedWarnings.length > 0) responseBody.warnings = combinedWarnings;
    if (completeRuleFlags.length > 0) responseBody.data.rule_flags = completeRuleFlags;

    if (testMode) {
      responseBody.test_mode = true;
      responseBody.data.no_write_confirmed = true;
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

    return standardSuccess(req, res, 'complete-workout processed', responseBody, 200);
  } catch (error) {
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

  if (formattedEffortRow) {
    let existingEffortSessionIds;
    try {
      existingEffortSessionIds = await getEffortSessionIds();
    } catch (error) {
      console.error('❌ Failed to check duplicate session IDs:', error);
      return standardError(req, res, 'Failed to validate duplicate session.', null, 500);
    }

    if (existingEffortSessionIds.map(id => id.toLowerCase()).includes(String(session_id).toLowerCase())) {
      return standardError(req, res, 'Duplicate session.', null, 409);
    }
  }

  try {
    console.log('📝 Appending formatted log_rows to', logSheetName, 'tab:', formattedLogRows);
    const logResponse = await appendRows(logSheetName, formattedLogRows);
    console.log('✅ Log rows appended successfully. Range:', logResponse.data.updates?.updatedRange);

    let effortResponse = null;
    if (formattedEffortRow) {
      console.log('\n📝 Appending formatted effort_row to', effortSheetName, 'tab:', [formattedEffortRow]);
      effortResponse = await appendRows(effortSheetName, [formattedEffortRow]);
      console.log('✅ Effort row appended successfully. Range:', effortResponse.data.updates?.updatedRange);
    }

    const responseBody = {
      message: 'Workout data appended successfully.',
      logAppendedRange: logResponse.data.updates?.updatedRange,
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

    return standardSuccess(req, res, 'log-workout processed', responseBody, 200);
  } catch (error) {
    console.error('❌ Failed to append workout data:', error);
    return standardError(req, res, 'Failed to append workout data', process.env.NODE_ENV === 'production' ? null : error.message, 500);
  }
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Atlas Workout Updater listening on port ${port}`);
});
