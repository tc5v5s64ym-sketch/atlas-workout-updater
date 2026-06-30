'use strict';

// ProgressionModule — pure progression recommendation engine.
// Combines ProgressionRulesModule (scenario → action) with IntensityModule
// (weight math) to produce structured progression recommendations.
// No Sheets access, no side effects, no LLM involvement.
//
// Prime directive: the engine computes the numbers; the LLM only words them.

const {
  getScenario,
  getLeverOrder,
  getIncrements,
} = require('./progressionRulesModule');

const { estimateE1RM, targetWeightForRIR } = require('./intensityModule');

// Round to the nearest plate-friendly increment (default 2.5 lb).
function _roundToNearest(value, increment) {
  return Math.round(value / increment) * increment;
}

// Compute a load step (positive = increase, negative = decrease) for a given
// weight and body region, using the minimum default increment.
// Returns the step value in the same units as currentWeight (lb).
function computeLoadStep(currentWeight, bodyRegion, direction) {
  if (typeof currentWeight !== 'number' || currentWeight <= 0) return null;
  if (direction !== 'up' && direction !== 'down') return null;

  const increments = getIncrements();
  let delta;

  if (bodyRegion === 'lower_body') {
    delta = increments.lower_body_lb[0]; // 5 lb
  } else {
    // upper_body: percentage of current weight, rounded to nearest 2.5 lb
    const pct = increments.upper_body_pct[0] / 100; // 2.5%
    delta = _roundToNearest(currentWeight * pct, 2.5);
    if (delta < 2.5) delta = 2.5; // floor at one small plate
  }

  return direction === 'up' ? delta : -delta;
}

// Produce a structured progression recommendation given a pre-classified
// scenario id and the current set context.
//
// context: {
//   currentWeight  — number, lb, required
//   currentReps    — number, required
//   currentRIR     — number (0–10), required
//   bodyRegion     — 'upper_body' | 'lower_body', default 'upper_body'
//   e1rm           — number, optional (estimated from weight/reps/RIR if absent)
// }
//
// Returns:
// {
//   scenarioId, default_action, lever,
//   targetWeight, targetReps,
//   rationale
// }
// or null if scenarioId or context is invalid.
function recommendProgression(scenarioId, context) {
  const scenario = getScenario(scenarioId);
  if (!scenario) return null;

  if (!context || typeof context !== 'object') return null;
  const {
    currentWeight,
    currentReps,
    currentRIR,
    bodyRegion = 'upper_body',
  } = context;

  if (typeof currentWeight !== 'number' || currentWeight <= 0) return null;
  if (typeof currentReps !== 'number' || !Number.isInteger(currentReps) || currentReps < 1) return null;
  if (typeof currentRIR !== 'number' || currentRIR < 0) return null;

  const result = {
    scenarioId,
    default_action: scenario.default_action,
    lever: getLeverOrder()[0], // default first lever (load)
    targetWeight: null,
    targetReps: null,
    rationale: null,
  };

  const increments = getIncrements();

  switch (scenario.default_action) {
    case 'increase_load': {
      // Prefer e1RM-derived target if RIR > 0; fall back to increment step.
      const e1rm = (typeof context.e1rm === 'number' && context.e1rm > 0)
        ? context.e1rm
        : estimateE1RM(currentWeight, currentReps);
      let targetW;
      if (currentRIR > 0) {
        // Target the same reps at one less RIR as a load-increase signal
        targetW = targetWeightForRIR(e1rm, currentReps, Math.max(0, currentRIR - 1));
      }
      // If the e1RM-derived step is smaller than the min increment, use the increment instead
      const step = computeLoadStep(currentWeight, bodyRegion, 'up');
      const incrementTarget = currentWeight + step;
      result.targetWeight = (targetW && targetW >= incrementTarget)
        ? _roundToNearest(targetW, bodyRegion === 'lower_body' ? 5 : 2.5)
        : incrementTarget;
      result.lever = 'load';
      const label = bodyRegion === 'lower_body'
        ? `${increments.lower_body_lb[0]} lb`
        : `${increments.upper_body_pct[0]}%`;
      result.rationale = `Underloaded — add load (min increment: ${label})`;
      break;
    }

    case 'maintain_or_add_reps': {
      result.lever = 'reps';
      result.targetWeight = currentWeight;
      result.targetReps = currentReps + 1;
      result.rationale = 'On target — add one rep before increasing load';
      break;
    }

    case 'hold_progression': {
      result.lever = 'none';
      result.targetWeight = currentWeight;
      result.targetReps = currentReps;
      result.rationale = 'Normal session variability — hold current parameters';
      break;
    }

    case 'hold_or_reduce_load': {
      result.lever = 'load';
      const step = computeLoadStep(currentWeight, bodyRegion, 'down');
      result.targetWeight = Math.max(0, currentWeight + step); // step is negative
      result.rationale = 'Fatigue signal — hold or reduce load to protect recovery';
      break;
    }

    case 'swap_exercise_or_reduce_rom': {
      result.lever = 'none';
      result.rationale = 'Injury signal — substitute exercise or reduce range of motion; do not increase load';
      break;
    }

    case 'change_variant_reps_or_volume': {
      result.lever = 'none';
      result.rationale = 'Plateau candidate — change variant, rep scheme, or volume before retrying load progression';
      break;
    }

    default: {
      result.lever = 'none';
      result.rationale = scenario.default_action;
    }
  }

  return result;
}

module.exports = {
  recommendProgression,
  computeLoadStep,
};
