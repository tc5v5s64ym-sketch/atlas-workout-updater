const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeExerciseKey, generateLiftCode, buildExerciseCatalogMap, enrichLogRow } = require('../services/exerciseEnrichment');
const { parseWorkoutText, buildWorkoutTextParseDryRunResponse, looksLikeCorrection, looksLikeLogIt } = require('../services/workoutTextParser');
const { normalizeDurationString } = require('../services/duration');
const {
  recommendNextSet, buildSessionSummary, computeExerciseProgress,
  computeMuscleGroupVolume, searchSessions, detectRecentPrs,
  buildBodyweightHistory, previewTestRows, detectStalls,
  buildWeeklyReport, buildProgressSummary, buildExerciseDetail, buildRecentSessions,
  classifyMuscleGroup, buildMuscleGroupReadiness, scoreIntents,
  localTodayIso
} = require('../services/analytics');
const { parseNumber, normalizeDate, parseDurationMinutes, getSimpleTrend, calculateQualityScore, qualityScoreBreakdown } = require('../services/validation');
const { logCleanedColumns, effortColumns, exerciseCatalogColumns } = require('../config/columns');
const {
  requiredSheetTabs,
  optionalSheetTabs,
  getMissingRequiredTabs,
  buildSheetContractStatus,
  normalizeHeaderToken,
  validateHeaderRow
} = require('../config/sheetContract');
const { logRowFieldAliases, effortRowFieldAliases, modalityLogColumns, modalityLogRowFieldAliases } = require('../config/columns');
const { isTransientAppendError, retryWithBackoff } = require('../sheets');
const { routeDefinitions } = require('../config/routes');
const { extractDryRunSafetyFields, assertDryRunNoWrite } = require('../scripts/smoke-test-render');
const { generateSessionId, nextAvailableSessionId, formatDateForSessionId, formatAmPmSuffix } = require('../services/sessionId');

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

// PR 486 slice 4a — Modality_Log typed tab schema (pure config, no write path).
test('Modality_Log is an OPTIONAL tab (never required), leaving the core contract intact', () => {
  assert.ok(optionalSheetTabs.includes('Modality_Log'));
  assert.ok(!requiredSheetTabs.includes('Modality_Log'));
  // Core contract unchanged: Log_Cleaned / Effort stay required, no new required tab.
  assert.deepEqual(requiredSheetTabs, ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary']);
  const status = buildSheetContractStatus(requiredSheetTabs);
  assert.equal(status.missingRequiredTabs.length, 0, 'Modality_Log absent must not make the sheet incomplete');
  assert.equal(status.optional.Modality_Log, false);
  const withTab = buildSheetContractStatus([...requiredSheetTabs, 'Modality_Log']);
  assert.equal(withTab.optional.Modality_Log, true);
});

test('Modality_Log column contract is the pinned 12-column order', () => {
  assert.deepEqual(modalityLogColumns, [
    'date', 'session_id', 'modality', 'exercise', 'duration_sec', 'distance_m',
    'rounds', 'rest_sec', 'level', 'rpe', 'avg_hr', 'notes'
  ]);
  // Every column has an alias entry (so a hand-edited header validates).
  for (const col of modalityLogColumns) {
    assert.ok(Array.isArray(modalityLogRowFieldAliases[col]) && modalityLogRowFieldAliases[col].length, `missing aliases for ${col}`);
  }
});

test('Modality_Log header validates against canonical and camelCase variants', () => {
  const canonical = validateHeaderRow(modalityLogColumns, modalityLogColumns, modalityLogRowFieldAliases);
  assert.equal(canonical.ok, true);
  const camel = validateHeaderRow(
    ['date', 'sessionId', 'modality', 'exercise', 'durationSec', 'distanceM', 'rounds', 'restSec', 'level', 'rpe', 'averageHR', 'notes'],
    modalityLogColumns,
    modalityLogRowFieldAliases
  );
  assert.equal(camel.ok, true, JSON.stringify(camel.mismatches));
  // A wrong header position is reported, not silently accepted.
  const wrong = validateHeaderRow(
    ['date', 'session_id', 'exercise', 'modality', 'duration_sec', 'distance_m', 'rounds', 'rest_sec', 'level', 'rpe', 'avg_hr', 'notes'],
    modalityLogColumns,
    modalityLogRowFieldAliases
  );
  assert.equal(wrong.ok, false);
});

test('localTodayIso defaults to UTC when no timezone is configured', () => {
  // An instant just after UTC midnight resolves to the UTC date with no zone.
  const instant = new Date('2026-06-20T00:30:00Z');
  assert.equal(localTodayIso(instant, undefined), '2026-06-20');
  assert.equal(localTodayIso(instant, ''), '2026-06-20');
});

test('localTodayIso resolves the LOCAL day for a configured zone (fixes the midnight off-by-one)', () => {
  // 03:00 UTC on Jun 20 is still 20:00 on Jun 19 in Los Angeles (PDT, UTC-7).
  // UTC would say "Jun 20"; the owner's local day is "Jun 19" — the exact case
  // that made a just-logged set look like it was "trained yesterday".
  const instant = new Date('2026-06-20T03:00:00Z');
  assert.equal(localTodayIso(instant, 'America/Los_Angeles'), '2026-06-19');
  assert.equal(localTodayIso(instant, undefined), '2026-06-20'); // UTC basis differs
  // A zone ahead of UTC pushes the local day forward.
  assert.equal(localTodayIso(new Date('2026-06-19T23:00:00Z'), 'Asia/Tokyo'), '2026-06-20');
});

test('localTodayIso falls back to UTC for an invalid timezone rather than throwing', () => {
  const instant = new Date('2026-06-20T12:00:00Z');
  assert.equal(localTodayIso(instant, 'Not/AZone'), '2026-06-20');
  // A non-Date / invalid input is tolerated (uses current time, returns a date string).
  assert.match(localTodayIso('garbage', undefined), /^\d{4}-\d{2}-\d{2}$/);
});

test('isTransientAppendError retries only request-rejected-before-write errors', () => {
  // Safe to retry — Google rejected the request before touching the sheet.
  assert.equal(isTransientAppendError({ code: 429 }), true);
  assert.equal(isTransientAppendError({ code: 503 }), true);
  assert.equal(isTransientAppendError({ response: { status: 503 } }), true);
  // Real gaxios-7 GaxiosError shape: numeric HTTP status on .status/.response.status,
  // .code is the (here absent) transport cause. The fast-path must fire on .status.
  assert.equal(isTransientAppendError({ status: 503, response: { status: 503 }, code: undefined }), true);
  assert.equal(isTransientAppendError({ status: 429, response: { status: 429 } }), true);
  assert.equal(isTransientAppendError({ code: 403, errors: [{ reason: 'rateLimitExceeded' }] }), true);
  assert.equal(isTransientAppendError({ code: 403, errors: [{ reason: 'userRateLimitExceeded' }] }), true);

  // Must NOT retry — ambiguous (rows may already be written) or non-transient.
  assert.equal(isTransientAppendError({ code: 500 }), false); // could have written, then failed
  // A 500 whose reason/message is backendError/unavailable must STILL be non-retryable:
  // the status gate wins so the reason text cannot re-classify an ambiguous 500.
  assert.equal(isTransientAppendError({ code: 500, errors: [{ reason: 'backendError' }] }), false);
  assert.equal(isTransientAppendError({ code: 500, response: { data: { error: { message: 'backend unavailable' } } } }), false);
  assert.equal(isTransientAppendError({ code: 'ETIMEDOUT' }), false); // post-send timeout: ambiguous
  assert.equal(isTransientAppendError({ code: 403, errors: [{ reason: 'forbidden' }] }), false); // auth, not quota
  assert.equal(isTransientAppendError({ code: 400 }), false);
  assert.equal(isTransientAppendError(null), false);
});

test('retryWithBackoff succeeds on the first attempt without sleeping', async () => {
  let calls = 0;
  let slept = 0;
  const result = await retryWithBackoff(
    async () => { calls += 1; return 'ok'; },
    { isRetryable: () => true, sleep: async () => { slept += 1; } }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test('retryWithBackoff retries transient failures then succeeds, with exponential delays', async () => {
  let calls = 0;
  const delays = [];
  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      if (calls < 3) throw { code: 503 };
      return 'written';
    },
    { isRetryable: isTransientAppendError, sleep: async ms => { delays.push(ms); } }
  );
  assert.equal(result, 'written');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]); // 500 * 2^0, 500 * 2^1
});

test('retryWithBackoff throws immediately on a non-retryable error (no double-append risk)', async () => {
  let calls = 0;
  let slept = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => { calls += 1; throw { code: 500 }; },
      { isRetryable: isTransientAppendError, sleep: async () => { slept += 1; } }
    ),
    err => err.code === 500
  );
  assert.equal(calls, 1); // not retried — a 500 might mean the rows already landed
  assert.equal(slept, 0);
});

test('retryWithBackoff gives up after maxAttempts on a persistent transient error', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => { calls += 1; throw { code: 429 }; },
      { isRetryable: isTransientAppendError, sleep: async () => {} }
    ),
    err => err.code === 429
  );
  assert.equal(calls, 4); // 1 initial + 3 retries
});

test('normalizeHeaderToken collapses header variants to one token', () => {
  assert.equal(normalizeHeaderToken('Session ID'), 'sessionid');
  assert.equal(normalizeHeaderToken('session_id'), 'sessionid');
  assert.equal(normalizeHeaderToken('sessionId'), 'sessionid');
  assert.equal(normalizeHeaderToken(null), '');
  assert.equal(normalizeHeaderToken(undefined), '');
});

