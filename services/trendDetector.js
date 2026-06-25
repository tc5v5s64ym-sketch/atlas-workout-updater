/* e1RM trend detector from historical Log_Cleaned rows.
 *
 * Pure function — no I/O, no LLM, no Sheets writes.
 * Accepts raw 2D rows from getSheetRows() (same shape as other analytics services).
 *
 * Returns:
 *   trend          – 'improving' | 'flat' | 'declining' | 'noisy' | 'insufficient_data'
 *   confidence     – 'high' (≥6 sessions) | 'medium' (4–5) | 'none'
 *   sessions_analyzed – number of sessions used
 *
 * Algorithm:
 *   1. Parse the lift's rows, group into sessions, filter warm-ups (same heuristic
 *      as exerciseBenchmark.js: weight < 60 % of session max OR RIR ≥ 4 → warm-up).
 *   2. Compute the best Epley e1RM across each session's working sets.
 *   3. Slice to the last SESSION_WINDOW sessions; require MIN_SESSIONS.
 *   4. Coefficient of variation > NOISY_CV_THRESHOLD → 'noisy' (high variance,
 *      no clear direction).
 *   5. Otherwise compare the first-half mean vs second-half mean:
 *      delta ≥ +TREND_DELTA_FRACTION of overall mean → 'improving'
 *      delta ≤ −TREND_DELTA_FRACTION              → 'declining'
 *      else                                         → 'flat'
 *
 * Column indices match the 12-column Log_Cleaned contract in CLAUDE.md.
 */
'use strict';

const { isWarmupNote } = require('./warmupTag');

const COL_DATE    = 0;
const COL_SESSION = 1;
const COL_LIFT    = 5;
const COL_WEIGHT  = 7;
const COL_REPS    = 8;
const COL_RIR     = 9;
const COL_NOTES   = 10;

const WARMUP_RIR_THRESHOLD   = 4;
const WARMUP_WEIGHT_FRACTION = 0.60;

const SESSION_WINDOW       = 8;    // look back up to this many sessions
const MIN_SESSIONS         = 4;    // minimum required for a trend verdict
const NOISY_CV_THRESHOLD   = 0.10; // coefficient of variation > 10 % → noisy
const TREND_DELTA_FRACTION = 0.025; // 2.5 % of mean e1RM = meaningful direction

// Epley formula: estimated one-rep max from a multi-rep set.
function epley(weight, reps) {
  return weight * (1 + reps / 30);
}

function meanOf(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDevOf(arr) {
  const m = meanOf(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function nullTrend(sessions_analyzed = 0) {
  return { trend: 'insufficient_data', confidence: 'none', sessions_analyzed };
}

function detectTrend(liftCode, rows) {
  if (!liftCode || !Array.isArray(rows) || !rows.length) return nullTrend();

  const code = String(liftCode).toUpperCase().trim();

  // Parse raw rows for this lift.
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
    const warmup = isWarmupNote(row[COL_NOTES]);
    const sessionId = String(row[COL_SESSION] || '') || String(row[COL_DATE] || '');
    const date      = String(row[COL_DATE] || '');
    parsed.push({ sessionId, date, weight, reps, rir, warmup });
  }

  if (!parsed.length) return nullTrend();

  // Group by session.
  const sessionMap = new Map();
  for (const s of parsed) {
    if (!sessionMap.has(s.sessionId)) sessionMap.set(s.sessionId, { date: s.date, sets: [] });
    sessionMap.get(s.sessionId).sets.push(s);
  }

  // Per session: filter warm-ups, compute best e1RM across working sets.
  const sessionEntries = [];
  for (const [, { date, sets }] of sessionMap) {
    const maxWeight = Math.max(...sets.map(s => s.weight));
    let working = sets.filter(s =>
      // An explicit warm-up tag (notes) is authoritative — excluded even if heavy
      // or low-RIR (closes the heavy-warm-up hole the weight/RIR heuristic leaves).
      !s.warmup &&
      s.weight >= maxWeight * WARMUP_WEIGHT_FRACTION &&
      (s.rir === null || !Number.isFinite(s.rir) || s.rir < WARMUP_RIR_THRESHOLD)
    );
    if (!working.length) working = sets;
    const sessionE1rm = Math.max(...working.map(s => epley(s.weight, s.reps)));
    sessionEntries.push({ date, e1rm: sessionE1rm });
  }

  sessionEntries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Use only the most recent SESSION_WINDOW sessions.
  const recent = sessionEntries.slice(-SESSION_WINDOW);
  if (recent.length < MIN_SESSIONS) return nullTrend(recent.length);

  const sessions_analyzed = recent.length;
  const e1rms = recent.map(s => s.e1rm);
  const overallMean = meanOf(e1rms);

  const confidence = sessions_analyzed >= 6 ? 'high' : 'medium';

  // Direction first: a strong linear trend naturally inflates CV (the spread
  // around the series mean grows with slope), so checking CV before direction
  // would misclassify clean novice progressions as noisy. Evaluate direction
  // first; only fall through to the CV/noisy check when the direction is flat.
  const half       = Math.floor(sessions_analyzed / 2);
  const firstMean  = meanOf(e1rms.slice(0, half));
  const secondMean = meanOf(e1rms.slice(-half));
  const delta      = secondMean - firstMean;
  const threshold  = overallMean * TREND_DELTA_FRACTION;

  if (delta >= threshold)  return { trend: 'improving', confidence, sessions_analyzed };
  if (delta <= -threshold) return { trend: 'declining', confidence, sessions_analyzed };

  // No clear direction. High variance here means random scatter, not a trend.
  const cv = overallMean > 0 ? stdDevOf(e1rms) / overallMean : 0;
  const trend = cv > NOISY_CV_THRESHOLD ? 'noisy' : 'flat';
  return { trend, confidence, sessions_analyzed };
}

module.exports = { detectTrend };
