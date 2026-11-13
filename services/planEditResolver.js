'use strict';

// Issue #1707 — model-proposed plan edits bypass the deterministic planner
// (Astra boundary audit, 6 CONFIRMED P1s; probe D_PLAN_MODEL_TO_USER).
//
// A model PROPOSE_PLAN_EDIT may identify a requested operation only. The
// model-selected exercise name is a REQUEST; exercise choice and every
// prescription field are resolved here, from the athlete's logged history,
// before the edit reaches the client. Model-supplied weight/reps/sets/RIR
// (and any model-supplied lift code) are discarded, never trusted. The
// model-supplied plan label is likewise discarded (Fable fix 3, #1729) —
// the resolved edit carries no label and the client falls back to the
// deterministic 'Coach plan' for the session banner.
//
// Fable fix 14 (#1739): the prescription comes from the SAME decision path
// /api/recommend/next serves — `recommendNextSet` for weight/reps/RIR,
// the route's deload overlay (an active deload cuts the load by the
// protocol's load_multiplier and takes the protocol's target RIR), and the
// saved avoid rules from the Constraints tab (a `preference / avoid` rule
// naming the lift drops it). Before this fix the resolver used
// `prescribeLift` — a second deterministic decider that disagreed with
// recommendNextSet (185x9 RIR 3 vs 185x8 RIR 2 on the same history) — and
// took no deload or constraints input at all.
//
//   resolvePlanEdit(edit, logRows, asOf, opts) → resolved edit | null
//
// - `add_exercises` / `replace_plan`: each proposed exercise resolves its
//   lift code from the name (history rows first, then the catalog override
//   table) and its prescription from `recommendNextSet` — the same engine
//   the Next card uses. An exercise with no next target drops. When nothing
//   resolves, the whole edit is null: fail closed, the prose suggestion
//   still stands.
// - `remove_exercises`: identity-only — no prescription fields are involved
//   and the client already no-ops unknown names against the live plan — so
//   it passes through unchanged.
// - Anything else (unknown action, malformed shape, no asOf) → null.
// - `opts.deload`: the evaluated deload decision, in either shape the
//   engine produces — the resolved `evaluateCurrentDeload` shape
//   ({ in_deload, protocol }) or the raw persisted state
//   ({ training_state: 'DELOAD_ACTIVE', deload_protocol }). Absent → no
//   overlay. `{ evaluationFailed: true }` means the caller could not
//   evaluate the deload (e.g. a damaged Deload_State row): add/replace
//   fail closed (null) rather than prescribe full load during a possible
//   deload; removes still pass through (identity-only).
// - `opts.constraints`: raw Constraints-tab rows (positional arrays or
//   {date,kind,target,rule,note} objects). A `preference / avoid` rule
//   naming the lift excludes it, via `resolveConstraints` — the same merge
//   the Session Generator consumes. `limit` rows are ignored in v1 (same
//   as resolveConstraints); injury/equipment rows map to patterns/enums,
//   not exercises, and are not evaluated here.
//
// Pure — no I/O, no LLM, no Sheets, no write. Consumes 12-col positional
// Log_Cleaned rows (as delivered by getSheetRows / the chat route's allLog).

const { recommendNextSet } = require('./analytics');
const { computePrescription, PROTOCOLS } = require('./deloadProtocols');
const { resolveConstraints } = require('./constraintResolver');
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
// code recommendNextSet needs is the code the history actually carries). A name
// with no history falls back to the catalog override table (aliases and
// shorthands included, e.g. "RDL" → RDL01); recommendNextSet then still returns
// no target without rows, and the exercise drops. A name that matches neither is
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

// Saved avoid rules as a normalized-name set, via resolveConstraints — the
// same merge the Session Generator consumes (kind=preference, rule=avoid →
// exclude_exercises). Malformed input or a resolver failure yields no
// exclusions rather than dropping the edit.
function excludedExerciseKeys(constraintRows) {
  const out = new Set();
  if (!Array.isArray(constraintRows) || !constraintRows.length) return out;
  let resolved = null;
  try { resolved = resolveConstraints({ stored: constraintRows }); } catch { return out; }
  const list = resolved && resolved.constraints
    && Array.isArray(resolved.constraints.exclude_exercises)
    ? resolved.constraints.exclude_exercises : [];
  for (const name of list) {
    const key = normalizeExerciseKey(name);
    if (key) out.add(key);
  }
  return out;
}

