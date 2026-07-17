'use strict';
/* Pending bodyweight-rep clarification (F09G / CONVO-LOG-1).
 *
 * When the parser returns needs_clarification but has ALREADY detected the sets
 * (its partial.sets — e.g. bare-rep bodyweight knee raises: "Knee raises 15 12 10"),
 * those reps must not be dropped. The composer holds them as a PENDING clarification:
 * the lifter sees a bounded question, and a short affirmation ("Just log it", "yes",
 * "log it") commits EXACTLY those sets to the session buffer — nothing fabricated (only
 * the parser's own detected reps), nothing silently dropped. One pending at a time; a
 * new clarification supersedes it, and any successful log / session reset clears it.
 *
 * Pure logic + a single module-scoped slot — no DOM, so it unit-tests directly in Node.
 * app.js wires three points: capture (on a needs_clarification carrying sets), resolve
 * (an affirmation logs them), and clear (a fresh log / reset supersedes it).
 */

// A short, standalone confirmation that RESOLVES a pending clarification into a log.
// Deliberately tight: ordinary chat ("yes but heavier?", a new set, a question, "log my
// squats too") must NOT match, or it would commit the held sets by accident.
const CLARIFY_YES_RE = /^(?:just\s+)?(?:log\s*(?:it|them|these|those|that)?|yes|yep|yeah|yup|correct|confirm(?:ed)?|do\s+it|go\s+ahead|that'?s\s+right)\s*[.!]*$/i;

export function looksLikeClarificationYes(text) {
  return CLARIFY_YES_RE.test(String(text == null ? '' : text).trim());
}

// Extract a holdable clarification { exercise, sets } from a parser result, or the error
// the client throws for one. Returns null when there is nothing concrete to hold (no
// exercise, or no set with a rep count) — so an ambiguous-alias / missing-exercise
// clarification, which carries no usable sets, is never held.
export function clarificationFrom(source) {
  if (!source || typeof source !== 'object') return null;
  const partial = (source.partial && typeof source.partial === 'object') ? source.partial : null;
  const exercise = (partial && partial.exercise) || source.recognizedExercise || source.exercise || null;
  const rawSets = partial && Array.isArray(partial.sets)
    ? partial.sets
    : (Array.isArray(source.partialSets) ? source.partialSets : null);
  if (!exercise || !Array.isArray(rawSets)) return null;
  const sets = rawSets.filter(s => s && s.reps != null);
  return sets.length ? { exercise, sets } : null;
}

// Convert held sets → the composer's logObj rows ({exercise, weight, reps, rir, notes}).
// Bodyweight weight (null) becomes '0' exactly as the normal parse path does
// (rowsFromBackendParsedWorkout), each detected rep count stays its own set, in order,
// so all reps and their set numbering are retained.
export function pendingSetsToLogObjs(clarification) {
  if (!clarification || !clarification.exercise || !Array.isArray(clarification.sets)) return [];
  return clarification.sets
    .filter(s => s && s.reps != null)
    .map(s => ({
      exercise: clarification.exercise,
      weight: s.weight == null ? '0' : String(s.weight),
      reps: String(s.reps),
      rir: s.rir == null ? '' : String(s.rir),
      notes: ''
    }));
}

// ── module-held single pending clarification ────────────────────────────────
let _pending = null;

// Hold a clarification (supersedes any prior). Returns the held record, or null when
// there was nothing concrete to hold — in which case the slot is CLEARED so a stale
// hold from an earlier turn can never linger behind a non-holdable clarification.
export function setPendingClarification(source) {
  const c = clarificationFrom(source);
  _pending = c ? { exercise: c.exercise, sets: c.sets, rows: pendingSetsToLogObjs(c) } : null;
  return _pending;
}

export function getPendingClarification() { return _pending; }

export function clearPendingClarification() { _pending = null; }

// Resolve on an affirmation: when a clarification is held AND the text is a short
// confirmation, return the rows to log and CLEAR the hold. Otherwise return null and
// keep the hold (the caller proceeds with its normal routing for that message).
export function resolvePendingClarification(text) {
  if (!_pending) return null;
  if (!looksLikeClarificationYes(text)) return null;
  const rows = _pending.rows;
  _pending = null;
  return Array.isArray(rows) && rows.length ? rows : null;
}
