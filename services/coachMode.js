'use strict';

// ── Coaching-mode enum (Soul Plan PR-B1) ─────────────────────────────────────
//
// One name, in one place, for "when the coach speaks and in what spirit."
// Today that decision is real but implicit — scattered across note tiers,
// verdict outcomes, rule decisions, and triggers. This module gives every
// coaching moment an engine-decided MODE so the model never chooses how a
// moment is framed; downstream (PR-B2/B4) the mode drives register/permissions.
//
// PURE + UNWIRED: no I/O, no LLM, no route, no wiring in this PR. Total —
// every input (including garbage) returns a valid { mode, evidence }.
//
// selectCoachMode maps EXISTING deterministic triggers onto the enum — it adds
// no new detection logic. Sources it reads (all already engine-computed):
//   - facts.note_trigger / facts.note_tier   (services/coachNoteTier.js)
//   - facts.rule_decisions[]                 (rules/ruleTypes.js shapes)
//   - facts.verdict.outcome                  (beat|met|fell_short|swap)
//   - facts.effort_verdict.level / facts.progression_verdict.level
//   - facts.substitution.decision            (approve|warn)
//   - facts.memory_patterns[*].patterns[*].type (services/coachMemory.js)
//   - facts.layoff.returning_from_layoff     (services/layoffGuard.js)
//   - facts.sme_context                      (an /api/coach/ask-class education ask)
//   - opts.scarcityClear                     (PR-B3 supplies it; defaults true)
//
// Precedence (highest first), pinned by table-driven tests:
//   safety > refuse > correct > reassure(explicit discouragement) > challenge
//     > reassure(layoff-return) > celebrate > praise > educate > note > nod > silent
//
// `reassure` has TWO triggers at DIFFERENT precedence (Owner Decision 1 / LT-011):
// an EXPLICIT discouragement message this turn outranks a standing `challenge`
// pattern (message-scoped, never clears the pattern; safety/refuse/correct and the
// route-level recovery read still sit above it), while the softer layoff-return
// reassure stays BELOW challenge. The single-word ladder above collapses these two
// to "challenge > reassure" for the layoff case the ladder tests exercise.
//
// Mapping notes (documented deviations, smallest-derivable readings):
//   - Both PAIN_INJURY and FORM_SAFETY note triggers map to `safety` — pain is
//     the highest-precedence safety class everywhere else in the engine.
//   - `refuse` = a rule decision of `reject` (any severity), or a `hold` that
//     carries warning/error severity. A routine info-level `hold`/`load` is a
//     quiet progression call and does NOT refuse — mirroring the note-tier
//     silence gate (services/coachNoteTier.js), where info-level progression
//     decisions never break silence.
//   - `new_ground` celebrates only when scarcity is clear (PR-B3); when the
//     celebration budget is spent it downgrades to `praise` — big reactions
//     stay rare because rarity is the feature.
//   - UNEXPECTED_EXCELLENCE / PLAN_CHANGE / LOW_CONFIDENCE / USER_ASKED_WHY
//     note triggers are note-worthy but not celebratory → `note`.
//   - An approved substitution (good pivot) or a `swap` verdict is a brief
//     acknowledgment → `nod`.
//   - A clean met set with no rule raised → `silent` (the crown jewel —
//     cross-referenced to the verdict-reaction gate semantics).

const { TIERS, TRIGGERS } = require('./coachNoteTier');

const COACH_MODES = Object.freeze([
  'silent', 'nod', 'note', 'praise', 'celebrate',
  'correct', 'challenge', 'reassure', 'educate', 'refuse', 'safety',
]);

function _levelOf(v) {
  return v && typeof v === 'object' && typeof v.level === 'string' ? v.level : null;
}

function _hasMemoryPattern(memoryPatterns, type) {
  if (!Array.isArray(memoryPatterns)) return false;
  return memoryPatterns.some(item => item && Array.isArray(item.patterns)
    && item.patterns.some(p => p && p.type === type));
}

