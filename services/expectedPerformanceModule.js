'use strict';

// ExpectedPerformanceModule — composite expected-performance + plateau assessment.
//
// Wraps two partial components (roadmap PR 14):
//   - assessExpectedPerformance: structured-entry adapter around computeExpectedPerformance
//   - detectLiftPlateaus: stall detection directly on structured log entries
//   - assessLift: composite — both above + optional readiness adjustment via scoreReadiness
//
// Prime directive: the engine computes all values; the LLM only words them.
// Safe-ladder position: read-only math (roadmap Phase 3, PR 14).
// Depends on: expectedPerformance.js (PR 3 dep), fatigueAssessmentModule.js (PR 11/12),
//             UserStateModule.js substrate (PR 6), warmupTag.js.

const { computeExpectedPerformance } = require('./expectedPerformance');
const { scoreReadiness }             = require('./fatigueAssessmentModule');
const { isWarmupNote }               = require('./warmupTag');

// Column indices for the 12-col Log_Cleaned positional format expected by
// computeExpectedPerformance (mirrors constants in expectedPerformance.js).
const COL_DATE    = 0;
const COL_SESSION = 1;
const COL_LIFT    = 5;
const COL_WEIGHT  = 7;
const COL_REPS    = 8;
const COL_RIR     = 9;
const COL_NOTES   = 10;
const ROW_LENGTH  = 12;

const DEFAULT_MIN_SESSIONS = 3;
const STALL_EPSILON        = 1e-6;

// Rep adjustment applied per readiness tier.
// 'high'     = optimal conditions — no adjustment.
// 'moderate' = mildly fatigued — prescribe 1 rep conservatively.
// 'low'      = significantly fatigued — prescribe 2 reps conservatively.
const READINESS_REP_DELTA = { high: 0, moderate: -1, low: -2 };

// ─── Internal helpers ────────────────────────────────────────────────────────

