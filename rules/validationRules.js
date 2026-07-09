'use strict';

// Validation rules — hard bounds, rejected at the gate before any sheet write.
// Works on normalized log row objects ({ weight, reps, rir, exercise, ... }).
// Effort metrics already have bounds in index.js (validateNumberField); these
// cover the set rows, which previously had no plausibility checks at all.

const BOUNDS = {
  // weight allows fractional values (micro-plates, 2.5 lb jumps); reps must be a
  // whole number — a fractional rep count (e.g. 3.7) is impossible and, without
  // this guard, rode straight into the written row (range-checked but not integer-
  // checked, unlike set_number). rir stays range-only (half-RIR is plausible).
  weight: { min: 0, max: 1500, label: 'lbs' },
  reps:   { min: 1, max: 100,  label: 'reps', integer: true },
  rir:    { min: 0, max: 10,   label: 'RIR' },
};

// Longest believable exercise name. Real names are well under this ("Barbell
// Bench Press" ≈ 19 chars); a 500-char blob is malformed input that should never
// reach a sheet cell.
const MAX_EXERCISE_NAME_LENGTH = 120;

// Maximum believable e1RM increase vs the previous session best (typo guard).
const E1RM_JUMP_MAX_PCT = 0.15;

function checkBound(field, value) {
  const b = BOUNDS[field];
  if (!b) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { field, error: `${field} must be a number, got: ${JSON.stringify(value)}` };
  }
  if (n < b.min || n > b.max) {
    return { field, error: `${field} must be ${b.min}–${b.max} ${b.label}, got: ${n}` };
  }
  if (b.integer && !Number.isInteger(n)) {
    return { field, error: `${field} must be a whole number, got: ${n}` };
  }
  return null;
}

// Validate a single normalized log row. Returns [] when valid.
// weight of 0 is allowed (bodyweight exercises); blank rir is allowed
// (absence of RIR is signal, not an error).
function validateLogRowBounds(row) {
  if (!row || typeof row !== 'object') return [];
  const errors = [];

  if (row.weight !== undefined && row.weight !== null && row.weight !== '') {
    const e = checkBound('weight', row.weight);
    if (e) errors.push(e);
  }
  if (row.reps !== undefined && row.reps !== null && row.reps !== '') {
    const e = checkBound('reps', row.reps);
    if (e) errors.push(e);
  }
  if (row.rir !== undefined && row.rir !== null && row.rir !== '') {
    const e = checkBound('rir', row.rir);
    if (e) errors.push(e);
  }

  // set_number must be a positive integer. Weight/reps had bounds but set_number
  // did not, so a negative or fractional set index (e.g. -5) rode straight into
  // the written row. Sets are 1-indexed; cap at a sane upper bound.
  if (row.set_number !== undefined && row.set_number !== null && row.set_number !== '') {
    const n = Number(row.set_number);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      errors.push({ field: 'set_number', error: `set_number must be an integer 1–100, got: ${JSON.stringify(row.set_number)}` });
    }
  }

  // exercise name length — an unbounded name (500-char blob) is malformed input,
  // not a real lift. Presence/emptiness is already enforced upstream; here we only
  // reject an implausibly long value so it can never land in a sheet cell.
  if (typeof row.exercise === 'string' && row.exercise.length > MAX_EXERCISE_NAME_LENGTH) {
    errors.push({ field: 'exercise', error: `exercise name must be ≤${MAX_EXERCISE_NAME_LENGTH} characters, got ${row.exercise.length}` });
  }

  return errors;
}

// Validate every row in a batch; returns [{ row_index, field, error }] flat list.
// Degrades safely on malformed input (non-array, null, etc).
function validateLogRowsBounds(rows) {
  if (!Array.isArray(rows)) return [];
  const all = [];
  rows.forEach((row, i) => {
    for (const e of validateLogRowBounds(row)) {
      all.push({ row_index: i, ...e });
    }
  });
  return all;
}

// Typo guard: e1RM for a new set jumping >15% above the lift's previous
// session best almost always means a mistyped weight. Returns a warning
// object (not a rejection — the lifter may genuinely have PR'd).
function checkE1rmJump(newBestE1rm, previousBestE1rm) {
  if (!previousBestE1rm || previousBestE1rm <= 0 || !newBestE1rm) return null;
  const pct = (newBestE1rm - previousBestE1rm) / previousBestE1rm;
  if (pct > E1RM_JUMP_MAX_PCT) {
    return {
      field: 'e1rm',
      warning: `Estimated 1RM jumped ${(pct * 100).toFixed(1)}% vs last session (threshold ${E1RM_JUMP_MAX_PCT * 100}%) — double-check the weight`,
      pct: Math.round(pct * 1000) / 1000,
    };
  }
  return null;
}

module.exports = { validateLogRowBounds, validateLogRowsBounds, checkBound, checkE1rmJump, BOUNDS, E1RM_JUMP_MAX_PCT, MAX_EXERCISE_NAME_LENGTH };