// Resolve the deload overlay for one working weight, mirroring
// /api/recommend/next and buildSession: accept either the resolved
// evaluateCurrentDeload shape ({ in_deload, protocol }) or the raw persisted
// state ({ training_state: 'DELOAD_ACTIVE', deload_protocol }). Returns
// { weight, target_rir } or null when no overlay applies.
function deloadPrescriptionFor(deload, workingWeight) {
  if (!deload || typeof deload !== 'object') return null;
  const active = deload.in_deload === true || deload.training_state === 'DELOAD_ACTIVE';
  if (!active) return null;
  const protocol = (deload.protocol && typeof deload.protocol === 'object')
    ? deload.protocol
    : (typeof deload.deload_protocol === 'string' ? PROTOCOLS[deload.deload_protocol] : null);
  if (!protocol) return null;
  let pr = null;
  try { pr = computePrescription(protocol, { working_weight: workingWeight }); } catch { pr = null; }
  if (!pr || typeof pr.weight !== 'number' || typeof pr.target_rir !== 'number') return null;
  return { weight: pr.weight, target_rir: pr.target_rir };
}

function resolvePlanEdit(edit, logRows, asOf, opts) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return null;
  if (!Array.isArray(edit.exercises) || !edit.exercises.length) return null;
  const action = edit.action;
  // Identity-only operation: no prescription fields exist to re-resolve.
  if (action === 'remove_exercises') return edit;
  if (action !== 'add_exercises' && action !== 'replace_plan') return null;

  const options = opts && typeof opts === 'object' ? opts : {};
  // A failed deload evaluation means the prescription cannot be trusted —
  // an active deload would be missed and full load prescribed. Fail the
  // edit closed; the chat reply's prose still stands.
  if (options.deload && options.deload.evaluationFailed === true) return null;
  // No asOf means no prescription — fail closed (same as the prescribeLift
  // path before this fix, which required asOf for its history window).
  if (!asOf) return null;

  const rows = Array.isArray(logRows) ? logRows : [];
  const excluded = excludedExerciseKeys(options.constraints);
  const resolved = [];
  for (const raw of edit.exercises) {
    const name = _nameOf(raw);
    if (!name) continue;
    const liftCode = resolveLiftCode(name, rows);
    if (!liftCode) continue;
    // Fable fix 14 (#1739): the prescription comes from recommendNextSet —
    // the same deterministic engine /api/recommend/next serves — so a plan
    // edit can no longer disagree with the Next card for the same lift and
    // history. A lift with no next target drops (fail closed).
    let rec = null;
    try { rec = recommendNextSet(rows, liftCode, { today: asOf }); } catch { rec = null; }
    const target = rec && rec.next_target;
    if (!target || !Number.isFinite(Number(target.weight)) || Number(target.weight) < 0
      || !Number.isFinite(Number(target.reps))) continue;
    const canonicalName = canonicalNameFor(liftCode, rows, name);
    // A saved avoid rule excludes the lift — match on the canonical name
    // the athlete's log uses, or the proposed name (a shorthand resolves
    // to the same canonical lift, so the avoid still applies).
    if (excluded.has(normalizeExerciseKey(canonicalName))
      || excluded.has(normalizeExerciseKey(name))) continue;
    let weight = Number(target.weight);
    const reps = Number(target.reps);
    let rir = Number.isFinite(Number(rec.target_rir)) ? Number(rec.target_rir) : DEFAULT_TARGET_RIR;
    const sets = Number.isFinite(Number(target.sets)) && Number(target.sets) > 0
      ? Number(target.sets) : DEFAULT_SETS;
    // Deload overlay — the same cut /api/recommend/next applies: on an
    // active deload, scale the working weight by the protocol's
    // load_multiplier and take the protocol's target RIR. Weight + RIR
    // only — the set count is untouched.
    const deloadPrescription = deloadPrescriptionFor(options.deload, weight);
    if (deloadPrescription) {
      weight = deloadPrescription.weight;
      rir = deloadPrescription.target_rir;
    }
    resolved.push({
      name: canonicalName,
      canonicalName,
      liftCode,
      weight,
      reps,
      sets,
      rir,
    });
  }
  if (!resolved.length) return null;
  // Fable fix 3 (#1729): the model-supplied plan label is discarded here —
  // it reached the session banner verbatim with invented numbers
  // ('Deadlift 317x13 PR day - 7 sets'). The resolved edit carries no label;
  // the client falls back to the deterministic 'Coach plan'.
  return { action, exercises: resolved };
}

module.exports = { resolvePlanEdit, resolveLiftCode };
