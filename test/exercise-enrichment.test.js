const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeExerciseKey,
  generateLiftCode,
  buildExerciseCatalogMap,
  enrichLogRow,
  closestExerciseMatches
} = require('../services/exerciseEnrichment');

const catalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench|flat bench|barbell bench'],
  ['Back Squat', 'Quads', 'SQ01', 'Back Squat', 'squat|squats'],
  ['Lat Pulldown', 'Back', 'LPD01', 'Lat Pulldown', 'lats|lat pull'],
  ['Dips (Weighted)', 'Chest', 'DIP01', 'Dips (Weighted)', 'weighted dips|dips weighted'],
  ['Cable Row', 'Back', 'ROW02', 'Cable Row', 'cable row']
];

function fakeCatalog() {
  return buildExerciseCatalogMap(catalogRows);
}

test('normalizeExerciseKey locks current casing, punctuation and whitespace behavior', () => {
  assert.equal(normalizeExerciseKey('  Bench, Press!!  '), 'bench press!!');
  assert.equal(normalizeExerciseKey('Lat/Pulldown + Cable'), 'latpulldown cable');
  assert.equal(normalizeExerciseKey('DIPS (Weighted)'), 'dips weighted');
  assert.equal(normalizeExerciseKey(''), '');
  assert.equal(normalizeExerciseKey(null), '');
});

test('generateLiftCode locks known overrides and deterministic fallbacks', () => {
  assert.equal(generateLiftCode('Bench Press'), 'BEN01');
  assert.equal(generateLiftCode('Back Squat'), 'SQ01');
  assert.equal(generateLiftCode('Cable Goblin Raises'), 'CGR01');
  assert.equal(generateLiftCode('Pullover'), 'PUL01');
  assert.equal(generateLiftCode(''), 'UNK01');
});

test('buildExerciseCatalogMap indexes canonical names, variants, and duplicate lift-code rows', () => {
  const map = fakeCatalog();
  assert.equal(map.get('bench press').lift_code, 'BEN01');
  assert.equal(map.get('flat bench').canonical_exercise, 'Bench Press');
  assert.equal(map.get('squats').canonical_exercise, 'Back Squat');
  assert.equal(map.get('dips weighted').canonical_exercise, 'Dips (Weighted)');

  const duplicateCodeMap = buildExerciseCatalogMap([
    ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'],
    ['Cable Row', 'Back', 'ROW01', 'Cable Row'],
    ['Seated Row', 'Back', 'ROW01', 'Seated Row']
  ]);
  assert.equal(duplicateCodeMap.get('cable row').lift_code, 'ROW01');
  assert.equal(duplicateCodeMap.get('seated row').lift_code, 'ROW01');
});

test('enrichLogRow locks clean, fuzzy and unknown row behavior', () => {
  const map = fakeCatalog();

  const exact = enrichLogRow({ exercise: 'Bench Press', weight: 225, reps: 5 }, map);
  assert.equal(exact.enriched.canonical_exercise, 'Bench Press');
  assert.equal(exact.enriched.muscle_group, 'Chest');
  assert.equal(exact.enriched.lift_code, 'BEN01');
  assert.equal(exact.warnings, null);

  const fuzzy = enrichLogRow({ exercise: 'Bench', weight: 225, reps: 5 }, map);
  assert.equal(fuzzy.enriched.canonical_exercise, 'Bench Press');
  assert.equal(fuzzy.enriched.lift_code, 'BEN01');
  assert.match(fuzzy.autoMatch, /Bench Press/);

  const unknown = enrichLogRow({ exercise: 'Zercher Cyclone', weight: 100, reps: 8 }, map);
  assert.equal(unknown.enriched.canonical_exercise, 'Zercher Cyclone');
  assert.equal(unknown.enriched.muscle_group, 'Unknown');
  assert.equal(unknown.enriched.lift_code, 'ZCX01');
  assert.match(unknown.warnings[0], /^Unknown exercise:/);
});

test('closestExerciseMatches ranks likely catalog matches', () => {
  const matches = closestExerciseMatches('bench', fakeCatalog(), 3);
  assert.equal(matches[0].canonical_exercise, 'Bench Press');
  assert.equal(matches[0].lift_code, 'BEN01');
  assert.ok(matches.length <= 3);
});

test('edge cases: empty catalogs and odd names stay deterministic', () => {
  assert.deepEqual(buildExerciseCatalogMap([]), new Map());
  assert.equal(normalizeExerciseKey(' Café PRESS '), 'café press');
  assert.equal(normalizeExerciseKey('Incline-DB/Press'), 'incline-dbpress');
  assert.equal(generateLiftCode(' Café Press '), 'CPX01');
  assert.equal(generateLiftCode(12345), '12301');

  const emptyCatalog = new Map();
  const whitespace = enrichLogRow({ exercise: '   ' }, emptyCatalog);
  assert.equal(whitespace.enriched.canonical_exercise, '   ');
  assert.equal(whitespace.enriched.muscle_group, 'Unknown');
  assert.equal(whitespace.enriched.lift_code, 'UNK01');

  const objectName = enrichLogRow({ exercise: { toString: () => 'Object Press' } }, emptyCatalog);
  assert.equal(objectName.enriched.lift_code, 'OPX01');
});

test('edge cases: malformed catalog and garbage rows do not crash or blank lift_code', () => {
  assert.doesNotThrow(() => buildExerciseCatalogMap(null));
  assert.equal(buildExerciseCatalogMap(null).size, 0);

  const malformed = buildExerciseCatalogMap([
    ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'],
    null,
    [],
    ['Back Squat', 'Quads', '', 'Back Squat']
  ]);
  assert.equal(malformed.get('back squat').canonical_exercise, 'Back Squat');

  const garbageInputs = [
    null,
    undefined,
    {},
    { exercise: null },
    { exercise: '', lift_code: '' }
  ];

  for (const row of garbageInputs) {
    const result = enrichLogRow(row, malformed);
    assert.ok(result.enriched.lift_code, 'lift_code must never be blank');
    assert.equal(result.enriched.muscle_group || 'Unknown', result.enriched.muscle_group);
  }
});

test('edge cases: closestExerciseMatches handles empty input or catalog', () => {
  assert.deepEqual(closestExerciseMatches('', fakeCatalog()), []);
  assert.deepEqual(closestExerciseMatches('bench', new Map()), []);
  assert.deepEqual(closestExerciseMatches('bench', null), []);
});
