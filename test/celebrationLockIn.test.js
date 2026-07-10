'use strict';

// Soul Plan PR-A4 — AC8 rule (c) lock-in: NEVER celebrate a set that wasn't
// actually logged.
//
// A guard-test sweep over every path that can emit celebratory / praising /
// completion copy (path inventory in the PR body). For each path, these tests
// pin that NO praise, celebration, or PR-language output is possible when the
// triggering input is: a suppressed question intent, a needs_clarification /
// unresolved result, a conversation-only (unsaved) set, or an empty
// session_tally — and that the earned cases (a real engine verdict from a real
// logged set) still fire, so the gates can't be "fixed" by muting everything.
//
// These are regression locks: every celebratory sentence Part B of the Soul
// Plan will ever write stands on the guarantees pinned here. If a change makes
// one of these fail, a celebration became reachable without a genuinely logged
// set — do not weaken the test; fix the gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isVerdictWorthReacting,
  hasActionableRuleDecision,
  shouldReactToVerdict,
  sanitizeVerdictFacts,
  sanitizeChatContext,
  buildCoachSystemPrompt,
  buildChatSystemPrompt,
  buildVerdictReactionSystemPrompt,
} = require('../services/coach');
const { classifyNoteTier, TIERS, TRIGGERS } = require('../services/coachNoteTier');
const { assembleBatchNoteFacts } = require('../services/batchNoteFacts');
const { renderSetVoice, findForbiddenContradictions } = require('../services/coachVoiceRenderer');
const { EFFORT_REASON_CODES } = require('../services/setEffortSignals');
const { computeCloseout } = require('../services/sessionCloseout');

// Celebration vocabulary that must never appear ungated. Used for source scans
// of the deterministic renderers (which own copy verbatim, unlike the LLM paths
// where the prompt is the gate).
const CELEBRATION_RE = /personal best|new pr\b|new record|crushed it|crushing it|beast mode|congrats|congratulations|🎉|💪/i;

// ── 1. Verdict-reaction gate (services/coach.js) ──────────────────────────────

test('AC8(c) verdict gate: no reaction without a real verdict from a logged set', () => {
  assert.equal(shouldReactToVerdict(), false, 'no input → silence');
  assert.equal(shouldReactToVerdict({}), false, 'empty input → silence');
  assert.equal(shouldReactToVerdict({ verdict: null, ruleDecisions: [] }), false);
  assert.equal(isVerdictWorthReacting(null), false);
  assert.equal(isVerdictWorthReacting({ outcome: 'met' }), false, 'a routine met set stays quiet');
  assert.equal(isVerdictWorthReacting({ outcome: 'celebrate' }), false, 'unknown outcomes never react');
  assert.equal(hasActionableRuleDecision([]), false);
  assert.equal(hasActionableRuleDecision([{ severity: 'info', decision: 'load' }]), false,
    'a routine info-level progression call does not break silence');
});

test('AC8(c) verdict gate: a fabricated/clarification-shaped verdict is dropped by sanitization', () => {
  // needs_clarification / unresolved results never produce a verdict object with a
  // known outcome — and anything outside the frozen vocabulary sanitizes to null,
  // so generateVerdictReaction returns null before any prompt is built.
  assert.equal(sanitizeVerdictFacts({ outcome: 'needs_clarification' }), null);
  assert.equal(sanitizeVerdictFacts({ outcome: 'question' }), null);
  assert.equal(sanitizeVerdictFacts({ outcome: '' }), null);
  assert.equal(sanitizeVerdictFacts('beat'), null, 'non-object input is dropped');
  // Control: the earned case still stands.
  const beat = sanitizeVerdictFacts({ outcome: 'beat', why: 'beat target reps' });
  assert.equal(beat.outcome, 'beat');
  assert.equal(shouldReactToVerdict({ verdict: beat, ruleDecisions: [] }), true);
});

// ── 2. Note-tier gates (coachNoteTier + batchNoteFacts) ───────────────────────

test('AC8(c) note tier: PR/praise tiers fire ONLY on engine-computed signals', () => {
  // PR language requires the engine's new_ground — a best_weight or hype flag
  // from anywhere else never reaches PR_MILESTONE.
  const pr = classifyNoteTier({ progression_verdict: { level: 'new_ground' } });
  assert.equal(pr.trigger, TRIGGERS.PR_MILESTONE, 'control: earned new_ground still fires');
  assert.equal(classifyNoteTier({ progression_verdict: { level: 'progressing' } }).tier, TIERS.ACK_ONLY,
    'merely progressing is a receipt, not praise');
  assert.equal(classifyNoteTier({ progression_verdict: { level: 'in_pocket' } }).tier, TIERS.ACK_ONLY);
  assert.equal(classifyNoteTier({ effort_verdict: { level: 'on_target' } }).tier, TIERS.ACK_ONLY,
    'an on-target set is not a coaching-note occasion');
  assert.equal(classifyNoteTier({ unexpected_excellence: 'yes' }).tier, TIERS.ACK_ONLY,
    'unexpected_excellence must be the boolean true from the engine, not a truthy client value');
  assert.equal(classifyNoteTier(null).tier, TIERS.ACK_ONLY, 'garbage input degrades to receipt-only');
  assert.equal(classifyNoteTier({ best_weight: 500 }).tier, TIERS.ACK_ONLY,
    'a bare best_weight never manufactures a milestone');
});

test('AC8(c) note tier: a block with no logged sets can never produce a note', () => {
  assert.equal(assembleBatchNoteFacts({ exerciseName: 'Bench Press', sets: [] }), null);
  assert.equal(assembleBatchNoteFacts({ exerciseName: 'Bench Press' }), null);
  assert.equal(assembleBatchNoteFacts(null), null);
});

