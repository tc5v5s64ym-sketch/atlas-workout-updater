'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { enrichCoachFacts, buildLiveSetContext } = require('../services/liveIntelligence');

// 12-column Log_Cleaned row: date_clean | session_id | exercise | canonical_exercise |
// muscle_group | lift_code | set_number | weight | reps | rir | notes | volume_calc
function row(date, session, exercise, liftCode, weight, reps, rir = '') {
  return [date, session, exercise, exercise, 'Shoulders', liftCode, '1', String(weight), String(reps), String(rir), '', ''];
}

// ── pass-through cases ─────────────────────────────────────────────────────────

test('enrichCoachFacts: null facts → null pass-through', () => {
  assert.equal(enrichCoachFacts(null, []), null);
});

test('enrichCoachFacts: no liftCode → facts object returned unchanged', () => {
  const facts = { exerciseName: 'Lateral Raises', todaySets: [{ weight: 15, reps: 12 }] };
  const result = enrichCoachFacts(facts, []);
  assert.deepEqual(result, facts);
});

test('enrichCoachFacts: liftCode present but allLog not array → facts unchanged', () => {
  const facts = { liftCode: 'LRA01', todaySets: [] };
  const result = enrichCoachFacts(facts, null);
  assert.deepEqual(result, facts);
});

// ── rec signal enrichment ──────────────────────────────────────────────────────

test('enrichCoachFacts: rec.working_weight set after enrichment', () => {
  const liftCode = 'LRA01';
  const rows = [
    row('2026-04-01', 'S1', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-08', 'S2', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-15', 'S3', 'Lateral Raises', liftCode, 15, 12, 2),
  ];
  const facts = { liftCode, todaySets: [] };
  const result = enrichCoachFacts(facts, rows);
  assert.ok(result.rec, 'rec must be present');
  assert.notEqual(result.rec.working_weight, undefined, 'working_weight must be set');
});

test('enrichCoachFacts: attaches progression_history computed server-side (matches buildProgressionHistory)', () => {
  const { buildProgressionHistory } = require('../services/progressionHistory');
  const { normalizeLogRow } = require('../services/analytics');
  const liftCode = 'BPR01';
  // Two clean sessions at 205 after climbing 185 → 195 → 205.
  const rows = [
    row('2026-04-01', 'S1', 'Bench Press', liftCode, 185, 6, 2),
    row('2026-04-08', 'S2', 'Bench Press', liftCode, 195, 6, 2),
    row('2026-04-15', 'S3', 'Bench Press', liftCode, 205, 6, 2),
    row('2026-04-22', 'S4', 'Bench Press', liftCode, 205, 6, 2),
  ];
  const result = enrichCoachFacts({ liftCode, todaySets: [] }, rows);
  assert.ok(result.progression_history, 'progression_history must be attached');
  // It is computed from the SAME lift-restricted, normalized log — no client influence.
  const expected = buildProgressionHistory(rows.map(normalizeLogRow), liftCode);
  assert.deepEqual(result.progression_history, expected);
  // Sanity: the engine checkpoint rode through.
  assert.equal(result.progression_history.next_checkpoint.decision, 'hold');
  assert.equal(result.progression_history.consecutive_on_target, 2);
});

test('enrichCoachFacts: rec.trend set after enrichment', () => {
  const liftCode = 'BPR01';
  const rows = [
    row('2026-04-01', 'S1', 'Bench Press', liftCode, 185, 5, 2),
    row('2026-04-08', 'S2', 'Bench Press', liftCode, 190, 5, 2),
    row('2026-04-15', 'S3', 'Bench Press', liftCode, 195, 5, 2),
    row('2026-04-22', 'S4', 'Bench Press', liftCode, 200, 5, 2),
    row('2026-04-29', 'S5', 'Bench Press', liftCode, 205, 5, 2),
  ];
  const facts = { liftCode, todaySets: [] };
  const result = enrichCoachFacts(facts, rows);
  assert.ok(result.rec, 'rec must be present');
  assert.notEqual(result.rec.trend, undefined, 'trend must be set');
});

test('enrichCoachFacts: rec.readiness_signal set after enrichment', () => {
  const liftCode = 'BPR01';
  const rows = [
    row('2026-04-01', 'S1', 'Bench Press', liftCode, 185, 5, 2),
    row('2026-04-08', 'S2', 'Bench Press', liftCode, 190, 5, 2),
  ];
  const facts = { liftCode, todaySets: [] };
  const result = enrichCoachFacts(facts, rows);
  assert.ok(result.rec, 'rec must be present');
  assert.notEqual(result.rec.readiness_signal, undefined, 'readiness_signal must be set');
});

