'use strict';

/**
 * The bounded vocabulary for WHY a validator suppressed a model response.
 *
 * Atlas already computes a precise reason every time it suppresses model prose, and then
 * throws it away: `routes/coachOps.js` called `coach.findRegisterViolations(...)`, used only
 * `violations.length > 0`, and discarded the `{ code, phrase }` it was handed. The durable
 * record (`Coach_Response.suppression_reason`) therefore stored the single coarse value
 * `validator_suppressed`, so a suppressed turn could not be adjudicated later without
 * storing the private model draft — which Atlas deliberately never stores.
 *
 * This module closes that gap WITHOUT storing anything private. Only a fixed enum code from
 * `SUPPRESSION_CODES` is ever persisted. The matched phrase, the draft, the athlete input,
 * the prompt, the facts payload, and any free-form validator text are never carried here:
 * `classifyRegisterViolations` reads `.code` and nothing else, and `formatSuppressionReason`
 * refuses any value that is not in the enum.
 *
 * Storage shape — no schema change, no new column. The existing `suppression_reason` field
 * carries `validator_suppressed:<code>`, keeping the historical coarse token as a prefix so
 * existing rows and new rows group together under `isValidatorSuppressed`.
 *
 * READ-ONLY and pure: no Sheets, no LLM, no I/O, no clock. It classifies; it never decides
 * whether to suppress. Every suppression decision stays exactly where it was.
 */

/**
 * Every code corresponds to a REACHABLE production suppression point. Codes are not
 * invented for paths that cannot fire; each one below is annotated with its producer.
 */
const SUPPRESSION_CODES = Object.freeze({
  // routes/coachOps.js finalizeSetVoice — the model returned only whitespace, normalized
  // to null so the endpoint never serializes an empty string (PR-11 Bug 4).
  EMPTY_MODEL_REPLY: 'empty_model_reply',
  // routes/coachOps.js finalizeSetVoice — voiceBase.suppress_generic_prose: a non-neutral
  // set-effort signal owns the reaction, so generic prose may not speak over it.
  SET_VOICE_GENERIC_PROSE: 'set_voice_generic_prose',
  // routes/coachOps.js finalizeSetVoice — findForbiddenContradictions: the prose
  // contradicts a deterministic set reason code.
  SET_VOICE_CONTRADICTION: 'set_voice_contradiction',
  // routes/coachOps.js finalizeCoachVoice — subVoiceBase.suppress_generic_prose: a good
  // pivot's deterministic line owns the acknowledgement.
  SUBSTITUTION_GENERIC_PROSE: 'substitution_generic_prose',
  // routes/coachOps.js finalizeCoachVoice — findSubstitutionContradictions: the prose
  // would lecture a swap the engine already accepted.
  SUBSTITUTION_CONTRADICTION: 'substitution_contradiction',
  // services/coach.js findRegisterViolations — profanity without a profanity_ok grant.
  PROFANITY_WITHOUT_PERMISSION: 'profanity_without_permission',
  // services/coach.js findRegisterViolations — celebration / PR vocabulary outside an
  // earned celebrate or praise moment.
  CELEBRATION_VOCAB_OUTSIDE_EARNED_MODE: 'celebration_vocab_outside_earned_mode',
  // routes/coachOps.js chat path — the register guard itself was unavailable, so the reply
  // was dropped rather than trusted. The route represents this as a bare string.
  REGISTER_GUARD_UNAVAILABLE: 'register_guard_unavailable',
  // Fail-closed: a suppression happened but the producer reported nothing recognizable.
  UNKNOWN: 'unknown',
});

const ALLOWED_CODES = Object.freeze(new Set(Object.values(SUPPRESSION_CODES)));

/** The historical coarse value. Preserved verbatim as the prefix of every new value. */
const VALIDATOR_SUPPRESSED = 'validator_suppressed';

