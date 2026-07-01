'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { lastWorkingSet, deriveLiftState, prescribeLift } = require('../services/liftPrescription');

const ASOF = '2026-06-30T14:00:00Z';

// 12-col: date|session|exercise|canonical|muscle|lift_code|set|weight|reps|rir|notes|vol
function row(date, sid, exercise, muscle, code, w) {
  return [date, sid, exercise, exercise, muscle, code, 1, w, 5, 2, '', w * 5];
}

// ─── lastWorkingSet bodyRegion (the dedupe-restored hinge case) ──────────────

describe('lastWorkingSet — bodyRegion classification', () => {
  it('a hinge-named exercise with a non-leg muscle group classifies lower_body', () => {
    // "Hip Hinge", muscle_group "posterior" (no leg token) — only the exercise-name
    // `hinge` token makes it lower_body. Guards the regex restored in the dedupe.
    const rows = [row('2026-06-01', 's1', 'Hip Hinge', 'posterior', 'HINGE', 135),
                  row('2026-06-04', 's2', 'Hip Hinge', 'posterior', 'HINGE', 140)];
    const set = lastWorkingSet(rows, 'HINGE', ASOF);
    assert.ok(set);
    assert.strictEqual(set.bodyRegion, 'lower_body');
  });

  it('a squat classifies lower_body; a bench classifies upper_body', () => {
    const squat = lastWorkingSet([row('2026-06-01', 's1', 'Back Squat', 'quads', 'SQUAT', 225)], 'SQUAT', ASOF);
    const bench = lastWorkingSet([row('2026-06-01', 's1', 'Bench Press', 'chest', 'BENCH', 185)], 'BENCH', ASOF);
    assert.strictEqual(squat.bodyRegion, 'lower_body');
    assert.strictEqual(bench.bodyRegion, 'upper_body');
  });

  it('takes the chronologically-most-recent set even when rows are out of order', () => {
    const rows = [row('2026-06-08', 's3', 'Bench Press', 'chest', 'BENCH', 215),
                  row('2026-06-01', 's1', 'Bench Press', 'chest', 'BENCH', 205)];
    assert.strictEqual(lastWorkingSet(rows, 'BENCH', ASOF).currentWeight, 215);
  });
});

// ─── guards ──────────────────────────────────────────────────────────────────

describe('liftPrescription — guards', () => {
  it('returns null without asOf / rows / liftCode', () => {
    assert.strictEqual(lastWorkingSet([], 'BENCH', ASOF), null);
    assert.strictEqual(deriveLiftState([row('2026-06-01', 's1', 'Bench Press', 'chest', 'BENCH', 185)], 'BENCH', null), null);
    assert.strictEqual(prescribeLift([], 'BENCH', ASOF, {}), null);
  });
  it('prescribeLift returns null when trend is insufficient (1 session)', () => {
    assert.strictEqual(prescribeLift([row('2026-06-01', 's1', 'Bench Press', 'chest', 'BENCH', 185)], 'BENCH', ASOF, {}), null);
  });
});

// ─── empty/blank numeric cells → NaN (not 0) ─────────────────────────────────

describe('normRow / lastWorkingSet — empty numeric cells normalize to NaN', () => {
  // 12-col row with an EMPTY RIR cell (index 9 = '').
  function rowEmptyRir(date, sid, w) {
    return [date, sid, 'Bench Press', 'Bench Press', 'chest', 'BENCH', 1, w, 5, '', '', w * 5];
  }
  it('an empty RIR cell yields currentRIR = NaN, not 0', () => {
    const set = lastWorkingSet([rowEmptyRir('2026-06-01', 's1', 185), rowEmptyRir('2026-06-04', 's2', 190)], 'BENCH', ASOF);
    assert.ok(set);
    assert.ok(Number.isNaN(set.currentRIR), `expected NaN, got ${set.currentRIR}`);
  });
  it('prescribeLift rejects an unlogged RIR (→ null, i.e. clarification) rather than reading it as at-failure', () => {
    // Enough sessions for a trend, but the most-recent set has no RIR.
    const rows = [
      [ '2026-06-01', 's1', 'Bench Press', 'Bench Press', 'chest', 'BENCH', 1, 185, 5, 2, '', 925 ],
      [ '2026-06-04', 's2', 'Bench Press', 'Bench Press', 'chest', 'BENCH', 1, 190, 5, 2, '', 950 ],
      rowEmptyRir('2026-06-08', 's3', 195),
    ];
    assert.strictEqual(prescribeLift(rows, 'BENCH', ASOF, {}), null);
  });
});
