'use strict';

// Pure Session Objective Scorer — Session Planning Engine §3/§4 (PR 480).
//
// Computes the nine term sub-scores (profile_match, goal_match, equipment_fit,
// time_fit, recovery_fit, adherence_fit, movement_balance_need, pain_conflict,
// fatigue_conflict) for each of the ten session objectives from a NORMALIZED
// planning snapshot, then ranks/selects via the PR 479 scoring contract
// (services/objectiveScoring.js).
//
// PURE / read-only: no I/O, no LLM, no Sheets, NO write path, NO Log_Cleaned
// schema change. It consumes a snapshot of already-derived signals; BUILDING that
// snapshot from live sources (profile vector, readiness model, coverage, Constraints,
// fatigue) is a later wiring slice. The per-objective feature rules here are the
// INITIAL deterministic defaults (§3) — simple, explainable, and fixture-gated, so
// any change is visible and test-reviewed.

const {
  SESSION_OBJECTIVES,
  combineObjectiveScore,
  explainObjectiveScore,
  selectObjective,
} = require('./objectiveScoring');

// ─── snapshot accessors (safe, normalized) ────────────────────────────────────

function n01(v, dflt = 0) {
  const x = Number(v);
  if (!Number.isFinite(x)) return dflt;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function b01(v) { return v ? 1 : 0; }

function profileAxis(s, axis) { return n01(s.profile && s.profile[axis], 0); }

// goal_match: primary goal in the objective's goal set → 1, secondary → 0.6, else 0.
function goalMatch(s, goalKeys) {
  const g = s.goals || {};
  if (goalKeys.includes(g.primary)) return 1;
  if (goalKeys.includes(g.secondary)) return 0.6;
  return 0;
}

// equipment_fit by modality need. equipment may be 'full_gym'/null (→ everything
// available) or an object of booleans { weights, cardio, space }.
function equip(s, need) {
  const e = s.equipment;
  if (e == null || e === 'full_gym') return 1;
  const has = (k) => b01(e[k]);
  switch (need) {
    case 'weights': return has('weights');
    case 'cardio': return has('cardio') || has('space'); // machine or open space (run)
    case 'space': return has('space');
    case 'none': return 1; // bodyweight needs nothing
    default: return 1;
  }
}

// time_fit: enough time → 1; otherwise the fraction of the need that fits. No time
// signal → 1 (don't penalize on missing data).
function timeFit(s, needMin) {
  if (s.time_min == null) return 1;
  const t = Number(s.time_min);
  if (!Number.isFinite(t) || needMin <= 0) return 1;
  return t >= needMin ? 1 : n01(t / needMin);
}

const recovery = (s) => n01(s.readiness && s.readiness.recovery_fit, 0.7);
const systemicFatigue = (s) => n01(s.fatigue && s.fatigue.systemic, 0.3);
const adherence = (s) => n01(s.adherence && s.adherence.matches_cadence, 0.6);

// movement_balance_need: does this objective address a currently under-served
// pattern/muscle? 1 if any of its covered patterns is in coverage_gaps, else a low
// baseline (it still trains, just isn't closing a gap).
function balanceNeed(s, covers) {
  const gaps = Array.isArray(s.coverage_gaps) ? s.coverage_gaps : [];
  if (!gaps.length || !covers.length) return 0.3;
  return covers.some((p) => gaps.includes(p)) ? 1 : 0.3;
}

// pain_conflict: does this objective load a flagged pain target?
function painConflict(s, loads) {
  const pain = Array.isArray(s.pain) ? s.pain : [];
  if (!pain.length || !loads.length) return 0;
  return loads.some((p) => pain.includes(p)) ? 1 : 0;
}

// ─── per-objective feature derivation ─────────────────────────────────────────
// Each entry returns the nine sub-scores for its objective from the snapshot.
// Normal (training-stressing) objectives: recovery_fit = readiness; fatigue_conflict
// rises with the systemic/recent-hard load they'd stack. The two recovery-oriented
// objectives (recovery_reload, deload) INVERT: they fit BETTER when fatigued, and
// stack ~no fatigue, so their recovery_fit is high under fatigue and their
// fatigue_conflict is ~0.

function trainingRecovery(s, taxedFlags) {
  // recovery_fit for an objective that taxes a system: base readiness, reduced by
  // any named "this objective's system is redlined" flag.
  let r = recovery(s);
  for (const f of taxedFlags) if (s.readiness && s.readiness[f]) r = Math.min(r, 0.3);
  return r;
}
function trainingFatigueConflict(s, taxedFlags) {
  let c = systemicFatigue(s);
  for (const f of taxedFlags) if (s.readiness && s.readiness[f]) c = Math.max(c, 0.9);
  return c;
}

const FEATURES = {
  strength_progression: (s) => ({
    profile_match: profileAxis(s, 'strength'),
    goal_match: goalMatch(s, ['strength', 'powerlifting']),
    equipment_fit: equip(s, 'weights'),
    time_fit: timeFit(s, 45),
    recovery_fit: s.deload_active ? 0 : trainingRecovery(s, ['main_compounds_redlined']),
    adherence_fit: adherence(s),
    movement_balance_need: balanceNeed(s, ['squat', 'hinge', 'push', 'pull']),
    pain_conflict: painConflict(s, ['squat', 'hinge', 'push', 'pull']),
    fatigue_conflict: trainingFatigueConflict(s, ['main_compounds_redlined']),
  }),
  hypertrophy_volume: (s) => ({
    profile_match: profileAxis(s, 'hypertrophy'),
    goal_match: goalMatch(s, ['hypertrophy', 'muscle']),
    equipment_fit: equip(s, 'weights'),
    time_fit: timeFit(s, 50),
    recovery_fit: s.deload_active ? 0 : trainingRecovery(s, ['target_muscles_redlined']),
    adherence_fit: adherence(s),
    movement_balance_need: balanceNeed(s, ['push', 'pull', 'lower', 'core']),
    pain_conflict: painConflict(s, ['push', 'pull', 'lower']),
    fatigue_conflict: trainingFatigueConflict(s, ['target_muscles_redlined']),
  }),
  general_fitness_balanced: (s) => ({
    profile_match: profileAxis(s, 'general_fitness'),
    goal_match: goalMatch(s, ['general_fitness', 'health', 'weight_loss']),
    equipment_fit: 1, // adaptable to whatever is available
    time_fit: timeFit(s, 30),
    recovery_fit: recovery(s),
    adherence_fit: Math.max(adherence(s), 0.5), // consistency objective
    movement_balance_need: balanceNeed(s, ['push', 'pull', 'lower', 'core']),
    pain_conflict: 0, // adapts around pain rather than loading it
    fatigue_conflict: Math.min(systemicFatigue(s), 0.5), // shrinks rather than stacks
  }),
  cardio_base: (s) => ({
    profile_match: profileAxis(s, 'cardio'),
    // Base is the default aerobic choice; it stays a strong fit even when the user
    // asked for intensity (it's the safe fallback), just slightly lower than a
    // matched interval intent.
    goal_match: s.cardio_intent === 'intervals' ? 0.7 : goalMatch(s, ['cardio', 'endurance', 'weight_loss', 'health']),
    equipment_fit: equip(s, 'cardio'),
    time_fit: timeFit(s, 30),
    recovery_fit: Math.max(recovery(s), 0.6), // easy aerobic work tolerates fatigue
    adherence_fit: adherence(s),
    movement_balance_need: balanceNeed(s, ['locomotion']),
    pain_conflict: painConflict(s, ['locomotion']),
    fatigue_conflict: Math.min(systemicFatigue(s), 0.4), // low-stress base work
  }),
  cardio_intervals: (s) => ({
    profile_match: profileAxis(s, 'cardio'),
    // Intervals need an explicit intensity intent (§4 "intensity intent"); without
    // it, base is preferred. With it, intervals out-matches base — UNLESS recovery
    // gates it (recovery_fit + fatigue_conflict below), which is the §8 downgrade.
    goal_match: s.cardio_intent === 'intervals' ? 1 : 0.4,
    equipment_fit: equip(s, 'cardio'),
    time_fit: timeFit(s, 35),
    recovery_fit: trainingRecovery(s, ['recent_hard_quality', 'legs_redlined']),
    adherence_fit: adherence(s),
    movement_balance_need: balanceNeed(s, ['locomotion']),
    pain_conflict: painConflict(s, ['locomotion']),
    fatigue_conflict: trainingFatigueConflict(s, ['recent_hard_quality', 'legs_redlined']),
  }),
  bodyweight_strength: (s) => ({
    profile_match: profileAxis(s, 'bodyweight'),
    goal_match: goalMatch(s, ['bodyweight', 'strength', 'relative_strength']),
    equipment_fit: equip(s, 'none'),
    time_fit: timeFit(s, 35),
    recovery_fit: s.deload_active ? 0 : trainingRecovery(s, ['upper_redlined']),
    adherence_fit: adherence(s),
    movement_balance_need: balanceNeed(s, ['push', 'pull', 'core']),
    pain_conflict: painConflict(s, ['push', 'pull']),
    fatigue_conflict: trainingFatigueConflict(s, ['upper_redlined']),
  }),
  circuit_conditioning: (s) => ({
    profile_match: Math.max(profileAxis(s, 'general_fitness'), profileAxis(s, 'bodyweight')),
    goal_match: goalMatch(s, ['conditioning', 'work_capacity', 'general_fitness']),
    equipment_fit: equip(s, 'none'),
    time_fit: timeFit(s, 25),
    recovery_fit: trainingRecovery(s, ['recent_hard_quality']),
    adherence_fit: adherence(s),
    movement_balance_need: balanceNeed(s, ['core', 'push', 'pull']),
    pain_conflict: painConflict(s, ['push', 'pull', 'lower']),
    fatigue_conflict: trainingFatigueConflict(s, ['recent_hard_quality']),
  }),
  skill_practice: (s) => ({
    profile_match: Math.max(profileAxis(s, 'strength'), profileAxis(s, 'bodyweight')) * 0.5,
    goal_match: b01(s.skill_goal_named) * (s.goals && s.goals.primary === 'skill' ? 1 : 0.6),
    equipment_fit: 1,
    time_fit: timeFit(s, 25),
    recovery_fit: trainingRecovery(s, []), // needs LOW residual fatigue for clean reps
    adherence_fit: adherence(s),
    movement_balance_need: 0.3,
    pain_conflict: 0,
    fatigue_conflict: systemicFatigue(s), // never under heavy systemic fatigue
  }),
  recovery_reload: (s) => {
    const fatiguedSignal = Math.max(
      systemicFatigue(s),
      b01(s.poor_sleep),
      b01(s.elevated_fatigue),
      1 - recovery(s),
    );
    return {
      profile_match: 0.5, // fits any profile when fatigue is elevated
      goal_match: 0.5,
      equipment_fit: 1,
      time_fit: timeFit(s, 20),
      recovery_fit: fatiguedSignal,     // INVERTED: a fatigued state is exactly when this fits
      adherence_fit: Math.max(adherence(s), 0.6), // keeps the streak without digging a hole
      movement_balance_need: 0.3,
      pain_conflict: 0,
      fatigue_conflict: 0,              // it reduces, never stacks, fatigue
    };
  },
  deload: (s) => ({
    profile_match: 0.5,
    goal_match: 0.5,
    equipment_fit: 1,
    time_fit: 1,
    recovery_fit: b01(s.deload_active), // chosen when the deterministic trigger is active
    adherence_fit: 0.6,
    movement_balance_need: 0.3,
    pain_conflict: 0,
    fatigue_conflict: 0,                // the objective IS fatigue management
  }),
};

/**
 * Compute the feature vector for one objective from the snapshot. Returns null for
 * an unknown objective.
 */
function featuresFor(objective, snapshot) {
  const fn = FEATURES[objective];
  if (!fn) return null;
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return fn(s);
}

/**
 * Score and rank every session objective for a planning snapshot.
 *
 * @param {object} snapshot  normalized planning signals (see module header)
 * @returns {{ selected: {objective,score,contributions}|null,
 *             ranked: Array<{objective,score,features,contributions}> }}
 */
function scoreObjectives(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const candidates = SESSION_OBJECTIVES.map((objective) => ({
    objective,
    features: featuresFor(objective, s),
  }));
  const ranked = candidates
    .map((c) => ({
      objective: c.objective,
      features: c.features,
      score: combineObjectiveScore(c.features),
      contributions: explainObjectiveScore(c.features),
    }))
    .sort((a, b) => b.score - a.score);
  const selected = selectObjective(candidates);
  return { selected, ranked };
}

module.exports = { scoreObjectives, featuresFor, FEATURES };
