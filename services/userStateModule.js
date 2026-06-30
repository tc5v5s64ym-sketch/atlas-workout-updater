'use strict';

// UserStateModule — per-user, per-lift state substrate (read-only).
// Aggregates raw Log_Cleaned entries into a compact feature object:
//   e1RM trend, personal records, staleness, muscle volume vs landmarks,
//   and session adherence.
// No Sheets access, no side effects, no LLM involvement.
//
// Prime directive: the engine computes all values; the LLM only words them.
// Safe-ladder position: read-only math substrate (roadmap Phase 1, PR 6).
// Depends on: IntensityModule (PR 3), VolumeAssessmentModule (PR 4).
//
// Each row in logEntries is one set (matches the 12-col Log_Cleaned schema).
// opts.asOf is required and makes the function fully deterministic — pass
// the current date so staleness and window calculations are reproducible in tests.

const { estimateE1RM, percentOf1RM } = require('./intensityModule');
const { classifyMuscleVolume } = require('./volumeAssessmentModule');

const TREND_THRESHOLD     = 0.02; // 2 % change required to declare a trend
const DEFAULT_WINDOW_DAYS = 7;    // volume + adherence look-back
const DEFAULT_TREND_SESSIONS = 5; // sessions considered for e1RM trend

// Normalise muscle name: lowercase + strip trailing parenthetical qualifier.
// Matches VolumeModule's internal normalisation so keys are consistent.
function _normalizeMuscle(name) {
  return name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function _parseDate(str) {
  if (typeof str !== 'string' || !str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Positive days from earlier to later; clamped to 0 if negative.
function _daysBetween(earlier, later) {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 86400000));
}

// Estimate e1RM from a single log entry.
// Uses RIR-adjusted Epley (weight / percentOf1RM) when rir is valid (0–4).
// Falls back to plain Epley (estimateE1RM) when rir is absent or out of range.
// Returns null if weight/reps are invalid or estimation throws.
function _entryE1rm(entry) {
  const weight = Number(entry.weight);
  const reps   = Number(entry.reps);
  if (!isFinite(weight) || weight <= 0) return null;
  if (!isFinite(reps)   || reps < 1 || reps > 20) return null;

  const rawRir = entry.rir != null ? Number(entry.rir) : null;
  const rir = isFinite(rawRir) && rawRir >= 0 && rawRir <= 4 ? rawRir : null;

  try {
    if (rir !== null) {
      return Math.round((weight / percentOf1RM(reps, rir)) * 100) / 100;
    }
    return estimateE1RM(weight, reps);
  } catch {
    return null;
  }
}

// Build e1RM trend, PR, and staleness for one canonical exercise.
// entries: all log rows for that exercise (any date range).
function _buildLiftState(entries, asOfDate, trendSessions) {
  // sessionMap: dateStr → { date: Date, bestE1rm: number }
  const sessionMap = new Map();
  let allTimeBestE1rm   = 0;
  let allTimeBestWeight = 0;
  let allTimeBestReps   = 0;
  let latestDate    = null;
  let latestDateStr = null;

  for (const entry of entries) {
    const entryDate = _parseDate(entry.date_clean);
    if (!entryDate) continue;

    const dateStr = entry.date_clean;
    if (!latestDate || entryDate > latestDate) {
      latestDate    = entryDate;
      latestDateStr = dateStr;
    }

    const weight = Number(entry.weight);
    const reps   = Number(entry.reps);
    if (isFinite(weight) && weight > 0 && weight > allTimeBestWeight) {
      allTimeBestWeight = weight;
      allTimeBestReps   = isFinite(reps) && reps > 0 ? reps : 0;
    }

    const e1rm = _entryE1rm(entry);
    if (e1rm !== null) {
      if (e1rm > allTimeBestE1rm) allTimeBestE1rm = e1rm;
      const prev = sessionMap.get(dateStr);
      if (!prev) {
        sessionMap.set(dateStr, { date: entryDate, bestE1rm: e1rm });
      } else if (e1rm > prev.bestE1rm) {
        prev.bestE1rm = e1rm;
      }
    }
  }

  const daysSinceLastSession = latestDate ? _daysBetween(latestDate, asOfDate) : null;

  // Sort chronologically, take only the most recent trendSessions.
  const sessions = Array.from(sessionMap.values()).sort((a, b) => a.date - b.date);
  const recent   = sessions.slice(-trendSessions);
  const current  = recent.length > 0 ? recent[recent.length - 1].bestE1rm : null;

  let trend = 'insufficient_data';
  if (recent.length >= 2) {
    // Split: older = first floor(n/2), newer = remaining ceil(n/2).
    // Newer half is equal or larger, giving more weight to recent sessions.
    const split    = Math.floor(recent.length / 2);
    const older    = recent.slice(0, split);
    const newer    = recent.slice(split);
    const olderAvg = older.reduce((s, x) => s + x.bestE1rm, 0) / older.length;
    const newerAvg = newer.reduce((s, x) => s + x.bestE1rm, 0) / newer.length;
    const delta    = (newerAvg - olderAvg) / olderAvg;
    trend = delta >  TREND_THRESHOLD ? 'improving'
          : delta < -TREND_THRESHOLD ? 'declining'
          : 'stalling';
  }

  return {
    e1rm: { current, trend, sessionsTracked: recent.length },
    pr: {
      bestE1rm:      allTimeBestE1rm   > 0 ? allTimeBestE1rm   : null,
      bestSetWeight: allTimeBestWeight  > 0 ? allTimeBestWeight  : null,
      bestSetReps:   allTimeBestReps    > 0 ? allTimeBestReps    : null,
    },
    staleness: { daysSinceLastSession, lastSessionDate: latestDateStr },
  };
}

// Count per-muscle sets from entries inside the window; classify against landmarks.
// Entries outside [asOf - windowDays, asOf] are excluded.
function _buildMuscleVolumeState(entries, asOfDate, windowDays) {
  const windowStart = new Date(asOfDate.getTime() - windowDays * 86400000);
  const muscleSets  = {};

  for (const entry of entries) {
    const entryDate = _parseDate(entry.date_clean);
    if (!entryDate || entryDate < windowStart || entryDate > asOfDate) continue;
    const raw = typeof entry.muscle_group === 'string' ? entry.muscle_group : '';
    if (!raw.trim()) continue;
    const muscle = _normalizeMuscle(raw);
    muscleSets[muscle] = (muscleSets[muscle] || 0) + 1;
  }

  const result = {};
  for (const [muscle, weeklySets] of Object.entries(muscleSets)) {
    const c = classifyMuscleVolume(muscle, weeklySets);
    if (c) {
      result[muscle] = {
        weeklySets:    c.weeklySets,
        zone:          c.zone,
        landmarks:     c.landmarks,
        distanceToMav: c.distanceToMav,
        distanceToMrv: c.distanceToMrv,
      };
    } else {
      // Muscle not in landmark config — still track the set count.
      result[muscle] = { weeklySets, zone: null, landmarks: null };
    }
  }
  return result;
}

// Count distinct training dates in the window; derive sessions per week.
function _buildAdherenceState(entries, asOfDate, windowDays) {
  const windowStart  = new Date(asOfDate.getTime() - windowDays * 86400000);
  const sessionDates = new Set();

  for (const entry of entries) {
    const entryDate = _parseDate(entry.date_clean);
    if (!entryDate || entryDate < windowStart || entryDate > asOfDate) continue;
    sessionDates.add(entry.date_clean);
  }

  const sessionsInWindow = sessionDates.size;
  const sessionsPerWeek  = windowDays > 0
    ? Math.round((sessionsInWindow / windowDays * 7) * 100) / 100
    : 0;

  return { sessionsInWindow, windowDays, sessionsPerWeek };
}

// Assemble the compact per-user state from an array of Log_Cleaned rows.
//
// logEntries — array of row objects. Minimum required fields per row:
//   date_clean        string  ISO date (e.g. "2026-06-30")
//   canonical_exercise string  name of the lift
//   muscle_group      string  primary muscle (may include parenthetical qualifier)
//   weight            number  weight lifted (> 0)
//   reps              number  reps performed (1–20 for e1RM; any for PR/volume)
//   rir               number? reps in reserve (0–4; null/undefined treated as absent)
//
// opts:
//   asOf          (required) ISO date string — reference point for staleness + window.
//   windowDays    (default 7) — calendar days for volume + adherence look-back.
//   trendSessions (default 5) — recent sessions for e1RM trend; minimum 2.
//
// Returns null for non-array logEntries or missing/invalid asOf.
function buildUserState(logEntries, opts) {
  if (!Array.isArray(logEntries)) return null;
  const options   = opts != null && typeof opts === 'object' ? opts : {};
  const asOfDate  = _parseDate(options.asOf);
  if (!asOfDate) return null;

  const windowDays = typeof options.windowDays === 'number' && options.windowDays > 0
    ? options.windowDays : DEFAULT_WINDOW_DAYS;
  const trendSessions = typeof options.trendSessions === 'number' && options.trendSessions >= 2
    ? options.trendSessions : DEFAULT_TREND_SESSIONS;

  const byLift       = new Map();
  const validEntries = [];

  for (const entry of logEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const exercise = typeof entry.canonical_exercise === 'string'
      ? entry.canonical_exercise.trim() : '';
    if (!exercise) continue;
    if (!_parseDate(entry.date_clean)) continue;

    validEntries.push(entry);
    const list = byLift.get(exercise);
    if (list) list.push(entry);
    else byLift.set(exercise, [entry]);
  }

  const liftStates = {};
  for (const [exercise, entries] of byLift) {
    liftStates[exercise] = _buildLiftState(entries, asOfDate, trendSessions);
  }

  return {
    asOf:         options.asOf,
    windowDays,
    liftStates,
    muscleVolume: _buildMuscleVolumeState(validEntries, asOfDate, windowDays),
    adherence:    _buildAdherenceState(validEntries, asOfDate, windowDays),
  };
}

module.exports = { buildUserState, _normalizeMuscle };
