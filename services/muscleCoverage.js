'use strict';

// Muscle-coverage map. Pattern-based, in the same spirit as liftRole.js.
// Pure functions, no I/O.
//
// Fixed taxonomy: 17 muscles. Nothing outside this set may appear in any
// primary or secondary array. See TAXONOMY below.
//
// Primary = the main training target(s) the lift is programmed *for*.
// Secondary = meaningful contributors that get real stimulus but aren't
//   *why* you'd program it. Isolation lifts may have an empty secondary.

const TAXONOMY = new Set([
  'chest', 'front_delts', 'side_delts', 'rear_delts', 'traps',
  'lats', 'upper_back', 'lower_back', 'biceps', 'triceps', 'forearms',
  'quads', 'hamstrings', 'glutes', 'calves', 'abs', 'obliques',
]);

const UNKNOWN = Object.freeze({ primary: [], secondary: [], needsReview: true });

// Ordered most-specific first so the first match wins.
const MUSCLE_MAP = [
  // Hammer Curls — before general curl
  {
    pattern: /hammer\s*curl/i,
    matchPattern: 'hammer_curl',
    primary: ['biceps', 'forearms'],
    secondary: [],
  },
  // Leg Curl (+ Single-Leg) — before general curl
  {
    pattern: /(?:single[\s-]*leg\s*)?leg\s*curl/i,
    matchPattern: 'leg_curl',
    primary: ['hamstrings'],
    secondary: [],
  },
  // Romanian Deadlift / RDL — before standard deadlift
  {
    pattern: /romanian\s*deadlift|\brdl\b/i,
    matchPattern: 'rdl',
    primary: ['hamstrings', 'glutes'],
    secondary: ['lower_back'],
  },
  // Deadlift (standard / sumo)
  {
    pattern: /\bdeadlift\b/i,
    matchPattern: 'deadlift',
    primary: ['glutes', 'hamstrings', 'lower_back'],
    secondary: ['traps', 'lats', 'forearms'],
  },
  // Incline press — before bench press
  {
    pattern: /incline\s*(?:db|dumbbell|barbell)?\s*press|incline\s*press/i,
    matchPattern: 'incline_press',
    primary: ['chest', 'front_delts'],
    secondary: ['triceps'],
  },
  // Overhead Press / OHP
  {
    pattern: /overhead\s*press|\bohp\b|military\s*press|standing\s*press|push\s*press/i,
    matchPattern: 'ohp',
    primary: ['front_delts', 'side_delts'],
    secondary: ['triceps', 'traps'],
  },
  // Bench Press (+ Machine variants)
  {
    pattern: /(?:machine\s*)?bench\s*press|\bbench\b/i,
    matchPattern: 'bench_press',
    primary: ['chest'],
    secondary: ['triceps', 'front_delts'],
  },
  // Back Squat and squat variants
  {
    pattern: /back\s*squat|front\s*squat|goblet\s*squat|\bsquat\b/i,
    matchPattern: 'squat',
    primary: ['quads', 'glutes'],
    secondary: ['hamstrings', 'lower_back'],
  },
  // Leg Press (linear / seated / single-leg)
  {
    pattern: /leg\s*press/i,
    matchPattern: 'leg_press',
    primary: ['quads', 'glutes'],
    secondary: ['hamstrings'],
  },
  // Leg Extension
  {
    pattern: /leg\s*ext(?:ension)?/i,
    matchPattern: 'leg_extension',
    primary: ['quads'],
    secondary: [],
  },
  // Dips (+ Weighted Dips)
  {
    pattern: /\bdips?\b/i,
    matchPattern: 'dips',
    primary: ['chest', 'triceps'],
    secondary: ['front_delts'],
  },
  // Seated Row — before barbell-row catch-all
  {
    pattern: /seated\s*(?:cable\s*)?row/i,
    matchPattern: 'seated_row',
    primary: ['lats', 'upper_back'],
    secondary: ['biceps', 'rear_delts'],
  },
  // Lat Pulldown
  {
    pattern: /lat\s*pull(?:down)?/i,
    matchPattern: 'lat_pulldown',
    primary: ['lats'],
    secondary: ['biceps'],
  },
  // Barbell / Bent Over Row (+ Reverse variants)
  {
    pattern: /(?:barbell|bent[\s-]*over|reverse[\s-]*bent[\s-]*over|pendlay|t[\s-]*bar)\s*row/i,
    matchPattern: 'barbell_row',
    primary: ['lats', 'upper_back'],
    secondary: ['biceps', 'rear_delts'],
  },
  // Face Pull
  {
    pattern: /face\s*pull/i,
    matchPattern: 'face_pull',
    primary: ['rear_delts', 'upper_back'],
    secondary: ['traps'],
  },
  // Lateral / Side Raise
  {
    pattern: /(?:lateral|side)\s*raise[s]?/i,
    matchPattern: 'lateral_raise',
    primary: ['side_delts'],
    secondary: [],
  },
  // Cable Crossover / Chest Fly / Pec Deck
  {
    pattern: /cable\s*cross(?:over)?|cable\s*fly|chest\s*fly|pec\s*deck/i,
    matchPattern: 'cable_crossover',
    primary: ['chest'],
    secondary: ['front_delts'],
  },
  // Shrugs
  {
    pattern: /\bshrug/i,
    matchPattern: 'shrugs',
    primary: ['traps'],
    secondary: [],
  },
  // Hanging Knee / Leg Raises
  {
    pattern: /hanging\s*(?:knee|leg)\s*raise[s]?/i,
    matchPattern: 'hanging_knee_raise',
    primary: ['abs'],
    secondary: ['obliques'],
  },
  // Dumbbell Side Bend
  {
    pattern: /side\s*bend/i,
    matchPattern: 'side_bend',
    primary: ['obliques'],
    secondary: [],
  },
  // General curl (dumbbell, barbell, cable, ez-bar…)
  // Must come after hammer curl and leg curl entries above.
  {
    pattern: /\bcurl\b/i,
    matchPattern: 'curl',
    primary: ['biceps'],
    secondary: [],
  },
];

// Returns { primary, secondary, needsReview, matchPattern? }.
// Unknown lifts → needsReview: true, empty arrays.
function musclesFor(liftName) {
  if (!liftName || typeof liftName !== 'string') return { ...UNKNOWN };
  const entry = MUSCLE_MAP.find(e => e.pattern.test(liftName));
  if (!entry) return { ...UNKNOWN };
  return {
    primary: [...entry.primary],
    secondary: [...entry.secondary],
    needsReview: false,
    matchPattern: entry.matchPattern,
  };
}

// Returns the subset of liftList whose muscle profile (primary or secondary)
// includes the given muscle. Unknown/needsReview lifts are excluded.
function liftsForMuscle(muscle, liftList) {
  if (!muscle || !Array.isArray(liftList)) return [];
  return liftList.filter(lift => {
    const result = musclesFor(lift);
    if (result.needsReview) return false;
    return result.primary.includes(muscle) || result.secondary.includes(muscle);
  });
}

module.exports = { musclesFor, liftsForMuscle, TAXONOMY };
