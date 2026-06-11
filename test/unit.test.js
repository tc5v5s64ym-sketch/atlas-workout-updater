const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeExerciseKey, buildExerciseCatalogMap, enrichLogRow } = require('../services/exerciseEnrichment');
const { parseWorkoutText, buildWorkoutTextParseDryRunResponse } = require('../services/workoutTextParser');
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
const { routeDefinitions } = require('../config/routes');
const { extractDryRunSafetyFields, assertDryRunNoWrite } = require('../scripts/smoke-test-render');

const repoRoot = path.resolve(__dirname, '..');

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

test('enrichLogRow prefers Bench Press for Bench when other bench movements exist', () => {
  const map = new Map([
    ['close grip bench press', { canonical_exercise: 'Close Grip Bench Press', muscle_group: 'Chest', lift_code: 'CGBP' }],
    ['bench press', { canonical_exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BEN01' }]
  ]);
  const result = enrichLogRow({ exercise: 'Bench' }, map);
  assert.equal(result.enriched.canonical_exercise, 'Bench Press');
  assert.equal(result.enriched.lift_code, 'BEN01');
});

test('enrichLogRow prefers the catalog weighted dips entry for Dips shorthand', () => {
  const map = new Map([
    ['tricep dips', { canonical_exercise: 'Tricep Dips', muscle_group: 'Arms', lift_code: 'TDIP' }],
    ['dips weighted', { canonical_exercise: 'Dips (Weighted)', muscle_group: 'Chest', lift_code: 'DIP01' }]
  ]);
  const result = enrichLogRow({ exercise: 'Dips' }, map);
  assert.equal(result.enriched.canonical_exercise, 'Dips (Weighted)');
  assert.equal(result.enriched.lift_code, 'DIP01');
});

test('enrichLogRow prefers weighted Dips over a less specific exact dips key', () => {
  const map = new Map([
    ['dips', { canonical_exercise: 'Tricep Dips', muscle_group: 'Arms', lift_code: 'TDIP' }],
    ['dips weighted', { canonical_exercise: 'Dips (Weighted)', muscle_group: 'Chest', lift_code: 'DIP01' }]
  ]);
  const result = enrichLogRow({ exercise: 'Dips' }, map);
  assert.equal(result.enriched.canonical_exercise, 'Dips (Weighted)');
  assert.equal(result.enriched.lift_code, 'DIP01');
});

test('enrichLogRow prefers Lateral Raises for Lateral and Laterals shorthand', () => {
  const map = new Map([
    ['cable lateral raise', { canonical_exercise: 'Cable Lateral Raise', muscle_group: 'Shoulders', lift_code: 'CLR01' }],
    ['lateral raises', { canonical_exercise: 'Lateral Raises', muscle_group: 'Shoulders', lift_code: 'LAT01' }]
  ]);
  const lateral = enrichLogRow({ exercise: 'Lateral' }, map);
  const laterals = enrichLogRow({ exercise: 'Laterals' }, map);
  assert.equal(lateral.enriched.canonical_exercise, 'Lateral Raises');
  assert.equal(laterals.enriched.canonical_exercise, 'Lateral Raises');
});

test('enrichLogRow never maps Lats shorthand to Lateral Raises', () => {
  const map = new Map([
    ['lateral raises', { canonical_exercise: 'Lateral Raises', muscle_group: 'Shoulders', lift_code: 'LAT01' }]
  ]);
  const result = enrichLogRow({ exercise: 'Lats' }, map);
  assert.equal(result.enriched.canonical_exercise, '');
  assert.ok(result.warnings[0].startsWith('Unknown exercise:'));
});

test('enrichLogRow resolves Lats to Lat Pulldown when present', () => {
  const map = new Map([
    ['lateral raises', { canonical_exercise: 'Lateral Raises', muscle_group: 'Shoulders', lift_code: 'LAT01' }],
    ['lat pulldown', { canonical_exercise: 'Lat Pulldown', muscle_group: 'Back', lift_code: 'LPD01' }]
  ]);
  const result = enrichLogRow({ exercise: 'Lats' }, map);
  assert.equal(result.enriched.canonical_exercise, 'Lat Pulldown');
  assert.equal(result.enriched.lift_code, 'LPD01');
});

test('enrichLogRow resolves common conversational aliases safely', () => {
  const map = new Map([
    ['back squat', { canonical_exercise: 'Back Squat', muscle_group: 'Quads', lift_code: 'SQ01' }],
    ['overhead press', { canonical_exercise: 'Overhead Press', muscle_group: 'Shoulders', lift_code: 'OHP01' }],
    ['hanging knee raises', { canonical_exercise: 'Hanging Knee Raises', muscle_group: 'Core', lift_code: 'HNR01' }],
    ['hammer curls', { canonical_exercise: 'Hammer Curls', muscle_group: 'Arms', lift_code: 'HC01' }],
    ['face pull', { canonical_exercise: 'Face Pull', muscle_group: 'Rear Delts', lift_code: 'FP01' }],
    ['leg curl', { canonical_exercise: 'Leg Curl', muscle_group: 'Hamstrings', lift_code: 'LC01' }]
  ]);

  assert.equal(enrichLogRow({ exercise: 'Squat' }, map).enriched.canonical_exercise, 'Back Squat');
  assert.equal(enrichLogRow({ exercise: 'Squats' }, map).enriched.canonical_exercise, 'Back Squat');
  assert.equal(enrichLogRow({ exercise: 'Ohp' }, map).enriched.canonical_exercise, 'Overhead Press');
  assert.equal(enrichLogRow({ exercise: 'Knee raises' }, map).enriched.canonical_exercise, 'Hanging Knee Raises');
  assert.equal(enrichLogRow({ exercise: 'Hammers' }, map).enriched.canonical_exercise, 'Hammer Curls');
  assert.equal(enrichLogRow({ exercise: 'Face pulls' }, map).enriched.canonical_exercise, 'Face Pull');
  assert.equal(enrichLogRow({ exercise: 'Leg curls' }, map).enriched.canonical_exercise, 'Leg Curl');
});

test('enrichLogRow leaves vague row shorthand unresolved for review', () => {
  const map = new Map([
    ['seated row', { canonical_exercise: 'Seated Row', muscle_group: 'Back', lift_code: 'SR01' }],
    ['bent over row', { canonical_exercise: 'Bent-Over Row', muscle_group: 'Back', lift_code: 'BOR01' }],
    ['cable row', { canonical_exercise: 'Cable Row', muscle_group: 'Back', lift_code: 'CR01' }]
  ]);

  const rowsResult = enrichLogRow({ exercise: 'Rows' }, map);
  assert.equal(rowsResult.enriched.canonical_exercise, '');
  assert.ok(rowsResult.warnings[0].startsWith('Unknown exercise:'));

  assert.equal(enrichLogRow({ exercise: 'Seated row' }, map).enriched.canonical_exercise, 'Seated Row');
  assert.equal(enrichLogRow({ exercise: 'Cable row' }, map).enriched.canonical_exercise, 'Cable Row');
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

test('enrichLogRow warns instead of auto-matching ambiguous substring shorthand', () => {
  const map = new Map([
    ['bench press', { canonical_exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BP' }],
    ['overhead press', { canonical_exercise: 'Overhead Press', muscle_group: 'Shoulders', lift_code: 'OHP' }]
  ]);
  const result = enrichLogRow({ exercise: 'Press' }, map);
  assert.equal(result.enriched.canonical_exercise, '');
  assert.equal(result.autoMatch, undefined);
  assert.ok(result.warnings[0].startsWith('Ambiguous exercise match:'));
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

test('conversational logger keeps preview no-write proof required before enabling save', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  assert.match(appSource, /function hasLogWorkoutNoWriteProof/);
  assert.match(appSource, /data\.test_mode === true/);
  assert.match(appSource, /data\.sheet_written === false/);
  assert.match(appSource, /data\.no_write_confirmed === true/);
  assert.match(appSource, /data\.sheet_write === 'skipped'/);
  assert.match(appSource, /function hasCompleteWorkoutNoWriteProof/);
  assert.match(appSource, /Preview did not prove no-write safety/);
  assert.match(appSource, /document\.getElementById\('approve-btn'\)\.disabled = !pendingWrite/);
});

test('conversational logger form edits invalidate stale previews before save', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  assert.match(appSource, /function invalidatePreview\(\)/);
  assert.match(appSource, /pendingWrite = null/);
  assert.match(appSource, /previewPanel\.hidden = true/);
  assert.match(appSource, /btn\.disabled = true/);
  assert.match(appSource, /logger-form'\)\.addEventListener\('input', invalidatePreview\)/);
  assert.match(appSource, /Run a preview above to enable this button/);
});

test('conversational logger renders textbox first and parsed rows as fallback editor', () => {
  const htmlSource = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  assert.match(htmlSource, /id="workout-text"/);
  assert.match(htmlSource, /id="parsed-rows-editor"[^>]*hidden/);
  assert.match(appSource, /function parseWorkoutText/);
  assert.match(appSource, /rowsFromWorkoutInput\(\)/);
  assert.match(appSource, /parsedRowsEditor\.hidden = false/);
});

test('conversational logger calls backend parser before local parser fallback', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const rowsFunction = appSource.slice(
    appSource.indexOf('async function rowsFromWorkoutInput()'),
    appSource.indexOf('function effortMode()')
  );

  assert.match(appSource, /async function parseWorkoutTextWithBackend/);
  assert.match(appSource, /api\('\/api\/parse-workout-text'/);
  assert.match(appSource, /test_mode: true/);
  assert.ok(rowsFunction.indexOf('parseWorkoutTextWithBackend(workoutText)') < rowsFunction.indexOf('parseWorkoutText(workoutText)'));
  assert.match(rowsFunction, /Backend parser unavailable - using local parser fallback/);
});

test('conversational logger converts backend parser output to editable rows', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const converter = appSource.slice(
    appSource.indexOf('function rowsFromBackendParsedWorkout(parsed)'),
    appSource.indexOf('async function parseWorkoutTextWithBackend')
  );

  assert.match(converter, /parsed\.intent !== 'log_sets'/);
  assert.match(converter, /parsed\.canonical_name \|\| parsed\.exercise \|\| parsed\.raw_name/);
  assert.match(converter, /set_number: String\(index \+ 1\)/);
  assert.match(converter, /weight: set\.weight == null \? '' : String\(set\.weight\)/);
  assert.match(converter, /reps: set\.reps == null \? '' : String\(set\.reps\)/);
  assert.match(converter, /rir: set\.rir == null \? '' : String\(set\.rir\)/);
});

test('conversational logger backend parser success alone cannot enable save', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const parserFunction = appSource.slice(
    appSource.indexOf('async function parseWorkoutTextWithBackend(workoutText)'),
    appSource.indexOf('function populateSetRows')
  );
  const rowsFunction = appSource.slice(
    appSource.indexOf('async function rowsFromWorkoutInput()'),
    appSource.indexOf('function effortMode()')
  );

  assert.doesNotMatch(parserFunction, /pendingWrite\s*=/);
  assert.doesNotMatch(rowsFunction, /pendingWrite\s*=/);
  assert.match(appSource, /if \(!hasLogWorkoutNoWriteProof\(result\)\)/);
  assert.match(appSource, /if \(!hasCompleteWorkoutNoWriteProof\(result\)\)/);
  assert.match(appSource, /document\.getElementById\('approve-btn'\)\.disabled = !pendingWrite/);
});

test('conversational logger requires backend parser no-write proof before using parser rows', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const parserFunction = appSource.slice(
    appSource.indexOf('async function parseWorkoutTextWithBackend(workoutText)'),
    appSource.indexOf('function populateSetRows')
  );

  assert.match(parserFunction, /data\.test_mode !== true/);
  assert.match(parserFunction, /data\.sheet_written !== false/);
  assert.match(parserFunction, /data\.no_write_confirmed !== true/);
  assert.match(parserFunction, /Backend parser did not prove no-write safety/);
});

test('conversational logger shows parser source without changing save gating', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const cssSource = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  const statusFunction = appSource.slice(
    appSource.indexOf('function parserStatusNode(status)'),
    appSource.indexOf('function rowsFromBackendParsedWorkout')
  );

  assert.match(appSource, /let lastParserStatus = null/);
  assert.match(statusFunction, /Parsed by backend parser/);
  assert.match(statusFunction, /Backend parser unavailable - local parser fallback used/);
  assert.match(appSource, /lastParserStatus = \{ source: 'backend' \}/);
  assert.match(appSource, /lastParserStatus = \{ source: 'local' \}/);
  assert.match(appSource, /const parseStatus = parserStatusNode\(lastParserStatus\)/);
  assert.doesNotMatch(statusFunction, /pendingWrite\s*=/);
  assert.match(cssSource, /\.parser-status/);
});

test('log-workout test_mode preview exposes explicit no-write proof fields', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');

  assert.match(indexSource, /test_mode: true/);
  assert.match(indexSource, /sheet_write: 'skipped'/);
  assert.match(indexSource, /sheet_written: false/);
  assert.match(indexSource, /no_write_confirmed: true/);
});

function compactParsedSets(result) {
  return result.sets.map(set => [set.weight, set.reps, set.rir]);
}

test('workout parser supports Dale bench shorthand', () => {
  const result = parseWorkoutText('Bench 135 10/5 185 8/3 225 5/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(compactParsedSets(result), [[135, 10, 5], [185, 8, 3], [225, 5, 2]]);
});

test('workout parser supports Dale squat shorthand with implied same weight', () => {
  const result = parseWorkoutText('Squat 135 10/4 185 8/4 225 8/2 240 5/2 5/1');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Back Squat');
  assert.deepEqual(compactParsedSets(result), [[135, 10, 4], [185, 8, 4], [225, 8, 2], [240, 5, 2], [240, 5, 1]]);
});

test('workout parser supports OHP shorthand with implied same weight', () => {
  const result = parseWorkoutText('Ohp 95 10/4 105 10/2 10/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Overhead Press');
  assert.deepEqual(compactParsedSets(result), [[95, 10, 4], [105, 10, 2], [105, 10, 2]]);
});

test('workout parser supports xN repeat shorthand for lats, face pulls, and leg curls', () => {
  const lats = parseWorkoutText('Lats 170 8/2 x3');
  assert.equal(lats.canonical_name, 'Lat Pulldown');
  assert.deepEqual(compactParsedSets(lats), [[170, 8, 2], [170, 8, 2], [170, 8, 2]]);

  const facePulls = parseWorkoutText('Face pulls 50 15/2 x3');
  assert.equal(facePulls.canonical_name, 'Face Pull');
  assert.deepEqual(compactParsedSets(facePulls), [[50, 15, 2], [50, 15, 2], [50, 15, 2]]);

  const legCurls = parseWorkoutText('Leg curls 70 15/2 x3');
  assert.equal(legCurls.canonical_name, 'Leg Curl');
  assert.deepEqual(compactParsedSets(legCurls), [[70, 15, 2], [70, 15, 2], [70, 15, 2]]);
});

test('workout parser supports hammer curl shorthand', () => {
  const result = parseWorkoutText('Hammers 40 10/1 8/2 8/1');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Hammer Curl');
  assert.deepEqual(compactParsedSets(result), [[40, 10, 1], [40, 8, 2], [40, 8, 1]]);
});

test('workout parser asks for clarification on bodyweight knee raises without context', () => {
  const result = parseWorkoutText('Knee raises 20 15 15');
  assert.equal(result.intent, 'needs_clarification');
  assert.equal(result.partial.exercise, 'Hanging Knee Raises');
  assert.deepEqual(result.partial.sets.map(set => set.reps), [20, 15, 15]);
  assert.ok(result.warnings.includes('missing_weight_or_bodyweight_context'));
});

test('workout parser supports app style RIR entry', () => {
  const result = parseWorkoutText('Bench Press 205 lb 5 reps RIR 2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(compactParsedSets(result), [[205, 5, 2]]);
});

test('workout parser supports compact weightxrepsxsets notation', () => {
  const result = parseWorkoutText('Bench 205x5x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(compactParsedSets(result), [[205, 5, null], [205, 5, null], [205, 5, null]]);
});

test('workout parser supports sets-first notation', () => {
  const result = parseWorkoutText('Bench 3x5 @205');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(compactParsedSets(result), [[205, 5, null], [205, 5, null], [205, 5, null]]);
});

test('workout parser supports natural language repeated sets', () => {
  const result = parseWorkoutText('I did bench today, 135 for 10, 185 for 8, then 205 for 5 three times.');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(compactParsedSets(result), [[135, 10, null], [185, 8, null], [205, 5, null], [205, 5, null], [205, 5, null]]);
});

test('workout parser supports natural language RIR across sets', () => {
  const result = parseWorkoutText('Squat 205 for 7, then 6 and 6, all around RIR 2.');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Back Squat');
  assert.deepEqual(compactParsedSets(result), [[205, 7, 2], [205, 6, 2], [205, 6, 2]]);
});

test('workout parser supports dumbbell per-hand notation', () => {
  const result = parseWorkoutText('Incline DB 65s 10,10,9');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.deepEqual(compactParsedSets(result), [[65, 10, null], [65, 10, null], [65, 9, null]]);
  assert.equal(result.sets[0].weight_unit, 'lb');
  assert.equal(result.sets[0].load_note, 'per_hand');
});

test('workout parser detects correction, delete, finish, effort, and planning intents', () => {
  const correction = parseWorkoutText('change that to RIR 1', {
    lastSet: { exercise: 'Bench Press', weight: 205, reps: 5, rir: 2 },
  });
  assert.equal(correction.intent, 'update_last_set');
  assert.deepEqual(correction.update, { rir: 1 });

  assert.equal(parseWorkoutText('delete last set').intent, 'delete_last_set');

  const finish = parseWorkoutText('log everything to spreadsheet');
  assert.equal(finish.intent, 'finish_session');
  assert.equal(finish.requires_effort_check, true);

  const effort = parseWorkoutText('Duration 53.75 Active 435 Total 551 Avg HR 121 Peak HR 165 Richmond');
  assert.equal(effort.intent, 'effort_capture');
  assert.deepEqual(effort.effort, {
    duration_min: 53.75,
    active_calories: 435,
    total_calories: 551,
    avg_hr: 121,
    peak_hr: 165,
    location: 'Richmond',
  });

  assert.equal(parseWorkoutText("It's June 9 and we're back at the gym, what are we doing").intent, 'plan_request');
});

test('workout parser keeps press aliases safe and specific', () => {
  const incline = parseWorkoutText('Incline press 65 10/2 x3');
  assert.equal(incline.intent, 'log_sets');
  assert.equal(incline.canonical_name, 'Incline DB Press');
  assert.deepEqual(compactParsedSets(incline), [[65, 10, 2], [65, 10, 2], [65, 10, 2]]);

  const generic = parseWorkoutText('Press 105 8/2');
  assert.equal(generic.intent, 'needs_clarification');
  assert.match(generic.message, /Which press/);
});

test('parser does not leak implied weight across multiple exercises', () => {
  const result = parseWorkoutText('Bench 225 5/2 squats 185 5/2');
  assert.equal(result.intent, 'needs_clarification');
  assert.match(result.message, /multiple exercises|mixed exercise/i);
  assert.ok(result.warnings.includes('multiple_exercises_in_input'));
  assert.equal(result.sets, undefined);
  assert.notDeepEqual(result.sets?.map(set => [set.weight, set.reps, set.rir]), [[225, 5, 2], [185, 5, 2]]);
});

test('bare correction number asks clarification instead of defaulting to RIR', () => {
  const result = parseWorkoutText('change that to 8');
  assert.equal(result.intent, 'needs_clarification');
  assert.equal(result.update, undefined);
  assert.equal(result.sets, undefined);
  assert.match(result.message, /8 what.*reps.*weight.*RIR/i);

  assert.deepEqual(parseWorkoutText('change rir to 1').update, { rir: 1 });
  assert.deepEqual(parseWorkoutText('actually call it RIR 1').update, { rir: 1 });
  assert.deepEqual(parseWorkoutText('change reps to 8').update, { reps: 8 });
  assert.deepEqual(parseWorkoutText('change weight to 225').update, { weight: 225 });
});

test('parse-workout-text dry-run response parses Dale shorthand without writes', () => {
  const result = buildWorkoutTextParseDryRunResponse({
    text: 'Bench 135 10/5 185 8/3 225 5/2',
    context: {
      activeExercise: null,
      activeSessionType: null,
      todayPlan: null,
    },
    test_mode: true,
  });

  assert.equal(result.status, 'success');
  assert.equal(result.test_mode, true);
  assert.equal(result.sheet_written, false);
  assert.equal(result.no_write_confirmed, true);
  assert.equal(result.parsed.intent, 'log_sets');
  assert.equal(result.parsed.canonical_name, 'Bench Press');
  assert.deepEqual(compactParsedSets(result.parsed), [[135, 10, 5], [185, 8, 3], [225, 5, 2]]);
});

test('parse-workout-text dry-run validates missing text and requires test_mode', () => {
  assert.throws(() => buildWorkoutTextParseDryRunResponse({
    text: '',
    test_mode: true,
  }), /text is required/);

  assert.throws(() => buildWorkoutTextParseDryRunResponse({
    text: 'Bench 205 5/2',
    test_mode: false,
  }), /test_mode=true is required/);

  assert.throws(() => buildWorkoutTextParseDryRunResponse({
    text: 'Bench 205 5/2',
  }), /test_mode=true is required/);
});

test('parse-workout-text dry-run returns finish, planning, and ambiguity intents', () => {
  const finish = buildWorkoutTextParseDryRunResponse({
    text: 'log everything to spreadsheet',
    test_mode: true,
  });
  assert.equal(finish.parsed.intent, 'finish_session');
  assert.equal(finish.parsed.requires_effort_check, true);

  const planning = buildWorkoutTextParseDryRunResponse({
    text: "It's June 9 and we're back at the gym, what are we doing",
    test_mode: true,
  });
  assert.equal(planning.parsed.intent, 'plan_request');

  const ambiguous = buildWorkoutTextParseDryRunResponse({
    text: 'Press 105 8/2',
    test_mode: true,
  });
  assert.equal(ambiguous.parsed.intent, 'needs_clarification');
  assert.match(ambiguous.parsed.message, /Which press/);
  assert.deepEqual(ambiguous.warnings, ['ambiguous_exercise_alias']);
});

test('parse-workout-text route is registered as read-only and no-write capable', () => {
  const route = routeDefinitions.find(candidate => candidate.path === '/api/parse-workout-text');
  assert.ok(route);
  assert.deepEqual(route.methods, ['POST']);
  assert.equal(route.authRequired, true);
  assert.equal(route.readOnly, true);
  assert.equal(route.writeCapable, false);

  const indexSource = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  assert.match(indexSource, /app\.post\('\/api\/parse-workout-text'/);
  assert.match(indexSource, /buildWorkoutTextParseDryRunResponse\(req\.body\)/);
  assert.doesNotMatch(indexSource.match(/app\.post\('\/api\/parse-workout-text'[\s\S]*?app\.post\('\/api\/parse-workout-image'/)[0], /appendRows|getSheetRows|getRecentRows|parseWorkoutScreenshot/);
});

test('recommendNextSet returns progression recommendation', () => {
  const rows = [
    ['2026-05-10', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-12', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '235', '5', '3', '']
  ];
  const rec = recommendNextSet(rows, 'SQ');
  assert.match(rec.recommendation, /Increase to/);
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
