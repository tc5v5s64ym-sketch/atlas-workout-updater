'use strict';

// In-session working-weight finder — #1342 (Corpus V2 §F.8).
//
// A session sub-state, distinct from the onboarding finder
// (docs/ONBOARDING_WORKING_WEIGHT_SPEC.md): when the athlete substitutes to a
// lift with no trustworthy load conversion (no history for the logged lift),
// the session enters finder mode for that lift. The engine ascends to the
// criterion rep/RIR, polices overshoot, and records the baseline mid-session.
//
//   criterion — target reps + target RIR (defaults 8 @ 2, the
//     buildWorkingWeightProtocol defaults; the corpus protocol in S4/S11).
//   met       — a set with reps >= targetReps AND rir === targetRir: the
//     criterion load. The FIRST met set's weight is the working weight.
//   over      — a set with rir < targetRir: pushed past the criterion into
//     failure-range effort. The FIRST over set is the overshoot; the ruling
//     is to drop back to the working weight, never to anchor on the overshoot.
//   under     — anything else (rir > targetRir, or target RIR reached short
//     of target reps): still ascending, no conclusion.
//   baseline  — confirmed when the working weight is met TWICE (repeatable):
//     { exercise, weight, reps, rir, sets } where sets counts the
//     criterion-meeting sets at the working weight across the whole finder
//     sequence (prior turns + this turn). S4: 140 8/2 x3 (1 criterion set +
//     2 confirmation sets). S11: 230 10/2 x2.
//
// Pure — no I/O, no Sheets, no clock. The caller owns history (hasHistory)
// and the session carry-over (priorSets, forwarded raw by the client and
// re-derived here — never a client-computed verdict).
//
// Entry gate (both vocabularies, deliberately):
//   - a substitution is present whose prescribed and logged names differ
//     (the substance of a swap), and it is not an abandoned objective
//     (classification 'abandoned') nor a warned swap (decision 'warn');
//   - AND the logged lift has no history (hasHistory === false), so no
//     trustworthy conversion exists; OR
//   - prior finder sets were forwarded for this exercise (a finder already
//     in progress — the confirmation turn carries no substitution).
// A history read that failed yields hasHistory === null, which fails closed
// (no finder) — a finder claim needs evidence, not an assumption.

const DEFAULT_TARGET_REPS = 8;
const DEFAULT_TARGET_RIR = 2;
const MAX_SETS = 12;

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _setOf(s) {
  if (Array.isArray(s)) return { weight: _num(s[0]), reps: _num(s[1]), rir: _num(s[2]) };
  if (s && typeof s === 'object') return { weight: _num(s.weight), reps: _num(s.reps), rir: _num(s.rir) };
  return null;
}

function _name(v) {
  if (v && typeof v === 'object') return typeof v.name === 'string' ? v.name.trim() : '';
  return typeof v === 'string' ? v.trim() : '';
}

function _normName(v) {
  return _name(v).toLowerCase();
}

// The substitution is a finder entry when it swaps to a different lift and
// the swap is not an abandoned objective or a warned one. Accepts both the
// server intent shape ({ classification: 'preserved'|'changed'|'abandoned'|
// 'baseline', decision: 'approve'|'warn', prescribed/logged names }) and the
// corpus-fixture shape ({ classification: 'substituted', prescribed/logged
// names, no decision }) — the gate reads the names + the vetoes, never the
// classification vocabulary.
function substitutionIsFinderEntry(substitution) {
  if (!substitution || typeof substitution !== 'object') return false;
  const prescribed = _name(substitution.prescribed);
  const logged = _name(substitution.logged);
  if (!prescribed || !logged) return false;
  if (prescribed.toLowerCase() === logged.toLowerCase()) return false;
  if (typeof substitution.classification === 'string'
    && substitution.classification.trim().toLowerCase() === 'abandoned') return false;
  if (typeof substitution.decision === 'string'
    && substitution.decision.trim().toLowerCase() === 'warn') return false;
  return true;
}

// Classify one judged set against the criterion. null = unjudged (no weight,
// no reps, or no RIR — the finder cannot read it).
function classifySet(set, targetReps, targetRir) {
  if (!set || set.weight === null || set.weight === undefined || set.weight <= 0) return null;
  if (set.reps === null || set.reps === undefined || set.reps <= 0) return null;
  if (set.rir === null || set.rir === undefined) return null;
  if (set.reps >= targetReps && set.rir === targetRir) return 'met';
  if (set.rir < targetRir) return 'over';
  return 'under';
}

function evaluateWorkingWeightFinder({
  exercise = null,
  prescribedExercise = null,
  substitution = null,
  todaySets = [],
  priorSets = [],
  hasHistory = null,
  targetReps = DEFAULT_TARGET_REPS,
  targetRir = DEFAULT_TARGET_RIR,
} = {}) {
  const reps = Math.max(1, Math.round(_num(targetReps) ?? DEFAULT_TARGET_REPS));
  const rir = Math.max(0, Math.round(_num(targetRir) ?? DEFAULT_TARGET_RIR));
  const name = _name(exercise);
  const prescribed = _name(prescribedExercise) || _name(substitution && substitution.prescribed) || null;

  const priors = (Array.isArray(priorSets) ? priorSets : []).slice(0, MAX_SETS).map(_setOf).filter(Boolean);
  const current = (Array.isArray(todaySets) ? todaySets : []).slice(0, MAX_SETS).map(_setOf).filter(Boolean);
  const entered = substitutionIsFinderEntry(substitution) && hasHistory === false;
  const continuing = priors.length > 0;
  if (!entered && !continuing) return null;
  if (!name) return null;

  const sequence = priors.concat(current);
  let workingWeight = null;
  let overshoot = null;
  let metAtWorking = 0;
  let judged = 0;
  for (const set of sequence) {
    const cls = classifySet(set, reps, rir);
    if (!cls) continue;
    judged += 1;
    if (cls === 'met' && !workingWeight) {
      workingWeight = { weight: set.weight, reps: set.reps, rir: set.rir };
    }
    if (cls === 'over' && !overshoot) {
      overshoot = { weight: set.weight, reps: set.reps, rir: set.rir };
    }
    if (cls === 'met' && workingWeight && set.weight === workingWeight.weight) metAtWorking += 1;
  }

  const baseline = (workingWeight && metAtWorking >= 2)
    ? { exercise: name, weight: workingWeight.weight, reps: workingWeight.reps, rir: workingWeight.rir, sets: metAtWorking }
    : null;
  const status = baseline ? 'baselined'
    : overshoot ? 'overshot'
    : workingWeight ? 'identified'
    : 'finding';

  return {
    exercise: name,
    prescribed_exercise: prescribed,
    criterion: { reps, rir },
    status,
    working_weight: workingWeight,
    overshoot,
    baseline,
    sets_evaluated: judged,
  };
}

module.exports = {
  evaluateWorkingWeightFinder,
  substitutionIsFinderEntry,
  classifySet,
  DEFAULT_TARGET_REPS,
  DEFAULT_TARGET_RIR,
};
