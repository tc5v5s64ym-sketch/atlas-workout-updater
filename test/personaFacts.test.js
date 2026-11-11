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
      // A null RIR lands as an empty cell, which the checker reads as
      // 'missing' — the same state the declaration's null maps to, so the
      // tuple matches. A non-numeric cell ('INVALID') reads as
      // 'malformed:<raw>' instead (#1663), so it can never match a missing
      // declaration.
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
    // The session's Modality_Log rows, modalityLogColumns order: the plank
    // timed hold at todaySec 40 — the measurable half of facts.plankPb.
    durableModalityRows: [plankModalityRow(40)],
    observedRemaining: [],
    bufferContext: 'after the final log turn',
    bufferNote: '(revised bench target in place, every other lift untouched)',
    ...over,
  });
}
// One Modality_Log row in modalityLogColumns order (date, session_id,
// modality, exercise, duration_sec, ...). A plank timed hold names the
// exercise Plank and carries the hold in duration_sec.
function plankModalityRow(durationSec) {
  return ['2026-07-10', SESSION, 'timed_hold', 'Plank', String(durationSec), '', '', '', '', '', '', ''];
}
function treadmillModalityRow(durationSec) {
  return ['2026-07-10', SESSION, 'cardio_steady', 'Treadmill', String(durationSec), '', '', '', '', '', '', ''];
}