function selectCoachMode(facts, opts = {}) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const scarcityClear = opts.scarcityClear !== false; // PR-B3 input; default clear
  const pick = (mode, evidence) => ({ mode, evidence });

  // 1. safety — highest precedence; fires even when every verdict looks on-plan
  //    (the tested coachNoteTier behavior: pain/form pre-empt everything).
  if (f.note_trigger === TRIGGERS.FORM_SAFETY || f.note_trigger === TRIGGERS.PAIN_INJURY) {
    return pick('safety', { note_trigger: f.note_trigger });
  }

  const rules = Array.isArray(f.rule_decisions) ? f.rule_decisions.filter(d => d && typeof d === 'object') : [];

  // 2. refuse — the engine rejected the move (or held it with real severity).
  const refusing = rules.find(d => d.decision === 'reject'
    || (d.decision === 'hold' && (d.severity === 'warning' || d.severity === 'error')));
  if (refusing) {
    return pick('refuse', { rule_decision: { decision: refusing.decision, severity: refusing.severity ?? null, rule_id: refusing.rule_id ?? null } });
  }

  // 3. correct — a caution rule, an under-target read, or a warn-grade swap.
  const caution = rules.find(d => d.decision === 'caution');
  if (caution) {
    return pick('correct', { rule_decision: { decision: 'caution', severity: caution.severity ?? null, rule_id: caution.rule_id ?? null } });
  }
  if (f.verdict && f.verdict.outcome === 'fell_short') {
    return pick('correct', { verdict_outcome: 'fell_short' });
  }
  if (_levelOf(f.effort_verdict) === 'far_easy') {
    return pick('correct', { effort_verdict: 'far_easy' });
  }
  if (f.substitution && f.substitution.decision === 'warn') {
    return pick('correct', { substitution_decision: 'warn' });
  }
  if (f.note_trigger === TRIGGERS.REGRESSION) {
    return pick('correct', { note_trigger: f.note_trigger });
  }

  // 4. reassure (explicit discouragement) — an EXPLICIT discouragement/frustration
  //    message this turn (services/discouragementSignal.detectDiscouragement) selects
  //    reassurance OVER a standing challenge pattern — Owner Decision 1 (LT-011):
  //    "Explicit discouragement overrides a standing challenge pattern for that
  //    message only. Safety and recovery remain higher precedence." Placement is
  //    deliberate and narrow: only ABOVE challenge, still BELOW safety/refuse/correct
  //    — and the chat route resolves tiredness/recovery before the LLM — so a genuinely
  //    unsafe, rejected, or tired moment is never softened into reassurance. The signal
  //    is message-scoped (recomputed per turn) and never clears the standing pattern,
  //    so the next ordinary turn challenges again. The layoff-return reassure below is
  //    UNCHANGED — it stays below challenge (only this explicit-message trigger moved).
  if (f.discouraged === true) {
    return pick('reassure', { discouraged: true });
  }

  // 5. challenge — a detected recurring underperformance pattern, or sandbagging.
  if (_hasMemoryPattern(f.memory_patterns, 'consistent_underperformance')) {
    return pick('challenge', { memory_pattern: 'consistent_underperformance' });
  }
  if (f.note_trigger === TRIGGERS.CHALLENGE_SANDBAG) {
    return pick('challenge', { note_trigger: f.note_trigger });
  }

  // 6. reassure (returning after a layoff) — a softer, lower-precedence reassure than
  //    an explicit discouragement message: a standing challenge pattern still outranks
  //    it (only the explicit-message trigger above was promoted past challenge).
  if (f.layoff && typeof f.layoff === 'object' && f.layoff.returning_from_layoff === true) {
    return pick('reassure', { returning_from_layoff: true });
  }

  // 6/7. celebrate / praise — new ground celebrates ONLY when scarcity is clear;
  //      a spent celebration budget downgrades to praise. An earned beat praises.
  if (_levelOf(f.progression_verdict) === 'new_ground') {
    return scarcityClear
      ? pick('celebrate', { progression_verdict: 'new_ground', scarcity_clear: true })
      : pick('praise', { progression_verdict: 'new_ground', scarcity_clear: false });
  }
  if (f.verdict && f.verdict.outcome === 'beat') {
    return pick('praise', { verdict_outcome: 'beat' });
  }

  // 8. educate — an SME-class training-knowledge ask, not a session moment.
  if (f.sme_context === true) {
    return pick('educate', { sme_context: true });
  }

  // 9. note — remaining note-worthy tiers (coachNoteTier said "extended" for a
  //    trigger not already claimed above: plan change, low confidence, explicit
  //    why, unexpected excellence).
  if (f.note_tier === TIERS.EXTENDED && f.note_trigger) {
    return pick('note', { note_trigger: f.note_trigger });
  }

  // 10. nod — a brief acknowledgment: an approved pivot or a swap verdict.
  if (f.substitution && f.substitution.decision === 'approve') {
    return pick('nod', { substitution_decision: 'approve' });
  }
  if (f.verdict && f.verdict.outcome === 'swap') {
    return pick('nod', { verdict_outcome: 'swap' });
  }

  // 11. silent — ack_only tiers, a clean met set with no rule raised, and every
  //     unknown/empty/garbage shape. Never a throw; silence is the safe floor.
  return pick('silent', {});
}

module.exports = Object.freeze({ COACH_MODES, selectCoachMode });
