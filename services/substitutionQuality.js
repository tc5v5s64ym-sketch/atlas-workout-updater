'use strict';

// Substitution Quality Scorer
//
// Deterministic. Pure function. No I/O, no history, no constraints, no LLM.
// Rates how well a logged exercise preserves the stimulus of a prescribed one.
//
// Quality tiers:
//   excellent  — same movement pattern, no cost-tier drop (compound → compound);
//                for isolation → isolation, only when primary muscles overlap.
//   acceptable — same pattern but compound → lighter compound (e.g. Squat → Leg Press),
//                OR same broad training region with a different sub-pattern,
//                OR isolation → isolation with partial primary-muscle overlap.
//   poor       — same pattern but compound → isolation, completely different region,
//                OR isolation → isolation training a different muscle.
//   unknown    — either exercise is unrecognised (pattern === 'other' + needsReview).
//
// Spec examples:
//   Deadlift → Romanian Deadlift  = excellent   (hinge→hinge, HIGH→HIGH)
//   Back Squat → Leg Press        = acceptable  (squat→squat, HIGH→MEDIUM)
//   Bench Press → Pec Deck        = poor        (horizontal_push→horizontal_push, MEDIUM→LOW)
//   Leg Curl → Leg Extension      = poor        (knee_isolation both, but hamstrings vs quads)

const { patternFor } = require('./movementPattern');
const { costFor }    = require('./liftCost');
const { musclesFor } = require('./muscleCoverage');
const { BROAD_REGION, computePrimaryMuscleOverlap, OVERLAP_THRESHOLD } = require('./substitutionIntent');

// Numeric rank per cost tier — higher is more demanding/compound.
const COST_RANK = { high: 2, medium: 1, low: 0 };

function nameOf(ex) {
  if (!ex) return '';
  return typeof ex === 'string' ? ex : (ex.name || '');
}

/**
 * Rate the quality of a substitution pair.
 *
 * @param {string|{name:string}} prescribed  - The planned exercise.
 * @param {string|{name:string}} logged      - The exercise actually performed.
 * @returns {{
 *   quality:    'excellent'|'acceptable'|'poor'|'unknown',
 *   reason:     string,
 *   prescribed: { name, pattern, cost },
 *   logged:     { name, pattern, cost }
 * }}
 */
function scoreSubstitutionQuality(prescribed, logged) {
  const prescribedName = nameOf(prescribed);
  const loggedName     = nameOf(logged);

  if (!prescribedName || !loggedName) {
    return {
      quality: 'unknown',
      reason:  'missing_exercise_name',
      prescribed: { name: prescribedName, pattern: null, cost: null },
      logged:     { name: loggedName,     pattern: null, cost: null },
    };
  }

  const pResult     = patternFor(prescribedName);
  const lResult     = patternFor(loggedName);
  const pCostResult = costFor(prescribedName);
  const lCostResult = costFor(loggedName);

  const prescribedPattern = pResult.pattern;
  const loggedPattern     = lResult.pattern;
  const prescribedCost    = pCostResult.cost;
  const loggedCost        = lCostResult.cost;

  const info = {
    prescribed: { name: prescribedName, pattern: prescribedPattern, cost: prescribedCost },
    logged:     { name: loggedName,     pattern: loggedPattern,     cost: loggedCost },
  };

  // Either exercise unrecognised in pattern OR cost catalog → cannot score.
  // The two catalogs are maintained independently and can drift, so both are checked.
  if (pResult.needsReview || lResult.needsReview || pCostResult.needsReview || lCostResult.needsReview) {
    return { quality: 'unknown', reason: 'unrecognized_exercise', ...info };
  }

  const patternsMatch  = prescribedPattern === loggedPattern && prescribedPattern !== 'other';
  const prescribedRegion = BROAD_REGION[prescribedPattern] || 'other';
  const loggedRegion     = BROAD_REGION[loggedPattern]     || 'other';
  const sharedRegion     = prescribedRegion === loggedRegion && prescribedRegion !== 'other';

  const prescribedRank = COST_RANK[prescribedCost] ?? 0;
  const loggedRank     = COST_RANK[loggedCost]     ?? 0;

  if (patternsMatch) {
    // No cost-tier drop (or logged is heavier — unusual but valid).
    if (loggedRank >= prescribedRank) {
      // Isolation → isolation (both LOW): same pattern is not enough — two
      // isolations in the same pattern family can train opposite muscles
      // (e.g. Leg Curl=hamstrings vs Leg Extension=quads, both knee_isolation).
      // When both primary-muscle sets are known, grade by muscle overlap.
      if (prescribedCost === 'low' && loggedCost === 'low') {
        const prescribedPrimary = musclesFor(prescribedName).primary;
        const loggedPrimary     = musclesFor(loggedName).primary;
        if (prescribedPrimary.length && loggedPrimary.length) {
          const overlap = computePrimaryMuscleOverlap(prescribedPrimary, loggedPrimary);
          if (overlap >= OVERLAP_THRESHOLD) {
            return { quality: 'excellent', reason: 'same_pattern_same_muscle', ...info };
          }
          if (overlap > 0) {
            return { quality: 'acceptable', reason: 'isolation_partial_muscle_overlap', ...info };
          }
          return { quality: 'poor', reason: 'isolation_different_muscle', ...info };
        }
        // Muscle data missing for one side — can't assess; fall through to the
        // conservative same-pattern/same-cost grade below.
      }
      return { quality: 'excellent', reason: 'same_pattern_same_cost', ...info };
    }
    // Dropped a tier but still a compound (MEDIUM).
    if (loggedCost !== 'low') {
      return { quality: 'acceptable', reason: 'same_pattern_lighter_compound', ...info };
    }
    // Dropped to isolation (LOW) — same pattern family but different stimulus.
    return { quality: 'poor', reason: 'same_pattern_isolation', ...info };
  }

  // Different sub-pattern but same broad training region.
  if (sharedRegion) {
    return { quality: 'acceptable', reason: 'same_region_different_pattern', ...info };
  }

  // Completely different region — stimulus largely abandoned.
  return { quality: 'poor', reason: 'different_region', ...info };
}

module.exports = { scoreSubstitutionQuality };
