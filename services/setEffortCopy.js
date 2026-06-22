'use strict';

// Deterministic coach copy for the set-effort signals (Training Intelligence
// PR 477 wiring). PURE: maps the engine output of services/setEffortSignals.js
// (`analyzeSetSequence` / `assessNextMoveConflict`) to short, user-facing strings.
//
// This is the engine-backed FLOOR — it never calls the LLM and never invents a
// number or verdict. It only words decisions the engine already made. The richer
// LLM voice that paraphrases these same facts is a later series slice (PR 484);
// until then this deterministic copy is what the lifter sees.
//
// The wordings trace to the owner-approved canonical lines in
// docs/TRAINING_PROFILE_TAXONOMY.md §7 and docs/COACH_VOICE_VALIDATION.md.

/**
 * One short line reacting to the just-logged exercise's set sequence, or null
 * when there is nothing worth saying (e.g. a clean on-target set, or a
 * warmup/feeder set — which must NEVER be scolded as sandbagging).
 *
 * @param {object|null} analysis - output of analyzeSetSequence.
 * @returns {string|null}
 */
function effortNote(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  const signals = analysis.signals || {};
  const verdict = analysis.progression_verdict;

  if (verdict === 'block') {
    // A heavy-compound redline (RIR 0). A same-load rep drop after it confirms
    // the system is cooked; on a pressing lift that reads as pressing-yellow.
    if (signals.rep_drop_after_redline) {
      return analysis.is_pressing
        ? 'You went to zero and reps dropped after. Pressing is yellow now.'
        : 'You went to zero and reps dropped after. That’s the ceiling today — hold the load.';
    }
    // Compound taken to failure without a rep drop: it counts as work, but a
    // grind is fatigue, not a green light to add weight.
    return 'That counted, but it does not earn more weight.';
  }

  if (verdict === 'caution') {
    // Isolation RIR 0 — caution only, never a heavy-compound progression block.
    return 'Took that isolation to failure — fine on a small lift, but no need to grind it. Leave a rep next time.';
  }

  if (verdict === 'bump') {
    // A working set left well above the target RIR — under-dosed.
    return 'Too much left in the tank. Bump coming.';
  }

  // 'neutral' (incl. a clean on-target set, or a warmup/feeder that was correctly
  // ignored) — say nothing on this axis.
  return null;
}

/**
 * One short routing suggestion when the just-finished pressing work went yellow
 * and the next planned move shares the prime mover. Suggestion-only — it words
 * the engine's reroute, it never reorders or mutates the plan.
 *
 * @param {object|null} conflict - output of assessNextMoveConflict.
 * @returns {string|null}
 */
function rerouteNote(conflict) {
  if (!conflict || !conflict.conflict || !conflict.suggestion) return null;
  const s = conflict.suggestion;
  if (s.type === 'reroute_pull_first' && s.pull_first && s.defer_press) {
    return `Pressing’s lit up — get ${s.pull_first} in first, then come back to ${s.defer_press} lighter or skip it.`;
  }
  if (s.type === 'cap_next_press' && s.press) {
    return `Pressing’s lit up — cap ${s.press} next: go lighter or make it optional.`;
  }
  return null;
}

module.exports = { effortNote, rerouteNote };
