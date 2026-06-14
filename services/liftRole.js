'use strict';

// Lift-role heuristic + recommendation guards.
//
// A stopgap until the Exercise_Catalog carries explicit lift_role / fatigue_class
// metadata. Pure functions, no I/O. The point: a stalled *accessory* (curl, face
// pull, shrug…) must never trigger a *systemic* "Deload" day, and accessories must
// never be prescribed a low-rep strength scheme like 5×3.

// Isolation / low-fatigue movements — checked by NAME first so "leg curl" doesn't
// get swept up by the "leg → lower" idea.
const ACCESSORY_PATTERNS = [
  /\bcurl\b/i,                                   // bicep / hammer / db / leg curl handled below too
  /face\s*pull/i,
  /(?:lat(?:eral)?|side|rear)\s*(?:delt\s*)?(?:raise|fly|flye)/i,
  /reverse\s*(?:pec\s*)?(?:deck|fly|flye)/i,
  /(?:tricep|push|press)\s*down/i,
  /tricep/i,
  /leg\s*curl/i,
  /leg\s*ext(?:ension)?/i,
  /\bshrug/i,
  /calf|calves/i,
  /(?:knee|leg)\s*raise|crunch|sit[\s-]*up|plank|oblique|ab\s*wheel|hanging\s*leg/i,
  /pec\s*deck|chest\s*fly|cable\s*fly|cable\s*cross/i,
  /kickback|concentration|preacher|wrist|forearm/i,
];

// Big compound, high systemic-fatigue movements — the only things a true deload
// should pull back. Row is "main" only when clearly a heavy barbell variant.
const MAIN_PATTERNS = [
  /squat/i,
  /dead\s*lift|deadlift|romanian\s*deadlift|\brdl\b/i,
  /bench\s*press|\bbench\b/i,
  /overhead\s*press|\bohp\b|military\s*press|standing\s*press|push\s*press/i,
  /(?:barbell|bent[\s-]*over|pendlay|t[\s-]*bar)\s*row/i,
  /weighted\s*(?:pull|chin)[\s-]*up/i,
  /\bclean\b|\bsnatch\b/i,
];

// Muscle groups that are almost always isolation work.
const ACCESSORY_MUSCLES = /bicep|tricep|forearm|calf|calves|side\s*delt|rear\s*delt|lateral\s*delt|\btrap\b|\bab\b|abs|oblique|core/i;

// Below this rep count, an accessory has been handed a strength scheme by mistake.
const ACCESSORY_REP_FLOOR = 8;

const ACCESSORY_RESET_LABEL = 'Recovery Pull / Accessory';
const ACCESSORY_RESET_FOCUS =
  'Main lifts are fatigued, but pulling accessories are available — reset the stalled ones at moderate effort and avoid digging a recovery hole.';
const ACCESSORY_RESET_REASON = 'Reset — lighter load, chase clean reps; accessories respond to volume, not a 5×3.';

// 'main' | 'secondary' | 'accessory'. Name wins over muscle group.
function classifyLiftRole(name = '', muscleGroup = '') {
  const n = String(name == null ? '' : name);
  const mg = String(muscleGroup == null ? '' : muscleGroup);

  if (ACCESSORY_PATTERNS.some(re => re.test(n))) return 'accessory';
  if (MAIN_PATTERNS.some(re => re.test(n))) return 'main';
  if (ACCESSORY_MUSCLES.test(mg)) return 'accessory';
  return 'secondary';
}

function isAccessory(name, muscleGroup) {
  return classifyLiftRole(name, muscleGroup) === 'accessory';
}

function isMainCompound(name, muscleGroup) {
  return classifyLiftRole(name, muscleGroup) === 'main';
}

// A sensible rep target for an accessory that was mis-prescribed a low-rep scheme.
function accessoryRepTarget(name = '', muscleGroup = '') {
  const hay = `${name || ''} ${muscleGroup || ''}`;
  // Delts, calves, core, face pulls → higher reps.
  if (/face\s*pull|lateral|side\s*raise|rear\s*delt|\bdelt|calf|calves|raise|crunch|plank|oblique|\bab\b|abs|core/i.test(hay)) {
    return 15;
  }
  return 12; // curls, pressdowns, leg curl/ext, flyes
}

function exerciseName(ex) {
  return (ex && (ex.exercise || ex.exercise_name)) || '';
}

function exerciseIsAccessory(ex) {
  return isAccessory(exerciseName(ex), ex && ex.muscle_group);
}