test('validateHeaderRow accepts a header matching the Log_Cleaned contract in order', () => {
  const { logCleanedColumns } = require('../config/columns');
  const result = validateHeaderRow(logCleanedColumns, logCleanedColumns, logRowFieldAliases);
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test('validateHeaderRow accepts accepted aliases and casing/spacing variants', () => {
  const { logCleanedColumns } = require('../config/columns');
  // A plausible hand-typed header row: title-case, spaces, and the 'date'/'volume' aliases.
  const variant = ['Date', 'Session ID', 'Exercise', 'Canonical Exercise', 'Muscle Group',
    'Lift Code', 'Set Number', 'Weight', 'Reps', 'RIR', 'Notes', 'Volume'];
  const result = validateHeaderRow(variant, logCleanedColumns, logRowFieldAliases);
  assert.equal(result.ok, true, JSON.stringify(result.mismatches));
});

test('validateHeaderRow flags a reordered column as a mismatch', () => {
  const { logCleanedColumns } = require('../config/columns');
  // Swap weight (index 7) and reps (index 8) — the exact silent-misroute risk.
  const swapped = [...logCleanedColumns];
  [swapped[7], swapped[8]] = [swapped[8], swapped[7]];
  const result = validateHeaderRow(swapped, logCleanedColumns, logRowFieldAliases);
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map(m => m.index), [7, 8]);
  assert.equal(result.mismatches[0].expected, 'weight');
  assert.equal(result.mismatches[0].actual, 'reps');
});

test('validateHeaderRow flags a too-short header with null actual', () => {
  const result = validateHeaderRow(['date_clean', 'session_id'], ['date_clean', 'session_id', 'exercise']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches, [{ index: 2, expected: 'exercise', actual: null }]);
});

test('validateHeaderRow ignores extra trailing columns beyond the contract', () => {
  const result = validateHeaderRow(
    ['date_clean', 'session_id', 'extra_user_column'],
    ['date_clean', 'session_id']
  );
  assert.equal(result.ok, true);
});

test('validateHeaderRow validates the Effort contract with its aliases', () => {
  const { effortColumns } = require('../config/columns');
  assert.equal(validateHeaderRow(effortColumns, effortColumns, effortRowFieldAliases).ok, true);
  const broken = [...effortColumns];
  [broken[5], broken[6]] = [broken[6], broken[5]]; // average_hr <-> peak_hr swap
  assert.equal(validateHeaderRow(broken, effortColumns, effortRowFieldAliases).ok, false);
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
  assert.equal(result.enriched.canonical_exercise, 'Lats');
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
  assert.equal(rowsResult.enriched.canonical_exercise, 'Rows');
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
  assert.equal(result.enriched.canonical_exercise, 'Zorblax Machine');
  assert.ok(result.warnings[0].startsWith('Unknown exercise:'));
});

test('enrichLogRow warns instead of auto-matching ambiguous substring shorthand', () => {
  const map = new Map([
    ['bench press', { canonical_exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BP' }],
    ['overhead press', { canonical_exercise: 'Overhead Press', muscle_group: 'Shoulders', lift_code: 'OHP' }]
  ]);
  const result = enrichLogRow({ exercise: 'Press' }, map);
  assert.equal(result.enriched.canonical_exercise, 'Press');
  assert.equal(result.autoMatch, undefined);
  assert.ok(result.warnings[0].startsWith('Ambiguous exercise match:'));
});

// ── generateLiftCode + lift-code fallback ─────────────────────────────────────

test('generateLiftCode: known exercises map to canonical codes', () => {
  assert.equal(generateLiftCode('Back Squat'), 'SQ01');
  assert.equal(generateLiftCode('back squat'), 'SQ01');
  assert.equal(generateLiftCode('Bench Press'), 'BEN01');
  assert.equal(generateLiftCode('bench'), 'BEN01');
  assert.equal(generateLiftCode('Deadlift'), 'DL01');
  assert.equal(generateLiftCode('Romanian Deadlift'), 'RDL01');
  assert.equal(generateLiftCode('rdl'), 'RDL01');
  assert.equal(generateLiftCode('Elliptical'), 'ELL01');
  assert.equal(generateLiftCode('Lat Pulldown'), 'LAT01');
  assert.equal(generateLiftCode('Face Pull'), 'FP01');
  assert.equal(generateLiftCode('Knee Raises'), 'KR01');
});

test('generateLiftCode: unknown exercise gets initialism fallback', () => {
  assert.equal(generateLiftCode('Cable Goblin Raises'), 'CGR01');
  assert.equal(generateLiftCode('Zorblax Machine'), 'ZMX01');
  assert.equal(generateLiftCode('Press'), 'PRE01');
});

test('generateLiftCode: empty or missing name returns UNK01', () => {
  assert.equal(generateLiftCode(''), 'UNK01');
  assert.equal(generateLiftCode(null), 'UNK01');
});

test('enrichLogRow: catalog entry with blank lift_code gets a generated fallback', () => {
  const map = new Map([['back squat', { canonical_exercise: 'Back Squat', muscle_group: 'Legs', lift_code: '' }]]);
  const result = enrichLogRow({ exercise: 'Back Squat' }, map);
  assert.equal(result.enriched.lift_code, 'SQ01');
  assert.ok(result.warnings && result.warnings[0].includes('Generated lift code'));
});

test('enrichLogRow: unknown exercise gets generated lift code, never blank', () => {
  const map = new Map();
  const result = enrichLogRow({ exercise: 'Cable Goblin Raises' }, map);
  assert.equal(result.enriched.lift_code, 'CGR01');
  assert.ok(result.enriched.lift_code.length > 0, 'lift_code must never be blank');
  assert.equal(result.enriched.muscle_group, 'Unknown');
  assert.ok(result.warnings[0].startsWith('Unknown exercise:'));
  assert.ok(result.warnings.some(warning => warning.includes("Using 'Unknown'")));
});

test('enrichLogRow: row-provided lift code takes priority over generated fallback', () => {
  const map = new Map([['custom move', { canonical_exercise: 'Custom Move', muscle_group: 'Core', lift_code: '' }]]);
  const result = enrichLogRow({ exercise: 'Custom Move', lift_code: 'CM99' }, map);
  assert.equal(result.enriched.lift_code, 'CM99');
  assert.ok(!result.warnings, 'no warning when lift code is row-provided');
});

test('generateLiftCode: single-word exercise uses first 3 letters', () => {
  assert.equal(generateLiftCode('Pullover'), 'PUL01');
  assert.equal(generateLiftCode('Row'), 'ROW01');
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

test('duration normalization rolls mm:ss minutes over 59 into hours (LO-9b)', () => {
  // A mm:ss minutes field over 59 previously emitted a malformed "00:90:30" (90 in
  // the 0–59 minutes slot). It now rolls into hours, preserving the span.
  assert.equal(normalizeDurationString('90:30'), '01:30:30');
  assert.equal(normalizeDurationString('60:00'), '01:00:00');
  assert.equal(normalizeDurationString('125:05'), '02:05:05');
  // Sub-hour mm:ss is unchanged.
  assert.equal(normalizeDurationString('59:59'), '00:59:59');
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

test('PR 486 frontend: modality logging mirrors the trust loop without altering slash logging', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  // The dry-run preview (tryPreviewModality) calls /api/log-modality with
  // test_mode:true and requires the no-write proof before staging an approval.
  assert.match(appSource, /async function tryPreviewModality/);
  assert.match(appSource, /function hasLogModalityNoWriteProof/);
  const previewBlock = appSource.slice(
    appSource.indexOf('async function tryPreviewModality'),
    appSource.indexOf('function hasAnyEffortInput')
  );
  assert.match(previewBlock, /'\/api\/log-modality'/);
  assert.match(previewBlock, /test_mode:\s*true/, 'the preview must be a dry-run');
  assert.match(previewBlock, /hasLogModalityNoWriteProof\(result\)/, 'fail closed without the no-write proof');
  assert.match(previewBlock, /generateWriteId\(\)/, 'a write_id is staged for idempotency');
  // The preview never writes: no live (test_mode-less) log-modality call here.
  assert.doesNotMatch(previewBlock, /delete[^\n]*test_mode|write_id: pendingWrite\.writeId/);

  // The ONLY live modality write is in the #approve-btn handler, gated on the
  // preview proof, and it requires an explicit success confirmation.
  const approveBlock = appSource.slice(
    appSource.indexOf("getElementById('approve-btn').addEventListener('click'"),
    appSource.indexOf("getElementById('approve-btn').addEventListener('click'") + 4000
  );
  assert.match(approveBlock, /pendingWrite\.mode === 'modality'/);
  assert.match(approveBlock, /write_id: pendingWrite\.writeId/, 'live write carries the staged write_id');
  assert.match(approveBlock, /writeData\.sheet_write !== 'success' \|\| writeData\.sheet_written !== true/);

  // Regression: the slash log-workout approve branch is unchanged — still posts
  // /api/log-workout with test_mode deleted and requires sheet_write success.
  assert.match(approveBlock, /const realPayload = \{ \.\.\.pendingWrite\.payload \}/);
  assert.match(approveBlock, /delete realPayload\.test_mode/);
  assert.match(approveBlock, /'\/api\/log-workout'/);

  // The modality hook lives ONLY in the coach-fallback branch (input the slash
  // parser rejected), so strength-set logging never routes through it.
  assert.match(appSource, /if \(await tryPreviewModality\(pendingChatText, sessionId, date\)\)/);
  const hookIdx = appSource.indexOf('if (await tryPreviewModality(pendingChatText');
  const coachRouteIdx = appSource.indexOf('routeMessageToCoach(pendingChatText)');
  assert.ok(hookIdx > 0 && coachRouteIdx > hookIdx, 'modality is tried before falling through to the coach');

  // Approval gating accepts the modality proof exactly like manual (sheet_write skipped).
  assert.match(appSource, /proof\.mode === 'modality' && proof\.sheet_write !== 'skipped'/);

  // The preview heading is modality-aware (a timed hold must not read "Cardio").
  assert.match(appSource, /const MODALITY_HEADINGS = \{/);
  assert.match(appSource, /timed_hold: 'Timed hold'/);
  assert.match(appSource, /MODALITY_HEADINGS\[preview\.modality\] \|\| 'Conditioning'/);
  assert.doesNotMatch(appSource, /'Cardio \/ conditioning to write/, 'the hardcoded cardio-only heading must be gone');

  // Question-shaped input ("how was my 5km run?") routes to the coach, never to a
  // write preview — the guard runs before the dry-run and bails out of the preview.
  assert.match(appSource, /function looksLikeModalityQuestion/);
  assert.match(appSource, /if \(looksLikeModalityQuestion\(text\)\) return false;/);
  const guardBlock = appSource.slice(
    appSource.indexOf('function looksLikeModalityQuestion'),
    appSource.indexOf('async function tryPreviewModality')
  );
  assert.match(guardBlock, /t\.endsWith\('\?'\)/, 'a trailing ? is a question');
  assert.match(guardBlock, /\^\(how\|/, 'interrogative lead words are questions');
  assert.doesNotMatch(guardBlock, /\bdid\b|\bdoes\b|\bran\b/, 'log-ambiguous verbs must NOT be treated as questions');
});

test('two-way chat: non-loggable text routes to the coach instead of erroring', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  // The helper exists and dispatches the read-only chat event (never a write).
  assert.match(appSource, /function routeMessageToCoach/);
  assert.match(appSource, /new CustomEvent\('atlas:chat-message'/);
  // It is reached from the parse-failure path and the empty-rows path.
  const submitBlock = appSource.slice(
    appSource.indexOf("getElementById('logger-form').addEventListener('submit'"),
    appSource.indexOf("getElementById('cancel-preview-btn')")
  );
  assert.match(submitBlock, /routeMessageToCoach\(chatText\)/);
  assert.match(submitBlock, /hasAnyEffortInput\(\)/, 'must not hijack a real effort/screenshot attempt');
  // Routing must not write — it only dispatches and clears the box.
  const routeBlock = appSource.slice(
    appSource.indexOf('function routeMessageToCoach'),
    appSource.indexOf('function routeMessageToCoach') + 600
  );
  assert.doesNotMatch(routeBlock, /\/api\/log-workout|\/api\/complete-workout|approve/);
});

test('live-audit PR2: a malformed SET surfaces a format hint instead of silently becoming coach chat', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  // The parser verdict is carried on the thrown error so the caller can tell a
  // failed LOG ATTEMPT apart from a question.
  assert.match(appSource, /err\.parsedIntent = parsed\?\.intent \|\| null;/);
  assert.match(appSource, /err\.recognizedExercise = \(parsed\?\.partial && parsed\.partial\.exercise\) \|\| null;/);

  // The interception is precise: needs_clarification + a recognized exercise + slash
  // notation in the input. It fires BEFORE the modality/coach routing, and returns
  // (does not also route to the coach).
  const guard = appSource.slice(
    appSource.indexOf("err.parsedIntent === 'needs_clarification' && err.recognizedExercise"),
    appSource.indexOf('if (await tryPreviewModality(pendingChatText')
  );
  assert.ok(guard.length > 0, 'the malformed-set guard must run before the modality/coach routing');
  assert.match(guard, /\/\\d\+\\s\*\\\/\\s\*\\d\+\/\.test\(pendingChatText\)/, 'must require slash-set notation');
  assert.match(guard, /setStatus\(loggerStatus, .*Check the format/, 'must surface a format hint');
  assert.match(guard, /return;/, 'must NOT fall through to the coach');
  // It must NOT suppress questions: the guard requires a recognized exercise + slash,
  // so a bare question (no recognized exercise, no slash) still reaches the coach.
  assert.doesNotMatch(guard, /routeMessageToCoach/, 'the guard itself never calls the coach');
});

test('live-audit PR3: "log it" with an empty buffer after a save says "nothing new", not a false closeout', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fn = appSource.slice(
    appSource.indexOf('async function handleLogIt()'),
    appSource.indexOf('async function handleLogIt()') + 2000
  );
  assert.ok(fn.length > 0, 'handleLogIt must exist');
  // The empty-buffer save path: lastWrite set → "nothing new", returns BEFORE the
  // /api/session/compile fallback (so the already-saved chat history is never
  // recompiled/re-written).
  const nothingNewIdx = fn.indexOf("Nothing new to log since your last save");
  const compileIdx = fn.indexOf('/api/session/compile');
  assert.ok(nothingNewIdx > 0, 'must surface a "nothing new" status');
  assert.match(fn, /if \(lastWrite\) \{[\s\S]*Nothing new to log[\s\S]*return;/, 'guarded by lastWrite, returns');
  assert.ok(compileIdx > nothingNewIdx, 'the nothing-new guard must precede the compile fallback');
  // The structured-buffer branch still wins first, so NEW sets logged after a save
  // (sessionLog non-empty) are unaffected.
  const bufferIdx = fn.indexOf('if (sessionLog.length)');
  assert.ok(bufferIdx >= 0 && bufferIdx < nothingNewIdx, 'the sessionLog branch precedes the nothing-new guard');
});

// ---------------------------------------------------------------------------
// Fix A — multi-line, one-exercise-per-line strength logging (PR1)
// ---------------------------------------------------------------------------

// Extract the PURE client local parser functions (no DOM refs) and run them, so we
// can prove behaviour, not just source shape.
function loadLocalParser() {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const start = src.indexOf('function splitWorkoutLine(');
  const end = src.indexOf('function parserStatusNode');
  assert.ok(start >= 0 && end > start, 'local parser functions must exist');
  return new Function(src.slice(start, end) + '; return { parseWorkoutText, splitWorkoutLine, parseSetSegment };')();
}

test('Fix A: the local parser logs ALL rows for one-exercise-per-line input (the failed live case)', () => {
  const local = loadLocalParser();
  const r = local.parseWorkoutText('Bench 225 5/2 x3\nWeighted dips +50 10/2 x3\nSeated row 190 10/2 x3');
  assert.equal(r.errors.length, 0, 'no per-line errors');
  assert.equal(r.rows.length, 9, '3 lines × 3 sets = 9 rows');
  const exercises = [...new Set(r.rows.map(x => x.exercise))];
  assert.deepEqual(exercises, ['Bench', 'Weighted dips', 'Seated row'], 'all three exercises present');
  // Each exercise keeps its own weight (added-load +50 → 50; no cross-line bleed).
  assert.deepEqual(r.rows.filter(x => x.exercise === 'Weighted dips').map(x => x.weight), ['50', '50', '50']);
  assert.deepEqual(r.rows.filter(x => x.exercise === 'Bench').map(x => [x.weight, x.reps, x.rir]), [['225', '5', '2'], ['225', '5', '2'], ['225', '5', '2']]);
});

test('Fix A: a single line still parses to exactly one exercise (no regression)', () => {
  const local = loadLocalParser();
  const r = local.parseWorkoutText('Seated row 190 10/2 x3');
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows.length, 3);
  assert.deepEqual([...new Set(r.rows.map(x => x.exercise))], ['Seated row']);
});

test('Fix A: multi-line routing is gated to newline-separated input with a CLEAN local parse', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  // The backend rejection carries the multi-exercise flag.
  assert.match(appSource, /err\.multipleExercises = Array\.isArray\(parsed\?\.warnings\) && parsed\.warnings\.includes\('multiple_exercises_in_input'\)/);
  // The routing branch sits inside rowsFromWorkoutInput's catch, BEFORE the
  // noFallback throw (which would otherwise drop to the coach).
  const fn = appSource.slice(
    appSource.indexOf('async function rowsFromWorkoutInput()'),
    appSource.indexOf('if (parsed.intent ===')
  );
  const branchIdx = fn.indexOf('if (backendError.multipleExercises && /\\n/.test(workoutText))');
  const throwIdx = fn.indexOf('if (!shouldUseLocalFallback(backendError)) throw backendError;');
  assert.ok(branchIdx > 0, 'the multi-line branch must exist');
  assert.ok(throwIdx > branchIdx, 'it must run BEFORE the noFallback throw (so it never drops to the coach)');
  const branch = fn.slice(branchIdx, throwIdx);
  // Requires a newline (same-line mixing stays blocked) and a CLEAN parse (no silent
  // logging of uncertain rows), and it returns (no coach fallback for this case).
  assert.match(branch, /\/\\n\/\.test\(workoutText\)/, 'gated on a newline → same-line mixing not routed here');
  assert.match(branch, /!multi\.errors\.length && multi\.rows\.length/, 'only a clean, non-empty local parse is used');
  assert.match(branch, /populateSetRows\(multi\.rows\)/);
  assert.match(branch, /return;/, 'on success it returns — never reaches the coach path');
});

test('Step 373: currentPlanForChat reads the live planned session before the cached recommendation', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  const fn = appSource.slice(
    appSource.indexOf('function currentPlanForChat()'),
    appSource.indexOf('function currentPlanForChat()') + 1100
  );
  // The authoritative branch reads activePlannedSession.exercises FIRST...
  const sessionIdx = fn.indexOf('activePlannedSession.exercises');
  const fallbackIdx = fn.indexOf('lastIntentData');
  assert.ok(sessionIdx !== -1, 'must derive the plan from the live activePlannedSession');
  assert.ok(fallbackIdx !== -1, 'must keep the cached-recommendation fallback');
  assert.ok(sessionIdx < fallbackIdx, 'the live session must be preferred over the cached recommendation');
  // ...and keys names as canonicalName||name so they reconcile with
  // resolveCompletedIdentity / sessionCompleted on the server.
  assert.match(fn, /ex\.canonicalName \|\| ex\.name/, 'plan name key must match resolveCompletedIdentity');
});

test('Step 373b: a declared swap is recorded and applied to the live session at log time', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  // State + helper exist, and the helper is the keep-in-sync mirror of the engine.
  assert.match(appSource, /let pendingSubstitution = null/, 'must declare pendingSubstitution state');
  assert.match(appSource, /function applySessionSubstitution\(/, 'must define the live-session substitution helper');
  assert.match(appSource, /keep in sync with applySubstitution in services\/sessionPlanExecutor\.js/,
    'helper must carry the keep-in-sync marker to the engine');

  // The swap is recorded when the lifter declares it (substitute suggestion path).
  const suggestFn = appSource.slice(
    appSource.indexOf('async function checkAndSuggestSubstitute'),
    appSource.indexOf('async function checkAndSuggestSubstitute') + 900
  );
  assert.match(suggestFn, /pendingSubstitution = \{ prescribed:/, 'must record the prescribed lift on a declared swap');

  // emitSetLogged applies the swap BEFORE the identity-resolution loop so the
  // substitute (not the swapped-out lift) is what gets marked done.
  const emitFn = appSource.slice(
    appSource.indexOf('function emitSetLogged('),
    appSource.indexOf('function emitSetLogged(') + 1400
  );
  const applyIdx = emitFn.indexOf('applySessionSubstitution(');
  const loopIdx = emitFn.indexOf('for (const o of (logObjs');
  assert.ok(applyIdx !== -1, 'emitSetLogged must apply the pending substitution');
  assert.ok(applyIdx < loopIdx, 'substitution must be applied before resolveCompletedIdentity runs');

  // The helper mutates the live session and re-renders the banner, and dedupes.
  const helper = appSource.slice(
    appSource.indexOf('function applySessionSubstitution('),
    appSource.indexOf('function startPlannedSession(')
  );
  assert.match(helper, /renderActiveSessionBanner\(\)/, 'must re-render the banner after a swap');
  assert.match(helper, /dupElsewhere/, 'must guard against duplicating an already-planned substitute');
  assert.match(helper, /if \(subKey === prescKey\) return/, 'logging the prescribed lift itself must be a no-op');

  // The declaration is cleared when the session ends.
  const endFn = appSource.slice(
    appSource.indexOf('function endPlannedSession()'),
    appSource.indexOf('function endPlannedSession()') + 900
  );
  assert.match(endFn, /pendingSubstitution = null/, 'ending the session must clear any pending swap');

  // Lifecycle symmetry: starting a session must not inherit a stale swap.
  const startFn = appSource.slice(
    appSource.indexOf('function startPlannedSession('),
    appSource.indexOf('function startPlannedSession(') + 320
  );
  assert.match(startFn, /pendingSubstitution = null/, 'starting a session must clear any stale pending swap');
});

test('Step 379: a declared swap advances the session cursor so subsequent checks use the next slot', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  const suggestFn = appSource.slice(
    appSource.indexOf('async function checkAndSuggestSubstitute'),
    appSource.indexOf('async function checkAndSuggestSubstitute') + 2200
  );

  // current_exercise is sourced from the cursor — so the cursor must move once a
  // swap is declared, or the next conversational message re-sends the taken lift.
  const currentExIdx = suggestFn.indexOf('activePlannedSession.exercises[activePlannedSession.index]');
  const recordIdx = suggestFn.indexOf('pendingSubstitution = { prescribed:');
  const advanceIdx = suggestFn.indexOf('activePlannedSession.index += 1');
  assert.ok(currentExIdx !== -1, 'current_exercise must be read from the cursor slot');
  assert.ok(recordIdx !== -1, 'must record the prescribed lift before advancing');
  assert.ok(advanceIdx !== -1, 'must advance the authoritative session cursor after a declared swap');
  // Order matters: the prescribed (taken) lift is recorded against the PRE-advance
  // slot, then the cursor moves on. Reversing it would record the wrong slot.
  assert.ok(recordIdx < advanceIdx, 'the swap must be recorded before the cursor advances');

  // The advance must be clamped so the last slot does not overrun / end the session,
  // and must re-render the banner so the displayed step matches the new cursor.
  const advanceBlock = suggestFn.slice(recordIdx, advanceIdx + 120);
  assert.match(advanceBlock, /activePlannedSession\.index < activePlannedSession\.exercises\.length - 1/,
    'the cursor advance must be clamped to the plan length');
  assert.match(advanceBlock, /renderActiveSessionBanner\(\)/, 'must re-render the banner after advancing');

  // Must NOT reuse advancePlannedSession(): that clears pendingSubstitution (so the
  // deferred swap would be lost) and restarts the logger input mid-conversation. The
  // advance is an inline, clamped index bump — assert no actual call statement exists
  // (the explanatory comment names the function, so match an invocation, not the name).
  assert.doesNotMatch(suggestFn, /^\s*advancePlannedSession\(\);?\s*$/m,
    'must not call advancePlannedSession() — it would clear the pending swap and restart the logger');
});

test('two-way chat: coach-conversation handles the chat event read-only via /api/coach/chat', () => {
  const convSource = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');

  assert.match(convSource, /addEventListener\('atlas:chat-message'/);
  assert.match(convSource, /'\/api\/coach\/chat'/);
  assert.match(convSource, /method: 'POST'/);
  // In-session history, bounded; falls back when the voice is unavailable.
  assert.match(convSource, /chatTurns/);
  assert.match(convSource, /function chatFallback/);
  // History sent must be PRIOR turns only (no double-send), but the current user
  // turn is recorded immediately after capture so an in-flight second message
  // still sees it. Atlas's reply is appended after it arrives.
  const chatBlock = convSource.slice(convSource.indexOf('Free-form chat'));
  const priorIdx = chatBlock.indexOf('const priorTurns = chatTurns.slice(-8)');
  const userPushIdx = chatBlock.indexOf("chatTurns.push({ role: 'user', text })");
  const replyIdx = chatBlock.indexOf("getChatReply(text, priorTurns");
  assert.ok(priorIdx !== -1, 'must capture priorTurns');
  assert.ok(userPushIdx > priorIdx, 'user turn recorded immediately after capturing priorTurns');
  assert.ok(replyIdx > userPushIdx, 'getChatReply still receives priorTurns only (current msg sent as message)');
  assert.match(chatBlock, /chatTurns\.push\(\{ role: 'atlas', text: reply \}\)/);
  // The chat path must never touch the write/approve machinery.
  assert.doesNotMatch(chatBlock, /approveBtn\.click|\/api\/log-workout|\/api\/complete-workout/);
});

test('major-lift ramp: suggested-workout display renders the engine warm-up ramp before working sets', () => {
  const convSource = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');

  // Reads the engine-owned warmup_sets off the raw intent exercise (the lead
  // compound only); normalizePlanExercise intentionally drops them.
  assert.match(convSource, /function warmupSetsFor\(raw\)/);
  assert.match(convSource, /raw\.warmup_sets/);
  // Warm-ups are formatted as priming sets (no RIR), marked "warm-up" so they
  // read as a build-up, distinct from working sets.
  assert.match(convSource, /function formatWarmupSetLine/);
  assert.match(convSource, /warm-up/);

  // In BOTH render paths the warm-up loop precedes the working-set loop, so the
  // ramp climbs INTO the working weight (never a substitute for the working sets).
  for (const fn of ['suggestedExercisesBlock', 'appendWorkoutPlan']) {
    const start = convSource.indexOf(`function ${fn}`);
    assert.ok(start !== -1, `${fn} must exist`);
    const body = convSource.slice(start, start + 2000);
    const warmIdx = body.indexOf('warmupSetsFor(raw)');
    const workIdx = body.indexOf('formatPlanSetLine');
    assert.ok(warmIdx !== -1, `${fn} must render warm-up sets`);
    assert.ok(workIdx !== -1, `${fn} must render working sets`);
    assert.ok(warmIdx < workIdx, `${fn} must render the ramp before the working sets`);
  }

  // The structured path tags warm-ups with their own class (visual distinction);
  // it must never route planned warm-ups into the write/approve loop.
  assert.match(convSource, /workout-plan-warmup/);
  assert.doesNotMatch(convSource, /warmup_sets[^\n]*\/api\/log-workout/);
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

test('proposed edit: validateProposedEdit checks rowCount bounds and field bounds', () => {
  const ccSource = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  assert.match(ccSource, /function validateProposedEdit\(edit, rowCount\)/);
  // Index must be < rowCount
  assert.match(ccSource, /edit\.index >= rowCount/);
  // EDIT_BOUNDS must cover all three constrained fields with correct maxes
  assert.match(ccSource, /weight.*1500/);
  assert.match(ccSource, /reps.*100/);
  assert.match(ccSource, /rir.*10/);
  // All three actions must be allowed
  assert.match(ccSource, /update_set.*delete_set.*add_set/);
});

test('proposed edit: applyProposedEdit always calls invalidatePreview and never touches the write path', () => {
  const ccSource = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  assert.match(ccSource, /function applyProposedEdit\(edit\)/);
  const applyBlock = ccSource.slice(
    ccSource.indexOf('function applyProposedEdit(edit)'),
    ccSource.indexOf('function getChatReply')
  );
  assert.match(applyBlock, /invalidatePreview/,
    'applyProposedEdit must call invalidatePreview so the lifter re-previews after edit');
  assert.doesNotMatch(applyBlock, /approveBtn\.click|\/api\/log-workout|\/api\/complete-workout|appendRows/,
    'applyProposedEdit must never touch any write path');
});

// ── PR 484: deterministic LLM-down voicing of the training-intelligence advisories ──

test('PR 484: getInWorkoutNote voices next-move + recovery advisories on the deterministic paths only', () => {
  const ccSource = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const block = ccSource.slice(
    ccSource.indexOf('async function getInWorkoutNote('),
    ccSource.indexOf('async function getLlmCoachingMessage(')
  );
  assert.ok(block, 'getInWorkoutNote block must be present');
  // The two engine advisories are worded via the pure templates.
  assert.match(block, /templatedNextMoveAdvisoryLine\(data\.next_move_advisory\)/,
    'next-move advisory must be voiced from the engine fact');
  assert.match(block, /templatedRecoveryAdvisoryLine\(data\.recovery_advisory\)/,
    'recovery advisory must be voiced from the engine fact');
  // The LLM-prose path must return BEFORE any advisory append, so the LLM (which
  // already worded the advisories) is never duplicated by the deterministic lines.
  const llmReturnIdx = block.indexOf('if (llm && llm.trim()) return { note: llm');
  const nextMoveUseIdx = block.indexOf('joinLines(voice.primary_line, nextMoveLine, recoveryLine)');
  const openerJoinIdx = block.indexOf('joinLines(opener, nextMoveLine)');
  assert.ok(llmReturnIdx > -1, 'LLM-prose early return must exist');
  assert.ok(openerJoinIdx > llmReturnIdx,
    'the opener+advisory deterministic path must come AFTER the LLM early return');
  assert.ok(nextMoveUseIdx > -1, 'the suppressed-prose path must also carry the advisories');
  // Conclusion-first: a recovery read is the headline and overrides the opener.
  assert.match(block, /if \(recoveryLine\) \{[\s\S]*joinLines\(recoveryLine, nextMoveLine\)/,
    'a recovery read must lead and override the progression-invite opener');
  // The same override must also apply on the SUPPRESSED-prose path for a `bump`
  // severity — `bump` is itself an add-load invite, so a co-occurring recovery read
  // must override it (never "add weight" + "deload" in one breath). Other suppressed
  // severities (block/caution/on_target) are back-off-consistent and keep the headline.
  assert.match(block, /recoveryLine && voice\.severity === 'bump'[\s\S]*joinLines\(recoveryLine, nextMoveLine\)/,
    'a recovery read must override a bump set line on the suppressed-prose path too');
});

// ── Coach's Pick engagement gate: a displayed suggestion is not an active plan ──

test('coach-pick gate: plannedExerciseEntries treats lastIntentData as a plan ONLY when engaged', () => {
  const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  // The engagement flag exists, defaults false, and has accessors for the coach layer.
  assert.match(appSrc, /let coachSuggestionEngaged = false;/, 'engagement flag must default false');
  assert.match(appSrc, /function setCoachSuggestionEngaged\(v\)/, 'a setter must be exposed for the coach layer');
  // plannedExerciseEntries() short-circuits to [] for the lastIntentData branch unless engaged.
  const block = appSrc.slice(
    appSrc.indexOf('function plannedExerciseEntries('),
    appSrc.indexOf('function plannedExerciseOrder(')
  );
  assert.ok(block, 'plannedExerciseEntries block must be present');
  const activeIdx = block.indexOf('activePlannedSession && activePlannedSession.exercises.length');
  const gateIdx = block.indexOf('if (!coachSuggestionEngaged) return [];');
  const intentIdx = block.indexOf('lastIntentData && lastIntentData.intents');
  assert.ok(gateIdx > -1, 'the engagement gate must be present');
  // The gate must sit AFTER the activePlannedSession branch (a started session always wins)
  // and BEFORE the lastIntentData branch (so a displayed-but-unengaged pick is never the plan).
  assert.ok(activeIdx > -1 && activeIdx < gateIdx, 'active session branch precedes the gate');
  assert.ok(gateIdx < intentIdx, 'the gate must guard the lastIntentData branch');
});

test('coach-pick gate: engaged on Coach\'s Pick, cleared on Freestyle', () => {
  const ccSrc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const pick = ccSrc.slice(ccSrc.indexOf('async function typeSuggestedWorkout('), ccSrc.indexOf('async function typeSuggestedWorkout(') + 600);
  assert.match(pick, /setCoachSuggestionEngaged === 'function'\) setCoachSuggestionEngaged\(true\)/,
    'tapping Coach\'s Pick must engage the suggestion');
  const free = ccSrc.slice(ccSrc.indexOf('async function startFreestyle('), ccSrc.indexOf('async function startFreestyle(') + 400);
  assert.match(free, /setCoachSuggestionEngaged === 'function'\) setCoachSuggestionEngaged\(false\)/,
    'Freestyle must clear any prior engagement');
});

// ── Suggested-workout display formatting (RIR must never be silently dropped) ──

// Extract the pure formatPlanSetLine helper from the coach-conversation IIFE.
function loadFormatPlanSetLine() {
  const ccSource = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const src = ccSource.slice(
    ccSource.indexOf('function formatPlanSetLine(ex)'),
    ccSource.indexOf('function suggestedExercisesBlock(rec)')
  );
  return new Function(`${src}; return formatPlanSetLine;`)();
}

// Extract normalizePlanExercise from app.js (carries rir through for display).
function loadNormalizePlanExercise() {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const src = appSource.slice(
    appSource.indexOf('function normalizePlanExercise(raw)'),
    appSource.indexOf('/* ===== Active planned session')
  );
  return new Function(`${src}; return normalizePlanExercise;`)();
}

test('suggested workout set line: RIR present renders {weight}lbs {reps}/{rir}', () => {
  const formatPlanSetLine = loadFormatPlanSetLine();
  assert.equal(formatPlanSetLine({ weight: 50, reps: 15, rir: 3 }), '50lbs 15/3');
  assert.equal(formatPlanSetLine({ weight: 225, reps: 5, rir: 2 }), '225lbs 5/2');
  assert.equal(formatPlanSetLine({ weight: 30, reps: 8, rir: 0 }), '30lbs 8/0');
});

test('suggested workout set line: missing RIR renders {weight}lbs {reps}/?', () => {
  const formatPlanSetLine = loadFormatPlanSetLine();
  assert.equal(formatPlanSetLine({ weight: 50, reps: 15 }), '50lbs 15/?');
  assert.equal(formatPlanSetLine({ weight: 50, reps: 15, rir: null }), '50lbs 15/?');
  assert.equal(formatPlanSetLine({ weight: 50, reps: 15, rir: undefined }), '50lbs 15/?');
});

test('suggested workout set line: never renders bare {weight}lbs {reps} (RIR never dropped)', () => {
  const formatPlanSetLine = loadFormatPlanSetLine();
  for (const ex of [{ weight: 50, reps: 15, rir: 3 }, { weight: 50, reps: 15 }, { weight: 50, reps: 15, rir: null }]) {
    const line = formatPlanSetLine(ex);
    assert.ok(line.includes('/'), `set line must include a "/" RIR marker, got "${line}"`);
    assert.notEqual(line, '50lbs 15', 'bare "{weight}lbs {reps}" with no RIR is forbidden');
  }
});

test('normalizePlanExercise carries target_rir (and next_target.rir) through to display', () => {
  const normalizePlanExercise = loadNormalizePlanExercise();
  assert.equal(
    normalizePlanExercise({ exercise: 'Face Pull', target_weight: 50, target_reps: 15, target_sets: 3, target_rir: 3 }).rir,
    3
  );
  assert.equal(
    normalizePlanExercise({ exercise: 'Bench Press', next_target: { weight: 225, reps: 5, rir: 2 } }).rir,
    2
  );
  // Missing RIR → null (the display layer renders "/?" — it is never invented).
  assert.equal(
    normalizePlanExercise({ exercise: 'Shrugs', target_weight: 75, target_reps: 15, target_sets: 3 }).rir,
    null
  );
});

test('suggested workout renders a structured block: bold names via <strong>, no bullets', () => {
  const ccSource = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const block = ccSource.slice(
    ccSource.indexOf('function appendWorkoutPlan(container, rec)'),
    ccSource.indexOf('function suggestedWorkoutProseLines')
  );
  // Exercise names are bold via a real <strong> element, not markdown asterisks.
  assert.match(block, /createElement\('strong'\)/, 'exercise names must render as <strong>');
  assert.match(block, /formatPlanSetLine\(ex\)/, 'set lines must use the RIR-safe formatter');
  // No bullet characters injected into the workout block.
  assert.doesNotMatch(block, /['"`][*•\-]\s/, 'workout block must not inject bullets');
  // The structured path is actually wired into the tile handler.
  assert.match(ccSource, /appendWorkoutPlan\(body, rec\)/,
    'typeSuggestedWorkout must render the structured workout block');
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

test('local fallback parser mirrors the backend added-load (+NN) strip so it buffers offline', () => {
  // Root cause of the live "added-load not entering session state" bug: the
  // CLIENT local fallback parser could not parse "Dips +25 8/2" (splitWorkoutLine
  // returned null), so the set routed to the coach and never buffered into
  // sessionLog. The local parser must mirror the backend slice-2b strip.
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  // The strip runs inside the local parseWorkoutText line loop, BEFORE splitWorkoutLine.
  const fn = appSource.slice(
    appSource.indexOf('function parseWorkoutText(text)'),
    appSource.indexOf('function parserStatusNode')
  );
  assert.ok(fn.length > 0, 'local parseWorkoutText(text) must exist');
  assert.match(fn, /\.replace\(\/\(\^\|\\s\)\\\+\(\\d\)\/g, '\$1\$2'\)/,
    'local parser must strip a token-leading "+" before a load (mirrors backend #526)');
  // Anchored form only — a "+" between digits ("225+25") is NOT stripped.
  assert.doesNotMatch(fn, /\.replace\(\/\\\+\(\\d\)\/g/, 'must not use the un-anchored global strip');
  // The strip precedes the splitWorkoutLine call in the loop.
  const stripIdx = fn.indexOf("replace(/(^|\\s)\\+(\\d)/g");
  const splitIdx = fn.indexOf('splitWorkoutLine(line)');
  assert.ok(stripIdx >= 0 && splitIdx > stripIdx, 'strip must run before splitWorkoutLine');
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
  assert.ok(rowsFunction.indexOf('parseWorkoutTextWithBackend(workoutText)') < rowsFunction.indexOf('parseWorkoutText(workoutText'));
  assert.match(rowsFunction, /console\.warn.*parse-workout-text unavailable/);
  assert.doesNotMatch(rowsFunction, /setStatus.*Backend parser unavailable/);
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
  assert.match(converter, /weight: set\.weight == null \? '0' : String\(set\.weight\)/);
  assert.match(converter, /reps: set\.reps == null \? '' : String\(set\.reps\)/);
  assert.match(converter, /rir: set\.rir == null \? '' : String\(set\.rir\)/);
});

test('fallback_gate_classifies_errors_correctly', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const helperSource = appSource.slice(
    appSource.indexOf('function shouldUseLocalFallback(err)'),
    appSource.indexOf('function effortMode()')
  );
  const shouldUseLocalFallback = new Function(`${helperSource}; return shouldUseLocalFallback;`)();

  assert.equal(shouldUseLocalFallback(new Error('network failed')), true);
  assert.equal(shouldUseLocalFallback(Object.assign(new Error('server failed'), { status: 500 })), true);
  assert.equal(shouldUseLocalFallback(Object.assign(new Error('server unavailable'), { status: 503 })), true);
  assert.equal(shouldUseLocalFallback(Object.assign(new Error('bad request'), { status: 400 })), false);
  assert.equal(shouldUseLocalFallback(Object.assign(new Error('unauthorized'), { status: 401 })), false);
  assert.equal(shouldUseLocalFallback(Object.assign(new Error('forbidden'), { status: 403 })), false);
  assert.equal(shouldUseLocalFallback(Object.assign(new Error('clarify'), { noFallback: true })), false);
});

test('clarification_intents_are_tagged_no_fallback', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const converterSource = appSource.slice(
    appSource.indexOf('function rowsFromBackendParsedWorkout(parsed)'),
    appSource.indexOf('async function parseWorkoutTextWithBackend')
  );
  const rowsFromBackendParsedWorkout = new Function(`${converterSource}; return rowsFromBackendParsedWorkout;`)();
  const press = buildWorkoutTextParseDryRunResponse({
    text: 'Press 135 8/2',
    test_mode: 'true'
  });

  assert.throws(
    () => rowsFromBackendParsedWorkout(press.parsed),
    err => err.noFallback === true && /Which press/i.test(err.message)
  );
  assert.throws(
    () => rowsFromBackendParsedWorkout({ intent: 'finish_session', sets: [] }),
    err => err.noFallback === true && /finish\/save command/i.test(err.message)
  );
  assert.throws(
    () => rowsFromBackendParsedWorkout({ intent: 'effort_capture', sets: [] }),
    err => err.noFallback === true && /watch\/effort data/i.test(err.message)
  );
});

test('clarification_blocks_local_parser_invocation', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const rowsFunction = appSource.slice(
    appSource.indexOf('async function rowsFromWorkoutInput()'),
    appSource.indexOf('function effortMode()')
  );
  const catchStart = rowsFunction.indexOf('catch (backendError)');
  const rethrowCheck = rowsFunction.indexOf('if (!shouldUseLocalFallback(backendError)) throw backendError;', catchStart);

  assert.ok(catchStart >= 0);
  assert.ok(rethrowCheck > catchStart);
  // The GENERAL local fallback (labelled 'local') stays AFTER the rethrow — a
  // clarification is never silently re-parsed locally into uncertain rows.
  const generalFallback = rowsFunction.indexOf("lastParserStatus = { source: 'local' }", catchStart);
  assert.ok(generalFallback > rethrowCheck, 'the general local fallback must follow the rethrow check');
  // EXCEPTION (Fix A, authorized): a `multiple_exercises_in_input` clarification with
  // newline-separated lines IS routed to the local parser — but ONLY inside that
  // explicit guard, and only when the local parse is clean. Any pre-rethrow local
  // parse must sit inside that guard, so no OTHER clarification can trigger it.
  const preRethrow = rowsFunction.slice(catchStart, rethrowCheck);
  const preCall = preRethrow.indexOf('parseWorkoutText(workoutText');
  if (preCall >= 0) {
    const guardIdx = preRethrow.indexOf('backendError.multipleExercises && /\\n/.test(workoutText)');
    assert.ok(guardIdx >= 0 && guardIdx < preCall, 'a pre-rethrow local parse must be inside the multi-line guard');
  }
});

test('parser_status_label_cannot_lie', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const localAssignments = appSource.match(/lastParserStatus = \{ source: 'local' \}/g) || [];
  const rowsFunction = appSource.slice(
    appSource.indexOf('async function rowsFromWorkoutInput()'),
    appSource.indexOf('function effortMode()')
  );
  const catchStart = rowsFunction.indexOf('catch (backendError)');
  const rethrowCheck = rowsFunction.indexOf('if (!shouldUseLocalFallback(backendError)) throw backendError;', catchStart);
  const localStatus = rowsFunction.indexOf("lastParserStatus = { source: 'local' }", catchStart);
  const noFallbackPath = rowsFunction.slice(catchStart, rethrowCheck);

  assert.equal(localAssignments.length, 1);
  assert.ok(localStatus > rethrowCheck);
  // The pre-rethrow region must never claim the 'local' label (that can only follow
  // a real local parse below the rethrow check).
  assert.doesNotMatch(noFallbackPath, /lastParserStatus = \{ source: 'local' \}/);
  // It MAY set a status only for the planned-lead reattach — and only after a
  // successful backend re-parse populated rows, so the label still cannot lie.
  if (/lastParserStatus\s*=/.test(noFallbackPath)) {
    assert.match(noFallbackPath, /populateSetRows\(replanned\)[\s\S]*lastParserStatus = \{ source: 'backend-replanned' \}/);
  }
});

test('clarification_leaves_text_unparsed', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const rowsFunction = appSource.slice(
    appSource.indexOf('async function rowsFromWorkoutInput()'),
    appSource.indexOf('function effortMode()')
  );
  const backendPopulate = rowsFunction.indexOf('populateSetRows(parsed.rows)');
  const localPopulate = rowsFunction.indexOf('populateSetRows(localResult.rows)');
  const rethrowCheck = rowsFunction.indexOf('if (!shouldUseLocalFallback(backendError)) throw backendError;');
  const markParsed = rowsFunction.lastIndexOf('lastParsedWorkoutText = workoutText');

  assert.ok(backendPopulate >= 0, 'backend populateSetRows call missing');
  assert.ok(localPopulate >= 0, 'local fallback populateSetRows call missing');
  assert.ok(markParsed > backendPopulate);
  assert.ok(markParsed > localPopulate);
  assert.ok(rethrowCheck < markParsed);
});

test('update_last_set_and_delete_last_set_are_wired_in_app', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const rowsFunction = appSource.slice(
    appSource.indexOf('async function rowsFromWorkoutInput()'),
    appSource.indexOf('function effortMode()')
  );
  assert.match(rowsFunction, /parsed\.intent === 'delete_last_set'/, 'delete_last_set dispatch missing');
  assert.match(rowsFunction, /parsed\.intent === 'update_last_set'/, 'update_last_set dispatch missing');
  assert.match(rowsFunction, /deleteLastSetRow\(\)/, 'deleteLastSetRow call missing');
  assert.match(rowsFunction, /applyUpdateToLastRow\(parsed\.update\)/, 'applyUpdateToLastRow call missing');
  assert.match(appSource, /function deleteLastSetRow\(\)/, 'deleteLastSetRow definition missing');
  assert.match(appSource, /function applyUpdateToLastRow\(update\)/, 'applyUpdateToLastRow definition missing');
});

test('update_last_set_parser_returns_update_fields', () => {
  const result = parseWorkoutText('rir was 2');
  assert.equal(result.intent, 'update_last_set');
  assert.equal(result.update.rir, 2);
});

test('delete_last_set_parser_returns_intent', () => {
  const result = parseWorkoutText('delete last set');
  assert.equal(result.intent, 'delete_last_set');
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

test('flaky/partial backend parse is fallback-eligible so the local parser can recover', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const parserFunction = appSource.slice(
    appSource.indexOf('async function parseWorkoutTextWithBackend(workoutText)'),
    appSource.indexOf('function populateSetRows')
  );
  // A partial/untrustworthy backend response (proof fields missing, or a log_sets
  // reply with no actual sets) must still THROW — we never trust it.
  assert.match(parserFunction, /Backend parser did not prove no-write safety/);
  assert.match(parserFunction, /Backend parser did not produce any set rows/);
  // ...but neither throw may TAG the error noFallback (the assignment, not the word
  // in a comment). On flaky signal that lets rowsFromWorkoutInput fall back to the
  // pure client-side local parser (which never writes) instead of dropping a
  // clearly-typed set into chat. The deliberate non-log answers keep noFallback —
  // see clarification_intents_are_tagged_no_fallback.
  assert.doesNotMatch(parserFunction, /\.noFallback\s*=/);
});

test('local parser recovers a clearly-typed named set on flaky signal (lb suffix, slash notation)', () => {
  // The live failure that motivated the fallback: "Lat Pulldown 175lbs 8/2 8/2 8/2"
  // dropped into chat as "Noted — keep logging" when the backend parse came back
  // partial on mobile signal. The local parser handles it cleanly, so the fallback
  // logs a real named set instead.
  const result = parseWorkoutText('Lat Pulldown 175lbs 8/2 8/2 8/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.equal(result.sets.length, 3);
  for (const set of result.sets) {
    assert.equal(set.weight, 175);
    assert.equal(set.reps, 8);
    assert.equal(set.rir, 2);
  }
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
  assert.match(statusFunction, /Parsed locally/);
  assert.match(appSource, /lastParserStatus = \{ source: 'backend' \}/);
  assert.match(appSource, /lastParserStatus = \{ source: 'local' \}/);
  assert.match(appSource, /const parseStatus = parserStatusNode\(lastParserStatus\)/);
  assert.doesNotMatch(statusFunction, /pendingWrite\s*=/);
  assert.match(cssSource, /\.parser-status/);
});

test('backend down fallback parity and gating', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fallbackFunction = appSource.slice(
    appSource.indexOf('async function rowsFromWorkoutInput()'),
    appSource.indexOf('function effortMode()')
  );
  const local = parseWorkoutText('Bench 225 5/2');

  assert.equal(local.intent, 'log_sets');
  assert.equal(local.canonical_name, 'Bench Press');
  assert.deepEqual(compactParsedSets(local), [[225, 5, 2]]);
  assert.match(fallbackFunction, /console\.warn.*parse-workout-text unavailable/);
  assert.doesNotMatch(fallbackFunction, /setStatus.*Backend parser unavailable/);
  assert.match(fallbackFunction, /lastParserStatus = \{ source: 'local' \}/);
  assert.doesNotMatch(fallbackFunction, /pendingWrite\s*=/);
  assert.match(appSource, /if \(!hasLogWorkoutNoWriteProof\(result\)\)/);
  assert.match(appSource, /data\.test_mode === true/);
  assert.match(appSource, /data\.sheet_written === false/);
  assert.match(appSource, /data\.no_write_confirmed === true/);
});

test('parser source state clears on invalidate', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const invalidateFunction = appSource.slice(
    appSource.indexOf('function invalidatePreview()'),
    appSource.indexOf("document.getElementById('logger-form').addEventListener('input', invalidatePreview)")
  );

  assert.match(invalidateFunction, /pendingWrite = null/);
  assert.match(invalidateFunction, /lastParserStatus = null/);
  assert.match(invalidateFunction, /previewPanel\.hidden = true/);
  assert.match(invalidateFunction, /btn\.disabled = true/);
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

test('slp_x_notation_does_not_create_70_rows', () => {
  const result = parseWorkoutText('slp 70 x 12 @2');
  // parseSetsFirst must not treat 70 as set count — guard rejects setCount > 10
  assert.ok(result.sets === undefined || result.sets.length <= 10,
    `expected ≤10 sets, got ${result.sets?.length}`);
  assert.ok(!result.sets?.some(s => s.weight === 2),
    'weight must not be 2 (the catastrophic misparse value)');
});

test('slp_multiplication_symbol_does_not_create_70_rows', () => {
  // normalizeParserText converts × (U+00D7) to x before parsing
  const result = parseWorkoutText('slp 70 × 12 @2');
  assert.ok(result.sets === undefined || result.sets.length <= 10,
    `expected ≤10 sets, got ${result.sets?.length}`);
  assert.ok(!result.sets?.some(s => s.weight === 2),
    'weight must not be 2 after multiplication-sign normalisation');
});

test('sets_first_small_count_boundary_still_safe', () => {
  // parseSetsFirst setCount=3 is below the cap of 10 — must not produce wrong output
  const result = parseWorkoutText('slp 3 x 10 @225');
  // Either produces 3 sets at weight=225 or clarifies — neither is catastrophic
  if (result.intent === 'log_sets') {
    assert.equal(result.sets.length, 3);
    assert.ok(result.sets.every(s => s.weight === 225),
      'each set must have the correct weight when set-count notation is used');
  } else {
    assert.equal(result.intent, 'needs_clarification');
  }
});

test('sets_first_above_cap_refuses', () => {
  // setCount=11 exceeds the guard threshold — parseSetsFirst must return null
  // and the input should clarify rather than produce 11 rows
  const result = parseWorkoutText('slp 11 x 10 @225');
  assert.ok(result.sets === undefined || result.sets.length <= 10,
    `setCount 11 must not produce 11+ rows, got ${result.sets?.length}`);
});

test('slp_slash_notation_unaffected', () => {
  // The fix must not regress normal slash (reps/RIR) shorthand for SLP
  const result = parseWorkoutText('slp 70 12/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Single-Leg Seated Leg Press');
  assert.deepEqual(compactParsedSets(result), [[70, 12, 2]]);
});

test('shorthand_single_group_slash_is_reps_rir', () => {
  const result = parseWorkoutText('Bench 225 5/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.equal(result.sets.length, 1);
  assert.deepEqual(compactParsedSets(result), [[225, 5, 2]]);
});

test('shorthand_chained_sets_inherit_weight', () => {
  const result = parseWorkoutText('Squats 205 7/2 6/2 6/1');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Back Squat');
  assert.deepEqual(compactParsedSets(result), [[205, 7, 2], [205, 6, 2], [205, 6, 1]]);
});

test('shorthand_multiple_weight_groups', () => {
  const result = parseWorkoutText('Bench 135 10/4 185 8/3 225 5/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(compactParsedSets(result), [[135, 10, 4], [185, 8, 3], [225, 5, 2]]);
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

test('workout parser supports xN repeat shorthand for lat pulldown, face pulls, and leg curls', () => {
  const lats = parseWorkoutText('Lat pulldown 170 8/2 x3');
  assert.equal(lats.canonical_name, 'Lat Pulldown');
  assert.deepEqual(compactParsedSets(lats), [[170, 8, 2], [170, 8, 2], [170, 8, 2]]);

  const facePulls = parseWorkoutText('Face pulls 50 15/2 x3');
  assert.equal(facePulls.canonical_name, 'Face Pull');
  assert.deepEqual(compactParsedSets(facePulls), [[50, 15, 2], [50, 15, 2], [50, 15, 2]]);

  const legCurls = parseWorkoutText('Leg curls 70 15/2 x3');
  assert.equal(legCurls.canonical_name, 'Leg Curl');
  assert.deepEqual(compactParsedSets(legCurls), [[70, 15, 2], [70, 15, 2], [70, 15, 2]]);
});

test('wd_alias_parses_weighted_dips', () => {
  const result = parseWorkoutText('Wd 45 10/1 8/2 8/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Dips (Weighted)');
  assert.deepEqual(compactParsedSets(result), [[45, 10, 1], [45, 8, 2], [45, 8, 2]]);
});

test('kr_bodyweight_repeat_parses_three_sets', () => {
  const result = parseWorkoutText('Kr 15 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Hanging Knee Raises');
  assert.equal(result.sets.length, 3);
  assert.ok(result.sets.every(set => set.weight === null && set.weight_unit === null));
  assert.deepEqual(result.sets.map(set => [set.reps, set.rir]), [[15, null], [15, null], [15, null]]);
});

test('kr_bodyweight_slash_rir_varied_sets', () => {
  const result = parseWorkoutText('Kr 15/1 12/2 10/3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Hanging Knee Raises');
  assert.equal(result.sets.length, 3);
  assert.ok(result.sets.every(set => set.weight === null && set.weight_unit === null));
  assert.deepEqual(result.sets.map(set => [set.reps, set.rir]), [[15, 1], [12, 2], [10, 3]]);
});

test('kr_bodyweight_slash_plus_repeat', () => {
  const result = parseWorkoutText('Kr 15/1 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Hanging Knee Raises');
  assert.equal(result.sets.length, 3);
  assert.ok(result.sets.every(set => set.weight === null && set.reps === 15 && set.rir === 1));
});

test('kr_bodyweight_slash_plus_x11_refuses', () => {
  const result = parseWorkoutText('Kr 15/1 x11');
  assert.equal(result.intent, 'needs_clarification');
  assert.equal(result.sets, undefined);
});

test('dale_repeat_x3_still_works', () => {
  const result = parseWorkoutText('Lat pulldown 170 8/2 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.deepEqual(compactParsedSets(result), [[170, 8, 2], [170, 8, 2], [170, 8, 2]]);
});

test('dale_repeat_x10_boundary_allowed', () => {
  const result = parseWorkoutText('Lat pulldown 170 8/2 x10');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.equal(result.sets.length, 10);
  assert.ok(result.sets.every(set => set.weight === 170 && set.reps === 8 && set.rir === 2));
});

test('dale_repeat_x11_refuses', () => {
  const result = parseWorkoutText('Lat pulldown 170 8/2 x11');
  assert.equal(result.intent, 'needs_clarification');
  assert.equal(result.sets, undefined);
  assert.ok(result.warnings.includes('missing_sets'));
});

test('dale_repeat_x99_refuses', () => {
  const result = parseWorkoutText('Lat pulldown 170 8/2 x99');
  assert.equal(result.intent, 'needs_clarification');
  assert.equal(result.sets, undefined);
  assert.ok(result.warnings.includes('missing_sets'));
});

test('x3_means_three_total_instances', () => {
  const result = parseWorkoutText('Lat pulldown 170 8/2 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.equal(result.sets.length, 3);
  assert.deepEqual(compactParsedSets(result), [[170, 8, 2], [170, 8, 2], [170, 8, 2]]);
});

test('x3_with_no_previous_set_cannot_invent_rows', () => {
  const result = parseWorkoutText('Bench x3');
  assert.equal(result.intent, 'needs_clarification');
  assert.equal(result.sets, undefined);
  assert.match(result.message, /Could not find sets|no valid sets/i);
  assert.ok(result.warnings.includes('missing_sets'));
});

test('implied_weight_carries_across_slash_groups', () => {
  const result = parseWorkoutText('Ohp 95 10/3 10/2 9/1');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Overhead Press');
  assert.deepEqual(compactParsedSets(result), [[95, 10, 3], [95, 10, 2], [95, 9, 1]]);
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
  const result = parseWorkoutText('Incline DB Press 65s 10,10,9');
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
  const incline = parseWorkoutText('Incline db press 65 10/2 x3');
  assert.equal(incline.intent, 'log_sets');
  assert.equal(incline.canonical_name, 'Incline DB Press');
  assert.deepEqual(compactParsedSets(incline), [[65, 10, 2], [65, 10, 2], [65, 10, 2]]);

  const generic = parseWorkoutText('Press 105 8/2');
  assert.equal(generic.intent, 'needs_clarification');
  assert.match(generic.message, /Which press/);
});

test('rdl_full_phrase_parses_as_single_exercise', () => {
  const result = parseWorkoutText('Romanian deadlift 185 5/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'RDL');
  assert.deepEqual(compactParsedSets(result), [[185, 5, 2]]);
});

test('rdl_short_phrase_parses_as_single_exercise', () => {
  const result = parseWorkoutText('romanian dl 185 5/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'RDL');
  assert.deepEqual(compactParsedSets(result), [[185, 5, 2]]);
});

test('rdl_code_still_works', () => {
  const result = parseWorkoutText('RDL 185 5/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'RDL');
  assert.deepEqual(compactParsedSets(result), [[185, 5, 2]]);
});

test('rdl_and_deadlift_together_is_still_mixed', () => {
  const result = parseWorkoutText('RDL 185 5/2 deadlift 225 3/2');
  assert.equal(result.intent, 'needs_clarification');
  assert.match(result.message, /multiple exercises|mixed exercise/i);
  assert.ok(result.warnings.includes('multiple_exercises_in_input'));
  assert.equal(result.sets, undefined);
  assert.notDeepEqual(result.sets?.map(set => [set.weight, set.reps, set.rir]), [[185, 5, 2], [225, 3, 2]]);
});

test('skip note on same line as exercise name does not trigger multiple_exercises', () => {
  // "Deadlift skipped" is a skip context — Romanian Deadlift is the logged lift.
  const result = parseWorkoutText(
    'Deadlift skipped - platform busy.\n\nRomanian Deadlift\n245lbs 7/2\n245lbs 7/2\n245lbs 7/2'
  );
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'RDL');
  assert.deepEqual(compactParsedSets(result), [[245, 7, 2], [245, 7, 2], [245, 7, 2]]);
  assert.ok(!result.warnings || !result.warnings.includes('multiple_exercises_in_input'));
});

test('sentence starting with skipped does not trigger multiple_exercises', () => {
  // "I skipped deadlifts" is skip context — Calf Raise is what was actually logged.
  const result = parseWorkoutText(
    'I skipped deadlifts because the machine was busy.\n\nCalf Raise\n200lbs 15/2\n200lbs 15/2\n200lbs 15/2'
  );
  assert.ok(!result.warnings || !result.warnings.includes('multiple_exercises_in_input'));
  // Calf Raise is not in the catalog so it surfaces as unknown_exercise, not as a multiple-exercise error.
  assert.notEqual(result.intent, 'needs_clarification', 'should not need clarification due to skip sentence');
});

test('real mixed exercise input without skip word still asks for clarification', () => {
  // Existing behaviour preserved — genuinely ambiguous input must still clarify.
  const result = parseWorkoutText('RDL 185 5/2 deadlift 225 3/2');
  assert.equal(result.intent, 'needs_clarification');
  assert.ok(result.warnings.includes('multiple_exercises_in_input'));
});

test('skip note without a period separator never drops the real sets', () => {
  // No ". " between the skip note and the sets, and x-notation (no reps/RIR
  // slash) — stripping the lone "sentence" would otherwise wipe everything.
  // The guard keeps the original text so the Bench sets still parse.
  const result = parseWorkoutText('Skipped warmup bench 225x5x2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.ok(result.sets && result.sets.length > 0, 'real sets must not be silently dropped');
});

test('ambiguous_press_asks_never_guesses', () => {
  const result = parseWorkoutText('Press 135 8/2');
  assert.equal(result.intent, 'needs_clarification');
  assert.match(result.message, /Which press/);
  assert.equal(result.sets, undefined);
  assert.notEqual(result.canonical_name, 'Overhead Press');
  assert.notEqual(result.canonical_name, 'Bench Press');
  assert.notEqual(result.canonical_name, 'Incline DB Press');
});

test('finish_session_log_everything', () => {
  const result = parseWorkoutText('Log everything to spreadsheet');
  assert.equal(result.intent, 'finish_session');
  assert.equal(result.requires_effort_check, true);
  assert.equal(result.sets, undefined);
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

// ── Contextual exercise aliases ───────────────────────────────────────────────

test('contextual_alias_lats_standalone_no_set_data_does_not_create_log', () => {
  // "lats" is contextual-only — cannot start an exercise without a strong alias.
  // With no set tokens and no activeExercise context, the parser asks for
  // clarification and surfaces an ambiguous_exercise_alias warning (not log_sets).
  const result = parseWorkoutText('lats are sore today');
  assert.equal(result.intent, 'needs_clarification');
  assert.ok(result.warnings.includes('ambiguous_exercise_alias'));
  assert.equal(result.sets, undefined);
});

test('contextual_alias_incline_standalone_no_set_data_does_not_create_log', () => {
  const result = parseWorkoutText('incline felt weird');
  assert.equal(result.intent, 'needs_clarification');
  assert.ok(result.warnings.includes('ambiguous_exercise_alias'));
  assert.equal(result.sets, undefined);
});

test('contextual_alias_lats_resolves_within_lat_pulldown_input', () => {
  // "lats" is a contextual alias: when "lat pulldown" identifies the exercise
  // first, "lats" appearing later in the same input is treated as a set label
  // and skipped, allowing both set groups to be parsed as Lat Pulldown.
  const result = parseWorkoutText('lat pulldown 120 10/2 lats 130 8/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.deepEqual(compactParsedSets(result), [[120, 10, 2], [130, 8, 2]]);
});

test('contextual_alias_incline_resolves_within_incline_db_press_input', () => {
  const result = parseWorkoutText('incline db press 60 10/2 incline 65 8/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.deepEqual(compactParsedSets(result), [[60, 10, 2], [65, 8, 2]]);
});

test('contextual_alias_lats_with_set_data_no_context_needs_clarification', () => {
  // "lats 130 8/2" has set data but no strong alias and no activeExercise.
  // Must NOT create a bogus "Lats" unknown-exercise row — surface as ambiguous instead.
  const result = parseWorkoutText('lats 130 8/2');
  assert.equal(result.intent, 'needs_clarification');
  assert.ok(result.warnings.includes('ambiguous_exercise_alias'));
  assert.equal(result.sets, undefined);
});

test('contextual_alias_incline_with_set_data_no_context_needs_clarification', () => {
  const result = parseWorkoutText('incline 65 8/2');
  assert.equal(result.intent, 'needs_clarification');
  assert.ok(result.warnings.includes('ambiguous_exercise_alias'));
  assert.equal(result.sets, undefined);
});

test('contextual_alias_lats_inherits_active_lat_pulldown', () => {
  // Cross-turn continuation: "lats 130 8/2" with activeExercise=Lat Pulldown
  // must inherit the active lift, not create a bogus "Lats" row.
  const result = parseWorkoutText('lats 130 8/2', { activeExercise: 'Lat Pulldown' });
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.deepEqual(compactParsedSets(result), [[130, 8, 2]]);
});

test('contextual_alias_incline_inherits_active_incline_db_press', () => {
  const result = parseWorkoutText('incline 65 8/2', { activeExercise: 'Incline DB Press' });
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.deepEqual(compactParsedSets(result), [[65, 8, 2]]);
});

test('contextual_alias_cross_turn_strips_mid_string_alias_tokens', () => {
  // "lats 130 8/2 lats 140 7/2" — leading "lats" resolved via activeExercise;
  // remaining "lats" token in the rest string is stripped so parseSetGroups
  // sees "130 8/2 140 7/2" and correctly returns two sets.
  const result = parseWorkoutText('lats 130 8/2 lats 140 7/2', { activeExercise: 'Lat Pulldown' });
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.deepEqual(compactParsedSets(result), [[130, 8, 2], [140, 7, 2]]);
});

test('new_strong_alias_cable_pulldown_maps_to_lat_pulldown', () => {
  const result = parseWorkoutText('cable pulldown 120 10/2 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.deepEqual(compactParsedSets(result), [[120, 10, 2], [120, 10, 2], [120, 10, 2]]);
});

test('new_strong_alias_lat_pull_down_maps_to_lat_pulldown', () => {
  const result = parseWorkoutText('lat pull down 120 10/2 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.deepEqual(compactParsedSets(result), [[120, 10, 2], [120, 10, 2], [120, 10, 2]]);
});

test('new_strong_alias_incline_db_bench_maps_to_incline_db_press', () => {
  const result = parseWorkoutText('incline db bench 65 10/2 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.deepEqual(compactParsedSets(result), [[65, 10, 2], [65, 10, 2], [65, 10, 2]]);
});

test('new_strong_alias_dumbbell_incline_press_maps_to_incline_db_press', () => {
  const result = parseWorkoutText('dumbbell incline press 65 10/2 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.deepEqual(compactParsedSets(result), [[65, 10, 2], [65, 10, 2], [65, 10, 2]]);
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

test('last_session_route_registered_before_lift_code_param', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  const lastSessionIndex = indexSource.indexOf("app.get('/api/exercises/last-session'");
  const liftCodeIndex = indexSource.indexOf("app.get('/api/exercises/:liftCode'");

  assert.ok(lastSessionIndex >= 0);
  assert.ok(liftCodeIndex >= 0);
  assert.ok(lastSessionIndex < liftCodeIndex);
});

test('coach set-reaction stimulus_grade is engine-only (always overwritten, no client passthrough)', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  // The route must ALWAYS set stimulus_grade from the engine (or null), never
  // conditionally leave a client-supplied value in place.
  assert.match(
    indexSource,
    /stimulus_grade:\s*kind === 'set'\s*\?\s*\(computed\.set_grade \|\| null\)\s*:\s*null/,
    'index.js must overwrite stimulus_grade with the engine value or null (engine-only)');
});

test('ME-12: dotenv config is guarded so a missing dotenv never blocks app load', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  // The bootstrap must not hard-require dotenv (Render injects env directly); a
  // missing dotenv must not crash module load.
  assert.doesNotMatch(indexSource, /^const dotenv = require\('dotenv'\);/m, 'dotenv must not be a hard top-level require');
  assert.match(indexSource, /try\s*\{\s*require\('dotenv'\)\.config\(\);\s*\}\s*catch/, 'dotenv.config must be wrapped in try/catch');
});

test('LO-2: complete-workout validation 400s gate error.message behind NODE_ENV (no raw leak)', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  // The three /api/complete-workout validation failures must NOT interpolate a raw
  // err/error.message into a client-facing JSON body — they route through
  // standardError with the detail gated on NODE_ENV (null in production).
  assert.doesNotMatch(indexSource, /log_rows_json is not valid JSON: \$\{err\.message\}/, 'log_rows_json parse error must not leak err.message');
  assert.doesNotMatch(indexSource, /Parsed metrics validation failed: \$\{error\.message\}/, 'metrics validation error must not leak error.message');
  assert.doesNotMatch(indexSource, /Log rows validation\/enrichment failed: \$\{error\.message\}/, 'log rows enrichment error must not leak error.message');
  // …and each now uses the NODE_ENV-gated standardError pattern.
  assert.match(indexSource, /standardError\(req, res, 'log_rows_json is not valid JSON', process\.env\.NODE_ENV === 'production' \? null : err\.message, 400\)/);
  assert.match(indexSource, /standardError\(req, res, 'Parsed metrics validation failed', process\.env\.NODE_ENV === 'production' \? null : error\.message, 400\)/);
  assert.match(indexSource, /standardError\(req, res, 'Log rows validation\/enrichment failed', process\.env\.NODE_ENV === 'production' \? null : error\.message, 400\)/);
});

test('route_definitions_include_last_session', () => {
  const route = routeDefinitions.find(candidate => candidate.path === '/api/exercises/last-session');

  assert.ok(route);
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.authRequired, true);
  assert.equal(route.readOnly, true);
  assert.equal(route.writeCapable, false);
});

test('route_definitions_cover_obvious_registered_routes', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  const registeredRoutes = [...indexSource.matchAll(/app\.(get|post)\('([^']+)'/g)]
    .map(match => ({ method: match[1].toUpperCase(), path: match[2] }))
    .filter(route => route.path !== '/app');
  const definitionKeys = new Set(routeDefinitions.flatMap(route =>
    route.methods.map(method => `${method} ${route.path}`)
  ));
  const missing = registeredRoutes
    .filter(route => !definitionKeys.has(`${route.method} ${route.path}`))
    .map(route => `${route.method} ${route.path}`);

  assert.deepEqual(missing, []);
});

test('recommendNextSet returns progression recommendation', () => {
  const rows = [
    ['2026-05-10', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-12', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '235', '5', '3', '']
  ];
  // Pin `today` so the recency-aware guard sees a fresh last session deterministically.
  const rec = recommendNextSet(rows, 'SQ', { today: '2026-05-13' });
  assert.match(rec.recommendation, /Increase to/);
});

test('recommendNextSet: equal-rep sets within ONE session do not trigger a load bump', () => {
  // A single session of three equal-rep sets at RIR 2 used to be mistaken for
  // "stable reps over two sessions" and bumped the load. Progression must require
  // a genuine prior session, so this holds at the same weight and adds a rep.
  const rows = [
    ['2026-05-12', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-12', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '2', '225', '5', '2', ''],
    ['2026-05-12', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '3', '225', '5', '2', '']
  ];
  const rec = recommendNextSet(rows, 'SQ', { today: '2026-05-13' });
  assert.doesNotMatch(rec.recommendation, /Increase to/, 'one session must not progress load');
  assert.equal(rec.next_target.weight, 225, 'weight held, not bumped');
  assert.equal(rec.sessions_analyzed, 1);
});

test('recommendNextSet: stable reps ACROSS two sessions (multi-set) still progresses', () => {
  // Two distinct sessions, each multiple sets at 225x5 RIR 2 — a real
  // session-over-session plateau at a sub-maximal RIR, so we add load.
  const rows = [
    ['2026-05-10', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-10', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '2', '225', '5', '2', ''],
    ['2026-05-12', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-12', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '2', '225', '5', '2', '']
  ];
  const rec = recommendNextSet(rows, 'SQ', { today: '2026-05-13' });
  assert.match(rec.recommendation, /Increase to/, 'two sessions of stable reps progresses');
  assert.equal(rec.next_target.weight, 235, 'lower body adds 10 lb');
  assert.equal(rec.sessions_analyzed, 2);
});

// ── Recommendation staleness guard ────────────────────────────────────────────

test('recommendNextSet: fresh data (3 days) still progresses, no age tacked on', () => {
  const rows = [
    ['2026-05-10', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-12', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '235', '5', '2', '']
  ];
  const rec = recommendNextSet(rows, 'SQ', { today: '2026-05-15' }); // 3 days
  assert.match(rec.recommendation, /Increase to/);
  assert.equal(rec.confidence, 'high');
  assert.equal(rec.days_since_last_session, 3);
  assert.doesNotMatch(rec.reasoning, /days ago/);
});

test('recommendNextSet: 8-day-old data keeps the recommendation but states the age', () => {
  const rows = [
    ['2026-05-04', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-06', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '235', '5', '2', '']
  ];
  const rec = recommendNextSet(rows, 'SQ', { today: '2026-05-14' }); // 8 days
  assert.match(rec.recommendation, /Increase to/, 'recommendation unchanged at 7-10 days');
  assert.equal(rec.confidence, 'high', 'confidence unchanged at 7-10 days');
  assert.equal(rec.days_since_last_session, 8);
  assert.match(rec.reasoning, /8 days ago/);
});

test('recommendNextSet: 23-day-old data repeats, downgrades confidence, states the age', () => {
  const rows = [
    ['2026-04-20', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-04-21', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '235', '5', '2', '']
  ];
  const rec = recommendNextSet(rows, 'SQ', { today: '2026-05-14' }); // 23 days
  assert.match(rec.recommendation, /Repeat 235 × 5/, 'must repeat last working weight, not add load');
  assert.equal(rec.next_target.weight, 235, 'no progression off stale data');
  assert.equal(rec.confidence, 'medium', 'high downgraded one step to medium');
  assert.equal(rec.days_since_last_session, 23);
  assert.match(rec.reasoning, /23 days ago/);
});

test('recommendNextSet returns no-history message for unknown lift', () => {
  const rec = recommendNextSet([], 'UNKNOWN');
  assert.match(rec.recommendation, /No recent working sets/);
});

// ── Today's Plan — exercise_name field ────────────────────────────────────────

test("today's plan: recommendNextSet includes exercise_name from canonical_exercise", () => {
  const rows = [
    ['2026-06-01', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '225', '5', '2', ''],
    ['2026-06-08', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '235', '5', '2', ''],
  ];
  const rec = recommendNextSet(rows, 'SQ01');
  assert.equal(rec.exercise_name, 'Back Squat', 'must resolve canonical_exercise to exercise_name');
  assert.equal(rec.liftCode, 'SQ01', 'liftCode must still be present');
});

test("today's plan: recommendNextSet falls back to liftCode when no exercise name", () => {
  const rows = [
    ['2026-06-01', 'S1', '', '', 'Legs', 'MYSTERY01', '1', '100', '5', '2', ''],
  ];
  const rec = recommendNextSet(rows, 'MYSTERY01');
  assert.equal(rec.exercise_name, 'MYSTERY01', 'must fall back to liftCode when names are empty');
});

test("today's plan: recommendNextSet returns exercise_name equal to liftCode for unknown code", () => {
  const rec = recommendNextSet([], 'UNKNOWN');
  assert.equal(rec.exercise_name, 'UNKNOWN', 'no-history path must include exercise_name');
});

test("today's plan: /api/plan/today filters out numeric-only lift codes", () => {
  const src = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  const planBlock = src.slice(src.indexOf("'/api/plan/today'"), src.indexOf("'/api/plan/today'") + 800);
  assert.match(planBlock, /\[a-zA-Z\]/, 'must filter lift codes that contain no letters');
});

test("today's plan: app.js uses exercise_name field for card title, not liftCode directly", () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const planFn = appSource.slice(appSource.indexOf('async function loadTodaysPlan'), appSource.indexOf('async function loadTodaysPlan') + 2000);
  assert.match(planFn, /exercise_name/, 'must reference exercise_name field');
  assert.match(planFn, /plan-card-lift-name/, 'must render exercise name as card title');
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

test('normalizeDate converts a numeric Excel/Sheets serial, not as a year (HI-4)', () => {
  // Serial 45000 is 2023-03-15. The old order ran `new Date("45000")` first,
  // which JS parses as the YEAR 45000 — saving a wrong far-future date.
  assert.equal(normalizeDate(45000), '2023-03-15');
  assert.match(normalizeDate(45000), /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(normalizeDate(45000), /^45000/); // never the year-45000 date
});

test('normalizeDate converts an Excel serial that arrives as a STRING (HI-4 string form)', () => {
  // FORMATTED_VALUE sheet reads return numbers as strings, so a serial can arrive as
  // "45000" — which `new Date("45000")` would parse as the YEAR 45000. An EXACTLY-5-digit
  // all-digit string in the serial range is converted like the numeric form.
  assert.equal(normalizeDate('45000'), '2023-03-15');
  assert.equal(normalizeDate('45000'), normalizeDate(45000));
});

test('normalizeDate does NOT treat a 4-digit year or an 8-digit YYYYMMDD as a serial', () => {
  // A bare 4-digit year stays a year (new Date("2026") → 2026-01-01), never a serial.
  assert.equal(normalizeDate('2026'), '2026-01-01');
  // An 8-digit all-digit string is not a 5-digit serial → not converted (new Date
  // rejects it → blank), so it can never be misread as a far-future serial date.
  assert.equal(normalizeDate('20260618'), '');
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

test('calculateQualityScore returns 0–100 and sums criterion points', () => {
  // Perfect-ish session: 12 sets, 60 min, 130 bpm avg, 450 cal, 4 exercises,
  // all sets at RIR 1 (close to failure), one historical PR beaten.
  const perfect = calculateQualityScore({
    totalSets: 12,
    effortDuration: '01:00:00',
    averageHR: 130,
    activeCalories: 450,
    uniqueExercisesCount: 5,
    validationWarnings: [],
    setsWithRir: [1, 1, 1, 1],
    sessionBestByLift: { BEN01: { weight: 240, exercise: 'Bench Press' } },
    historicalBestByLift: { BEN01: 235 }
  });
  // Volume 30 + Intensity 25 + Effort 25 (12 duration + 13 HR for 130 bpm) + Balance 10 + Progression 10 = 100
  assert.equal(perfect, 100);

  // Minimal session: 2 sets, 10 min, 80 bpm, 1 exercise, no RIR, no history
  const minimal = calculateQualityScore({
    totalSets: 2,
    effortDuration: '00:10:00',
    averageHR: 80,
    activeCalories: 0,
    uniqueExercisesCount: 1,
    validationWarnings: ['some warning'],
    setsWithRir: [],
    sessionBestByLift: {},
    historicalBestByLift: {}
  });
  // Volume 0 + Intensity 12 (no RIR data = neutral) + Effort 6 (0 min pts + 6 HR pts for 80 bpm)
  // + Balance 0 + Progression 0 = 18
  assert.equal(minimal, 18);
});

test('qualityScoreBreakdown returns five criteria with id/label/points/maxPoints/description', () => {
  const metrics = {
    totalSets: 9,
    effortDuration: '00:47:00',
    averageHR: 118,
    activeCalories: 390,
    uniqueExercisesCount: 3,
    validationWarnings: [],
    setsWithRir: [1, 2, 1, 2],
    sessionBestByLift: { BEN01: { weight: 225, exercise: 'Bench Press' } },
    historicalBestByLift: { BEN01: 225 }
  };
  const breakdown = qualityScoreBreakdown(metrics);
  assert.equal(breakdown.length, 5);
  for (const c of breakdown) {
    assert.equal(typeof c.id, 'string');
    assert.ok(c.id.length > 0);
    assert.equal(typeof c.label, 'string');
    assert.ok(c.label.length > 0);
    assert.ok(Number.isFinite(c.points) && c.points >= 0);
    assert.ok(Number.isFinite(c.maxPoints) && c.maxPoints > 0);
    assert.ok(c.points <= c.maxPoints);
    assert.equal(typeof c.description, 'string');
    assert.ok(c.description.length > 0);
  }
  // Points sum equals the headline score.
  const total = breakdown.reduce((s, c) => s + c.points, 0);
  assert.equal(total, calculateQualityScore(metrics));
  // Volume: 9 sets → 22 pts; Intensity: avg RIR 1.5 → 20 pts
  const vol = breakdown.find(c => c.id === 'volume');
  assert.equal(vol.points, 22);
  assert.match(vol.description, /9 sets/);
  const intensity = breakdown.find(c => c.id === 'intensity');
  assert.equal(intensity.points, 20);
  assert.match(intensity.description, /RIR/);
  // No new PR (held at 225) → 3 pts (holding steady)
  const prog = breakdown.find(c => c.id === 'progression');
  assert.equal(prog.points, 3);
  assert.match(prog.description, /Holding steady/);
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
  // Per-set detail must be present so the History detail can show exactly what
  // was logged (weight × reps @rir).
  assert.ok(Array.isArray(summary.sets), 'summary must include a sets array');
  assert.equal(summary.sets.length, 3, 'one entry per logged set');
  assert.ok(summary.sets[0].weight != null && summary.sets[0].reps != null, 'sets carry weight + reps');
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

test('previewTestRows matches session-20YY ids beyond 2026 (no year hardcode)', () => {
  const rows = [
    ['2027-01-01', 'session-2027-01-01', 'Squat', 'Squat', 'Legs', 'SQ', '1', '135', '5', '3', ''],
    ['2030-06-01', 'session-2030-06-01', 'Squat', 'Squat', 'Legs', 'SQ', '1', '135', '5', '3', ''],
    ['2026-05-01', 'real-20260501-PM-01', 'Squat', 'Squat', 'Legs', 'SQ', '1', '135', '5', '3', ''],
  ];
  const preview = previewTestRows(rows, []);
  assert.equal(preview.log_candidates.length, 2);
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

test('suggestDeloads holds working weight for persistent stalls (volume-first)', () => {
  const rows = [
    ['2026-04-01', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '1', ''],
    ['2026-04-05', 'S2', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '1', ''],
    ['2026-04-10', 'S3', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '1', ''],
    ['2026-04-15', 'S4', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '1', '']
  ];
  const suggestions = suggestDeloads(rows, 4);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].liftCode, 'BP');
  // The exercise name rides along so the UI can show it instead of the code.
  assert.equal(suggestions[0].exercise, 'Bench Press');
  // Volume-first: hold the working weight, cut sets — not a weight reduction.
  assert.equal(suggestions[0].suggested_deload_weight, 200);
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

test('deload suggestions render the exercise name, not the lift code, as the label', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const start = appSource.indexOf('const deloads = data.deload_suggestions');
  assert.ok(start !== -1, 'deload rendering block must exist');
  const block = appSource.slice(start, start + 1000);
  // Visible label prefers the exercise name; lift code is only the click target.
  assert.match(block, /d\.exercise \|\| d\.liftCode/, 'label must prefer exercise name over lift code');
  assert.match(block, /'data-lift': d\.liftCode/, 'lift code must remain the data-lift navigation target');
  assert.doesNotMatch(block, /text: d\.liftCode/, 'lift code must not be the visible link text');
  // UNKNOWN groups code-less rows whose progress view is empty — the label must
  // not claim a specific exercise the link can't navigate to.
  assert.match(block, /d\.liftCode === 'UNKNOWN'/, 'UNKNOWN code must keep the code as its visible label');
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

// ── Reaction layer — source-level contracts ───────────────────────────────────

test('reaction layer: fetchReaction exists and fails quietly', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /async function fetchReaction\(/, 'fetchReaction must exist');
  const fetchFn = appSource.slice(
    appSource.indexOf('async function fetchReaction('),
    appSource.indexOf('async function fetchReaction(') + 1200
  );
  assert.match(fetchFn, /return null/, 'must return null on unavailable data');
  assert.match(fetchFn, /catch/, 'must catch errors silently');
  assert.match(fetchFn, /\/api\/recommend\/next\//, 'must call the recommend endpoint');
  // The just-logged set is forwarded as query params so the recommendation
  // anchors on it (Bug 1) — not on the previous session in the sheet.
  assert.match(fetchFn, /async function fetchReaction\(liftCode, justLoggedSet\)/, 'must accept an optional just-logged set');
  assert.match(fetchFn, /URLSearchParams/, 'must append the set as query params');
  // Deload narration: the active plan intent is threaded through so the engine's
  // reaction (and the coach note) can flip on a deload day.
  assert.match(fetchFn, /activePlannedSession && activePlannedSession\.intentId/, 'must read the active plan intent');
  assert.match(fetchFn, /params\.set\('intentId', intentId\)/, 'must forward the active intent as ?intentId');
});

test('deload narration: a planned session records its intent id for the in-workout reaction', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const start = appSource.indexOf('function startPlannedSession(');
  const fn = appSource.slice(start, start + 700);
  // The intent id (e.g. 'deload_reset') is stored on the active session so
  // fetchReaction can forward it — without it, a deload set mis-reads as too light.
  assert.match(fn, /intentId: intent\.id \|\| null/, 'must store the plan intent id on the active session');
});

test('reaction layer: the recommend route reads ?w&reps&rir and stays read-only', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  // The route parses the optional just-logged set and passes it to the engine.
  assert.match(indexSource, /function parseJustLoggedSet\(query\)/, 'route must parse the just-logged query set');
  assert.match(indexSource, /recommendNextSet\(allLog, liftCode, \{/, 'route must forward options to the engine');
  assert.match(indexSource, /\.\.\.\(justLoggedSet \? \{ justLoggedSet \} : \{\}\)/, 'route must forward the just-logged set to the engine');
  // Deload is engine-driven now (PR 6b): the route no longer reads a ?deload /
  // ?intentId override — it attaches the deload engine's decision (read from the
  // persisted Deload_State), so a single source of truth drives the deload.
  assert.doesNotMatch(indexSource, /const deload = req\.query\.deload/, 'route must not read a deload query override');
  assert.match(indexSource, /recommendation\.deload = await evaluateCurrentDeload/, 'route must attach the engine deload decision');
  // It's a GET that only reads — a just-logged set must never trigger a write.
  const start = indexSource.indexOf("app.get('/api/recommend/next/:liftCode'");
  const routeFn = indexSource.slice(start, start + 700);
  assert.doesNotMatch(routeFn, /appendRows|deleteRows|completeWrite/, 'recommend-next must never write');
});

test('in-workout note: handleSetLogged anchors the recommendation on the just-logged set', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const start = cc.indexOf('async function handleSetLogged(');
  const fn = cc.slice(start, start + 1400);
  // Passes the last just-logged set of the primary exercise into fetchReaction.
  assert.match(fn, /primary\.sets\[primary\.sets\.length - 1\]/, 'must take the just-logged set');
  assert.match(fn, /fetchReaction\(code, justLogged\)/, 'must forward it to fetchReaction');
});

test('in-workout note: coachOpener leads with the engine effort verdict, de-templated (PR4)', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const opener = cc.slice(cc.indexOf('function coachOpener('), cc.indexOf('function coachOpener(') + 1700);
  assert.match(opener, /effort_verdict/, 'opener must consult the verdict');
  assert.match(opener, /pickVerdictLine\(verdict\.level\)/, 'opener must route the verdict through the de-templating picker');

  // The variant table + rotation: every verdict level is covered, failure has
  // multiple phrasings (de-templating), far_easy reads as under-effort/add weight,
  // and the easy copy still offers room to add load or reps.
  const vstart = cc.indexOf('const VERDICT_VARIANTS');
  const block = cc.slice(vstart, vstart + 2200);
  assert.ok(vstart !== -1, 'a VERDICT_VARIANTS table must exist');
  for (const level of ['failure', 'far_easy', 'easy', 'hard', 'on_target']) {
    assert.match(block, new RegExp(`${level}:\\s*\\[`), `variants must cover the ${level} verdict`);
  }
  const failureArr = block.match(/failure:\s*\[([\s\S]*?)\]/);
  const failureCount = (failureArr[1].match(/^\s*'/gm) || failureArr[1].match(/',/g) || []).length;
  assert.ok(failureCount >= 2, 'failure must have at least two phrasings so two failure sets do not repeat');
  assert.match(block, /add real weight|too light|under-effort/i, 'far_easy → add-weight language, not praise');
  assert.match(block, /add load or reps/i, 'easy → room to add load or reps');
  assert.match(cc, /verdictRotation/, 'must rotate phrasings per level to de-template within a session');
});

// PR 484 (LLM-down stimulus_grade voicing): the offline opener must defer to the
// profile-aware governor grade so an `easy`/`far_easy` raw verdict never invites
// progression the governor is holding.
test('coachOpener: defers to the governor grade to suppress a held progression invite (PR 484)', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const start = cc.indexOf('function coachOpener(');
  const opener = cc.slice(start, start + 1700);
  // The opener takes the grade and only overrides on the progression-invite levels.
  assert.match(opener, /function coachOpener\(todaySets, rec, grade\)/, 'opener must accept the set_grade');
  assert.match(opener, /verdict\.level === 'easy' \|\| verdict\.level === 'far_easy'/, 'override gated to progression-invite verdicts only');
  assert.match(opener, /governorOverridesProgressionInvite\(grade\)/, 'opener must consult the governor override predicate');
  assert.match(opener, /templatedGovernorHoldLine\(grade\)/, 'opener must word the governor hold line when overriding');
  // It must be fed the grade from the server response (the LLM-down path carries set_grade).
  assert.match(cc, /coachOpener\(facts\.todaySets \|\| \[\], facts\.rec, data && data\.set_grade\)/,
    'the fallback call site must pass data.set_grade into the opener');
});

// De-templating guarantee (re-implemented rotation, mirrors pickVerdictLine):
// rotating a per-level index means consecutive same-level notes never repeat
// until the variants are exhausted.
test('coachOpener de-templating: a per-level rotation yields non-identical consecutive notes', () => {
  const variants = ['a', 'b', 'c'];
  const rotation = {};
  const pick = level => {
    const i = (rotation[level] || 0) % variants.length;
    rotation[level] = (rotation[level] || 0) + 1;
    return variants[i];
  };
  const first = pick('failure');
  const second = pick('failure');
  assert.notEqual(first, second, 'two failure notes in a session must differ');
});

test('reaction layer: renderAtlasSuggestion and extractLiftCodes exist', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /function renderAtlasSuggestion\(/, 'renderAtlasSuggestion must exist');
  assert.match(appSource, /function extractLiftCodes\(/, 'extractLiftCodes must exist');
  const atlasFn = appSource.slice(
    appSource.indexOf('function renderAtlasSuggestion('),
    appSource.indexOf('function renderAtlasSuggestion(') + 800
  );
  assert.match(atlasFn, /atlas-suggestion/, 'must use atlas-suggestion CSS class');
  assert.match(atlasFn, /return null/, 'must return null when no useful data');
});

test('reaction layer: renderLogWorkoutPreview injects suggestion and never blocks on failure', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const previewFn = appSource.slice(
    appSource.indexOf('function renderLogWorkoutPreview('),
    appSource.indexOf('function renderCompleteWorkoutPreview(')
  );
  assert.match(previewFn, /extractLiftCodes/, 'must extract lift codes from preview rows');
  assert.match(previewFn, /fetchReaction/, 'must call fetchReaction');
  assert.match(previewFn, /\.catch\(/, 'must catch to prevent blocking preview render');
  assert.match(previewFn, /pendingWrite\.liftCodes/, 'must store lift codes for write reaction');
});

test('preview summary: both preview renderers use the compact rows summary, not the full table', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /function renderRowsSummary\(/, 'renderRowsSummary helper must exist');

  const logFn = appSource.slice(
    appSource.indexOf('function renderLogWorkoutPreview('),
    appSource.indexOf('function renderCompleteWorkoutPreview(')
  );
  const completeFn = appSource.slice(
    appSource.indexOf('function renderCompleteWorkoutPreview('),
    appSource.indexOf("document.getElementById('cancel-preview-btn')")
  );
  assert.match(logFn, /renderRowsSummary\(data\.log_rows_preview/, 'log preview must render the summary');
  assert.match(completeFn, /renderRowsSummary\(data\.rows_to_write/, 'complete preview must render the summary');
  assert.doesNotMatch(logFn, /Workout rows to write/, 'full rows table heading must be gone from log preview');
  assert.doesNotMatch(completeFn, /Workout rows to write/, 'full rows table heading must be gone from complete preview');

  const summaryFn = appSource.slice(
    appSource.indexOf('function renderRowsSummary('),
    appSource.indexOf('function renderWarnings(')
  );
  assert.match(summaryFn, /set.*to write/, 'summary must state the set count being written');
  assert.doesNotMatch(summaryFn, /api\(|fetch\(/, 'summary helper must be a pure render — no requests');
});

test('effort-only preview: submit handler allows empty workout rows when screenshot or manual effort exists', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('logger-form').addEventListener('submit'";
  const submitSection = appSource.slice(
    appSource.indexOf(anchor),
    appSource.indexOf('async function submitCompleteWorkout(')
  );

  assert.match(submitSection, /const effortOnly = !logRows\.length && Boolean\(file \|\| manualEffort\)/);
  assert.match(submitSection, /if \(!logRows\.length && !effortOnly\)/);
  assert.match(submitSection, /mode: 'effort-only'/);
});

test('screenshot preview date resolution: screenshot mode does not hard-require a manual date', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('logger-form').addEventListener('submit'";
  const submitSection = appSource.slice(
    appSource.indexOf(anchor),
    appSource.indexOf('async function submitCompleteWorkout(')
  );

  assert.match(submitSection, /const mode = effortMode\(\)/);
  assert.match(submitSection, /if \(!date && mode !== 'screenshot'\)/);
});

test('screenshot preview date resolution: pendingWrite uses server-resolved date and session id', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('logger-form').addEventListener('submit'";
  const submitSection = appSource.slice(
    appSource.indexOf(anchor),
    appSource.indexOf('async function submitCompleteWorkout(')
  );

  assert.match(submitSection, /const resolvedData = result\?\.data\?\.data \|\| \{\}/);
  assert.match(submitSection, /const resolvedDate = resolvedData\.date \|\| date \|\| getLocalDateString\(\)/);
  assert.match(submitSection, /const resolvedSessionId = resolvedData\.session_id \|\| sessionId \|\| generateSessionId\(resolvedDate\)/);
  assert.match(submitSection, /document\.getElementById\('log-date'\)\.value = resolvedDate/);
  assert.match(submitSection, /sessionIdInput\.value = resolvedSessionId/);
  assert.match(submitSection, /pendingWrite = \{[\s\S]*mode: 'screenshot'[\s\S]*sessionId: resolvedSessionId,[\s\S]*date: resolvedDate/);
});

test('screenshot preview date resolution: multipart submit omits blank date and session id', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const submitFunction = appSource.slice(
    appSource.indexOf('async function submitCompleteWorkout('),
    appSource.indexOf('function renderRowsSummary(')
  );

  assert.match(submitFunction, /if \(sessionId\) form\.append\('session_id', sessionId\)/);
  assert.match(submitFunction, /if \(date\) form\.append\('date', date\)/);
});

test('effort-only preview: complete-workout preview shows no-workout copy and effort-only CTA', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const previewFn = appSource.slice(
    appSource.indexOf('function renderCompleteWorkoutPreview('),
    appSource.indexOf("document.getElementById('cancel-preview-btn')")
  );

  assert.match(previewFn, /Effort-only preview/);
  assert.match(previewFn, /Write Effort to Google Sheets/);
  assert.match(previewFn, /data\.effort_source === 'manual'/);
});

test('reaction layer: approve-btn captures lift codes and fires write reaction', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const approveSection = appSource.slice(
    appSource.indexOf(anchor),
    appSource.indexOf(anchor) + 9000
  );
  assert.match(approveSection, /reactionLiftCodes/, 'must capture reactionLiftCodes before invalidatePreview');
  assert.match(approveSection, /fetchReaction/, 'must call fetchReaction after write');
  assert.match(approveSection, /\.catch\(/, 'write reaction must fail quietly');
});

test('approve success message: effortOnly is captured before invalidatePreview nulls pendingWrite', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const approveSection = appSource.slice(
    appSource.indexOf(anchor),
    appSource.indexOf(anchor) + 9000
  );
  const captureAt = approveSection.indexOf('const wasEffortOnly = pendingWrite.effortOnly');
  const invalidateAt = approveSection.indexOf('invalidatePreview()', captureAt);
  assert.ok(captureAt > -1, 'must capture effortOnly into a local before the write');
  assert.ok(invalidateAt > -1, 'approve path must still invalidate the preview');
  assert.ok(captureAt < invalidateAt, 'capture must happen before invalidatePreview clears pendingWrite');
  const afterInvalidate = approveSection.slice(invalidateAt);
  assert.doesNotMatch(afterInvalidate, /pendingWrite\./, 'nothing may dereference pendingWrite after invalidatePreview');
});

test('effort-only approve: complete-workout path accepts Effort-only writes without log rows', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const approveSection = appSource.slice(
    appSource.indexOf(anchor),
    appSource.indexOf(anchor) + 9000
  );

  assert.match(approveSection, /pendingWrite\.mode === 'screenshot' \|\| pendingWrite\.mode === 'effort-only'/);
  assert.match(approveSection, /writeData\.effort_only === true/);
  assert.match(approveSection, /writeData\.effort_written !== true \|\| writeData\.sheet_written !== true/);
});

// ── Post-write verdict ────────────────────────────────────────────────────────

test('verdict: buildVerdict exists in app.js and returns null for empty data', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /function buildVerdict\(/, 'buildVerdict must exist');
  const fn = appSource.slice(
    appSource.indexOf('function buildVerdict('),
    appSource.indexOf('function buildVerdict(') + 900
  );
  assert.match(fn, /return null/, 'must return null when no useful data');
  assert.match(fn, /rule_decision/, 'must read holdUntilClean rule_decision');
  assert.match(fn, /e1rm_trend/, 'must check e1rm trend');
  assert.match(fn, /criterion_progress/, 'must surface criterion progress');
});

test('verdict: post-write block shows Logged verdict and Next recommendation', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const approveSection = appSource.slice(
    appSource.indexOf(anchor),
    appSource.indexOf(anchor) + 9000
  );
  assert.match(approveSection, /buildVerdict\(rec\)/, 'must call buildVerdict');
  assert.match(approveSection, /'Logged'/, 'must label verdict row "Logged"');
  assert.match(approveSection, /'Next'/, 'must label recommendation row "Next"');
  assert.match(approveSection, /\.catch\(/, 'must fail quietly');
});

test('verdict: write safety unchanged — undo button still wired after verdict block', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const approveSection = appSource.slice(
    appSource.indexOf(anchor),
    appSource.indexOf(anchor) + 9000
  );
  // undo button must still be appended before the verdict fetch
  const undoIdx = approveSection.indexOf('undo-write-btn');
  const verdictIdx = approveSection.indexOf('buildVerdict');
  assert.ok(undoIdx !== -1, 'undo button must still exist in approve handler');
  assert.ok(verdictIdx !== -1, 'buildVerdict must exist in approve handler');
  assert.ok(undoIdx < verdictIdx, 'undo button must be appended before verdict fetch fires');
});

// ── Duplicate-write protection ────────────────────────────────────────────────

test('duplicate-write: writeInFlight guard variable exists in app.js', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /let writeInFlight\s*=\s*false/, 'writeInFlight must be declared false');
});

test('duplicate-write: approve handler checks guard and sets it before request', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const handler = appSource.slice(appSource.indexOf(anchor), appSource.indexOf(anchor) + 9000);
  // Guard must be the first check before stored preview-proof validation.
  const guardIdx = handler.indexOf('if (writeInFlight) return');
  const pendingIdx = handler.indexOf('if (!pendingWriteHasPreviewProof(pendingWrite))');
  assert.ok(guardIdx !== -1, 'writeInFlight guard must exist in handler');
  assert.ok(pendingIdx !== -1, 'approve handler must require stored preview proof');
  assert.ok(guardIdx < pendingIdx, 'guard must come before preview-proof check');
  // Must set writeInFlight = true before the try block
  assert.match(handler, /writeInFlight = true/, 'must set writeInFlight = true');
});

test('trust loop: approve handler requires stored dry-run proof before writing', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /function pendingWriteHasPreviewProof/, 'must centralize pending-write proof validation');
  assert.match(appSource, /proof\.test_mode !== true/, 'proof must require test_mode true');
  assert.match(appSource, /proof\.sheet_written !== false/, 'proof must require sheet_written false');
  assert.match(appSource, /proof\.no_write_confirmed !== true/, 'proof must require no_write_confirmed true');
  assert.match(appSource, /proof\.sheet_write !== 'skipped'/, 'proof must require skipped sheet_write marker');

  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const handler = appSource.slice(appSource.indexOf(anchor), appSource.indexOf(anchor) + 9000);
  assert.match(handler, /if \(!pendingWriteHasPreviewProof\(pendingWrite\)\)/, 'approve click must block missing or stale preview proof');
  assert.doesNotMatch(handler, /if \(!pendingWrite\)/, 'approve click must not rely on pendingWrite existence alone');
});

test('duplicate-write: finally block always clears writeInFlight', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const handler = appSource.slice(appSource.indexOf(anchor), appSource.indexOf(anchor) + 9000);
  assert.match(handler, /finally\s*\{/, 'handler must have a finally block');
  const finallyIdx = handler.indexOf('finally');
  const clearIdx = handler.indexOf('writeInFlight = false', finallyIdx);
  assert.ok(clearIdx !== -1 && clearIdx > finallyIdx, 'writeInFlight = false must be inside finally');
});

test('duplicate-write: successful write sets button text to Written ✓', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const handler = appSource.slice(appSource.indexOf(anchor), appSource.indexOf(anchor) + 9000);
  assert.match(handler, /Written\s*✓/, 'button must show "Written ✓" after success');
  // Written ✓ must appear before the catch block
  const writtenIdx = handler.indexOf('Written');
  const catchIdx = handler.indexOf('} catch (err)');
  assert.ok(writtenIdx < catchIdx, 'Written ✓ text must be in success path, not catch');
});

test('duplicate-write: undo button is unaffected — still wired after success', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const handler = appSource.slice(appSource.indexOf(anchor), appSource.indexOf(anchor) + 9000);
  assert.match(handler, /undo-write-btn/, 'undo button must still exist in success path');
  assert.match(handler, /handleUndoLastWrite/, 'undo click handler must still be wired');
});

// ── Readback verification ─────────────────────────────────────────────────────

test('readback: verify-range route registered as GET, read-only, auth-required', () => {
  const route = routeDefinitions.find(r => r.path === '/api/log-workout/verify-range');
  assert.ok(route, 'route definition must exist');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.authRequired, true);
  assert.equal(route.readOnly, true);
  assert.equal(route.writeCapable, false);
});

test('readback: verify-range endpoint enforces Log_Cleaned tab restriction', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  assert.match(src, /\/api\/log-workout\/verify-range/, 'endpoint must be registered');
  assert.match(src, /range must target/, 'must reject non-Log_Cleaned tabs');
  assert.match(src, /not a valid A1 range/, 'must reject malformed range strings');
});

test('readback: verify-range endpoint verifies session_id and row count before returning ok', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  const endpointStart = src.indexOf("'/api/log-workout/verify-range'");
  const endpointBlock = src.slice(endpointStart, endpointStart + 3000);
  assert.match(endpointBlock, /session_id mismatch/, 'must check session_id in returned rows');
  assert.match(endpointBlock, /row count mismatch/, 'must check returned row count matches span');
  assert.match(endpointBlock, /verified.*true/, 'must return verified: true on success');
  assert.match(endpointBlock, /readRange\(range\)/, 'must call readRange with the validated range');
});

test('readback: verifyWrittenRange function exists and fails quietly', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /async function verifyWrittenRange\(/, 'verifyWrittenRange must exist');
  const fn = appSource.slice(
    appSource.indexOf('async function verifyWrittenRange('),
    appSource.indexOf('async function verifyWrittenRange(') + 400
  );
  assert.match(fn, /return false/, 'must return false on any failure');
  assert.match(fn, /verify-range/, 'must call verify-range endpoint');
  assert.match(fn, /verified.*true/, 'must check verified: true in response');
});

test('readback: approve handler fires verifyWrittenRange after write, before reaction fetch', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const handler = appSource.slice(appSource.indexOf(anchor), appSource.indexOf(anchor) + 9000);
  assert.match(handler, /verifyWrittenRange/, 'must call verifyWrittenRange in success path');
  assert.match(handler, /Verified in Sheet/, 'must show Verified in Sheet note');
  assert.match(handler, /readback verification unavailable/, 'must show unavailable note on failure');
  // undo button must come before verify call
  const undoIdx = handler.indexOf('undo-write-btn');
  const verifyIdx = handler.indexOf('verifyWrittenRange');
  const reactionIdx = handler.indexOf('fetchReaction');
  assert.ok(undoIdx < verifyIdx, 'undo button must be appended before verify fires');
  assert.ok(verifyIdx < reactionIdx, 'verify must fire before reaction fetch');
});

test('readback: verification failure cannot affect write success — no throw, no await block', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fn = appSource.slice(
    appSource.indexOf('async function verifyWrittenRange('),
    appSource.indexOf('async function verifyWrittenRange(') + 550
  );
  // Must catch all errors and return false — never re-throw
  assert.match(fn, /catch/, 'must have a catch block');
  assert.match(fn, /return false/, 'catch must return false, not throw');
});

// ── Weekly Report ─────────────────────────────────────────────────────────────

test('weekly report: buildWeeklyReport returns correct structure for a normal week', () => {
  const today = '2026-06-11';
  const rows = [
    ['2026-06-05', 'W1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-06-05', 'W1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '185', '8', '2', ''],
    ['2026-06-08', 'W2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-06-08', 'W2', 'Overhead Press', 'Overhead Press', 'Shoulders', 'OHP', '1', '115', '8', '2', ''],
  ];
  const report = buildWeeklyReport(rows, { today });
  assert.equal(report.period_start, '2026-06-05');
  assert.equal(report.period_end, '2026-06-11');
  assert.equal(report.sessions_count, 2);
  assert.equal(report.total_sets, 4);
  assert.ok(report.total_volume > 0, 'total_volume must be positive');
  assert.ok(Array.isArray(report.top_exercises), 'top_exercises must be an array');
  assert.ok(report.top_exercises.length > 0, 'must have at least one top exercise');
  assert.ok(typeof report.summary_markdown === 'string', 'summary_markdown must be a string');
  assert.match(report.summary_markdown, /Weekly Training Report/);
  assert.match(report.summary_markdown, /Sessions: 2/);
  // All required response keys must be present
  for (const key of ['period_start', 'period_end', 'sessions_count', 'total_sets', 'total_volume', 'top_exercises', 'muscle_group_volume', 'prs', 'stalls_or_watchouts', 'recommendations', 'summary_markdown']) {
    assert.ok(key in report, `response must include key: ${key}`);
  }
});

test('weekly report: buildWeeklyReport returns zero-state for empty data', () => {
  const report = buildWeeklyReport([], { today: '2026-06-11' });
  assert.equal(report.sessions_count, 0);
  assert.equal(report.total_sets, 0);
  assert.equal(report.total_volume, 0);
  assert.deepEqual(report.top_exercises, []);
  assert.deepEqual(report.prs, []);
  assert.deepEqual(report.stalls_or_watchouts, []);
  assert.match(report.summary_markdown, /No training data/);
});

test('weekly report: buildWeeklyReport detects weight improvements vs prior period', () => {
  const today = '2026-06-11';
  const rows = [
    // Prior week (Jun 4): BP at 215
    ['2026-06-04', 'P1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '215', '8', '2', ''],
    // This week (Jun 8): BP at 225 — improvement
    ['2026-06-08', 'W1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '225', '8', '2', ''],
  ];
  const report = buildWeeklyReport(rows, { today });
  assert.equal(report.prs.length, 1, 'must detect one improvement');
  assert.equal(report.prs[0].lift_code, 'BP');
  assert.equal(report.prs[0].prev_best, 215);
  assert.equal(report.prs[0].this_week_best, 225);
  assert.equal(report.prs[0].type, 'weight');
  assert.match(report.summary_markdown, /Improvements/);
});

test('weekly report: buildWeeklyReport surfaces stalls from history for this week\'s lifts', () => {
  const today = '2026-06-11';
  const rows = [
    // Stalled: 4 sessions at same weight, spread across weeks
    ['2026-05-01', 'A1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-08', 'A2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    ['2026-05-15', 'A3', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
    // This week — same lift appears in report
    ['2026-06-08', 'W1', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
  ];
  const report = buildWeeklyReport(rows, { today });
  assert.equal(report.sessions_count, 1, 'only this week counted');
  const stall = report.stalls_or_watchouts.find(s => s.liftCode === 'SQ');
  assert.ok(stall, 'SQ must be flagged as stalled');
  assert.equal(stall.exercise, 'Back Squat', 'stall must carry the exercise name for display');
  assert.match(report.summary_markdown, /Watchouts: Back Squat stalled/, 'markdown shows the name, not the code');
});

test('weekly report: endpoint registered as GET and read-only', () => {
  const route = routeDefinitions.find(r => r.path === '/api/report/weekly');
  assert.ok(route, 'route definition must exist');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.readOnly, true);
  assert.equal(route.writeCapable, false);
  assert.equal(route.authRequired, true);
});

test('weekly report: weekly-report-btn wired in app.js and renders summary_markdown', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /weekly-report-btn/, 'button must be referenced in app.js');
  assert.match(appSource, /\/api\/report\/weekly/, 'must call /api/report/weekly endpoint');
  const handlerStart = appSource.indexOf("getElementById('weekly-report-btn')");
  assert.ok(handlerStart !== -1, 'button handler must be registered');
  const handlerBlock = appSource.slice(handlerStart, handlerStart + 1700);
  assert.match(handlerBlock, /summary_markdown/, 'must render summary_markdown from response');
  assert.match(handlerBlock, /finally/, 'must re-enable button in finally block');
});

// ── Exercise Detail ───────────────────────────────────────────────────────────

test('exercise detail: buildExerciseDetail returns correct structure for a known lift', () => {
  // Use SAMPLE_LOG: SQ has 2 sessions (2026-05-10 @ 225, 2026-05-12 @ 235)
  // With today='2026-06-11', cutoff = 2026-05-12 — so only 2026-05-12 row is in window
  const detail = buildExerciseDetail(SAMPLE_LOG, 'SQ', { today: '2026-06-11' });
  assert.equal(detail.lift_code, 'SQ');
  assert.deepEqual(detail.exercise_names, ['Back Squat']);
  assert.equal(detail.sessions_count, 2);
  assert.equal(detail.last_sessions.length, 2, 'both sessions returned (≤ 5 total)');
  assert.ok(detail.last_sessions[0].best_weight > 0, 'last_sessions must have best_weight');
  assert.ok(detail.last_sessions[0].sets > 0, 'last_sessions must have sets');
  assert.equal(detail.volume_trend, 'up', 'SQ weight went 225 → 235 so trend is up');
  // best_recent_set: cutoff = 2026-05-12 → only 2026-05-12 row (235 lb) is in window
  assert.ok(detail.best_recent_set !== null, 'best_recent_set must be populated');
  assert.equal(detail.best_recent_set.weight, 235, 'best recent is the May-12 set at 235 lb');
  // Verify all required keys are present
  for (const key of ['lift_code', 'exercise_names', 'sessions_count', 'last_sessions', 'best_recent_set', 'volume_trend', 'recommendation']) {
    assert.ok(key in detail, `response must include key: ${key}`);
  }
});

test('exercise detail: buildExerciseDetail handles unknown lift code gracefully', () => {
  const detail = buildExerciseDetail(SAMPLE_LOG, 'UNKNOWN', { today: '2026-06-11' });
  assert.equal(detail.lift_code, 'UNKNOWN');
  assert.deepEqual(detail.exercise_names, []);
  assert.equal(detail.sessions_count, 0);
  assert.deepEqual(detail.last_sessions, []);
  assert.equal(detail.best_recent_set, null);
  assert.equal(detail.volume_trend, 'flat');
  assert.equal(detail.recommendation, null);
});

test('exercise detail: buildExerciseDetail handles low-data lift (one session)', () => {
  // DL has one session (2026-05-12 @ 315 lb)
  const detail = buildExerciseDetail(SAMPLE_LOG, 'DL', { today: '2026-06-11' });
  assert.equal(detail.sessions_count, 1);
  assert.equal(detail.last_sessions.length, 1);
  assert.equal(detail.last_sessions[0].best_weight, 315);
  assert.equal(detail.exercise_names[0], 'Deadlift');
  assert.equal(detail.best_recent_set.weight, 315);
});

test('exercise detail: best_recent_set is null when all sessions are outside the window', () => {
  // BP only has rows on 2026-05-10, which is 32 days before today 2026-06-11
  // With recentDays=30 and today='2026-06-11', cutoff = 2026-05-12 → May 10 is excluded
  const detail = buildExerciseDetail(SAMPLE_LOG, 'BP', { today: '2026-06-11', recentDays: 30 });
  assert.equal(detail.sessions_count, 1, 'one BP session');
  assert.equal(detail.best_recent_set, null, 'May-10 is outside the 30-day window');
});

test('exercise detail: last_sessions is capped at 5 even with more history', () => {
  // Build a lift with 7 sessions
  const rows = [];
  for (let i = 1; i <= 7; i++) {
    rows.push([`2026-0${i < 10 ? '0' + i : i}-10`, `S${i}`, 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', String(185 + i * 5), '8', '2', '']);
  }
  const detail = buildExerciseDetail(rows, 'BP', { today: '2026-06-30' });
  assert.equal(detail.sessions_count, 7);
  assert.equal(detail.last_sessions.length, 5, 'last_sessions must be capped at 5');
  // The last session (highest weight) must appear
  assert.equal(detail.last_sessions[4].best_weight, 185 + 7 * 5);
});

test('exercise detail: endpoint registered as GET and read-only', () => {
  const route = routeDefinitions.find(r => r.path === '/api/exercises/:liftCode/detail');
  assert.ok(route, 'route definition must exist');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.readOnly, true);
  assert.equal(route.writeCapable, false);
  assert.equal(route.authRequired, true);
});

test('exercise detail: detail-form wired in app.js and calls correct endpoint', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /detail-form/, 'detail-form must be referenced in app.js');
  assert.match(appSource, /detail-lift-code/, 'detail-lift-code input must be referenced');
  assert.match(appSource, /\/api\/exercises\/.*\/detail/, 'must call exercises detail endpoint');
  const handlerStart = appSource.indexOf("getElementById('detail-form')");
  assert.ok(handlerStart !== -1, 'detail-form handler must be registered');
  const handlerBlock = appSource.slice(handlerStart, handlerStart + 2100);
  assert.match(handlerBlock, /sessions_count/, 'must check sessions_count for empty state');
  assert.match(handlerBlock, /last_sessions/, 'must render last_sessions table');
  assert.match(handlerBlock, /recommendation/, 'must render recommendation');
});

// ── Session History ────────────────────────────────────────────────────────────

const HISTORY_LOG = [
  ['2026-06-10', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '225', '5', '2', ''],
  ['2026-06-10', 'S2', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '185', '8', '2', ''],
  ['2026-06-10', 'S2', 'Bench Press', 'Bench Press', 'Chest', 'BP', '2', '185', '8', '2', ''],
  ['2026-06-05', 'S1', 'Deadlift', 'Deadlift', 'Back', 'DL', '1', '315', '3', '2', ''],
];

const HISTORY_EFFORT = [
  ['2026-06-10', 'S2', '1:05:00', '420', '580', '138', '172', 'Gym', ''],
];

test('session history: buildRecentSessions returns correct structure', () => {
  const result = buildRecentSessions(HISTORY_LOG, HISTORY_EFFORT);
  assert.ok(Array.isArray(result.sessions), 'sessions must be an array');
  assert.equal(result.count, 2, 'should find 2 distinct sessions');
  const s2 = result.sessions.find(s => s.session_id === 'S2');
  assert.ok(s2, 'S2 session must be present');
  assert.equal(s2.date, '2026-06-10');
  assert.ok(Array.isArray(s2.exercises), 'exercises must be an array');
  assert.ok(s2.exercises.length > 0, 'exercises must not be empty');
  assert.ok(s2.sets_count > 0, 'sets_count must be positive');
  assert.ok(s2.total_volume > 0, 'total_volume must be positive');
});

test('session history: buildRecentSessions joins effort data', () => {
  const result = buildRecentSessions(HISTORY_LOG, HISTORY_EFFORT);
  const s2 = result.sessions.find(s => s.session_id === 'S2');
  assert.ok(s2.effort !== null, 'S2 must have effort joined');
  assert.equal(s2.effort.active_calories, 420);
  const s1 = result.sessions.find(s => s.session_id === 'S1');
  assert.equal(s1.effort, null, 'S1 has no effort row');
});

test('session history: buildRecentSessions returns sessions sorted by date desc', () => {
  const result = buildRecentSessions(HISTORY_LOG, HISTORY_EFFORT);
  assert.equal(result.sessions[0].session_id, 'S2', 'most recent session must come first');
  assert.equal(result.sessions[1].session_id, 'S1');
});

test('session history: buildRecentSessions handles empty data', () => {
  const result = buildRecentSessions([], []);
  assert.equal(result.sessions.length, 0);
  assert.equal(result.count, 0);
});

test('session history: buildRecentSessions respects limit', () => {
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    rows.push([`2026-0${i < 10 ? '0' + i : i}-01`, `SX${i}`, 'Squat', 'Back Squat', 'Legs', 'SQ', '1', '200', '5', '2', '']);
  }
  const result = buildRecentSessions(rows, [], { limit: 5 });
  assert.equal(result.sessions.length, 5, 'must respect limit of 5');
  assert.equal(result.count, 5);
});

// Regression: issue #359 — historical lift retrieval must use actual logged sets.
// Golden fixture: the exact June 11 bench session from the bug report.
// These ensure the snapshot carries real per-set data so the model cannot
// answer a history question from prescription/benchmark data instead.
test('session history: buildRecentSessions includes lift_sets with per-set data (issue #359 golden fixture)', () => {
  const jun11Rows = [
    ['2026-06-11', '20260611-PM-01', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '135', '12', '4', ''],
    ['2026-06-11', '20260611-PM-01', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '2', '185', '10', '2', ''],
    ['2026-06-11', '20260611-PM-01', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '3', '225', '6',  '1', ''],
    ['2026-06-11', '20260611-PM-01', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '4', '225', '5',  '1', ''],
    ['2026-06-11', '20260611-PM-01', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '5', '225', '5',  '0', ''],
  ];
  const result = buildRecentSessions(jun11Rows, []);
  assert.equal(result.sessions.length, 1);
  const session = result.sessions[0];
  assert.equal(session.date, '2026-06-11');
  assert.ok(session.lift_sets && typeof session.lift_sets === 'object', 'lift_sets must be present');
  const benchSets = session.lift_sets['Bench Press'];
  assert.ok(Array.isArray(benchSets), 'Bench Press must have a set array');
  assert.equal(benchSets.length, 5, 'all 5 sets must be preserved');
  assert.deepEqual(benchSets[0], { weight: 135, reps: 12, rir: 4 }, 'set 1: 135×12 @RIR4');
  assert.deepEqual(benchSets[1], { weight: 185, reps: 10, rir: 2 }, 'set 2: 185×10 @RIR2');
  assert.deepEqual(benchSets[2], { weight: 225, reps: 6,  rir: 1 }, 'set 3: 225×6  @RIR1');
  assert.deepEqual(benchSets[3], { weight: 225, reps: 5,  rir: 1 }, 'set 4: 225×5  @RIR1');
  assert.deepEqual(benchSets[4], { weight: 225, reps: 5,  rir: 0 }, 'set 5: 225×5  @RIR0 — RIR 0 must not be dropped');
});

test('session history: buildRecentSessions lift_sets includes null rir when not logged', () => {
  const rows = [
    ['2026-06-11', 'S1', 'Deadlift', 'Deadlift', 'Back', 'DL01', '1', '315', '3', '', ''],
  ];
  const result = buildRecentSessions(rows, []);
  const dlSets = result.sessions[0].lift_sets['Deadlift'];
  assert.equal(dlSets.length, 1);
  assert.equal(dlSets[0].rir, null, 'missing RIR must be null, not fabricated');
});

test('session history: buildRecentSessions lift_sets excludes rows with no weight/reps', () => {
  const rows = [
    ['2026-06-11', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '225', '5', '2', ''],
    ['2026-06-11', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '2', '',    '',  '',  ''],
  ];
  const result = buildRecentSessions(rows, []);
  const benchSets = result.sessions[0].lift_sets['Bench Press'];
  assert.equal(benchSets.length, 1, 'row without weight/reps must not appear in lift_sets');
});

test('session history: buildRecentSessions lift_sets caps at 12 sets per exercise', () => {
  const rows = [];
  for (let i = 1; i <= 15; i++) {
    rows.push(['2026-06-11', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', String(i), '135', '5', '3', '']);
  }
  const result = buildRecentSessions(rows, []);
  const benchSets = result.sessions[0].lift_sets['Bench Press'];
  assert.equal(benchSets.length, 12, 'lift_sets must cap at 12 sets per exercise');
});

test('progress summary: returns correct structure for normal data', () => {
  const rows = [
    ['2026-05-26', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '2', ''],
    ['2026-05-26', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '2', '200', '5', '2', ''],
    ['2026-05-28', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '300', '5', '2', ''],
    ['2026-06-02', 'S3', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '205', '5', '2', ''],
    ['2026-06-04', 'S4', 'Lat Pulldown', 'Lat Pulldown', 'Back', 'LPD', '1', '160', '8', '2', ''],
    ['2026-06-09', 'S5', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '210', '5', '2', ''],
    ['2026-06-10', 'S6', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '305', '5', '2', '']
  ];

  const summary = buildProgressSummary(rows, { today: '2026-06-11' });

  assert.equal(summary.total_sessions, 6);
  assert.equal(summary.total_sets, 7);
  assert.equal(summary.total_volume, 8380);
  assert.equal(summary.first_session_date, '2026-05-26');
  assert.equal(summary.latest_session_date, '2026-06-10');
  assert.equal(summary.current_week_sessions, 2);
  assert.equal(summary.weekly_streak, 0);
  assert.equal(summary.streak_target_per_week, 3);
  assert.equal(summary.average_sessions_per_week, 2);
  assert.ok(Array.isArray(summary.sessions_by_week));
  assert.ok(Array.isArray(summary.volume_by_week));
  assert.ok(Array.isArray(summary.top_exercises));
  assert.equal(summary.top_exercises[0].exercise, 'Bench Press');
  assert.equal(summary.recent_prs.length, 0);
});

test('progress summary: counts a 2+ week streak when recent weeks meet target', () => {
  const rows = [
    ['2026-05-26', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '2', ''],
    ['2026-05-28', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '300', '5', '2', ''],
    ['2026-05-30', 'S3', 'Lat Pulldown', 'Lat Pulldown', 'Back', 'LPD', '1', '160', '8', '2', ''],
    ['2026-06-02', 'S4', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '205', '5', '2', ''],
    ['2026-06-04', 'S5', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '305', '5', '2', ''],
    ['2026-06-06', 'S6', 'Lat Pulldown', 'Lat Pulldown', 'Back', 'LPD', '1', '165', '8', '2', '']
  ];

  const summary = buildProgressSummary(rows, { today: '2026-06-07' });
  assert.equal(summary.current_week_sessions, 3);
  assert.equal(summary.weekly_streak, 2);
});

test('progress summary: streak resets when current week is below target', () => {
  const rows = [
    ['2026-05-26', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '200', '5', '2', ''],
    ['2026-05-28', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '300', '5', '2', ''],
    ['2026-05-30', 'S3', 'Lat Pulldown', 'Lat Pulldown', 'Back', 'LPD', '1', '160', '8', '2', ''],
    ['2026-06-02', 'S4', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '205', '5', '2', ''],
    ['2026-06-03', 'S5', 'Back Squat', 'Back Squat', 'Legs', 'SQ', '1', '305', '5', '2', ''],
    ['2026-06-04', 'S6', 'Lat Pulldown', 'Lat Pulldown', 'Back', 'LPD', '1', '165', '8', '2', ''],
    ['2026-06-09', 'S7', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '210', '5', '2', '']
  ];

  const summary = buildProgressSummary(rows, { today: '2026-06-11' });
  assert.equal(summary.current_week_sessions, 1);
  assert.equal(summary.weekly_streak, 0);
});

test('progress summary: returns zero-state for empty data', () => {
  const summary = buildProgressSummary([], { today: '2026-06-11' });
  assert.equal(summary.total_sessions, 0);
  assert.equal(summary.average_sessions_per_week, 0);
  assert.equal(summary.total_sets, 0);
  assert.equal(summary.total_volume, 0);
  assert.equal(summary.first_session_date, null);
  assert.equal(summary.latest_session_date, null);
  assert.equal(summary.current_week_sessions, 0);
  assert.equal(summary.weekly_streak, 0);
  assert.equal(summary.streak_target_per_week, 3);
  assert.deepEqual(summary.top_exercises, []);
  assert.deepEqual(summary.recent_prs, []);
  assert.deepEqual(summary.watchouts, []);
  assert.equal(summary.sessions_by_week.length, 12);
  assert.equal(summary.volume_by_week.length, 12);
});

test('progress summary: endpoint registered as GET and read-only', () => {
  const route = routeDefinitions.find(r => r.path === '/api/progress/summary');
  assert.ok(route, 'route definition must exist');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.readOnly, true);
  assert.equal(route.writeCapable, false);
  assert.equal(route.authRequired, true);
});

test('trainingStore read layer can be stubbed and builds progress summary', async () => {
  const sheetsPath = require.resolve('../sheets');
  const trainingStorePath = require.resolve('../services/trainingStore');
  const originalSheetsCache = require.cache[sheetsPath];
  const originalTrainingStoreCache = require.cache[trainingStorePath];
  const calls = [];

  require.cache[sheetsPath] = {
    id: sheetsPath,
    filename: sheetsPath,
    loaded: true,
    exports: {
      getRecentRows: async (tabName, limit) => {
        calls.push(['getRecentRows', tabName, limit]);
        return [];
      },
      getSheetRows: async tabName => {
        calls.push(['getSheetRows', tabName]);
        if (tabName === 'Log_Cleaned') {
          return [
            ['2026-06-09', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '200', '5', '2', ''],
            ['2026-06-10', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '300', '5', '2', '']
          ];
        }
        return [];
      },
      logSheetName: 'Log_Cleaned',
      effortSheetName: 'Effort'
    }
  };
  delete require.cache[trainingStorePath];

  try {
    const trainingStore = require('../services/trainingStore');
    const summary = await trainingStore.getProgressSummary({ today: '2026-06-11' });

    assert.equal(summary.total_sessions, 2);
    assert.equal(summary.total_sets, 2);
    assert.equal(summary.total_volume, 2500);
    assert.deepEqual(calls, [['getSheetRows', 'Log_Cleaned']]);
  } finally {
    if (originalSheetsCache) require.cache[sheetsPath] = originalSheetsCache;
    else delete require.cache[sheetsPath];
    if (originalTrainingStoreCache) require.cache[trainingStorePath] = originalTrainingStoreCache;
    else delete require.cache[trainingStorePath];
  }
});

test('trainingStore read layer combines log and effort rows for recent sessions', async () => {
  const sheetsPath = require.resolve('../sheets');
  const trainingStorePath = require.resolve('../services/trainingStore');
  const originalSheetsCache = require.cache[sheetsPath];
  const originalTrainingStoreCache = require.cache[trainingStorePath];
  const calls = [];

  require.cache[sheetsPath] = {
    id: sheetsPath,
    filename: sheetsPath,
    loaded: true,
    exports: {
      getRecentRows: async (tabName, limit) => {
        calls.push(['getRecentRows', tabName, limit]);
        return [];
      },
      getSheetRows: async tabName => {
        calls.push(['getSheetRows', tabName]);
        if (tabName === 'Log_Cleaned') {
          return [
            ['2026-06-10', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '200', '5', '2', '']
          ];
        }
        if (tabName === 'Effort') {
          return [['2026-06-10', 'S1', '45', '300', '400', '120', '160', 'Gym', '']];
        }
        return [];
      },
      logSheetName: 'Log_Cleaned',
      effortSheetName: 'Effort'
    }
  };
  delete require.cache[trainingStorePath];

  try {
    const trainingStore = require('../services/trainingStore');
    const result = await trainingStore.getRecentSessions({ limit: 5 });

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].session_id, 'S1');
    assert.equal(result.sessions[0].effort.duration, '45');
    assert.deepEqual(calls, [['getSheetRows', 'Log_Cleaned'], ['getSheetRows', 'Effort']]);
  } finally {
    if (originalSheetsCache) require.cache[sheetsPath] = originalSheetsCache;
    else delete require.cache[sheetsPath];
    if (originalTrainingStoreCache) require.cache[trainingStorePath] = originalTrainingStoreCache;
    else delete require.cache[trainingStorePath];
  }
});

test('session history: /api/sessions/recent endpoint registered as GET and read-only', () => {
  const route = routeDefinitions.find(r => r.path === '/api/sessions/recent');
  assert.ok(route, 'route definition must exist');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.readOnly, true);
  assert.equal(route.writeCapable, false);
  assert.equal(route.authRequired, true);
});

test('session history: /api/sessions/recent registered BEFORE /:sessionId in index.js', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  const recentIdx = src.indexOf("'/api/sessions/recent'");
  const paramIdx = src.indexOf("'/api/sessions/:sessionId'");
  assert.ok(recentIdx !== -1, '/api/sessions/recent endpoint must exist');
  assert.ok(paramIdx !== -1, '/api/sessions/:sessionId endpoint must exist');
  assert.ok(recentIdx < paramIdx, '/api/sessions/recent must be registered before /:sessionId');
});

test('session history: auto-load wired in app.js and calls correct endpoint', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /\/api\/sessions\/recent/, 'must call /api/sessions/recent');
  assert.match(appSource, /loadHistory/, 'loadHistory function must exist');
  assert.match(appSource, /sessions-result/, 'sessions-result container must be used');
  assert.match(appSource, /atlasRefreshSessions/, 'refresh bridge for nav.js must exist');
  const htmlSource = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(htmlSource, /load-sessions-btn/, 'manual load button must stay removed — list auto-loads');
  // With no manual refresh button, writes and undos must invalidate the cache
  // (declaration + write success + undo success = at least 3 assignments).
  const invalidations = (appSource.match(/historyLoaded = false/g) || []).length;
  assert.ok(invalidations >= 3, 'successful write and undo must reset historyLoaded so History re-fetches');
});

// ── Session Queue UX ──────────────────────────────────────────────────────────

test('session queue: startLift function exists and switches to logger tab', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /function startLift\(/, 'startLift must exist');
  const fnStart = appSource.indexOf('function startLift(');
  const fnBlock = appSource.slice(fnStart, fnStart + 3500);
  assert.match(fnBlock, /tab-logger/, 'must switch to logger tab');
  assert.match(fnBlock, /coach-panel/, 'must show coach panel');
  assert.match(fnBlock, /workout-text/, 'must reference workout textarea');
});

test('session queue: coach-panel element exists in index.html logger section', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const loggerSection = html.slice(html.indexOf('tab-logger'), html.indexOf('tab-logger') + 2000);
  assert.match(loggerSection, /id="coach-panel"/, 'coach-panel must be in logger section');
});

test('today-screen: above-fold elements exist in index.html', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const dashSection = html.slice(html.indexOf('tab-dashboard'), html.indexOf('tab-progress'));
  assert.match(dashSection, /id="todays-pick"/, 'today\'s pick hero card must exist');
  assert.match(dashSection, /id="start-session-btn"/, 'START SESSION button must exist');
  assert.match(dashSection, /id="consistency-line"/, 'consistency line must exist');
  // Intent grid stays — now in a glance-card
  assert.match(dashSection, /id="intent-grid"/, 'intent-grid must remain');
});

test('dashboard simplification: Suggested Session card removed from dashboard HTML', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const dashSection = html.slice(html.indexOf('tab-dashboard'), html.indexOf('tab-progress'));
  assert.doesNotMatch(dashSection, /id="suggested-session"/, 'suggested-session element must not be in dashboard');
  assert.doesNotMatch(dashSection, /<h2>Suggested Session<\/h2>/, 'Suggested Session heading must not be in dashboard');
  assert.match(dashSection, /id="intent-grid"/, 'intent-grid tiles must remain');
});

test('dashboard simplification: loadDashboard does not call loadSuggestedSession', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const dashFn = appSource.slice(
    appSource.indexOf('async function loadDashboard('),
    appSource.indexOf('async function loadDashboard(') + 1200
  );
  assert.doesNotMatch(dashFn, /loadSuggestedSession/, 'loadDashboard must not call loadSuggestedSession');
  assert.match(dashFn, /intent-recommendation/, 'loadDashboard must call the intent-recommendation endpoint');
  assert.match(dashFn, /progress\/summary/, 'loadDashboard must call progress/summary');
});

test('session queue: loadTodaysPlan includes helper copy about targets', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /progression targets.*not a required order|not a required order/, 'must include helper copy about targets');
  assert.match(appSource, /Log a few sessions/, 'must include new-user message');
});

// ── Mobile tap fix tests ──────────────────────────────────────────────────────

test('mobile tap fix: plan-card exercise name is not a lift-link anchor', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const planFn = appSource.slice(appSource.indexOf('async function loadTodaysPlan'), appSource.indexOf('async function loadTodaysPlan') + 2000);
  // exercise name must be a span, not an anchor with lift-link
  assert.match(planFn, /plan-card-lift-name/, 'exercise name must use plan-card-lift-name span');
  // a View progress link must exist as the navigation path
  assert.match(planFn, /View progress/, 'must have explicit View progress link');
  assert.match(planFn, /plan-card-progress-link/, 'must use plan-card-progress-link class');
  // must not use lift-link class on the exercise name span
  assert.doesNotMatch(planFn, /lift-link.*text: exerciseName/, 'exercise name must not use lift-link directly');
});

test('mobile tap fix: session-start-btn has active state in CSS', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /session-start-btn:active/, 'must have :active state for touch feedback');
  assert.match(css, /border-left.*accent/, 'must have accent border for visual affordance');
});

test('mobile tap fix: coach panel uses conversational wording', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fnStart = appSource.indexOf('function startLift(');
  const fnBlock = appSource.slice(fnStart, fnStart + 3000);
  assert.match(fnBlock, /Ok,.*time\./, 'coach panel must open with conversational greeting');
  assert.match(fnBlock, /aim for/, 'coach panel must use aim for in target text');
  assert.match(fnBlock, /Last session:/, 'coach panel must label last set as Last session');
});

test('mobile tap fix: startLift coach panel includes back-to-session button', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fnStart = appSource.indexOf('function startLift(');
  const fnBlock = appSource.slice(fnStart, fnStart + 3000);
  assert.match(fnBlock, /Back to session/, 'coach panel must have Back to session button');
  assert.match(fnBlock, /tab-dashboard/, 'back button must switch to dashboard tab');
});

// ── Start Any Lift From Dashboard ─────────────────────────────────────────────

test('start-any-lift: plan cards are tappable and call startLift', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const planFn = appSource.slice(appSource.indexOf('async function loadTodaysPlan'), appSource.indexOf('async function loadTodaysPlan') + 2000);
  assert.match(planFn, /plan-card-startable/, 'card must have startable class');
  assert.match(planFn, /card\.addEventListener.*click/, 'card must have click handler');
  assert.match(planFn, /startLift\(exerciseName/, 'card click must call startLift with exercise name');
  assert.match(planFn, /e\.target\.closest.*lift-link/, 'card click must skip lift-link clicks');
});

test('start-any-lift: plan card footer has Tap to start hint and View progress link', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const planFn = appSource.slice(appSource.indexOf('async function loadTodaysPlan'), appSource.indexOf('async function loadTodaysPlan') + 2000);
  assert.match(planFn, /plan-card-footer/, 'must have plan-card-footer container');
  assert.match(planFn, /plan-card-tap-hint/, 'must have tap hint element');
  assert.match(planFn, /Tap to start/, 'must include Tap to start text');
  assert.match(planFn, /View progress/, 'must retain View progress secondary link');
});

test('start-any-lift: plan-card-startable has :active state in CSS', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /plan-card-startable:active/, 'startable cards must have :active touch state');
  assert.match(css, /cursor.*pointer/, 'startable cards must set cursor:pointer');
});

test('start-any-lift: helper text tells user to tap any card', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /Tap any card to start that lift/, 'helper copy must guide mobile users');
});

