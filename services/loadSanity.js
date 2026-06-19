'use strict';

// Per-movement-class load sanity bounds.
// Purpose: prevent impossible prescriptions reaching the UI (e.g. 170 lb lateral raise).
// Ceilings are intentionally generous — they catch gross errors, not limit strong lifters.
//
// Golden invariant: lateral raises must never be prescribed above 100 lb.
//
// Pure function — no I/O, no LLM, no Sheets writes.

// Ordered most-specific first; first match wins.
const MOVEMENT_CEILINGS = [
  // Delt isolations: lateral raises, face pulls, rear delts, reverse flys
  {
    re: /(?:lat(?:eral)?|side)\s*raises?|face\s*pull|rear\s*delt|rear\s*fly|reverse\s*(?:pec\s*)?(?:deck|fly|flye)/i,
    ceiling: 100,
    label: 'delt_isolation',
  },
  // Core / abs
  {
    re: /(?:knee|leg)\s*raises?|crunch|sit[\s-]*up|plank|ab\s*wheel|hanging|oblique|side\s*bend/i,
    ceiling: 100,
    label: 'core',
  },
  // Leg isolation machines: leg curl, leg extension — before arm_isolation
  // (must precede the generic \bcurls?\b pattern or "Leg Curl" matches arm ceiling)
  {
    re: /leg\s*(?:curl|ext(?:ension)?)|hamstring\s*curl/i,
    ceiling: 400,
    label: 'leg_isolation',
  },
  // Arm isolations: curls (any variant), triceps
  {
    re: /\bcurls?\b|tricep|push[\s-]*down|kickback/i,
    ceiling: 200,
    label: 'arm_isolation',
  },
  // Chest isolation: flys, pec deck, cable crossovers
  {
    re: /chest\s*fly|pec\s*deck|cable\s*cross(?:over)?/i,
    ceiling: 200,
    label: 'chest_isolation',
  },
  // Calf raises (machine or standing)
  {
    re: /calf|calves/i,
    ceiling: 400,
    label: 'calf',
  },
  // Hip / glute isolation
  {
    re: /hip\s*thrust|glute\s*bridge|hip\s*abduct/i,
    ceiling: 600,
    label: 'hip_isolation',
  },
  // Shrugs
  {
    re: /\bshrugs?\b/i,
    ceiling: 600,
    label: 'shrug',
  },
  // Compound upper: bench, OHP, rows, pulldowns, dips, pull-ups
  {
    re: /bench|overhead\s*press|\bohp\b|military\s*press|incline|dips?\b|lat\s*pull|seated\s*row|cable\s*row|bent[\s-]*over\s*row|pull[\s-]*up|chin[\s-]*up/i,
    ceiling: 600,
    label: 'compound_upper',
  },
  // Leg press (plate-loaded machines can go very high)
  {
    re: /leg\s*press/i,
    ceiling: 1200,
    label: 'leg_press',
  },
  // Big barbell compounds: squat, deadlift, RDL
  {
    re: /\bsquat\b|\bdeadlift\b|\brdl\b|romanian/i,
    ceiling: 900,
    label: 'compound_lower',
  },
];

const DEFAULT_CEILING = 700;

// Returns the maximum plausible load (lb) for a given exercise name.
function movementCeilingFor(exerciseName) {
  if (!exerciseName || typeof exerciseName !== 'string') return DEFAULT_CEILING;
  for (const entry of MOVEMENT_CEILINGS) {
    if (entry.re.test(exerciseName)) return entry.ceiling;
  }
  return DEFAULT_CEILING;
}

// Returns true when the prescribed load is physically plausible for this exercise.
function isLoadPlausible(exerciseName, weight) {
  if (!Number.isFinite(weight) || weight <= 0) return false;
  return weight <= movementCeilingFor(exerciseName);
}

// Sanitize a prescribed load.
// When the load is plausible: returns { weight, sanitized: false }.
// When implausible: falls back to historyBest (the lifter's actual working weight)
// if available, or null if there is no history to fall back to.
//
// Return shape:
//   { weight, sanitized: false }
//   { weight, sanitized: true, originalWeight, reason }
function sanitizeLoad(exerciseName, weight, historyBest = null) {
  if (isLoadPlausible(exerciseName, weight)) {
    return { weight, sanitized: false };
  }

  const ceiling = movementCeilingFor(exerciseName);
  const reason = `Prescribed ${weight} lb exceeds movement-class ceiling (${ceiling} lb) for "${exerciseName || 'unknown'}"`;
  // Only use historyBest as fallback when it is itself within the plausible range.
  // If historyBest is also corrupt (e.g. the whole history was logged at 170 lb), clear it.
  const fallback = (Number.isFinite(historyBest) && historyBest > 0 && isLoadPlausible(exerciseName, historyBest))
    ? historyBest
    : null;

  return {
    weight: fallback,
    sanitized: true,
    originalWeight: weight,
    reason,
  };
}

module.exports = { movementCeilingFor, isLoadPlausible, sanitizeLoad };