// Bump any accessory handed a sub-floor (e.g. 5×3) scheme into its rep range.
function guardAccessoryReps(ex) {
  if (!ex || !exerciseIsAccessory(ex)) return ex;
  const reps = Number(ex.target_reps);
  if (Number.isFinite(reps) && reps < ACCESSORY_REP_FLOOR) {
    return {
      ...ex,
      target_reps: accessoryRepTarget(exerciseName(ex), ex.muscle_group),
      reason: ACCESSORY_RESET_REASON,
    };
  }
  return ex;
}

// Recommended reps-in-reserve for a planned exercise, by training intent + lift role.
// The engine already backs OFF LOAD near failure; this is the target effort to aim for:
// recovery/reduced-stress days leave more in the tank, heavy strength work leaves less,
// and hypertrophy/accessory work sits at a moderate ~2.
function recommendedTargetRir(ex, intentId) {
  const isMain = isMainCompound(exerciseName(ex), ex && ex.muscle_group);
  switch (intentId) {
    case 'build_strength':
    case 'test_progress':
      return isMain ? 1 : 2;       // heavier work — leave less in reserve
    case 'deload_reset':
    case 'recovery_pump':
    case 'short_session':
      return isMain ? 2 : 3;       // reduced stress — leave more in reserve
    default:
      return 2;                    // hypertrophy / balanced / accessory work
  }
}

// Attach a recommended target_rir to a planned exercise (respecting an explicit value if present).
function withTargetRir(ex, intentId) {
  if (!ex || typeof ex !== 'object') return ex;
  if (ex.target_rir != null) return ex;
  return { ...ex, target_rir: recommendedTargetRir(ex, intentId) };
}

// Post-process a scoreIntents() result:
//   1. An accessory-ONLY deload is reframed as "Recovery Pull / Accessory" (never "Deload").
//   2. Any accessory in any intent that got a sub-8-rep scheme is bumped into its range.
//   3. todays_read's headline is kept in sync with the (possibly relabeled) pick.
// A deload that includes a real main lift is left as a deload.
function applyLiftRoleGuards(result) {
  if (!result || !Array.isArray(result.intents)) return result;

  const intents = result.intents.map(intent => {
    let next = intent;

    if (
      intent && intent.id === 'deload_reset' &&
      intent.label === 'Deload & Reset' &&   // fallback only — skip if the engine already reframed it
      Array.isArray(intent.exercises) && intent.exercises.length > 0 &&
      intent.exercises.every(exerciseIsAccessory)
    ) {
      const names = intent.exercises.map(exerciseName).filter(Boolean).join(', ');
      // The original rationale (why_today / watch_for / what_it_protects) was
      // deload-worded ("...stalled — deload to ~X lb", "if a deloaded set...").
      // Rewrite it too, so a relabeled reset never renders deload copy upstream
      // (the Today hero + coach fallback both surface these before the focus line).
      next = {
        ...next,
        label: ACCESSORY_RESET_LABEL,
        focus: ACCESSORY_RESET_FOCUS,
        why_today: [
          `${names || 'These accessories'} have stalled — but an accessory stall doesn't warrant a systemic pullback.`,
          'Reset the load, chase clean reps (10–20), and rotate the variation if it stays stuck.',
        ],
        what_it_protects: [
          'Keeps momentum without digging a recovery hole',
          'Saves the heavy-lift reset for when the main lifts actually slip',
        ],
        watch_for: ["If a main lift starts grinding next session, that's the real signal to pull back"],
      };
    }

    if (next && Array.isArray(next.exercises)) {
      next = { ...next, exercises: next.exercises.map(ex => withTargetRir(guardAccessoryReps(ex), next.id)) };
    }
    return next;
  });

  let todays_read = result.todays_read;
  if (todays_read && todays_read.recommended_intent_id) {
    const rec = intents.find(i => i && i.id === todays_read.recommended_intent_id);
    if (rec) {
      todays_read = {
        ...todays_read,
        recommended_label: rec.label != null ? rec.label : todays_read.recommended_label,
        recommended_reason: rec.focus != null ? rec.focus : todays_read.recommended_reason,
      };
    }
  }

  return { ...result, intents, todays_read };
}

module.exports = {
  classifyLiftRole,
  isAccessory,
  isMainCompound,
  accessoryRepTarget,
  guardAccessoryReps,
  recommendedTargetRir,
  applyLiftRoleGuards,
  ACCESSORY_REP_FLOOR,
  ACCESSORY_RESET_LABEL,
};
