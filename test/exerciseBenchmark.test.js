const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBenchmark, resolveWorkingWeight } = require('../services/exerciseBenchmark');

/* ===== Helpers ===== */

// Build a raw Log_Cleaned row (12-column contract).
// col indices: 0=date, 1=session, 5=liftCode, 7=weight, 8=reps, 9=rir
function row(date, session, liftCode, weight, reps, rir = '') {
  const r = new Array(12).fill('');
  r[0] = date;
  r[1] = session;
  r[5] = liftCode;
  r[7] = String(weight);
  r[8] = String(reps);
  r[9] = rir === null ? '' : String(rir);
  return r;
}

const BENCH = 'BEN01';
const SQUAT = 'SQU01';
const HDR = ['date_clean', 'session_id', 'exercise', 'canonical_exercise',
             'muscle_group', 'lift_code', 'set_number', 'weight', 'reps', 'rir', 'notes', 'volume_calc'];

/* ===== Null / empty inputs ===== */

test('computeBenchmark: returns nullBenchmark for null liftCode', () => {
  const b = computeBenchmark(null, [row('2026-01-01', 'S1', BENCH, 225, 5, 2)]);
  assert.equal(b.confidence, 'none');
  assert.equal(b.workingWeight, null);
  assert.equal(b.sampleSize, 0);
});

test('computeBenchmark: returns nullBenchmark for empty rows array', () => {
  const b = computeBenchmark(BENCH, []);
  assert.equal(b.confidence, 'none');
  assert.equal(b.sampleSize, 0);
});

test('computeBenchmark: skips header row and returns nullBenchmark when only header', () => {
  const b = computeBenchmark(BENCH, [HDR]);
  assert.equal(b.confidence, 'none');
});

test('computeBenchmark: ignores rows for a different lift code', () => {
  const b = computeBenchmark(BENCH, [row('2026-01-01', 'S1', SQUAT, 315, 5, 2)]);
  assert.equal(b.sampleSize, 0);
  assert.equal(b.workingWeight, null);
});

/* ===== Single session ===== */

test('computeBenchmark: single session returns workingWeight = that session top', () => {
  const b = computeBenchmark(BENCH, [
    row('2026-01-01', 'S1', BENCH, 135, 10, 5),  // warm-up (rir 5 >= 4)
    row('2026-01-01', 'S1', BENCH, 225, 5, 2),   // working
  ]);
  assert.equal(b.sampleSize, 1);
  assert.equal(b.confidence, 'low');
  assert.equal(b.workingWeight, 225);
  assert.equal(b.recentBest, 225);
});

test('computeBenchmark: single set with no RIR still produces a benchmark', () => {
  const b = computeBenchmark(BENCH, [
    row('2026-01-01', 'S1', BENCH, 185, 8, null),
  ]);
  assert.equal(b.sampleSize, 1);
  assert.equal(b.workingWeight, 185);
});

/* ===== Warm-up exclusion ===== */

test('computeBenchmark: excludes sets with rir >= 4 from working set calculation', () => {
  const b = computeBenchmark(BENCH, [
    row('2026-01-01', 'S1', BENCH, 95,  10, 5),  // warm-up: rir >= 4
    row('2026-01-01', 'S1', BENCH, 135, 10, 4),  // warm-up: rir >= 4
    row('2026-01-01', 'S1', BENCH, 185, 8,  2),  // working
    row('2026-01-01', 'S1', BENCH, 225, 5,  2),  // working top
  ]);
  assert.equal(b.workingWeight, 225);
  // Only reps from working sets (185×8 and 225×5), not warm-ups
  assert.ok(b.repRange.min >= 5);
  assert.ok(b.repRange.max <= 8);
});

test('computeBenchmark: excludes light sets (< 60 % of session max) from benchmark', () => {
  // 95 lb is 42 % of 225 — below 60 % threshold
  const b = computeBenchmark(BENCH, [
    row('2026-01-01', 'S1', BENCH, 95,  12, 2),  // warm-up: weight < 60% of max
    row('2026-01-01', 'S1', BENCH, 225, 5,  2),  // working top
  ]);
  assert.equal(b.workingWeight, 225);
  assert.equal(b.repRange.min, 5);
  assert.equal(b.repRange.max, 5);
});

