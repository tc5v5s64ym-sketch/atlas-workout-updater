'use strict';

// Constraint message detector
//
// Deterministic. Pure function. No I/O, no LLM.
// Detects whether a user message indicates that an exercise or piece of
// equipment is currently unavailable (busy, broken, taken, etc.).
//
// Used by the substitution recommendation flow: if a constraint message is
// detected while a planned exercise is active, the recommender is consulted.
// The visible integration (endpoint + UI wiring) lives in PR 344.
//
// Intentionally conservative — matches only clear unavailability signals.
// Ambiguous phrases like "no" alone are not matched.

const CONSTRAINT_KEYWORDS = [
  'busy',
  'unavailable',
  'taken',
  'occupied',
  'broken',
  'out of order',
  'not available',
  'not working',
  'full',
  'closed',
];

/**
 * Returns true when the message expresses that equipment or an exercise
 * is unavailable — the caller should consult recommendSubstitute().
 *
 * @param {string} text  - The raw user message.
 * @returns {boolean}
 */
function isConstraintMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return CONSTRAINT_KEYWORDS.some(kw => lower.includes(kw));
}

module.exports = { isConstraintMessage, CONSTRAINT_KEYWORDS };
