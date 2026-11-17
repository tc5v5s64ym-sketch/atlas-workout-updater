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
//   A-01 re-fix (#1765 regression, Astra re-audit #3) — seven NEW incomplete-
//     parse forms reach the write sink that the original probe set did not
//     cover. Every one is a SECOND set-group token the parser's first-claim
//     grammars never consume: `parseSetsFirst` and `parseWeightRepsSets` match
//     only the FIRST group (`bench 3x8@165 3x8@135`, `bench 185x8x3 165x8x3`),
//     `parseSetsFirst` claims the text before a WxR group is ever seen
//     (`bench 185x5 3x8@165`, either order), a bare `NxM` token after a group
//     (`bench 3x8@165 3x8`), a second group on a later line of a one-exercise
//     turn (newlines collapse to one blob) or inside one segment (segments
//     split on FIRST exercise mention only), and a trailing `xN` repeat or
//     stray `@N` beside a group. The gate therefore counts set-group tokens
//     per span and refuses when a second group is present that no grammar
//     consumes as a whole — separator-agnostic, so it closes the class, not
//     just the listed separators. Forms the parser DOES consume whole are
//     exempt: slash repeats (shorthand token loop), `for` repeats
//     (`parseNaturalSets` matchAll), dumbbell repeats (`parseDumbbellGroups`
//     matchAll), WxR@RIR tiling pairs (`245 x 6 @3 225 x 5 @2`, both
//     leaders > 10 — a weight, never a set count), slash-chain repeats
//     (`225 5/2 8/8/7 x3` — the `xN` repeats the last chain element), WxR
//     repeats (`185x5 x3` — the `xN` is the WxRxN count), and one-line
//     multi-exercise turns (`bench 3x8@165 squat 3x8@135` — the parser
//     segments per exercise and consumes both; the per-line backstop checks
//     only line content no child's raw_text already covers).
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
const { normalizeParserText, normalizeWeightUnits, looksLikeSetToken, isNameLikeWord } = require('./workoutTextParser');

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

