/* Deterministic per-exercise current-session tally for the coach chat context.
 *
 * The coach chat context historically carried NO structured record of what was
 * logged this session — only completed exercise NAMES (plan_completed) and, during
 * a preview, current_preview. So the coach had to INFER set counts and per-exercise
 * weights from the capped 8-turn transcript, which (targeted validation sweep
 * 2026-07-09) fabricated weights (225 vs the logged 185), undercounted sets once
 * logging exceeded the 8-turn window (2 vs 3 rows; 4 vs 5 total), and lost
 * substitution identity (reported a suggested lift + invented count/weight instead
 * of the logged Front Squat). This module turns the authoritative per-set session
 * buffer (getSessionLog(): [{exercise, weight, reps, rir, notes}]) into a structured
 * tally the coach reads instead of guessing.
 *
 * PURE — no globals, no I/O, no catalog/KB lookup.
 *
 *   buildSessionTally(
 *     [{exercise:'Back Squat', weight:185, reps:8, rir:2}, ...],
 *     ['Back Squat', 'Seated Row', ...]        // current plan exercise names
 *   )
 *   → { exercises: [{ exercise:'Back Squat', sets:3,
 *                     per_set:[{weight:185,reps:8,rir:2}, ...], planned:true }],
 *       total_working_sets: 3 }
 *
 * `planned` is true when the logged exercise name is (case-insensitively) in the
 * current plan, false when it is not (off-plan / extra / an un-reconciled variant),
 * and null when no plan names are supplied (freestyle). Returns null when nothing
 * loggable is in the buffer, so the coach says it has nothing logged yet rather than
 * inventing a tally.
 */

function num(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function buildSessionTally(logRows, planNames) {
  const rows = Array.isArray(logRows) ? logRows : [];
  const planSet = new Set(
    (Array.isArray(planNames) ? planNames : [])
      .map(n => (n == null ? '' : String(n).trim().toLowerCase()))
      .filter(Boolean)
  );

  const byExercise = new Map();
  const order = [];
  for (const s of rows) {
    const name = s && s.exercise != null ? String(s.exercise).trim() : '';
    if (!name) continue;
    if (!byExercise.has(name)) { byExercise.set(name, []); order.push(name); }
    byExercise.get(name).push({ weight: num(s.weight), reps: num(s.reps), rir: num(s.rir) });
  }
  if (!order.length) return null;

  const exercises = order.map(name => ({
    exercise: name,
    sets: byExercise.get(name).length,
    per_set: byExercise.get(name),
    planned: planSet.size ? planSet.has(name.toLowerCase()) : null
  }));

  return {
    exercises,
    total_working_sets: exercises.reduce((total, e) => total + e.sets, 0)
  };
}