test('computeBenchmark: falls back to all sets when every set looks like a warm-up', () => {
  // All sets have rir >= 4 — fall back keeps them all so we still get a result
  const b = computeBenchmark(BENCH, [
    row('2026-01-01', 'S1', BENCH, 135, 10, 4),
    row('2026-01-01', 'S1', BENCH, 185, 8,  5),
  ]);
  assert.ok(b.workingWeight !== null);
  assert.equal(b.sampleSize, 1);
});

/* ===== App-test-hold: 225×5 @2 beats 185×8 @2 as working weight ===== */

test('computeBenchmark: identifies 225×5 @2 as stronger benchmark than 185×8 @2', () => {
  // Three sessions where the lifter builds to 225×5 @2, with 185×8 @2 appearing
  // as a sub-max set in some sessions and as the only set in one.
  const rows = [
    // Session A: 185×8 only
    row('2026-01-01', 'SA', BENCH, 185, 8, 2),
    // Session B: 185×8 then 225×5
    row('2026-01-08', 'SB', BENCH, 185, 8, 2),
    row('2026-01-08', 'SB', BENCH, 225, 5, 2),
    // Session C: 225×5 only
    row('2026-01-15', 'SC', BENCH, 225, 5, 2),
    // Session D: 225×5 only
    row('2026-01-22', 'SD', BENCH, 225, 5, 2),
  ];
  const b = computeBenchmark(BENCH, rows);
  assert.equal(b.sampleSize, 4);
  assert.equal(b.confidence, 'medium');
  // 225 appears as the top set in 3 of 4 sessions → mode = 225
  assert.equal(b.workingWeight, 225,
    `expected workingWeight 225 (mode of top sets), got ${b.workingWeight}`);
  assert.equal(b.recentBest, 225);
});

test('computeBenchmark: workingWeight is the mode when one weight clearly dominates', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, 2),
    row('2026-01-08', 'S2', BENCH, 225, 5, 2),
    row('2026-01-15', 'S3', BENCH, 225, 5, 2),
    row('2026-01-22', 'S4', BENCH, 235, 5, 2),  // one step up
  ];
  const b = computeBenchmark(BENCH, rows);
  // 225 appears 3×, 235 appears 1× → mode = 225
  assert.equal(b.workingWeight, 225);
});

test('computeBenchmark: workingWeight is the higher mode when two weights tie at max frequency', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8, 2),
    row('2026-01-08', 'S2', BENCH, 185, 8, 2),
    row('2026-01-15', 'S3', BENCH, 225, 5, 2),
    row('2026-01-22', 'S4', BENCH, 225, 5, 2),
  ];
  const b = computeBenchmark(BENCH, rows);
  // Both 185 and 225 appear twice — tie → pick the higher weight (strength bias)
  assert.equal(b.workingWeight, 225);
});

test('computeBenchmark: workingWeight falls back to median when all top-set weights are unique', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8, 2),
    row('2026-01-08', 'S2', BENCH, 205, 5, 2),
    row('2026-01-15', 'S3', BENCH, 225, 5, 2),
  ];
  const b = computeBenchmark(BENCH, rows);
  // No mode → median of [185, 205, 225] = 205, rounded to nearest 5 = 205
  assert.equal(b.workingWeight, 205);
});

/* ===== Confidence levels ===== */

test('computeBenchmark: confidence none when no matching rows', () => {
  assert.equal(computeBenchmark(BENCH, []).confidence, 'none');
});

test('computeBenchmark: confidence low for 1 session', () => {
  const b = computeBenchmark(BENCH, [row('2026-01-01', 'S1', BENCH, 225, 5, 2)]);
  assert.equal(b.confidence, 'low');
});

