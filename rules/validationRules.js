'use strict';

// Validation rules — hard bounds, rejected at the gate before any sheet write.
// Works on normalized log row objects ({ weight, reps, rir, exercise, ... }).
// Effort metrics already have bounds in index.js (validateNumberField); these
// cover the set rows, which previously had no plausibility checks at all.

const BOUNDS = {
  weight: { min: 0, max: 1500, label: 'lbs' },
  reps:   { min: 1, max: 100,  label: 'reps' },
  rir:    { min: 0, max: 10,   label: 'RIR' },
};

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

module.exports = { validateLogRowBounds, validateLogRowsBounds, checkBound, checkE1rmJump, BOUNDS, E1RM_JUMP_MAX_PCT };
