'use strict';

// Soul Plan PR-B1 — coaching-mode enum golden tests.
//
// Pins: (1) the frozen COACH_MODES vocabulary; (2) every mode reachable from a
// realistic fact shape; (3) the precedence ladder
// safety > refuse > correct > challenge > reassure > celebrate > praise >
// educate > note > nod > silent (table-driven); (4) the crown jewel — a clean
// met set with no rule raised maps to silent (cross-referenced to the
// verdict-reaction gate: `met` never breaks silence); (5) totality — unknown /
// empty / garbage facts return silent, never throw; (6) evidence echoes the
// exact fact fields that justified the mode.

const test = require('node:test');
const assert = require('node:assert/strict');

const { COACH_MODES, selectCoachMode } = require('../services/coachMode');
const { TIERS, TRIGGERS } = require('../services/coachNoteTier');

test('COACH_MODES is the frozen 11-mode vocabulary', () => {
  assert.deepEqual(COACH_MODES, [
    'silent', 'nod', 'note', 'praise', 'celebrate',
    'correct', 'challenge', 'reassure', 'educate', 'refuse', 'safety',
  ]);
  assert.ok(Object.isFrozen(COACH_MODES));
  assert.ok(Object.isFrozen(require('../services/coachMode')));
});

// ── Every mode reachable from a realistic fact shape ──────────────────────────

const REALISTIC = {
  safety:    { facts: { note_trigger: TRIGGERS.FORM_SAFETY, note_tier: TIERS.EXTENDED } },
  refuse:    { facts: { rule_decisions: [{ decision: 'reject', severity: 'error', rule_id: 'load_sanity' }] } },
  correct:   { facts: { rule_decisions: [{ decision: 'caution', severity: 'warning', rule_id: 'rir_caution' }] } },
  challenge: { facts: { memory_patterns: [{ liftCode: 'BEN01', patterns: [{ type: 'consistent_underperformance' }] }] } },
  reassure:  { facts: { layoff: { returning_from_layoff: true, severity: 'moderate' } } },
  celebrate: { facts: { progression_verdict: { level: 'new_ground' } } },
  praise:    { facts: { verdict: { outcome: 'beat', why: 'beat target reps' } } },
  educate:   { facts: { sme_context: true } },
  note:      { facts: { note_tier: TIERS.EXTENDED, note_trigger: TRIGGERS.PLAN_CHANGE } },
  nod:       { facts: { substitution: { decision: 'approve', classification: 'preserved' } } },
  silent:    { facts: { verdict: { outcome: 'met' } } },
};

for (const [mode, { facts }] of Object.entries(REALISTIC)) {
  test(`mode reachable: ${mode}`, () => {
    const out = selectCoachMode(facts);
    assert.equal(out.mode, mode);
    assert.ok(out.evidence && typeof out.evidence === 'object', 'evidence object required');
  });
}

// ── Precedence ladder, table-driven: higher always wins when both present ─────

const LADDER = ['safety', 'refuse', 'correct', 'challenge', 'reassure', 'celebrate', 'praise', 'educate', 'note', 'nod', 'silent'];

test('precedence: each mode beats every mode below it', () => {
  for (let hi = 0; hi < LADDER.length - 1; hi++) {
    for (let lo = hi + 1; lo < LADDER.length; lo++) {
      const combined = { ...REALISTIC[LADDER[lo]].facts, ...REALISTIC[LADDER[hi]].facts };
      const out = selectCoachMode(combined);
      assert.equal(out.mode, LADDER[hi],
        `${LADDER[hi]} facts + ${LADDER[lo]} facts must resolve to ${LADDER[hi]}, got ${out.mode}`);
    }
  }
});

test('precedence: pain trigger overrides an on-plan celebration (safety fires even when verdicts look good)', () => {
  const out = selectCoachMode({
    note_trigger: TRIGGERS.PAIN_INJURY,
    progression_verdict: { level: 'new_ground' },
    verdict: { outcome: 'beat' },
  });
  assert.equal(out.mode, 'safety');
  assert.deepEqual(out.evidence, { note_trigger: TRIGGERS.PAIN_INJURY });
});

// ── Scarcity input (PR-B3 arrives later; optional param, default clear) ───────

test('celebrate requires scarcity clear; a spent budget downgrades to praise', () => {
  const facts = { progression_verdict: { level: 'new_ground' } };
  assert.equal(selectCoachMode(facts).mode, 'celebrate', 'default scarcity is clear');
  assert.equal(selectCoachMode(facts, { scarcityClear: true }).mode, 'celebrate');
  const spent = selectCoachMode(facts, { scarcityClear: false });
  assert.equal(spent.mode, 'praise', 'no celebration when the budget is spent');
  assert.equal(spent.evidence.scarcity_clear, false);
});

// ── Rule-decision nuance: routine info-level hold/load never refuses ──────────

test('a routine info-level hold/load is a quiet progression call, not a refusal', () => {
  // Mirrors the note-tier silence gate (services/coachNoteTier.js): info-level
  // progression decisions never break silence — so they must not manufacture a
  // refuse mode.
  assert.equal(selectCoachMode({ rule_decisions: [{ decision: 'hold', severity: 'info' }] }).mode, 'silent');
  assert.equal(selectCoachMode({ rule_decisions: [{ decision: 'load', severity: 'info' }] }).mode, 'silent');
  // A hold that carries real severity DOES refuse.
  assert.equal(selectCoachMode({ rule_decisions: [{ decision: 'hold', severity: 'warning' }] }).mode, 'refuse');
  assert.equal(selectCoachMode({ rule_decisions: [{ decision: 'reject', severity: 'info' }] }).mode, 'refuse',
    'reject refuses at any severity');
});

