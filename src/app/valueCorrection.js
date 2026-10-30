/* Deterministic VALUE-correction classifier (#1625).
 *
 * The gap this closes. The identity-correction lane (identityCorrection.js)
 * relabels a lift deterministically, but it needs an exercise NAME and rejects
 * a digit-led capture by design. A bare value correction — the corpus's
 * "Typo. 275." (Soul Corpus Session 6) — therefore matched NO deterministic
 * lane, fell through to the LLM coach, and the retained sets kept the wrong
 * weight while the model's recap asserted they were "logged as planned".
 *
 * This classifier is the front half of the missing lane: it recognizes an
 * explicit correction cue carrying a corrected VALUE, optionally naming the
 * exercise. The app state owns the rewrite; the coach only ever confirms it,
 * with a line composed from the buffer's post-correction state.
 *
 *   classifyValueCorrection("Typo. 275.")        → { exercise: null, field: 'weight', value: 275 }
 *   classifyValueCorrection("RDL was 275")        → { exercise: 'rdl', field: 'weight', value: 275 }
 *   classifyValueCorrection("typo, 8 reps")       → { exercise: null, field: 'reps', value: 8 }
 *   classifyValueCorrection("275")                → null  (a bare number is a set continuation here)
 *   classifyValueCorrection("Bench 225 5/2 x3.")  → null  (a fresh log)
 *
 * Conservative by design, mirroring the identity classifier: the WHOLE message
 * must be the correction (anchored patterns, short), an explicit cue is
 * required, a question is never a correction, and slash set-notation is a log,
 * never a correction. Returns null for anything else so the message falls
 * through to the existing lanes unchanged.
 *
 * PURE / UMD: no DOM, no I/O — unit-testable in Node, loadable in the browser.
 */
