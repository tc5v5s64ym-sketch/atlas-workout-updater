'use strict';

/**
 * Optional Gemini "polish" pass.
 *
 * Takes deterministic, already-correct coaching text (an SME answer or a recommendation
 * explanation) and asks Gemini to reword it more naturally — WITHOUT changing any number.
 * The deterministic text is always the ground truth: polish is best-effort and degrades to the
 * original whenever Gemini is unconfigured, slow, errors, returns nothing, or drifts a number.
 *
 * Two guards keep the numbers locked:
 *   1. numbersPreserved() — the polished text must carry the same numbers, in the same
 *      order, with the same multiplicity, whether written as digits or spelled out
 *      ("ninety" is 90, "twenty-five" is 25). A reordered, respelled, dropped, or
 *      introduced number is a meaning change, not a reword.
 *   2. validateCoachExplanation() — for recommendation explanations, the field-aware check also
 *      confirms weight / sets×reps / RIR still match the locked prescription, in `NxM`
 *      form and in "N sets, M reps" word form.
 */

const coach = require('./coach');
const { validateCoachExplanation } = require('./coachExplanationPolicy');

const DEFAULT_TIMEOUT_MS = 2500;

const WORD_ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const WORD_TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const WORD_SCALES = { hundred: 100, thousand: 1000, million: 1000000 };

// Parse a run of English number words starting at tokens[i] ("twenty-five",
// "one hundred and twenty", "two thousand"). Returns { value, next } or null.
// "and" only joins inside a scaled run ("one hundred and twenty"), never two
// bare counts ("five and six" stays two numbers). Within one number there is at
// most one tens and one ones ("twenty twenty" is two twenties, not forty;
// "one two three" is a count, not six) — a repeated class ends the run.
function parseWordNumber(tokens, i) {
  let current = 0;
  let result = 0;
  let seen = false;
  let afterScale = false;
  let sawTens = false;
  let sawOnes = false;
  let j = i;
  while (j < tokens.length) {
    const w = tokens[j];
    if (w === 'and' && afterScale) { j++; afterScale = false; continue; }
    if (Object.prototype.hasOwnProperty.call(WORD_ONES, w)) {
      if (sawOnes) break;
      current += WORD_ONES[w]; seen = true; afterScale = false; sawOnes = true; j++; continue;
    }
    if (Object.prototype.hasOwnProperty.call(WORD_TENS, w)) {
      if (sawTens) break;
      current += WORD_TENS[w]; seen = true; afterScale = false; sawTens = true; j++; continue;
    }
    if (w === 'hundred') {
      current = (current || 1) * 100; seen = true; afterScale = true;
      sawTens = false; sawOnes = false; j++; continue;
    }
    if (w === 'thousand' || w === 'million') {
      result += (current || 1) * WORD_SCALES[w]; current = 0;
      seen = true; afterScale = true; sawTens = false; sawOnes = false; j++; continue;
    }
    break;
  }
  if (!seen) return null;
  return { value: result + current, next: j };
}

// Canonical form for one number token: "01", "1", and "1.0" are the same number.
// Comparing by value (not by digit string) is what "preserve numeric meaning" means.
function canonicalNumber(token) {
  const n = Number(token);
  return Number.isFinite(n) ? String(n) : token;
}

// The ordered sequence of numbers in the text, digits and spelled-out words alike,
// in the order they appear. "1–6" is [1, 6]; "ninety sets" is [90].
function extractNumberSequence(text) {
  const tokens = String(text == null ? '' : text).toLowerCase()
    .match(/[a-z]+|\d+(?:\.\d+)?/g) || [];
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^\d/.test(tok)) { out.push(canonicalNumber(tok)); i++; continue; }
    const parsed = parseWordNumber(tokens, i);
    if (parsed) { out.push(String(parsed.value)); i = parsed.next; continue; }
    i++;
  }
  return out;
}

// Every number in `polished` must match `original` — same values, same order, same
// counts. A set-membership check is not enough: "strength 1-6, hypertrophy 8-15"
// reworded as "strength 8-15, hypertrophy 1-6" reuses only old digits yet reverses
// the meaning, and "ninety sets" smuggles a number in with no digit at all.
// Reordering, dropping, introducing, or respelling a number rejects the polish;
// the deterministic original is returned instead. Fail closed.
function numbersPreserved(original, polished) {
  const a = extractNumberSequence(original);
  const b = extractNumberSequence(polished);
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

function buildPolishSystemPrompt() {
  return [
    'You are Atlas, a strength coach. Reword the given coaching text so it reads naturally and conversationally.',
    'HARD RULES:',
    '- Never change, add, or remove any number — weights, reps, rep ranges, RIR, sets, rest, and percentages must stay exactly as written.',
    '- Do not introduce any number that is not already in the text.',
    '- Keep it brief and direct. Plain text only — no markdown, no lists, no preamble.',
    '- If you cannot improve it, return it unchanged.'
  ].join('\n');
}

// Core: reword `original`, return it unchanged on any failure or number drift.
async function polishText(original, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const text = String(original == null ? '' : original).trim();
  if (!text || !coach.isConfigured()) return text;

  let polished;
  try {
    polished = await coach.callGemini(buildPolishSystemPrompt(), text, timeoutMs);
  } catch (_e) {
    return text; // Gemini down / timeout / error → deterministic original
  }
  polished = String(polished == null ? '' : polished).trim();
  if (!polished) return text;
  if (!numbersPreserved(text, polished)) return text; // a number drifted → reject

  return polished;
}

// Recommendation explanation: also run the field-aware validator against the locked prescription.
async function polishCoachExplanation(original, lockedNumbers = {}, opts = {}) {
  const text = String(original == null ? '' : original).trim();
  if (!text) return text;
  const polished = await polishText(text, opts);
  if (polished === text) return text;
  return validateCoachExplanation(polished, lockedNumbers).valid ? polished : text;
}

// SME prose has no locked-number structure — the numbersPreserved guard is the lock.
async function polishSmeAnswer(original, opts = {}) {
  return polishText(original, opts);
}

module.exports = { polishText, polishCoachExplanation, polishSmeAnswer, numbersPreserved, extractNumberSequence };