// ── Intent analytics: classifyMuscleGroup ──────────────────────────────────────

test('classifyMuscleGroup: maps standard muscle group strings to patterns', () => {
  assert.equal(classifyMuscleGroup('Legs'), 'lower');
  assert.equal(classifyMuscleGroup('Quads'), 'lower');
  assert.equal(classifyMuscleGroup('Chest'), 'push');
  assert.equal(classifyMuscleGroup('Shoulders'), 'push');
  assert.equal(classifyMuscleGroup('Back'), 'pull');
  assert.equal(classifyMuscleGroup('Lats'), 'pull');
  assert.equal(classifyMuscleGroup('Rear Delts'), 'pull');
  assert.equal(classifyMuscleGroup('Core'), 'core');
  assert.equal(classifyMuscleGroup('Posterior Chain'), 'hinge');
  assert.equal(classifyMuscleGroup('Lower Back'), 'hinge');
});

test('classifyMuscleGroup: Rear Delts routes to pull not push', () => {
  assert.equal(classifyMuscleGroup('Rear Delts'), 'pull');
  assert.notEqual(classifyMuscleGroup('Rear Delts'), 'push');
});

test('classifyMuscleGroup: Posterior Chain routes to hinge not lower', () => {
  assert.equal(classifyMuscleGroup('Posterior Chain'), 'hinge');
  assert.notEqual(classifyMuscleGroup('Posterior Chain'), 'lower');
});

