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
//      ("30 to 45 sec", "between 30 and 45 sec"), a tilde/dot range
//      ("30~45 sec", "30..45 sec"), a spelled-out sign ("minus 45 seconds",
//      "negative 45 sec"), or a signed sets multiplier ("x -3", "3x -3").
//      A spaced dash IS a separator — and still parses — only when it sits
//      between two stated quantities: the text before it ends with a unit
//      word or a number ("Run 5 km - 30 min", "situps 20 - 6 rounds",
//      "Plank 60 sec - 3x" — the last reads as duration, then sets), or the
//      dash is inside a circuit movement list and the rounds count follows
//      it ("AMRAP 12 min: … - 6 rounds"). Any other spaced sign (start of
//      input, after a name, after a preposition or `x`, after a rating
//      keyword) is a sign and refuses. A spaced dash between two quantities
//      of the SAME dimension is a range, not a separator ("60 sec - 45 sec",
//      "5 km - 10 km") — hasSameDimensionPair refuses those.
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
// minus, U+00AD soft hyphen, U+2043 hyphen bullet. Any one of them in front
// of a quantity is a sign. A new dash added to Unicode is covered by \p{Pd}
// automatically; the explicit list is only the non-Pd stragglers. All
// patterns using it carry the `u` flag. (Pre-review B6: the previous
// 13-char denylist leaked U+207B/U+208B/U+2796/U+2043/U+2E3A/U+2E3B/U+058A/
// U+05BE/U+1806/U+2E17/U+2E40.)
const SIGN_CHARS = '[\\p{Pd}\\u2212\\u207B\\u208B\\u2796\\u02D7\\u00AD\\u2043]';
// A signed number may lead with the decimal point ("-.5 sec" reads as 5 in
// the extractors — the sign is dropped AND the point is skipped — so the
// guard must match it; the unsigned ".5 sec" magnitude quirk is pre-existing
// and out of scope). Plain numbers have no leading dot.
const SIGNED_NUMBER = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const PLAIN_NUMBER = '(?:\\d+(?:\\.\\d+)?)';
const UNIT = '(?:km|miles?|mi|meters?|m|min(?:ute)?s?|mins|sec(?:ond)?s?|secs)';
// What may follow a quantity's digits: a unit, the "x" multiplier, a rounds
// count, or the ":" of an mm:ss elapsed time. The unit list is what makes a
// bare "2026-11-16" date (no unit follows either number) and a "Nov 3-5"
// (no unit) NOT a range, and a "-5C" / "-5 degrees" (no modality unit)
// NOT a signed quantity.
// The range check deliberately omits "rounds": a movement list ends in a
// spaced-dash separator before the rounds count ("situps 20 - 6 rounds"),
// which is digits–dash–digits feeding "rounds" and must keep parsing. An
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
// "30 and 45 sec". The digits must sit directly around the word —
// "Run 5 km to 30 min" does not match (a unit sits between the first number
// and "to"), and "Plank 60 sec to failure" does not match (no digits after
// "to"). "between X and Y" is its own pattern below (the word comes first).
const RANGE_WORDS = '(?:to|or|through|thru|and)';
const RANGED_WORD_QUANTITY = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s+${RANGE_WORDS}\\s+(${PLAIN_NUMBER})(?=${RANGE_FOLLOW})`, 'u');
const BETWEEN_RANGE = new RegExp(`\\bbetween\\s+(${PLAIN_NUMBER})\\s*(?:${UNIT})?\\s+and\\s+(${PLAIN_NUMBER})\\s*(?:${UNIT})\\b`, 'iu');
// Tilde / dot ranges: "30~45 sec", "30..45 sec" (and "..."). A lone "~45"
// (approximate, no digits before it) does not match — that stays the
// pre-existing approx-nominal residual.
const TILDE_RANGE = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s*~\\s*(${PLAIN_NUMBER})(?=${RANGE_FOLLOW})`, 'u');
const DOT_RANGE = new RegExp(`(?<![\\d:])(${PLAIN_NUMBER})\\s*\\.\\.+\\s*(${PLAIN_NUMBER})(?=${RANGE_FOLLOW})`, 'u');
// A signed sets multiplier: "x -3" / "x-3" (the "x" sits before the sign,
// so the quantity-follow lookahead cannot see it — the digits end the
// input). The "x" may follow a digit ("3x -3") or a word boundary — but a
// word merely ending in "x" ("Box", "Relax") must not match.
const SETS_SIGN = new RegExp(`(?:\\b|(?<=\\d))x\\s*${SIGN_CHARS}\\s*${SIGNED_NUMBER}`, 'iu');
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
  for (const re of [PAIR_DASH, PAIR_WORD]) {
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

function hasSignedOrRangedQuantity(t) {
  return SIGNED_QUANTITY.test(t)
    || hasNonSeparatorSpacedSign(t)
    || hasSameDimensionPair(t)
    || RANGED_QUANTITY.test(t)
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
    || SPELLED_RATING.test(t);
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
  const hr = t.match(/\bavg(?:erage)?\s*hr\s*(\d+)/i) || t.match(/\bhr\s*(\d+)/i);
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
