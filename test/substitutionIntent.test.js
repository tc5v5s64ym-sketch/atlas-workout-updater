'use strict';

// Golden fixtures for services/substitutionIntent.js
// Pure data — no I/O, no Sheets, no LLM.
// Each fixture reproduces a case from docs/SUBSTITUTION_SPEC.md or
// docs/COACH_VOICE_VALIDATION.md (Set B).
//
// Invariant: if the spec changes, update this file first.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classifySubstitution, OVERLAP_THRESHOLD } = require('../services/substitutionIntent');

// Minimal history shape — just needs to be a non-empty array.
const SOME_HISTORY = [{ weight: 135, reps: 8, rir: 2 }];

// ─── return shape ─────────────────────────────────────────────────────────────

describe('classifySubstitution — return shape', () => {
  it('always returns all required fields', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Leg Press' },
      history:    SOME_HISTORY,
    });
    assert.ok('classification'  in r, 'missing classification');
    assert.ok('decision'        in r, 'missing decision');
    assert.ok('reason_code'     in r, 'missing reason_code');
    assert.ok('prescribed'      in r, 'missing prescribed');
    assert.ok('logged'          in r, 'missing logged');
    assert.ok('muscle_overlap'  in r, 'missing muscle_overlap');
    assert.ok('evidence'        in r, 'missing evidence');
    assert.ok(Array.isArray(r.evidence), 'evidence must be array');
  });

  it('prescribed info includes name, lift_code, pattern, primary_muscles', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat', lift_code: 'SQ01' },
      logged:     { name: 'Leg Press' },
      history:    SOME_HISTORY,
    });
    assert.ok('name'            in r.prescribed);
    assert.ok('lift_code'       in r.prescribed);
    assert.ok('pattern'         in r.prescribed);
    assert.ok('primary_muscles' in r.prescribed);
    assert.strictEqual(r.prescribed.lift_code, 'SQ01');
  });

  it('muscle_overlap is a number in [0, 1]', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Leg Press' },
      history:    SOME_HISTORY,
    });
    assert.ok(typeof r.muscle_overlap === 'number');
    assert.ok(r.muscle_overlap >= 0 && r.muscle_overlap <= 1);
  });

  it('classification is one of the four valid values', () => {
    const valid = new Set(['preserved', 'changed', 'abandoned', 'baseline']);
    const r = classifySubstitution({ prescribed: { name: 'Back Squat' }, logged: { name: 'Leg Press' }, history: SOME_HISTORY });
    assert.ok(valid.has(r.classification), `unexpected classification: ${r.classification}`);
  });

  it('decision is approve or warn', () => {
    const r = classifySubstitution({ prescribed: { name: 'Back Squat' }, logged: { name: 'Leg Press' }, history: SOME_HISTORY });
    assert.ok(r.decision === 'approve' || r.decision === 'warn');
  });
});

// ─── baseline ────────────────────────────────────────────────────────────────

describe('baseline — no history', () => {
  it('null history → baseline / approve / no_history_calibration (spec B8)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Leg Press' },
      history:    null,
    });
    assert.strictEqual(r.classification, 'baseline');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'no_history_calibration');
  });

  it('undefined history → baseline', () => {
    const r = classifySubstitution({ prescribed: { name: 'Bench Press' }, logged: { name: 'Dips' } });
    assert.strictEqual(r.classification, 'baseline');
    assert.strictEqual(r.decision,       'approve');
  });

  it('empty array history → baseline', () => {
    const r = classifySubstitution({ prescribed: { name: 'Deadlift' }, logged: { name: 'Romanian Deadlift' }, history: [] });
    assert.strictEqual(r.classification, 'baseline');
    assert.strictEqual(r.decision,       'approve');
  });

  it('baseline evidence mentions calibration mode', () => {
    const r = classifySubstitution({ prescribed: { name: 'Back Squat' }, logged: { name: 'Leg Press' }, history: null });
    assert.ok(r.evidence.some(e => /calibration/i.test(e)), 'evidence must mention calibration');
  });
});

