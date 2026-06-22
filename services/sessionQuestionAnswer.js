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

// A "bare" in-session shorthand question — pure attribute shorthand with NO lift
// named in the message ("RIR?", "Reps?", "How much?", "How much weight?",
// "How many sets?"). Deliberately tight so off-topic text that merely contains a
// token ("how much should I sleep?") does NOT match.
const BARE_SHORTHAND_RE = /^(rir|reps?|sets?|weight|load|how much( weight)?|how many (reps|sets))\s*\??$/i;

function isBareSessionShorthand(message) {
  return BARE_SHORTHAND_RE.test(String(message == null ? '' : message).trim());
}

// Distinct lift names available from the live context: the actively-previewed
// lift is THE current lift; otherwise a single planned lift is current; multiple
// planned lifts with no preview are ambiguous.
function currentLiftFromContext(clientContext) {
  const cc = clientContext && typeof clientContext === 'object' ? clientContext : {};
  const previewLifts = [...new Set((Array.isArray(cc.current_preview) ? cc.current_preview : [])
    .map(p => p && p.exercise).filter(Boolean))];
  if (previewLifts.length === 1) return { current: previewLifts[0], candidates: previewLifts };
  if (previewLifts.length > 1) return { current: null, candidates: previewLifts };
  const planLifts = [...new Set((Array.isArray(cc.current_plan) ? cc.current_plan : [])
    .map(p => p && p.name).filter(Boolean))];
  if (planLifts.length === 1) return { current: planLifts[0], candidates: planLifts };
  return { current: null, candidates: planLifts };
}

function formatLiftChoices(lifts) {
  const top = lifts.slice(0, 3);
  if (top.length <= 1) return top[0] || 'your current lift';
  if (top.length === 2) return `${top[0]} or ${top[1]}`;
  return `${top.slice(0, -1).join(', ')}, or ${top[top.length - 1]}`;
}

/**
 * Answer bare in-session shorthand from the engine/current lift, regardless of
 * whether the Gemini coach is up — so "RIR?" mid-workout returns the current
 * lift's target, not generic education. Ambiguous current lift → ask which one.
 *
 * @returns {{kind:'answer'|'clarify', text:string}|null}
 *   - 'answer'  : a deterministic current-lift fact
 *   - 'clarify' : a tight "which lift?" question (active session, ambiguous lift)
 *   - null      : not bare shorthand, or no active lift context (caller handles,
 *                 e.g. education when there is no active session)
 */
function answerBareShorthand(message, clientContext = null, resolveTarget = null) {
  if (!isBareSessionShorthand(message)) return null;
  const attrs = attributesAsked(message);
  if (!attrs.length) return null;

  const { current, candidates } = currentLiftFromContext(clientContext);
  if (!current) {
    if (candidates.length > 1) {
      return { kind: 'clarify', text: `For which lift — ${formatLiftChoices(candidates)}?` };
    }
    return null; // no active lift context → let the caller fall back (education is fine)
  }

  const ctxTarget = targetFromContext(current, clientContext);
  const contextMissingAsked = !ctxTarget || attrs.some(a => ctxTarget[a] == null);
  let target = ctxTarget;
  if (contextMissingAsked && typeof resolveTarget === 'function') {
    const engineTarget = resolveTarget(current);
    if (engineTarget) target = mergeTargets(ctxTarget, engineTarget);
  }
  if (!target) return null;
  const text = formatAnswer(current, attrs, target);
  return text ? { kind: 'answer', text } : null;
}

// Past-tense / history signals. A question about the PAST is NOT a current-plan
// question — history owns "last time / previous / before", so the plan-first
// answer must defer on these (the caller's history/LLM path answers them).
const HISTORY_RE = /\b(last time|last (week|session|month|workout|time)|previous(ly)?|history|before|used to)\b/i;

// Reasoning / advice framings. A "why is …", "should I …", "how much to increase"
// question is NOT a direct value lookup — it wants the coach's judgement, which
// Gemini answers far better than the terse fact. So the deterministic plan answer
// defers on these (the chat route falls through to Gemini). Deliberately avoids
// words that collide with lift names (e.g. "raise" in Lateral Raise, "lower").
const ADVICE_RE = /\b(why|should|explain|recommend|increase|decrease|heavier|lighter|progress|better|instead)\b|\btoo\s+(low|high|light|heavy|easy|hard|much|little)/i;

