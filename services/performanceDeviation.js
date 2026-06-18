/* Performance deviation classification against expected performance.
 *
 * Pure function — no I/O, no LLM, no Sheets writes.
 *
 * classifyDeviation(logged, expected)
 *   logged   – object with numeric `reps` field (the set just logged)
 *   expected – return value of computeExpectedPerformance(), or null
 *
 * Returns:
 *   verdict   – 'above_expected' | 'on_target' | 'below_expected' | 'insufficient_data'
 *   delta     – logged.reps − expected.expectedReps (null when insufficient_data)
 *   magnitude – 'significant' (|delta| ≥ 4) | 'slight' (|delta| ≥ 2) | null (on_target)
 *
 * Thresholds:
 *   delta ≥ +2 → above_expected
 *   delta ≤ −2 → below_expected
 *   else       → on_target
 */
'use strict';

const ABOVE_THRESHOLD = 2;    // delta >= +2 → above_expected
const BELOW_THRESHOLD = -2;   // delta <= -2 → below_expected
const SIGNIFICANT_ABS = 4;    // |delta| >= 4 → significant

function classifyDeviation(logged, expected) {
  if (!expected || typeof expected !== 'object' || expected.expectedReps == null) {
    return { verdict: 'insufficient_data', delta: null, magnitude: null };
  }

  const loggedReps = logged && typeof logged === 'object' ? Number(logged.reps) : NaN;
  if (!Number.isFinite(loggedReps) || loggedReps <= 0) {
    return { verdict: 'insufficient_data', delta: null, magnitude: null };
  }

  const expectedReps = Number(expected.expectedReps);
  if (!Number.isFinite(expectedReps)) {
    return { verdict: 'insufficient_data', delta: null, magnitude: null };
  }

  const delta = loggedReps - expectedReps;

  let verdict;
  if (delta >= ABOVE_THRESHOLD) {
    verdict = 'above_expected';
  } else if (delta <= BELOW_THRESHOLD) {
    verdict = 'below_expected';
  } else {
    verdict = 'on_target';
  }

  const magnitude = verdict !== 'on_target'
    ? (Math.abs(delta) >= SIGNIFICANT_ABS ? 'significant' : 'slight')
    : null;

  return { verdict, delta, magnitude };
}

module.exports = { classifyDeviation };
