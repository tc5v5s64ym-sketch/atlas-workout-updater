'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { enrichCoachFacts } = require('../services/liveIntelligence');

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
