'use strict';

// STATUS (2026-07 architecture audit): DARK — no runtime consumer; intentional
// build-ahead. Named in docs/COACHING_ENGINE_ARCHITECTURE.md as the 'Goal &
// population policy' layer, pending wiring alongside goalTemplateModule.

const path = require('path');
const fs   = require('fs');

const POPS_DIR = path.join(__dirname, '..', 'config', 'coaching', 'populations');

let _cache = null;

function _load() {
  if (_cache) return _cache;
  const files = fs.readdirSync(POPS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const map = {};
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(POPS_DIR, file), 'utf8'));
    map[raw.id] = Object.freeze(raw);
  }
  _cache = Object.freeze(map);
  return _cache;
}

function _resetForTesting() { _cache = null; }

/**
 * Return a single population caps object by ID, or null.
 */
function getPopulationCaps(populationId) {
  if (!populationId || typeof populationId !== 'string') return null;
  return _load()[populationId] ?? null;
}

/**
 * List all populations as lightweight summary objects.
 */
function listPopulations() {
  return Object.values(_load()).map(p => ({
    id:          p.id,
    name:        p.name,
    description: p.description,
  }));
}

/**
 * Apply population-specific caps to session parameters.
 *
 * params fields (all optional):
 *   days_per_week          number
 *   session_duration_min   number
 *   weekly_sets_per_muscle number
 *   compounds_per_session  number
 *   target_rir             number
 *   intensity_percent_1rm  number
 *
 * Returns a shallow copy of params with any applicable caps applied.
 * Unknown populationId returns an unmodified copy of params.
 * Null params returns null.
 */
function applyPopulationCaps(params, populationId) {
  if (!params || typeof params !== 'object') return null;
  const caps = getPopulationCaps(populationId);
  if (!caps) return { ...params };

  const c   = caps.constraints || {};
  const out = { ...params };

  if (c.max_days_per_week != null && out.days_per_week != null) {
    out.days_per_week = Math.min(out.days_per_week, c.max_days_per_week);
  }
  if (c.max_session_duration_min != null && out.session_duration_min != null) {
    out.session_duration_min = Math.min(out.session_duration_min, c.max_session_duration_min);
  }
  if (c.max_weekly_sets_per_muscle != null && out.weekly_sets_per_muscle != null) {
    out.weekly_sets_per_muscle = Math.min(out.weekly_sets_per_muscle, c.max_weekly_sets_per_muscle);
  }
  if (c.max_compounds_per_session != null && out.compounds_per_session != null) {
    out.compounds_per_session = Math.min(out.compounds_per_session, c.max_compounds_per_session);
  }
  if (c.rir_floor != null && out.target_rir != null) {
    out.target_rir = Math.max(out.target_rir, c.rir_floor);
  }
  if (c.intensity_ceiling_percent_1rm != null && out.intensity_percent_1rm != null) {
    out.intensity_percent_1rm = Math.min(out.intensity_percent_1rm, c.intensity_ceiling_percent_1rm);
  }

  return out;
}

module.exports = { getPopulationCaps, listPopulations, applyPopulationCaps, _resetForTesting };
