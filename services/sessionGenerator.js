'use strict';

// Session Generator — keystone #2 of the One-Brain engine.
//
// The Brian-native replacement for analytics.js::scoreIntents: composes the
// shipped modules into a full `workout` payload. Pure — no I/O, no LLM, no
// Sheets, no write; every number traces to an engine module (per-lift
// prescription, deload protocol). Selection/ordering policy lives here; the math
// lives in the modules it calls.
//
// Spec: docs/COACHING_SESSION_GENERATOR_SPEC.md
//
// buildSession(state, constraints) → { payload, explanation_inputs, why_today,
//   substitutions_applied, notes } | null   (null when no history-backed block
//   can be built — the Orchestrator degrades to clarification).
//
// v1 scope: history-backed lifts only (cold-start lifts are noted, deferred to
// onboardingSessionPlan). `sets` and non-deload `target_rir` are prescription
// defaults (BACKLOG: derive from goal/scenario); volume is surfaced as why_today
// facts (BACKLOG: full MRV-capping).

const { PATTERN_VARIANTS, CORE_PATTERNS, WIDEN_PATTERNS, DEFAULT_EQUIPMENT } = require('./onboardingSessionPlan');
const { normRow, prescribeLift } = require('./liftPrescription');

const DEFAULT_DURATION_MIN = 60;
const DEFAULT_SETS = 3;
const DEFAULT_TARGET_RIR = 2;
const MIN_PER_SET = 3.5;   // rough working-set time budget
const OVERHEAD_PER_BLOCK = 2;

// focus → the movement patterns to cover (patterns from PATTERN_VARIANTS).
const FOCUS_PATTERNS = Object.freeze({
  full_body:  [...CORE_PATTERNS],
  upper_body: ['horizontal_push', 'horizontal_pull', 'vertical_push', 'isolation'],
  lower_body: ['squat', 'hinge'],
  push:       ['horizontal_push', 'vertical_push'],
  pull:       ['horizontal_pull'],
  hinge:      ['hinge'],
  squat:      ['squat'],
  core:       ['isolation'],
});

// injury → movement patterns to avoid (conservative; a red flag is a separate
// safety-capability veto). Loaded patterns most implicated by the joint.
const INJURY_AVOID = Object.freeze({
  shoulder:   ['vertical_push', 'horizontal_push'],
  knee:       ['squat'],
  lower_back: ['hinge'],
  hip:        ['hinge', 'squat'],
  neck:       ['vertical_push'],
  elbow:      [],
  wrist:      [],
  ankle:      [],
});

function _label(focus) {
  const map = { full_body: 'Full Body', upper_body: 'Upper Body', lower_body: 'Lower Body',
    push: 'Push', pull: 'Pull', hinge: 'Hinge', squat: 'Squat', core: 'Core' };
  return map[focus] || 'Session';
}

function _selectVariant(pattern, equipmentSet) {
  const variants = PATTERN_VARIANTS[pattern] || [];
  return variants.find(v => equipmentSet.has(v.equipment)) || null;
}

function _findLiftCode(normalized, exerciseName) {
  const m = normalized.filter(o => o.canonical_exercise === exerciseName);
  return m.length ? m[m.length - 1].lift_code.trim().toUpperCase() : null;
}

