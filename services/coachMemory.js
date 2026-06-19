/* Coach memory: detect recurring patterns from historical training data.
 *
 * Pure function — no I/O, no LLM, no Sheets writes.
 *
 * detectPatterns(liftCode, rows, options?) → { patterns[] }
 *
 * patterns: zero or more of:
 *   { type: 'repeated_substitution', details: { original, substitute, count } }
 *   { type: 'consistent_underperformance', details: { sessions_below, sessions_checked } }
 *
 * Returns empty patterns array when data is insufficient — never noisy.
 *
 * options:
 *   substitutionHistory: [{original, substitute}] — last-N substitution events.
 *     Each entry represents one logged substitution across any lift. Optional;
 *     repeated_substitution is skipped when absent.
 *
 * 'missed_lift' pattern is deferred — needs planned-session data (not in rows).
 */
'use strict';

const { computeBenchmark } = require('./exerciseBenchmark');

const COL_DATE    = 0;
const COL_SESSION = 1;
const COL_LIFT    = 5;
const COL_WEIGHT  = 7;
const COL_REPS    = 8;
const COL_RIR     = 9;

const WARMUP_RIR_THRESHOLD   = 4;
const WARMUP_WEIGHT_FRACTION = 0.60;

// Session window and thresholds from the plan spec.
const SUBSTITUTION_SESSION_WINDOW  = 10;
const SUBSTITUTION_MIN_COUNT       = 3;
const UNDERPERFORMANCE_WINDOW      = 5;
const UNDERPERFORMANCE_MIN         = 3;
// Missed-lift pattern: fire after ≥ this many misses across the window.
// detectMissedLifts is a standalone utility — NOT wired into detectPatterns because
// missed lifts are exercise-name events (not lift-code-specific) and would contaminate
// per-lift patterns if mixed in. Call it directly when session-level context is needed.
const MISSED_LIFT_WINDOW           = 10;
const MISSED_LIFT_MIN_COUNT        = 1;
// e1RM deficit threshold — session e1RM below this fraction of benchmark e1RM
// counts as "below expected" for the consistent_underperformance pattern.
const UNDERPERFORMANCE_E1RM_DEFICIT = 0.05; // 5 %

function epley(weight, reps) {
  return weight * (1 + reps / 30);
}

// Group rows by session and filter to the target liftCode.
// Returns an array of sessions (chronological order), each being an array of rows.
function sessionsForLift(liftCode, rows) {
  if (!liftCode || !Array.isArray(rows)) return [];
  const bySession = new Map();
  const order = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    if (String(row[COL_LIFT] || '').trim().toLowerCase() !== liftCode.toLowerCase()) continue;
    const session = String(row[COL_SESSION] || '').trim();
    if (!session) continue;
    if (!bySession.has(session)) { bySession.set(session, []); order.push(session); }
    bySession.get(session).push(row);
  }
  return order.map(k => bySession.get(k));
}

// Filter warm-ups from a session's rows. Uses the same heuristic as
// exerciseBenchmark.js: weight < 60% of session max OR RIR ≥ 4.
// Falls back to all rows when every row looks like a warm-up.
function workingSets(sessionRows) {
  const weights = sessionRows.map(r => parseFloat(r[COL_WEIGHT]) || 0);
  const sessionMax = Math.max(...weights, 0);
  if (sessionMax === 0) return sessionRows;
  const working = sessionRows.filter(r => {
    const w = parseFloat(r[COL_WEIGHT]) || 0;
    const rir = r[COL_RIR] != null && r[COL_RIR] !== '' ? parseFloat(r[COL_RIR]) : null;
    if (w < sessionMax * WARMUP_WEIGHT_FRACTION) return false;
    if (rir !== null && rir >= WARMUP_RIR_THRESHOLD) return false;
    return true;
  });
  return working.length ? working : sessionRows;
}

// Return the top-set e1RM for a session (best e1RM among working sets).
function sessionTopE1RM(sessionRows) {
  const ws = workingSets(sessionRows);
  let best = 0;
  for (const r of ws) {
    const w = parseFloat(r[COL_WEIGHT]) || 0;
    const reps = parseFloat(r[COL_REPS]) || 0;
    if (w > 0 && reps > 0) best = Math.max(best, epley(w, reps));
  }
  return best > 0 ? best : null;
}