test('classifyMuscleGroup: returns null for unknown muscle group', () => {
  assert.equal(classifyMuscleGroup('Unknown'), null);
  assert.equal(classifyMuscleGroup(''), null);
  assert.equal(classifyMuscleGroup(null), null);
});

// ── Intent analytics: buildMuscleGroupReadiness ────────────────────────────────

const makeLogRow = (date, sessionId, muscleGroup, weight = 100, reps = 5, rir = 2) => [
  date, sessionId, muscleGroup, muscleGroup, muscleGroup, 'TST01',
  '1', String(weight), String(reps), String(rir), ''
];

test('buildMuscleGroupReadiness: fatigued when trained today', () => {
  const today = '2026-06-12';
  const rows = [makeLogRow('2026-06-12', 'S1', 'Chest')];
  const result = buildMuscleGroupReadiness(rows, { today });
  const push = result.find(r => r.pattern === 'push');
  assert.equal(push.status, 'fatigued');
  assert.equal(push.daysSince, 0);
});

test('buildMuscleGroupReadiness: fatigued when trained yesterday at @1 RIR', () => {
  const today = '2026-06-12';
  const rows = [makeLogRow('2026-06-11', 'S1', 'Chest', 100, 5, 1)];
  const result = buildMuscleGroupReadiness(rows, { today });
  const push = result.find(r => r.pattern === 'push');
  assert.equal(push.status, 'fatigued');
});

