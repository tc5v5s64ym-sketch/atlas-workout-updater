'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  computeCurrentE1RM,
  detectLPGraduation,
  autoregulateLoad,
} = require('../services/autoregulationModule');

// ─── Shared helpers ──────────────────────────────────────────────────────────

// Build a structured Log_Cleaned entry (object format used by autoregulationModule).
function entry(overrides) {
  return {
    date_clean:  '2026-01-01',
    session_id:  'S1',
    lift_code:   'SQUAT',
    weight:      180,
    reps:        5,
    rir:         1,
    notes:       '',
    ...overrides,
  };
}

// Build N flat sessions for one lift at a fixed weight/reps/rir.
// Weight=180, reps=5, rir=1 → e1RM = 180*(1+6/30) = 216 for every session.
function flatSessions(n, liftCode = 'SQUAT') {
  const entries = [];
  for (let i = 0; i < n; i++) {
    const date = `2026-0${i + 1}-01`;
    const sid  = `S${i + 1}`;
    entries.push(entry({ date_clean: date, session_id: sid, lift_code: liftCode, weight: 180, reps: 5, rir: 1 }));
  }
  return entries;
}

// Build N sessions with strictly increasing e1RM (no plateau).
function improvingSessions(n, liftCode = 'SQUAT') {
  const entries = [];
  for (let i = 0; i < n; i++) {
    const date = `2026-0${i + 1}-01`;
    const sid  = `S${i + 1}`;
    entries.push(entry({ date_clean: date, session_id: sid, lift_code: liftCode, weight: 180 + i * 5, reps: 5, rir: 1 }));
  }
  return entries;
}

// ─── computeCurrentE1RM ──────────────────────────────────────────────────────

test('computeCurrentE1RM: returns null for empty liftCode', () => {
  assert.equal(computeCurrentE1RM('', flatSessions(3)), null);
});

test('computeCurrentE1RM: returns null for non-string liftCode', () => {
  assert.equal(computeCurrentE1RM(null, flatSessions(3)), null);
  assert.equal(computeCurrentE1RM(42,   flatSessions(3)), null);
});

test('computeCurrentE1RM: returns null for empty logEntries', () => {
  assert.equal(computeCurrentE1RM('SQUAT', []), null);
  assert.equal(computeCurrentE1RM('SQUAT', null), null);
});

test('computeCurrentE1RM: returns null when no entries match liftCode', () => {
  const rows = [entry({ lift_code: 'BENCH' })];
  assert.equal(computeCurrentE1RM('SQUAT', rows), null);
});

test('computeCurrentE1RM: lift code matching is case-insensitive', () => {
  const rows = [entry({ lift_code: 'squat' })];
  const e1rm = computeCurrentE1RM('SQUAT', rows);
  assert.ok(e1rm !== null, 'should find matching entry');
});

test('computeCurrentE1RM: RIR-adjusted formula: weight=180 reps=5 rir=1 → e1RM=216', () => {
  // weight / percentOf1RM(reps, rir) = 180 / (1/(1 + 6/30)) = 180 * 36/30 = 216
  const rows  = [entry({ weight: 180, reps: 5, rir: 1 })];
  const e1rm  = computeCurrentE1RM('SQUAT', rows);
  assert.equal(e1rm, 216);
});

test('computeCurrentE1RM: no RIR falls back to Epley: weight=180 reps=5 → e1RM=210', () => {
  // Epley: 180 * (1 + 5/30) = 180 * 35/30 = 210
  const rows = [entry({ weight: 180, reps: 5, rir: null })];
  const e1rm = computeCurrentE1RM('SQUAT', rows);
  assert.equal(e1rm, 210);
});

test('computeCurrentE1RM: out-of-range RIR (5) falls back to Epley', () => {
  // rir=5 is > 4, so falls back to Epley: 180 * (1+5/30) = 210
  const rows = [entry({ weight: 180, reps: 5, rir: 5 })];
  const e1rm = computeCurrentE1RM('SQUAT', rows);
  assert.equal(e1rm, 210);
});

