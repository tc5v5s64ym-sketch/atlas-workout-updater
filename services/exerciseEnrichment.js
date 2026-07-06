function normalizeExerciseKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[''""]/g, '')
    .replace(/[()\[\]{}:;,.\/\\+*?^$|]/g, '')
    .replace(/\s+/g, ' ');
}

// Deterministic lift-code overrides for exercises that are common enough to
// always map to the same code even when the catalog row has a blank code cell.
const knownLiftCodeOverrides = new Map([
  ['bench', 'BEN01'], ['bench press', 'BEN01'], ['flat bench', 'BEN01'], ['barbell bench press', 'BEN01'],
  ['back squat', 'SQ01'], ['squat', 'SQ01'],
  ['deadlift', 'DL01'],
  ['romanian deadlift', 'RDL01'], ['rdl', 'RDL01'],
  ['elliptical', 'ELL01'],
  ['seated row', 'ROW01'], ['seated rows', 'ROW01'],
  ['lat pull', 'LAT01'], ['lat pulls', 'LAT01'], ['lat pulldown', 'LAT01'], ['lat pulldowns', 'LAT01'],
  ['dip', 'DIP01'], ['dips', 'DIP01'], ['weighted dip', 'DIP01'], ['weighted dips', 'DIP01'],
  ['face pull', 'FP01'], ['face pulls', 'FP01'],
  ['lateral raise', 'LRA01'], ['lateral raises', 'LRA01'], ['laterals', 'LRA01'],
  ['hammer curl', 'HC01'], ['hammer curls', 'HC01'], ['hammers', 'HC01'],
  // Plain "curl"/"curls" and the bicep-curl synonyms default to BC01 when the catalog
  // has no code (mirrors the PREFERRED_ALIAS_TARGETS entry for plain curl/curls, defined
  // below). The distinct "Dumbbell Curl" (CRL01) is intentionally NOT folded in — that's
  // a separate owner taxonomy decision (filed in BACKLOG.md).
  ['bicep curl', 'BC01'], ['bicep curls', 'BC01'], ['biceps curl', 'BC01'], ['biceps curls', 'BC01'],
  ['curl', 'BC01'], ['curls', 'BC01'],
  ['knee raise', 'KR01'], ['knee raises', 'KR01']
]);

// Small registry for tracking used generated lift codes within one batch of rows.
// Ensures colliding unknown exercises get distinct 01/02/.. suffixes while keeping
// generateLiftCode itself pure and unchanged for direct callers/tests.
// The pre-assignment (in sorted name order) makes output independent of input row order.
function makeLiftCodeRegistry() {
  const used = new Set();
  const assigned = new Map(); // normKey -> code (idempotent per name)
  return {
    generate(exerciseName) {
      const norm = normalizeExerciseKey(exerciseName);
      if (assigned.has(norm)) return assigned.get(norm);
      let code = generateLiftCode(exerciseName);
      if (used.has(code)) {
        const prefix = code.slice(0, 3);
        for (let s = 2; s <= 99; s += 1) {
          const cand = `${prefix}${String(s).padStart(2, '0')}`;
          if (!used.has(cand)) {
            code = cand;
            break;
          }
        }
      }
      used.add(code);
      assigned.set(norm, code);
      return code;
    }
  };
}

// Returns a deterministic lift code when the catalog row has no code.
// Known exercises map to the canonical codes above; others get a 3-letter
// initialism prefix so the field is never blank.
function generateLiftCode(exerciseName) {
  const normalized = normalizeExerciseKey(exerciseName);
  if (knownLiftCodeOverrides.has(normalized)) return knownLiftCodeOverrides.get(normalized);

  const ignoredWords = new Set(['a', 'an', 'and', 'the', 'of', 'with', 'to', 'for']);
  const words = String(exerciseName || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !ignoredWords.has(w.toLowerCase()));

  if (words.length === 0) return 'UNK01';

  const prefix = words.length === 1
    ? words[0].slice(0, 3)
    : words.map(w => w[0]).join('').slice(0, 3);

  return `${prefix.padEnd(3, 'X')}01`;
}

// Pick a lift code: catalog -> row-provided -> generated (in that priority).
// Returns { lift_code, generated: true } when we had to generate a fallback.
// registry (optional) enables cross-row uniqueness for generated fallbacks only.
function resolveOrGenerateLiftCode(catalogCode, providedCode, exerciseName, registry = null) {
  if (catalogCode) return { lift_code: catalogCode, generated: false };
  if (providedCode) return { lift_code: providedCode, generated: false };
  const code = registry ? registry.generate(exerciseName) : generateLiftCode(exerciseName);
  return { lift_code: code, generated: true };
}

function fallbackMuscleGroup(muscleGroup) {
  const value = String(muscleGroup || '').trim();
  return value || 'Unknown';
}