test('buildMuscleGroupReadiness: recovering when trained yesterday at @2 RIR', () => {
  const today = '2026-06-12';
  const rows = [makeLogRow('2026-06-11', 'S1', 'Chest', 100, 5, 2)];
  const result = buildMuscleGroupReadiness(rows, { today });
  const push = result.find(r => r.pattern === 'push');
  assert.equal(push.status, 'recovering');
});

test('buildMuscleGroupReadiness: ready when trained 3 days ago', () => {
  const today = '2026-06-12';
  const rows = [makeLogRow('2026-06-09', 'S1', 'Back')];
  const result = buildMuscleGroupReadiness(rows, { today });
  const pull = result.find(r => r.pattern === 'pull');
  assert.equal(pull.status, 'ready');
});

test('buildMuscleGroupReadiness: fresh when not trained in 5+ days', () => {
  const today = '2026-06-12';
  const rows = [makeLogRow('2026-06-07', 'S1', 'Back')];
  const result = buildMuscleGroupReadiness(rows, { today });
  const pull = result.find(r => r.pattern === 'pull');
  assert.equal(pull.status, 'fresh');
  assert.equal(pull.daysSince, 5);
});

test('buildMuscleGroupReadiness: unknown for patterns never trained', () => {
  const today = '2026-06-12';
  const rows = [makeLogRow('2026-06-10', 'S1', 'Chest')]; // only push trained
  const result = buildMuscleGroupReadiness(rows, { today });
  const core = result.find(r => r.pattern === 'core');
  assert.equal(core.status, 'unknown');
  assert.equal(core.daysSince, null);
});

