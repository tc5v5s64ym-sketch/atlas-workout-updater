'use strict';

// Session Objective Scoring — Session Planning Engine §3 (PR 479).
//
// PURE. The deterministic weights + the combine/select formula the daily planner
// uses to pick the best session objective. This slice ships the SCORING CONTRACT
// (the frozen weights + how term sub-scores combine into a single objective score
// and how the winner is selected) so it is FIXTURE-PROTECTED before the scorer
// that computes the term sub-scores ships (PR 480). A weight change is therefore a
// visible, test-gated decision — never a silent drift (§3).
//
// No I/O, no LLM, no Sheets, NO write path, NO Log_Cleaned schema change. The term
// sub-scores (profile_match, recovery_fit, …) are computed elsewhere (PR 480) from
// real inputs; this module only combines and ranks them.

// The ten supported session objectives (§4). Frozen; the planner selects exactly
// one per day.
const SESSION_OBJECTIVES = Object.freeze([
  'strength_progression',
  'hypertrophy_volume',
  'general_fitness_balanced',
  'cardio_base',
  'cardio_intervals',
  'bodyweight_strength',
  'circuit_conditioning',
  'skill_practice',
  'recovery_reload',
  'deload',
]);

// Initial deterministic weights (§3). Positive terms are fits (higher = better);
// the two `*_conflict` terms are PENALTIES (negative weight). Frozen so any change
// trips the golden tests below.
const OBJECTIVE_WEIGHTS = Object.freeze({
  profile_match: 0.30,
  goal_match: 0.15,
  equipment_fit: 0.10,
  time_fit: 0.10,
  recovery_fit: 0.15,
  adherence_fit: 0.10,
  movement_balance_need: 0.10,
  pain_conflict: -0.10,
  fatigue_conflict: -0.10,
});

// The term names, split by sign — used for validation + explainability.
const FIT_TERMS = Object.freeze(Object.keys(OBJECTIVE_WEIGHTS).filter(k => OBJECTIVE_WEIGHTS[k] > 0));
const PENALTY_TERMS = Object.freeze(Object.keys(OBJECTIVE_WEIGHTS).filter(k => OBJECTIVE_WEIGHTS[k] < 0));

// Clamp a term sub-score into the documented [0,1] range; a missing/NaN term is 0
// (a term that wasn't computed contributes nothing — it never fabricates signal).
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Per-term contributions (weight × clamped sub-score) for a feature vector.
 * Pure; the basis of the explainable score. Unknown keys in `features` are ignored.
 * @param {Object<string,number>} features  term name → sub-score in [0,1]
 * @returns {Object<string,number>} term name → signed contribution
 */
function explainObjectiveScore(features) {
  const f = features && typeof features === 'object' ? features : {};
  const out = {};
  for (const term of Object.keys(OBJECTIVE_WEIGHTS)) {
    out[term] = round4(OBJECTIVE_WEIGHTS[term] * clamp01(f[term]));
  }
  return out;
}

/**
 * Combine a feature vector into a single objective score via the §3 weighted sum.
 * @param {Object<string,number>} features  term name → sub-score in [0,1]
 * @returns {number} the objective score (rounded to 4 dp)
 */
function combineObjectiveScore(features) {
  const contributions = explainObjectiveScore(features);
  let score = 0;
  for (const term of Object.keys(contributions)) score += contributions[term];
  return round4(score);
}

/**
 * Select the highest-scoring objective from candidates. Ties break by the
 * SESSION_OBJECTIVES declaration order (stable, deterministic).
 *
 * @param {Array<{objective:string, features:Object}>} candidates
 * @returns {{objective:string, score:number, contributions:Object}|null}
 */
function selectObjective(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const order = new Map(SESSION_OBJECTIVES.map((o, i) => [o, i]));
  let best = null;
  for (const c of candidates) {
    if (!c || typeof c.objective !== 'string') continue;
    const score = combineObjectiveScore(c.features);
    if (
      best === null ||
      score > best.score ||
      (score === best.score && (order.get(c.objective) ?? Infinity) < (order.get(best.objective) ?? Infinity))
    ) {
      best = { objective: c.objective, score, contributions: explainObjectiveScore(c.features) };
    }
  }
  return best;
}

module.exports = {
  SESSION_OBJECTIVES,
  OBJECTIVE_WEIGHTS,
  FIT_TERMS,
  PENALTY_TERMS,
  combineObjectiveScore,
  explainObjectiveScore,
  selectObjective,
};
