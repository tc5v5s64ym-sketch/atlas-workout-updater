/* Atlas coaching voice — Gemini layer.
 *
 * Atlas's engine produces the *facts* (what was logged, the last working sets,
 * the deterministic next-set recommendation). This service turns those facts
 * into the coach's *voice* via Gemini 2.5 Flash-Lite. It is the server side of
 * the frontend's getInWorkoutNote() seam.
 *
 * Hard rules (enforced by the prompt + by only ever forwarding whitelisted
 * fields): the model phrases the numbers, it never invents them, and it never
 * writes anything. This module performs no Google Sheets access of any kind.
 */

const coachBrain = require('./coachBrain');
// Stimulus Governor vocabularies (PR 481) — imported (not re-declared) so the
// stimulus_grade whitelist stays in lockstep with the engine's controlled enums.
const { PROFILES, PROGRESSION_VERDICTS, FATIGUE_SIGNALS } = require('./stimulusGovernorRules');
// Fatigue Router action vocabulary (PR 483) — imported so the next_move_advisory
// whitelist stays in lockstep with the engine's controlled routing actions.
const { ROUTE_ACTIONS } = require('./fatigueRouter');
// Recovery/Deload SELECTION decision vocabulary (PR 485) — imported so the
// recovery_advisory whitelist stays in lockstep with the engine's decisions.
const { RECOVERY_DECISIONS } = require('./recoveryDeloadSelection');
// The rules engine's frozen decision/severity vocabularies — ruleTypes.js is
// built to be consumed by "(later) the AI coaching layer", i.e. here. Importing
// (rather than re-declaring) keeps the verdict-reaction whitelist in lockstep
// with the engine, so a new decision type can never silently drift out of sync.
const { DECISION_TYPES, SEVERITY_TYPES } = require('../rules/ruleTypes');

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_TIMEOUT_MS = 8000;

function coachModel() {
  return process.env.GEMINI_COACH_MODEL || DEFAULT_MODEL;
}

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// The coach's voice + the guardrails. Kept as its own function so it can be
// unit-tested without a network call (mirrors services/vision.js).
function buildCoachSystemPrompt() {
  // Governed by docs/COACHING_NOTE_VOICE.md — a note is a VERDICT on today's set,
  // grounded in the lifter's own numbers, ending on a forward-looking decision. The
  // engine owns every number and every verdict; the model only words them.
  return [
    'You are Atlas, a sharp, encouraging strength coach talking to a lifter who just logged a set.',
    'You are given STRUCTURED FACTS as JSON. Write a short coaching note in a natural, conversational voice — like a knowledgeable training partner, not a report.',
    'A note is a VERDICT, not a description: judge today against the lifter\'s own history, take a position, and point forward to the next decision.',
    '',
    'Hard rules:',
    '- IRON RULE: every number is engine-computed. Never invent or change numbers, and never recalculate. Cite ONLY numbers present in the facts (weights, reps, RIR, the range, the ceiling). If a fact is missing, drop that beat rather than fabricate one.',
    '- Use ONLY the weights, reps, and RIR present in the facts.',
    '- IRON RULE — PR/personal-best language ("personal best", "new PR", "new record", "broke your record", "PR today", or any equivalent): ONLY allowed when `progression_verdict.level` is exactly `new_ground`. A `best_weight` value in the facts alone does NOT authorize PR language. When `progression_verdict` is absent or its level is not `new_ground`, never call today a PR or personal best — not even if today\'s weight exceeds `best_weight`.',
    '- Do not claim a stall or fatigue state unless the facts say so.',
    '- Keep it tight: under ~120 words.',
    '- CONCLUSION FIRST: open with the verdict on today, then the reason, with any supporting number last — the first sentence lands the call, not the trend behind it. Reason second, details only when they earn their place; never bury the conclusion behind the explanation.',
    '- Open with one honest reaction line (e.g. acknowledge effort, a step up, or a set that hit failure).',
    '- The facts may include "effort_verdict" {level, headline} — the engine\'s read of how hard the set was, from the logged RIR vs the target. Your opening line MUST agree with it: level "far_easy" = way under target (under-effort), so say plainly it was too light and to add real weight next time, NOT merely "room to add"; "easy" = comfortably within reserve, so name that there is room to add load or reps (do NOT praise it as a grind or "pushing through"); "failure" = they hit failure, acknowledge it and say to back off; "hard" = a tough, near-target set; "on_target" = dialled in. Never contradict the verdict, and never call a high-RIR set hard or a failure set easy.',
    '- IRON RULE — derive effort from effort_verdict ONLY, never from raw RIR values in the facts: RIR 2 is solid working effort, NOT failure and NOT a grind. The words "failure", "barely made it", "grinding", "pushed to failure", "edge of failure", "near-failure", or any synonym for rep failure MUST NOT appear unless effort_verdict.level is "failure". RIR 0 in the facts does NOT by itself mean failure — only the engine\'s verdict does. Never supplement or contradict effort_verdict with your own RIR math.',
    '- The facts may include "progression_verdict" {level, range_low, range_high, ceiling, headline} — the engine\'s read of where today\'s top working set sits against the lifter\'s OWN recent working range. WORD it, never contradict it (same discipline as effort_verdict): "under_shot" = today is below their range_low–range_high band, so call out the under-shot with a spine (no reason to be light here); "in_pocket" = solidly inside the band, box checked — say so and hold the line, do not tell them to go heavier; "maintenance_drift" = inside the band but drifting toward the low end; "progressing" = pushing the top of the band upward; "new_ground" = today clears the ceiling they had beaten before. Read today AGAINST the range and reference the band when it is present.',
    '- The facts may include "deload" {active, protocol_id, load_pct, target_rir, sessions_remaining} — when present with active true, today is a DELOAD the engine is running. Frame the whole note as a deload: name it plainly, and make clear the reduced load (~{load_pct}% of the normal working weight), the fewer sets, and the high RIR (target {target_rir}, well short of failure) are BY DESIGN. A high-RIR or easy-reading set here is ON-PLAN, NOT under-effort — so do NOT tell them to add weight or push harder even if effort_verdict reads "easy" or "far_easy"; on a deload that easy reading is the goal. When sessions_remaining is present, note how many easy sessions are left and that normal training resumes after. This overrides the add-weight steer of effort_verdict ONLY here; still never invent numbers, never restate the logged sets, and never contradict the progression_verdict.',
    '- The facts may include "substitution" {classification, decision, quality, reason_code, prescribed, logged} — the engine\'s read of a swapped exercise. WORD it, never derive it: your read MUST agree with `decision` — "approve" = a sound pivot that kept the intent (preserved/baseline), "warn" = the objective was changed or abandoned, so push back honestly. You may name the prescribed and logged lifts and restate `reason_code` in plain words; you NEVER decide the classification yourself, never contradict or relabel it, and never invent a movement/muscle claim or a reason beyond `reason_code`.',
    '- `substitution.quality` (when present) is the engine\'s read of how well the swap preserves the stimulus: "poor" → VOLUNTEER it — say plainly what muscle or training intent today\'s swap missed (e.g. the prescribed lift\'s target did not get trained); "acceptable" → at most one line on the tradeoff (lighter / still covers the area), no warning; "excellent" → a clean equivalent, a brief acknowledgement is fine. NEVER call a swap good, equivalent, or say it "counts" unless quality is "excellent" or "acceptable". If quality is absent or "unknown", do NOT judge the swap\'s quality at all — only restate the decision. No praise for ordinary compliance.',
    '- The facts may include "evidence_context" {reference_sets[], date_range, benchmark, confidence} — the engine\'s historical record behind today\'s verdict. When evidence_context is present you MUST ground at least one statement in it: cite `trend.sessions_analyzed` as the session count ("Based on your last N sessions…") when present, the date span, the benchmark, or a specific reference weight/reps. Every figure you cite must appear in the facts; never fabricate a number. NEVER derive a session count by counting the `reference_sets` array — those are individual sets, not sessions, and counting them would give the wrong number.',
    '- The facts may include "deviation" {verdict, delta, magnitude} — the engine\'s read of today\'s reps vs. the lifter\'s historical expectation at this weight. "above_expected" = logged more reps than usual (positive delta); "below_expected" = fewer reps than usual (negative delta); "on_target" = consistent with history; "insufficient_data" = not enough history to judge. When deviation is present and is not "insufficient_data", weave it into the reaction once: name whether today was better or worse than their norm at this load, and name the magnitude when it is significant. Never contradict the deviation verdict, and never use a single below_expected result to call fatigue — that belongs to readiness_signal.',
    '- You MAY reference ONE history number from the facts (working_weight, first_weight, best_weight, the range/ceiling, or the most recent entry from last_working_sets) to ground progress, e.g. "right at your working weight of {working_weight}" or "up from {first_weight}" or "right in your {range_low}–{range_high}" — but only when it is present and only if it is truthful given the sets. Never invent a past number.',
    '- The facts may include "trend" {trend, confidence, sessions_analyzed} — the engine\'s e1RM trajectory across recent sessions. "improving" = e1RM is clearly rising; "flat" = holding steady; "declining" = e1RM is drifting down; "noisy" = high variance, no clear read. When trend is present and is not "noisy", name the direction once as part of the arc narrative. Never claim a trend when the field is absent, and never contradict the engine\'s verdict. `trend` is the authoritative e1RM trajectory signal — use only this object, never any other trend field in the facts.',
    '- The facts may include "readiness_signal" {signal, confidence, note} — the engine\'s fatigue inference from the recent deviation streak. "monitoring" = watching, no fatigue signal; "possible_fatigue" = 3+ consecutive below-expected sessions; "likely_fatigue" = sustained streak + declining e1RM trend. When monitoring, say nothing about fatigue. When possible_fatigue, gently name the pattern without catastrophising. When likely_fatigue, be direct and honest: name the trend and suggest the lifter consider a recovery week. Never diagnose fatigue from a single session and never contradict the engine\'s verdict.',
    '- The facts may include "stimulus_grade" {profile, effort_interpretation, progression_verdict, fatigue_signal} — the engine\'s PROFILE-AWARE read of this set (the same RIR reads differently by training profile). Respect it and never contradict it: progression_verdict "hold" or "back_off" means do NOT tell them to add load/push; "+load"/"+reps" means there is room to progress; fatigue_signal "high" means flag recovery, not progression. Critically, for a "general_fitness" profile do NOT celebrate grinding to failure — maximal effort is not the goal there. It is consistent with effort_verdict (never contradict either); word it, and never invent a number from it.',
    '- The facts may include "next_move_advisory" {action, reason, next_exercise, next_modality} — the engine\'s SUGGESTION for the planned NEXT move given the fatigue just logged. WORD it as a heads-up for what is up next, never as an order, and never reorder the plan yourself: "reduce" = trim sets/load on the next item; "make_optional" = the next item is optional today; "promote_alternative" = consider a rested/antagonist move instead; "block_pr" = do NOT attempt a PR on the next lift until recovery shows; "reduce_intensity" = keep the upcoming cardio easy (Zone 2 / shorter); "reduce_density" = cut rounds/density on the next circuit. Use the engine\'s reason; never invent a number, a set count, or a load.',
    '- The facts may include "recovery_advisory" {decision, recovery_state, rationale, deload_style} — the engine\'s CONVERGENCE-BASED read that recovery may be due. It appears ONLY on a genuine signal; when it is absent, say NOTHING about deloading. Word it CAUTIOUSLY, never as a command: for "deload" say a deload is "worth considering" or "recovery may be the smarter play" — never a flat "you need a deload"; for "recovery_reload" suggest "holding the line today" — a lighter week, not a full deload. Give the reason briefly from the facts (the converged signals / rationale) and, if deload_style is present, you may name its qualitative focus — but invent NO load/volume/RIR numbers (the prescription is owned elsewhere). Do NOT shame hard effort; reward the smart move of backing off, not heroics. Like an active deload, recovery_advisory OVERRIDES the add-weight steer of effort_verdict: when it is present, a high-RIR or "easy"/"far_easy" reading is acceptable today — so do NOT tell them to add load, go heavier, or push, NOT in the opening line and NOT anywhere, even if effort_verdict reads "easy" or "far_easy". (It remains consistent with stimulus_grade / next_move_advisory.)',
    '- The facts may include "calibration_status" — the engine\'s per-lift onboarding state. "calibrating" means Atlas does NOT yet have enough logged sessions to recommend a load for THIS lift (0–2 sessions): frame today as CALIBRATION, present any load only as a conservative START HINT ("start around {weight} and work up until ~2 reps are left in reserve"), NEVER as a recommendation, verdict, target, or "you should". Do NOT imply the lift is dialed in, and do NOT word a progression/effort verdict as settled. Frame the uncertainty as the process working — not a weakness — and never apologize for missing data. A user-stated number is a start hint only; it never becomes a confidence or a verdict. When the status is "graduated" or absent, normal verdict/recommendation phrasing is allowed.',
    '- THIN-HISTORY RULE: When `progression_verdict`, `trend`, and `readiness_signal` are all absent or null, the engine has no historical band, trajectory, or fatigue picture for this lift. You have no multi-session verdict to word — so do NOT manufacture one. React only to what IS present: the weight and RIR in `today_sets`, and `effort_verdict` if given. One factual sentence about the set is enough. Do NOT fill the void with generic filler — "great work", "keep it up", "solid session", "stay consistent", "nice job", "well done", or any equivalent phrase that says nothing specific. If you genuinely have nothing concrete to add beyond acknowledging the set happened, that is the correct response. The rule is: say what the facts let you say, and be quiet on what they do not.',
    '- End on a forward-looking DECISION line about the trajectory — where this is heading ("one clean session from moving up", "sitting on the edge of new ground"). This is about the arc, NOT a prescription. (For a "calibrating" lift, the forward line is about getting clean logged sessions in, not a load target.)',
    '- Do NOT restate the logged sets, do NOT add a "Next:" line, and do NOT duplicate the next-set recommendation numbers — the app already renders the set readout and the next-set card. Your note is the reaction and the verdict ONLY: a conversational line or two, no per-set list.',
    '- Output plain text only. No markdown headings, no bold, no code fences.',
    '- You never write to any database or sheet; you only talk.'
  ].join('\n');
}

