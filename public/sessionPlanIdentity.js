/* Pure planned-session identity helpers shared by app.js and the Node tests.
 * UMD wrapper: exports in Node, sets window.sessionPlanIdentity in the browser.
 *
 * No DOM, no network, no writes.
 */
(function (root) {
  'use strict';

  function text(value) {
    return String(value || '').trim();
  }

  function key(value) {
    return text(value).toLowerCase();
  }

  function plannedExercises(plannedSession) {
    if (Array.isArray(plannedSession)) return plannedSession;
    if (plannedSession && Array.isArray(plannedSession.exercises)) return plannedSession.exercises;
    return [];
  }

  function planName(entry) {
    return text(
      (entry && (entry.canonicalName || entry.canonical_exercise)) ||
      (entry && (entry.name || entry.exercise))
    );
  }

  function planLiftCode(entry) {
    return key(entry && (entry.liftCode || entry.lift_code));
  }

  function planNameKeys(entry) {
    return [
      key(entry && (entry.canonicalName || entry.canonical_exercise)),
      key(entry && (entry.name || entry.exercise))
    ].filter(Boolean);
  }

  /**
   * Resolve the stable identity used for sessionCompleted / plan_completed.
   *
   * Priority:
   *   1. enrichment lift_code exact match
   *   2. enrichment canonical_exercise exact match
   *   3. raw logged name exact match against either plan display or canonical name
   *   4. raw logged name fallback
   */
  function resolveCompletedIdentity(rawName, enrichmentRow, plannedSession) {
    const exercises = plannedExercises(plannedSession);
    if (!exercises.length) return rawName;

    const loggedCode = key(enrichmentRow && (enrichmentRow.lift_code || enrichmentRow.liftCode));
    if (loggedCode) {
      const match = exercises.find(entry => planLiftCode(entry) === loggedCode);
      if (match) return planName(match) || rawName;
    }

    const canonical = key(enrichmentRow && (enrichmentRow.canonical_exercise || enrichmentRow.canonicalExercise));
    if (canonical) {
      const match = exercises.find(entry => planNameKeys(entry).includes(canonical));
      if (match) return planName(match) || rawName;
    }

    const raw = key(rawName);
    if (raw) {
      const match = exercises.find(entry => planNameKeys(entry).includes(raw));
      if (match) return planName(match) || rawName;
    }

    return rawName;
  }

  const exported = { resolveCompletedIdentity };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.sessionPlanIdentity = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
