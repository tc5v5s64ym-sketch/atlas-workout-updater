'use strict';

// StarterProgramModule — deterministic template runner for beginner starter programs.
//
// Roadmap PR 7 (Phase 2): StrongLifts 5×5 + GZCLP as structured JSON data
// plus a pure deterministic session-prescription builder.
//
// Prime directive: the engine computes all weights; the LLM only words them.
// Safe-ladder position: prescription / data (roadmap Phase 2, PR 7).
// Depends on: config/coaching/programs/*.json
//
// Public API:
//   getProgram(programId)            → program config | null
//   listPrograms()                   → [{ id, name }]
//   buildNextSession(programId, state) → prescription | null
//
// State shapes (program-specific; unrecognised fields are ignored):
//
//   StrongLifts 5×5:
//     { sessionCount, currentWeights, consecutiveFails }
//     currentWeights:     { [liftCode]: number | null }  — null → program default
//     consecutiveFails:   { [liftCode]: number }          — default 0
//
//   GZCLP:
//     { sessionCount, currentWeights, t2Weights, t1Tiers, consecutiveFails }
//     currentWeights:   { [liftCode]: number | null }  — T1 weights; null → program default
//     t2Weights:        { [liftCode]: number | null }  — T2 weights; null → program t2 default
//     t1Tiers:          { [liftCode]: number }          — 0=5×3+, 1=6×2+, 2=10×1+; default 0
//     consecutiveFails: { [liftCode]: number }          — T2 consecutive fails; default 0
//
// Prescription return shape (both programs):
//   {
//     programId:     string,
//     sessionLabel:  string,
//     cyclePosition: number,   — 0-based index within the program cycle
//     exercises: [{
//       exerciseId:      string,
//       liftCode:        string,
//       sets:            number,
//       reps:            number,
//       repsScheme:      'fixed' | 'amrap',
//       targetWeight:    number,   — in lb; 0 = bodyweight/unloaded
//       bodyRegion:      string,
//       tier:            string | null,   — 'T1'|'T2'|'T3' (GZCLP) or null (SL5×5)
//       progressionNote: string,
//     }]
//   }

const path = require('node:path');
const fs   = require('node:fs');

const PROGRAMS_DIR = path.join(__dirname, '..', 'config', 'coaching', 'programs');

// ─── Program loading ──────────────────────────────────────────────────────────

const _cache = new Map();

