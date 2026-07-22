'use strict';

// ── Active-session response grounding for the coach chat path ────────────────
//
// Pure, deterministic helpers for POST /api/coach/chat. No I/O, no LLM, no clock.
//
// Two production response-grounding failures (2026-07-21) motivate this module:
//
//   1. RELEVANCE — an explanation about ONE exercise (Seated Row) was contaminated
//      with an unrelated lift's diagnostic (a Bench Press "below your recent
//      benchmark" paragraph). Root cause: `coach_mode` becomes "challenge" from ANY
//      memory_patterns entry, and the challenge prompt tells the model to proactively
//      raise that pattern — even when it belongs to a lift the athlete did not ask
//      about. `narrowContextToPlanTurn` filters the all-lift diagnostics (stalls,
//      memory_patterns) to the exercise(s) the turn is actually about and recomputes
//      coach_mode from the narrowed patterns, so an unrelated lift can never be raised.
//
//   2. MUTATION TRUTH — a correction ("that isn't what you planned…") drew the reply
//      "The plan was updated. It now calls for 3 sets of 10…", a false completed-write
//      claim. `/api/coach/chat` is read-only and never carries write proof, so a
//      completed-mutation claim on this route is always false. `detectUnsupportedMutationClaim`
//      flags such prose (state-aware: proposals, questions, quotations, and negations
//      are NOT claims), and `buildGroundedPlanStatement` supplies a truthful,
//      grounded replacement that states the current plan and that nothing changed.
//
// The engine owns numbers/decisions; these helpers only select context and validate
// wording. They never mutate a plan, never write, and never invent a fact.

const { generateLiftCode } = require('./exerciseEnrichment');
const { deriveChatCoachMode } = require('./chatCoachMode');

// ── text utilities ──────────────────────────────────────────────────────────

// Lowercase + straighten curly/typographic apostrophes so "isn't" == "isn’t".
function normalize(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[‘’ʼ′]/g, "'").trim();
}

