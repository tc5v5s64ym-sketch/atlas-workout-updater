'use strict';

// LT-011 live-validation finding (2026-07-12): the chat coach's `reassure` mode was
// forwarding `memory_patterns` (the challenge fuel) to the prompt, so on an athlete
// with a standing `consistent_underperformance` pattern an explicit-discouragement
// message reliably came back as a CHALLENGE ("Bench Press under target 5 of 5 — what's
// going on?") instead of REASSURANCE — the exact pile-on reassure exists to prevent.
//
// Owner Decision 1 (LT-011) already places `reassure` ABOVE `challenge` at the mode
// seam. This pins the data-layer half of that decision: when the engine has decided
// `reassure`, the challenge signal must not reach the model at all. Deterministic and
// LLM-free — it constrains what the prompt can be built from, so the fix does not rely
// on the model obeying a prompt instruction.

const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeChatContext } = require('../services/coach');

// The engine memory_patterns shape sanitizeChatContext expects: an array of
// { liftCode, patterns: [{ type, details }] }.
function benchUnderperformance() {
  return [{
    liftCode: 'BEN01',
    patterns: [{ type: 'consistent_underperformance', details: { sessions_below: 5, sessions_checked: 5 } }],
  }];
}

test('reassure mode suppresses memory_patterns (no challenge fuel reaches the prompt)', () => {
  const ctx = sanitizeChatContext({ coach_mode: 'reassure', memory_patterns: benchUnderperformance() });
  assert.equal(ctx.coach_mode, 'reassure', 'reassure mode is preserved');
  assert.deepEqual(ctx.memory_patterns, [], 'reassure must forward NO memory_patterns — the model cannot challenge without the pattern');
});

test('challenge mode still forwards memory_patterns intact', () => {
  const ctx = sanitizeChatContext({ coach_mode: 'challenge', memory_patterns: benchUnderperformance() });
  assert.equal(ctx.coach_mode, 'challenge');
  assert.equal(ctx.memory_patterns.length, 1, 'challenge mode keeps the pattern so the coach can name it');
  assert.equal(ctx.memory_patterns[0].patterns[0].type, 'consistent_underperformance');
});

test('no coach_mode (ordinary chat) still forwards memory_patterns intact', () => {
  const ctx = sanitizeChatContext({ memory_patterns: benchUnderperformance() });
  assert.equal(ctx.coach_mode, null);
  assert.equal(ctx.memory_patterns.length, 1, 'a null mode is not reassure — the pattern is preserved');
});
