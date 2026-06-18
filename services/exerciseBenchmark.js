/* Deterministic per-exercise benchmark from historical Log_Cleaned rows.
 *
 * Pure function — no I/O, no LLM, no Sheets writes.
 * Accepts raw 2D rows from getSheetRows() (same shape as analytics.js consumers).
 *
 * Returns:
 *   workingWeight  – mode (or median) of per-session top-set weights, rounded to 5 lb
 *   recentBest     – highest top-set weight in the last 10 sessions
 *   repRange       – { min, max } reps across working sets
 *   rirRange       – { min, max } RIR across working sets (null-RIR entries excluded)
 *   confidence     – 'high' (≥5 sessions) | 'medium' (3–4) | 'low' (1–2) | 'none'
 *   sampleSize     – number of distinct sessions analysed
 *
 * "Working set" heuristic: a set whose weight is ≥ 60 % of the session max AND
 * whose RIR is < 4 (or RIR is absent). Sets below that threshold are treated as
 * warm-ups and excluded from the benchmark. If every set in a session looks like
 * a warm-up, all sets are kept (guards against lifters who always log all sets at
 * full effort with no explicit RIR).
 *
 * Column indices match the 12-column Log_Cleaned contract in CLAUDE.md.
 */
'use strict';

const COL_DATE     = 0;
const COL_SESSION  = 1;
const COL_LIFT     = 5;
const COL_WEIGHT   = 7;
const COL_REPS     = 8;
const COL_RIR      = 9;

const WARMUP_RIR_THRESHOLD   = 4;   // rir >= 4 → warm-up
const WARMUP_WEIGHT_FRACTION = 0.60; // weight < 60 % of session max → warm-up
const RECENT_SESSION_WINDOW  = 10;
const TARGET_RIR_MIN = 0;           // target zone for resolveWorkingWeight
const TARGET_RIR_MAX = 3;           //   sessions where top-set RIR ∈ [0, 3]

function nullBenchmark() {
  return {
    workingWeight: null,
    recentBest:    null,
    repRange:      null,
    rirRange:      null,
    confidence:    'none',
    sampleSize:    0,
  };
}

function roundTo5(n) {
  return Math.round(n / 5) * 5;
}

// Returns the most frequent value in arr, or null if all values are equally
// frequent (ties, including the all-unique case).
function modeOf(arr) {
  if (!arr.length) return null;
  const freq = new Map();
  for (const v of arr) freq.set(v, (freq.get(v) || 0) + 1);
  const maxFreq = Math.max(...freq.values());
  if (maxFreq < 2) return null;   // all unique — no true mode
  const modes = [...freq.entries()].filter(([, f]) => f === maxFreq).map(([v]) => v);
  // Multiple values share the highest frequency → pick the higher weight (strength
  // bias: prefer the heavier working weight when there's a tie).
  return Math.max(...modes);
}

// Median of an array of numbers, result rounded to nearest 5 lb.
function medianOf(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return roundTo5(raw);
}

function computeBenchmark(liftCode, rows) {
  if (!liftCode || !Array.isArray(rows) || !rows.length) return nullBenchmark();

  const code = String(liftCode).toUpperCase().trim();

  // Parse raw rows for this lift, skip header and malformed entries.
  const parsed = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    if (String(row[COL_DATE] || '') === 'date_clean') continue;
    if (String(row[COL_LIFT] || '').toUpperCase().trim() !== code) continue;
    const weight = Number(row[COL_WEIGHT]);
    const reps   = Number(row[COL_REPS]);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (!Number.isFinite(reps)   || reps   <= 0) continue;
    const rirRaw = row[COL_RIR];
    const rir = (rirRaw == null || rirRaw === '') ? null : Number(rirRaw);
    // Use session_id as the primary grouping key; fall back to date_clean.
    const sessionId = String(row[COL_SESSION] || '') || String(row[COL_DATE] || '');
    const date      = String(row[COL_DATE] || '');
    parsed.push({ sessionId, date, weight, reps, rir });
  }

  if (!parsed.length) return nullBenchmark();

  // Group into sessions, preserving row order (Sheets returns rows by date asc).
  const sessionMap = new Map();
  for (const s of parsed) {
    if (!sessionMap.has(s.sessionId)) sessionMap.set(s.sessionId, { date: s.date, sets: [] });
    sessionMap.get(s.sessionId).sets.push(s);
  }

  // Per session: extract working sets (filter warm-ups).
  const sessionEntries = [];
  for (const [, { date, sets }] of sessionMap) {
    const maxWeight = Math.max(...sets.map(s => s.weight));
    let working = sets.filter(s =>
      s.weight >= maxWeight * WARMUP_WEIGHT_FRACTION &&
      (s.rir === null || !Number.isFinite(s.rir) || s.rir < WARMUP_RIR_THRESHOLD)
    );
    // If every set looks like a warm-up, keep them all (no penalty for missing RIR data).
    if (!working.length) working = sets;
    const topWeight = Math.max(...working.map(s => s.weight));
    sessionEntries.push({ date, working, topWeight });
  }

  // Sort sessions by date ascending to make recent-window slicing deterministic.
  sessionEntries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const sampleSize = sessionEntries.length;
  const confidence =
    sampleSize >= 5 ? 'high'   :
    sampleSize >= 3 ? 'medium' :
    sampleSize >= 1 ? 'low'    : 'none';

  // Working weight: mode of session top-set weights (rounded to 5 lb) captures
  // what the lifter TYPICALLY works at, not just their best or most recent.
  // Falls back to median when all sessions have unique top weights.
  const roundedTops = sessionEntries.map(s => roundTo5(s.topWeight));
  const workingWeight = modeOf(roundedTops) ?? medianOf(roundedTops);

  // Recent best: highest top-set weight in the most recent window.
  const recentSessions = sessionEntries.slice(-RECENT_SESSION_WINDOW);
  const recentBest = roundTo5(Math.max(...recentSessions.map(s => s.topWeight)));

  // Rep and RIR ranges across all working sets.
  const allWorking = sessionEntries.flatMap(s => s.working);

  const repVals = allWorking.map(s => s.reps);
  const repRange = repVals.length ? { min: Math.min(...repVals), max: Math.max(...repVals) } : null;

  const rirVals = allWorking.map(s => s.rir).filter(r => r !== null && Number.isFinite(r));
  const rirRange = rirVals.length ? { min: Math.min(...rirVals), max: Math.max(...rirVals) } : null;

  return { workingWeight, recentBest, repRange, rirRange, confidence, sampleSize };
}

