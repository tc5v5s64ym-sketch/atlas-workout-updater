/* Expected performance at a given weight, derived from historical Log_Cleaned rows.
 *
 * Pure function — no I/O, no LLM, no Sheets writes.
 * Accepts raw 2D rows from getSheetRows() (same 12-column contract as analytics.js).
 *
 * Returns:
 *   expectedReps      – median reps logged at this weight across recent sessions
 *   expectedRirRange  – { min, max } RIR at this weight (null when no RIR data)
 *   basis             – { sampleSize, weightWindow: { min, max }, confidence }
 *
 * Returns null when fewer than MIN_DATA_POINTS sessions match the weight window.
 *
 * Weight window: ±10% of todayWeight.
 * Session representative: the set with the most reps at the target weight in that
 *   session (warm-ups excluded by RIR threshold; ties broken by preferring the set
 *   that has RIR data so the RIR range is as rich as possible).
 * Recency window: most recent MAX_SESSIONS qualifying sessions.
 *
 * Column indices match the 12-column Log_Cleaned contract in CLAUDE.md.
 */
'use strict';

const COL_DATE    = 0;
const COL_SESSION = 1;
const COL_LIFT    = 5;
const COL_WEIGHT  = 7;
const COL_REPS    = 8;
const COL_RIR     = 9;

const WEIGHT_WINDOW       = 0.10;   // ±10% of todayWeight
const WARMUP_RIR_THRESHOLD = 4;    // rir >= 4 → warm-up, excluded
const MAX_SESSIONS        = 6;
const MIN_DATA_POINTS     = 3;

// Integer median: result rounded to nearest whole rep.
function medianInt(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function computeExpectedPerformance(liftCode, rows, todayWeight) {
  if (!liftCode || !Array.isArray(rows) || !rows.length) return null;
  const weight = Number(todayWeight);
  if (!Number.isFinite(weight) || weight <= 0) return null;

  const code = String(liftCode).toUpperCase().trim();
  const weightMin = weight * (1 - WEIGHT_WINDOW);
  const weightMax = weight * (1 + WEIGHT_WINDOW);

  // Parse all rows for this lift that fall within the weight window.
  const parsed = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    if (String(row[COL_DATE] || '') === 'date_clean') continue;
    if (String(row[COL_LIFT] || '').toUpperCase().trim() !== code) continue;
    const w = Number(row[COL_WEIGHT]);
    const r = Number(row[COL_REPS]);
    if (!Number.isFinite(w) || w <= 0) continue;
    if (!Number.isFinite(r) || r <= 0) continue;
    if (w < weightMin || w > weightMax) continue;
    const rirRaw = row[COL_RIR];
    const rir = (rirRaw == null || rirRaw === '') ? null : Number(rirRaw);
    // Exclude sets that are clearly warm-ups at this weight (high RIR).
    if (rir !== null && Number.isFinite(rir) && rir >= WARMUP_RIR_THRESHOLD) continue;
    const sessionId = String(row[COL_SESSION] || '') || String(row[COL_DATE] || '');
    const date      = String(row[COL_DATE] || '');
    parsed.push({ sessionId, date, weight: w, reps: r, rir });
  }

  if (!parsed.length) return null;

  // Group by session; per session keep the set with the most reps at this weight
  // (best working-set performance at this load). Ties broken by preferring a set
  // that has RIR data so the RIR range is populated.
  const sessionMap = new Map();
  for (const s of parsed) {
    const prev = sessionMap.get(s.sessionId);
    const better = !prev
      || s.reps > prev.reps
      || (s.reps === prev.reps && s.rir !== null && prev.rir === null);
    if (better) sessionMap.set(s.sessionId, s);
  }

  // Sort sessions chronologically (Sheets rows arrive date-asc; stable after group).
  const sessions = [...sessionMap.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );

  // Most recent MAX_SESSIONS qualifying sessions.
  const recent = sessions.slice(-MAX_SESSIONS);
  if (recent.length < MIN_DATA_POINTS) return null;

  const repVals = recent.map(s => s.reps);
  const expectedReps = medianInt(repVals);

  const rirVals = recent.map(s => s.rir).filter(r => r !== null && Number.isFinite(r));
  const expectedRirRange = rirVals.length
    ? { min: Math.min(...rirVals), max: Math.max(...rirVals) }
    : null;

  const wVals = recent.map(s => s.weight);
  const confidence = recent.length >= 5 ? 'high' : 'medium';

  return {
    expectedReps,
    expectedRirRange,
    basis: {
      sampleSize: recent.length,
      weightWindow: { min: Math.min(...wVals), max: Math.max(...wVals) },
      confidence,
    },
  };
}

module.exports = { computeExpectedPerformance };