// Forward ONLY known fields to the model — never arbitrary client-supplied
// text. This both keeps the prompt grounded and avoids passing unexpected
// content to the LLM.
function sanitizeFacts(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const toSet = s => (s && typeof s === 'object' ? {
    weight: numOrNull(s.weight),
    reps: numOrNull(s.reps),
    rir: s.rir == null ? null : numOrNull(s.rir)
  } : { weight: null, reps: null, rir: null });
  const rec = f.rec && typeof f.rec === 'object' ? f.rec : {};
  const target = rec.next_target && typeof rec.next_target === 'object' ? rec.next_target : null;
  return {
    exercise: strOrNull(f.exerciseName) || strOrNull(rec.exercise_name) || strOrNull(f.liftCode),
    lift_code: strOrNull(f.liftCode),
    today_sets: Array.isArray(f.todaySets) ? f.todaySets.slice(0, 12).map(toSet) : [],
    last_working_sets: Array.isArray(rec.last_working_sets)
      ? rec.last_working_sets.slice(-6).map(s => (s && typeof s === 'object' ? {
          weight: numOrNull(s.weight),
          reps: numOrNull(s.reps),
          rir: s.rir == null ? null : numOrNull(s.rir)
        } : { weight: null, reps: null, rir: null }))
      : [],
    recommendation: strOrNull(rec.recommendation),
    next_target: target ? { weight: numOrNull(target.weight), reps: numOrNull(target.reps), sets: numOrNull(target.sets) } : null,
    // The engine's read of how hard the just-logged set was (easy/on_target/
    // hard/failure) and the role-aware target RIR. The model WORDS this verdict —
    // it must never derive its own read of effort.
    effort_verdict: sanitizeVerdict(rec.effort_verdict),
    // The engine's read of today's LOAD against the lifter's own recent working band
    // (under_shot/in_pocket/maintenance_drift/progressing/new_ground) plus the band and
    // ceiling it was judged against. The model WORDS this verdict — it must never derive
    // its own read of progress, and every number here is engine-computed history.
    progression_verdict: sanitizeProgressionVerdict(rec.progression_verdict),
    // The deload engine's decision (from /api/recommend/next's `deload` field).
    // When a deload is active it tells the note today is a deload — reduced load,
    // fewer sets, high RIR by design — so an easy/high-RIR set is on-plan, not
    // under-effort. The model WORDS this; every number is engine-computed.
    deload: sanitizeDeloadFact(rec.deload),
    // The engine's substitution intent classification (preserved/changed/abandoned/
    // baseline + approve/warn) when the logged lift was a swap. The model WORDS this
    // decision — it never decides the classification itself or invents a reason.
    substitution: sanitizeSubstitution(f.substitution || rec.substitution),
    target_rir: numOrNull(rec.target_rir),
    // Lift history so a note can ground progress in a real number, not "great work".
    // working_weight: the RIR-zone–anchored current working weight (from resolveWorkingWeight).
    // Accepts either the full { weight, ... } object or a pre-extracted number.
    working_weight: numOrNull(
      rec.working_weight && typeof rec.working_weight === 'object'
        ? rec.working_weight.weight
        : rec.working_weight
    ),
    first_weight: numOrNull(rec.first_weight),
    best_weight: numOrNull(rec.best_weight),
    days_since_last_session: numOrNull(rec.days_since_last_session),
    // The deviation engine's classification of today's reps vs. historical expectation.
    // The model WORDS this verdict — it never derives its own deviation read.
    deviation: sanitizeDeviation(f.deviation),
    // The evidence record the engine used to assess today's performance (benchmark,
    // reference sets, date range, confidence). When present, the model MUST cite at
    // least one piece of evidence — a session count, the date span, or a reference
    // weight/reps. Every cited number must appear in the facts; the model never invents.
    evidence_context: sanitizeEvidenceContext(f.evidence_context),
    // The e1RM trend engine's verdict (services/trendDetector.js).
    // improving/flat/declining/noisy — used to ground the arc narrative.
    trend: sanitizeTrend(rec.trend),
    // The readiness/fatigue inference engine's verdict (services/readinessSignal.js).
    // monitoring/possible_fatigue/likely_fatigue from recent deviation streak + trend.
    readiness_signal: sanitizeReadinessSignal(rec.readiness_signal),
    // The Stimulus Governor's PROFILE-AWARE read of the set (PR 482/484): which
    // metric was read + a coarse progression direction + fatigue signal, styled to
    // the lifter's profile. The model WORDS this; it never invents a number.
    stimulus_grade: sanitizeStimulusGrade(f.stimulus_grade),
    // The Fatigue Router's cross-pattern / cross-modality SUGGESTION for the planned
    // NEXT move (PR 483/484), given the fatigue just logged. The model WORDS this
    // suggestion — it never auto-applies it, reorders the plan, or invents a number.
    next_move_advisory: sanitizeNextMoveAdvisory(f.next_move_advisory),
    // The Recovery/Deload SELECTION engine's CONVERGENCE-based read (PR 485/484) that
    // recovery may be due. Present only for a genuine deload / recovery_reload signal;
    // the model words it CAUTIOUSLY (worth considering / hold the line), never as a
    // command, never with a number — the deload prescription is owned elsewhere.
    recovery_advisory: sanitizeRecoveryAdvisory(f.recovery_advisory),
    // PR-O3 onboarding voice gate: the lift's per-lift calibration_status from
    // onboardingState ('calibrating' = 0–2 logged sessions, no recommendation yet;
    // 'graduated' = ≥3). When 'calibrating' the note frames a load as a conservative
    // START HINT only, never a verdict/recommendation, and never "dialed in".
    calibration_status: sanitizeCalibrationStatus(f.calibration_status ?? rec.calibration_status)
  };
}

// PR-O3: whitelist the per-lift onboarding calibration_status. Only the two enum
// values from services/onboardingState.js survive; anything else (incl. absent or
// an unknown confidence) → null, which the prompt reads as "no gate" (normal voice).
const CALIBRATION_STATUSES = ['calibrating', 'graduated'];
function sanitizeCalibrationStatus(value) {
  const s = strOrNull(value);
  return s && CALIBRATION_STATUSES.includes(s) ? s : null;
}

// Whitelist the Stimulus Governor grade — only the controlled-enum fields survive.
// A grade carrying neither a known verdict nor a known fatigue signal is dropped.
function sanitizeStimulusGrade(g) {
  if (!g || typeof g !== 'object') return null;
  const profile = PROFILES.includes(g.profile) ? g.profile : null;
  const progression_verdict = PROGRESSION_VERDICTS.includes(g.progression_verdict) ? g.progression_verdict : null;
  const fatigue_signal = FATIGUE_SIGNALS.includes(g.fatigue_signal) ? g.fatigue_signal : null;
  const effort_interpretation = strOrNull(g.effort_interpretation);
  if (!progression_verdict && !fatigue_signal) return null;
  return { profile, effort_interpretation, progression_verdict, fatigue_signal };
}

