'use strict';

// Substitution Recommender
//
// Deterministic. Pure function. No I/O, no LLM, no sheet writes.
// Given a prescribed exercise that is unavailable, returns the best known
// substitute from a curated catalog, scored by scoreSubstitutionQuality.
//
// Only recommends 'excellent' or 'acceptable' quality alternatives — never
// 'poor' or 'unknown'. Returns null when no suitable substitute is found.
//
// Spec example:
//   recommendSubstitute('Deadlift') →
//     { recommendation: 'Romanian Deadlift', quality: 'excellent',
//       reason: 'Maintains the hip hinge pattern and training stimulus.' }

const { scoreSubstitutionQuality } = require('./substitutionQuality');

// Human-readable labels for the 14-pattern vocabulary.
const PATTERN_LABEL = {
  hinge:           'hip hinge',
  squat:           'squat',
  horizontal_push: 'horizontal push',
  vertical_push:   'vertical push',
  horizontal_pull: 'horizontal pull',
  vertical_pull:   'vertical pull',
  knee_isolation:  'knee isolation',
  hip_isolation:   'hip isolation',
  arm_isolation:   'arm isolation',
  delt_isolation:  'shoulder isolation',
  calf_isolation:  'calf isolation',
  trunk:           'core',
  carry:           'carry',
  other:           'other',
};

// Curated substitute candidates per exercise, ordered by preference.
// The quality scorer selects the best among them; list order breaks ties
// (first listed wins among equal-quality candidates).
const RAW_CATALOG = {
  'Deadlift':           ['Romanian Deadlift', 'Good Morning', 'Leg Press'],
  'Romanian Deadlift':  ['Deadlift', 'Good Morning', 'Leg Curl'],
  'Good Morning':       ['Romanian Deadlift', 'Deadlift'],
  'Back Squat':         ['Leg Press', 'Goblet Squat'],
  'Squat':              ['Leg Press', 'Goblet Squat'],
  'Leg Press':          ['Back Squat', 'Goblet Squat'],
  'Goblet Squat':       ['Leg Press', 'Back Squat'],
  'Bench Press':        ['Incline Press', 'Dips', 'Chest Fly'],
  'Incline Press':      ['Bench Press', 'Dips'],
  'Overhead Press':     ['Bench Press', 'Dips'],
  'Lat Pulldown':       ['Pull-up', 'Seated Row'],
  'Pull-up':            ['Lat Pulldown', 'Seated Row'],
  'Barbell Row':        ['Seated Row', 'Lat Pulldown'],
  'Seated Row':         ['Barbell Row', 'Lat Pulldown'],
};

// Minimum quality rank to recommend (0=poor, 1=acceptable, 2=excellent).
const MIN_QUALITY_RANK = 1;
const QUALITY_RANK = { excellent: 2, acceptable: 1, poor: 0, unknown: -1 };

// Normalize catalog keys to lowercase for case-insensitive lookup.
const SUBSTITUTE_CATALOG = Object.fromEntries(
  Object.entries(RAW_CATALOG).map(([k, v]) => [k.toLowerCase(), v])
);

function buildReason(scoreResult) {
  const { reason, prescribed, logged } = scoreResult;
  const pLabel = PATTERN_LABEL[prescribed.pattern] || prescribed.pattern;
  const lLabel = PATTERN_LABEL[logged.pattern]     || logged.pattern;

  switch (reason) {
    case 'same_pattern_same_cost':
      return `Maintains the ${pLabel} pattern and training stimulus.`;
    case 'same_pattern_lighter_compound':
      return `Preserves the ${pLabel} pattern with a lighter compound alternative.`;
    case 'same_region_different_pattern':
      return `Trains the same muscle region via the ${lLabel} pattern.`;
    default:
      return 'Best available alternative for this stimulus.';
  }
}

/**
 * Recommend the best known substitute for a prescribed exercise.
 *
 * @param {string|{name:string}} prescribed - The exercise that cannot be performed.
 * @returns {{
 *   recommendation: string,
 *   quality:        'excellent'|'acceptable',
 *   reason:         string
 * }|null}  null when no acceptable substitute is known.
 */
function recommendSubstitute(prescribed) {
  const name = prescribed && typeof prescribed === 'string'
    ? prescribed
    : (prescribed && prescribed.name) || '';

  if (!name) return null;

  const candidates = SUBSTITUTE_CATALOG[name.toLowerCase().trim()];
  if (!candidates || !candidates.length) return null;

  let best     = null;
  let bestRank = MIN_QUALITY_RANK - 1;

  for (const candidate of candidates) {
    const scored = scoreSubstitutionQuality(name, candidate);
    const rank   = QUALITY_RANK[scored.quality] ?? -1;
    if (rank > bestRank) {
      bestRank = rank;
      best     = {
        recommendation: candidate,
        quality:        scored.quality,
        reason:         buildReason(scored),
      };
    }
    if (bestRank >= QUALITY_RANK['excellent']) break;
  }

  return best;
}

module.exports = { recommendSubstitute, SUBSTITUTE_CATALOG };
