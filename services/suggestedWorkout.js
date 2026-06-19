'use strict';

/**
 * Suggested Workout Engine — PR 366.
 *
 * Deterministically selects the day's best workout by:
 *   1. Running scoreIntents to score all intent options (strength, muscle, blind-spots, balanced)
 *      using readiness, muscle coverage, stalls, trends, and training goal.
 *   2. Picking the top-scoring intent.
 *   3. Filtering the exercise list: exercises with a `consistent_underperformance` memory
 *      pattern are moved to filtered_out (not dropped silently — surfaced in evidence so
 *      the coach can explain the downgrade, and callers can choose to restore them).
 *
 * Returns null when logRows has insufficient data to score any intent.
 *
 * Pure function — no I/O, no LLM, no Sheets writes.
 *
 * Dependencies:
 *   analytics.scoreIntents    — scores intents with full readiness/stall/gap context
 *   coachMemory.detectPatterns — detects per-lift memory patterns (underperformance, subs)
 */

const { scoreIntents }    = require('./analytics');
const { detectPatterns }  = require('./coachMemory');

/**
 * buildSuggestedWorkout(logRows, effortRows, options)
 *
 * @param {Array}  logRows    12-col Log_Cleaned rows
 * @param {Array}  effortRows Effort tab rows (optional)
 * @param {object} options
 * @param {string} [options.today]  ISO date override (defaults to today)
 * @param {string} [options.goal]   Training goal override ('strength'|'muscle'|'general')
 *
 * @returns {{
 *   intent: string,
 *   intent_label: string,
 *   intent_score: number,
 *   focus: string,
 *   exercises: Array<{exercise, lift_code, target_weight, target_reps, target_sets, reason}>,
 *   reason_codes: string[],
 *   evidence: {
 *     data_points: Array<{label, value, context}>,
 *     filtered_out: Array<{exercise, lift_code, reason, details}>,
 *   },
 *   watch_for: string[],
 *   pivot_logic: Array<{exercise, condition, action}>,
 * }} | null
 */
function buildSuggestedWorkout(logRows, effortRows = [], options = {}) {
  if (!Array.isArray(logRows) || !logRows.length) return null;

  const { today = null, goal = null } = options && typeof options === 'object' ? options : {};

  const scoreResult = scoreIntents(
    Array.isArray(logRows) ? logRows : [],
    Array.isArray(effortRows) ? effortRows : [],
    { today, goal }
  );

  const intents = scoreResult && Array.isArray(scoreResult.intents) ? scoreResult.intents : null;
  if (!intents || !intents.length) return null;

  // Pick the highest-scoring intent (stable: first wins on tie).
  const topIntent = intents.reduce((best, i) => (!best || (i.score > best.score)) ? i : best, null);
  if (!topIntent) return null;

  const rows = Array.isArray(logRows) ? logRows : [];

  // Filter exercises: consistent_underperformance → moved to filtered_out.
  const exercises = [];
  const filteredOut = [];
  for (const ex of Array.isArray(topIntent.exercises) ? topIntent.exercises : []) {
    if (!ex || !ex.lift_code) { exercises.push(ex); continue; }
    const { patterns } = detectPatterns(ex.lift_code, rows);
    const underperf = patterns.find(p => p.type === 'consistent_underperformance');
    if (underperf) {
      filteredOut.push({
        exercise: ex.exercise,
        lift_code: ex.lift_code,
        reason: 'consistent_underperformance',
        details: underperf.details,
      });
    } else {
      exercises.push(ex);
    }
  }

  return {
    intent:        topIntent.id,
    intent_label:  topIntent.label,
    intent_score:  topIntent.score,
    focus:         topIntent.focus || '',
    exercises,
    reason_codes:  Array.isArray(topIntent.why_today) ? topIntent.why_today : [],
    evidence: {
      data_points:  Array.isArray(topIntent.data_points)  ? topIntent.data_points  : [],
      filtered_out: filteredOut,
    },
    watch_for:    Array.isArray(topIntent.watch_for)   ? topIntent.watch_for   : [],
    pivot_logic:  Array.isArray(topIntent.pivot_logic) ? topIntent.pivot_logic : [],
  };
}

module.exports = { buildSuggestedWorkout };
