'use strict';

// MemoryModule — Brian-layer composite for training memory and pattern detection.
//
// Formalizes the long-term-trends store, coach-memory pattern detection, and
// entity resolution as a single read-only engine module.
//
// Prime directive: the engine computes all values; the LLM only words them.
// Safe-ladder position: read-only memory composite (roadmap Phase 4, PR 18).
// Depends on: trendDetector (PR 3 chain), coachMemory (PR 6 chain),
//             entityResolutionModule (PR 18), userStateModule (PR 6),
//             expectedPerformanceModule (PR 14).
//
// Public API:
//   resolveExercise(rawName)              → { exerciseId, name, confidence, method } | null
//   listExerciseIds()                     → [string]
//   queryTrend(liftCode, logRows)         → { trend, confidence, sessions_analyzed }
//   queryPatterns(liftCode, logRows, opts?) → { patterns }
//   buildMemorySnapshot(logRows, opts?)   → MemorySnapshot
//
// buildMemorySnapshot return shape (MemorySnapshot):
//   {
//     liftsEncountered: string[],               — sorted lift codes found in rows
//     liftTrends:   { [liftCode]: TrendResult }, — per-lift e1RM trend
//     liftPatterns: { [liftCode]: { patterns } },— per-lift pattern detection
//     missedLifts:  { patterns },               — from opts.missedLiftHistory
//   }
//
// opts for buildMemorySnapshot:
//   substitutionHistory: [{ original, substitute, liftCode }]  — forwarded to detectPatterns
//   missedLiftHistory:   [{ exercise }]                        — forwarded to detectMissedLifts
//
// queryTrend delegates to trendDetector.detectTrend:
//   trend ∈ 'improving' | 'flat' | 'declining' | 'noisy' | 'insufficient_data'
//   confidence ∈ 'high' | 'medium' | 'none'

const { detectTrend }                      = require('./trendDetector');
const { detectPatterns, detectMissedLifts } = require('./coachMemory');
const {
  resolveExercise,
  listExerciseIds,
}                                           = require('./entityResolutionModule');

// Column 5 of the 12-col Log_Cleaned positional format holds lift_code.
const COL_LIFT = 5;

const NULL_TREND = { trend: 'insufficient_data', confidence: 'none', sessions_analyzed: 0 };

// Extract all unique lift codes present in the raw log rows.
// Skips the Log_Cleaned header row ('date_clean') for consistency with trendDetector.
function _liftsIn(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    if (String(row[0] || '') === 'date_clean') continue;
    const code = String(row[COL_LIFT] || '').trim().toUpperCase();
    if (code) seen.add(code);
  }
  return [...seen].sort();
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Query the e1RM trend for one lift code across the supplied log rows.
// Returns the detectTrend result shape; returns NULL_TREND on invalid input.
function queryTrend(liftCode, logRows) {
  if (typeof liftCode !== 'string' || !liftCode.trim()) return { ...NULL_TREND };
  if (!Array.isArray(logRows)) return { ...NULL_TREND };
  return detectTrend(liftCode, logRows);
}

// Query coach-memory patterns for one lift code across the supplied log rows.
// Returns { patterns: [] } on invalid or insufficient input.
function queryPatterns(liftCode, logRows, options) {
  if (typeof liftCode !== 'string' || !liftCode.trim()) return { patterns: [] };
  if (!Array.isArray(logRows)) return { patterns: [] };
  const opts = options != null && typeof options === 'object' ? options : {};
  return detectPatterns(liftCode, logRows, opts);
}

// Build a full memory snapshot across all lifts present in logRows.
// Accepts Log_Cleaned positional rows (12-column arrays).
function buildMemorySnapshot(logRows, options) {
  const opts = options != null && typeof options === 'object' ? options : {};
  const rows = Array.isArray(logRows) ? logRows : [];

  const liftsEncountered = _liftsIn(rows);

  const liftTrends   = {};
  const liftPatterns = {};

  for (const liftCode of liftsEncountered) {
    liftTrends[liftCode]   = detectTrend(liftCode, rows);
    liftPatterns[liftCode] = detectPatterns(liftCode, rows, {
      substitutionHistory: Array.isArray(opts.substitutionHistory)
        ? opts.substitutionHistory.filter(
            e => e && String(e.liftCode || '').trim().toUpperCase() === liftCode
          )
        : undefined,
    });
  }

  const rawMissedPatterns = detectMissedLifts(
    Array.isArray(opts.missedLiftHistory) ? opts.missedLiftHistory : []
  );
  const missedLifts = { patterns: Array.isArray(rawMissedPatterns) ? rawMissedPatterns : [] };

  return { liftsEncountered, liftTrends, liftPatterns, missedLifts };
}

module.exports = {
  resolveExercise,
  listExerciseIds,
  queryTrend,
  queryPatterns,
  buildMemorySnapshot,
};
