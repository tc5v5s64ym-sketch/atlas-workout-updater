const { logCleanedColumns } = require('../config/columns');

let getExerciseCatalog;
let normalizeLogRow;

function configureExerciseEnrichment(dependencies) {
  getExerciseCatalog = dependencies.getExerciseCatalog;
  normalizeLogRow = dependencies.normalizeLogRow;
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
      return rowObj.notes === undefined || rowObj.notes === null ? '' : rowObj.notes;
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

async function enrichAndFormatLogRows(logRows, topLevelSessionId, topLevelDate) {
  if (!getExerciseCatalog || !normalizeLogRow) {
    throw new Error('Exercise enrichment dependencies have not been configured.');
  }

  let catalogMap;
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

module.exports = {
  configureExerciseEnrichment,
  normalizeExerciseKey,
  buildExerciseCatalogMap,
  buildExerciseCatalogEntries,
  enrichLogRow,
  logRowObjectToArray,
  enrichAndFormatLogRows
};
