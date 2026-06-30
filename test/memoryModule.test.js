'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveExercise,
  listExerciseIds,
  queryTrend,
  queryPatterns,
  buildMemorySnapshot,
} = require('../services/memoryModule');

const { _resetCache } = require('../services/entityResolutionModule');

// ─── Row helpers ──────────────────────────────────────────────────────────────

// Build one 12-column Log_Cleaned row (positional array).
// COL_DATE=0, COL_SESSION=1, COL_LIFT=5, COL_WEIGHT=7, COL_REPS=8, COL_RIR=9
function makeRow({ date = '2025-01-01', session, lift, weight, reps, rir = '' } = {}) {
  const row = new Array(12).fill('');
  row[0] = date;
  row[1] = session;
  row[5] = lift;
  row[7] = String(weight);
  row[8] = String(reps);
  row[9] = rir != null ? String(rir) : '';
  return row;
}

// Build N sessions of a single lift (chronological, distinct session IDs).
function buildSessions(n, { weight = 225, reps = 5, rir = 2, lift = 'SQUAT', dateBase = 1 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const session = `s${dateBase + i}`;
    const date    = `2025-01-${String(dateBase + i).padStart(2, '0')}`;
    rows.push(makeRow({ date, session, lift, weight, reps, rir }));
  }
  return rows;
}

// Build N sessions with linearly increasing weights (to produce 'improving' trend).
function buildImprovingSessions(n, { lift = 'SQUAT', startWeight = 200, increment = 5 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(makeRow({
      date:    `2025-01-${String(i + 1).padStart(2, '0')}`,
      session: `s${i + 1}`,
      lift,
      weight:  startWeight + i * increment,
      reps:    5,
      rir:     2,
    }));
  }
  return rows;
}

// Build N sessions with linearly decreasing weights (to produce 'declining' trend).
function buildDecliningeSessions(n, { lift = 'BENCH', startWeight = 250, decrement = 5 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(makeRow({
      date:    `2025-02-${String(i + 1).padStart(2, '0')}`,
      session: `s${i + 1}`,
      lift,
      weight:  startWeight - i * decrement,
      reps:    5,
      rir:     2,
    }));
  }
  return rows;
}

// ─── resolveExercise ──────────────────────────────────────────────────────────

test('resolveExercise: returns null for empty string', () => {
  assert.equal(resolveExercise(''), null);
});

test('resolveExercise: returns null for whitespace-only string', () => {
  assert.equal(resolveExercise('   '), null);
});

test('resolveExercise: returns null for non-string input', () => {
  assert.equal(resolveExercise(null), null);
  assert.equal(resolveExercise(42), null);
  assert.equal(resolveExercise(undefined), null);
});

test('resolveExercise: resolves canonical exercise ID exactly', () => {
  const result = resolveExercise('back-squat');
  assert.ok(result, 'should resolve back-squat');
  assert.equal(result.exerciseId, 'back-squat');
  assert.equal(result.confidence, 'exact');
  assert.equal(result.method, 'exact');
});

test('resolveExercise: resolves canonical display name (case-insensitive)', () => {
  const result = resolveExercise('Back Squat');
  assert.ok(result, 'should resolve Back Squat');
  assert.equal(result.exerciseId, 'back-squat');
  assert.equal(result.confidence, 'name');
});

test('resolveExercise: resolves display name in lowercase', () => {
  const result = resolveExercise('back squat');
  assert.ok(result, 'should resolve back squat');
  assert.equal(result.exerciseId, 'back-squat');
});

test('resolveExercise: resolves alias — BB squat → back-squat', () => {
  const result = resolveExercise('BB squat');
  assert.ok(result, 'should resolve BB squat');
  assert.equal(result.exerciseId, 'back-squat');
  assert.equal(result.confidence, 'alias');
  assert.equal(result.method, 'alias');
});

test('resolveExercise: resolves alias — barbell back squat → back-squat', () => {
  const result = resolveExercise('barbell back squat');
  assert.ok(result, 'should resolve barbell back squat');
  assert.equal(result.exerciseId, 'back-squat');
});

