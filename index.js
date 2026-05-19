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
  getSpreadsheetTabs,
  logSheetName,
  effortSheetName
} = require('./sheets');
const { parseWorkoutScreenshot } = require('./services/vision');

validateConfig();

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
app.use(express.json());

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: duration
    };
    console.log(JSON.stringify(logEntry));
  });
  next();
}

app.use(requestLogger);
const { execSync } = require('child_process');

const deploymentTimestamp = new Date().toISOString();
// In-memory pending exercises collected from complete-workout responses
const pendingExercisesMemory = [];

const routeDefinitions = [
  { path: '/', methods: ['GET'], public: true, authRequired: false, readOnly: true, writeCapable: false },
  { path: '/health', methods: ['GET'], public: true, authRequired: false, readOnly: true, writeCapable: false },
  { path: '/routes', methods: ['GET'], public: true, authRequired: false, readOnly: true, writeCapable: false },
  { path: '/version', methods: ['GET'], public: true, authRequired: false, readOnly: true, writeCapable: false },
  { path: '/api/history/recent', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/exercises/:liftCode', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/recommend/next/:liftCode', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/summary/weekly', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/prs/recent', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/pending-exercises', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/session/:sessionId', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/catalog/exercises', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/catalog/search', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/health/sheets', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/health/openai', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/debug/config', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/schema/log', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/schema/effort', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/schema/complete-workout', methods: ['GET'], public: false, authRequired: true, readOnly: true, writeCapable: false },
  { path: '/api/parse-workout-image', methods: ['POST'], public: false, authRequired: true, readOnly: false, writeCapable: true },
  { path: '/api/complete-workout', methods: ['POST'], public: false, authRequired: true, readOnly: false, writeCapable: true },
  { path: '/api/log-workout', methods: ['POST'], public: false, authRequired: true, readOnly: false, writeCapable: true }
];

const logCleanedColumns = [
  'date_clean',
  'session_id',
  'exercise',
  'canonical_exercise',
  'muscle_group',
  'lift_code',
  'set_number',
  'weight',
  'reps',
  'rir',
  'notes'
];

const logRowFieldAliases = {
  date_clean: ['date_clean', 'dateClean', 'date'],
  session_id: ['session_id', 'sessionId'],
  exercise: ['exercise'],
  canonical_exercise: ['canonical_exercise', 'canonicalExercise'],
  muscle_group: ['muscle_group', 'muscleGroup'],
  lift_code: ['lift_code', 'liftCode'],
  set_number: ['set_number', 'setNumber', 'set'],
  weight: ['weight'],
  reps: ['reps'],
  rir: ['rir'],
  notes: ['notes']
};

const effortColumns = [
  'date',
  'session_id',
  'duration',
  'active_calories',
  'total_calories',
  'average_hr',
  'peak_hr',
  'location',
  'notes'
];

const effortRowFieldAliases = {
  date: ['date'],
  session_id: ['session_id', 'sessionId'],
  duration: ['duration'],
  active_calories: ['active_calories', 'activeCalories'],
  total_calories: ['total_calories', 'totalCalories'],
  average_hr: ['average_hr', 'averageHR', 'avg_hr'],
  peak_hr: ['peak_hr', 'peakHR'],
  location: ['location'],
  notes: ['notes']
};

function ensureNotes(value) {
  return value === undefined || value === null ? '' : value;
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

  for (const field of ['date_clean', 'session_id', 'exercise', 'set_number', 'weight', 'reps', 'rir']) {
    if (result[field] === undefined || result[field] === null || result[field] === '') {
      throw new Error(`Missing required log row field: ${field}`);
    }
  }

  return result;
}