test('computeCurrentE1RM: takes best e1RM across entries in session window', () => {
  const rows = [
    entry({ session_id: 'S1', weight: 160, reps: 5, rir: 1 }), // e1RM = 160*36/30 = 192
    entry({ session_id: 'S1', weight: 180, reps: 5, rir: 1 }), // e1RM = 216
  ];
  const e1rm = computeCurrentE1RM('SQUAT', rows);
  assert.equal(e1rm, 216);
});

test('computeCurrentE1RM: only uses last 3 sessions', () => {
  // S1 has a higher e1RM (240) but is older than the 3-session window.
  // S2, S3, S4 (the 3 most recent) all produce e1RM=216.
  const rows = [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200, reps: 5, rir: 1 }), // e1RM=240, outside window
    entry({ date_clean: '2026-02-01', session_id: 'S2', weight: 180, reps: 5, rir: 1 }), // e1RM=216
    entry({ date_clean: '2026-03-01', session_id: 'S3', weight: 180, reps: 5, rir: 1 }), // e1RM=216
    entry({ date_clean: '2026-04-01', session_id: 'S4', weight: 180, reps: 5, rir: 1 }), // e1RM=216
  ];
  const e1rm = computeCurrentE1RM('SQUAT', rows);
  assert.equal(e1rm, 216);
});

test('computeCurrentE1RM: excludes warm-up sets by notes', () => {
  // Warm-up at 110 lb (below 60% of maxW=180), also tagged — excluded by note.
  // Working set at 180 lb — included. e1RM comes from the working set only.
  const rows = [
    entry({ session_id: 'S1', weight: 110, reps: 5, rir: 0, notes: 'warm-up' }),
    entry({ session_id: 'S1', weight: 180, reps: 5, rir: 1, notes: '' }),
  ];
  const e1rm = computeCurrentE1RM('SQUAT', rows);
  assert.equal(e1rm, 216);
});

test('computeCurrentE1RM: excludes sets with weight < 60% of session max', () => {
  // maxW=180; 100 < 180*0.60=108 → excluded
  const rows = [
    entry({ session_id: 'S1', weight: 100, reps: 1, rir: 0 }), // excluded (weight heuristic)
    entry({ session_id: 'S1', weight: 180, reps: 5, rir: 1 }),  // included → e1RM=216
  ];
  const e1rm = computeCurrentE1RM('SQUAT', rows);
  assert.equal(e1rm, 216);
});

test('computeCurrentE1RM: excludes sets with RIR >= 4', () => {
  // RIR=4 entry has higher weight but is excluded by RIR threshold.
  const rows = [
    entry({ session_id: 'S1', weight: 250, reps: 5, rir: 4 }),  // excluded: rir >= 4
    entry({ session_id: 'S1', weight: 180, reps: 5, rir: 1 }),  // included → e1RM=216
  ];
  const e1rm = computeCurrentE1RM('SQUAT', rows);
  assert.equal(e1rm, 216);
});

test('computeCurrentE1RM: falls back to all entries when all look like warm-ups', () => {
  // All entries would be filtered by the RIR heuristic — should fall back.
  const rows = [
    entry({ session_id: 'S1', weight: 100, reps: 5, rir: 4 }),
    entry({ session_id: 'S1', weight: 110, reps: 5, rir: 4 }),
  ];
  // If fallback works, we get a result (not null) from Epley on the higher entry.
  const e1rm = computeCurrentE1RM('SQUAT', rows);
  assert.ok(e1rm !== null, 'should return a value via fallback');
});

test('computeCurrentE1RM: returns null for entries with invalid weight', () => {
  const rows = [entry({ weight: 0, reps: 5, rir: 1 })];
  assert.equal(computeCurrentE1RM('SQUAT', rows), null);
});

