'use strict';

// ── Owner Decision 1 (LT-011) — explicit discouragement overrides a standing
//    challenge pattern for THAT MESSAGE ONLY ──────────────────────────────────
//
// Owner verdict (docs/TEST_QUEUE.md LT-011):
//   "Explicit discouragement overrides a standing challenge pattern for that
//    message only. Safety and recovery remain higher precedence."
//
// New precedence (only the discouraged→reassure step moved; everything else is
// unchanged):  safety > refuse > correct > reassure(explicit discouragement)
//   > challenge > … > reassure(layoff-return).
//
// The change is deliberately narrow: ONLY the existing deterministic
// detectDiscouragement signal (message-scoped) can select reassure over a
// standing challenge, and ONLY for the current turn. It never deletes or clears
// the standing consistent_underperformance pattern, so the next ordinary turn
// challenges again. Safety (pain/form) and the route-level recovery/tiredness
// read stay above reassure. No profanity, no invented facts/numbers — reassurance
// still zooms out using ONLY the existing deterministic evidence (asserted in
// test/coachPromptRules.test.js).
//
// This file pins the owner's 9 required tests. Route-scoped tests #5 (recovery
// beats reassure) and #7 (a lift-naming discouragement message reaches the
// reassure voice, not the deterministic lift-answer lane) live in
// test/api-smoke.test.js where the live chat harness is set up.

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectCoachMode } = require('../services/coachMode');
const { deriveChatCoachMode } = require('../services/chatCoachMode');
const { detectDiscouragement } = require('../services/discouragementSignal');
const { buildChatSystemPrompt } = require('../services/coach');
const { TRIGGERS } = require('../services/coachNoteTier');

// A standing recurring-underperformance pattern (the challenge trigger).
const UNDERPERF = {
  memory_patterns: [
    { liftCode: 'BENCH', patterns: [{ type: 'consistent_underperformance', details: { sessions_below: 3, sessions_checked: 4 } }] },
  ],
};

// Test 1 — standing underperformance + explicit discouragement → reassure.
test('D1-1: standing underperformance + explicit discouragement → reassure', () => {
  assert.equal(selectCoachMode({ ...UNDERPERF, discouraged: true }).mode, 'reassure');
  assert.equal(deriveChatCoachMode(UNDERPERF, { discouraged: true }), 'reassure');
});

// Test 2 — standing underperformance + an ordinary (non-discouraged) message
// still challenges. The override is discouragement-only; nothing else moves it.
test('D1-2: standing underperformance + ordinary message → challenge', () => {
  assert.equal(selectCoachMode({ ...UNDERPERF, discouraged: false }).mode, 'challenge');
  assert.equal(deriveChatCoachMode(UNDERPERF, { discouraged: false }), 'challenge');
  assert.equal(deriveChatCoachMode(UNDERPERF), 'challenge'); // opts omitted → not discouraged
});

// Test 3 — reassurance applies only to the CURRENT message. The standing pattern
// is never cleared, so the very next ordinary turn challenges again. Modelled by
// two successive derivations off the SAME standing snapshot: only the per-message
// `discouraged` flag differs.
test('D1-3: reassurance is message-scoped; the next ordinary turn → challenge', () => {
  assert.equal(deriveChatCoachMode(UNDERPERF, { discouraged: true }), 'reassure'); // this turn
  assert.equal(deriveChatCoachMode(UNDERPERF, { discouraged: false }), 'challenge'); // next turn
  // Idempotent: reassure on a discouraged turn does not mutate/consume the pattern.
  assert.equal(deriveChatCoachMode(UNDERPERF, { discouraged: true }), 'reassure');
  assert.equal(deriveChatCoachMode(UNDERPERF), 'challenge');
});

// Test 4 — pain/injury outranks discouragement: safety, never reassure. Discour-
// agement was NOT moved above safety.
test('D1-4: pain/injury + discouragement → safety, not reassure', () => {
  assert.equal(selectCoachMode({ discouraged: true, note_trigger: TRIGGERS.PAIN_INJURY }).mode, 'safety');
  assert.equal(selectCoachMode({ discouraged: true, note_trigger: TRIGGERS.FORM_SAFETY }).mode, 'safety');
  // …and even with a standing challenge pattern also present, safety still wins.
  assert.equal(selectCoachMode({ ...UNDERPERF, discouraged: true, note_trigger: TRIGGERS.PAIN_INJURY }).mode, 'safety');
});

// Test 5 (route recovery precedence) is asserted end-to-end in api-smoke; the
// engine half — a tiredness message never becomes discouragement by construction
// — is pinned here so recovery can never be swallowed into reassurance.
test('D1-5 (engine half): pure tiredness is not discouragement (recovery read owns it)', () => {
  for (const msg of ["I'm exhausted", 'legs are toast', "I'm wiped out", 'so tired today']) {
    assert.equal(detectDiscouragement(msg, {}).discouraged, false, msg);
  }
});

// Test 6 — an analytical question ("why is my bench stuck?") is for the coach,
// not a frustration report: it does NOT become reassurance. (Also pinned in
// test/discouragementSignal.test.js; re-asserted here at the mode boundary.)
test('D1-6: an analytical question does not automatically become reassurance', () => {
  const analytical = ['why is my bench stuck?', 'how do I get past this plateau', 'what should I do about being stuck'];
  for (const msg of analytical) {
    const discouraged = detectDiscouragement(msg, {}).discouraged;
    assert.equal(discouraged, false, msg);
    // With a standing pattern present, the mode stays challenge (not reassure).
    assert.equal(deriveChatCoachMode(UNDERPERF, { discouraged }), 'challenge', msg);
  }
});

// Test 7 (route lane order) lives in api-smoke; the engine half — an explicit
// discouragement phrase that also names a lift is still discouragement (so the
// route can route it to reassure) — is pinned here.
test('D1-7 (engine half): explicit discouragement that names a lift still fires', () => {
  assert.equal(detectDiscouragement('bench is stuck, I feel like a failure', {}).discouraged, true);
  assert.equal(detectDiscouragement("my squat is going nowhere and I'm useless", {}).discouraged, true);
});

// Test 8 — thin history still produces the honest "say less" reassurance variant
// with NO invented progress. The instruction lives in the reassure prompt block.
test('D1-8: reassure prompt keeps the thin-history "say less" / no-invented-progress rule', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('THIN HISTORY = SAY LESS, NOT WARMER'));
  assert.ok(chat.includes('never invent progress'));
  assert.ok(chat.includes('ZOOM OUT using ONLY facts actually present'));
});

// Test 9 — existing challenge behavior (and the LT-009 challenge expectations)
// remain green: a standing underperformance pattern with no discouragement is
// still challenge, and the layoff-return reassure is UNCHANGED (still below
// challenge — only the explicit-discouragement trigger was promoted).
test('D1-9: existing challenge + layoff-reassure precedence unchanged', () => {
  assert.equal(selectCoachMode(UNDERPERF).mode, 'challenge');
  assert.equal(selectCoachMode({ note_trigger: TRIGGERS.CHALLENGE_SANDBAG }).mode, 'challenge');
  // layoff-return reassure was NOT promoted: a standing challenge still outranks it.
  assert.equal(selectCoachMode({ ...UNDERPERF, layoff: { returning_from_layoff: true } }).mode, 'challenge');
  // …but a lone layoff-return still reassures.
  assert.equal(selectCoachMode({ layoff: { returning_from_layoff: true } }).mode, 'reassure');
});
