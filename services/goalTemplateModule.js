'use strict';

const path = require('path');
const fs   = require('fs');

const GOALS_DIR = path.join(__dirname, '..', 'config', 'coaching', 'goals');

let _cache = null;

function _load() {
  if (_cache) return _cache;
  const files = fs.readdirSync(GOALS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const map = {};
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(GOALS_DIR, file), 'utf8'));
    map[raw.id] = Object.freeze(raw);
  }
  _cache = Object.freeze(map);
  return _cache;
}

function _resetForTesting() { _cache = null; }

/**
 * Return a single goal template by ID, or null.
 */
function getGoalTemplate(goalId) {
  if (!goalId || typeof goalId !== 'string') return null;
  return _load()[goalId] ?? null;
}

/**
 * List all goal templates as lightweight summary objects.
 */
function listGoalTemplates() {
  return Object.values(_load()).map(g => ({
    id:          g.id,
    name:        g.name,
    description: g.description,
  }));
}

/**
 * Return program IDs recommended for a goal + training level.
 * trainingLevel: 'beginner' | 'intermediate' | 'advanced'  (default: 'beginner')
 * Returns [] when the goal is unknown or no programs match the level.
 */
function selectPrograms(goalId, { trainingLevel = 'beginner' } = {}) {
  const template = getGoalTemplate(goalId);
  if (!template || !Array.isArray(template.recommended_programs)) return [];
  return template.recommended_programs
    .filter(rp => Array.isArray(rp.training_levels) && rp.training_levels.includes(trainingLevel))
    .map(rp => rp.program_id);
}

module.exports = { getGoalTemplate, listGoalTemplates, selectPrograms, _resetForTesting };