// Whitelist the Fatigue Router's next-move suggestion (PR 483/484) — only a known
// routing action survives, with the engine's reason/target/next-move labels as
// bounded strings. A 'keep' (or unknown) action carries no advice, so it is dropped.
function sanitizeNextMoveAdvisory(a) {
  if (!a || typeof a !== 'object') return null;
  const action = ROUTE_ACTIONS.includes(a.action) ? a.action : null;
  if (!action || action === 'keep') return null;
  return {
    action,
    reason: clampText(a.reason, 200),
    target: strOrNull(a.target),
    next_exercise: strOrNull(a.next_exercise),
    next_modality: strOrNull(a.next_modality),
  };
}

// Whitelist the Recovery/Deload SELECTION (PR 485/484). ONLY the two recovery-
// oriented decisions are ever voiced — deload / recovery_reload; anything else
// (normal / micro_adjustment / taper / complete_rest / unknown) carries no recovery
// advice here and is dropped, keeping the coach SILENT on weak/ambiguous signal.
// The deload_style is a profile + qualitative focus list (NO numbers — the
// prescription is owned elsewhere); converged_signals are bounded engine labels.
function sanitizeRecoveryAdvisory(a) {
  if (!a || typeof a !== 'object') return null;
  const decision = RECOVERY_DECISIONS.includes(a.decision) ? a.decision : null;
  if (decision !== 'deload' && decision !== 'recovery_reload') return null;
  const style = a.deload_style && typeof a.deload_style === 'object' ? a.deload_style : null;
  const deload_style = style ? {
    profile: strOrNull(style.profile),
    focus: Array.isArray(style.focus) ? style.focus.slice(0, 4).map(f => clampText(f, 80)).filter(Boolean) : [],
  } : null;
  return {
    decision,
    recovery_state: strOrNull(a.recovery_state),
    converged_signals: Array.isArray(a.converged_signals) ? a.converged_signals.slice(0, 6).map(s => clampText(s, 60)).filter(Boolean) : [],
    rationale: clampText(a.rationale, 240),
    deload_style,
  };
}

// Whitelist the engine's effort verdict — only the level, target, and headline
// survive; never an arbitrary object from the recommendation.
function sanitizeVerdict(v) {
  if (!v || typeof v !== 'object') return null;
  const level = strOrNull(v.level);
  if (!level) return null;
  return { level, target_rir: numOrNull(v.target_rir), headline: clampText(v.headline, 160) };
}

// Whitelist the engine's progression verdict — only the level, the band it was judged
// against, the ceiling, and the headline survive; never an arbitrary object.
function sanitizeProgressionVerdict(v) {
  if (!v || typeof v !== 'object') return null;
  const level = strOrNull(v.level);
  if (!level) return null;
  return {
    level,
    range_low: numOrNull(v.range_low),
    range_high: numOrNull(v.range_high),
    ceiling: numOrNull(v.ceiling),
    headline: clampText(v.headline, 160)
  };
}

// Whitelist the deload engine's decision into the coach fact. Only an ACTIVE
// deload (in_deload true) carries framing into the prompt — a normal day, an
// offer, or a recommendation never does. The protocol's load multiplier becomes
// a plain percent and its target RIR rides along; nothing else from the decision
// (scores, signals, raw protocol object) reaches the model.
function sanitizeDeloadFact(d) {
  if (!d || typeof d !== 'object' || d.in_deload !== true) return null;
  const protocol = d.protocol && typeof d.protocol === 'object' ? d.protocol : null;
  const loadMult = protocol ? numOrNull(protocol.load_multiplier) : null;
  return {
    active: true,
    protocol_id: strOrNull(d.protocol_id),
    load_pct: loadMult != null ? Math.round(loadMult * 100) : null,
    target_rir: protocol ? numOrNull(protocol.target_rir) : null,
    sessions_remaining: numOrNull(d.sessions_remaining)
  };
}

// Whitelist the engine's substitution intent verdict (services/substitutionIntent.js).
// Only the fields the model may WORD survive: the classification, the approve/warn
// decision, the engine's reason code, the two lift NAMES, and the evidence strings.
// classification and decision must come from the engine's frozen vocabularies — a
// value outside them (e.g. a client-injected classification) makes the whole fact
// null. The model never decides preserved/changed/abandoned and never invents a
// reason; it only words what the engine already decided. Same discipline as
// sanitizeVerdict / sanitizeConstraint.
const SUBSTITUTION_CLASSIFICATIONS = ['preserved', 'changed', 'abandoned', 'baseline'];
const SUBSTITUTION_DECISIONS = ['approve', 'warn'];
// The stimulus-quality tier from services/substitutionQuality.js. Bounded so the
// coach can only word a quality the engine actually computed.
const SUBSTITUTION_QUALITIES = ['excellent', 'acceptable', 'poor', 'unknown'];
function sanitizeSubstitution(s) {
  if (!s || typeof s !== 'object') return null;
  const classification = strOrNull(s.classification);
  const decision = strOrNull(s.decision);
  if (!SUBSTITUTION_CLASSIFICATIONS.includes(classification)) return null;
  if (!SUBSTITUTION_DECISIONS.includes(decision)) return null;
  const liftName = ref => (ref && typeof ref === 'object' ? strOrNull(ref.name) : strOrNull(ref));
  return {
    classification,
    decision,
    quality: SUBSTITUTION_QUALITIES.includes(s.quality) ? s.quality : null,
    reason_code: strOrNull(s.reason_code),
    prescribed: liftName(s.prescribed),
    logged: liftName(s.logged),
    evidence: Array.isArray(s.evidence)
      ? s.evidence.slice(0, 8).map(e => clampText(e, 160)).filter(Boolean)
      : [],
    ...(s.reason != null ? { reason: clampText(String(s.reason), 200) } : {}),
  };
}

// Whitelist the deviation engine's classification (services/performanceDeviation.js).
// Only the verdict, the rep delta, and the magnitude survive — never arbitrary caller data.
const DEVIATION_VERDICTS   = ['above_expected', 'on_target', 'below_expected', 'insufficient_data'];
const DEVIATION_MAGNITUDES = ['significant', 'slight'];
function sanitizeDeviation(d) {
  if (!d || typeof d !== 'object') return null;
  const verdict = strOrNull(d.verdict);
  if (!DEVIATION_VERDICTS.includes(verdict)) return null;
  const delta     = d.delta     != null ? numOrNull(d.delta)              : null;
  const rawMag    = d.magnitude != null ? strOrNull(d.magnitude)          : null;
  const magnitude = rawMag !== null && DEVIATION_MAGNITUDES.includes(rawMag) ? rawMag : null;
  return { verdict, delta, magnitude };
}

// Whitelist the evidence record the engine assembled to back today's assessment.
// Only the reference sets (up to 8), the date range, the working-weight benchmark,
// and the confidence level survive. All set fields are re-validated; the confidence
// string is checked against the frozen vocabulary; every date is clamped to a safe
// length. An evidence context with no usable fields collapses to null.
const EVIDENCE_CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'none'];

function sanitizeEvidenceContext(e) {
  if (!e || typeof e !== 'object') return null;

  const reference_sets = Array.isArray(e.reference_sets)
    ? e.reference_sets.slice(0, 8).map(s => {
        if (!s || typeof s !== 'object') return null;
        const weight = numOrNull(s.weight);
        const reps   = numOrNull(s.reps);
        if (weight == null || reps == null) return null;
        return {
          weight,
          reps,
          rir:  s.rir  != null ? numOrNull(s.rir)              : null,
          date: s.date != null ? clampText(String(s.date), 20) : null,
        };
      }).filter(Boolean)
    : [];

  const rawRange   = e.date_range && typeof e.date_range === 'object' ? e.date_range : null;
  const rangeFrom  = rawRange ? clampText(String(rawRange.from || ''), 20) : null;
  const rangeTo    = rawRange ? clampText(String(rawRange.to   || ''), 20) : null;
  const date_range = (rangeFrom || rangeTo) ? { from: rangeFrom, to: rangeTo } : null;

  const benchmark  = numOrNull(e.benchmark);
  const rawConf    = strOrNull(e.confidence);
  const confidence = rawConf && EVIDENCE_CONFIDENCE_LEVELS.includes(rawConf) ? rawConf : null;

  if (!reference_sets.length && !date_range && benchmark == null && !confidence) return null;

  return { reference_sets, date_range, benchmark, confidence };
}

// Whitelist the trend engine's output (services/trendDetector.js).
// 'insufficient_data' collapses to null — nothing actionable to forward to the model.
// confidence is restricted to the same two-tier vocabulary used by trendDetector.
const TREND_VERDICTS    = Object.freeze(['improving', 'flat', 'declining', 'noisy']);
const TREND_CONFIDENCE  = Object.freeze(['high', 'medium', 'none']);
function sanitizeTrend(t) {
  if (!t || typeof t !== 'object') return null;
  const trend = strOrNull(t.trend);
  if (!trend || !TREND_VERDICTS.includes(trend)) return null;
  const rawConf = strOrNull(t.confidence);
  const confidence = rawConf && TREND_CONFIDENCE.includes(rawConf) ? rawConf : null;
  return { trend, confidence, sessions_analyzed: numOrNull(t.sessions_analyzed) };
}

// Whitelist the readiness engine's output (services/readinessSignal.js).
// 'monitoring' with 'none' confidence collapses to null — nothing actionable to say.
const READINESS_SIGNALS    = Object.freeze(['monitoring', 'possible_fatigue', 'likely_fatigue']);
const READINESS_CONFIDENCE = Object.freeze(['none', 'low', 'medium', 'high']);
const READINESS_NOTES      = Object.freeze(['consecutive_below_expected', 'sustained_declining_trend']);
function sanitizeReadinessSignal(r) {
  if (!r || typeof r !== 'object') return null;
  const signal = strOrNull(r.signal);
  if (!signal || !READINESS_SIGNALS.includes(signal)) return null;
  // Suppress trivial monitoring — only surface when there is a genuine concern.
  if (signal === 'monitoring' && (r.confidence === 'none' || r.confidence == null)) return null;
  const rawConf = strOrNull(r.confidence);
  const confidence = rawConf && READINESS_CONFIDENCE.includes(rawConf) ? rawConf : null;
  const rawNote = strOrNull(r.note);
  const note = rawNote && READINESS_NOTES.includes(rawNote) ? rawNote : null;
  return { signal, confidence, note };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, 80) : null;
}

