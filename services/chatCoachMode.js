'use strict';

// ── Chat-path coaching-MODE derivation (Soul Plan — B5 foundation) ────────────
//
// The set-reaction path (routes/coachOps.js POST /api/coach/message) already picks
// an engine-decided coach_mode via selectCoachMode (PR-B4 slice 1). The live CHAT
// path (POST /api/coach/chat) did not — it forwarded a permanently-null coach_mode,
// so there was no mode foundation for the B5 challenge/reassure triggers to plug
// into. That gap is exactly why the B5 Part-2 premise failed (see #951 / BACKLOG):
// wiring drift→challenge or discouragement→reassure had nowhere on the chat path to
// attach.
//
// This helper is that attachment point. It maps the deterministic chat TRAINING
// SNAPSHOT onto selectCoachMode's EXISTING inputs and returns the mode string. It
// adds NO new detection: today the only mode trigger the chat snapshot carries is
// `memory_patterns` (services/coachMemory.js) → `challenge` on a
// consistent_underperformance pattern; every other shape floors to `silent`. The
// route already resolves the higher-precedence recovery/tiredness moment BEFORE the
// LLM (isTirednessExpression → recovery routing), so this only ever runs on the
// non-tired chat turn — it does not disturb that precedence.
//
// B5 Part 2 extends THIS function (not the route) — detectDrift → the `challenge`
// input and detectDiscouragement → a `reassure` input — so the wiring lives in one
// tested seam instead of being threaded through the route by hand. The two
// plan-history drift kinds (skipped_pattern_streak / plan_deviation) stay dark until
// persisted plan history exists (owner decision — see the Decision Desk issue).
//
// PURE + additive: no I/O, no LLM, no clock. Total — every input (including
// garbage) returns a valid mode from the frozen COACH_MODES vocabulary.

const { selectCoachMode } = require('./coachMode');

// Map the chat snapshot onto selectCoachMode's input shape. Only the fields the
// chat path genuinely computes are forwarded — nothing is invented, and an absent
// field is simply not passed (selectCoachMode floors every missing trigger).
function deriveChatCoachMode(context, opts = {}) {
  const c = context && typeof context === 'object' ? context : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const facts = {
    // Challenge on a recurring consistent_underperformance pattern (data-derived).
    // Same shape selectCoachMode reads: memory_patterns[*].patterns[*].type.
    memory_patterns: Array.isArray(c.memory_patterns) ? c.memory_patterns : [],
    // Reassure on an EXPLICIT discouragement/frustration message (B5b Part 2). The
    // signal is message-derived (services/discouragementSignal.detectDiscouragement),
    // computed + passed by the chat route — never inferred here. `challenge` still
    // outranks `reassure` (B1 precedence), and the route resolves tiredness/recovery
    // before the LLM so recovery beats reassure.
    discouraged: o.discouraged === true,
  };
  return selectCoachMode(facts, {}).mode;
}

module.exports = { deriveChatCoachMode };
