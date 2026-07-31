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
// FAIL-CLOSED follow-up (2026-07-22): a factual plan dispute/correction is now answered
// DETERMINISTICALLY (`isFactualPlanDispute` → `buildDisputeAnswer`), bypassing the model
// for the factual answer — so arbitrary completed-write wording cannot reach the athlete
// on this read-only route without depending on a finite denylist. The model keeps
// narrating genuine "why did you…" explanations (with context narrowed to the requested
// lift, abbreviations resolved); `detectUnsupportedMutationClaim` stays as a backstop on
// that model path only. Explicit modification requests ("change it to…") are excluded
// from the dispute path and keep flowing to the model's proposal → approval → write lane.
//
// The engine owns numbers/decisions; these helpers only select context, construct the
// deterministic dispute answer, and validate wording. They never mutate a plan, never
// write, and never invent a fact.

const { generateLiftCode } = require('./exerciseEnrichment');
const { deriveChatCoachMode } = require('./chatCoachMode');
const { canonicalizeExerciseName } = require('./workoutTextParser');
// Whether the message names a DIFFERENT real exercise than the one matched here — decided
// by the Exercise KB, not by a modifier list this module would have to keep in step.
const { namesDifferentExercise } = require('./explicitExerciseReference');

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

// A canonical comparison key for a lift name, resolving abbreviations/aliases via the
// parser's canonicalizer ("RDL" → "RDL", "OHP" → "Overhead Press", "Romanian Deadlift" →
// "RDL"). Falls back to the raw name key when the canonicalizer finds nothing, so a plain
// name still matches itself. This is what lets "why did you program RDL?" resolve to the
// plan's Romanian Deadlift instead of falling through to the whole plan (Codex #1122).
function canonicalKey(name) {
  let canon = null;
  try { canon = canonicalizeExerciseName(name); } catch { canon = null; }
  const resolved = canon && canon.canonicalName ? canon.canonicalName : name;
  return nameKey(resolved);
}

// Does the message name a specific lift at all (by full name OR abbreviation)? Used to
// avoid the whole-plan fallback for a targeted question whose lift we couldn't map.
function messageNamesALift(message) {
  let canon = null;
  try { canon = canonicalizeExerciseName(message); } catch { canon = null; }
  return !!(canon && canon.canonicalName);
}

// A variant MODIFIER that turns a base lift into a DISTINCT exercise. When one survives the
// strip of the matched lift's words, the message named a second, SHARED-WORD variant that
// the canonicalizer can't recognize on its own — e.g. "Bench Press and Incline Bench Press"
// leaves "incline" after removing bench/press; "Dumbbell Bench Press" leaves "dumbbell".
const LIFT_VARIANT_MODIFIER = /\b(incline|decline|dumbbell|db|cable|machine|smith|goblet|romanian|sumo|hack|bulgarian|deficit|pendlay|zercher|landmine|preacher|spider|reverse|paused?|close[- ]?grip|wide[- ]?grip|single[- ]?arm|one[- ]?arm|neutral[- ]?grip)\b/;

// After a lift has been matched, does the message ALSO name a DIFFERENT lift? Strips the
// matched lift's significant words, then flags either a distinct canonical lift in the
// remainder ("Bench Press and Deadlift…" → Deadlift, off-snapshot) OR a surviving variant
// modifier ("Bench Press and Incline Bench Press…" → "incline"). Either means the correction
// is multi-lift and must fail closed, even though namedLiftsInMessage surfaced only the
// in-plan lift (Codex #1128). The interim heuristic can't perfectly enumerate every free-text
// lift mention — the definitive fix is the Phase-4 packet referent set at answer time.
function mentionsAnotherLift(message, matchedName) {
  const words = significantWords(matchedName);
  if (!words.length) return false;
  let stripped = normalize(message);
  for (const w of words) stripped = stripped.replace(new RegExp(`\\b${escapeRe(w)}\\w*`, 'g'), ' ');
  return messageNamesALift(stripped) || LIFT_VARIANT_MODIFIER.test(stripped);
}

