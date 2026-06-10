const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExerciseKey, buildExerciseCatalogMap, enrichLogRow } = require('../services/exerciseEnrichment');
const { normalizeDurationString } = require('../services/duration');
const { recommendNextSet } = require('../services/analytics');
const { logCleanedColumns, exerciseCatalogColumns } = require('../config/columns');
const { buildCompleteWorkoutResponseData } = require('../services/completeWorkoutResponse');
const { extractDryRunSafetyFields, assertDryRunNoWrite } = require('../scripts/smoke-test-render');
const {
  requiredSheetTabs,
  optionalSheetTabs,
  getMissingRequiredTabs,
  buildSheetContractStatus
} = require('../config/sheetContract');

test('required sheet contract excludes Dashboard', () => {
  assert.deepEqual(requiredSheetTabs, ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary']);
  assert.ok(!requiredSheetTabs.includes('Dashboard'));
  assert.ok(optionalSheetTabs.includes('Dashboard'));
});

test('sheet contract validates required tabs and optional Dashboard', () => {
  const requiredOnly = ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'];
  assert.deepEqual(getMissingRequiredTabs(requiredOnly), []);
  assert.deepEqual(getMissingRequiredTabs([...requiredOnly, 'Dashboard']), []);
  assert.deepEqual(getMissingRequiredTabs(requiredOnly.filter(tab => tab !== 'Log_Cleaned')), ['Log_Cleaned']);
  assert.deepEqual(getMissingRequiredTabs(requiredOnly.filter(tab => tab !== 'Exercise_Catalog')), ['Exercise_Catalog']);

  const status = buildSheetContractStatus(requiredOnly);
  assert.equal(status.optionalTabs.Dashboard.exists, false);
  assert.equal(status.optionalTabs.Dashboard.required, false);
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
  assert.deepEqual(exerciseCatalogColumns, ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise']);
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

test('buildExerciseCatalogMap supports cleaned Exercise_Catalog headers', () => {
  const rows = [
    ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'],
    ['Hanging Knee Raises', 'Core', 'HNR01', 'Hanging Knee Raises']
  ];
  const map = buildExerciseCatalogMap(rows);
  assert.equal(map.get('hanging knee raises').lift_code, 'HNR01');
  assert.equal(map.get('hanging knee raises').muscle_group, 'Core');
});

test('cleaned Exercise_Catalog key lifts enrich correctly', () => {
  const rows = [
    ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'],
    ['Back Squat', 'Quads', 'SQ01', 'Back Squat'],
    ['Bench Press', 'Chest', 'BEN01', 'Bench Press'],
    ['Overhead Press', 'Shoulders', 'OHP01', 'Overhead Press'],
    ['Lat Pulldown', 'Back', 'LPD01', 'Lat Pulldown'],
    ['Face Pull', 'Rear Delts / Rotator Cuff', 'FP01', 'Face Pull'],
    ['Hanging Knee Raises', 'Core', 'HNR01', 'Hanging Knee Raises'],
    ['Core', 'HNR01', '3', 'Hanging Knee Raises']
  ];
  const map = buildExerciseCatalogMap(rows);
  assert.deepEqual(map.get('back squat'), { canonical_exercise: 'Back Squat', muscle_group: 'Quads', lift_code: 'SQ01' });
  assert.deepEqual(map.get('bench press'), { canonical_exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BEN01' });
  assert.deepEqual(map.get('overhead press'), { canonical_exercise: 'Overhead Press', muscle_group: 'Shoulders', lift_code: 'OHP01' });
  assert.deepEqual(map.get('lat pulldown'), { canonical_exercise: 'Lat Pulldown', muscle_group: 'Back', lift_code: 'LPD01' });
  assert.equal(map.get('face pull').lift_code, 'FP01');
  assert.deepEqual(map.get('hanging knee raises'), { canonical_exercise: 'Hanging Knee Raises', muscle_group: 'Core', lift_code: 'HNR01' });
  assert.notEqual(map.get('hanging knee raises').lift_code, '3');
});

test('enrichLogRow enriches known exercise', () => {
  const map = new Map([['back squat', { canonical_exercise: 'Back Squat', muscle_group: 'Legs', lift_code: 'SQ' }]]);
  const result = enrichLogRow({ exercise: 'Back Squat' }, map);
  assert.equal(result.enriched.lift_code, 'SQ');
});

test('duration normalization supports mm:ss and hh:mm:ss', () => {
  assert.equal(normalizeDurationString('45:30'), '00:45:30');
  assert.equal(normalizeDurationString('1:05:09'), '01:05:09');
  assert.equal(normalizeDurationString(45), '00:45:00');
  assert.equal(normalizeDurationString('45'), '00:45:00');
  assert.equal(normalizeDurationString(53.75), '00:53:45');
});

test('recommendNextSet returns progression recommendation', () => {
  const rows = [
    ['2026-05-10', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-12', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '235', '5', '3', '']
  ];
  const rec = recommendNextSet(rows, 'SQ');
  assert.match(rec.recommendation, /Increase the weight/);
});

test('complete-workout test mode response exposes strict no-write fields', () => {
  const response = buildCompleteWorkoutResponseData({
    sessionId: 'ATLAS-DRYRUN',
    dateValue: '2026-06-09',
    testMode: true,
    rowsToWrite: [['2026-06-09', 'ATLAS-DRYRUN', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', 1, 135, 5, 3, '', 675]],
    skippedDuplicates: [],
    duplicateSession: true,
    effortWritten: false,
    normalizedMetrics: { duration: '00:45:00', activeCalories: 350, totalCalories: 430, averageHR: 121, peakHR: 165 },
    qualityScore: 5,
    effortSource: 'manual',
    effortRow: ['2026-06-09', 'ATLAS-DRYRUN', '00:45:00', 350, 430, 121, 165, 'Test', ''],
    formattedLogRows: [['2026-06-09', 'ATLAS-DRYRUN', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', 1, 135, 5, 3, '', 675]],
    pendingExercises: []
  });

  assert.equal(response.test_mode, true);
  assert.equal(response.would_write, true);
  assert.equal(response.sheet_written, false);
  assert.equal(response.no_write_confirmed, true);
  assert.equal(response.duplicate_check.duplicate_session, true);
  assert.equal(response.log_rows_preview.length, 1);
  assert.equal(response.effort_row.length, 9);
  assert.equal(response.enrichment[0].lift_code, 'SQ01');
  assert.equal(response.data.no_write_confirmed, true);
});

test('Mission Control smoke parser accepts only strict no-write dry-run responses', () => {
  const ok = {
    status: 'ok',
    data: {
      test_mode: true,
      would_write: true,
      sheet_written: false,
      no_write_confirmed: true
    }
  };
  assert.deepEqual(extractDryRunSafetyFields(ok), {
    test_mode: true,
    would_write: true,
    sheet_written: false,
    no_write_confirmed: true,
    sheet_write: undefined
  });
  assert.doesNotThrow(() => assertDryRunNoWrite(ok));

  assert.throws(() => assertDryRunNoWrite({ data: { test_mode: true, sheet_written: true, no_write_confirmed: true } }));
  assert.throws(() => assertDryRunNoWrite({ data: { test_mode: true, sheet_written: false, no_write_confirmed: false } }));
  assert.throws(() => assertDryRunNoWrite({ data: { test_mode: false, sheet_written: false, no_write_confirmed: true } }));
});
