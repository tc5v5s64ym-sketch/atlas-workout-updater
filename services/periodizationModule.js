'use strict';

const path = require('path');
const fs   = require('fs');

const PERIOD_DIR = path.join(__dirname, '..', 'config', 'coaching', 'periodization');

let _cache = {};

function _loadFile(filename) {
  if (_cache[filename]) return _cache[filename];
  const raw = JSON.parse(fs.readFileSync(path.join(PERIOD_DIR, filename), 'utf8'));
  _cache[filename] = Object.freeze(raw);
  return _cache[filename];
}

function _resetForTesting() { _cache = {}; }

function _round5(value) { return Math.round(value / 5) * 5; }

// ---- Model selection ----

// [goalId][trainingLevel] → periodization model id, or null for beginner (LP handled elsewhere)
// powerlifting advanced → block-intermediate is intentional: 531 wave IS the intermediate step;
// block periodization is the next rung (the config's own training_level label predates this map).
const MODEL_MAP = Object.freeze({
  'powerlifting':    Object.freeze({ beginner: null, intermediate: '531_wave',         advanced: 'block-intermediate' }),
  'general-fitness': Object.freeze({ beginner: null, intermediate: '531_wave',         advanced: 'dup-patterns'       }),
  'bodybuilding':    Object.freeze({ beginner: null, intermediate: 'dup-patterns',     advanced: 'dup-patterns'       }),
  'weight-loss':     Object.freeze({ beginner: null, intermediate: 'dup-patterns',     advanced: 'dup-patterns'       }),
});

const VALID_LEVELS = new Set(['beginner', 'intermediate', 'advanced']);

/**
 * Select the periodization model appropriate for a goal + training level.
 *
 * Beginners use linear progression (handled by starterProgramModule, not here) — returns null.
 * '531_wave' delegates to intermediateProgramModule; this module handles block and DUP models.
 *
 * Returns null for invalid or unrecognized inputs, or for beginner.
 * Returns { modelId, goalId, trainingLevel, notes } for recognized combinations.
 */
function selectPeriodizationModel(goalId, trainingLevel) {
  if (!goalId || typeof goalId !== 'string') return null;
  if (!trainingLevel || typeof trainingLevel !== 'string') return null;
  if (!VALID_LEVELS.has(trainingLevel)) return null;
  const goalEntry = MODEL_MAP[goalId];
  if (!goalEntry) return null;
  const modelId = goalEntry[trainingLevel] ?? null;
  if (!modelId) return null;  // beginner → null

  let notes;
  if (modelId === '531_wave') {
    notes = 'Wendler 5/3/1 wave loading — use intermediateProgramModule.buildNextSession531().';
  } else if (modelId === 'block-intermediate') {
    notes = 'Block periodization: accumulation (4 wk) → intensification (3 wk) → realization (1 wk).';
  } else {
    notes = 'Daily Undulating Periodization: varies rep range and intensity each session within the week.';
  }

  return { modelId, goalId, trainingLevel, notes };
}

// ---- Block periodization ----

/**
 * Return the full phase list for the block-intermediate model.
 *
 * Returns null for null/unknown modelId.
 * Returns { modelId, name, totalWeeks, phases[] } where each phase carries:
 *   name, label, weeks, percent_tm_range, rep_range, set_range, volume_factor, rpe_target, notes
 */
function buildBlockPhases(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  if (modelId !== 'block-intermediate') return null;
  const data = _loadFile('block-intermediate.json');
  return {
    modelId:    data.id,
    name:       data.name,
    totalWeeks: data.total_weeks,
    phases:     data.phases.map(p => ({ ...p })),
  };
}

// ---- DUP patterns ----

/**
 * Return the ordered session-type descriptors for a DUP pattern keyed by days-per-week.
 *
 * Returns null for invalid daysPerWeek or when no pattern matches.
 * Returns { patternId, daysPerWeek, sessions[] } where each session carries:
 *   typeId, label, rep_range, percent_tm_range, set_range, rpe_target, notes
 */
function getDupSessionTypes(daysPerWeek) {
  if (typeof daysPerWeek !== 'number' || !Number.isFinite(daysPerWeek) || daysPerWeek < 1) return null;
  const data = _loadFile('dup-patterns.json');
  const pattern = data.patterns.find(p => p.days_per_week === daysPerWeek);
  if (!pattern) return null;
  const sessions = pattern.session_sequence.map(typeId => ({
    typeId,
    ...data.session_types[typeId],
  }));
  return { patternId: pattern.id, daysPerWeek: pattern.days_per_week, sessions };
}

// ---- Peaking / taper ----

const _PEAKING_EXCLUDED_POPS = new Set(['youth', 'older-adult']);
const _PEAKING_ELIGIBLE_GOALS = new Set(['powerlifting']);

/**
 * Returns true when a competition peaking/taper block is appropriate.
 * Requires powerlifting goal AND a population that is not intensity-capped
 * below competition-viable levels (youth, older-adult excluded).
 */
function isPeakingAppropriate(goalId, populationId) {
  if (!goalId || !_PEAKING_ELIGIBLE_GOALS.has(goalId)) return false;
  if (populationId && _PEAKING_EXCLUDED_POPS.has(populationId)) return false;
  return true;
}

/**
 * Build a 2-week peaking/taper prescription.
 *
 * @param {object} params
 * @param {object} params.trainingMaxes   { [liftCode]: number (lb) }
 * @param {string} [params.goalId]
 * @param {string} [params.populationId]
 *
 * Returns null when peaking is not appropriate for the given population/goal,
 * or for invalid/missing trainingMaxes.
 *
 * Returns:
 *   { modelId, taperWeeks, phases[], eligibleGoal, population }
 *
 * Each phase carries: name, label, week_from_competition, volume_factor,
 *   intensity_ceiling_factor, rep_range, notes, prescriptions{}
 *
 * prescriptions[liftCode]: { trainingMax, targetIntensityMax (lb, round5), volumeFactor, repRange }
 */
function buildPeakingPhase(params) {
  if (!params || typeof params !== 'object') return null;
  const { trainingMaxes, goalId, populationId } = params;
  if (!trainingMaxes || typeof trainingMaxes !== 'object') return null;
  if (!isPeakingAppropriate(goalId, populationId)) return null;

  const data = _loadFile('peaking.json');

  const phases = data.phases.map(phase => {
    const prescriptions = {};
    for (const [code, tm] of Object.entries(trainingMaxes)) {
      if (typeof tm !== 'number' || !Number.isFinite(tm) || tm <= 0) continue;
      const intensityCeiling = phase.intensity_ceiling_factor ?? 1.0;
      prescriptions[code] = {
        trainingMax:          tm,
        targetIntensityMax:   _round5(tm * intensityCeiling),
        volumeFactor:         phase.volume_factor,
        repRange:             phase.rep_range,
      };
    }
    return {
      name:                    phase.name,
      label:                   phase.label,
      weekFromCompetition:     phase.week_from_competition,
      volumeFactor:            phase.volume_factor,
      intensityCeilingFactor:  phase.intensity_ceiling_factor,
      repRange:                phase.rep_range,
      notes:                   phase.notes,
      prescriptions,
    };
  });

  return {
    modelId:      data.id,
    taperWeeks:   data.taper_weeks,
    phases,
    eligibleGoal: goalId ?? null,
    population:   populationId ?? null,
  };
}

module.exports = {
  selectPeriodizationModel,
  buildBlockPhases,
  getDupSessionTypes,
  isPeakingAppropriate,
  buildPeakingPhase,
  _resetForTesting,
};