// Well-known gym abbreviations that substring matching cannot resolve on its own.
// Maps normalized shorthand -> normalized catalog key to look up.
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
  squat: ['back squat'],
  squats: ['back squat'],
  dips: ['dips weighted', 'weighted dips', 'dips'],
  lateral: ['lateral raises', 'lateral raise'],
  laterals: ['lateral raises', 'lateral raise'],
  lats: ['lat pulldown', 'lat pulldowns'],
  'knee raises': ['hanging knee raises'],
  hammers: ['hammer curls', 'hammer curl'],
  'face pulls': ['face pull'],
  'leg curls': ['leg curl'],
  // Plain "curl" / "curls" is in NO catalog variant list, so it resolved to a
  // generated fallback code and split from the lifter's other bicep-curl rows
  // ("Atlas doesn't know what curls are"). Steer the bare word to the "Bicep Curl"
  // canonical (BC01). Named variants already resolve on their own — "bicep curl" /
  // "biceps curl" exact-match the Bicep Curl row, and distinct curls (barbell /
  // hammer / preacher / leg / dumbbell / cable / EZ-bar / …) keep their own codes.
  // NOTE: folding the distinct "Dumbbell Curl" (CRL01) row into Bicep Curl is a
  // separate product/taxonomy decision (owner-reserved) — filed in BACKLOG.md.
  curl: ['bicep curl'],
  curls: ['bicep curl']
};

const BLOCKED_AMBIGUOUS_ALIASES = new Set(['lats', 'row', 'rows']);

function findPreferredAliasMatch(normalizedKey, catalogMap) {
  const targets = PREFERRED_ALIAS_TARGETS[normalizedKey];
  if (!targets && BLOCKED_AMBIGUOUS_ALIASES.has(normalizedKey)) return { blocked: true };
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

  return BLOCKED_AMBIGUOUS_ALIASES.has(normalizedKey) ? { blocked: true } : null;
}

// Returns { entry, autoMatch } when a non-exact match is found, or null.
// Priority: plural->singular exact -> abbreviation expansion -> substring containment.
function findFuzzyMatch(normalizedKey, catalogMap) {
  // 1. plural -> singular  (squats -> squat, dips -> dip, curls -> curl)
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
  //    "bench" is in "bench press", "lateral" is in "lateral raise"
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
      const best = subMatches[0];
      return { entry: best.entry };
    }
  }

  return null;
}

