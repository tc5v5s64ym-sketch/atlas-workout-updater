'use strict';

// STATUS (2026-07 architecture audit): DARK — slice 1 (pure engine) only, per the
// BACKLOG epic; wiring is deferred slices 2-4 (coach_unavailable fallback route,
// pre-LLM fast path, voice pass). Not a duplicate of the LIVE set-reaction voice
// in services/coachVoiceRenderer.js — that one stays canonical until these slices ship.

/**
 * Deterministic Coach Voice Renderer (BACKLOG: "Deterministic Coach Voice
 * Renderer — APPROVED"). Slice 1: the PURE engine + tests only — no route, LLM,
 * or write-path wiring (that is a later slice).
 *
 * Atlas falls back to generic robotic templates when the LLM is unavailable,
 * rate-limited, or too expensive. This renders known gym events deterministically
 * from facts — still human, specific, coach-like — with NO model call.
 *
 * PRINCIPLE: the engine owns facts/decisions; the LLM is optional narration. This
 * renderer NEVER invents a number — it only ever interpolates values present in
 * its input, or uses fixed stock phrases. Output is conclusion-first
 * (evidence → verdict → next action) and short enough for live gym use (≤3
 * sentences). Pure and stateless: same input → same output.
 *
 * Input shape (all fields optional/nullable):
 *   { exercise, target:{weight,reps,rir,sets}, actual:{weight,reps,rir},
 *     previousHistory, trainingGap,
 *     progressionStatus:{verdict, next_weight, reason},  // OBJECT (pinned for wiring):
 *       //   .next_weight → progress_next_time's exact next load; .reason → hold_weight's why.
 *     sessionContext:{next_exercise, sets_written, error},
 *     mutationContext:{prescribed, logged, canonical}, readinessContext }
 *
 * Output: { message: string, evidenceCited: boolean }
 *   evidenceCited === true when the message cites a concrete number from the input
 *   (vs. a stock-phrase-only line).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

// Deterministic variant index — a stable djb2 hash of the seed, NOT random
// (random would break the pure/stateless contract). Same seed → same variant.
function hashIndex(seed, n) {
  if (!n || n < 1) return 0;
  const s = String(seed || '');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h % n;
}

function pick(variants, seed) {
  return variants[hashIndex(seed, variants.length)];
}

// Format a set as Atlas shorthand using ONLY the values present: "225×8 at RIR 2",
// "225×8", "8 reps", "225 lb". Returns null when nothing concrete is present.
function fmtSet(set) {
  if (!set || typeof set !== 'object') return null;
  const w = num(set.weight), r = num(set.reps), rir = num(set.rir);
  let core = null;
  if (w !== null && r !== null) core = `${w}×${r}`;
  else if (r !== null) core = `${r} reps`;
  else if (w !== null) core = `${w} lb`;
  if (core === null) return rir !== null ? `RIR ${rir}` : null;
  return rir !== null ? `${core} at RIR ${rir}` : core;
}

// ---------------------------------------------------------------------------
// Per-event renderers. Each returns { message, evidenceCited }.
// Each event has ≥2 phrasing variants chosen deterministically by `pick`.
// ---------------------------------------------------------------------------

const RENDERERS = {
  // A set was recorded cleanly.
  set_logged(input) {
    const ex = str(input.exercise);
    const set = fmtSet(input.actual);
    const seed = `${ex}|${set}`;
    if (set) {
      const v = [
        `Logged ${ex || 'that'} — ${set}.`,
        `${set} on ${ex || 'that one'} — in the books.`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = [
      `Logged${ex ? ` ${ex}` : ''}.`,
      `Got it${ex ? ` — ${ex} recorded` : ''}.`,
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Actual result matched the prescribed target.
  target_hit(input) {
    const set = fmtSet(input.actual);
    const w = num((input.actual && input.actual.weight) ?? (input.target && input.target.weight));
    const seed = `${str(input.exercise)}|${set}`;
    if (set) {
      const next = w !== null ? ` Hold ${w} for the next set and keep the reps clean.` : ' Hold here and keep the reps clean.';
      const v = [
        `Good set. You hit ${set}, right where we want it.${next}`,
        `${set} — dialled in, that's the target.${next}`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = [
      'Right on target — hold here and keep the reps clean.',
      'That landed on target. Hold and repeat.',
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Fell short of the rep target.
  reps_missed(input) {
    const r = num(input.actual && input.actual.reps);
    const tr = num(input.target && input.target.reps);
    const w = num((input.actual && input.actual.weight) ?? (input.target && input.target.weight));
    const seed = `${str(input.exercise)}|${r}|${tr}`;
    if (r !== null && tr !== null) {
      const hold = w !== null ? ` Keep ${w} and chase the reps next set.` : ' Keep the load and chase the reps next set.';
      const v = [
        `${r} reps against the ${tr} target — short this time.${hold}`,
        `Came up short: ${r} of ${tr}.${hold}`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = [
      'Short of the rep target — keep the load and chase the reps next set.',
      'Reps came up short. Hold the weight and try to close the gap.',
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // RIR below the prescribed floor — grinding.
  rir_too_low(input) {
    const rir = num(input.actual && input.actual.rir);
    const floor = num(input.target && input.target.rir);
    const seed = `${str(input.exercise)}|${rir}|${floor}`;
    if (rir !== null && floor !== null) {
      const v = [
        `RIR ${rir}, under the ${floor} floor — you ground that one out. Bank the recovery and leave a rep next set.`,
        `That came in at RIR ${rir} vs a ${floor} floor — too close to failure. Ease off and keep a rep in reserve.`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = [
      'Below the RIR floor — you were grinding. Leave a rep in reserve next set.',
      'That dipped under the RIR floor. Back off a touch and keep a rep in the tank.',
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // RIR above the prescribed ceiling — undershooting.
  rir_too_high(input) {
    const rir = num(input.actual && input.actual.rir);
    const ceiling = num(input.target && input.target.rir);
    const seed = `${str(input.exercise)}|${rir}|${ceiling}`;
    if (rir !== null && ceiling !== null) {
      const v = [
        `RIR ${rir}, above the ${ceiling} target — left too much in the tank. Add a little next set.`,
        `That read RIR ${rir} vs a ${ceiling} target — under-dosed. Nudge the load up next set.`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = [
      'Above the RIR target — left some in the tank. Add a little next set.',
      'Undershot the target RIR — room to add. Nudge it up next set.',
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Engine verdict is hold; explain why.
  hold_weight(input) {
    const w = num((input.target && input.target.weight) ?? (input.actual && input.actual.weight));
    const reason = str(input.progressionStatus && input.progressionStatus.reason);
    const seed = `${str(input.exercise)}|${w}|${reason}`;
    const why = reason ? ` ${reason}.` : '';
    if (w !== null) {
      const v = [
        `Hold at ${w} for now.${why}`,
        `Stay at ${w} — no change yet.${why}`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = [
      `Hold the weight here for now.${why}`,
      `Keep the load where it is.${why}`,
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Engine verdict is progress; give the exact next load (from input only).
  progress_next_time(input) {
    const next = num(input.progressionStatus && input.progressionStatus.next_weight);
    const cur = num((input.actual && input.actual.weight) ?? (input.target && input.target.weight));
    const seed = `${str(input.exercise)}|${cur}|${next}`;
    if (next !== null) {
      const from = cur !== null ? ` up from ${cur}` : '';
      const v = [
        `You've earned it — move to ${next} next time${from}.`,
        `Next session, take it to ${next}${from}. That set said you're ready.`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = [
      "You've earned a bump — add load next time.",
      'Ready to progress — take it up a notch next session.',
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Hand off to the next planned exercise.
  next_up_handoff(input) {
    const done = str(input.exercise);
    const next = str(input.sessionContext && input.sessionContext.next_exercise);
    const seed = `${done}|${next}`;
    if (next) {
      const v = [
        `${done ? `${done} done. ` : ''}Next up: ${next}.`,
        `${done ? `That wraps ${done}. ` : ''}On to ${next}.`,
      ];
      return { message: pick(v, seed), evidenceCited: false };
    }
    const v = [
      `${done ? `${done} done. ` : ''}That's the plan — log anything else or finish up.`,
      `${done ? `${done} in the books. ` : ''}Nothing queued — keep going or wrap it.`,
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // A swap was classified and accepted.
  substitution_accepted(input) {
    const logged = str(input.mutationContext && input.mutationContext.logged);
    const prescribed = str(input.mutationContext && input.mutationContext.prescribed);
    const seed = `${prescribed}|${logged}`;
    if (logged && prescribed) {
      const v = [
        `Swapped ${prescribed} for ${logged} — that covers it.`,
        `${logged} in for ${prescribed}. Counts toward today.`,
      ];
      return { message: pick(v, seed), evidenceCited: false };
    }
    const v = ['Swap logged — that counts toward today.', 'Got the substitution — it counts.'];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Exercise removed from the active session.
  skipped_exercise(input) {
    const ex = str(input.exercise);
    const seed = `skip|${ex}`;
    const v = ex
      ? [`Dropped ${ex} from today.`, `${ex} skipped — off today's list.`]
      : ['Dropped that one from today.', 'Skipped — off today\'s list.'];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Exercise added mid-session.
  inserted_accessory(input) {
    const ex = str(input.exercise);
    const seed = `insert|${ex}`;
    const v = ex
      ? [`Added ${ex} to today.`, `${ex} is in — logging it now.`]
      : ['Added that to today.', 'In the session now.'];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Exercise name re-resolved to a canonical.
  identity_corrected(input) {
    const canonical = str(input.mutationContext && input.mutationContext.canonical) || str(input.exercise);
    const seed = `id|${canonical}`;
    const v = canonical
      ? [`Got it — logging that as ${canonical}.`, `Reading that as ${canonical}.`]
      : ['Got it — name sorted.', 'Recognized that one.'];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Warm-up set recorded; excluded from progression.
  warmup_logged(input) {
    const set = fmtSet(input.actual);
    const seed = `wu|${str(input.exercise)}|${set}`;
    if (set) {
      const v = [
        `Warm-up in — ${set}. Not counted toward your working sets.`,
        `${set} logged as a warm-up; it won't touch your progression.`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = [
      "Warm-up logged — it won't count toward your working sets.",
      'Got the warm-up; excluded from progression.',
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Returning after a gap; ease-back framing.
  first_session_back(input) {
    const gap = str(input.trainingGap);
    const seed = `back|${gap}`;
    if (gap) {
      const v = [
        `Welcome back — it's been ${gap}. Start a little conservative today and build from there.`,
        `Good to see you back after ${gap}. Ease in today; no need to chase old numbers on set one.`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = [
      'Welcome back — start a little conservative today and build from there.',
      'Good to have you back. Ease in today, no need to chase old numbers.',
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // LLM is down; the deterministic path IS the output, not an apology.
  coach_unavailable(input) {
    const set = fmtSet(input.actual);
    const ex = str(input.exercise);
    const seed = `offline|${ex}|${set}`;
    if (set) {
      const v = [
        `Logged ${ex || 'that'} — ${set}. Keep going.`,
        `${set} in. On to the next one.`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = ['Logged. Keep going.', 'Got it — keep logging.'];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Session written to Sheets successfully.
  save_succeeded(input) {
    const n = num(input.sessionContext && input.sessionContext.sets_written);
    const seed = `saved|${n}`;
    if (n !== null) {
      const v = [
        `Saved — ${n} ${n === 1 ? 'set' : 'sets'} written to your log.`,
        `Done. ${n} ${n === 1 ? 'set' : 'sets'} are in your log.`,
      ];
      return { message: pick(v, seed), evidenceCited: true };
    }
    const v = ['Saved to your log.', 'Done — your session is in the log.'];
    return { message: pick(v, seed), evidenceCited: false };
  },

  // Session write failed; actionable message, not a system dump.
  save_failed(input) {
    const reason = str(input.sessionContext && input.sessionContext.error);
    const seed = `savefail|${reason}`;
    const tail = ' Your sets are still here — try saving again.';
    if (reason) {
      const v = [
        `That didn't save: ${reason}.${tail}`,
        `Save failed — ${reason}.${tail}`,
      ];
      return { message: pick(v, seed), evidenceCited: false };
    }
    const v = [
      `That didn't save.${tail}`,
      `The save didn't go through.${tail}`,
    ];
    return { message: pick(v, seed), evidenceCited: false };
  },
};

/**
 * Render a deterministic coach line for a known gym event.
 * @param {string} eventType - one of EVENT_TYPES.
 * @param {object} input - the renderer input shape (all fields optional).
 * @returns {{message: string, evidenceCited: boolean}} — empty message for an
 *   unknown event type (caller decides the fallback).
 */
function renderCoachEvent(eventType, input = {}) {
  const fn = RENDERERS[eventType];
  if (typeof fn !== 'function') return { message: '', evidenceCited: false };
  const safeInput = input && typeof input === 'object' ? input : {};
  const out = fn(safeInput) || {};
  return { message: typeof out.message === 'string' ? out.message : '', evidenceCited: !!out.evidenceCited };
}

const EVENT_TYPES = Object.freeze(Object.keys(RENDERERS));

module.exports = { renderCoachEvent, EVENT_TYPES, fmtSet, hashIndex };
