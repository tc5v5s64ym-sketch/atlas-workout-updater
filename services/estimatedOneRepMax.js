'use strict';

/**
 * Estimated 1RM (one-rep max) from a reps-to-failure set — #1777.
 *
 * Deterministic Epley calculator: e1RM = weight x (1 + reps/30), rounded to the
 * nearest whole unit. The engine computes; the model only words the value. Pure,
 * no I/O, no Sheets, no LLM.
 *
 * #1339: the Epley math lives in the single engine method
 * (intensityModule.estimateE1RM, RIR 0 for a to-failure set); this module keeps
 * only the question parsing, the whole-unit rounding, and the answer wording.
 *
 * Rules (issue #1777):
 *   - Inputs: weight + reps, unit as stated (lb or kg; no silent conversion, and
 *     no unit invented when none was stated).
 *   - The exercise name is used for wording only — the math is exercise-independent.
 *   - Reps = 1: the answer is the weight itself.
 *   - Reps > 12: compute, but flag it as a rougher estimate.
 *   - Missing weight or reps: NO number — the coach asks for the set (fail closed).
 *   - The value is always presented as an ESTIMATE, never as a measured max.
 *   - Nothing is stored as a record, PR, or training max (non-goal; #1778 owns the
 *     history-based estimate from logged rows).
 */

const { estimateE1RM } = require('./intensityModule');

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

const WORD_NUMBER_RE = Object.keys(WORD_NUMBERS).join('|');

// Canonical lift names, for wording only (longest match wins).
const KNOWN_LIFTS = [
  'bench press', 'incline bench', 'dumbbell bench', 'front squat', 'squat',
  'romanian deadlift', 'deadlift', 'overhead press', 'shoulder press',
  'leg press', 'barbell row', 'seated row', 'pull-up', 'pullup', 'chin-up',
  'chinup', 'dip', 'bicep curl', 'lunge', 'hip thrust',
];

function normalize(text) {
  return String(text == null ? '' : text).toLowerCase();
}

