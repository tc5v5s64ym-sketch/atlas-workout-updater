'use strict';

// Persona fact checks (Slice 2b, persona test rig — issue #1607; design §3.4).
// The pure checker behind the persona scorecard's new checks, bitten here on
// synthetic durable rows in the exact shape the session-filtered verifier
// returns. Includes the design §5 validation shape as a first-class case: the
// NEGATIVE CONTROL — durable rows carrying the un-corrected fat-finger weight
// must fail the correction check (and the equality check), or the check is
// decoration.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { checkPersonaFacts } = require('../tests/e2e/gate/persona-facts');
const { loadPersonaFixture } = require('../tests/e2e/gate/personas/load-persona');

const MARCUS = loadPersonaFixture('marcus');
const SESSION = '20261029-AM-01';

// The run's computed declaration for the script-shaped draw: top set read at
// RIR 4 (one over the planned 3), so the back-offs ride the revised 290.
const EXPECTED_SETS = [
  { exercise: 'Back Squat', lift_code: 'SQ01', weight: 135, reps: 5, rir: 5 },
  { exercise: 'Back Squat', lift_code: 'SQ01', weight: 225, reps: 3, rir: 4 },
  { exercise: 'Back Squat', lift_code: 'SQ01', weight: 275, reps: 2, rir: 3 },
  { exercise: 'Back Squat', lift_code: 'SQ01', weight: 315, reps: 3, rir: 4 },
  { exercise: 'Back Squat', lift_code: 'SQ01', weight: 290, reps: 5, rir: 2 },
  { exercise: 'Back Squat', lift_code: 'SQ01', weight: 290, reps: 5, rir: 2 },
  { exercise: 'Back Squat', lift_code: 'SQ01', weight: 290, reps: 5, rir: 2 },
  { exercise: 'Bench Press', lift_code: 'BEN01', weight: 225, reps: 5, rir: 2 },
  { exercise: 'Bench Press', lift_code: 'BEN01', weight: 225, reps: 5, rir: 2 },
  { exercise: 'Bench Press', lift_code: 'BEN01', weight: 225, reps: 5, rir: 2 },
  { exercise: 'Romanian Deadlift', lift_code: 'RDL01', weight: 275, reps: 6, rir: 2 },
  { exercise: 'Romanian Deadlift', lift_code: 'RDL01', weight: 275, reps: 6, rir: 2 },
  { exercise: 'Romanian Deadlift', lift_code: 'RDL01', weight: 275, reps: 6, rir: 2 },
];
const LOGGED_NAMES = [
  ...Array(7).fill('Back Squat'),
  ...Array(3).fill('Bench Press'),
  ...Array(3).fill('Romanian Deadlift'),
];

const MUSCLE = { SQ01: 'Legs', BEN01: 'Chest', RDL01: 'Hamstrings' };
function durableRows(sets) {
  const perLift = {};
  return sets.map((s) => {
    perLift[s.lift_code] = (perLift[s.lift_code] || 0) + 1;
    // logCleanedColumns order, as the durable verifier returns the span.
    return ['2026-10-29', SESSION, s.exercise, s.exercise, MUSCLE[s.lift_code], s.lift_code,
      String(perLift[s.lift_code]), String(s.weight), String(s.reps), String(s.rir), '', ''];
  });
}

function runFacts(over = {}) {
  return checkPersonaFacts({
    fixture: MARCUS,
    expectedSets: EXPECTED_SETS,
    loggedNames: LOGGED_NAMES,
    bufferSets: EXPECTED_SETS,
    durableLogRows: durableRows(EXPECTED_SETS),
    observedRemaining: [],
    ...over,
  });
}
const check = (facts, id) => facts.checks.find((c) => c.id === id);

