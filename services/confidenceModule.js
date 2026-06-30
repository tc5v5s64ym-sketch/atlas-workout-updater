'use strict';

// ConfidenceModule — ask-vs-act decision engine.
//
// Synthesizes signals from prior Brian-layer modules into a single confidence
// score that drives the 'act' / 'act_with_caveat' / 'ask' recommendation.
//
// Prime directive: the engine computes all values; the LLM only words them.
// Safe-ladder position: confidence layer (roadmap Phase 4, PR 19).
// Depends on: UserStateModule (PR 6), FatigueAssessmentModule (PR 11),
//             MemoryModule (PR 18), AutoregulationModule (PR 15).
//
// Public API:
//   scoreConfidence(params)  → ConfidenceResult | null
//
// ConfidenceResult:
//   {
//     confidenceScore:  number (0–100),
//     tier:             'high' | 'moderate' | 'low',
//     action:           'act' | 'act_with_caveat' | 'ask',
//     caveats:          string[],       — machine-readable keys; LLM words these
//     safetyInverted:   boolean,        — true when a safety flag escalated the action
//     dimensions: {
//       completeness:          { score, sessionsTracked, readinessInputsUsed },
//       recency:               { score, daysSinceLastSession },
//       consistency:           { score, trend, trendConfidence },
//       selfReportReliability: { score, readinessConfidence, inputsUsed },
//     },
//   }
//
// scoreConfidence params (all optional — absent fields degrade the score):
//   liftState?        object  — userState.liftStates[exercise] from buildUserState (PR 6)
//   readinessResult?  object  — return value of scoreReadiness() (PR 11)
//   trendResult?      object  — return value of queryTrend() / detectTrend (PR 18)
//   safetyFlags?      { active: string[] } | null  — active red-flag keys (PR 5)
//   exerciseKnown?    boolean — true: entity resolution matched; false: unresolved
//                              (undefined/null: not provided, no caveat added)
//
// CAVEAT_KEYS (exported): machine-readable strings attached to the result's
//   `caveats` array. The LLM reads these and chooses appropriate language.

// ─── Constants ────────────────────────────────────────────────────────────────

// Dimension weights (must sum to 1.0).
const WEIGHTS = Object.freeze({
  completeness:          0.30,
  recency:               0.25,
  consistency:           0.25,
  selfReportReliability: 0.20,
});

// Action tier thresholds.
const TIER_ACT_MIN    = 75;  // score >= 75 → 'high'     → 'act'
const TIER_CAVEAT_MIN = 45;  // score >= 45 → 'moderate' → 'act_with_caveat'
                              // score <  45 → 'low'      → 'ask'

// Trend confidence multipliers applied to the consistency dimension.
const TREND_CONFIDENCE_MULTIPLIER = Object.freeze({ high: 1.0, medium: 0.7 });
const TREND_CONFIDENCE_FALLBACK   = 0.3;  // for 'none' or unknown

// Readiness confidence base scores for the self-report-reliability dimension.
const READINESS_CONFIDENCE_SCORE = Object.freeze({ high: 100, medium: 60, low: 30 });

// Machine-readable caveat keys — the LLM turns these into natural language.
const CAVEAT_KEYS = Object.freeze({
  INSUFFICIENT_HISTORY: 'insufficient_history',
  STALE_DATA:           'stale_data',
  LOW_TREND_CONFIDENCE: 'low_trend_confidence',
  LIMITED_READINESS:    'limited_readiness_inputs',
  EXERCISE_UNRESOLVED:  'exercise_unresolved',
  SAFETY_FLAG:          'safety_flag_present',
});

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Safely count array length or numeric value (e.g. scoreReadiness inputsUsed).
function _countArr(field) {
  if (Array.isArray(field)) return field.length;
  if (typeof field === 'number' && Number.isFinite(field) && field >= 0) return Math.floor(field);
  return 0;
}

// Recency score (0–100) from days since last session.
function _recencyScore(days) {
  if (days === null || days === undefined || !Number.isFinite(days)) return 0;
  if (days <= 3)  return 100;
  if (days <= 7)  return 80;
  if (days <= 14) return 60;
  if (days <= 21) return 40;
  if (days <= 30) return 20;
  return 0;
}

// Trend base score (0–100) from trend label.
function _trendBaseScore(trend) {
  if (trend === 'improving')                    return 100;
  if (trend === 'stalling' || trend === 'flat') return 70;
  if (trend === 'declining')                    return 60;
  if (trend === 'noisy')                        return 30;
  return 20;  // 'insufficient_data' or unrecognised
}

// ─── Dimension scorers ────────────────────────────────────────────────────────

// Completeness: how much data is available? (0–100)
//   sessionsScore      [0–50]: sessions tracked for e1RM trend
//   readinessScore     [0–30]: readiness inputs used
//   exerciseScore      [0–20]: entity-resolved exercise
function _scoreCompleteness(liftState, readinessResult, exerciseKnown) {
  const sessionsTracked      = Number(liftState?.e1rm?.sessionsTracked) || 0;
  const readinessInputsUsed  = _countArr(readinessResult?.inputsUsed);

  const sessionsScore    = Math.min(sessionsTracked / 5, 1) * 50;
  const readinessScore   = Math.min(readinessInputsUsed / 4, 1) * 30;
  const exerciseScore    = exerciseKnown === true ? 20 : 0;

  return {
    score: Math.round(sessionsScore + readinessScore + exerciseScore),
    sessionsTracked,
    readinessInputsUsed,
  };
}