function logRowArrayToObject(row) {
  if (!Array.isArray(row) || row.length !== logCleanedColumns.length) {
    throw new Error(`Each log row must contain ${logCleanedColumns.length} values in Log_Cleaned column order.`);
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
    notes: ensureNotes(row[10])
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

function buildExerciseCatalogMap(rows) {
  if (!rows.length) return new Map();

  const header = rows[0].map(cell => String(cell || '').trim().toLowerCase());
  const originalVariantsIndex = header.findIndex(value => ['original_variants', 'original variants', 'originalvariant', 'original variant'].includes(value));
  const canonicalNameIndex = header.findIndex(value => ['canonical_name', 'canonical name', 'canonicalname'].includes(value));
  const muscleGroupIndex = header.findIndex(value => ['muscle_group', 'muscle group', 'musclegroup'].includes(value));
  const liftCodeIndex = header.findIndex(value => ['lift code', 'lift_code', 'liftcode'].includes(value));

  if (canonicalNameIndex === -1) {
    throw new Error('Exercise_Catalog header must include Canonical_Name.');
  }

  const entryMap = new Map();

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const canonicalName = String(row[canonicalNameIndex] || '').trim();
    if (!canonicalName) continue;

    const muscleGroup = String(row[muscleGroupIndex] || '').trim();
    const liftCode = String(row[liftCodeIndex] || '').trim();

    const addMatch = name => {
      const key = normalizeExerciseKey(name);
      if (!key) return;
      if (!entryMap.has(key)) {
        entryMap.set(key, {
          canonical_exercise: canonicalName,
          muscle_group: muscleGroup,
          lift_code: liftCode || ''
        });
      }
    };

    addMatch(canonicalName);

    if (originalVariantsIndex !== -1) {
      const variants = String(row[originalVariantsIndex] || '').split(/[,;|]/).map(v => v.trim()).filter(Boolean);
      variants.forEach(addMatch);
    }
  }

  return entryMap;
}

function enrichLogRow(rowObj, catalogMap) {
  const key = normalizeExerciseKey(rowObj.exercise);
  const catalogMatch = catalogMap.get(key);
  const enriched = { ...rowObj };
  if (catalogMatch) {
    enriched.canonical_exercise = catalogMatch.canonical_exercise;
    enriched.muscle_group = catalogMatch.muscle_group;
    enriched.lift_code = catalogMatch.lift_code || '';
    const warnings = [];
    if (!catalogMatch.lift_code) warnings.push(`No lift code for exercise '${rowObj.exercise}'.`);
    return { enriched, warnings: warnings.length ? warnings : null };
  }

  enriched.canonical_exercise = '';
  enriched.muscle_group = '';
  enriched.lift_code = '';
  return {
    enriched,
    warnings: [`Unknown exercise: ${rowObj.exercise}`]
  };
}

function logRowObjectToArray(rowObj) {
  return logCleanedColumns.map(column => {
    if (column === 'notes') {
      return ensureNotes(rowObj.notes);
    }
    return rowObj[column];
  });
}

function normalizeExerciseKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, '')
    .replace(/[()\[\]{}:;,.\/\\+*?^$|]/g, '')
    .replace(/\s+/g, ' ');
}

function standardError(res, message, details = undefined, statusCode = 400) {
  const payload = { status: 'error', message };
  if (details !== undefined) {
    payload.details = details;
  }
  return res.status(statusCode).json(payload);
}

function standardSuccess(res, message, data = undefined, statusCode = 200) {
  const payload = { status: 'ok', message };
  if (data !== undefined) {
    payload.data = data;
  }
  return res.status(statusCode).json(payload);
}

function requireApiKey(req, res) {
  const incomingApiKey = req.header('x-atlas-api-key');
  if (!incomingApiKey || incomingApiKey !== atlasApiKey) {
    standardError(res, 'Unauthorized', null, 401);
    return false;
  }
  return true;
}