function _loadProgram(programId) {
  if (_cache.has(programId)) return _cache.get(programId);
  const filePath = path.join(PROGRAMS_DIR, `${programId}.json`);
  if (!fs.existsSync(filePath)) { _cache.set(programId, null); return null; }
  try {
    const program = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    _cache.set(programId, program);
    return program;
  } catch {
    _cache.set(programId, null);
    return null;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Normalise state: fill in missing sub-objects so downstream code can rely on them.
function _normaliseState(state) {
  const s = state != null && typeof state === 'object' ? state : {};
  return {
    sessionCount:     Number.isFinite(Number(s.sessionCount)) ? Math.max(0, Math.floor(Number(s.sessionCount))) : 0,
    currentWeights:   s.currentWeights  != null && typeof s.currentWeights  === 'object' ? s.currentWeights  : {},
    t2Weights:        s.t2Weights       != null && typeof s.t2Weights       === 'object' ? s.t2Weights       : {},
    t1Tiers:          s.t1Tiers         != null && typeof s.t1Tiers         === 'object' ? s.t1Tiers         : {},
    consecutiveFails: s.consecutiveFails!= null && typeof s.consecutiveFails=== 'object' ? s.consecutiveFails: {},
  };
}

// Round a weight to the nearest 5 lb increment (minimum 45 lb — empty barbell).
function _round5(weight) {
  return Math.max(45, Math.round(weight / 5) * 5);
}

// ─── StrongLifts 5×5 builder ──────────────────────────────────────────────────

function _buildSL5x5(program, state) {
  const { sessionCount, currentWeights, consecutiveFails } = state;
  const cyclePos = sessionCount % program.cycle_length;
  const template = program.sessions[cyclePos];
  const prog     = program.progression;
  const starts   = program.start_weights_lb;

  const exercises = template.exercises.map(ex => {
    const liftCode     = ex.lift_code;
    const region       = ex.body_region;
    const increment    = prog.success_increment_lb[region === 'lower_body' ? 'lower_body' : 'upper_body'];
    const stalls       = Number(consecutiveFails[liftCode]) || 0;
    const rawWeight    = currentWeights[liftCode] ?? null;
    const startWeight  = starts[liftCode] ?? 45;

    let targetWeight;
    let progressionNote;

    if (rawWeight === null) {
      targetWeight    = startWeight;
      progressionNote = 'start weight';
    } else if (stalls >= prog.fail_handling.consecutive_fails_before_deload) {
      targetWeight    = Math.min(rawWeight, _round5(rawWeight * (1 - prog.fail_handling.deload_pct / 100)));
      progressionNote = `deload ${prog.fail_handling.deload_pct}%`;
    } else if (stalls > 0) {
      targetWeight    = rawWeight;
      progressionNote = `hold — stall ${stalls}/${prog.fail_handling.consecutive_fails_before_deload}`;
    } else {
      targetWeight    = rawWeight + increment;
      progressionNote = `increase ${increment} lb`;
    }

    return {
      exerciseId:      ex.exercise_id,
      liftCode,
      sets:            ex.sets,
      reps:            ex.reps,
      repsScheme:      ex.reps_scheme,
      targetWeight,
      bodyRegion:      region,
      tier:            null,
      progressionNote,
    };
  });

  return { programId: program.id, sessionLabel: template.label, cyclePosition: cyclePos, exercises };
}

// ─── GZCLP builder ───────────────────────────────────────────────────────────

function _buildGZCLP(program, state) {
  const { sessionCount, currentWeights, t2Weights, t1Tiers, consecutiveFails } = state;
  const cyclePos = sessionCount % program.cycle_length;
  const template = program.sessions[cyclePos];
  const prog     = program.progression;
  const starts   = program.start_weights_lb   || {};
  const t2Starts = program.t2_start_weights_lb || {};

  const exercises = template.exercises.map(ex => {
    const liftCode = ex.lift_code;
    const region   = ex.body_region;
    const tier     = ex.tier;

    if (tier === 'T1') {
      const tierIndex   = Math.min(Math.max(Number(t1Tiers[liftCode]) || 0, 0), prog.t1.max_tier);
      const tierConfig  = prog.t1.tiers[tierIndex];
      const increment   = prog.t1.success_increment_lb[region === 'lower_body' ? 'lower_body' : 'upper_body'];
      const rawWeight   = currentWeights[liftCode] ?? null;
      const startWeight = starts[liftCode] ?? 45;

      let targetWeight;
      let progressionNote;

      if (rawWeight === null) {
        targetWeight    = startWeight;
        progressionNote = 'start weight';
      } else if (tierIndex > 0) {
        // Currently on a stall tier: hold weight, work through the harder scheme
        targetWeight    = rawWeight;
        progressionNote = `hold — T1 tier ${tierIndex} (${tierConfig.sets}×${tierConfig.reps}+)`;
      } else {
        // Tier 0 (normal): add weight
        targetWeight    = rawWeight + increment;
        progressionNote = `increase ${increment} lb`;
      }

      return {
        exerciseId:      ex.exercise_id,
        liftCode,
        sets:            tierConfig.sets,
        reps:            tierConfig.reps,
        repsScheme:      tierConfig.reps_scheme,
        targetWeight,
        bodyRegion:      region,
        tier:            'T1',
        progressionNote,
      };
    }

    if (tier === 'T2') {
      const stalls      = Number(consecutiveFails[liftCode]) || 0;
      const inDeload    = stalls >= prog.t2.consecutive_fails_before_deload;
      // Deload resets to the base 4×6+ scheme (not the stall 4×10+ scheme) so
      // the lifter rebuilds from a lower weight at the normal rep range.
      const scheme      = (stalls > 0 && !inDeload) ? prog.t2.stall_scheme : prog.t2.normal_scheme;
      const increment   = prog.t2.success_increment_lb[region === 'lower_body' ? 'lower_body' : 'upper_body'];
      const rawWeight   = t2Weights[liftCode] ?? null;
      const startWeight = t2Starts[liftCode] ?? starts[liftCode] ?? 45;
      const deloadPct   = prog.t2.deload_pct / 100;

      let targetWeight;
      let progressionNote;

      if (rawWeight === null) {
        targetWeight    = startWeight;
        progressionNote = 'start weight';
      } else if (inDeload) {
        targetWeight    = Math.min(rawWeight, _round5(rawWeight * (1 - deloadPct)));
        progressionNote = `deload ${prog.t2.deload_pct}%`;
      } else if (stalls > 0) {
        targetWeight    = rawWeight;
        progressionNote = `hold — T2 stall (${scheme.sets}×${scheme.reps}+)`;
      } else {
        targetWeight    = rawWeight + increment;
        progressionNote = `increase ${increment} lb`;
      }

      return {
        exerciseId:      ex.exercise_id,
        liftCode,
        sets:            scheme.sets,
        reps:            scheme.reps,
        repsScheme:      scheme.reps_scheme,
        targetWeight,
        bodyRegion:      region,
        tier:            'T2',
        progressionNote,
      };
    }

    // T3 — fixed accessory; no weight progression tracking
    const rawWeight = currentWeights[liftCode] ?? t2Weights[liftCode] ?? null;
    const startWeight = starts[liftCode] ?? 0;

    return {
      exerciseId:      ex.exercise_id,
      liftCode,
      sets:            ex.sets,
      reps:            ex.reps,
      repsScheme:      ex.reps_scheme,
      targetWeight:    rawWeight ?? startWeight,
      bodyRegion:      region,
      tier:            'T3',
      progressionNote: 'accessory — no load progression',
    };
  });

  return { programId: program.id, sessionLabel: template.label, cyclePosition: cyclePos, exercises };
}

// ─── Dispatch table ───────────────────────────────────────────────────────────

const BUILDERS = {
  'stronglifts-5x5': _buildSL5x5,
  'gzclp':           _buildGZCLP,
};

// ─── Public API ───────────────────────────────────────────────────────────────

// Return the parsed program config for the given id, or null if not found.
function getProgram(programId) {
  if (typeof programId !== 'string' || !programId) return null;
  return _loadProgram(programId) ?? null;
}

// Return a list of all available programs as [{ id, name }].
function listPrograms() {
  let files;
  try {
    files = fs.readdirSync(PROGRAMS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  } catch { return []; }

  return files.flatMap(f => {
    const p = _loadProgram(f.replace(/\.json$/, ''));
    return p && p.id && p.name ? [{ id: p.id, name: p.name }] : [];
  });
}

// Build the prescription for the next session given a program id and program state.
// Returns null if programId is invalid, the program is unknown, or state is malformed.
function buildNextSession(programId, state) {
  if (typeof programId !== 'string' || !programId) return null;

  const program = _loadProgram(programId);
  if (!program) return null;

  const builder = BUILDERS[programId];
  if (!builder) return null;

  return builder(program, _normaliseState(state));
}

module.exports = { getProgram, listPrograms, buildNextSession };