/**
 * Answer a NAMED-LIFT session-value question directly from the live plan/preview.
 *
 * This is the "current plan beats history and education" rule: when the lifter
 * explicitly NAMES a lift that is in today's plan/preview and asks for one of its
 * prescribed values (rir / reps / weight / sets), answer from the plan — not from
 * generic education ("what is RIR") and not from past history.
 *
 * Returns null (defer to the normal SME/LLM flow) when:
 *   - no session attribute is asked,
 *   - the question is about the PAST (history owns "last time / previous"),
 *   - NO lift is named *in the message* (so "what is RIR?" stays education — we do
 *     NOT fall back to plan[0] here, unlike resolveLiftName),
 *   - the named lift is not in the live plan/preview (→ clarify / history defer),
 *   - the plan carries none of the asked attributes for that lift.
 *
 * READ-ONLY: no Sheets, no LLM, no invented numbers — only the plan's own values.
 *
 * @param {string} message
 * @param {object|null} clientContext  client-sent context (current_plan/current_preview)
 * @returns {string|null}
 */
function answerPlannedLiftQuestion(message, clientContext = null) {
  const attrs = attributesAsked(message);
  if (!attrs.length) return null;
  const raw = String(message == null ? '' : message);
  if (HISTORY_RE.test(raw)) return null; // past-tense → history owns it
  if (ADVICE_RE.test(raw)) return null;  // "why / should / increase" → let Gemini coach

  const named = canonicalizeExerciseName(message);
  const liftName = named && named.canonicalName;
  if (!liftName) return null; // no lift named → education/clarify path stays correct

  const target = targetFromContext(liftName, clientContext);
  if (!target) return null; // named lift not in the live plan → defer (clarify/history)
  if (!attrs.some(a => target[a] != null)) return null; // plan lacks the asked value(s)

  const name = target.exercise_name || liftName;
  const parts = [];
  if (attrs.includes('weight') && target.weight != null) parts.push(`${target.weight} lbs`);
  if (attrs.includes('reps') && target.reps != null) parts.push(`${target.reps} reps`);
  if (attrs.includes('sets') && target.sets != null) parts.push(`${target.sets} sets`);
  if (attrs.includes('rir') && target.rir != null) parts.push(`RIR ${target.rir}`);
  if (!parts.length) return null;
  return `${name} today: ${parts.join(', ')}.`;
}

// A "total" question wants sets × reps as a PLANNED total, not the per-set target.
const TOTAL_RE = /\btotal\b/i;

/**
 * Answer a "total reps" question with an ENGINE-COMPUTED planned total (sets ×
 * reps), worded as planned — so a bare "total?" follow-up gets a grounded fact
 * instead of an LLM that multiplies the numbers itself and mis-tenses it as
 * completed work ("you've done 45 reps" when nothing is logged).
 *
 * Resolves the lift from the message, then the recent conversation turns, then the
 * live plan (via resolveLiftName), so "total?" right after discussing a lift works.
 * Returns null (defer) when it isn't a total question, is past-tense/advice, the
 * lift can't be resolved, or the plan lacks BOTH reps and sets (no fabrication).
 * READ-ONLY: no Sheets, no LLM, no invented numbers.
 *
 * @param {string} message
 * @param {object} opts  { history, clientContext }
 * @returns {string|null}
 */
function answerTotalRepsQuestion(message, { history = [], clientContext = null } = {}) {
  const raw = String(message == null ? '' : message);
  if (!TOTAL_RE.test(raw)) return null;
  if (HISTORY_RE.test(raw) || ADVICE_RE.test(raw)) return null; // past / reasoning → defer

  const liftName = resolveLiftName(message, history, clientContext);
  if (!liftName) return null;
  const target = targetFromContext(liftName, clientContext);
  if (!target || target.reps == null || target.sets == null) return null; // need both to total

  const name = target.exercise_name || liftName;
  const total = target.sets * target.reps;
  return `${name} today: ${total} total reps planned (${target.sets} sets × ${target.reps}).`;
}

module.exports = { buildSessionQuestionAnswer, attributesAsked, resolveLiftName, answerBareShorthand, isBareSessionShorthand, answerPlannedLiftQuestion, answerTotalRepsQuestion };