// Detect consistent_underperformance: e1RM in ≥ UNDERPERFORMANCE_MIN of last
// UNDERPERFORMANCE_WINDOW sessions falls ≥ UNDERPERFORMANCE_E1RM_DEFICIT below
// the benchmark e1RM. Returns pattern object or null.
function detectUnderperformance(liftCode, rows) {
  const benchmark = computeBenchmark(liftCode, rows);
  // Need a working weight to compute benchmark e1RM.
  if (!benchmark || !benchmark.workingWeight || !benchmark.repRange) return null;
  const benchE1RM = epley(
    benchmark.workingWeight,
    benchmark.repRange.min + Math.round((benchmark.repRange.max - benchmark.repRange.min) / 2)
  );
  if (benchE1RM <= 0) return null;

  const sessions = sessionsForLift(liftCode, rows);
  const window = sessions.slice(-UNDERPERFORMANCE_WINDOW);
  if (window.length < UNDERPERFORMANCE_WINDOW) return null; // need full window

  const threshold = benchE1RM * (1 - UNDERPERFORMANCE_E1RM_DEFICIT);
  let below = 0;
  for (const s of window) {
    const e1rm = sessionTopE1RM(s);
    if (e1rm !== null && e1rm < threshold) below++;
  }

  if (below >= UNDERPERFORMANCE_MIN) {
    return {
      type: 'consistent_underperformance',
      details: { sessions_below: below, sessions_checked: window.length }
    };
  }
  return null;
}

// Detect repeated_substitution: the same (original → substitute) swap appears
// ≥ SUBSTITUTION_MIN_COUNT times across the last SUBSTITUTION_SESSION_WINDOW
// entries in substitutionHistory. Returns array of pattern objects (one per
// qualifying swap pair). An empty array means no pattern detected.
function detectRepeatedSubstitutions(substitutionHistory) {
  if (!Array.isArray(substitutionHistory) || !substitutionHistory.length) return [];

  const window = substitutionHistory.slice(-SUBSTITUTION_SESSION_WINDOW);
  const counts = new Map();
  for (const entry of window) {
    if (!entry || typeof entry !== 'object') continue;
    const original   = typeof entry.original   === 'string' ? entry.original.trim().toLowerCase()   : null;
    const substitute = typeof entry.substitute === 'string' ? entry.substitute.trim().toLowerCase() : null;
    if (!original || !substitute) continue;
    const key = `${original}→${substitute}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const patterns = [];
  for (const [key, count] of counts) {
    if (count >= SUBSTITUTION_MIN_COUNT) {
      const [original, substitute] = key.split('→');
      patterns.push({ type: 'repeated_substitution', details: { original, substitute, count } });
    }
  }
  return patterns;
}

// Detect missed_lift: the same exercise appears in missedLiftHistory
// ≥ MISSED_LIFT_MIN_COUNT times across the last MISSED_LIFT_WINDOW entries.
// Returns array of pattern objects (one per qualifying exercise).
function detectMissedLifts(missedLiftHistory) {
  if (!Array.isArray(missedLiftHistory) || !missedLiftHistory.length) return [];

  const window = missedLiftHistory.slice(-MISSED_LIFT_WINDOW);
  const counts = new Map();
  for (const entry of window) {
    if (!entry || typeof entry !== 'object') continue;
    const exercise = typeof entry.exercise === 'string' ? entry.exercise.trim().toLowerCase() : null;
    if (!exercise) continue;
    counts.set(exercise, (counts.get(exercise) || 0) + 1);
  }

  const patterns = [];
  for (const [exercise, count] of counts) {
    if (count >= MISSED_LIFT_MIN_COUNT) {
      patterns.push({ type: 'missed_lift', details: { exercise, count } });
    }
  }
  return patterns;
}

/**
 * detectPatterns(liftCode, rows, options?) → { patterns[] }
 *
 * options.substitutionHistory – array of { original, substitute, liftCode } events (optional).
 *   Caller is responsible for filtering to the relevant liftCode before passing.
 *
 * NOTE: detectMissedLifts is NOT wired here. Missed-lift events are exercise-name-based
 * (not lift-code-specific) and must be evaluated at the session level by the caller,
 * not per-lift — mixing them in would attribute missed Row events to Bench, Deadlift, etc.
 */
function detectPatterns(liftCode, rows, options) {
  const patterns = [];
  const opts = options && typeof options === 'object' ? options : {};

  // Consistent underperformance — computed from rows vs benchmark.
  const underperf = detectUnderperformance(liftCode, rows);
  if (underperf) patterns.push(underperf);

  // Repeated substitution — requires caller-supplied history filtered to this liftCode.
  const subs = detectRepeatedSubstitutions(opts.substitutionHistory);
  patterns.push(...subs);

  return { patterns };
}

module.exports = { detectPatterns, detectMissedLifts };
