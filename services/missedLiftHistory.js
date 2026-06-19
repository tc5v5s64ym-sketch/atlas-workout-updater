'use strict';

/**
 * Build a missed-lift history from planned-vs-completed session records.
 *
 * A "missed lift" is a planned exercise that was not completed in a session
 * where at least one other planned exercise WAS completed — confirming the
 * session actually happened rather than just being abandoned mid-plan.
 *
 * Inputs:
 *   sessions — Array of { planned: string[], completed: string[], date: string }
 *
 * Returns [{exercise: string, date: string}] sorted chronologically.
 * Returns [] when sessions is empty or no misses are detectable.
 *
 * Matching is case-insensitive name comparison (consistent with computePlanState).
 *
 * Pure function — no I/O, no LLM, no Sheets writes.
 *
 * Note: historical wiring requires a persistent session plan store (not yet
 * available). Current callers may feed single-session data to surface
 * current-session misses. Full cross-session pattern detection activates
 * once a plan store is wired.
 */
function buildMissedLiftHistory(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) return [];

  const events = [];

  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue;

    const date      = typeof session.date === 'string' ? session.date.trim() : '';
    const planned   = Array.isArray(session.planned)   ? session.planned.filter(e => typeof e === 'string' && e.trim()) : [];
    const completed = Array.isArray(session.completed) ? session.completed.filter(e => typeof e === 'string' && e.trim()) : [];

    if (!planned.length) continue;

    const completedLower = new Set(completed.map(e => e.trim().toLowerCase()));

    // Require that at least one planned exercise was actually completed — avoids
    // treating a fully-abandoned or unstarted session as a source of misses.
    const anyDone = planned.some(e => completedLower.has(e.trim().toLowerCase()));
    if (!anyDone) continue;

    for (const exercise of planned) {
      const name = exercise.trim();
      if (!name) continue;
      if (!completedLower.has(name.toLowerCase())) {
        events.push({ exercise: name, date });
      }
    }
  }

  // Sort chronologically; stable within same date.
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return events;
}

module.exports = { buildMissedLiftHistory };