test('computeBenchmark: confidence low for 2 sessions', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, 2),
    row('2026-01-08', 'S2', BENCH, 225, 5, 2),
  ];
  assert.equal(computeBenchmark(BENCH, rows).confidence, 'low');
});

test('computeBenchmark: confidence medium for 3 sessions', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, 2),
    row('2026-01-08', 'S2', BENCH, 225, 5, 2),
    row('2026-01-15', 'S3', BENCH, 225, 5, 2),
  ];
  assert.equal(computeBenchmark(BENCH, rows).confidence, 'medium');
});

test('computeBenchmark: confidence high for 5+ sessions', () => {
  const rows = [1,2,3,4,5].map((i) =>
    row(`2026-01-0${i}`, `S${i}`, BENCH, 225, 5, 2)
  );
  assert.equal(computeBenchmark(BENCH, rows).confidence, 'high');
});

/* ===== recentBest ===== */

test('computeBenchmark: recentBest uses only the last 10 sessions', () => {
  // 11 sessions: first has 275 lb, rest have 225
  const rows = [
    row('2025-01-01', 'OLD', BENCH, 275, 3, 2),  // outside recent window
    ...[1,2,3,4,5,6,7,8,9,10].map(i =>
      row(`2026-01-${String(i).padStart(2,'0')}`, `S${i}`, BENCH, 225, 5, 2)
    ),
  ];
  const b = computeBenchmark(BENCH, rows);
  assert.equal(b.sampleSize, 11);
  // recentBest only looks at last 10 sessions (all at 225)
  assert.equal(b.recentBest, 225, 'recentBest should not include session outside window');
});

/* ===== Rep and RIR ranges ===== */

test('computeBenchmark: repRange captures min/max across working sets', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, 2),
    row('2026-01-08', 'S2', BENCH, 225, 8, 2),
    row('2026-01-15', 'S3', BENCH, 225, 3, 2),
  ];
  const b = computeBenchmark(BENCH, rows);
  assert.equal(b.repRange.min, 3);
  assert.equal(b.repRange.max, 8);
});

test('computeBenchmark: rirRange excludes null-RIR sets', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, null),  // no RIR
    row('2026-01-08', 'S2', BENCH, 225, 5, 2),
    row('2026-01-15', 'S3', BENCH, 225, 5, 3),
  ];
  const b = computeBenchmark(BENCH, rows);
  assert.deepEqual(b.rirRange, { min: 2, max: 3 });
});

test('computeBenchmark: rirRange is null when no sets have RIR', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, null),
    row('2026-01-08', 'S2', BENCH, 225, 5, null),
  ];
  assert.equal(computeBenchmark(BENCH, rows).rirRange, null);
});

/* ===== Case insensitivity ===== */

test('computeBenchmark: lift code match is case-insensitive', () => {
  const rows = [row('2026-01-01', 'S1', 'ben01', 225, 5, 2)];
  const b = computeBenchmark('BEN01', rows);
  assert.equal(b.sampleSize, 1);
});

/* ===== Header row handling ===== */

test('computeBenchmark: skips the header row in mixed input', () => {
  const rows = [HDR, row('2026-01-01', 'S1', BENCH, 225, 5, 2)];
  const b = computeBenchmark(BENCH, rows);
  assert.equal(b.sampleSize, 1);
  assert.equal(b.workingWeight, 225);
});

/* ===== workingWeight is rounded to nearest 5 lb ===== */

test('computeBenchmark: workingWeight is rounded to nearest 5 lb', () => {
  // 3 sessions at 222 lb (between 220 and 225 but closer to 220)
  const rows = [1,2,3].map(i => row(`2026-01-0${i}`, `S${i}`, BENCH, 222, 5, 2));
  const b = computeBenchmark(BENCH, rows);
  assert.equal(b.workingWeight % 5, 0, 'workingWeight must be a multiple of 5');
});

/* ===== resolveWorkingWeight ===== */

