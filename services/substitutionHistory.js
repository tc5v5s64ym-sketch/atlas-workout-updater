'use strict';

/**
 * Build a substitution history from Log_Cleaned rows.
 *
 * Strategy: for each muscle group, find the "usual" lift code — the one that
 * appears in the most sessions (must appear ≥ MIN_SESSIONS_FOR_USUAL sessions
 * to be considered established). Then walk sessions chronologically: when the
 * usual lift is absent from a session but a different lift IS present for the
 * same muscle group, record a substitution event.
 *
 * Only one substitution event is emitted per (session × muscle group) pair
 * to avoid flooding from a single workout where many exercises were swapped.
 *
 * Returns [{original, substitute, date}] sorted chronologically.
 * Returns [] when rows is empty or no pattern is detectable.
 *
 * Pure function — no I/O, no LLM, no Sheets writes.
 */

// Columns in 12-col Log_Cleaned format:
const COL_DATE     = 0;
const COL_SESSION  = 1;
const COL_EXERCISE = 2; // raw logged name
const COL_MUSCLE   = 4;
const COL_LIFT     = 5;

// A lift must appear in at least this many distinct sessions before it is
// considered the "usual" exercise for its muscle group. Prevents sparse data
// from generating noisy substitution signals.
const MIN_SESSIONS_FOR_USUAL = 3;

function buildSubstitutionHistory(logRows) {
  if (!Array.isArray(logRows) || !logRows.length) return [];

  // Step 1: Parse rows into per-session, per-muscle-group lift usage.
  //   sessions: Map<sessionId, Map<muscle, Map<liftCode, {exercise, count}>>>
  const sessions = new Map();
  const sessionDates = new Map(); // session_id -> earliest date

  for (const row of logRows) {
    if (!Array.isArray(row)) continue;
    const date     = String(row[COL_DATE]     || '');
    if (date === 'date_clean') continue;
    const session  = String(row[COL_SESSION]  || '') || date;
    const exercise = String(row[COL_EXERCISE] || '');
    const muscle   = String(row[COL_MUSCLE]   || '').toLowerCase().trim();
    const liftCode = String(row[COL_LIFT]     || '').toUpperCase().trim();

    if (!session || !muscle || !liftCode || !exercise) continue;

    if (!sessions.has(session)) sessions.set(session, new Map());
    if (!sessionDates.has(session) || date < sessionDates.get(session)) {
      sessionDates.set(session, date);
    }
    const muscleMap = sessions.get(session);
    if (!muscleMap.has(muscle)) muscleMap.set(muscle, new Map());
    const liftMap = muscleMap.get(muscle);
    const prev = liftMap.get(liftCode);
    liftMap.set(liftCode, { exercise, count: prev ? prev.count + 1 : 1 });
  }

  if (!sessions.size) return [];

  // Step 2: For each muscle group, count how many sessions each lift appeared in.
  //   muscleLiftSessions: Map<muscle, Map<liftCode, {sessionCount, exercise}>>
  const muscleLiftSessions = new Map();
  for (const [, muscleMap] of sessions) {
    for (const [muscle, liftMap] of muscleMap) {
      if (!muscleLiftSessions.has(muscle)) muscleLiftSessions.set(muscle, new Map());
      const tally = muscleLiftSessions.get(muscle);
      for (const [liftCode, { exercise }] of liftMap) {
        const prev = tally.get(liftCode);
        tally.set(liftCode, { sessionCount: (prev ? prev.sessionCount : 0) + 1, exercise });
      }
    }
  }

  // Step 3: For each muscle group, find the "usual" lift (highest session count,
  //   minimum MIN_SESSIONS_FOR_USUAL).
  const usualLift = new Map(); // muscle -> {liftCode, exercise}
  for (const [muscle, tally] of muscleLiftSessions) {
    let best = null;
    for (const [liftCode, { sessionCount, exercise }] of tally) {
      if (sessionCount < MIN_SESSIONS_FOR_USUAL) continue;
      if (!best || sessionCount > best.sessionCount) {
        best = { liftCode, exercise, sessionCount };
      }
    }
    if (best) usualLift.set(muscle, best);
  }

  if (!usualLift.size) return [];

  // Step 4: Walk sessions chronologically; detect sessions where the usual lift
  //   is absent but a different lift is present for the same muscle group.
  const sortedSessions = [...sessions.entries()].sort((a, b) => {
    const da = sessionDates.get(a[0]) || '';
    const db = sessionDates.get(b[0]) || '';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const events = [];
  for (const [sessionId, muscleMap] of sortedSessions) {
    const date = sessionDates.get(sessionId) || '';
    for (const [muscle, liftMap] of muscleMap) {
      const usual = usualLift.get(muscle);
      if (!usual) continue;
      if (liftMap.has(usual.liftCode)) continue; // usual lift was done — not a substitution

      // Usual lift absent; emit ONE event for the substitute with the most sets
      // this session (most sets = likely the main working exercise, not a warm-up addition).
      let topSub = null;
      for (const [liftCode, { exercise, count }] of liftMap) {
        if (liftCode === usual.liftCode) continue;
        if (!topSub || count > topSub.count) topSub = { exercise, count };
      }
      if (topSub) {
        events.push({ original: usual.exercise, substitute: topSub.exercise, date });
      }
    }
  }

  return events;
}

module.exports = { buildSubstitutionHistory };