function buildExerciseCatalogMap(rows) {
  if (!Array.isArray(rows)) return new Map();
  if (!rows.length) return new Map();

  if (!Array.isArray(rows[0])) return new Map();
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
    if (!Array.isArray(row) || row.length === 0) continue;

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

function enrichLogRow(rowObj, catalogMap, registry = null) {
  rowObj = rowObj && typeof rowObj === 'object' ? rowObj : {};
  catalogMap = catalogMap instanceof Map ? catalogMap : new Map();

  const key = normalizeExerciseKey(rowObj.exercise);
  const providedLiftCode = String(rowObj.lift_code || rowObj.liftCode || '').trim();

  const preferredAlias = findPreferredAliasMatch(key, catalogMap);
  if (preferredAlias) {
    if (!preferredAlias.entry) {
      const resolved = resolveOrGenerateLiftCode('', providedLiftCode, rowObj.exercise, registry);
      return {
        enriched: { ...rowObj, canonical_exercise: rowObj.exercise, muscle_group: fallbackMuscleGroup(), lift_code: resolved.lift_code },
        warnings: [
          `Unknown exercise: ${rowObj.exercise}`,
          `Missing catalog muscle group for '${rowObj.exercise}'. Using 'Unknown' until Exercise_Catalog is updated.`,
          ...(resolved.generated ? [`Generated lift code '${resolved.lift_code}' for exercise '${rowObj.exercise}'. Add it to Exercise_Catalog to lock it.`] : [])
        ]
      };
    }
    const resolved = resolveOrGenerateLiftCode(preferredAlias.entry.lift_code, providedLiftCode, preferredAlias.entry.canonical_exercise || rowObj.exercise, registry);
    const enriched = { ...rowObj,
      canonical_exercise: preferredAlias.entry.canonical_exercise,
      muscle_group: fallbackMuscleGroup(preferredAlias.entry.muscle_group),
      lift_code: resolved.lift_code
    };
    const autoMatch = `"${rowObj.exercise}" -> "${preferredAlias.entry.canonical_exercise}"`;
    const warnings = [
      ...(preferredAlias.entry.muscle_group ? [] : [`Missing catalog muscle group for '${preferredAlias.entry.canonical_exercise}'. Using 'Unknown' until Exercise_Catalog is updated.`]),
      ...(resolved.generated ? [`Generated lift code '${resolved.lift_code}' for exercise '${rowObj.exercise}'. Add it to Exercise_Catalog to lock it.`] : [])
    ];
    return { enriched, warnings: warnings.length ? warnings : null, autoMatch };
  }

  // Exact match (includes any variants already indexed in the map)
  const exactMatch = catalogMap.get(key);
  if (exactMatch) {
    const resolved = resolveOrGenerateLiftCode(exactMatch.lift_code, providedLiftCode, exactMatch.canonical_exercise || rowObj.exercise, registry);
    const enriched = { ...rowObj,
      canonical_exercise: exactMatch.canonical_exercise,
      muscle_group: fallbackMuscleGroup(exactMatch.muscle_group),
      lift_code: resolved.lift_code
    };
    const warnings = [
      ...(exactMatch.muscle_group ? [] : [`Missing catalog muscle group for '${exactMatch.canonical_exercise}'. Using 'Unknown' until Exercise_Catalog is updated.`]),
      ...(resolved.generated ? [`Generated lift code '${resolved.lift_code}' for exercise '${rowObj.exercise}'. Add it to Exercise_Catalog to lock it.`] : [])
    ];
    return { enriched, warnings: warnings.length ? warnings : null };
  }

  // Fuzzy fallback: plural, abbreviation, substring
  const fuzzy = findFuzzyMatch(key, catalogMap);
  if (fuzzy) {
    if (!fuzzy.entry) {
      const resolved = resolveOrGenerateLiftCode('', providedLiftCode, rowObj.exercise, registry);
      return {
        enriched: { ...rowObj, canonical_exercise: rowObj.exercise, muscle_group: fallbackMuscleGroup(), lift_code: resolved.lift_code },
        warnings: [
          `Ambiguous exercise match: ${rowObj.exercise} could be ${fuzzy.alternatives.join(', ')}`,
          `Missing catalog muscle group for '${rowObj.exercise}'. Using 'Unknown' until Exercise_Catalog is updated.`,
          ...(resolved.generated ? [`Generated lift code '${resolved.lift_code}' for exercise '${rowObj.exercise}'. Add it to Exercise_Catalog to lock it.`] : [])
        ]
      };
    }
    const resolved = resolveOrGenerateLiftCode(fuzzy.entry.lift_code, providedLiftCode, fuzzy.entry.canonical_exercise || rowObj.exercise, registry);
    const enriched = { ...rowObj,
      canonical_exercise: fuzzy.entry.canonical_exercise,
      muscle_group: fallbackMuscleGroup(fuzzy.entry.muscle_group),
      lift_code: resolved.lift_code
    };
    const autoMatch = `"${rowObj.exercise}" -> "${fuzzy.entry.canonical_exercise}"`;
    const warnings = [
      ...(fuzzy.entry.muscle_group ? [] : [`Missing catalog muscle group for '${fuzzy.entry.canonical_exercise}'. Using 'Unknown' until Exercise_Catalog is updated.`]),
      ...(resolved.generated ? [`Generated lift code '${resolved.lift_code}' for exercise '${rowObj.exercise}'. Add it to Exercise_Catalog to lock it.`] : [])
    ];
    return { enriched, warnings: warnings.length ? warnings : null, autoMatch };
  }

  // No match at all -- generate a lift code so the field is never blank.
  const resolved = resolveOrGenerateLiftCode('', providedLiftCode, rowObj.exercise, registry);
  return {
    enriched: { ...rowObj, canonical_exercise: rowObj.exercise, muscle_group: fallbackMuscleGroup(), lift_code: resolved.lift_code },
    warnings: [
      `Unknown exercise: ${rowObj.exercise}`,
      `Missing catalog muscle group for '${rowObj.exercise}'. Using 'Unknown' until Exercise_Catalog is updated.`,
      ...(resolved.generated ? [`Generated lift code '${resolved.lift_code}' for exercise '${rowObj.exercise}'. Add it to Exercise_Catalog to lock it.`] : [])
    ]
  };
}

function closestExerciseMatches(input, catalogMap, limit = 5) {
  const normalizedInput = normalizeExerciseKey(input);
  if (!normalizedInput) return [];
  if (!(catalogMap instanceof Map)) return [];

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

// Returns the canonical liftCode for a known exercise name using the override table,
// or null for exercises not in the table.
// Used to normalize liftCodes when resolving history across name variants
// (e.g. "Lateral Raise" and "Lateral Raises" both map to "LRA01").
function canonicalLiftCodeFor(exerciseName) {
  if (!exerciseName || typeof exerciseName !== 'string') return null;
  const norm = normalizeExerciseKey(exerciseName);
  return knownLiftCodeOverrides.get(norm) || null;
}

module.exports = {
  normalizeExerciseKey, generateLiftCode, makeLiftCodeRegistry, buildExerciseCatalogMap,
  enrichLogRow, closestExerciseMatches, canonicalLiftCodeFor,
  // Exported for exerciseTruthAudit.js (report-only; not imported by production paths)
  knownLiftCodeOverrides, PREFERRED_ALIAS_TARGETS, SHORTHAND_EXPANSIONS,
};
