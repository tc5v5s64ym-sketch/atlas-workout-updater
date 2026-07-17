'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCoachSystemPrompt, buildPlanSystemPrompt, buildChatSystemPrompt } = require('../services/coach');

const prompt = buildCoachSystemPrompt();

// ── RIR anti-fabrication rule ──────────────────────────────────────────────────

test('system prompt: contains RIR anti-fabrication IRON RULE', () => {
  assert.ok(
    prompt.includes('IRON RULE — derive effort from effort_verdict ONLY'),
    'prompt must contain the RIR anti-fabrication iron rule'
  );
});

test('system prompt: names RIR 2 explicitly as solid working effort', () => {
  assert.ok(
    prompt.includes('RIR 2 is solid working effort'),
    'prompt must explicitly state RIR 2 is solid working effort, not failure'
  );
});

test('system prompt: forbids "failure" unless effort_verdict says so', () => {
  assert.ok(
    prompt.includes('MUST NOT appear unless effort_verdict.level is "failure"'),
    'prompt must prohibit failure language unless the engine verdict says failure'
  );
});

test('system prompt: forbids "near-failure" language', () => {
  assert.ok(
    prompt.includes('near-failure'),
    'prompt must mention near-failure in the forbidden list'
  );
});

test('system prompt: clarifies RIR 0 alone does not mean failure', () => {
  assert.ok(
    prompt.includes('RIR 0 in the facts does NOT by itself mean failure'),
    'prompt must clarify RIR 0 alone is not a failure signal'
  );
});

// ── deviation wording instruction ──────────────────────────────────────────────

test('system prompt: contains deviation instruction', () => {
  assert.ok(
    prompt.includes('"deviation"'),
    'prompt must contain the deviation field instruction'
  );
});

test('system prompt: deviation instruction names all four verdicts', () => {
  assert.ok(prompt.includes('above_expected'), 'must mention above_expected');
  assert.ok(prompt.includes('below_expected'), 'must mention below_expected');
  assert.ok(prompt.includes('on_target'), 'must mention on_target');
  assert.ok(prompt.includes('insufficient_data'), 'must mention insufficient_data');
});

test('system prompt: deviation instruction guards against single-session fatigue diagnosis', () => {
  assert.ok(
    prompt.includes('never use a single below_expected result to call fatigue'),
    'prompt must forbid calling fatigue from one deviation result'
  );
});

// ── historical context reference ───────────────────────────────────────────────

test('system prompt: last_working_sets mentioned as a grounding source', () => {
  assert.ok(
    prompt.includes('last_working_sets'),
    'prompt must allow referencing last_working_sets for historical grounding'
  );
});

test('system prompt: effort_verdict still required for reaction framing', () => {
  assert.ok(
    prompt.includes('effort_verdict'),
    'effort_verdict rule must still be present'
  );
});

test('system prompt: deviation instruction placed before readiness_signal', () => {
  const deviationIdx = prompt.indexOf('"deviation"');
  const readinessIdx = prompt.indexOf('"readiness_signal"');
  assert.ok(deviationIdx < readinessIdx, 'deviation rule must precede readiness_signal rule');
});

// ── trend object is the authoritative e1RM signal ──────────────────────────────

test('system prompt: trend rule identifies trend object as the authoritative e1RM trajectory signal', () => {
  assert.ok(
    prompt.includes('authoritative e1RM trajectory signal'),
    'trend rule must mark the trend object as authoritative to prevent the model using a legacy trend string'
  );
});

// ── P3 — Coach Brevity Pass: conclusion-first ordering across all three voices ──

test('set-reaction prompt: carries the CONCLUSION FIRST ordering rule', () => {
  assert.ok(
    prompt.includes('CONCLUSION FIRST'),
    'set-reaction prompt must instruct the model to lead with the verdict'
  );
});

test('plan prompt: carries the CONCLUSION FIRST ordering rule', () => {
  assert.ok(
    buildPlanSystemPrompt().includes('CONCLUSION FIRST'),
    'plan "why today" prompt must instruct the model to lead with the position'
  );
});

test('chat prompt: carries the CONCLUSION FIRST ordering rule', () => {
  assert.ok(
    buildChatSystemPrompt().includes('CONCLUSION FIRST'),
    'chat prompt must instruct the model to lead with the answer, reason second, details on ask'
  );
});

