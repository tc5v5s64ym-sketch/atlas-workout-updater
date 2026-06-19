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

module.exports = { computePlanState };