const _exports = (function () {
  'use strict';

  // The same bounds the coach layer validates proposed edits against
  // (coach-conversation.js EDIT_BOUNDS): a correction outside them is not a
  // correction, and a target is never invented.
  const BOUNDS = { weight: [1, 1500], reps: [1, 100], rir: [0, 10] };

  const CUES = '(?:typo|correction|oops|whoops|my bad|actually|sorry)';
  // A value token: an optional field word BEFORE the number ("RIR 3"), the
  // number, an optional unit after it ("275 lbs", "8 reps"). Field defaults to
  // weight — in gym shorthand a bare corrected number is the load.
  const VAL = '(?:(rir|reps?)\\s+)?(\\d+(?:\\.\\d+)?)\\s*(lbs?|pounds?|kg|reps?|rir)?\\s*[.!]?';

  function parseValue(prefixUnit, numStr, suffixUnit) {
    const value = Number(numStr);
    if (!Number.isFinite(value)) return null;
    let field = 'weight';
    const u = String(prefixUnit || suffixUnit || '').toLowerCase();
    if (u.startsWith('rir')) field = 'rir';
    else if (u.startsWith('rep')) field = 'reps';
    const [lo, hi] = BOUNDS[field];
    if (value < lo || value > hi) return null;
    return { field, value };
  }

  // Clean a captured exercise phrase the way the identity classifier does:
  // lowercase, no trailing punctuation, no leading article.
  function cleanNamePhrase(s) {
    let t = String(s == null ? '' : s).trim().toLowerCase();
    t = t.replace(/[.?!,;:]+$/, '').trim();
    t = t.replace(/^(?:the|my|a|an|some)\s+/, '');
    return t.replace(/[.?!,;:]+$/, '').trim();
  }

  // Plausibly an exercise name: letters, no digits, not a demonstrative or a
  // cue word (those are the unnamed forms' furniture, not a lift).
  function looksLikeExerciseName(s) {
    if (!s || s.length < 2 || s.length > 40) return false;
    if (/\d/.test(s) || /^\d/.test(s)) return false;
    if (!/[a-z]/.test(s)) return false;
    if (/^(that|this|it|those|these|today|typo|correction|sorry|actually|oops|whoops)\b/.test(s)) return false;
    if (/^(rir|reps?|lbs?|pounds?|kg)$/.test(s)) return false;   // a field/unit word is not a lift ("typo, RIR 3")
    return true;
  }

  function named(nameRaw, pv) {
    const name = cleanNamePhrase(nameRaw);
    if (!pv || !looksLikeExerciseName(name)) return null;
    return { exercise: name, field: pv.field, value: pv.value };
  }

  function unnamed(pv) {
    return pv ? { exercise: null, field: pv.field, value: pv.value } : null;
  }

  /**
   * classifyValueCorrection(text)
   *   → { exercise: string|null, field: 'weight'|'reps'|'rir', value: number } | null
   * `exercise` is a cleaned free-text phrase (the caller resolves it against
   * the buffered lifts); null means the correction refers to the
   * most-recently-logged lift, the same convention identity corrections use.
   */
  function classifyValueCorrection(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw || raw.length > 80) return null;
    if (/\?\s*$/.test(raw)) return null;                 // a question is never a correction
    if (/\d+\s*\/\s*\d+/.test(raw)) return null;         // slash set-notation is a log
    const t = raw.toLowerCase().replace(/\s+/g, ' ');

    let m;
    // "<cue> <name> <value>" — "typo, RDL 275", "correction: bench press 225".
    m = t.match(new RegExp('^' + CUES + '[,.:]?\\s+(.+?)\\s+' + VAL + '$'));
    if (m) { const r = named(m[1], parseValue(m[2], m[3], m[4])); if (r) return r; }

    // "make that/it <name> <value>" — "make that RDL 275".
    m = t.match(new RegExp('^make\\s+(?:that|it)\\s+(.+?)\\s+' + VAL + '$'));
    if (m) { const r = named(m[1], parseValue(m[2], m[3], m[4])); if (r) return r; }

    // "make that/it <value>" — "make that 275".
    m = t.match(new RegExp('^make\\s+(?:that|it)\\s+' + VAL + '$'));
    if (m) { const r = unnamed(parseValue(m[1], m[2], m[3])); if (r) return r; }

    // "<cue> [it was|that was|i meant|meant|should be] <value>" — "Typo. 275.",
    // "sorry, 275", "actually that was 275", "correction: 275".
    m = t.match(new RegExp('^' + CUES + '[,.:]?\\s+(?:(?:it\\s+was|that\\s+was|i\\s+meant|meant|should\\s+be)\\s+)?' + VAL + '$'));
    if (m) { const r = unnamed(parseValue(m[1], m[2], m[3])); if (r) return r; }

    // "should be <value>" / "that should be <value>".
    m = t.match(new RegExp('^(?:that\\s+)?should\\s+be\\s+' + VAL + '$'));
    if (m) { const r = unnamed(parseValue(m[1], m[2], m[3])); if (r) return r; }

    // "i meant/mean <value>".
    m = t.match(new RegExp('^i\\s+(?:meant|mean)\\s+' + VAL + '$'));
    if (m) { const r = unnamed(parseValue(m[1], m[2], m[3])); if (r) return r; }

    // "<name> was|is|should be|meant <value>" — "RDL was 275".
    m = t.match(new RegExp('^(.+?)\\s+(?:was|is|should\\s+be|meant)\\s+' + VAL + '$'));
    if (m) { const r = named(m[1], parseValue(m[2], m[3], m[4])); if (r) return r; }

    // "<value> not <value>" — "275 not 285": the first value stands.
    m = t.match(new RegExp('^' + VAL.replace('[.!]?', '') + '\\s+not\\s+' + VAL + '$'));
    if (m) {
      const first = parseValue(m[1], m[2], m[3]);
      const second = parseValue(m[4], m[5], m[6]);
      if (first && second && first.field === second.field) return unnamed(first);
      return null;
    }

    return null;
  }

  function fieldValueLabel(field, value) {
    if (field === 'reps') return `${value} reps`;
    if (field === 'rir') return `RIR ${value}`;
    return `${value}`;
  }

  // The confirmation line, composed ONLY from the correction detail the shell
  // derived from the retained buffer (exercise as buffered, the value the
  // buffer held, the value it holds now, how many sets carry it). Nothing here
  // can state a number the buffer does not hold, and nothing claims plan
  // conformance — the failure this lane exists to close was a recap asserting
  // the sets were "logged as planned" while the buffer held the fat-fingered
  // weight.
  function formatValueCorrection(d) {
    const detail = d && typeof d === 'object' ? d : {};
    const name = String(detail.exercise || 'that lift');
    const to = fieldValueLabel(detail.field, detail.to);
    if (detail.unchanged) return `✓ ${name} already reads ${to} — nothing to change.`;
    const count = Number(detail.count) || 0;
    const sets = count === 1 ? '1 set' : `all ${count} sets`;
    if (detail.from === null || detail.from === undefined) {
      return `✓ Corrected ${name}: now ${to} on ${sets}.`;
    }
    return `✓ Corrected ${name}: ${fieldValueLabel(detail.field, detail.from)} → ${to} on ${sets}.`;
  }

  // The ask, when a correction is clearly intended but its target cannot be
  // proven: nothing is mutated and nothing is claimed — the athlete re-states
  // it naming the lift, the same remedy the identity lane offers.
  function formatValueCorrectionAmbiguous(d) {
    const detail = d && typeof d === 'object' ? d : {};
    const what = detail.value !== undefined && detail.value !== null
      ? ` to ${fieldValueLabel(detail.field, detail.value)}` : '';
    return `I couldn't tell which sets you meant to correct${what} — nothing changed. Name the lift, e.g. "RDL was 275".`;
  }

  const exported = { classifyValueCorrection, formatValueCorrection, formatValueCorrectionAmbiguous };

  return exported;
})();

export const { classifyValueCorrection, formatValueCorrection, formatValueCorrectionAmbiguous } = _exports;