// A-01 re-fix — set-group tokens, counted per span. The parser's first-claim
// grammars each consume at most ONE group of their own shape, so a second
// group token in the same span is dropped by construction:
//
//   X_AT_GROUP — `NxM@W`, any leader. A leader ≤ 10 is a set count (the shape
//     `parseSetsFirst` claims); a leader > 10 is a weight (the WxR@RIR shape
//     `parseWeightRepsAtRir` tiles whole). Spacing is free (`3 x 8 @ 165`).
//   WXR_N_GROUP — `WxRxN` (`185x8x3`), the shape `parseWeightRepsSets` claims
//     once. A bare `WxR` token (`185x5`, `3x8`) is the same family without the
//     count; the lookaheads keep it from double-counting the `WxR` prefix of
//     an x@ group (`3x8` in `3x8@165`) or of a WxRxN group (`185x8` in
//     `185x8x3`). Dumbbell groups (`55s x10 @3`) never match any of these:
//     the `s` sits between the digits and the `x`.
const X_AT_GROUP_GLOBAL = /\b\d+\s*x\s*\d+\s*@\s*\d+(?:\.\d+)?/g;
const DUMBBELL_X_AT_GROUP_GLOBAL = /\b\d+(?:\.\d+)?s\s+x\d+\s*@\s*\d+(?:\.\d+)?/g;
const DUMBBELL_SLASH_GROUP_GLOBAL = /\b\d+(?:\.\d+)?s\s+\d+\s*\/\s*\d+(?:\.\d+)?(?:\s+x\d+)?/g;
const WXR_N_GROUP_GLOBAL = /\b\d+(?:\.\d+)?\s*x\s*\d+\s*x\s*\d+\b/g;
const BARE_WXR_TOKEN_GLOBAL = /\b\d+(?:\.\d+)?\s*x\s*\d+\b(?!\s*@)(?!\s*x\s*\d)/g;
const TRAILING_REPEAT_TOKEN = /\bx\d+\b/;
const DUMBBELL_GROUP = /\b\d+(?:\.\d+)?s\s+(?:\d+\s*\/\s*\d+|x\d+\s*@\s*\d+)/;
// P4 (pack-only, #1790 follow-up) — a prose set group: `N sets of M at W`
// (`3 sets of 8 at 165`, `3 sets of 8 reps @ 165`). No parser grammar consumes
// it (`parseNaturalSets` matches only `\d+ for \d+`), so beside any other
// group it is a dropped second group. A lone prose group never reaches the
// gate: the parser refuses it first (needs_clarification), so the gate only
// ever sees it beside a consumed group.
// Round 2 (pre-review on 3a9eff2c, F1–F4): the same group spelled with a
// `with` weight preposition (`3 sets of 8 with 165`), an `x` separator
// (`3 sets x 8 at 165`), or number-words in the count/rep slots
// (`three sets of 8 at 165`, `3 sets of eight at 165`) dropped just as
// silently. The count and rep slots accept digits or number-words zero–
// twenty; the rep slot must still be numeric, so `did 3 sets of bench`
// (a word after "of") is not a prose group.
const NUMBER_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';
const PROSE_COUNT = `(?:\\d+|${NUMBER_WORD})`;
const PROSE_SET_GROUP = new RegExp(`\\b${PROSE_COUNT}\\s+sets?\\s+(?:of|x)\\s+${PROSE_COUNT}\\s+(?:reps?\\s+)?(?:at|@|with)\\s*\\d+(?:\\.\\d+)?\\b`);
const PROSE_SET_GROUP_GLOBAL = new RegExp(PROSE_SET_GROUP.source, 'g');
// P8/P9 (pack-only, #1790 follow-up) — zero-quantity directives the parser
// drops: a trailing `x0` repeat, and prose `for zero sets` / `zero sets` /
// `0 sets`. The shorthand consumes a trailing `xN` as the slash group's own
// repeat count, but `x0` is silently ignored instead of applied; "zero" is a
// word, not a digit, so no `for` grammar emits from it either.
// Round 2 (pre-review on 3a9eff2c, F5–F8): `for no sets` / `for none sets`
// state zero sets as plainly as `zero`; `x00`, `x 00`, and `x-0` are the
// same zero repeat spelled with a doubled zero or a hyphen. The repeat
// directive takes one-or-more zeros with an optional hyphen, so `x05`
// (a 5-repeat, not a zero repeat) still does not match.
const ZERO_REPEAT_DIRECTIVE = /\bx\s*-?\s*0+\b/;
const ZERO_SETS_PROSE = /\b(?:for\s+)?(?:zero|0|no|none)\s+sets?\b/;
// Unit-glued groups (B4): `normalizeWeightUnits` converts `85kg` only when a
// word boundary follows the unit, so in `85kgx5` / `185lbx5` the unit survives
// unconverted and the token matches neither bare-WxR nor WxRxN above — the
// group then drops silently beside a group the parser does claim. Count the
// glued forms as group tokens of the same family.
const UNIT_WXR_TOKEN_GLOBAL = /\b\d+(?:\.\d+)?\s*(?:kgs?|lbs?)\s*x\s*\d+\b(?!\s*@)(?!\s*x\s*\d)/g;
const UNIT_WXR_N_GROUP_GLOBAL = /\b\d+(?:\.\d+)?\s*(?:kgs?|lbs?)\s*x\s*\d+\s*x\s*\d+\b/g;

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

function zeroRepeatMessage() {
  return "That repeats a set zero times (x0), which isn't a real set. Mind re-sending it with the sets you mean? (nothing's logged yet)";
}

function zeroSetsMessage() {
  return "That says zero sets, which isn't a real set. Mind re-sending it with the sets you mean? (nothing's logged yet)";
}

function unrecognizedSetNotationMessage() {
  return "That includes a set written with a multiplier I don't recognize, so I can't tell what it means. Mind re-sending it with x, like 3x8@165? (nothing's logged yet)";
}

function repeatedSetGroupMessage() {
  return "That looks like two sets in one entry, and I can only read the first — I don't want to drop the second. Mind re-sending each set on its own line? (nothing's logged yet)";
}