/* Working-weight resolver — RIR-zone–anchored variant of the benchmark.
 *
 * Returns the mode (or median) of per-session top-set weights restricted to
 * sessions where the heaviest working set was logged in the target RIR zone
 * (0–3: hard work, not warm-up territory). When no session has in-zone RIR
 * data the function falls back gracefully to all sessions (same behaviour as
 * computeBenchmark's workingWeight field, without the 5 lb rounding that
 * computeBenchmark applies globally).
 *
 * Return shape:
 *   weight     – mode/median of qualifying top-set weights, rounded to 5 lb
 *   repRange   – { min, max } reps across qualifying sessions' working sets
 *   rirRange   – { min, max } RIR across those sets (null when no RIR data)
 *   confidence – 'high' (≥5 sessions) | 'medium' (3–4) | 'low' (1–2) | 'none'
 *   sampleSize – number of sessions used
 */
function nullWorkingWeight() {
  return { weight: null, repRange: null, rirRange: null, confidence: 'none', sampleSize: 0 };
}

function resolveWorkingWeight(liftCode, rows) {
  if (!liftCode || !Array.isArray(rows) || !rows.length) return nullWorkingWeight();

  const code = String(liftCode).toUpperCase().trim();

  // Parse all rows for this lift — identical to computeBenchmark's parse step.
  const parsed = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    if (String(row[COL_DATE] || '') === 'date_clean') continue;
    if (String(row[COL_LIFT] || '').toUpperCase().trim() !== code) continue;
    const weight = Number(row[COL_WEIGHT]);
    const reps   = Number(row[COL_REPS]);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (!Number.isFinite(reps)   || reps   <= 0) continue;
    const rirRaw  = row[COL_RIR];
    const rir     = (rirRaw == null || rirRaw === '') ? null : Number(rirRaw);
    const sessionId = String(row[COL_SESSION] || '') || String(row[COL_DATE] || '');
    const date      = String(row[COL_DATE] || '');
    parsed.push({ sessionId, date, weight, reps, rir });
  }

  if (!parsed.length) return nullWorkingWeight();

  // Group by session.
  const sessionMap = new Map();
  for (const s of parsed) {
    if (!sessionMap.has(s.sessionId)) sessionMap.set(s.sessionId, { date: s.date, sets: [] });
    sessionMap.get(s.sessionId).sets.push(s);
  }

  // Per session: filter warm-ups, find the top-set weight and its RIR.
  const sessionEntries = [];
  for (const [, { date, sets }] of sessionMap) {
    const maxWeight = Math.max(...sets.map(s => s.weight));
    let working = sets.filter(s =>
      s.weight >= maxWeight * WARMUP_WEIGHT_FRACTION &&
      (s.rir === null || !Number.isFinite(s.rir) || s.rir < WARMUP_RIR_THRESHOLD)
    );
    if (!working.length) working = sets;
    const topWeight = Math.max(...working.map(s => s.weight));
    // Minimum RIR among sets at the top weight = the hardest effort at peak load.
    const topSetsRir = working
      .filter(s => s.weight === topWeight)
      .map(s => s.rir)
      .filter(r => r !== null && Number.isFinite(r));
    const topRir = topSetsRir.length ? Math.min(...topSetsRir) : null;
    sessionEntries.push({ date, working, topWeight, topRir });
  }

  sessionEntries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Prefer sessions where the top-set RIR is within the target zone [0, 3].
  // These are genuine hard-work sessions that represent real working capacity.
  // Fall back to all sessions when no in-zone RIR data exists (e.g. early logs).
  const targetSessions = sessionEntries.filter(s =>
    s.topRir !== null && s.topRir >= TARGET_RIR_MIN && s.topRir <= TARGET_RIR_MAX
  );
  const sessions = targetSessions.length ? targetSessions : sessionEntries;

  const sampleSize = sessions.length;
  const confidence =
    sampleSize >= 5 ? 'high'   :
    sampleSize >= 3 ? 'medium' :
    sampleSize >= 1 ? 'low'    : 'none';

  const roundedTops = sessions.map(s => roundTo5(s.topWeight));
  const weight = modeOf(roundedTops) ?? medianOf(roundedTops);

  const allWorking = sessions.flatMap(s => s.working);
  const repVals = allWorking.map(s => s.reps);
  const repRange = repVals.length ? { min: Math.min(...repVals), max: Math.max(...repVals) } : null;
  const rirVals  = allWorking.map(s => s.rir).filter(r => r !== null && Number.isFinite(r));
  const rirRange = rirVals.length ? { min: Math.min(...rirVals), max: Math.max(...rirVals) } : null;

  return { weight, repRange, rirRange, confidence, sampleSize };
}

module.exports = { computeBenchmark, resolveWorkingWeight };
