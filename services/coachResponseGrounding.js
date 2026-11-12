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
const { namesDifferentExercise, unresolvableExerciseReference } = require('./explicitExerciseReference');

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
//
// Clause-split (Astra #1662 sibling; Codex #1225 P1 pattern): a modal in a LATER
// clause must not excuse a completed claim asserted in an EARLIER one —
// "I changed it to 275, so you can save it." bypassed the guard because "can"
// exempted the whole sentence as a proposal. Each clause is judged on its own
// markers; clause findings are UNIONED with the whole-segment result, never
// substituted for it, so splitting can only ever add a detection.
function detectUnsupportedMutationClaim(text) {
  const out = [];
  for (const whole of segments(text)) {
    if (isCompletedMutationSegment(whole)) { out.push(whole); continue; }
    const parts = whole.split(CLAUSE_BOUNDARY).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      for (const p of parts) if (isCompletedMutationSegment(p) && !out.includes(p)) out.push(p);
    }
  }
  return out;
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

// Exercises with genuine completed work this session: plan_state.completed, plus a
// session_tally row that meets the prescription rule below. plan_state.completed is
// membership and is not reinterpreted here.
//
// A tally row completes an exercise only when its logged set count reaches the
// prescribed set count, and only when that count is known. The prescription is the
// positive finite `sets` on the same context's current_plan entry, matched by nameKey.
// Logged count >= prescribed → completed. Logged count < prescribed → not completed
// by the tally. No known prescription (the lift is off the plan, or the plan entry
// has no positive set count) keeps the prior rule: any logged set completes it.
// sets == 0 is not completed work. sets == null keeps the prior treatment, because
// a null count cannot prove a partial.
function prescribedSetCount(context, key) {
  if (!key) return null;
  const plan = Array.isArray(context.current_plan) ? context.current_plan : [];
  for (const entry of plan) {
    if (!entry || typeof entry !== 'object') continue;
    if (nameKey(entry.name || entry.exercise) !== key) continue;
    const sets = entry.sets;
    if (typeof sets === 'number' && Number.isFinite(sets) && sets > 0) return sets;
  }
  return null;
}

function tallyRowCompletesExercise(entry, context) {
  const sets = entry ? entry.sets : undefined;
  // A tally row with no set actually logged is not completed work.
  if (sets != null && !(Number(sets) > 0)) return false;
  const prescribed = prescribedSetCount(context, nameKey(entry && entry.exercise));
  // Unknown prescription, or a null logged count (partial not provable): prior rule.
  if (prescribed == null || sets == null) return true;
  return Number(sets) >= prescribed;
}

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
      if (k && tallyRowCompletesExercise(e, c)) keys.add(k);
    }
  }
  return keys;
}

// Exercises the deterministic plan state still lists as outstanding, minus anything
// completedExerciseKeys treats as finished. plan_state.completed always wins. A tally
// row wins only under the prescription rule in tallyRowCompletesExercise.
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
// "lifted" (#1710): the audit's set-lying probe — "You lifted 315 for 12 reps" —
// escaped every detector because the verb was missing here, even though it asserts
// completed work exactly as "logged" or "did" does.
const COMPLETED_WORK_VERB = /\b(?:completed|finished|logged|did|done|hit|lifted|knocked out|got through|wrapped up)\b/;
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

// Clause split (Codex #1225 P1). Sentence-level state-awareness is too coarse: a false
// completion ASSERTED in one clause escaped when a LATER clause carried a question mark
// or a modal — "You completed the workout, so should we cool down?" and "You completed
// the workout, so you should cool down." both reached the athlete unchanged. Each clause
// is judged on its own markers instead.
//
// Splits only on an explicit clause boundary — a semicolon, a dash, a comma FOLLOWED
// BY a conjunction, or a bare "so" opening a purpose clause with a subject pronoun
// ("…so you can save it") — so an ordinary list ("Squat, Bench Press and Row are
// logged") stays one clause. The bare-"so" alternative is the re-audit #1662 sibling:
// "I changed it to 275 so you can save it." (no comma) escaped the mutation guard
// because "can" exempted the whole sentence; the completed claim lives in its own
// clause before the modal. The pronoun lookahead keeps "so far" / "so much" /
// "so 3 sets" unsplit. Clause findings are UNIONED with the whole-segment result,
// never substituted for it, so splitting can only ever add a detection.
const CLAUSE_BOUNDARY = /\s*(?:;|,\s*(?:so|but|and|then|although|though|while|yet)\b|\s+[—–]\s+|so\s+(?=(?:you|we|i|it|they|he|she|that|this)\b))\s*/;