test('enrichCoachFacts: preserves client-forwarded rec fields', () => {
  const liftCode = 'LRA01';
  const rows = [row('2026-05-01', 'S1', 'Lateral Raises', liftCode, 15, 12, 2)];
  const clientRec = { recommendation: 'Keep it up!', next_target: { weight: 17.5, reps: 12, sets: 3 } };
  const facts = { liftCode, rec: clientRec, todaySets: [] };
  const result = enrichCoachFacts(facts, rows);
  assert.equal(result.rec.recommendation, 'Keep it up!');
  assert.deepEqual(result.rec.next_target, { weight: 17.5, reps: 12, sets: 3 });
});

test('buildLiveSetContext: client-supplied target RIR cannot grant an on-target register', () => {
  const liftCode = 'BPR01';
  const rows = [
    row('2026-04-01', 'S1', 'Bench Press', liftCode, 225, 6, 4),
    row('2026-04-08', 'S2', 'Bench Press', liftCode, 225, 6, 4),
  ];
  const ctx = buildLiveSetContext({
    liftCode,
    exerciseName: 'Bench Press',
    todaySets: [{ weight: 225, reps: 6, rir: 4 }],
    rec: { target_rir: 4 },
  }, rows);

  assert.equal(ctx.register, 'conservative_hold');
  assert.equal(ctx.progression_context.target_rir, null);
  assert.equal(ctx.progression_context.comparable_on_target_streak, null);
});

test('buildLiveSetContext: recovery context downgrades a server-targeted increase to hold', () => {
  const liftCode = 'BPR01';
  const rows = [
    row('2026-04-01', 'S1', 'Bench Press', liftCode, 225, 6, 2),
    row('2026-04-08', 'S2', 'Bench Press', liftCode, 225, 6, 2),
  ];
  const ctx = buildLiveSetContext({
    liftCode,
    exerciseName: 'Bench Press',
    intentId: 'recovery_pump',
    todaySets: [{ weight: 225, reps: 6, rir: 2 }],
  }, rows, {
    serverTargetRir: 2,
    progressionHistory: { next_checkpoint: { decision: 'load', clean_sessions: 3, required_sessions: 3, criterion_progress: '3 of 3 clean sessions at 225' } },
  });

  assert.equal(ctx.register, 'on_target_hold');
  assert.equal(ctx.progression_context.comparable_on_target_streak, 3);
  assert.equal(ctx.progression_context.next_action, 'prove_again');
});

test('buildLiveSetContext: repeated on-target work does not authorize load without the engine checkpoint', () => {
  const liftCode = 'BPR01';
  const rows = [
    row('2026-04-01', 'S1', 'Bench Press', liftCode, 225, 6, 2),
    row('2026-04-08', 'S2', 'Bench Press', liftCode, 225, 6, 2),
  ];
  const ctx = buildLiveSetContext({
    liftCode,
    exerciseName: 'Bench Press',
    todaySets: [{ weight: 225, reps: 6, rir: 2 }],
  }, rows, {
    serverTargetRir: 2,
    progressionHistory: { next_checkpoint: { decision: 'hold', clean_sessions: 2, required_sessions: 3, criterion_progress: '2 of 3 clean sessions at 225' } },
  });

  assert.equal(ctx.register, 'on_target_hold');
  assert.equal(ctx.progression_context.comparable_on_target_streak, 3);
  assert.equal(ctx.progression_context.engine_checkpoint_decision, 'hold');
  assert.equal(ctx.progression_context.next_action, 'prove_again');
});

test('buildLiveSetContext: load increase requires the engine-owned checkpoint decision', () => {
  const liftCode = 'BPR01';
  const rows = [
    row('2026-04-01', 'S1', 'Bench Press', liftCode, 225, 6, 2),
    row('2026-04-08', 'S2', 'Bench Press', liftCode, 225, 6, 2),
  ];
  const ctx = buildLiveSetContext({
    liftCode,
    exerciseName: 'Bench Press',
    todaySets: [{ weight: 225, reps: 6, rir: 2 }],
  }, rows, {
    serverTargetRir: 2,
    progressionHistory: { next_checkpoint: { decision: 'load', clean_sessions: 3, required_sessions: 3, criterion_progress: '3 of 3 clean sessions at 225' } },
  });

  assert.equal(ctx.register, 'on_target_increase');
  assert.equal(ctx.progression_context.engine_checkpoint_decision, 'load');
  assert.equal(ctx.progression_context.next_action, 'increase_load');
});

// ── deviation enrichment ───────────────────────────────────────────────────────

