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
// Matching discipline:
//   - Single-word keywords use \b word boundaries to avoid partial matches
//     (e.g. "taken" must not match "mistaken").
//   - Multi-word phrases use substring search (inherently anchored by context).
//   - "full" and "closed" are intentionally excluded: both appear frequently
//     in fitness phrasing ("Full ROM", "full body", "I closed my grip") and
//     produce too many false positives to be useful as bare keywords.

const CONSTRAINT_PATTERNS = [
  /\bbusy\b/i,
  /\bunavailable\b/i,
  /\btaken\b/i,
  /\boccupied\b/i,
  /\bbroken\b/i,
  /out of order/i,
  /not available/i,
  /not working/i,
  /\bis\s+closed\b/i,   // "Gym is closed" — bare 'closed' excluded (matches "I closed my grip")
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
  return CONSTRAINT_PATTERNS.some(re => re.test(text));
}

module.exports = { isConstraintMessage, CONSTRAINT_PATTERNS };
