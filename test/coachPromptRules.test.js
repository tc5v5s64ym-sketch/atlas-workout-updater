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
