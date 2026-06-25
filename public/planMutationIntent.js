/* Deterministic plan-mutation intent classifier (P0 Active Workout State
 * Unification, wiring Sub-PR 2a).
 *
 * Turns an explicit user statement about changing the workout into a structured
 * mutation the canonical ActiveSession can apply — WITHOUT asking the LLM. The app
 * state owns the mutation; the coach only ever explains it.
 *
 *   classifyMutationIntent("skip deadlifts/rdls and do squats")
 *     → { action: 'replace', target: 'deadlifts/rdls', substitute: 'squats' }
 *   classifyMutationIntent("skip leg extensions")
 *     → { action: 'skip', target: 'leg extensions' }
 *   classifyMutationIntent("how many reps?")            → null
 *
 * Conservative by design: it returns null for anything that isn't an unambiguous
 * swap/skip so the message falls through to the existing substitute/coach flow. The
 * caller resolves `target`/`substitute` against the live plan + catalog (the names
 * here are cleaned free-text phrases, matched case-insensitively downstream).
 *
 * PURE / UMD: no DOM, no I/O — unit-testable in Node, loadable in the browser.
 */
(function (root) {
  'use strict';

  // Strip conversational lead-ins so the intent verb lands at the start.
  const LEAD = /^(?:ok(?:ay)?|so|um|uh|hey|well|actually|i think|i'?ll|ill|i am going to|i'?m gonna|im gonna|i'?m going to|gonna|going to|let me|lets|let'?s|can we|could we|i want to|i wanna|i'?d like to|please|just)\s+/i;

  function stripLeads(t) {
    let s = t;
    for (let i = 0; i < 4; i++) {           // peel a few stacked lead-ins
      const next = s.replace(LEAD, '');
      if (next === s) break;
      s = next;
    }
    return s;
  }

  // Clean a captured exercise phrase: drop articles, trailing fillers, punctuation.
  function cleanName(s) {
    let t = String(s == null ? '' : s).trim().toLowerCase();
    t = t.replace(/[.?!,;:]+$/, '').trim();
    t = t.replace(/^(?:the|my|a|an|some)\s+/, '');
    t = t.replace(/\s+(?:instead|today|this time|for now|now|please|then)$/, '').trim();
    return t;
  }

  // A phrase is plausibly an exercise name (not empty, not a set-notation log).
  function looksLikeExercise(s) {
    if (!s) return false;
    if (s.length < 2 || s.length > 60) return false;
    if (/\d+\s*\/\s*\d+/.test(s)) return false;       // "225 5/2" — a logged set
    if (/^\d/.test(s)) return false;                  // leads with a number
    return /[a-z]/.test(s);
  }

  function replace(target, substitute) {
    const t = cleanName(target), sub = cleanName(substitute);
    if (!looksLikeExercise(t) || !looksLikeExercise(sub)) return null;
    if (t === sub) return null;
    return { action: 'replace', target: t, substitute: sub };
  }
  function skip(target) {
    const t = cleanName(target);
    if (!looksLikeExercise(t)) return null;
    return { action: 'skip', target: t };
  }

  /**
   * classifyMutationIntent(text) → { action:'replace', target, substitute }
   *                              | { action:'skip', target }
   *                              | null
   */
  function classifyMutationIntent(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    if (/\d+\s*\/\s*\d+/.test(raw)) return null;       // a slash-set log, never a mutation
    const t = stripLeads(raw.toLowerCase());

    let m;
    // "swap/replace/switch/sub X for|with|to Y"
    m = t.match(/^(?:swap|switch|sub(?:stitute)?|replace)\s+(.+?)\s+(?:for|with|to|->|→)\s+(.+)$/);
    if (m) return replace(m[1], m[2]);

    // "skip/drop/cut X [,/and] do|hit|use Y"  (explicit swap-by-skip)
    m = t.match(/^(?:skip|drop|cut|ditch)\s+(.+?)[,\s]+(?:and\s+|then\s+)?(?:do|doing|hit|use|go with|run)\s+(.+)$/);
    if (m) return replace(m[1], m[2]);

    // "X is/are/'s taken|busy|in use ... do|use|hit Y"
    m = t.match(/^(.+?)\s+(?:is|are|'?s)\s+(?:taken|busy|in use|unavailable|occupied|down)\b.*?\b(?:do|use|hit|run|go with)\s+(.+)$/);
    if (m) return replace(m[1], m[2]);

    // "do|hit|use Y instead of X"  and bare "Y instead of X"
    m = t.match(/^(?:do|doing|hit|use|run)\s+(.+?)\s+instead of\s+(.+)$/);
    if (m) return replace(m[2], m[1]);                 // substitute=Y(1), target=X(2)
    m = t.match(/^(.+?)\s+instead of\s+(.+)$/);
    if (m) return replace(m[2], m[1]);

    // skip-only: "skip/drop/cut X" with no replacement clause
    m = t.match(/^(?:skip|drop|cut|ditch)\s+(.+)$/);
    if (m) return skip(m[1]);

    return null;
  }

  const exported = { classifyMutationIntent, cleanName };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.planMutationIntent = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
