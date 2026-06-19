/* Session plan executor — deterministic plan state from a planned list and a
 * completed list. Pure function, no I/O, no LLM, no Sheets writes.
 *
 * computePlanState(planned, completed) → { planned, completed, remaining, isComplete }
 *
 *   planned   – ordered array. Each entry may be either:
 *                 - a string exercise name, OR
 *                 - { name: string, liftCode?: string }
 *   completed – array. Same format as planned.
 *
 * An exercise in `planned` is considered done when ANY of the following hold:
 *   1. Its name matches a name in `completed` (case-insensitive), OR
 *   2. Both sides supply a non-empty liftCode and they match (case-insensitive).
 *      This covers the "Rows" (plan) vs "Barbell Row" (logged) identity mismatch
 *      when both carry the same lift_code.
 *
 * planned[] and completed[] in the RETURN value are always string arrays
 * (names only) so downstream consumers see a stable shape.
 *
 * remaining  = planned exercises not yet covered by either match rule above
 * isComplete = remaining.length === 0 AND planned.length > 0
 *
 * Non-string and blank entries in either array are silently dropped.
 */
'use strict';

function toRecord(entry) {
  if (typeof entry === 'string') {
    const name = entry.trim();
    return name ? { name, liftCode: '' } : null;
  }
  if (entry && typeof entry === 'object') {
    const name = String(entry.name || '').trim();
    const liftCode = String(entry.liftCode || entry.lift_code || '').trim();
    return name ? { name, liftCode } : null;
  }
  return null;
}

function toRecords(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(toRecord).filter(Boolean);
}

/**
 * computePlanState(planned, completed) → { planned, completed, remaining, isComplete }
 */
function computePlanState(planned, completed) {
  const planRecs  = toRecords(planned);
  const doneRecs  = toRecords(completed);

  const doneNames = new Set(doneRecs.map(r => r.name.toLowerCase()));
  const doneCodes = new Set(doneRecs.map(r => r.liftCode.toLowerCase()).filter(Boolean));

  const remaining = planRecs
    .filter(r => {
      if (doneNames.has(r.name.toLowerCase())) return false;
      if (r.liftCode && doneCodes.has(r.liftCode.toLowerCase())) return false;
      return true;
    })
    .map(r => r.name);

  const planArr      = planRecs.map(r => r.name);
  const completedArr = doneRecs.map(r => r.name);

  return {
    planned:    planArr,
    completed:  completedArr,
    remaining,
    isComplete: planArr.length > 0 && remaining.length === 0
  };
}

/**
 * nextExerciseFromPlan(map, exerciseName)
 *
 * Pure lookup: given an ordered Map<lowercase-name, record> from the API plan,
 * returns the next exercise entry (or null for the last exercise).
 *
 * Return shape:
 *   { found: true,  next: string|null } — exercise was in the plan; next is the
 *                                          following entry's display name, or null
 *                                          when the matched exercise is the last.
 *   { found: false }                    — exercise was NOT in the plan; caller
 *                                          should use its fallback (e.g. activePlannedSession).
 *
 * Matching: exact lowercase first, then bidirectional substring.
 * When found, the result is AUTHORITATIVE — the caller must NOT consult any
 * fallback, because the API plan is the source of truth for plan order.
 *
 * This replicates the lookup block inside getNextExerciseInPlan
 * (public/coach-conversation.js) so the algorithm can be tested in Node.js
 * without a browser environment.
 * keep in sync with the "keep in sync" block in getNextExerciseInPlan (coach-conversation.js)
 */
function nextExerciseFromPlan(map, exerciseName) {
  if (!map || !map.size) return { found: false };
  const key = String(exerciseName || '').toLowerCase();
  const keys = Array.from(map.keys());
  let idx = keys.indexOf(key);
  if (idx === -1) idx = keys.findIndex(k => k.includes(key) || key.includes(k));
  if (idx === -1) return { found: false };
  if (idx >= keys.length - 1) return { found: true, next: null };
  const nextRec = map.get(keys[idx + 1]);
  return { found: true, next: (nextRec && (nextRec.exercise_name || nextRec.exercise)) || null };
}

