'use strict';

/**
 * Pure deterministic formatter for suggested workout output.
 *
 * Format contract:
 *   - Exercise names:  **Bench Press**
 *   - Set lines:       {weight}lbs {reps}/{rir}
 *   - RIR range:       {weight}lbs {reps}/{rirMin}-{rirMax}  (order preserved)
 *   - Missing RIR:     {weight}lbs {reps}  (no trailing slash)
 *   - Exercises separated by one blank line, no bullets, no prose inside the block.
 *
 * No I/O. No side effects. No imports from the rest of the app.
 */

/**
 * Format a single set line.
 *
 * @param {{ weight: number, reps: number, rir?: number, rirMin?: number, rirMax?: number }} set
 * @returns {string}  e.g. "225lbs 5/2" or "225lbs 5/2-1" or "225lbs 5"
 */
function formatSetLine({ weight, reps, rir, rirMin, rirMax } = {}) {
  if (weight == null) throw new Error('formatSetLine: weight is required');
  if (reps == null) throw new Error('formatSetLine: reps is required');

  const base = `${weight}lbs ${reps}`;

  if (rirMin != null && rirMax != null) {
    // Preserve display order — "2-1" means "starts ~2 RIR, may drift to 1"
    return `${base}/${rirMin}-${rirMax}`;
  }
  if (rir != null) {
    return `${base}/${rir}`;
  }
  return base;
}

/**
 * Format one exercise block: bold name followed by one set line per row.
 *
 * @param {{ name: string, sets: Array }} exercise
 * @returns {string}
 */
function formatExerciseBlock({ name, sets } = {}) {
  if (!name) throw new Error('formatExerciseBlock: name is required');
  if (!Array.isArray(sets) || sets.length === 0) {
    throw new Error('formatExerciseBlock: sets must be a non-empty array');
  }

  const lines = [`**${name}**`];
  for (const set of sets) {
    lines.push(formatSetLine(set));
  }
  return lines.join('\n');
}

/**
 * Format a complete suggested workout.
 *
 * @param {{ why?: string, exercises: Array }} workout
 * @returns {string}
 */
function formatSuggestedWorkout({ why, exercises } = {}) {
  if (!Array.isArray(exercises) || exercises.length === 0) {
    throw new Error('formatSuggestedWorkout: exercises must be a non-empty array');
  }

  const workoutBlock = exercises.map(formatExerciseBlock).join('\n\n');

  if (why && why.trim()) {
    return `${why.trim()}\n\n${workoutBlock}`;
  }
  return workoutBlock;
}

module.exports = { formatSetLine, formatExerciseBlock, formatSuggestedWorkout };
