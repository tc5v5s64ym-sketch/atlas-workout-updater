/* Deterministic display-block normalizer (multi-workout composer, engine slice).
 *
 * The Atlas composer (and fitness apps like Strong/Hevy/Apple Fitness) emit a
 * workout as stacked blocks: a bare exercise-name header line, then one set per
 * line — "135lbs 10 · warm-up" for warm-ups and Atlas slash notation
 * "245lbs 6/2" (reps/RIR) for working sets, or a "135 × 10" display format.
 * Pasted into the composer this is several workouts at once — exactly the shape
 * the proven single-line slash parser was never built to read.
 *
 * This module ONLY restructures that display format into the canonical per-exercise
 * lines the existing parser already accepts (e.g. "Bench Press 185 5 185 5"). It
 * does NOT parse sets itself, does NOT touch the slash-notation contract, and
 * returns isDisplayBlock:false for anything that isn't unmistakably this format —
 * so single-exercise and slash-notation input pass straight through untouched.
 *
 *   normalizeDisplayBlocks("Deadlift\n135lbs 10 · warm-up\n225lbs 8 · warm-up\n245lbs 6/2\n245lbs 6/2")
 *     → { isDisplayBlock: true, blocks: [{
 *           name: 'Deadlift',
 *           sets: [{weight:135,reps:10,rir:null,warmup:true,unit:'lb'},
 *                  {weight:225,reps:8,rir:null,warmup:true,unit:'lb'},
 *                  {weight:245,reps:6,rir:2,warmup:false,unit:'lb'}, ...],
 *           warmupCount: 2,
 *           canonicalText: 'Deadlift 135 10 225 8 245 6/2 245 6/2',     // faithful: every set
 *           canonicalTextWorkingOnly: 'Deadlift 245 6/2 245 6/2'        // working sets only
 *        }] }
 *
 * The caller decides which canonicalText to feed the parser and how to confirm —
 * this layer stays neutral and never discards what the lifter pasted (warm-ups are
 * flagged, not silently dropped).
 *
 * PURE / UMD: no DOM, no I/O — unit-testable in Node, loadable in the browser.
 */
