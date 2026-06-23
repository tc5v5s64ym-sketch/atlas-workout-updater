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
const FRAMING = /\b(i'?m|i am|im|feel(?:ing)?|so|really|pretty|kinda|super|totally|today|legs?|arms?|shoulders?|back|body|everything|completely|absolutely)\b/;

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

// Read the readiness engine's per-pattern statuses for any flagged as fatigued.
function fatiguedPatternNames(readiness) {
  if (!Array.isArray(readiness)) return [];
  return readiness
    .filter(r => r && /fatigued|caution|red|low/i.test(String(r.status || '')))
    .map(r => r.pattern)
    .filter(Boolean);
}

/**
 * Build a short, deterministic, recovery-routed reply for a tired lifter. Grounds
 * in the engine's real signals; invents no lift-specific numbers; never hypes.
 *
 * @param {object} signals
 * @param {object|null} signals.fatigueStatus         - computeFatigueStatus() output ({status,...}).
 * @param {Array|null}  signals.readiness             - [{pattern,status,detail}] readiness snapshot.
 * @param {number|null} signals.daysSinceLastSession  - days since the last logged session.
 * @returns {string} a recovery-routed reply (always non-empty).
 */
function buildTirednessRecoveryAnswer({ fatigueStatus = null, readiness = null, daysSinceLastSession = null } = {}) {
  const fs = fatigueStatus && typeof fatigueStatus === 'object' ? fatigueStatus : {};
  const elevated = fs.status === 'high';
  // Guard null/undefined/'' explicitly — Number(null) is 0, which would wrongly
  // read as "trained today". Only a real numeric day count counts.
  const d = (daysSinceLastSession == null || daysSinceLastSession === '') ? NaN : Number(daysSinceLastSession);
  const backToBack = Number.isFinite(d) && d <= 1;
  const patterns = fatiguedPatternNames(readiness);

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
  if (Number.isFinite(d) && d >= 3 && fs.status === 'normal') {
    return `Your logs actually look recovered — it's been ${d} days since your last session and your volume's in a normal range. If you're still flat, trust that and keep it easy: a short technique session or a rest day both beat forcing it.`;
  }

  // No strong signal either way (or no history yet): safe recovery routing, no numbers.
  return `Then don't force it. A lighter session or a full rest day both beat grinding through fatigue — recovery is when the training pays off. If you do train, leave more in reserve than usual and stop while it still feels clean.`;
}

module.exports = { isTirednessExpression, buildTirednessRecoveryAnswer };