/**
 * isPlanComplete(planned, completed) → boolean
 *
 * Convenience wrapper: true when planned is non-empty and every entry has a
 * match in completed (same rules as computePlanState). Used by regression tests
 * and any future server-side caller; the browser replicates the name-match logic
 * inline (no require() in classic scripts).
 */
function isPlanComplete(planned, completed) {
  return computePlanState(planned, completed).isComplete;
}

/**
 * applySubstitution(planned, prescribed, substitute) → { planned, substituted, applied }
 *
 * Records an in-session swap on the planned list: the `prescribed` exercise's
 * slot is replaced, IN PLACE (order preserved), by the `substitute` exercise.
 * This is how an accepted "X is taken, I'll do Y instead" swap updates the
 * authoritative session state so the prescribed exercise stops showing as
 * remaining and the substitute takes its place. (Roadmap Step 372.)
 *
 * Inputs (entries may be a string name or { name, liftCode }):
 *   planned    – ordered planned list
 *   prescribed – the planned exercise being swapped OUT (string or record)
 *   substitute – the exercise swapped IN (string or record). Its liftCode, when
 *                present, rides along so a later log under a different canonical
 *                name (e.g. plan "Rows" logged as "Barbell Row") still matches by
 *                code in computePlanState.
 *
 * Returns:
 *   planned     – updated ordered list as { name, liftCode } records (stable shape;
 *                 computePlanState accepts records directly)
 *   substituted – array of { from, to } applied swaps (empty when none applied)
 *   applied     – true when the prescribed slot was found and replaced
 *
 * No-op (applied:false, planned returned as records unchanged) when:
 *   - prescribed or substitute is blank / non-resolvable, OR
 *   - prescribed is not found in planned (by name or liftCode) — that is an
 *     'add', not a substitution; the caller decides what to do, OR
 *   - substitute resolves to the same NAME as prescribed (nothing to swap).
 *
 * Pure function. Never mutates its inputs.
 */
function applySubstitution(planned, prescribed, substitute) {
  const planRecs = toRecords(planned);
  const presc = toRecord(prescribed);
  const sub   = toRecord(substitute);

  if (!presc || !sub) return { planned: planRecs, substituted: [], applied: false };
  if (presc.name.toLowerCase() === sub.name.toLowerCase()) {
    return { planned: planRecs, substituted: [], applied: false };
  }

  const prescKey  = presc.name.toLowerCase();
  const prescCode = presc.liftCode.toLowerCase();

  const idx = planRecs.findIndex(r => {
    if (r.name.toLowerCase() === prescKey) return true;
    if (prescCode && r.liftCode.toLowerCase() === prescCode) return true;
    return false;
  });
  if (idx === -1) return { planned: planRecs, substituted: [], applied: false };

  const fromName = planRecs[idx].name;

  // Dedupe guard: if the substitute is ALREADY planned in another slot, drop the
  // prescribed slot instead of replacing it — otherwise the list would carry the
  // substitute twice and computePlanState would close both slots from a single
  // logged set.
  const subKey  = sub.name.toLowerCase();
  const subCode = sub.liftCode.toLowerCase();
  const dupElsewhere = planRecs.some((r, i) =>
    i !== idx && (
      r.name.toLowerCase() === subKey ||
      (subCode && r.liftCode.toLowerCase() === subCode)
    )
  );

  const updated = planRecs.slice();
  if (dupElsewhere) {
    updated.splice(idx, 1);
  } else {
    updated[idx] = { name: sub.name, liftCode: sub.liftCode };
  }

  return {
    planned: updated,
    substituted: [{ from: fromName, to: sub.name }],
    applied: true,
  };
}

module.exports = { computePlanState, nextExerciseFromPlan, isPlanComplete, applySubstitution };
