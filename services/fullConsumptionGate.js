'use strict';

// ── F05 full-consumption / ambiguous-@ gate (PARSE-4, PARSE-5; Astra A-01 #1765) ─
//
// Wired at the parse-route ORCHESTRATION boundary, right after the unresolved-lift
// gate and before the client assembles preview rows. It closes silent-
// correctness gaps WITHOUT touching the parser grammar (the `225 5/2` = 225 lb ×
// 5 reps @ RIR 2 slash contract and every parser golden stay byte-identical):
//
//   PARSE-4 — mixed set notation silently drops groups. `parseSetGroups` is
//     first-sub-parser-wins over the whole rest text, so `bench 185 5/2 3x8@165`
//     keeps only the `3x8@165` and silently discards the frozen-contract slash
//     set. When the raw text mixes TWO OR MORE distinct set-notation families
//     (slash `\d+/\d+`, `x\d+@`, `\d+ for \d+`) — the exact shape where one group
//     is dropped — refuse and ask instead of previewing a partial set list.
//
//   PARSE-5 — `@N` is a weight in the barbell sets-first grammar but an RIR in the
//     dumbbell grammar, so `bench 3x10 @2` logs a 2 lb bench. When the barbell
//     `NxM@W` form carries `W ≤ 10` (a lifter's RIR band, never a real barbell
//     weight) and the parser actually emitted that tiny weight, refuse and ask.
//
//   A-01 (#1765) — the Astra Ultra re-audit showed three evasions of the above:
//     (a) the parser folds Unicode × to x (`normalizeParserText`) but the gate
//     read the RAW text, so `bench 185 5/2 and 3×8@165` hid its x@ family and
//     the 185x5 set silently disappeared (volume 3960 instead of 4885);
//     (b) the gate was a no-op for `log_sets_multi`, so the same drops — and the
//     2-lb `@2` sets — sailed through inside multi-exercise turns;
//     (c) zero-value sets (`bench 3x0@165` → three 0-rep sets, `bench 0 8/2` →
//     a 0-lb set) logged silently. The fix, per the issue's invariant:
//     parsing and validation SHARE normalized tokens and consumed spans,
//     including every child of multi-exercise output. Any unconsumed set-bearing
//     text causes clarification, never a partial preview.
//
//   B1 (pre-review blocker, fixed in the second commit) — multipliers other
//     than ASCII x / U+00D7 × are never folded by the parser, so a group
//     written with one (✕ U+2715, ✗ U+2717, ✖ U+2716, * U+002A, ＊ U+FF0A,
//     full-width Ｘ U+FF38 / ｘ U+FF58) is silently dropped even when the rest
//     of the turn logs — and a fold-in-the-gate would MISS the same-family
//     shape (`bench 3x8@165 and 3✕8@135` folds to one family, still drops
//     the 135 group). The gate therefore refuses any digit–multiplier–digit
//     (or digit–multiplier–@) pattern using a glyph the parser does not
//     recognize, in every span it checks.
//
// All paths only ever REDUCE what reaches the preview (parsed →
// needs_clarification with zero rows). Pure, read-only, and it never throws —
// a garbage input returns the parsed object unchanged. It needs the ORIGINAL
// text because `parsed` has already discarded the unconsumed tokens.
//
// applyFullConsumptionGate(parsed, rawText) → parsed' (possibly downgraded)

// Shared normalization: the gate reads the text EXACTLY the way the parser does
// (weight units first, then the parser-text fold — same order as the parser's
// entry), so a notation family the parser consumes is always visible to the gate.
// Required from the parser itself, never re-implemented here, so the two cannot
// drift apart again.
const { normalizeParserText, normalizeWeightUnits } = require('./workoutTextParser');

// The barbell sets-first form `NxM@W`. A leading digit must sit immediately before
// `x` (word boundary), so the dumbbell form `55s x8 @2` — where `s ` precedes `x`
// — is NOT matched, and its `@` correctly stays an RIR. Global: the scan must
// see every @ in the text, not just the first.
const BARBELL_SETS_FIRST_AT_GLOBAL = /\b\d+\s*x\s*\d+\s*@\s*(\d+(?:\.\d+)?)\b/g;

