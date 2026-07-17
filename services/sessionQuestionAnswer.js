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

// The ACCEPTED-PLAN target for a lift, when present (no Sheets needed). F09F: only
// `current_plan` (today's accepted prescription) is a source of a "planned" target.
// `current_preview` holds PERFORMED/preview rows — what the lifter is about to log or
// just logged — so it is NEVER read here as a prescription (that is the "actual
// silently becomes plan" bug). Preview still helps resolve lift IDENTITY elsewhere
// (resolveLiftName / currentLiftFromContext); it just cannot supply target numbers.
// The returned target is tagged `source: 'plan'` so callers can keep plan and live
// engine values distinct in the wording.
function targetFromContext(liftName, clientContext) {
  const cc = clientContext && typeof clientContext === 'object' ? clientContext : {};
  const key = normName(liftName);

  for (const p of (Array.isArray(cc.current_plan) ? cc.current_plan : [])) {
    if (p && normName(p.name) === key && (p.rir != null || p.reps != null || p.weight != null || p.sets != null)) {
      return { exercise_name: p.name, weight: p.weight ?? null, reps: p.reps ?? null, sets: p.sets ?? null, rir: p.rir ?? null, source: 'plan' };
    }
  }
  return null;
}

// The asked-and-known attributes, worded conclusion-first.
function formatParts(attrs, target) {
  const parts = [];
  if (attrs.includes('weight') && target.weight != null) parts.push(`${target.weight} lbs`);
  if (attrs.includes('reps') && target.reps != null) parts.push(`${target.reps} reps`);
  if (attrs.includes('sets') && target.sets != null) parts.push(`${target.sets} sets`);
  if (attrs.includes('rir') && target.rir != null) parts.push(`RIR ${target.rir}`);
  return parts;
}

// Word a resolved answer with EXPLICIT provenance (F09F). `resolved` is
// { target, provenance } from resolveAnswerTarget:
//   - 'plan'   → the accepted plan's own prescription (worded plainly, as today's plan);
//   - 'engine' → a live recommendation for the NEXT set, labeled so it is never
//                mistaken for the stored plan (and never a performed value).
// Only asked-and-known attributes are included. Returns null when nothing is known.
function formatAnswer(liftName, attrs, resolved) {
  const { target, provenance } = resolved || {};
  if (!target) return null;
  const name = target.exercise_name || liftName;
  const parts = formatParts(attrs, target);
  if (!parts.length) return null;
  if (provenance === 'engine') {
    return `${name}: no planned target — recommended for your next set: ${parts.join(', ')}.`;
  }
  return `${name}: ${parts.join(', ')}.`;
}

