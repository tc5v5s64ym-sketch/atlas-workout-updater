'use strict';

// AutoregulationModule — e1RM-driven, readiness-aware load prescription.
//
// Upgrades the fixed-increment LP (linear progression) approach in
// ProgressionModule to derive target weights from the lifter's current
// estimated one-rep max (e1RM) and session readiness, and detects when
// a lifter should graduate from session-to-session LP.
//
// Prime directive: the engine computes all numbers; the LLM only words them.
// Safe-ladder position: prescription layer (roadmap Phase 3, PR 15).
// Depends on: IntensityModule (PR 3), FatigueAssessmentModule (PR 11),
//             ExpectedPerformanceModule (PR 14).
//
// Public API:
//   computeCurrentE1RM(liftCode, logEntries)        → number | null
//   detectLPGraduation(liftCode, logEntries, opts?)  → GraduationResult
//   autoregulateLoad(params)                         → AutoregulationResult | null
//
// AutoregulationResult:
//   {
//     recommendedWeight:   number | null,  — target weight, rounded to plate; null when insufficient data
//     targetReps:          number,         — reps prescribed for the session
//     effectiveRIR:        number,         — RIR after readiness adjustment
//     e1rm:                number | null,  — e1RM used for derivation (null when unavailable)
//     readinessTier:       'high'|'moderate'|'low'|null,  — null when no readiness inputs
//     readinessAdjustment: number,         — extra RIR added due to readiness (0, 1, or 2)
//     graduateFromLP:      boolean,        — plateau detected; suggest non-LP progression scheme
//     plateauDetails:      object[] | null,
//     basis:               'e1rm_derived' | 'increment_fallback' | 'insufficient_data',
//   }
//
// GraduationResult:
//   {
//     shouldGraduate: boolean,
//     reason:         string | null,
//     plateauDetails: object[] | null,
//   }
//
// autoregulateLoad params:
//   liftCode        string           — lift code (e.g. 'SQUAT')
//   logEntries      object[]         — Log_Cleaned structured entries
//   targetReps      number           — reps to prescribe (default 5)
//   targetRIR       number           — ideal RIR at full readiness (default 1)
//   readinessInputs object | null    — forwarded to scoreReadiness; null = no adjustment
//   bodyRegion      string           — 'upper_body' | 'lower_body' (default 'upper_body')

const { estimateE1RM, targetWeightForRIR, percentOf1RM } = require('./intensityModule');
const { scoreReadiness }     = require('./fatigueAssessmentModule');
const { detectLiftPlateaus } = require('./expectedPerformanceModule');
const { isWarmupNote }       = require('./warmupTag');

// Readiness tier → additional RIR applied to target load.
// Fatigued lifter gets a more conservative (lighter) weight for the same rep target.
const READINESS_RIR_DELTA = { high: 0, moderate: 1, low: 2 };

// Plate-friendly rounding increments by body region (lb).
const ROUND_INCREMENT = { lower_body: 5, upper_body: 2.5 };

// Number of most-recent sessions to consider when computing current e1RM.
const E1RM_SESSION_WINDOW = 3;

// Warm-up exclusion thresholds (matches trendDetector / coachMemory).
const WARMUP_WEIGHT_FRACTION = 0.60;
const WARMUP_RIR_THRESHOLD   = 4;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _roundToPlate(weight, bodyRegion) {
  const inc = ROUND_INCREMENT[bodyRegion] || ROUND_INCREMENT.upper_body;
  return Math.max(0, Math.round(weight / inc) * inc);
}

// Estimate e1RM from one structured log entry.
// Uses RIR-adjusted formula when RIR is valid (0–4); otherwise plain Epley.
function _entryE1rm(entry) {
  const weight = Number(entry.weight);
  const reps   = Number(entry.reps);
  if (!Number.isFinite(weight) || weight <= 0) return null;
  if (!Number.isFinite(reps)   || reps < 1 || reps > 20) return null;

  const rawRir = entry.rir != null ? Number(entry.rir) : null;
  const rir = (Number.isFinite(rawRir) && rawRir >= 0 && rawRir <= 4) ? rawRir : null;

  try {
    if (rir !== null) {
      const pct = percentOf1RM(reps, rir);
      if (pct > 0) return weight / pct;
    }
    return estimateE1RM(weight, reps);
  } catch {
    return null;
  }
}

