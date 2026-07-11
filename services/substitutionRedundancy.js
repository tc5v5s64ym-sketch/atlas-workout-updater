'use strict';

// Substitution redundancy — context awareness for engine-picked substitutions.
//
// Deterministic, pure. Live evidence (2026-07-11): Back Squat was auto-replaced with
// Leg Press while the very next planned slot was Single-Leg Seated Leg Press —
// redundant back-to-back movements. This module answers ONE question: is a candidate
// substitute redundant with an already-planned exercise? "Redundant" means the same
// exercise, an alias, a unilateral/bilateral variant, or an obvious same-movement-
// family duplicate.
//
// It works from the exercise NAME STRUCTURE (generic laterality / implement /
// orientation modifiers) plus the existing movement-pattern metadata as a guard — it
// hard-codes NO exercise names. Modifier vocabulary is generic ("single-leg",
// "seated", "barbell", …), never a specific lift. The pattern guard (services/
// movementPattern) keeps a coincidental shared core word (e.g. "press" in leg press
// vs bench press) from reading as family across different movement patterns.

const { patternFor } = require('./movementPattern');

// Generic modifiers that do NOT change exercise identity: laterality, implement, and
// bench/seat orientation words. Movement-defining qualifiers (front/goblet/hack/
// bulgarian/split/incline/decline/romanian/sumo/close-grip…) are deliberately NOT here.
const MODIFIERS = new RegExp(
  '\\b(?:single|one|1)[\\s-]*(?:leg|arm|side[d]?)\\b' +            // single-leg / one-arm / single-sided
  '|\\b(?:unilateral|bilateral|alternating|alt)\\b' +
  '|\\b(?:seated|standing|lying|machine|smith|cable|barbell|bb|dumbbell|db|kettlebell|kb|banded|band|45[\\s-]?degree)\\b',
  'g'
);

// Conservative singular: drop a trailing plural "s" only after a non-"s"
// ("curls"→"curl", "squats"→"squat") so "press"/"cross" survive.
function _singular(w) {
  return /[^s]s$/.test(w) ? w.slice(0, -1) : w;
}

// The sorted set of core (identity-bearing) tokens of an exercise name, with generic
// modifiers stripped. "Single-Leg Seated Leg Press" → ["leg","press"]; "Leg Press" →
// ["leg","press"]; "Goblet Squat" → ["goblet","squat"].
function coreTokens(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[-/]+/g, ' ')
    .replace(MODIFIERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(_singular)
    .filter(Boolean)
    .sort();
}

// Same known movement pattern? Unknown / 'other' on either side is permissive (the
// name-core signal decides) — the guard only VETOES a match across two KNOWN, DIFFERENT
// patterns, so "Leg Press" (squat) never reads as family with "Bench Press" (push).
function _samePattern(a, b) {
  const pa = patternFor(a), pb = patternFor(b);
  const na = pa && pa.pattern, nb = pb && pb.pattern;
  if (!na || !nb || na === 'other' || nb === 'other') return true;
  return na === nb;
}

// Two exercises are the same movement family when their identity-bearing tokens match
// exactly (after stripping generic modifiers) AND they do not sit in two different
// known movement patterns. Catches same-exercise, alias, and unilateral/bilateral
// variants without naming any exercise.
function sameMovementFamily(a, b) {
  const ta = coreTokens(a), tb = coreTokens(b);
  if (!ta.length || ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return false;
  return _samePattern(a, b);
}

// Is `candidate` redundant with ANY exercise already in the (remaining) plan? Total —
// null/garbage `others` → false, never throws.
function isRedundantWithAny(candidate, others) {
  const list = Array.isArray(others) ? others : [];
  return list.some(o => o && sameMovementFamily(candidate, o));
}

module.exports = { sameMovementFamily, isRedundantWithAny, coreTokens };