test('resolveExercise: resolves alias — military press → overhead-press', () => {
  const result = resolveExercise('military press');
  assert.ok(result, 'should resolve military press');
  assert.equal(result.exerciseId, 'overhead-press');
  assert.equal(result.confidence, 'alias');
});

test('resolveExercise: resolves alias — OHP → overhead-press', () => {
  const result = resolveExercise('OHP');
  assert.ok(result, 'should resolve OHP');
  assert.equal(result.exerciseId, 'overhead-press');
});

test('resolveExercise: resolves alias — deadlift → conventional-deadlift', () => {
  const result = resolveExercise('deadlift');
  assert.ok(result, 'should resolve deadlift');
  assert.equal(result.exerciseId, 'conventional-deadlift');
  assert.equal(result.confidence, 'alias');
});

test('resolveExercise: resolves alias — flat bench → bench-press', () => {
  const result = resolveExercise('flat bench');
  assert.ok(result, 'should resolve flat bench');
  assert.equal(result.exerciseId, 'bench-press');
});

test('resolveExercise: resolves alias — bent-over row → barbell-row', () => {
  const result = resolveExercise('bent-over row');
  assert.ok(result, 'should resolve bent-over row');
  assert.equal(result.exerciseId, 'barbell-row');
});

test('resolveExercise: resolves hyphenated alias with normalization — bent over row → barbell-row', () => {
  const result = resolveExercise('bent over row');
  assert.ok(result, 'should resolve bent over row via normalization');
  assert.equal(result.exerciseId, 'barbell-row');
});

test('resolveExercise: resolves progression variant — low-bar back squat → back-squat', () => {
  const result = resolveExercise('low-bar back squat');
  assert.ok(result, 'should resolve low-bar back squat');
  assert.equal(result.exerciseId, 'back-squat');
  assert.equal(result.confidence, 'progression');
  assert.equal(result.method, 'progression');
});

test('resolveExercise: resolves progression variant — high-bar back squat → back-squat', () => {
  const result = resolveExercise('high-bar back squat');
  assert.ok(result, 'should resolve high-bar back squat');
  assert.equal(result.exerciseId, 'back-squat');
});

test('resolveExercise: goblet squat resolves to goblet-squat (not back-squat progression)', () => {
  // goblet squat appears as a progression in back-squat.json but IS its own exercise
  const result = resolveExercise('goblet squat');
  assert.ok(result, 'should resolve goblet squat');
  assert.equal(result.exerciseId, 'goblet-squat', 'should be goblet-squat, not back-squat');
  assert.ok(result.confidence !== 'progression', 'should win via name match, not progression');
});

test('resolveExercise: returns null for completely unknown name', () => {
  assert.equal(resolveExercise('unknown florp press 3000'), null);
});

test('resolveExercise: result has exerciseId and name fields', () => {
  const result = resolveExercise('back-squat');
  assert.ok(typeof result.exerciseId === 'string');
  assert.ok(typeof result.name === 'string');
  assert.ok(result.name.length > 0);
});

// ─── listExerciseIds ──────────────────────────────────────────────────────────

test('listExerciseIds: returns a non-empty array', () => {
  const ids = listExerciseIds();
  assert.ok(Array.isArray(ids));
  assert.ok(ids.length > 0);
});

test('listExerciseIds: contains back-squat', () => {
  assert.ok(listExerciseIds().includes('back-squat'));
});

test('listExerciseIds: contains overhead-press', () => {
  assert.ok(listExerciseIds().includes('overhead-press'));
});

test('listExerciseIds: contains conventional-deadlift', () => {
  assert.ok(listExerciseIds().includes('conventional-deadlift'));
});

test('listExerciseIds: contains no duplicates', () => {
  const ids = listExerciseIds();
  const unique = [...new Set(ids)];
  assert.equal(ids.length, unique.length);
});

test('listExerciseIds: is sorted alphabetically', () => {
  const ids = listExerciseIds();
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted);
});

// ─── queryTrend ───────────────────────────────────────────────────────────────