test('buildMuscleGroupReadiness: returns all 5 patterns', () => {
  const result = buildMuscleGroupReadiness([], { today: '2026-06-12' });
  const patterns = result.map(r => r.pattern).sort();
  assert.deepEqual(patterns, ['core', 'hinge', 'lower', 'pull', 'push']);
});

// ── Continuous recovery curve (Phase 2a) ───────────────────────────────────────

test('recovery curve: exposes a continuous recovery fraction that climbs with rest', () => {
  const today = '2026-06-12';
  const recoveryAt = daysAgo => {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - daysAgo);
    const rows = [makeLogRow(d.toISOString().slice(0, 10), 'S1', 'Chest', 100, 5, 2)];
    return buildMuscleGroupReadiness(rows, { today }).find(r => r.pattern === 'push').recovery;
  };
  const r0 = recoveryAt(0), r1 = recoveryAt(1), r3 = recoveryAt(3), r6 = recoveryAt(6);
  assert.equal(r0, 0, 'just-trained recovery must be 0');
  assert.ok(r1 > r0 && r3 > r1 && r6 > r3, 'recovery must rise monotonically with rest days');
  assert.ok(r6 > 0.9, 'a week out should be nearly fully recovered');
  assert.equal(buildMuscleGroupReadiness([], { today }).find(r => r.pattern === 'push').recovery, null,
    'never-trained pattern has null recovery');
});

test('recovery curve: a harder session (lower RIR) recovers slower than an easy one', () => {
  const today = '2026-06-12';
  const date = '2026-06-09'; // 3 days prior for both
  const recoveryFor = rir =>
    buildMuscleGroupReadiness([makeLogRow(date, 'S1', 'Chest', 100, 5, rir)], { today })
      .find(r => r.pattern === 'push').recovery;
  const hard = recoveryFor(0);   // trained to failure
  const easy = recoveryFor(3);   // left plenty in the tank
  assert.ok(easy > hard, `easy session must recover faster (easy=${easy}, hard=${hard})`);
});

test('recovery curve: intensity can change the readiness label at the same rest gap', () => {
  const today = '2026-06-12';
  const date = '2026-06-09'; // 3 days prior
  const statusFor = rir =>
    buildMuscleGroupReadiness([makeLogRow(date, 'S1', 'Chest', 100, 5, rir)], { today })
      .find(r => r.pattern === 'push').status;
  // A brutal (failure) session is still only "recovering" at 3 days, while a
  // moderate one is "ready" — the curve, not a fixed day-bin, decides.
  assert.equal(statusFor(0), 'recovering', 'failure session is still recovering at 3 days');
  assert.equal(statusFor(2), 'ready', 'moderate session is ready at 3 days');
});

// ── Effort data folded into recovery (Phase 2b) ────────────────────────────────
// Effort rows are arrays: [date, session_id, duration, active_cal, total_cal, avg_hr, peak_hr, location, notes]

test('effort fatigue: a high-effort session recovers slower than a low-effort one at the same gap', () => {
  const today = '2026-06-12';
  const logRows = [makeLogRow('2026-06-09', 'HARD', 'Chest', 100, 5, 2)]; // 3 days, @2 RIR
  // Same session, opposite effort profiles. The OTHER row only provides spread to normalise against.
  const hardEffort = [
    ['2026-06-09', 'HARD', '75:00', 600, 750, 170, 185, '', ''],
    ['2026-06-01', 'OTHER', '30:00', 200, 300, 110, 130, '', ''],
  ];
  const easyEffort = [
    ['2026-06-09', 'HARD', '30:00', 200, 300, 110, 130, '', ''],
    ['2026-06-01', 'OTHER', '75:00', 600, 750, 170, 185, '', ''],
  ];
  const pushWith = effort => buildMuscleGroupReadiness(logRows, { today, effortRows: effort }).find(r => r.pattern === 'push');
  const hard = pushWith(hardEffort);
  const easy = pushWith(easyEffort);
  assert.ok(hard.recovery < easy.recovery, `high-effort must recover slower (hard=${hard.recovery}, easy=${easy.recovery})`);
  assert.equal(hard.status, 'recovering', 'a hard session is still recovering at 3 days');
  assert.equal(easy.status, 'ready', 'an easy session is ready at 3 days');
  assert.ok(hard.effortIntensity > easy.effortIntensity, 'effort intensity must be surfaced and ordered');
});

test('effort fatigue: recovery stays neutral when effort data is absent or too sparse', () => {
  const today = '2026-06-12';
  const logRows = [makeLogRow('2026-06-09', 'S1', 'Chest', 100, 5, 2)];
  const baseline = buildMuscleGroupReadiness(logRows, { today }).find(r => r.pattern === 'push');
  // A single effort row can't be normalised → must match the no-effort baseline exactly.
  const oneEffort = [['2026-06-09', 'S1', '60:00', 400, 500, 150, 175, '', '']];
  const withOne = buildMuscleGroupReadiness(logRows, { today, effortRows: oneEffort }).find(r => r.pattern === 'push');
  assert.equal(withOne.recovery, baseline.recovery, 'one effort row must not shift recovery');
  assert.equal(withOne.effortIntensity, null, 'sparse effort yields null intensity');
  assert.equal(baseline.effortIntensity, null, 'no effort yields null intensity');
});

test('scoreIntents: threads effort data into readiness (high-effort session shows less recovery)', () => {
  const today = '2026-06-12';
  const rows = makeIntentLogRows([
    { date: '2026-06-09', session: 'HARD', muscle: 'Chest', liftCode: 'BEN01', weight: 200, reps: 5, rir: 2 },
  ]);
  const effortHigh = [
    ['2026-06-09', 'HARD', '80:00', 650, 800, 175, 188, '', ''],
    ['2026-06-01', 'OTHER', '25:00', 180, 260, 105, 125, '', ''],
  ];
  const effortLow = [
    ['2026-06-09', 'HARD', '25:00', 180, 260, 105, 125, '', ''],
    ['2026-06-01', 'OTHER', '80:00', 650, 800, 175, 188, '', ''],
  ];
  const pushVia = effort => scoreIntents(rows, effort, { today }).todays_read.patterns.find(p => p.pattern === 'push');
  assert.ok(pushVia(effortHigh).recovery < pushVia(effortLow).recovery,
    'effort must flow through scoreIntents into per-pattern recovery');
});

// ── Intent analytics: scoreIntents ────────────────────────────────────────────

function makeIntentLogRows(entries) {
  // entries: [{ date, session, muscle, weight, reps, rir }]
  return entries.map(e => [
    e.date, e.session, e.exercise || e.muscle, e.exercise || e.muscle,
    e.muscle, e.liftCode || 'TST01', '1',
    String(e.weight || 100), String(e.reps || 5), String(e.rir ?? 2), ''
  ]);
}

test('scoreIntents: returns all 8 intent ids', () => {
  const rows = makeIntentLogRows([
    { date: '2026-06-09', session: 'S1', muscle: 'Chest', liftCode: 'BEN01', weight: 225, reps: 5, rir: 2 },
    { date: '2026-06-09', session: 'S1', muscle: 'Back', liftCode: 'LPD01', weight: 150, reps: 8, rir: 2 },
    { date: '2026-06-07', session: 'S2', muscle: 'Legs', liftCode: 'SQ01', weight: 200, reps: 5, rir: 2 }
  ]);
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  const ids = result.intents.map(i => i.id).sort();
  assert.deepEqual(ids, ['balanced', 'build_muscle', 'build_strength', 'custom', 'fix_blind_spots', 'recovery_pump', 'short_session', 'test_progress'].sort());
});

test('scoreIntents: exactly one intent is recommended (non-custom)', () => {
  const rows = makeIntentLogRows([
    { date: '2026-06-09', session: 'S1', muscle: 'Chest', liftCode: 'BEN01', weight: 225, reps: 5, rir: 2 }
  ]);
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  const recommended = result.intents.filter(i => i.recommended);
  assert.equal(recommended.length, 1, 'exactly one intent must be recommended');
  assert.notEqual(recommended[0].id, 'custom', 'custom must never be recommended');
});

test('scoreIntents: recovery_pump scores high when overall fatigue is high', () => {
  // Fill in lots of volume in past 7 days vs low baseline
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(...makeIntentLogRows([
      { date: '2026-06-10', session: `S${i}`, muscle: 'Chest', liftCode: `B${i}`, weight: 200, reps: 10, rir: 1 }
    ]));
  }
  // Add small baseline (older) to make ratio > 1.5
  rows.push(...makeIntentLogRows([
    { date: '2026-05-20', session: 'OLD', muscle: 'Chest', liftCode: 'B00', weight: 100, reps: 5, rir: 3 }
  ]));
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  const recovery = result.intents.find(i => i.id === 'recovery_pump');
  // Score should be higher than baseline 30
  assert.ok(recovery.score > 30, `recovery_pump score should be > 30, got ${recovery.score}`);
});

test('scoreIntents: fix_blind_spots scores high when a pattern is fresh', () => {
  const rows = makeIntentLogRows([
    { date: '2026-06-05', session: 'S1', muscle: 'Back', liftCode: 'LPD01', weight: 150, reps: 8, rir: 2 }
  ]);
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  const fbs = result.intents.find(i => i.id === 'fix_blind_spots');
  assert.ok(fbs.score > 40, `fix_blind_spots score should be > 40, got ${fbs.score}`);
  assert.equal(fbs.confidence, 'high');
});

test('scoreIntents: todays_read contains per-pattern readiness', () => {
  const rows = makeIntentLogRows([
    { date: '2026-06-12', session: 'S1', muscle: 'Chest', liftCode: 'BEN01', weight: 225, reps: 5, rir: 1 }
  ]);
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  assert.ok(result.todays_read, 'todays_read must exist');
  assert.ok(Array.isArray(result.todays_read.patterns), 'patterns must be an array');
  assert.ok(result.todays_read.recommended_intent_id, 'must include recommended_intent_id');
  const push = result.todays_read.patterns.find(p => p.pattern === 'push');
  assert.equal(push.status, 'fatigued', 'push must be fatigued after training today');
});

test('scoreIntents: each intent has required fields', () => {
  const rows = makeIntentLogRows([
    { date: '2026-06-10', session: 'S1', muscle: 'Chest', liftCode: 'BEN01', weight: 200, reps: 5, rir: 2 }
  ]);
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  for (const intent of result.intents) {
    assert.ok(typeof intent.id === 'string', `${intent.id}: id must be string`);
    assert.ok(typeof intent.label === 'string', `${intent.id}: label must be string`);
    assert.ok(typeof intent.score === 'number', `${intent.id}: score must be number`);
    assert.ok(typeof intent.recommended === 'boolean', `${intent.id}: recommended must be boolean`);
    assert.ok(Array.isArray(intent.why_today), `${intent.id}: why_today must be array`);
    assert.ok(Array.isArray(intent.exercises), `${intent.id}: exercises must be array`);
  }
});

test('scoreIntents: returns ok with no history', () => {
  const result = scoreIntents([], [], { today: '2026-06-12' });
  assert.ok(result.intents.length === 8, 'must return all 8 intents even with no history');
  assert.ok(result.todays_read, 'todays_read must exist even with no history');
});

// ── Stalls-aware recommendations (Phase 1) ─────────────────────────────────────

test('scoreIntents: surfaces a Deload & Reset intent when 2+ rested lifts are stalled', () => {
  // Both stalled lifts were last trained ~6-7 days ago → muscle groups are rested,
  // so deloading them today is appropriate.
  const rows = makeIntentLogRows([
    { date: '2026-05-28', session: 'A1', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-01', session: 'A2', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-05', session: 'A3', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-05-28', session: 'A1', muscle: 'Back', liftCode: 'ROW01', weight: 155, reps: 8, rir: 1 },
    { date: '2026-06-01', session: 'A2', muscle: 'Back', liftCode: 'ROW01', weight: 155, reps: 8, rir: 1 },
    { date: '2026-06-05', session: 'A3', muscle: 'Back', liftCode: 'ROW01', weight: 155, reps: 8, rir: 1 },
  ]);
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  const deload = result.intents.find(i => i.id === 'deload_reset');
  assert.ok(deload, 'Deload & Reset must appear when multiple rested lifts stall');
  assert.ok(deload.exercises.length >= 2, 'deload must list the stalled lifts');
  assert.ok(deload.why_today.some(w => /hold.*lb.*cut|cut.*sets/i.test(w)), 'deload must describe the hold+volume prescription');
  // Volume-first: hold the working weight, cut sets to 2 — no weight reduction.
  const bench = deload.exercises.find(ex => ex.lift_code === 'BENCH01');
  assert.ok(bench && bench.target_weight === 185, 'deload must hold the stalled working weight');
  assert.equal(bench.target_sets, 2, 'mains get 2 sets on deload day');
});

test('scoreIntents: a stalled lift trained yesterday is held out of the deload, with an honest reason', () => {
  const rows = makeIntentLogRows([
    // Bench stalled, but chest was trained HARD yesterday → push is not rested.
    { date: '2026-06-03', session: 'A1', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-07', session: 'A2', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-11', session: 'A3', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    // Leg press stalled and legs are rested (last trained 6 days ago).
    { date: '2026-05-30', session: 'B1', muscle: 'Legs', liftCode: 'LEGP01', weight: 300, reps: 8, rir: 2 },
    { date: '2026-06-02', session: 'B2', muscle: 'Legs', liftCode: 'LEGP01', weight: 300, reps: 8, rir: 2 },
    { date: '2026-06-06', session: 'B3', muscle: 'Legs', liftCode: 'LEGP01', weight: 300, reps: 8, rir: 2 },
  ]);
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  const deload = result.intents.find(i => i.id === 'deload_reset');
  assert.ok(deload, 'deload should still appear because a rested stalled lift exists');
  const codes = deload.exercises.map(ex => ex.lift_code);
  assert.ok(codes.includes('LEGP01'), 'the rested stalled lift is recommended today');
  assert.ok(!codes.includes('BENCH01'), 'the recently-trained stalled lift must NOT be recommended today');
  assert.ok(deload.why_today.some(w => /not today/.test(w) && /trained recently/.test(w)),
    'must honestly say the held lift is due soon but not today');
});

test('scoreIntents: no deload when every stalled lift was trained recently', () => {
  const rows = makeIntentLogRows([
    { date: '2026-06-03', session: 'A1', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-07', session: 'A2', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-11', session: 'A3', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-03', session: 'A1', muscle: 'Back', liftCode: 'ROW01', weight: 155, reps: 8, rir: 1 },
    { date: '2026-06-07', session: 'A2', muscle: 'Back', liftCode: 'ROW01', weight: 155, reps: 8, rir: 1 },
    { date: '2026-06-11', session: 'A3', muscle: 'Back', liftCode: 'ROW01', weight: 155, reps: 8, rir: 1 },
  ]);
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  assert.equal(result.intents.find(i => i.id === 'deload_reset'), undefined,
    'deload must not be offered when no stalled muscle group is rested');
});

test('scoreIntents: no Deload intent when fewer than two lifts are stalled', () => {
  const rows = makeIntentLogRows([
    { date: '2026-06-02', session: 'A1', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-06', session: 'A2', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-10', session: 'A3', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
  ]);
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  assert.equal(result.intents.find(i => i.id === 'deload_reset'), undefined, 'one stall must not trigger a deload');
});

test('scoreIntents: a stalled lift is kept out of Test Progress while a progressing lift stays in', () => {
  const rows = makeIntentLogRows([
    // True plateau: flat weight AND flat reps → e1RM never moves → a real stall.
    // (Flat weight with RISING reps is progress, not a stall — see the ME-7
    // golden fixtures in analytics-edge.test.js.)
    { date: '2026-06-02', session: 'A1', muscle: 'Chest', liftCode: 'STALL01', weight: 185, reps: 5, rir: 2 },
    { date: '2026-06-05', session: 'A2', muscle: 'Chest', liftCode: 'STALL01', weight: 185, reps: 5, rir: 2 },
    { date: '2026-06-09', session: 'A3', muscle: 'Chest', liftCode: 'STALL01', weight: 185, reps: 5, rir: 2 },
    // Rising weight → genuinely progressing, not stalled.
    { date: '2026-06-02', session: 'A1', muscle: 'Chest', liftCode: 'RISE01', weight: 100, reps: 5, rir: 2 },
    { date: '2026-06-05', session: 'A2', muscle: 'Chest', liftCode: 'RISE01', weight: 110, reps: 5, rir: 2 },
    { date: '2026-06-09', session: 'A3', muscle: 'Chest', liftCode: 'RISE01', weight: 120, reps: 5, rir: 2 },
  ]);
  // Sanity: STALL01 must be both stalled and upward-trending for this to prove the filter.
  assert.ok(detectStalls(rows, 3).some(s => s.liftCode === 'STALL01'), 'STALL01 must register as stalled');
  const result = scoreIntents(rows, [], { today: '2026-06-12' });
  const tp = result.intents.find(i => i.id === 'test_progress');
  const codes = tp.exercises.map(ex => ex.lift_code);
  assert.ok(!codes.includes('STALL01'), 'stalled lift must not be a PR candidate');
  assert.ok(codes.includes('RISE01'), 'progressing lift must remain a PR candidate');
});

test('scoreIntents: Build Strength flags a stalled push/pull lift only when its muscle is rested', () => {
  // Rested case (last trained 7 days ago) → push is fresh, so the stall is flagged.
  const rested = makeIntentLogRows([
    { date: '2026-05-28', session: 'A1', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-01', session: 'A2', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-05', session: 'A3', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
  ]);
  const restedBs = scoreIntents(rested, [], { today: '2026-06-12' }).intents.find(i => i.id === 'build_strength');
  assert.ok(restedBs.why_today.some(w => /hasn't improved in \d+ sessions/.test(w)), 'rested stalled lift must be called out');

  // Recently-trained case (yesterday) → push not rested, so no stall call-out here.
  const recent = makeIntentLogRows([
    { date: '2026-06-03', session: 'A1', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-07', session: 'A2', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
    { date: '2026-06-11', session: 'A3', muscle: 'Chest', liftCode: 'BENCH01', weight: 185, reps: 5, rir: 1 },
  ]);
  const recentBs = scoreIntents(recent, [], { today: '2026-06-12' }).intents.find(i => i.id === 'build_strength');
  assert.ok(!recentBs.why_today.some(w => /hasn't improved in \d+ sessions/.test(w)), 'recently-trained stall must not be flagged for today');
});

test('scoreIntents: intent-recommendation route is GET and read-only', () => {
  const { routeDefinitions } = require('../config/routes');
  const route = routeDefinitions.find(r => r.path === '/api/plan/intent-recommendation');
  assert.ok(route, 'route must be registered');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.readOnly, true);
  assert.equal(route.writeCapable, false);
});

// ── Intent Dashboard Frontend ──────────────────────────────────────────────────

test('intent dashboard: loadDashboard calls intent-recommendation and renders results', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const dashFn = appSource.slice(
    appSource.indexOf('async function loadDashboard('),
    appSource.indexOf('async function loadDashboard(') + 1400
  );
  assert.match(dashFn, /\/api\/plan\/intent-recommendation/, 'must call intent-recommendation endpoint');
  assert.match(dashFn, /renderTodaysRead/, 'must call renderTodaysRead');
  assert.match(dashFn, /renderIntentGrid/, 'must call renderIntentGrid');
  assert.match(dashFn, /renderTodaysPick/, 'must call renderTodaysPick (hero card)');
});

test('intent dashboard: readiness strip and intent-grid containers exist in index.html', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="todays-read"/, 'todays-read container must exist in HTML');
  assert.match(html, /id="intent-grid"/, 'intent-grid container must exist in HTML');
});

test('intent dashboard: Todays Read and Intent Grid cards exist in index.html', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="todays-read"/, 'todays-read container must exist in HTML');
  assert.match(html, /id="todays-pick"/, 'todays-pick hero card must exist in HTML');
  assert.match(html, /id="intent-grid"/, 'intent-grid container must exist in HTML');
  assert.match(html, /id="start-session-btn"/, 'START SESSION button must exist in HTML');
});

test('intent dashboard: Intent Drawer overlay exists in index.html', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="intent-drawer"/, 'intent-drawer must exist');
  assert.match(html, /id="intent-drawer-backdrop"/, 'backdrop must exist');
  assert.match(html, /id="intent-drawer-close"/, 'close button must exist');
  assert.match(html, /id="intent-drawer-content"/, 'drawer content container must exist');
  assert.match(html, /intent-drawer-panel/, 'drawer panel must exist');
});

test('intent dashboard: renderTodaysRead and renderIntentGrid render correct containers', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /function renderTodaysRead\(/, 'renderTodaysRead must exist');
  assert.match(appSource, /function renderIntentGrid\(/, 'renderIntentGrid must exist');

  const readFn = appSource.slice(
    appSource.indexOf('function renderTodaysRead('),
    appSource.indexOf('function renderTodaysRead(') + 1400
  );
  assert.match(readFn, /pattern-dots/, 'renderTodaysRead must render pattern-dots container');
  assert.match(readFn, /pattern-dot-/, 'must apply per-status CSS class to dots');

  const gridFn = appSource.slice(
    appSource.indexOf('function renderIntentGrid('),
    appSource.indexOf('function renderIntentGrid(') + 900
  );
  assert.match(gridFn, /intent-grid/, 'renderIntentGrid must render intent-grid container');
  assert.match(gridFn, /intent-tile/, 'must render intent-tile elements');
  assert.match(gridFn, /intent-tile-recommended/, 'must mark recommended tile');
  assert.match(gridFn, /openIntentDrawer/, 'tile click must call openIntentDrawer');
});

test('read surfacing: Today\'s Read shows a recovery bar and a recovery/effort tooltip', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /function readinessTitle\(/, 'tooltip helper must exist');
  const titleFn = appSource.slice(appSource.indexOf('function readinessTitle('), appSource.indexOf('function readinessTitle(') + 400);
  assert.match(titleFn, /recovered/, 'tooltip must report % recovered');
  assert.match(titleFn, /effortIntensity/, 'tooltip must report last effort intensity');

  const readFn = appSource.slice(appSource.indexOf('function renderTodaysRead('), appSource.indexOf('function renderTodaysRead(') + 1600);
  assert.match(readFn, /pattern-recovery/, 'must render the recovery bar');
  assert.match(readFn, /p\.recovery/, 'bar width must be driven by the recovery fraction');
  assert.match(readFn, /readinessTitle/, 'dots must use the enriched tooltip');
});

test('read surfacing: coach strip tooltip includes recovery percentage', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const stripFn = appSource.slice(appSource.indexOf('function renderCoachReadStrip('), appSource.indexOf('function renderCoachReadStrip(') + 800);
  assert.match(stripFn, /recovered/, 'strip tooltip must mention recovery when present');
  assert.match(stripFn, /p\.recovery/, 'strip must read the recovery field');
});

test('read surfacing: recovery bar styled in CSS', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.pattern-recovery\b/, 'recovery track must be styled');
  assert.match(css, /\.pattern-recovery-fill/, 'recovery fill must be styled');
});

test('intent dashboard: openIntentDrawer and closeIntentDrawer exist and are wired', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /function openIntentDrawer\(/, 'openIntentDrawer must exist');
  assert.match(appSource, /function closeIntentDrawer\(/, 'closeIntentDrawer must exist');
  assert.match(appSource, /intent-drawer-backdrop.*closeIntentDrawer|closeIntentDrawer.*intent-drawer-backdrop/, 'backdrop click must close drawer');
  assert.match(appSource, /intent-drawer-close.*closeIntentDrawer|closeIntentDrawer.*intent-drawer-close/, 'close button must close drawer');

  const openFn = appSource.slice(
    appSource.indexOf('function openIntentDrawer('),
    appSource.indexOf('function openIntentDrawer(') + 3600
  );
  assert.match(openFn, /drawer-title/, 'must render drawer title');
  assert.match(openFn, /drawer-section-title/, 'must render section titles');
  assert.match(openFn, /intent-start-btn/, 'must include START SESSION button');
  assert.match(openFn, /startLift/, 'START SESSION must call startLift');
  assert.match(openFn, /closeIntentDrawer/, 'START SESSION must close drawer first');
});

test('intent dashboard: CSS has all required intent and drawer classes', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.intent-grid/, 'must have .intent-grid class');
  assert.match(css, /\.intent-tile/, 'must have .intent-tile class');
  assert.match(css, /\.intent-tile-recommended/, 'must have .intent-tile-recommended class');
  assert.match(css, /\.intent-drawer/, 'must have .intent-drawer class');
  assert.match(css, /position.*fixed|fixed.*position/, 'intent-drawer must be fixed position');
  assert.match(css, /\.intent-drawer\[hidden\]/, 'must override hidden attribute on drawer');
  assert.match(css, /\.pattern-dot/, 'must have .pattern-dot class');
  assert.match(css, /\.pattern-dot-fatigued/, 'must have fatigued dot style');
  assert.match(css, /\.pattern-dot-ready/, 'must have ready dot style');
  assert.match(css, /\.intent-start-btn/, 'must have intent-start-btn class');
});

// ---------------------------------------------------------------------------
// Bodyweight exercise logging — frontend null-weight handling
// ---------------------------------------------------------------------------

test('bodyweight: parser returns null weight for knee raises slash-pair format', () => {
  const result = parseWorkoutText('Knee raises 20/2 20/2 13/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Hanging Knee Raises');
  assert.equal(result.sets.length, 3);
  assert.ok(result.sets.every(s => s.weight === null), 'all sets must have weight: null');
  assert.deepEqual(result.sets.map(s => s.reps), [20, 20, 13]);
  assert.deepEqual(result.sets.map(s => s.rir), [2, 2, 2]);
});

test('bodyweight: parser returns null weight for Kr repeat format', () => {
  const result = parseWorkoutText('Kr 15 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Hanging Knee Raises');
  assert.ok(result.sets.every(s => s.weight === null), 'bodyweight reps must have weight: null');
});

test('bodyweight: weighted dips still carry the plate weight', () => {
  const result = parseWorkoutText('Wd 45 10/1 8/2 8/2');
  assert.equal(result.canonical_name, 'Dips (Weighted)');
  assert.ok(result.sets.every(s => s.weight === 45), 'weighted dips must retain weight');
});

test('bodyweight: rowsFromBackendParsedWorkout converts null weight to "0"', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fnStart = appSource.indexOf('function rowsFromBackendParsedWorkout(');
  assert.ok(fnStart >= 0, 'rowsFromBackendParsedWorkout must exist');
  const fnBody = appSource.slice(fnStart, fnStart + 2100);
  // Must map null weight to '0', not to '' which fails backend validation
  assert.match(fnBody, /weight.*null.*'0'|'0'.*null.*weight/,
    "null weight must convert to '0' (not '') so backend validation passes for bodyweight exercises");
  assert.doesNotMatch(fnBody, /weight.*null.*''|''.*null.*weight/,
    "null weight must NOT convert to empty string — that fails backend validation");
});

// ---------------------------------------------------------------------------
// UI shell redesign — two-surface Coach | Progress (PR: ui-design-tokens-v1)
// ---------------------------------------------------------------------------

test('shell: header has Coach and Progress segmented control', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /class="segmented"/, 'must have a segmented control');
  assert.match(html, /data-surface="coach"[^>]*>Coach</, 'must have a Coach surface button');
  assert.match(html, /data-surface="progress"[^>]*>Progress</, 'must have a Progress surface button');
});

test('shell: loads nav.js after app.js so the trust loop wiring binds first', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const appIdx = html.indexOf('src="app.js"');
  const navIdx = html.indexOf('src="nav.js"');
  assert.ok(appIdx >= 0, 'app.js must still be loaded');
  assert.ok(navIdx > appIdx, 'nav.js must load after app.js');
});

test('shell: Coach surface keeps the workout composer and approval gate intact', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  // Composer wraps the existing workout textarea + the "+" attachment affordance
  assert.match(html, /class="composer"/, 'must have a composer container');
  assert.match(html, /id="composer-attach"/, 'composer must have the + attachment button');
  const composerIdx = html.indexOf('class="composer"');
  const composerBlock = html.slice(composerIdx, composerIdx + 600);
  assert.match(composerBlock, /id="workout-text"/, 'composer must contain the workout textarea');
  // Trust loop must survive the reskin
  assert.match(html, /id="preview-btn"/, 'preview button must remain');
  assert.match(html, /id="approve-btn"[^>]*disabled/, 'approve button must remain disabled until preview');
  assert.match(html, /test_mode=true/, 'two-step write-flow safety note must remain');
});

