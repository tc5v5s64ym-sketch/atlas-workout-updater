'use strict';

// Multi-Modality input recognition — Taxonomy §4 (PR 486, slices 1–2).
//
// Recognizes the NON-slash-notation logging formats (timed holds, steady cardio,
// cardio intervals, and circuits) into structured fields, so Atlas can later
// preview / route them. This is a SEPARATE, pure recognizer — it deliberately does
// NOT touch `services/workoutTextParser.js` or the slash-notation contract
// (`225 5/2` = 225 lb × 5 reps @ RIR 2). It returns `null` for anything that looks
// like the existing weighted/slash workflow, so the resistance parser is never
// hijacked.
//
// PURE / read-only: no I/O, no LLM, no Sheets, NO write path, NO Log_Cleaned/Effort
// schema change, NOT wired into the live parse/preview/write path. Wiring (dry-run
// preview) and the [owner-gated] persistence target are later slices. Added-load
// bodyweight (which carries slash sets) is deferred to a later slice.

const MODALITIES = Object.freeze([
  'timed_hold', 'cardio_steady', 'cardio_interval', 'circuit',
]);

// Names that read as a timed isometric hold (duration is the whole point).
const HOLD_NAME = /\b(plank|wall\s*sit|dead\s*hang|hollow\s*hold|l-?sit|hold|iso(?:metric)?\s*hold|side\s*plank)\b/i;
// Names that read as steady cardio (machine or locomotion).
const CARDIO_NAME = /\b(run(?:ning)?|jog(?:ging)?|walk(?:ing)?|hike|row(?:ing)?|bike|cycl\w*|spin|elliptical|treadmill|stair\s*master|stairmaster|stair\s*climber|airdyne|assault\s*bike|ski\s*erg|erg|swim|ruck)\b/i;

// A weighted/slash-notation set token (e.g. "225 5/2", "8/2", "x3" after a slash
// set). If present, this is the resistance workflow → not ours.
const SLASH_SET = /\d+\s*\/\s*\d+/;

