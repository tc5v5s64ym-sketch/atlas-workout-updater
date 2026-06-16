'use strict';

// Systemic-cost tier lookup. Pattern-based, pure data.
// Three tiers drawn directly from SESSION_DESIGN.md Rule A:
//
//   HIGH   — Deadlift, Back Squat, RDL, heavy Barbell / Bent-Over Row.
//            Slowest to recover; at most one HIGH-cost anchor per system
//            per session. Two HIGH-cost anchors in the same system are a
//            blocked co-anchor pair.
//   MEDIUM — Bench, OHP, Seated Row, Lat Pulldown, Leg Press family,
//            Incline DB Press, Dips. Demanding but recoverable within a
//            normal session.
//   LOW    — All isolation / accessories. Never drive a systemic fatigue
//            call; never trigger a deload on their own.
//
// Unknown lifts default to LOW + needsReview:true (safe: doesn't block
// any pairing; downstream can flag for review).

const COST_TIERS = new Set(['high', 'medium', 'low']);

// Ordered most-specific first — first match wins.
const COST_MAP = [
  // ── HIGH ──────────────────────────────────────────────────────────────
  // Romanian Deadlift / RDL — before standard deadlift
  {
    re: /romanian\s*deadlift|\brdl\b/i,
    cost: 'high',
  },
  // Standard Deadlift (sumo, conventional, trap-bar)
  {
    re: /\bdeadlift\b/i,
    cost: 'high',
  },
  // Light / accessory squat variants — MEDIUM (no heavy barbell spinal load)
  // Must be listed before the generic squat rule below.
  {
    re: /goblet\s*squat|bulgarian|split\s*squat|hack\s*squat|box\s*squat/i,
    cost: 'medium',
  },
  // Back Squat and remaining barbell squat variants — HIGH
  {
    re: /\bsquat\b/i,
    cost: 'high',
  },
  // Heavy Barbell / Bent-Over Row — HIGH systemic cost (lower-back demand)
  // Seated Row and generic cable/machine rows are MEDIUM (listed below).
  {
    re: /(?:barbell|bent[\s-]*over|reverse|pendlay|t[\s-]*bar)\s*row/i,
    cost: 'high',
  },
  // Good Morning — heavy barbell hinge, same lower-back demand as RDL → HIGH
  {
    re: /good\s*morning/i,
    cost: 'high',
  },

  // ── MEDIUM ────────────────────────────────────────────────────────────
  // Leg Press family — MEDIUM (quad-dominant but no lower-back loading)
  {
    re: /leg\s*press/i,
    cost: 'medium',
  },
  // Incline press — before bench press
  {
    re: /incline\s*(?:db|dumbbell|barbell|bench)?\s*press/i,
    cost: 'medium',
  },
  // Overhead Press / OHP
  {
    re: /overhead\s*press|\bohp\b|military\s*press|standing\s*press|push\s*press/i,
    cost: 'medium',
  },
  // Bench Press (includes Machine Bench Press)
  {
    re: /bench\s*press|\bbench\b/i,
    cost: 'medium',
  },
  // Dips (Weighted or not) — MEDIUM (demanding but lower systemic cost than bench)
  {
    re: /\bdips?\b/i,
    cost: 'medium',
  },
  // Lat Pulldown
  {
    re: /lat\s*pull(?:down)?/i,
    cost: 'medium',
  },
  // Pull-up / Chin-up (weighted or not)
  {
    re: /(?:weighted\s*)?(?:pull[\s-]*up|chin[\s-]*up)/i,
    cost: 'medium',
  },
  // Seated Row (cable/machine — lower systemic cost than barbell row)
  {
    re: /seated\s*row/i,
    cost: 'medium',
  },
  // Generic Row catch-all (any unmatched row variant, e.g. cable row)
  {
    re: /\brow\b/i,
    cost: 'medium',
  },
  // ── LOW (isolations / accessories) ────────────────────────────────────
  // Leg Curl (single-leg variant too) — before generic curl
  {
    re: /(?:single[\s-]*leg\s*)?leg\s*curl/i,
    cost: 'low',
  },
  // Leg Extension
  {
    re: /leg\s*ext(?:ension)?/i,
    cost: 'low',
  },
  // Curls (all variants — Dumbbell, Hammer, Preacher, etc.)
  {
    re: /\bcurls?\b/i,
    cost: 'low',
  },
  // Tricep work
  {
    re: /tricep|push[\s-]*down|kickback/i,
    cost: 'low',
  },
  // Delt isolation (Face Pull, Lateral Raise, Rear Delt Fly)
  {
    re: /face\s*pull|(?:lat(?:eral)?|side|rear)\s*(?:delt\s*)?raises?|rear\s*delt|reverse\s*(?:pec\s*)?(?:deck|fly|flye)/i,
    cost: 'low',
  },
  // Cable Crossover / Chest Fly / Pec Deck
  {
    re: /cable\s*cross(?:over)?|chest\s*fly|pec\s*deck/i,
    cost: 'low',
  },
  // Shrugs
  {
    re: /\bshrugs?\b/i,
    cost: 'low',
  },
  // Core / Trunk
  {
    re: /(?:knee|leg)\s*raises?|crunch|sit[\s-]*up|plank|oblique|ab\s*wheel|hanging\s*(?:knee|leg)|side\s*bend/i,
    cost: 'low',
  },
  // Calf work
  {
    re: /calf|calves/i,
    cost: 'low',
  },
  // Hip isolation
  {
    re: /hip\s*thrust|glute\s*bridge|hip\s*abduct|hip\s*ext(?:ension)?/i,
    cost: 'low',
  },
];

// Unknown / unrecognised lift: LOW is the safe permissive default —
// doesn't block any pairing; downstream flags via needsReview.
const UNKNOWN = { cost: 'low', needsReview: true };

function costFor(liftName) {
  if (!liftName || typeof liftName !== 'string') return UNKNOWN;
  const name = liftName.trim();
  if (!name) return UNKNOWN;

  for (const entry of COST_MAP) {
    if (entry.re.test(name)) {
      return { cost: entry.cost, needsReview: false };
    }
  }
  return UNKNOWN;
}

module.exports = { costFor, COST_TIERS };