// A-01 re-fix — a second set-group token in one span that no parser grammar
// consumes whole. Returns the refusal code, or null. The shapes the parser
// consumes whole are exempt by construction:
//   - two x@ groups with NO sets-first claimant (both leaders > 10) are the
//     WxR@RIR tiling pair (`245 x 6 @3 225 x 5 @2`);
//   - a lone WxR token with no other group (`185x5`, `185x5 165x8`) tiles;
//   - a trailing `xN` beside a slash/for/dumbbell group is that grammar's own
//     repeat/count (`185 5/2 x3`, `60s 10/3 x3`), never a second group;
//   - a trailing `xN` that IS the WxRxN count (`185x5 x3` parses as 3× 185x5),
//     spaced included (`185 x 5 x 3` — the WxRxN match is stripped before
//     counting bare tokens, so its inner `5 x 3` tail never reads as a
//     second group);
//   - a slash-chain tail's `xN` (`225 5/2 8/8/7 x3` repeats the last chain
//     element) — chain tails are stripped before counting, so the RIR digit
//     never reads as a WxR leader;
//   - two dumbbell groups together are consumed whole (`parseDumbbellGroups`
//     matchAll: `55s x10 @3 60s x8 @2`, `60s 10/3 65s 8/2`).
// Everything else below is a group `parseSetsFirst` / `parseWeightRepsSets`
// claims once and then drops: a second x@ group, a WxRxN group beside a
// sets-first group, two WxRxN groups, a WxRxN group beside a slash or `for`
// group (`185x8x3 165 8/2`, `185x8x3 175 for 5` — the WxRxN group is claimed
// and the other drops), a bare WxR token beside any other group (slash /
// for / dumbbell / sets-first / WxRxN), a trailing `xN` beside a
// single-claim group, a stray `@N` no group owns, a unit-glued group
// (`85kgx5`, `185lbx5` — the unit survives normalization unconverted, so it
// counts as a group token of the same family), or a dumbbell group beside
// any barbell group (`parseDumbbellGroups` is tried first and claims the
// text: `bench 185 5/2 55s x10 @3`, `bench 3x8@165 55s x10 @3`).
function hasRepeatedSetGroup(text) {
  const t = String(text || '');
  // A slash set is `weight reps/rir` — the shorthand path consumes the pair
  // whole, so its digits must not participate in any other group's count:
  // without this, the RIR digit reads as a WxR leader (`185 5/2 x3` looks
  // like a `2 x 3` group, and the legit repeat `bench 185 5/2 x3` would
  // falsely refuse; same for a dumbbell slash pair, `60s 10/3 x3`, and for a
  // slash-chain tail, `225 5/2 8/8/7 x3` — the `xN` repeats the last chain
  // element, and the unstripped `7 x3` would read as a phantom group).
  // Strip weight+slash pairs, dumbbell groups, and slash-chain tails before
  // counting groups; the family checks below still run on the original text.
  const g = t
    .replace(/\b\d+(?:\.\d+)?\s+\d+\s*\/\s*\d+(?:\.\d+)?/g, ' ')
    .replace(DUMBBELL_SLASH_GROUP_GLOBAL, ' ')
    .replace(DUMBBELL_X_AT_GROUP_GLOBAL, ' ')
    .replace(/\b\d+(?:\/\d+)+/g, ' ');
  const xAt = [...g.matchAll(X_AT_GROUP_GLOBAL)];
  const setsFirst = xAt.filter(m => Number(m[0].match(/^\d+/)[0]) <= 10);
  const wxrN = [...g.matchAll(WXR_N_GROUP_GLOBAL), ...g.matchAll(UNIT_WXR_N_GROUP_GLOBAL)];
  // F1 (pre-review round 2): a spaced WxRxN group's inner tail (`5 x 3` in
  // `185 x 5 x 3`) matches the bare-WxR regex, and the `wxrN >= 1` arm of
  // the bare-WxR rule then fires on a turn the parser logs whole. Strip
  // matched WxRxN groups before counting bare tokens, so the count of a
  // claimed group never reads as a second group. The trailing-repeat test
  // below uses the same stripped text.
  const withoutWxrN = g.replace(WXR_N_GROUP_GLOBAL, ' ').replace(UNIT_WXR_N_GROUP_GLOBAL, ' ');
  const bareWxr = [...withoutWxrN.matchAll(BARE_WXR_TOKEN_GLOBAL), ...withoutWxrN.matchAll(UNIT_WXR_TOKEN_GLOBAL)];
  const hasSlash = FAMILY_SLASH.test(t);
  const hasFor = FAMILY_FOR.test(t);
  // F2 (pre-review round 2): a `for` GROUP (`175 for 5`) — not bare prose
  // (`for the record`, which a logging WxRxN turn tolerates) — beside a
  // WxRxN group, which the parser drops.
  const hasForGroup = /\bfor\s+\d+/.test(t);
  const hasDumbbell = DUMBBELL_GROUP.test(t);
  const hasOtherGroup = setsFirst.length > 0 || wxrN.length > 0 || bareWxr.length > 0
    || hasSlash || hasFor || hasDumbbell;
  if (xAt.length >= 2 && setsFirst.length >= 1) return 'repeated_set_group';
  if (setsFirst.length >= 1 && wxrN.length >= 1) return 'repeated_set_group';
  if (wxrN.length >= 2) return 'repeated_set_group';
  // F2: a WxRxN group beside a slash or `for` group — the parser claims the
  // WxRxN group and drops the other (`185x8x3 165 8/2`, either order, and
  // `185x8x3 175 for 5`). The bare-WxR analog already refuses; `wxrN` was
  // checked only against setsFirst and itself.
  if (wxrN.length >= 1 && (hasSlash || hasForGroup)) return 'repeated_set_group';
  if (bareWxr.length >= 1 && (setsFirst.length >= 1 || wxrN.length >= 1 || hasSlash || hasFor || hasDumbbell)) return 'repeated_set_group';
  // A trailing `xN` beside a single-claim group is unconsumed (`3x8@165 x3`)
  // — unless the `xN` is already the count of a WxRxN group the parser
  // claims whole (`185x5 x3` parses as 3× 185x5: the WxRxN match absorbs
  // the repeat token, so strip matched WxRxN groups before testing).
  if ((setsFirst.length >= 1 || wxrN.length >= 1) && TRAILING_REPEAT_TOKEN.test(withoutWxrN)) return 'repeated_set_group';
  const stripped = g.replace(X_AT_GROUP_GLOBAL, ' ').replace(DUMBBELL_X_AT_GROUP_GLOBAL, ' ');
  if (/@\s*\d/.test(stripped) && hasOtherGroup) return 'repeated_set_group';
  // A dumbbell group beside any other group: `parseDumbbellGroups` is tried
  // before every barbell grammar, so it claims the text and the other group
  // drops (`bench 185 5/2 55s x10 @3`, `bench 3x8@165 55s x10 @3`). Two
  // dumbbell groups together are consumed whole (matchAll) and stay exempt:
  // the slash test below runs on the text with dumbbell groups removed, so a
  // dumbbell slash group (`60s 10/3`) never counts as a barbell slash group.
  if (hasDumbbell) {
    const withoutDumbbell = t
      .replace(DUMBBELL_X_AT_GROUP_GLOBAL, ' ')
      .replace(DUMBBELL_SLASH_GROUP_GLOBAL, ' ');
    const hasNonDumbbellSlash = FAMILY_SLASH.test(withoutDumbbell);
    if (setsFirst.length >= 1 || wxrN.length >= 1 || bareWxr.length >= 1 || hasNonDumbbellSlash || hasFor) return 'repeated_set_group';
  }
  // P4: a prose set group beside any other group token — no grammar consumes
  // the prose form, so the second group drops (`bench 185 5/2 then 3 sets of
  // 8 at 165` logs only 185x5; `bench 3 sets of 8 at 165 and 2x5@185` logs
  // only the 185 sets). The `at` form is the gap: the `@` form already
  // refuses via the stray-@ arm above.
  const proseGroups = [...t.matchAll(PROSE_SET_GROUP_GLOBAL)];
  if (proseGroups.length >= 1 && (setsFirst.length >= 1 || wxrN.length >= 1 || bareWxr.length >= 1 || hasSlash || hasFor || hasDumbbell)) return 'repeated_set_group';
  return null;
}

