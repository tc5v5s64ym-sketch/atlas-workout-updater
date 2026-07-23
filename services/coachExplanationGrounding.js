'use strict';

// ── Recommendation-explanation grounding for the coach chat path ─────────────
//
// Pure, deterministic helpers for POST /api/coach/chat. No I/O, no LLM, no clock.
//
// Production conversation-grounding failure (deployed 62ab44a, Flight Recorder
// FR-20260722231349-ckbvri1o):
//
//   1. Atlas displayed an authoritative Recovery/Pump recommendation
//      (Bench Press 175×9 @5 ×3, …) from /api/plan/intent-recommendation.
//   2. The athlete asked "Why only 175 for bench I haven't done bench in over a
//      week?" — an EXPLANATION of the displayed recommendation.
//   3. The reply substituted an unrelated benchmark CHALLENGE ("Bench Press has
//      come in below your recent benchmark 5 of the last 5 sessions…") instead of
//      explaining why the recommendation chose 175.
//
// Root boundary: the turn "why only 175 for bench" does NOT match the existing
// `PLAN_EXPLAIN_RE` ("why did you PROGRAM/PRESCRIBE…"), so it was never recognized
// as a grounded turn. No narrowing ran, `coach_mode` stayed "challenge" (bench had a
// consistent_underperformance pattern), and the challenge prompt drove the model to
// raise the benchmark trend instead of answering the question. Narrowing alone does
// not fix it: the challenged lift IS the lift being asked about, so filtering the
// diagnostics to the target keeps the challenge. A recommendation-EXPLANATION turn
// must therefore DEMOTE the challenge — the athlete asked why the prescription is
// what it is, and a benchmark critique of the same lift is a non-sequitur that dodges
// the question.
//
// This module (a) recognizes the recommendation-explanation turn the existing lane
// misses, (b) resolves the displayed recommendation entry it is about, (c) narrows
// the diagnostics to that lift AND drops its challenge so the recommendation facts
// outrank it, (d) builds a trusted recommendation snapshot (target exercise, the
// prescribed sets/reps/weight/RIR, the engine's readiness/label reason, and the
// relevant history) used by the deterministic fallback and recorded in Coach_Shadow,
// and (e) recognizes a bare conversational aside ("hello, are you there?", "uh oh
// you're broken again") so a standing challenge/coach_mode can never replay onto an
// unrelated turn.
//
// The engine owns numbers/decisions; these helpers only select context, build a
// grounded statement of facts already present, and classify the turn. They never
// mutate a plan, never write, and never invent a number.

const { generateLiftCode } = require('./exerciseEnrichment');
const { deriveChatCoachMode } = require('./chatCoachMode');
const coachResponseGrounding = require('./coachResponseGrounding');

const { normalize, nameKey, canonicalKey, namedLiftsInMessage, extractClaimedTargets,
  hasActiveSession, isPlanModificationRequest, isFactualPlanDispute } = coachResponseGrounding;

// ── small utilities ──────────────────────────────────────────────────────────