function namedLiftsInMessage(message, context) {
  const m = normalize(message);
  if (!m) return [];
  const known = knownLiftNames(context);
  // 1. Loose significant-word match ("seated rows" → "Seated Row"), minus any lift the
  //    message QUALIFIES into a different exercise. One shared word is otherwise enough:
  //    "zercher squat" matched a planned Back Squat on `squat` and handed back that lift's
  //    diagnostics for an exercise the athlete named explicitly.
  const wordMatched = known.filter((name) => {
    const words = significantWords(name);
    if (!words.length) return false;
    if (!words.some((w) => new RegExp(`\\b${escapeRe(w)}`).test(m))) return false;
    return !namesDifferentExercise(message, name);
  });
  if (wordMatched.length) return wordMatched;
  // 2. Abbreviation/alias resolution via the canonicalizer (RDL, OHP, …): map the message
  // to a canonical lift and match it against the known lifts by canonical key. The same
  // qualifier check applies — the canonicalizer resolves "zercher squat" to Back Squat by
  // its trailing alias, so without it the variant leaks back in through this path.
  const msgKey = canonicalKey(message);
  if (msgKey) {
    const aliasMatched = known.filter((name) => canonicalKey(name) === msgKey
      && !namesDifferentExercise(message, name));
    if (aliasMatched.length) return aliasMatched;
  }
  return [];
}

// The exercise(s) the turn is about: those named in the message (full name or
// abbreviation), else — for a bare correction that names no lift — the active plan the
// correction refers to. A message that DID name a lift we couldn't map to the plan
// returns [] (never the whole plan), so an unrelated lift's diagnostics can't leak in.
function resolveTurnExercises(message, context) {
  const named = namedLiftsInMessage(message, context);
  if (named.length) return named;
  if (messageNamesALift(message)) return [];
  return planLiftNames(context);
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

// The single, established broad-review classifier — a turn that legitimately wants the FULL
// diagnostics ("any problems?", "is anything wrong?", "how's my training going?"). Exported so
// other lanes reuse the SAME definition instead of a narrower copy (D7 clarification demote).
function isBroadReview(message) {
  return BROAD_REVIEW_RE.test(normalize(message));
}

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

// ── completed-work grounding ────────────────────────────────────────────────
//
// A PRESCRIPTION IS NOT WORK. Soul Corpus V2 Session 12 drew, after the athlete's
// goodbye ("…Later."), a reply enumerating three never-performed plan slots as actual
// sets at zero load and then declaring "You have completed the workout." — and, one
// turn earlier, "You've logged 3 sessions so far" when three EXERCISES had been logged
// in ONE session. Nothing rejected either claim: the mutation backstop above covers
// plan MUTATION only, so a fabricated COMPLETION passed straight through to the athlete.
//
// The deterministic verdicts already exist on this route and are already forwarded to
// the model:
//   - `plan_state` (services/sessionPlanExecutor.planStateFromContext) — planned /
//     completed / remaining, with `isComplete` recomputed server-side, never trusted
//     from the client;
//   - `session_tally` — the per-exercise record of what was actually logged this session;
//   - `session_count` — the count of HISTORICAL sessions read from the log.
//
// These helpers hold the model to them. Completed-set and completed-session truth wins:
// a remaining slot may be described as planned or remaining, never projected as actual
// completed work, and a completion verdict may only restate the deterministic one.
// Fail-closed — when the deterministic state is absent, a completion claim is ungrounded
// rather than assumed true.

// Exercises with genuine completed work this session: plan_state.completed plus every
// exercise the deterministic session tally records as logged.
function completedExerciseKeys(context) {
  const c = context && typeof context === 'object' ? context : {};
  const keys = new Set();
  const ps = c.plan_state && typeof c.plan_state === 'object' ? c.plan_state : null;
  if (ps && Array.isArray(ps.completed)) {
    for (const n of ps.completed) { const k = nameKey(n); if (k) keys.add(k); }
  }
  const tally = c.session_tally && typeof c.session_tally === 'object' ? c.session_tally : null;
  if (tally && Array.isArray(tally.exercises)) {
    for (const e of tally.exercises) {
      const k = nameKey(e && e.exercise);
      // A tally row with no set actually logged is not completed work.
      if (k && (e.sets == null || Number(e.sets) > 0)) keys.add(k);
    }
  }
  return keys;
}

// Exercises the deterministic plan state still lists as outstanding, minus anything the
// tally proves was logged (the tally is the stronger evidence of actual work).
function remainingExerciseNames(context) {
  const c = context && typeof context === 'object' ? context : {};
  const ps = c.plan_state && typeof c.plan_state === 'object' ? c.plan_state : null;
  if (!ps || !Array.isArray(ps.remaining)) return [];
  const done = completedExerciseKeys(c);
  return ps.remaining
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => n.trim())
    .filter((n) => !done.has(nameKey(n)));
}

