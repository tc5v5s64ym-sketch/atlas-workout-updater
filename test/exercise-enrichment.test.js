const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeExerciseKey,
  generateLiftCode,
  makeLiftCodeRegistry,
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

// Acceptance tests for unique generated lift codes (the collision fix)
test('lift code uniqueness: two unknown exercises colliding on prefix get distinct codes (01/02)', () => {
  const map = fakeCatalog(); // or empty; doesn't matter for pure unknowns
  // clear for safety
  const reg = makeLiftCodeRegistry();
  // "Big Press" and "Bar Press" both -> BPX01 base via first letters
  const ra = enrichLogRow({ exercise: 'Big Press' }, new Map(), reg);
  const rb = enrichLogRow({ exercise: 'Bar Press' }, new Map(), reg);
  assert.equal(ra.enriched.lift_code, 'BPX01');
  assert.equal(rb.enriched.lift_code, 'BPX02');
  assert.notEqual(ra.enriched.lift_code, rb.enriched.lift_code);
});

test('lift code uniqueness: single / non-colliding unknown keeps 01', () => {
  const reg = makeLiftCodeRegistry();
  const r = enrichLogRow({ exercise: 'Solo Lift' }, new Map(), reg);
  assert.equal(r.enriched.lift_code, 'SLX01');
});

test('lift code uniqueness: catalog or row-provided codes win and are untouched', () => {
  const map = fakeCatalog();
  const reg = makeLiftCodeRegistry();
  const cat = enrichLogRow({ exercise: 'Bench Press' }, map, reg);
  assert.equal(cat.enriched.lift_code, 'BEN01'); // from catalog, not generated

  const prov = enrichLogRow({ exercise: 'Mystery', lift_code: 'MYS42' }, new Map(), reg);
  assert.equal(prov.enriched.lift_code, 'MYS42');
});

test('lift code uniqueness: same input set of names yields identical codes across runs (deterministic via name sort)', () => {
  const names = ['Big Press', 'Bar Press', 'Solo'];
  const run = () => {
    const reg = makeLiftCodeRegistry();
    const items = names.map(n => ({ exercise: n }));
    // simulate pre-claim sorted
    const sorted = [...items].sort((a, b) => normalizeExerciseKey(a.exercise).localeCompare(normalizeExerciseKey(b.exercise)));
    sorted.forEach(it => enrichLogRow(it, new Map(), reg));
    return names.map(n => enrichLogRow({ exercise: n }, new Map(), reg).enriched.lift_code);
  };
  const codesA = run();
  const codesB = run();
  assert.deepEqual(codesA, codesB);
  // names order: Big, Bar, Solo ; Bar lex-first among BPX group so gets 01, Big gets 02
  assert.equal(codesA[0], 'BPX02'); // Big Press
  assert.equal(codesA[1], 'BPX01'); // Bar Press (lex smaller)
  assert.equal(codesA[2], 'SOL01');
});

// ── Curl alias/code consistency ─────────────────────────────────────────────
// Flight Recorder evidence: curls scattered across BC01 / CRL01 ("Atlas doesn't
// know what curls are"). The catalog fragments the same movement across two rows —
// "Bicep Curl" (BC01) and "Dumbbell Curl" (CRL01) — and plain curl/curls is in
// neither variant list. All generic bicep-curl inputs must unify to BC01 while the
// genuinely-distinct curls keep their own codes.
const curlCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Bicep Curl', 'Biceps', 'BC01', 'Bicep Curl', 'bicep curl|bicep curls|biceps curl|biceps curls'],
  ['Dumbbell Curl', 'Biceps', 'CRL01', 'Dumbbell Curl', 'dumbbell curl|dumbbell curls|db curl|db curls'],
  ['Barbell Curl', 'Biceps', 'BBC01', 'Barbell Curl', 'barbell curl|barbell curls'],
  ['Hammer Curls', 'Biceps', 'HAM01', 'Hammer Curls', 'hammer curls|hammer curl'],
  ['Leg Curl', 'Hamstrings', 'LC01', 'Leg Curl', 'leg curl|hamstring curl'],
  ['Preacher Curl', 'Biceps', 'PRC01', 'Preacher Curl', 'preacher curl|preacher curls']
];
function curlCatalog() { return buildExerciseCatalogMap(curlCatalogRows); }

test('curl aliases unify to Bicep Curl / BC01 (curl, curls, bicep, dumbbell, db)', () => {
  const map = curlCatalog();
  for (const input of ['curl', 'curls', 'Curls', 'bicep curl', 'biceps curls', 'dumbbell curl', 'dumbbell curls', 'DB Curls']) {
    const { enriched } = enrichLogRow({ exercise: input }, map);
    assert.equal(enriched.lift_code, 'BC01', `"${input}" must map to BC01`);
    assert.equal(enriched.canonical_exercise, 'Bicep Curl', `"${input}" canonical must be Bicep Curl`);
  }
});

test('distinct curls keep their own codes (unrelated mappings unchanged)', () => {
  const map = curlCatalog();
  const cases = [
    ['barbell curl', 'BBC01', 'Barbell Curl'],
    ['hammer curls', 'HAM01', 'Hammer Curls'],
    ['leg curl', 'LC01', 'Leg Curl'],
    ['preacher curl', 'PRC01', 'Preacher Curl']
  ];
  for (const [input, code, canon] of cases) {
    const { enriched } = enrichLogRow({ exercise: input }, map);
    assert.equal(enriched.lift_code, code, `"${input}" must stay ${code}`);
    assert.equal(enriched.canonical_exercise, canon);
  }
});

test('curl fallback (no catalog code) resolves to BC01 via generateLiftCode', () => {
  for (const input of ['curl', 'curls', 'bicep curl', 'dumbbell curl', 'db curls']) {
    assert.equal(generateLiftCode(input), 'BC01', `"${input}" fallback must be BC01`);
  }
});
