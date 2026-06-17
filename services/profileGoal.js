'use strict';

const { normalizeTrainingGoal } = require('./trainingKnowledge');

/**
 * Returns the persisted per-user training goal from ATLAS_PROFILE_GOAL (env var).
 * Returns null when the variable is absent or empty, so the caller's fallback chain
 * (explicit goal → session text → profile goal → default) remains undisturbed.
 *
 * The value is passed through normalizeTrainingGoal so aliases like "muscle" → "hypertrophy"
 * work. An unrecognised value normalises to "general_health" — same as the pipeline default.
 */
function getProfileGoal() {
  const raw = process.env.ATLAS_PROFILE_GOAL;
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
  return normalizeTrainingGoal(raw.trim());
}

module.exports = { getProfileGoal };