// The ONLY grounded source of "the workout is finished". Absent state → not complete.
function workoutIsComplete(context) {
  const c = context && typeof context === 'object' ? context : {};
  const ps = c.plan_state && typeof c.plan_state === 'object' ? c.plan_state : null;
  return Boolean(ps && ps.isComplete === true);
}

// True when there is ANY authoritative session state to judge a completion claim against.
function hasAuthoritativeSessionState(context) {
  const c = context && typeof context === 'object' ? context : {};
  const ps = c.plan_state && typeof c.plan_state === 'object' ? c.plan_state : null;
  return Boolean(ps && Array.isArray(ps.planned) && ps.planned.length);
}

// Asserts the whole workout/session is finished.
const WORKOUT_COMPLETION_PATTERNS = [
  /\b(?:you|we)(?:'ve| have)?\s+(?:just\s+|now\s+|already\s+)?(?:completed|finished|wrapped up)\s+(?:the|your|today'?s|tonight'?s|this)\s+(?:workout|session|training|training session)\b/,
  /\b(?:the|your|today'?s|tonight'?s|this)\s+(?:workout|session)\s+(?:is|'s|has been|have been|was)\s+(?:now\s+)?(?:complete|completed|done|finished|over|wrapped|in the books)\b/,
  /\bthat'?s\s+(?:the\s+|your\s+|today'?s\s+)?(?:workout|session|everything|it|all of it)\s+(?:done|complete|completed|finished|wrapped)\b/,
  /\b(?:you|we)(?:'re| are)\s+(?:all\s+)?done\s+(?:for\s+(?:the\s+day|today|tonight)|with\s+(?:the|your|today'?s)\s+(?:workout|session))\b/,
  /\bworkout\s+(?:complete|completed|finished)\b/,
];

// A completed-work verb applied to a specific exercise. This — NOT the mere presence of
// numbers — is what makes a segment an actual-work claim. Set enumeration alone is a
// PRESCRIPTION signal at least as often as a performance one ("the plan calls for 200 for
// 10 reps at 1 RIR on Seated Row"), so keying on numerals would reject truthful planning
// prose; the zero-load rule below covers the bare-enumeration fabrication instead.
const COMPLETED_WORK_VERB = /\b(?:completed|finished|logged|did|done|hit|knocked out|got through|wrapped up)\b/;
// Zero LOAD in an actual-set enumeration. Genuine bodyweight work carries weight `null`
// and renders without a load (services/workoutTextParser), so a literal "0 x 8" is always
// a null-coerced prescription rendered as work — never a real logged set. The lookbehinds
// keep an RIR/@ figure ("RIR 0 x 8") from reading as a zero load.
const ZERO_LOAD_SET = /(?<!rir\s)(?<!@\s)(?<![\d.])\b0\s*(?:x|×)\s*\d+/;