function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function strOrNull(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function liftCodeOf(name) {
  try { return generateLiftCode(name) || null; } catch { return null; }
}

// Every displayed-recommendation entry currently in view. `current_plan` is where the
// client forwards the displayed-but-not-yet-accepted recommendation (currentPlanForChat
// falls back to the cached recommended intent when no session is active), so the same
// selector serves both the accepted plan and the displayed recommendation.
function planEntries(context) {
  const c = context && typeof context === 'object' ? context : {};
  return (Array.isArray(c.current_plan) ? c.current_plan : []).filter((e) => e && (e.name || e.exercise));
}
function entryName(entry) {
  return (entry && (entry.name || entry.exercise)) || null;
}

// ── turn classification ───────────────────────────────────────────────────────

// A "why" question about the MAGNITUDE of a prescription — "why only 175", "why so
// light", "why just 3 sets", "why is bench only 175". The magnitude cue (a number or a
// light/heavy/only/just word) is what separates a prescription-explanation from a
// performance question ("why is bench declining"), which is a legitimate challenge.
const WHY_RE = /\bwhy\b/;
const MAGNITUDE_RE = /\b(only|just|so\s+(?:light|heavy|low|high|easy|hard|little|much|few|many)|too\s+(?:light|heavy|low|high|easy|hard|much|little)|light(?:er)?|heav(?:y|ier)|low(?:er)?|high(?:er)?|few(?:er)?)\b|\d/;

// A PAST-tense / history question ("why did I do 175 for bench last week?") is about a
// prior session, NOT the currently displayed recommendation — history owns it. Mirrors
// sessionQuestionAnswer.HISTORY_RE (kept in sync) plus the athlete-past-action forms
// ("did i do/hit/…", "yesterday", "ago"), so a number-bearing history question is never
// hijacked into the current-recommendation lane and answered from an unrelated plan. The
// "did I … <verb>" form tolerates up to three intervening adverbs ("did I only get",
// "did I just barely hit") so an adverbial history question is not misrouted (Codex #1133).
const HISTORY_PAST_RE = /\b(?:last (?:time|week|session|month|year|workout|training)|previous(?:ly)?|history|before|used to|yesterday|ago|earlier|the other (?:day|week)|when i (?:did|last)|did\s+i(?:\s+\w+){0,3}\s+(?:do|does|hit|get|got|gotten|use|used|run|ran|bench|squat|press(?:ed)?|lift(?:ed)?|pull(?:ed)?|row(?:ed)?|curl(?:ed)?|manage[d]?|perform(?:ed)?|finish(?:ed)?|complete[d]?|score[d]?))\b/;

// A broad-session review legitimately wants the full diagnostics — never narrowed to a
// single lift. Mirrors coachResponseGrounding's broad-review guard (kept minimal here
// on purpose; the WHY+MAGNITUDE+resolvable-target gate already excludes most reviews).
const BROAD_REVIEW_RE = /\b(overall|in general|everything|all my|recent training|my (?:recent )?training|the whole (?:session|workout|plan|program)|review my|how('?s| is) (?:my )?(?:training|progress|everything))\b/;

// The displayed-recommendation entry the turn is about: (1) a lift named in the message
// that maps to exactly one recommendation entry; (2) a claimed number that matches
// exactly one entry's weight; (3) the sole recommendation entry. Ambiguous (>1 match) or
// a named lift NOT in the recommendation returns null — we never guess which prescription
// the athlete means.
function resolveRecommendationTarget(message, context) {
  const c = context && typeof context === 'object' ? context : {};
  const plan = planEntries(c);
  if (!plan.length) return null;

  const named = namedLiftsInMessage(message, c);
  if (named.length) {
    const keys = new Set(named.map(canonicalKey));
    const matches = plan.filter((e) => keys.has(canonicalKey(entryName(e))));
    return matches.length === 1 ? matches[0] : null; // >1 ambiguous; 0 → named a non-plan lift
  }

  const claimed = extractClaimedTargets(message);
  if (claimed && claimed.weight != null) {
    const wMatches = plan.filter((e) => numOrNull(e.weight) === Number(claimed.weight));
    if (wMatches.length === 1) return wMatches[0];
  }

  return plan.length === 1 ? plan[0] : null;
}

// True for a turn that asks why a currently displayed authoritative recommendation chose
// its numbers. Requires an active/displayed recommendation, a why+magnitude phrasing, and
// a resolvable target. Excludes broad reviews (keep full picture), modification requests
// (proposal flow), and factual disputes (answered deterministically by the dispute lane).
function isRecommendationExplanationTurn(message, context) {
  const c = context && typeof context === 'object' ? context : {};
  if (!hasActiveSession(c)) return false;
  const m = normalize(message);
  if (!m) return false;
  if (BROAD_REVIEW_RE.test(m)) return false;
  if (HISTORY_PAST_RE.test(m)) return false;           // a past-session question — history owns it
  if (isPlanModificationRequest(m)) return false;
  if (isFactualPlanDispute(message, c)) return false;
  if (!WHY_RE.test(m) || !MAGNITUDE_RE.test(m)) return false;
  return !!resolveRecommendationTarget(message, c);
}

// ── snapshot + narrowing ──────────────────────────────────────────────────────

// The relevant logged history for the target lift, from the recent-sessions the route
// already assembled (zero extra read). Bounded: the most recent session that logged the
// lift, its date, and its top set. Null when the lift is not in recent history.
function buildTargetHistory(context, name) {
  const c = context && typeof context === 'object' ? context : {};
  const key = nameKey(name);
  const sessions = Array.isArray(c.recent_sessions) ? c.recent_sessions : [];
  for (const s of sessions) {
    const liftSets = s && s.lift_sets && typeof s.lift_sets === 'object' ? s.lift_sets : {};
    for (const liftName of Object.keys(liftSets)) {
      if (nameKey(liftName) !== key) continue;
      const sets = Array.isArray(liftSets[liftName]) ? liftSets[liftName] : [];
      const top = sets.find((x) => x && numOrNull(x.weight) != null) || null;
      return {
        last_date: strOrNull(s.date),
        last_top: top ? `${numOrNull(top.weight)} for ${numOrNull(top.reps)}${top.rir != null ? ` at ${numOrNull(top.rir)} RIR` : ''}` : null,
      };
    }
  }
  return null;
}

// The trusted recommendation snapshot — the exact displayed recommendation as grounding.
// Carries the recommendation fingerprint (label + lift set), the target exercise and its
// prescribed sets/reps/weight/RIR, the engine's readiness/label reason, and the relevant
// history. Used by the deterministic explanation and recorded in Coach_Shadow.
function buildRecommendationSnapshot(context, targetEntry, message) {
  const c = context && typeof context === 'object' ? context : {};
  const name = entryName(targetEntry);
  const target = {
    name,
    weight: numOrNull(targetEntry.weight),
    reps: numOrNull(targetEntry.reps),
    sets: numOrNull(targetEntry.sets),
    rir: targetEntry.rir == null ? null : numOrNull(targetEntry.rir),
  };
  const planNames = planEntries(c).map(entryName).filter(Boolean).slice(0, 10);
  return {
    coaching_strategy: 'explain_recommendation',
    fingerprint: { label: strOrNull(c.recommended_label), lifts: planNames },
    label: strOrNull(c.recommended_label),
    focus: strOrNull(c.recommended_focus),
    target,
    readiness: (Array.isArray(c.readiness) ? c.readiness : []).slice(0, 6)
      .map((r) => ({ pattern: strOrNull(r && r.pattern), status: strOrNull(r && r.status), detail: strOrNull(r && r.detail) }))
      .filter((r) => r.pattern),
    history: buildTargetHistory(c, name),
    athlete_note: strOrNull(message),
  };
}

// The llmContext for a recommendation-explanation turn: diagnostics narrowed to the
// target lift, muscle_gaps dropped, and — critically — the target's
// consistent_underperformance (CHALLENGE) pattern removed so `coach_mode` floors to
// non-challenge and the model explains the prescription instead of pivoting to a
// benchmark critique of the same lift. A non-challenge pattern (e.g. a repeated
// substitution) for the target lift is preserved.
function narrowContextForRecommendationExplanation(context, targetEntry, opts = {}) {
  const c = context && typeof context === 'object' ? context : {};
  const name = entryName(targetEntry);
  const code = liftCodeOf(name);
  const key = nameKey(name);
  const isTarget = (sCode, sName) => (sCode && code && sCode === code) || (sName && nameKey(sName) === key);

  const stalls = (Array.isArray(c.stalls) ? c.stalls : [])
    .filter((s) => s && isTarget(liftCodeOf(s.exercise) || s.liftCode || null, s.exercise));
  const memory_patterns = (Array.isArray(c.memory_patterns) ? c.memory_patterns : [])
    .filter((p) => p && code && p.liftCode === code)
    .map((p) => ({ ...p, patterns: (Array.isArray(p.patterns) ? p.patterns : []).filter((x) => x && x.type !== 'consistent_underperformance') }))
    .filter((p) => p.patterns.length > 0);
  const coach_mode = deriveChatCoachMode({ memory_patterns }, { discouraged: opts.discouraged === true });

  return { ...c, stalls, memory_patterns, muscle_gaps: [], coach_mode };
}

// One resolve for the route: null on a non-recommendation-explanation turn, else the
// resolved target entry and its trusted snapshot.
function resolveRecommendationExplanation(message, context) {
  if (!isRecommendationExplanationTurn(message, context)) return null;
  const target = resolveRecommendationTarget(message, context);
  if (!target) return null;
  return { target, snapshot: buildRecommendationSnapshot(context, target, message) };
}

// ── deterministic explanation (LLM-down / fallback) ────────────────────────────

function formatLoad(t) {
  const parts = [];
  if (t.weight != null) parts.push(`${t.weight} lb`);
  if (t.reps != null) parts.push(`for ${t.reps} reps`);
  if (t.rir != null) parts.push(`at ${t.rir} RIR`);
  if (t.sets != null) parts.push(`across ${t.sets} sets`);
  return parts.join(' ');
}

// A grounded, deterministic explanation of WHY the recommendation chose its numbers —
// the target prescription, tied to the engine's readiness/label reason, plus the
// relevant history. Never a completed-write claim, never an invented number. Returns
// null (no fabrication) when the target has no weight to explain.
function buildDeterministicRecommendationExplanation(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const t = s.target && typeof s.target === 'object' ? s.target : {};
  if (!t.name || t.weight == null) return null;
  const load = formatLoad(t);
  const parts = [];
  parts.push(`${t.name} is set at ${load}${s.label ? ` — that's today's ${s.label} recommendation` : ''}.`);
  if (s.label) {
    parts.push(`The load fits a ${s.label.toLowerCase()} focus for today, which is why ${t.name} comes in at ${t.weight} rather than a heavier top set.`);
  } else {
    parts.push(`That's the engine's target for ${t.name} today, based on your recent training — not a heavier top set.`);
  }
  if (s.history && s.history.last_date) {
    parts.push(`Your last logged ${t.name} was ${s.history.last_date}${s.history.last_top ? ` at ${s.history.last_top}` : ''}.`);
  }
  return parts.join(' ');
}

// ── conversational aside ───────────────────────────────────────────────────────
//
// A bare greeting / presence-check / malfunction complaint carries no coaching content.
// It must NOT replay the previous recommendation explanation or a standing challenge (the
// production turns 3–4: "Hello, atlas are you there?" and "Uh oh your broken again" each
// replayed the same unrelated bench challenge). Handled deterministically with a direct
// acknowledgement, bypassing the model so a stale visible response can never be reused.

const ASIDE_GREETING_RE = /^(?:hi+|hey+|hello+|yo+|hiya|howdy|sup|greetings|good\s+(?:morning|afternoon|evening|day))\b/;
const ASIDE_PRESENCE_RE = /\b(?:you\s+there|are\s+you\s+(?:there|around|here|awake|alive|listening|ok|okay)|u\s+there|anyone(?:\s+there)?|anybody(?:\s+there)?|hello|atlas|you\s+(?:good|alright|working|online))\b/;
const ASIDE_MALFUNCTION_RE = /\b(?:uh[-\s]?oh|(?:you|u|ur|your|you're|youre)\s+(?:broke|broken|down|dead|dying|glitch\w*|bugg?\w*|stuck|frozen|froze|malfunction\w*)|broken\s+again|it'?s?\s+broken|is\s+it\s+broken|not\s+working|are\s+you\s+broken)\b/;
// Any coaching / lift / number / question-about-training content disqualifies a message
// from the pure-aside lane, so a real question that happens to open with "hello" ("hello,
// what's my next set?") is never swallowed.
const ASIDE_GUARD_RE = /\b(plan|next|rir|rpe|rep|set|weight|load|deload|workout|exercise|program|today|tomorrow|why|how\s+(?:much|many|do|should|to)|should\s+i|last\s+(?:time|session|week)|bench|squat|deadlift|press|curl|row|pull|push|fly|lunge|dip|raise|extension|volume|progress|benchmark|recommend\w*)\b|\d/;

function isConversationalAside(message) {
  const m = normalize(message);
  if (!m) return false;
  if (ASIDE_GUARD_RE.test(m)) return false;
  return ASIDE_GREETING_RE.test(m) || ASIDE_PRESENCE_RE.test(m) || ASIDE_MALFUNCTION_RE.test(m);
}

// A direct conversational acknowledgement / safe clarification — never a receipt, never a
// coaching claim, and never the prior answer.
function buildConversationalAck(message) {
  const m = normalize(message);
  if (ASIDE_MALFUNCTION_RE.test(m)) {
    return "I'm here and running. What do you want to work on?";
  }
  return "I'm here. What do you want to work on?";
}

module.exports = {
  planEntries,
  resolveRecommendationTarget,
  isRecommendationExplanationTurn,
  buildTargetHistory,
  buildRecommendationSnapshot,
  narrowContextForRecommendationExplanation,
  resolveRecommendationExplanation,
  buildDeterministicRecommendationExplanation,
  isConversationalAside,
  buildConversationalAck,
};
