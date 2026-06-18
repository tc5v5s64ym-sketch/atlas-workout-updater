/* Readiness signal from trend direction and recent deviation streak.
 *
 * Pure function — no I/O, no LLM, no Sheets writes.
 *
 * Args:
 *   trend           – detectTrend() result { trend, confidence, sessions_analyzed }
 *                     OR a plain trend string ('improving'/'flat'/'declining'/'noisy');
 *                     may be null / omitted when trend data is unavailable.
 *   deviationHistory – ordered array of classifyDeviation() results, most recent
 *                     LAST. Each entry may be a full object { verdict, delta,
 *                     magnitude } or a plain verdict string. 'insufficient_data'
 *                     entries break the streak (unknown sessions don't count as
 *                     below_expected, nor do they clear it — they are neutral gaps).
 *                     An empty or absent array yields 'monitoring' / 'none'.
 *
 * Returns:
 *   signal     – 'monitoring' | 'possible_fatigue' | 'likely_fatigue'
 *   confidence – 'none' | 'low' | 'medium' | 'high'
 *   note       – null | 'consecutive_below_expected' | 'sustained_declining_trend'
 *
 * Classification rules:
 *   streak = consecutive 'below_expected' sessions at the tail of deviationHistory
 *   streak 0     → monitoring, confidence: none
 *   streak 1–2   → monitoring, confidence: low  (watching, insufficient for fatigue)
 *   streak 3+    → possible_fatigue, confidence: medium
 *   streak 3+ AND trend === 'declining' → likely_fatigue, confidence: high
 *
 * The engine NEVER emits 'likely_fatigue' from fewer than 3 consecutive sessions.
 */
'use strict';

const STREAK_THRESHOLD = 3;

// Extract the plain verdict string from a deviationHistory entry (object or string).
function verdictOf(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object') return entry.verdict != null ? String(entry.verdict) : null;
  return null;
}

// Count consecutive 'below_expected' verdicts from the tail of the history.
// 'insufficient_data' breaks the streak (neutral gap — not a confirmed bad session).
function streakCount(deviationHistory) {
  let count = 0;
  for (let i = deviationHistory.length - 1; i >= 0; i--) {
    if (verdictOf(deviationHistory[i]) === 'below_expected') {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function computeReadiness(trend, deviationHistory) {
  if (!Array.isArray(deviationHistory) || !deviationHistory.length) {
    return { signal: 'monitoring', confidence: 'none', note: null };
  }

  const streak = streakCount(deviationHistory);

  if (streak >= STREAK_THRESHOLD) {
    const trendVerdict = trend && typeof trend === 'object' ? trend.trend : trend;
    if (typeof trendVerdict === 'string' && trendVerdict === 'declining') {
      return { signal: 'likely_fatigue', confidence: 'high', note: 'sustained_declining_trend' };
    }
    return { signal: 'possible_fatigue', confidence: 'medium', note: 'consecutive_below_expected' };
  }

  // streak 0 → no concerning signal yet; streak 1–2 → watching
  const confidence = streak === 0 ? 'none' : 'low';
  return { signal: 'monitoring', confidence, note: null };
}

module.exports = { computeReadiness };