// A claim of N HISTORICAL sessions. "3 sets" / "3 exercises" are deliberately not matched.
const SESSION_COUNT_CLAIM = [
  /\b(?:you(?:'ve| have)?\s+)?(?:logged|completed|done|got|recorded)\s+(\d+)\s+(?:sessions?|workouts?)\b/,
  /\b(\d+)\s+(?:sessions?|workouts?)\s+(?:so far|logged|completed|recorded|in the books|under your belt)\b/,
];

// Shared state-awareness with the mutation backstop: a proposal, question, quotation of
// the athlete, or negation is not an assertion.
function isAssertionSegment(seg) {
  const s = String(seg || '').trim();
  if (!s) return false;
  if (s.includes('?')) return false;
  if (PROPOSAL_MARKER.test(s)) return false;
  if (ATTRIBUTION_MARKER.test(s)) return false;
  if (NEGATION_MARKER.test(s)) return false;
  return true;
}

// Does this segment describe the named exercise as PLANNED/REMAINING rather than done?
// Prescription framings ("the plan calls for…", "the target is…") belong here: they are
// truthful statements ABOUT a remaining slot and must pass through untouched.
const REMAINING_FRAMING = /\b(?:remaining|remains|still (?:to|has|have|left|on|shows?)|left to|to come|coming up|next up|planned|prescribed|scheduled|on the plan|outstanding|upcoming|yet to|calls for|call for|target(?:ing|s)?|aim(?:ing)? for|we'?ll|you'?ll|should (?:do|hit|aim)|going to)\b/;

/**
 * detectUngroundedCompletionClaim(text, context) → [{ segment, kind }]
 *
 * Flags prose that converts prescription into completed work, invents actual set
 * numbers, converts an exercise count into a historical session count, or declares
 * completion the deterministic state does not support. Empty array = grounded.
 *
 * Pure. Judges ONLY against `plan_state`, `session_tally`, and `session_count`.
 */
function detectUngroundedCompletionClaim(text, context) {
  const c = context && typeof context === 'object' ? context : {};
  const out = [];
  const remaining = remainingExerciseNames(c);
  const remainingKeys = new Set(remaining.map(nameKey).filter(Boolean));
  const complete = workoutIsComplete(c);
  const authoritative = hasAuthoritativeSessionState(c);
  const engineCount = typeof c.session_count === 'number' && Number.isFinite(c.session_count)
    ? c.session_count
    : null;

  for (const seg of segments(text)) {
    if (!isAssertionSegment(seg)) continue;

    // 1. Workout-completion claim. Grounded ONLY by the deterministic verdict.
    if (!complete && WORKOUT_COMPLETION_PATTERNS.some((re) => re.test(seg))) {
      out.push({ segment: seg, kind: 'workout_completion' });
      continue;
    }

    // 2. Fabricated zero-load actual sets — never a real logged set.
    if (ZERO_LOAD_SET.test(seg)) {
      out.push({ segment: seg, kind: 'fabricated_sets' });
      continue;
    }

    // 3. A remaining slot described as completed work, or enumerated as actual sets.
    if (remainingKeys.size && !REMAINING_FRAMING.test(seg)) {
      const named = remaining.filter((n) => {
        const words = significantWords(n);
        if (!words.length) return normalize(seg).includes(normalize(n));
        return words.every((w) => new RegExp(`\\b${escapeRe(w)}`).test(normalize(seg)));
      });
      if (named.length && COMPLETED_WORK_VERB.test(seg)) {
        out.push({ segment: seg, kind: 'unperformed_slot_as_work' });
        continue;
      }
    }

    // 4. Historical session count. Fail closed when the engine has no count to match.
    for (const re of SESSION_COUNT_CLAIM) {
      const m = re.exec(normalize(seg));
      if (!m) continue;
      const claimed = Number(m[1]);
      if (!Number.isFinite(claimed)) continue;
      if (engineCount == null || claimed !== engineCount) {
        out.push({ segment: seg, kind: 'session_count' });
      }
      break;
    }
  }
  // A completion claim made with NO authoritative session state at all is ungrounded even
  // when no pattern above fired on a remaining slot — there is nothing to complete against.
  if (!authoritative && !complete) {
    for (const seg of segments(text)) {
      if (!isAssertionSegment(seg)) continue;
      if (out.some((o) => o.segment === seg)) continue;
      if (WORKOUT_COMPLETION_PATTERNS.some((re) => re.test(seg))) {
        out.push({ segment: seg, kind: 'workout_completion' });
      }
    }
  }
  return out;
}

/**
 * buildGroundedSessionStateStatement(context) → string
 *
 * The deterministic replacement for rejected completion prose: what is actually logged
 * and what is actually still outstanding, read straight from the engine's state. It
 * never claims completion, never states a load the tally does not carry, and says so
 * plainly when there is no authoritative state.
 */
function buildGroundedSessionStateStatement(context) {
  const c = context && typeof context === 'object' ? context : {};
  const ps = c.plan_state && typeof c.plan_state === 'object' ? c.plan_state : null;
  const tally = c.session_tally && typeof c.session_tally === 'object' ? c.session_tally : null;
  const logged = tally && Array.isArray(tally.exercises)
    ? tally.exercises.map((e) => e && e.exercise).filter(Boolean)
    : [];
  const remaining = remainingExerciseNames(c);

  const parts = [];
  if (logged.length) parts.push(`Logged this session: ${logged.join(', ')}.`);
  else if (ps && Array.isArray(ps.completed) && ps.completed.length) parts.push(`Logged this session: ${ps.completed.join(', ')}.`);

  if (remaining.length) parts.push(`Still remaining: ${remaining.join(', ')}.`);

  if (!parts.length) {
    return "I don't have an authoritative record of what you've completed this session, so I can't say what's done or still outstanding.";
  }
  if (remaining.length) parts.push("Those are still planned, not done — nothing counts as completed until it's logged.");
  return parts.join(' ');
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

// ── fail-closed active-plan dispute answer ──────────────────────────────────
//
// A FACTUAL plan dispute/correction ("that isn't what you planned", "you said 195",
// "the workout says 200×10") is answered DETERMINISTICALLY from the current plan — the
// model is never asked to narrate the factual answer. That is what makes an arbitrary
// completed-write claim structurally impossible on this read-only route: no model prose
// (any wording) reaches the athlete for a dispute, so there is no denylist to outrun.

const MODIFY_VERB = 'change|make|switch|update|set|adjust|swap|replace|bump|drop|remove|redo|rework|cut|lower|raise|increase|decrease';

// An IMPERATIVE request to change the plan ("change it to 3 sets of 8", "make it 8 reps",
// "switch to…", "update the plan to…") — NOT a factual dispute. It must keep flowing to
// the model's proposal → approval → write lane, so it is excluded from the dispute path.
// The verb must open a clause (start / after punctuation / after please|can you|let's) so
// an assertion like "you didn't change the plan" is NOT read as a change request.
const PLAN_MODIFY_RE = new RegExp(`(?:^|[.!?;,]\\s*|\\b(?:please|can you|could you|would you|will you|let'?s|i want you to|i'd like you to)\\s+)(${MODIFY_VERB})\\b`);

// A REQUEST/DESIRE framing where the change verb does NOT open the clause
// ("I want to change the plan to 3x8", "can we change the plan", "I'd like to change it",
// "could you switch it to 8 reps"). The leading cue must be a first-person desire or a
// polite request ("i want/need/like…", "can/could we|you", "would/will you", "let's",
// "please"), so a plain assertion about what was planned ("you set the plan to 3x8") is
// NOT swept in. An over-match here degrades safely: the turn falls through to the model,
// where the mutation-truth backstop still grounds any false completed-write claim — an
// UNDER-match, by contrast, would wrongly deny the athlete the proposal flow (Codex #1126).
const PLAN_MODIFY_REQUEST_RE = new RegExp(`\\b(?:i(?:'d| would)? (?:want|wanna|need|like|love)(?: to| you to)?|we (?:want|need|should|could|can)|can (?:you|we)|could (?:you|we)|would you|will you|let'?s|let us|please)\\b[^.?!;]*?\\b(?:${MODIFY_VERB})\\b`);

function isPlanModificationRequest(message) {
  const m = normalize(message);
  return PLAN_MODIFY_RE.test(m) || PLAN_MODIFY_REQUEST_RE.test(m);
}

// True for a FACTUAL plan dispute/correction during an active session — the turn whose
// factual answer is built deterministically (model bypassed). Excludes broad reviews,
// "why did you…" explanations (those keep model narration, narrowed), and modification
// requests (those keep the proposal flow).
function isFactualPlanDispute(message, context) {
  if (!hasActiveSession(context)) return false;
  const m = normalize(message);
  if (!m || BROAD_REVIEW_RE.test(m)) return false;
  if (PLAN_EXPLAIN_RE.test(m)) return false;
  if (isPlanModificationRequest(m)) return false;
  return isPlanReferenceLike(m);
}

// Extract the numeric targets the athlete CLAIMS (sets / reps / weight / rir), so the
// answer can distinguish the claim from the plan. Deterministic, invents nothing; an
// unparseable claim simply yields fewer fields (the answer then states the plan alone).
function extractClaimedTargets(message) {
  const m = normalize(message).replace(/×/g, 'x');
  const out = {};
  let mm;
  if ((mm = m.match(/\b(\d+)\s*sets?\b/))) out.sets = Number(mm[1]);
  if ((mm = m.match(/\b(\d+)\s*reps?\b/))) out.reps = Number(mm[1]);
  if ((mm = m.match(/\b(\d+)\s*(?:lb|lbs|pounds?)\b/))) out.weight = Number(mm[1]);
  if ((mm = m.match(/\brir\s*(\d+)\b/)) || (mm = m.match(/\b(\d+)\s*rir\b/))) out.rir = Number(mm[1]);
  if ((mm = m.match(/\b(\d+)\s+sets?\s+of\s+(\d+)\b/))) {
    if (out.sets == null) out.sets = Number(mm[1]);
    if (out.reps == null) out.reps = Number(mm[2]);
  }
  // "NxN": weight×reps when the lead number is a plausible load (≥45), else sets×reps.
  if ((mm = m.match(/\b(\d+)\s*x\s*(\d+)\b/))) {
    const a = Number(mm[1]), b = Number(mm[2]);
    if (a >= 45) { if (out.weight == null) out.weight = a; if (out.reps == null) out.reps = b; }
    else { if (out.sets == null) out.sets = a; if (out.reps == null) out.reps = b; }
  }
  // A bare, untagged number that reads like a load — "you said 195". Strip the tokens
  // already claimed above, then a leftover load-sized number (≥45) is the claimed weight.
  if (out.weight == null) {
    const stripped = m
      .replace(/\b\d+\s*sets?\b/g, ' ')
      .replace(/\b\d+\s*reps?\b/g, ' ')
      .replace(/\brir\s*\d+\b|\b\d+\s*rir\b/g, ' ')
      .replace(/\b\d+\s*x\s*\d+\b/g, ' ')
      .replace(/\b\d+\s+sets?\s+of\s+\d+\b/g, ' ')
      .replace(/\b\d+\s*(?:lb|lbs|pounds?)\b/g, ' ');
    const bare = stripped.match(/\b(\d{2,4})\b/);
    if (bare && Number(bare[1]) >= 45) out.weight = Number(bare[1]);
  }
  return out;
}

function formatClaim(claim) {
  const c = claim && typeof claim === 'object' ? claim : {};
  const parts = [];
  if (c.sets != null && c.reps != null) parts.push(`${c.sets} sets of ${c.reps} reps`);
  else if (c.reps != null) parts.push(`${c.reps} reps`);
  else if (c.sets != null) parts.push(`${c.sets} sets`);
  if (c.weight != null) parts.push(`${c.weight} lb`);
  if (c.rir != null) parts.push(`${c.rir} RIR`);
  return parts.join(', ');
}

// Does the claim differ from the plan entry on any field the athlete specified?
function claimDiffersFromPlan(claim, entry) {
  const c = claim || {}, e = entry || {};
  for (const k of ['sets', 'reps', 'weight', 'rir']) {
    if (c[k] != null && e[k] != null && Number(c[k]) !== Number(e[k])) return true;
  }
  return false;
}

// How many of the most recent ATHLETE turns tier 3 may scan. Bounded on purpose: a
// referent recovered from deep history is a stale confident answer, which is worse than
// asking (the whole resolver fails closed instead).
const RECENT_USER_TURN_WINDOW = 3;

// The plan entry a factual dispute is about, resolved DETERMINISTICALLY (never the model,
// never numeric similarity) by a fixed precedence. The production correction ("That isn't
// what you planned. You planned 3 sets at 8 reps.") omits the lift name while the active
// plan holds several exercises — the referent is the lift that was just under discussion.
// Returns the plan entry, or null so the caller fails closed with the ambiguity response.
//
//   1. a lift explicitly named in the CURRENT message (exactly one);
//   2. the session's LAST-DISCUSSED lift — recorded SERVER-SIDE at answer time and passed
//      in via `opts.lastDiscussedLift`, already freshness-bounded by the caller. It is
//      NEVER read from client context (unspoofable). This is the case the prior fix missed:
//      Atlas named the lift ("what's next?" → "Bench Press…"), the athlete disputed without
//      naming it. The route records it in services/coachDiscussionReferent;
//   3. a BOUNDED scan of the last few ATHLETE (role:'user') turns in `history`: stop at the
//      FIRST (most recent) user turn that names ANY plan lift — exactly one is the referent,
//      MORE THAN ONE fails closed. Deep history is never consulted. Atlas replies are never
//      a referent;
//   4. the sole current_plan exercise when the plan has exactly one;
//   5. otherwise null (fail closed).
function resolveDisputedLiftEntry(message, context, history, opts) {
  const c = context && typeof context === 'object' ? context : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const plan = Array.isArray(c.current_plan) ? c.current_plan.filter((e) => e && (e.name || e.exercise)) : [];
  if (!plan.length) return null;
  const findEntry = (name) => {
    if (!name) return null;
    const key = canonicalKey(name);
    return plan.find((e) => canonicalKey(e.name || e.exercise) === key) || null;
  };

  // 1. Named in the current message. The athlete explicitly named a lift, so the answer
  //    must be about THAT lift or a clarification — never a substituted referent. Resolve
  //    only when EXACTLY ONE named lift maps to a current_plan entry. Otherwise fail closed
  //    before the referent/history fallbacks (Codex #1128):
  //      • more than one named ("Bench Press and Seated Row aren't what you planned") is an
  //        ambiguous correction, not an omitted-lift one; and
  //      • a single named lift that is NOT in the current plan — e.g. an unplanned preview
  //        or history lift that knownLiftNames surfaces ("Deadlift isn't what you planned"
  //        when Deadlift is only a preview row) — must clarify, not answer for a stale lift.
  const named = namedLiftsInMessage(message, c);
  if (named.length >= 1) {
    // Resolve ONLY when the message names exactly one lift total and it maps to the plan.
    // `mentionsAnotherLift` catches a second, off-snapshot canonical lift that
    // namedLiftsInMessage didn't surface ("Bench Press and Deadlift are not what you
    // planned"); any such ambiguity fails closed.
    if (named.length === 1 && !mentionsAnotherLift(message, named[0])) {
      const e = findEntry(named[0]);
      if (e) return e;
    }
    return null;
  }
  // The athlete named a canonical lift that appears NOWHERE in the snapshot (not plan,
  // preview, or history) — namedLiftsInMessage returns [] for it, but messageNamesALift
  // still recognizes it. It is an explicitly named lift, so fail closed rather than answer
  // for a referent (Codex #1128). A genuine omitted-lift correction names no lift, so
  // messageNamesALift is false there and tier 2/3 below still run.
  if (messageNamesALift(message)) return null;

  // 2. The session's server-recorded last-discussed lift (already freshness-bounded).
  if (o.lastDiscussedLift) { const e = findEntry(o.lastDiscussedLift); if (e) return e; }

  // 3. Bounded scan of the last few athlete turns; stop at the first that names any plan
  //    lift (1 → referent, >1 → fail closed). Never scan deep history.
  if (Array.isArray(history)) {
    let userTurnsSeen = 0;
    for (let i = history.length - 1; i >= 0 && userTurnsSeen < RECENT_USER_TURN_WINDOW; i -= 1) {
      const turn = history[i];
      if (!turn || typeof turn !== 'object' || turn.role !== 'user') continue;
      userTurnsSeen += 1;
      const text = typeof turn.text === 'string' ? turn.text
        : (typeof turn.message === 'string' ? turn.message : '');
      if (!text) continue;
      const inTurn = namedLiftsInMessage(text, c);
      if (inTurn.length === 0) continue;                 // named no plan lift — keep scanning the window
      if (inTurn.length === 1) return findEntry(inTurn[0]) || null;  // first lift-naming turn → single referent
      return null;                                       // first lift-naming turn named >1 → fail closed
    }
  }

  // 4. Sole plan exercise.
  if (plan.length === 1) return plan[0];

  // 5. Fail closed.
  return null;
}

// A "what's next? / what am I doing next?" next-up question. Tight on purpose: this only
// seeds the discussion-referent, so over-matching would mis-seed a later bare dispute.
const NEXT_UP_RE = /\bwhat('?s| is)? next\b|\bwhat am i (?:doing|lifting|on|up to)(?: next)?\b|\bnext (?:exercise|lift|movement|up)\b/;

function isNextUpQuestion(message) {
  return NEXT_UP_RE.test(normalize(message));
}

// The next planned lift's NAME, from the server-recomputed plan_state.remaining[0] (the
// same client-derived plan state the route already holds), else the first plan entry when
// no completion info is present. Used to seed the referent for a next-up answer.
function nextPlannedLiftName(context) {
  const c = context && typeof context === 'object' ? context : {};
  const ps = c.plan_state;
  if (ps && Array.isArray(ps.remaining) && ps.remaining.length) {
    const r0 = ps.remaining[0];
    const name = typeof r0 === 'string' ? r0 : (r0 && (r0.name || r0.exercise)) || null;
    if (name) return name;
  }
  const plan = Array.isArray(c.current_plan) ? c.current_plan.filter((e) => e && (e.name || e.exercise)) : [];
  return plan.length ? (plan[0].name || plan[0].exercise) : null;
}

// The single plan lift THIS turn's answer is about — recorded server-side as the session's
// last-discussed lift so a later bare dispute can resolve to it (resolver tier 2). Covers
// "Atlas named the lift, the athlete didn't": a lift named in the message (an explanation
// or a value question), or the next-up lift for a "what's next?" answer. Returns the
// canonical key, or null when the turn is about no single identifiable plan lift. The
// dispute turn's referent is the RESOLVED disputed entry (the route records that separately).
function resolveDiscussedLift(message, context) {
  const c = context && typeof context === 'object' ? context : {};
  const plan = Array.isArray(c.current_plan) ? c.current_plan.filter((e) => e && (e.name || e.exercise)) : [];
  if (!plan.length) return null;
  const named = namedLiftsInMessage(message, c);
  if (named.length === 1) return canonicalKey(named[0]);
  if (isNextUpQuestion(message)) {
    const nextName = nextPlannedLiftName(c);
    if (nextName) return canonicalKey(nextName);
  }
  return null;
}

// The deterministic answer to a factual plan dispute: state what the plan currently
// shows for the disputed lift, distinguish the athlete's claim, and state plainly that
// nothing was changed. Never claims an update/save/switch/adjustment. When the plan (or
// the specific lift) is not in view, it states that uncertainty rather than inventing a
// target. This bypasses the model entirely for the factual answer (fail-closed). `history`
// (prior `{role,text}` turns) and `opts.lastDiscussedLift` (server-recorded, freshness-
// bounded) supply the omitted-lift referent for a bare correction.
function buildDisputeAnswer(message, context, history, opts) {
  const c = context && typeof context === 'object' ? context : {};
  const plan = Array.isArray(c.current_plan) ? c.current_plan.filter((e) => e && (e.name || e.exercise)) : [];
  if (!plan.length) {
    return "I don't have the current plan in view here, so I can't confirm what it shows — and I haven't changed anything.";
  }
  const entry = resolveDisputedLiftEntry(message, c, history, opts);
  if (!entry) {
    return "I have the current plan in view, but I'm not sure which exercise you mean — tell me the lift and I'll read back exactly what it shows. I haven't changed anything.";
  }
  const planLine = formatPlanLine(entry);
  const claim = extractClaimedTargets(message);
  const claimStr = formatClaim(claim);
  if (claimStr && claimDiffersFromPlan(claim, entry)) {
    return `The current plan shows ${planLine} — not ${claimStr}. I haven't changed it.`;
  }
  if (claimStr) {
    // The athlete's numbers match the plan (they misremembered it as a mismatch).
    return `The current plan shows ${planLine} — that's what you said. I haven't changed it.`;
  }
  return `The current plan shows ${planLine}. I haven't changed it.`;
}

module.exports = {
  normalize,
  nameKey,
  significantWords,
  planLiftNames,
  knownLiftNames,
  namedLiftsInMessage,
  resolveTurnExercises,
  messageNamesALift,
  canonicalKey,
  hasActiveSession,
  isPlanReferenceLike,
  isPlanModificationRequest,
  isFactualPlanDispute,
  isBroadReview,
  isActivePlanGroundedTurn,
  narrowContextToPlanTurn,
  detectUnsupportedMutationClaim,
  detectUngroundedCompletionClaim,
  buildGroundedSessionStateStatement,
  workoutIsComplete,
  remainingExerciseNames,
  extractClaimedTargets,
  resolveDisputedLiftEntry,
  isNextUpQuestion,
  nextPlannedLiftName,
  resolveDiscussedLift,
  buildGroundedPlanStatement,
  buildDisputeAnswer,
};
