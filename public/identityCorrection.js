/* Deterministic exercise-identity correction classifier (P0 PR 4, AC7).
 *
 * Turns an explicit "I mislabeled the last lift" statement into a structured
 * correction the canonical session can apply — WITHOUT the LLM. The app state owns
 * the relabel; the coach only ever confirms it. This is exactly the live-gym gap:
 * "sorry that was squats" must relabel the just-logged lift even when the coach is
 * unavailable.
 *
 *   classifyIdentityCorrection("sorry that was squats")   → { to: 'squats' }
 *   classifyIdentityCorrection("i meant lat pulldown")    → { to: 'lat pulldown' }
 *   classifyIdentityCorrection("that was rows not curls") → { to: 'rows' }
 *   classifyIdentityCorrection("how many reps?")          → null
 *
 * Conservative by design: it fires ONLY on an explicit correction cue (sorry / i
 * meant / actually / correction / make that / should be), so an ordinary remark
 * ("that was heavy") never relabels. Returns null for anything else so the message
 * falls through to the existing substitute/coach flow.
 *
 * PURE / UMD: no DOM, no I/O — unit-testable in Node, loadable in the browser.
 */
(function (root) {
  'use strict';

  // Clean a captured exercise phrase: lowercase, drop a trailing set-notation tail
  // ("squats 225 8/2" → "squats"), articles, trailing fillers, punctuation.
  function cleanName(s) {
    let t = String(s == null ? '' : s).trim().toLowerCase();
    t = t.replace(/[.?!,;:]+$/, '').trim();
    // Drop a trailing set-notation / number tail: keep the leading non-numeric words.
    const tokens = t.split(/\s+/);
    const lead = [];
    for (const tok of tokens) { if (/\d/.test(tok)) break; lead.push(tok); }
    t = (lead.length ? lead : tokens).join(' ');
    t = t.replace(/^(?:the|my|a|an|some)\s+/, '');
    t = t.replace(/[,\s]+(?:instead|today|this time|for now|now|please|then|actually|really)$/, '').trim();
    t = t.replace(/[.?!,;:]+$/, '').trim();   // a filler may have left a trailing comma
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

  function correction(to) {
    const t = cleanName(to);
    if (!looksLikeExercise(t)) return null;
    return { to: t };
  }

  /**
   * classifyIdentityCorrection(text) → { to } | null
   * `to` is the corrected exercise name (a cleaned free-text phrase; the caller
   * resolves it against the catalog). Only an explicit correction cue fires.
   */
  function classifyIdentityCorrection(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    if (/\?\s*$/.test(raw)) return null;               // a question is never a correction
    // (No blanket slash-set guard: a correction may RE-STATE the set —
    // "sorry that was squats 225 8/2" — and cleanName strips the numeric tail while
    // looksLikeExercise rejects a numeric-only capture, so a bare set log still → null.)
    const t = raw.toLowerCase();

    let m;
    // "... X not Y" — the correction is X (what it really was), before "not".
    m = t.match(/^(?:sorry[,]?\s+)?(?:that\s+was|that's|it\s+was|it's)\s+(?:actually\s+|really\s+)?(.+?)\s+not\s+.+$/);
    if (m) return correction(m[1]);

    // "sorry that was X" / "sorry, it was X" / "sorry i meant X"
    m = t.match(/^sorry[,]?\s+(?:that\s+was|that's|it\s+was|it's|i\s+meant|i\s+mean)\s+(.+)$/);
    if (m) return correction(m[1]);

    // "actually / oops / my bad, that was X"
    m = t.match(/^(?:actually|oops|my bad|whoops)[,]?\s+(?:that\s+was|that's|it\s+was|it's|i\s+meant)\s+(.+)$/);
    if (m) return correction(m[1]);

    // "that was actually/really X" (the cue is the adverb)
    m = t.match(/^(?:that\s+was|that's|it\s+was|it's)\s+(?:actually|really)\s+(.+)$/);
    if (m) return correction(m[1]);

    // "i meant X" / "i mean X"
    m = t.match(/^i\s+(?:meant|mean)\s+(?:to\s+say\s+)?(.+)$/);
    if (m) return correction(m[1]);

    // "correction: X" / "correction X"
    m = t.match(/^correction[:]?\s+(.+)$/);
    if (m) return correction(m[1]);

    // "make that X" / "make it X"
    m = t.match(/^make\s+(?:that|it)\s+(.+)$/);
    if (m) return correction(m[1]);

    // "that should be X" / "should be X"
    m = t.match(/^(?:that\s+should\s+be|should\s+be)\s+(.+)$/);
    if (m) return correction(m[1]);

    return null;
  }

  const exported = { classifyIdentityCorrection, cleanName };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.identityCorrection = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