// Convert one structured Log_Cleaned entry to the 12-column positional array
// that computeExpectedPerformance expects. Unrecognised fields are left null.
function _entryToRow(entry) {
  const row        = new Array(ROW_LENGTH).fill(null);
  row[COL_DATE]    = entry.date_clean ?? null;
  row[COL_SESSION] = entry.session_id ?? null;
  row[COL_LIFT]    = entry.lift_code  ?? null;
  row[COL_WEIGHT]  = entry.weight     ?? null;
  row[COL_REPS]    = entry.reps       ?? null;
  row[COL_RIR]     = entry.rir        ?? null;
  row[COL_NOTES]   = entry.notes      ?? null;
  return row;
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Assess expected performance for one lift at a given target weight.
//
// liftCode     — lift code string (e.g. 'SQUAT'); matched case-insensitively.
// logEntries   — array of Log_Cleaned structured row objects.
// targetWeight — number > 0 (same unit as the log entries).
//
// Returns { expectedReps, expectedRirRange, basis } or null when there is
// insufficient historical data (< 3 matching sessions at the target weight).
// Return shape is identical to computeExpectedPerformance.
function assessExpectedPerformance(liftCode, logEntries, targetWeight) {
  if (!liftCode || typeof liftCode !== 'string') return null;
  if (!Array.isArray(logEntries)) return null;
  const weight = Number(targetWeight);
  if (!Number.isFinite(weight) || weight <= 0) return null;

  const rows = logEntries
    .filter(e => e != null && typeof e === 'object')
    .map(_entryToRow);

  return computeExpectedPerformance(liftCode, rows, weight);
}

// Detect plateau / stall conditions across all lifts in the entry list.
//
// A lift is stalled when its best e1RM (Epley: w * (1 + r/30)) across the
// last `minSessions` sessions has not improved beyond the first session's
// e1RM by more than STALL_EPSILON (1e-6). Warm-up sets are excluded so that
// tagged feeler sets do not inflate the e1RM and mask a true stall.
//
// logEntries        — array of Log_Cleaned structured row objects.
// opts.minSessions  — consecutive sessions without e1RM gain required to flag
//                     a stall (default 3, minimum enforced to 2).
//
// Returns an array of stall descriptors, one per stalled lift:
//   { liftCode, exercise, sessions_stalled,
//     last_best_weight, first_session_date, last_session_date }
// Returns [] for empty / non-array input.
function detectLiftPlateaus(logEntries, opts) {
  const options = opts != null && typeof opts === 'object' ? opts : {};
  const rawMin  = Number(options.minSessions);
  const minSessions = Number.isFinite(rawMin) && rawMin >= 2
    ? Math.floor(rawMin) : DEFAULT_MIN_SESSIONS;

  if (!Array.isArray(logEntries) || logEntries.length === 0) return [];

  // Retain only valid working sets; warm-up notes are excluded.
  const valid = logEntries.filter(e => {
    if (!e || typeof e !== 'object') return false;
    const w = Number(e.weight);
    const r = Number(e.reps);
    if (!Number.isFinite(w) || w <= 0) return false;
    if (!Number.isFinite(r) || r <= 0) return false;
    return !isWarmupNote(e.notes);
  });

  if (valid.length === 0) return [];

  // Group by lift code, uppercased for consistency with computeExpectedPerformance.
  const byLift = new Map();
  for (const entry of valid) {
    const code = typeof entry.lift_code === 'string' && entry.lift_code.trim()
      ? entry.lift_code.trim().toUpperCase() : 'UNKNOWN';
    const list = byLift.get(code);
    if (list) list.push(entry);
    else byLift.set(code, [entry]);
  }

  const stalls = [];

  for (const [liftCode, entries] of byLift) {
    // Sort chronologically; session_id as tie-breaker within the same date.
    const sorted = [...entries].sort((a, b) => {
      const da = String(a.date_clean || '');
      const db = String(b.date_clean || '');
      if (da !== db) return da < db ? -1 : 1;
      return String(a.session_id || '').localeCompare(String(b.session_id || ''));
    });

    // Aggregate per session: best weight and best Epley e1RM.
    const sessionMap = new Map();
    for (const entry of sorted) {
      const key  = `${entry.session_id || ''}||${entry.date_clean || ''}`;
      const w    = Number(entry.weight);
      const r    = Number(entry.reps);
      const e1rm = w * (1 + r / 30);
      const prev = sessionMap.get(key) || {
        date: entry.date_clean || null,
        best_weight: 0,
        best_e1rm:   0,
      };
      if (w    > prev.best_weight) prev.best_weight = w;
      if (e1rm > prev.best_e1rm)   prev.best_e1rm   = e1rm;
      sessionMap.set(key, prev);
    }

    const sessions = Array.from(sessionMap.values());
    if (sessions.length < minSessions) continue;

    const lastN     = sessions.slice(-minSessions);
    const maxE1rm   = Math.max(...lastN.map(s => s.best_e1rm));
    const firstE1rm = lastN[0].best_e1rm;

    if (maxE1rm - firstE1rm <= STALL_EPSILON) {
      const lastNamed = [...sorted].reverse()
        .find(e => e.canonical_exercise || e.exercise);
      const exerciseName = lastNamed
        ? (lastNamed.canonical_exercise || lastNamed.exercise)
        : '';

      stalls.push({
        liftCode,
        exercise:            exerciseName,
        sessions_stalled:    lastN.length,
        last_best_weight:    lastN[lastN.length - 1].best_weight,
        first_session_date:  lastN[0].date,
        last_session_date:   lastN[lastN.length - 1].date,
      });
    }
  }

  return stalls;
}

// Composite lift assessment: expected performance + plateau status + optional readiness.
//
// liftCode          — lift code string (e.g. 'SQUAT').
// logEntries        — array of Log_Cleaned structured row objects.
// targetWeight      — number > 0.
// opts:
//   minSessions     — forwarded to detectLiftPlateaus (default 3).
//   readinessInputs — optional { sleep, soreness, stress, motivation,
//                     recent_load, hrv } (0–10 each); when provided, readiness
//                     is scored and expectedReps adjusted downward for
//                     sub-optimal readiness.
//
// Returns null if liftCode / logEntries / targetWeight are invalid.
// Returns:
// {
//   liftCode,              string — normalised uppercase lift code
//   targetWeight,          number
//   expectedPerformance,   { expectedReps, expectedRirRange, basis } | null
//   plateau,               stall descriptor | null
//   readiness,             { score, tier, inputsUsed, inputsAbsent, confidence } | null
//   adjustedExpectedReps,  number | null  (null when expectedPerformance is null)
//   readinessAdjustment,   'none' | 'reduced_1' | 'reduced_2'
// }
function assessLift(liftCode, logEntries, targetWeight, opts) {
  if (!liftCode || typeof liftCode !== 'string') return null;
  if (!Array.isArray(logEntries)) return null;
  const weight = Number(targetWeight);
  if (!Number.isFinite(weight) || weight <= 0) return null;

  const options = opts != null && typeof opts === 'object' ? opts : {};
  const code    = String(liftCode).toUpperCase().trim();

  const expectedPerformance = assessExpectedPerformance(code, logEntries, weight);
  const plateaus            = detectLiftPlateaus(logEntries, { minSessions: options.minSessions });
  const plateau             = plateaus.find(p => p.liftCode === code) ?? null;

  const readiness = options.readinessInputs
    ? scoreReadiness(options.readinessInputs)
    : null;

  let adjustedExpectedReps = expectedPerformance ? expectedPerformance.expectedReps : null;
  let readinessAdjustment  = 'none';

  if (readiness && readiness.tier && adjustedExpectedReps !== null) {
    const delta = READINESS_REP_DELTA[readiness.tier] ?? 0;
    if (delta !== 0) {
      adjustedExpectedReps = Math.max(1, adjustedExpectedReps + delta);
      readinessAdjustment  = delta === -1 ? 'reduced_1' : 'reduced_2';
    }
  }

  return {
    liftCode: code,
    targetWeight: weight,
    expectedPerformance,
    plateau,
    readiness,
    adjustedExpectedReps,
    readinessAdjustment,
  };
}

module.exports = { assessExpectedPerformance, detectLiftPlateaus, assessLift };
