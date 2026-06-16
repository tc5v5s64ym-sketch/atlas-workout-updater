const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SIGNAL_WEIGHTS, estimateE1rm, stagnationThreshold, analyzeLift,
  countRecoveryReports, scoreFatigueExposure, computeFatigueScore
} = require('../services/deloadFatigueScore');

// Helper: build a chronological exposure list for one lift.
const lift = (lift_code, focus, exposures) => ({ lift_code, focus, exposures });
const ex = (weight, reps, rir) => ({ weight, reps, rir });

/* =========================================================================
   All expected numbers below are HAND-COMPUTED from the scoring rules in
   services/deloadFatigueScore.js, never copied from the code's output.
   ========================================================================= */

/* ===== estimateE1rm (Epley) ===== */

test('estimateE1rm uses Epley and guards bad input', () => {
  assert.equal(estimateE1rm(225, 5), 225 * (1 + 5 / 30)); // 262.5
  assert.equal(estimateE1rm(100, 0), null);
  assert.equal(estimateE1rm(0, 5), null);
  assert.equal(estimateE1rm(null, 5), null);
});

/* ===== stagnation threshold + frequency adjustment ===== */

test('stagnationThreshold: strength=3, hypertrophy=4, low-frequency adds 2', () => {
  assert.equal(stagnationThreshold('strength', 5), 3);
  assert.equal(stagnationThreshold('strength', 2), 5);   // 1-3x/week → +2
  assert.equal(stagnationThreshold('hypertrophy', 5), 4);
  assert.equal(stagnationThreshold('hypertrophy', 2), 6);
  assert.equal(stagnationThreshold('mystery', 5), 4);    // unknown focus → default 4
  assert.equal(stagnationThreshold('strength', undefined), 3); // no freq → not low-freq
});

/* ===== THE anti-false-stall guard: same weight, more reps = progress ===== */

test('same weight with increasing reps is progress, NOT stagnation (score 0)', () => {
  // 225×5 → 225×6 → 225×7 at RIR 2. e1RM rises each session, so nothing stalls.
  const out = computeFatigueScore({
    frequency_per_week: 5,
    lifts: [lift('BENCH', 'strength', [ex(225, 5, 2), ex(225, 6, 2), ex(225, 7, 2)])]
  });
  assert.equal(out.score, 0);
  assert.deepEqual(out.signals, { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 });
});

test('spec Example B: low-frequency lifter, flat weight but rising reps → stays quiet', () => {
  // Back squat 205, reps progressing, trains 2x/week. Must NOT accrue fatigue.
  const out = computeFatigueScore({
    frequency_per_week: 2,
    lifts: [lift('SQUAT', 'strength', [ex(205, 5, 2), ex(205, 6, 2), ex(205, 7, 2)])]
  });
  assert.equal(out.score, 0);
});

/* ===== A: a genuine flat plateau is a (modest) stall ===== */

test('a flat plateau over the threshold flags stagnation at 20 points', () => {
  // 225×5 @2 four times: first progresses, next three stall. threshold(strength,hi)=3.
  const out = computeFatigueScore({
    frequency_per_week: 5,
    lifts: [lift('BENCH', 'strength', [ex(225, 5, 2), ex(225, 5, 2), ex(225, 5, 2), ex(225, 5, 2)])]
  });
  assert.equal(out.signals.A, 20); // at threshold → 20
  assert.equal(out.score, 20);     // a lone stall stays in 'normal coaching' (<50)
});

/* ===== frequency adjustment changes the same data's verdict ===== */

test('the same stalled history scores differently by training frequency', () => {
  // 200×5 @2 five times: first progresses, four stall (stalledCount = 4).
  const exposures = [ex(200, 5, 2), ex(200, 5, 2), ex(200, 5, 2), ex(200, 5, 2), ex(200, 5, 2)];

  // High frequency: threshold 3, over = 1 → A = 20 + 5 = 25.
  const hi = computeFatigueScore({ frequency_per_week: 5, lifts: [lift('BENCH', 'strength', exposures)] });
  assert.equal(hi.signals.A, 25);
  assert.equal(hi.score, 25);

  // Low frequency: threshold 5, stalledCount 4 < 5 → not stalled at all.
  const lo = computeFatigueScore({ frequency_per_week: 2, lifts: [lift('BENCH', 'strength', exposures)] });
  assert.equal(lo.signals.A, 0);
  assert.equal(lo.score, 0);
});

/* ===== B: regression ===== */

test('an e1RM drop of ≥5% flags regression (20 points at the 5% edge)', () => {
  // 225×6 → 225×5 → 225×4: e1RM 270 → 262.5 → 255. Drop = 15/270 = 5.56% ≥ 5%.
  const out = computeFatigueScore({
    frequency_per_week: 5,
    lifts: [lift('BENCH', 'strength', [ex(225, 6, 2), ex(225, 5, 2), ex(225, 4, 2)])]
  });
  assert.equal(out.signals.B, 20);
  assert.equal(out.signals.A, 0); // only 2 stalled exposures (< threshold 3)
  assert.equal(out.score, 20);
});

/* ===== C: RIR drift at stable performance ===== */

test('falling RIR at identical performance flags drift, isolated from stagnation', () => {
  // 225×5 at RIR 3 → 2 → 1. Same weight & reps, effort rising. Only 2 stalled
  // exposures (< threshold 3) so A stays 0; drift = 3 − 1 = 2 → C = 8 + 8 = 16.
  const out = computeFatigueScore({
    frequency_per_week: 5,
    lifts: [lift('BENCH', 'strength', [ex(225, 5, 3), ex(225, 5, 2), ex(225, 5, 1)])]
  });
  assert.equal(out.signals.C, 16);
  assert.equal(out.signals.A, 0);
  assert.equal(out.score, 16);
});

