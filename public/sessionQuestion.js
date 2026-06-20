/* Atlas — active-session question classifier.
 *
 * Pure, deterministic helper shared between coach-conversation.js (browser) and
 * the Node test suite. UMD wrapper: exports in Node, sets window.sessionQuestion
 * in the browser. No DOM, no closures, no side effects, no I/O, no LLM.
 *
 * PURPOSE (Trust-Critical Coach Interaction Layer, P0): during an active workout,
 * short workout-state questions ("RIR?", "reps?", "how much", "what next") must be
 * answered from the live session prescription, not intercepted by the generic
 * training-knowledge SME (/api/coach/ask) and answered with a textbook definition.
 *
 * `isSessionStateQuestion(message)` returns true ONLY for messages that clearly ask
 * about the current workout's state/prescription. It deliberately returns false for
 * explicitly educational questions ("what does RIR mean?", "what rep range builds
 * strength?", "what is training volume?", "explain RPE", "teach me about deloading")
 * so the SME education path is NEVER killed — those keep their existing routing.
 * Anything ambiguous also returns false (safe default = unchanged behavior).
 *
 * The caller gates this behind an active-session signal; this function only judges
 * the message shape.
 */
(function (root) {
  'use strict';

  // Workout-state question/command shapes. Each entry is intentionally specific so
  // educational framings (which reference a concept in the abstract, e.g. "what is
  // training volume") do not match — they fall through to the SME as before.
  const SESSION_PATTERNS = [
    // "what next" / "what's next" / "what is next"
    /\bwhat('?s| is)? next\b/,
    // "what am I doing/lifting/on next", "what am I supposed to do"
    /\bwhat am i (doing|lifting|on|supposed|up to)\b/,
    // "what exercise is next", "which exercise"
    /\bwh(at|ich) exercise\b/,
    // "next exercise/lift/movement/set/up"
    /\bnext (exercise|lift|movement|set|up)\b/,
    // "what's the target", "what is the target"
    /\bwhat('?s| is) (the |my )?(target|prescription|plan)\b/,
    // "the target" / "my target" (target rir/reps/weight for this lift)
    /\b(the|my) target\b/,
    // "how much" / "how much weight" (current prescribed load)
    /\bhow much\b/,
    // "how many reps" / "how many sets" (current prescription)
    /\bhow many (reps?|sets?)\b/,
    // "what should I do (now)" / "what now" / "what do I do"
    /\bwhat should i do\b/,
    /\bwhat do i do\b/,
    /\bwhat now\b/,
    // mid-session reorder / skip / fatigue / substitution signals
    /\bskip (that|this|it|ahead)\b/,
    /\brack('?s| is)? (busy|taken|occupied|full|in use)\b/,
    /\b(legs?|arms?|quads?|i'?m|im) (are |is )?(toast|fried|cooked|done|shot|smoked)\b/,
    /\binstead\b/, // "I'll do leg press instead", "do RDL instead"
    // bare shorthand with a question mark anywhere in the message:
    // "RIR?", "Reps?", "Sets?", "Weight?", "RPE?" (also catches "Weight? Reps? RIR?")
    /(^|[^a-z])(weight|reps?|sets?|rir|rpe|load)\s*\?/,
  ];

  function isSessionStateQuestion(message) {
    const m = (typeof message === 'string' ? message : '').toLowerCase().trim();
    if (!m) return false;
    return SESSION_PATTERNS.some((re) => re.test(m));
  }

  const exported = { isSessionStateQuestion };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.sessionQuestion = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