function buildExerciseCatalogEntries(rows) {
  if (!rows.length) return [];

  const header = rows[0].map(cell => String(cell || '').trim().toLowerCase());
  const canonicalNameIndex = header.findIndex(value => ['canonical_name', 'canonical name', 'canonicalname'].includes(value));
  const muscleGroupIndex = header.findIndex(value => ['muscle_group', 'muscle group', 'musclegroup'].includes(value));
  const liftCodeIndex = header.findIndex(value => ['lift code', 'lift_code', 'liftcode'].includes(value));
  const variantsIndex = header.findIndex(value => ['original_variants', 'original variants', 'originalvariant', 'original variant'].includes(value));

  if (canonicalNameIndex === -1) {
    throw new Error('Exercise_Catalog header must include Canonical_Name.');
  }

  const entries = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const canonicalName = String(row[canonicalNameIndex] || '').trim();
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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function normalizeDurationString(value) {
  if (value === null || value === undefined) {
    throw new Error('duration is required');
  }

  const s = String(value).trim();
  if (!s) throw new Error('duration is required');

  const parts = s.split(':').map(p => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    // mm:ss -> 00:MM:SS
    const [mm, ss] = parts;
    if (!/^\d+$/.test(mm) || !/^\d+$/.test(ss)) throw new Error(`Invalid duration format: ${value}`);
    const m = Number(mm);
    const sec = Number(ss);
    if (sec < 0 || sec > 59 || m < 0) throw new Error(`Invalid duration values: ${value}`);
    return `${pad2(0)}:${pad2(m)}:${pad2(sec)}`;
  }

  if (parts.length === 3) {
    // h:mm:ss or hh:mm:ss
    const [h, mm, ss] = parts;
    if (!/^\d+$/.test(h) || !/^\d+$/.test(mm) || !/^\d+$/.test(ss)) throw new Error(`Invalid duration format: ${value}`);
    const hr = Number(h);
    const m = Number(mm);
    const sec = Number(ss);
    if (m < 0 || m > 59 || sec < 0 || sec > 59 || hr < 0) throw new Error(`Invalid duration values: ${value}`);
    return `${pad2(hr)}:${pad2(m)}:${pad2(sec)}`;
  }

  throw new Error(`Invalid duration format: ${value}`);
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
  if (normalized.peakHR < normalized.averageHR) {
    warnings.push('peakHR is less than averageHR');
  }

  if (parsedMetrics.peakHR === null || parsedMetrics.peakHR === undefined || parsedMetrics.peakHR === '') {
    warnings.push('peakHR missing from parsed screenshot');
  }

  return { normalized, warnings };
}

async function enrichAndFormatLogRows(logRows, topLevelSessionId, topLevelDate) {
  let catalogMap;
  // allow passing in a prebuilt catalogMap via optional 4th param
  if (arguments.length >= 4 && arguments[3] && arguments[3] instanceof Map) {
    catalogMap = arguments[3];
  } else {
    const catalogRows = await getExerciseCatalog();
    catalogMap = buildExerciseCatalogMap(catalogRows);
  }
  const warnings = [];

  const pending_exercises = [];
  const formattedRows = logRows.map(row => {
    const rowObj = normalizeLogRow(row, topLevelSessionId, topLevelDate);
    const result = enrichLogRow(rowObj, catalogMap);
    const enriched = result.enriched;
    const rowWarnings = result.warnings || null;
    if (rowWarnings) {
      for (const w of rowWarnings) {
        warnings.push(w);
      }
      // If unknown exercise, add to pending_exercises
      for (const w of rowWarnings) {
        if (w && String(w).startsWith('Unknown exercise:')) {
          pending_exercises.push({
            exercise: rowObj.exercise,
            suggested_canonical_name: rowObj.exercise,
            reason: 'No Exercise_Catalog match'
          });
        }
      }
    }
    return logRowObjectToArray(enriched);
  });

  return { formattedRows, warnings, pending_exercises };
}

app.get('/', (req, res) => {
  return standardSuccess(res, 'Atlas backend is running', {
    service: 'atlas-workout-updater',
    message: 'Atlas backend is running'
  });
});

app.get('/health', (req, res) => {
  return standardSuccess(res, 'Health check passed', { service: 'atlas-workout-updater' });
});

app.get('/routes', (req, res) => {
  return standardSuccess(res, 'Available routes', { routes: routeDefinitions });
});

app.get('/version', (req, res) => {
  let gitVersion = 'unknown';
  try {
    gitVersion = execSync('git describe --always --dirty', { encoding: 'utf8' }).trim();
  } catch (err) {
    // ignore
  }

  return standardSuccess(res, 'Service version', {
    version: gitVersion,
    deployed_at: deploymentTimestamp,
    endpoints: routeDefinitions
  });
});

// GET /api/history/recent
app.get('/api/history/recent', async (req, res) => {
  const incomingApiKey = req.header('x-atlas-api-key');
  if (!incomingApiKey || incomingApiKey !== atlasApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
    return res.status(500).json({ error: `Failed to fetch history: ${error.message}` });
  }
});

// GET /api/exercises/:liftCode
app.get('/api/exercises/:liftCode', async (req, res) => {
  const incomingApiKey = req.header('x-atlas-api-key');
  if (!incomingApiKey || incomingApiKey !== atlasApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const liftCode = String(req.params.liftCode || '').trim().toLowerCase();
  if (!liftCode) return res.status(400).json({ error: 'liftCode is required in path' });

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
    return res.status(500).json({ error: `Failed to fetch exercise detail: ${error.message}` });
  }
});

// GET /api/pending-exercises
app.get('/api/pending-exercises', (req, res) => {
  if (!requireApiKey(req, res)) return;
  return standardSuccess(res, 'Pending exercises endpoint', { pending_exercises: [], message: 'Pending exercise persistence not implemented yet.' });
});

// GET /api/catalog/exercises
app.get('/api/catalog/exercises', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const rows = await getExerciseCatalog();
    const exercises = buildExerciseCatalogEntries(rows);
    return standardSuccess(res, 'Exercise catalog entries', { exercises });
  } catch (error) {
    return standardError(res, 'Failed to read Exercise_Catalog', error.message, 500);
  }
});

