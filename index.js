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
  }
});

const app = express();
app.use(express.json());
const { execSync } = require('child_process');

const deploymentTimestamp = new Date().toISOString();

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
      const key = String(name || '').trim().toLowerCase();
      if (!key) return;
      if (!entryMap.has(key)) {
        entryMap.set(key, {
          canonical_exercise: canonicalName,
          muscle_group: muscleGroup,
          lift_code: liftCode
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
  const key = String(rowObj.exercise || '').trim().toLowerCase();
  const catalogMatch = catalogMap.get(key);
  const enriched = { ...rowObj };

  if (catalogMatch) {
    enriched.canonical_exercise = catalogMatch.canonical_exercise;
    enriched.muscle_group = catalogMatch.muscle_group;
    enriched.lift_code = catalogMatch.lift_code;
    return { enriched, warning: null };
  }

  enriched.canonical_exercise = '';
  enriched.muscle_group = '';
  enriched.lift_code = '';
  return {
    enriched,
    warning: `No catalog match for exercise '${rowObj.exercise}'.` 
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

  const formattedRows = logRows.map(row => {
    const rowObj = normalizeLogRow(row, topLevelSessionId, topLevelDate);
    const { enriched, warning } = enrichLogRow(rowObj, catalogMap);
    if (warning) warnings.push(warning);
    return logRowObjectToArray(enriched);
  });

  return { formattedRows, warnings };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'atlas-workout-updater' });
});

app.get('/routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach(mw => {
    if (!mw.route) return;
    const methods = Object.keys(mw.route.methods).map(m => m.toUpperCase());
    routes.push({ path: mw.route.path, methods });
  });
  res.json({ status: 'ok', routes });
});

app.get('/version', (req, res) => {
  let gitVersion = 'unknown';
  try {
    gitVersion = execSync('git describe --always --dirty', { encoding: 'utf8' }).trim();
  } catch (err) {
    // ignore
  }

  const routes = [];
  app._router.stack.forEach(mw => {
    if (!mw.route) return;
    const methods = Object.keys(mw.route.methods).map(m => m.toUpperCase());
    routes.push({ path: mw.route.path, methods });
  });

  res.json({
    status: 'ok',
    version: gitVersion,
    deployed_at: deploymentTimestamp,
    endpoints: routes
  });
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
    return res.status(500).json({ error: `Failed to parse workout image: ${error.message}` });
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

    return res.status(200).json(responseBody);
  } catch (error) {
    return res.status(500).json({ error: `Failed to complete workout ingestion: ${error.message}` });
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
    return res.status(400).json({ error: 'Invalid JSON payload. A JSON object is required.' });
  }

  const { session_id, date, log_rows, effort_row } = payload;

  console.log('Received payload:', { session_id, date, log_rows, effort_row });

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
    return res.status(500).json({ error: 'Failed to append workout data.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Atlas Workout Updater listening on port ${port}`);
});