// F-1 (#1767): the quantity extractors below match digits only — a sign
// character in front of a number was silently dropped, so a signed quantity
// was recorded as positive work ("Dead hang −45 seconds" → a 45s timed_hold
// row). The entire signed, dimensional quantity must be consumed, and
// nonpositive or ambiguous work rejected before an approvable row exists.
// Two guards enforce that at the single entry point (recognizeModalityInput
// is the only export that reads input, so the preview, the row builder, and
// sentence stripping all see the same refusal):
//   1. hasSignedOrRangedQuantity(t): an attached or spaced sign on a
//      quantity, a digits–dash–digits range feeding a unit, a word range
//      ("30 to 45 sec", "between 30 and 45 sec", "30 and/or 45 sec",
//      "30 up to 45 sec", "30 vs 45 sec", "30 versus 45 sec",
//      "30 v 45 sec", "30 plus 45 sec"), a symbol range ("30+45 sec",
//      "30 & 45 sec", "30 * 45 sec"), a tilde/dot range
//      ("30~45 sec", "30..45 sec", "30≈45 sec"), a spelled-out sign
//      ("minus 45 seconds", "negative 45 sec"), a signed sets multiplier
//      ("x -3", "3x -3", "x3-3"), a signed number dangling after a count
//      word ("3 sets -3"), a plus-minus sign ("±45 sec", "∓45 sec"), a
//      signed decimal-comma quantity ("-5,5 sec"), a chained separator
//      stating one dimension twice ("5 km - 30 min - 45 sec"), a second
//      end with its unit elided ("30 sec to 45", "5 km - 10"), or an
//      elapsed-time pair ("32:10 - 45:20") — plus the structural whitelist
//      (coordinator direction 2026-11-16): any two-numbers-one-unit shape
//      whose separator is not a known legitimate one refuses, so no new
//      glyph or synonym can leak through the enumerations above. See
//      hasUnlistedTwoNumberSeparator for the legitimate set (drawn from
//      the passing controls/tests) and the shape boundaries.
//      A spaced dash IS a separator — and still parses — only when it sits
//      between two stated quantities: the text before it ends with a unit
//      word or a number ("Run 5 km - 30 min", "AMRAP 12 min: … - 6 rounds",
//      "Plank 60 sec - 3x" — the last reads as duration, then sets), or the
//      dash is inside a circuit movement list and the rounds count follows
//      it ("AMRAP 12 min: … - 6 rounds"). Any other spaced sign (start of
//      input, after a name, after a preposition or `x`, after a rating
//      keyword) is a sign and refuses. A spaced dash between two quantities
//      of the SAME dimension is a range, not a separator ("60 sec - 45 sec",
//      "5 km - 10 km") — hasSameDimensionPair refuses those, and
//      hasRepeatedDimensionChain refuses the same dimension stated twice
//      anywhere in one separator chain ("5 km - 30 min - 500 m") or as two
//      elapsed times ("32:10 - 45:20").
//   2. hasNonpositiveWork(rec): a recognized record whose work quantity is
//      zero (duration / distance / rounds / work / sets / cap). Signs never
//      survive extraction (the regexes match digits only), so zero is the
//      only nonpositive value a record can carry. Ratings (RPE/HR/level) may
//      legitimately be zero and are not work; a zero rest is meaningful
//      (no rest between intervals) and is allowed. Ratings refuse only when
//      signed or ranged — a literal zero rating is recorded as stated.
// SIGN_CHARS is the Unicode dash category (\p{Pd} — every hyphen/dash) plus
// the minus signs that live outside it: U+2212 minus, U+207B superscript
// minus, U+208B subscript minus, U+2796 heavy minus, U+02D7 modifier-letter
// minus, U+00AD soft hyphen, U+2043 hyphen bullet, plus the two math signs
// plus-minus (U+00B1) and minus-or-plus (U+2213) — Sm, not \p{Pd}, and not
// in the explicit list until the round-3 fix (B11: "±45 sec" / "∓45 sec"
// recorded positive work). Any one of them in front
// of a quantity is a sign. A new dash added to Unicode is covered by \p{Pd}
// automatically; the explicit list is only the non-Pd stragglers. All
// patterns using it carry the `u` flag. (Pre-review B6: the previous
// 13-char denylist leaked U+207B/U+208B/U+2796/U+2043/U+2E3A/U+2E3B/U+058A/
// U+05BE/U+1806/U+2E17/U+2E40.)
const SIGN_CHARS = '[\\p{Pd}\\u2212\\u207B\\u208B\\u2796\\u02D7\\u00AD\\u2043\\u00B1\\u2213]';
// A signed number may lead with the decimal point ("-.5 sec" reads as 5 in
// the extractors — the sign is dropped AND the point is skipped — so the
// guard must match it; the unsigned ".5 sec" magnitude quirk is pre-existing
// and out of scope). Both forms accept a comma as the decimal separator
// ("-5,5 sec", "-,5 sec", "30,5-45,5 sec" — B12: the comma form escaped
// the sign and range patterns, so a signed comma quantity recorded
// positive work. The unsigned "5,5 sec" magnitude quirk is pre-existing
// and unchanged).
const SIGNED_NUMBER = '(?:\\d+(?:[.,]\\d+)?|[.,]\\d+)';
const PLAIN_NUMBER = '(?:\\d+(?:[.,]\\d+)?)';
const UNIT = '(?:km|miles?|mi|meters?|m|min(?:ute)?s?|mins|sec(?:ond)?s?|secs)';
// What may follow a quantity's digits: a unit, the "x" multiplier, a rounds
// count, or the ":" of an mm:ss elapsed time. The unit list is what makes a
// bare "2026-11-16" date (no unit follows either number) and a "Nov 3-5"
// (no unit) NOT a range, and a "-5C" / "-5 degrees" (no modality unit)
// NOT a signed quantity.
// The range check deliberately omits "rounds": a movement list ends in a
// spaced-dash separator before the rounds count ("AMRAP 12 min: push-ups,
// squats - 6 rounds"), which is digits–dash–digits feeding "rounds" and
// must keep parsing. An
// attached rounds range ("6-8 rounds") or signed rounds ("-6 rounds") is
// still refused by the sign check below; only a SPACED rounds range
// ("6 - 8 rounds") is a known residual — the spaced dash is this module's
// separator idiom.
const QUANTITY_FOLLOW = `(?:\\s*${UNIT}\\b|\\s*x\\b|\\s*rounds?\\b|:)`;
const RANGE_FOLLOW = `(?:\\s*${UNIT}\\b|\\s*x\\b|:)`;
const SIGNED_QUANTITY = new RegExp(`${SIGN_CHARS}(${SIGNED_NUMBER})(?=${QUANTITY_FOLLOW})`, 'u');
const SIGNED_QUANTITY_SPACED = new RegExp(`${SIGN_CHARS}\\s+(${SIGNED_NUMBER})(?=${QUANTITY_FOLLOW})`, 'gu');
// The (?<![\d:]) on every range's first number stops an mm:ss elapsed time
// from reading as a range start ("Run 32:10 - 5 km" — the "10" is the
// seconds half, not a range start; the lookbehind also stops a suffix of a
// longer number from matching as the start).
const RANGED_QUANTITY = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s*${SIGN_CHARS}\\s*(${PLAIN_NUMBER})(?=${RANGE_FOLLOW})`, 'u');
// Word ranges: "30 to 45 sec", "5 or 10 km", "30 through 45 sec",
// "30 and 45 sec", "30 and/or 45 sec", "30 up to 45 sec", "30 vs 45 sec",
// "30 versus 45 sec", "30 v 45 sec", "30 plus 45 sec" (C1/C2: the versus
// family and "plus" were missing, so those ranges recorded the upper end;
// D1b: "against", "compared to", "over", and "v/s" were missing too).
// The digits must sit directly around the word —
// "Run 5 km to 30 min" does not match (a unit sits between the first number
// and "to"), and "Plank 60 sec to failure" does not match (no digits after
// "to"). "between X and Y" is its own pattern below (the word comes first).
// Longest first ("versus" before "vs" before "v"; "and/or" before "and"/"or";
// "compared to" before "to"; "over" before "or"; "v/s" before "v")
// so the longer form wins; "vs."/"v." allow the abbreviated period.
const RANGE_WORDS = '(?:and/or|up to|compared to|versus|against|vs\\.?|v/s|v\\.?|over|plus|to|or|through|thru|and)';
const RANGED_WORD_QUANTITY = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s+${RANGE_WORDS}\\s+(${PLAIN_NUMBER})(?=${RANGE_FOLLOW})`, 'iu');
const BETWEEN_RANGE = new RegExp(`\\bbetween\\s+(${PLAIN_NUMBER})\\s*(?:${UNIT})?\\s+and\\s+(${PLAIN_NUMBER})\\s*(?:${UNIT})\\b`, 'iu');
// Tilde / dot ranges: "30~45 sec", "30..45 sec" (and "..."). A lone "~45"
// (approximate, no digits before it) does not match — that stays the
// pre-existing approx-nominal residual. The tilde class also holds the
// Unicode approx operators (C3: "30≈45 sec", "30∼45 sec", "30∽45 sec",
// "30～45 sec", "30≃45 sec", "30≅45 sec" all recorded the upper end —
// the same rewording applied to the tilde range; D3 adds the remaining
// U+2242–U+2253 approx operators plus the U+223E–U+223F sine-wave forms).
const TILDE_CHARS = '[~\\u223C\\u223D\\uFF5E\\u2248\\u2243\\u2245\\u2252\\u2253\\u224D\\u224E\\u224F\\u2250\\u2251\\u2242\\u2246\\u224A\\u224B\\u223F\\u223E\\u223A\\u223B]';
const TILDE_RANGE = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s*${TILDE_CHARS}\\s*(${PLAIN_NUMBER})(?=${RANGE_FOLLOW})`, 'u');
const DOT_RANGE = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s*\\.\\.+\\s*(${PLAIN_NUMBER})(?=${RANGE_FOLLOW})`, 'u');
// Symbol connectors between two numbers feeding one unit ("30+45 sec",
// "30 & 45 sec", "30 * 45 sec" — C2: recorded the upper end, wrong under
// every reading, since as arithmetic 30+45 is 75, not 45; D2 adds the
// multiplication/division/equality/dot operators "×", "÷", "=", "⋅", "∙",
// "%" — the same rewording, same wrong upper end). Attached forms
// exist, so the connector takes \s* on both sides. "/" is deliberately NOT
// in this class — it is the interval separator ("8 x 400m / 90 sec").
// "x" is not in this class either — "30 x 45 sec" is the legitimate sets
// multiplier. A leading "+45" stays positive: a two-number pattern needs a
// number before the connector, so "Dead hang +45 seconds" cannot match.
const SYMBOL_CHARS = '[+&*\\u00D7\\u00F7=\\u22C5\\u2219%]';
const RANGED_SYMBOL_QUANTITY = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s*${SYMBOL_CHARS}\\s*(${PLAIN_NUMBER})(?=${RANGE_FOLLOW})`, 'u');
const PAIR_SYMBOL = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s*(${UNIT})\\s*${SYMBOL_CHARS}\\s*(${PLAIN_NUMBER})\\s*(${UNIT})\\b`, 'gu');
// A tilde/dot-connected same-dimension pair ("30 sec ≈ 45 sec",
// "30 sec ~ 45 sec", "30 sec .. 45 sec" — D3b: the tilde/dot classes were
// never wired into the pair check, so even operators already in the class
// rowed the first end as definite). Same shape as PAIR_SYMBOL, same
// dimension check in hasSameDimensionPair.
const PAIR_TILDE = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s*(${UNIT})\\s*(?:${TILDE_CHARS}|\\.\\.+)\\s*(${PLAIN_NUMBER})\\s*(${UNIT})\\b`, 'gu');
// A signed number dangling after a count word ("3 sets -3", "3 reps -3",
// "3 rounds -3" — N18: the "-3" recorded nothing, so no false work, but
// the spaced-sign principle is refuse-instead-of-drop; the word-form count
// itself is still dropped as before, only the dangling sign now refuses;
// D4: singular "set"/"rep"/"round" and "repetitions" were missing).
const COUNT_SIGN = new RegExp(`\\b(?:sets?|reps?|rounds?|repetitions?)\\s*${SIGN_CHARS}\\s*${SIGNED_NUMBER}`, 'iu');
// A signed sets multiplier: "x -3" / "x-3" (the "x" sits before the sign,
// so the quantity-follow lookahead cannot see it — the digits end the
// input). The "x" may follow a digit ("3x -3") or a word boundary — but a
// word merely ending in "x" ("Box", "Relax") must not match. The count may
// sit between the "x" and the sign ("x3-3", "x 3 - 3" — B14: the prefix
// order dropped the signed count and recorded the sets).
const SETS_SIGN = new RegExp(`(?:\\b|(?<=\\d))x(?:\\s*\\d+)?\\s*${SIGN_CHARS}\\s*${SIGNED_NUMBER}`, 'iu');
// A spelled-out sign in front of a quantity: "minus 45 seconds",
// "negative 45 sec". "plus"/"positive" are not refused — the value is right.
const SPELLED_SIGN = new RegExp(`\\b(?:minus|negative)\\s+(${SIGNED_NUMBER})(?=${QUANTITY_FOLLOW})`, 'iu');
// A signed or ranged rating (RPE / HR / level): the keyword anchors it, so
// "RPE -7" and "HR 140-150" refuse while "Plank 60 sec - RPE 7" (spaced
// separator, no sign on the number) still parses. Spaced forms ("RPE - 7",
// "RPE 7 - 8") and spelled forms ("RPE minus 7") refuse too — a dash after
// a rating keyword is never a separator between quantities.
const RATING_WORD = '(?:rpe|avg(?:erage)?\\s*hr|hr|level)';
const SIGNED_RATING = new RegExp(`\\b${RATING_WORD}\\s*${SIGN_CHARS}${SIGNED_NUMBER}`, 'iu');
const SIGNED_RATING_SPACED = new RegExp(`\\b${RATING_WORD}\\s*${SIGN_CHARS}\\s*${SIGNED_NUMBER}`, 'iu');
const RANGED_RATING = new RegExp(`\\b${RATING_WORD}\\s*${PLAIN_NUMBER}\\s*${SIGN_CHARS}\\s*${PLAIN_NUMBER}`, 'iu');
const RANGED_RATING_SPACED = new RegExp(`\\b${RATING_WORD}\\s*${PLAIN_NUMBER}\\s*${SIGN_CHARS}\\s*${PLAIN_NUMBER}`, 'iu');
const RANGED_RATING_WORDS = new RegExp(`\\b${RATING_WORD}\\s*${PLAIN_NUMBER}\\s+${RANGE_WORDS}\\s*${PLAIN_NUMBER}`, 'iu');
const SPELLED_RATING = new RegExp(`\\b${RATING_WORD}\\s+(?:minus|negative)\\s+${SIGNED_NUMBER}`, 'iu');
// A symbol-connected rating range ("RPE 7+8", "RPE 7 + 8", "HR 140&150" —
// C2, rating form: the second number is dropped and the first recorded as
// definite, the same shape as the quantity form).
const RANGED_RATING_SYMBOL = new RegExp(`\\b${RATING_WORD}\\s*${PLAIN_NUMBER}\\s*${SYMBOL_CHARS}\\s*${PLAIN_NUMBER}`, 'iu');
// The text before a spaced sign ends with a unit word or a number — where
// the unit may be glued to its digits ("5km", "60sec": the unit is preceded
// by a digit, not a word boundary) or be a bare "k" after a digit ("5k").
// The \b guards stop a trailing letter from reading as a unit ("Gym - 5 sec"
// ends with "m" of Gym, not the metre unit; "Plank - 45 sec" ends with "k"
// of Plank, not the kilo shorthand).
const SEPARATOR_BEFORE = /(?:(?:\b|(?<=\d))(?:km|miles?|mi|meters?|m|min(?:ute)?s?|mins|sec(?:ond)?s?|secs)|(?<=\d)k|\d)\s*$/i;
const CIRCUIT_LIST_BEFORE = /\b(?:amrap|emom|circuit|wod|metcon)\b[^:]*:/i;

// A spaced dash between two quantities of the SAME dimension is a range,
// not a separator ("60 sec - 45 sec", "5 km - 10 km", "30 sec to 45 sec"):
// the row would record the first end as definite and silently drop the
// second. Different dimensions ("5 km - 30 min") and sets/rounds/RPE after
// the dash stay separators.
function dimensionOf(unit) {
  const u = String(unit || '').toLowerCase();
  if (/^(min|mins|minute|minutes|sec|secs|second|seconds)$/.test(u)) return 'duration';
  if (/^(km|mi|mile|miles|m|meter|meters)$/.test(u)) return 'distance';
  return null;
}
const PAIR_DASH = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s*(${UNIT})\\s*${SIGN_CHARS}\\s*(${PLAIN_NUMBER})\\s*(${UNIT})\\b`, 'gu');
const PAIR_WORD = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s*(${UNIT})\\s+${RANGE_WORDS}\\s+(${PLAIN_NUMBER})\\s*(${UNIT})\\b`, 'giu');
function hasSameDimensionPair(t) {
  for (const re of [PAIR_DASH, PAIR_WORD, PAIR_SYMBOL, PAIR_TILDE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      const d1 = dimensionOf(m[2]);
      const d2 = dimensionOf(m[4]);
      if (d1 && d1 === d2) return true;
    }
  }
  return false;
}

// A separator chain states one dimension twice: "5 km - 30 min - 45 sec"
// (the shared middle quantity hides the second end from
// hasSameDimensionPair, whose global pair scan consumes it — B15), or two
// elapsed times ("32:10 - 45:20" — B17). One match consumes the whole
// chain, so no end is shadowed: refuse when any dimension repeats inside
// one chain. Only dash- or word-connected quantities count — "5 km in
// 30 min" and "60 sec rest 30 sec" are not chains and keep parsing.
const CHAIN_QUANTITY = `(?:${PLAIN_NUMBER}\\s*${UNIT}\\b|\\d{1,2}:\\d{2}(?::\\d{2})?)`;
const CHAIN_SEPARATOR = `(?:\\s*${SIGN_CHARS}\\s*|\\s*${SYMBOL_CHARS}\\s*|\\s*${TILDE_CHARS}\\s*|\\s*\\.\\.+\\s*|\\s+${RANGE_WORDS}\\s+)`;
const CHAIN_RE = new RegExp(`(?<![\\d:])${CHAIN_QUANTITY}(?:${CHAIN_SEPARATOR}${CHAIN_QUANTITY})+`, 'giu');
function chainDimension(q) {
  // An mm:ss elapsed time is its own dimension: "32:10 - 30 min" is an
  // elapsed time plus a duration and keeps parsing, while "32:10 - 45:20"
  // is two elapsed times and refuses. Min/sec units are "duration".
  if (/^\d{1,2}:\d{2}/.test(q)) return 'elapsed';
  const m = q.match(new RegExp(`(${UNIT})\\b`, 'i'));
  return m ? dimensionOf(m[1]) : null;
}
function hasRepeatedDimensionChain(t) {
  CHAIN_RE.lastIndex = 0;
  let m;
  while ((m = CHAIN_RE.exec(t)) !== null) {
    const seen = new Set();
    const qs = m[0].match(new RegExp(CHAIN_QUANTITY, 'gu')) || [];
    for (const q of qs) {
      const d = chainDimension(q);
      if (d) {
        if (seen.has(d)) return true;
        seen.add(d);
      }
    }
  }
  return false;
}

// A second end with its unit elided: "30 sec to 45", "5 km - 10",
// "30sec-45". Every range guard needs a unit after the second number, so
// the elided end was dropped while the first end recorded as definite
// (B16). A bare number after a dash or range word refuses — unless it is
// a sets/reps/rounds count ("60 sec - 3 sets", "60 sec - 3 reps",
// "60 sec - 3x", "60 sec - 3 repetitions" — N25: the carve-out list now
// matches COUNT_SIGN's vocabulary), an elapsed time ("5 km - 32:10"), or a
// quantity with its own unit ("5 km - 30 min", which the chain check then
// judges). The connector class mirrors the chain separator (dash, symbol,
// tilde, dot-run, word — D3b wired the tilde/dot classes in here too),
// and the pattern is case-insensitive (D1: capitalized word ranges).
// Dates ("2026-11-16", "Nov 3-5") have no unit on the first number, so
// they never match.
const ELIDED_SECOND_END = new RegExp(
  `(?<![\\d:])(?:${PLAIN_NUMBER}\\s*${UNIT}\\b|\\d{1,2}:\\d{2}(?::\\d{2})?)(?:\\s*${SIGN_CHARS}\\s*|\\s*${SYMBOL_CHARS}\\s*|\\s*${TILDE_CHARS}\\s*|\\s*\\.\\.+\\s*|\\s+${RANGE_WORDS}\\s+)${PLAIN_NUMBER}(?![\\d.,])(?!\\s*(?:${UNIT}\\b|x\\b|rounds?\\b|reps?\\b|sets?\\b|repetitions?\\b|:))`,
  'iu',
);

function hasNonSeparatorSpacedSign(t) {
  SIGNED_QUANTITY_SPACED.lastIndex = 0;
  let m;
  while ((m = SIGNED_QUANTITY_SPACED.exec(t)) !== null) {
    const before = t.slice(0, m.index);
    if (SEPARATOR_BEFORE.test(before)) continue;
    // Inside a circuit movement list the dash is the list/metadata
    // separator — but only for the rounds count that legitimately follows
    // it ("... - 6 rounds"). Any other spaced quantity there is a signed
    // quantity the splitter would silently drop ("dead hang - 45 sec"),
    // so it refuses instead of dropping.
    const after = t.slice(m.index + m[0].length);
    if (/^\s*rounds?\b/i.test(after) && CIRCUIT_LIST_BEFORE.test(before)) continue;
    return true;
  }
  return false;
}

// ── Structural whitelist (coordinator direction 2026-11-16, #1767) ──────────
// Five rounds of enumeration each leaked: every fix closed its listed
// variants and the next hunt found the next glyph or synonym, and E7 has no
// clean enumeration at all. So the guard inverts: a two-numbers-one-unit
// shape refuses UNLESS its separator is a known legitimate one. The
// legitimate set is drawn from the passing controls / tests — nothing is
// invented — and was verified firsthand on this head before the fix
// (hidden_files/1767-survey-whitelist.js):
//   single-unit `N SEP N UNIT` — `x` with a trailing space (the sets
//     multiplier: `30 x 45 sec` → sets 30, duration 45; `30x 45 sec` the
//     same). Attached `x` (`30x45 sec`) and `x` with no trailing space
//     (`30 x45 sec`) drop the first number, so they refuse. A dot-decimal
//     (`30.45 sec`) is one number, not a separator; a comma-decimal
//     (`30,45 sec`) is not honored by the extractors, so it refuses.
//   pair `N U SEP N U`, same dimension — `rest` (the second number is
//     rest, not work: `60 sec rest 30 sec`); `x` with a leading space
//     (sets: `30 sec x 45 sec` → duration 30, sets 45); `/` when the pair
//     is preceded by a sets multiplier (`6 x 2 min / 60 sec` — the interval
//     rest). Different-dimension pairs are never this shape's business.
//   elided `N U SEP N` (bare second number) — `rest`, or `x` with a
//     leading space (sets). The existing carve-outs (second number followed
//     by a unit, `x`, a count word, or `:`) still apply first.
//   rating `RATING N SEP N` — `x` with NO trailing space (attached sets:
//     `RPE 7 x3` → rpe 7, sets 3). Spaced `x` (`RPE 7 x 8`) misreads the
//     rating number itself as sets, so it refuses.
//   chain (3+ unit quantities, a dimension repeats) — no legitimate
//     separator: any repeated-dimension run refuses, whatever joins it.
// A span is NOT a connector (the shape is skipped, not refused) when it is
// prose between statements: it contains a sentence terminator (`.`/`!`/`?`
// followed by space + uppercase — abbreviated periods such as `v.s.` and
// decimals do not terminate, and a period glued to the next number
// (`30 sec.45 sec`) is a separator, not a terminator, so it refuses), a colon followed by a
// word (a list introducer: `AMRAP 8 min: plank 30 sec`), a rating keyword
// (two separate ratings: `level 7 RPE 8`), a circuit-list comma (inside a
// colon-delimited circuit list body, commas separate movement items:
// `Bike circuit: sprint 30 sec, easy 60 sec`), a date fragment
// (`2026-11-16`, `Nov 16-17`, or a year / number-plus-dash split across
// the separator and the second number), or more than three tokens.
// A colon in the span is a list introducer when a circuit keyword
// precedes the shape or the colon is followed by a word; a lone colon is
// a connector (`30:45 sec` refuses); any other colon use — an
// elapsed-time fragment such as `:10` in `32:10 - 5 km` — is not a
// connector either. The first number of the single-unit shape must be a
// complete token (not glued to a digit or a letter other than the sets
// `x`: `10km - 45 min` is a pair, `5k - 30 min` keeps its 30-min row);
// the elided second number must be bare (not glued to a letter, and not
// the first half of a date or range: `on 11-16` keeps parsing).
// Over-refusals this creates (a multi-activity sentence with a repeated
// dimension, a same-dimension pair joined by `then`/`in`/`,`) are the safe
// direction — the parser would otherwise record one end and silently drop
// the other — and are disclosed as residuals, never as recorded work.
const STRUCT_NUM = '\\d+(?:\\.\\d+)?';
const SENTENCE_END = /[.!?](?=\s+[A-Z])/;
// A count word followed by a sign at the end of the separator (`3 sets -`,
// `3 sets of -`, `3 sets, -`, `3 circuits -`): the signed number after it
// is a dangling count (E6 family), not a second quantity — the separator is
// a connector, never prose, however many tokens it carries. The extended
// count vocabulary (circuits/laps/cycles/series/intervals) rides along;
// the enumerated COUNT_SIGN pattern still refuses the covered words first.
const DANGLING_COUNT_WL = new RegExp(
  `\\b(?:sets?|reps?|rounds?|repetitions?|circuits?|laps?|cycles?|series|intervals?)\\b.{0,20}${SIGN_CHARS}\\s*$`,
  'iu',
);
function spanIsBoundary(sep, t, shapeStart) {
  if (SENTENCE_END.test(sep)) return true;
  if (RATING_KW.test(sep)) return true;
  // A date fragment is prose, not a connector (`Plank 60 sec on 2026-11-16`,
  // `Run 5 km, Nov 16-17` — the date's last component would otherwise read
  // as a bare second number).
  if (/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i.test(sep)) return true;
  if (/\d{4}[-/]\d{1,2}[-/]/.test(sep) || /\b\d{1,2}[-/]\d{1,2}[-/]/.test(sep)) return true;
  // A date split across the separator and the second number (`on 2026-11-`
  // + `16`, `on 11-` + `16`): the separator ends in a year or a
  // number-plus-dash, so the second number is the date's last component,
  // not a bare quantity. A range the separator's dash would otherwise
  // join (`45-50`) is still refused by the enumerated ranged patterns.
  if (/\b\d{4}[-/]/.test(sep) || /\d{1,2}[-/]\s*$/.test(sep)) return true;
  // A dangling count overrides the token rule below: `3 sets of -` is four
  // tokens but a connector (E6), not prose.
  if (DANGLING_COUNT_WL.test(sep)) return false;
  const tokens = sep.trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 3) return true;
  if (sep.includes(':')) {
    // A colon introduces a list when a circuit keyword precedes the shape
    // (`EMOM 10 min: 5 pullups`, `AMRAP 12 min: pushups 10`) or is followed
    // by a word (`AMRAP 8 min: plank 30 sec`); a lone colon is a connector
    // (`30:45 sec`, `30 sec: 45 sec` refuse); any other colon use — an
    // elapsed-time fragment such as `:10` in `32:10 - 5 km` or ` - 32:` in
    // `5 km - 32:10` — is not a connector either.
    const before = t.slice(0, shapeStart);
    if (/\b(?:amrap|emom|circuit|wod|metcon)\b/i.test(before)) return true;
    if (/:\s*[A-Za-z]/.test(sep)) return true;
    if (sep.trim() !== ':') return true;
  }
  // A comma inside a colon-delimited circuit list body separates movement
  // items, not quantities (`Bike circuit: sprint 30 sec, easy 60 sec`).
  if (tokens.length > 0 && tokens[0].startsWith(',')) {
    const before = t.slice(0, shapeStart);
    if (/\b(?:amrap|emom|circuit|wod|metcon)\b/i.test(before) && before.includes(':')) return true;
  }
  return false;
}
function isLegitSingleSep(sep) {
  return sep.trim().toLowerCase() === 'x' && /\s$/.test(sep);
}
function isLegitPairSep(sep, t, matchStart) {
  const trimmed = sep.trim().toLowerCase();
  if (trimmed === 'rest') return true;
  if (trimmed === 'x' && /^\s/.test(sep)) return true;
  // The interval rest: `6 x 2 min / 60 sec` — a `/` pair is the rest token
  // only inside a `<rounds> x <work> / <rest>` interval specification.
  if (trimmed === '/' && /\d+\s*x\s*$/.test(t.slice(0, matchStart))) return true;
  return false;
}
function isLegitElidedSep(sep) {
  const trimmed = sep.trim().toLowerCase();
  if (trimmed === 'rest') return true;
  if (trimmed === 'x' && /^\s/.test(sep)) return true;
  return false;
}
function isLegitRatingSep(sep) {
  return /^\s*x$/i.test(sep);
}
const RATING_KW = /\b(?:rpe|avg(?:erage)?\s*hr|hr|level)\b/i;
const SINGLE_WL = new RegExp(`(?<![\\d:])(${STRUCT_NUM})(?![\\da-wyzA-WYZ])(?!\\.\\d)([\\s\\S]{1,80}?)(${STRUCT_NUM})(?=\\s*(?:${UNIT})\\b)`, 'giu');
const PAIR_WL = new RegExp(`(?<![\\d:])(${STRUCT_NUM})\\s*(${UNIT})\\b([\\s\\S]{0,80}?)(${STRUCT_NUM})\\s*(${UNIT})\\b`, 'giu');
const ELIDED_WL = new RegExp(
  `(?<![\\d:])(?:${STRUCT_NUM}\\s*${UNIT}\\b|\\d{1,2}:\\d{2}(?::\\d{2})?)([\\s\\S]{0,80}?)(${STRUCT_NUM})(?![\\d.,A-Za-z])(?![-/]\\d)(?![-/]\\d{1,2}[-/])(?!\\s*(?:${UNIT}\\b|x\\b|rounds?\\b|reps?\\b|sets?\\b|repetitions?\\b|:))`,
  'giu',
);
const RATING_WL = new RegExp(`\\b(?:${RATING_WORD})\\s*(${STRUCT_NUM})(?![\\da-wyzA-WYZ])(?!\\.\\d)([\\s\\S]{1,80}?)(${STRUCT_NUM})`, 'giu');
const CHAIN_QTY_WL = new RegExp(`(?<![\\d:])(${STRUCT_NUM})\\s*(${UNIT})\\b`, 'giu');
function hasUnlistedTwoNumberSeparator(t) {
  // Single-unit: `N SEP N UNIT`. A unit word inside the separator means
  // the first number already has its unit — that is a pair, not this shape.
  SINGLE_WL.lastIndex = 0;
  let m;
  while ((m = SINGLE_WL.exec(t)) !== null) {
    const sep = m[2];
    if (new RegExp(`\\b(?:${UNIT})\\b`, 'i').test(sep)) continue;
    if (spanIsBoundary(sep, t, m.index)) continue;
    if (isLegitSingleSep(sep)) continue;
    return true;
  }
  // Pair: `N U SEP N U`, same dimension only.
  PAIR_WL.lastIndex = 0;
  while ((m = PAIR_WL.exec(t)) !== null) {
    const d1 = dimensionOf(m[2]);
    const d2 = dimensionOf(m[5]);
    if (!d1 || d1 !== d2) continue;
    const sep = m[3];
    if (spanIsBoundary(sep, t, m.index)) continue;
    if (isLegitPairSep(sep, t, m.index)) continue;
    return true;
  }
  // Elided: `N U SEP N` with a bare second number.
  ELIDED_WL.lastIndex = 0;
  while ((m = ELIDED_WL.exec(t)) !== null) {
    const sep = m[1];
    if (spanIsBoundary(sep, t, m.index)) continue;
    if (isLegitElidedSep(sep)) continue;
    return true;
  }
  // Rating: `RATING N SEP N`.
  RATING_WL.lastIndex = 0;
  while ((m = RATING_WL.exec(t)) !== null) {
    const sep = m[2];
    if (spanIsBoundary(sep, t, m.index)) continue;
    if (isLegitRatingSep(sep)) continue;
    return true;
  }
  // Chain: a run of 3+ unit quantities joined by non-boundary spans, with
  // a repeated dimension. Spans that are boundaries split the run into
  // separate statements.
  CHAIN_QTY_WL.lastIndex = 0;
  const qs = [];
  while ((m = CHAIN_QTY_WL.exec(t)) !== null) {
    qs.push({ start: m.index, end: m.index + m[0].length, dim: dimensionOf(m[2]) });
  }
  let run = [];
  const flushRun = () => {
    if (run.length >= 3) {
      const seen = new Set();
      for (const q of run) {
        if (!q.dim) continue;
        if (seen.has(q.dim)) return true;
        seen.add(q.dim);
      }
    }
    return false;
  };
  for (let i = 0; i < qs.length; i++) {
    if (run.length === 0) { run.push(qs[i]); continue; }
    const prev = run[run.length - 1];
    const span = t.slice(prev.end, qs[i].start);
    if (spanIsBoundary(span, t, prev.end)) {
      if (flushRun()) return true;
      run = [qs[i]];
    } else {
      run.push(qs[i]);
    }
  }
  if (flushRun()) return true;
  return false;
}

// An hour compound ("1 hr 15 min", "1h 30min", "1h30min", "2 hr 30 min"):
// the parser has no hour vocabulary, so the hour is dropped and the second
// number is recorded as the whole quantity (A03) — and, for the spaced
// form, re-read as a heart rate (A1). Refuse the compound instead of
// recording a changed quantity. Guard-side only: no hour unit is invented
// (a follow-up can add hour vocabulary as a feature), and hour forms with
// no second quantity ("Run 5 km in 1 hr", "Plank 1 hr") keep their
// existing behavior.
const HOUR_COMPOUND = new RegExp(
  `\\b(${PLAIN_NUMBER})\\s*(?:hours?|hrs?|h)\\s*(${PLAIN_NUMBER})\\s*(?:${UNIT})\\b`,
  'iu',
);

function hasSignedOrRangedQuantity(t) {
  return SIGNED_QUANTITY.test(t)
    || hasNonSeparatorSpacedSign(t)
    || hasSameDimensionPair(t)
    || hasRepeatedDimensionChain(t)
    || ELIDED_SECOND_END.test(t)
    || HOUR_COMPOUND.test(t)
    || RANGED_QUANTITY.test(t)
    || RANGED_SYMBOL_QUANTITY.test(t)
    || COUNT_SIGN.test(t)
    || RANGED_WORD_QUANTITY.test(t)
    || BETWEEN_RANGE.test(t)
    || TILDE_RANGE.test(t)
    || DOT_RANGE.test(t)
    || SETS_SIGN.test(t)
    || SPELLED_SIGN.test(t)
    || SIGNED_RATING.test(t)
    || SIGNED_RATING_SPACED.test(t)
    || RANGED_RATING.test(t)
    || RANGED_RATING_SPACED.test(t)
    || RANGED_RATING_WORDS.test(t)
    || RANGED_RATING_SYMBOL.test(t)
    || SPELLED_RATING.test(t)
    || hasUnlistedTwoNumberSeparator(t);
}

// "mm:ss" / "h:mm:ss" → total seconds (null if unparseable). Mirrors the
// row builder's elapsedToSec; kept local so this module stays dependency-free.
function elapsedTotalSec(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2];
}

function hasNonpositiveWork(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const bad = (v) => v !== null && v !== undefined && !(v > 0);
  if (rec.modality === 'timed_hold') {
    return bad(rec.duration_sec) || bad(rec.sets);
  }
  if (rec.modality === 'cardio_steady') {
    if (bad(rec.duration_min) || bad(rec.distance_km)) return true;
    if (rec.elapsed !== null && rec.elapsed !== undefined) {
      const total = elapsedTotalSec(rec.elapsed);
      if (total !== null && total <= 0) return true;
    }
    return false;
  }
  if (rec.modality === 'cardio_interval') {
    // rest_sec is deliberately unchecked: zero rest is meaningful.
    return bad(rec.rounds) || bad(rec.work_distance_m) || bad(rec.work_sec);
  }
  if (rec.modality === 'circuit') {
    return bad(rec.cap_min) || bad(rec.rounds);
  }
  return false;
}

function num(s) { const n = Number(s); return Number.isFinite(n) ? n : null; }

// Shared scalar extractors (all optional, all null when absent).
function extractCommon(t) {
  const rpe = t.match(/\brpe\s*(\d+(?:\.\d+)?)/i);
  // A03/A1: `hr <N>` is not a heart rate when <N> is followed by a duration
  // or distance unit (`Run 1 hr 15 min` — the 15 is minutes, not a heart
  // rate). The hour compound itself refuses via HOUR_COMPOUND; this guard
  // keeps the extractor honest wherever the shape appears.
  const hrNotUnit = `(?!\\s*(?:${UNIT})\\b)`;
  const hr = t.match(new RegExp(`\\bavg(?:erage)?\\s*hr\\s*(\\d+)${hrNotUnit}`, 'i'))
    || t.match(new RegExp(`\\bhr\\s*(\\d+)${hrNotUnit}`, 'i'));
  const level = t.match(/\blevel\s*(\d+)/i);
  return {
    rpe: rpe ? num(rpe[1]) : null,
    avg_hr: hr ? num(hr[1]) : null,
    level: level ? num(level[1]) : null,
  };
}

// Leading exercise name = the words before the first number/keyword token.
function leadName(t) {
  const m = t.match(/^([A-Za-z][A-Za-z\s'-]*?)(?=\s*(?:\d|\+|rpe\b|level\b|avg\b|hr\b))/i);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

function durationToMin(t) {
  const min = t.match(/(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|mins)\b/i);
  if (min) return num(min[1]);
  const sec = t.match(/(\d+(?:\.\d+)?)\s*(?:sec(?:ond)?s?|secs)\b/i);
  if (sec) return Math.round((num(sec[1]) / 60) * 100) / 100;
  return null;
}
function durationToSec(t) {
  const sec = t.match(/(\d+(?:\.\d+)?)\s*(?:sec(?:ond)?s?|secs)\b/i);
  if (sec) return num(sec[1]);
  const min = t.match(/(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|mins)\b/i);
  if (min) return Math.round(num(min[1]) * 60);
  return null;
}

// timed hold: a hold-name + a duration, no slash set, no distance.
function recognizeTimedHold(t) {
  if (!HOLD_NAME.test(t)) return null;
  if (SLASH_SET.test(t)) return null;
  const dur = durationToSec(t);
  if (dur == null) return null;
  // Sets multiplier: "x3" / "3x" as a standalone token anywhere in the input
  // (e.g. "Plank 60 sec x3 RPE 7" or "Plank 60 sec RPE 7 x3").
  const setsM = t.match(/(?:\bx\s*(\d+)|\b(\d+)\s*x)\b/i);
  const sets = setsM ? num(setsM[1] || setsM[2]) : null;
  const { rpe } = extractCommon(t);
  // The exercise is the hold itself, not the message lead: a mixed turn
  // ("Rows done, 30 pounds, 10 each arm, 3 sets. Tank answer: 2. Plank 40
  // seconds!!") leads with the resistance work, so leadName returns null
  // (or the wrong lead) and the plank lands unnamed — the persona-plank-pb
  // fact check (#1659) requires a named plank. The lead wins only when it
  // names a hold itself ("Wall sit 45 sec" → "Wall sit"), so a pure hold
  // input is unchanged.
  const holdMatch = t.match(HOLD_NAME);
  const lead = leadName(t);
  const exercise = (lead && HOLD_NAME.test(lead))
    ? lead
    : (holdMatch ? holdMatch[0].trim().replace(/\s+/g, ' ') : lead);
  return {
    modality: 'timed_hold',
    exercise: exercise || null,
    duration_sec: dur,
    sets: sets != null ? sets : 1,
    rpe,
  };
}

// steady cardio: a cardio name OR a distance token, no slash set. Carries any of
// duration / distance / elapsed time (mm:ss) / RPE / HR / machine level.
const DISTANCE = /(\d+(?:\.\d+)?)\s*(km|mi|mile|miles|meters|m)\b/i;
const ELAPSED = /\b(\d{1,3}:\d{2})\b/;

function recognizeCardio(t) {
  const hasCardioName = CARDIO_NAME.test(t);
  const distM = t.match(DISTANCE);
  if (!hasCardioName && !distM) return null;
  if (SLASH_SET.test(t)) return null; // weighted workflow, not cardio
  const durationMin = durationToMin(t);
  // Require at least one cardio quantity so a bare lift name never matches.
  const elapsed = t.match(ELAPSED);
  if (durationMin == null && !distM && !elapsed) return null;
  const { rpe, avg_hr, level } = extractCommon(t);
  let distance_km = null;
  if (distM) {
    const v = num(distM[1]); const unit = distM[2].toLowerCase();
    if (v != null) {
      if (unit === 'km') distance_km = v;
      else if (unit === 'mi' || unit === 'mile' || unit === 'miles') distance_km = Math.round(v * 1.60934 * 100) / 100;
      else if (unit === 'm' || unit === 'meters') distance_km = Math.round((v / 1000) * 1000) / 1000;
    }
  }
  return {
    modality: 'cardio_steady',
    exercise: leadName(t) || null,
    duration_min: durationMin,
    distance_km,
    elapsed: elapsed ? elapsed[1] : null,
    level,
    rpe,
    avg_hr,
  };
}

// cardio intervals: a "<rounds> x <work>" pattern where work is a distance or a
// time, optionally with a rest token after a slash (e.g. "8 x 400m / 90 sec").
// Longest unit alternatives first so "miles"/"meters" win over "mi"/"m".
const INTERVAL_ROUNDS = /\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(km|miles?|mi|meters|m|min(?:ute)?s?|sec(?:ond)?s?)\b/i;
const INTERVAL_REST = /\/\s*(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|mins|sec(?:ond)?s?|secs)\b/i;

function recognizeIntervals(t) {
  if (SLASH_SET.test(t)) return null; // weighted/slash workflow, not ours
  const m = t.match(INTERVAL_ROUNDS);
  if (!m) return null;
  const rounds = num(m[1]);
  const wv = num(m[2]);
  const unit = m[3].toLowerCase();
  let work_distance_m = null;
  let work_sec = null;
  if (wv != null) {
    if (unit === 'km') work_distance_m = Math.round(wv * 1000);
    else if (unit === 'mi' || unit === 'mile' || unit === 'miles') work_distance_m = Math.round(wv * 1609.34);
    else if (unit === 'm' || unit === 'meters') work_distance_m = Math.round(wv);
    else if (/^min/.test(unit)) work_sec = Math.round(wv * 60);
    else if (/^sec/.test(unit)) work_sec = Math.round(wv);
  }
  // Need a real work quantity to be an interval.
  if (work_distance_m == null && work_sec == null) return null;
  const restM = t.match(INTERVAL_REST);
  let rest_sec = null;
  if (restM) {
    const rv = num(restM[1]);
    rest_sec = /^min/i.test(restM[2]) ? Math.round(rv * 60) : Math.round(rv);
  }
  const { rpe, avg_hr } = extractCommon(t);
  return {
    modality: 'cardio_interval',
    exercise: leadName(t) || null,
    rounds,
    work_distance_m,
    work_sec,
    rest_sec,
    rpe,
    avg_hr,
  };
}

// circuits / conditioning: AMRAP / EMOM / circuit / WOD / metcon. Carries an
// optional time cap (mm min), a reported round count, and a colon-delimited list
// of movements. No slash sets (that is the resistance workflow).
const CIRCUIT_KIND = /\b(amrap|emom|circuit|wod|metcon)\b/i;

function recognizeCircuit(t) {
  const kindM = t.match(CIRCUIT_KIND);
  if (!kindM) return null;
  if (SLASH_SET.test(t)) return null; // weighted workflow, not ours
  const kind = kindM[1].toLowerCase();
  const colonIdx = t.indexOf(':');
  const roundsM = t.match(/(\d+)\s*rounds?\b/i);
  // The generic word "circuit" also appears inside steady-cardio names
  // ("Bike circuit 20 min"). When the ONLY circuit signal is a bare "circuit"
  // with no circuit STRUCTURE (no colon-delimited movement list, no explicit
  // rounds count) AND the input reads as steady cardio (a machine/locomotion
  // name), it is a steady ride — return null so recognizeCardio claims it and the
  // persistence layer doesn't file a ride as a circuit. AMRAP/EMOM/WOD/metcon
  // (unambiguous conditioning formats) and any structured circuit are unaffected.
  if (kind === 'circuit' && colonIdx < 0 && !roundsM && CARDIO_NAME.test(t)) return null;
  // Anchor the time cap to the keyword header (before the colon, where
  // "AMRAP 12 min:" puts it) so a movement's own duration ("plank 2 min")
  // is never misread as the cap.
  const capHead = colonIdx >= 0 ? t.slice(0, colonIdx) : t;
  const capM = capHead.match(/(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|mins)\b/i);
  const { rpe, avg_hr } = extractCommon(t);
  let movements = null;
  if (colonIdx >= 0) {
    // Drop trailing " - 6 rounds RPE 8"-style metadata after a dash.
    const body = t.slice(colonIdx + 1).split(/\s[-–—]\s/)[0];
    const parts = body.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) movements = parts;
  }
  return {
    modality: 'circuit',
    kind, // 'amrap' | 'emom' | 'circuit' | 'wod' | 'metcon'
    cap_min: capM ? num(capM[1]) : null,
    rounds: roundsM ? num(roundsM[1]) : null,
    movements,
    rpe,
    avg_hr,
  };
}

/**
 * Recognize a non-slash modality input. Returns a structured record or null
 * (null = let the existing slash-notation / resistance parser handle it).
 * Order matters:
 *   1. circuits (AMRAP/EMOM/…) — most specific keyword; a circuit may list a
 *      hold movement ("plank 30 sec"), so it must win over the timed-hold check.
 *   2. timed holds — hold-name + duration.
 *   3. intervals — must run before steady cardio, since an interval's distance
 *      token would otherwise be read as steady cardio.
 *   4. steady cardio — the fallback.
 * @param {string} text
 * @returns {object|null}
 */
function recognizeModalityInput(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  // F-1 (#1767): a signed, ranged, or zero quantity never becomes a row.
  if (hasSignedOrRangedQuantity(t)) return null;
  const rec = recognizeCircuit(t)
    || recognizeTimedHold(t)
    || recognizeIntervals(t)
    || recognizeCardio(t)
    || null;
  if (rec && hasNonpositiveWork(rec)) return null;
  return rec;
}

module.exports = { recognizeModalityInput, MODALITIES };
