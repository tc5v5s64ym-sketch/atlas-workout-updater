'use strict';

// Scenario Classifier — keystone #1 of the One-Brain engine.
//
// Pure facts → progression scenario_id. Maps a lift's derived state (e1RM trend,
// plateau, readiness, injury) to one of the six scenarios in
// config/coaching/rules/progression.rules.json, so
// progressionModule.recommendProgression can be driven by real data — it
// otherwise requires a scenario handed in, which nothing produced (the keystone
// gap). No I/O, no LLM, no Sheets, no write.
//
// Safety-first precedence (mirrors the decision table's evidence tiers):
//   injury (tier 1) > plateau > fatigue (readiness/declining) > progression state.
//
// Spec: docs/COACHING_ENGINE_ARCHITECTURE.md (Scenario Classifier keystone)
//
// classifyScenario(params) → { scenario_id, rationale } | null
//   params: {
//     liftState,       // userStateModule lift state: { e1rm: { trend, sessionsTracked }, ... }
//     plateau,         // expectedPerformanceModule plateau object (truthy) | null
//     readiness,       // { tier: 'high'|'moderate'|'low' } | null
//     injury,          // truthy injury/pain signal (e.g. envelope constraint) | null
//     overperforming,  // true when actual output beats expected at prescribed effort
//   }

// The six scenario ids (must match progressionRulesModule.getAllScenarioIds();
// a test guards the alignment so this never drifts from the rules config).
const SCENARIOS = Object.freeze({
  UNDERLOADED:        'underloaded',
  ON_TARGET:          'on_target',
  NORMAL_VARIABILITY: 'normal_variability',
  LIKELY_FATIGUE:     'likely_fatigue',
  INJURY_SIGNAL:      'injury_signal',
  CANDIDATE_PLATEAU:  'candidate_plateau',
});

function _hasUsableTrend(liftState) {
  const e = liftState && typeof liftState === 'object' ? liftState.e1rm : null;
  if (!e || typeof e !== 'object') return false;
  return typeof e.trend === 'string' && e.trend !== 'insufficient_data'
      && typeof e.sessionsTracked === 'number' && e.sessionsTracked >= 2;
}

/**
 * Classify the progression scenario for a lift. Returns null when there is not
 * enough signal to classify (no injury and no usable e1RM trend).
 */
function classifyScenario(params) {
  if (!params || typeof params !== 'object') return null;
  const { liftState, plateau, readiness, injury, overperforming } = params;

  // 1. Injury — highest precedence; classifiable even without a trend.
  if (injury) {
    const which = typeof injury === 'string' ? injury : 'reported';
    return { scenario_id: SCENARIOS.INJURY_SIGNAL,
             rationale: `Injury/pain signal (${which}) — reduce ROM or swap the movement before loading.` };
  }

  // Everything else requires a usable e1RM trend.
  if (!_hasUsableTrend(liftState)) return null;
  const trend = liftState.e1rm.trend;

  // 2. Plateau — stale stimulus across multiple exposures.
  if (plateau) {
    return { scenario_id: SCENARIOS.CANDIDATE_PLATEAU,
             rationale: 'Underperforming expected output across exposures — candidate plateau; change variant, reps, or volume.' };
  }

  // 3. Fatigue — low readiness or a declining e1RM trajectory.
  if (readiness && readiness.tier === 'low') {
    return { scenario_id: SCENARIOS.LIKELY_FATIGUE,
             rationale: 'Low readiness — likely fatigue; hold or reduce load this session.' };
  }
  if (trend === 'declining') {
    return { scenario_id: SCENARIOS.LIKELY_FATIGUE,
             rationale: 'Declining e1RM trajectory — likely fatigue or over-prescription; hold or reduce load.' };
  }

  // 4. Progression state.
  if (overperforming === true) {
    return { scenario_id: SCENARIOS.UNDERLOADED,
             rationale: 'Beating expected output at prescribed effort — underloaded; increase load.' };
  }
  if (trend === 'improving') {
    return { scenario_id: SCENARIOS.ON_TARGET,
             rationale: 'Improving on plan — on target; maintain or add reps.' };
  }
  // trend === 'stalling' — within tolerance but off the top of range.
  return { scenario_id: SCENARIOS.NORMAL_VARIABILITY,
           rationale: 'Within tolerance but short of the top of range — normal variability; hold progression.' };
}

module.exports = { classifyScenario, SCENARIOS };