test('queryTrend: returns insufficient_data for empty rows', () => {
  const result = queryTrend('SQUAT', []);
  assert.equal(result.trend, 'insufficient_data');
  assert.equal(result.confidence, 'none');
});

test('queryTrend: returns insufficient_data for null rows', () => {
  const result = queryTrend('SQUAT', null);
  assert.equal(result.trend, 'insufficient_data');
  assert.equal(result.confidence, 'none');
});

test('queryTrend: returns insufficient_data for empty liftCode', () => {
  const rows = buildSessions(6);
  const result = queryTrend('', rows);
  assert.equal(result.trend, 'insufficient_data');
});

test('queryTrend: returns insufficient_data when fewer than MIN_SESSIONS available', () => {
  const rows = buildSessions(3, { lift: 'SQUAT' });
  const result = queryTrend('SQUAT', rows);
  assert.equal(result.trend, 'insufficient_data');
});

test('queryTrend: detects improving trend across 8 sessions', () => {
  const rows   = buildImprovingSessions(8, { lift: 'SQUAT', startWeight: 200, increment: 5 });
  const result = queryTrend('SQUAT', rows);
  assert.equal(result.trend, 'improving');
});

test('queryTrend: detects declining trend across 8 sessions', () => {
  const rows   = buildDecliningeSessions(8, { lift: 'BENCH' });
  const result = queryTrend('BENCH', rows);
  assert.equal(result.trend, 'declining');
});

test('queryTrend: detects flat trend for constant weight sessions', () => {
  const rows   = buildSessions(8, { lift: 'OHP', weight: 135 });
  const result = queryTrend('OHP', rows);
  // flat or noisy — not improving or declining
  assert.ok(result.trend !== 'improving' && result.trend !== 'declining', `unexpected trend: ${result.trend}`);
});

test('queryTrend: confidence is high when ≥6 sessions analyzed', () => {
  const rows   = buildImprovingSessions(8, { lift: 'DEADLIFT' });
  const result = queryTrend('DEADLIFT', rows);
  assert.equal(result.confidence, 'high');
});

test('queryTrend: result has sessions_analyzed field', () => {
  const rows   = buildSessions(6, { lift: 'SQUAT' });
  const result = queryTrend('SQUAT', rows);
  assert.ok(typeof result.sessions_analyzed === 'number');
});

// ─── queryPatterns ────────────────────────────────────────────────────────────

test('queryPatterns: returns { patterns: [] } for empty rows', () => {
  const result = queryPatterns('SQUAT', []);
  assert.ok(result && typeof result === 'object');
  assert.ok(Array.isArray(result.patterns));
  assert.equal(result.patterns.length, 0);
});

test('queryPatterns: returns { patterns: [] } for null rows', () => {
  const result = queryPatterns('SQUAT', null);
  assert.ok(Array.isArray(result.patterns));
  assert.equal(result.patterns.length, 0);
});

test('queryPatterns: returns { patterns: [] } for empty liftCode', () => {
  const rows   = buildSessions(6);
  const result = queryPatterns('', rows);
  assert.ok(Array.isArray(result.patterns));
  assert.equal(result.patterns.length, 0);
});

test('queryPatterns: returns repeated_substitution when threshold met', () => {
  const history = [
    { original: 'back squat', substitute: 'leg press', liftCode: 'SQUAT' },
    { original: 'back squat', substitute: 'leg press', liftCode: 'SQUAT' },
    { original: 'back squat', substitute: 'leg press', liftCode: 'SQUAT' },
  ];
  const result = queryPatterns('SQUAT', [], { substitutionHistory: history });
  const subs   = result.patterns.filter(p => p.type === 'repeated_substitution');
  assert.equal(subs.length, 1, 'should fire repeated_substitution after 3 occurrences');
  assert.equal(subs[0].details.count, 3);
});