test('chat prompt: conclusion-first rule is presentation order only, not a content change', () => {
  const chat = buildChatSystemPrompt();
  const idx = chat.indexOf('CONCLUSION FIRST');
  assert.ok(idx >= 0);
  // The rule must explicitly scope itself to presentation so it never overrides the
  // grounding/what's-left/history rules above it.
  assert.ok(
    chat.slice(idx).includes('presentation order only'),
    'chat conclusion-first rule must declare it changes presentation order, not what is answered'
  );
});

// ── prescription loads: the LLM words engine numbers, never invents them (owner
//    decision 2026-07-04). The chat voice previously fabricated "today's plan"
//    weights when asked for a session the engine had not priced. ──────────────────

test('chat prompt: forbids inventing prescription loads', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(
    chat.includes('PRESCRIPTION LOADS: never invent a working weight'),
    'chat prompt must carry an iron rule forbidding invented prescription weights'
  );
});

test('chat prompt: states the engine owns loads and the coach only words them', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(
    chat.includes('The engine owns loads; you word them, you never create them'),
    'chat prompt must state loads are engine-owned, not coach-created'
  );
});

test('chat prompt: gives a load-less prescription when the snapshot has no load', () => {
  const chat = buildChatSystemPrompt();
  // When no engine load exists for a requested lift, the coach prescribes the movement
  // as sets × reps @ a target RIR with NO fabricated weight.
  assert.ok(
    chat.includes('put NO specific weight on it'),
    'chat prompt must instruct a weight-less prescription when the engine has no load'
  );
});

// ── PR-B5a sandbag challenge: the chat challenge-mode prompt block ─────────────
// Deterministic side already merged (#953): deriveChatCoachMode maps a
// consistent_underperformance memory pattern → coach_mode 'challenge' into the chat
// snapshot. This slice adds the smallest prompt wiring that words that mode —
// evidence + one question, never a lecture, hold the line on pushback, grounded in
// memory_patterns, and NO register/profanity escalation. All other chat behavior is
// unchanged (the block is semantically gated on coach_mode === 'challenge').

test('chat prompt: carries a CHALLENGE MODE block gated on coach_mode', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('CHALLENGE MODE'), 'chat prompt must carry a challenge-mode block');
  assert.ok(chat.includes('challenge ONLY when'), 'challenge must be gated to coach_mode challenge, not raised in other modes');
});

test('chat prompt: challenge states the evidence and ASKS, never lectures', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('State the evidence and ASK'), 'challenge must state the pattern then ask a question');
  assert.ok(chat.includes('never lecture'), 'challenge must forbid lecturing');
});

test('chat prompt: challenge holds the line on pushback (does not cave)', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('do NOT cave'), 'challenge must not cave when the lifter pushes back');
  assert.ok(chat.includes("restate the pattern's facts once"), 'challenge holds the line by restating the facts, neutrally');
});

test('chat prompt: challenge is grounded in memory_patterns — never invents a pattern', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('Never invent a pattern that is not in'), 'challenge must never invent a pattern absent from memory_patterns');
});

test('chat prompt: challenge carries no register/profanity escalation (honesty, not heat)', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('challenge is honesty, not heat'), 'challenge stays in the ordinary direct register — no escalation');
});

// ── F09J (UNDER-TARGET-1): a consistent_underperformance challenge is a BENCHMARK/TREND
// comparison against the lift's own established performance — no per-session prescription
// was ever stored, so it is NOT a missed plan. The prompt must forbid plan-failure
// vocabulary ("under target", "missed target", "failed the plan", "beat expectations")
// and supply the honest benchmark replacement wording. ─────────────────────────────────

test('chat prompt: challenge frames the comparison as a benchmark/trend, NOT a missed plan', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('BENCHMARK/TREND comparison'), 'challenge must frame it as a benchmark/trend comparison');
  assert.ok(chat.includes('NOT a missed plan'), 'challenge must state no per-session prescription was stored — not a missed plan');
});

test('chat prompt: challenge explicitly forbids plan-failure vocabulary', () => {
  const chat = buildChatSystemPrompt();
  // The forbidden phrases may appear ONLY inside this prohibition, never as guidance.
  assert.ok(
    chat.includes('NEVER say "under target", "missed target", "failed the plan", or "beat expectations"'),
    'challenge must forbid describing a benchmark trend as a missed/failed plan'
  );
});

test('chat prompt: challenge supplies the benchmark replacement wording', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('below your recent benchmark'), 'challenge must offer "below your recent benchmark" wording');
  assert.ok(chat.includes('below your established range'), 'challenge must offer "below your established range" wording');
});

