'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const { detectPatterns } = require('../services/coachMemory');

// Minimal 12-column row builder for Log_Cleaned.
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

// Build N sessions of bench sets, each at the same weight/reps/rir.
function benchSessions(n, { weight = 225, reps = 5, rir = 2, lift = 'bench_press', dateOffset = 0 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const session = `s${i + 1 + dateOffset}`;
    const date = `2025-01-${String(i + 1 + dateOffset).padStart(2, '0')}`;
    rows.push(makeRow({ date, session, lift, weight, reps, rir }));
  }
  return rows;
}

/* ===== Empty / guard cases ===== */

test('detectPatterns: returns object with patterns array for empty rows', () => {
  const result = detectPatterns('bench_press', []);
  assert.ok(result && typeof result === 'object');
  assert.ok(Array.isArray(result.patterns));
  assert.equal(result.patterns.length, 0);
});

test('detectPatterns: returns empty array when lift not in rows', () => {
  const rows = benchSessions(5, { lift: 'squat' });
  const { patterns } = detectPatterns('bench_press', rows);
  assert.equal(patterns.length, 0);
});

test('detectPatterns: returns empty array when fewer than 5 sessions (underperformance window)', () => {
  const rows = benchSessions(4, { weight: 100, reps: 5 });
  const { patterns } = detectPatterns('bench_press', rows);
  assert.equal(patterns.length, 0);
});

test('detectPatterns: returns empty when no substitution history provided', () => {
  const rows = benchSessions(6);
  const { patterns } = detectPatterns('bench_press', rows);
  assert.equal(patterns.length, 0);
});

test('detectPatterns: returns empty when substitution history is empty array', () => {
  const rows = benchSessions(6);
  const { patterns } = detectPatterns('bench_press', rows, { substitutionHistory: [] });
  assert.equal(patterns.length, 0);
});

/* ===== consistent_underperformance ===== */

test('consistent_underperformance: does NOT flag when all sessions match benchmark weight/reps', () => {
  // 8 sessions of 225×5 @ RIR 2 — benchmark == sessions, e1RM matches
  const rows = benchSessions(8, { weight: 225, reps: 5, rir: 2 });
  const { patterns } = detectPatterns('bench_press', rows);
  const u = patterns.filter(p => p.type === 'consistent_underperformance');
  assert.equal(u.length, 0);
});

test('consistent_underperformance: flags when ≥3 of last 5 sessions are clearly below benchmark', () => {
  // 6 sessions at working weight to establish benchmark
  const normalRows = benchSessions(6, { weight: 225, reps: 5, rir: 2, dateOffset: 0 });
  // 5 recent sessions at sharply lower weight (e1RM ≈ 204 vs ~262 benchmark)
  const underRows  = benchSessions(5, { weight: 185, reps: 3, rir: 2, lift: 'bench_press', dateOffset: 6 });
  const { patterns } = detectPatterns('bench_press', [...normalRows, ...underRows]);
  const u = patterns.filter(p => p.type === 'consistent_underperformance');
  assert.equal(u.length, 1);
  assert.ok(u[0].details.sessions_below >= 3);
  assert.equal(u[0].details.sessions_checked, 5);
});

test('consistent_underperformance: does NOT flag when only 2 of last 5 sessions are below benchmark', () => {
  // Benchmark: 8 sessions at 225×5
  const normalRows = benchSessions(8, { weight: 225, reps: 5, rir: 2, dateOffset: 0 });
  // Last 5: 3 normal + 2 low
  const lastRows = [
    ...benchSessions(3, { weight: 225, reps: 5, rir: 2, dateOffset: 8 }),
    ...benchSessions(2, { weight: 185, reps: 3, rir: 2, dateOffset: 11 })
  ];
  const { patterns } = detectPatterns('bench_press', [...normalRows, ...lastRows]);
  assert.equal(patterns.filter(p => p.type === 'consistent_underperformance').length, 0);
});

test('consistent_underperformance: requires exactly 5 sessions in window — does NOT flag with 4', () => {
  const rows = benchSessions(4, { weight: 95, reps: 3, rir: 2 });
  const { patterns } = detectPatterns('bench_press', rows);
  assert.equal(patterns.filter(p => p.type === 'consistent_underperformance').length, 0);
});

test('consistent_underperformance: uses last 5 sessions — old poor sessions do not trigger when recent are good', () => {
  // 6 very low sessions, then 5 normal sessions at benchmark weight
  const oldLowRows = benchSessions(6, { weight: 150, reps: 3, rir: 2, dateOffset: 0 });
  const newNormRows = benchSessions(5, { weight: 225, reps: 5, rir: 2, dateOffset: 6 });
  const { patterns } = detectPatterns('bench_press', [...oldLowRows, ...newNormRows]);
  assert.equal(patterns.filter(p => p.type === 'consistent_underperformance').length, 0);
});

test('consistent_underperformance: details contain sessions_below and sessions_checked', () => {
  const normalRows = benchSessions(6, { weight: 225, reps: 5, rir: 2, dateOffset: 0 });
  const underRows  = benchSessions(5, { weight: 150, reps: 3, rir: 2, dateOffset: 6 });
  const { patterns } = detectPatterns('bench_press', [...normalRows, ...underRows]);
  const u = patterns.find(p => p.type === 'consistent_underperformance');
  assert.ok(u, 'expected consistent_underperformance pattern');
  assert.equal(typeof u.details.sessions_below, 'number');
  assert.equal(u.details.sessions_checked, 5);
});

/* ===== repeated_substitution ===== */

