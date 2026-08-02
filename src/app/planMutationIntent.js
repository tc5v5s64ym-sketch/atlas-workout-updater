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
const _exports = (function () {
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
    // Strip trailing session-scope fillers REPEATEDLY so a stacked tail
    // ("rdls for me today") reduces to the bare exercise ("rdls"). No exercise
    // name ends in one of these words, so this never eats a real lift.
    let prev;
    do {
      prev = t;
      t = t.replace(/[,\s]+(?:instead|today|tonight|this time|for now|right now|for me|for the day|for the rest of (?:the\s+)?(?:session|workout|day)|now|please|then)$/, '').trim();
    } while (t !== prev);
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
    const exactNames = [];
    for (const e of entries) {
      const en = singular(e.name);
      const enWords = wordSet(e.name);
      // Lift-code stem (owner live find 2026-07-07: "no RDLs" must reach the
      // "Romanian Deadlift" slot, whose name has no "rdl" substring). Match a token
      // against the slot's lift code with its trailing serial dropped: RDL01→"rdl",
      // OHP01→"ohp". Guarded to ≥2 chars so a stub code never over-matches.
      const codeStem = String(e.liftCode || e.lift_code || '').toLowerCase().replace(/\d+$/, '');
      let exactHit = false;
      const hit = tokens.some(tok => {
        if (en === tok) { exactHit = true; return true; }
        if (en.includes(tok) || tok.includes(en)) return true;
        if (codeStem.length >= 2 && tok === codeStem) return true;
        // Token-subset tier (owner live find 2026-07-03: "single leg press"
        // must resolve "Single-Leg Seated Leg Press"): every word of the
        // user's phrase appears in the slot name. Two-word minimum so a lone
        // "press"/"leg" can never vacuum up half the plan.
        const tokWords = [...wordSet(tok)];
        return tokWords.length >= 2 && tokWords.every(w => enWords.has(w));
      });
      if (hit && !names.includes(e.name)) {
        names.push(e.name);
        if (exactHit) exactNames.push(e.name);
      }
    }
    // Wrong-target guard: for a SINGLE-token target, an EXACT name match ranks
    // ahead of fuzzy (substring/word-subset) matches. The live callers mutate
    // targetNames[0], so plan order alone would let "skip leg press" act on a
    // "Single-Leg Seated Leg Press" slot that happens to come earlier — a slot the
    // athlete never named. Fuzzy matches still resolve, ranked after. COMPOUND
    // targets keep plan order: the caller acts on every match, so there is no
    // single wrong pick to guard, and the pinned compound resolutions are unchanged.
    if (tokens.length === 1 && exactNames.length) {
      return exactNames.concat(names.filter(n => !exactNames.includes(n)));
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

  // A POSITIONAL reference names a slot by position, not by exercise name:
  // "next exercise/workout/lift/one", "the next one", "current exercise", "this one".
  // The caller resolves it against the LIVE plan (the current/next pending slot) —
  // the classifier must never treat it as a lift NAME to fuzzy-match (the live repro:
  // "swap next workout for dips" matched no slot and fell through to the LLM, which
  // then removed Dips). `positional:true` tells the caller to resolve by position.
  const POSITIONAL = '__current__';
  const POSITIONAL_RE = /^(?:next|current|upcoming|following|this)(?:\s+(?:one|exercise|workout|lift|set|movement|thing))?$/;
  function isPositional(phrase) {
    return POSITIONAL_RE.test(cleanName(phrase));
  }

  // A vague "give me an unspecified replacement" noun phrase — NOT a real exercise
  // name. The athlete is asking the ENGINE to pick the substitute, so this must never
  // become a literal "something else" slot; it flips a swap/decline to an IMPLICIT
  // substitution (production bug 2026-07-11: "…give me something else" skipped Back
  // Squat; "replace X with something else" would have created a phantom exercise).
  const VAGUE_SUB_RE = /^(?:something\s+(?:else|different)|another\s+(?:exercise|movement|lift|one)|an?\s+alternative|a\s+different\s+(?:exercise|movement|lift|one)|anything\s+else)$/;
  function isVagueReplacement(phrase) {
    const p = String(phrase == null ? '' : phrase).toLowerCase().trim().replace(/[.?!,;:]+$/, '').trim();
    return VAGUE_SUB_RE.test(p);
  }

  // A trailing "give me something else"-style REQUEST clause: an optional request verb
  // + a vague-replacement noun phrase, or "what else can I do". Anchored at $, so it
  // only strips when the phrase ENDS with a replacement request (a real trailing
  // exercise name is never a vague NP, so it is never stripped).
  const REPLACEMENT_REQUEST_TAIL = /[\s,;]*(?:\b(?:and|so|but|then)\b\s*)?(?:(?:can|could)\s+(?:you|i)\s+|please\s+)?(?:give\s+me|gimme|get\s+me|grab\s+me|show\s+me|find\s+me|suggest|recommend|pick(?:\s+me)?|i\s+(?:want|need)|i'?d\s+(?:like|prefer)|let'?s\s+(?:do|try))?\s*(?:something\s+(?:else|different)|another\s+(?:exercise|movement|lift|one)|an?\s+alternative|a\s+different\s+(?:exercise|movement|lift|one)|anything\s+else)\s*$/;
  const WHAT_ELSE_TAIL = /[\s,;]*(?:\b(?:and|so|but|then)\b\s*)?what\s+else\s+can\s+i\s+do\b.*$/;

  // Split a trailing replacement REQUEST off a decline phrase → the bare target, or
  // null when no request is present. "squats, give me something else" → "squats";
  // "squats today" → null (a plain decline, whose skip behavior is unchanged).
  function stripReplacementRequest(phrase) {
    const p = String(phrase == null ? '' : phrase).toLowerCase().replace(/[.?!]+$/, '').trim();
    if (!REPLACEMENT_REQUEST_TAIL.test(p) && !WHAT_ELSE_TAIL.test(p)) return null;
    return p.replace(WHAT_ELSE_TAIL, '').replace(REPLACEMENT_REQUEST_TAIL, '').replace(/[\s,;]+$/, '').trim();
  }

  // An IMPLICIT substitution: the athlete wants the current/named lift swapped but
  // named NO substitute — the deterministic engine (services/substitutionRecommender)
  // picks it. Same target discipline as declineSkip (no positional-as-name, no vague
  // pronoun, no mutation-verb capture); a positional/current target is preserved.
  function implicitSubstitute(target) {
    const t = cleanName(target);
    if (isPositional(t)) return { action: 'substitute', target: POSITIONAL, positional: true, implicit: true };
    if (VAGUE_TARGET.test(t)) return null;
    if (/^(?:skip|drop|cut|ditch|remove|delete|swap|switch|sub(?:stitute)?|replace)\b/.test(t)) return null;
    if (!looksLikeExercise(t)) return null;
    return { action: 'substitute', target: t, implicit: true };
  }

  function replace(target, substitute) {
    // A vague substitute ("replace X with something else") is an IMPLICIT substitution
    // on the named/current target — never a literal "something else" slot.
    if (isVagueReplacement(substitute)) {
      const tv = cleanName(target);
      if (isPositional(tv)) return { action: 'substitute', target: POSITIONAL, positional: true, implicit: true };
      if (!looksLikeExercise(tv)) return null;
      return { action: 'substitute', target: tv, implicit: true };
    }
    const sub = cleanName(substitute);
    if (!looksLikeExercise(sub)) return null;
    const t = cleanName(target);
    // Positional source ("swap NEXT WORKOUT for dips") → substitute into the current slot.
    if (isPositional(t)) return { action: 'replace', target: POSITIONAL, substitute: sub, positional: true };
    if (!looksLikeExercise(t)) return null;
    if (t === sub) return null;
    return { action: 'replace', target: t, substitute: sub };
  }
  // Destination-only swap ("swap to/for X", "sub in X", "replace with X") — no source
  // named, so it substitutes X into the current/next slot (positional).
  function replaceInto(substitute) {
    // "swap to something else" — a vague destination is an implicit substitution.
    if (isVagueReplacement(substitute)) return { action: 'substitute', target: POSITIONAL, positional: true, implicit: true };
    const sub = cleanName(substitute);
    if (!looksLikeExercise(sub)) return null;
    return { action: 'replace', target: POSITIONAL, substitute: sub, positional: true };
  }
  function skip(target) {
    const t = cleanName(target);
    if (isPositional(t)) return { action: 'skip', target: POSITIONAL, positional: true };
    if (!looksLikeExercise(t)) return null;
    return { action: 'skip', target: t };
  }

  // A vague/pronoun target carries no exercise identity — "I don't want to do THIS /
  // ANYTHING / it" is sentiment, not a named skip. Rejected so the decline lane never
  // infers a skip from a phrase that names nothing to skip (owner: no broad sentiment
  // inference). A genuine named decline ("… do LEG EXTENSIONS") still resolves.
  const VAGUE_TARGET = /^(?:it|this|that|these|those|them|anything|everything|something|nothing|any|all(?:\s+of\s+(?:it|this|them))?|the\s+rest|much|stuff|more|be\s+.+|feel\s+.+)$/;

  // An EXPLICIT decline that NAMES a planned exercise ("I don't want to do leg
  // extensions") is a deterministic skip — NOT the coach's early-stop/quitting lane.
  // Conservative by construction: a mutation-verb capture is a double negation
  // ("don't want to skip squats" — keep it), a positional/vague capture names nothing,
  // and the downstream plan-slot resolution is the final gate (a non-exercise capture
  // matches no slot and falls through to the coach).
  function declineSkip(target) {
    const t = cleanName(target);
    if (isPositional(t) || VAGUE_TARGET.test(t)) return null;
    if (/^(?:skip|drop|cut|ditch|remove|delete|swap|switch|sub(?:stitute)?|replace)\b/.test(t)) return null;
    if (!looksLikeExercise(t)) return null;
    return { action: 'skip', target: t };
  }

  // Leading gerund mutation verbs → their imperative base (see the head-anchored
  // normalize in classifyMutationIntent). Closed set — only mutation verbs.
  const GERUND_BASE = {
    swapping: 'swap', switching: 'switch', subbing: 'sub', substituting: 'substitute',
    replacing: 'replace', skipping: 'skip', dropping: 'drop', cutting: 'cut',
    ditching: 'ditch', removing: 'remove', deleting: 'delete',
  };

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
    let t = stripLeads(raw.toLowerCase());
    // Normalize a LEADING gerund mutation verb to its imperative so the whole
    // swap/skip grammar below applies unchanged (canary find 2026-07-10: "Swapping
    // seated row for bent over row" fell through because only the base verb "swap"
    // was matched). Head-anchored + a closed verb set, so it never rewrites a
    // mid-sentence word or a real lift name ("rowing" stays "rowing").
    t = t.replace(/^(?:swapping|switching|subbing|substituting|replacing|skipping|dropping|cutting|ditching|removing|deleting)\b/,
      m => GERUND_BASE[m]);
    // Interrogative lead → a question, never a plan mutation (contract: questions → null).
    // The single-word forms are unambiguous; the auxiliary forms require a following
    // pronoun ("do you" / "should i") so the imperative "do squats…" is preserved.
    if (/^(?:why|how|what'?s?|when|where|which|who|should|could|would|can)\b/.test(t)) return null;
    if (/^(?:do|does|did|is|are|am|was|were|will|have|has)\s+(?:i|you|we|it|they|he|she)\b/.test(t)) return null;

    let m;
    // "swap/replace/switch/sub/change X for|with|to Y". `change` is included so
    // "change back squats to bench" and "change out squats for bench" are a REPLACE,
    // not a one-sided skip (production FR-20260723031748). The optional "out" after the
    // source lets "change squats out for bench" through too.
    m = t.match(/^(?:swap|switch|sub(?:stitute)?|replace|change)(?:\s+out)?\s+(.+?)(?:\s+out)?\s+(?:for|with|to|into|->|→)\s+(.+)$/);
    if (m) return replace(m[1], m[2]);

    // F-SB1-C (Stage B workout 1, 2026-08-01). An explicit request for an UNNAMED
    // substitute for a NAMED lift: "I'm looking for a substitute for bench press",
    // "give me an alternative to squats", "suggest a replacement for RDLs". The athlete
    // named what to swap and asked the ENGINE to pick, which is exactly an IMPLICIT
    // substitution — so it reaches `tryProposeImplicitSubstitution`, which sends
    // `intent:'substitute'` and gets a deterministic recommendation. Without this lane the
    // turn falls to `checkAndSuggestSubstitute`, which sends NO intent, so the route's
    // constraint gate ("busy"/"taken") refuses it and the athlete gets generic coach prose
    // instead of a swap (Codex P1, PR #1238).
    //
    // Anchored on the substitute NOUN, so it never touches the verb forms below: "swap for
    // dips" / "sub in leg curls" keep naming a DESTINATION. English agrees — "a substitute
    // FOR bench press" is the thing bench press is replaced BY, so the named lift is the
    // target, never the replacement.
    m = t.match(/\b(?:substitutes?|substitution|alternatives?|replacements?)\s+(?:for|to)\s+(.+)$/);
    if (m) { const sub = implicitSubstitute(m[1]); if (sub) return sub; }

    // Destination-only: "swap/switch/sub/replace/change to|for|in|with Y" — no source
    // named, so Y goes INTO the current/next slot (positional). Distinct from the pattern
    // above, which needs a source before the preposition.
    m = t.match(/^(?:swap|switch|sub(?:stitute)?|replace|change)\s+(?:to|for|in|with)\s+(.+)$/);
    if (m) return replaceInto(m[1]);

    // "skip/drop/cut/remove X [,/and] <replace-verb> Y"  (explicit swap-by-skip). The
    // replace-verb set is broad: do/hit/use/run/go-with, "change (it) out for/to/with",
    // "swap (it) (out) for/to/with/in", "sub/put/throw/bring in", "switch to/in",
    // "replace (it) with". This is the production repro — "remove back squats and change
    // it out for bench press" — which previously fell to the skip-only pattern below and
    // dropped the replacement (FR-20260723031748).
    m = t.match(/^(?:skip|drop|cut|ditch|remove|delete|take\s+out|get\s+rid\s+of)\s+(.+?)[,\s]+(?:and\s+|then\s+|so\s+|,\s*)?(?:do|doing|hit|use|go\s+with|run|change(?:\s+(?:it|them|those|these))?(?:\s+out)?\s+(?:for|to|into|with)|swap(?:\s+(?:it|them))?(?:\s+out)?\s+(?:for|to|with|in\s+for|in)|sub(?:stitute)?\s+in|put\s+in|throw\s+in|bring\s+in|switch\s+(?:to|in)|replace(?:\s+(?:it|them))?\s+with)\s+(.+)$/);
    if (m) return replace(m[1], m[2]);

    // "instead of X, [let's/do/hit/use] Y" (leading instead-of). The trailing lead-in
    // ("let's"/"we'll"/"i'll") + optional verb is stripped so Y is the bare lift. Distinct
    // from the "Y instead of X" forms below (which name the substitute FIRST).
    m = t.match(/^instead of\s+(.+?)[,\s]+(?:let'?s\s+|we'?ll\s+|i'?ll\s+|lets\s+|just\s+)?(?:do|doing|hit|use|go\s+with|run|try)?\s*(.+)$/);
    if (m && looksLikeExercise(cleanName(m[2]))) return replace(m[1], m[2]);

    // "X is/are/'s taken|busy|in use ... do|use|hit Y"
    m = t.match(/^(.+?)\s+(?:is|are|'?s)\s+(?:taken|busy|in use|unavailable|occupied|down)\b.*?\b(?:do|use|hit|run|go with)\s+(.+)$/);
    if (m) return replace(m[1], m[2]);

    // "do|hit|use Y instead of X"  and bare "Y instead of X"
    m = t.match(/^(?:do|doing|hit|use|run)\s+(.+?)\s+instead of\s+(.+)$/);
    if (m) return replace(m[2], m[1]);                 // substitute=Y(1), target=X(2)
    m = t.match(/^(.+?)\s+instead of\s+(.+)$/);
    if (m) return replace(m[2], m[1]);

    // skip/remove-only: "skip/drop/cut/remove/delete X" with no replacement clause,
    // plus the two-word removal verbs "take out X" / "get rid of X".
    m = t.match(/^(?:skip|drop|cut|ditch|remove|delete)\s+(.+)$/);
    if (m) return skip(m[1]);
    m = t.match(/^(?:take\s+out|get\s+rid\s+of|toss(?:\s+out)?)\s+(.+)$/);
    if (m) return skip(m[1]);

    // Negation-style skip: "no [more] X" (owner live find 2026-07-07: "no RDLs for
    // me today" must skip the RDL slot, not just get a coach reply). Session-scope
    // fillers were stripped by cleanName; the downstream plan-slot resolution is the
    // safety net for a non-exercise capture ("no thanks" → no matching slot → falls
    // through to the coach). "no" alone (nothing after) never matches.
    // F-SB1-C (Stage B workout 1, 2026-08-01): a CONVERSATIONAL "no" is a correction of
    // what Atlas just said, never a skip instruction. "No I'm looking for a substitute for
    // bench press" was captured whole — looksLikeExercise accepts any 2–60 char string, so
    // the entire clause became the skip target, resolved to the Bench Press slot, and the
    // lift was silently dropped. The owner asked for a swap and the plan lost the exercise.
    // This lane exists for a bare NOUN PHRASE ("no RDLs for me today", "no more curls"), so
    // a remainder opening with a subject pronoun or a discourse word is refused outright.
    // No exercise name begins with one of these words, so nothing real is lost.
    const CONVERSATIONAL_NO = /^(?:i|i'?m|im|i'?ve|i'?d|i'?ll|you|u|we|they|he|she|it|it'?s|that|that'?s|this|there|thanks|thank\s+you|not|but|sorry|wait|actually|please|let'?s|need|want|keep|still|just)\b/;
    m = t.match(/^no\s+(?:more\s+)?(.+)$/);
    if (m && !CONVERSATIONAL_NO.test(m[1].trim())) return skip(m[1]);

    // Reason-clause tolerance (owner live find 2026-07-03: "My legs are fried
    // right now I think I'll skip single leg press and leg extensions" fell to
    // the chat LLM, which debated instead of skipping). Every pattern above is
    // start-anchored, so a leading reason defeats them. When the message
    // carries a FIRST-PERSON INTENT marker glued to a mutation verb, classify
    // from that marker onward — the reason clause is context, not the intent.
    // Negations ("I don't think I'll skip…") never classify.
    if (/\b(?:don'?t|do not|not|never|won'?t|wouldn'?t|shouldn'?t|can'?t)\s+(?:think\s+)?(?:(?:i'?ll|i will|i'?m gonna|im gonna|i'?m going to|gonna|going to|wanna|want to)\s+)?(?:skip|drop|cut|ditch|remove|delete|swap|switch|sub(?:stitute)?|replace)\b/.test(t)) {
      return null;
    }

    // Explicit DECLINE of a named exercise → skip (canary find 2026-07-10: "I don't
    // want to do leg extensions" produced a coach early-stop message, never the skip
    // path). Runs AFTER the negation guard above, so a double negation ("don't want to
    // skip squats") has already been rejected. NAMED targets only — declineSkip drops
    // positional/vague/sentiment captures, and the plan-slot resolution downstream is
    // the final gate.
    m = t.match(/^i\s*(?:'?d)?\s+(?:really\s+|honestly\s+)?(?:don'?t\s+want\s+to|do\s+not\s+want\s+to|don'?t\s+wanna|dont\s+wanna|would\s+rather\s+not|rather\s+not|prefer\s+not\s+to)\s+(?:do\s+|doing\s+|perform\s+)?(.+)$/);
    if (m) {
      // A decline that ALSO asks for a replacement ("…squats, give me something else")
      // is an IMPLICIT substitution, not a skip — strip the request, keep the target.
      const stripped = stripReplacementRequest(m[1]);
      if (stripped != null) { const sub = implicitSubstitute(stripped); if (sub) return sub; }
      const inner = declineSkip(m[1]);
      if (inner) return inner;
    }
    // "i don't want X" (no "to do") — the same explicit decline, minus the verb. The
    // negative lookahead defers the "…want to do X" form to the regex above (else it
    // would capture "to do X" here, defeating the positional/vague gate).
    m = t.match(/^i\s+(?:really\s+|honestly\s+)?(?:don'?t\s+want|do\s+not\s+want|don'?t\s+wanna|dont\s+wanna)(?!\s+to\b)\s+(.+)$/);
    if (m) {
      const stripped = stripReplacementRequest(m[1]);
      if (stripped != null) { const sub = implicitSubstitute(stripped); if (sub) return sub; }
      const inner = declineSkip(m[1]);
      if (inner) return inner;
    }
    m = t.match(/\b(?:i think\s+)?(?:i'?ll|i will|i'?m gonna|im gonna|i'?m going to|let'?s|i want to|i wanna)\s+((?:skip|drop|cut|ditch|remove|delete|swap|switch|sub(?:stitute)?|replace)\b.*)$/);
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

    // Reason clause + NEGATION skip ("my lower back is a bit sore so no rdls for me
    // today"): the "no X" grammar above is start-anchored, so a leading reason
    // defeats it. Peel the reason before a connector (so / but / then / comma) and
    // re-run on the "no X" clause. The negation guard above still blocks a real
    // negation ("… so I won't skip squats"); a non-exercise capture falls through
    // via the plan-slot gate downstream.
    m = t.match(/(?:\bso\b|\bbut\b|\bthen\b|,)\s*(no\s+(?:more\s+)?.+)$/);
    if (m) {
      const inner = classifyMutationIntent(m[1]);
      if (inner) return inner;
    }

    return null;
  }

  const exported = { classifyMutationIntent, cleanName, splitTargets, resolvePlanTargets };

  return exported;
})();

export const { classifyMutationIntent, cleanName, splitTargets, resolvePlanTargets } = _exports;