test('shell: all original tab sections survive the redesign', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  for (const id of ['tab-logger', 'tab-dashboard', 'tab-progress', 'tab-history', 'tab-body', 'tab-settings']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} section must still exist`);
  }
  // The .tab-btn engine app.js depends on must still have every data-tab control
  for (const tab of ['dashboard', 'progress', 'logger', 'history', 'body', 'settings']) {
    assert.match(html, new RegExp(`data-tab="${tab}"`), `data-tab="${tab}" control must exist for app.js tab engine`);
  }
});

test('shell: nav.js routes surfaces without touching the trust loop', () => {
  const nav = fs.readFileSync(path.join(repoRoot, 'public', 'nav.js'), 'utf8');
  assert.match(nav, /MutationObserver/, 'must observe tab changes to stay in sync with app.js');
  assert.match(nav, /\.tab-btn/, 'must navigate through the existing .tab-btn engine');
  // nav.js is presentation-only: it must never perform or confirm writes
  assert.doesNotMatch(nav, /appendRows|sheet_write|confirm_delete|\/api\/log-workout/, 'nav.js must not touch write endpoints');
});

test('shell: nav.js rotates the composer placeholder, paused for focus/typing and reduced motion', () => {
  const nav = fs.readFileSync(path.join(repoRoot, 'public', 'nav.js'), 'utf8');
  assert.match(nav, /PLACEHOLDER_HINTS/, 'must define the rotating hint list');
  assert.match(nav, /225 5\/2/, 'hints teach the slash notation');
  assert.match(nav, /what should I train today/i, 'hints surface that you can just ask');
  assert.match(nav, /prefers-reduced-motion/, 'must honour reduced motion (no rotation)');
  assert.match(nav, /hintPaused/, 'must pause rotation while the composer is focused');
  // composerTextarea.value is checked (possibly alongside sessionActive) to skip rotation while the box has text.
  assert.match(nav, /composerTextarea\.value/, 'must skip rotating while the box has text');
  // Presentation only — it sets the placeholder, never the composer value.
  const start = nav.indexOf('PLACEHOLDER_HINTS');
  const block = nav.slice(start, start + 1000);
  assert.match(block, /\.placeholder =/, 'must rotate via the placeholder attribute');
  assert.doesNotMatch(block, /composerTextarea\.value\s*=[^=]/, 'must never write the composer value');
});

test('shell: nav.js stops rotating placeholder once a session is active (atlas:set-logged)', () => {
  const nav = fs.readFileSync(path.join(repoRoot, 'public', 'nav.js'), 'utf8');
  // Must listen for the atlas:set-logged event to detect session start.
  assert.match(nav, /atlas:set-logged/, 'must listen for the atlas:set-logged event');
  // Must have a sessionActive flag that blocks rotation.
  assert.match(nav, /sessionActive/, 'must track whether a session is underway');
  // The rotation guard must include the sessionActive check.
  assert.match(nav, /sessionActive\)/, 'rotation interval must bail out when sessionActive is true');
  // Pre-session rotation is unaffected: sessionActive starts as false.
  assert.match(nav, /sessionActive\s*=\s*false/, 'sessionActive must start false so pre-session rotation runs normally');
});

test('Step 382 (#402B): a displayed suggested workout stops the save-ready placeholder rotation', () => {
  const nav = fs.readFileSync(path.join(repoRoot, 'public', 'nav.js'), 'utf8');
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');

  // The save-ready hint that must NOT pressure a screen where nothing was performed.
  assert.match(nav, /Say .* to save your session/i, 'the save-ready hint exists in the rotation (this is what must be suppressed)');

  // coach-conversation owns the composer placeholder through setWorkoutPlaceholder, and
  // signals that ownership so the generic rotation yields.
  const setPh = cc.slice(cc.indexOf('function setWorkoutPlaceholder'), cc.indexOf('function setWorkoutPlaceholder') + 900);
  assert.match(setPh, /atlas:placeholder-owned/, 'setWorkoutPlaceholder must announce that coach-conversation owns the placeholder');
  assert.match(setPh, /dispatchEvent/, 'must dispatch the ownership event, not just set the attribute');

  // A suggested workout routes through setWorkoutPlaceholder, so viewing a suggestion
  // fires the ownership event before the next 4.5s rotation tick.
  const suggestFn = cc.slice(cc.indexOf('async function typeSuggestedWorkout'), cc.indexOf('async function typeSuggestedWorkout') + 2400);
  assert.match(suggestFn, /setWorkoutPlaceholder\(/, 'typeSuggestedWorkout must set a contextual placeholder (which announces ownership)');

  // nav.js suppresses the rotation on the ownership event (same flag as a logged set).
  assert.match(nav, /atlas:placeholder-owned/, 'nav.js must listen for the placeholder-owned event');
  const ownedListener = nav.slice(nav.indexOf("'atlas:placeholder-owned'"), nav.indexOf("'atlas:placeholder-owned'") + 80);
  assert.match(ownedListener, /sessionActive\s*=\s*true/, 'the placeholder-owned listener must stop the rotation');
});

// ── Step 385: frontend deload lifecycle wiring ─────────────────────────────────

test('Step 385: startPlannedSession fires deload/begin only on deload_reset intent', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  // Find startPlannedSession body — look far enough to capture the deload/begin block.
  const fnStart = app.indexOf('function startPlannedSession(');
  assert.ok(fnStart !== -1, 'startPlannedSession must exist');
  const fnBody = app.slice(fnStart, fnStart + 1800);

  // begin fires only when the intent is deload_reset.
  assert.match(fnBody, /intent\.id\s*===\s*['"]deload_reset['"]/, 'begin must be guarded by intent.id === deload_reset');
  assert.match(fnBody, /\/api\/deload\/begin/, 'startPlannedSession must call /api/deload/begin for deload sessions');
  // Fire-and-forget — a lifecycle failure must never block the session UI.
  assert.match(fnBody, /\.catch\(/, 'begin call must swallow errors (fire-and-forget)');
});

test('Step 385: approve handler marks deload session written; advance fires once per session in endPlannedSession', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

  // ── Approve handler: sets the flag, does NOT call advance directly ──────────
  const approveStart = app.indexOf("document.getElementById('approve-btn').addEventListener('click'");
  assert.ok(approveStart !== -1, 'approve-btn click handler must exist');
  const handlerBody = app.slice(approveStart, approveStart + 6000);

  // advance must NOT appear anywhere in the approve handler — it belongs in endPlannedSession.
  assert.doesNotMatch(handlerBody, /\/api\/deload\/advance/, 'advance must NOT be called inside the approve handler (it fires once per session in endPlannedSession)');

  // The approve handler sets deloadWritten on the session object after a confirmed live write.
  assert.match(handlerBody, /deloadWritten\s*=\s*true/, 'approve handler must set deloadWritten flag after confirmed write');
  // The flag is gated on deload_reset intent and not a duplicate-blocked replay.
  assert.match(handlerBody, /intentId\s*===\s*['"]deload_reset['"]/, 'deloadWritten flag must be guarded by intentId === deload_reset');
  assert.match(handlerBody, /!duplicateBlocked/, 'deloadWritten flag must not set for duplicate-blocked replays');

  // ── endPlannedSession: advance fires here, exactly once per session ─────────
  const endFnStart = app.indexOf('function endPlannedSession(');
  assert.ok(endFnStart !== -1, 'endPlannedSession must exist');
  const endFnBody = app.slice(endFnStart, endFnStart + 700);

  assert.match(endFnBody, /\/api\/deload\/advance/, 'advance must be called in endPlannedSession');
  assert.match(endFnBody, /deloadWritten/, 'endPlannedSession must check deloadWritten before advancing');
  // Auto-resolve when sessions are exhausted.
  assert.match(endFnBody, /POST_DELOAD_EVALUATION/, 'endPlannedSession must auto-resolve when advance returns POST_DELOAD_EVALUATION');
  assert.match(endFnBody, /\/api\/deload\/resolve/, 'endPlannedSession must call resolve after the final deload session');
});

test('shell: styles define dark mode and the new component tokens', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  // Dark is the single primary theme now (graphite/ember in :root), so the dark
  // look is asserted via the base ground token rather than a media query.
  assert.match(css, /--bg:\s*#0A0B0E/i, 'dark graphite ground must be the base theme');
  assert.match(css, /@font-face[\s\S]*?Space Grotesk/, 'must self-host the display font (no Google Fonts link)');
  assert.match(css, /--accent:/, 'must define the accent design token');
  assert.match(css, /\.segmented/, 'must style the segmented control');
  assert.match(css, /\.surface-btn/, 'must style surface buttons');
  assert.match(css, /\.composer/, 'must style the chat composer');
  assert.match(css, /\.composer-attach/, 'must style the + attachment button');
  assert.match(css, /\.chip/, 'must style suggestion chips');
  // Coach surface hides the Progress sub-nav
  assert.match(css, /\[data-surface="coach"\]\s*#subnav/, 'subnav must be hidden on the Coach surface');
});

// ── Coach chat thread (UI PR 3) ────────────────────────────────────────────────

test('chat: coach thread holds messages, preview card and status in order', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="coach-thread"/, 'coach thread container must exist');
  const threadIdx = html.indexOf('id="coach-thread"');
  const formIdx = html.indexOf('id="logger-form"');
  assert.ok(threadIdx > -1 && threadIdx < formIdx, 'thread must render above the composer form');
  const threadBlock = html.slice(threadIdx, formIdx);
  const msgIdx = threadBlock.indexOf('id="thread-messages"');
  const previewIdx = threadBlock.indexOf('id="preview-panel"');
  const statusIdx = threadBlock.indexOf('id="logger-status"');
  assert.ok(msgIdx > -1, 'thread-messages must be inside the thread');
  assert.ok(previewIdx > msgIdx, 'preview panel must follow user messages');
  assert.ok(statusIdx > previewIdx, 'status replies must follow the preview card');
});

test('chat: composer owns the preview submit button as send', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const composerIdx = html.indexOf('class="composer"');
  const composerBlock = html.slice(composerIdx, composerIdx + 1200);
  assert.match(composerBlock, /id="preview-btn"[^>]*class="composer-send"/, 'preview button must be the composer send button');
  // Send still previews — the accessible name keeps the no-write promise
  assert.match(composerBlock, /Preview — no data saved/, 'send button keeps the preview wording');
});

test('chat: form keeps date, effort and notes reachable', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('id="logger-details"') > -1, 'logger-details container must exist');
  // Session fields live in hidden div (auto-populated); effort fields accessible via + menu
  for (const id of ['log-date', 'log-session-id', 'log-location', 'effort-details', 'effort-image', 'log-notes']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must exist in the form`);
  }
});

test('chat: chat.js is a visual layer that never touches write endpoints', () => {
  const chat = fs.readFileSync(path.join(repoRoot, 'public', 'chat.js'), 'utf8');
  assert.match(chat, /addEventListener\('submit'/, 'must narrate form submission as a user bubble');
  assert.match(chat, /chat-bubble-user/, 'must append user bubbles');
  assert.match(chat, /MutationObserver/, 'must observe app.js-owned panels rather than drive them');
  assert.doesNotMatch(chat, /appendRows|sheet_write|confirm_delete|\/api\//, 'chat.js must never call the API or write paths');
});

test('chat: chat.js loads last so app.js owns the trust loop wiring', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const appIdx = html.indexOf('src="app.js"');
  const navIdx = html.indexOf('src="nav.js"');
  const chatIdx = html.indexOf('src="chat.js"');
  assert.ok(appIdx > -1 && navIdx > appIdx && chatIdx > navIdx, 'script order must be app.js, nav.js, chat.js');
});

test('chat: styles define the thread bubbles and in-thread preview card', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.coach-thread/, 'must style the thread container');
  assert.match(css, /\.chat-bubble-user/, 'must style user bubbles');
  assert.match(css, /\.coach-thread #preview-panel/, 'preview panel must restyle as an in-thread card');
  assert.match(css, /\.composer-send/, 'must style the composer send button');
});

// ── Screenshot chat-first upload (Phase 1) ─────────────────────────────────────

test('screenshot: picking a file auto-fires the preview (no separate Preview tap)', () => {
  const nav = fs.readFileSync(path.join(repoRoot, 'public', 'nav.js'), 'utf8');
  // A change listener on the file input dispatches the form submit automatically.
  assert.match(nav, /effortImage\?\.addEventListener\('change'/, 'must listen for file selection');
  assert.match(nav, /effort-mode"\]:checked'\)\?\.value === 'screenshot'/, 'must only auto-submit in screenshot mode');
  assert.match(nav, /logger-form'\)\?\.dispatchEvent\(new Event\('submit'/, 'must dispatch the form submit');
});

test('closeout screenshot: attachment menu does not auto-open the effort details panel', () => {
  const nav = fs.readFileSync(path.join(repoRoot, 'public', 'nav.js'), 'utf8');
  const screenshotHandler = nav.slice(
    nav.indexOf("attach-screenshot')?.addEventListener"),
    nav.indexOf("attach-manual')?.addEventListener")
  );
  assert.match(nav, /function setEffortMode\(mode, \{ reveal = true \} = \{\}\)/, 'setEffortMode must support a no-reveal screenshot path');
  assert.match(screenshotHandler, /setEffortMode\('screenshot', \{ reveal: false \}\)/, 'screenshot selection must not reveal Effort optional details');
  assert.doesNotMatch(screenshotHandler, /scrollIntoView|details\.open\s*=\s*true/, 'screenshot selection must not auto-open or scroll the Effort panel');
});

test('closeout screenshot: plan-complete attachment parses effort without workout ingestion', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const submitStart = app.indexOf("document.getElementById('logger-form').addEventListener('submit'");
  const parseAt = app.indexOf('await rowsFromWorkoutInput()', submitStart);
  const guardAt = app.indexOf('if (file && !pendingChatText && !sessionCompiledAwaitingPreview && isPlanCloseoutAwaitingSave())', submitStart);
  const guard = app.slice(guardAt, app.indexOf('let logRows = []', guardAt));
  assert.ok(guardAt > submitStart && guardAt < parseAt, 'closeout screenshot guard must run before workout parsing');
  assert.match(guard, /closeoutScreenshotFile = file/, 'must remember the attachment locally');
  assert.match(guard, /parseWorkoutImage\(file\)/, 'must try parse-only effort extraction');
  assert.match(guard, /Effort read from screenshot\. Say done to preview your workout with effort data\./, 'successful parse must say effort data will be included');
  assert.match(guard, /Screenshot attached, but effort couldn't be read\. Say done to save the workout without effort data\./, 'failed parse must be explicit and non-blocking');
  assert.match(guard, /return;/, 'must not fall through into /api/complete-workout preview');
  assert.doesNotMatch(guard, /submitCompleteWorkout|complete-workout/, 'closeout attachment must not call workout ingestion');
});

test('closeout screenshot: done save uses normal log-workout preview and includes parsed effort when available', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /const closeoutAttachmentOnly = file && closeoutScreenshotFile === file && sessionCompiledAwaitingPreview;/, 'done path must identify a closeout-only screenshot');
  assert.match(app, /if \(closeoutAttachmentOnly\) file = null;/, 'done path must not send the buffered screenshot to complete-workout');
  assert.match(app, /if \(closeoutAttachmentOnly && closeoutScreenshotEffort\) \{[\s\S]*manualEffort = effortRowFromParsedEffort\(closeoutScreenshotEffort, sessionId, date, location, notes\);[\s\S]*\}/, 'parsed closeout effort must become the normal effort_row payload');
  const previewStart = app.indexOf("const previewBtn = document.getElementById('preview-btn')");
  const previewBranch = app.slice(previewStart, app.indexOf("} else if (effortOnly)", previewStart));
  assert.match(previewBranch, /if \(mode === 'screenshot' && file\)/, 'screenshot ingestion must require an actual non-buffered file');
  const manualBranch = app.slice(app.indexOf('const effortRow = manualEffort;', previewStart), app.indexOf('renderLogWorkoutPreview(result, effortRow);', previewStart) + 60);
  assert.match(manualBranch, /\/api\/log-workout/, 'normal done preview must still use the log-workout dry-run');
});

test('chips: nav.js chip handlers are read-only and never touch write paths', () => {
  const nav = fs.readFileSync(path.join(repoRoot, 'public', 'nav.js'), 'utf8');
  // nav.js may call read-only API endpoints for chip answer cards, but must never
  // reach write endpoints or perform sheet mutations.
  assert.doesNotMatch(nav, /appendRows|sheet_write|confirm_delete|\/api\/log-workout|\/api\/complete-workout|\/api\/bodyweight(?!\/history)/, 'nav.js must not touch write paths');
  // chip handlers must use api() (delegated to app.js) not a raw fetch
  assert.doesNotMatch(nav, /\bfetch\(/, 'nav.js must not call fetch() directly — use api()');
  // train/last/report chips must render in-thread
  assert.match(nav, /chipAnswerTrain/, 'must have chipAnswerTrain handler');
  assert.match(nav, /chipAnswerLast/, 'must have chipAnswerLast handler');
  assert.match(nav, /chipAnswerReport/, 'must have chipAnswerReport handler');
  assert.match(nav, /chat-bubble-atlas/, 'must render atlas reply bubbles');
});

test('screenshot: chat.js drops the attachment bubble on file change, not on submit', () => {
  const chat = fs.readFileSync(path.join(repoRoot, 'public', 'chat.js'), 'utf8');
  assert.match(chat, /effortImage\?\.addEventListener\('change'/, 'bubble must appear when the file is chosen');
  // The submit handler must no longer carry the screenshot-bubble branch.
  const submitBlock = chat.slice(chat.indexOf("addEventListener('submit'"), chat.indexOf("addEventListener('submit'") + 200);
  assert.doesNotMatch(submitBlock, /effort-mode/, 'submit handler must not re-derive the screenshot bubble');
});

test('screenshot/effort: parsed effort flows into the single review card (no separate save panel)', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const coach = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  // The legacy second save surface (effort-reply card with its own Save) is gone.
  assert.doesNotMatch(app, /function addAtlasEffortReply\(/, 'the legacy effort-reply save card must be removed');
  // The screenshot/effort preview forwards the watch metrics onto the review card.
  assert.match(app, /emitCoachPreview\(data\.rows_to_write, completeLiftCodes, effortOnly, data\.parsed_effort/, 'effort preview must forward parsed_effort to the review card');
  // The single review card renders the Apple Watch metrics grid and receives the effort.
  assert.match(coach, /function buildEffortGrid\(/, 'review card must render the Apple Watch metrics grid');
  assert.match(coach, /buildReviewCard\(rows, liftCodes, effortOnly, effort\)/, 'review card must receive the effort');
});

test('screenshot: missing peak HR renders plainly in the preview table, not blank', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /effort\.peakHR == null \? 'not visible in screenshot'/, 'null peak HR must show explanatory text');
});

test('screenshot: the dry-run + approval gate is unchanged', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const coach = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  // Preview still asserts no-write proof before allowing approval.
  assert.match(app, /hasCompleteWorkoutNoWriteProof\(result\)/, 'screenshot preview must still prove no-write');
  // The effort metrics display in the review card is read-only — no write endpoint.
  const start = coach.indexOf('function buildEffortGrid(');
  const fn = coach.slice(start, start + 800);
  assert.doesNotMatch(fn, /api\(|fetch\(|complete-workout|log-workout/, 'effort metrics display must not write');
});

test('screenshot: styles define the Atlas reply bubble', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.chat-bubble-atlas/, 'Atlas reply bubble must be styled');
  assert.match(css, /\.atlas-reply-gate/, 'the "nothing saved" gate line must be styled');
});

test('effort-preview: missing peak HR shows a warn chip with a fix link', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /effort-missing-chip/, 'must render a warning chip class when peak HR is null');
  assert.match(app, /effort\.peakHR == null/, 'chip must be conditional on null peak HR');
  assert.match(app, /prefillEffortForm/, 'chip must offer a prefill action');
});

test('effort-preview: prefillEffortForm is a pure DOM helper and never writes', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function prefillEffortForm('), app.indexOf('function prefillEffortForm(') + 1200);
  assert.doesNotMatch(fn, /api\(|fetch\(|log-workout|complete-workout|appendRows/, 'prefillEffortForm must not write');
  assert.match(fn, /effort-duration/, 'must pre-fill the duration field');
  assert.match(fn, /effort-peak-hr/, 'must pre-fill the peak HR field');
});

// ── Trust loop card states (UI PR 4) ───────────────────────────────────────────

test('trust cards: status card styles every write state row in the thread', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.coach-thread #logger-status \{/, 'status box must restyle as an in-thread card');
  assert.match(css, /\.coach-thread #logger-status \.status-msg\.ok/, 'Written state row must be styled');
  assert.match(css, /\.coach-thread #logger-status \.undo-write-btn/, 'Undo state row must be styled');
  assert.match(css, /\.coach-thread #logger-status \.parser-status/, 'Verified state row must be styled');
  assert.match(css, /\.coach-thread #logger-status \.atlas-suggestion/, 'Verdict state row must be styled');
});

test('trust cards: the trust loop wiring in app.js is untouched', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /sheet_write !== 'success'/, 'live write must still require sheet_write success proof');
  assert.match(app, /log_rows_written/, 'live write must still verify rows-written count');
  assert.match(app, /undo-last/, 'undo endpoint must still be wired');
  assert.match(app, /confirm_delete: true/, 'undo must still send explicit confirm_delete');
  assert.match(app, /Verified in Sheet/, 'readback verification message must remain');
  assert.match(app, /undo-write-btn/, 'undo button must still be appended after a write');
});

// ── Progress surface v1: Training Snapshot (UI PR 5) ───────────────────────────

test('today-screen: above-fold leads with pick hero, not snapshot grid', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const dashSection = html.slice(html.indexOf('tab-dashboard'), html.indexOf('tab-progress'));
  assert.match(dashSection, /id="todays-pick"/, 'today\'s pick hero must be in dashboard');
  assert.match(dashSection, /id="consistency-line"/, 'consistency line must be in dashboard');
  // snapshot moves to a glance-card, not above the fold
  assert.match(dashSection, /id="progress-snapshot"/, 'snapshot data container must still exist (inside glance)');
  const pickIdx = dashSection.indexOf('todays-pick');
  const snapIdx = dashSection.indexOf('progress-snapshot');
  assert.ok(pickIdx < snapIdx, 'pick hero must appear before the snapshot glance card');
});

test('snapshot: progress/summary data is fetched and rendered by loadDashboard', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /\/api\/progress\/summary/, 'must read the progress summary endpoint');
  assert.match(app, /function renderProgressSnapshot/, 'renderer must exist');
  assert.match(app, /metric-grid/, 'must render the metric grid');
  assert.match(app, /function renderConsistencyLine/, 'consistency line renderer must exist');
  assert.match(app, /function buildConsistencyText/, 'consistency text builder must exist');
});

test('snapshot: streak copy rewards consistency and explains the restart', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /-week streak/, 'active streak line must show week count');
  assert.match(app, /Streak paused/, 'paused state must be honest, not shaming');
  assert.match(app, /to restart your/, 'paused state must say how to restart');
  assert.match(app, /sessions_by_week/, 'consistency strip must use weekly buckets');
});

test('snapshot: styles define the metric grid, streak and consistency strip', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.metric-grid/, 'metric grid styles must exist');
  assert.match(css, /\.metric-tile/, 'metric tile styles must exist');
  assert.match(css, /\.streak-line/, 'streak line styles must exist');
  assert.match(css, /\.consistency-strip/, 'consistency strip styles must exist');
  assert.match(css, /\.week-bar-hit/, 'streak-hit week bar style must exist');
});

test('snapshot: renderProgressSnapshot is read-only — no write calls', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fnStart = app.indexOf('function renderProgressSnapshot(');
  const fnEnd = app.indexOf('function renderProgressSnapshot(') + 1800;
  const snapshotBlock = app.slice(fnStart, fnEnd);
  assert.ok(snapshotBlock.length > 10, 'renderProgressSnapshot block must exist');
  assert.doesNotMatch(snapshotBlock, /POST|log-workout|complete-workout|undo|confirm_delete/, 'snapshot renderer must be read-only');
});

// ── Frontend write_id idempotency wiring ───────────────────────────────────────

test('write_id: every previewed manual workout carries a fresh write_id', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /function generateWriteId/, 'generateWriteId helper must exist');
  assert.match(app, /crypto\.randomUUID/, 'must prefer crypto.randomUUID');
  assert.match(app, /test_mode: 'true', write_id: generateWriteId\(\)/, 'preview payload must include the write_id');
});

test('write_id: duplicate acceptance is strict — all three proof fields required', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const handler = app.slice(app.indexOf(anchor), app.indexOf(anchor) + 9000);
  assert.match(handler, /duplicate_write === true/, 'must require duplicate_write flag');
  assert.match(handler, /sheet_write === 'skipped_duplicate'/, 'must require the skipped_duplicate marker');
  assert.match(handler, /original_sheet_write === 'success'/, 'must require the original write to have succeeded');
});

test('write_id: fresh-write proof is not weakened by the duplicate path', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const anchor = "getElementById('approve-btn').addEventListener('click'";
  const handler = app.slice(app.indexOf(anchor), app.indexOf(anchor) + 9000);
  // The success + rows-written checks must still guard every non-duplicate write
  const guardIdx = handler.indexOf('if (!duplicateBlocked)');
  const successIdx = handler.indexOf("sheet_write !== 'success'");
  const rowsIdx = handler.indexOf('log_rows_written || 0) > 0');
  assert.ok(guardIdx !== -1, 'non-duplicate branch must exist');
  assert.ok(successIdx > guardIdx, 'sheet_write success proof must remain inside the non-duplicate branch');
  assert.ok(rowsIdx > guardIdx, 'rows-written proof must remain inside the non-duplicate branch');
});

test('write_id: blocked duplicate reports honestly instead of pretending to write', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /Duplicate tap blocked — this workout was already written/, 'duplicate status message must exist');
});

test('write_id: complete-workout sends write_id only on the live write', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('async function submitCompleteWorkout('), app.indexOf('async function submitCompleteWorkout(') + 800);
  assert.match(fn, /\bwriteId\b/, 'submitCompleteWorkout must accept writeId');
  assert.match(fn, /writeId && !testMode/, 'write_id must be withheld from dry-run previews');
  assert.match(fn, /form\.append\('write_id'/, 'live write must send write_id');
});

test('write_id: screenshot and effort previews each stamp a write_id for the live write', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.ok((app.match(/writeId: generateWriteId\(\)/g) || []).length >= 2,
    'both the screenshot and effort-only pendingWrite objects must carry a write_id');
});

test('bodyweight: preview proof and write_id gate live bodyweight writes', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /function hasBodyweightNoWriteProof/, 'bodyweight preview must validate no-write proof');
  assert.match(app, /function pendingBodyweightHasPreviewProof/, 'bodyweight approve must validate stored proof');
  assert.match(app, /function hasBodyweightWriteProof/, 'bodyweight approve must validate live write proof');
  assert.match(app, /original_sheet_write === 'success'/, 'bodyweight duplicate acceptance must require original success');
  assert.match(app, /pendingBwWrite = \{[\s\S]*write_id: generateWriteId\(\)/, 'bodyweight live write must carry a write_id');
  assert.match(app, /if \(!pendingBodyweightHasPreviewProof\(pendingBwWrite\)\)/, 'bodyweight approve must block stale or missing proof');
});

test('write_id: screenshot approve accepts a blocked duplicate from complete-workout', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const idx = app.indexOf("pendingWrite.mode === 'screenshot'");
  const branch = app.slice(idx, idx + 1000);
  assert.match(branch, /duplicate_write === true/, 'must recognise a blocked duplicate');
  assert.match(branch, /sheet_write === 'skipped_duplicate'/, 'must check the duplicate marker');
  assert.match(branch, /original_sheet_written === true/, 'acceptance requires the original to have written');
});

// ── Coach declutter + shell cache bump ─────────────────────────────────────────

test('declutter: load-session corrector lives inside the Details fold, off the main screen', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const foldBlock = html.slice(html.indexOf('id="logger-details"'), html.indexOf('id="parsed-rows-editor"'));
  assert.match(foldBlock, /id="load-session-btn"/, 'session corrector must be inside the Details fold');
  // It must not appear before the thread anymore
  const beforeThread = html.slice(html.indexOf('id="tab-logger"'), html.indexOf('id="coach-thread"'));
  assert.doesNotMatch(beforeThread, /load-session-details/, 'corrector must not clutter the greeting area');
});