// ─── detectLPGraduation ──────────────────────────────────────────────────────

test('detectLPGraduation: returns shouldGraduate:false for empty liftCode', () => {
  const r = detectLPGraduation('', flatSessions(3));
  assert.equal(r.shouldGraduate, false);
  assert.equal(r.reason, null);
  assert.equal(r.plateauDetails, null);
});

test('detectLPGraduation: returns shouldGraduate:false for null logEntries', () => {
  const r = detectLPGraduation('SQUAT', null);
  assert.equal(r.shouldGraduate, false);
});

test('detectLPGraduation: returns shouldGraduate:false when no plateau for lift', () => {
  const rows = improvingSessions(3);
  const r = detectLPGraduation('SQUAT', rows);
  assert.equal(r.shouldGraduate, false);
  assert.equal(r.reason, null);
  assert.equal(r.plateauDetails, null);
});

test('detectLPGraduation: detects plateau across 3 flat sessions', () => {
  const rows = flatSessions(3);
  const r = detectLPGraduation('SQUAT', rows);
  assert.equal(r.shouldGraduate, true);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason should be a string');
  assert.ok(Array.isArray(r.plateauDetails) && r.plateauDetails.length > 0, 'plateauDetails should be non-empty');
});

test('detectLPGraduation: reason mentions LP graduation concept', () => {
  const rows = flatSessions(3);
  const r = detectLPGraduation('SQUAT', rows);
  assert.ok(r.reason.toLowerCase().includes('lp') || r.reason.toLowerCase().includes('linear'));
});

test('detectLPGraduation: plateau for different lift does not trigger graduation', () => {
  // BENCH has 3 flat sessions; SQUAT has none.
  const rows = flatSessions(3, 'BENCH');
  const r = detectLPGraduation('SQUAT', rows);
  assert.equal(r.shouldGraduate, false);
});

test('detectLPGraduation: plateauDetails contains liftCode matching entry', () => {
  const rows = flatSessions(3);
  const r = detectLPGraduation('SQUAT', rows);
  if (r.shouldGraduate) {
    assert.ok(r.plateauDetails[0].liftCode === 'SQUAT' ||
              String(r.plateauDetails[0].liftCode || '').toUpperCase() === 'SQUAT');
  }
});

// ─── autoregulateLoad ─────────────────────────────────────────────────────────

test('autoregulateLoad: returns null for null params', () => {
  assert.equal(autoregulateLoad(null), null);
});

test('autoregulateLoad: returns null for missing liftCode', () => {
  assert.equal(autoregulateLoad({ logEntries: flatSessions(3) }), null);
  assert.equal(autoregulateLoad({ liftCode: '', logEntries: flatSessions(3) }), null);
});

test('autoregulateLoad: returns null when logEntries is not an array', () => {
  assert.equal(autoregulateLoad({ liftCode: 'SQUAT', logEntries: null }), null);
});

test('autoregulateLoad: insufficient_data basis when no entries', () => {
  const r = autoregulateLoad({ liftCode: 'SQUAT', logEntries: [] });
  assert.equal(r.basis, 'insufficient_data');
  assert.equal(r.recommendedWeight, null);
  assert.equal(r.e1rm, null);
});

test('autoregulateLoad: default values (targetReps=5, targetRIR=1, bodyRegion=upper_body)', () => {
  const r = autoregulateLoad({ liftCode: 'SQUAT', logEntries: [] });
  assert.equal(r.targetReps, 5);
  assert.equal(r.effectiveRIR, 1);  // targetRIR=1, no readiness adjustment
  assert.equal(r.readinessTier, null);
  assert.equal(r.readinessAdjustment, 0);
});