// ── 3. Deterministic renderers ────────────────────────────────────────────────

test('AC8(c) renderer: no praise line without an engine verdict; hype stripped on HOLD signals', () => {
  const neutral = renderSetVoice({});
  assert.equal(neutral.primary_line, null, 'no analysis, no verdict → no line at all');

  // The contradiction guard strips celebratory prose whenever the engine said HOLD.
  const hits = findForbiddenContradictions(
    [EFFORT_REASON_CODES.REDLINE_SET],
    'Crushed it — keep pushing, new PR incoming!'
  );
  assert.ok(hits.length > 0, 'progression hype over a redline must be flagged for suppression');

  // No reason codes → nothing to contradict (the guard is signal-driven, not a censor).
  assert.deepEqual(findForbiddenContradictions([], 'Crushed it!'), []);
});

test('AC8(c) renderer: the LLM-down fallback renderer owns zero celebration vocabulary', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'deterministicCoachRenderer.js'), 'utf8');
  assert.ok(!CELEBRATION_RE.test(src),
    'deterministicCoachRenderer must carry no PR/celebration copy — its most positive copy is the earned progress handoff');
});

// ── 4. Client copy gates (src/app/coach-conversation.js, source pins) ─────────

const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'coach-conversation.js'), 'utf8');

test('AC8(c) client: the opener praises only from the engine effort verdict or real logged weights', () => {
  // coachOpener leads with rec.effort_verdict (engine-owned, from a logged set)…
  assert.match(clientSrc, /const verdict = rec && rec\.effort_verdict;/,
    'the opener must read the engine effort verdict, never invent a read');
  // …and its step-up praise is gated on a literal numeric comparison of logged weights.
  assert.match(clientSrc, /lastTop != null && topWeight > lastTop\) return `Nice — that's a step up on your last session/,
    'the step-up line must require topWeight > lastTop from real sets');
  // With no history at all the opener is a plain receipt, not praise.
  assert.ok(clientSrc.includes("Logged. That sets your baseline"),
    'the no-history opener is a receipt, never manufactured praise');
});

test('AC8(c) client: closeout copy requires a genuinely complete plan and never declares the session over', () => {
  assert.match(clientSrc, /if \(!nextEx && detail\.planIsComplete\) \{\s*\n\s*if \(!closeoutAnnounced\)/,
    'closeout renders only when every planned exercise is logged, once');
  assert.ok(clientSrc.includes("That's your planned work done"),
    'closeout copy is the planned-work-done wording — never a "session over" declaration (G3)');
});

test('AC8(c) client: persistence praise ("Saved") appears only in the review-save path', () => {
  const matches = clientSrc.match(/Saved to your sheet/g) || [];
  assert.equal(matches.length, 1, 'exactly one saved-confirmation copy site');
  assert.match(clientSrc, /rv-saved-txt', '✓ Saved to your sheet'/,
    'the saved confirmation lives in the review-card saved renderer, gated on a real write');
});

// ── 5. LLM prompt gates (reasserted alongside — the two existing iron gates) ──

test('AC8(c) prompts: PR language requires new_ground (set-reaction iron rule reasserted)', () => {
  const prompt = buildCoachSystemPrompt();
  assert.ok(prompt.includes('ONLY allowed when `progression_verdict.level` is exactly `new_ground`'));
  assert.ok(prompt.includes('does NOT authorize PR language'),
    'a best_weight value alone must not authorize PR language');
});

test('AC8(c) prompts: celebration requires an earned beat (verdict-reaction rule reasserted)', () => {
  const prompt = buildVerdictReactionSystemPrompt();
  assert.match(prompt, /Celebrate ONLY when it is earned/i);
  assert.match(prompt, /overrides any "beat" or celebration/i, 'pain overrides any celebration');
});

test('AC8(c) prompts: completion praise requires plan_state.isComplete (chat COMPLETION-CLAIM reasserted)', () => {
  const prompt = buildChatSystemPrompt();
  assert.ok(prompt.includes('UNLESS `plan_state.isComplete` is true'),
    'an "I\'m done" declaration must not earn completion praise on an incomplete plan');
  assert.match(prompt, /never manufacture 'great session', 'you crushed it'/,
    'manufactured completion praise is named and banned');
  assert.match(prompt, /do NOT call it "logged", "saved", "recorded", or "stored"/,
    'conversation-only sets must never be described as persisted');
});

// ── 6. Empty session_tally: nothing logged → no tally fact to praise from ─────

test('AC8(c) tally: an empty session_tally sanitizes to null, so in-session praise has no data', () => {
  assert.equal(sanitizeChatContext({ session_tally: { exercises: [] } }).session_tally, null);
  assert.equal(sanitizeChatContext({ session_tally: {} }).session_tally, null);
  assert.equal(sanitizeChatContext({}).session_tally, null);
  // Control: a real logged tally survives.
  const real = sanitizeChatContext({
    session_tally: { exercises: [{ exercise: 'Bench Press', sets: 3, per_set: [], planned: true }], total_working_sets: 3 }
  });
  assert.equal(real.session_tally.exercises[0].exercise, 'Bench Press');
});

// ── 7. Closeout engine: completeness cannot be claimed early ──────────────────

test('AC8(c) closeout: computeCloseout returns null unless every planned exercise is logged', () => {
  assert.equal(computeCloseout(['Bench Press', 'Seated Row'], ['Bench Press']), null,
    'a partial session never produces a closeout payload');
  assert.equal(computeCloseout([], []), null, 'no plan → nothing to close out');
  const done = computeCloseout(['Bench Press', 'Seated Row'], ['Bench Press', 'Seated Row']);
  assert.ok(done && done.isComplete === true, 'control: a genuinely complete plan closes out');
});
