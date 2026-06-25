/* Deterministic display-block normalizer (multi-workout composer, engine slice).
 *
 * Fitness apps (Strong, Hevy, Apple Fitness, etc.) export a workout as stacked
 * blocks: a bare exercise-name header line, then one set per line in a
 * "135 lb × 10" display format, sometimes annotated "· warm-up". Pasted into the
 * Atlas composer this is several workouts at once — exactly the shape the proven
 * single-line slash parser was never built to read.
 *
 * This module ONLY restructures that display format into the canonical per-exercise
 * lines the existing parser already accepts (e.g. "Bench Press 185 5 185 5"). It
 * does NOT parse sets itself, does NOT touch the slash-notation contract, and
 * returns isDisplayBlock:false for anything that isn't unmistakably this format —
 * so single-exercise and slash-notation input pass straight through untouched.
 *
 *   normalizeDisplayBlocks("Bench Press\n135 lb × 10 · warm-up\n185 lb × 5\n185 lb × 5")
 *     → { isDisplayBlock: true, blocks: [{
 *           name: 'Bench Press',
 *           sets: [{weight:135,reps:10,warmup:true,unit:'lb'}, {weight:185,reps:5,...}, ...],
 *           warmupCount: 1,
 *           canonicalText: 'Bench Press 135 10 185 5 185 5',            // faithful: every set
 *           canonicalTextWorkingOnly: 'Bench Press 185 5 185 5'         // warm-ups dropped
 *        }] }
 *
 * The caller decides which canonicalText to feed the parser and how to confirm —
 * this layer stays neutral and never discards what the lifter pasted (warm-ups are
 * flagged, not silently dropped).
 *
 * PURE / UMD: no DOM, no I/O — unit-testable in Node, loadable in the browser.
 */
(function (root) {
  // A display set line: "135 lb × 10", "135 × 10", "185x5", "60 kg × 12 · warm-up".
  // The unicode "×" (U+00D7) and ascii "x"/"X" are both accepted as the separator.
  // A trailing annotation (warm-up / RPE / anything after the reps) is captured
  // separately so it can be classified without polluting the weight/reps read.
  const SET_LINE_RE = /^\s*(\d+(?:\.\d+)?)\s*(lb|lbs|kg|kgs)?\s*[×xX]\s*(\d+)\b(.*)$/;

  // Marks a warm-up set in the trailing annotation ("· warm-up", "warmup", "warm up", "(W)").
  const WARMUP_RE = /\bwarm[\s-]?up\b|\(w\)/i;

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\r\n/g, '\n');
  }

  // Parse a single display set line. Returns {weight, reps, warmup, unit} or null.
  function parseDisplaySetLine(line) {
    const m = normalizeText(line).match(SET_LINE_RE);
    if (!m) return null;
    const weight = Number(m[1]);
    const reps = Number(m[3]);
    if (!Number.isFinite(weight) || !Number.isFinite(reps)) return null;
    const trailing = m[4] || '';
    return {
      weight,
      reps,
      warmup: WARMUP_RE.test(trailing),
      unit: m[2] ? m[2].toLowerCase().replace(/s$/, '') : null
    };
  }

  function isSetLine(line) {
    return SET_LINE_RE.test(normalizeText(line));
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
    const setTokens = list => list.map(s => `${s.weight} ${s.reps}`).join(' ');
    return {
      name,
      sets,
      warmupCount: sets.length - working.length,
      workingSetCount: working.length,
      // Faithful: every pasted set, warm-ups included.
      canonicalText: `${name} ${setTokens(sets)}`.trim(),
      // Working sets only — warm-ups dropped (volume model is working-set based).
      // Falls back to the faithful line if every set was a warm-up, so nothing is
      // ever reduced to a bare name with no sets.
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
    isHeaderLine,
    cleanHeaderName
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.displayBlockNormalizer = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