test('queryPatterns: BENCH substitution history does NOT contaminate SQUAT via standalone call', () => {
  const allSubs = [
    { original: 'bench press', substitute: 'push-up', liftCode: 'BENCH' },
    { original: 'bench press', substitute: 'push-up', liftCode: 'BENCH' },
    { original: 'bench press', substitute: 'push-up', liftCode: 'BENCH' },
  ];
  const result = queryPatterns('SQUAT', [], { substitutionHistory: allSubs });
  const subs = result.patterns.filter(p => p.type === 'repeated_substitution');
  assert.equal(subs.length, 0, 'BENCH substitutions must not fire under SQUAT in queryPatterns');
});

test('queryPatterns: no repeated_substitution when below threshold', () => {
  const history = [
    { original: 'back squat', substitute: 'leg press' },
    { original: 'back squat', substitute: 'leg press' },
  ];
  const result = queryPatterns('SQUAT', [], { substitutionHistory: history });
  const subs   = result.patterns.filter(p => p.type === 'repeated_substitution');
  assert.equal(subs.length, 0);
});

// ─── buildMemorySnapshot ──────────────────────────────────────────────────────

test('buildMemorySnapshot: returns correct shape for empty rows', () => {
  const snap = buildMemorySnapshot([]);
  assert.ok(Array.isArray(snap.liftsEncountered));
  assert.equal(snap.liftsEncountered.length, 0);
  assert.ok(snap.liftTrends && typeof snap.liftTrends === 'object');
  assert.ok(snap.liftPatterns && typeof snap.liftPatterns === 'object');
  assert.ok(snap.missedLifts && typeof snap.missedLifts === 'object');
  assert.ok(Array.isArray(snap.missedLifts.patterns));
});

test('buildMemorySnapshot: skips Log_Cleaned header row — no phantom LIFT_CODE entry', () => {
  const header = new Array(12).fill('');
  header[0] = 'date_clean';
  header[5] = 'lift_code';
  const rows = [header, ...buildSessions(4, { lift: 'SQUAT' })];
  const snap = buildMemorySnapshot(rows);
  assert.ok(!snap.liftsEncountered.includes('LIFT_CODE'), 'header row must not produce a phantom lift');
  assert.ok(snap.liftsEncountered.includes('SQUAT'), 'real lift still found');
});

test('buildMemorySnapshot: returns correct shape for null rows', () => {
  const snap = buildMemorySnapshot(null);
  assert.equal(snap.liftsEncountered.length, 0);
});

test('buildMemorySnapshot: returns correct shape when no options provided', () => {
  const rows = buildSessions(4, { lift: 'SQUAT' });
  const snap = buildMemorySnapshot(rows);
  assert.ok(snap.liftsEncountered.includes('SQUAT'));
});

test('buildMemorySnapshot: liftsEncountered lists all distinct lift codes', () => {
  const squat = buildSessions(4, { lift: 'SQUAT', dateBase: 1 });
  const bench = buildSessions(4, { lift: 'BENCH', dateBase: 10 });
  const snap  = buildMemorySnapshot([...squat, ...bench]);
  assert.ok(snap.liftsEncountered.includes('SQUAT'));
  assert.ok(snap.liftsEncountered.includes('BENCH'));
  assert.equal(snap.liftsEncountered.length, 2);
});

test('buildMemorySnapshot: liftsEncountered is sorted', () => {
  const squat = buildSessions(4, { lift: 'SQUAT', dateBase: 1 });
  const bench = buildSessions(4, { lift: 'BENCH', dateBase: 5 });
  const snap  = buildMemorySnapshot([...squat, ...bench]);
  const sorted = [...snap.liftsEncountered].sort();
  assert.deepEqual(snap.liftsEncountered, sorted);
});

test('buildMemorySnapshot: liftTrends has entry for each encountered lift', () => {
  const rows = buildSessions(4, { lift: 'DEADLIFT' });
  const snap = buildMemorySnapshot(rows);
  assert.ok('DEADLIFT' in snap.liftTrends);
  assert.ok(typeof snap.liftTrends['DEADLIFT'].trend === 'string');
});

