'use strict';

// Soul Plan B5 foundation — chat-path coach-mode derivation.
//
// deriveChatCoachMode maps the chat TRAINING SNAPSHOT onto selectCoachMode's
// EXISTING inputs and adds no new detection. Pins: (1) the one live chat trigger
// (memory_patterns → challenge) fires; (2) everything else floors to silent — this
// is the honest current state (drift/discouragement are Part 2, plan-history kinds
// stay dark until persistence exists); (3) totality (garbage never throws, always a
// frozen-vocabulary mode); (4) the derived mode round-trips through the chat
// sanitizer intact (so the foundation actually reaches the coach payload).

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveChatCoachMode } = require('../services/chatCoachMode');
const { COACH_MODES } = require('../services/coachMode');
const { sanitizeChatContext } = require('../services/coach');

const UNDERPERF = {
  memory_patterns: [
    { liftCode: 'BENCH', patterns: [{ type: 'consistent_underperformance', details: { sessions_below: 3, sessions_checked: 4 } }] },
  ],
};

test('challenge: a consistent_underperformance memory pattern maps to challenge', () => {
  assert.equal(deriveChatCoachMode(UNDERPERF), 'challenge');
});

test('silent: no memory pattern → silent (the honest current-state floor)', () => {
  assert.equal(deriveChatCoachMode({ memory_patterns: [] }), 'silent');
  assert.equal(deriveChatCoachMode({}), 'silent');
  // A non-challenge pattern (repeated_substitution) is NOT a challenge trigger — no
  // new detection is invented here, so it floors to silent too.
  assert.equal(deriveChatCoachMode({
    memory_patterns: [{ liftCode: 'SQUAT', patterns: [{ type: 'repeated_substitution', details: { original: 'Back Squat', substitute: 'Leg Press', count: 3 } }] }],
  }), 'silent');
});

test('no new detection: unrelated snapshot fields never move the mode off silent', () => {
  // stalls / discouragement-shaped text / layoff are NOT wired here (Part 2) — a rich
  // snapshot with none of the selectCoachMode inputs still floors to silent.
  assert.equal(deriveChatCoachMode({
    stalls: [{ exercise: 'Bench Press', sessions_stalled: 5 }],
    recommended_label: 'Upper A',
    session_count: 40,
  }), 'silent');
});

test('totality: garbage/empty input → a valid frozen-vocabulary mode, never throws', () => {
  for (const arg of [null, undefined, 42, 'nope', [], { memory_patterns: 'not-an-array' }, { memory_patterns: [null, 7, {}] }]) {
    const mode = deriveChatCoachMode(arg);
    assert.ok(COACH_MODES.includes(mode), `mode ${mode} must be in the frozen vocabulary`);
  }
  assert.equal(deriveChatCoachMode({ memory_patterns: 'not-an-array' }), 'silent');
});

test('foundation reaches the coach: the derived mode round-trips through sanitizeChatContext', () => {
  const mode = deriveChatCoachMode(UNDERPERF);
  const snapshot = sanitizeChatContext({ memory_patterns: UNDERPERF.memory_patterns, coach_mode: mode });
  assert.equal(snapshot.coach_mode, 'challenge', 'the whitelist forwards the derived mode intact');
  // Register stays null — no register/profanity expansion in this foundation (B4-4).
  assert.equal(snapshot.register, null);
  // A silent mode also survives the round-trip (it is a real frozen mode, not a drop).
  assert.equal(sanitizeChatContext({ coach_mode: deriveChatCoachMode({}) }).coach_mode, 'silent');
});

test('reassure: an explicit discouragement signal routes the chat mode to reassure (B5b Part 2)', () => {
  assert.equal(deriveChatCoachMode({}, { discouraged: true }), 'reassure');
  // Owner Decision 1 (LT-011): explicit discouragement overrides a standing
  // challenge pattern for THAT MESSAGE ONLY — reassure now beats challenge here.
  // The next ordinary turn (discouraged:false) challenges again (message-scoped).
  assert.equal(deriveChatCoachMode(UNDERPERF, { discouraged: true }), 'reassure');
  assert.equal(deriveChatCoachMode(UNDERPERF, { discouraged: false }), 'challenge');
  // no discouragement, no pattern → silent; opts optional (back-compat)
  assert.equal(deriveChatCoachMode({}, {}), 'silent');
  assert.equal(deriveChatCoachMode({}), 'silent');
  assert.equal(deriveChatCoachMode({}, { discouraged: false }), 'silent');
});