// Filter warm-up sets from a session's entries (same heuristic as trendDetector):
// explicit warm-up note OR weight < 60% of session max OR RIR ≥ 4.
// Falls back to all entries when every set looks like a warm-up.
function _workingSets(entries) {
  const maxW = Math.max(...entries.map(e => Number(e.weight) || 0), 0);
  if (maxW === 0) return entries;
  const working = entries.filter(e => {
    if (isWarmupNote(e.notes)) return false;
    if ((Number(e.weight) || 0) < maxW * WARMUP_WEIGHT_FRACTION) return false;
    const rir = e.rir != null ? Number(e.rir) : null;
    if (Number.isFinite(rir) && rir >= WARMUP_RIR_THRESHOLD) return false;
    return true;
  });
  return working.length ? working : entries;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Compute the best e1RM from the most recent E1RM_SESSION_WINDOW sessions for
// a given lift. Returns null when there is insufficient or invalid data.
function computeCurrentE1RM(liftCode, logEntries) {
  if (typeof liftCode !== 'string' || !liftCode.trim()) return null;
  if (!Array.isArray(logEntries) || logEntries.length === 0) return null;

  const code = liftCode.trim().toUpperCase();

  const liftEntries = logEntries
    .filter(e => e && typeof e === 'object' &&
      typeof e.lift_code === 'string' &&
      e.lift_code.trim().toUpperCase() === code)
    .sort((a, b) => String(a.date_clean || '').localeCompare(String(b.date_clean || '')));

  if (liftEntries.length === 0) return null;

  // Group by session.
  const sessionMap = new Map();
  for (const entry of liftEntries) {
    const sid = String(entry.session_id || entry.date_clean || '');
    if (!sessionMap.has(sid)) sessionMap.set(sid, []);
    sessionMap.get(sid).push(entry);
  }

  // Compute best e1RM across working sets in the most recent sessions.
  const sessions = [...sessionMap.values()];
  const recent   = sessions.slice(-E1RM_SESSION_WINDOW);

  let bestE1RM = null;
  for (const sess of recent) {
    for (const entry of _workingSets(sess)) {
      const e1rm = _entryE1rm(entry);
      if (e1rm !== null && (bestE1RM === null || e1rm > bestE1RM)) bestE1RM = e1rm;
    }
  }

  return bestE1RM;
}

// Detect whether a lifter should graduate from linear progression for a lift.
// Uses detectLiftPlateaus (PR 14): fires when e1RM has not improved across
// minSessions consecutive sessions (default 3).
function detectLPGraduation(liftCode, logEntries, opts) {
  const none = { shouldGraduate: false, reason: null, plateauDetails: null };

  if (typeof liftCode !== 'string' || !liftCode.trim()) return none;
  if (!Array.isArray(logEntries) || logEntries.length === 0) return none;

  const code    = liftCode.trim().toUpperCase();
  const options = opts != null && typeof opts === 'object' ? opts : {};

  let plateaus;
  try {
    plateaus = detectLiftPlateaus(logEntries, { minSessions: options.minSessions });
  } catch {
    return none;
  }

  const match = plateaus.find(p => String(p.liftCode || '').toUpperCase() === code);
  if (!match) return none;

  return {
    shouldGraduate: true,
    reason: `e1RM has not improved across the last ${match.sessions_stalled} sessions — consider switching from session-to-session LP to week-over-week progression`,
    plateauDetails: [match],
  };
}

// Build a readiness-adjusted, e1RM-derived load prescription for one lift.
function autoregulateLoad(params) {
  if (!params || typeof params !== 'object') return null;

  const {
    liftCode,
    logEntries,
    targetReps      = 5,
    targetRIR       = 1,
    readinessInputs = null,
    bodyRegion      = 'upper_body',
  } = params;

  if (typeof liftCode !== 'string' || !liftCode.trim()) return null;
  if (!Array.isArray(logEntries)) return null;

  const reps = Math.max(1, Math.round(Number(targetReps) || 5));
  const rir  = Number.isFinite(Number(targetRIR)) ? Math.max(0, Number(targetRIR)) : 1;

  // ── 1. Readiness adjustment ───────────────────────────────────────────────
  let readinessTier       = null;
  let readinessAdjustment = 0;

  if (readinessInputs != null && typeof readinessInputs === 'object') {
    const readiness = scoreReadiness(readinessInputs);
    readinessTier       = readiness.tier;
    readinessAdjustment = READINESS_RIR_DELTA[readinessTier] ?? 0;
  }

  // Clamp to intensityModule's MAX_RIR (4) so targetWeightForRIR never throws
  // even when targetRIR + readiness adjustment would exceed the formula limit.
  const effectiveRIR = Math.min(rir + readinessAdjustment, 4);

  // ── 2. Current e1RM ──────────────────────────────────────────────────────
  const e1rm = computeCurrentE1RM(liftCode, logEntries);

  // ── 3. Derive recommended weight ─────────────────────────────────────────
  let recommendedWeight = null;
  let basis;

  if (e1rm !== null && e1rm > 0) {
    try {
      const derived = targetWeightForRIR(e1rm, reps, effectiveRIR);
      if (Number.isFinite(derived) && derived > 0) {
        recommendedWeight = _roundToPlate(derived, bodyRegion);
        basis = 'e1rm_derived';
      } else {
        basis = 'increment_fallback';
      }
    } catch {
      basis = 'increment_fallback';
    }
  } else {
    basis = 'insufficient_data';
  }

  // ── 4. Graduate-from-LP detection ────────────────────────────────────────
  const graduation     = detectLPGraduation(liftCode, logEntries);
  const graduateFromLP = graduation.shouldGraduate;
  const plateauDetails = graduation.plateauDetails;

  return {
    recommendedWeight,
    targetReps:          reps,
    effectiveRIR,
    e1rm,
    readinessTier,
    readinessAdjustment,
    graduateFromLP,
    plateauDetails,
    basis,
  };
}

module.exports = {
  autoregulateLoad,
  detectLPGraduation,
  computeCurrentE1RM,
};