// GET /api/catalog/search
app.get('/api/catalog/search', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const query = String(req.query.q || '').trim();
  if (!query) {
    return standardError(res, 'Query param q is required', null, 400);
  }

  try {
    const rows = await getExerciseCatalog();
    const exercises = buildExerciseCatalogEntries(rows);
    const lowerQuery = query.toLowerCase();
    const results = exercises.filter(entry => {
      return entry.canonical_name.toLowerCase().includes(lowerQuery)
        || entry.lift_code.toLowerCase().includes(lowerQuery)
        || entry.variants.some(v => v.toLowerCase().includes(lowerQuery));
    });
    return standardSuccess(res, 'Catalog search results', { query, results });
  } catch (error) {
    return standardError(res, 'Failed to search Exercise_Catalog', error.message, 500);
  }
});

// GET /api/health/sheets
app.get('/api/health/sheets', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const tabs = await getSpreadsheetTabs();
    const requiredTabs = ['Log_Cleaned', 'Effort', 'Exercise_Catalog'];
    const status = requiredTabs.reduce((acc, tab) => {
      acc[tab] = { exists: tabs.includes(tab) };
      return acc;
    }, {});
    return standardSuccess(res, 'Google Sheets health check', { tabs: status, availableTabs: tabs });
  } catch (error) {
    return standardError(res, 'Failed to verify Google Sheets tabs', error.message, 500);
  }
});

// GET /api/health/openai
app.get('/api/health/openai', (req, res) => {
  if (!requireApiKey(req, res)) return;
  return standardSuccess(res, 'OpenAI health check', { configured: Boolean(process.env.OPENAI_API_KEY) });
});