test('repeated_substitution: flags the same swap 3 times in history', () => {
  const history = [
    { original: 'Deadlift', substitute: 'RDL' },
    { original: 'Deadlift', substitute: 'RDL' },
    { original: 'Deadlift', substitute: 'RDL' },
  ];
  const { patterns } = detectPatterns('deadlift', [], { substitutionHistory: history });
  const s = patterns.filter(p => p.type === 'repeated_substitution');
  assert.equal(s.length, 1);
  assert.equal(s[0].details.count, 3);
  assert.equal(s[0].details.original, 'deadlift');
  assert.equal(s[0].details.substitute, 'rdl');
});

test('repeated_substitution: does NOT flag a swap that appears only twice', () => {
  const history = [
    { original: 'Deadlift', substitute: 'RDL' },
    { original: 'Deadlift', substitute: 'RDL' },
  ];
  const { patterns } = detectPatterns('deadlift', [], { substitutionHistory: history });
  assert.equal(patterns.filter(p => p.type === 'repeated_substitution').length, 0);
});

test('repeated_substitution: flags two distinct qualifying swap pairs independently', () => {
  const history = [
    { original: 'Deadlift', substitute: 'RDL' },
    { original: 'Deadlift', substitute: 'RDL' },
    { original: 'Deadlift', substitute: 'RDL' },
    { original: 'OHP', substitute: 'DB Press' },
    { original: 'OHP', substitute: 'DB Press' },
    { original: 'OHP', substitute: 'DB Press' },
  ];
  const { patterns } = detectPatterns('any', [], { substitutionHistory: history });
  assert.equal(patterns.filter(p => p.type === 'repeated_substitution').length, 2);
});

test('repeated_substitution: window is last 10 entries — swap only in the last 2 of 12 does not qualify', () => {
  // 10 filler entries of a different swap, then 2 entries of the target swap.
  // slice(-10) gives 8 filler + 2 target → target count = 2 < 3.
  const history = [
    ...Array(10).fill({ original: 'Other', substitute: 'Alt' }),
    { original: 'Deadlift', substitute: 'RDL' },
    { original: 'Deadlift', substitute: 'RDL' },
  ]; // total 12, slice(-10) → 2 Other dropped, 8 Other + 2 Deadlift in window
  // Other has 8 ≥ 3 → qualifies, Deadlift has 2 → does not
  const { patterns } = detectPatterns('deadlift', [], { substitutionHistory: history });
  const dl = patterns.filter(p => p.type === 'repeated_substitution' && p.details.original === 'deadlift');
  assert.equal(dl.length, 0);
});

test('repeated_substitution: is case-insensitive for swap pair keys', () => {
  const history = [
    { original: 'DEADLIFT', substitute: 'rdl' },
    { original: 'Deadlift', substitute: 'RDL' },
    { original: 'deadlift', substitute: 'Rdl' },
  ];
  const { patterns } = detectPatterns('deadlift', [], { substitutionHistory: history });
  assert.equal(patterns.filter(p => p.type === 'repeated_substitution').length, 1);
});

test('repeated_substitution: skips malformed substitution entries', () => {
  const history = [
    null,
    undefined,
    { original: 'Deadlift' },          // missing substitute
    { substitute: 'RDL' },              // missing original
    { original: 'Deadlift', substitute: 'RDL' },
    { original: 'Deadlift', substitute: 'RDL' },
    { original: 'Deadlift', substitute: 'RDL' },
  ];
  const { patterns } = detectPatterns('deadlift', [], { substitutionHistory: history });
  const s = patterns.filter(p => p.type === 'repeated_substitution');
  assert.equal(s.length, 1);
  assert.equal(s[0].details.count, 3);
});

/* ===== Result shape ===== */

test('detectPatterns: always returns an object with a patterns array', () => {
  const result = detectPatterns('bench_press', []);
  assert.ok('patterns' in result);
  assert.ok(Array.isArray(result.patterns));
});

test('detectPatterns: only returns known pattern types', () => {
  const KNOWN = new Set(['consistent_underperformance', 'repeated_substitution']);
  const rows = benchSessions(6, { weight: 225, reps: 5, rir: 2 });
  const { patterns } = detectPatterns('bench_press', rows, {
    substitutionHistory: [
      { original: 'Bench', substitute: 'DB Bench' },
      { original: 'Bench', substitute: 'DB Bench' },
      { original: 'Bench', substitute: 'DB Bench' },
    ]
  });
  for (const p of patterns) {
    assert.ok(KNOWN.has(p.type), `unexpected pattern type: ${p.type}`);
  }
});

test('detectPatterns: can return multiple patterns simultaneously', () => {
  const normalRows = benchSessions(6, { weight: 225, reps: 5, rir: 2, dateOffset: 0 });
  const underRows  = benchSessions(5, { weight: 150, reps: 3, rir: 2, dateOffset: 6 });
  const { patterns } = detectPatterns('bench_press', [...normalRows, ...underRows], {
    substitutionHistory: [
      { original: 'bench_press', substitute: 'DB Bench' },
      { original: 'bench_press', substitute: 'DB Bench' },
      { original: 'bench_press', substitute: 'DB Bench' },
    ]
  });
  const types = new Set(patterns.map(p => p.type));
  assert.ok(types.has('consistent_underperformance'));
  assert.ok(types.has('repeated_substitution'));
});

test('detectPatterns: handles null rows gracefully', () => {
  const result = detectPatterns('bench_press', null);
  assert.ok(Array.isArray(result.patterns));
  assert.equal(result.patterns.length, 0);
});

test('detectPatterns: handles null options gracefully', () => {
  const rows = benchSessions(6);
  const result = detectPatterns('bench_press', rows, null);
  assert.ok(Array.isArray(result.patterns));
});
