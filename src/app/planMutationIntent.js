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

  // Conservative singularization: drop a trailing plural "s" only after a non-"s"
  // ("deadlifts"→"deadlift", "rows"→"row") so genuine "ss" endings survive ("press").
  function singular(s) {
    const t = String(s == null ? '' : s).toLowerCase().trim();
    return /[^s]s$/.test(t) ? t.slice(0, -1) : t;
  }

  // Split a compound target phrase into individual exercise tokens:
  // "deadlifts/rdls" → ["deadlifts","rdls"]; "deadlift and rdl" → ["deadlift","rdl"].
  function splitTargets(s) {
    return String(s == null ? '' : s)
      .split(/\s*(?:\/|,|&|\+|\band\b|\bor\b)\s*/i)
      .map(x => x.trim())
      .filter(Boolean);
  }

  /**
   * resolvePlanTargets(targetPhrase, planEntries) → string[]
   * Resolve a (possibly compound) target phrase to the matching PENDING plan-slot
   * names, in plan order. planEntries: [{ name, status? }]. A token matches a slot
   * by exact name, equal singular, or singular substring (either direction) — so
   * "deadlifts/rdls" resolves "Deadlift" AND a realistically-named "Romanian
   * Deadlift". Completed/skipped slots are NEVER matched (a swap/skip can't re-open
   * finished work). Returns [] when nothing matches (caller falls through).
   */
  // Word-set for the token-subset tier: lowercase, hyphens/slashes → spaces,
  // each word singularized — so "single leg press" can meet
  // "Single-Leg Seated Leg Press" word-by-word.
  function wordSet(s) {
    return new Set(String(s == null ? '' : s).toLowerCase()
      .replace(/[-/]+/g, ' ')
      .split(/\s+/)
      .map(singular)
      .filter(Boolean));
  }

  function resolvePlanTargets(targetPhrase, planEntries) {
    const entries = (Array.isArray(planEntries) ? planEntries : [])
      .filter(e => e && e.name && (e.status === undefined || e.status === 'pending'));
    const tokens = splitTargets(targetPhrase).map(singular).filter(Boolean);
    if (!tokens.length) return [];
    const names = [];
    for (const e of entries) {
      const en = singular(e.name);
      const enWords = wordSet(e.name);
      const hit = tokens.some(tok => {
        if (en === tok || en.includes(tok) || tok.includes(en)) return true;
        // Token-subset tier (owner live find 2026-07-03: "single leg press"
        // must resolve "Single-Leg Seated Leg Press"): every word of the
        // user's phrase appears in the slot name. Two-word minimum so a lone
        // "press"/"leg" can never vacuum up half the plan.
        const tokWords = [...wordSet(tok)];
        return tokWords.length >= 2 && tokWords.every(w => enWords.has(w));
      });
      if (hit && !names.includes(e.name)) names.push(e.name);
    }
    return names;
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
    // Normalize curly apostrophes (’ U+2019) to straight — mobile keyboards
    // autocorrect to curly, which would otherwise defeat the lead-in strip ("Let’s")
    // and leave the lead-in glued onto the captured substitute ("let's do rdls").
    const raw = String(text == null ? '' : text).replace(/’/g, "'").trim();
    if (!raw) return null;
    if (/\?\s*$/.test(raw)) return null;               // a question is never a mutation
    if (/\d+\s*\/\s*\d+/.test(raw)) return null;       // a slash-set log, never a mutation
    if (/\bdrop[\s-]?set/.test(raw.toLowerCase())) return null; // "drop set" is a technique, not a skip
    const t = stripLeads(raw.toLowerCase());
    // Interrogative lead → a question, never a plan mutation (contract: questions → null).
    // The single-word forms are unambiguous; the auxiliary forms require a following
    // pronoun ("do you" / "should i") so the imperative "do squats…" is preserved.
    if (/^(?:why|how|what'?s?|when|where|which|who|should|could|would|can)\b/.test(t)) return null;
    if (/^(?:do|does|did|is|are|am|was|were|will|have|has)\s+(?:i|you|we|it|they|he|she)\b/.test(t)) return null;

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

    // Reason-clause tolerance (owner live find 2026-07-03: "My legs are fried
    // right now I think I'll skip single leg press and leg extensions" fell to
    // the chat LLM, which debated instead of skipping). Every pattern above is
    // start-anchored, so a leading reason defeats them. When the message
    // carries a FIRST-PERSON INTENT marker glued to a mutation verb, classify
    // from that marker onward — the reason clause is context, not the intent.
    // Negations ("I don't think I'll skip…") never classify.
    if (/\b(?:don'?t|do not|not|never|won'?t|wouldn'?t|shouldn'?t|can'?t)\s+(?:think\s+)?(?:(?:i'?ll|i will|i'?m gonna|im gonna|i'?m going to|gonna|going to|wanna|want to)\s+)?(?:skip|drop|cut|ditch|swap|switch|sub(?:stitute)?|replace)\b/.test(t)) {
      return null;
    }
    m = t.match(/\b(?:i think\s+)?(?:i'?ll|i will|i'?m gonna|im gonna|i'?m going to|let'?s|i want to|i wanna)\s+((?:skip|drop|cut|ditch|swap|switch|sub(?:stitute)?|replace)\b.*)$/);
    if (m) {
      // An interrogative frame right before the marker ("do you think i'll
      // skip…") is a question about intent, not intent — never a mutation.
      const before = t.slice(0, m.index);
      if (/\b(?:do|does|did|should|would|could|can|will)\s+(?:you|we|they|i)\s+(?:think|say|guess|reckon|suppose|bet)\s*$/.test(before)) {
        return null;
      }
      const clause = m[1];
      // Re-run the anchored grammar on the extracted clause only — one code
      // lane for the patterns, no second grammar to drift.
      const inner = classifyMutationIntent(clause);
      if (inner) return inner;
    }

    return null;
  }

  const exported = { classifyMutationIntent, cleanName, splitTargets, resolvePlanTargets };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.planMutationIntent = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
