'use strict';

// ── F05 full-consumption / ambiguous-@ gate (PARSE-4, PARSE-5) ────────────────
//
// Wired at the parse-route ORCHESTRATION boundary, right after the unresolved-lift
// gate and before the client assembles preview rows. It closes two silent-
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
// Both paths only ever REDUCE what reaches the preview (parsed → needs_clarification
// with zero rows). Pure, read-only, and it never throws — a garbage input returns
// the parsed object unchanged. It needs the ORIGINAL text because `parsed` has
// already discarded the unconsumed tokens.
//
// applyFullConsumptionGate(parsed, rawText) → parsed' (possibly downgraded)

// The barbell sets-first form `NxM@W`. A leading digit must sit immediately before
// `x` (word boundary), so the dumbbell form `55s x8 @2` — where `s ` precedes `x`
// — is NOT matched, and its `@` correctly stays an RIR.
const BARBELL_SETS_FIRST_AT = /\b\d+\s*x\s*\d+\s*@\s*(\d+(?:\.\d+)?)\b/;

// The three set-notation families whose co-occurrence signals dropped groups.
const FAMILY_SLASH = /\d+\s*\/\s*\d+/;       // reps/RIR, incl. dumbbell `10/3`
const FAMILY_X_AT = /x\s*\d+\s*@/;           // `3x8@165`, `55s x8 @2`
const FAMILY_FOR = /\b\d+\s+for\s+\d+\b/;    // `175 for 5`

// The ambiguous @ band: a value this small in the barbell form is a lifter's RIR,
// never a real barbell weight.
const AMBIGUOUS_AT_MAX = 10;

function ask(message, code, parsed, rawText) {
  return {
    intent: 'needs_clarification',
    raw_text: (parsed && parsed.raw_text) || String(rawText || ''),
    message,
    warnings: [...new Set([...(Array.isArray(parsed && parsed.warnings) ? parsed.warnings : []), code])],
  };
}

function applyFullConsumptionGate(parsed, rawText) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  // Only a successfully-parsed single set line can have silently dropped a group
  // or emitted a tiny @-weight. Any other intent (needs_clarification, multi,
  // small talk) is left exactly as it is.
  if (parsed.intent !== 'log_sets') return parsed;

  const text = String(rawText || '').toLowerCase();
  if (!text) return parsed;

  // PARSE-5 — ambiguous small `@N` in the barbell sets-first grammar, confirmed by
  // the parser having actually emitted that value as the weight.
  const atMatch = text.match(BARBELL_SETS_FIRST_AT);
  if (atMatch) {
    const atValue = Number(atMatch[1]);
    const sets = Array.isArray(parsed.sets) ? parsed.sets : [];
    if (atValue <= AMBIGUOUS_AT_MAX && sets.some(s => Number(s && s.weight) === atValue)) {
      return ask(
        `Just to be safe — "@${atMatch[1]}" reads as a weight here, but a number that small is usually your RIR. Which did you mean? (nothing's logged yet)`,
        'ambiguous_at_value',
        parsed,
        rawText,
      );
    }
  }

  // PARSE-4 — two or more distinct set-notation families in one lift means the
  // first-sub-parser-wins chain kept one and silently dropped the rest.
  let families = 0;
  if (FAMILY_SLASH.test(text)) families += 1;
  if (FAMILY_X_AT.test(text)) families += 1;
  if (FAMILY_FOR.test(text)) families += 1;
  if (families >= 2) {
    return ask(
      "That looks like more than one set format mixed together, and I don't want to drop any of it. Mind re-sending it one way? (nothing's logged yet)",
      'mixed_set_format',
      parsed,
      rawText,
    );
  }

  return parsed;
}

module.exports = { applyFullConsumptionGate };