function formatTargetPrescription(target) {
  if (!target || typeof target !== 'object') return null;
  const parts = [];
  if (target.weight != null) parts.push(`${target.weight} lbs`);
  if (target.reps != null) parts.push(`${target.reps} reps`);
  if (target.sets != null) parts.push(`${target.sets} sets`);
  if (target.rir != null) parts.push(`RIR ${target.rir}`);
  return parts.length ? parts.join(', ') : null;
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

// F09F provenance resolver. Given the accepted-plan target (or null) and the live
// engine target (or null), decide which the answer speaks with:
//   - accepted plan present → speak as the PLAN; the engine may only FILL attributes
//     the plan genuinely lacks (e.g. a missing set count) — the lift IS planned, so it
//     is still the plan's answer (this preserves the missing-set-count behavior).
//   - no accepted plan target → the engine value is a REVISED NEXT-SET RECOMMENDATION,
//     surfaced under that label, never as the plan.
//   - neither → no reliable target.
// A performed/preview value never reaches here as a target (targetFromContext drops it),
// so actual can never masquerade as plan.
function resolveAnswerTarget(planTarget, engineTarget) {
  if (planTarget) {
    return { target: engineTarget ? mergeTargets(planTarget, engineTarget) : planTarget, provenance: 'plan' };
  }
  if (engineTarget) return { target: engineTarget, provenance: 'engine' };
  return { target: null, provenance: 'none' };
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

  const planTarget = targetFromContext(liftName, clientContext);
  // Consult the engine whenever the accepted plan can't cover EVERY asked attribute
  // (a real plan lift missing e.g. its set count, or no accepted plan target at all).
  const planMissingAsked = !planTarget || attrs.some(a => planTarget[a] == null);
  const engineTarget = (planMissingAsked && typeof resolveTarget === 'function')
    ? resolveTarget(liftName)
    : null;

  const resolved = resolveAnswerTarget(planTarget, engineTarget);
  // This layer answers only when the LLM coach is unavailable, so when a lift is named
  // and attributes are asked but neither the accepted plan nor the engine can ground a
  // target, the honest floor is to say so — never a performed value, never a guess.
  return formatAnswer(liftName, attrs, resolved) || `${liftName}: no reliable target available.`;
}

/**
 * Provider-down advice fallback. This runs ONLY from the caller's Gemini
 * unavailable/error path, never before a healthy coach. It gives a useful
 * deterministic floor for advice-shaped lift questions by wording the existing
 * current-plan target or recommendNextSet target. No new math, no LLM, no writes.
 */
function buildSessionAdviceFallback(message, { history = [], clientContext = null, resolveTarget = null } = {}) {
  const raw = String(message == null ? '' : message);
  if (!ADVICE_RE.test(raw)) return null;

  const liftName = resolveLiftName(message, history, clientContext);
  if (!liftName) return null;

  const ctxTarget = targetFromContext(liftName, clientContext);
  const engineTarget = typeof resolveTarget === 'function' ? resolveTarget(liftName) : null;
  const target = mergeTargets(ctxTarget, engineTarget);
  const prescription = formatTargetPrescription(target);
  if (!prescription) return null;

  const name = (target && target.exercise_name) || liftName;
  const reason = engineTarget && typeof engineTarget.reasoning === 'string' && engineTarget.reasoning.trim()
    ? ` Engine read: ${engineTarget.reasoning.trim()}`
    : '';
  return `${name}: use ${prescription}.${reason}`;
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
  // Owner live find (2026-07-03): a multi-lift plan's CURRENT STEP is not
  // ambiguous — "How much weight?" mid-session got "for which lift?" while the
  // session pin showed the current one. plan_completed is the client's
  // canonical done-list (sent whenever a plan is visible); the first
  // not-completed plan lift IS the current lift. Without plan_completed the
  // old clarify behavior stands.
  if (planLifts.length > 1 && Array.isArray(cc.plan_completed)) {
    const done = new Set(cc.plan_completed.map(n => String(n == null ? '' : n).toLowerCase()));
    const pending = planLifts.filter(n => !done.has(String(n).toLowerCase()));
    if (pending.length) return { current: pending[0], candidates: pending };
  }
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

  const planTarget = targetFromContext(current, clientContext);
  const planMissingAsked = !planTarget || attrs.some(a => planTarget[a] == null);
  const engineTarget = (planMissingAsked && typeof resolveTarget === 'function')
    ? resolveTarget(current)
    : null;
  const resolved = resolveAnswerTarget(planTarget, engineTarget);
  // Pre-Gemini lane: defer (null) when nothing can be grounded so the LLM / education
  // path still applies — the "no reliable target" floor belongs to the LLM-down lane.
  if (!resolved.target) return null;
  const text = formatAnswer(current, attrs, resolved);
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
  // This answers a REPS total only. A "total weight/load", "total volume", or
  // "total sets" question asks a different metric — defer it to Gemini rather than
  // reply with a rep count. (Bare "total?" carries no attribute and stays a
  // reps-total.)
  const totalAttrs = attributesAsked(raw);
  if (totalAttrs.includes('weight') || /\bvolume\b/i.test(raw)) return null;
  if (totalAttrs.includes('sets') && !totalAttrs.includes('reps')) return null;

  const liftName = resolveLiftName(message, history, clientContext);
  if (!liftName) return null;
  const target = targetFromContext(liftName, clientContext);
  if (!target || target.reps == null || target.sets == null) return null; // need both to total

  const name = target.exercise_name || liftName;
  const total = target.sets * target.reps;
  return `${name} today: ${total} total reps planned (${target.sets} sets × ${target.reps}).`;
}

module.exports = { buildSessionQuestionAnswer, buildSessionAdviceFallback, attributesAsked, resolveLiftName, answerBareShorthand, isBareSessionShorthand, answerPlannedLiftQuestion, answerTotalRepsQuestion };