// A set group joined by a multiplier the parser never recognizes (B1). The
// group is unconsumed by definition — the parser has no grammar for it — so
// the turn asks instead of previewing the rest without it.
function hasUnrecognizedSetNotation(text) {
  return UNRECOGNIZED_MULTIPLIER.test(String(text || ''));
}

// P8/P9 — a zero-quantity directive beside a consumed set group: the parser
// logs the group and silently drops the zero instruction. Returns the
// clarification message, or null. The group check mirrors
// hasRepeatedSetGroup (slash pairs stripped before bare-WxR counting, so the
// RIR digit of a slash group never reads as a WxR leader beside the `x0`).
// Runs after hasZeroValueSet in checkSpan, so a zero set the parser DID emit
// keeps its existing verdict — never a logged zero set. (E.g. `bench 185 5/2
// for 0 sets` refuses as `mixed_set_format`: the `5/2` + `2 for 0` families
// fire before the zero-value arm. The zero-directive arm only fires when the
// parser dropped the directive entirely.)
function zeroSetDirectiveMessage(text) {
  const t = String(text || '');
  const hasZeroRepeat = ZERO_REPEAT_DIRECTIVE.test(t);
  const hasZeroSets = ZERO_SETS_PROSE.test(t);
  if (!hasZeroRepeat && !hasZeroSets) return null;
  const g = t
    .replace(/\b\d+(?:\.\d+)?\s+\d+\s*\/\s*\d+(?:\.\d+)?/g, ' ')
    .replace(DUMBBELL_SLASH_GROUP_GLOBAL, ' ')
    .replace(DUMBBELL_X_AT_GROUP_GLOBAL, ' ')
    .replace(/\b\d+(?:\/\d+)+/g, ' ');
  const withoutWxrN = g.replace(WXR_N_GROUP_GLOBAL, ' ').replace(UNIT_WXR_N_GROUP_GLOBAL, ' ');
  const hasGroup = FAMILY_SLASH.test(t) || FAMILY_FOR.test(t) || DUMBBELL_GROUP.test(t)
    || [...g.matchAll(X_AT_GROUP_GLOBAL)].length > 0
    || [...g.matchAll(WXR_N_GROUP_GLOBAL)].length > 0
    || [...withoutWxrN.matchAll(BARE_WXR_TOKEN_GLOBAL)].length > 0
    || PROSE_SET_GROUP.test(t);
  if (!hasGroup) return null;
  return hasZeroRepeat ? zeroRepeatMessage() : zeroSetsMessage();
}