// A name comparison key: uppercase alphanumerics only ("Seated Row" → "SEATEDROW").
function nameKey(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function liftCodeOf(name) {
  try { return generateLiftCode(name) || null; } catch { return null; }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Significant words of a lift name (≥4 chars) for loose message matching — so
// "Seated Row" is found in "seated rows" and "Bench Press" in "why is bench…".
function significantWords(name) {
  return normalize(name).split(/\s+/).filter((w) => w.length >= 4);
}

// ── target-exercise resolution ──────────────────────────────────────────────

function planLiftNames(context) {
  const c = context && typeof context === 'object' ? context : {};
  const out = [];
  for (const e of (Array.isArray(c.current_plan) ? c.current_plan : [])) {
    const n = e && (e.name || e.exercise);
    if (n) out.push(String(n));
  }
  for (const e of (Array.isArray(c.current_preview) ? c.current_preview : [])) {
    const n = e && (e.exercise || e.name);
    if (n) out.push(String(n));
  }
  return dedupeByKey(out);
}

// Every lift name we can see in the snapshot — used to detect which lift a message
// names (a free-text NER is unnecessary: the relevant lifts are already named in the
// plan/preview/stalls/recent sessions).
function knownLiftNames(context) {
  const c = context && typeof context === 'object' ? context : {};
  const out = [...planLiftNames(c)];
  for (const s of (Array.isArray(c.stalls) ? c.stalls : [])) {
    if (s && s.exercise) out.push(String(s.exercise));
  }
  for (const s of (Array.isArray(c.recent_sessions) ? c.recent_sessions : [])) {
    for (const ex of (Array.isArray(s && s.exercises) ? s.exercises : [])) if (ex) out.push(String(ex));
  }
  return dedupeByKey(out);
}

function dedupeByKey(names) {
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const k = nameKey(n);
    if (k && !seen.has(k)) { seen.add(k); out.push(n); }
  }
  return out;
}

function namedLiftsInMessage(message, context) {
  const m = normalize(message);
  if (!m) return [];
  return knownLiftNames(context).filter((name) => {
    const words = significantWords(name);
    return words.length > 0 && words.some((w) => new RegExp(`\\b${escapeRe(w)}`).test(m));
  });
}

// The exercise(s) the turn is about: those named in the message, else (a correction
// that omits the lift) the active plan/preview exercises the correction refers to.
function resolveTurnExercises(message, context) {
  const named = namedLiftsInMessage(message, context);
  return named.length ? named : planLiftNames(context);
}

// ── turn classification ─────────────────────────────────────────────────────

function hasActiveSession(context) {
  const c = context && typeof context === 'object' ? context : {};
  return (Array.isArray(c.current_plan) && c.current_plan.length > 0)
    || (Array.isArray(c.current_preview) && c.current_preview.length > 0);
}

// "Why did you program/prescribe/recommend/pick… X" — a plan-rationale explanation.
const PLAN_EXPLAIN_RE = /\bwhy\b[^?]*\byou\b[^?]*\b(program(?:med|ming)?|program|prescrib(?:e|ed)|recommend(?:ed)?|pick(?:ed)?|choose|chose|put|set|planned|plan|suggest(?:ed)?|prescribe)\b/;

// A broad-session review request keeps the full diagnostics — never narrowed.
const BROAD_REVIEW_RE = /\b(any (problems?|issues?|concerns?|red flags?)|anything (wrong|off|else|i should)|overall|in general|recent training|my (recent )?training|everything|all my|the whole (session|workout|plan|program)|review my|how('?s| is) (my )?(training|progress|everything)|what should i (train|do today))\b/;

// A plan reference / dispute / correction — mirrors src/app/sessionQuestion.isPlanReference
// (the client routing classifier from PR #1121). Kept in sync intentionally; this is the
// server-side grounding lane, that is the client-side routing lane.
function isPlanReferenceLike(message) {
  const m = normalize(message);
  if (!m) return false;
  const YOU_PRESCRIBED = /\byou(?:'ve|'d| have| did)?\s+(?:just |already |only |actually |even )?(plan(?:n(?:ed|ing))?|prescrib(?:e|ed|ing)|programm?(?:ed|ing)?|program|recommend(?:ed|ing)?|suggest(?:ed|ing)?|told|telling|said|say|gave|give|giving|given|set)\b/;
  const YOU_HAD_ME = /\byou (?:had|have|got|put) me\b/;
  if (YOU_PRESCRIBED.test(m) || YOU_HAD_ME.test(m)) return true;
  const PLAN_NOUN = /\b(?:the|your|this|that|my|today's) (?:plan|workout|program|prescription|routine|session)\b/;
  const PLAN_CONTEXT = /\b(said?|says?|say|calls?|called|show(?:s|ed|n)?|reads?|different|differs?|change[ds]?|not|no|wrong|thought|meant|supposed|instead)\b|\d/;
  return PLAN_NOUN.test(m) && PLAN_CONTEXT.test(m);
}

// True for an active-session plan explanation / dispute / correction — the turns whose
// diagnostics should be narrowed to the exercise in question. A broad-session review is
// deliberately excluded (it legitimately wants the full picture).
function isActivePlanGroundedTurn(message, context) {
  if (!hasActiveSession(context)) return false;
  const m = normalize(message);
  if (!m || BROAD_REVIEW_RE.test(m)) return false;
  return PLAN_EXPLAIN_RE.test(m) || isPlanReferenceLike(m);
}

// ── relevance narrowing ─────────────────────────────────────────────────────

// For a plan-grounded turn, return a context whose all-lift diagnostics are filtered
// to the target exercise(s): stalls + memory_patterns kept only for the target lift,
// muscle_gaps (accessory-suggestion context) dropped, and coach_mode recomputed from
// the narrowed patterns so a "challenge" can only ever name the target lift's own
// pattern — never an unrelated lift's. Non-grounded turns are returned unchanged.
function narrowContextToPlanTurn(context, message, opts = {}) {
  const c = context && typeof context === 'object' ? context : {};
  if (!isActivePlanGroundedTurn(message, c)) return c;

  const targets = resolveTurnExercises(message, c);
  const targetCodes = new Set(targets.map(liftCodeOf).filter(Boolean));
  const targetKeys = new Set(targets.map(nameKey).filter(Boolean));
  const isTarget = (code, name) =>
    (code && targetCodes.has(code)) || (name && targetKeys.has(nameKey(name)));

  const stalls = (Array.isArray(c.stalls) ? c.stalls : [])
    .filter((s) => s && isTarget(liftCodeOf(s.exercise) || s.liftCode || null, s.exercise));
  const memory_patterns = (Array.isArray(c.memory_patterns) ? c.memory_patterns : [])
    .filter((p) => p && targetCodes.has(p.liftCode));
  const coach_mode = deriveChatCoachMode({ memory_patterns }, { discouraged: opts.discouraged === true });

  return { ...c, stalls, memory_patterns, muscle_gaps: [], coach_mode };
}

// ── mutation-claim validation ───────────────────────────────────────────────

// Split into clause-ish segments so a claim in one sentence is judged on its own.
function segments(text) {
  return normalize(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// A modal / conditional / future / proposal marker turns a mutation verb into a
// PROPOSAL, not a completed claim ("I can update…", "want me to switch…", "to change…").
const PROPOSAL_MARKER = /\b(can|could|would|will|'ll|shall|should|may|might|want me to|do you want|would you like|if you (?:want|'?d like)|let me|happy to|glad to|i'd|i can|i could|i'll|to (?:update|change|switch|adjust|save|modify|edit|swap|replace)|propose|proposing|suggest|suggesting|offer)\b/;
// The mutation is attributed to the ATHLETE, not claimed by Atlas ("you said the plan was updated").
const ATTRIBUTION_MARKER = /\byou(?:'re| are)?\s+(said|say|saying|claim(?:ed|ing)?|mention(?:ed|ing)?|think|thought|asked|asking|wrote|typed|feel|felt|believe|mean|meant)\b/;
// A negated mutation is not a completed claim ("I haven't changed it", "nothing was saved").
const NEGATION_MARKER = /\b(haven'?t|have not|hasn'?t|has not|hadn'?t|had not|didn'?t|did not|don'?t|do not|won'?t|will not|wouldn'?t|would not|never|nothing|no changes?|not (?:yet )?(?:been )?(?:updated|changed|saved|switched|adjusted|modified|edited|revised|altered|swapped|replaced))\b/;

const COMPLETED_MUTATION_PATTERNS = [
  // First-person Atlas completed: "I updated the plan", "I've changed it", "we switched it".
  /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+|already\s+|now\s+)?(?:updated|changed|switched|adjusted|saved|modified|edited|revised|altered|swapped|replaced)\b/,
  // Passive completed on the plan / it / that: "the plan was updated", "it has been changed".
  /\b(?:the plan|the workout|the program|the prescription|the routine|your plan|your workout|your program|it|that|this)\s+(?:was|were|has been|have been|'s been|is now|are now|got)\s+(?:updated|changed|switched|adjusted|saved|modified|edited|revised|altered|swapped|replaced|set)\b/,
  // Bare "has been updated/saved/…".
  /\b(?:has|have)\s+been\s+(?:updated|changed|switched|adjusted|saved|modified|edited|revised|altered|swapped|replaced)\b/,
  // "it now calls for…", "the plan now shows/says/reads/has/is" — a just-changed state.
  /\b(?:it|the plan|the workout|the program|the prescription|that|this)\s+now\s+(?:calls for|shows?|says?|reads?|has|have|is|includes?|reflects?)\b/,
];

function isCompletedMutationSegment(seg) {
  const s = String(seg || '').trim();
  if (!s) return false;
  if (s.includes('?')) return false;               // a question is a proposal
  if (PROPOSAL_MARKER.test(s)) return false;        // modal / future / proposal
  if (ATTRIBUTION_MARKER.test(s)) return false;     // quoting the athlete
  if (NEGATION_MARKER.test(s)) return false;        // negated → no claim
  return COMPLETED_MUTATION_PATTERNS.some((re) => re.test(s));
}

// Return the segment(s) that assert a completed plan/workout mutation by Atlas.
// Empty array = no unsupported mutation claim. State-aware: proposals, questions,
// athlete quotations, and negations are NOT claims.
function detectUnsupportedMutationClaim(text) {
  return segments(text).filter(isCompletedMutationSegment);
}

// ── grounded plan statement ─────────────────────────────────────────────────

function formatPlanLine(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const name = e.name || e.exercise || 'that lift';
  const parts = [];
  const sets = e.sets, reps = e.reps, weight = e.weight, rir = e.rir;
  if (sets != null && reps != null) parts.push(`${sets} sets of ${reps} reps`);
  else if (reps != null) parts.push(`${reps} reps`);
  else if (sets != null) parts.push(`${sets} sets`);
  if (typeof weight === 'number' && weight > 0) parts.push(`at ${weight} lb`);
  if (rir != null) parts.push(`${rir} RIR`);
  return parts.length ? `${name}: ${parts.join(' ')}` : String(name);
}

// A truthful, grounded statement of what the current plan shows for the turn's
// exercise, plus that nothing was changed. When the plan (or the target exercise) is
// not in view, it states that uncertainty rather than inventing a target. This is the
// deterministic replacement for a rejected completed-mutation claim on the read-only
// route — never a completed-write claim itself.
function buildGroundedPlanStatement(context, opts = {}) {
  const c = context && typeof context === 'object' ? context : {};
  const plan = Array.isArray(c.current_plan) ? c.current_plan.filter((e) => e && (e.name || e.exercise)) : [];
  const targets = Array.isArray(opts.exercises) ? opts.exercises : [];
  let entry = null;
  if (plan.length) {
    if (targets.length) {
      const keys = new Set(targets.map(nameKey).filter(Boolean));
      entry = plan.find((e) => keys.has(nameKey(e.name || e.exercise))) || null;
    }
    if (!entry && plan.length === 1) entry = plan[0];
  }
  if (entry) {
    return `The current plan shows ${formatPlanLine(entry)}. I haven't changed it.`;
  }
  if (plan.length) {
    return "I have the current plan in view, but I'm not sure which exercise you mean — tell me the lift and I'll read back exactly what it shows. I haven't changed anything.";
  }
  return "I don't have the current plan in view here, so I can't confirm what it shows — and I haven't changed anything.";
}

module.exports = {
  normalize,
  nameKey,
  significantWords,
  planLiftNames,
  knownLiftNames,
  namedLiftsInMessage,
  resolveTurnExercises,
  hasActiveSession,
  isPlanReferenceLike,
  isActivePlanGroundedTurn,
  narrowContextToPlanTurn,
  detectUnsupportedMutationClaim,
  buildGroundedPlanStatement,
};
