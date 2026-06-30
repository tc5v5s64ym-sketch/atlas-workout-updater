'use strict';

// Onboarding router — PR 9 (Cold-start onboarding flow), questionnaire → template assignment.
// Pure / deterministic. No I/O, no LLM, no Sheets writes, no schema, no route.
//
// Completes the engine layer of the cold-start onboarding flow by connecting
// questionnaire answers (goalId, trainingLevel, availableEquipment, daysPerWeek)
// to the right program/template assignment.
//
// Routing decision tree:
//   1. cold_start_calibration — no log history → 3-session calibration plan
//      (establishes working weights before program assignment)
//   2. beginner_lp            — trainingLevel 'beginner' + has history → first
//      recommended starter program from goalTemplateModule (SL5×5 or GZCLP per goal)
//   3. intermediate_531       — intermediate + 531_wave model → Wendler 5/3/1
//      (consumer provides trainingMaxes to build sessions via intermediateProgramModule)
//   4. advanced_block         — advanced + block-intermediate → 8-week block
//      periodization phases (accumulation / intensification / realization)
//   5. advanced_dup           — intermediate/advanced + dup-patterns → DUP
//      session types keyed by daysPerWeek
//
// Input shape:
//   {
//     goalId:             string,     'powerlifting' | 'general-fitness' | 'bodybuilding' | 'weight-loss'
//     trainingLevel:      string,     'beginner' | 'intermediate' | 'advanced'
//     availableEquipment: string[],   used by calibration plan; defaults to full equipment set
//     daysPerWeek:        number,     3 | 4 — used by DUP session pattern; optional
//     logEntries:         array,      [] or null/missing → cold-start calibration
//     lifts:              array,      lift objects with lift_confidence — used by calibration plan
//   }
//
// Output shape (or null for invalid/unrecognized inputs):
//   {
//     route:          string,          see ROUTE_* constants
//     programId:      string | null,   resolved starter/531 program id
//     modelSelection: object | null,   from selectPeriodizationModel (intermediate/advanced)
//     plan:           object | null,   calibration plan | { programId, initialState } | block phases | DUP sessions
//     notes:          string,          routing explanation
//   }

const { selectPrograms }                       = require('./goalTemplateModule');
const { buildOnboardingSessionPlan,
        DEFAULT_EQUIPMENT }                    = require('./onboardingSessionPlan');
const { selectPeriodizationModel,
        buildBlockPhases,
        getDupSessionTypes }                   = require('./periodizationModule');

const VALID_TRAINING_LEVELS = new Set(['beginner', 'intermediate', 'advanced']);

const ROUTE_COLD_START  = 'cold_start_calibration';
const ROUTE_BEGINNER_LP = 'beginner_lp';
const ROUTE_INT_531     = 'intermediate_531';
const ROUTE_ADV_BLOCK   = 'advanced_block';
const ROUTE_ADV_DUP     = 'advanced_dup';

/**
 * Route questionnaire answers to a program/template assignment.
 *
 * @param {object} params
 * @param {string} params.goalId
 * @param {string} params.trainingLevel
 * @param {string[]} [params.availableEquipment]
 * @param {number} [params.daysPerWeek]
 * @param {array} [params.logEntries]
 * @param {array} [params.lifts]
 *
 * Returns null for invalid or unrecognized inputs.
 */
function routeOnboarding(params) {
  if (!params || typeof params !== 'object') return null;
  const { goalId, trainingLevel, availableEquipment, daysPerWeek, logEntries, lifts } = params;

  if (!goalId || typeof goalId !== 'string') return null;
  if (!trainingLevel || typeof trainingLevel !== 'string') return null;
  if (!VALID_TRAINING_LEVELS.has(trainingLevel)) return null;

  // Route 1: cold start — no log history; calibrate working weights before assigning a program.
  const hasHistory = Array.isArray(logEntries) && logEntries.length > 0;
  if (!hasHistory) {
    const equipment = Array.isArray(availableEquipment) && availableEquipment.length > 0
      ? availableEquipment
      : DEFAULT_EQUIPMENT;
    const plan = buildOnboardingSessionPlan({
      availableEquipment: equipment,
      lifts: Array.isArray(lifts) ? lifts : [],
    });
    return {
      route:          ROUTE_COLD_START,
      programId:      null,
      modelSelection: null,
      plan,
      notes:          'No training history. Starting with a 3-session calibration plan to establish working weights before program assignment.',
    };
  }

  // Route 2: beginner linear progression.
  if (trainingLevel === 'beginner') {
    const programIds = selectPrograms(goalId, { trainingLevel: 'beginner' });
    const programId  = programIds.length > 0 ? programIds[0] : null;
    return {
      route:          ROUTE_BEGINNER_LP,
      programId,
      modelSelection: null,
      plan:           programId
        ? { programId, initialState: { sessionCount: 0, currentWeights: {}, consecutiveFails: {} } }
        : null,
      notes:          programId
        ? `Beginner linear progression: ${programId}. Call starterProgramModule.buildNextSession('${programId}', initialState) for the first session.`
        : `Beginner LP: no starter program configured for goal '${goalId}'.`,
    };
  }

  // Routes 3–5: intermediate / advanced — select periodization model.
  const modelSelection = selectPeriodizationModel(goalId, trainingLevel);
  if (!modelSelection) return null;

  if (modelSelection.modelId === '531_wave') {
    return {
      route:          ROUTE_INT_531,
      programId:      '531-intermediate',
      modelSelection,
      plan:           null, // consumer provides trainingMaxes → intermediateProgramModule.buildNextSession531
      notes:          'Wendler 5/3/1 wave loading. Provide trainingMaxes and call intermediateProgramModule.buildNextSession531({ sessionCount, trainingMaxes }).',
    };
  }

  if (modelSelection.modelId === 'block-intermediate') {
    return {
      route:          ROUTE_ADV_BLOCK,
      programId:      null,
      modelSelection,
      plan:           buildBlockPhases('block-intermediate'),
      notes:          'Block periodization: 8-week cycle (accumulation 4 wk → intensification 3 wk → realization 1 wk).',
    };
  }

  if (modelSelection.modelId === 'dup-patterns') {
    const dupSessions = typeof daysPerWeek === 'number' ? getDupSessionTypes(daysPerWeek) : null;
    return {
      route:          ROUTE_ADV_DUP,
      programId:      null,
      modelSelection,
      plan:           dupSessions,
      notes:          dupSessions
        ? `Daily Undulating Periodization: ${daysPerWeek}-day pattern (${dupSessions.sessions.map(s => s.typeId).join('/')}).`
        : 'Daily Undulating Periodization. Provide daysPerWeek (3 or 4) to getDupSessionTypes for the session pattern.',
    };
  }

  return null;
}

module.exports = {
  routeOnboarding,
  ROUTE_COLD_START,
  ROUTE_BEGINNER_LP,
  ROUTE_INT_531,
  ROUTE_ADV_BLOCK,
  ROUTE_ADV_DUP,
};
