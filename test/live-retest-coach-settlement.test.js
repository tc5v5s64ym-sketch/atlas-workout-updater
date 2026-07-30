'use strict';

// Assertion matrix for the production coach-response settlement scenario
// (`coach-response-settlement`, verdict mode `settled_no_forbidden`).
//
// The mode reaches a genuine PASS/FAIL via the real settlement path WITHOUT
// asserting on nondeterministic reply wording: a SETTLED coach reply with no
// outage wording is a PASS, an outage wording is a FAIL, and anything that never
// produced an observable settled reply is INCONCLUSIVE. A PASS proves only that a
// new reply bubble appeared, settled, and revealed no outage — it does NOT
// establish model provenance or Gemini health (the settled reply may come from
// Gemini or the deterministic engine fallback). These tests drive assertScenario
// directly with crafted { threadText, settle } — deterministic, no browser — and
// pin that the mode does NOT rely on the generic "no expected regex = PASS" path
// and does NOT alter any existing scenario's semantics (esp. the outage-specific
// bug-20260629-153258 and its #719 anti-false-PASS assertion).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertScenario, SCENARIOS } = require('../scripts/live-retest');

const TMP = path.join(os.tmpdir(), 'atlas-live-retest-coach-settlement');
fs.mkdirSync(TMP, { recursive: true });

const SCN_SETTLE = SCENARIOS['coach-response-settlement'];
const OUTAGE = SCENARIOS['bug-20260629-153258'];
const MODALITY = SCENARIOS['bug-20260629-002945'];

// The lifter's own bubble text; a settled reply is appended after it.
const USER = 'you missed a set';
const CLEAN_REPLY = `${USER} Got it — tell me the set and I'll slot it into today's log.`;
const OUTAGE_REPLY = `${USER} Sorry, the coach is unavailable right now.`;

function verdict(scenario, key, threadText, settle) {
  return assertScenario({
    scenarioKey: key, scenario,
    navResult: { navigated: true, threadText, settle },
    outputDir: TMP
  });
}

const settled = { settled: true, reason: 'settled' };

// ── 1. Settled reply + forbidden absent → PASS ──────────────────────

test('1. settled coach reply, no forbidden pattern → PASS', () => {
  assert.equal(verdict(SCN_SETTLE, 'h1', CLEAN_REPLY, settled), 'PASS');
  const json = JSON.parse(fs.readFileSync(path.join(TMP, 'h1-result.json'), 'utf8'));
  assert.equal(json.verdict, 'PASS');
});

// ── 2. Settled reply + forbidden present → FAIL ─────────────────────────────

test('2. settled atlas reply containing an outage pattern → FAIL', () => {
  assert.equal(verdict(SCN_SETTLE, 'h2', OUTAGE_REPLY, settled), 'FAIL');
});

// ── 3. Stable user bubble only → INCONCLUSIVE ───────────────────────────────

test('3. only the user bubble is present (no atlas reply), stable → INCONCLUSIVE', () => {
  const r = verdict(SCN_SETTLE, 'h3', USER, { settled: false, reason: 'timeout_no_response' });
  assert.equal(r, 'INCONCLUSIVE');
  const json = JSON.parse(fs.readFileSync(path.join(TMP, 'h3-result.json'), 'utf8'));
  assert.equal(json.settleReason, 'timeout_no_response');
});

// ── 4. No atlas reply at all → timeout_no_response → INCONCLUSIVE ────────────

test('4. no atlas reply → timeout_no_response → INCONCLUSIVE', () => {
  assert.equal(verdict(SCN_SETTLE, 'h4', '', { settled: false, reason: 'timeout_no_response' }), 'INCONCLUSIVE');
});

// ── 5. Atlas bubble stuck on Thinking… → INCONCLUSIVE ───────────────────────

