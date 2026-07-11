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
const { isRedundantWithAny } = require('./substitutionRedundancy');

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
// Catalog discipline: only include candidates with a clear pattern connection.
//   - Same fine-grained pattern preferred (excellent tier).
//   - Same broad region, different pattern is acceptable when closely related.
//   - Cross-region and compound→isolation candidates are excluded even if the
//     quality scorer would allow them via the broad-region fallback — the fallback
//     exists as a safety net, not as a recommendation signal.
// Overhead Press → Bench Press: same push region, different pattern (vertical→horizontal).
//   Retained as the only viable "push" sub when no vertical-push alternative is available,
//   but it is explicitly cross-pattern (acceptable-not-ideal).
const RAW_CATALOG = {
  'Deadlift':           ['Romanian Deadlift', 'Good Morning'],
  'Romanian Deadlift':  ['Deadlift', 'Good Morning'],
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
 * @param {{ avoid?: string[] }} [opts] - CONTEXT: exercise names already in the
 *        remaining workout (esp. the next planned slot). An acceptable candidate that
 *        is redundant with any of them (same exercise / alias / unilateral-bilateral
 *        variant / same movement family — services/substitutionRedundancy) is skipped
 *        in favor of a valid non-redundant one. When every acceptable candidate is
 *        redundant, the best is still returned (a valid-but-redundant sub beats none).
 *        Omitting opts preserves the original context-free selection exactly.
 * @returns {{
 *   recommendation: string,
 *   quality:        'excellent'|'acceptable',
 *   reason:         string
 * }|null}  null when no acceptable substitute is known.
 */
function recommendSubstitute(prescribed, opts = {}) {
  const name = prescribed && typeof prescribed === 'string'
    ? prescribed
    : (prescribed && prescribed.name) || '';

  if (!name) return null;

  const candidates = SUBSTITUTE_CATALOG[name.toLowerCase().trim()];
  if (!candidates || !candidates.length) return null;

  const avoid = opts && Array.isArray(opts.avoid) ? opts.avoid.filter(Boolean) : [];

  // Score every acceptable+ candidate, flagging redundancy with the remaining plan.
  // List order is the preference tiebreaker (first listed wins among equal quality),
  // exactly as before.
  const scored = [];
  for (const candidate of candidates) {
    const s = scoreSubstitutionQuality(name, candidate);
    const rank = QUALITY_RANK[s.quality] ?? -1;
    if (rank < MIN_QUALITY_RANK) continue;
    scored.push({ candidate, rank, quality: s.quality, reason: buildReason(s), redundant: avoid.length ? isRedundantWithAny(candidate, avoid) : false });
  }
  if (!scored.length) return null;

  // Prefer non-redundant acceptable candidates; if all are redundant, keep them all
  // (never regress to a skip). Then pick the highest quality, list order breaking ties.
  const pool = scored.some(c => !c.redundant) ? scored.filter(c => !c.redundant) : scored;
  let best = null;
  for (const c of pool) {
    if (!best || c.rank > best.rank) best = c;   // strict > → list order breaks ties
    if (best.rank >= QUALITY_RANK['excellent']) break;
  }

  return { recommendation: best.candidate, quality: best.quality, reason: best.reason };
}

module.exports = { recommendSubstitute, SUBSTITUTE_CATALOG };
