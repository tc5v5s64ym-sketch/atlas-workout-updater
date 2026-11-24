'use strict';

// #1339 — e1RM single-method standardization (failing-first).
// One engine method: reps+RIR → %1RM lookup. The rep-only figure must retire,
// so every e1RM in the engine answers from the same (weight, reps, rir).
// Proving case everywhere: 225 lb x 6 @ RIR 2 → 285 (rep-only Epley says 270).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const intensity = require('../services/intensityModule');
const { estimateE1RM } = intensity;
const { estimateOneRepMax } = require('../services/estimatedOneRepMax');
const { detectTrend } = require('../services/trendDetector');
const { buildUserState } = require('../services/userStateModule');

// Five sessions, same lift. S1–S3: 225x6 RIR 2. S4–S5: 225x6 RIR 0.
// Rep-only series: 270, 270, 270, 270, 270 → flat.
// Reps+RIR series: 285, 285, 285, 270, 270 → declining.
function fiveSessions() {
  const dates = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];
  const rirs = [2, 2, 2, 0, 0];
  const rows = dates.map((d, i) => {
    const r = new Array(12).fill('');
    r[0] = d; r[1] = `S${i + 1}`; r[5] = 'BENCH PRESS'; r[7] = 225; r[8] = 6; r[9] = rirs[i];
    return r;
  });
  const entries = dates.map((d, i) => ({
    date_clean: d, canonical_exercise: 'Bench Press', muscle_group: 'Chest',
    weight: 225, reps: 6, rir: rirs[i],
  }));
  return { rows, entries };
}

test('#1339 P1: single method honors RIR — 225x6 @ RIR 2 is 285, not 270', () => {
  assert.strictEqual(estimateE1RM(225, 6, 2), 285);
});

test('#1339 P1: absent RIR is RIR 0 — 225x6 with no RIR stays 270', () => {
  assert.strictEqual(estimateE1RM(225, 6), 270);
  assert.strictEqual(estimateE1RM(225, 6, 0), 270);
  assert.strictEqual(estimateE1RM(225, 6, null), 270);
  assert.strictEqual(estimateE1RM(225, 6, undefined), 270);
});

test('#1339 P1: no second formula — Brzycki/Lombardi alternates are retired', () => {
  assert.ok(!intensity.FORMULAS, 'FORMULAS must not exist: one method only');
  assert.ok(!intensity.DEFAULT_FORMULA, 'DEFAULT_FORMULA must not exist: one method only');
  assert.throws(() => estimateE1RM(100, 5, 'brzycki'), TypeError);
});

test('#1339 P2: trendDetector agrees with userStateModule on identical rows', () => {
  const { rows, entries } = fiveSessions();
  const trend = detectTrend('BENCH PRESS', rows);
  assert.strictEqual(trend.trend, 'declining');
  const us = buildUserState(entries, { asOf: '2026-11-21', trendSessions: 5 });
  assert.strictEqual(us.liftStates['Bench Press'].e1rm.trend, 'declining');
  assert.strictEqual(us.liftStates['Bench Press'].pr.bestE1rm, 285);
});

test('#1339 P3: #1777 to-failure answer is unchanged — 225x6 to failure stays 270', () => {
  assert.strictEqual(estimateOneRepMax({ weight: 225, reps: 6 }).value, 270);
});