// ─── preserved — pattern + muscle match ──────────────────────────────────────

describe('preserved (pattern_and_muscle_match) — spec core examples', () => {
  it('Back Squat → Leg Press: same squat pattern, quads+glutes overlap (spec B1)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Leg Press' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'pattern_and_muscle_match');
    assert.ok(r.muscle_overlap >= OVERLAP_THRESHOLD);
  });

  it('Bench Press → Incline Dumbbell Press: horizontal_push, chest overlap (spec B2)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Bench Press' },
      logged:     { name: 'Incline Dumbbell Press' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'pattern_and_muscle_match');
    assert.ok(r.muscle_overlap >= OVERLAP_THRESHOLD);
  });

  it('Deadlift → Romanian Deadlift: hinge pattern, glutes+hamstrings overlap', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Deadlift' },
      logged:     { name: 'Romanian Deadlift' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'pattern_and_muscle_match');
  });

  it('Barbell Row → Seated Row: horizontal_pull, lats+upper_back overlap', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Barbell Row' },
      logged:     { name: 'Seated Row' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'pattern_and_muscle_match');
  });

  it('Lat Pulldown → Seated Row: shared pull region, lats overlap (cross-sub-pattern)', () => {
    // vertical_pull ≠ horizontal_pull (different sub-patterns) but both are 'pull'
    // broad region and both primarily train lats → preserved.
    const r = classifySubstitution({
      prescribed: { name: 'Lat Pulldown' },
      logged:     { name: 'Seated Row' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'pattern_and_muscle_match');
    assert.ok(r.muscle_overlap >= OVERLAP_THRESHOLD);
  });
});

// ─── changed — wrong muscle emphasis ─────────────────────────────────────────

describe('changed (wrong_muscle) — spec core examples', () => {
  it('Leg Curl → Leg Extension: same knee_isolation pattern, opposite muscle (spec B12)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Leg Curl' },
      logged:     { name: 'Leg Extension' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'changed');
    assert.strictEqual(r.decision,       'warn');
    assert.strictEqual(r.reason_code,    'wrong_muscle');
    assert.ok(r.muscle_overlap < OVERLAP_THRESHOLD);
  });

  it('Overhead Press → Bench Press: both push but delt→chest is wrong emphasis', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Overhead Press' },
      logged:     { name: 'Bench Press' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'changed');
    assert.strictEqual(r.decision,       'warn');
    assert.strictEqual(r.reason_code,    'wrong_muscle');
    assert.ok(r.muscle_overlap < OVERLAP_THRESHOLD);
  });
});

// ─── abandoned — different stimulus, no justification ────────────────────────

describe('abandoned (pattern_abandoned) — spec core examples', () => {
  it('Back Squat → Treadmill: lower→other, ~0 overlap, no constraint (spec B10)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Treadmill' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'abandoned');
    assert.strictEqual(r.decision,       'warn');
    assert.strictEqual(r.reason_code,    'pattern_abandoned');
  });

  it('Back Squat → Barbell Curl: lower→arm, ~0 overlap, no constraint', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Barbell Curl' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'abandoned');
    assert.strictEqual(r.decision,       'warn');
    assert.strictEqual(r.reason_code,    'pattern_abandoned');
  });

  it('Deadlift → Lateral Raise: hinge→delt, ~0 muscle overlap, no constraint (spec B20)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Deadlift' },
      logged:     { name: 'Lateral Raise' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'abandoned');
    assert.strictEqual(r.decision,       'warn');
    assert.strictEqual(r.reason_code,    'pattern_abandoned');
  });
});

// ─── cost/role gate — abandoned requires real training weight ─────────────────

