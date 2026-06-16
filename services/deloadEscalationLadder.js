// services/deloadEscalationLadder.js
//
// The escalation ladder, per docs/DELOAD_SPEC.md ("ESCALATION LADDER"). It maps
// a fatigue score (0-100, from services/deloadFatigueScore.js) to the action
// Atlas should take, scaling the intervention to the fatigue:
//
//   Fatigue score | Action
//   ------------- | --------------------------------------
//   < 50          | Normal coaching
//   50 - 75       | Workout adjustment or recovery workout
//   75 - 90       | Offer a deload
//   > 90          | Recommend a deload
//
// Pure and standalone. It owns ONLY the score → action mapping; it does not read
// or write training state, and it never *applies* a deload — an offer/recommend
// is a question, not a prescription. The owner-invoked deload path bypasses this
// ladder entirely (the spec: a user can invoke a deload on demand regardless of
// score); that lives in the integration layer.
//
// Boundary convention (the spec writes the bands as "50-75" / "75-90"): the
// lower bound is inclusive and the band runs up to — and including — its upper
// label, with the next band opening just above it. So 50 → adjust, 75 → offer,
// 90 → offer, and only > 90 → recommend.

const { selectProtocol } = require('./deloadProtocols');
const { STATES } = require('./deloadStateMachine');

const ACTIONS = Object.freeze({
  NORMAL_COACHING: 'NORMAL_COACHING',
  WORKOUT_ADJUSTMENT: 'WORKOUT_ADJUSTMENT',
  OFFER_DELOAD: 'OFFER_DELOAD',
  RECOMMEND_DELOAD: 'RECOMMEND_DELOAD'
});

// Band thresholds, kept as named constants so the spec's numbers are visible and
// tunable in one place.
const BAND_ADJUST_MIN = 50;     // < 50 is normal coaching
const BAND_OFFER_MIN = 75;      // 50..<75 is workout adjustment
const BAND_RECOMMEND_MIN = 90;  // 75..90 is offer; > 90 is recommend

// Which training state each action suggests the lifter move toward. The ladder
// only *suggests*; the state machine still validates the actual transition, and
// the move into DELOAD_ACTIVE happens on acceptance/invocation, not here.
const ACTION_SUGGESTED_STATE = Object.freeze({
  [ACTIONS.NORMAL_COACHING]: STATES.NORMAL,
  [ACTIONS.WORKOUT_ADJUSTMENT]: STATES.RECOVERY_CANDIDATE,
  [ACTIONS.OFFER_DELOAD]: STATES.DELOAD_RECOMMENDED,
  [ACTIONS.RECOMMEND_DELOAD]: STATES.DELOAD_RECOMMENDED
});

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Classify a score into its action + a human-readable band label.
function classify(score) {
  if (score < BAND_ADJUST_MIN) {
    return { action: ACTIONS.NORMAL_COACHING, band: `<${BAND_ADJUST_MIN}` };
  }
  if (score < BAND_OFFER_MIN) {
    return { action: ACTIONS.WORKOUT_ADJUSTMENT, band: `${BAND_ADJUST_MIN}-${BAND_OFFER_MIN}` };
  }
  if (score <= BAND_RECOMMEND_MIN) {
    return { action: ACTIONS.OFFER_DELOAD, band: `${BAND_OFFER_MIN}-${BAND_RECOMMEND_MIN}` };
  }
  return { action: ACTIONS.RECOMMEND_DELOAD, band: `>${BAND_RECOMMEND_MIN}` };
}

const REASONS = Object.freeze({
  [ACTIONS.NORMAL_COACHING]: 'below 50 — normal coaching, no intervention',
  [ACTIONS.WORKOUT_ADJUSTMENT]: 'in the 50-75 band — a workout adjustment or recovery workout, not a deload',
  [ACTIONS.OFFER_DELOAD]: 'in the 75-90 band — offer a deload (a question, not a prescription)',
  [ACTIONS.RECOMMEND_DELOAD]: 'above 90 — recommend a deload'
});

// Evaluate a fatigue score against the ladder.
//   evaluate(score, { focus })
// Returns:
//   {
//     score,                 // the clamped 0-100 score evaluated
//     action,                // one of ACTIONS
//     band,                  // human-readable band label
//     suggested_state,       // the state this action points toward
//     protocol,              // selected protocol when offering/recommending, else null
//     reason                 // deterministic explanation (the coach words it later)
//   }
// A non-numeric score is a loud bug, not a silent "normal" — throw. A numeric
// score outside 0-100 is clamped defensively (the fatigue score is already 0-100).
function evaluate(score, { focus } = {}) {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error(`Fatigue score must be a finite number, got ${JSON.stringify(score)}`);
  }
  const clamped = clamp(score, 0, 100);
  const { action, band } = classify(clamped);

  const offersDeload = action === ACTIONS.OFFER_DELOAD || action === ACTIONS.RECOMMEND_DELOAD;
  const protocol = offersDeload ? selectProtocol(focus) : null;

  return {
    score: clamped,
    action,
    band,
    suggested_state: ACTION_SUGGESTED_STATE[action],
    protocol,
    reason: `Fatigue score ${clamped} is ${REASONS[action]}.`
  };
}

module.exports = {
  ACTIONS,
  BAND_ADJUST_MIN,
  BAND_OFFER_MIN,
  BAND_RECOMMEND_MIN,
  ACTION_SUGGESTED_STATE,
  classify,
  evaluate
};