test('autoregulateLoad: e1rm_derived basis and correct weight for known e1RM', () => {
  // weight=180, reps=5, rir=1 → e1RM=216
  // targetWeightForRIR(216, 5, 1) = 216 * 30/36 = 180 → rounded to 2.5 = 180
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];
  const r = autoregulateLoad({ liftCode: 'SQUAT', logEntries: rows, targetReps: 5, targetRIR: 1 });
  assert.equal(r.basis, 'e1rm_derived');
  assert.equal(r.e1rm, 216);
  assert.equal(r.recommendedWeight, 180);
});

test('autoregulateLoad: high readiness → no RIR adjustment', () => {
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];
  const r = autoregulateLoad({
    liftCode: 'SQUAT',
    logEntries: rows,
    targetReps: 5,
    targetRIR: 1,
    readinessInputs: { sleep: 9, soreness: 1, stress: 1, motivation: 9 },
  });
  assert.equal(r.readinessTier, 'high');
  assert.equal(r.readinessAdjustment, 0);
  assert.equal(r.effectiveRIR, 1);
});

test('autoregulateLoad: moderate readiness → +1 RIR → lighter weight', () => {
  // e1RM = 216, effectiveRIR=2 → targetWeightForRIR(216, 5, 2) = 216*30/37 ≈ 175.14 → rounded=175
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];
  const r = autoregulateLoad({
    liftCode: 'SQUAT',
    logEntries: rows,
    targetReps: 5,
    targetRIR: 1,
    readinessInputs: { sleep: 6, soreness: 5, stress: 5, motivation: 5 },
  });
  assert.equal(r.readinessAdjustment, 1);
  assert.equal(r.effectiveRIR, 2);
  assert.ok(r.recommendedWeight !== null && r.recommendedWeight < 180,
    `moderate readiness should prescribe less than 180 lb, got ${r.recommendedWeight}`);
});

test('autoregulateLoad: low readiness → +2 RIR → lightest weight', () => {
  // e1RM = 216, effectiveRIR=3 → targetWeightForRIR(216, 5, 3) = 216*30/38 ≈ 170.53 → rounded=170
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];
  const rLow = autoregulateLoad({
    liftCode: 'SQUAT',
    logEntries: rows,
    targetReps: 5,
    targetRIR: 1,
    readinessInputs: { sleep: 3, soreness: 9, stress: 9, motivation: 2 },
  });
  assert.equal(rLow.readinessAdjustment, 2);
  assert.equal(rLow.effectiveRIR, 3);
  assert.ok(rLow.recommendedWeight !== null && rLow.recommendedWeight < 180,
    `low readiness should prescribe less than 180 lb`);
});

test('autoregulateLoad: low readiness lighter than moderate readiness', () => {
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];
  const rMod = autoregulateLoad({
    liftCode: 'SQUAT', logEntries: rows, targetReps: 5, targetRIR: 1,
    readinessInputs: { sleep: 6, soreness: 5, stress: 5, motivation: 5 },
  });
  const rLow = autoregulateLoad({
    liftCode: 'SQUAT', logEntries: rows, targetReps: 5, targetRIR: 1,
    readinessInputs: { sleep: 3, soreness: 9, stress: 9, motivation: 2 },
  });
  assert.ok(rLow.recommendedWeight <= rMod.recommendedWeight,
    'low readiness should prescribe ≤ moderate readiness weight');
});

test('autoregulateLoad: null readinessInputs → no tier and zero adjustment', () => {
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];
  const r = autoregulateLoad({ liftCode: 'SQUAT', logEntries: rows, readinessInputs: null });
  assert.equal(r.readinessTier, null);
  assert.equal(r.readinessAdjustment, 0);
});

test('autoregulateLoad: lower_body rounds to nearest 5 lb', () => {
  // weight=180, reps=5, rir=1 → e1RM=216
  // targetWeightForRIR(216, 5, 1) = 180 exactly → still 180 at 5 lb rounding
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];
  const r = autoregulateLoad({
    liftCode: 'SQUAT', logEntries: rows,
    targetReps: 5, targetRIR: 1, bodyRegion: 'lower_body',
  });
  assert.ok(r.recommendedWeight % 5 === 0,
    `lower_body weight should be a multiple of 5, got ${r.recommendedWeight}`);
});

