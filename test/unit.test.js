const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExerciseKey, buildExerciseCatalogMap, enrichLogRow } = require('../services/exerciseEnrichment');
const { normalizeDurationString } = require('../services/duration');
const {
  recommendNextSet, buildSessionSummary, computeExerciseProgress,
  computeMuscleGroupVolume, searchSessions, detectRecentPrs,
  buildBodyweightHistory, previewTestRows, detectStalls
} = require('../services/analytics');
const { parseNumber, normalizeDate, parseDurationMinutes, getSimpleTrend, calculateQualityScore } = require('../services/validation');
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
  assert.equal(result.autoMatch, undefined);
});

test('enrichLogRow fuzzy-matches a substring shorthand (Bench → Bench Press)', () => {
  const map = new Map([['bench press', { canonical_exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BP' }]]);
  const result = enrichLogRow({ exercise: 'Bench' }, map);
  assert.equal(result.enriched.canonical_exercise, 'Bench Press');
  assert.ok(result.autoMatch && result.autoMatch.includes('Bench Press'));
});

test('enrichLogRow fuzzy-matches plural to singular (Squats → Back Squat via variant)', () => {
  const map = new Map([
    ['back squat', { canonical_exercise: 'Back Squat', muscle_group: 'Legs', lift_code: 'SQ' }],
    ['squat', { canonical_exercise: 'Back Squat', muscle_group: 'Legs', lift_code: 'SQ' }]
  ]);
  const result = enrichLogRow({ exercise: 'Squats' }, map);
  assert.equal(result.enriched.canonical_exercise, 'Back Squat');
});

test('enrichLogRow expands OHP abbreviation to Overhead Press', () => {
  const map = new Map([['overhead press', { canonical_exercise: 'Overhead Press', muscle_group: 'Shoulders', lift_code: 'OHP' }]]);
  const result = enrichLogRow({ exercise: 'OHP' }, map);
  assert.equal(result.enriched.canonical_exercise, 'Overhead Press');
  assert.ok(result.autoMatch);
});

test('enrichLogRow returns Unknown for truly unrecognised exercise', () => {
  const map = new Map([['back squat', { canonical_exercise: 'Back Squat', muscle_group: 'Legs', lift_code: 'SQ' }]]);
  const result = enrichLogRow({ exercise: 'Zorblax Machine' }, map);
  assert.equal(result.enriched.canonical_exercise, '');
  assert.ok(result.warnings[0].startsWith('Unknown exercise:'));
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

test('recommendNextSet returns no-history message for unknown lift', () => {
  const rec = recommendNextSet([], 'UNKNOWN');
  assert.match(rec.recommendation, /No recent working sets/);
});

// ── Validation helpers ────────────────────────────────────────────────────────

test('parseNumber handles numeric, string, and blank inputs', () => {
  assert.equal(parseNumber(42), 42);
  assert.equal(parseNumber('42'), 42);
  assert.equal(parseNumber('42.5'), 42.5);
  assert.equal(parseNumber('1,234'), 1234);
  assert.equal(parseNumber(0), 0);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber(undefined), null);
  assert.equal(parseNumber('not-a-number'), null);
  assert.equal(parseNumber(Infinity), null);
});

test('normalizeDate handles ISO, datetime, and blank values', () => {
  assert.equal(normalizeDate('2026-05-17'), '2026-05-17');
  assert.equal(normalizeDate('2026-05-17 0:00:00'), '2026-05-17');
  assert.equal(normalizeDate('2026-05-17T00:00:00.000Z'), '2026-05-17');
  assert.equal(normalizeDate(''), '');
  assert.equal(normalizeDate(null), '');
  assert.equal(normalizeDate(undefined), '');
});

test('parseDurationMinutes converts hh:mm:ss, mm:ss, and numeric to minutes', () => {
  assert.equal(parseDurationMinutes('01:00:00'), 60);
  assert.equal(parseDurationMinutes('00:30:00'), 30);
  assert.equal(parseDurationMinutes('00:30:30'), 30.5);
  assert.equal(parseDurationMinutes('30'), 30);
  assert.equal(parseDurationMinutes(45), 45);
  assert.equal(parseDurationMinutes(''), 0);
  assert.equal(parseDurationMinutes(null), 0);
  assert.equal(parseDurationMinutes(undefined), 0);
});

test('getSimpleTrend detects up, down, and flat', () => {
  assert.equal(getSimpleTrend([100, 110, 120]), 'up');
  assert.equal(getSimpleTrend([120, 110, 100]), 'down');
  assert.equal(getSimpleTrend([100, 100, 100]), 'flat');
  assert.equal(getSimpleTrend([100]), 'flat');
  assert.equal(getSimpleTrend([]), 'flat');
});

test('calculateQualityScore returns 5 for perfect session and 0 for minimal session', () => {
  assert.equal(calculateQualityScore({
    totalSets: 12,
    effortDuration: '01:00:00',
    averageHR: 130,
    uniqueExercisesCount: 5,
    validationWarnings: []
  }), 5);
  assert.equal(calculateQualityScore({
    totalSets: 2,
    effortDuration: '00:10:00',
    averageHR: 80,
    uniqueExercisesCount: 1,
    validationWarnings: ['some warning']
  }), 0);
});

// ── Analytics functions ───────────────────────────────────────────────────────

// For functions that cut off by "days ago from now", fixtures must be relative
// to the test run date or they silently age out of the window.
function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const SAMPLE_LOG = [
  ['2026-05-10', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
  ['2026-05-10', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '185', '8', '1', ''],
  ['2026-05-10', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '2', '185', '7', '2', ''],
  ['2026-05-12', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '235', '5', '3', ''],
  ['2026-05-12', 'S2', 'Deadlift', 'Deadlift', 'Posterior Chain', 'DL', '1', '315', '3', '1', ''],
];

const SAMPLE_EFFORT = [
  ['2026-05-10', 'S1', '01:10:00', '450', '550', '135', '162', 'Gym', ''],
  ['2026-05-12', 'S2', '00:55:00', '380', '480', '130', '155', 'Gym', ''],
];

test('buildSessionSummary returns correct totals for a known session', () => {
  const summary = buildSessionSummary(SAMPLE_LOG, SAMPLE_EFFORT, 'S1');
  assert.equal(summary.session_id, 'S1');
  assert.equal(summary.total_sets, 3);
  assert.ok(summary.exercises.includes('Bench Press'));
  assert.ok(summary.total_volume > 0);
  assert.ok(summary.effort !== null);
  assert.equal(summary.effort.duration, '01:10:00');
});

test('buildSessionSummary returns empty result for unknown session', () => {
  const summary = buildSessionSummary(SAMPLE_LOG, SAMPLE_EFFORT, 'UNKNOWN');
  assert.equal(summary.total_sets, 0);
  assert.equal(summary.effort, null);
});

test('computeExerciseProgress tracks weight and 1RM trends', () => {
  const progress = computeExerciseProgress(SAMPLE_LOG, 'SQ');
  assert.equal(progress.liftCode, 'SQ');
  assert.equal(progress.sessions.length, 2);
  assert.equal(progress.best_weight_over_time[0].best_weight, 225);
  assert.equal(progress.best_weight_over_time[1].best_weight, 235);
  assert.equal(progress.recent_trend, 'up');
});

test('computeExerciseProgress returns empty for unknown lift', () => {
  const progress = computeExerciseProgress(SAMPLE_LOG, 'UNKNOWN');
  assert.equal(progress.sessions.length, 0);
  assert.equal(progress.recent_trend, 'flat');
});

test('computeMuscleGroupVolume sums volume and sets by muscle group', () => {
  // Relative dates so the rows always fall inside the days window
  const rows = [
    [daysAgoIso(5), 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    [daysAgoIso(5), 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '185', '8', '1', ''],
    [daysAgoIso(3), 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '235', '5', '3', ''],
    [daysAgoIso(3), 'S2', 'Bench Press', 'Bench Press', 'Chest', 'BP', '2', '185', '7', '2', ''],
    [daysAgoIso(60), 'OLD', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '300', '5', '2', '']
  ];
  const groups = computeMuscleGroupVolume(rows, 14);
  const legs = groups.find(g => g.muscle_group === 'Legs');
  const chest = groups.find(g => g.muscle_group === 'Chest');
  assert.ok(legs, 'Legs should be present');
  assert.equal(legs.volume, 225 * 5 + 235 * 5);
  assert.ok(chest, 'Chest should be present');
  assert.equal(chest.set_count, 2);
});

test('searchSessions filters by liftCode', () => {
  const result = searchSessions(SAMPLE_LOG, { liftCode: 'SQ' });
  assert.ok(result.session_ids.includes('S1'));
  assert.ok(result.session_ids.includes('S2'));
  assert.equal(result.rows.length, 2);
});

test('searchSessions filters by dateFrom', () => {
  const result = searchSessions(SAMPLE_LOG, { dateFrom: '2026-05-11' });
  assert.ok(!result.session_ids.includes('S1'));
  assert.ok(result.session_ids.includes('S2'));
});

test('searchSessions returns all rows when no filters applied', () => {
  const result = searchSessions(SAMPLE_LOG, {});
  assert.ok(result.session_ids.includes('S1'));
  assert.ok(result.session_ids.includes('S2'));
});

test('detectRecentPrs returns best weight and rep set per lift', () => {
  const prs = detectRecentPrs(SAMPLE_LOG);
  const sqPr = prs.find(p => p.liftCode === 'SQ');
  assert.ok(sqPr, 'SQ PR should be present');
  assert.equal(sqPr.bestWeightSet.weight, 235);
  const bpPr = prs.find(p => p.liftCode === 'BP');
  assert.ok(bpPr, 'BP PR should be present');
  assert.equal(bpPr.bestWeightSet.weight, 185);
});

test('buildBodyweightHistory computes entries, average, and trend', () => {
  const rows = [
    [daysAgoIso(20), '185', ''],
    [daysAgoIso(10), '184', ''],
    [daysAgoIso(2), '183', ''],
  ];
  const history = buildBodyweightHistory(rows, 30);
  assert.equal(history.entries.length, 3);
  assert.equal(history.latest.weight, 183);
  assert.ok(history.average > 0);
  assert.equal(history.trend, 'down');
});

test('buildBodyweightHistory respects days window and excludes old entries', () => {
  const rows = [
    [daysAgoIso(2000), '200', ''],
    [daysAgoIso(2), '183', ''],
  ];
  const history = buildBodyweightHistory(rows, 30);
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].weight, 183);
});

test('previewTestRows identifies test session IDs and test notes', () => {
  const testLogRows = [
    ['2026-05-01', 'test-session', 'Squat', 'Squat', 'Legs', 'SQ', '1', '135', '5', '3', ''],
    ['2026-05-01', 'real-session', 'Squat', 'Squat', 'Legs', 'SQ', '1', '135', '5', '3', 'test run'],
    ['2026-05-01', 'normal-session', 'Squat', 'Squat', 'Legs', 'SQ', '1', '135', '5', '3', ''],
  ];
  const preview = previewTestRows(testLogRows, []);
  assert.equal(preview.log_candidates.length, 2);
  assert.equal(preview.effort_candidates.length, 0);
});

test('detectStalls flags lifts with no weight progression over minSessions', () => {
  const rows = [
    ['2026-04-01', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '185', '5', '1', ''],
    ['2026-04-05', 'S2', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '185', '5', '2', ''],
    ['2026-04-10', 'S3', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '185', '5', '1', ''],
  ];
  const stalls = detectStalls(rows, 3);
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].liftCode, 'BP');
  assert.equal(stalls[0].sessions_stalled, 3);
});

test('detectStalls does not flag progresssing lifts', () => {
  const rows = [
    ['2026-04-01', 'S1', 'Squat', 'Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-04-05', 'S2', 'Squat', 'Squat', 'Legs', 'SQ', '1', '235', '5', '2', ''],
    ['2026-04-10', 'S3', 'Squat', 'Squat', 'Legs', 'SQ', '1', '245', '5', '2', ''],
  ];
  assert.equal(detectStalls(rows, 3).length, 0);
});

test('detectStalls skips lifts with fewer sessions than minSessions', () => {
  const rows = [
    ['2026-04-01', 'S1', 'Row', 'Row', 'Back', 'ROW', '1', '135', '8', '2', ''],
    ['2026-04-05', 'S2', 'Row', 'Row', 'Back', 'ROW', '1', '135', '8', '2', ''],
  ];
  assert.equal(detectStalls(rows, 3).length, 0);
});

// ── Backup export script ──────────────────────────────────────────────────────

const { rowsToCsv, toCsvCell, buildBackupManifest } = require('../scripts/export-sheets-backup');

test('toCsvCell escapes quotes, commas, and newlines', () => {
  assert.equal(toCsvCell('plain'), 'plain');
  assert.equal(toCsvCell('has,comma'), '"has,comma"');
  assert.equal(toCsvCell('has "quote"'), '"has ""quote"""');
  assert.equal(toCsvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(toCsvCell(null), '');
  assert.equal(toCsvCell(undefined), '');
  assert.equal(toCsvCell(42), '42');
});

test('rowsToCsv joins rows and cells correctly', () => {
  const csv = rowsToCsv([
    ['Date', 'Exercise', 'Notes'],
    ['2026-05-10', 'Squat', 'felt good, strong']
  ]);
  assert.equal(csv, 'Date,Exercise,Notes\n2026-05-10,Squat,"felt good, strong"\n');
});

test('buildBackupManifest summarizes exported tabs', () => {
  const manifest = buildBackupManifest({
    spreadsheetId: 'sheet-123',
    tabs: [{ name: 'Log_Cleaned', rowCount: 100 }, { name: 'Effort', rowCount: 20 }],
    timestamp: '2026-06-10T00-00-00Z'
  });
  assert.equal(manifest.spreadsheet_id, 'sheet-123');
  assert.equal(manifest.tab_count, 2);
  assert.deepEqual(manifest.tabs[0], { name: 'Log_Cleaned', rows: 100 });
});

// ── Coaching: deloads and fatigue ─────────────────────────────────────────────

const { suggestDeloads, computeFatigueStatus } = require('../services/analytics');

test('suggestDeloads recommends a 10% reduction for persistent stalls', () => {
  const rows = [
    ['2026-04-01', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '1', ''],
    ['2026-04-05', 'S2', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '1', ''],
    ['2026-04-10', 'S3', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '1', ''],
    ['2026-04-15', 'S4', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '1', '']
  ];
  const suggestions = suggestDeloads(rows, 4);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].liftCode, 'BP');
  assert.equal(suggestions[0].suggested_deload_weight, 180);
  assert.match(suggestions[0].suggestion, /Deload/);
});

test('suggestDeloads returns nothing for progressing lifts', () => {
  const rows = [
    ['2026-04-01', 'S1', 'Squat', 'Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-04-05', 'S2', 'Squat', 'Squat', 'Legs', 'SQ', '1', '235', '5', '2', ''],
    ['2026-04-10', 'S3', 'Squat', 'Squat', 'Legs', 'SQ', '1', '245', '5', '2', ''],
    ['2026-04-15', 'S4', 'Squat', 'Squat', 'Legs', 'SQ', '1', '255', '5', '2', '']
  ];
  assert.equal(suggestDeloads(rows, 4).length, 0);
});

test('computeFatigueStatus flags high recent volume against baseline', () => {
  const ref = new Date('2026-06-10T12:00:00Z');
  const rows = [
    // Baseline weeks (days 8-28 before ref): ~1000 volume/week
    ['2026-05-15', 'B1', 'Squat', 'Squat', 'Legs', 'SQ', '1', '100', '10', '2', ''],
    ['2026-05-22', 'B2', 'Squat', 'Squat', 'Legs', 'SQ', '1', '100', '10', '2', ''],
    ['2026-05-29', 'B3', 'Squat', 'Squat', 'Legs', 'SQ', '1', '100', '10', '2', ''],
    // Recent week: 2000 volume (2x baseline weekly)
    ['2026-06-08', 'R1', 'Squat', 'Squat', 'Legs', 'SQ', '1', '200', '10', '2', '']
  ];
  const fatigue = computeFatigueStatus(rows, ref);
  assert.equal(fatigue.status, 'high');
  assert.ok(fatigue.ratio >= 1.5);
  assert.equal(fatigue.recent_volume, 2000);
});

test('computeFatigueStatus reports normal when volumes are comparable', () => {
  const ref = new Date('2026-06-10T12:00:00Z');
  const rows = [
    ['2026-05-15', 'B1', 'Squat', 'Squat', 'Legs', 'SQ', '1', '100', '10', '2', ''],
    ['2026-05-22', 'B2', 'Squat', 'Squat', 'Legs', 'SQ', '1', '100', '10', '2', ''],
    ['2026-05-29', 'B3', 'Squat', 'Squat', 'Legs', 'SQ', '1', '100', '10', '2', ''],
    ['2026-06-08', 'R1', 'Squat', 'Squat', 'Legs', 'SQ', '1', '100', '10', '2', '']
  ];
  const fatigue = computeFatigueStatus(rows, ref);
  assert.equal(fatigue.status, 'normal');
});

test('computeFatigueStatus reports no_baseline without prior history', () => {
  const ref = new Date('2026-06-10T12:00:00Z');
  const rows = [
    ['2026-06-08', 'R1', 'Squat', 'Squat', 'Legs', 'SQ', '1', '100', '10', '2', '']
  ];
  const fatigue = computeFatigueStatus(rows, ref);
  assert.equal(fatigue.status, 'no_baseline');
  assert.equal(fatigue.ratio, null);
});

// ── Backup script tab discovery (read-only client) ────────────────────────────

const { listTabs } = require('../scripts/export-sheets-backup');

test('listTabs extracts tab titles via the provided (read-only) client', async () => {
  const fakeClient = {
    spreadsheets: {
      get: async ({ spreadsheetId, fields }) => {
        assert.equal(spreadsheetId, 'sheet-123');
        assert.equal(fields, 'sheets.properties.title');
        return { data: { sheets: [
          { properties: { title: 'Log_Cleaned' } },
          { properties: { title: 'Effort' } },
          { properties: {} }
        ] } };
      }
    }
  };
  const tabs = await listTabs(fakeClient, 'sheet-123');
  assert.deepEqual(tabs, ['Log_Cleaned', 'Effort', '']);
});

test('listTabs returns empty array when spreadsheet has no sheets data', async () => {
  const fakeClient = { spreadsheets: { get: async () => ({ data: {} }) } };
  assert.deepEqual(await listTabs(fakeClient, 'sheet-123'), []);
});
