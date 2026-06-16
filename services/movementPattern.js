'use strict';

// Movement-pattern map. Pattern-based, pure data.
// One primary movement pattern per lift, drawn from the 14-pattern vocabulary below.
//
// Consumed by the session builder's pairing/competition check (SESSION_DESIGN.md Rule A)
// to enforce anchor co-anchor rules (e.g. block Deadlift + RDL as co-anchors).
//
// Unknown lifts return { pattern: 'other', needsReview: true } — never a guess.

const VALID_PATTERNS = new Set([
  'squat', 'hinge',
  'horizontal_push', 'vertical_push',
  'horizontal_pull', 'vertical_pull',
  'knee_isolation', 'hip_isolation',
  'arm_isolation', 'delt_isolation',
  'calf_isolation', 'trunk', 'carry', 'other',
]);

// Unknown / unrecognised lift.
const UNKNOWN = { pattern: 'other', needsReview: true };

// Ordered most-specific first — first match wins.
const PATTERN_MAP = [
  // Leg Curl (Single-Leg variant) — before any generic curl rule
  {
    re: /(?:single[\s-]*leg\s*)?leg\s*curl/i,
    movement: 'knee_isolation',
  },
  // Leg Extension
  {
    re: /leg\s*ext(?:ension)?/i,
    movement: 'knee_isolation',
  },
  // Romanian Deadlift / RDL — before standard deadlift
  {
    re: /romanian\s*deadlift|\brdl\b/i,
    movement: 'hinge',
  },
  // Deadlift (standard / sumo)
  {
    re: /\bdeadlift\b/i,
    movement: 'hinge',
  },
  // Good Morning — hinge family
  {
    re: /good\s*morning/i,
    movement: 'hinge',
  },
  // Incline press — before bench press
  {
    re: /incline\s*(?:db|dumbbell|barbell|bench)?\s*press/i,
    movement: 'horizontal_push',
  },
  // Overhead Press / OHP / Military Press
  {
    re: /overhead\s*press|\bohp\b|military\s*press|standing\s*press|push\s*press/i,
    movement: 'vertical_push',
  },
  // Bench Press (includes Machine Bench Press)
  {
    re: /bench\s*press|\bbench\b/i,
    movement: 'horizontal_push',
  },
  // Dips — horizontal push family (same prime movers as bench; SESSION_DESIGN lists
  // dips as a bench fallback, not a vertical push like OHP)
  {
    re: /\bdips?\b/i,
    movement: 'horizontal_push',
  },
  // Cable Crossover / Chest Fly / Pec Deck — horizontal push family
  {
    re: /cable\s*cross(?:over)?|chest\s*fly|pec\s*deck/i,
    movement: 'horizontal_push',
  },
  // Back Squat and all squat variants
  {
    re: /\bsquat\b/i,
    movement: 'squat',
  },
  // Leg Press family (Linear / Seated / Single-Leg Leg Press)
  {
    re: /leg\s*press/i,
    movement: 'squat',
  },
  // Lat Pulldown — before generic pull-up / row rules
  {
    re: /lat\s*pull(?:down)?/i,
    movement: 'vertical_pull',
  },
  // Pull-up / Chin-up (weighted or not)
  {
    re: /(?:weighted\s*)?(?:pull[\s-]*up|chin[\s-]*up)/i,
    movement: 'vertical_pull',
  },
  // Barbell / Bent-Over / Reverse Bent-Over / Pendlay / T-Bar Row
  {
    re: /(?:barbell|bent[\s-]*over|reverse|pendlay|t[\s-]*bar)\s*row/i,
    movement: 'horizontal_pull',
  },
  // Seated Row
  {
    re: /seated\s*row/i,
    movement: 'horizontal_pull',
  },
  // Generic Row catch-all (any remaining row variants)
  {
    re: /\brow\b/i,
    movement: 'horizontal_pull',
  },
  // Face Pull — rear delt isolation; too light to compete as an anchor
  {
    re: /face\s*pull/i,
    movement: 'delt_isolation',
  },
  // Lateral / Side Raise (singular and plural)
  {
    re: /(?:lat(?:eral)?|side)\s*raises?/i,
    movement: 'delt_isolation',
  },
  // Rear Delt Fly / Reverse Fly
  {
    re: /rear\s*delt|reverse\s*(?:pec\s*)?(?:deck|fly|flye)/i,
    movement: 'delt_isolation',
  },
  // Hip isolation (Hip Thrust, Glute Bridge, Hip Abduction, etc.)
  {
    re: /hip\s*thrust|glute\s*bridge|hip\s*abduct|hip\s*ext(?:ension)?/i,
    movement: 'hip_isolation',
  },
  // Carries (Farmer's / Suitcase / Trap-bar Carry)
  {
    re: /farmer(?:'?s)?\s*(?:walk|carry)|suitcase\s*carry|trap[\s-]*bar\s*carry/i,
    movement: 'carry',
  },
  // Shrugs — trap isolation; no closer pattern in this vocabulary
  {
    re: /\bshrugs?\b/i,
    movement: 'other',
  },
  // Curls — arm isolation (Dumbbell Curl, Hammer Curls, Preacher Curl, etc.)
  // Leg Curl is already handled above; this catches the remaining curl variants.
  {
    re: /\bcurls?\b/i,
    movement: 'arm_isolation',
  },
  // Tricep work (pressdown, kickback, etc.)
  {
    re: /tricep|push[\s-]*down|kickback/i,
    movement: 'arm_isolation',
  },
  // Core / Trunk (abs, obliques, hanging raises, side bends, planks)
  {
    re: /(?:knee|leg)\s*raises?|crunch|sit[\s-]*up|plank|oblique|ab\s*wheel|hanging\s*(?:knee|leg)|side\s*bend/i,
    movement: 'trunk',
  },
  // Calf work
  {
    re: /calf|calves/i,
    movement: 'calf_isolation',
  },
];

function patternFor(liftName) {
  if (!liftName || typeof liftName !== 'string') return UNKNOWN;
  const name = liftName.trim();
  if (!name) return UNKNOWN;

  for (const entry of PATTERN_MAP) {
    if (entry.re.test(name)) {
      return { pattern: entry.movement, needsReview: false };
    }
  }
  return UNKNOWN;
}

module.exports = { patternFor, VALID_PATTERNS };