// Like strOrNull but with a caller-chosen length cap — for chat turns and the
// lifter's free-form message, which are longer than the short labels strOrNull
// guards.
function clampText(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function buildCoachUserPrompt(facts) {
  return `STRUCTURED FACTS:\n${JSON.stringify(sanitizeFacts(facts), null, 2)}`;
}

// ── Plan voice: "why this session, today" ─────────────────────────────────────
// Phrases the deterministic intent-recommendation reasoning as a short coaching
// line. The engine still owns the reasons/readiness/numbers; this only words them.
// Governed by docs/COACHING_NOTE_VOICE.md — a pre-session note still takes a position
// (the verdict is the readiness/focus call, since there is no logged set yet) and ends
// looking forward, never inventing or contradicting the engine's read.
function buildPlanSystemPrompt() {
  return [
    'You are Atlas, a sharp strength coach. The athlete just asked what to train today.',
    "You are given STRUCTURED FACTS as JSON: today's recommended focus, the reasons behind it, current movement-pattern readiness, and supporting numbers.",
    'Write a short coaching note (1–3 sentences) that takes a POSITION on today — a verdict, not a neutral description. There is no logged set yet, so the verdict is the readiness/focus call: a fresh pattern to attack, a fatigued one to respect.',
    '',
    'Hard rules:',
    '- Use ONLY the reasons, readiness, and numbers in the facts. Never invent data. Cite at most one concrete supporting number (a data_point value/context or a readiness status) and only if it is present; if none is present, drop that beat rather than fabricate one.',
    '- Have a spine: when the facts show a gap — a fatigued pattern, an elevated weekly load — name it honestly instead of only cheerleading.',
    '- CONCLUSION FIRST: lead with the position on today (a pattern to attack, a fatigued one to respect), then the reason — the conclusion opens the note, the supporting readiness/number follows. Reason second, details only when they earn their place.',
    '- Do not list the exercises — the app already shows them. Speak to WHY today looks the way it does, not what to do set by set.',
    '- End on a forward-looking line about where this session sits in the arc (e.g. "banks recovery for tomorrow\'s heavy day") — the trajectory, NOT a prescription or a rep/weight target.',
    '- Speak to the athlete ("you"). Be direct and encouraging, not a bulleted report.',
    '- The facts may include "layoff" {severity, days_since_last_session, volume_reduced} — the engine\'s read that the athlete is returning after time off. This is safety-relevant, so VOLUNTEER it: name the time off, and give the next action (ease in, hit these clean, leave a little in reserve, rebuild from here). Match severity — "mild" is no big deal, "extended" is a deliberate re-entry, not a test. Say volume was pulled back today ONLY when volume_reduced is true; never claim a cut otherwise. Direct, not dramatic — no hype, no fake encouragement.',
    '- Do NOT invent any set, rep, or weight numbers. The only numbers you may state are those present in the facts (e.g. days_since_last_session); everything else is the app\'s job.',
    '- Under ~70 words. Plain text only — no markdown, no bullets, no headings.',
    '- You never write to any database or sheet; you only explain.'
  ].join('\n');
}

// Bound the engine's return-after-layoff signal to a fixed shape: a severity
// enum, an integer day count, and a boolean. No free text reaches the model, and
// an unrecognised severity drops the whole signal (so the coach can't word a
// layoff the engine didn't assert).
function sanitizeLayoff(l) {
  if (!l || typeof l !== 'object') return null;
  const severity = ['mild', 'significant', 'extended'].includes(l.severity) ? l.severity : null;
  if (!severity) return null;
  const days = Number.isFinite(l.days_since_last_session)
    ? Math.max(0, Math.round(l.days_since_last_session))
    : null;
  return { severity, days_since_last_session: days, volume_reduced: l.volume_reduced === true };
}

function sanitizePlanFacts(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const valueStr = v => (v == null ? null : String(v).trim().slice(0, 40) || null);
  return {
    label: strOrNull(f.label),
    focus: strOrNull(f.focus),
    layoff: sanitizeLayoff(f.layoff),
    why_today: Array.isArray(f.why_today) ? f.why_today.map(strOrNull).filter(Boolean).slice(0, 4) : [],
    readiness: Array.isArray(f.readiness)
      ? f.readiness.slice(0, 6)
          .map(r => ({ pattern: strOrNull(r && r.pattern), status: strOrNull(r && r.status) }))
          .filter(r => r.pattern)
      : [],
    data_points: Array.isArray(f.data_points)
      ? f.data_points.slice(0, 4)
          .map(d => ({ label: strOrNull(d && d.label), value: valueStr(d && d.value), context: strOrNull(d && d.context) }))
          .filter(d => d.label && d.value)
      : []
  };
}

function buildPlanUserPrompt(facts) {
  return `STRUCTURED FACTS:\n${JSON.stringify(sanitizePlanFacts(facts), null, 2)}`;
}

// Single Gemini call shared by every voice (set-coaching, plan, chat). Accepts a
// ready-made `contents` array so the chat voice can pass multi-turn history while
// the one-shot voices pass a single user turn. Throws when unconfigured, on a
// Deterministic unit guard on coach DISPLAY-VOICE output (G4). The coach contract is
// numbers-only, no units — every weight Atlas stores and shows is lbs. The prompt
// says so (buildCoachSystemPrompt), but a model can IGNORE the instruction and
// fabricate a unit it was never given ("70kg", "best of 50kg") — the live 2026-06-25
// bug. The prompt is not trustworthy on its own, so this strips any weight-unit
// token the model emits, AFTER generation, BEFORE the prose reaches the user.
//
// Applied ONLY to the human-facing voices (generateCoachMessage / generatePlanMessage
// / generateChatReply), NOT at the shared callGeminiContents layer — because that
// layer also serves compileSessionFromHistory, whose slash-notation `workout_text`
// feeds the parser → preview → approve → write path. The guard must stay off any
// write-feeding text (owner scope: do not touch preview→approve→write). It is a no-op
// on valid numbers-only slash notation anyway, but scoping it to display prose keeps
// the write path genuinely untouched rather than relying on that no-op.
//
// Surgical: removes a unit ONLY when it immediately follows a number (a weight
// value), keeping the number and the rest of the sentence intact — "best of 50kg"
// → "best of 50", "225 lbs" → "225", "100 pounds" → "100". The `\b` boundary means
// only a standalone unit token is removed, never letters inside another word
// ("club"), and because it requires a leading number it never touches rep/RIR/set
// counts, percentages, dates, durations, calories, or HR (none are followed by a
// weight-unit word). Idempotent; safe on the chat path's trailing `PROPOSE_EDIT:`
// JSON (its numbers carry no unit suffix). Pure.
// Leading number is REQUIRED (so it only fires on a weight value and never on a
// word that merely contains the letters). The optional space is INSIDE the match
// (consumed), so "50 kg" → "50" with no leftover double space. The trailing \b
// keeps it to a standalone unit token — "lbs" not "lbsomething", "kilo" not
// "kilojoule". A trailing period/comma is left intact so the sentence survives
// ("best of 50kg." → "best of 50.").
const WEIGHT_UNIT_AFTER_NUMBER_RE = /(\d)\s*(?:kgs?|kilograms?|kilos?|lbs?|pounds?)\b/gi;
function stripFabricatedUnits(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(WEIGHT_UNIT_AFTER_NUMBER_RE, '$1');
}

// non-OK response, on timeout, or on empty output — the route turns any throw
// into a graceful "fall back to templated" response so the UI is never blocked.
async function callGeminiContents(systemText, contents, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputTokens = 320 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(coachModel())}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens, topP: 0.95 }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const data = await response.json();
  const text = extractText(data);
  if (!text) throw new Error('Gemini returned no text output.');
  return text;
}

// Single-turn convenience wrapper — preserves the original set/plan call shape.
async function callGemini(systemText, userText, timeoutMs) {
  return callGeminiContents(systemText, [{ role: 'user', parts: [{ text: userText }] }], { timeoutMs });
}

// Minimal connectivity probe for the coach LLM — used by GET /api/coach/health so
// the owner can see WHY coaching falls back to robotic templates (401 bad key, 404
// bad model, 429 quota, timeout). Tiny call (≤5 tokens); throws the same
// "Gemini request failed (status): detail" / "GEMINI_API_KEY is not configured" the
// real coach paths throw, so the surfaced reason matches production behavior.
async function pingGemini({ timeoutMs = 8000 } = {}) {
  // maxOutputTokens 16 (not ~5): a tiny budget can hit MAX_TOKENS before any text
  // part is emitted, making extractText throw "no text output" on a HEALTHY model —
  // the exact false-negative this probe must avoid (PR-582 review). Cost is trivial.
  return callGeminiContents('You are a connectivity probe. Reply with the word OK.',
    [{ role: 'user', parts: [{ text: 'ping' }] }], { timeoutMs, maxOutputTokens: 16 });
}

async function generateCoachMessage(facts, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // G4 unit guard — display prose only (this is the set-reaction voice).
  return stripFabricatedUnits(await callGemini(buildCoachSystemPrompt(), buildCoachUserPrompt(facts), timeoutMs));
}

async function generatePlanMessage(facts, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // G4 unit guard — display prose only (this is the plan "why today" voice).
  return stripFabricatedUnits(await callGemini(buildPlanSystemPrompt(), buildPlanUserPrompt(facts), timeoutMs));
}