// Recency: how fresh is the training data? (0–100)
function _scoreRecency(liftState) {
  const days = liftState?.staleness?.daysSinceLastSession ?? null;
  return { score: _recencyScore(days), daysSinceLastSession: days };
}

// Consistency: is the trend clean and confident? (0–100)
function _scoreConsistency(trendResult) {
  if (!trendResult || typeof trendResult !== 'object') {
    return { score: 0, trend: null, trendConfidence: null };
  }
  const trend           = typeof trendResult.trend      === 'string' ? trendResult.trend      : null;
  const trendConfidence = typeof trendResult.confidence === 'string' ? trendResult.confidence : null;

  const base       = _trendBaseScore(trend);
  const multiplier = TREND_CONFIDENCE_MULTIPLIER[trendConfidence] ?? TREND_CONFIDENCE_FALLBACK;

  return { score: Math.round(base * multiplier), trend, trendConfidence };
}

// Self-report reliability: quality of readiness check-in (0–100).
// Penalised when more inputs were absent than used.
function _scoreSelfReport(readinessResult) {
  if (!readinessResult || typeof readinessResult !== 'object') {
    return { score: 0, readinessConfidence: null, inputsUsed: 0 };
  }

  const conf        = readinessResult.confidence ?? null;
  const inputsUsed  = _countArr(readinessResult.inputsUsed);
  const inputsAbsent = _countArr(readinessResult.inputsAbsent);

  const base       = READINESS_CONFIDENCE_SCORE[conf] ?? 0;
  const multiplier = (inputsAbsent > inputsUsed && inputsUsed > 0) ? 0.7 : 1.0;

  return { score: Math.round(base * multiplier), readinessConfidence: conf, inputsUsed };
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Score the engine's confidence and recommend an action for one decision context.
function scoreConfidence(params) {
  if (!params || typeof params !== 'object') return null;

  const { liftState, readinessResult, trendResult, safetyFlags, exerciseKnown } = params;

  // ── 1. Dimension scores ───────────────────────────────────────────────────
  const completeness          = _scoreCompleteness(liftState, readinessResult, exerciseKnown);
  const recency               = _scoreRecency(liftState);
  const consistency           = _scoreConsistency(trendResult);
  const selfReportReliability = _scoreSelfReport(readinessResult);

  // ── 2. Weighted overall score ─────────────────────────────────────────────
  const confidenceScore = Math.round(
    completeness.score          * WEIGHTS.completeness +
    recency.score               * WEIGHTS.recency +
    consistency.score           * WEIGHTS.consistency +
    selfReportReliability.score * WEIGHTS.selfReportReliability
  );

  // ── 3. Tier ───────────────────────────────────────────────────────────────
  const tier = confidenceScore >= TIER_ACT_MIN    ? 'high'
             : confidenceScore >= TIER_CAVEAT_MIN ? 'moderate'
             : 'low';

  // ── 4. Caveats ────────────────────────────────────────────────────────────
  const caveats = [];
  if (completeness.sessionsTracked < 2)                               caveats.push(CAVEAT_KEYS.INSUFFICIENT_HISTORY);
  if (Number.isFinite(recency.daysSinceLastSession) &&
      recency.daysSinceLastSession > 14)                              caveats.push(CAVEAT_KEYS.STALE_DATA);
  if (consistency.score < 40)                                         caveats.push(CAVEAT_KEYS.LOW_TREND_CONFIDENCE);
  if (selfReportReliability.inputsUsed < 2)                           caveats.push(CAVEAT_KEYS.LIMITED_READINESS);
  if (exerciseKnown === false)                                        caveats.push(CAVEAT_KEYS.EXERCISE_UNRESOLVED);

  const activeSafetyFlags = Array.isArray(safetyFlags?.active) ? safetyFlags.active : [];
  const hasSafetyFlag     = activeSafetyFlags.length > 0;
  if (hasSafetyFlag) caveats.push(CAVEAT_KEYS.SAFETY_FLAG);

  // ── 5. Action (with safety inversion) ────────────────────────────────────
  // Safety inverts: low confidence about a red flag → MORE caution.
  // A safety flag always escalates the action one step toward 'ask'.
  let action;
  let safetyInverted = false;

  if (hasSafetyFlag) {
    if (tier === 'high') {
      action = 'act_with_caveat';  // downgraded from 'act'
      safetyInverted = true;
    } else if (tier === 'moderate') {
      action = 'ask';              // downgraded from 'act_with_caveat'
      safetyInverted = true;
    } else {
      action = 'ask';              // unchanged — already 'ask' without flag
      safetyInverted = false;
    }
  } else {
    action = tier === 'high'     ? 'act'
           : tier === 'moderate' ? 'act_with_caveat'
           : 'ask';
    safetyInverted = false;
  }

  return {
    confidenceScore,
    tier,
    action,
    caveats,
    safetyInverted,
    dimensions: { completeness, recency, consistency, selfReportReliability },
  };
}

module.exports = { scoreConfidence, CAVEAT_KEYS };