test('autoregulateLoad: upper_body rounds to nearest 2.5 lb', () => {
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];
  const r = autoregulateLoad({
    liftCode: 'SQUAT', logEntries: rows,
    targetReps: 5, targetRIR: 1, bodyRegion: 'upper_body',
  });
  // result must be divisible by 2.5
  assert.ok(r.recommendedWeight % 2.5 === 0,
    `upper_body weight should be multiple of 2.5 lb, got ${r.recommendedWeight}`);
});

test('autoregulateLoad: result shape includes all required fields', () => {
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];
  const r = autoregulateLoad({ liftCode: 'SQUAT', logEntries: rows });
  assert.ok('recommendedWeight'   in r);
  assert.ok('targetReps'          in r);
  assert.ok('effectiveRIR'        in r);
  assert.ok('e1rm'                in r);
  assert.ok('readinessTier'       in r);
  assert.ok('readinessAdjustment' in r);
  assert.ok('graduateFromLP'      in r);
  assert.ok('plateauDetails'      in r);
  assert.ok('basis'               in r);
});

test('autoregulateLoad: graduateFromLP true when plateau detected', () => {
  const rows = flatSessions(3);
  const r = autoregulateLoad({ liftCode: 'SQUAT', logEntries: rows });
  assert.equal(r.graduateFromLP, true);
  assert.ok(Array.isArray(r.plateauDetails) && r.plateauDetails.length > 0);
});

test('autoregulateLoad: graduateFromLP false for improving sessions', () => {
  const rows = improvingSessions(3);
  const r = autoregulateLoad({ liftCode: 'SQUAT', logEntries: rows });
  assert.equal(r.graduateFromLP, false);
  assert.equal(r.plateauDetails, null);
});

test('autoregulateLoad: targetReps is clamped to minimum 1', () => {
  const r = autoregulateLoad({ liftCode: 'SQUAT', logEntries: [], targetReps: -1 });
  assert.equal(r.targetReps, 1);
});

test('autoregulateLoad: custom targetReps flows through to result', () => {
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];
  const r = autoregulateLoad({ liftCode: 'SQUAT', logEntries: rows, targetReps: 3, targetRIR: 2 });
  assert.equal(r.targetReps, 3);
});

test('autoregulateLoad: lift code matching case-insensitive in e1RM lookup', () => {
  const rows = [entry({ lift_code: 'squat', weight: 180, reps: 5, rir: 1 })];
  const r = autoregulateLoad({ liftCode: 'SQUAT', logEntries: rows });
  assert.equal(r.e1rm, 216);
  assert.equal(r.basis, 'e1rm_derived');
});

test('autoregulateLoad: effectiveRIR clamped to 4 — e1rm_derived even at targetRIR=3 + low readiness', () => {
  // targetRIR=3, low readiness (+2) would give effectiveRIR=5 which exceeds MAX_RIR=4.
  // Clamping to 4 should still yield a valid e1rm_derived result, not a null fallback.
  const rows = [entry({ weight: 180, reps: 5, rir: 1 })];  // e1RM=216
  const r = autoregulateLoad({
    liftCode: 'SQUAT', logEntries: rows,
    targetReps: 5, targetRIR: 3,
    readinessInputs: { sleep: 3, soreness: 9, stress: 9, motivation: 2 }, // low → +2
  });
  assert.equal(r.effectiveRIR, 4, 'effectiveRIR should be clamped to 4');
  assert.equal(r.basis, 'e1rm_derived', 'should still derive weight from e1RM');
  assert.ok(r.recommendedWeight !== null && r.recommendedWeight > 0,
    'should produce a non-null weight after clamping');
});