function buildSession(state, constraints) {
  if (!state || typeof state !== 'object') return null;
  const rows = Array.isArray(state.log_history) ? state.log_history : [];
  const asOf = typeof state.asOf === 'string' ? state.asOf : null;
  const c = constraints && typeof constraints === 'object' ? constraints : {};

  const equipment = Array.isArray(c.equipment) && c.equipment.length ? c.equipment : DEFAULT_EQUIPMENT;
  const equipmentSet = new Set(equipment);
  const focus = typeof c.focus === 'string' && FOCUS_PATTERNS[c.focus] ? c.focus : 'full_body';
  const durationMin = Number.isFinite(c.duration_minutes) ? c.duration_minutes : DEFAULT_DURATION_MIN;
  const injury = typeof c.injury === 'string' ? c.injury : null;
  const exclude = new Set((Array.isArray(c.exclude_exercises) ? c.exclude_exercises : []).map(x => String(x).toLowerCase()));

  const patterns = FOCUS_PATTERNS[focus];
  const avoid = new Set(injury ? (INJURY_AVOID[injury] || []) : []);
  const normalized = rows.map(normRow).filter(o => o && o.date_clean && o.canonical_exercise);

  const notes = [];
  const substitutions_applied = [];
  const blocks = [];
  const eiBlocks = []; // explanation_inputs.blocks — built in lockstep with blocks

  for (const pattern of patterns) {
    if (avoid.has(pattern)) {
      substitutions_applied.push({ from: pattern, to: null, reason: `avoid loaded ${pattern} for ${injury}` });
      notes.push(`dropped ${pattern} (${injury})`);
      continue;
    }
    const variant = _selectVariant(pattern, equipmentSet);
    if (!variant) { notes.push(`no equipment variant for ${pattern}`); continue; }
    if (exclude.has(variant.exercise.toLowerCase())) { notes.push(`excluded ${variant.exercise}`); continue; }

    const liftCode = _findLiftCode(normalized, variant.exercise);
    if (!liftCode) { notes.push(`no history for ${variant.exercise} — needs calibration`); continue; }

    // injury is handled at the session level (avoided patterns are dropped above);
    // the remaining lifts prescribe normally — a knee issue must not turn every lift
    // into an injury_signal scenario.
    const p = asOf ? prescribeLift(rows, liftCode, asOf, {}) : null;
    if (!p || typeof p.targetWeight !== 'number') { notes.push(`no prescription for ${variant.exercise}`); continue; }

    const reps = typeof p.targetReps === 'number' ? p.targetReps : p.currentReps;
    blocks.push({
      exercise: variant.exercise, lift_code: liftCode, pattern,
      sets: DEFAULT_SETS, reps, target_weight: p.targetWeight, target_rir: DEFAULT_TARGET_RIR,
      scenario_id: p.scenario_id, source: 'brian', warmup: false,
    });
    eiBlocks.push({ target_weight: p.targetWeight, reps, target_rir: DEFAULT_TARGET_RIR });
  }

  if (!blocks.length) return null;

  // Duration fit: trim accessory (WIDEN) blocks from the end until it fits.
  const perBlock = b => b.sets * MIN_PER_SET + OVERHEAD_PER_BLOCK;
  const isAccessory = b => WIDEN_PATTERNS.includes(b.pattern);
  let total = blocks.reduce((s, b) => s + perBlock(b), 0);
  while (total > durationMin && blocks.some(isAccessory)) {
    let idx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) { if (isAccessory(blocks[i])) { idx = i; break; } }
    if (idx < 0) break;
    total -= perBlock(blocks[idx]);
    notes.push(`trimmed ${blocks[idx].exercise} to fit ${durationMin}min`);
    blocks.splice(idx, 1);
    eiBlocks.splice(idx, 1);
  }

  // Deload: apply the persisted protocol (load cut + RIR) when active.
  const deload = state.deload_state;
  if (deload && (deload.in_deload === true || deload.training_state === 'DELOAD_ACTIVE') && deload.protocol) {
    try {
      const { computePrescription } = require('./deloadProtocols');
      blocks.forEach((b, i) => {
        const pr = computePrescription(deload.protocol, { working_weight: b.target_weight });
        if (pr && typeof pr.weight === 'number') {
          b.target_weight = pr.weight;
          eiBlocks[i].target_weight = pr.weight;
          if (typeof pr.target_rir === 'number') { b.target_rir = pr.target_rir; eiBlocks[i].target_rir = pr.target_rir; }
        }
      });
      notes.push('deload protocol applied');
    } catch { /* deload is best-effort; never break the session */ }
  }

  // why_today: machine facts only (the coach voice words them downstream).
  const why_today = blocks.map(b => `${b.lift_code}:${b.scenario_id}`);

  const payload = {
    session_label: _label(focus),
    focus,
    target_duration_min: durationMin,
    blocks,
    why_today,
    substitutions_applied,
  };
  const explanation_inputs = { blocks: eiBlocks };

  return { payload, explanation_inputs, why_today, substitutions_applied, notes };
}

module.exports = { buildSession, FOCUS_PATTERNS, INJURY_AVOID };
