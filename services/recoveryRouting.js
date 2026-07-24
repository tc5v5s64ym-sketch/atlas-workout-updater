'use strict';

// Recovery routing for the chat surface (Coach Voice slice 3).
//
// PURE. No I/O, no LLM, no Sheets, no writes. When the lifter SAYS they are tired
// ("I'm wiped", "legs are toast", "exhausted"), Atlas must route on the engine's
// actual recovery/fatigue state — never default to motivation hype ("push through",
// "you got this"). The deterministic engine owns the meaning here, exactly like the
// P0 session-question short-circuits; the LLM never gets to cheerlead a tired lifter.
//
// Two pure pieces:
//   isTirednessExpression(message)        — is the lifter reporting their own fatigue?
//   buildTirednessRecoveryAnswer(signals) — a short, grounded, recovery-routed reply.
//
// Vocabulary overlaps services/trainingGoalClassifier.js (recovery terms) on purpose
// — that classifier routes the PLAN; this one routes the CHAT reply. Both read the
// same kind of "I'm cooked" language; neither invents numbers.

// "tired of …" / "sick of …" is impatience, not training fatigue — never route it.
const IMPATIENCE = /\btired of\b|\bsick (and tired )?of\b/;

// Negation flips the meaning: "I'm not tired", "not feeling tired", "hardly tired"
// must NOT route to a pull-back line (it would contradict the lifter). Allow up to
// two words between the negator and the fatigue term ("not really that tired").
const NEGATED_FATIGUE = /\b(not|never|hardly|barely|no longer|isn'?t|aren'?t|ain'?t|don'?t|wasn'?t)\s+(\w+\s+){0,2}(tired|exhausted|wiped|drained|spent|cooked|wrecked|fatigued|gassed|smoked|fried|knackered|toast|beat)\b/;

// A leading interrogative makes it an analytical question ("why am I always tired
// lately?") — that belongs to the coach, not a canned current-state recovery line.
const LEADING_QUESTION = /^(why|how|what|when|where|which|is|are|am|do|does|did|should|could|would|can|who)\b/;

// Direct fatigue states the lifter reports about themselves.
const FATIGUE_STATE = /(exhausted|wiped(?:\s*out)?|drained|knackered|gassed|smoked|spent|fatigued|shattered|zonked|burn(?:t|ed)\s*out|running on (?:empty|fumes)|(?:no|low|zero)\s+energy|no gas(?:\s+left)?)/;

// Fatigue slang that needs a self/body framing so it doesn't catch unrelated uses
// ("beat my PR", "is the gym dead"). Paired with FRAMING below.
const FATIGUE_SLANG = /(cooked|wrecked|toast|fried|beat(?:en)?\s*up|so done)/;
// Self/body framing words. Beyond first-person and the coarse regions (legs/arms/…)
// this also names specific muscle groups, so muscle-specific fatigue slang routes to
// recovery too ("quads are fried", "hamstrings are toast", "chest is cooked"). The
// slang requirement (FATIGUE_SLANG) still guards against unrelated muscle mentions.
const FRAMING = /\b(i'?m|i am|im|feel(?:ing)?|so|really|pretty|kinda|super|totally|today|legs?|arms?|shoulders?|back|body|everything|completely|absolutely|quads?|hamstrings?|hams|glutes?|calves|calf|chest|pecs?|delts?|traps?|lats?|biceps?|triceps?|forearms?|abs|core)\b/;

// One-word fatigue exclamations.
const BARE = /^(cooked|wrecked|toast|exhausted|drained|spent|knackered|fried|gassed|smoked|wiped)\.?!?$/;

/**
 * Is this message the lifter reporting their own current fatigue? Pure.
 * @param {string} message
 * @returns {boolean}
 */
function isTirednessExpression(message) {
  const t = String(message == null ? '' : message).toLowerCase().trim();
  if (!t) return false;
  if (IMPATIENCE.test(t)) return false;
  // Negation and analytical questions are NOT current-state fatigue reports — both
  // bias toward letting the coach answer rather than canning a recovery line.
  if (NEGATED_FATIGUE.test(t)) return false;
  if (LEADING_QUESTION.test(t)) return false;
  if (BARE.test(t)) return true;
  if (FATIGUE_STATE.test(t)) return true;
  // "tired" as a whole word (the impatience sense is already excluded above).
  if (/\btired\b/.test(t)) return true;
  if (FATIGUE_SLANG.test(t) && FRAMING.test(t)) return true;
  return false;
}

// Read the readiness engine's per-pattern statuses for any flagged fatigued. The
// engine's vocabulary is fatigued|recovering|ready|fresh|unknown (analytics.js
// readinessStatus); only `fatigued` is the "flagged fatigued" state this line names.
function fatiguedPatternNames(readiness) {
  if (!Array.isArray(readiness)) return [];
  return readiness
    .filter(r => r && String(r.status || '').toLowerCase() === 'fatigued')
    .map(r => r.pattern)
    .filter(Boolean);
}

/**
 * The canonical recovery-reason FACTS a tiredness/recovery turn is grounded in — the exact,
 * authoritative signals buildTirednessRecoveryAnswer consumes, extracted once into a small
 * shape suitable for a CoachingDecision's explanation_inputs (Phase 4 H-03). Pure.
 *
 * Only genuinely-present facts are included ("here are the facts you may word"); a signal the
 * reply cannot use is omitted, never null-padded — an outage snapshot with only client readiness
 * yields at most `fatigued_patterns` (honest: nothing else is grounded). Values are carried
 * VERBATIM as the reply reads them (fatigue_status is NOT trimmed — the reply tests
 * `fatigueStatus.status === 'high'` exactly, so trimming could diverge; days_since_last_session is
 * normalized with the SAME `Number()`/finite guard the reply uses; fatigued_patterns is the FULL
 * flagged-pattern list, because the reply words slice(0,2) for names but the full length for the
 * singular/plural boundary). This shape is the single source both the reply worder and the
 * canonical decision read from as Phase 4 wires live consumption.
 *
 * @param {object} signals  same shape buildTirednessRecoveryAnswer takes.
 * @returns {{fatigue_status?: string, days_since_last_session?: number, fatigued_patterns?: string[]}}
 */
function recoveryReasonFacts(signals) {
  const s = signals && typeof signals === 'object' ? signals : {};
  const fs = s.fatigueStatus && typeof s.fatigueStatus === 'object' ? s.fatigueStatus : {};
  const facts = {};
  // Verbatim, present-iff-truthy — never trimmed (the reply compares fs.status exactly).
  if (typeof fs.status === 'string' && fs.status) facts.fatigue_status = fs.status;
  // Same normalization as the reply: null/''/non-finite ⇒ absent (Number(null) is 0 — guard it).
  const d = (s.daysSinceLastSession == null || s.daysSinceLastSession === '') ? NaN : Number(s.daysSinceLastSession);
  if (Number.isFinite(d)) facts.days_since_last_session = d;
  // The full flagged-fatigued pattern list (the reply needs both slice(0,2) and the true length).
  const patterns = fatiguedPatternNames(s.readiness);
  if (patterns.length) facts.fatigued_patterns = patterns;
  return facts;
}

// The SINGLE prose home for the deterministic recovery reply. Takes the canonical recovery-reason
// FACTS (recoveryReasonFacts shape: fatigue_status / days_since_last_session / fatigued_patterns)
// and words the exact reply. Both the route-input path (buildTirednessRecoveryAnswer, via
// recoveryReasonFacts) and the canonical CoachTurnPacket decision path
// (buildTirednessRecoveryAnswerFromDecision, via _recoveryFactsFromDecision) funnel their facts
// through here, so the two can NEVER word the recovery reply differently — the invariant that lets
// the live route consume packet.decision byte-identically as Phase 4 wires it (H-03).
//
// It is a faithful extraction of the prior inline logic: the reasons are built in the SAME order
// (elevated → back-to-back → fatigued patterns), the "because" clause takes the first two reasons,
// the recovered branch is reached only with a real day count ≥ 3 at a normal fatigue status, and
// the fallback never invents a number or hypes. Because recoveryReasonFacts carries every value
// VERBATIM as the reply reads it (fatigue_status untrimmed; the day count already Number()-normalized;
// the full fatigued-pattern list), reading the facts here reproduces the original byte-for-byte.
function _wordRecovery(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const elevated = f.fatigue_status === 'high';
  // recoveryReasonFacts already applied the reply's Number()/finite guard, so a present
  // days_since_last_session is a finite number; absent ⇒ no day-count reasons.
  const hasD = typeof f.days_since_last_session === 'number' && Number.isFinite(f.days_since_last_session);
  const d = hasD ? f.days_since_last_session : NaN;
  const backToBack = hasD && d <= 1;
  const patterns = Array.isArray(f.fatigued_patterns) ? f.fatigued_patterns : [];

  const reasons = [];
  if (elevated) reasons.push('your last 7 days are well above your usual volume');
  if (backToBack) reasons.push(d === 0 ? 'you already trained today' : 'you trained yesterday');
  if (patterns.length) {
    reasons.push(`your ${patterns.slice(0, 2).join(' and ')} ${patterns.length > 1 ? 'patterns are' : 'pattern is'} already flagged fatigued`);
  }

  if (reasons.length) {
    const because = reasons.slice(0, 2).join(', and ');
    return `Makes sense — ${because}. Today's a pull-back, not a grind: go lighter, leave 3–4 reps in reserve, or take the rest day. Recovery is where the work actually sticks.`;
  }

  // Logs look recovered — say so honestly, still no pressure to grind.
  if (hasD && d >= 3 && f.fatigue_status === 'normal') {
    return `Your logs actually look recovered — it's been ${d} days since your last session and your volume's in a normal range. If you're still flat, trust that and keep it easy: a short technique session or a rest day both beat forcing it.`;
  }

  // No strong signal either way (or no history yet): safe recovery routing, no numbers.
  return `Then don't force it. A lighter session or a full rest day both beat grinding through fatigue — recovery is when the training pays off. If you do train, leave more in reserve than usual and stop while it still feels clean.`;
}

/**
 * Build a short, deterministic, recovery-routed reply for a tired lifter from the ROUTE-LOCAL
 * signals — extract the canonical reason facts (recoveryReasonFacts) and word them through the
 * shared worder. Grounds in the engine's real signals; invents no lift-specific numbers; never
 * hypes. This is the EXISTING behavior, unchanged.
 *
 * @param {object} signals
 * @param {object|null} signals.fatigueStatus         - computeFatigueStatus() output ({status,...}).
 * @param {Array|null}  signals.readiness             - [{pattern,status,detail}] readiness snapshot.
 * @param {number|null} signals.daysSinceLastSession  - days since the last logged session.
 * @returns {string} a recovery-routed reply (always non-empty).
 */
function buildTirednessRecoveryAnswer(signals) {
  return _wordRecovery(recoveryReasonFacts(signals));
}

// Extract the recovery reason facts from a canonical CoachTurnPacket decision's explanation_inputs
// (services/coachDecisionSnapshot.js buildRecoveryDecision → recoveryReasonFacts). The key names
// mirror recoveryReasonFacts's output exactly, so for a decision built from route signals the facts
// round-trip and the reply is byte-identical. Defensive: only well-typed facts are read; anything
// missing/malformed is dropped (the worder then degrades to the safe fallback, never a fabrication).
function _recoveryFactsFromDecision(decision) {
  const d = decision && typeof decision === 'object' ? decision : {};
  const ei = d.explanation_inputs && typeof d.explanation_inputs === 'object' ? d.explanation_inputs : {};
  const facts = {};
  if (typeof ei.fatigue_status === 'string' && ei.fatigue_status) facts.fatigue_status = ei.fatigue_status;
  if (typeof ei.days_since_last_session === 'number' && Number.isFinite(ei.days_since_last_session)) facts.days_since_last_session = ei.days_since_last_session;
  if (Array.isArray(ei.fatigued_patterns) && ei.fatigued_patterns.length) facts.fatigued_patterns = ei.fatigued_patterns;
  return facts;
}

/**
 * Build the SAME recovery reply from a canonical CoachTurnPacket decision (the recovery decision's
 * explanation_inputs) instead of the route-local signals — the bridge that lets the live route word
 * the recovery reply from packet.decision (Phase 4 H-03 live consumption, PR 3). Funnels through the
 * SAME worder, so for a decision built from signals the output is byte-identical to
 * buildTirednessRecoveryAnswer of those signals. Falls back to the safe no-numbers routing when the
 * decision carries no recovery facts.
 *
 * @param {object} decision  a canonical `recovery` CoachingDecision.
 * @returns {string} a recovery-routed reply (always non-empty).
 */
function buildTirednessRecoveryAnswerFromDecision(decision) {
  return _wordRecovery(_recoveryFactsFromDecision(decision));
}

module.exports = {
  isTirednessExpression,
  buildTirednessRecoveryAnswer,
  buildTirednessRecoveryAnswerFromDecision,
  recoveryReasonFacts,
};