// The three set-notation families whose co-occurrence signals dropped groups.
const FAMILY_SLASH = /\d+\s*\/\s*\d+/;       // reps/RIR, incl. dumbbell `10/3`
const FAMILY_X_AT = /x\s*\d+\s*@/;           // `3x8@165`, `55s x8 @2`
const FAMILY_FOR = /\b\d+\s+for\s+\d+\b/;    // `175 for 5`

// The ambiguous @ band: a value this small in the barbell form is a lifter's RIR,
// never a real barbell weight.
const AMBIGUOUS_AT_MAX = 10;

// B1 — multipliers the parser never folds or recognizes. The parser folds only
// U+00D7 × to x, so a set group written with any of these glyphs is invisible
// to both parser and gate families — it must be refused outright, never
// folded: folding would hide the same-family drop (`3x8@165 and 3✕8@135`).
// A digit must precede the glyph and a digit or @ must follow it, so a
// trailing markdown asterisk (`3x8@165*`) does not trip.
const UNRECOGNIZED_MULTIPLIER = /\d+\s*[*✕✗✖＊Ｘｘ]\s*[\d@]/;

function ask(message, code, parsed, rawText) {
  return {
    intent: 'needs_clarification',
    raw_text: (parsed && parsed.raw_text) || String(rawText || ''),
    message,
    warnings: [...new Set([...(Array.isArray(parsed && parsed.warnings) ? parsed.warnings : []), code])],
    ...(parsed && Array.isArray(parsed.unresolved) ? { unresolved: parsed.unresolved } : {}),
  };
}

// The gate reads normalized text: weight units first, then the parser-text fold,
// then lowercase for the family regexes — the parser's own entry order.
function normalizeGateText(value) {
  return normalizeParserText(normalizeWeightUnits(String(value || ''))).toLowerCase();
}

function countFamilies(text) {
  let families = 0;
  if (FAMILY_SLASH.test(text)) families += 1;
  if (FAMILY_X_AT.test(text)) families += 1;
  if (FAMILY_FOR.test(text)) families += 1;
  return families;
}

// First barbell `@N` (N ≤ 10) that the parser actually emitted as the weight,
// or null. Scans every @ in the text — a later ambiguous @ is still ambiguous
// even when an earlier, harmless @ precedes it.
function findAmbiguousAt(text, sets) {
  const emitted = Array.isArray(sets) ? sets : [];
  for (const m of String(text).matchAll(BARBELL_SETS_FIRST_AT_GLOBAL)) {
    const atValue = Number(m[1]);
    if (atValue <= AMBIGUOUS_AT_MAX && emitted.some(s => Number(s && s.weight) === atValue)) {
      return m[1];
    }
  }
  return null;
}

// A zero (or negative / non-finite) weight or rep count is never a real set —
// the parser emitted it, so the turn must ask instead of previewing it. Weight
// null (bodyweight) and RIR 0 (to failure) are legal and never trip.
function hasZeroValueSet(sets) {
  return (Array.isArray(sets) ? sets : []).some(s => {
    const w = s && s.weight !== null && s.weight !== undefined ? Number(s.weight) : null;
    const r = s && s.reps !== null && s.reps !== undefined ? Number(s.reps) : null;
    return (w !== null && (!Number.isFinite(w) || w <= 0)) ||
      (r !== null && (!Number.isFinite(r) || r <= 0));
  });
}

function ambiguousAtMessage(atValue) {
  return `Just to be safe — "@${atValue}" reads as a weight here, but a number that small is usually your RIR. Which did you mean? (nothing's logged yet)`;
}

function mixedFormatMessage() {
  return "That looks like more than one set format mixed together, and I don't want to drop any of it. Mind re-sending it one way? (nothing's logged yet)";
}

function zeroValueMessage() {
  return "That includes a set with a zero weight or zero reps, which isn't a real set. Mind re-sending it? (nothing's logged yet)";
}

function unrecognizedSetNotationMessage() {
  return "That includes a set written with a multiplier I don't recognize, so I can't tell what it means. Mind re-sending it with x, like 3x8@165? (nothing's logged yet)";
}

