'use strict';

// Issue #1737 — Fable fix 11 (P1): PROPOSE_EDIT — model names the operation
// and row only; values from the athlete or dropped; athlete accepts a card.
//
// The Fable 5.2 re-audit findings (B-01 P1, B-04 P2, B-23 P3, #1706
// NEW-VARIANT): the model's PROPOSE_EDIT sets weight/reps/RIR the athlete
// never stated (athlete said 'really 140'; 410 was written to Log_Cleaned
// on Save), can delete_set an athlete-logged set out of the approved write,
// and a mid-session add_set plants an exercise-less row that blocks closeout.
// The server checked range only and the client applied with no accept step.
//
//   resolveProposeEdit(edit, athleteMessage, previewRows) → resolved edit | null
//
// - A model proposal may identify the operation and the row ONLY. Every
//   value in the resolved edit is extracted deterministically from the
//   athlete's own message (extractAthleteValues); model-supplied
//   weight/reps/RIR are discarded, never trusted — the same discipline as
//   planEditResolver (#1707), where the deterministic planner re-resolves
//   every prescription field.
// - `update_set`: the index must name a row in the preview the client sent
//   as context; the resolved edit carries only athlete-stated fields. No
//   athlete-stated value → the whole edit is null (fail closed).
// - `delete_set`: identity-only — no values exist to re-resolve, so the
//   operation + validated index pass through unchanged (like
//   planEditResolver's remove_exercises). The athlete accept card on the
//   client is its guard (B-plan-1); a bad index is dropped here.
// - `add_set`: values from the athlete message or dropped; dropped outright
//   when the preview is empty, because the client attaches the new set to
//   the last preview row's exercise — with no row there is no exercise,
//   and the planted exercise-less row blocks closeout (B-write-4).
// - Anything else (unknown action, malformed shape, out-of-range value)
//   → null.
//
// Pure — no I/O, no LLM, no Sheets, no write. The schema + bounds checks
// mirror services/coach.isValidEditSchema / editNumbersValid so this module
// stays importable from route tests that stub services/coach.

const NUM = '(\\d+(?:\\.\\d+)?)';

// Extract weight/reps/RIR the ATHLETE stated in their own message.
// Deterministic, conservative: only the patterns below count as stated.
// - "140x8" / "140 x 8" / "235×5" → weight + reps.
// - "140 lb" / "137.5 pounds" → weight.
// - "8 reps" → reps.
// - "rir 2" / "rir: 2" → rir.
// - Correction shorthand — "really 140", "actually 140", "change set 1 to
//   235", "make it 140": a single stated number read as the load. The
//   audit pins "really 140" → weight 140; athletes correcting reps say
//   "8 reps", which the reps pattern claims first, so the shorthand never
//   steals a number already claimed as reps/RIR.
// A number outside the sane rule-engine bounds (weight 0..2000, reps int
// 1..100, rir 0..10) is dropped, not carried.
function extractAthleteValues(message) {
  const text = String(message || '').toLowerCase();
  const values = {};
  let m = text.match(new RegExp(`${NUM}\\s*[x×]\\s*(\\d+)`));
  if (m) {
    values.weight = Number(m[1]);
    values.reps = Number(m[2]);
  }
  m = text.match(new RegExp(`${NUM}\\s*(?:lb|lbs|pounds?)\\b`));
  if (m && values.weight === undefined) values.weight = Number(m[1]);
  m = text.match(/(\d+)\s*reps?\b/);
  if (m && values.reps === undefined) values.reps = Number(m[1]);
  m = text.match(/rir\s*(?:of|:|=)?\s*(\d+(?:\.\d+)?)/);
  if (m && values.rir === undefined) values.rir = Number(m[1]);
  if (values.weight === undefined) {
    m = text.match(/(?:really|actually|meant|should be|was|it was|to|at)\s+(\d+(?:\.\d+)?)\b/);
    // Never steal a number already claimed as reps/RIR ("that was 8 reps").
    if (m && Number(m[1]) !== values.reps && Number(m[1]) !== values.rir) {
      values.weight = Number(m[1]);
    }
  }
  if (values.weight !== undefined && !(values.weight > 0 && values.weight <= 2000)) delete values.weight;
  if (values.reps !== undefined && !(Number.isInteger(values.reps) && values.reps >= 1 && values.reps <= 100)) delete values.reps;
  if (values.rir !== undefined && !(values.rir >= 0 && values.rir <= 10)) delete values.rir;
  return values;
}

// Structural schema check + numeric bounds. Mirrors
// services/coach.isValidEditSchema: update_set / delete_set need a valid
// index; add_set needs no index; a present value must be finite and within
// sane rule-engine bounds.
function isValidEditSchema(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const numbersValid = (o) => {
    if (o.weight !== null && o.weight !== undefined && !(Number.isFinite(o.weight) && o.weight > 0 && o.weight <= 2000)) return false;
    if (o.reps !== null && o.reps !== undefined && !(Number.isInteger(o.reps) && o.reps >= 1 && o.reps <= 100)) return false;
    if (o.rir !== null && o.rir !== undefined && !(Number.isFinite(o.rir) && o.rir >= 0 && o.rir <= 10)) return false;
    return true;
  };
  if (obj.action === 'update_set') {
    return Number.isInteger(obj.index) && obj.index >= 0 && numbersValid(obj);
  }
  if (obj.action === 'delete_set') {
    return Number.isInteger(obj.index) && obj.index >= 0;
  }
  if (obj.action === 'add_set') {
    return numbersValid(obj);
  }
  return false;
}

function resolveProposeEdit(edit, athleteMessage, previewRows) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return null;
  if (!isValidEditSchema(edit)) return null;
  const rows = Array.isArray(previewRows) ? previewRows : [];
  if (edit.action === 'update_set' || edit.action === 'delete_set') {
    if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= rows.length) return null;
  }
  if (edit.action === 'update_set') {
    const values = extractAthleteValues(athleteMessage);
    if (values.weight === undefined && values.reps === undefined && values.rir === undefined) return null;
    const resolved = { action: 'update_set', index: edit.index };
    if (values.weight !== undefined) resolved.weight = values.weight;
    if (values.reps !== undefined) resolved.reps = values.reps;
    if (values.rir !== undefined) resolved.rir = values.rir;
    return resolved;
  }
  if (edit.action === 'delete_set') {
    return { action: 'delete_set', index: edit.index };
  }
  if (edit.action === 'add_set') {
    if (!rows.length) return null;
    const values = extractAthleteValues(athleteMessage);
    if (values.weight === undefined && values.reps === undefined && values.rir === undefined) return null;
    const resolved = { action: 'add_set' };
    if (values.weight !== undefined) resolved.weight = values.weight;
    if (values.reps !== undefined) resolved.reps = values.reps;
    if (values.rir !== undefined) resolved.rir = values.rir;
    return resolved;
  }
  return null;
}

module.exports = { resolveProposeEdit, extractAthleteValues };