describe('cost/role gate — low-cost accessory swaps are changed, not abandoned', () => {
  it('Lateral Raise → Treadmill: low-cost accessory, ~0 overlap → changed/accessory_swap', () => {
    // Lateral Raise: delt_isolation, low cost, accessory role.
    // Treadmill: unknown (pattern 'other'). Different stimulus, no justification,
    // but the dropped lift carried no real weight → changed (soft flag), not abandoned.
    const r = classifySubstitution({
      prescribed: { name: 'Lateral Raise' },
      logged:     { name: 'Treadmill' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'changed');
    assert.strictEqual(r.decision,       'warn');
    assert.strictEqual(r.reason_code,    'accessory_swap');
  });

  it('Bicep Curl → Leg Press: low-cost accessory dropped for unrelated work → changed/accessory_swap', () => {
    // Bicep Curl: arm_isolation, low cost, accessory. Leg Press: squat/lower.
    // No shared region, 0 overlap, no justification, accessory → changed.
    const r = classifySubstitution({
      prescribed: { name: 'Bicep Curl' },
      logged:     { name: 'Leg Press' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'changed');
    assert.strictEqual(r.reason_code,    'accessory_swap');
  });

  it('main/high-cost lift dropped for unrelated work stays abandoned (gate passes)', () => {
    // Back Squat is high cost → the gate is satisfied → abandoned.
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Treadmill' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'abandoned');
    assert.strictEqual(r.reason_code,    'pattern_abandoned');
  });

  it('medium-cost lift (Bench) dropped for unrelated work stays abandoned', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Bench Press' },
      logged:     { name: 'Leg Curl' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'abandoned');
    assert.strictEqual(r.reason_code,    'pattern_abandoned');
  });

  it('accessory_swap evidence names the chosen reason', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Lateral Raise' },
      logged:     { name: 'Treadmill' },
      history:    SOME_HISTORY,
    });
    assert.ok(r.evidence.some(e => /accessory_swap/.test(e)));
  });

  it('two unknown lifts (both pattern other, no muscles) → changed/accessory_swap', () => {
    // Unknown lifts default to low cost + secondary role (not main), so the gate
    // fails and they classify as a soft accessory_swap rather than abandoned.
    const r = classifySubstitution({
      prescribed: { name: 'ZZZ Unknown Exercise' },
      logged:     { name: 'ZZZ Other Unknown' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.classification, 'changed');
    assert.strictEqual(r.reason_code,    'accessory_swap');
  });
});

// ─── pain override ───────────────────────────────────────────────────────────

describe('pain redirect — spec override ordering', () => {
  it('OHP → Back Squat with painFlag: pain rescues the redirect (spec B3)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Overhead Press' },
      logged:     { name: 'Back Squat' },
      history:    SOME_HISTORY,
      painFlag:   true,
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'pain_redirect');
  });

  it('Deadlift → Bench Press with painFlag: lower-back pain redirects to push (spec B4)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Deadlift' },
      logged:     { name: 'Bench Press' },
      history:    SOME_HISTORY,
      painFlag:   true,
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'pain_redirect');
  });

  it('pain does not downgrade a genuine pattern+muscle match', () => {
    // Pain cannot condemn a good substitution — pattern+muscle match wins first.
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Leg Press' },
      history:    SOME_HISTORY,
      painFlag:   true,
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.reason_code,    'pattern_and_muscle_match');
  });

  it('pain absent: unjustified abandon stays warn (override ordering)', () => {
    // Feeling good or working hard is not a constraint — absence of pain
    // never upgrades an abandoned substitution.
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Treadmill' },
      history:    SOME_HISTORY,
      painFlag:   false,
    });
    assert.strictEqual(r.classification, 'abandoned');
    assert.strictEqual(r.decision,       'warn');
  });

  it('evidence mentions pain signal when painFlag is true', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Overhead Press' },
      logged:     { name: 'Back Squat' },
      history:    SOME_HISTORY,
      painFlag:   true,
    });
    assert.ok(r.evidence.some(e => /pain/i.test(e)), 'evidence must mention pain');
  });
});

// ─── constraint override ──────────────────────────────────────────────────────