// A set group joined by a multiplier the parser never recognizes (B1). The
// group is unconsumed by definition — the parser has no grammar for it — so
// the turn asks instead of previewing the rest without it.
function hasUnrecognizedSetNotation(text) {
  return UNRECOGNIZED_MULTIPLIER.test(String(text || ''));
}

// The single-exercise checks (PARSE-4, PARSE-5, zero-value) over one span of
// normalized text and the sets emitted from it. Returns the refusal, or null.
function checkSpan(parsed, rawText, text, sets) {
  if (hasUnrecognizedSetNotation(text)) return ask(unrecognizedSetNotationMessage(), 'unrecognized_set_notation', parsed, rawText);
  const atValue = findAmbiguousAt(text, sets);
  if (atValue) return ask(ambiguousAtMessage(atValue), 'ambiguous_at_value', parsed, rawText);
  if (countFamilies(text) >= 2) return ask(mixedFormatMessage(), 'mixed_set_format', parsed, rawText);
  if (hasZeroValueSet(sets)) return ask(zeroValueMessage(), 'zero_set_value', parsed, rawText);
  return null;
}

function applyMultiGate(parsed, rawText) {
  const exercises = Array.isArray(parsed.exercises) ? parsed.exercises : [];
  const allSets = exercises.flatMap(e => (Array.isArray(e.sets) ? e.sets : []));
  // No sets emitted anywhere in the turn → nothing was silently dropped and
  // nothing previews, so the gate leaves the result exactly as it is (this
  // keeps the empty-multi robustness case a no-op).
  if (allSets.length === 0) return parsed;

  // (1) Per-child checks, over each child's own consumed span (its raw_text)
  // with that child's emitted sets — the precise mirror of the per-segment parse.
  for (const child of exercises) {
    const childText = normalizeGateText(child.raw_text || '');
    if (!childText) continue;
    const refused = checkSpan(parsed, rawText, childText, child.sets);
    if (refused) return refused;
  }

  // (2) Per-line backstop over the whole turn, for a span the merge dropped: a
  // second segment for the same exercise is merged into the first child's
  // raw_text, so its own text is no longer visible per-child. A line that mixes
  // families, or carries an ambiguous @ the turn emitted as a weight, still
  // refuses. Lines already surfaced as unresolved emitted no sets, so nothing
  // was silently dropped from them — skip those, so one ambiguous line never
  // discards its clean siblings.
  const unresolvedLines = new Set(
    (Array.isArray(parsed.unresolved) ? parsed.unresolved : [])
      .map(u => normalizeGateText(u.line || '').trim()),
  );
  const lines = normalizeWeightUnits(String(rawText || ''))
    .split(/\r?\n/)
    .map(line => normalizeGateText(line).trim())
    .filter(Boolean);
  for (const line of lines) {
    if (unresolvedLines.has(line)) continue;
    const refused = checkSpan(parsed, rawText, line, allSets);
    if (refused) return refused;
  }

  // (3) Zero-value sets across all children (already covered per-child above,
  // but a child without raw_text skips step 1 — catch its sets here).
  if (hasZeroValueSet(allSets)) return ask(zeroValueMessage(), 'zero_set_value', parsed, rawText);

  return parsed;
}

function applyFullConsumptionGate(parsed, rawText) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  // A-01: the multi-exercise output carries sets too — every child is checked,
  // and the whole turn refuses when any child trips.
  if (parsed.intent === 'log_sets_multi') return applyMultiGate(parsed, rawText);
  // Only a successfully-parsed single set line can have silently dropped a group
  // or emitted a tiny @-weight. Any other intent (needs_clarification, small
  // talk) is left exactly as it is.
  if (parsed.intent !== 'log_sets') return parsed;

  const text = normalizeGateText(rawText);
  if (!text) return parsed;

  const sets = Array.isArray(parsed.sets) ? parsed.sets : [];
  return checkSpan(parsed, rawText, text, sets) || parsed;
}

module.exports = { applyFullConsumptionGate };