test('enrichCoachFacts: no todaySets → deviation is null', () => {
  const liftCode = 'LRA01';
  const rows = [
    row('2026-04-01', 'S1', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-08', 'S2', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-15', 'S3', 'Lateral Raises', liftCode, 15, 12, 2),
  ];
  const facts = { liftCode, todaySets: [] };
  const result = enrichCoachFacts(facts, rows);
  assert.equal(result.deviation, null, 'no todaySets means no deviation');
});

test('enrichCoachFacts: GOLDEN FIXTURE — above_expected deviation when reps >> history', () => {
  const liftCode = 'LRA01';
  // 5 sessions at 15 lb × 12 reps; median expected = 12
  const rows = [
    row('2026-04-01', 'S1', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-08', 'S2', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-15', 'S3', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-22', 'S4', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-29', 'S5', 'Lateral Raises', liftCode, 15, 12, 2),
  ];
  // Today: logged 20 reps at 15 lb — delta = +8 → above_expected / significant
  const facts = { liftCode, todaySets: [{ weight: 15, reps: 20, rir: 2 }] };
  const result = enrichCoachFacts(facts, rows);
  assert.ok(result.deviation, 'deviation must be present');
  assert.equal(result.deviation.verdict, 'above_expected');
  assert.equal(result.deviation.magnitude, 'significant');
});

test('enrichCoachFacts: GOLDEN FIXTURE — below_expected deviation when reps << history', () => {
  const liftCode = 'LRA01';
  const rows = [
    row('2026-04-01', 'S1', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-08', 'S2', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-15', 'S3', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-22', 'S4', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-29', 'S5', 'Lateral Raises', liftCode, 15, 12, 2),
  ];
  // Today: logged 5 reps at 15 lb — delta = -7 → below_expected / significant
  const facts = { liftCode, todaySets: [{ weight: 15, reps: 5, rir: 2 }] };
  const result = enrichCoachFacts(facts, rows);
  assert.ok(result.deviation, 'deviation must be present');
  assert.equal(result.deviation.verdict, 'below_expected');
  assert.equal(result.deviation.magnitude, 'significant');
});

test('enrichCoachFacts: deviation uses the highest-weight set when multiple todaySets present', () => {
  const liftCode = 'LRA01';
  const rows = [
    row('2026-04-01', 'S1', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-08', 'S2', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-15', 'S3', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-22', 'S4', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-29', 'S5', 'Lateral Raises', liftCode, 15, 12, 2),
  ];
  // Two sets today at different weights; 15 lb is the higher (history matched to 15 lb)
  const facts = {
    liftCode,
    todaySets: [
      { weight: 10, reps: 20, rir: 4 }, // warm-up
      { weight: 15, reps: 5,  rir: 2 }, // top set — below expected (delta = -7)
    ],
  };
  const result = enrichCoachFacts(facts, rows);
  assert.ok(result.deviation);
  assert.equal(result.deviation.verdict, 'below_expected', 'should use 15 lb top set, not 10 lb warm-up');
});

// ── evidence_context enrichment ────────────────────────────────────────────────

test('enrichCoachFacts: evidence_context present with enough history', () => {
  const liftCode = 'LRA01';
  const rows = [
    row('2026-04-01', 'S1', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-08', 'S2', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-15', 'S3', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-22', 'S4', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-29', 'S5', 'Lateral Raises', liftCode, 15, 12, 2),
  ];
  const facts = { liftCode, todaySets: [{ weight: 15, reps: 12, rir: 2 }] };
  const result = enrichCoachFacts(facts, rows);
  assert.ok(result.evidence_context, 'evidence_context should be present');
  assert.ok(['high', 'medium'].includes(result.evidence_context.confidence));
});

test('enrichCoachFacts: evidence_context null when no todaySets', () => {
  const liftCode = 'LRA01';
  const rows = [row('2026-04-01', 'S1', 'Lateral Raises', liftCode, 15, 12, 2)];
  const facts = { liftCode, todaySets: [] };
  const result = enrichCoachFacts(facts, rows);
  assert.equal(result.evidence_context, null);
});

// ── Step 376: cross-lift history contamination guard ────────────────────────────