/**
 * Deterministic precedence when ONE suppression point reports several violations at once.
 * `findRegisterViolations` can return both a profanity and a celebration violation for the
 * same prose; the stored reason must not depend on array order or on future rule additions.
 *
 * Profanity outranks celebration vocabulary: it is the harder contract (the D1 ceiling,
 * an explicit owner grant) whereas celebration vocabulary is mode-dependent. An
 * unrecognized guard state ranks last, since it is the least specific.
 */
const REGISTER_PRECEDENCE = Object.freeze([
  SUPPRESSION_CODES.PROFANITY_WITHOUT_PERMISSION,
  SUPPRESSION_CODES.CELEBRATION_VOCAB_OUTSIDE_EARNED_MODE,
  SUPPRESSION_CODES.REGISTER_GUARD_UNAVAILABLE,
]);

/** The code carried by one violation entry, or null. Reads `.code` ONLY — never `.phrase`. */
function codeOfViolation(violation) {
  if (typeof violation === 'string') return ALLOWED_CODES.has(violation) ? violation : null;
  if (violation && typeof violation === 'object' && typeof violation.code === 'string') {
    return ALLOWED_CODES.has(violation.code) ? violation.code : null;
  }
  return null;
}

/**
 * Classify a `findRegisterViolations` result into ONE fixed code.
 *
 * Fails closed: an empty, malformed, non-array, or wholly unrecognized result yields
 * `unknown` rather than any text from the input. A recognized code that is not in the
 * precedence list still returns itself, so a future rule is stored precisely instead of
 * being flattened to `unknown`.
 *
 * @param {Array} violations
 * @returns {string} a value from SUPPRESSION_CODES
 */
function classifyRegisterViolations(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return SUPPRESSION_CODES.UNKNOWN;
  const present = new Set();
  for (const v of violations) {
    const code = codeOfViolation(v);
    if (code) present.add(code);
  }
  if (!present.size) return SUPPRESSION_CODES.UNKNOWN;
  for (const code of REGISTER_PRECEDENCE) {
    if (present.has(code)) return code;
  }
  // A recognized code outside the documented precedence — deterministic by enum order.
  for (const code of Object.values(SUPPRESSION_CODES)) {
    if (present.has(code)) return code;
  }
  return SUPPRESSION_CODES.UNKNOWN;
}

/**
 * The value stored in `suppression_reason`: `validator_suppressed:<code>`.
 *
 * Anything not in the enum — undefined, null, a number, an object, free text, a matched
 * phrase, a stack trace — becomes `validator_suppressed:unknown`. That is the privacy
 * boundary: no caller can persist arbitrary text through this function, so the stored
 * value is bounded by construction rather than by the discipline of each call site.
 */
function formatSuppressionReason(code) {
  const safe = typeof code === 'string' && ALLOWED_CODES.has(code) ? code : SUPPRESSION_CODES.UNKNOWN;
  return `${VALIDATOR_SUPPRESSED}:${safe}`;
}

/**
 * Does this `suppression_reason` denote a validator suppression?
 *
 * The one correct way for a consumer to group suppressions. Recognizes BOTH the historical
 * exact value (rows written before this change keep it, and are never rewritten) and every
 * `validator_suppressed:*` value, including codes added later.
 */
function isValidatorSuppressed(reason) {
  if (typeof reason !== 'string') return false;
  const value = reason.trim();
  return value === VALIDATOR_SUPPRESSED || value.startsWith(`${VALIDATOR_SUPPRESSED}:`);
}

/** The fixed code inside a reason, or null when it carries none (a historical row). */
function suppressionCodeOf(reason) {
  if (!isValidatorSuppressed(reason)) return null;
  const value = String(reason).trim();
  if (value === VALIDATOR_SUPPRESSED) return null;
  const code = value.slice(VALIDATOR_SUPPRESSED.length + 1);
  return ALLOWED_CODES.has(code) ? code : SUPPRESSION_CODES.UNKNOWN;
}

module.exports = {
  SUPPRESSION_CODES,
  ALLOWED_CODES,
  VALIDATOR_SUPPRESSED,
  REGISTER_PRECEDENCE,
  classifyRegisterViolations,
  formatSuppressionReason,
  isValidatorSuppressed,
  suppressionCodeOf,
};
