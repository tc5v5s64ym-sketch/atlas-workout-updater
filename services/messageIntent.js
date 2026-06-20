// AC8 — phantom-set credibility floor (see CONVERSATION_DESIGN.md).
//
// The real 2026-06-16 bug: the question "Didn't you suggest 225 5/2 x3" was
// parsed as a set, logged under a fabricated exercise ("Didn't You Suggest"),
// celebrated, AND flagged "didn't catch that lift" — all at once. Atlas must
// never log a phantom set: a question is answered and nothing is logged; an
// unresolved lift is not saved (Atlas asks which lift); and an unlogged set is
// never celebrated.
//
// This module is the DETERMINISTIC guard for that floor. It is pure (no I/O, no
// parser/save-path edit). The save path wires it in a follow-up PR: it consumes
// the raw composer text plus two facts the parser already knows — whether the
// message resolved to a known lift, and whether it carried set tokens — and
// decides whether logging must be suppressed and why.

// Does the message read as a question? Conservative on purpose: a bare past-tense
// log like "did 225x5" ("I did 225 for 5") must NOT count as a question, so a
// leading "did"/"do" alone never qualifies — only a trailing "?", an
// interrogative opener, or an explicit question phrase does.
function isQuestionText(text) {
  const t = String(text == null ? '' : text).trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith('?')) return true;

  // Interrogative openers. Each is anchored with \b so it can't fire on a lift
  // name that merely starts with the same letters (e.g. "are" must not match
  // "arnold press", "is" must not match a lift like "iso row").
  const QUESTION_OPENERS = /^(what|whats|what's|whatre|whatra|when|where|why|how|hows|how's|which|who|whom|should|shouldn'?t|could|couldn'?t|would|wouldn'?t|can|will|won'?t|are|aren'?t|is|isn'?t|am|was|were|does|doesn'?t)\b/;
  if (QUESTION_OPENERS.test(t)) return true;

  // Explicit question phrases that can appear after a leading word.
  const QUESTION_PHRASES = /\b(didn'?t you|did you|do you|don'?t you|should i|shall i|shall we|should we|do i|what should|how much should|how many should|is it|are these)\b/;
  if (QUESTION_PHRASES.test(t)) return true;

  return false;
}

// Decide whether logging must be suppressed for this message, and why.
//
// facts:
//   hasResolvedLift — the message resolved to a known catalogue lift (or an
//                     active in-progress exercise the set continues).
//   hasSetTokens    — the message carried parseable set tokens (weight/reps...).
//
// Returns { isQuestion, suppressLog, reason } where reason ∈
//   'question'        — answer it, log nothing (pure question, no real set).
//   'unresolved_lift' — don't save; echo "didn't catch that lift — which one?".
//   null              — nothing to suppress.
//
// Precedence: a message that resolved to a real lift AND carried set tokens is a
// genuine set — it logs even if it also asks a question ("Crushed 235x8, should
// I go up?" → log the set, answer the question). Only when there is no real,
// resolved set do the suppression rules fire.
function classifyMessageIntent(rawText, facts = {}) {
  const hasResolvedLift = Boolean(facts.hasResolvedLift);
  const hasSetTokens = Boolean(facts.hasSetTokens);
  const isQuestion = isQuestionText(rawText);

  if (hasResolvedLift && hasSetTokens) {
    return { isQuestion, suppressLog: false, reason: null };
  }
  if (isQuestion) {
    return { isQuestion: true, suppressLog: true, reason: 'question' };
  }
  if (hasSetTokens && !hasResolvedLift) {
    return { isQuestion: false, suppressLog: true, reason: 'unresolved_lift' };
  }
  return { isQuestion, suppressLog: false, reason: null };
}

module.exports = { classifyMessageIntent, isQuestionText };
