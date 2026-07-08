'use strict';

// Unit tests for the controlled Exercise_Catalog maintenance planner
// (scripts/catalog-maintenance.js). These exercise the PURE planning logic only
// — no network, no credentials, no Sheets write. They prove the safety contract:
// duplicate detection, validation, column mapping, and tab guarding.

const test = require('node:test');
const assert = require('node:assert');

const {
  planCatalogAppend,
  planSheetSync,
  resolveColumns,
  buildExistingIdentitySet,
  rowToCells,
  parseArgs,
  CATALOG_TAB,
  PROTECTED_TABS
} = require('../scripts/catalog-maintenance');

// The live production header (verified 2026-06-29).
const HEADER = ['Canonical_Name', 'Muscle_Group', 'Lift_Code', 'Original_Variants'];

// A small slice mirroring the real catalog, including the five campaign lifts.
const EXISTING = [
  ['Incline Bench Press', 'Chest', 'IBP01', 'Incline Bench Press, Incline Barbell Bench'],
  ['Decline Bench Press', 'Chest', 'DBP01', 'Decline Bench Press, Decline Barbell Bench'],
  ['Cable Tricep Pushdown', 'Arms', 'CTP01', 'Cable Tricep Pushdown, Tricep Pushdown'],
  ['Romanian Deadlift', 'Posterior Chain', 'RDL01', 'Romanian Deadlift, RDL, RDLs'],
  ['Bicep Curl', 'Biceps', 'BC01', 'Bicep Curl, Bicep Curls, Biceps Curl, Biceps Curls']
];

test('catalog-maintenance: resolveColumns maps the live header', () => {
  const cols = resolveColumns(HEADER);
  assert.deepEqual(cols, { canonical: 0, muscle: 1, code: 2, variants: 3 });
});

test('catalog-maintenance: resolveColumns accepts legacy header spellings', () => {
  const cols = resolveColumns(['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise']);
  // When both columns exist, Canonical_Exercise wins over Exercise — same priority
  // the enrichment reader uses (canonicalName || exerciseName).
  assert.equal(cols.canonical, 3);
  assert.equal(cols.muscle, 1);
  assert.equal(cols.code, 2);
  // A header with only "Exercise" still resolves it as canonical.
  assert.equal(resolveColumns(['Exercise', 'Muscle_Group']).canonical, 0);
});

test('catalog-maintenance: all five campaign lifts are detected as duplicates (canonical match)', () => {
  const inputs = EXISTING.map(r => ({ canonical_name: r[0], muscle_group: r[1], lift_code: r[2] }));
  const { toWrite, skipped } = planCatalogAppend(HEADER, EXISTING, inputs);
  assert.equal(toWrite.length, 0, 'nothing new to write — all present');
  assert.equal(skipped.length, 5);
});

test('catalog-maintenance: a variant match (not just canonical) blocks a write', () => {
  // "RDLs" is only listed as a VARIANT of Romanian Deadlift, never a canonical.
  const inputs = [{ canonical_name: 'RDLs', muscle_group: 'Legs' }];
  const { toWrite, skipped } = planCatalogAppend(HEADER, EXISTING, inputs);
  assert.equal(toWrite.length, 0);
  assert.match(skipped[0].reason, /already in catalog/);
});

test('catalog-maintenance: a genuinely new lift is planned for write with correctly positioned cells', () => {
  const inputs = [{ canonical_name: 'Pec Deck', muscle_group: 'Chest', lift_code: 'PD01', original_variants: 'Pec Deck, Machine Fly' }];
  const { toWrite, skipped } = planCatalogAppend(HEADER, EXISTING, inputs);
  assert.equal(skipped.length, 0);
  assert.equal(toWrite.length, 1);
  assert.deepEqual(toWrite[0].cells, ['Pec Deck', 'Chest', 'PD01', 'Pec Deck, Machine Fly']);
});

test('catalog-maintenance: variants default to the canonical name when omitted', () => {
  const inputs = [{ canonical_name: 'Pendlay Row', muscle_group: 'Back' }];
  const { toWrite } = planCatalogAppend(HEADER, EXISTING, inputs);
  assert.deepEqual(toWrite[0].cells, ['Pendlay Row', 'Back', '', 'Pendlay Row']);
});

test('catalog-maintenance: rows missing canonical_name or muscle_group are rejected, not written', () => {
  const inputs = [
    { canonical_name: '', muscle_group: 'Chest' },
    { canonical_name: 'No Muscle', muscle_group: '' }
  ];
  const { toWrite, invalid } = planCatalogAppend(HEADER, EXISTING, inputs);
  assert.equal(toWrite.length, 0);
  assert.equal(invalid.length, 2);
});

test('catalog-maintenance: a duplicate WITHIN one batch is collapsed to a single write', () => {
  const inputs = [
    { canonical_name: 'Sissy Squat', muscle_group: 'Quads' },
    { canonical_name: 'Sissy Squat', muscle_group: 'Quads' }
  ];
  const { toWrite, skipped } = planCatalogAppend(HEADER, EXISTING, inputs);
  assert.equal(toWrite.length, 1, 'only the first instance is written');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /within this batch/);
});

test('catalog-maintenance: matching is case/space-insensitive', () => {
  const inputs = [{ canonical_name: '  bICEP   curl ', muscle_group: 'Biceps' }];
  const { toWrite } = planCatalogAppend(HEADER, EXISTING, inputs);
  assert.equal(toWrite.length, 0, 'normalized identity still matches the existing Bicep Curl');
});

