const { test } = require('node:test');
const assert = require('node:assert/strict');

const { recommendNextSet } = require('../services/analytics');
const { computeBenchmark } = require('../services/exerciseBenchmark');

// Owner RIR contract (2026-06-25):
//  1/2. RIR is optional — never required for saving (write-path; see api-smoke).
//  3.   Warm-up status comes from explicit markers, NOT from a missing RIR.
//  4.   Missing RIR reduces confidence in effort-based recs, never blocks logging.
// This file locks clauses 3 & 4 (read/recommendation side) against regression.

// 12-col Log_Cleaned row
const row = (session, weight, reps, rir, notes = '') =>
  ['2026-06-10', session, 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', weight, reps, rir, notes, ''];

// --- Clause 4: missing RIR → still recommends, with reduced confidence ---

test('recommendNextSet: a set logged without RIR still produces a recommendation (not blocked)', () => {
  const rec = recommendNextSet([row('S1', 225, 5, '')], 'BEN01', { today: '2026-06-11' });
  assert.ok(rec && rec.recommendation, 'a recommendation is produced even with no RIR');
  assert.equal(rec.confidence, 'low', 'missing RIR reduces confidence');
});

test('recommendNextSet: confidence is higher when RIR is present than when it is missing', () => {
  const withRir = recommendNextSet([row('S1', 225, 5, 2), row('S2', 225, 5, 2)], 'BEN01', { today: '2026-06-11' });
  const noRir = recommendNextSet([row('S1', 225, 5, '')], 'BEN01', { today: '2026-06-11' });
  assert.equal(withRir.confidence, 'high');
  assert.equal(noRir.confidence, 'low');
});

test('recommendNextSet (just-logged, no RIR): asks for RIR to tune, low confidence, never blocks', () => {
  const rec = recommendNextSet([row('S1', 225, 5, '')], 'BEN01', {
    today: '2026-06-11',
    justLoggedSet: { weight: 225, reps: 5, rir: null }
  });
  assert.ok(rec.recommendation, 'still recommends');
  assert.equal(rec.confidence, 'low');
});

// --- Clause 3: warm-up status from explicit markers, not from a missing RIR ---

test('computeBenchmark: a heavy set with MISSING RIR (no warm-up note) counts as a working set', () => {
  // 225 has no RIR and no warm-up note → it is a working set (missing RIR alone
  // must not infer warm-up). 135 carries an explicit "warm-up" note → excluded.
  const b = computeBenchmark('BEN01', [row('S1', 225, 5, ''), row('S1', 135, 10, '', 'warm-up')]);
  assert.equal(b.recentBest, 225, 'the missing-RIR working set is counted, not treated as a warm-up');
});

test('computeBenchmark: explicit warm-up note IS excluded even when it is the heaviest set', () => {
  // The only thing that makes a set a warm-up is the explicit marker — here the
  // heaviest (250) is note-tagged, so the working best is the 245.
  const b = computeBenchmark('BEN01', [row('S1', 250, 3, '', 'warm-up'), row('S1', 245, 5, 2)]);
  assert.equal(b.recentBest, 245);
});
