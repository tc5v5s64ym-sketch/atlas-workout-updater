'use strict';

/**
 * Deterministic, LLM-free answers for in-session shorthand questions
 * ("RIR?", "reps?", "sets?", "how much?", "how many reps and rir") — used as a
 * fallback by POST /api/coach/chat when the Gemini coach is unavailable
 * (unconfigured, timed out, errored, or returned empty). The engine owns every
 * number; this layer only WORDS the target the recommendation engine already
 * produced. READ-ONLY: no Sheets access, no LLM, no writes.
 *
 * It answers only when (a) the message asks about a session attribute and
 * (b) the lift in question can be resolved. Otherwise it returns null and the
 * caller keeps its existing generic fallback.
 */

const { canonicalizeExerciseName } = require('./workoutTextParser');

// Which session attribute(s) the message is asking about. A message may ask for
// several at once ("how many reps and rir").
const ATTR_PATTERNS = [
  ['rir', /\brir\b|reps?\s+in\s+reserve|\brpe\b/],
  ['reps', /\breps?\b|how many reps|rep range/],
  ['sets', /\bsets?\b|how many sets/],
  ['weight', /\bweight\b|how much|how heavy|how light|\bload\b/],
];

function attributesAsked(message) {
  const m = String(message == null ? '' : message).toLowerCase();
  const out = [];
  for (const [attr, re] of ATTR_PATTERNS) {
    if (re.test(m)) out.push(attr);
  }
  return out;
}

function normName(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

// Resolve the lift the question is about, in priority order:
//   1. a lift named in the current message,
//   2. a lift named in the most recent prior turns (closest first),
//   3. the lift in the live preview / plan from the client context.
function resolveLiftName(message, history, clientContext) {
  const fromMsg = canonicalizeExerciseName(message);
  if (fromMsg && fromMsg.canonicalName) return fromMsg.canonicalName;

  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const text = turns[i] && turns[i].text;
    if (!text) continue;
    const hit = canonicalizeExerciseName(text);
    if (hit && hit.canonicalName) return hit.canonicalName;
  }

  const cc = clientContext && typeof clientContext === 'object' ? clientContext : {};
  const preview = Array.isArray(cc.current_preview) ? cc.current_preview : [];
  if (preview[0] && preview[0].exercise) return preview[0].exercise;
  const plan = Array.isArray(cc.current_plan) ? cc.current_plan : [];
  if (plan[0] && plan[0].name) return plan[0].name;

  return null;
}

// A target from the client's live plan/preview, when present (no Sheets needed).
function targetFromContext(liftName, clientContext) {
  const cc = clientContext && typeof clientContext === 'object' ? clientContext : {};
  const key = normName(liftName);

  for (const p of (Array.isArray(cc.current_plan) ? cc.current_plan : [])) {
    if (p && normName(p.name) === key && (p.rir != null || p.reps != null || p.weight != null || p.sets != null)) {
      return { exercise_name: p.name, weight: p.weight ?? null, reps: p.reps ?? null, sets: p.sets ?? null, rir: p.rir ?? null };
    }
  }
  for (const p of (Array.isArray(cc.current_preview) ? cc.current_preview : [])) {
    if (p && normName(p.exercise) === key && (p.rir != null || p.reps != null || p.weight != null)) {
      return { exercise_name: p.exercise, weight: p.weight ?? null, reps: p.reps ?? null, sets: null, rir: p.rir ?? null };
    }
  }
  return null;
}

// Conclusion-first, brief. Only includes attributes that were asked AND known.
function formatAnswer(liftName, attrs, target) {
  const name = (target && target.exercise_name) || liftName;
  const parts = [];
  if (attrs.includes('weight') && target.weight != null) parts.push(`${target.weight} lbs`);
  if (attrs.includes('reps') && target.reps != null) parts.push(`${target.reps} reps`);
  if (attrs.includes('sets') && target.sets != null) parts.push(`${target.sets} sets`);
  if (attrs.includes('rir') && target.rir != null) parts.push(`RIR ${target.rir}`);
  if (!parts.length) return null;
  return `${name}: ${parts.join(', ')}.`;
}

// Fill any attribute the primary target is missing from the fallback target.
// Primary (client context) wins wherever it has a value.
function mergeTargets(primary, fallback) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    exercise_name: primary.exercise_name || fallback.exercise_name,
    weight: primary.weight ?? fallback.weight,
    reps: primary.reps ?? fallback.reps,
    sets: primary.sets ?? fallback.sets,
    rir: primary.rir ?? fallback.rir
  };
}

/**
 * @param {string} message
 * @param {object} opts
 * @param {Array}  opts.history        prior chat turns [{role,text}]
 * @param {object} opts.clientContext  the client-sent context (current_plan/current_preview)
 * @param {(liftName:string)=>({exercise_name?,weight?,reps?,sets?,rir?}|null)} opts.resolveTarget
 *        engine target lookup (e.g. recommendNextSet); consulted when the client
 *        context has no target for the lift, or its target lacks the asked attribute.
 * @returns {string|null} a deterministic answer, or null to defer to the caller's fallback.
 */
function buildSessionQuestionAnswer(message, { history = [], clientContext = null, resolveTarget = null } = {}) {
  const attrs = attributesAsked(message);
  if (!attrs.length) return null;

  const liftName = resolveLiftName(message, history, clientContext);
  if (!liftName) return null;

  const ctxTarget = targetFromContext(liftName, clientContext);
  // Consult the engine whenever the client context can't cover EVERY asked
  // attribute (e.g. the plan carries rir but the user asked "sets?"), then merge
  // with context values winning — so a partial context target never shadows a
  // fuller engine answer.
  const contextMissingAsked = !ctxTarget || attrs.some(a => ctxTarget[a] == null);
  let target = ctxTarget;
  if (contextMissingAsked && typeof resolveTarget === 'function') {
    const engineTarget = resolveTarget(liftName);
    if (engineTarget) target = mergeTargets(ctxTarget, engineTarget);
  }
  if (!target) return null;

  return formatAnswer(liftName, attrs, target);
}

module.exports = { buildSessionQuestionAnswer, attributesAsked, resolveLiftName };