// ── Conversational chat voice ────────────────────────────────────────────────
// Free-form, two-way coaching chat. Unlike the set/plan voices, this forwards
// the lifter's OWN message to the model — so the system prompt is the guardrail:
// answer only from the read-only training snapshot, never invent numbers, and
// NEVER claim to have written, logged, changed, or deleted anything. This module
// performs no Google Sheets access; the route assembles the read-only snapshot.
//
// `context` is the sanitized snapshot (after sanitizeChatContext). It drives
// cold-start vs. data-informed framing — pass undefined for the safe default
// (cold-start, conservative).
function buildChatSystemPrompt(context) {
  const modeFragment = coachBrain.isColdStart(context || {})
    ? coachBrain.buildColdStartFragment()
    : coachBrain.buildDataInformedFragment();
  return [
    'You are Atlas, a sharp, encouraging strength coach having a conversation with the lifter.',
    "You are given a read-only TRAINING SNAPSHOT (recent sessions, movement-pattern readiness, today's recommended focus, current workout plan, stalled lifts, and under-coverage gaps) as JSON, then the conversation so far. Answer the latest message in a natural, conversational coaching voice.",
    "- `muscle_gaps` in the snapshot lists muscles below their weekly minimum effective sets. When the lifter asks what to train or you're suggesting accessories, weave in a nudge toward 1–2 of the most under-served muscles with a concrete lift suggestion. Keep it to one sentence, only when it fits naturally — never recite the full list unprompted.",
    "- `memory_patterns` (if present) lists engine-detected recurring patterns for specific lifts — e.g. consistent underperformance or a repeated substitution. Reference these naturally when discussing the relevant lift. Never recite the full list unprompted, and never invent a pattern that is not in the snapshot.",
    "- `extra_work` (if present) is the engine's read of work done BEYOND today's plan: `extra_sets` (a planned lift logged for more sets than prescribed) and `extra_exercises` (logged but never planned). Keep this ON-ASK and brief — answer it plainly when the lifter asks (e.g. 'did I overdo it?'), state the fact and, if it matters, the why and next action. Do NOT volunteer it for ordinary extra work, and never praise it as compliance. ONLY raise it unprompted when it actually works against recovery or today's recommendation (e.g. extra volume on a pattern the snapshot flags fatigued/under-recovered) — then name it honestly without alarmism. Use only the numbers in `extra_work`; invent nothing.",
    "- `plan_state` (if present) is the authoritative session plan. `plan_state.remaining` lists exercises still to complete. Never drop, replace, or suggest removing a remaining exercise unless the lifter explicitly asks. When the lifter reorders (e.g. 'doing X next because machine is busy'), confirm the change and name what is still in the session — the rest of the plan stays intact. Only call the session complete when `plan_state.isComplete` is true.",
    "- WHAT'S-LEFT RULE: when the lifter asks what remains, what's next, or whether they're done — 'what's left?', 'what else?', 'what's next?', 'are we done?' — and `plan_state` is present, answer ONLY from `plan_state.remaining` (and `plan_state.isComplete` for done/not-done). Never derive remaining work from `current_plan`, the recommendation, or earlier conversation turns — those list the whole session, not what is still outstanding, and would falsely report completed lifts as remaining. If `plan_state` is absent, say you don't have an authoritative session state rather than guessing from `current_plan`.",
    '',
    coachBrain.buildPrinciplesFragment(),
    '',
    modeFragment,
    '',
    'Hard rules:',
    '- HISTORY RULE: when the lifter asks what they did in a past workout — "what did I bench last session?", "what were my squat sets?", "how did June 11 go?" — answer ONLY from `recent_sessions[*].lift_sets` (the actual logged sets). Each entry lists the real sets per exercise in order: weight × reps @ RIR N. Never substitute prescription, current_plan, recommendation, benchmark, or working-weight data for actual logged history. If the lift or session is not in the snapshot, say so plainly.',
    "- PLANNED-VS-DONE RULE: numbers in `current_plan`, `current_preview`, and the recommendation are PLANNED targets, NOT work performed. Never describe them as already done — do not say \"you've done\", \"you did\", \"you hit\", \"you got\", or report a completed total/volume from them. Only `recent_sessions[*].lift_sets` (and `plan_state` completion) reflect work actually logged. Never multiply sets × reps (or sets × weight) and state the product as work performed; a planned total is \"planned\", e.g. \"3 × 15 = 45 reps planned today\".",
    '- Ground every specific in the SNAPSHOT. Never invent or change weights, reps, RIR, dates, PRs, trends, or session counts that are not in the snapshot.',
    "- If the snapshot does not contain what you need, say you don't have that data yet — never guess a number.",
    '- General training, form, and programming advice is fine, but tie any specifics back to the snapshot.',
    '- You can only TALK and SUGGEST. You never write, save, log, edit, undo, or delete anything — that is impossible for you. Never say or imply that you saved, logged, changed, or removed something.',
    '- Atlas slash notation: "Bench 225 5/2 5/2" means Bench Press, 225 lb × 5 reps at RIR 2, twice. "185 8" means 185 lb × 8 reps, no RIR given.',
    '- When the lifter sends sets in Atlas notation (e.g. "Bench 135 10/4 185 8/2 225 5/2 5/2"), acknowledge what you heard in plain language: repeat back the exercise name and each set as "{weight} × {reps} @ RIR {rir}" (omit RIR when not given), grouping identical consecutive sets. Then add a brief coaching note (1–2 sentences). This is how the lifter confirms you captured it right — keep it fast and scannable.',
    '- If they name a lift with no sets (e.g. "Bench"), ask for the sets rather than guessing.',
    '- The lifter saves the session by saying "log it" at the end — you never trigger the write. Until then, sets are in the conversation only.',
    '- When the lifter asks what to train (or names a preference like "upper body" or "legs"), give the full session in the FIRST reply. No warm-up preamble, no "we can do X" without the numbers. Format: one short sentence of context, then each exercise on its own line: "Exercise — Xlbs × Y reps × Z sets @ RIR N". Commit — if you are not going to push back, give the prescription. Only ask a question if there is a genuine reason not to proceed (injury conflict, missing info you cannot infer).',
    '- Keep it tight — usually 2–5 sentences. Plain text only: no markdown headings, no bold, no code fences.',
    '- CONCLUSION FIRST: lead with the answer, then the reason, and details only when asked — "Hold 116. You\'re right on target." beats "Trend is flat over the last 8 sessions, so hold 116." Don\'t bury the conclusion behind the explanation. (This is presentation order only — it never changes WHAT you answer or the grounding rules above.)',
    '',
    'PROPOSING EDITS TO THE CURRENT PREVIEW:',
    '- When the lifter clearly asks to change, update, delete, or add a specific set in current_preview, you MAY propose an edit.',
    '- Only propose an edit when: (a) current_preview is non-empty, (b) the intent is unambiguous.',
    '- Put your prose reply first. Then, as the VERY LAST LINE of your response, write exactly:',
    '  PROPOSE_EDIT: {"action":"update_set","index":0,"weight":235,"reps":5,"rir":2}',
    '  or PROPOSE_EDIT: {"action":"delete_set","index":2}',
    '  or PROPOSE_EDIT: {"action":"add_set","weight":225,"reps":5,"rir":2}',
    '- index is 0-based. For update_set, omit weight/reps/rir fields you are not changing.',
    '- The PROPOSE_EDIT line is stripped by the app and never shown to the lifter — write your prose as if it does not exist.',
    '- If the intent is ambiguous or current_preview is empty, respond in prose only with no PROPOSE_EDIT line.',
    '',
    'PROPOSING PLAN EDITS TO THE CURRENT WORKOUT PLAN:',
    '- When you give the lifter a workout plan in chat, or clearly add/remove exercises from the current plan, you MUST include a structured plan edit.',
    '- This is only for the in-memory workout plan, not saved workout data. You still never write, save, log, edit sheets, undo, or delete anything.',
    '- Put your prose reply first. Then, as the VERY LAST LINE of your response, write exactly one of:',
    '  PROPOSE_PLAN_EDIT: {"action":"replace_plan","exercises":[{"name":"Bench Press","weight":225,"reps":5,"sets":3,"rir":2}]}',
    '  or PROPOSE_PLAN_EDIT: {"action":"add_exercises","exercises":[{"name":"Hanging Knee Raises","sets":3,"reps":15,"rir":2}]}',
    '  or PROPOSE_PLAN_EDIT: {"action":"remove_exercises","exercises":["Hanging Knee Raises","Dumbbell Side Bend"]}',
    '- For replace_plan, include the full visible plan in order. For add_exercises, include only the exercises being added. For remove_exercises, include only the exercises being removed.',
    '- Omit unknown weight/reps/sets/rir fields rather than inventing numbers.',
    '- The PROPOSE_PLAN_EDIT line is stripped by the app and never shown to the lifter.',
    '',
    'PROPOSING A COACHING NOTE (persistent background memory):',
    '- When the lifter reveals something durable and actionable — an injury, a mobility limit, a goal, a program change, an equipment constraint — you MAY propose saving it as a coaching note.',
    '- Only propose a note for facts worth persisting across sessions. Session observations ("great set today") do not qualify.',
    '- Put your prose reply first. Then, as the VERY LAST LINE of your response, write exactly:',
    '  PROPOSE_NOTE: {"note": "..."}',
    '- The note text must be concise (under 120 characters), factual, and third-person ("Left shoulder impingement — avoid overhead pressing"). No coaching advice in the note text itself.',
    '- The PROPOSE_NOTE line is stripped by the app and shown to the lifter as "Save this note?". Write your prose as if it does not exist.',
    '',
    'PROPOSING A STRUCTURED CONSTRAINT (a typed rule the engine can act on):',
    '- When the durable fact is a hard training rule the planner should obey — an injury that rules out a movement, a missing piece of equipment, a standing preference — prefer a structured constraint over a free-text note. It carries the same fact in a shape the engine can filter on.',
    '- A constraint has exactly three required fields plus an optional note:',
    '  - kind: one of "injury", "equipment", "preference".',
    '  - target: the movement, pattern, or equipment it applies to ("overhead pressing", "barbell", "high-bar squat").',
    '  - rule: one of "avoid" (never program it), "limit" (keep it light/cautious), "substitute" (swap for an alternative).',
    '  - note (optional): brief context, under 120 characters, factual ("left shoulder impingement").',
    '- Put your prose reply first. Then, as the VERY LAST LINE of your response, write exactly:',
    '  PROPOSE_CONSTRAINT: {"kind":"injury","target":"overhead pressing","rule":"avoid","note":"left shoulder impingement"}',
    '- The PROPOSE_CONSTRAINT line is stripped by the app and shown to the lifter as "Save this constraint?". Write your prose as if it does not exist.',
    '',
    'PROPOSAL RULES (apply to all three):',
    '- You can only ever propose ONE thing per reply — a PROPOSE_EDIT, a PROPOSE_NOTE, or a PROPOSE_CONSTRAINT, never more than one.',
    '- The `constraints` already in the snapshot are active rules — treat them as silent background; never re-propose a constraint that is already saved.',
    '- If nothing worth persisting came up, respond in prose only with no proposal line.'
  ].join('\n');
}

// Extract an optional PROPOSE_EDIT: {...} from the last non-blank line of a
// Gemini reply. Returns { reply: proseText, propose_edit: objectOrNull }.
// Malformed JSON or an unrecognised schema → propose_edit is null.
function parseEditFromReply(text) {
  if (typeof text !== 'string') return { reply: '', propose_edit: null };
  const lines = text.split('\n');
  // Walk backwards, skip blank lines, inspect the first non-empty line from end.
  let editLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('PROPOSE_EDIT:')) editLineIdx = i;
    break; // stop after finding the first non-blank line from the end
  }
  if (editLineIdx === -1) return { reply: text.trim(), propose_edit: null };
  const jsonPart = lines[editLineIdx].trim().slice('PROPOSE_EDIT:'.length).trim();
  const prose = lines.slice(0, editLineIdx).join('\n').trim();
  let propose_edit = null;
  try {
    const parsed = JSON.parse(jsonPart);
    if (isValidEditSchema(parsed)) propose_edit = parsed;
  } catch { /* malformed JSON — no edit */ }
  return { reply: prose || text.trim(), propose_edit };
}