test('buildMemorySnapshot: liftPatterns has entry for each encountered lift', () => {
  const rows = buildSessions(4, { lift: 'OHP' });
  const snap = buildMemorySnapshot(rows);
  assert.ok('OHP' in snap.liftPatterns);
  assert.ok(Array.isArray(snap.liftPatterns['OHP'].patterns));
});

test('buildMemorySnapshot: improving trend appears in liftTrends', () => {
  const rows = buildImprovingSessions(8, { lift: 'SQUAT' });
  const snap = buildMemorySnapshot(rows);
  assert.equal(snap.liftTrends['SQUAT'].trend, 'improving');
});

test('buildMemorySnapshot: missedLifts.patterns is empty when no history provided', () => {
  const rows = buildSessions(4, { lift: 'SQUAT' });
  const snap = buildMemorySnapshot(rows);
  assert.equal(snap.missedLifts.patterns.length, 0);
});

test('buildMemorySnapshot: missedLifts.patterns populated when history meets threshold', () => {
  const rows = buildSessions(4, { lift: 'SQUAT' });
  const snap = buildMemorySnapshot(rows, {
    missedLiftHistory: [
      { exercise: 'back squat' },
      { exercise: 'back squat' },
    ],
  });
  // MISSED_LIFT_MIN_COUNT = 1, so 2 misses should fire the pattern
  const missed = snap.missedLifts.patterns.filter(p => p.type === 'missed_lift');
  assert.ok(missed.length >= 1, 'should detect missed_lift pattern');
});

test('buildMemorySnapshot: substitutionHistory forwarded to liftPatterns (with liftCode)', () => {
  // Entry shape requires liftCode so buildMemorySnapshot can filter per-lift.
  const subHistory = [
    { original: 'bench press', substitute: 'push-up', liftCode: 'BENCH' },
    { original: 'bench press', substitute: 'push-up', liftCode: 'BENCH' },
    { original: 'bench press', substitute: 'push-up', liftCode: 'BENCH' },
  ];
  const rows = buildSessions(4, { lift: 'BENCH' });
  const snap = buildMemorySnapshot(rows, { substitutionHistory: subHistory });
  const subs = snap.liftPatterns['BENCH'].patterns.filter(p => p.type === 'repeated_substitution');
  assert.equal(subs.length, 1, 'repeated_substitution should be detected via snapshot');
});

test('buildMemorySnapshot: BENCH substitution history does NOT contaminate SQUAT patterns', () => {
  // 3× bench→push-up substitutions tagged liftCode='BENCH'
  const subHistory = [
    { original: 'bench press', substitute: 'push-up', liftCode: 'BENCH' },
    { original: 'bench press', substitute: 'push-up', liftCode: 'BENCH' },
    { original: 'bench press', substitute: 'push-up', liftCode: 'BENCH' },
  ];
  const squat = buildSessions(4, { lift: 'SQUAT', dateBase: 1 });
  const bench = buildSessions(4, { lift: 'BENCH', dateBase: 5 });
  const snap  = buildMemorySnapshot([...squat, ...bench], { substitutionHistory: subHistory });

  // BENCH should detect repeated_substitution
  const benchSubs = snap.liftPatterns['BENCH'].patterns.filter(p => p.type === 'repeated_substitution');
  assert.equal(benchSubs.length, 1, 'BENCH should detect repeated_substitution');

  // SQUAT must NOT have that pattern — the history was BENCH-specific
  const squatSubs = snap.liftPatterns['SQUAT'].patterns.filter(p => p.type === 'repeated_substitution');
  assert.equal(squatSubs.length, 0, 'SQUAT must not inherit BENCH substitution patterns');
});

test('buildMemorySnapshot: handles mixed-lift rows correctly', () => {
  const squat = buildImprovingSessions(8, { lift: 'SQUAT' });
  const bench = buildDecliningeSessions(8, { lift: 'BENCH' });
  const snap  = buildMemorySnapshot([...squat, ...bench]);
  assert.equal(snap.liftTrends['SQUAT'].trend, 'improving');
  assert.equal(snap.liftTrends['BENCH'].trend, 'declining');
});