test('declutter: composer form docks to the bottom of the Coach surface', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  // body[data-surface="coach"] locks the viewport so only the thread scrolls
  assert.match(css, /body\[data-surface="coach"\]\s*\{[^}]*overflow:\s*hidden/, 'coach body must block page scroll');
  assert.match(css, /body\[data-surface="coach"\]\s*\{[^}]*position:\s*fixed/, 'coach body must fill the viewport via position:fixed');
  assert.match(css, /#tab-logger\.active\s*\{[^}]*flex-direction:\s*column/, 'Coach surface must be a column');
  assert.match(css, /#tab-logger\.active\s*\{[^}]*overflow:\s*hidden/, 'Coach surface must clip so inner thread scrolls');
  assert.match(css, /#coach-thread\s*\{[^}]*overflow-y:\s*auto/, 'thread must be the scroll container');
  assert.match(css, /#logger-form\s*\{[^}]*flex:\s*0 0 auto/, 'composer must be a pinned static flex child');
});

test('declutter: safety note still proves test_mode and stays compact', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /safety-note compact/, 'safety note must use the compact style');
  assert.match(html, /test_mode=true/, 'the no-write promise must remain visible');
});

test('shell cache: service worker version bumped and all shell scripts precached', () => {
  const sw = fs.readFileSync(path.join(repoRoot, 'public', 'sw.js'), 'utf8');
  assert.match(sw, /atlas-shell-v41/, 'cache name must be bumped so stale assets are evicted');
  assert.doesNotMatch(sw, /atlas-shell-v40\b/, 'old cache name must be gone');
  // The shell build tag baked into app.js must equal the SW cache version, so the
  // "Running shell: vNN" line truthfully reflects the running bundle.
  const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const shellTag = (appSrc.match(/const ATLAS_SHELL_BUILD = '([^']+)'/) || [])[1];
  const swCacheVer = (sw.match(/atlas-shell-(v\d+)/) || [])[1];
  assert.equal(shellTag, swCacheVer, 'ATLAS_SHELL_BUILD (app.js) must match the SW cache version');
  // The shell tag is rendered into its own dedicated, always-set element.
  assert.match(appSrc, /shellEl\.textContent = ATLAS_SHELL_BUILD/, 'the running-shell line must display the shell tag');
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="shell-version"/, 'a dedicated shell-version element must exist in Settings');
  // Session-state debug dump (read-only diagnostic for a wrong next-up / stale composer).
  assert.match(html, /id="load-session-state-btn"/, 'a "Show session state" debug button must exist');
  assert.match(appSrc, /load-session-state-btn'\)\?\.addEventListener/, 'the session-state debug handler must be wired');
  assert.match(appSrc, /remainingPlannedExercises\(\),/, 'the dump must include remainingPlannedExercises');
  for (const asset of ['/app/styles.css', '/app/app.js', '/app/nav.js', '/app/drawer.js', '/app/chat.js',
    '/app/sessionQuestion.js', '/app/activeSession.js',
    '/app/fonts/space-grotesk.woff2', '/app/fonts/jetbrains-mono.woff2', '/app/fonts/inter.woff2']) {
    assert.ok(sw.includes(`'${asset}'`), `${asset} must be precached`);
  }
  // The API must still never be intercepted
  assert.match(sw, /startsWith\('\/api'\)/, 'API traffic must stay uncached');
});

// P0 wiring Sub-PR 1: the canonical ActiveSession is loaded into the browser shell
// and exposed as the single derived session view (readers switch to it in Sub-PR 2).
test('P0 wiring: public/activeSession.js is loaded in index.html and app.js exposes getCanonicalSession', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /<script src="activeSession\.js"><\/script>/, 'index.html must load activeSession.js');

  const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fn = appSrc.slice(appSrc.indexOf('function getCanonicalSession('), appSrc.indexOf('function getCanonicalSession(') + 1100);
  assert.ok(fn.length > 50, 'getCanonicalSession must exist');
  // Built from the authoritative store through the shared model — never a second copy.
  assert.match(fn, /window\.activeSession/, 'derives from the shared activeSession model');
  assert.match(fn, /createActiveSession\(/, 'builds the canonical session from the planned order');
  assert.match(fn, /plannedExerciseEntries\(\)/, 'uses the planned order as the source');
  assert.match(fn, /markCompleted\(/, 'replays logged completions onto the canonical session');
  assert.match(fn, /insertExercise\(/, 'an off-plan logged lift is represented, not dropped');
});

// ── Set-effort signals: live coach wiring (Training Intelligence PR 477) ────────

test('set-effort wiring: app.js threads the remaining planned queue into atlas:set-logged', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const block = appSource.slice(
    appSource.indexOf('function emitSetLogged('),
    appSource.indexOf('// The session lives in the buffer')
  );
  // plannedQueue = the shared remaining-after-this-log source (excludes completed
  // lifts under any alias); nextPlanned derives from the same source.
  assert.match(block, /const remaining = remainingPlannedExercises\(\);/);
  assert.match(block, /const plannedQueue = remaining;/);
  assert.match(block, /plannedQueue\.length \? \{ plannedQueue \}/);
  // Suggestion-only — emitSetLogged must not reorder or mutate the plan here.
  assert.doesNotMatch(block, /activePlannedSession\.exercises\.(sort|reverse|splice)/);
});

test('set-effort wiring: handleSetLogged renders one short effort line + folds reroute, no full-session recap', () => {
  const ccSource = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const block = ccSource.slice(
    ccSource.indexOf('async function handleSetLogged(detail)'),
    ccSource.indexOf('async function handlePreviewReady')
  );
  assert.ok(block.length > 0, 'handleSetLogged must be found');
  // The engine-backed effort line is rendered (one element), and the planned queue
  // is forwarded to the coach facts.
  assert.match(block, /planned_queue:\s*Array\.isArray\(detail\.plannedQueue\)/);
  assert.match(block, /reaction\.effort_note/);
  assert.match(block, /effort-note/);
  // The reroute suggestion is folded into the existing single handoff line.
  assert.match(block, /reaction\.reroute && reaction\.reroute\.line/);
  // Exactly one effort line — the deterministic line is rendered once, not per set.
  assert.equal((block.match(/className = 'coach-msg effort-note'/g) || []).length, 1);
  // No full-session recap: the per-set handler must not iterate the whole session
  // log / sessionLog to print a summary after each set.
  assert.doesNotMatch(block, /sessionLog\b/, 'no full-session recap may be built per set');
});

test('handoff: the /api/plan/today fallback never resurrects an already-completed lift', () => {
  const ccSource = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const block = ccSource.slice(
    ccSource.indexOf('async function handleSetLogged(detail)'),
    ccSource.indexOf('async function handlePreviewReady')
  );
  // next-up is computed BEFORE the closeout decision, so a genuine next wins.
  assert.match(block, /let nextEx = detail\.nextPlanned \|\| await getNextExerciseInPlan/);
  // A fallback next-up (only when there's no deterministic nextPlanned) that is
  // already in detail.completed is dropped — this is the "wanted weighted dips
  // again" fix.
  assert.match(block, /if \(nextEx && !detail\.nextPlanned\)/);
  assert.match(block, /detail\.completed \|\| \[\]\)\.some/);
  assert.match(block, /if \(done\) nextEx = null;/);
  // Closeout fires only when the plan is complete AND nothing is genuinely next.
  assert.match(block, /if \(!nextEx && detail\.planIsComplete\)/);
  // app.js threads the completed-lift names into the event for that rejection.
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /completed: \[\.\.\.sessionCompleted\]/);
});

// ── Glanceable dashboard ───────────────────────────────────────────────────────

test('glance: data-heavy dashboard cards collapse to one friendly line each', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const dashSection = html.slice(html.indexOf('tab-dashboard'), html.indexOf('tab-progress'));
  // coaching-hint is merged into the weekly card; weekly-summary-hint serves both
  for (const hint of ['recent-prs-hint', 'stalls-hint', 'weekly-summary-hint', 'recent-history-hint']) {
    assert.match(dashSection, new RegExp(`id="${hint}"`), `${hint} glance line must exist`);
  }
  // The full data containers survive — same information, one tap deeper
  for (const id of ['recent-prs', 'stalls', 'weekly-summary', 'recent-history', 'coaching']) {
    assert.match(dashSection, new RegExp(`id="${id}"`), `${id} detail container must remain`);
  }
  assert.match(dashSection, /glance-card/, 'cards must use the collapsible glance style');
});

test('glance: loaders fill the friendly hint lines', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /function setGlanceHint/, 'hint helper must exist');
  for (const hint of ['recent-prs-hint', 'stalls-hint', 'weekly-summary-hint', 'recent-history-hint', 'coaching-hint']) {
    assert.ok(app.includes(`setGlanceHint('${hint}'`), `${hint} must be filled by its loader`);
  }
});

test('glance: readiness dots speak plain language, not gym jargon', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(app, /FRIENDLY_PATTERN_LABELS/, 'pattern label overrides must exist');
  assert.match(app, /Hips & back/, 'Hinge must read as Hips & back');
  assert.match(app, /FRIENDLY_STATUS_WORDS/, 'status word map must exist');
  assert.match(app, /pattern-dot-status/, 'status word must render under each dot');
});

test('glance: intent drawer shows the point first and folds the analysis', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function openIntentDrawer('), app.indexOf('function closeIntentDrawer('));
  assert.match(fn, /why_today\.slice\(0, 2\)/, 'glance layer caps why-today at two lines');
  assert.match(fn, /drawer-more/, 'analysis must fold behind More detail');
  assert.match(fn, /More detail/, 'fold must be labelled plainly');
  // Nothing is lost — every section still renders inside the fold
  for (const section of ['data_points', 'what_it_protects', 'watch_for', 'pivot_logic']) {
    assert.match(fn, new RegExp(section), `${section} must still be available one tap deeper`);
  }
});

test('glance: styles define the glance card row and status words', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.glance-card > summary/, 'glance summary row style must exist');
  assert.match(css, /\.glance-hint/, 'hint line style must exist');
  assert.match(css, /\.pattern-dot-status/, 'dot status word style must exist');
  assert.match(css, /\.drawer-more/, 'drawer fold style must exist');
});

// ── Coach polish (lift names · session auto-populate · read strip) ─────────────

test('polish: plan cards show exercise name — lift code secondary span removed', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const planFn = appSource.slice(appSource.indexOf('async function loadTodaysPlan'), appSource.indexOf('async function loadTodaysPlan') + 2000);
  assert.match(planFn, /plan-card-lift-name/, 'exercise name span must be present');
  assert.doesNotMatch(planFn, /plan-card-code muted/, 'lift code secondary span must not be rendered');
});

test('polish: session fields are hidden and auto-populated — no visible form fold', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  // The hidden container must exist with all session fields inside
  const detailsIdx = html.indexOf('id="logger-details"');
  assert.ok(detailsIdx > -1, 'logger-details container must exist');
  const block = html.slice(detailsIdx, html.indexOf('id="parsed-rows-editor"'));
  for (const id of ['log-date', 'log-session-id', 'log-location', 'log-notes']) {
    assert.match(block, new RegExp(`id="${id}"`), `${id} must remain in the hidden session container`);
  }
  // The old visible summary text must be gone
  assert.doesNotMatch(html, />Details.*date, session, effort, notes</, 'visible Details summary must be removed');
});

test('polish: effort section is a direct form child accessible via + menu', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  // effort-details must appear before logger-details (i.e. NOT nested inside it)
  const effortIdx = html.indexOf('id="effort-details"');
  const sessionIdx = html.indexOf('id="logger-details"');
  assert.ok(effortIdx > -1, 'effort-details must exist');
  assert.ok(effortIdx < sessionIdx, 'effort-details must come before the hidden session container, not inside it');
});

test('polish: coach-read-strip container exists in Coach surface', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="coach-read-strip"/, 'strip container must exist in tab-logger');
  // Must appear before suggestion chips (between greeting and chips)
  const stripIdx = html.indexOf('id="coach-read-strip"');
  const chipsIdx = html.indexOf('id="suggestion-chips"');
  assert.ok(stripIdx < chipsIdx, 'strip must appear above suggestion chips');
});

test('polish: renderCoachReadStrip renders compact dots and pick text', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  assert.match(appSource, /function renderCoachReadStrip\(/, 'function must exist');
  const fn = appSource.slice(appSource.indexOf('function renderCoachReadStrip('), appSource.indexOf('function renderCoachReadStrip(') + 1100);
  assert.match(fn, /coach-read-strip/, 'must target the strip container');
  assert.match(fn, /strip-dot/, 'must render compact dots');
  assert.match(fn, /strip-rec/, 'must render pick text');
  assert.match(fn, /FRIENDLY_PATTERN_LABELS/, 'must use friendly labels for dot titles');
});

test('polish: loadDashboard calls renderCoachReadStrip', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fn = appSource.slice(appSource.indexOf('async function loadDashboard('), appSource.indexOf('async function loadDashboard(') + 1400);
  assert.match(fn, /renderCoachReadStrip/, 'loadDashboard must call renderCoachReadStrip');
});

test('polish: coach-read-strip and strip-dot styled in CSS', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.coach-read-strip/, 'strip container must be styled');
  assert.match(css, /\.strip-dot/, 'compact dot must be styled');
  assert.match(css, /\.strip-rec/, 'pick text must be styled');
});

// ── Correction language detection ─────────────────────────────────────────────

test('looksLikeCorrection: recognises common correction phrases', () => {
  const yes = [
    'Actually I was wrong, it was 225',
    'correction: should be 185 not 195',
    'change that to 3 sets not 4',
    'replace that with bench not squat',
    'I meant 225 not 235',
    'sorry I meant 3 reps',
    'wait I meant left leg',
    'no I meant squat not deadlift',
    'actually it was 185',
  ];
  yes.forEach(p => assert.ok(looksLikeCorrection(p), `should detect correction in: "${p}"`));
});

test('looksLikeCorrection: does not flag normal workout text or questions', () => {
  const no = [
    'Bench 225 5/2',
    'I did 5 sets of bench at 225',
    'Squat 315 3/1 x3',
    'What should I train today?',
    'How is my bench progressing?',
    'Lateral Raise 30 12/3 x3',
  ];
  no.forEach(p => assert.ok(!looksLikeCorrection(p), `should NOT detect correction in: "${p}"`));
});

test('looksLikeCorrection: handles edge cases gracefully', () => {
  assert.ok(!looksLikeCorrection(''),    'empty string is not a correction');
  assert.ok(!looksLikeCorrection(null),  'null is not a correction');
  assert.ok(!looksLikeCorrection(42),    'number is not a correction');
});

// ── End-of-session "log it" detection ─────────────────────────────────────────

test('looksLikeLogIt: recognises end-of-session triggers', () => {
  const yes = [
    'log it',
    'Log it',
    'LOG IT',
    'log it.',
    'log it!',
    'log that',
    'log the session',
    'log this session',
    'log this workout',
    'save the session',
    'save it',
    'ok log it',
    'alright log it',
    'compile session',
    'compile the session',
    'that\'s all',
    'thats all',
    "we're done",
    'were done',
    'done',
    'done for today',
    'finish session',
    'end session',
    'end the session',
    'we\'re done logging',
  ];
  yes.forEach(p => assert.ok(looksLikeLogIt(p), `should detect log-it in: "${p}"`));
});

test('looksLikeLogIt: does not flag workout text or coach questions', () => {
  const no = [
    'Bench 225 5/2',
    'log bench press 225',
    'log set bench 135 10',
    'What should I train today?',
    'How is my bench progressing?',
    'Squat 315 3/1 x3',
    'I want to log a new session',
    'log my morning session on friday',
    '',
  ];
  no.forEach(p => assert.ok(!looksLikeLogIt(p), `should NOT detect log-it in: "${p}"`));
});

test('looksLikeLogIt: handles edge cases gracefully', () => {
  assert.ok(!looksLikeLogIt(''),    'empty string is not log-it');
  assert.ok(!looksLikeLogIt(null),  'null is not log-it');
  assert.ok(!looksLikeLogIt(42),    'number is not log-it');
});

// ── Session ID generation ──────────────────────────────────────────────────────

test('generateSessionId produces the correct format', () => {
  const noon = new Date('2026-06-14T12:00:00');
  const morning = new Date('2026-06-14T09:00:00');
  assert.equal(generateSessionId('2026-06-14', noon), '20260614-PM-01');
  assert.equal(generateSessionId('2026-06-14', morning), '20260614-AM-01');
});

test('formatDateForSessionId strips separators', () => {
  assert.equal(formatDateForSessionId('2026-06-14'), '20260614');
  assert.equal(formatDateForSessionId('20260614'), '20260614');
});

test('formatDateForSessionId throws on bad input', () => {
  assert.throws(() => formatDateForSessionId('not-a-date'), /Invalid date/);
  assert.throws(() => formatDateForSessionId(''), /Invalid date/);
});

test('formatAmPmSuffix: morning is AM, afternoon/evening is PM', () => {
  assert.equal(formatAmPmSuffix(new Date('2026-06-14T06:00:00')), 'AM');
  assert.equal(formatAmPmSuffix(new Date('2026-06-14T11:59:00')), 'AM');
  assert.equal(formatAmPmSuffix(new Date('2026-06-14T12:00:00')), 'PM');
  assert.equal(formatAmPmSuffix(new Date('2026-06-14T21:00:00')), 'PM');
});

test('nextAvailableSessionId returns -01 when no existing sessions', () => {
  const noon = new Date('2026-06-14T14:00:00');
  const id = nextAvailableSessionId('2026-06-14', [], noon);
  assert.equal(id, '20260614-PM-01');
});

test('nextAvailableSessionId increments past occupied slots', () => {
  const noon = new Date('2026-06-14T14:00:00');
  const existing = ['20260614-PM-01', '20260614-PM-02'];
  assert.equal(nextAvailableSessionId('2026-06-14', existing, noon), '20260614-PM-03');
});

test('nextAvailableSessionId is case-insensitive against existing IDs', () => {
  const noon = new Date('2026-06-14T14:00:00');
  const existing = ['20260614-pm-01'];
  assert.equal(nextAvailableSessionId('2026-06-14', existing, noon), '20260614-PM-02');
});

test('nextAvailableSessionId handles null/undefined existing list', () => {
  const noon = new Date('2026-06-14T14:00:00');
  assert.equal(nextAvailableSessionId('2026-06-14', null, noon), '20260614-PM-01');
  assert.equal(nextAvailableSessionId('2026-06-14', undefined, noon), '20260614-PM-01');
});

test('session/compile route is registered as read-only', () => {
  const route = routeDefinitions.find(r => r.path === '/api/session/compile');
  assert.ok(route, '/api/session/compile must be in routeDefinitions');
  assert.ok(route.authRequired, 'must require auth');
  assert.ok(route.readOnly, 'must be read-only');
  assert.ok(!route.writeCapable, 'must not be write-capable');
});

// ── PR 6 — Next-exercise handoff + composer advance ───────────────────────────

// Extract the pure getNextExerciseInPlan logic as a synchronous helper for
// unit-testing. The real function is async (calls getPlanTodayByName which
// hits the API), but the index/lookup logic is pure once the map is available.
function nextExerciseFromMap(map, exerciseName) {
  if (!map || !map.size) return null;
  const key = String(exerciseName).toLowerCase();
  const keys = Array.from(map.keys());
  let idx = keys.indexOf(key);
  if (idx === -1) {
    idx = keys.findIndex(k => k.includes(key) || key.includes(k));
  }
  if (idx === -1 || idx >= keys.length - 1) return null;
  const nextRec = map.get(keys[idx + 1]);
  return (nextRec && (nextRec.exercise_name || nextRec.exercise)) || null;
}

test('PR6: getNextExerciseInPlan returns the N+1 exercise for an exact match', () => {
  const map = new Map([
    ['bench press', { exercise_name: 'Bench Press' }],
    ['lat pulldown', { exercise_name: 'Lat Pulldown' }],
    ['face pull', { exercise_name: 'Face Pull' }]
  ]);
  assert.equal(nextExerciseFromMap(map, 'Bench Press'), 'Lat Pulldown');
  assert.equal(nextExerciseFromMap(map, 'Lat Pulldown'), 'Face Pull');
});

test('PR6: getNextExerciseInPlan returns null when the exercise is last in the plan', () => {
  const map = new Map([
    ['bench press', { exercise_name: 'Bench Press' }],
    ['lat pulldown', { exercise_name: 'Lat Pulldown' }]
  ]);
  assert.equal(nextExerciseFromMap(map, 'Lat Pulldown'), null);
});

test('PR6: getNextExerciseInPlan uses fuzzy matching ("bench" ↔ "bench press")', () => {
  const map = new Map([
    ['bench press', { exercise_name: 'Bench Press' }],
    ['overhead press', { exercise_name: 'Overhead Press' }]
  ]);
  assert.equal(nextExerciseFromMap(map, 'bench'), 'Overhead Press');
});

test('PR6: getNextExerciseInPlan returns null for an empty or missing map', () => {
  assert.equal(nextExerciseFromMap(null, 'Bench Press'), null);
  assert.equal(nextExerciseFromMap(new Map(), 'Bench Press'), null);
});

test('PR6: getNextExerciseInPlan returns null when exercise is not found in the plan', () => {
  const map = new Map([
    ['bench press', { exercise_name: 'Bench Press' }],
    ['squat', { exercise_name: 'Back Squat' }]
  ]);
  assert.equal(nextExerciseFromMap(map, 'deadlift'), null);
});

test('PR6: coach-conversation.js emits the handoff div with the correct class and text format', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  // Must create the handoff element with the right class.
  assert.match(cc, /next-exercise-handoff/, 'must use .next-exercise-handoff class');
  // Handoff text must include "Moving on" and "next up".
  assert.match(cc, /Moving on.*next up/, 'handoff text must say "Moving on — next up: <Name>"');
  // Must call setWorkoutPlaceholder to advance the composer (now with the full
  // next prescription via formatNextPlaceholder, falling back to the name).
  assert.match(cc, /setWorkoutPlaceholder\(placeholder\)/, 'must advance the placeholder after the handoff');
  // Trust loop must be untouched: handoff is in the same bubble, no new write surface.
  assert.doesNotMatch(cc, /buildReviewCard.*nextEx|nextEx.*buildReviewCard/, 'handoff must not touch the review card');
});

test('PR6: coach-conversation.js getNextExerciseInPlan uses getPlanTodayByName (engine-owned ordering)', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const fn = cc.slice(cc.indexOf('async function getNextExerciseInPlan('), cc.indexOf('function formatNextPlaceholder('));
  assert.match(fn, /getPlanTodayByName/, 'must source ordering from getPlanTodayByName');
  assert.doesNotMatch(fn, /api\(|fetch\(/, 'must not make its own API call — reuses cached plan map');
});

// ── FIX 2 — next-exercise composer placeholder = full prescription ────────────

// Re-implements formatNextPlaceholder for unit coverage (the real function is a
// browser-IIFE closure). One "{reps}/{rir}" token per prescribed set, bare
// weight (no "lbs"), no "xN".
function fmtNextPlaceholder(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const name = rec.exercise_name || rec.exercise || '';
  const t = rec.next_target && typeof rec.next_target === 'object' ? rec.next_target : {};
  const weight = t.weight != null ? t.weight : rec.target_weight;
  const reps = t.reps != null ? t.reps : rec.target_reps;
  const rir = rec.target_rir;
  let sets = Number(t.sets != null ? t.sets : rec.target_sets);
  if (!Number.isFinite(sets) || sets < 1) sets = 1;
  sets = Math.min(sets, 10);
  if (!name || weight == null || reps == null) return name || null;
  if (rir == null || rir === '') return `${name} ${weight} ${reps}`;
  return `${name} ${weight} ${Array(sets).fill(`${reps}/${rir}`).join(' ')}`;
}

test('FIX2: next-exercise placeholder writes each set out — bare weight, reps/rir per set, no xN', () => {
  // Real /api/plan/today shape (next_target + target_rir).
  assert.equal(
    fmtNextPlaceholder({ exercise_name: 'Face Pull', next_target: { weight: 45, reps: 15, sets: 3 }, target_rir: 4 }),
    'Face Pull 45 15/4 15/4 15/4'
  );
  // Flat target_* shape (dashboard / e2e mock).
  assert.equal(
    fmtNextPlaceholder({ exercise_name: 'Lat Pulldown', target_weight: 170, target_reps: 8, target_sets: 3, target_rir: 2 }),
    'Lat Pulldown 170 8/2 8/2 8/2'
  );
  // Null RIR → a single round-tripping "{weight} {reps}" token (a repeated bare-
  // reps list would re-parse to one set), never an invented RIR.
  assert.equal(
    fmtNextPlaceholder({ exercise_name: 'Plank', next_target: { weight: 0, reps: 60, sets: 2 }, target_rir: null }),
    'Plank 0 60'
  );
  // Missing numbers → name only (graceful fallback).
  assert.equal(fmtNextPlaceholder({ exercise_name: 'Mystery' }), 'Mystery');
});

test('FIX2: coach-conversation.js advances the composer to the full next prescription', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  assert.match(cc, /function formatNextPlaceholder\(/, 'must define the placeholder formatter');
  assert.match(cc, /Array\(sets\)\.fill\(`\$\{reps\}\/\$\{rir\}`\)\.join\(' '\)/, 'one reps/rir token per prescribed set when RIR is present');
  assert.match(cc, /rir == null \|\| rir === ''\) return `\$\{name\} \$\{weight\} \$\{reps\}`/, 'RIR-less prescriptions emit a single round-tripping token');
  assert.match(cc, /formatNextPlaceholder\(nextRec\)/, 'the placeholder comes from the formatter');
  assert.match(cc, /Moving on — next up: \$\{nextEx\}/, 'the handoff line stays name-only');
});

// Mid-session substitution wiring (PR #340)
// The parser produces lastPrescribed for skip-notation inputs ("Deadlift skipped
// - platform busy. Romanian Deadlift 245lbs 7/2 x3"). app.js classifies the swap
// via a test_mode dry-run in the mid-session branch (before emitSetLogged) and
// passes the engine verdict in the atlas:set-logged event detail. handleSetLogged
// only words the verdict — it never calls a write path.

test('mid-session substitution: app.js classifies prescribed pairs before emitSetLogged', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  // Isolate the mid-session branch (between the early-return check and emitSetLogged).
  const branchStart = appSource.indexOf('if (logRows.length && !file && !manualEffort && !sessionCompiledAwaitingPreview)');
  const branchEnd = appSource.indexOf('emitSetLogged(logRows', branchStart) + 60;
  const branch = appSource.slice(branchStart, branchEnd);
  assert.match(branch, /lastPrescribed/, 'mid-session branch must consult lastPrescribed');
  assert.match(branch, /test_mode.*true|true.*test_mode/, 'mid-session branch must use test_mode:true for the classification call');
  assert.match(branch, /log-workout/, 'mid-session branch must call /api/log-workout to classify the swap');
});

test('mid-session substitution: emitSetLogged forwards substitutions in atlas:set-logged detail', () => {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fn = appSource.slice(
    appSource.indexOf('function emitSetLogged('),
    appSource.indexOf('function emitSetLogged(') + 1000
  );
  assert.match(fn, /substitutions/, 'emitSetLogged must forward the classified substitutions in the event detail');
});

test('mid-session substitution: handleSetLogged passes substitution into coach facts without calling a write path', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const start = cc.indexOf('async function handleSetLogged(');
  const end = cc.indexOf('  async function handlePreviewReady(');
  const fn = cc.slice(start, end > start ? end : start + 4000);
  assert.match(fn, /substitutions/, 'handleSetLogged must destructure substitutions from the event detail');
  // PR 345: substitution is folded into the main LLM facts object rather than
  // rendered as a separate sub-note card — check for the facts key, not the old helper.
  assert.match(fn, /substitution.*primarySub|substitution:\s*primarySub/, 'handleSetLogged must forward substitution into the getInWorkoutNote facts');
  assert.doesNotMatch(fn, /renderSubstitutionNotes/, 'handleSetLogged must NOT call renderSubstitutionNotes — removed in PR 345');
  assert.doesNotMatch(fn, /log-workout/, 'handleSetLogged must NOT call /api/log-workout — the coach layer is purely visual');
});

// Suggestion acknowledgment (PR 347 / coach-intelligence PR 345)
// When Atlas surfaced a substitute suggestion and the user logs that exact exercise,
// handleSetLogged suppresses the sub from the LLM facts and appends a short ack
// instead. The match requires both logged name AND prescribed name to agree with
// the stored lastSuggestion — preventing stale suggestions from misfiring on
// unrelated substitutions later in the session.

test('suggestion acknowledgment: handleSubstituteSuggested stores prescribed and recommendation from detail', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const start = cc.indexOf('async function handleSubstituteSuggested(');
  const fn = cc.slice(start, start + 600);
  assert.match(fn, /lastSuggestion\s*=/, 'handleSubstituteSuggested must assign lastSuggestion');
  assert.match(fn, /prescribed/, 'handleSubstituteSuggested must store prescribed from detail');
  assert.match(fn, /recommendation/, 'handleSubstituteSuggested must store recommendation from detail');
  assert.match(fn, /typeof recommendation.*string|typeof.*recommendation.*===.*string/, 'handleSubstituteSuggested must type-guard recommendation before storing');
});

test('suggestion acknowledgment: handleSetLogged guards lastSuggestion types before comparing', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const start = cc.indexOf('async function handleSetLogged(');
  const end = cc.indexOf('  async function handlePreviewReady(');
  const fn = cc.slice(start, end > start ? end : start + 4000);
  assert.match(fn, /typeof lastSuggestion\.recommendation.*string/, 'must guard lastSuggestion.recommendation is a string');
  assert.match(fn, /typeof lastSuggestion\.prescribed.*string/, 'must guard lastSuggestion.prescribed is a string');
  assert.match(fn, /prescribedName/, 'must extract prescribedName from the substitution object');
});

test('suggestion acknowledgment: handleSetLogged scopes match to both logged and prescribed names', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const start = cc.indexOf('async function handleSetLogged(');
  const end = cc.indexOf('  async function handlePreviewReady(');
  const fn = cc.slice(start, end > start ? end : start + 4000);
  assert.match(fn, /lastSuggestion\.recommendation/, 'suggestMatch must compare against lastSuggestion.recommendation');
  assert.match(fn, /lastSuggestion\.prescribed/, 'suggestMatch must also compare against lastSuggestion.prescribed');
  assert.match(fn, /prescribedName\.toLowerCase\(\)/, 'prescribedName comparison must be case-insensitive');
});

test('suggestion acknowledgment: handleSetLogged suppresses substitution from LLM on match and appends ack', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const start = cc.indexOf('async function handleSetLogged(');
  const end = cc.indexOf('  async function handlePreviewReady(');
  const fn = cc.slice(start, end > start ? end : start + 4000);
  assert.match(fn, /suggestMatch\s*\?\s*undefined\s*:\s*primarySub/, 'must suppress substitution from LLM facts when suggestMatch is true');
  assert.match(fn, /Good call.*you went with|you went with.*Intent preserved/, 'must append deterministic ack text on match');
  assert.match(fn, /if\s*\(\s*suggestMatch/, 'ack must be gated on suggestMatch');
});
