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

  it('the forbidden weight is scoped to the corrected lift: squat back-offs AT 285 do not fail the RDL correction', () => {
    // The unrevised draw (top set read at target): back-offs stay at 285 —
    // the same number that is forbidden on the RDL. A session-wide ban would
    // fail this correct end-state on a coincidence (found by the artifact
    // control against run persona-marcus-20261030T002629-B6D931's own
    // declaration, whose draw was exactly this shape).
    const atTarget = EXPECTED_SETS.map((s) => (s.weight === 290 ? { ...s, weight: 285 } : s));
    const facts = runFacts({ expectedSets: atTarget, bufferSets: atTarget, durableLogRows: durableRows(atTarget) });
    assert.equal(facts.ok, true, JSON.stringify(facts.checks, null, 2));
    assert.equal(check(facts, 'persona-correction-end-state:RDL01').ok, true);
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

// ── Priya (Slice 2c fixture, scored slice under #1607) ───────────────────────
// No correction beat by design: the bench form-bail is a target revision,
// not a correction — so the correction check must pass informationally
// (not fail a correct run), and the bench end-state is judged by its own
// check: DBB01 durable rows exactly 25 x 8 x3 with NO RIR recorded.
const { buildPriyaDeclaration } = require('../tests/e2e/gate/persona-scenario');
const PRIYA = loadPersonaFixture('priya');
const PRIYA_SETS = buildPriyaDeclaration(PRIYA).expectedSets;
const PRIYA_NAMES = PRIYA_SETS.map((s) => s.exercise);
const PRIYA_MUSCLE = { GSQ01: 'Legs', DBB01: 'Chest', OAR01: 'Back' };
function priyaDurableRows(sets) {
  const perLift = {};
  return sets.map((s) => {
    perLift[s.lift_code] = (perLift[s.lift_code] || 0) + 1;
    return ['2026-07-10', SESSION, s.exercise, s.exercise, PRIYA_MUSCLE[s.lift_code], s.lift_code,
      String(perLift[s.lift_code]), String(s.weight), String(s.reps),
      // A null RIR lands as an empty cell, which the checker reads as NaN —
      // the same NaN the declaration's null maps to, so the tuple matches.
      s.rir === null || s.rir === undefined ? '' : String(s.rir), '', ''];
  });
}
function runPriyaFacts(over = {}) {
  return checkPersonaFacts({
    fixture: PRIYA,
    expectedSets: PRIYA_SETS,
    loggedNames: PRIYA_NAMES,
    bufferSets: PRIYA_SETS,
    durableLogRows: priyaDurableRows(PRIYA_SETS),
    observedRemaining: [],
    bufferContext: 'after the final log turn',
    bufferNote: '(revised bench target in place, every other lift untouched)',
    ...over,
  });
}

describe('persona fact checks — Priya (no correction beat, revised bench target)', () => {
  it('all checks pass on the true revised end-state, in check order', () => {
    const facts = runPriyaFacts();
    assert.equal(facts.ok, true, JSON.stringify(facts.checks, null, 2));
    assert.deepEqual(facts.checks.map((c) => c.id), [
      'persona-parsed-set-equality',
      'persona-correction-end-state',
      'persona-bench-revised-target:DBB01',
      'persona-retained-buffer-corrected',
      'persona-plan-state-facts',
    ]);
    assert.match(check(facts, 'persona-correction-end-state').detail, /no correction beat/);
    assert.match(check(facts, 'persona-bench-revised-target:DBB01').detail, /25x8 with no RIR recorded x3/);
    assert.match(check(facts, 'persona-retained-buffer-corrected').detail, /after the final log turn/);
    assert.match(check(facts, 'persona-retained-buffer-corrected').detail, /revised bench target/);
  });

  it('the RIR-null bench sets match empty-RIR durable rows one-for-one (NaN tuples)', () => {
    const facts = runPriyaFacts();
    assert.equal(check(facts, 'persona-parsed-set-equality').ok, true);
    assert.match(check(facts, 'persona-parsed-set-equality').detail, /9 durable Log_Cleaned rows/);
  });

  it('a correction beat with no declared end-state still fails (the authoring hole)', () => {
    const withBeat = {
      ...PRIYA,
      beats: [...PRIYA.beats, { id: 'x-correction', kind: 'correction', forms: ['Typo. 1.'], slots: {} }],
    };
    const facts = runPriyaFacts({ fixture: withBeat });
    assert.equal(check(facts, 'persona-correction-end-state').ok, false);
    assert.match(check(facts, 'persona-correction-end-state').detail, /must declare its end-state/);
    assert.equal(facts.ok, false);
  });

  it('bench rows at the unrevised 10s fail the revised-target check but leave equality to its own verdict', () => {
    const unrevised = PRIYA_SETS.map((s) => (s.lift_code === 'DBB01' ? { ...s, reps: 10 } : s));
    const facts = runPriyaFacts({ durableLogRows: priyaDurableRows(unrevised) });
    const bench = check(facts, 'persona-bench-revised-target:DBB01');
    assert.equal(bench.ok, false);
    assert.match(bench.detail, /off the revised end-state/);
  });

  it('a recorded RIR on a bench row fails the revised-target check: the bail states none', () => {
    const withRir = PRIYA_SETS.map((s) => (s.lift_code === 'DBB01' ? { ...s, rir: 2 } : s));
    const facts = runPriyaFacts({ durableLogRows: priyaDurableRows(withRir) });
    assert.equal(check(facts, 'persona-bench-revised-target:DBB01').ok, false);
  });

  it('two bench rows instead of three fail the revised-target check on count alone', () => {
    const short = PRIYA_SETS.filter((s, ix) => !(s.lift_code === 'DBB01' && ix === 5));
    const facts = runPriyaFacts({ durableLogRows: priyaDurableRows(short) });
    const bench = check(facts, 'persona-bench-revised-target:DBB01');
    assert.equal(bench.ok, false);
    assert.match(bench.detail, /2 durable DBB01 row\(s\), declared 3/);
  });

  it('the default buffer wording still names the correction (Marcus path unchanged)', () => {
    const facts = runFacts();
    assert.match(check(facts, 'persona-retained-buffer-corrected').detail, /after the correction/);
    assert.match(check(facts, 'persona-retained-buffer-corrected').detail, /corrected weight in place/);
  });
});