function titleCaseLift(name) {
  return name.split(/[\s-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// A number token (digits, or a number-word) with its position, for weight/reps resolution.
// Digits are bounded by digits only (not by word boundaries): "225x6" must tokenize
// as 225 + 6 even though "x" is a word character and no \b sits between them.
// Number-words keep \b so "one" never matches inside "someone". `word` marks a
// word-number token (used to spot compound numbers, which this parser cannot
// resolve — see parseOneRepMaxSet).
function numberTokens(text) {
  const tokens = [];
  const digitRe = /(?<![0-9])(\d+(?:\.\d+)?)(?![0-9])/g;
  let m;
  while ((m = digitRe.exec(text)) !== null) {
    tokens.push({ value: parseFloat(m[1]), index: m.index, end: m.index + m[0].length, word: false });
  }
  const wordRe = new RegExp(`\\b(${WORD_NUMBER_RE})\\b`, 'g');
  while ((m = wordRe.exec(text)) !== null) {
    tokens.push({ value: WORD_NUMBERS[m[1]], index: m.index, end: m.index + m[0].length, word: true });
  }
  tokens.sort((a, b) => a.index - b.index);
  return tokens;
}

// Number-words this parser does NOT cover: tens above twenty, "hundred",
// "thousand". A set written with one of them ("two hundred twenty-five
// pounds", "thirty-five times") cannot be resolved to a single token, and a
// partial resolution would serve a WRONG number — so the parse fails closed.
const COMPOUND_NUMBER_WORD = /\b(thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/;

function unitAfter(text, end) {
  const rest = text.slice(end, end + 12);
  const m = rest.match(/^\s*(lb|lbs|pounds?|kg|kgs|kilos?|kilograms?)\b/);
  if (!m) return null;
  return /^(kg|kgs|kilos?|kilograms?)$/.test(m[1]) ? 'kg' : 'lb';
}

function findExercise(text) {
  for (const lift of KNOWN_LIFTS) {
    if (text.includes(lift)) return titleCaseLift(lift);
  }
  return null;
}

/**
 * Parse a reps-to-failure set from a question.
 * @returns {{weight:number, reps:number, unit:('lb'|'kg'|null), exercise:(string|null)}|null}
 */
function parseOneRepMaxSet(text) {
  // Strip the 1RM phrase itself before tokenizing: "one rep" in "one rep max"
  // is not a set (it would otherwise parse as weight 1, reps 1). The set lives
  // in the rest of the message.
  const t = normalize(text).replace(/one[\s-]?rep(?:etition)?s?\s+max(?:imum)?|one[\s-]?rm|\b1\s?rm\b/g, ' ');
  if (!t) return null;
  // Compound numbers ("two hundred twenty-five", "twenty-five", "thirty-five")
  // are not resolvable from single tokens — "five" in "twenty-five pounds"
  // would be taken as the weight. Fail closed instead of serving a wrong number.
  if (COMPOUND_NUMBER_WORD.test(t)) return null;
  const tokens = numberTokens(t);
  if (tokens.length === 0) return null;
  // Two word-numbers side by side ("twenty five", "two hundred" with the
  // hundred stripped above) are one compound number, not two tokens.
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a.word && b.word && /^[\s-]+$/.test(t.slice(a.end, b.index))) return null;
  }

  // Weight: the token with a unit attached first, else the first token >= 10,
  // else the first token. (A bare small number first is usually the reps.)
  let weightToken = null;
  for (const tok of tokens) {
    if (unitAfter(t, tok.end)) { weightToken = tok; break; }
  }
  if (!weightToken) weightToken = tokens.find((tok) => tok.value >= 10) || tokens[0];
  const unit = unitAfter(t, weightToken.end);
  const weight = weightToken.value;
  if (!(weight >= 1 && weight <= 2000)) return null;

  // Reps: the first reps-pattern match whose token is not the weight token.
  const repsPatterns = [
    // "225x6" / "405 lb x 5"
    new RegExp(`\\b${weightToken.value}\\s*(?:lb|lbs|pounds?|kg|kgs|kilos?|kilograms?)?\\s*x\\s*(\\d{1,2})\\b`),
    /\bfor\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/,
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+times\b/,
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+reps?\b/,
    /\bgot\s+(\d{1,2})\b/,
    /\bhit\s+(\d{1,2})\b/,
    /\bdid\s+(\d{1,2})\b/,
  ];
  let reps = null;
  for (const re of repsPatterns) {
    const m = t.match(re);
    if (!m) continue;
    const raw = m[1];
    const value = /^\d/.test(raw) ? parseInt(raw, 10) : WORD_NUMBERS[raw];
    // Skip a match that IS the weight token itself ("did 225" states the weight,
    // not the reps). Compare positions, not values: "10 lb for 10" is a real set
    // whose reps happen to equal the weight.
    const numStart = m.index + m[0].lastIndexOf(raw);
    if (numStart === weightToken.index) continue;
    reps = value;
    break;
  }
  // "once" / "twice" (a single rep, or a double).
  if (reps === null) {
    if (/\bonce\b/.test(t)) reps = 1;
    else if (/\btwice\b/.test(t)) reps = 2;
  }
  if (reps === null || !(reps >= 1 && reps <= 30)) return null;

  return { weight, reps, unit, exercise: findExercise(t) };
}

// Phrasings that ask about a one-rep max (not bare "max" — "max effort" is not a 1RM question).
const ONE_RM_PATTERNS = [
  /one[\s-]?rep(?:etition)?s?\s+max(?:imum)?/,
  /one[\s-]?rm\b/,
  /\b1\s?rm\b/,
  /\bestimat(?:ed|e)\s+(?:one[\s-]?rep(?:etition)?\s+)?max(?:imum)?\b/,
  /\bhow much could i max\b/,
  /\bas a single\b/,
  /\bmax single\b/,
  /\bfor (?:a |one )?single\b/,
];

// A question cue: a trailing "?", a question word, an imperative request for the
// estimate, or an explicit request phrase ("I need to know my one rep max").
// The lane CLAIMS questions, not statements — "my 1RM attempt: bench 225x6" is a
// log line, and claiming it would swallow the set instead of logging it ("never
// silently lose part of a workout"). A turn can still BE a 1RM turn without the
// cue (analyzeOneRepMaxTurn reports claimable: false) — the backstop still guards
// the number if the model speaks on that turn.
const QUESTION_CUE = /\?\s*$|\b(what|how|could|would|can|should|is|are|did|do|does|when|which|who|estimate|calculate|tell me|show me|work out|figure out|need to know|want to know)\b/;

function isOneRepMaxQuestion(text, context = {}) {
  const t = normalize(text);
  if (!t) return false;
  if (ONE_RM_PATTERNS.some((re) => re.test(t))) return true;
  // "What's my max (on bench)?" — "my max" plus either a parsed set or a lift
  // word. Without one of those it is not a 1RM question: "what is my max heart
  // rate?" / "what is my max effort today?" / "is my max higher than last
  // month?" are not.
  if (/\bmy\s+max\b/.test(t) && (context.hasSet || context.hasLift)) return true;
  return false;
}

// Past-tense / history-flavoured phrasing — a question about a PAST max belongs to
// the history lane (#1778 owns the history-based estimate), never to this lane's
// ask-for-the-set. Only consulted when no set was parsed.
function isHistoryFlavored(text) {
  const t = normalize(text);
  return /\b(last time|last session|yesterday|last week|previous|last workout|was my|did i|have i)\b/.test(t);
}

/**
 * Epley estimate. Reps = 1 returns the weight itself. Reps > 12 is flagged rough.
 * #1339: the math is the single engine method (intensityModule.estimateE1RM)
 * with RIR 0 — a reps-to-failure set. The value is identical to the old local
 * Epley copy; only the duplicate implementation is retired.
 * @returns {{value:number, rough:boolean}}
 */
function estimateOneRepMax({ weight, reps }) {
  const w = Number(weight);
  const r = Number(reps);
  if (!(w > 0) || !(r >= 1)) throw new Error('estimateOneRepMax needs a positive weight and reps >= 1');
  if (r === 1) return { value: Math.round(w), rough: false };
  return { value: Math.round(estimateE1RM(w, r, 0)), rough: r > 12 };
}

function formatUnit(unit) {
  return unit === 'kg' ? ' kg' : unit === 'lb' ? ' lb' : '';
}

function buildOneRepMaxAnswer({ weight, reps, unit, exercise }) {
  const { value, rough } = estimateOneRepMax({ weight, reps });
  const unitSuffix = formatUnit(unit);
  const forExercise = exercise ? ` for ${exercise}` : '';
  const formula = unit
    ? `${weight}${unitSuffix} × (1 + ${reps}/30)`
    : `${weight} × (1 + ${reps}/30)`;
  let answer;
  if (reps === 1) {
    answer = `Your estimated 1RM${forExercise} is ${value}${unitSuffix} — that's the weight itself, since a single rep at ${weight}${unitSuffix} is your max by definition.`;
  } else {
    answer = `Your estimated 1RM${forExercise} is ${value}${unitSuffix} (Epley estimate: ${formula}).`;
  }
  if (rough) {
    answer += ' This is a rougher estimate — the Epley formula is less accurate above 12 reps.';
  }
  if (!unit) {
    answer += ' Same unit as the set you gave.';
  }
  return { value, rough, answer };
}

function buildOneRepMaxAskForSet() {
  return 'To estimate your 1RM I need the set: what weight did you lift, and for how many reps to failure?';
}

/**
 * Analyze a message for the 1RM lane. Returns null when the message is not a 1RM
 * turn; otherwise the parsed set (or null when no set was given) plus the answer
 * to serve (computed, or the ask-for-the-set when the turn is not
 * history-flavoured). `claimable` is true when the turn is a QUESTION (or an
 * explicit request) — only then do the lanes serve the answer; a statement
 * ("my 1RM attempt: bench 225x6") is a log line and must fall through to the
 * logging lanes. The backstop does NOT require claimable: if the model speaks on
 * a 1RM turn (reassure bypass), the computed answer is still the guard.
 */
function analyzeOneRepMaxTurn(text) {
  const set = parseOneRepMaxSet(text);
  const t = normalize(text);
  // The "my max" branch needs a set or a lift word to claim the turn; parse first
  // so the question check can see them.
  if (!isOneRepMaxQuestion(text, { hasSet: !!set, hasLift: !!findExercise(t) })) return null;
  const claimable = QUESTION_CUE.test(t);
  if (set) {
    const built = buildOneRepMaxAnswer(set);
    return { isQuestion: true, claimable, set, value: built.value, rough: built.rough, answer: built.answer };
  }
  if (isHistoryFlavored(text)) return { isQuestion: true, claimable, set: null, value: null, answer: null };
  return { isQuestion: true, claimable, set: null, value: null, answer: buildOneRepMaxAskForSet() };
}

module.exports = {
  WORD_NUMBERS,
  parseOneRepMaxSet,
  isOneRepMaxQuestion,
  isHistoryFlavored,
  estimateOneRepMax,
  buildOneRepMaxAnswer,
  buildOneRepMaxAskForSet,
  analyzeOneRepMaxTurn,
};
