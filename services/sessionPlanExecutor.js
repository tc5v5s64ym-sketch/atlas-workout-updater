/* Session plan executor — deterministic plan state from a planned list and a
 * completed list. Pure function, no I/O, no LLM, no Sheets writes.
 *
 * computePlanState(planned, completed) → { planned, completed, remaining, isComplete }
 *
 *   planned   – ordered array of exercise name strings (the session's intended list)
 *   completed – array of exercise name strings logged/confirmed so far (any order)
 *
 * remaining  = planned exercises whose name does NOT appear in completed
 *              (case-insensitive comparison)
 * isComplete = remaining.length === 0 AND planned.length > 0
 *
 * Non-string and blank entries in either array are silently dropped.
 *
 * Design note: the state is computed on demand from the two lists — there is no
 * persisted state machine. The caller (frontend / chat context) supplies what was
 * completed; this function determines what remains. This makes the computation
 * idempotent and safe to re-run from any client snapshot.
 */
'use strict';

function toNames(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim());
}

/**
 * computePlanState(planned, completed) → { planned, completed, remaining, isComplete }
 */
function computePlanState(planned, completed) {
  const planArr      = toNames(planned);
  const completedArr = toNames(completed);
  const doneSet      = new Set(completedArr.map(n => n.toLowerCase()));
  const remaining    = planArr.filter(n => !doneSet.has(n.toLowerCase()));

  return {
    planned:    planArr,
    completed:  completedArr,
    remaining,
    isComplete: planArr.length > 0 && remaining.length === 0
  };
}

module.exports = { computePlanState };
