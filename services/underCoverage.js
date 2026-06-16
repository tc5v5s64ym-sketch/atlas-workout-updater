'use strict';

// Under-coverage signal engine. Pure, read-only.
//
// Computes how well each of the 17 taxonomy muscles is trained over a rolling
// window (default 7 days) by comparing weekly effective sets from the log
// against coaching target ranges. Returns a record for every muscle so callers
// can filter by status — e.g. only surface the `under` ones to the user.
//
// Effective-set credit follows weeklyMuscleVolume: 1.0/set for primary muscles,
// 0.5/set for secondary. Targets are conservative MEV-style minimums calibrated
// for a 1–3×/week recreational lifter — they are intentionally modest so the
// signal only fires on genuine gaps, not routine-by-routine fluctuation.

const { weeklyMuscleVolume } = require('./muscleVolume');
const { TAXONOMY } = require('./muscleCoverage');

// Per-muscle target ranges (effective sets / 7-day window).
// min = Minimum Effective Volume: below this is a genuine training gap.
// max = approximate ceiling above which more volume adds little and may impede.
const MUSCLE_TARGETS = {
  chest:       { min: 4, max: 12 },
  front_delts: { min: 2, max:  6 },
  side_delts:  { min: 3, max:  8 },
  rear_delts:  { min: 3, max:  8 },
  traps:       { min: 2, max:  6 },
  lats:        { min: 4, max: 10 },
  upper_back:  { min: 3, max:  8 },
  lower_back:  { min: 2, max:  6 },
  biceps:      { min: 3, max:  8 },
  triceps:     { min: 3, max:  8 },
  forearms:    { min: 2, max:  6 },
  quads:       { min: 4, max: 12 },
  hamstrings:  { min: 3, max:  8 },
  glutes:      { min: 3, max:  8 },
  calves:      { min: 2, max:  6 },
  abs:         { min: 2, max:  6 },
  obliques:    { min: 1, max:  4 },
};

// Stable ordered list for consistent output ordering.
const TAXONOMY_LIST = [...TAXONOMY];

// Guard: every taxonomy muscle must have a target — catch drift at module load.
for (const muscle of TAXONOMY_LIST) {
  if (!MUSCLE_TARGETS[muscle]) {
    throw new Error(`underCoverage: no target defined for taxonomy muscle "${muscle}"`);
  }
}

// Build a human-readable reason string for each status.
function buildReason(muscle, sets, min, max, status) {
  if (status === 'under') {
    if (sets === 0) return `No effective sets this week for ${muscle} — aim for at least ${min}.`;
    const s = sets === 1 ? 'set' : 'sets';
    return `Only ${sets} effective ${s} this week for ${muscle} — aim for at least ${min}.`;
  }
  if (status === 'optimal') {
    return `${sets} effective sets this week for ${muscle} — at or above the ${max}-set ceiling.`;
  }
  return `${sets} effective sets this week for ${muscle} — within the ${min}–${max} target range.`;
}

// Compute under-coverage for every taxonomy muscle.
//
// logRows   — raw log rows (array-of-arrays or array-of-objects)
// options.days  — rolling window size (default 7)
// options.today — YYYY-MM-DD anchor for the window (default: real "now")
//
// Returns an array of 17 records in taxonomy order:
//   { muscle, currentEffectiveSets, targetRange: { min, max }, status, reason }
// status ∈ { 'under' | 'adequate' | 'optimal' }
function computeUnderCoverage(logRows, options = {}) {
  const { days = 7, today = null } = options || {};
  const volume = weeklyMuscleVolume(logRows, { days, today });

  return TAXONOMY_LIST.map(muscle => {
    const eff = (volume[muscle] && volume[muscle].totalEffectiveSets) || 0;
    const { min, max } = MUSCLE_TARGETS[muscle];

    const status = eff < min ? 'under' : eff < max ? 'adequate' : 'optimal';
    const reason = buildReason(muscle, eff, min, max, status);

    return {
      muscle,
      currentEffectiveSets: eff,
      targetRange: { min, max },
      status,
      reason,
    };
  });
}

module.exports = { computeUnderCoverage, MUSCLE_TARGETS };