describe('equipment constraint honored — spec override ordering', () => {
  it('injury constraint on cross-pattern redirect without pain → falls through to abandoned', () => {
    // Spec: constraint-justified redirect requires the substitute to "keep a defensible
    // portion of the intended muscle/pattern." OHP (vertical_push, front/side delts) →
    // Back Squat (squat, quads/glutes) has zero overlap and no shared region, so the
    // constraint falls through. Without painFlag the normal rules fire → abandoned.
    // For a true cross-pattern pain-justified redirect, use painFlag:true (pain_redirect).
    const constraints = [
      { kind: 'injury', target: 'overhead press', rule: 'avoid', note: 'shoulder impingement' },
    ];
    const r = classifySubstitution({
      prescribed:  { name: 'Overhead Press' },
      logged:      { name: 'Back Squat' },
      history:     SOME_HISTORY,
      constraints,
    });
    assert.strictEqual(r.classification, 'abandoned');
    assert.strictEqual(r.decision,       'warn');
  });

  it('injury constraint + defensible swap → equipment_constraint_honored', () => {
    // Wrist injury on barbell bench; user does Incline DB Press (same horizontal_push
    // pattern, chest overlap ≥ threshold). The constraint fires and upgrade is defensible.
    const constraints = [
      { kind: 'injury', target: 'bench', rule: 'avoid', note: 'wrist strain' },
    ];
    const r = classifySubstitution({
      prescribed:  { name: 'Bench Press' },
      logged:      { name: 'Incline Dumbbell Press' },
      history:     SOME_HISTORY,
      constraints,
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'equipment_constraint_honored');
  });

  it('Squat + equipment constraint (squat rack) → preserved', () => {
    const constraints = [
      { kind: 'equipment', target: 'squat rack', rule: 'avoid', note: 'rack occupied all session' },
    ];
    const r = classifySubstitution({
      prescribed:  { name: 'Back Squat' },
      logged:      { name: 'Leg Press' },
      history:     SOME_HISTORY,
      constraints,
    });
    // Constraint fires before pattern-match check; reason_code is equipment_constraint_honored.
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'equipment_constraint_honored');
  });

  it('Bench Press + equipment constraint → preserved (defensible swap)', () => {
    // Bench occupied; user did Dips instead (chest overlap in primary).
    // Dips: primary ['chest', 'triceps']; Bench: primary ['chest'].
    // Overlap = 1/1 = 1.0, shared horizontal_push pattern → defensible → constraint fires.
    const constraints = [
      { kind: 'equipment', target: 'bench', rule: 'avoid' },
    ];
    const r = classifySubstitution({
      prescribed:  { name: 'Bench Press' },
      logged:      { name: 'Dips' },
      history:     SOME_HISTORY,
      constraints,
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
  });

  it('unmatched constraint does not rescue an abandoned substitution', () => {
    // Constraint is for "deadlift" but prescription is "Bench Press" — no match.
    const constraints = [
      { kind: 'equipment', target: 'deadlift', rule: 'avoid' },
    ];
    const r = classifySubstitution({
      prescribed:  { name: 'Bench Press' },
      logged:      { name: 'Treadmill' },
      history:     SOME_HISTORY,
      constraints,
    });
    assert.strictEqual(r.classification, 'abandoned');
    assert.strictEqual(r.decision,       'warn');
  });

  it('evidence mentions constraint when a defensible constraint swap matched', () => {
    // Use a defensible swap (same squat pattern, good overlap) so the constraint branch
    // fires; non-defensible pairs fall through and evidence does not mention constraint.
    const constraints = [{ kind: 'equipment', target: 'squat', rule: 'avoid' }];
    const r = classifySubstitution({
      prescribed:  { name: 'Back Squat' },
      logged:      { name: 'Leg Press' },
      history:     SOME_HISTORY,
      constraints,
    });
    assert.strictEqual(r.reason_code, 'equipment_constraint_honored');
    assert.ok(r.evidence.some(e => /constraint/i.test(e)), 'evidence must mention constraint');
  });
});

// ─── threshold boundary ────────────────────────────────────────────────────────

describe(`threshold boundary (OVERLAP_THRESHOLD = ${OVERLAP_THRESHOLD})`, () => {
  it('OVERLAP_THRESHOLD is exported and equals 0.5', () => {
    assert.strictEqual(OVERLAP_THRESHOLD, 0.5);
  });

  it('overlap exactly at threshold (RDL → Leg Curl: 1/2 = 0.5) → preserved', () => {
    // Romanian Deadlift primary: ['hamstrings', 'glutes']
    // Leg Curl primary: ['hamstrings']
    // Overlap: hamstrings covered → 1/2 = 0.5 = OVERLAP_THRESHOLD → preserved
    const r = classifySubstitution({
      prescribed: { name: 'Romanian Deadlift' },
      logged:     { name: 'Leg Curl' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.muscle_overlap, 0.5);
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
  });

  it('overlap below threshold (Deadlift → Leg Curl: 1/3 ≈ 0.33) → changed (shared lower region)', () => {
    // Deadlift primary: ['glutes', 'hamstrings', 'lower_back']
    // Leg Curl primary: ['hamstrings']
    // Overlap: hamstrings covered → 1/3 ≈ 0.333 < 0.5
    // Both in 'lower' broad region → changed (not abandoned)
    const r = classifySubstitution({
      prescribed: { name: 'Deadlift' },
      logged:     { name: 'Leg Curl' },
      history:    SOME_HISTORY,
    });
    assert.ok(r.muscle_overlap < OVERLAP_THRESHOLD, `expected overlap < ${OVERLAP_THRESHOLD}, got ${r.muscle_overlap}`);
    assert.strictEqual(r.classification, 'changed');
    assert.strictEqual(r.decision,       'warn');
    assert.strictEqual(r.reason_code,    'wrong_muscle');
  });

  it('overlap = 0, no related region → abandoned (not changed)', () => {
    // Bench Press (push) → Leg Curl (lower): no shared broad region, 0 muscle overlap
    const r = classifySubstitution({
      prescribed: { name: 'Bench Press' },
      logged:     { name: 'Leg Curl' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.muscle_overlap, 0);
    assert.strictEqual(r.classification, 'abandoned');
    assert.strictEqual(r.decision,       'warn');
  });

  it('partial overlap above threshold with same pattern → preserved', () => {
    // Deadlift primary: ['glutes', 'hamstrings', 'lower_back']
    // RDL primary: ['hamstrings', 'glutes']
    // Overlap: {hamstrings, glutes} → 2/3 ≈ 0.667 ≥ 0.5 AND both hinge → preserved
    const r = classifySubstitution({
      prescribed: { name: 'Deadlift' },
      logged:     { name: 'Romanian Deadlift' },
      history:    SOME_HISTORY,
    });
    assert.ok(r.muscle_overlap >= OVERLAP_THRESHOLD);
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
  });
});

// ─── override ordering invariants ─────────────────────────────────────────────

describe('override ordering invariants', () => {
  it('pain present + good match: reason_code stays pattern_and_muscle_match (pain cannot condemn)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Leg Press' },
      history:    SOME_HISTORY,
      painFlag:   true,
    });
    // Pain cannot downgrade a genuine pattern+muscle match.
    assert.strictEqual(r.reason_code, 'pattern_and_muscle_match');
  });

  it('constraint present + good match: reason_code is equipment_constraint_honored (constraint beats pattern match)', () => {
    const r = classifySubstitution({
      prescribed:  { name: 'Back Squat' },
      logged:      { name: 'Leg Press' },
      history:     SOME_HISTORY,
      constraints: [{ kind: 'equipment', target: 'squat', rule: 'avoid' }],
    });
    // Constraint fires before Rule 2 (pattern match); reason_code is equipment_constraint_honored.
    assert.strictEqual(r.reason_code, 'equipment_constraint_honored');
  });

  it('constraint bypasses baseline: no history but constraint present → equipment_constraint_honored', () => {
    // Without a constraint, no history → baseline. With a matching constraint the engine
    // has deterministic knowledge to evaluate the swap; constraint fires before Rule 1.
    const r = classifySubstitution({
      prescribed:  { name: 'Deadlift' },
      logged:      { name: 'Romanian Deadlift' },
      history:     [],
      constraints: [{ kind: 'equipment', target: 'Deadlift', rule: 'substitute' }],
    });
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.decision,       'approve');
    assert.strictEqual(r.reason_code,    'equipment_constraint_honored');
  });

  it('pain absent + pattern match: still preserved (pain absence cannot condemn)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Bench Press' },
      logged:     { name: 'Incline Dumbbell Press' },
      history:    SOME_HISTORY,
      painFlag:   false,
    });
    assert.strictEqual(r.classification, 'preserved');
  });

  it('pain present + zero overlap + pattern mismatch: pain_redirect (not pattern_abandoned)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Overhead Press' },
      logged:     { name: 'Back Squat' },
      history:    SOME_HISTORY,
      painFlag:   true,
    });
    // Pain upgrades what would be abandoned → preserved
    assert.strictEqual(r.classification, 'preserved');
    assert.strictEqual(r.reason_code,    'pain_redirect');
    assert.notStrictEqual(r.reason_code, 'pattern_abandoned');
  });

  it('constraint absent: abandoned substitution stays warn regardless of effort', () => {
    // Feeling good / working hard is not a constraint — absence cannot excuse an abandon.
    const r = classifySubstitution({
      prescribed:  { name: 'Deadlift' },
      logged:      { name: 'Lateral Raise' },
      history:     SOME_HISTORY,
      constraints: [],
      painFlag:    false,
    });
    assert.strictEqual(r.classification, 'abandoned');
    assert.strictEqual(r.decision,       'warn');
  });
});