test('catalog-maintenance: planner throws if no canonical column exists', () => {
  assert.throws(() => planCatalogAppend(['Foo', 'Bar'], [], [{ canonical_name: 'X', muscle_group: 'Y' }]),
    /no recognizable Canonical_Name/);
});

test('catalog-maintenance: planner throws if no muscle column exists (never silently drop muscle_group)', () => {
  assert.throws(() => planCatalogAppend(['Canonical_Name', 'Lift_Code'], [], [{ canonical_name: 'X', muscle_group: 'Y' }]),
    /no recognizable Muscle_Group/);
});

test('catalog-maintenance: only targets Exercise_Catalog; protected tabs are listed', () => {
  assert.equal(CATALOG_TAB, 'Exercise_Catalog');
  for (const t of ['Log_Cleaned', 'Effort', 'Bug_Reports']) {
    assert.ok(PROTECTED_TABS.includes(t), `${t} must be a protected tab`);
  }
});

test('catalog-maintenance: parseArgs defaults to dry-run (confirm=false) and the catalog tab', () => {
  assert.deepEqual(parseArgs(['--file', 'rows.json']), { confirm: false, file: 'rows.json', tab: 'Exercise_Catalog', syncSheet: false });
  assert.equal(parseArgs(['--file', 'rows.json', '--confirm']).confirm, true);
  assert.equal(parseArgs(['--sync-sheet']).syncSheet, true, '--sync-sheet flag parses');
  assert.equal(parseArgs(['--sync-sheet']).confirm, false, '--sync-sheet never implies a write');
});

// ── planSheetSync (PR-15 dry-run reconciliation, JSON source vs sheet view) ──────

// The JSON source carries only `name` (+ primary_muscles); no lift_code/muscle_group.
const JSON_CATALOG = [
  { exercise_id: 'barbell_bench_press', name: 'Bench Press', primary_muscles: ['chest'] },
  { exercise_id: 'romanian_deadlift', name: 'Romanian Deadlift', primary_muscles: ['hamstrings'] },
  { exercise_id: 'overhead_press', name: 'Overhead Press', primary_muscles: ['front_delts'] },
];

test('catalog-maintenance: planSheetSync reports source exercises missing from the sheet', () => {
  const sheet = [
    ['Bench Press', 'Chest', 'BEN01', 'Bench Press, Flat Bench'],
    // Romanian Deadlift + Overhead Press are in the JSON source but not the sheet.
  ];
  const plan = planSheetSync(JSON_CATALOG, HEADER, sheet);
  const missing = plan.missingFromSheet.map(m => m.name).sort();
  assert.deepEqual(missing, ['Overhead Press', 'Romanian Deadlift']);
  assert.equal(plan.inSync, false);
  // It surfaces primary_muscles as a hint (never fabricates a Muscle_Group value).
  const rdl = plan.missingFromSheet.find(m => m.name === 'Romanian Deadlift');
  assert.deepEqual(rdl.primary_muscles, ['hamstrings']);
});

test('catalog-maintenance: planSheetSync counts a JSON name matched by a sheet VARIANT as present', () => {
  const sheet = [
    ['Bench Press', 'Chest', 'BEN01', 'Bench Press'],
    // "RDL" is the sheet canonical, but "Romanian Deadlift" is a listed variant —
    // so the JSON "Romanian Deadlift" is represented and must NOT be flagged missing.
    ['RDL', 'Posterior Chain', 'RDL01', 'RDL, Romanian Deadlift, RDLs'],
    ['Overhead Press', 'Shoulders', 'OHP01', 'Overhead Press'],
  ];
  const plan = planSheetSync(JSON_CATALOG, HEADER, sheet);
  assert.deepEqual(plan.missingFromSheet, [], 'variant coverage prevents a false "missing"');
  // "RDL" is a sheet canonical with no JSON source name -> reported as extra.
  assert.deepEqual(plan.extraInSheet, ['RDL']);
});

test('catalog-maintenance: planSheetSync reports inSync when identities align', () => {
  const sheet = [
    ['Bench Press', 'Chest', 'BEN01', 'Bench Press'],
    ['Romanian Deadlift', 'Posterior Chain', 'RDL01', 'Romanian Deadlift, RDL'],
    ['Overhead Press', 'Shoulders', 'OHP01', 'Overhead Press, OHP'],
  ];
  const plan = planSheetSync(JSON_CATALOG, HEADER, sheet);
  assert.equal(plan.inSync, true);
  assert.deepEqual(plan.missingFromSheet, []);
  assert.deepEqual(plan.extraInSheet, []);
});

test('catalog-maintenance: planSheetSync never writes — it is a pure planner returning a diff', () => {
  // Contract guard: the function has no side effects and returns only report data.
  const plan = planSheetSync(JSON_CATALOG, HEADER, []);
  assert.ok(Array.isArray(plan.missingFromSheet) && Array.isArray(plan.extraInSheet));
  assert.equal(plan.jsonCount, 3);
  assert.equal(plan.sheetCount, 0);
});

test('catalog-maintenance: buildExistingIdentitySet / rowToCells helpers behave', () => {
  const cols = resolveColumns(HEADER);
  const set = buildExistingIdentitySet(EXISTING, cols);
  assert.ok(set.has('bicep curl'));
  assert.ok(set.has('rdls'), 'variant identities are indexed too');
  assert.deepEqual(rowToCells({ canonical_name: 'A', muscle_group: 'B', lift_code: 'C01', original_variants: 'A, a2' }, cols),
    ['A', 'B', 'C01', 'A, a2']);
});