// The single-exercise checks (PARSE-4, PARSE-5, zero-value) over one span of
// normalized text and the sets emitted from it. Returns the refusal, or null.
function checkSpan(parsed, rawText, text, sets) {
  if (hasUnrecognizedSetNotation(text)) return ask(unrecognizedSetNotationMessage(), 'unrecognized_set_notation', parsed, rawText);
  const atValue = findAmbiguousAt(text, sets);
  if (atValue) return ask(ambiguousAtMessage(atValue), 'ambiguous_at_value', parsed, rawText);
  const repeated = hasRepeatedSetGroup(text);
  if (repeated) return ask(repeatedSetGroupMessage(), repeated, parsed, rawText);
  if (countFamilies(text) >= 2) return ask(mixedFormatMessage(), 'mixed_set_format', parsed, rawText);
  if (hasZeroValueSet(sets)) return ask(zeroValueMessage(), 'zero_set_value', parsed, rawText);
  const zdm = zeroSetDirectiveMessage(text);
  if (zdm) return ask(zdm, 'zero_set_directive', parsed, rawText);
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
  //
  // B3 (re-fix): a one-line multi-exercise turn (`bench 3x8@165 squat 3x8@135`)
  // is ONE line holding two exercises' groups, and the parser segments per
  // exercise and consumes both whole — but the backstop counted groups across
  // the whole line and refused a fully-logged turn. So a line is checked only
  // for content NO child's raw_text already covers: remove each child's
  // normalized raw_text from the line first; a line left empty is fully
  // verified per-child and skipped. A merged second segment is in no child's
  // raw_text, so it still reaches the check whole.
  const unresolvedLines = new Set(
    (Array.isArray(parsed.unresolved) ? parsed.unresolved : [])
      .map(u => normalizeGateText(u.line || '').trim()),
  );
  const childTexts = exercises
    .map(e => normalizeGateText(e.raw_text || ''))
    .filter(Boolean);
  const lines = normalizeWeightUnits(String(rawText || ''))
    .split(/\r?\n/)
    .map(line => normalizeGateText(line).trim())
    .filter(Boolean);
  for (const line of lines) {
    if (unresolvedLines.has(line)) continue;
    let uncovered = line;
    for (const childText of childTexts) {
      if (uncovered.includes(childText)) uncovered = uncovered.replace(childText, ' ');
    }
    if (!uncovered.trim()) continue;
    const refused = checkSpan(parsed, rawText, uncovered, allSets);
    if (refused) return refused;
  }

  // (3) Zero-value sets across all children (already covered per-child above,
  // but a child without raw_text skips step 1 — catch its sets here).
  if (hasZeroValueSet(allSets)) return ask(zeroValueMessage(), 'zero_set_value', parsed, rawText);

  return parsed;
}

