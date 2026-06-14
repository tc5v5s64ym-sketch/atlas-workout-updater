'use strict';

/**
 * Day-of-session autoregulation — deterministic and pure.
 *
 * This is intentionally SEPARATE from planned progression (recommendationPolicy). Planned
 * progression decides what to walk in with; autoregulation reacts to what actually happened on the
 * set in front of you (RIR overshoot/undershoot, bar speed, pain). It owns no history and performs
 * no I/O. The rule engine still owns the numbers; this only suggests a bounded next-set adjustment.
 */

const AUTOREG_REASON_CODES = Object.freeze({
  PAIN_REGRESS: 'autoreg_pain_regress',
  POWER_PROTECT_SPEED: 'autoreg_power_protect_speed',
  REDUCE_LOAD_RIR_OVERSHOOT: 'autoreg_reduce_load_rir_overshoot',
  INCREASE_LOAD_RIR_UNDERSHOOT: 'autoreg_increase_load_rir_undershoot',
  TECHNIQUE_GATES_LOAD: 'autoreg_technique_gates_load',
  ON_TARGET: 'autoreg_on_target',
});

const DEFAULT_PAIN_THRESHOLD = 3;   // on a 0–10 pain scale
const HIGH_VELOCITY_LOSS_PCT = 20;  // bar-speed drop that should end a power set
const LOAD_STEP_DOWN_PCT = -5;      // "reduce 2–5%" — use the safe end of the band
const LOAD_STEP_UP_PCT = 3;         // "increase 2–5%" — conservative default

function midpointRIR(targetRIR) {
  if (Number.isFinite(targetRIR)) return targetRIR;
  if (targetRIR && Number.isFinite(targetRIR.min) && Number.isFinite(targetRIR.max)) {
    return (targetRIR.min + targetRIR.max) / 2;
  }
  return null;
}

function adjustedLoad(currentLoad, pct) {
  if (!Number.isFinite(currentLoad) || !Number.isFinite(pct)) return undefined;
  return Math.round(currentLoad * (1 + pct / 100) * 10) / 10;
}

/**
 * @param {object} input
 * @param {string} [input.goal]            - canonical goal id (e.g. 'power')
 * @param {number|{min:number,max:number}} [input.targetRIR] - planned RIR (scalar or range)
 * @param {number} [input.actualRIR]       - RIR actually achieved on the set
 * @param {boolean} [input.techniqueSolid=true]
 * @param {number} [input.velocityLossPct] - bar-speed loss on the set, percent
 * @param {boolean} [input.repsGrindy=false]
 * @param {number} [input.painLevel]       - 0–10
 * @param {number} [input.painThreshold=3]
 * @param {number} [input.currentLoad]     - for computing a suggestedLoad
 * @returns {{action:string, loadAdjustmentPct:number, suggestedLoad:(number|undefined), note:string, reasonCodes:string[]}}
 */
function autoregulateNextSet(input = {}) {
  const {
    goal,
    targetRIR,
    actualRIR,
    techniqueSolid = true,
    velocityLossPct,
    repsGrindy = false,
    painLevel,
    painThreshold = DEFAULT_PAIN_THRESHOLD,
    currentLoad,
  } = input;

  const decision = (action, loadAdjustmentPct, note, reasonCodes) => ({
    action,
    loadAdjustmentPct,
    suggestedLoad: adjustedLoad(currentLoad, loadAdjustmentPct),
    note,
    reasonCodes,
  });

  // 1. Pain overrides everything.
  if (Number.isFinite(painLevel) && painLevel >= painThreshold) {
    return decision('regress', LOAD_STEP_DOWN_PCT,
      'Pain above threshold — reduce load, shorten range of motion, or switch to a pain-free variation.',
      [AUTOREG_REASON_CODES.PAIN_REGRESS]);
  }

  // 2. Power: protect speed, never grind to failure.
  if (goal === 'power'
      && ((Number.isFinite(velocityLossPct) && velocityLossPct >= HIGH_VELOCITY_LOSS_PCT) || repsGrindy === true)) {
    return decision('end_set_or_switch_low_fatigue', 0,
      'Bar speed dropped or reps turned grindy — end the set or move to lower-fatigue work. No grinding for power.',
      [AUTOREG_REASON_CODES.POWER_PROTECT_SPEED]);
  }

  const target = midpointRIR(targetRIR);
  if (target === null || !Number.isFinite(actualRIR)) {
    return decision('hold', 0,
      'Not enough RIR signal to autoregulate — repeat the prescription.',
      [AUTOREG_REASON_CODES.ON_TARGET]);
  }

  // 3. Harder than planned (fewer reps in reserve than target): pull load back or drop a back-off set.
  if (actualRIR <= target - 1) {
    return decision('reduce_load_or_drop_backoff', LOAD_STEP_DOWN_PCT,
      'Last set was harder than planned — drop next-set load ~2–5% or remove one back-off set.',
      [AUTOREG_REASON_CODES.REDUCE_LOAD_RIR_OVERSHOOT]);
  }

  // 4. Easier than planned (more reps in reserve): add load only if technique held.
  if (actualRIR >= target + 1) {
    if (techniqueSolid) {
      return decision('increase_load', LOAD_STEP_UP_PCT,
        'Last set was easier than planned with clean technique — add ~2–5% next set.',
        [AUTOREG_REASON_CODES.INCREASE_LOAD_RIR_UNDERSHOOT]);
    }
    return decision('hold', 0,
      'Reps in reserve are high but technique is breaking down — hold load and clean up form first.',
      [AUTOREG_REASON_CODES.TECHNIQUE_GATES_LOAD]);
  }

  // 5. On target.
  return decision('hold', 0, 'On target — repeat the prescription.', [AUTOREG_REASON_CODES.ON_TARGET]);
}

module.exports = {
  autoregulateNextSet,
  AUTOREG_REASON_CODES,
  DEFAULT_PAIN_THRESHOLD,
  HIGH_VELOCITY_LOSS_PCT,
};