/* ===== D: multiple lifts stalling at once ===== */

test('two lifts stalling simultaneously adds the multi-lift signal', () => {
  const stalled = [ex(225, 5, 2), ex(225, 5, 2), ex(225, 5, 2), ex(225, 5, 2)]; // stall 3 each
  const out = computeFatigueScore({
    frequency_per_week: 5,
    lifts: [lift('BENCH', 'strength', stalled), lift('ROW', 'strength', stalled)]
  });
  assert.equal(out.signals.A, 20); // worst single lift
  assert.equal(out.signals.D, 10); // 2 lifts stalled → 10
  assert.equal(out.score, 30);
});

/* ===== E: recovery signals — repeated reports matter, one does not ===== */

test('recovery reports scale, and a single report stays minor', () => {
  const one = computeFatigueScore({ recovery_reports: ['sore'] });
  assert.equal(one.signals.E, 4);
  assert.equal(one.score, 4);

  const two = computeFatigueScore({ recovery_reports: ['sore', 'exhausted'] });
  assert.equal(two.signals.E, 17); // 8 + 9

  const three = computeFatigueScore({ recovery_reports: ['sore', 'exhausted', 'beat up'] });
  assert.equal(three.signals.E, 25); // 8 + 18 = 26, capped at 25
});

test('countRecoveryReports de-duplicates and ignores blanks', () => {
  assert.equal(countRecoveryReports(['Sore', 'sore', '  ', 'exhausted']), 2);
  assert.equal(countRecoveryReports(null), 0);
});

/* ===== F: high fatigue exposure — capped, and alone can NEVER trigger ===== */

test('high fatigue exposure is capped at 12 and cannot reach the trigger band alone', () => {
  const out = computeFatigueScore({
    fatigue_exposure: { hard_sets: 25, failure_sets: 6, block_length_sessions: 10 }
  });
  assert.equal(out.signals.F, 12);  // 4 + 4 + 4
  assert.equal(out.score, 12);
  assert.ok(out.score < 50, 'F alone must stay below the 50 normal-coaching ceiling');
  assert.equal(scoreFatigueExposure({ hard_sets: 12, failure_sets: 2, block_length_sessions: 5 }), 6);
});

/* ===== Stacked signals cross into the deload bands (offer is 75-90) ===== */

test('genuinely high fatigue (several signals stacking) crosses into the offer band', () => {
  // Lift1: 225×6→5→4→4 @2 — stalls (count 3 → A 20) AND regresses 5.56% (B 20).
  // Lift2: 225×5 @2 ×4 — stalls (count 3). Two lifts stalled → D 10.
  // Recovery: three distinct reports → E 25. Fatigue exposure maxed → F 12.
  // Total = 20 + 20 + 10 + 25 + 12 = 87.
  const out = computeFatigueScore({
    frequency_per_week: 5,
    lifts: [
      lift('BENCH', 'strength', [ex(225, 6, 2), ex(225, 5, 2), ex(225, 4, 2), ex(225, 4, 2)]),
      lift('ROW', 'strength', [ex(225, 5, 2), ex(225, 5, 2), ex(225, 5, 2), ex(225, 5, 2)])
    ],
    recovery_reports: ['beat up', 'exhausted', 'sore'],
    fatigue_exposure: { hard_sets: 25, failure_sets: 6, block_length_sessions: 10 }
  });
  assert.deepEqual(out.signals, { A: 20, B: 20, C: 0, D: 10, E: 25, F: 12 });
  assert.equal(out.score, 87);
  // 87 sits in the spec's OFFER band (75-90); recommend is >90. The band → action
  // mapping is the escalation-ladder PR; here we only assert the score crosses 75.
  assert.ok(out.score > 75, 'stacked fatigue should clear the 75 offer threshold');
});

/* ===== degenerate input ===== */

test('empty input scores zero with no signals', () => {
  const out = computeFatigueScore({});
  assert.equal(out.score, 0);
  assert.deepEqual(out.signals, { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 });
});

test('a single exposure cannot stall, regress, or drift', () => {
  const a = analyzeLift(lift('BENCH', 'strength', [ex(225, 5, 2)]), 5);
  assert.equal(a.stalled, false);
  assert.equal(a.regressed, false);
  assert.equal(a.rirDrift, false);
});

test('the score is clamped to 100', () => {
  // Stack everything heavy enough to exceed 100 pre-clamp.
  const big = [ex(315, 6, 0), ex(315, 3, 0), ex(315, 2, 0), ex(315, 2, 0), ex(315, 2, 0)];
  const out = computeFatigueScore({
    frequency_per_week: 6,
    lifts: [lift('A', 'strength', big), lift('B', 'strength', big), lift('C', 'strength', big)],
    recovery_reports: ['beat up', 'exhausted', 'sore', 'joint pain'],
    fatigue_exposure: { hard_sets: 30, failure_sets: 8, block_length_sessions: 12 }
  });
  assert.ok(out.score <= 100);
});

test('SIGNAL_WEIGHTS keeps F below the normal-coaching ceiling', () => {
  // Structural guarantee behind "F alone cannot trigger a deload."
  assert.ok(SIGNAL_WEIGHTS.F_FATIGUE_EXPOSURE < 50);
});
