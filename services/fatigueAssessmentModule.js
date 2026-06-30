'use strict';

// FatigueAssessmentModule — composite fatigue/recovery engine.
// Combines FatigueRulesModule (recovery priors, readiness config, deload triggers)
// with input signals to produce structured assessments.
// No Sheets access, no side effects, no LLM involvement.
//
// Prime directive: the engine computes the numbers; the LLM only words them.

const {
  getRecoveryPriors,
  getReadinessInputs,
  getDeloadTriggers,
} = require('./fatigueRulesModule');

// Input directionality: 1 = higher raw value means better readiness,
// -1 = higher raw value means worse readiness.
const INPUT_DIRECTION = {
  sleep: 1,        // 0=poor, 10=excellent
  soreness: -1,    // 0=none, 10=severe
  stress: -1,      // 0=calm, 10=high
  motivation: 1,   // 0=none, 10=high
  recent_load: -1, // 0=light, 10=heavy
  hrv: 1,          // 0=poor, 10=excellent
};

const WEIGHT_MULTIPLIER = { high: 3, medium: 2, low: 1 };

function _scoreTier(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'moderate';
  return 'low';
}

// Assess muscle recovery status given a muscle category and hours since the last
// training session that stressed that category.
//
// muscleCategory: 'small_muscles' | 'large_compound' | 'heavy_eccentric_or_to_failure'
// hoursSinceLastSession: number >= 0
//
// Returns:
// {
//   status: 'recovered' | 'possibly_recovering' | 'likely_underrecovered',
//   hoursLeft: number (0 when recovered),
//   recoveryWindow: [minHours, maxHours]
// }
// or null for invalid inputs.
function assessRecovery(muscleCategory, hoursSinceLastSession) {
  if (typeof hoursSinceLastSession !== 'number' || Number.isNaN(hoursSinceLastSession) || hoursSinceLastSession < 0) return null;

  const priors = getRecoveryPriors();
  const window = priors[muscleCategory];
  if (!Array.isArray(window) || window.length < 2) return null;

  const [minHours, maxHours] = window;

  let status;
  let hoursLeft;
  if (hoursSinceLastSession >= maxHours) {
    status = 'recovered';
    hoursLeft = 0;
  } else if (hoursSinceLastSession >= minHours) {
    status = 'possibly_recovering';
    hoursLeft = maxHours - hoursSinceLastSession;
  } else {
    status = 'likely_underrecovered';
    hoursLeft = minHours - hoursSinceLastSession;
  }

  return { status, hoursLeft, recoveryWindow: window };
}

// Score composite readiness from raw 0–10 input values.
//
// inputValues: {
//   sleep?       0-10 (0=poor sleep, 10=excellent)
//   soreness?    0-10 (0=none, 10=severe)
//   stress?      0-10 (0=calm, 10=high stress)
//   motivation?  0-10 (0=none, 10=high)
//   recent_load? 0-10 (0=light, 10=very heavy)
//   hrv?         0-10 (0=poor, 10=excellent relative to personal baseline)
// }
// Unknown or absent keys are skipped; out-of-range or non-number values are skipped.
//
// Returns:
// {
//   score: 0–100 or null (null = no valid inputs provided),
//   tier: 'low' | 'moderate' | 'high' | null,
//   inputsUsed: string[],
//   inputsAbsent: string[],
//   confidence: 'low' | 'moderate' | 'high'
// }
function scoreReadiness(inputValues) {
  const inputs = getReadinessInputs();
  const allKeys = inputs.map(i => i.key);

  if (!inputValues || typeof inputValues !== 'object') {
    return { score: null, tier: null, inputsUsed: [], inputsAbsent: allKeys, confidence: 'low' };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  const inputsUsed = [];
  const inputsAbsent = [];

  for (const input of inputs) {
    const { key, weight_hint } = input;
    const raw = inputValues[key];
    const weight = WEIGHT_MULTIPLIER[weight_hint] ?? 1;

    if (raw == null || typeof raw !== 'number' || Number.isNaN(raw) || raw < 0 || raw > 10) {
      inputsAbsent.push(key);
      continue;
    }

    const direction = INPUT_DIRECTION[key] ?? 1;
    const normalized = direction === 1 ? raw : (10 - raw);
    weightedSum += normalized * weight;
    totalWeight += 10 * weight;
    inputsUsed.push(key);
  }

  if (inputsUsed.length === 0) {
    return { score: null, tier: null, inputsUsed: [], inputsAbsent: allKeys, confidence: 'low' };
  }

  const score = Math.round((weightedSum / totalWeight) * 100);
  const tier = _scoreTier(score);
  const confidence =
    inputsUsed.length >= 4 ? 'high' :
    inputsUsed.length >= 2 ? 'moderate' : 'low';

  return { score, tier, inputsUsed, inputsAbsent, confidence };
}

// Evaluate whether a deload is warranted based on training age and active signals.
//
// weeksSinceDeload: number >= 0 (weeks since last deload; 0 = just deloaded)
// activeTriggerKeys: string[] — which autoregulated trigger descriptions are active.
//   These should be strings from getDeloadTriggers().autoregulated_any_two,
//   but the function only counts them — it does not validate against the config list.
//
// Returns:
// {
//   plannedDeloadDue: boolean,
//   autoregulatedTriggersFired: number,
//   deloadWarranted: boolean,
//   reason: 'planned' | 'autoregulated' | 'both' | 'none',
//   triggersPresent: string[],
//   weeksSinceDeload: number
// }
// or null for invalid weeksSinceDeload.
function checkDeloadTriggers(weeksSinceDeload, activeTriggerKeys = []) {
  if (typeof weeksSinceDeload !== 'number' || Number.isNaN(weeksSinceDeload) || weeksSinceDeload < 0) return null;

  const triggers = getDeloadTriggers();
  const [plannedMin] = triggers.planned_every_weeks;
  const plannedDeloadDue = weeksSinceDeload >= plannedMin;

  const keys = Array.isArray(activeTriggerKeys) ? activeTriggerKeys : [];
  const autoregulatedTriggersFired = keys.length;
  const autoregulatedWarranted = autoregulatedTriggersFired >= 2;

  const deloadWarranted = plannedDeloadDue || autoregulatedWarranted;
  const reason =
    plannedDeloadDue && autoregulatedWarranted ? 'both' :
    plannedDeloadDue ? 'planned' :
    autoregulatedWarranted ? 'autoregulated' : 'none';

  return {
    plannedDeloadDue,
    autoregulatedTriggersFired,
    deloadWarranted,
    reason,
    triggersPresent: keys,
    weeksSinceDeload,
  };
}

module.exports = {
  assessRecovery,
  scoreReadiness,
  checkDeloadTriggers,
};