// Did the parser resolve this multiline turn per-line (rescue) rather than
// as one blob? The rescue runs only when the collapsed blob dead-ends — for a
// single-exercise turn, exactly when the G1 refuse-to-merge guard fires: a
// name-like word run sits between set tokens in the rest
// (`bench 185x8x3 bench 165 8/2` → the repeated `bench` between the WxRxN
// group and the slash group). Mirror that guard on the collapsed text: some
// name-like word appears at least twice, with a set token before its later
// occurrence and another set token after it. Two details make the mirror
// exact: (1) x@ groups are NOT set tokens (`looksLikeSetToken('3x8@165')`
// is false), so an x@-first turn never matches — the blob claims the first
// x@ group and later groups drop, a true positive the whole-text check must
// keep; (2) the repeated word must be name-like — a contextual-alias word
// (`press` in `bench press 185x5` / `press 165 8/2`) or a continuation word
// (`and`) does not trip the guard, the blob logs, and the dropped group must
// still refuse. The parser's own classifiers are used (exported from
// workoutTextParser) so the two never drift apart.
function isMultilineRescueShape(text) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  // The parser's guard runs on the rest (after the exercise name is stripped),
  // where a prose lead's numbers are gone. Mirror that: start the window at
  // the first name-like word — a prose number before it must not count as the
  // set token before the repeated name (`did 3 sets of bench 3x8@165 bench
  // 165 8/2` drops the slash; the `3` is not a set token in the rest).
  const start = tokens.findIndex(isNameLikeWord);
  if (start < 0) return false;
  const window = tokens.slice(start);
  for (let i = 0; i < window.length; i += 1) {
    const word = window[i];
    if (!isNameLikeWord(word)) continue;
    if (window.indexOf(word) !== i) continue; // only the first occurrence can start the run
    for (let j = i + 1; j < window.length; j += 1) {
      if (window[j] !== word) continue;
      const setBefore = window.slice(0, j).some(looksLikeSetToken);
      const setAfter = window.slice(j + 1).some(looksLikeSetToken);
      if (setBefore && setAfter) return true;
    }
  }
  return false;
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
  // Multiline turns resolve per-line when the blob dead-ends (rescue): each
  // line is the parser's consumption unit, so check each line on its own
  // first — a within-line drop (two x@ groups on one line, a WxRxN beside a
  // slash on one line) still refuses there. The whole-text check still runs,
  // but a refusal it produces is suppressed when the turn has the rescue
  // shape AND every line passes on its own: the parser logged each line
  // separately and nothing was dropped (`bench 185x8x3` + `bench 165 8/2`
  // logs 4 sets; `bench 175 for 5` + `bench 165 8/2` logs both families).
  // A blob-flattened turn keeps its whole-text refusal: x@-first (no rescue
  // shape — x@ is not a set token) and a contextual-alias-only repeat
  // (`press` alone) both still drop.
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map(line => normalizeGateText(line).trim())
    .filter(Boolean);
  if (lines.length > 1) {
    for (const line of lines) {
      const refused = checkSpan(parsed, rawText, line, sets);
      if (refused) return refused;
    }
    const whole = checkSpan(parsed, rawText, text, sets);
    if (whole && !isMultilineRescueShape(text)) return whole;
    return parsed;
  }
  return checkSpan(parsed, rawText, text, sets) || parsed;
}

module.exports = { applyFullConsumptionGate };