// ─── defensive / edge cases ───────────────────────────────────────────────────

describe('defensive inputs', () => {
  it('null prescribed and logged → returns a result without throwing', () => {
    assert.doesNotThrow(() => classifySubstitution({ prescribed: null, logged: null, history: SOME_HISTORY }));
  });

  it('missing names → gracefully resolves to some classification', () => {
    const r = classifySubstitution({ prescribed: {}, logged: {}, history: SOME_HISTORY });
    assert.ok(['preserved', 'changed', 'abandoned', 'baseline'].includes(r.classification));
  });

  it('constraints: null → treated as no constraints', () => {
    const r = classifySubstitution({
      prescribed:  { name: 'Back Squat' },
      logged:      { name: 'Treadmill' },
      history:     SOME_HISTORY,
      constraints: null,
    });
    assert.strictEqual(r.classification, 'abandoned');
  });

  it('constraints: non-array → treated as no constraints', () => {
    const r = classifySubstitution({
      prescribed:  { name: 'Back Squat' },
      logged:      { name: 'Treadmill' },
      history:     SOME_HISTORY,
      constraints: 'bad input',
    });
    assert.strictEqual(r.classification, 'abandoned');
  });

  it('lift_code is passed through on both prescribed and logged', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat', lift_code: 'SQ01' },
      logged:     { name: 'Leg Press',  lift_code: 'LP01' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.prescribed.lift_code, 'SQ01');
    assert.strictEqual(r.logged.lift_code,     'LP01');
  });

  it('prescribed pattern and primary_muscles are populated from engine', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Leg Press' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.prescribed.pattern, 'squat');
    assert.ok(Array.isArray(r.prescribed.primary_muscles));
    assert.ok(r.prescribed.primary_muscles.length > 0);
  });

  it('logged pattern and primary_muscles are populated from engine', () => {
    const r = classifySubstitution({
      prescribed: { name: 'Back Squat' },
      logged:     { name: 'Leg Press' },
      history:    SOME_HISTORY,
    });
    assert.strictEqual(r.logged.pattern, 'squat');
    assert.ok(r.logged.primary_muscles.includes('quads'));
  });

  it('unknown exercise name results in some classification (no throw)', () => {
    const r = classifySubstitution({
      prescribed: { name: 'ZZZ Unknown Exercise' },
      logged:     { name: 'ZZZ Other Unknown' },
      history:    SOME_HISTORY,
    });
    assert.ok(['preserved', 'changed', 'abandoned'].includes(r.classification));
  });
});