test('5. atlas bubble stuck on Thinking… → INCONCLUSIVE', () => {
  const r = verdict(SCN_SETTLE, 'h5', `${USER} Thinking…`, { settled: false, reason: 'timeout_still_thinking' });
  assert.equal(r, 'INCONCLUSIVE');
  const json = JSON.parse(fs.readFileSync(path.join(TMP, 'h5-result.json'), 'utf8'));
  assert.equal(json.settleReason, 'timeout_still_thinking');
});

// The mode NEVER PASSes on a non-settled response, even if the (empty-by-design)
// forbidden set doesn't match — i.e. it does not fall through to a generic PASS.
test('5b. a settled:false reply with no forbidden hit is INCONCLUSIVE, never PASS', () => {
  assert.equal(verdict(SCN_SETTLE, 'h5b', CLEAN_REPLY, { settled: false, reason: 'timeout_unstable' }), 'INCONCLUSIVE');
});

test('5c. a missing settle object fails closed to INCONCLUSIVE (settlement never observed)', () => {
  const r = verdict(SCN_SETTLE, 'h5c', CLEAN_REPLY, undefined);
  assert.equal(r, 'INCONCLUSIVE');
  const json = JSON.parse(fs.readFileSync(path.join(TMP, 'h5c-result.json'), 'utf8'));
  assert.equal(json.settleReason, 'no_settlement_observed');
});

// ── 6. Existing scenarios retain their current expected-pattern semantics ────

test('6. bug-20260629-002945 keeps expected-pattern semantics: settled + expected present → PASS', () => {
  assert.equal(
    verdict(MODALITY, 'h6a', 'Knee raises 20 20 20 Did you mean bodyweight reps? How many?', settled),
    'PASS'
  );
});

test('6b. bug-20260629-002945: settled but expected MISSING → INCONCLUSIVE (unchanged)', () => {
  assert.equal(
    verdict(MODALITY, 'h6b', 'Knee raises 20 20 20 Noted — keep logging and say "log it" when done.', settled),
    'INCONCLUSIVE'
  );
});

// ── 7. bug-20260629-153258 unchanged: cannot PASS on forbidden-absent alone ──

test('7. bug-20260629-153258: settled reply, forbidden absent, but expected keyword MISSING → INCONCLUSIVE (never PASS)', () => {
  // A settled reply with none of the forbidden outage wording AND none of the
  // #719 expected keywords (re-type / add it to the preview / log it). The outage
  // scenario must NOT PASS merely because the forbidden wording is absent.
  const settledNoKeyword = `${USER} Got it — give me the exercise and weight and I'll capture it.`;
  assert.equal(verdict(OUTAGE, 'h7', settledNoKeyword, settled), 'INCONCLUSIVE');
});

test('7b. bug-20260629-153258 still FAILs on an outage pattern, and PASSes only via its #719 expected keyword', () => {
  assert.equal(verdict(OUTAGE, 'h7b-fail', OUTAGE_REPLY, settled), 'FAIL');
  assert.equal(
    verdict(OUTAGE, 'h7b-pass', `${USER} If a set didn't make it in, re-type it and I'll add it to the preview.`, settled),
    'PASS'
  );
});

// ── The new scenario's shape is what we think it is ─────────────────────────

test('the settlement scenario uses mode settled_no_forbidden, has no expected regex, and is composer-driven', () => {
  assert.equal(SCN_SETTLE.assertion.mode, 'settled_no_forbidden');
  assert.equal(SCN_SETTLE.assertion.expected, undefined, 'no expected regex by design');
  assert.equal(SCN_SETTLE.assertion.forbidden.length, 4, 'the four outage patterns');
  assert.equal(SCN_SETTLE.navigation.type, 'composer');
  assert.equal(SCN_SETTLE.navigation.text, 'you missed a set');
});

test('the outage scenario bug-20260629-153258 is untouched (still expected-gated, no mode)', () => {
  assert.equal(OUTAGE.assertion.mode, undefined, 'outage scenario has no verdict mode');
  assert.equal(OUTAGE.assertion.expected.length, 1, 'its #719 expected keyword assertion stands');
  assert.equal(OUTAGE.assertion.forbidden.length, 4);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
