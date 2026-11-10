'use strict';

// Issue #1707 — model-proposed plan edits bypass the deterministic planner
// (Astra boundary audit, 6 CONFIRMED P1s; probe D_PLAN_MODEL_TO_USER).
//
// A model PROPOSE_PLAN_EDIT may identify a requested operation only. The
// model-selected exercise name is a REQUEST; exercise choice and every
// prescription field are resolved here, from the athlete's logged history,
// before the edit reaches the client. Model-supplied weight/reps/sets/RIR
// (and any model-supplied lift code) are discarded, never trusted.
//
//   resolvePlanEdit(edit, logRows, asOf) → resolved edit | null
//
// - `add_exercises` / `replace_plan`: each proposed exercise resolves its
//   lift code from the name (history rows first, then the catalog override
//   table) and its prescription from `prescribeLift` — the same deterministic
//   planner the Session Generator uses. Sets/RIR are the planner's plan-shape
//   defaults (DEFAULT_SETS / DEFAULT_TARGET_RIR, shared with the Session
//   Generator). An exercise the planner cannot prescribe — no history, too
//   thin a trend, unlogged RIR — is dropped. When nothing resolves, the
//   whole edit is null: fail closed, the prose suggestion still stands.
// - `remove_exercises`: identity-only — no prescription fields are involved
//   and the client already no-ops unknown names against the live plan — so
//   it passes through unchanged.
// - Anything else (unknown action, malformed shape) → null.
//
// Pure — no I/O, no LLM, no Sheets, no write. Consumes 12-col positional
// Log_Cleaned rows (as delivered by getSheetRows / the chat route's allLog).

const { prescribeLift } = require('./liftPrescription');
const { canonicalLiftCodeFor, normalizeExerciseKey } = require('./exerciseEnrichment');
const { DEFAULT_SETS, DEFAULT_TARGET_RIR } = require('./sessionGenerator');

// 12-col row: date|session|exercise|canonical|muscle|lift_code|set|weight|reps|rir|notes|vol
const COL_EXERCISE = 2;
const COL_CANONICAL = 3;
const COL_LIFT_CODE = 5;

function _nameOf(raw) {
  if (typeof raw === 'string') return raw.trim();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  if (typeof raw.name === 'string' && raw.name.trim()) return raw.name.trim();
  if (typeof raw.exercise === 'string' && raw.exercise.trim()) return raw.exercise.trim();
  return '';
}

// Resolve the lift code for a proposed name. History rows are the authority:
// a name the athlete has logged resolves to the code on those rows (so the
// code prescribeLift needs is the code the history actually carries). A name
// with no history falls back to the catalog override table (aliases and
// shorthands included, e.g. "RDL" → RDL01); prescribeLift then still returns
// null without rows, and the exercise drops. A name that matches neither is
// unresolvable → null.
function resolveLiftCode(name, rows) {
  const key = normalizeExerciseKey(name);
  if (!key) return null;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const canonical = typeof row[COL_CANONICAL] === 'string' ? row[COL_CANONICAL] : '';
    const exercise = typeof row[COL_EXERCISE] === 'string' ? row[COL_EXERCISE] : '';
    if ((canonical && normalizeExerciseKey(canonical) === key)
      || (exercise && normalizeExerciseKey(exercise) === key)) {
      const code = String(row[COL_LIFT_CODE] || '').toUpperCase().trim();
      if (code) return code;
    }
  }
  return canonicalLiftCodeFor(name);
}

// Canonical display name for a resolved code: the history row's canonical
// exercise (the name the athlete's own log uses), or the proposed name when
// the code came from the catalog and no row carries it.
function canonicalNameFor(liftCode, rows, fallbackName) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    if (String(row[COL_LIFT_CODE] || '').toUpperCase().trim() !== liftCode) continue;
    const canonical = typeof row[COL_CANONICAL] === 'string' ? row[COL_CANONICAL].trim() : '';
    if (canonical) return canonical;
  }
  return fallbackName;
}

function resolvePlanEdit(edit, logRows, asOf) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return null;
  if (!Array.isArray(edit.exercises) || !edit.exercises.length) return null;
  const action = edit.action;
  // Identity-only operation: no prescription fields exist to re-resolve.
  if (action === 'remove_exercises') return edit;
  if (action !== 'add_exercises' && action !== 'replace_plan') return null;

  const rows = Array.isArray(logRows) ? logRows : [];
  const resolved = [];
  for (const raw of edit.exercises) {
    const name = _nameOf(raw);
    if (!name) continue;
    const liftCode = resolveLiftCode(name, rows);
    if (!liftCode) continue;
    let prescription = null;
    try { prescription = prescribeLift(rows, liftCode, asOf, {}); } catch { prescription = null; }
    if (!prescription || typeof prescription.targetWeight !== 'number'
      || typeof prescription.targetReps !== 'number') continue;
    const canonicalName = canonicalNameFor(liftCode, rows, name);
    resolved.push({
      name: canonicalName,
      canonicalName,
      liftCode,
      weight: prescription.targetWeight,
      reps: prescription.targetReps,
      sets: DEFAULT_SETS,
      rir: DEFAULT_TARGET_RIR,
    });
  }
  if (!resolved.length) return null;
  const out = { action, exercises: resolved };
  if (action === 'replace_plan' && typeof edit.label === 'string' && edit.label.trim()) {
    out.label = edit.label.trim();
  }
  return out;
}

module.exports = { resolvePlanEdit, resolveLiftCode };