function assertedClauses(seg) {
  const whole = String(seg || '').trim();
  if (!whole) return [];
  const out = [];
  if (isAssertionSegment(whole)) out.push(whole);
  const parts = whole.split(CLAUSE_BOUNDARY).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    for (const p of parts) if (isAssertionSegment(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

// A count framed as THIS session rather than training history. `session_count` is built
// from PREVIOUSLY logged sessions (routes/coachOps.js) and deliberately excludes the
// in-progress one, so comparing a current-session count against it rejects a truthful
// statement — "You completed 1 workout today" (Codex #1225 P2). Current-session counts
// are governed by plan_state / session_tally, which the completion rules above already
// enforce; they are not historical claims and are not judged here.
const CURRENT_SESSION_FRAMING = /\b(?:today|tonight|this (?:session|workout|morning|evening|afternoon)|just now|right now)\b/;

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

  const seen = new Set();
  const flag = (segment, kind) => {
    const key = `${kind}::${segment}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ segment, kind });
  };

  for (const whole of segments(text)) {
    for (const seg of assertedClauses(whole)) {
      // 1. Workout-completion claim. Grounded ONLY by the deterministic verdict.
      if (!complete && WORKOUT_COMPLETION_PATTERNS.some((re) => re.test(seg))) {
        flag(seg, 'workout_completion');
        continue;
      }

      // 2. Fabricated zero-load actual sets — never a real logged set.
      if (ZERO_LOAD_SET.test(seg)) {
        flag(seg, 'fabricated_sets');
        continue;
      }

      // 3. A remaining slot described as completed work.
      if (remainingKeys.size && !REMAINING_FRAMING.test(seg)) {
        const named = remaining.filter((n) => {
          const words = significantWords(n);
          if (!words.length) return normalize(seg).includes(normalize(n));
          return words.every((w) => new RegExp(`\\b${escapeRe(w)}`).test(normalize(seg)));
        });
        if (named.length && COMPLETED_WORK_VERB.test(seg)) {
          flag(seg, 'unperformed_slot_as_work');
          continue;
        }
      }

      // 4. HISTORICAL session count. A current-session framing is governed by the rules
      // above, not by `session_count`, so it is never judged here. Fail closed when the
      // engine has no historical count to match.
      if (CURRENT_SESSION_FRAMING.test(seg)) continue;
      for (const re of SESSION_COUNT_CLAIM) {
        const m = re.exec(normalize(seg));
        if (!m) continue;
        const claimed = Number(m[1]);
        if (!Number.isFinite(claimed)) continue;
        if (engineCount == null || claimed !== engineCount) flag(seg, 'session_count');
        break;
      }
    }
  }
  // A completion claim made with NO authoritative session state at all is ungrounded even
  // when no pattern above fired on a remaining slot — there is nothing to complete against.
  if (!authoritative && !complete) {
    for (const whole of segments(text)) {
      for (const seg of assertedClauses(whole)) {
        if (WORKOUT_COMPLETION_PATTERNS.some((re) => re.test(seg))) flag(seg, 'workout_completion');
      }
    }
  }
  return out;
}

// ── recap-number grounding (Astra #1662, P1-4) ─────────────────────────────
//
// detectUngroundedCompletionClaim above checks completion / zero-load invention /
// remaining lifts / historical counts — not nonzero per-set numerical
// equivalence. The coach is instructed to use session_tally
// (services/coach.js:973-978) but an instruction is not a validator: the
// audit's constructed state (accepted RDL 275x6x3; retained rows 285x6 @2 x3)
// lets BOTH "The RDLs are also logged as planned." and "You logged Romanian
// Deadlift at 275 for 6 reps across 3 sets." pass, and "bench 25x10 as
// planned" passes over actual 25x8 rows.
//
// This detector judges recap/confirmation prose against the retained rows in
// session_tally (the authoritative record) and, for "as planned" claims,
// against the current_plan entry. Only an explicit completed-work assertion
// counts — a bare set enumeration is prescription as often as performance
// (A5b), so it is never judged here. Multi-lift clauses are split on the
// conjunctions joining the per-lift assertions and each piece is judged
// against its own lift; a clause whose pieces cannot be attributed is flagged
// rather than skipped. A number shape with two true readings (weight x
// reps vs sets x reps — "25x8") is grounded when ANY reading matches the
// retained rows; only a claim no reading matches is flagged. Fail-closed:
// numbers asserted with no retained rows to check against are ungrounded.

// An "as planned / as prescribed / as programmed" equivalence claim.
const AS_PLANNED_RE = /\bas (?:planned|prescribed|programmed)\b/;
// A historical framing — last week, yesterday, a previous session — is not a
// this-session recap; it is judged against recent_sessions instead (#1709).
// "Ago" is deliberately NOT bare: "a moment ago" / "minutes ago" is THIS
// session, only a days-or-more "ago" is history.
const RECAP_HISTORY_RE = /\b(?:last (?:week|session|workout|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|yesterday|previously|a week ago|days ago|weeks ago|months ago|years ago|in your last)\b/;
// Conjunctions joining per-lift assertions in one recap clause ("…and…",
// "…+…", "…,…"). Used only to attribute numbers per lift in a multi-lift
// clause; the split is accepted only when every piece names exactly one lift.
const MULTI_LIFT_JOIN = /,\s+|\s+and\s+|\s*\+\s*/;
// "In the books" is a completion idiom (cf. WORKOUT_COMPLETION_PATTERNS) —
// a per-lift "in the books" claim asserts logged work just as "logged" does.
const RECAP_IN_THE_BOOKS_RE = /\bin the books\b/;

// Strict null-or-undefined checks — the file's `!= null` idiom trips eqeqeq,
// so new code uses these helpers and adds no new lint warnings.
function isNil(v) { return v === null || v === undefined; }
function hasValue(v) { return !isNil(v); }

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const WORD_NUM_RE = Object.keys(WORD_NUMBERS).join('|');

function numToken(tok) {
  if (/^\d+$/.test(tok)) return Number(tok);
  return WORD_NUMBERS[tok] ?? null;
}

// Weight tokens are decimal-aware: the parser converts decimal kg to lb
// rounded to 1 decimal (workoutTextParser.js:64), so every kg-logged lift
// carries a decimal retained weight ("27.5", "60.6"). An integer-only token
// would truncate "27.5" to 27 and flag every honest decimal recap.
const DECIMAL_NUM = String.raw`\d+(?:\.\d+)?`;

// The parser's kg→lb conversion (services/workoutTextParser.js: KG_TO_LB,
// normalizeWeightUnits): kilograms convert to pounds rounded to 0.1 lb, so
// 27.5 kg is stored as 60.6 lb. The recap validator must apply the same
// conversion, or honest kg recaps false-red and false kg recaps pass.
const KG_TO_LB = 2.20462;
function kgToLb(kg) { return Math.round(kg * KG_TO_LB * 10) / 10; }

// The asserted numbers in a recap clause, as candidate readings. Explicit
// tokens (N sets / N reps / N lb / N sets of M / at N / RIR) are fixed across
// readings; each "AxB" shape branches into a weight reading and a sets
// reading when neither is fixed, because "25x8" is genuinely ambiguous. A
// three-part "AxBxC" reads as weight x reps x sets, the recap convention.
// A pair whose reps contradict an explicit reps token marks every reading
// contradictory — the clause asserts two different rep counts at once.
function extractAssertedReadings(seg) {
  let s = normalize(seg).replace(/×/g, 'x');
  const fixed = {};
  const strip = (re, fn) => {
    s = s.replace(re, (...args) => { fn(args); return ' '; });
  };
  let m;
  // A three-part "AxBxC" reads as weight x reps x sets, the recap convention.
  // The weight may carry its unit ("27.5 kg x 8 x 3"): a kg weight converts
  // to the stored pounds before comparing, or the honest kg triple false-reds
  // and the false kg triple passes on its reps/sets alone.
  if ((m = s.match(new RegExp(`(${DECIMAL_NUM})\\s*(kg|kgs|kilos?|kilograms?|lb|lbs|pounds?)?\\s*x\\s*(\\d+)\\s*x\\s*(\\d+)`)))) {
    fixed.weight = m[2] && /^(kg|kgs|kilos?|kilograms?)$/.test(m[2]) ? kgToLb(Number(m[1])) : Number(m[1]);
    fixed.reps = Number(m[3]); fixed.sets = Number(m[4]);
    s = s.replace(new RegExp(`(${DECIMAL_NUM})\\s*(kg|kgs|kilos?|kilograms?|lb|lbs|pounds?)?\\s*x\\s*(\\d+)\\s*x\\s*(\\d+)`), ' ');
  }
  strip(/(\d+)\s+sets?\s+of\s+(\d+)/, (a) => { if (isNil(fixed.sets)) fixed.sets = Number(a[1]); if (isNil(fixed.reps)) fixed.reps = Number(a[2]); });
  strip(new RegExp(`(\\d+|${WORD_NUM_RE})\\s*sets?\\b`), (a) => { const n = numToken(a[1]); if (hasValue(n) && isNil(fixed.sets)) fixed.sets = n; });
  strip(new RegExp(`(\\d+|${WORD_NUM_RE})\\s*reps?\\b`), (a) => { const n = numToken(a[1]); if (hasValue(n) && isNil(fixed.reps)) fixed.reps = n; });
  // Kilograms convert to the stored pounds (see kgToLb above) so "at 27.5 kg"
  // matches retained 60.6 lb and "at 60.6 kg" does not. Runs before the bare
  // `at N` strip, or "at 27.5 kg" would be read as 27.5 lb.
  strip(new RegExp(`(${DECIMAL_NUM})\\s*(?:kg|kgs|kilos?|kilograms?)\\b`), (a) => { if (isNil(fixed.weight)) fixed.weight = kgToLb(Number(a[1])); });
  strip(new RegExp(`(${DECIMAL_NUM})\\s*(?:lb|lbs|pounds?)\\b`), (a) => { if (isNil(fixed.weight)) fixed.weight = Number(a[1]); });
  // RIR (#1709): an asserted RIR ("0 RIR", "RIR 2", "@ 2") is a number the
  // recap matcher must validate, exactly like weight/reps/sets — the tally's
  // per_set carries rir, but the matcher never read it, so any invented RIR
  // on an otherwise-true recap passed. "@ N" is RIR by the recap convention
  // ("weight x reps @ RIR N"); it is stripped here, before the pairs pass,
  // so it can never be re-read as a weight or a set count. Word numbers
  // ("two RIR") resolve the same way sets/reps do.
  strip(new RegExp(`\\brir\\s*(\\d+|${WORD_NUM_RE})\\b`), (a) => { const n = numToken(a[1]); if (hasValue(n) && isNil(fixed.rir)) fixed.rir = n; });
  strip(new RegExp(`(\\d+|${WORD_NUM_RE})\\s*rir\\b`), (a) => { const n = numToken(a[1]); if (hasValue(n) && isNil(fixed.rir)) fixed.rir = n; });
  strip(/@\s*(\d+(?:\.\d+)?)\b/, (a) => { if (isNil(fixed.rir)) fixed.rir = Number(a[1]); });
  // The lookahead also excludes a following unit word the validator cannot
  // normalize ("at 100 stone" must not be read as 100 lb); the unhandled-unit
  // guard below fails such a clause closed instead.
  strip(new RegExp(`at\\s+(${DECIMAL_NUM})\\b(?!\\s*(?:reps?|sets?|rir|kg|kgs|kilos?|kilograms?|lb|lbs|pounds?|stone|stones|oz|ounces?|grams?|g)\\b)`), (a) => { if (isNil(fixed.weight)) fixed.weight = Number(a[1]); });
  const pairs = [];
  s = s.replace(new RegExp(`(${DECIMAL_NUM})\\s*x\\s*(\\d+)`, 'g'), (...args) => { pairs.push([Number(args[1]), Number(args[2])]); return ' '; });

  let readings = [{ ...fixed }];
  for (const [a, b] of pairs) {
    if (hasValue(fixed.reps) && b !== fixed.reps) {
      readings = readings.map((r) => ({ ...r, __conflict: true }));
      continue;
    }
    const next = [];
    for (const r of readings) {
      if (r.__conflict) { next.push(r); continue; }
      const candidates = [];
      if (isNil(r.weight) && isNil(r.sets)) {
        candidates.push({ ...r, weight: a, reps: b }, { ...r, sets: a, reps: b });
      } else if (hasValue(r.sets) && isNil(r.weight)) {
        candidates.push({ ...r, weight: a, reps: b });
      } else if (hasValue(r.weight) && isNil(r.sets)) {
        candidates.push({ ...r, sets: a, reps: b });
      } else {
        if (r.weight === a) candidates.push({ ...r, reps: b });
        if (r.sets === a) candidates.push({ ...r, reps: b });
      }
      const surviving = candidates.filter(() => isNil(r.reps) || r.reps === b);
      if (surviving.length) next.push(...surviving);
      else next.push({ ...r, __conflict: true });
    }
    readings = next;
  }
  // A weight asserted in a unit the validator cannot normalize (stone, oz,
  // grams, …) is unvalidated, not absent: mark every reading contradictory so
  // the clause fails closed instead of passing on its reps/sets alone. The
  // `at N` lookahead above leaves such a token in place for this guard.
  if (new RegExp(`(${DECIMAL_NUM})\\s*(?:stone|stones|oz|ounces?|grams?|g)\\b`).test(s)) {
    readings = readings.map((r) => ({ ...r, __conflict: true }));
  }
  // A second, different RIR asserted in the same clause contradicts the first
  // ("at 0 RIR and 2 RIR") — the strips above take only the first, so a
  // leftover RIR token with another value marks every reading contradictory,
  // the same fail-closed rule the pairs pass applies to reps.
  const leftoverRir = s.match(new RegExp(`(?:\\brir\\s*(\\d+|${WORD_NUM_RE})\\b|(\\d+|${WORD_NUM_RE})\\s*rir\\b|@\\s*(\\d+(?:\\.\\d+)?)\\b)`));
  if (leftoverRir) {
    const v = numToken(leftoverRir[1] || leftoverRir[2] || leftoverRir[3]);
    if (hasValue(fixed.rir) && hasValue(v) && v !== fixed.rir) {
      readings = readings.map((r) => ({ ...r, __conflict: true }));
    }
  }
  return readings;
}

// The lifts a recap clause may be about: plan + preview + the tally's own
// logged lifts (an off-plan extra is judged against its own retained rows).
function namedRecapLifts(seg, context) {
  const c = context && typeof context === 'object' ? context : {};
  const names = [];
  for (const e of (Array.isArray(c.current_plan) ? c.current_plan : [])) {
    if (e && (e.name || e.exercise)) names.push(String(e.name || e.exercise));
  }
  for (const e of (Array.isArray(c.current_preview) ? c.current_preview : [])) {
    if (e && (e.exercise || e.name)) names.push(String(e.exercise || e.name));
  }
  const tally = c.session_tally && typeof c.session_tally === 'object' ? c.session_tally : null;
  if (tally && Array.isArray(tally.exercises)) {
    for (const e of tally.exercises) if (e && e.exercise) names.push(String(e.exercise));
  }
  const found = namedLiftsInMessage(seg, { current_plan: dedupeByKey(names).map((n) => ({ name: n })) });
  // Whole-message alias resolution returns a single canonical key, so a
  // clause naming two lifts by alias ("RDLs and bench") resolves only one of
  // them. Scan single tokens too: a token resolving to a known lift's
  // canonical key adds that lift. Over-matching is safe here — the caller
  // filters to lifts the clause actually distinguishes, and anything left
  // ambiguous fails closed.
  for (const tok of normalize(seg).split(/[^a-z0-9]+/).filter(Boolean)) {
    const tk = canonicalKey(tok);
    for (const n of dedupeByKey(names)) {
      if (canonicalKey(n) === tk && !found.includes(n)) found.push(n);
    }
  }
  return found;
}

// A named lift actually OCCURS in a recap clause only when the clause carries
// a mention that distinguishes it from the other lifts named in the same
// clause: its full name, a run of its significant words containing a word no
// other named lift shares, or an alias token that resolves to it alone (a
// token resolving to several candidates — "bench" → "Bench Press" for both
// bench variants — does not discriminate). The loose word match in
// namedLiftsInMessage otherwise returns BOTH variants whenever they share
// words ("bench press" matches "Dumbbell Bench Press" even when the clause
// says "Barbell Bench Press"), which would read a single-lift recap as
// multi-lift and fail it closed. A lift with no discriminating mention is
// dropped, not guessed at; the caller keeps the unfiltered list when the
// filter empties it, so a wholly ambiguous clause still fails closed.
function liftsOccurringInClause(lifts, seg) {
  const m = normalize(seg);
  const wordsOf = (name) => significantWords(name);
  return lifts.filter((name) => {
    if (normalize(name) && m.includes(normalize(name))) return true;
    const mine = wordsOf(name);
    const others = new Set(lifts.filter((n) => n !== name).flatMap(wordsOf));
    for (let len = mine.length; len >= 1; len -= 1) {
      for (let i = 0; i + len <= mine.length; i += 1) {
        const run = mine.slice(i, i + len);
        if (!run.some((w) => !others.has(w))) continue;
        const re = new RegExp(`\\b${run.map((w) => `${escapeRe(w)}\\w*`).join('\\s+')}`);
        if (re.test(m)) return true;
      }
    }
    const myKey = canonicalKey(name);
    const otherKeys = new Set(lifts.filter((n) => n !== name).map((n) => canonicalKey(n)));
    for (const tok of m.split(/[^a-z0-9]+/).filter(Boolean)) {
      // A token that is also a word of another lift's name cannot discriminate
      // it (issue #1685 follow-up): 'bench' sits in both bench variants'
      // names, so it must not single out either one even though the two
      // variants now carry distinct canonical keys ('Dumbbell Bench Press'
      // is a parser canonical; 'Barbell Bench Press' still resolves through
      // the 'bench press' alias). Without this, a single-lift dumbbell recap
      // reads as multi-lift and fails closed on its own true numbers.
      if (others.has(tok)) continue;
      if (canonicalKey(tok) === myKey && !otherKeys.has(myKey)) return true;
    }
    return false;
  });
}

function tallyEntryForLift(context, name) {
  const tally = context && context.session_tally && typeof context.session_tally === 'object' ? context.session_tally : null;
  if (!tally || !Array.isArray(tally.exercises)) return null;
  // Exact exercise identity first: the KB canonicalizer collapses variants
  // ("Dumbbell Bench Press" and "Barbell Bench Press" both → "Bench Press"),
  // so a canonical-only lookup resolves by tally order and judges a recap
  // against the WRONG variant's rows. An exact-name hit is unambiguous.
  const exact = nameKey(name);
  const exactHit = tally.exercises.find((e) => e && nameKey(e.exercise) === exact);
  if (exactHit) return exactHit;
  // Alias fallback only when it resolves uniquely — an ambiguous canonical
  // match (two variants in the tally) cannot verify the recap, so it fails
  // closed (null → the caller flags the clause).
  const key = canonicalKey(name);
  const canonHits = tally.exercises.filter((e) => e && canonicalKey(e.exercise) === key);
  return canonHits.length === 1 ? canonHits[0] : null;
}

function planEntryForLift(context, name) {
  const plan = context && Array.isArray(context.current_plan) ? context.current_plan : [];
  // Same exact-first rule as the tally lookup: a canonical-only match must
  // not silently resolve a variant recap against the other variant's plan.
  const exact = nameKey(name);
  const exactHit = plan.find((e) => e && nameKey(e.name || e.exercise) === exact);
  if (exactHit) return exactHit;
  const key = canonicalKey(name);
  const canonHits = plan.filter((e) => e && canonicalKey(e.name || e.exercise) === key);
  return canonHits.length === 1 ? canonHits[0] : null;
}

// Does one candidate reading match the retained rows? Every retained set
// with a known weight/reps/rir must equal the asserted value, and the set
// count must equal the tally's. A field the tally carries no data for cannot
// be verified, so a reading asserting it does not match — fail closed.
function readingMatchesTally(reading, entry) {
  if (!entry || reading.__conflict) return false;
  const sets = Array.isArray(entry.per_set) ? entry.per_set : [];
  if (hasValue(reading.weight)) {
    const known = sets.map((s) => s && s.weight).filter((w) => hasValue(w));
    if (!known.length || !known.every((w) => Number(w) === reading.weight)) return false;
  }
  if (hasValue(reading.reps)) {
    const known = sets.map((s) => s && s.reps).filter((r) => hasValue(r));
    if (!known.length || !known.every((r) => Number(r) === reading.reps)) return false;
  }
  if (hasValue(reading.sets)) {
    const n = hasValue(entry.sets) ? Number(entry.sets) : sets.length;
    if (!Number.isFinite(n) || n !== reading.sets) return false;
  }
  // RIR (#1709): the tally's per_set carries rir, and an asserted RIR is
  // judged exactly like weight/reps — every known rir must equal it, and a
  // tally with no rir data cannot verify one.
  if (hasValue(reading.rir)) {
    const known = sets.map((s) => s && s.rir).filter((r) => hasValue(r));
    if (!known.length || !known.every((r) => Number(r) === reading.rir)) return false;
  }
  return true;
}

// Does the retained tally match the plan entry on every numeric field the
// plan carries? An off-plan extra was never planned, and a plan entry with
// no numeric field at all cannot verify an "as planned" claim — both fail.
function tallyMatchesPlan(tally, plan) {
  if (!tally || !plan) return false;
  if (tally.planned === false) return false;
  const sets = Array.isArray(tally.per_set) ? tally.per_set : [];
  if (isNil(plan.sets) && isNil(plan.reps) && isNil(plan.weight)) return false;
  if (hasValue(plan.weight)) {
    const known = sets.map((s) => s && s.weight).filter((w) => hasValue(w));
    if (!known.length || !known.every((w) => Number(w) === Number(plan.weight))) return false;
  }
  if (hasValue(plan.reps)) {
    const known = sets.map((s) => s && s.reps).filter((r) => hasValue(r));
    if (!known.length || !known.every((r) => Number(r) === Number(plan.reps))) return false;
  }
  if (hasValue(plan.sets)) {
    const n = hasValue(tally.sets) ? Number(tally.sets) : sets.length;
    if (!Number.isFinite(n) || n !== Number(plan.sets)) return false;
  }
  return true;
}

// ── history grounding (#1709) ──────────────────────────────────────────────
//
// A history-framed numeric claim ("last session you logged Bench at 315 for
// 12") was skipped outright by the recap detector, and the completion detector
// judges only historical *session counts* — so invented history passed every
// backstop. The truth is in the context: recent_sessions[*].lift_sets maps
// each exercise to its real logged sets (weight x reps @ RIR), most recent
// session first (services/analytics.js buildRecentSessions sorts date
// descending). History claims are judged against it: "last session /
// yesterday / last time" binds to the most recent session carrying the lift;
// vaguer framings ("last week", "previously", "ago") bind to any recorded
// session carrying it. A lift with no recorded session, or numbers no
// recorded session carries, fails closed.

// "Last session / yesterday / last time" names the most recent session; the
// other RECAP_HISTORY_RE framings name the past generally.
const LAST_SESSION_RE = /\b(?:last (?:session|workout|time)|yesterday|in your last)\b/;

// The recorded set lists for one lift, most recent first — one list per
// session carrying it (a single-element array when mostRecentOnly). Empty
// array = no recorded session carries the lift. Exact-name match first, then
// a canonical match only when it resolves uniquely, the same rule as the
// tally/plan lookups above.
function historySetsForLift(context, name, mostRecentOnly) {
  const c = context && typeof context === 'object' ? context : {};
  const sessions = Array.isArray(c.recent_sessions) ? c.recent_sessions : [];
  const exact = nameKey(name);
  const key = canonicalKey(name);
  const lists = [];
  for (const s of sessions) {
    const liftSets = s && s.lift_sets && typeof s.lift_sets === 'object' ? s.lift_sets : null;
    if (!liftSets) continue;
    let found = null;
    for (const rawName of Object.keys(liftSets)) {
      if (nameKey(rawName) === exact) { found = liftSets[rawName]; break; }
    }
    if (isNil(found)) {
      const canonHits = Object.keys(liftSets).filter((n) => canonicalKey(n) === key);
      if (canonHits.length === 1) found = liftSets[canonHits[0]];
    }
    if (Array.isArray(found) && found.length) lists.push(found);
  }
  return mostRecentOnly ? lists.slice(0, 1) : lists;
}

// Does one candidate reading match one recorded history set list? Same field
// rules as readingMatchesTally, over a raw per_set list: every known
// weight/reps/rir must equal the asserted value, and the set count must
// equal the recorded count. A field the history carries no data for cannot
// be verified, so a reading asserting it does not match — fail closed.
function readingMatchesHistorySets(reading, sets) {
  if (!sets || reading.__conflict) return false;
  const list = Array.isArray(sets) ? sets : [];
  if (hasValue(reading.weight)) {
    const known = list.map((s) => s && s.weight).filter((w) => hasValue(w));
    if (!known.length || !known.every((w) => Number(w) === reading.weight)) return false;
  }
  if (hasValue(reading.reps)) {
    const known = list.map((s) => s && s.reps).filter((r) => hasValue(r));
    if (!known.length || !known.every((r) => Number(r) === reading.reps)) return false;
  }
  if (hasValue(reading.sets)) {
    if (!Number.isFinite(list.length) || list.length !== reading.sets) return false;
  }
  if (hasValue(reading.rir)) {
    const known = list.map((s) => s && s.rir).filter((r) => hasValue(r));
    if (!known.length || !known.every((r) => Number(r) === reading.rir)) return false;
  }
  return true;
}

// The lifts a history clause may be about: plan + preview + tally + the
// recent sessions' own exercises — a lift done last session need not be in
// today's plan or tally, and a history claim about it still needs judging.
// (namedRecapLifts covers plan/preview/tally only, so it would miss it.)
function namedHistoryLifts(seg, context) {
  const c = context && typeof context === 'object' ? context : {};
  const names = [...knownLiftNames(c)];
  const tally = c.session_tally && typeof c.session_tally === 'object' ? c.session_tally : null;
  if (tally && Array.isArray(tally.exercises)) {
    for (const e of tally.exercises) if (e && e.exercise) names.push(String(e.exercise));
  }
  const found = namedLiftsInMessage(seg, { current_plan: dedupeByKey(names).map((n) => ({ name: n })) });
  // Single-token scan, as in namedRecapLifts: an alias token ("RDLs") resolves
  // a lift the loose word match missed.
  for (const tok of normalize(seg).split(/[^a-z0-9]+/).filter(Boolean)) {
    const tk = canonicalKey(tok);
    for (const n of dedupeByKey(names)) {
      if (canonicalKey(n) === tk && !found.includes(n)) found.push(n);
    }
  }
  return found;
}

// True when a history-framed clause asserts numbers no recorded session
// supports for the lift(s) it names. A clause asserting no numbers passes
// (there is nothing to judge); a clause naming no lift passes (nothing
// attributable — the recap/completion detectors own unattributable claims).
function judgeHistoryClause(seg, context) {
  const c = context && typeof context === 'object' ? context : {};
  const mostRecentOnly = LAST_SESSION_RE.test(seg);
  const hasNumbers = (readings) => readings.some((r) => hasValue(r.weight) || hasValue(r.reps) || hasValue(r.sets) || hasValue(r.rir) || r.__conflict);
  const grounded = (name, readings) => {
    const lists = historySetsForLift(c, name, mostRecentOnly);
    if (!lists.length) return false;
    return lists.some((list) => readings.some((r) => readingMatchesHistorySets(r, list)));
  };
  let lifts = namedHistoryLifts(seg, c);
  if (!lifts.length) return false;
  if (lifts.length > 1) {
    const occurring = liftsOccurringInClause(lifts, seg);
    if (occurring.length) lifts = occurring;
  }
  if (lifts.length === 1) {
    const readings = extractAssertedReadings(seg);
    if (!hasNumbers(readings)) return false;
    return !grounded(lifts[0], readings);
  }
  // Multi-lift clause: split and judge per piece, the same attribution rule
  // as the recap path. A piece that cannot be attributed is not judged here.
  const pieces = seg.split(MULTI_LIFT_JOIN).map((p) => p.trim()).filter(Boolean);
  const pieceLifts = pieces.map((p) => namedHistoryLifts(p, c));
  if (pieces.length < 2 || !pieceLifts.every((ls) => ls.length === 1)) {
    const readings = extractAssertedReadings(seg);
    return hasNumbers(readings);
  }
  for (let i = 0; i < pieces.length; i++) {
    const readings = extractAssertedReadings(pieces[i]);
    if (!hasNumbers(readings)) continue;
    if (!grounded(pieceLifts[i][0], readings)) return true;
  }
  return false;
}

/**
 * detectUngroundedRecapNumbers(text, context) → [{ segment, kind }]
 *
 * Flags recap/confirmation prose that asserts specific weights/reps/sets the
 * retained rows do not carry, or an "as planned" equivalence the tally does
 * not support against the plan. Empty array = grounded.
 *
 * Pure. Judges against `session_tally` and `current_plan`, and
 * history-framed claims against `recent_sessions`.
 */
function detectUngroundedRecapNumbers(text, context) {
  const c = context && typeof context === 'object' ? context : {};
  const out = [];
  const seen = new Set();
  const flag = (segment, kind) => {
    const key = `${kind}::${segment}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ segment, kind });
  };

  for (const whole of segments(text)) {
    for (const seg of assertedClauses(whole)) {
      // History-framed claims are judged against recent_sessions, not
      // skipped (#1709): "last session you logged Bench at 315 for 12"
      // passed every backstop because no detector read history numbers.
      if (RECAP_HISTORY_RE.test(seg)) {
        if (judgeHistoryClause(seg, c)) flag(seg, 'recap_history_numbers');
        continue;
      }
      const isRecap = COMPLETED_WORK_VERB.test(seg) || AS_PLANNED_RE.test(seg) || RECAP_IN_THE_BOOKS_RE.test(seg);
      if (!isRecap) continue;
      let lifts = namedRecapLifts(seg, c);
      if (!lifts.length) continue;
      // When several lifts match loosely, keep only the ones the clause
      // actually distinguishes (see liftsOccurringInClause): shared words
      // alone ("bench press") must not turn a single-lift recap into a
      // multi-lift one. An emptied filter means wholly ambiguous — keep the
      // unfiltered list so the clause still fails closed below.
      if (lifts.length > 1) {
        const occurring = liftsOccurringInClause(lifts, seg);
        if (occurring.length) lifts = occurring;
      }
      if (lifts.length === 1) {
        const name = lifts[0];
        const tally = tallyEntryForLift(c, name);
        const plan = planEntryForLift(c, name);
        if (AS_PLANNED_RE.test(seg) && !tallyMatchesPlan(tally, plan)) {
          flag(seg, 'recap_as_planned');
          continue;
        }
        const readings = extractAssertedReadings(seg);
        const hasNumbers = readings.some((r) => hasValue(r.weight) || hasValue(r.reps) || hasValue(r.sets) || hasValue(r.rir) || r.__conflict);
        if (!hasNumbers) continue;
        if (!tally || !readings.some((r) => readingMatchesTally(r, tally))) flag(seg, 'recap_numbers');
        continue;
      }
      // Multi-lift clause (re-audit #1662): the numbers must be attributed per
      // lift, not skipped — a false RDL number beside a true bench number
      // passed every guard. "As planned" is judged per lift across the whole
      // clause, because the equivalence claim spans the conjunction ("The RDLs
      // and bench are also logged as planned").
      if (AS_PLANNED_RE.test(seg)) {
        let plannedOk = true;
        for (const n of lifts) {
          if (!tallyMatchesPlan(tallyEntryForLift(c, n), planEntryForLift(c, n))) { plannedOk = false; break; }
        }
        if (!plannedOk) { flag(seg, 'recap_as_planned'); continue; }
      }
      // Split on the conjunctions joining the per-lift assertions. The split
      // is accepted only when EVERY piece names exactly one lift, so a number
      // fragment can never be judged against the wrong lift. Anything
      // unattributable fails closed: a clause asserting numbers no piece can
      // own is flagged. Known residual: a comma-fragmented assertion ("…at
      // 285, 6 reps, and bench…") does not split cleanly and fails closed.
      const pieces = seg.split(MULTI_LIFT_JOIN).map((p) => p.trim()).filter(Boolean);
      const pieceLifts = pieces.map((p) => namedRecapLifts(p, c));
      if (pieces.length < 2 || !pieceLifts.every((ls) => ls.length === 1)) {
        const readings = extractAssertedReadings(seg);
        if (readings.some((r) => hasValue(r.weight) || hasValue(r.reps) || hasValue(r.sets) || hasValue(r.rir) || r.__conflict)) flag(seg, 'recap_numbers');
        continue;
      }
      for (let i = 0; i < pieces.length; i++) {
        const name = pieceLifts[i][0];
        const tally = tallyEntryForLift(c, name);
        const readings = extractAssertedReadings(pieces[i]);
        const hasNumbers = readings.some((r) => hasValue(r.weight) || hasValue(r.reps) || hasValue(r.sets) || hasValue(r.rir) || r.__conflict);
        if (!hasNumbers) continue;
        if (!tally || !readings.some((r) => readingMatchesTally(r, tally))) { flag(seg, 'recap_numbers'); break; }
      }
    }
  }
  return out;
}

