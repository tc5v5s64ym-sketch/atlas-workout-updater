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
const _exports = (function () {
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

  // A session VALUE word (the attribute the lifter is asking about).
  const ATTR_RE = /\b(rir|rpe|reps?|sets?|weight|load|how much|how many|how heavy|how light)\b/;
  // Past-tense / history framings — these are NOT current-plan questions.
  const HISTORY_RE = /\b(last time|last (week|session|month|workout|time)|previous(ly)?|history|before|used to)\b/;

  // True when the message asks a session value (rir/reps/weight/sets) about a lift
  // that is in the live plan/preview (names provided by the caller from context).
  // This catches the named-lift framings isSessionStateQuestion misses — e.g.
  // "what's the RIR for bench?" — so the caller can route them to the session-aware
  // coach (current plan) instead of the generic SME education. Returns false for
  // pure education ("what is RIR?" names no lift) and for history questions.
  function isPlannedLiftQuestion(message, liftNames) {
    const m = (typeof message === 'string' ? message : '').toLowerCase().trim();
    if (!m || !ATTR_RE.test(m) || HISTORY_RE.test(m)) return false;
    if (!Array.isArray(liftNames)) return false;
    return liftNames.some((n) => {
      const words = String(n == null ? '' : n).toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
      return words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(m));
    });
  }

  // A plan REFERENCE / DISPUTE / CORRECTION about what Atlas planned, prescribed,
  // recommended, or previously said. The 2026-07-21 production failure: an active
  // workout was running (Seated Row 200×10 @ 1 RIR ×3) and the athlete corrected
  // "That isn't what you planned. You planned 3 sets at 8 reps." — a correction, not
  // one of the enumerated session-state QUESTION shapes and carrying no lift name, so
  // it matched neither classifier above, fell to the generic SME, and got unrelated
  // warm-up advice. This flags such references so the caller (gated on an active
  // workout) routes them to the session-aware coach — which holds the current plan —
  // instead of the SME. It deliberately does NOT match pure education ("what is RIR?",
  // "how should I warm up?", "what muscles do seated rows work?"): those name no plan
  // and attribute nothing to Atlas, so they keep the SME education path untouched.
  //
  // Two shapes qualify (numbers optional; the active exercise supplies missing lift
  // context, so a lift name is never required):
  //   1. an ATTRIBUTION to Atlas — second-person "you planned / told me / said /
  //      gave me / programmed / prescribed / recommended / had me at …"; or
  //   2. a reference to "the plan / the workout / your program / …" paired with a
  //      stating, comparison, dispute, or numeric context (the bare noun alone is
  //      too broad — a plain mention must not skip the SME).
  function isPlanReference(message) {
    let m = (typeof message === 'string' ? message : '').toLowerCase().trim();
    if (!m) return false;
    // Normalize curly / typographic apostrophes to straight so "isn't" == "isn’t".
    m = m.replace(/[‘’ʼ′]/g, "'");

    // 1 — Atlas attribution: "you planned", "you told me", "you said", "you gave me",
    // "you programmed", "you prescribed", "you recommended", "you suggested", "you
    // set", etc. (suggest/recommend are the same coaching act — a correction like
    // "that's not what you suggested" must reach the session coach, not the SME).
    const YOU_PRESCRIBED = /\byou(?:'ve|'d| have| did)?\s+(?:just |already |only |actually |even )?(plan(?:n(?:ed|ing))?|prescrib(?:e|ed|ing)|programm?(?:ed|ing)?|program|recommend(?:ed|ing)?|suggest(?:ed|ing)?|told|telling|said|say|gave|give|giving|given|set)\b/;
    // "you had / have / got / put me (at) …" — had/have/got/put are too generic on
    // their own, so require the "me" that makes it a prescription to the athlete.
    const YOU_HAD_ME = /\byou (?:had|have|got|put) me\b/;
    if (YOU_PRESCRIBED.test(m) || YOU_HAD_ME.test(m)) return true;

    // 2 — a reference to the plan/workout/program paired with a genuine stating /
    // comparison / dispute / numeric signal. A bare copula (is/was/are) is deliberately
    // NOT such a signal: "was this workout good for hypertrophy?" is education the SME
    // answers deterministically, and must stay on the SME — so a plan-content statement
    // must carry a content verb (said/says/calls…), a dispute word (different/not/
    // wrong/changed…), a cognitive framing (thought/meant/supposed), or a number. An
    // abstract mention ("how does a training plan work?") has no determiner and no such
    // signal, so it never skips the SME either.
    const PLAN_NOUN = /\b(?:the|your|this|that|my|today's) (?:plan|workout|program|prescription|routine|session)\b/;
    const PLAN_CONTEXT = /\b(said?|says?|say|calls?|called|show(?:s|ed|n)?|reads?|different|differs?|change[ds]?|not|no|wrong|thought|meant|supposed|instead)\b|\d/;
    if (PLAN_NOUN.test(m) && PLAN_CONTEXT.test(m)) return true;

    return false;
  }

  // A plan-MODIFICATION REQUEST — the athlete asking to CHANGE the active plan
  // ("change it to 3x6", "can we change it to 3 sets of 6?", "make that 8 reps",
  // "could we lower it to 175?", "I want to change it to 3 sets"). During an active
  // workout these must reach the session-aware coach (/api/coach/chat), where #1126's
  // server-side classifier routes them into the proposal → approval → write flow —
  // NOT the generic SME. A shorthand request often carries neither a lift name nor the
  // word "plan", so isPlanReference / the session-state classifiers miss it and it
  // leaked to /api/coach/ask (the 2026-07-22 production failure: "Can we change it to
  // 3 sets of 6?" got a generic warm-up card).
  //
  // Mirrors services/coachResponseGrounding.isPlanModificationRequest EXACTLY (kept in
  // sync intentionally, like isPlanReference above) — same normalize, same two regexes:
  //   1. an IMPERATIVE change verb opening a clause ("change it…", "…, switch to…"); or
  //   2. a first-person desire / polite request cue ("i want/need/like…", "can/could
  //      we|you", "would/will you", "let's", "please") followed by a change verb.
  // Education carries neither shape, so it stays on the SME: "how do I change my grip?"
  // has no clause-opening verb and no request-cue+verb pair; "can changing rep ranges
  // build muscle?" never matches ("changing" isn't the bare verb; "can changing" isn't a
  // request cue). An over-match degrades safely — the turn reaches the read-only chat
  // coach, which proposes (never writes); an under-match strands a real change request.
  const MODIFY_VERB = 'change|make|switch|update|set|adjust|swap|replace|bump|drop|remove|redo|rework|cut|lower|raise|increase|decrease';
  const PLAN_MODIFY_RE = new RegExp(`(?:^|[.!?;,]\\s*|\\b(?:please|can you|could you|would you|will you|let'?s|i want you to|i'd like you to)\\s+)(${MODIFY_VERB})\\b`);
  const PLAN_MODIFY_REQUEST_RE = new RegExp(`\\b(?:i(?:'d| would)? (?:want|wanna|need|like|love)(?: to| you to)?|we (?:want|need|should|could|can)|can (?:you|we)|could (?:you|we)|would you|will you|let'?s|let us|please)\\b[^.?!;]*?\\b(?:${MODIFY_VERB})\\b`);

  function isPlanModificationRequest(message) {
    const m = (typeof message === 'string' ? message : '').toLowerCase().replace(/[‘’ʼ′]/g, "'").trim();
    if (!m) return false;
    return PLAN_MODIFY_RE.test(m) || PLAN_MODIFY_REQUEST_RE.test(m);
  }

  // A WORKOUT-GENERATION request — asking Atlas to create/plan a NEW session
  // ("Plan me a workout", "Plan me a workout but have it start with back squats",
  // "Build me a pull workout", "What should I train today?"). The 2026-07-22 production
  // failure: these leaked to the free-form /api/coach/chat lane, which had Gemini write a
  // pseudo-plan (incomplete prescriptions, no plan_version, no canonical lift codes) that
  // the client wrongly treated as an active plan. Generation must instead route to the
  // AUTHORITATIVE recommendation/plan pipeline (Coach's Pick → /api/plan/intent-recommendation).
  //
  // It must NOT match education/how-to ("how do I plan a workout?"), plan disputes /
  // corrections / explanations, or plan-MODIFICATION requests (those keep their #1126–#1128
  // routes). A generation verb (plan/build/make/create/generate/…) must precede a workout
  // noun within a couple words; a "how do I / how to …" framing is education and bails.
  const GEN_VERB = 'plan|build|make|create|generate|program|design|assemble|put together|set up|give me|throw together|write me';
  const GEN_NOUN = 'workout|session|training|lift|split|routine|program|leg day|push day|pull day|upper day|lower day';
  const GEN_REQUEST_RE = new RegExp(`\\b(?:${GEN_VERB})\\b\\s+(?:me\\s+|us\\s+)?(?:a|an|my|the|this|today'?s)?\\s*(?:\\w+\\s+){0,2}\\b(?:${GEN_NOUN})\\b`);
  const GEN_ASK_RE = /\bwhat should i train\b|\bwhat (?:should|do) (?:i|we) do today\b|\bwhat are we (?:doing|training)(?: today)?\b|\bwhat'?s the plan(?: today)?\b/;
  // A "how to / how do I / how does one …" framing is a request to be TAUGHT, not to
  // have a session generated ("How do I plan a workout?", "How to program a push day?").
  const GEN_HOWTO_RE = /\bhow (?:to|do|does|can|could|should|would)\b/;

  function isWorkoutGenerationRequest(message) {
    const m = (typeof message === 'string' ? message : '').toLowerCase().replace(/[‘’ʼ′]/g, "'").trim();
    if (!m) return false;
    if (GEN_HOWTO_RE.test(m)) return false; // "how do I plan a workout?" is education
    return GEN_REQUEST_RE.test(m) || GEN_ASK_RE.test(m);
  }

  // Structured planning constraints carried by a generation request, so the authoritative
  // pipeline can honor them: a requested FIRST exercise ("start with back squats") and a
  // focus / movement pattern ("pull workout", "upper body", "leg day"). Returns raw phrases;
  // the server canonicalizes the first-exercise name to a lift code. Exclusions/equipment
  // are not extracted here because the legacy authoritative engine does not honor them
  // (they exist only on the flag-gated One-Brain path) — "preserve when already supported".
  function extractGenerationConstraints(message) {
    const m = (typeof message === 'string' ? message : '').toLowerCase().replace(/[‘’ʼ′]/g, "'").trim();
    const out = {};
    if (!m) return out;
    const first = m.match(/\b(?:start(?:ing)?|begin(?:ning)?|open(?:ing)?|lead(?:ing)?|kick(?:ing)? off)\s+(?:it\s+|the\s+(?:workout|session)\s+)?with\s+([a-z][a-z '-]*?)\s*(?:,|\.|;|!|\?|\band\b|\bthen\b|\bplease\b|\bbut\b|$)/);
    if (first && first[1]) {
      out.firstExercise = first[1].trim().replace(/^(?:the|a|an|some|my)\s+/, '').trim();
      if (!out.firstExercise) delete out.firstExercise;
    }
    if (/\bupper(?:\s*body)?\b/.test(m)) out.focus = 'upper_body';
    else if (/\blower(?:\s*body)?\b|\bleg\s*day\b|\blegs\b/.test(m)) out.focus = 'lower_body';
    else if (/\bpush(?:\s*(?:day|workout|session))?\b/.test(m)) out.focus = 'push';
    else if (/\bpull(?:\s*(?:day|workout|session))?\b/.test(m)) out.focus = 'pull';
    else if (/\bfull[\s-]*body\b/.test(m)) out.focus = 'full_body';
    return out;
  }

  const exported = { isSessionStateQuestion, isPlannedLiftQuestion, isPlanReference, isPlanModificationRequest, isWorkoutGenerationRequest, extractGenerationConstraints };

  return exported;
})();

export const { isSessionStateQuestion, isPlannedLiftQuestion, isPlanReference, isPlanModificationRequest, isWorkoutGenerationRequest, extractGenerationConstraints } = _exports;
