'use strict';

// Profile-Aware Stimulus Governor — RULE TABLE + lookup (Training Profile
// Taxonomy §5, PR 481).
//
// The governor decides whether logged effort earns progression, holds, or signals
// fatigue, using the user's PROFILE plus the exercise's MODALITY. RIR/fatigue rules
// differ by profile ("don't force the barbell model"). This slice ships the RULE
// CONTRACT — the per-(profile × modality) interpretation rules + the controlled
// output vocabularies — and FIXTURE-PROTECTS it before the governor that applies a
// rule to a logged set ships (PR 482). A rule change is therefore visible and
// test-gated, never silent.
//
// PURE DATA / lookup: no I/O, no LLM, no Sheets, NO write path, NO Log_Cleaned
// schema change. `governorRuleFor` takes a profile + a coarse modality category
// (PR 482 maps a real exercise → category via services/exerciseModality.js);
// applying a rule to actual logged effort is PR 482.

// The five training profiles (Taxonomy §1).
const PROFILES = Object.freeze([
  'strength', 'hypertrophy', 'general_fitness', 'cardio', 'bodyweight',
]);

// Coarse modality categories the governor distinguishes (derived from the §3
// modality schema; PR 482 bridges exerciseModality.modalityFor → one of these).
const MODALITY_CATEGORIES = Object.freeze([
  'resistance', 'bodyweight', 'cardio', 'timed', 'circuit',
]);

// Deterministic governor outputs (engine facts the voice may word, never invent).
const PROGRESSION_VERDICTS = Object.freeze([
  '+load', '+reps', '+rounds', '+duration', 'hold', 'back_off',
]);
const FATIGUE_SIGNALS = Object.freeze(['none', 'elevated', 'high']);

// Which effort metric the governor READS for a modality (effort_interpretation),
// and the progression verdicts reachable for that modality.
const MODALITY_RULES = Object.freeze({
  resistance: { effort_interpretation: 'rir', rir_relevant: true, allowed_verdicts: Object.freeze(['+load', '+reps', 'hold', 'back_off']) },
  bodyweight: { effort_interpretation: 'reps_rir', rir_relevant: true, allowed_verdicts: Object.freeze(['+reps', '+load', 'hold', 'back_off']) },
  cardio: { effort_interpretation: 'hr_zone_pace', rir_relevant: false, allowed_verdicts: Object.freeze(['+duration', 'hold', 'back_off']) },
  timed: { effort_interpretation: 'duration_rpe', rir_relevant: false, allowed_verdicts: Object.freeze(['+duration', 'hold', 'back_off']) },
  circuit: { effort_interpretation: 'rounds_density', rir_relevant: false, allowed_verdicts: Object.freeze(['+rounds', 'hold', 'back_off']) },
});

// Per-PROFILE RIR-0 handling + progression bias (§5). These apply only when the
// modality makes RIR relevant (resistance / bodyweight); for cardio/timed/circuit
// the profile's RIR rule is moot (rir_relevant=false).
//   rir0_blocks_progression — RIR 0 on a HEAVY COMPOUND blocks the next progression
//   rir0_caution            — RIR 0 on a heavy compound is allowed but flagged (recovery cost)
//   rir0_ok_isolation       — RIR 0 on isolation/accessory is fine
//   reward_consistency      — reward showing up + clean reps over maximal effort
const PROFILE_RIR_RULES = Object.freeze({
  strength: { rir_band: [1, 3], rir0_blocks_progression: true, rir0_caution: false, rir0_ok_isolation: true, reward_consistency: false },
  hypertrophy: { rir_band: [0, 3], rir0_blocks_progression: false, rir0_caution: true, rir0_ok_isolation: true, reward_consistency: false },
  general_fitness: { rir_band: [2, 4], rir0_blocks_progression: false, rir0_caution: false, rir0_ok_isolation: true, reward_consistency: true },
  cardio: { rir_band: null, rir0_blocks_progression: false, rir0_caution: false, rir0_ok_isolation: true, reward_consistency: true },
  bodyweight: { rir_band: [0, 3], rir0_blocks_progression: false, rir0_caution: false, rir0_ok_isolation: true, reward_consistency: false },
});

/**
 * The governor rule for a (profile × modality) pair: which metric to read, whether
 * RIR is relevant, how RIR 0 is handled for this profile, and the reachable
 * progression verdicts. Pure; returns null for an unknown profile or modality.
 *
 * @param {string} profile           one of PROFILES
 * @param {string} modalityCategory  one of MODALITY_CATEGORIES
 * @returns {{
 *   profile:string, modality:string, effort_interpretation:string,
 *   rir_relevant:boolean, rir_band:(number[]|null),
 *   rir0_blocks_progression:boolean, rir0_caution:boolean,
 *   rir0_ok_isolation:boolean, reward_consistency:boolean,
 *   allowed_verdicts:string[]
 * }|null}
 */
function governorRuleFor(profile, modalityCategory) {
  const p = PROFILE_RIR_RULES[profile];
  const m = MODALITY_RULES[modalityCategory];
  if (!p || !m) return null;
  // The modality decides whether RIR is read at all (cardio overrides RIR
  // regardless of profile — §5 "RIR irrelevant"); the profile's RIR-0 handling
  // only bites when RIR is relevant.
  const rirRelevant = m.rir_relevant;
  return {
    profile,
    modality: modalityCategory,
    effort_interpretation: m.effort_interpretation,
    rir_relevant: rirRelevant,
    // Copy the nested array (PROFILE_RIR_RULES is only shallow-frozen) so a caller
    // can't mutate the shared module-level rule table — symmetric with allowed_verdicts.
    rir_band: rirRelevant && p.rir_band ? p.rir_band.slice() : null,
    rir0_blocks_progression: rirRelevant ? p.rir0_blocks_progression : false,
    rir0_caution: rirRelevant ? p.rir0_caution : false,
    rir0_ok_isolation: rirRelevant ? p.rir0_ok_isolation : false,
    reward_consistency: p.reward_consistency,
    allowed_verdicts: m.allowed_verdicts.slice(),
  };
}

module.exports = {
  PROFILES,
  MODALITY_CATEGORIES,
  PROGRESSION_VERDICTS,
  FATIGUE_SIGNALS,
  MODALITY_RULES,
  PROFILE_RIR_RULES,
  governorRuleFor,
};
