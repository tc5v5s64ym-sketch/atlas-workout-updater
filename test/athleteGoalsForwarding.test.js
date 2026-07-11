'use strict';

// Soul Plan PR-B8a — athlete_goals forwarding + grounding.
//
// Goals reach the coach chat voice through the SAME frozen-whitelist discipline as
// athlete_identity (PR-A7): sanitizeAthleteGoals bounds every field, drops unknown
// keys, keeps "absent" as null, and the persona core forbids stating goal proximity
// from anything but athlete_goals + a current number (cite-never-invent).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeAthleteGoals,
  sanitizeChatContext,
  buildChatSystemPrompt,
  buildCoachSystemPrompt,
} = require('../services/coach');
const { PERSONA_CORE } = require('../services/coachPersonaCore');

const VALID_GOAL = { lift_code: 'bench_press', target_weight: 215, target_reps: 5, set_date: '2026-07-11', note: 'a year in the making' };

// ── sanitizeAthleteGoals — the frozen whitelist ──────────────────────────────

test('sanitizeAthleteGoals: a valid goal round-trips with only the whitelisted fields', () => {
  const out = sanitizeAthleteGoals([VALID_GOAL]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], VALID_GOAL);
});

test('sanitizeAthleteGoals: unknown keys are dropped; only the 5 schema fields survive', () => {
  const out = sanitizeAthleteGoals([{
    ...VALID_GOAL,
    write: true, __proto__: { polluted: 1 }, evil: '<script>', current_best: 999,
  }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['lift_code', 'note', 'set_date', 'target_reps', 'target_weight']);
  assert.equal(out[0].write, undefined);
});

test('sanitizeAthleteGoals: drops an entry with no lift_code or no positive target_weight', () => {
  assert.equal(sanitizeAthleteGoals([{ target_weight: 215 }]), null, 'no lift_code → dropped');
  assert.equal(sanitizeAthleteGoals([{ lift_code: 'bench', target_weight: 0 }]), null, 'non-positive weight → dropped');
  assert.equal(sanitizeAthleteGoals([{ lift_code: 'bench', target_weight: 'heavy' }]), null, 'non-numeric weight → dropped');
  assert.equal(sanitizeAthleteGoals([{ lift_code: 'bench', target_weight: 99999 }]), null, 'absurd weight (>2000) → dropped');
});

test('sanitizeAthleteGoals: optional fields degrade to null; a non-literal date is dropped', () => {
  const out = sanitizeAthleteGoals([{ lift_code: 'squat', target_weight: 315 }]);
  assert.deepEqual(out[0], { lift_code: 'squat', target_weight: 315, target_reps: null, set_date: null, note: null });
  const badDate = sanitizeAthleteGoals([{ lift_code: 'squat', target_weight: 315, set_date: 'July 2026' }]);
  assert.equal(badDate[0].set_date, null, 'only literal YYYY-MM-DD survives');
});

test('sanitizeAthleteGoals: a long note is clamped; target_reps is bounded', () => {
  const out = sanitizeAthleteGoals([{ lift_code: 'squat', target_weight: 315, target_reps: 9999, note: 'x'.repeat(500) }]);
  assert.ok(out[0].note.length <= 200, 'note clamped to <=200 chars');
  assert.equal(out[0].target_reps, null, 'out-of-range reps → null');
});

test('sanitizeAthleteGoals: non-array / empty / all-malformed → null (absent, never [])', () => {
  assert.equal(sanitizeAthleteGoals(null), null);
  assert.equal(sanitizeAthleteGoals('goals'), null);
  assert.equal(sanitizeAthleteGoals([]), null);
  assert.equal(sanitizeAthleteGoals([{ bogus: 1 }, null, 'nope']), null);
});

test('sanitizeAthleteGoals: caps the count at 12', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ lift_code: `lift${i}`, target_weight: 100 + i }));
  assert.equal(sanitizeAthleteGoals(many).length, 12);
});

// ── sanitizeChatContext forwards athlete_goals under the same whitelist ───────

test('sanitizeChatContext forwards athlete_goals, bounded by the whitelist', () => {
  const ctx = sanitizeChatContext({ athlete_goals: [VALID_GOAL, { lift_code: 'squat', target_weight: 315 }] });
  assert.equal(ctx.athlete_goals.length, 2);
  assert.equal(ctx.athlete_goals[0].lift_code, 'bench_press');
});

test('sanitizeChatContext: absent athlete_goals → null', () => {
  assert.equal(sanitizeChatContext({}).athlete_goals, null);
  assert.equal(sanitizeChatContext({ athlete_goals: [] }).athlete_goals, null);
});

// ── Persona core + chat prompt — cite-never-invent goal proximity ────────────

test('persona core carries the goal-proximity grounding rule (goal + current number, else no claim)', () => {
  assert.match(PERSONA_CORE, /athlete_goals/i, 'the core must name the athlete_goals fact');
  assert.match(PERSONA_CORE, /goal/i);
  // The rule must require BOTH the goal AND a current number, and forbid a claim when absent.
  assert.match(PERSONA_CORE, /current|best|e1rm/i, 'goal proximity must be tied to a current number');
});

test('the chat voice describes athlete_goals so the model may cite goal proximity', () => {
  assert.match(buildChatSystemPrompt(), /athlete_goals/, 'chat prompt must describe the athlete_goals fact');
});

test('the goal-proximity rule rides the shared persona core, so every voice inherits cite-never-invent', () => {
  // The core is prepended to every builder; the set-reaction voice (which does NOT
  // receive athlete_goals) still carries the rule, so it can never invent a goal claim.
  assert.match(buildCoachSystemPrompt(), /athlete_goals/i);
});

// ── Read budget + engine-only wiring (source introspection) ──────────────────

const fs = require('node:fs');
const path = require('node:path');
const goalsSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'athleteGoals.js'), 'utf8');
const coachOpsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'coachOps.js'), 'utf8');

test('read budget: athleteGoals is pure — no Sheets, no network, no clock', () => {
  assert.ok(!/require\((['"]).*sheets/.test(goalsSrc), 'must not require the sheets adapter');
  assert.ok(!/\bfetch\(|\bhttps?:\/\//.test(goalsSrc), 'must not reach the network');
  assert.ok(!/new Date\(\)|Date\.now\(\)/.test(goalsSrc), 'must not read the clock');
});

test('read budget: the chat route derives athlete_goals from the ALREADY-FETCHED Constraints rows (zero new read)', () => {
  // The route reads Constraints exactly once (the pre-existing constraints fetch),
  // and goals are parsed from those same raw rows — never a second Sheets call.
  const constraintReads = coachOpsSrc.match(/getSheetRows\('Constraints'\)/g) || [];
  assert.equal(constraintReads.length, 1, 'exactly one Constraints read — goals add none');
  assert.match(coachOpsSrc, /athlete_goals:\s*readAthleteGoals\(modeOpts\.constraintRows\)/,
    'goals must derive from the raw constraintRows the route already fetched');
  assert.match(coachOpsSrc, /buildChatContext\([^)]*\{\s*discouraged,\s*constraintRows\s*\}\)/,
    'the route must thread the already-fetched constraintRows into buildChatContext');
});