const _exports = (function () {
  // A display set line — the real Atlas/app formats seen in live use:
  //   "135lbs 10 · warm-up"  (unit attached, SPACE separator, warm-up note)
  //   "245lbs 6/2"           (working set in Atlas slash notation reps/RIR)
  //   "135 × 10", "185x5"    (unicode "×" U+00D7 or ascii "x"/"X" separator)
  //   "135x10wu"             (coach composer-hint warm-up token)
  // Shape: WEIGHT [unit] [× | space] REPS [ /RIR ] [trailing annotation]. The
  // weight↔reps separator may be "×"/"x" OR just whitespace; an optional "/RIR"
  // slash carries the working-set RIR; anything after is captured as the trailing
  // annotation (warm-up marker etc.) so it can't pollute the weight/reps read.
  // The weight→reps separator is MANDATORY (a "×"/"x", whitespace, or a unit) so a
  // bare number like "10" can never be mis-split into weight 1 / reps 0.
  const SET_LINE_RE = /^\s*(\d+(?:\.\d+)?)(?:\s*(lb|lbs|kg|kgs))?(?:\s*[×xX]\s*|\s+)(\d+)(?:\s*\/\s*(\d+(?:\.\d+)?))?(.*)$/;

  // Marks a warm-up set in the trailing annotation: "· warm-up", "warmup",
  // "warm up", a trailing "wu" token (coach hint notation), or "(W)".
  const WARMUP_RE = /\bwarm[\s-]?up\b|\bwu\b|\(w\)/i;

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\r\n/g, '\n');
  }

  // Parse a single display set line. Returns {weight, reps, rir, warmup, unit} or
  // null. `rir` is null when the line carries no "/RIR" (e.g. a warm-up).
  function parseDisplaySetLine(line) {
    const m = normalizeText(line).match(SET_LINE_RE);
    if (!m) return null;
    const weight = Number(m[1]);
    const reps = Number(m[3]);
    if (!Number.isFinite(weight) || !Number.isFinite(reps)) return null;
    const trailing = m[5] || '';
    const rir = (m[4] == null || m[4] === '') ? null : Number(m[4]);
    return {
      weight,
      reps,
      rir: Number.isFinite(rir) ? rir : null,
      warmup: WARMUP_RE.test(trailing),
      unit: m[2] ? m[2].toLowerCase().replace(/s$/, '') : null
    };
  }

  function isSetLine(line) {
    return SET_LINE_RE.test(normalizeText(line));
  }

  // True when a set line carries leftover numeric content AFTER the first
  // weight/reps[/rir] — a "packed" multi-set line like "225 5/2 225 5/2 225 5/2".
  // SET_LINE_RE only captures the first set (the rest fall into the trailing group),
  // so logging such a line would silently drop sets. The caller bails the whole
  // paste to the proven parser instead — never log only the first of several sets
  // ("looks logged but wasn't"). Warm-up markers (· warm-up / wu / (W)) carry no
  // digits, so a normal one-set-per-line warm-up never trips this.
  function setLineHasLeftoverSets(line) {
    const m = normalizeText(line).match(SET_LINE_RE);
    if (!m) return false;
    return /\d/.test(m[5] || '');
  }

  // A header line is a non-empty, non-set line that plausibly names an exercise:
  // it must contain a letter (so a stray numeric/symbol line isn't taken as a
  // name) and not itself be a set line.
  function isHeaderLine(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    if (isSetLine(t)) return false;
    return /[a-z]/i.test(t);
  }

  // Words that occur in conversational prose but never in an exercise name —
  // mirrors workoutTextParser's prose guard so a free-text note pasted alongside
  // the blocks can never be coined into a bogus exercise. A name that reads as
  // prose (a conversational word, or longer than a plausible lift name) makes the
  // whole paste ambiguous → the caller falls back to the proven parser.
  const PROSE_WORD_RE = /\b(i|im|i'?m|ive|i'?ve|you|your|we|we'?re|they|my|me|us|he|she|it'?s|dont|don'?t|do|does|wont|won'?t|cant|can'?t|not|no|want|wanna|should|would|could|will|like|love|hate|feel|felt|think|thought|need|gonna|let'?s|lets|because|across|prove|proven|instead|maybe|please|too|really|just|move|moving|after|before|when|why|how|what|that'?s|thats|today|tomorrow|yesterday|next|week|strong|tired|good|great)\b/i;
  function looksLikeProseName(name) {
    const cleaned = cleanHeaderName(name);
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length > 4) return true;
    return PROSE_WORD_RE.test(cleaned);
  }

  // Strip a trailing display annotation from a header ("Bench Press · Barbell"
  // → "Bench Press"): keep only the text before the first " · " separator.
  function cleanHeaderName(line) {
    return String(line || '')
      .split(/\s+[·•|]\s+/)[0]
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildBlock(name, sets) {
    const working = sets.filter(s => !s.warmup);
    // Emit Atlas shorthand the proven parser accepts: "weight reps/rir" when an
    // RIR is present (working sets), bare "weight reps" otherwise (warm-ups).
    const setTokens = list => list
      .map(s => (s.rir != null ? `${s.weight} ${s.reps}/${s.rir}` : `${s.weight} ${s.reps}`))
      .join(' ');
    return {
      name,
      sets,
      warmupCount: sets.length - working.length,
      workingSetCount: working.length,
      // `canonicalText` is the FAITHFUL line — every pasted set, warm-ups included.
      // Owner decision (2026-06-25): warm-ups are real training history and MUST be
      // logged as rows AND counted in total session volume; they are excluded ONLY
      // from the weight-bump/progression decision (via each set's `warmup` flag),
      // never dropped from the saved log. So the wiring slice logs from
      // `canonicalText` (or the full `sets[]`) and tags warm-ups — it must NOT log
      // from the field below.
      canonicalText: `${name} ${setTokens(sets)}`.trim(),
      // `canonicalTextWorkingOnly` is the working-set SUBSET — for the progression /
      // weight-bump decision only, NOT a log filter and NOT a volume filter. Falls
      // back to the faithful line if every set was a warm-up, so it is never reduced
      // to a bare name with no sets.
      canonicalTextWorkingOnly: working.length
        ? `${name} ${setTokens(working)}`.trim()
        : `${name} ${setTokens(sets)}`.trim()
    };
  }

  // Walk the lines, grouping each header with the set lines that follow it.
  // Returns { isDisplayBlock, blocks }. isDisplayBlock is true only when at least
  // one header→set block was found (i.e. the display format was actually present);
  // otherwise blocks is [] and the caller leaves the input to the proven parser.
  function normalizeDisplayBlocks(input) {
    const lines = normalizeText(input).split('\n');
    const blocks = [];
    let currentName = null;
    let currentSets = [];

    const flush = () => {
      if (currentName && currentSets.length) {
        blocks.push(buildBlock(currentName, currentSets));
      }
      currentName = null;
      currentSets = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        // A blank line ends the current block but doesn't start one.
        flush();
        continue;
      }
      const set = parseDisplaySetLine(line);
      if (set) {
        // A set line only counts inside a block (after a header). A set line with
        // no preceding header is left for the proven parser — bail entirely so we
        // never half-normalize a mixed/ambiguous paste.
        if (!currentName) return { isDisplayBlock: false, blocks: [] };
        // A packed multi-set line (e.g. "225 5/2 225 5/2") would lose all but the
        // first set — bail to the proven parser rather than silently drop sets.
        if (setLineHasLeftoverSets(line)) return { isDisplayBlock: false, blocks: [] };
        currentSets.push(set);
        continue;
      }
      if (isHeaderLine(line)) {
        // A header that reads as conversational prose makes the whole paste
        // ambiguous — bail so the proven parser handles it rather than coin a
        // bogus exercise from a free-text note.
        if (looksLikeProseName(line)) return { isDisplayBlock: false, blocks: [] };
        // A new header closes the previous block and opens the next.
        flush();
        currentName = cleanHeaderName(line);
        continue;
      }
      // Unreachable in practice (every non-empty, non-set line with a letter is a
      // header; numeric/symbol-only lines are rare) — bail to be safe.
      return { isDisplayBlock: false, blocks: [] };
    }
    flush();

    return { isDisplayBlock: blocks.length > 0, blocks };
  }

  // Convenience boolean: does this text contain at least one header→set block?
  function looksLikeDisplayBlock(input) {
    return normalizeDisplayBlocks(input).isDisplayBlock;
  }

  const exported = {
    normalizeDisplayBlocks,
    looksLikeDisplayBlock,
    parseDisplaySetLine,
    isSetLine,
    setLineHasLeftoverSets,
    isHeaderLine,
    cleanHeaderName
  };

  return exported;
})();

export const {
  normalizeDisplayBlocks,
  looksLikeDisplayBlock,
  parseDisplaySetLine,
  isSetLine,
  setLineHasLeftoverSets,
  isHeaderLine,
  cleanHeaderName
} = _exports;