describe('persona fact checks — Marcus (design §3.4)', () => {
  it('all checks pass on the true corrected end-state', () => {
    const facts = runFacts();
    assert.equal(facts.ok, true, JSON.stringify(facts.checks, null, 2));
    assert.deepEqual(facts.checks.map((c) => c.id), [
      'persona-parsed-set-equality',
      'persona-correction-end-state:RDL01',
      'persona-retained-buffer-corrected',
      'persona-plan-state-facts',
    ]);
  });

  it('NEGATIVE CONTROL: durable rows still carrying the fat-finger 285 fail the correction check', () => {
    // The seeded wrong correction end-state (design §5, Slice 2b validation):
    // the correction never landed, so the RDL rows read 285 — the check MUST
    // fail, naming the forbidden weight, or it proves nothing.
    const wrong = EXPECTED_SETS.map((s) => (s.lift_code === 'RDL01' ? { ...s, weight: 285 } : s));
    const facts = runFacts({ durableLogRows: durableRows(wrong) });
    assert.equal(facts.ok, false);
    const corr = check(facts, 'persona-correction-end-state:RDL01');
    assert.equal(corr.ok, false);
    assert.match(corr.detail, /285/);
    assert.equal(check(facts, 'persona-parsed-set-equality').ok, false);
    // The buffer and plan-state surfaces are untouched by this mutation.
    assert.equal(check(facts, 'persona-retained-buffer-corrected').ok, true);
    assert.equal(check(facts, 'persona-plan-state-facts').ok, true);
  });

  it('a tampered bench row fails equality but leaves the correction check green', () => {
    const wrong = EXPECTED_SETS.map((s, ix) => (ix === 7 ? { ...s, weight: 230 } : s));
    const facts = runFacts({ durableLogRows: durableRows(wrong) });
    assert.equal(check(facts, 'persona-parsed-set-equality').ok, false);
    assert.match(check(facts, 'persona-parsed-set-equality').detail, /230/);
    assert.equal(check(facts, 'persona-correction-end-state:RDL01').ok, true);
  });

  it('a missing durable row fails equality, naming the missing set', () => {
    const facts = runFacts({ durableLogRows: durableRows(EXPECTED_SETS.slice(0, 12)) });
    const eq = check(facts, 'persona-parsed-set-equality');
    assert.equal(eq.ok, false);
    assert.match(eq.detail, /Romanian Deadlift 275x6@2/);
  });

  it('a buffer still carrying 285 fails the retained-buffer check even when the durable rows are correct', () => {
    // The two surfaces are independent evidence: a write-time repair must not
    // be able to impersonate an in-session correction.
    const staleBuffer = EXPECTED_SETS.map((s) => (s.lift_code === 'RDL01' ? { ...s, weight: 285 } : s));
    const facts = runFacts({ bufferSets: staleBuffer });
    assert.equal(check(facts, 'persona-retained-buffer-corrected').ok, false);
    assert.equal(check(facts, 'persona-correction-end-state:RDL01').ok, true);
    assert.equal(facts.ok, false);
  });

  it('plan-state fails when the client still reports remaining work', () => {
    const facts = runFacts({ observedRemaining: ['Bench Press'] });
    const ps = check(facts, 'persona-plan-state-facts');
    assert.equal(ps.ok, false);
    assert.match(ps.detail, /Bench Press/);
  });

  it('unmeasured surfaces fail closed, never pass', () => {
    const facts = runFacts({ bufferSets: null, observedRemaining: null });
    assert.equal(check(facts, 'persona-retained-buffer-corrected').ok, false);
    assert.match(check(facts, 'persona-retained-buffer-corrected').detail, /unproven/);
    assert.equal(check(facts, 'persona-plan-state-facts').ok, false);
    assert.match(check(facts, 'persona-plan-state-facts').detail, /unproven/);
    assert.equal(facts.ok, false);
  });

  it('a second correction end-state with the wrong set count fails on count alone', () => {
    const short = EXPECTED_SETS.filter((s, ix) => !(s.lift_code === 'RDL01' && ix === 12));
    const facts = runFacts({ durableLogRows: durableRows(short), expectedSets: short });
    const corr = check(facts, 'persona-correction-end-state:RDL01');
    assert.equal(corr.ok, false);
    assert.match(corr.detail, /2 durable RDL01 row\(s\), declared 3/);
  });
});
