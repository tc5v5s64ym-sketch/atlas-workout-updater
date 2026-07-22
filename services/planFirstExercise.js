'use strict';

// Make the authoritative recommendation LEAD with the athlete's requested first exercise
// ("Plan me a workout but have it start with back squats"). Authoritative-only and pure:
// the numbers come from the deterministic engine (the caller resolves them via
// recommendNextSet) — never fabricated here. When the requested lift is already in the
// recommended intent it is moved to the front; otherwise it is INJECTED at the front with
// the engine-resolved target, or — when history can't support a load — an EXPLICIT
// unresolved-load state (`unresolved_load: true`, `target_weight: null`), never a fabricated
// number and never a silently omitted field (2026-07-22 requirement). Read-only: it only
// reorders/annotates the recommendation object the route already built.

function normKey(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Build the structured entry for a requested first lift that is NOT already in the
// recommendation. `target` is the engine's resolved next target ({ weight, reps, sets, rir })
// or null/undefined. A numeric weight (including 0 for bodyweight) is a resolved load; the
// absence of one surfaces the explicit unresolved-load state.
function buildInjectedEntry(name, code, target) {
  const t = target && typeof target === 'object' ? target : null;
  const hasLoad = t && typeof t.weight === 'number' && Number.isFinite(t.weight);
  if (hasLoad) {
    return {
      exercise: name,
      lift_code: code || null,
      target_weight: t.weight,
      target_reps: t.reps != null ? t.reps : null,
      target_sets: t.sets != null ? t.sets : null,
      target_rir: t.rir != null ? t.rir : null,
      reason: `Leading with ${name} as requested.`,
      requested_first: true,
    };
  }
  return {
    exercise: name,
    lift_code: code || null,
    target_weight: null,
    target_reps: null,
    target_sets: null,
    target_rir: null,
    unresolved_load: true,
    reason: `You asked to start with ${name}, but I don't have enough history to set a working weight — log a set (or tell me a starting weight) and I'll anchor it.`,
    requested_first: true,
  };
}

// Reorder/inject so the recommended intent leads with the requested first exercise.
// `req` = { name (canonical display name), code (canonical lift code), target (engine next
// target or null) }. Returns the same `result` object (mutated), unchanged when there is no
// request or no recommended intent to lead.
function applyFirstExercise(result, req) {
  const r = req && typeof req === 'object' ? req : {};
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name || !result || !Array.isArray(result.intents)) return result;
  const rec = result.intents.find((i) => i && i.recommended === true);
  if (!rec || !Array.isArray(rec.exercises)) return result;

  const codeKey = normKey(r.code);
  const nameKey = normKey(name);
  const matches = (e) => !!e && (
    (codeKey && normKey(e.lift_code) === codeKey) ||
    (nameKey && normKey(e.exercise || e.name) === nameKey)
  );

  const idx = rec.exercises.findIndex(matches);
  if (idx > 0) {
    const [ex] = rec.exercises.splice(idx, 1);
    rec.exercises.unshift(ex);
  } else if (idx < 0) {
    rec.exercises.unshift(buildInjectedEntry(name, r.code || null, r.target));
  }
  // idx === 0 → already leads; nothing to move.

  rec.requested_first_exercise = name;
  return result;
}

module.exports = { applyFirstExercise, buildInjectedEntry, normKey };