// GET /api/debug/config
app.get('/api/debug/config', (req, res) => {
  if (!requireApiKey(req, res)) return;
  return standardSuccess(res, 'Safe debug configuration', {
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
  if (!requireApiKey(req, res)) return;
  return standardSuccess(res, 'Log_Cleaned schema', {
    schema: ['Date_Clean', 'Session ID', 'Exercise', 'Canonical_Exercise', 'Muscle_Group', 'Lift Code', 'Set #', 'Weight', 'Reps', 'RIR', 'Notes']
  });
});

// GET /api/schema/effort
app.get('/api/schema/effort', (req, res) => {
  if (!requireApiKey(req, res)) return;
  return standardSuccess(res, 'Effort schema', {
    schema: ['Date', 'Session ID', 'Duration', 'Active Calories', 'Total Calories', 'Average HR', 'Peak HR', 'Location', 'Notes']
  });
});

// GET /api/schema/complete-workout
app.get('/api/schema/complete-workout', (req, res) => {
  if (!requireApiKey(req, res)) return;
  return standardSuccess(res, 'Complete-workout multipart schema', {
    required: ['image', 'log_rows_json'],
    optional: ['session_id', 'date', 'location', 'notes', 'test_mode', 'auto_write']
  });
});

// GET /api/recommend/next/:liftCode
app.get('/api/recommend/next/:liftCode', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const liftCode = String(req.params.liftCode || '').trim().toLowerCase();
  if (!liftCode) {
    return standardError(res, 'liftCode is required in path', null, 400);
  }

  try {
    const allLog = await getRecentRows(logSheetName, 1000);
    const workingSets = allLog
      .filter(row => String(row[5] || '').toLowerCase() === liftCode)
      .filter(row => Number(row[7]) > 0)
      .sort((a, b) => String(a[0] || '').localeCompare(String(b[0] || '')) || Number(a[6]) - Number(b[6]));

    if (!workingSets.length) {
      return standardError(res, `No working sets found for liftCode ${liftCode}`, null, 404);
    }

    const recentWorkingSets = workingSets.slice(-10).map(r => ({
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
    }));

    const lastSet = recentWorkingSets[recentWorkingSets.length - 1];
    const lastWeight = Number(lastSet.weight);
    const lastReps = Number(lastSet.reps);
    const lastRir = Number(lastSet.rir);
    const lastSessionPerformance = {
      date_clean: lastSet.date_clean,
      session_id: lastSet.session_id,
      weight: lastWeight,
      reps: lastReps,
      rir: lastRir,
      exercise: lastSet.exercise
    };

    let recommendation = 'Repeat the last working set and focus on consistent form.';
    let reasoning = 'No significant change detected from the last set.';

    if (lastWeight > 0 && Number.isFinite(lastReps) && Number.isFinite(lastRir)) {
      if (lastReps >= 8 && lastRir >= 2) {
        recommendation = `Increase weight slightly from ${lastWeight} to ${lastWeight + 2.5} and aim for ${lastReps} reps.`;
        reasoning = 'Last top set hit target reps with sufficient RIR, so a small progression is reasonable.';
      } else if (lastReps < 8 || lastRir <= 0) {
        recommendation = `Keep the same weight or reduce by a small step and focus on reaching the target reps.`;
        reasoning = 'Reps dropped or RIR was low, so maintain or reduce weight to rebuild confidence and volume.';
      } else {
        recommendation = `Repeat the current weight and try to add a rep or two next session.`;
        reasoning = 'Current performance is solid, so prioritize an extra rep before increasing weight.';
      }
    }

    return standardSuccess(res, 'Recommendation generated', {
      liftCode: liftCode.toUpperCase(),
      recentWorkingSets,
      lastSessionPerformance,
      recommendation,
      reasoning
    });
  } catch (error) {
    return standardError(res, 'Failed to compute recommendation', error.message, 500);
  }
});

// GET /api/summary/weekly
app.get('/api/summary/weekly', async (req, res) => {
  const incomingApiKey = req.header('x-atlas-api-key');
  if (!incomingApiKey || incomingApiKey !== atlasApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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

    return standardSuccess(res, 'Weekly summary', {
      sessions: Array.from(sessions.values()),
      totalSets,
      totalVolume,
      muscleGroupBreakdown,
      effortSummary,
      highlights
    });
  } catch (error) {
    return standardError(res, 'Failed to build weekly summary', error.message, 500);
  }
});

// GET /api/prs/recent
app.get('/api/prs/recent', async (req, res) => {
  const incomingApiKey = req.header('x-atlas-api-key');
  if (!incomingApiKey || incomingApiKey !== atlasApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const allLog = await getRecentRows(logSheetName, 1000);
    const workingSets = allLog.filter(row => Number(row[7]) > 0);
    const liftCodeMap = new Map();

    workingSets.forEach(row => {
      const code = String(row[5] || '').trim().toUpperCase();
      if (!code) return;
      const weight = Number(row[7]);
      const reps = Number(row[8]);
      const current1RM = Number.isFinite(weight) && Number.isFinite(reps) ? weight * (1 + reps / 30) : 0;
      const existing = liftCodeMap.get(code) || {
        liftCode: code,
        exercise: row[2],
        bestWeight: 0,
        bestRepsAtBestWeight: 0,
        bestEstimated1RM: 0
      };

      if (weight > existing.bestWeight) {
        existing.bestWeight = weight;
        existing.bestRepsAtBestWeight = reps;
      } else if (weight === existing.bestWeight && reps > existing.bestRepsAtBestWeight) {
        existing.bestRepsAtBestWeight = reps;
      }

      if (current1RM > existing.bestEstimated1RM) {
        existing.bestEstimated1RM = current1RM;
      }

      liftCodeMap.set(code, existing);
    });

    return standardSuccess(res, 'Recent PRs', { prs: Array.from(liftCodeMap.values()) });
  } catch (error) {
    return standardError(res, 'Failed to fetch recent PRs', error.message, 500);
  }
});

// GET /api/session/:sessionId
app.get('/api/session/:sessionId', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const sessionId = String(req.params.sessionId || '').trim();
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required in path' });
  }

  try {
    const recentLog = await getRecentRows(logSheetName, 1000);
    const recentEffort = await getRecentRows(effortSheetName, 1000);

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
    return standardError(res, 'Failed to fetch session data', error.message, 500);
  }
});