test('resolveWorkingWeight: null liftCode → nullWorkingWeight shape', () => {
  const r = resolveWorkingWeight(null, [row('2026-01-01', 'S1', BENCH, 225, 5, 2)]);
  assert.equal(r.weight, null);
  assert.equal(r.confidence, 'none');
  assert.equal(r.sampleSize, 0);
});

test('resolveWorkingWeight: empty rows → nullWorkingWeight', () => {
  const r = resolveWorkingWeight(BENCH, []);
  assert.equal(r.weight, null);
  assert.equal(r.confidence, 'none');
});

test('resolveWorkingWeight: null rows → nullWorkingWeight', () => {
  assert.equal(resolveWorkingWeight(BENCH, null).weight, null);
});

test('resolveWorkingWeight: wrong lift code → nullWorkingWeight', () => {
  const rows = [row('2026-01-01', 'S1', SQUAT, 225, 5, 2)];
  assert.equal(resolveWorkingWeight(BENCH, rows).weight, null);
});

test('resolveWorkingWeight: header-only rows → nullWorkingWeight', () => {
  assert.equal(resolveWorkingWeight(BENCH, [HDR]).weight, null);
});

/* ── Target-zone filtering ── */

test('resolveWorkingWeight: uses only sessions where top-set RIR ∈ [0, 3]', () => {
  // S1: top set 225@2 (in zone), S2: top set 185@5 (outside zone — too easy)
  // Working weight should anchor to 225, not average in 185.
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, 2),
    row('2026-01-08', 'S2', BENCH, 185, 8, 5),
    row('2026-01-15', 'S3', BENCH, 225, 5, 1),
    row('2026-01-22', 'S4', BENCH, 225, 5, 2),
  ];
  const r = resolveWorkingWeight(BENCH, rows);
  assert.equal(r.weight, 225);
  assert.equal(r.sampleSize, 3);  // only S1/S3/S4 qualify
});

test('resolveWorkingWeight: RIR 0 is included (lower boundary)', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, 0),
    row('2026-01-08', 'S2', BENCH, 225, 5, 0),
    row('2026-01-15', 'S3', BENCH, 225, 5, 0),
  ];
  const r = resolveWorkingWeight(BENCH, rows);
  assert.equal(r.weight, 225);
});

test('resolveWorkingWeight: RIR 3 is included (upper boundary)', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, 3),
    row('2026-01-08', 'S2', BENCH, 225, 5, 3),
    row('2026-01-15', 'S3', BENCH, 225, 5, 3),
  ];
  const r = resolveWorkingWeight(BENCH, rows);
  assert.equal(r.weight, 225);
});

test('resolveWorkingWeight: RIR 4 at top-set excludes session from zone (warm-up threshold)', () => {
  // Sessions with top-set RIR=4 are outside the target zone; should fall back to all sessions.
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 10, 4),
    row('2026-01-08', 'S2', BENCH, 185, 10, 4),
    row('2026-01-15', 'S3', BENCH, 185, 10, 4),
  ];
  // No target-zone sessions → falls back to all sessions
  const r = resolveWorkingWeight(BENCH, rows);
  // 185 lb warm-up sets are excluded by the weight-fraction heuristic relative to session max.
  // Since all sets in each session are at the same weight, working = all sets, topWeight = 185.
  // Falls back: all 3 sessions → weight = 185 (rounded to 5 lb).
  assert.equal(r.weight, 185);
  assert.equal(r.sampleSize, 3);
});

test('resolveWorkingWeight: falls back to all sessions when no in-zone RIR data', () => {
  // All sessions have null RIR (older logs) — fall back uses all sessions.
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, null),
    row('2026-01-08', 'S2', BENCH, 225, 5, null),
    row('2026-01-15', 'S3', BENCH, 225, 5, null),
  ];
  const r = resolveWorkingWeight(BENCH, rows);
  assert.equal(r.weight, 225);
  assert.equal(r.sampleSize, 3);
});

/* ── Mode / median ── */