// ── Correct-mode inputs ────────────────────────────────────────────────────────

test('correct fires on fell_short, far_easy, warn-grade substitution, and regression', () => {
  assert.equal(selectCoachMode({ verdict: { outcome: 'fell_short' } }).mode, 'correct');
  assert.equal(selectCoachMode({ effort_verdict: { level: 'far_easy' } }).mode, 'correct');
  assert.equal(selectCoachMode({ substitution: { decision: 'warn' } }).mode, 'correct');
  assert.equal(selectCoachMode({ note_trigger: TRIGGERS.REGRESSION, note_tier: TIERS.EXTENDED }).mode, 'correct');
});

// ── The crown jewel + totality ────────────────────────────────────────────────

test('crown jewel: a clean met set with no rule raised is SILENT', () => {
  // A clean met set is the quiet default across the engine — the note-tier gate
  // maps it to ack_only (silent); the mode enum must agree.
  const out = selectCoachMode({
    verdict: { outcome: 'met' },
    effort_verdict: { level: 'on_target' },
    progression_verdict: { level: 'in_pocket' },
    note_tier: TIERS.ACK_ONLY,
    rule_decisions: [],
  });
  assert.equal(out.mode, 'silent');
  assert.deepEqual(out.evidence, {});
});

test('totality: unknown/empty/garbage facts → silent, never a throw', () => {
  for (const garbage of [undefined, null, 42, 'facts', [], {}, { unknown_key: true },
    { rule_decisions: 'nope' }, { verdict: 'beat' }, { memory_patterns: [{}] },
    { note_trigger: 'made_up_trigger' }, { layoff: { returning_from_layoff: 'yes' } }]) {
    const out = selectCoachMode(garbage);
    assert.equal(out.mode, 'silent', `garbage ${JSON.stringify(garbage)} must be silent`);
  }
});

// ── Evidence is key-aware: it echoes the exact justifying fields ──────────────

test('evidence echoes the justifying fact fields', () => {
  assert.deepEqual(selectCoachMode(REALISTIC.refuse.facts).evidence,
    { rule_decision: { decision: 'reject', severity: 'error', rule_id: 'load_sanity' } });
  assert.deepEqual(selectCoachMode(REALISTIC.praise.facts).evidence, { verdict_outcome: 'beat' });
  assert.deepEqual(selectCoachMode(REALISTIC.reassure.facts).evidence, { returning_from_layoff: true });
  assert.deepEqual(selectCoachMode(REALISTIC.note.facts).evidence, { note_trigger: TRIGGERS.PLAN_CHANGE });
});

// ── Nod: brief acknowledgments ────────────────────────────────────────────────

test('nod: an approved pivot or a swap verdict is a brief acknowledgment', () => {
  assert.equal(selectCoachMode({ substitution: { decision: 'approve' } }).mode, 'nod');
  assert.equal(selectCoachMode({ verdict: { outcome: 'swap' } }).mode, 'nod');
});

// ── Reassure: explicit discouragement trigger (Soul Plan B5b Part 2) ───────────

test('reassure: an explicit discouragement signal maps to reassure', () => {
  assert.equal(selectCoachMode({ discouraged: true }).mode, 'reassure');
  assert.deepEqual(selectCoachMode({ discouraged: true }).evidence, { discouraged: true });
  // layoff-return still reassures too.
  assert.equal(selectCoachMode({ layoff: { returning_from_layoff: true } }).mode, 'reassure');
});

test('reassure precedence: safety/refuse outrank discouragement; discouragement outranks challenge (Owner Decision 1)', () => {
  // safety (pain/form) beats reassure — discouragement was NOT moved above safety.
  assert.equal(selectCoachMode({ discouraged: true, note_trigger: TRIGGERS.FORM_SAFETY }).mode, 'safety');
  // Owner Decision 1 (LT-011): explicit discouragement now overrides a standing
  // consistent_underperformance challenge pattern — for that message only.
  assert.equal(selectCoachMode({
    discouraged: true,
    memory_patterns: [{ liftCode: 'BEN01', patterns: [{ type: 'consistent_underperformance' }] }],
  }).mode, 'reassure');
  // …but with no discouragement the same standing pattern still challenges.
  assert.equal(selectCoachMode({
    memory_patterns: [{ liftCode: 'BEN01', patterns: [{ type: 'consistent_underperformance' }] }],
  }).mode, 'challenge');
  // a reject rule still refuses (refuse/correct stay above discouragement).
  assert.equal(selectCoachMode({ discouraged: true, rule_decisions: [{ decision: 'reject' }] }).mode, 'refuse');
  // the layoff-return reassure was NOT promoted: a standing challenge still beats it.
  assert.equal(selectCoachMode({
    layoff: { returning_from_layoff: true },
    memory_patterns: [{ liftCode: 'BEN01', patterns: [{ type: 'consistent_underperformance' }] }],
  }).mode, 'challenge');
});
