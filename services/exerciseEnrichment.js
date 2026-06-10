function normalizeExerciseKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/[()\[\]{}:;,.\/\\+*?^$|]/g, '')
    .replace(/\s+/g, ' ');
}

// Well-known gym abbreviations that substring matching cannot resolve on its own.
// Maps normalized shorthand → normalized catalog key to look up.
const SHORTHAND_EXPANSIONS = {
  ohp: 'overhead press',
  rdl: 'romanian deadlift',
  sldl: 'stiff leg deadlift',
  cgbp: 'close grip bench press',
  hnr: 'hanging knee raises',
  hkr: 'hanging knee raises',
  dl: 'deadlift',
  bp: 'bench press',
};

const PREFERRED_ALIAS_TARGETS = {
  bench: ['bench press'],
  dips: ['dips weighted', 'weighted dips', 'dips'],
  lateral: ['lateral raises', 'lateral raise'],
  laterals: ['lateral raises', 'lateral raise'],
  lats: ['lat pulldown', 'lat pulldowns']
};

function findPreferredAliasMatch(normalizedKey, catalogMap) {
  const targets = PREFERRED_ALIAS_TARGETS[normalizedKey];
  if (!targets) return null;

  for (const target of targets) {
    const exactTarget = catalogMap.get(target);
    if (exactTarget) return { entry: exactTarget };
  }

  for (const target of targets) {
    for (const entry of catalogMap.values()) {
      if (normalizeExerciseKey(entry.canonical_exercise) === target) {
        return { entry };
      }
    }
  }

  return normalizedKey === 'lats' ? { blocked: true } : null;
}

// Returns { entry, autoMatch } when a non-exact match is found, or null.
// Priority: plural→singular exact → abbreviation expansion → substring containment.
function findFuzzyMatch(normalizedKey, catalogMap) {
  // 1. plural → singular  (squats → squat, dips → dip, curls → curl)
  if (normalizedKey.endsWith('s') && normalizedKey.length > 3) {
    const singular = normalizedKey.slice(0, -1);
    const hit = catalogMap.get(singular);
    if (hit) return { entry: hit };
  }

  // 2. known abbreviation expansion
  const expanded = SHORTHAND_EXPANSIONS[normalizedKey];
  if (expanded) {
    const hit = catalogMap.get(expanded);
    if (hit) return { entry: hit };
  }

  // 3. input (or its singular) is a substring of a catalog key
  //    "bench" ⊂ "bench press", "lateral" ⊂ "lateral raise"
  const searchKey = (normalizedKey.endsWith('s') && normalizedKey.length > 3)
    ? normalizedKey.slice(0, -1)
    : normalizedKey;

  if (searchKey.length >= 4) {
    const subMatches = [];
    for (const [catalogKey, entry] of catalogMap.entries()) {
      if (catalogKey.includes(searchKey)) subMatches.push({ catalogKey, entry });
    }
    if (subMatches.length > 1) {
      return {
        ambiguous: true,
        alternatives: subMatches
          .slice(0, 5)
          .map(m => m.entry.canonical_exercise)
      };
    }
    if (subMatches.length === 1) {
      // prefer the shortest matching catalog key (most specific / least padded)
      const best = subMatches[0];
      return {
        entry: best.entry
      };
    }
  }

  return null;
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

  const preferredAlias = findPreferredAliasMatch(key, catalogMap);
  if (preferredAlias) {
    if (!preferredAlias.entry) {
      return {
        enriched: { ...rowObj, canonical_exercise: '', muscle_group: '', lift_code: '' },
        warnings: [`Unknown exercise: ${rowObj.exercise}`]
      };
    }
    const enriched = { ...rowObj,
      canonical_exercise: preferredAlias.entry.canonical_exercise,
      muscle_group: preferredAlias.entry.muscle_group,
      lift_code: preferredAlias.entry.lift_code || ''
    };
    const autoMatch = `"${rowObj.exercise}" â†’ "${preferredAlias.entry.canonical_exercise}"`;
    const warnings = preferredAlias.entry.lift_code ? null : [`No lift code for exercise '${rowObj.exercise}'.`];
    return { enriched, warnings, autoMatch };
  }

  // Exact match (includes any variants already indexed in the map)
  const exactMatch = catalogMap.get(key);
  if (exactMatch) {
    const enriched = { ...rowObj,
      canonical_exercise: exactMatch.canonical_exercise,
      muscle_group: exactMatch.muscle_group,
      lift_code: exactMatch.lift_code || ''
    };
    const warnings = exactMatch.lift_code ? null : [`No lift code for exercise '${rowObj.exercise}'.`];
    return { enriched, warnings };
  }

  // Fuzzy fallback: plural, abbreviation, substring
  const fuzzy = findFuzzyMatch(key, catalogMap);
  if (fuzzy) {
    if (!fuzzy.entry) {
      return {
        enriched: { ...rowObj, canonical_exercise: '', muscle_group: '', lift_code: '' },
        warnings: [`Ambiguous exercise match: ${rowObj.exercise} could be ${fuzzy.alternatives.join(', ')}`]
      };
    }
    const enriched = { ...rowObj,
      canonical_exercise: fuzzy.entry.canonical_exercise,
      muscle_group: fuzzy.entry.muscle_group,
      lift_code: fuzzy.entry.lift_code || ''
    };
    const autoMatch = `"${rowObj.exercise}" → "${fuzzy.entry.canonical_exercise}"`;
    const warnings = fuzzy.entry.lift_code ? null : [`No lift code for exercise '${rowObj.exercise}'.`];
    return { enriched, warnings, autoMatch };
  }

  return {
    enriched: { ...rowObj, canonical_exercise: '', muscle_group: '', lift_code: '' },
    warnings: [`Unknown exercise: ${rowObj.exercise}`]
  };
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
