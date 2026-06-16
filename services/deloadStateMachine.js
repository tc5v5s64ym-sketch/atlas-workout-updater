// services/deloadStateMachine.js
//
// The Atlas training-state machine, per docs/DELOAD_SPEC.md ("ATLAS TRAINING
// STATES"). A lifter is always in exactly one state; this module owns which
// transitions between those states are legal and rejects the rest.
//
// The spec's happy-path flow is linear:
//
//   NORMAL → RECOVERY_CANDIDATE → DELOAD_RECOMMENDED → DELOAD_ACTIVE
//          → POST_DELOAD_EVALUATION → NORMAL
//
// but real training needs a few extra legal edges (owner-invoked deloads,
// de-escalation when fatigue resolves, a declined recommendation). The table
// below encodes every allowed edge and nothing else.
//
// Pure and standalone (no I/O, no persistence) — persistence of the current
// state lands in a later PR. This module only answers "is this move legal?".

const STATES = Object.freeze({
  NORMAL: 'NORMAL',
  RECOVERY_CANDIDATE: 'RECOVERY_CANDIDATE',
  DELOAD_RECOMMENDED: 'DELOAD_RECOMMENDED',
  DELOAD_ACTIVE: 'DELOAD_ACTIVE',
  POST_DELOAD_EVALUATION: 'POST_DELOAD_EVALUATION'
});

// The resting state every lifter starts in and returns to.
const INITIAL_STATE = STATES.NORMAL;

// Legal transitions, keyed by the current state. Rationale per edge:
//
// NORMAL → RECOVERY_CANDIDATE   fatigue climbing into the adjust/recovery band
//        → DELOAD_RECOMMENDED   fatigue high enough to offer/recommend a deload
//        → DELOAD_ACTIVE        owner invokes a deload on demand (always allowed)
//
// RECOVERY_CANDIDATE → NORMAL              fatigue resolved; recovery worked
//                    → DELOAD_RECOMMENDED  fatigue escalated past the offer gate
//                    → DELOAD_ACTIVE       owner invokes on demand
//
// DELOAD_RECOMMENDED → DELOAD_ACTIVE       the lifter accepts the deload
//                    → RECOVERY_CANDIDATE  declined, but still warrants easing off
//                    → NORMAL              declined and fatigue no longer a concern
//
// DELOAD_ACTIVE → POST_DELOAD_EVALUATION   the deload's last session completed.
//   This is the ONLY exit: a deload runs to completion, it doesn't bounce back
//   to NORMAL or jump elsewhere mid-block.
//
// POST_DELOAD_EVALUATION → NORMAL          always returns to NORMAL.
//   The spec is explicit: if the lifter has NOT rebounded, Atlas must "not
//   immediately trigger another deload" and instead investigate. So this state
//   never transitions straight back into DELOAD_RECOMMENDED/ACTIVE — the only
//   edge is to NORMAL, from where a fresh evaluation can begin.
const TRANSITIONS = Object.freeze({
  [STATES.NORMAL]: Object.freeze([
    STATES.RECOVERY_CANDIDATE,
    STATES.DELOAD_RECOMMENDED,
    STATES.DELOAD_ACTIVE
  ]),
  [STATES.RECOVERY_CANDIDATE]: Object.freeze([
    STATES.NORMAL,
    STATES.DELOAD_RECOMMENDED,
    STATES.DELOAD_ACTIVE
  ]),
  [STATES.DELOAD_RECOMMENDED]: Object.freeze([
    STATES.DELOAD_ACTIVE,
    STATES.RECOVERY_CANDIDATE,
    STATES.NORMAL
  ]),
  [STATES.DELOAD_ACTIVE]: Object.freeze([
    STATES.POST_DELOAD_EVALUATION
  ]),
  [STATES.POST_DELOAD_EVALUATION]: Object.freeze([
    STATES.NORMAL
  ])
});

function isState(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TRANSITIONS, value);
}

// The states reachable from `state` in one legal move. Returns a fresh array so
// callers can't mutate the frozen transition table. Unknown state → [].
function nextStates(state) {
  return isState(state) ? [...TRANSITIONS[state]] : [];
}

function canTransition(from, to) {
  if (!isState(from) || !isState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

// Perform a transition. Returns the target state when legal; throws a clear
// error otherwise so an illegal move is a loud bug, never a silent no-op that
// leaves the lifter in a wrong state. Self-transitions are not legal edges — a
// lifter "staying" in a state simply isn't a transition (e.g. an in-progress
// multi-session deload stays DELOAD_ACTIVE without calling this).
function transition(from, to) {
  if (!isState(from)) {
    throw new Error(`Unknown current training state: ${JSON.stringify(from)}`);
  }
  if (!isState(to)) {
    throw new Error(`Unknown target training state: ${JSON.stringify(to)}`);
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal training-state transition: ${from} → ${to}`);
  }
  return to;
}

// Convenience predicate for the integration layer: while this is the state,
// recommendations must defer to the active deload protocol.
function isActiveDeload(state) {
  return state === STATES.DELOAD_ACTIVE;
}

module.exports = {
  STATES,
  INITIAL_STATE,
  TRANSITIONS,
  isState,
  nextStates,
  canTransition,
  transition,
  isActiveDeload
};
