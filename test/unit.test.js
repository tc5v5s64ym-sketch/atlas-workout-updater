const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExerciseKey, buildExerciseCatalogMap, enrichLogRow } = require('../services/exerciseEnrichment');
const { normalizeDurationString } = require('../services/duration');
const { recommendNextSet } = require('../services/analytics');
const { logCleanedColumns, effortColumns, exerciseCatalogColumns } = require('../config/columns');
const {
  requiredSheetTabs,
  optionalSheetTabs,
  getMissingRequiredTabs,
  buildSheetContractStatus
} = require('../config/sheetContract');
const { extractDryRunSafetyFields, assertDryRunNoWrite } = require('../scripts/smoke-test-render');

test('required sheet contract excludes Dashboard', () => {
  assert.deepEqual(requiredSheetTabs, ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary']);
  assert.ok(!requiredSheetTabs.includes('Dashboard'));
  assert.ok(optionalSheetTabs.includes('Dashboard'));
});

test('sheet contract accepts Dashboard absent or present as optional', () => {
  const requiredOnly = ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'];
  assert.deepEqual(getMissingRequiredTabs(requiredOnly), []);

  const withDashboard = [...requiredOnly, 'Dashboard'];
  const status = buildSheetContractStatus(withDashboard);
  assert.deepEqual(status.missingRequiredTabs, []);
  assert.equal(status.optional.Dashboard, true);
  assert.equal(status.required.Metadata, true);
});

test('sheet contract reports each missing required tab', () => {
  for (const tab of requiredSheetTabs) {
    const tabs = requiredSheetTabs.filter(candidate => candidate !== tab);
    assert.deepEqual(getMissingRequiredTabs(tabs), [tab]);
  }
  assert.ok(!getMissingRequiredTabs(requiredSheetTabs).includes('Dashboard'));
});

test('column contracts match cleaned sheet headers', () => {
  assert.deepEqual(logCleanedColumns, [
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
    'notes',
    'volume_calc'
  ]);
  assert.equal(logCleanedColumns.indexOf('volume_calc'), 11);
  assert.deepEqual(exerciseCatalogColumns, ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise']);
  assert.deepEqual(effortColumns, [
    'date',
    'session_id',
    'duration',
    'active_calories',
    'total_calories',
    'average_hr',
    'peak_hr',
    'location',
    'notes'
  ]);
});

test('column contracts tolerate derived columns after core ranges', () => {
  const importedHeaders = [...logCleanedColumns, 'e1rm', 'training_block'];
  assert.deepEqual(importedHeaders.slice(0, logCleanedColumns.length), logCleanedColumns);
  assert.equal(importedHeaders[11], 'volume_calc');
});

test('normalizeExerciseKey normalizes punctuation and spacing', () => {
  assert.equal(normalizeExerciseKey(' Back Squat (Barbell) '), 'back squat barbell');
});

test('buildExerciseCatalogMap includes canonical and variants', () => {
  const rows = [
    ['Canonical_Name', 'Muscle_Group', 'Lift Code', 'Original_Variants'],
    ['Back Squat', 'Legs', 'SQ', 'BB Back Squat|Squat']
  ];
  const map = buildExerciseCatalogMap(rows);
  assert.equal(map.get('back squat').lift_code, 'SQ');
  assert.equal(map.get('bb back squat').canonical_exercise, 'Back Squat');
});

test('buildExerciseCatalogMap covers expected cleaned and legacy exercise aliases', () => {
  const rows = [
    ['Canonical_Name', 'Muscle_Group', 'Lift Code', 'Original_Variants'],
    ['Back Squat', 'Quads', 'SQ01', 'squat|back squat'],
    ['Bench Press', 'Chest', 'BEN01', 'bench|bench press'],
    ['Overhead Press', 'Shoulders', 'OHP01', 'OHP|overhead press'],
    ['Lat Pulldown', 'Back', 'LPD01', 'lat pulldown'],
    ['Face Pull', 'Rear Delts', 'FP01', 'face pull|face pulls'],
    ['Hanging Knee Raises', 'Core', 'HNR01', 'knee raises|hanging knee raises'],
    ['Deadlift', 'Posterior Chain', 'DL01', 'deadlift']
  ];
  const map = buildExerciseCatalogMap(rows);
  const expected = [
    ['squat', 'SQ01', 'Quads'],
    ['back squat', 'SQ01', 'Quads'],
    ['bench', 'BEN01', 'Chest'],
    ['bench press', 'BEN01', 'Chest'],
    ['OHP', 'OHP01', 'Shoulders'],
    ['overhead press', 'OHP01', 'Shoulders'],
    ['lat pulldown', 'LPD01', 'Back'],
    ['face pulls', 'FP01', 'Rear Delts'],
    ['knee raises', 'HNR01', 'Core'],
    ['hanging knee raises', 'HNR01', 'Core'],
    ['deadlift', 'DL01', 'Posterior Chain']
  ];

  for (const [alias, liftCode, muscleGroup] of expected) {
    assert.equal(map.get(normalizeExerciseKey(alias)).lift_code, liftCode);
    assert.equal(map.get(normalizeExerciseKey(alias)).muscle_group, muscleGroup);
  }
});

test('buildExerciseCatalogMap supports cleaned Exercise_Catalog headers', () => {
  const rows = [
    ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'],
    ['Hanging Knee Raises', 'Core', 'HNR01', 'Hanging Knee Raises']
  ];
  const map = buildExerciseCatalogMap(rows);
  assert.equal(map.get('hanging knee raises').lift_code, 'HNR01');
  assert.equal(map.get('hanging knee raises').muscle_group, 'Core');
});

test('buildExerciseCatalogMap ignores the old malformed Hanging Knee Raises row shape', () => {
  const rows = [
    ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'],
    ['Core', 'HNR01', '3', 'Hanging Knee Raises'],
    ['Hanging Knee Raises', 'Core', 'HNR01', 'Hanging Knee Raises']
  ];
  const map = buildExerciseCatalogMap(rows);
  assert.equal(map.get('hanging knee raises').lift_code, 'HNR01');
  assert.equal(map.get('hanging knee raises').muscle_group, 'Core');
  assert.notEqual(map.get('core')?.canonical_exercise, 'Hanging Knee Raises');
});

test('enrichLogRow enriches known exercise', () => {
  const map = new Map([['back squat', { canonical_exercise: 'Back Squat', muscle_group: 'Legs', lift_code: 'SQ' }]]);
  const result = enrichLogRow({ exercise: 'Back Squat' }, map);
  assert.equal(result.enriched.lift_code, 'SQ');
});

test('duration normalization supports mm:ss and hh:mm:ss', () => {
  assert.equal(normalizeDurationString('45:30'), '00:45:30');
  assert.equal(normalizeDurationString('1:05:09'), '01:05:09');
  assert.equal(normalizeDurationString('00:45:00'), '00:45:00');
  assert.equal(normalizeDurationString('53:45'), '00:53:45');
  assert.equal(normalizeDurationString(45), '00:45:00');
  assert.equal(normalizeDurationString('45'), '00:45:00');
  assert.equal(normalizeDurationString('53.75'), '00:53:45');
  assert.throws(() => normalizeDurationString('not a duration'), /Invalid duration format/);
});

test('Mission Control extracts dry-run safety fields from top-level or nested response data', () => {
  assert.deepEqual(extractDryRunSafetyFields({
    status: 'ok',
    data: {
      test_mode: true,
      would_write: true,
      sheet_written: false,
      no_write_confirmed: true
    }
  }), {
    test_mode: true,
    would_write: true,
    sheet_written: false,
    no_write_confirmed: true,
    sheet_write: undefined
  });
});

test('Mission Control accepts only explicit no-write dry-run proof', () => {
  assert.doesNotThrow(() => assertDryRunNoWrite({
    status: 'ok',
    test_mode: true,
    would_write: true,
    sheet_written: false,
    no_write_confirmed: true
  }));
  assert.doesNotThrow(() => assertDryRunNoWrite({
    status: 'ok',
    data: {
      data: {
        test_mode: true,
        would_write: true,
        sheet_written: false,
        no_write_confirmed: true
      }
    }
  }));
  assert.doesNotThrow(() => assertDryRunNoWrite({
    status: 'ok',
    test_mode: true,
    would_write: true,
    sheet_write: 'skipped'
  }));
  assert.throws(() => assertDryRunNoWrite({
    status: 'ok',
    test_mode: true,
    would_write: true,
    sheet_written: true,
    no_write_confirmed: true
  }), /sheet_written=true/);
  assert.throws(() => assertDryRunNoWrite({
    status: 'ok',
    test_mode: true,
    would_write: true,
    sheet_written: false,
    no_write_confirmed: false
  }), /explicitly prove no-write/);
  assert.throws(() => assertDryRunNoWrite({
    status: 'ok',
    test_mode: false,
    would_write: true,
    sheet_written: false,
    no_write_confirmed: true
  }), /test_mode=true/);
  assert.throws(() => assertDryRunNoWrite({
    status: 'ok',
    test_mode: true,
    would_write: true
  }), /explicitly prove no-write/);
  assert.throws(() => assertDryRunNoWrite({
    status: 'ok',
    test_mode: true,
    would_write: true,
    sheet_written: 'maybe',
    no_write_confirmed: false
  }), /explicitly prove no-write/);
});

test('recommendNextSet returns progression recommendation', () => {
  const rows = [
    ['2026-05-10', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-12', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '235', '5', '3', '']
  ];
  const rec = recommendNextSet(rows, 'SQ');
  assert.match(rec.recommendation, /Increase the weight/);
});
