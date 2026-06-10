function normalizeExerciseKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, '')
    .replace(/[()\[\]{}:;,.\/\\+*?^$|]/g, '')
    .replace(/\s+/g, ' ');
}

function buildExerciseCatalogMap(rows) {
  if (!rows.length) return new Map();

  const header = rows[0].map(cell => String(cell || '').trim().toLowerCase());
  const originalVariantsIndex = header.findIndex(value => ['original_variants', 'original variants', 'originalvariant', 'original variant'].includes(value));
  const exerciseIndex = header.findIndex(value => ['exercise', 'exercise_name', 'exercise name'].includes(value));
  const canonicalNameIndex = header.findIndex(value => ['canonical_name', 'canonical name', 'canonicalname', 'canonical_exercise', 'canonical exercise', 'canonicalexercise'].includes(value));
  const muscleGroupIndex = header.findIndex(value => ['muscle_group', 'muscle group', 'musclegroup'].includes(value));
  const liftCodeIndex = header.findIndex(value => ['lift code', 'lift_code', 'liftcode'].includes(value));

  if (canonicalNameIndex === -1 && exerciseIndex === -1) {
    throw new Error('Exercise_Catalog header must include Exercise or Canonical_Name.');
  }

  const entryMap = new Map();
  const knownMuscleGroups = new Set(['chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'full body', 'glutes']);
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const exerciseName = exerciseIndex === -1 ? '' : String(row[exerciseIndex] || '').trim();
    const canonicalName = String(row[canonicalNameIndex] || exerciseName).trim();
    if (!canonicalName) continue;

    const muscleGroup = String(row[muscleGroupIndex] || '').trim();
    const liftCode = String(row[liftCodeIndex] || '').trim();
    const looksLikeOldMisalignedRow =
      knownMuscleGroups.has(normalizeExerciseKey(exerciseName)) &&
      /\d/.test(muscleGroup) &&
      /^\d+$/.test(liftCode) &&
      normalizeExerciseKey(canonicalName) !== normalizeExerciseKey(exerciseName);
    if (looksLikeOldMisalignedRow) continue;

    const addMatch = name => {
      const key = normalizeExerciseKey(name);
      if (!key) return;
      if (!entryMap.has(key)) {
        entryMap.set(key, { canonical_exercise: canonicalName, muscle_group: muscleGroup, lift_code: liftCode || '' });
      }
    };

    addMatch(canonicalName);
    addMatch(exerciseName);
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
  return { enriched, warnings: [`Unknown exercise: ${rowObj.exercise}`] };
}

function closestExerciseMatches(input, catalogMap, limit = 5) {
  const normalizedInput = normalizeExerciseKey(input);
  if (!normalizedInput) return [];

  const candidates = Array.from(catalogMap.entries()).map(([key, value]) => ({ key, value }));
  const scored = candidates.map(item => {
    const starts = item.key.startsWith(normalizedInput) ? 0 : 1;
    const includes = item.key.includes(normalizedInput) ? 0 : 1;
    const distance = Math.abs(item.key.length - normalizedInput.length);
    return { ...item, score: starts * 100 + includes * 10 + distance };
  });

  return scored
    .sort((a, b) => a.score - b.score || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map(({ key, value }) => ({ normalized_key: key, canonical_exercise: value.canonical_exercise, muscle_group: value.muscle_group, lift_code: value.lift_code }));
}

module.exports = { normalizeExerciseKey, buildExerciseCatalogMap, enrichLogRow, closestExerciseMatches };