test('step-376: a colliding liftCode never leaks a foreign lift\'s working range', () => {
  // Two genuinely different exercises share one liftCode (the live bug: Leg
  // Extension worked at 60 lb, but a foreign lift logged 150 under the same code).
  // The coach must see only Leg Extension's numbers, not the foreign 150 range.
  const liftCode = 'LEX01';
  const rows = [
    row('2026-04-01', 'S1', 'Leg Extension', liftCode, 60, 12, 2),
    row('2026-04-08', 'S2', 'Leg Extension', liftCode, 60, 12, 2),
    row('2026-04-15', 'S3', 'Leg Extension', liftCode, 60, 12, 2),
    row('2026-04-22', 'S4', 'Leg Extension', liftCode, 60, 12, 2),
    row('2026-04-29', 'S5', 'Leg Extension', liftCode, 60, 12, 2),
    // Foreign rows that wrongly carry the same liftCode:
    row('2026-04-02', 'F1', 'Leg Press', liftCode, 150, 10, 2),
    row('2026-04-09', 'F2', 'Leg Press', liftCode, 160, 10, 2),
    row('2026-04-16', 'F3', 'Leg Press', liftCode, 170, 10, 2),
  ];
  const facts = { liftCode, exerciseName: 'Leg Extension', todaySets: [{ weight: 60, reps: 12, rir: 2 }] };
  const result = enrichCoachFacts(facts, rows);
  assert.equal(result.evidence_context.benchmark, 60, 'benchmark must reflect Leg Extension (60), not the foreign 150–170 rows');
  assert.equal(result.rec.working_weight.weight, 60, 'working weight must come from the target lift only');
  assert.ok(result.rec.working_weight.weight < 100, 'foreign 150–170 history must not leak in');
});

test('step-376: contamination with an unidentifiable target lift suppresses the claim', () => {
  // The same liftCode covers two foreign lifts and today\'s exercise matches
  // neither stored name (cannot confidently isolate clean evidence). Rather than
  // cite foreign history, all same-code evidence is dropped → benchmark null.
  const liftCode = 'XYZ01';
  const rows = [
    row('2026-04-01', 'S1', 'Leg Press', liftCode, 150, 10, 2),
    row('2026-04-08', 'S2', 'Leg Press', liftCode, 160, 10, 2),
    row('2026-04-15', 'S3', 'Hack Squat', liftCode, 200, 8, 2),
    row('2026-04-22', 'S4', 'Hack Squat', liftCode, 210, 8, 2),
  ];
  const facts = { liftCode, exerciseName: 'Leg Extension', todaySets: [{ weight: 60, reps: 12, rir: 2 }] };
  const result = enrichCoachFacts(facts, rows);
  assert.equal(result.evidence_context, null, 'no clean same-lift evidence → no benchmark/deviation claim');
  assert.equal(result.rec.working_weight.weight, null, 'working weight suppressed when evidence is foreign');
});

test('step-376: clean single-exercise history is unchanged when exerciseName is supplied', () => {
  // No contamination (all rows are the same lift): supplying exerciseName must
  // NOT over-filter — the full benchmark still computes as before.
  const liftCode = 'LRA01';
  const rows = [
    row('2026-04-01', 'S1', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-08', 'S2', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-15', 'S3', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-22', 'S4', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-29', 'S5', 'Lateral Raises', liftCode, 15, 12, 2),
  ];
  const facts = { liftCode, exerciseName: 'Lateral Raise', todaySets: [{ weight: 15, reps: 12, rir: 2 }] };
  const result = enrichCoachFacts(facts, rows);
  assert.equal(result.evidence_context.benchmark, 15, 'clean history yields the full benchmark');
  assert.equal(result.rec.working_weight.weight, 15);
  assert.ok(['high', 'medium'].includes(result.evidence_context.confidence), 'all 5 sessions still counted');
});

test('step-376: name variants sharing a canonical liftCode are kept under contamination', () => {
  // "Lateral Raise" and "Lateral Raises" both map to LRA01 via the override table.
  // When a foreign lift contaminates the code, the plural/singular variants of the
  // real lift must survive (matched by canonicalLiftCodeFor), not be dropped.
  const liftCode = 'LRA01';
  const rows = [
    row('2026-04-01', 'S1', 'Lateral Raise',  liftCode, 15, 12, 2),
    row('2026-04-08', 'S2', 'Lateral Raises', liftCode, 15, 12, 2),
    row('2026-04-15', 'S3', 'Laterals',       liftCode, 15, 12, 2),
    // Foreign contamination under the same code:
    row('2026-04-20', 'F1', 'Leg Press',      liftCode, 200, 8, 2),
  ];
  const facts = { liftCode, exerciseName: 'Lateral Raise', todaySets: [{ weight: 15, reps: 12, rir: 2 }] };
  const result = enrichCoachFacts(facts, rows);
  assert.equal(result.evidence_context.benchmark, 15, 'all lateral-raise name variants kept; foreign 200 dropped');
  assert.equal(result.rec.working_weight.weight, 15);
});