// Defense-in-depth numeric validation for an edit proposal (ME-9). The client
// still bounds-checks against the visible rows and the write path re-parses, but
// a proposal carrying a non-finite or absurd weight/reps/rir must never be offered
// to the lifter as an approvable edit. Each field is validated ONLY when present:
// update_set omits the fields it is not changing, and a bare add_set is allowed to
// let the client supply the numbers — so absence is valid, but a present value must
// be finite and within sane rule-engine bounds (weight lb >0..2000, reps int 1..100,
// rir 0..10). Catches NaN/Infinity/negative/string/out-of-range from a flaky model.
function editNumbersValid(obj) {
  if (obj.weight != null && !(Number.isFinite(obj.weight) && obj.weight > 0 && obj.weight <= 2000)) return false;
  if (obj.reps   != null && !(Number.isInteger(obj.reps) && obj.reps >= 1 && obj.reps <= 100)) return false;
  if (obj.rir    != null && !(Number.isFinite(obj.rir) && obj.rir >= 0 && obj.rir <= 10)) return false;
  return true;
}

// Structural schema check + numeric bounds. The row-count bounds (index vs visible
// rows) are still validated by the client; the server adds finiteness/range guards
// so a malformed proposal never reaches the approval gate.
function isValidEditSchema(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const { action } = obj;
  if (action === 'update_set') {
    return Number.isInteger(obj.index) && obj.index >= 0 && editNumbersValid(obj);
  }
  if (action === 'delete_set') {
    return Number.isInteger(obj.index) && obj.index >= 0;
  }
  if (action === 'add_set') {
    return editNumbersValid(obj);
  }
  return false;
}

function sanitizePlanEditExercise(ex) {
  if (typeof ex === 'string') {
    const name = ex.trim();
    return name ? { name } : null;
  }
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) return null;
  const name = typeof ex.name === 'string'
    ? ex.name.trim()
    : (typeof ex.exercise === 'string' ? ex.exercise.trim() : '');
  if (!name) return null;
  const clean = { name };
  const liftCode = ex.liftCode || ex.lift_code;
  if (typeof liftCode === 'string' && liftCode.trim()) clean.liftCode = liftCode.trim();
  const rationale = ex.rationale || ex.reason || ex.focus;
  if (typeof rationale === 'string' && rationale.trim()) clean.rationale = rationale.trim().slice(0, 200);
  for (const key of ['weight', 'reps', 'sets', 'rir']) {
    if (ex[key] == null || ex[key] === '') continue;
    const n = Number(ex[key]);
    if (Number.isFinite(n)) clean[key] = n;
  }
  return clean;
}

function isValidPlanEditSchema(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const action = obj.action;
  if (!['replace_plan', 'add_exercises', 'remove_exercises'].includes(action)) return false;
  if (!Array.isArray(obj.exercises) || obj.exercises.length === 0) return false;
  const exercises = obj.exercises.map(sanitizePlanEditExercise).filter(Boolean);
  if (!exercises.length) return false;
  obj.exercises = exercises.slice(0, 12);
  return true;
}

// Fixed vocabularies for structured constraints. A constraint is a typed,
// approved rule ({ kind, target, rule }) — distinct from a free-text note.
// These mirror the validation the /api/constraints write route enforces.
const CONSTRAINT_KINDS = ['injury', 'equipment', 'preference'];
const CONSTRAINT_RULES = ['avoid', 'limit', 'substitute'];

// Whitelist a single constraint fact for the model. Only known fields survive;
// kind/rule must come from the fixed vocabularies; a malformed constraint → null.
// Same discipline as sanitizeVerdict / sanitizeProgressionVerdict.
function sanitizeConstraint(v) {
  if (!v || typeof v !== 'object') return null;
  const kind = typeof v.kind === 'string' ? v.kind.trim().toLowerCase() : '';
  const rule = typeof v.rule === 'string' ? v.rule.trim().toLowerCase() : '';
  const target = strOrNull(v.target);
  if (!CONSTRAINT_KINDS.includes(kind)) return null;
  if (!CONSTRAINT_RULES.includes(rule)) return null;
  if (!target) return null;
  return { kind, target, rule, note: clampText(v.note, 200) };
}

// Forward ONLY a known, bounded snapshot — never arbitrary client object keys.
function sanitizeChatContext(context) {
  const c = context && typeof context === 'object' ? context : {};
  const recent_sessions = Array.isArray(c.recent_sessions) ? c.recent_sessions.slice(0, 6).map(s => {
    const rawLiftSets = s && s.lift_sets && typeof s.lift_sets === 'object' ? s.lift_sets : {};
    const lift_sets = {};
    let exerciseCount = 0;
    for (const rawName of Object.keys(rawLiftSets)) {
      if (exerciseCount >= 8) break;
      const name = strOrNull(rawName);
      if (!name) continue;
      const sets = Array.isArray(rawLiftSets[rawName])
        ? rawLiftSets[rawName].slice(0, 12).map(set => {
            if (!set || typeof set !== 'object') return null;
            const weight = numOrNull(set.weight);
            const reps = numOrNull(set.reps);
            if (weight == null || weight <= 0 || reps == null || reps <= 0) return null;
            return { weight, reps, rir: set.rir != null ? numOrNull(set.rir) : null };
          }).filter(Boolean)
        : [];
      if (sets.length) { lift_sets[name] = sets; exerciseCount++; }
    }
    return {
      date: strOrNull(s && s.date),
      exercises: Array.isArray(s && s.exercises) ? s.exercises.slice(0, 12).map(strOrNull).filter(Boolean) : [],
      sets: numOrNull(s && s.sets),
      volume: numOrNull(s && s.volume),
      lift_sets
    };
  }) : [];
  const readiness = Array.isArray(c.readiness) ? c.readiness.slice(0, 8).map(r => ({
    pattern: strOrNull(r && r.pattern),
    status: strOrNull(r && r.status),
    detail: strOrNull(r && r.detail)
  })).filter(r => r.pattern) : [];
  const stalls = Array.isArray(c.stalls) ? c.stalls.slice(0, 8).map(s => ({
    exercise: strOrNull(s && s.exercise),
    weight: numOrNull(s && s.weight),
    sessions_stalled: numOrNull(s && s.sessions_stalled)
  })).filter(s => s.exercise) : [];
  const current_preview = Array.isArray(c.current_preview) ? c.current_preview.slice(0, 16).map(s => (s && typeof s === 'object' ? {
    exercise: strOrNull(s.exercise),
    weight: numOrNull(s.weight),
    reps: numOrNull(s.reps),
    rir: s.rir == null ? null : numOrNull(s.rir)
  } : { exercise: null, weight: null, reps: null, rir: null })).filter(s => s.exercise) : [];
  const current_plan = Array.isArray(c.current_plan) ? c.current_plan.slice(0, 10).map(e => (e && typeof e === 'object' ? {
    name: strOrNull(e.name),
    rationale: strOrNull(e.rationale),
    weight: numOrNull(e.weight),
    reps: numOrNull(e.reps),
    sets: numOrNull(e.sets),
    rir: e.rir == null ? null : numOrNull(e.rir)
  } : { name: null, rationale: null, weight: null, reps: null, sets: null, rir: null })).filter(e => e.name) : [];
  const session_count = numOrNull(c.session_count);
  const coaching_notes = Array.isArray(c.coaching_notes)
    ? c.coaching_notes.slice(0, 10).map(n => ({
        date: strOrNull(n && n.date),
        note: clampText(n && n.note, 200)
      })).filter(n => n.note)
    : [];
  const constraints = Array.isArray(c.constraints)
    ? c.constraints.slice(0, 12).map(sanitizeConstraint).filter(Boolean)
    : [];
  // Under-coverage gaps computed by the deterministic engine — muscles below
  // their weekly minimum. Capped at 6; only known fields survive sanitization.
  const muscle_gaps = Array.isArray(c.muscle_gaps)
    ? c.muscle_gaps.slice(0, 6).map(g => ({
        muscle: strOrNull(g && g.muscle),
        currentEffectiveSets: numOrNull(g && g.currentEffectiveSets),
        targetMin: numOrNull(g && g.targetMin)
      })).filter(g => g.muscle)
    : [];
  // Whitelist known pattern types; pick only the expected detail fields per type.
  const memory_patterns = Array.isArray(c.memory_patterns)
    ? c.memory_patterns.slice(0, 5).map(item => {
        if (!item || typeof item !== 'object') return null;
        const liftCode = strOrNull(item.liftCode);
        if (!liftCode) return null;
        const patterns = Array.isArray(item.patterns)
          ? item.patterns.slice(0, 4).map(p => {
              if (!p || typeof p !== 'object') return null;
              const type = strOrNull(p.type);
              const d = p.details && typeof p.details === 'object' ? p.details : {};
              if (type === 'consistent_underperformance') {
                return { type, details: { sessions_below: numOrNull(d.sessions_below), sessions_checked: numOrNull(d.sessions_checked) } };
              }
              if (type === 'repeated_substitution') {
                return { type, details: { original: strOrNull(d.original), substitute: strOrNull(d.substitute), count: numOrNull(d.count) } };
              }
              return null; // unknown type — drop
            }).filter(Boolean)
          : [];
        return patterns.length ? { liftCode, patterns } : null;
      }).filter(Boolean)
    : [];
  // Plan state: remaining exercises must survive sanitization intact so the coach
  // can see exactly what is still to be done. Only string entries survive; cap at 20.
  const rawPs = c.plan_state && typeof c.plan_state === 'object' ? c.plan_state : null;
  const plan_state = rawPs && Array.isArray(rawPs.planned) && rawPs.planned.length > 0
    ? {
        planned:    rawPs.planned.slice(0, 20).map(strOrNull).filter(Boolean),
        completed:  Array.isArray(rawPs.completed)  ? rawPs.completed.slice(0, 20).map(strOrNull).filter(Boolean)  : [],
        remaining:  Array.isArray(rawPs.remaining)  ? rawPs.remaining.slice(0, 20).map(strOrNull).filter(Boolean)  : [],
        isComplete: rawPs.isComplete === true
      }
    : null;
  // Unprogrammed extra-work signal (engine: services/extraWorkDetector.js). Bounded
  // to the engine's shape; counts coerced to numbers, names to strings. Null when
  // there is nothing extra so the coach has no fact to volunteer.
  const rawXw = c.extra_work && typeof c.extra_work === 'object' ? c.extra_work : null;
  const extra_work = rawXw && rawXw.has_extra === true
    ? {
        extra_sets: Array.isArray(rawXw.extra_sets)
          ? rawXw.extra_sets.slice(0, 8).map(s => ({
              exercise: strOrNull(s && s.exercise),
              prescribed_sets: numOrNull(s && s.prescribed_sets),
              logged_sets: numOrNull(s && s.logged_sets),
              extra: numOrNull(s && s.extra)
            })).filter(s => s.exercise)
          : [],
        extra_exercises: Array.isArray(rawXw.extra_exercises)
          ? rawXw.extra_exercises.slice(0, 8).map(e => ({ exercise: strOrNull(e && e.exercise) })).filter(e => e.exercise)
          : [],
        has_extra: true
      }
    : null;
  return {
    recommended_label: strOrNull(c.recommended_label),
    recommended_focus: strOrNull(c.recommended_focus),
    readiness,
    recent_sessions,
    stalls,
    muscle_gaps,
    memory_patterns,
    plan_state,
    current_preview,
    current_plan,
    extra_work,
    session_count,
    coaching_notes,
    constraints
  };
}