app.post('/api/parse-workout-image', upload.single('image'), async (req, res) => {
  const incomingApiKey = req.header('x-atlas-api-key');

  if (!incomingApiKey || incomingApiKey !== atlasApiKey) {
    if (req.file?.path) {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'image file is required in multipart/form-data under field name image' });
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

    return res.status(200).json(responseBody);
  } catch (error) {
    return standardError(res, 'Failed to parse workout image', error.message, 500);
  } finally {
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
});


app.post('/api/complete-workout', upload.single('image'), async (req, res) => {
  const incomingApiKey = req.header('x-atlas-api-key');

  if (!incomingApiKey || incomingApiKey !== atlasApiKey) {
    if (req.file?.path) {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'image file is required in multipart/form-data under field name image' });
  }

  const formFields = req.body || {};
  const testMode = isTestModeEnabled(formFields.test_mode);

  // log_rows_json is required
  if (!formFields.log_rows_json) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'log_rows_json is required in multipart/form-data' });
  }

  let parsedLogRows;
  try {
    parsedLogRows = JSON.parse(formFields.log_rows_json);
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: `log_rows_json is not valid JSON: ${err.message}` });
  }

  if (!Array.isArray(parsedLogRows) || parsedLogRows.length === 0) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'log_rows_json must be a non-empty JSON array' });
  }

  try {
    // 1) Parse image to get effort metrics
    const visionResult = await parseWorkoutScreenshot(req.file.path);

    // 2) Validate parsed effort metrics (required before any writes)
    let normalizedMetrics;
    let metricWarnings = [];
    try {
      const result = normalizeAndValidateParsedMetrics(visionResult.parsed_metrics);
      normalizedMetrics = result.normalized;
      metricWarnings = result.warnings || [];
    } catch (error) {
      await fs.promises.unlink(req.file.path).catch(() => {});
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
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(500).json({ error: 'Failed to validate duplicate session.' });
    }

    if (existingEffortSessionIds.map(id => id.toLowerCase()).includes(String(sessionId).toLowerCase())) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(409).json({ error: 'Duplicate session.' });
    }

    // 5) Enrich and format log rows using existing catalog logic
    let formattedLogRows;
    let enrichWarnings = [];
    try {
      // fetch catalog once and pass the map to the enricher to ensure consistent lookup
      const catalogRows = await getExerciseCatalog();
      const catalogMap = buildExerciseCatalogMap(catalogRows);
      const enrichResult = await enrichAndFormatLogRows(parsedLogRows, sessionId, dateValue, catalogMap);
      formattedLogRows = enrichResult.formattedRows;
      enrichWarnings = enrichResult.warnings || [];
      const pendingExercises = enrichResult.pending_exercises || [];
      // store pending exercises in memory (dedupe by exercise)
      for (const pe of pendingExercises) {
        const key = String(pe.exercise || '').trim().toLowerCase();
        if (!key) continue;
        const exists = pendingExercisesMemory.some(e => String(e.exercise || '').trim().toLowerCase() === key);
        if (!exists) pendingExercisesMemory.push(pe);
      }
    } catch (error) {
      await fs.promises.unlink(req.file.path).catch(() => {});
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
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(500).json({ error: 'Failed to append workout data.' });
      }
    }

    const duplicateWarnings = skippedDuplicates.length > 0 ? [`${skippedDuplicates.length} log row(s) skipped due to duplicate session_id+exercise+set_number`] : [];
    const combinedWarnings = [...new Set([...(metricWarnings || []), ...(enrichWarnings || []), ...duplicateWarnings])];

    const responseBody = {
      status: 'ok',
      message: 'complete-workout processed',
      data: {
        session_id: sessionId,
        date: dateValue,
        log_rows_written: logAppendCount,
        effort_written: effortWritten,
        parsed_effort: normalizedMetrics
      }
    };

    if (combinedWarnings.length > 0) responseBody.warnings = combinedWarnings;

    if (testMode) {
      responseBody.test_mode = true;
      responseBody.data.effort_row = effortRow;
      responseBody.data.log_rows_preview = formattedLogRows;
      responseBody.data.rows_to_write = rowsToWrite;
      responseBody.data.rows_skipped = skippedDuplicates.map(s => s.row);
    }

    // include pending_exercises when present
    if (typeof pendingExercises !== 'undefined' && pendingExercises.length > 0) {
      responseBody.pending_exercises = pendingExercises;
    }

    return res.status(200).json(responseBody);
  } catch (error) {
    return standardError(res, 'Failed to complete workout ingestion', error.message, 500);
  } finally {
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/log-workout', async (req, res) => {
  const incomingApiKey = req.header('x-atlas-api-key');

  if (!incomingApiKey || incomingApiKey !== atlasApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return standardError(res, 'Invalid JSON payload. A JSON object is required.', null, 400);
  }

  const { session_id, date, log_rows, effort_row } = payload;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required.' });
  }

  if (!date) {
    return res.status(400).json({ error: 'date is required.' });
  }

  if (log_rows === undefined) {
    return res.status(400).json({ error: 'log_rows is required.' });
  }

  if (!Array.isArray(log_rows)) {
    return res.status(400).json({ error: 'log_rows must be an array.' });
  }

  if (log_rows.length === 0) {
    return res.status(400).json({ error: 'log_rows must be a non-empty array.' });
  }

  if (effort_row === undefined) {
    return res.status(400).json({ error: 'effort_row is required.' });
  }

  if (!Array.isArray(effort_row) && !(effort_row && typeof effort_row === 'object')) {
    return res.status(400).json({ error: 'effort_row must be an array or object.' });
  }

  let existingEffortSessionIds;
  try {
    existingEffortSessionIds = await getEffortSessionIds();
  } catch (error) {
    console.error('❌ Failed to check duplicate session IDs:', error);
    return res.status(500).json({ error: 'Failed to validate duplicate session.' });
  }

  if (existingEffortSessionIds.map(id => id.toLowerCase()).includes(String(session_id).toLowerCase())) {
    return res.status(409).json({ error: 'Duplicate session.' });
  }

  let formattedLogRows;
  let warnings = [];
  try {
    const logResult = await enrichAndFormatLogRows(log_rows, session_id, date);
    formattedLogRows = logResult.formattedRows;
    warnings = logResult.warnings;
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  let formattedEffortRow;
  try {
    formattedEffortRow = formatEffortRow(effort_row);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {
    console.log('📝 Appending formatted log_rows to', logSheetName, 'tab:', formattedLogRows);
    const logResponse = await appendRows(logSheetName, formattedLogRows);
    console.log('✅ Log rows appended successfully. Range:', logResponse.data.updates?.updatedRange);

    console.log('\n📝 Appending formatted effort_row to', effortSheetName, 'tab:', [formattedEffortRow]);
    const effortResponse = await appendRows(effortSheetName, [formattedEffortRow]);
    console.log('✅ Effort row appended successfully. Range:', effortResponse.data.updates?.updatedRange);

    const responseBody = {
      message: 'Workout data appended successfully.',
      logAppendedRange: logResponse.data.updates?.updatedRange,
      effortAppendedRange: effortResponse.data.updates?.updatedRange
    };
    if (warnings.length > 0) {
      responseBody.warnings = [...new Set(warnings)];
    }

    return res.status(200).json(responseBody);
  } catch (error) {
    console.error('❌ Failed to append workout data:', error);
    return standardError(res, 'Failed to append workout data', process.env.NODE_ENV === 'production' ? null : error.message, 500);
  }
});

app.use((req, res) => {
  return standardError(res, 'Route not found', { path: req.originalUrl }, 404);
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return standardError(res, 'File too large. Max size is 10MB.', null, 413);
  }

  if (err && err.message && /^Only image\/(png|jpeg|jpg|webp)/.test(err.message)) {
    return standardError(res, err.message, null, 400);
  }

  console.error('Unhandled error:', err);
  return standardError(
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
