'use strict';

/**
 * RIR policy — the recommended reps-in-reserve for a planned set, derived from the
 * training type (goal) and the lift's role. The per-goal RIR *bands* live in
 * trainingKnowledge.js (the single source of truth); this module picks an
 * evidence-aligned point inside the band by role, so strength / hypertrophy / power /
 * recovery each get a distinct effort target instead of one flat number.
 *
 * Deterministic — the rule engine owns the number; the LLM only words it. Day-of
 * autoregulation (services/autoregulation.js) corrects in real time when the lifter's
 * actual RIR comes in off target.
 *
 * Lower RIR = closer to failure (harder); higher RIR = more in reserve (easier).
 */

const { getTrainingGoal, normalizeTrainingGoal } = require('./trainingKnowledge');

// scoreIntents() session intents → canonical training goal.
const INTENT_TO_GOAL = Object.freeze({
  build_strength: 'strength',
  test_progress: 'strength',
  build_muscle: 'hypertrophy',
  fix_blind_spots: 'hypertrophy',
  muscular_endurance: 'muscular_endurance',
  conditioning: 'conditioning_fat_loss',
  balanced: 'general_health',
  short_session: 'general_health',
  recovery_pump: 'recovery',
  deload_reset: 'recovery',
  custom: 'general_health',
});

// Recommended RIR by goal + lift role. Evidence-aligned, then clamped to each goal's
// band so a value can never drift outside the knowledge layer:
//  - strength: avoid failure on heavy compounds (technique/recovery) → ~2
//  - hypertrophy: proximity to failure drives growth (more than for strength);
//    isolation/accessory work safely sits closer to failure → main 2, accessory 1
//  - power: speed/quality, never grind, stop on velocity drop → high (~4)
//  - muscular_endurance: sustained, near-but-not-to-failure → ~2
//  - conditioning / general_health: preserve quality, no required failure → 2–3
//  - recovery: reduced stress, blood flow only → 4–5
//  - mixed: strength-biased main + hypertrophy-biased accessories
const RIR_BY_GOAL = Object.freeze({
  strength:              Object.freeze({ main: 2, accessory: 2 }),
  hypertrophy:           Object.freeze({ main: 2, accessory: 1 }),
  power:                 Object.freeze({ main: 4, accessory: 4 }),
  muscular_endurance:    Object.freeze({ main: 2, accessory: 2 }),
  conditioning_fat_loss: Object.freeze({ main: 3, accessory: 2 }),
  general_health:        Object.freeze({ main: 3, accessory: 2 }),
  recovery:              Object.freeze({ main: 5, accessory: 4 }),
  mixed:                 Object.freeze({ main: 2, accessory: 1 }),
});

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function intentToGoal(intentId) {
  return INTENT_TO_GOAL[intentId] || 'general_health';
}

// role: 'main' | 'accessory' (anything not 'main' is treated as accessory).
function recommendTargetRir({ goal, role } = {}) {
  const g = normalizeTrainingGoal(goal);
  const table = RIR_BY_GOAL[g] || RIR_BY_GOAL.general_health;
  const base = role === 'main' ? table.main : table.accessory;
  const band = getTrainingGoal(g).targetRIR; // { min, max }
  return clamp(base, band.min, band.max);
}

module.exports = { intentToGoal, recommendTargetRir, INTENT_TO_GOAL, RIR_BY_GOAL };
