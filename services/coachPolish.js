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
 *   1. numbersPreserved() — the polished text may not contain any number the original didn't.
 *   2. validateCoachExplanation() — for recommendation explanations, the field-aware check also
 *      confirms weight / sets×reps / RIR still match the locked prescription.
 */

const coach = require('./coach');
const { validateCoachExplanation } = require('./coachExplanationPolicy');

const DEFAULT_TIMEOUT_MS = 2500;

function extractNumbers(text) {
  return String(text == null ? '' : text).match(/\d+(?:\.\d+)?/g) || [];
}

// Every number in `polished` must already appear in `original` — the model may reword, never
// introduce or change a number (weights, reps, rep ranges, RIR, sets, rest, percentages).
function numbersPreserved(original, polished) {
  const allowed = new Set(extractNumbers(original));
  return extractNumbers(polished).every((n) => allowed.has(n));
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

module.exports = { polishText, polishCoachExplanation, polishSmeAnswer, numbersPreserved };