// Extract an optional PROPOSE_NOTE: {...} from the last non-blank line.
// Returns { reply: proseText, propose_note: objectOrNull }.
function parseNoteFromReply(text) {
  if (typeof text !== 'string') return { reply: '', propose_note: null };
  const lines = text.split('\n');
  let noteLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('PROPOSE_NOTE:')) noteLineIdx = i;
    break;
  }
  if (noteLineIdx === -1) return { reply: text.trim(), propose_note: null };
  const jsonPart = lines[noteLineIdx].trim().slice('PROPOSE_NOTE:'.length).trim();
  const prose = lines.slice(0, noteLineIdx).join('\n').trim();
  let propose_note = null;
  try {
    const parsed = JSON.parse(jsonPart);
    if (parsed && typeof parsed === 'object' && typeof parsed.note === 'string' && parsed.note.trim()) {
      propose_note = { note: parsed.note.trim().slice(0, 200) };
    }
  } catch { /* malformed JSON — no note */ }
  return { reply: prose || text.trim(), propose_note };
}

// Internal parser that handles PROPOSE_EDIT, PROPOSE_NOTE, and PROPOSE_CONSTRAINT
// in one pass — the last non-blank line can carry at most one token per reply.
function parseReplyWithProposals(text) {
  const empty = { reply: '', propose_edit: null, propose_note: null, propose_constraint: null, propose_plan_edit: null };
  if (typeof text !== 'string') return empty;
  const lines = text.split('\n');
  let tokenLineIdx = -1;
  let tokenType = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('PROPOSE_EDIT:')) { tokenLineIdx = i; tokenType = 'edit'; }
    else if (trimmed.startsWith('PROPOSE_NOTE:')) { tokenLineIdx = i; tokenType = 'note'; }
    else if (trimmed.startsWith('PROPOSE_CONSTRAINT:')) { tokenLineIdx = i; tokenType = 'constraint'; }
    else if (trimmed.startsWith('PROPOSE_PLAN_EDIT:')) { tokenLineIdx = i; tokenType = 'plan_edit'; }
    break;
  }
  if (tokenLineIdx === -1) return { ...empty, reply: text.trim() };
  const prefix = tokenType === 'edit'
    ? 'PROPOSE_EDIT:'
    : tokenType === 'note'
      ? 'PROPOSE_NOTE:'
      : tokenType === 'constraint'
        ? 'PROPOSE_CONSTRAINT:'
        : 'PROPOSE_PLAN_EDIT:';
  const jsonPart = lines[tokenLineIdx].trim().slice(prefix.length).trim();
  const prose = lines.slice(0, tokenLineIdx).join('\n').trim();
  let propose_edit = null;
  let propose_note = null;
  let propose_constraint = null;
  let propose_plan_edit = null;
  try {
    const parsed = JSON.parse(jsonPart);
    if (tokenType === 'edit' && isValidEditSchema(parsed)) propose_edit = parsed;
    else if (tokenType === 'note' && parsed && typeof parsed === 'object' && typeof parsed.note === 'string' && parsed.note.trim()) {
      propose_note = { note: parsed.note.trim().slice(0, 200) };
    } else if (tokenType === 'constraint') {
      propose_constraint = sanitizeConstraint(parsed);
    } else if (tokenType === 'plan_edit' && isValidPlanEditSchema(parsed)) {
      propose_plan_edit = parsed;
    }
  } catch { /* malformed JSON — no proposal */ }
  return { reply: prose || text.trim(), propose_edit, propose_note, propose_constraint, propose_plan_edit };
}

// Bound the conversation to the last few turns; only role + text survive. The
// caller passes PRIOR turns here and the current message separately.
function sanitizeChatHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map(turn => {
    const role = (turn && turn.role === 'atlas') ? 'model' : 'user';
    const text = clampText(turn && turn.text, 2000);
    return text ? { role, text } : null;
  }).filter(Boolean);
}

async function generateChatReply({ message, context, history } = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const userMessage = clampText(message, 2000);
  if (!userMessage) throw new Error('chat message is required');

  const snapshot = sanitizeChatContext(context);
  const turns = sanitizeChatHistory(history);

  // Prime with the snapshot as the first exchange so the model treats it as
  // grounding, then replay prior turns, then the lifter's current message.
  // coaching_notes arrive already inside `snapshot` (via sanitizeChatContext);
  // they are included here without any extra instruction so the model treats them
  // as silent background — not something to announce or repeat.
  const contents = [
    { role: 'user', parts: [{ text: `TRAINING SNAPSHOT (read-only facts):\n${JSON.stringify(snapshot, null, 2)}` }] },
    { role: 'model', parts: [{ text: "Got it — I'll answer from these facts, treat any coaching notes and saved constraints as silent background only, and never claim to save anything." }] }
  ];
  for (const t of turns) contents.push({ role: t.role, parts: [{ text: t.text }] });
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  // G4 unit guard — strip fabricated weight units from the chat prose before
  // parsing. Safe on the trailing PROPOSE_EDIT/PROPOSE_NOTE directive: its numbers
  // carry no unit suffix, so the strip is a no-op on the structured last line.
  const raw = stripFabricatedUnits(await callGeminiContents(buildChatSystemPrompt(snapshot), contents, { timeoutMs, maxOutputTokens: 450 }));
  return parseReplyWithProposals(raw);
}

function extractText(data) {
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
}

// ── Session compilation: extract logged sets from conversation ────────────────
// When the lifter says "log it" at the end of a conversational session, this
// asks Gemini to extract all the workout sets they actually did — ignoring
// Atlas's own suggestions and any sets discussed but not performed.
function buildCompileSystemPrompt() {
  return [
    'You are Atlas, a workout logging assistant.',
    'You are given a conversation between a lifter and Atlas (their coach).',
    'Your job: extract ONLY the workout sets the lifter ACTUALLY LOGGED OR PERFORMED during this session.',
    '',
    'Output format — Atlas slash notation, one exercise per line:',
    '  Bench Press 135 10 185 8/2 225 6/1',
    '  Deadlift 135 10/4 185 10/2 225 8/2 245 6/2',
    '',
    'Set notation: {exercise} {weight} {reps}/{rir}',
    '  - weight is in lbs (numbers only, no units in output)',
    '  - reps is number of reps',
    '  - rir is reps in reserve — omit the /rir if not mentioned',
    '  - Chain multiple sets for the same exercise on one line',
    '',
    'Rules:',
    '- ONLY include sets the lifter did. Ignore Atlas\'s recommendations, plans, and suggestions.',
    '- If the lifter corrected a number ("actually that was 8 not 10"), use the corrected value.',
    '- Preserve the order exercises were performed.',
    '- Use the canonical exercise name when obvious (e.g. "bench" → "Bench Press"), or the lifter\'s exact phrasing otherwise.',
    '- If no workout sets are found in the conversation, output exactly: NO_WORKOUT_FOUND',
    '- Output ONLY the workout lines. No prose, no explanations, no headings, no commentary.'
  ].join('\n');
}

async function compileSessionFromHistory(turns, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Array.isArray(turns) || !turns.length) return { workout_text: null };

  const sanitized = turns
    .filter(t => t && (t.role === 'user' || t.role === 'atlas'))
    .slice(-40)
    .map(t => {
      const role = t.role === 'atlas' ? 'Atlas' : 'Lifter';
      const text = clampText(t.text, 800);
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean);

  if (!sanitized.length) return { workout_text: null };

  const userPrompt = `CONVERSATION:\n${sanitized.join('\n')}\n\nExtract the workout sets.`;
  const raw = await callGemini(buildCompileSystemPrompt(), userPrompt, timeoutMs);
  const result = raw.trim();
  if (!result || result === 'NO_WORKOUT_FOUND') return { workout_text: null };
  return { workout_text: result };
}

// ── Expectation verdict reaction (PR 3.4) ────────────────────────────────────
// Words the PR 3.3 `computeExpectationVerdict` result + the rules engine's
// decisions (rules/ruleTypes.js) with the personality spec from
// COACH_PERSONALITY.md. The engine owns every number, the verdict, AND the rule
// calls; this layer only words them. Pure voice — nothing surfaces it yet.
//
// Gate: react for fell_short, swap, and beat, OR when the engine raised a rule
// worth surfacing (a caution/reject — e.g. pain, RIR 0–1 grinding). Stay quiet
// for a clean "met" set with no rule raised. Default quiet: the engine decides
// when there is something worth saying; this module only words the decision.