describe('persona fact checks — Priya (no correction beat, revised bench target)', () => {
  it('all checks pass on the true revised end-state, in check order', () => {
    const facts = runPriyaFacts();
    assert.equal(facts.ok, true, JSON.stringify(facts.checks, null, 2));
    assert.deepEqual(facts.checks.map((c) => c.id), [
      'persona-parsed-set-equality',
      'persona-correction-end-state',
      'persona-bench-revised-target:DBB01',
      'persona-squat-hold:GSQ01',
      'persona-squat-hold-recommendation',
      'persona-plank-pb',
      'persona-retained-buffer-corrected',
      'persona-plan-state-facts',
    ]);
    assert.match(check(facts, 'persona-correction-end-state').detail, /no correction beat/);
    assert.match(check(facts, 'persona-bench-revised-target:DBB01').detail, /25x8 with no RIR recorded x3/);
    assert.match(check(facts, 'persona-squat-hold:GSQ01').detail, /weight stays 35/);
    assert.match(check(facts, 'persona-squat-hold-recommendation').detail, /human-judged/);
    assert.match(check(facts, 'persona-squat-hold-recommendation').detail, /hold stays 35 until all 3 sets sit at target RIR 2/);
    assert.match(check(facts, 'persona-plank-pb').detail, /40s/);
    assert.match(check(facts, 'persona-retained-buffer-corrected').detail, /after the final log turn/);
    assert.match(check(facts, 'persona-retained-buffer-corrected').detail, /revised bench target/);
  });

  it('the RIR-null bench sets match empty-RIR durable rows one-for-one (missing tuples)', () => {
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

  // ── #1663 (Astra P1/P2-5): every declared Priya expectation is judged ────
  // Failing-first: squatHold and plankPb have no automated consumer today,
  // and a malformed RIR cell passes as a missing one.

  it('the squat hold is judged: squat rows at the held 35 with set 3 off target RIR pass', () => {
    const hold = check(runPriyaFacts(), 'persona-squat-hold:GSQ01');
    assert.equal(hold.ok, true, hold.detail);
    assert.match(hold.detail, /weight stays 35/);
    assert.match(hold.detail, /RIRs: 2, 2, 1/);
  });

  it('the squat hold fails when the weight progressed past 35', () => {
    const progressed = PRIYA_SETS.map((s) => (s.lift_code === 'GSQ01' ? { ...s, weight: 40 } : s));
    const facts = runPriyaFacts({ durableLogRows: priyaDurableRows(progressed) });
    const hold = check(facts, 'persona-squat-hold:GSQ01');
    assert.equal(hold.ok, false);
    assert.match(hold.detail, /off the held end-state/);
  });

  it('the squat hold fails when every set sits at target RIR: the hold is not exercised', () => {
    // All three sets at RIR 2 means the progression condition is met — the
    // weight should move, so a hold claim on this run is vacuous.
    const allAtTarget = PRIYA_SETS.map((s) => (s.lift_code === 'GSQ01' ? { ...s, rir: 2 } : s));
    const facts = runPriyaFacts({
      expectedSets: allAtTarget, bufferSets: allAtTarget,
      durableLogRows: priyaDurableRows(allAtTarget),
    });
    const hold = check(facts, 'persona-squat-hold:GSQ01');
    assert.equal(hold.ok, false);
    assert.match(hold.detail, /hold is not exercised/);
  });

  it('the squat hold fails when a squat row carries no usable RIR', () => {
    const rows = priyaDurableRows(PRIYA_SETS);
    const squatRowIx = rows.findIndex((r) => r[5] === 'GSQ01');
    rows[squatRowIx][9] = '';
    const facts = runPriyaFacts({ durableLogRows: rows });
    const hold = check(facts, 'persona-squat-hold:GSQ01');
    assert.equal(hold.ok, false);
    assert.match(hold.detail, /no usable RIR/);
  });

  it('two plank rows fail the plank check on count alone', () => {
    const facts = runPriyaFacts({ durableModalityRows: [plankModalityRow(40), plankModalityRow(40)] });
    const pb = check(facts, 'persona-plank-pb');
    assert.equal(pb.ok, false);
    assert.match(pb.detail, /2 plank rows/);
  });

  it('a whitespace-only RIR cell reads as missing, never as a recorded 0', () => {
    const rows = priyaDurableRows(PRIYA_SETS);
    const benchRowIx = rows.findIndex((r) => r[5] === 'DBB01');
    rows[benchRowIx][9] = ' ';
    const facts = runPriyaFacts({ durableLogRows: rows });
    assert.equal(check(facts, 'persona-parsed-set-equality').ok, true);
    assert.equal(check(facts, 'persona-bench-revised-target:DBB01').ok, true);
  });

  // ── #1663 reopened (Astra re-audit 2026-11-07): the NEXT squat hold
  // recommendation is not judged. persona-squat-hold judges today's rows;
  // the recommendation is model prose, and the script declares no next
  // squat weight, so the smallest permitted closure is the plank-baseline
  // pattern: mark it human-judged and carry the hold rule on the emitted
  // review checklist, with a checker verdict enforcing both.

  it('NEGATIVE CONTROL (audit counterexample): the next squat hold recommendation is judged — an unmarked recommendation fails', () => {
    // Failing-first: before the fix there is no recommendation verdict at
    // all, so a coach reply of "Increase squat to 40 next time" over
    // 35x10x3 @2,2,1 passes silently. The unmarked fixture must fail.
    const unmarked = { ...PRIYA, facts: { ...PRIYA.facts, squatHold: { exercise: 'Goblet Squat', lift_code: 'GSQ01', weight: 35, sets: 3, reps: 10, targetRir: 2 } } };
    const facts = runPriyaFacts({ fixture: unmarked });
    const rec = check(facts, 'persona-squat-hold-recommendation');
    assert.ok(rec, 'no recommendation verdict — the gap reproduces');
    assert.equal(rec.ok, false);
    assert.match(rec.detail, /human-judged/);
    assert.equal(facts.ok, false);
  });

  it('a recommendation marked anything but human fails: the marking must name the judge', () => {
    // Collapse probe: 'human' and 'automated' must produce different
    // verdicts — a non-human marking is not a human-judged designation.
    const marked = { ...PRIYA, facts: { ...PRIYA.facts, squatHold: { ...PRIYA.facts.squatHold, nextRecommendationJudgedBy: 'automated' } } };
    const facts = runPriyaFacts({ fixture: marked });
    const rec = check(facts, 'persona-squat-hold-recommendation');
    assert.equal(rec.ok, false);
    assert.match(rec.detail, /not marked human-judged/);
  });

  it('a checklist with no squat-recommendation item fails: the closure requires the item on the emitted list', () => {
    const noItem = { ...PRIYA, reviewChecklist: PRIYA.reviewChecklist.filter((i) => !/next squat recommendation/i.test(i)) };
    const facts = runPriyaFacts({ fixture: noItem });
    const rec = check(facts, 'persona-squat-hold-recommendation');
    assert.equal(rec.ok, false);
    assert.match(rec.detail, /review checklist carries no item/);
    assert.equal(facts.ok, false);
  });

  it('a vague checklist item does not satisfy the closure: it must name the hold rule', () => {
    // Collapse probe: an item naming squat but not the next recommendation
    // or the hold rule must not pass — otherwise any squat mention would
    // satisfy the check.
    const vague = { ...PRIYA, reviewChecklist: [...PRIYA.reviewChecklist.filter((i) => !/next squat recommendation/i.test(i)), 'Check the squat form.'] };
    const facts = runPriyaFacts({ fixture: vague });
    const rec = check(facts, 'persona-squat-hold-recommendation');
    assert.equal(rec.ok, false);
    assert.match(rec.detail, /review checklist carries no item/);
  });

  it('Marcus emits no recommendation check: he declares no squat hold', () => {
    const facts = runFacts();
    assert.equal(check(facts, 'persona-squat-hold-recommendation'), undefined);
  });

  it('the plank PB is judged against the modality row: a 40s plank hold passes', () => {
    const pb = check(runPriyaFacts(), 'persona-plank-pb');
    assert.equal(pb.ok, true, pb.detail);
    assert.match(pb.detail, /40s/);
    assert.match(pb.detail, /human-judged/);
  });

  it('NEGATIVE CONTROL (audit counterexample): a 5-second treadmill row with no plank fails the plank check', () => {
    // The audit reproduced a condition-13 PASS with exactly this shape: the
    // modality observation retained only row_count, so a session-correlated
    // treadmill row stood in for the plank. The content check must fail it.
    const facts = runPriyaFacts({ durableModalityRows: [treadmillModalityRow(5)] });
    const pb = check(facts, 'persona-plank-pb');
    assert.equal(pb.ok, false);
    assert.match(pb.detail, /no plank row/);
    assert.match(pb.detail, /Treadmill 5s/);
    assert.equal(facts.ok, false);
  });

  it('a plank hold at the wrong duration fails the plank check', () => {
    const facts = runPriyaFacts({ durableModalityRows: [plankModalityRow(30)] });
    const pb = check(facts, 'persona-plank-pb');
    assert.equal(pb.ok, false);
    assert.match(pb.detail, /30s.*declared 40s|declared 40s.*30s/);
  });

  it('an unmeasured modality surface fails the plank check closed, never passes', () => {
    const facts = runPriyaFacts({ durableModalityRows: null });
    const pb = check(facts, 'persona-plank-pb');
    assert.equal(pb.ok, false);
    assert.match(pb.detail, /unproven/);
    assert.equal(facts.ok, false);
  });

  it('an unmarked previous-best baseline fails: it has no automated consumer', () => {
    // The 32s baseline is not in engine-visible history, so it cannot be
    // judged automatically — the fixture must mark it human-judged.
    const unmarked = { ...PRIYA, facts: { ...PRIYA.facts, plankPb: { previousBestSec: 32, todaySec: 40 } } };
    const facts = runPriyaFacts({ fixture: unmarked });
    const pb = check(facts, 'persona-plank-pb');
    assert.equal(pb.ok, false);
    assert.match(pb.detail, /human-judged/);
  });

  it('a declared PB that is not a PB fails on authoring consistency', () => {
    const notPb = { ...PRIYA, facts: { ...PRIYA.facts, plankPb: { previousBestSec: 45, todaySec: 40, previousBestJudgedBy: 'human' } } };
    const facts = runPriyaFacts({ fixture: notPb });
    const pb = check(facts, 'persona-plank-pb');
    assert.equal(pb.ok, false);
    assert.match(pb.detail, /not a PB/);
  });

  it("a malformed RIR 'INVALID' on a bench row fails equality and the revised-target check, naming it", () => {
    // Number('INVALID') is NaN, the same NaN a genuinely empty cell maps
    // to — so the old tuple passed a malformed cell as a missing one.
    const rows = priyaDurableRows(PRIYA_SETS);
    const benchRowIx = rows.findIndex((r) => r[5] === 'DBB01');
    rows[benchRowIx][9] = 'INVALID';
    const facts = runPriyaFacts({ durableLogRows: rows });
    const eq = check(facts, 'persona-parsed-set-equality');
    assert.equal(eq.ok, false);
    assert.match(eq.detail, /malformed 'INVALID'/);
    const bench = check(facts, 'persona-bench-revised-target:DBB01');
    assert.equal(bench.ok, false);
    assert.match(bench.detail, /malformed RIR 'INVALID'/);
    assert.equal(facts.ok, false);
  });

  it('a genuinely empty bench RIR cell still passes: missing is not malformed', () => {
    const facts = runPriyaFacts();
    assert.equal(check(facts, 'persona-parsed-set-equality').ok, true);
    assert.equal(check(facts, 'persona-bench-revised-target:DBB01').ok, true);
  });

  it('the default buffer wording still names the correction (Marcus path unchanged)', () => {
    const facts = runFacts();
    assert.match(check(facts, 'persona-retained-buffer-corrected').detail, /after the correction/);
    assert.match(check(facts, 'persona-retained-buffer-corrected').detail, /corrected weight in place/);
  });
});