test('chat prompt: challenge example models benchmark phrasing, not target phrasing', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(
    chat.includes('below your recent benchmark 3 of the last 4 sessions'),
    'the worked example must use benchmark phrasing, so the model imitates the honest framing'
  );
});

// ── F09H (PR-CLAIM-1): a self-reported PR must never become a coaching note ─────

test('chat prompt: forbids proposing a note/constraint for a self-reported PR claim', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('NEVER propose saving it as a note or constraint'),
    'the note-proposing guidance must exclude a self-reported PR/personal-best claim');
  assert.ok(chat.includes('PR status is determined by the engine'),
    'the prompt must state PR status is engine-owned, never a typed claim');
});

// ── G5: coach claims grounding audit (PR / personal-best / session count) ──────

test('set-reaction prompt: PR language IRON RULE requires progression_verdict.level new_ground', () => {
  // G5 grounding audit: the model may only say "personal best", "new PR", etc.
  // when the engine verdict is new_ground — not merely when best_weight is present.
  assert.ok(prompt.includes('new_ground'), 'PR iron rule must reference new_ground');
  assert.ok(
    prompt.includes('personal best') && prompt.includes('new_ground'),
    'prompt must explicitly tie personal-best language to new_ground'
  );
});

test('set-reaction prompt: best_weight alone does not authorize PR language', () => {
  assert.ok(
    prompt.includes('best_weight') && prompt.includes('does NOT authorize PR language'),
    'prompt must clarify that best_weight alone does not license PR claims'
  );
});

test('set-reaction prompt: session count must come from trend.sessions_analyzed', () => {
  // G5 grounding audit: session counts in evidence_context rules must be sourced
  // from the forwarded trend.sessions_analyzed field, not by counting reference_sets
  // (which are individual sets, not session counts).
  assert.ok(
    prompt.includes('sessions_analyzed'),
    'prompt must direct the model to use trend.sessions_analyzed for session counts'
  );
  assert.ok(
    prompt.includes('NEVER derive a session count by counting'),
    'prompt must forbid the model from counting the reference_sets array'
  );
});

// ── B10: thin-history / accessory-core coaching discipline ────────────────────

test('set-reaction prompt: THIN-HISTORY RULE present', () => {
  assert.ok(
    prompt.includes('THIN-HISTORY RULE'),
    'prompt must contain the thin-history rule for lifts with no band/trend/fatigue picture'
  );
});

test('set-reaction prompt: thin-history rule gates on all three absent-signal fields', () => {
  assert.ok(
    prompt.includes('progression_verdict') && prompt.includes('trend') && prompt.includes('readiness_signal'),
    'thin-history rule must reference all three key signal fields'
  );
});

test('set-reaction prompt: thin-history rule explicitly bans generic filler phrases', () => {
  // The prompt must name specific banned filler so the model can\'t substitute synonyms.
  const fillerPhrases = ['great work', 'keep it up', 'solid session', 'stay consistent', 'nice job', 'well done'];
  for (const phrase of fillerPhrases) {
    assert.ok(prompt.includes(phrase), `thin-history rule must name "${phrase}" in the banned-filler list`);
  }
});

test('set-reaction prompt: thin-history rule placed after calibration_status rule', () => {
  const thinHistoryIdx = prompt.indexOf('THIN-HISTORY RULE');
  const calibStatusIdx = prompt.indexOf('calibration_status');
  assert.ok(calibStatusIdx < thinHistoryIdx, 'thin-history rule must follow the calibration_status rule');
});

// ── PR-B5b Part 2: the chat REASSURE-mode prompt block ────────────────────────

test('chat prompt: carries a REASSURE MODE block gated on coach_mode', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('REASSURE MODE'), 'chat prompt must carry a reassure-mode block');
  assert.ok(chat.includes('Reassure ONLY when'), 'reassure must be gated to coach_mode reassure');
});

test('chat prompt: reassure zooms out ONLY with facts present and gives ONE next move', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('ZOOM OUT using ONLY facts actually present'));
  assert.ok(chat.includes('ONE concrete next move'));
});

test('chat prompt: reassure — thin history says less, never invents progress, no filler', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('THIN HISTORY = SAY LESS, NOT WARMER'));
  assert.ok(chat.includes('never invent progress'));
  assert.ok(chat.includes('believe in yourself'), 'must ban the "believe in yourself" filler');
});

test('chat prompt: reassure defers to pain/safety/recovery', () => {
  const chat = buildChatSystemPrompt();
  assert.ok(chat.includes('that takes precedence'), 'pain/injury/fatigue outranks reassurance');
});