function buildVerdictReactionSystemPrompt() {
  return [
    'You are Atlas, a strength coach reacting to a set the lifter just logged.',
    'Identity: you keep the logbook and you are not easily impressed. You speak only when there is something worth saying, and you say it straight — a direct training partner, never a hype man.',
    '',
    'You are given REACTION INPUT as JSON: the engine\'s `verdict` (its read of the gap between expected and actual effort), any `rule_decisions` the engine raised (its final calls — caution, pain, etc.), and a read-only `context` block with the grounding numbers. React to the gap and to any rule the engine raised. The gap is the story.',
    '',
    'outcome rules (from verdict.outcome):',
    '- "beat": pushed harder than the target. Celebrate ONLY when it is earned — a meaningful push (2+ RIR below target), a true milestone, or hitting the mark after time off. For a small beat (1 RIR under), one honest line, then move on — not a song.',
    '- "fell_short": too much left in reserve. Firm, honest pushback — on their side, never harsh, never "you failed". Name what you saw and tell them how to close the gap (e.g. "if set one feels easy, bump the weight and chase that [prescribedRir]-in-reserve").',
    '- "swap": the lifter logged a different exercise than prescribed. If `context.substitution` is present, it is the engine\'s classification of that swap — defer to it (see the substitution rule below). If it is absent, treat the swap as a win — a brief acknowledgement of a smart adjustment, and if no clean equivalent load exists, coach them to find the working weight at the target RIR — start conservative, work up until the set leaves about [prescribedRir] in reserve.',
    '- "met": a clean set landed where expected — nothing to react to. The gate already filters these out; if one reaches you with no rule raised, a single nod at most.',
    '',
    'substitution (context.substitution — the engine\'s read of a swapped exercise; present only on a swap):',
    '- It carries a `classification` (preserved / changed / abandoned / baseline), a `decision` (approve / warn), a `quality` tier, the engine\'s `reason_code`, and the `prescribed` / `logged` lift names. The engine OWNS this call.',
    '- Your read MUST agree with `decision`: "approve" = a sound pivot that kept the session\'s intent (preserved or baseline) — acknowledge it as a smart adjustment; "warn" = the intent was changed or abandoned (wrong muscle, or the objective went untrained) — push back honestly and tell them to get the real movement back in.',
    '- `quality` (when present) grades the stimulus: "poor" → name plainly what muscle/intent today\'s swap missed; "acceptable" → at most one line on the tradeoff; "excellent" → a clean equivalent, brief acknowledgement is fine. NEVER call a swap good/equivalent or say it "counts" unless quality is "excellent" or "acceptable"; if quality is absent or "unknown", do not judge the swap\'s quality, only restate the decision.',
    '- You may name the `prescribed` and `logged` lifts, restate the engine\'s `reason_code` in plain words, and if `reason` is present, incorporate that stated reason naturally (e.g. "the rack was unavailable, so you pivoted to..."). You must NEVER decide the classification yourself, never relabel or contradict it, and never name a reason the engine did not give. Never invent a movement-pattern or muscle claim that is not in the facts.',
    '',
    'rule_decisions (the engine\'s final calls — explain them, never override them):',
    '- A rule decision is FINAL. Word its `reasoning` in your own voice; never argue with it, never soften it into nothing. If the lifter pushes back, do NOT relent — restate the criterion they still have to beat (use `criterion_progress` when present).',
    '- rule_id "pain_flag": pain or a tweak was noted. STOP coaching load — do not tell them to add weight or push. Flag it plainly and tell them to hold load on that lift until it clears. This overrides any "beat" or celebration.',
    '- rule_id "rir_caution" / "junk_rep_guard" (RIR 0–1, grinding to failure): acknowledge the effort, then counsel caution — these count as reps, not as the clean-session standard. Never celebrate grinding as if it were the goal.',
    '',
    'Hard rules:',
    '- IRON RULE: the engine owns the verdict and every number; you only word it. Never contradict `outcome`, `why`, `rirDelta`, or any rule decision.',
    '- State ONLY numbers that appear in the input (weights, reps, RIR, the delta, criterion_progress). Never invent a weight, rep, RIR, session, set, or effort that is not there. If a number is missing, drop that beat rather than fabricate one.',
    '- The verdict\'s `why` is the engine\'s read — cite it when useful, never rewrite it with different numbers.',
    '',
    'Voice — match the shape of these moments (tone, length, information-order — never the numbers):',
    '- clean set: a brief nod, move on. Do not gush.',
    '- grindy set (RIR 0–1): respect the effort first, then the caution — coach-style ("that one cost you"), not a disclaimer.',
    '- milestone (an earned beat / PR): name what they beat, one honest line of credit, point forward.',
    '- asks-to-load-early / pushes back: hold the line and restate the criterion still to beat — explain, do not cave.',
    '- session finish: a short, honest read of the session — no recap of every set.',
    '- parser clarification: when the input is ambiguous, ask the one thing you need; never guess a number.',
    '',
    'Anti-patterns — never produce these:',
    '- No exclamation stacking, no "Great job!! 💪", no emoji confetti.',
    '- Do not restate the lifter\'s input back at length.',
    '- No hedging walls, and no corporate or liability safety boilerplate. Caution sounds like a coach ("that one cost you"), not a disclaimer.',
    '',
    '- Default to at most 4 short sentences and stay under 60 words. Plain text only — no markdown, no bullets, no headings.',
    '- You never write to any database or sheet; you only talk.'
  ].join('\n');
}

// Whitelist only the verdict fields the model needs — never arbitrary input.
function sanitizeVerdictFacts(verdict) {
  if (!verdict || typeof verdict !== 'object') return null;
  const outcome = typeof verdict.outcome === 'string' ? verdict.outcome.trim() : null;
  if (!['beat', 'met', 'fell_short', 'swap'].includes(outcome)) return null;
  const numNullable = v => (v == null ? null : numOrNull(v));
  return {
    outcome,
    why:           clampText(verdict.why, 200),
    prescribedRir: numNullable(verdict.prescribedRir),
    actualRir:     numNullable(verdict.actualRir),
    rirDelta:      numNullable(verdict.rirDelta),
  };
}

// Whitelist a single rules-engine decision (rules/ruleTypes.js shape) for the
// model. Only the known fields survive; `decision` must come from the frozen
// vocabulary and `rule_id` is required — a malformed decision → null. Same
// discipline as sanitizeVerdictFacts / sanitizeConstraint.
function sanitizeRuleDecision(d) {
  if (!d || typeof d !== 'object') return null;
  const decision = typeof d.decision === 'string' ? d.decision.trim() : '';
  if (!DECISION_TYPES.includes(decision)) return null;
  const rule_id = strOrNull(d.rule_id);
  if (!rule_id) return null;
  const severity = SEVERITY_TYPES.includes(d.severity) ? d.severity : 'info';
  return {
    decision,
    rule_id,
    severity,
    reasoning:          clampText(d.reasoning, 240),
    criterion_progress: clampText(d.criterion_progress, 120),
    lift_code:          strOrNull(d.lift_code),
  };
}

// Whitelist the array of rule decisions; drop anything malformed, cap the count.
function sanitizeRuleDecisions(decisions) {
  if (!Array.isArray(decisions)) return [];
  return decisions.slice(0, 6).map(sanitizeRuleDecision).filter(Boolean);
}

// Whitelist the per-request context block — the grounding numbers the model may
// word. Never arbitrary client keys; every number is engine-supplied and passed
// through verbatim (this layer derives nothing).
function sanitizeReactionContext(context) {
  const c = context && typeof context === 'object' ? context : {};
  // Tolerate a malformed array element (null / non-object) the same way the
  // function tolerates a null context — guard the element before dereferencing
  // it, so an untrusted `sets: [null]` can't crash the whitelist.
  const toSet = s => (s && typeof s === 'object' ? {
    weight: numOrNull(s.weight),
    reps:   numOrNull(s.reps),
    rir:    s.rir == null ? null : numOrNull(s.rir),
  } : { weight: null, reps: null, rir: null });
  const sets = Array.isArray(c.sets) ? c.sets
    : Array.isArray(c.todaySets) ? c.todaySets
    : [];
  return {
    exercise:     strOrNull(c.exercise) || strOrNull(c.exerciseName) || strOrNull(c.lift_code),
    lift_code:    strOrNull(c.lift_code),
    sets:         sets.slice(0, 12).map(toSet),
    first_weight: numOrNull(c.first_weight),
    best_weight:  numOrNull(c.best_weight),
    days_since_last_session: numOrNull(c.days_since_last_session),
    // The engine's substitution intent verdict for a swapped lift — the model words
    // the decision, never derives it. Unknown keys/invalid vocab are dropped.
    substitution: sanitizeSubstitution(c.substitution),
  };
}

// Returns true when the verdict has a gap worth talking about.
// met → quiet; beat / fell_short / swap → react.
function isVerdictWorthReacting(verdict) {
  if (!verdict || typeof verdict !== 'object') return false;
  const { outcome } = verdict;
  return outcome === 'beat' || outcome === 'fell_short' || outcome === 'swap';
}

// A rule decision is worth breaking silence for when it is a caution/reject or
// carries a warning/error severity (pain, RIR 0–1 grinding, drift). Info-level
// progression calls (a routine "load"/"hold") on their own do NOT force a
// reaction — those ride the quiet "met" path.
function hasActionableRuleDecision(decisions) {
  const list = Array.isArray(decisions) ? decisions : [];
  return list.some(d => d && (
    d.severity === 'warning' || d.severity === 'error' ||
    d.decision === 'caution' || d.decision === 'reject'
  ));
}

// The full gate: speak when the verdict shows a real gap OR the engine raised a
// rule worth surfacing (so a clean "met" set with a pain note still gets flagged).
function shouldReactToVerdict({ verdict, ruleDecisions } = {}) {
  return isVerdictWorthReacting(verdict) || hasActionableRuleDecision(ruleDecisions);
}

// Generate a short coaching reaction (≤4 sentences) for the expectation verdict
// plus any rule decisions and the per-request context. Returns null when there
// is nothing worth saying (a clean met set, no rule raised, null/bad input).
// Degrades gracefully — throws when Gemini is unconfigured (caught by the route).
async function generateVerdictReaction(verdict, { ruleDecisions = [], context = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const facts = sanitizeVerdictFacts(verdict);
  const rules = sanitizeRuleDecisions(ruleDecisions);
  if (!shouldReactToVerdict({ verdict: facts, ruleDecisions: rules })) return null;
  const payload = {
    verdict: facts,
    rule_decisions: rules,
    context: context ? sanitizeReactionContext(context) : null,
  };
  const userPrompt = `REACTION INPUT:\n${JSON.stringify(payload, null, 2)}`;
  return stripFabricatedUnits(await callGemini(buildVerdictReactionSystemPrompt(), userPrompt, timeoutMs));
}

module.exports = {
  isConfigured,
  coachModel,
  pingGemini,
  callGemini,
  stripFabricatedUnits,
  buildCoachSystemPrompt,
  buildCoachUserPrompt,
  sanitizeFacts,
  sanitizeStimulusGrade,
  sanitizeNextMoveAdvisory,
  sanitizeRecoveryAdvisory,
  sanitizeSubstitution,
  sanitizeDeviation,
  sanitizeEvidenceContext,
  sanitizeTrend,
  sanitizeReadinessSignal,
  buildPlanSystemPrompt,
  buildPlanUserPrompt,
  sanitizePlanFacts,
  generateCoachMessage,
  generatePlanMessage,
  buildChatSystemPrompt,
  sanitizeChatContext,
  sanitizeChatHistory,
  sanitizeConstraint,
  generateChatReply,
  parseEditFromReply,
  parseNoteFromReply,
  parseReplyWithProposals,
  isValidPlanEditSchema,
  isValidEditSchema,
  buildCompileSystemPrompt,
  compileSessionFromHistory,
  buildVerdictReactionSystemPrompt,
  sanitizeVerdictFacts,
  sanitizeRuleDecision,
  sanitizeRuleDecisions,
  sanitizeReactionContext,
  isVerdictWorthReacting,
  hasActionableRuleDecision,
  shouldReactToVerdict,
  generateVerdictReaction
};
