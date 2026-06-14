'use strict';

/**
 * Recommendation pipeline — ties the deterministic layers together:
 *   user intent → rule policy → user history → recommendation → short coach explanation.
 *
 * Pure and deterministic: no network, no LLM, no writes. The rule engine owns the numbers; the
 * templated explanation only words them and is validated so it can never substitute a number.
 * Returns the PUBLIC payload only (no raw sheet rows / analytics blobs).
 */

const { resolveTrainingGoal } = require('./trainingGoalClassifier');
const { recommendExercisePrescription } = require('./recommendationPolicy');
const { buildLiftHistory } = require('./recommendationHistoryAdapter');
const { buildTemplatedExplanation, validateCoachExplanation } = require('./coachExplanationPolicy');

function buildRecommendation(input = {}) {
  const {
    sessionText,
    explicitGoal,
    userProfileGoal,
    liftCode,
    exerciseName,
    logRows,
    effortRows,
    today,
    constraints,
  } = input;

  const resolved = resolveTrainingGoal({ explicitGoal, userProfileGoal, sessionText });
  const goal = resolved.goal;

  const history = buildLiftHistory(logRows, liftCode, { effortRows, today });

  const prescription = recommendExercisePrescription({
    goal,
    exerciseName: exerciseName || (history.raw && history.raw.rec && history.raw.rec.exercise_name) || liftCode || 'Unknown Exercise',
    previousPerformance: history.previousPerformance,
    recentTrends: history.recentTrends,
    constraints,
  });

  const explanation = buildTemplatedExplanation(prescription);
  const validation = validateCoachExplanation(explanation, prescription.llmBrief.lockedNumbers);

  const out = {
    intent: goal,
    source: resolved.source,
    recommendation: {
      exercise: prescription.exerciseName,
      exerciseType: prescription.exerciseType,
      movementRegion: prescription.movementRegion,
      targetSets: prescription.targetSets,
      targetRepRange: prescription.targetRepRange,
      targetRIR: prescription.targetRIR,
      restSeconds: prescription.restSeconds,
      recommendedWeight: prescription.recommendedWeight,
      progression: prescription.progression,
      adjustment: prescription.adjustment,
    },
    reasonCodes: prescription.reasonCodes,
    safetyFlags: prescription.safetyFlags || [],
    llmBrief: prescription.llmBrief,
    coachExplanation: validation.valid ? explanation : null,
    explanationValid: validation.valid,
  };
  if (prescription.weightGuidance) out.weightGuidance = prescription.weightGuidance;
  return out;
}

/**
 * Parse optional PR #210 constraints from a request query. Numeric fields are coerced safely;
 * painFlags / injuryConstraints accept comma-separated strings (or arrays). Empty values are
 * omitted. No persistence, no schema — just a pass-through hint object (or undefined).
 */
function parseRecommendationConstraints(query = {}) {
  const c = {};

  for (const field of ['sessionMinutes', 'trainingDaysPerWeek']) {
    const v = query[field];
    if (v != null && String(v).trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) c[field] = n;
    }
  }

  for (const field of ['equipmentTier', 'experienceLevel']) {
    if (typeof query[field] === 'string' && query[field].trim()) c[field] = query[field].trim();
  }

  for (const field of ['painFlags', 'injuryConstraints']) {
    const v = query[field];
    let arr = [];
    if (typeof v === 'string') arr = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (Array.isArray(v)) arr = v.map((s) => String(s).trim()).filter(Boolean);
    if (arr.length) c[field] = arr;
  }

  return Object.keys(c).length ? c : undefined;
}

module.exports = { buildRecommendation, parseRecommendationConstraints };