test('resolveWorkingWeight: mode wins when sessions cluster at same weight', () => {
  // Four sessions at 225, one at 230 — mode is 225.
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, 2),
    row('2026-01-08', 'S2', BENCH, 225, 5, 2),
    row('2026-01-15', 'S3', BENCH, 225, 5, 2),
    row('2026-01-22', 'S4', BENCH, 225, 5, 2),
    row('2026-01-29', 'S5', BENCH, 230, 5, 2),
  ];
  const r = resolveWorkingWeight(BENCH, rows);
  assert.equal(r.weight, 225);
});

test('resolveWorkingWeight: median used when all top-set weights are unique', () => {
  // 5 sessions at 205, 210, 215, 220, 225 → median = 215 → rounds to 215
  const rows = [205, 210, 215, 220, 225].map((w, i) =>
    row(`2026-01-${String(i + 1).padStart(2, '0')}`, `S${i + 1}`, BENCH, w, 5, 2)
  );
  const r = resolveWorkingWeight(BENCH, rows);
  assert.equal(r.weight, 215);
});

/* ── Confidence ── */

test('resolveWorkingWeight: confidence high when ≥5 qualifying sessions', () => {
  const rows = [1, 2, 3, 4, 5].map(i =>
    row(`2026-01-${String(i).padStart(2, '0')}`, `S${i}`, BENCH, 225, 5, 2)
  );
  assert.equal(resolveWorkingWeight(BENCH, rows).confidence, 'high');
});

test('resolveWorkingWeight: confidence medium when 3–4 qualifying sessions', () => {
  const rows = [1, 2, 3].map(i =>
    row(`2026-01-${String(i).padStart(2, '0')}`, `S${i}`, BENCH, 225, 5, 2)
  );
  assert.equal(resolveWorkingWeight(BENCH, rows).confidence, 'medium');
});

test('resolveWorkingWeight: confidence low when 1–2 qualifying sessions', () => {
  const rows = [row('2026-01-01', 'S1', BENCH, 225, 5, 2)];
  assert.equal(resolveWorkingWeight(BENCH, rows).confidence, 'low');
});

/* ── Rep and RIR ranges ── */

test('resolveWorkingWeight: repRange spans qualifying sessions\' working sets', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 4, 2),
    row('2026-01-08', 'S2', BENCH, 225, 5, 2),
    row('2026-01-15', 'S3', BENCH, 225, 6, 1),
  ];
  const r = resolveWorkingWeight(BENCH, rows);
  assert.deepEqual(r.repRange, { min: 4, max: 6 });
});

test('resolveWorkingWeight: rirRange null when no RIR data (fallback path)', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, null),
    row('2026-01-08', 'S2', BENCH, 225, 5, null),
    row('2026-01-15', 'S3', BENCH, 225, 5, null),
  ];
  const r = resolveWorkingWeight(BENCH, rows);
  assert.equal(r.rirRange, null);
});

/* ── Plan spec golden test ── */

test('resolveWorkingWeight: spec golden — bench 225×5 @2 anchors working weight to 225', () => {
  // Plan app-test hold: "Bench working weight resolves around 225×5 @2, not the latest random test set."
  // S3 (245@8) is outside the target RIR zone — only S1/S2/S4/S5/S6 (4 in-zone sessions → medium)
  // and weight correctly resolves to 225, not the one-off 245 test set.
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, 2),
    row('2026-01-08', 'S2', BENCH, 225, 5, 2),
    row('2026-01-15', 'S3', BENCH, 245, 3, 8),  // test set — RIR 8, outside target zone
    row('2026-01-22', 'S4', BENCH, 225, 5, 2),
    row('2026-01-29', 'S5', BENCH, 225, 4, 3),
    row('2026-02-05', 'S6', BENCH, 225, 5, 1),
  ];
  const r = resolveWorkingWeight(BENCH, rows);
  assert.equal(r.weight, 225, 'should anchor to 225, not the one-off 245 test set');
  assert.equal(r.confidence, 'high');  // 5 in-zone sessions (S1/S2/S4/S5/S6)
});