// ── prescription-number grounding (#1709) ───────────────────────────────────
//
// A forward-looking numeric prescription ("Next up is Deadlift at 315 for 5
// sets of 12") was none of the three backstops above — not a mutation, not a
// this-session recap, not a completion claim — so invented next loads reached
// the athlete. REMAINING_FRAMING correctly exempts prescription framings from
// *completion* judging (they are not completed work), but nothing validated
// the prescription numbers against the plan.
//
// A prescription claim is grounded only by the current plan, then the
// current preview (the engine's next-target statement, which carries
// weight/reps/rir but no sets). RIR is compared only when the binding entry
// carries it — an RIR target with no plan RIR is legitimate coaching, not a
// lie (the engine's own rule prescribes sets x reps @ RIR when there is no
// snapshot load). A named lift with no plan or preview entry has no binding
// and fails closed. Bare-number prescriptions with no lift named are not
// judged here (nothing attributable — disclosed residual).

// Future markers beyond REMAINING_FRAMING: a bare "next", tomorrow, up next.
const FUTURE_PRESCRIPTION_RE = /\b(?:next|tomorrow|up next|for tomorrow|next (?:session|workout|week))\b/;
// Explicit proposal verbs — an offered suggestion, not an asserted prescription.
const PRESCRIPTION_PROPOSAL_RE = /\b(?:suggest(?:ed|ing)?|propos(?:e|ed|ing)|offer(?:ed|ing)?|want me to|would you like|if you (?:want|'?d like))\b/;

// A clause that asserts a prescription: future/remaining/planned framing, and
// not a question, an athlete quotation, a negation, or an explicit proposal.
// Modal futures ("you'll do…", "you should do…") ARE prescription claims —
// the modal is the prescription itself, not an excuse for it.
function isPrescriptionSegment(seg) {
  const s = String(seg || '').trim();
  if (!s) return false;
  if (s.includes('?')) return false;
  if (ATTRIBUTION_MARKER.test(s)) return false;
  if (NEGATION_MARKER.test(s)) return false;
  if (PRESCRIPTION_PROPOSAL_RE.test(s)) return false;
  if (!REMAINING_FRAMING.test(s) && !FUTURE_PRESCRIPTION_RE.test(s)) return false;
  return true;
}

function prescriptionClauses(seg) {
  const whole = String(seg || '').trim();
  if (!whole) return [];
  const out = [];
  if (isPrescriptionSegment(whole)) out.push(whole);
  const parts = whole.split(CLAUSE_BOUNDARY).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    for (const p of parts) if (isPrescriptionSegment(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

// The plan entry for a lift, else the preview entry (same exact-then-unique-
// canonical rule as planEntryForLift; the preview carries no sets).
function previewEntryForLift(context, name) {
  const preview = context && Array.isArray(context.current_preview) ? context.current_preview : [];
  const exact = nameKey(name);
  const exactHit = preview.find((e) => e && nameKey(e.exercise || e.name) === exact);
  if (exactHit) return exactHit;
  const key = canonicalKey(name);
  const canonHits = preview.filter((e) => e && canonicalKey(e.exercise || e.name) === key);
  return canonHits.length === 1 ? canonHits[0] : null;
}

function prescriptionEntryForLift(context, name) {
  return planEntryForLift(context, name) || previewEntryForLift(context, name);
}

// Does one candidate reading match the prescription entry? Every asserted
// weight/reps/sets must equal the entry's value, and a field the entry
// carries no data for cannot verify the claim — fail closed. RIR is
// compared only when the entry carries it.
function readingMatchesPrescription(reading, entry) {
  if (!entry || reading.__conflict) return false;
  if (hasValue(reading.weight)) {
    if (isNil(entry.weight) || Number(entry.weight) !== reading.weight) return false;
  }
  if (hasValue(reading.reps)) {
    if (isNil(entry.reps) || Number(entry.reps) !== reading.reps) return false;
  }
  if (hasValue(reading.sets)) {
    if (isNil(entry.sets) || Number(entry.sets) !== reading.sets) return false;
  }
  if (hasValue(reading.rir) && hasValue(entry.rir)) {
    if (Number(entry.rir) !== reading.rir) return false;
  }
  return true;
}

/**
 * detectUngroundedPrescriptionNumbers(text, context) → [{ segment, kind }]
 *
 * Flags forward-looking numeric prescriptions no deterministic source binds:
 * a next/remaining/planned claim whose numbers differ from the current plan
 * (or preview) entry for the named lift, or that names a lift with no plan
 * or preview entry at all. Empty array = grounded.
 *
 * Pure. Judges ONLY against `current_plan` and `current_preview`. Only
 * cleanly attributable single-lift claims are judged — a clause asserting
 * numbers without a lift, or a multi-lift clause whose pieces cannot each
 * be attributed to one lift, is left to the recap/completion detectors, so
 * an honest recap riding the same sentence is never misjudged as a
 * prescription.
 */
function detectUngroundedPrescriptionNumbers(text, context) {
  const c = context && typeof context === 'object' ? context : {};
  const out = [];
  const seen = new Set();
  const flag = (segment, kind) => {
    const key = `${kind}::${segment}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ segment, kind });
  };
  const hasNumbers = (readings) => readings.some((r) => hasValue(r.weight) || hasValue(r.reps) || hasValue(r.sets) || r.__conflict);

  for (const whole of segments(text)) {
    for (const seg of prescriptionClauses(whole)) {
      let lifts = namedRecapLifts(seg, c);
      if (!lifts.length) {
        // No in-snapshot lift named. If the clause still names a lift (the
        // Exercise KB resolves one) and asserts numbers, the prescription
        // names an exercise with no plan/preview binding — ungrounded.
        const readings = extractAssertedReadings(seg);
        if (hasNumbers(readings) && messageNamesALift(seg)) flag(seg, 'prescription_numbers');
        continue;
      }
      if (lifts.length > 1) {
        const occurring = liftsOccurringInClause(lifts, seg);
        if (occurring.length) lifts = occurring;
      }
      if (lifts.length === 1) {
        const readings = extractAssertedReadings(seg);
        if (!hasNumbers(readings)) continue;
        const entry = prescriptionEntryForLift(c, lifts[0]);
        if (!entry || !readings.some((r) => readingMatchesPrescription(r, entry))) flag(seg, 'prescription_numbers');
        continue;
      }
      // Multi-lift clause: judge only pieces that are themselves prescription
      // claims naming exactly one lift — a recap piece riding the same
      // sentence is judged by the recap detector, not here.
      const pieces = seg.split(MULTI_LIFT_JOIN).map((p) => p.trim()).filter(Boolean);
      const pieceLifts = pieces.map((p) => namedRecapLifts(p, c));
      if (pieces.length < 2 || !pieceLifts.every((ls) => ls.length === 1)) continue;
      for (let i = 0; i < pieces.length; i++) {
        if (!isPrescriptionSegment(pieces[i])) continue;
        const readings = extractAssertedReadings(pieces[i]);
        if (!hasNumbers(readings)) continue;
        const entry = prescriptionEntryForLift(c, pieceLifts[i][0]);
        if (!entry || !readings.some((r) => readingMatchesPrescription(r, entry))) { flag(seg, 'prescription_numbers'); break; }
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

// ── fail-closed remaining-work question ─────────────────────────────────────
//
// "What do I have left?" is a STATE question whose deterministic answer already
// exists — buildGroundedSessionStateStatement above renders it from plan_state +
// session_tally. But no lane claimed the phrasing: the client classifier does not
// match it and neither did any route lane, so the turn reached the model, which
// answered from the tally alone with a bare set-fact recap naming NONE of the
// remaining lifts while the correct plan_state.remaining sat unused in its own
// snapshot (F-SB4 Session 3, run fsb4b-s3-20261029T055908-69D1E9). The completion
// backstop cannot catch that prose — an enumeration with no completion verb is
// not a completion claim — so the fix is a claim, not a bigger denylist.
//
// Tight on purpose, like the session-close family: whole-message, anchored, and
// fail-closed — an ambiguous shape declines and keeps today's handling. No lift
// name is required (the answer is the whole remaining list, not one lift's
// target). Shapes other lanes own are excluded: next-up questions (guarded by
// isNextUpQuestion itself), session-close questions (their cores share no token
// with these), and attribute asks — "how much …" is guarded explicitly, and a
// "how many" ask is claimed ONLY when it counts remaining exercises/lifts, never
// weight/reps/sets/RIR (services/sessionQuestionAnswer.js owns those).
const REMAINING_WORK_LEADIN_RE = /^(?:ok(?:ay)?|so|and|well|hey|right)\s*[, ]\s*/;
// What may follow the core: a to-do/to-go infinitive and ONE session-scope phrase.
// The whitelist is what declines "is there anything left in the tank …" (an
// energy idiom, not plan state) and "what's left of my protein shake?" — neither
// tail is the session, so neither is this lane's question.
const REMAINING_WORK_TAIL = String.raw`(?:\s+to (?:do|go))?(?:\s+(?:for me|for today|today|in (?:today'?s|the|this|my) (?:session|workout|training|plan)|on (?:today'?s|the|this|my) plan|of (?:today'?s|the|this) (?:session|workout|plan)))?`;
const REMAINING_WORK_CORES = [
  String.raw`what do (?:i|we) (?:still )?have (?:still )?(?:left|remaining)`,
  String.raw`what have (?:i|we) (?:got )?(?:still )?(?:left|remaining)`,
  String.raw`what(?:'s| is) (?:else )?(?:still )?(?:left|remaining)`,
  String.raw`what else (?:is )?(?:still )?(?:left|remaining)`,
  String.raw`what (?:still )?remains\b`,
  String.raw`which (?:exercises?|lifts?|movements?) (?:are )?(?:still )?(?:left|remaining)`,
  String.raw`which (?:exercises?|lifts?|movements?) do (?:i|we) have (?:still )?(?:left|remaining)`,
  String.raw`(?:is there )?anything (?:else )?(?:still )?(?:left|remaining)`,
  String.raw`how many (?:exercises?|lifts?|movements?) do (?:i|we) have (?:still )?(?:left|remaining)`,
  String.raw`how many (?:exercises?|lifts?|movements?) (?:are )?(?:still )?(?:left|remaining)`,
];
const REMAINING_WORK_RES = REMAINING_WORK_CORES.map(
  (core) => new RegExp(`^${core}${REMAINING_WORK_TAIL}[\\s?.!]*$`)
);

function isRemainingWorkQuestion(message) {
  const m = normalize(message);
  if (!m) return false;
  if (isNextUpQuestion(m)) return false;
  if (/\bhow much\b/.test(m)) return false;
  const body = m.replace(REMAINING_WORK_LEADIN_RE, '');
  return REMAINING_WORK_RES.some((re) => re.test(body));
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

// ── fail-closed substitution answer (F-SB3, owner ruling 2026-08-02) ─────────
//
// /api/coach/chat is READ-ONLY. It cannot swap a plan slot, cannot retain the original
// `plan_item_id`, and cannot emit the canonical `substituted` item_outcome — so ANY
// substitution wording it produces describes a mutation the durable ledger never saw.
//
// In the 2026-08-02 live session the model answered a substitution request with
// "Understood. You're substituting Bench Press with Incline Dumbbell Press." and
// "Okay, I've noted the substitution." The ledger recorded ZERO item_outcome events,
// Bench Press stayed pending, and the closeout sealed over the contradiction. Atlas
// visibly claimed a substitution it never performed.
//
// The mutation-claim denylist missed BOTH phrasings — `noted` is not one of its verbs
// and it has no second-person completed frame — and extending it is the losing strategy
// this module already documents: the model can always word it a new way. The winning
// pattern is the one `buildDisputeAnswer` established. Answer the turn deterministically
// and never call the model at all, so there is no wording to outrun.
//
// The mutation itself belongs to the client's ONE substitution proposal lane (propose →
// accept → applySessionSubstitution), which this answer points the athlete back at. It
// never claims, promises, or performs a plan change.

// A lift-level substitution request or discussion. Broad on purpose: an UNDER-match here
// hands the turn back to the model on a route that cannot honestly answer it, which is the
// exact trust failure. An OVER-match degrades safely to a grounded, claim-free statement of
// what the plan actually shows.
const SUBSTITUTION_CUE = new RegExp([
  '\\bsubstitut(?:e|es|ed|ing|ion|ions)\\b',
  '\\bsubbing\\b',
  '\\ba sub\\b',
  '\\bswap(?:s|ped|ping)?\\b',
  '\\binstead of\\b',
  '\\balternatives?\\b',
  '\\breplacements?\\b',
  '\\breplace(?:s|d)?\\b',
  '\\bsomething else\\b',
  '\\bdifferent (?:lift|exercise|movement)\\b',
].join('|'));

// A "why DID/DO/HAVE you …" question is an explanation of a past choice, not a request to
// change anything — so it keeps its (narrowed) model narration. PLAN_EXPLAIN_RE does not
// cover it here because its verb list has no substitution verb. The auxiliary is required,
// so a request phrased as a question ("why don't you swap it for me") is NOT excluded.
const SUBSTITUTION_EXPLAIN_RE = /\bwhy\b[^?]*\b(?:did|do|have)\s+you\b/;

// True for an active-session substitution turn whose answer must be built deterministically.
// An explanation and a broad-session review are excluded — neither is a mutation request.
function isSubstitutionTurn(message, context) {
  if (!hasActiveSession(context)) return false;
  const m = normalize(message);
  if (!m || BROAD_REVIEW_RE.test(m)) return false;
  if (PLAN_EXPLAIN_RE.test(m) || SUBSTITUTION_EXPLAIN_RE.test(m)) return false;
  return SUBSTITUTION_CUE.test(m);
}

// The deterministic answer to a substitution turn: state what the plan STILL shows for the
// lift in question, state plainly that nothing has been changed, and name the one thing that
// actually produces a substitute the athlete can approve. Never claims a completed mutation,
// never invents a substitute, never invents a load.
function buildSubstitutionAnswer(message, context) {
  const c = context && typeof context === 'object' ? context : {};
  const plan = Array.isArray(c.current_plan) ? c.current_plan.filter((e) => e && (e.name || e.exercise)) : [];
  const ASK = 'Tell me the lift is unavailable — for example "bench is taken" — and I\'ll pull up a substitute with its target for you to approve.';
  if (!plan.length) {
    return `I don't have your current plan in view here, so I can't set up a swap — and I haven't changed anything. ${ASK}`;
  }
  // Resolve the lift ONLY when the message names exactly one plan lift; otherwise say so
  // rather than answering about a lift the athlete did not mean (the same fail-closed rule
  // the dispute resolver uses).
  const named = namedLiftsInMessage(message, c);
  const entry = named.length === 1 && !mentionsAnotherLift(message, named[0])
    ? plan.find((e) => canonicalKey(e.name || e.exercise) === canonicalKey(named[0])) || null
    : null;
  if (entry) {
    return `Your plan still shows ${formatPlanLine(entry)} — I haven't changed it. ${ASK}`;
  }
  return `I haven't changed your plan. ${ASK}`;
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

// ── logged set-count (issue #1525) ──────────────────────────────────────────
//
// "How many sets have I done?" is a count of sets logged THIS session. It is not
// the prescribed set count, and it is not the number of exercise names in
// plan_completed. Neither the bare-shorthand lane nor the named-lift lane claims
// the past-tense phrasing, so the turn reached the model — which answered "2 sets"
// for 2 squat sets + 1 bench set — and the model-down path answered the current
// lift's prescription ("Back Squat: 4 sets."). The completion and recap backstops
// do not judge a bare set total, so a wrong count was not replaced.
//
// This lane claims only the done/logged set-count question and reads session_tally.
// Prescription ("how many sets?"), remaining ("how many sets left?"), history,
// warm-up, and advice stay with the lanes that already own them.

function isLoggedSetCountQuestion(message) {
  const m = normalize(message);
  if (!m) return false;
  if (/\bwarm[\s-]?ups?\b/.test(m)) return false;
  if (/\b(?:left|remaining|to go|to do)\b/.test(m)) return false;
  if (/\b(?:should|planned|prescribed|prescription|target)\b/.test(m)) return false;
  if (/\b(?:last time|last (?:week|session|month|workout|time)|previous(?:ly)?|history|used to)\b/.test(m)) return false;
  if (/\b(?:why|explain|recommend)\b/.test(m)) return false;
  if (/\b(?:reps?|weight|rir|rpe|load)\b/.test(m)) return false;
  if (!/\bhow many(?:\s+\w+){0,4}\s+sets?\b/.test(m)) return false;
  if (!/\b(?:have|did)\s+(?:i|we)\b|\b(?:i|we)(?:'ve| have| did)\b/.test(m)) return false;
  if (!/\b(?:done|do|logged|log|completed|complete|finished|finish|got|gotten|put in)\b/.test(m)) return false;
  return true;
}

function tallyExerciseRows(context) {
  const tally = context && context.session_tally;
  if (!tally || typeof tally !== 'object' || Array.isArray(tally)) return null;
  if (!Array.isArray(tally.exercises)) return [];
  return tally.exercises.filter((e) => e && e.exercise);
}

function contextWithTallyNames(context) {
  const c = context && typeof context === 'object' ? context : {};
  const rows = tallyExerciseRows(c);
  if (!rows || !rows.length) return c;
  const extra = rows.map((e) => ({ name: String(e.exercise) }));
  return { ...c, current_plan: [...(Array.isArray(c.current_plan) ? c.current_plan : []), ...extra] };
}

function liftsAskedInLoggedCount(message, context) {
  const named = namedLiftsInMessage(message, contextWithTallyNames(context));
  if (named.length) return named;
  let canon = null;
  try { canon = canonicalizeExerciseName(message); } catch { canon = null; }
  if (canon && canon.canonicalName && !namesDifferentExercise(message, canon.canonicalName)) {
    return [canon.canonicalName];
  }
  return [];
}

function loggedSetsForName(rows, name) {
  const key = nameKey(name);
  const canon = canonicalKey(name);
  const row = rows.find((e) => nameKey(e.exercise) === key || canonicalKey(e.exercise) === canon);
  if (!row) return 0;
  const n = Number(row.sets);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function setsPhrase(n) {
  return n === 1 ? '1 set' : `${n} sets`;
}

function buildLoggedSetCountAnswer(message, context) {
  const c = context && typeof context === 'object' ? context : {};
  const rows = tallyExerciseRows(c);
  const lifts = liftsAskedInLoggedCount(message, c);
  let unresolved = null;
  if (!lifts.length) {
    try {
      unresolved = unresolvableExerciseReference(message, (text) => {
        try { return canonicalizeExerciseName(text); } catch { return null; }
      });
    } catch { unresolved = null; }
  }
  if (unresolved) return "I can't tell which lift that is, so I won't guess a set count.";
  if (rows === null) {
    if (lifts.length === 1) {
      return `I don't have this session's set tally, so I can't say how many ${lifts[0]} sets are logged.`;
    }
    return "I don't have this session's set tally, so I can't say how many sets are logged.";
  }
  if (lifts.length === 1) {
    return `${lifts[0]}: ${setsPhrase(loggedSetsForName(rows, lifts[0]))} logged this session.`;
  }
  if (lifts.length > 1) {
    const total = lifts.reduce((n, name) => n + loggedSetsForName(rows, name), 0);
    const parts = lifts.map((name) => `${name} ${loggedSetsForName(rows, name)}`);
    return `${setsPhrase(total)} logged this session: ${parts.join(', ')}.`;
  }
  if (!rows.length) return 'No working sets logged this session yet.';
  const total = rows.reduce((n, e) => n + loggedSetsForName(rows, e.exercise), 0);
  const parts = rows.map((e) => `${e.exercise} ${loggedSetsForName(rows, e.exercise)}`);
  return `${setsPhrase(total)} logged this session: ${parts.join(', ')}.`;
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

// ── message-narration numeric grounding (#1710) ─────────────────────────────
//
// /api/coach/message narrates deterministic facts (a just-logged set, or why
// today's session fits) through the model, and — unlike /api/coach/chat — had
// no numeric validator on the model prose: finalizeCoachVoice checked effort
// contradictions and register only. The Astra audit's B1 probes reached the
// athlete verbatim (plan: an invented Deadlift 315 5x12 + "add 20 next
// session"; set: "You lifted 315 for 12" + "Next do Deadlift at 225" over a
// logged 135x8).
//
// This enforces the B-02 binding mechanism on the message paths: the route's
// deterministic facts are adapted into the grounding-context shape the B-02
// detectors already judge, and the prose is validated with the recap,
// prescription, and mutation detectors. Ungrounded prose suppresses (the
// route's existing fail-closed shape — message null, client falls back to
// templated copy), exactly like the other finalizeCoachVoice suppressors.
//
// What grounds what, on this route:
//   - session_tally ← todaySets for the just-logged lift (the recap ground).
//     A "You lifted N" claim must match the logged sets.
//   - current_plan ← rec.next_target for the just-logged lift (the engine's
//     next-target statement — the ONLY prescription numbers the model was
//     shown) plus the planned_queue names (name only: the engine authorized
//     no numbers for a queued lift, so a numeric prescription for one fails
//     closed).
//   - recent_sessions ← rec.last_working_sets (the most recent working sets
//     the model was shown), so a "last time you did…" citation of them is
//     judged against the real sets instead of failing closed.
//   - The completion detector is NOT run here: this route has no plan_state /
//     session_count to judge completion against, and the set voice's own
//     prompt authorizes citing trend.sessions_analyzed as a session count —
//     a claim that detector cannot verify. Completion-claim grounding on the
//     message route needs plan_state plumbed into the route (follow-up).
//   - A bare load-delta decision ("add 20 next session" with no other
//     numbers) asserts no weight/reps/sets reading, so the prescription
//     detector does not catch it on its own. Disclosed residual; the audit's
//     plan probe is still caught whole via its prescription half.

function numOrNullValue(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeMessageSet(s) {
  if (Array.isArray(s)) {
    return { weight: numOrNullValue(s[0]), reps: numOrNullValue(s[1]), rir: numOrNullValue(s[2]) };
  }
  if (s && typeof s === 'object') {
    return { weight: numOrNullValue(s.weight), reps: numOrNullValue(s.reps), rir: numOrNullValue(s.rir) };
  }
  return null;
}

function normalizeMessageSets(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    const n = normalizeMessageSet(s);
    if (n) out.push(n);
  }
  return out;
}

function queueEntryName(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') {
    return String(item.name || item.canonicalName || item.exercise || item.canonical_exercise || '').trim();
  }
  return '';
}

/**
 * buildCoachMessageGroundingContext(facts, kind) → grounding context
 *
 * Adapts the /api/coach/message route's deterministic facts into the shape
 * the B-02 detectors judge (session_tally / current_plan / recent_sessions).
 * Pure. Only numbers the model was actually shown can ground a claim:
 * todaySets, rec.next_target (+ target_rir), and rec.last_working_sets.
 * Planned-queue entries carry a name and no numbers.
 */
function buildCoachMessageGroundingContext(facts, kind) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const exerciseName = typeof f.exerciseName === 'string' ? f.exerciseName.trim() : '';
  const rec = f.rec && typeof f.rec === 'object' ? f.rec : {};
  const ctx = { session_tally: null, current_plan: [], current_preview: [], recent_sessions: [], plan_state: null, session_count: null };
  // Recap ground: the just-logged sets for the just-logged lift.
  const todaySets = normalizeMessageSets(f.todaySets);
  if (exerciseName && todaySets.length) {
    ctx.session_tally = { exercises: [{ exercise: exerciseName, sets: todaySets.length, per_set: todaySets }] };
  }
  // Prescription ground: the engine's next-target statement for the
  // just-logged lift, plus the planned-queue names (name only).
  const plan = [];
  const target = rec.next_target && typeof rec.next_target === 'object' ? rec.next_target : null;
  if (exerciseName && target) {
    plan.push({
      name: exerciseName,
      weight: numOrNullValue(target.weight),
      reps: numOrNullValue(target.reps),
      sets: numOrNullValue(target.sets),
      rir: numOrNullValue(rec.target_rir),
    });
  }
  const queue = Array.isArray(f.planned_queue) ? f.planned_queue : [];
  for (const item of queue) {
    const name = queueEntryName(item);
    if (name) plan.push({ name });
  }
  // Dedupe by name key, keeping the first (numbered) entry for a name.
  const seenPlan = new Set();
  ctx.current_plan = plan.filter((e) => {
    const k = nameKey(e.name);
    if (!k || seenPlan.has(k)) return false;
    seenPlan.add(k);
    return true;
  });
  // History ground: the most recent working sets the model was shown.
  const lastWorking = normalizeMessageSets(rec.last_working_sets);
  if (exerciseName && lastWorking.length) {
    ctx.recent_sessions = [{ date: null, exercises: [exerciseName], lift_sets: { [exerciseName]: lastWorking } }];
  }
  return ctx;
}

/**
 * detectUngroundedMessageNumbers(message, facts, kind) → [{ segment, kind }]
 *
 * Flags /api/coach/message narration prose whose numbers no deterministic
 * fact on that route binds: ungrounded recap numbers, ungrounded
 * prescription numbers, and unsupported plan-change claims (the B-02
 * detectors, run over the adapted context). On kind 'plan' — where the model
 * is given no per-lift numbers at all — a completed-work numeric claim
 * naming a lift is ungrounded by construction and is flagged directly.
 * Empty array = grounded. Pure.
 */
function detectUngroundedMessageNumbers(message, facts, kind) {
  const ctx = buildCoachMessageGroundingContext(facts, kind);
  const out = [];
  const seen = new Set();
  const flaggedSegments = new Set();
  const flag = (segment, kind) => {
    const key = `${kind}::${segment}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ segment, kind });
    flaggedSegments.add(segment);
  };
  const pushAll = (findings) => {
    for (const f of findings) flag(f.segment, f.kind);
  };
  pushAll(detectUngroundedRecapNumbers(message, ctx));
  pushAll(detectUngroundedPrescriptionNumbers(message, ctx));
  pushAll(detectUnsupportedMutationClaim(message).map((segment) => ({ segment, kind: 'unsupported_mutation' })));
  // Plan voice: no per-lift numbers exist in the facts, so a completed-work
  // numeric claim is ungrounded by construction — the recap detector skips it
  // only because the lift is absent from the (empty) context names. The gate
  // is a named lift OR a history framing: a bare weekly count ("did 12 sets
  // this week") may cite a data_point and is left alone.
  if (kind === 'plan' && typeof message === 'string' && message) {
    for (const whole of segments(message)) {
      for (const seg of assertedClauses(whole)) {
        if (flaggedSegments.has(seg) || flaggedSegments.has(whole)) continue;
        if (!COMPLETED_WORK_VERB.test(seg)) continue;
        const readings = extractAssertedReadings(seg);
        if (!readings.some((r) => hasValue(r.weight) || hasValue(r.reps) || hasValue(r.sets) || hasValue(r.rir) || r.__conflict)) continue;
        if (!messageNamesALift(seg) && !RECAP_HISTORY_RE.test(seg)) continue;
        flag(seg, 'message_plan_recap');
      }
    }
  }
  // Single-lift attribution (set/block): the message route narrates exactly
  // ONE just-logged lift, so a numeric claim that names no lift is still
  // attributable — it is about the just-logged lift. The B-02 detectors skip
  // unattributed claims (right for chat, where a turn may span lifts); here
  // skipping them would let the audit's bare recap ("You lifted 315 for 12
  // reps") through. Clauses naming a lift outside the context are flagged
  // outright (no binding exists for that lift); the rest are judged against
  // the single lift's tally / next-target / history ground.
  if ((kind === 'set' || kind === 'block') && ctx.session_tally
    && Array.isArray(ctx.session_tally.exercises) && ctx.session_tally.exercises.length === 1) {
    const single = ctx.session_tally.exercises[0];
    const singleName = single && single.exercise;
    const planEntry = singleName ? planEntryForLift(ctx, singleName) : null;
    for (const whole of segments(message)) {
      for (const seg of assertedClauses(whole)) {
        if (flaggedSegments.has(seg) || flaggedSegments.has(whole)) continue;
        if (namedRecapLifts(seg, ctx).length) continue; // named in-context → B-02 owned it
        const readings = extractAssertedReadings(seg);
        const hasNumbers = readings.some((r) => hasValue(r.weight) || hasValue(r.reps) || hasValue(r.sets) || hasValue(r.rir) || r.__conflict);
        if (!hasNumbers) continue;
        const namesOutsideLift = messageNamesALift(seg);
        if (RECAP_HISTORY_RE.test(seg)) {
          if (namesOutsideLift) { flag(seg, 'recap_history_numbers'); continue; }
          const mostRecentOnly = LAST_SESSION_RE.test(seg);
          const lists = historySetsForLift(ctx, singleName, mostRecentOnly);
          const grounded = lists.some((list) => readings.some((r) => readingMatchesHistorySets(r, list)));
          if (!grounded) flag(seg, 'recap_history_numbers');
          continue;
        }
        if (isPrescriptionSegment(seg)) {
          if (namesOutsideLift) { flag(seg, 'prescription_numbers'); continue; }
          if (!planEntry || !readings.some((r) => readingMatchesPrescription(r, planEntry))) flag(seg, 'prescription_numbers');
          continue;
        }
        if (COMPLETED_WORK_VERB.test(seg) || AS_PLANNED_RE.test(seg) || RECAP_IN_THE_BOOKS_RE.test(seg)) {
          if (namesOutsideLift) { flag(seg, 'recap_numbers'); continue; }
          if (AS_PLANNED_RE.test(seg) && !tallyMatchesPlan(single, planEntry)) { flag(seg, 'recap_as_planned'); continue; }
          if (!readings.some((r) => readingMatchesTally(r, single))) flag(seg, 'recap_numbers');
        }
      }
    }
  }
  return out;
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
  isSubstitutionTurn,
  buildSubstitutionAnswer,
  isBroadReview,
  isActivePlanGroundedTurn,
  narrowContextToPlanTurn,
  detectUnsupportedMutationClaim,
  detectUngroundedCompletionClaim,
  detectUngroundedRecapNumbers,
  detectUngroundedPrescriptionNumbers,
  buildCoachMessageGroundingContext,
  detectUngroundedMessageNumbers,
  buildGroundedSessionStateStatement,
  isRemainingWorkQuestion,
  workoutIsComplete,
  remainingExerciseNames,
  extractClaimedTargets,
  resolveDisputedLiftEntry,
  isNextUpQuestion,
  nextPlannedLiftName,
  resolveDiscussedLift,
  isLoggedSetCountQuestion,
  buildLoggedSetCountAnswer,
  buildGroundedPlanStatement,
  buildDisputeAnswer,
};
