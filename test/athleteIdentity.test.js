'use strict';

// PR-A7 — Athlete Identity Facts golden tests.
//
// Pure-module fixtures over buildAthleteIdentity: rich multi-year history, thin
// history (< 3 sessions → mostly-null, never fabricated), gap-heavy history, and
// single-lift history — plus the warm-up exclusion, the injected-asOf contract
// (no clock), and determinism.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAthleteIdentity } = require('../services/athleteIdentity');

// 12-col Log_Cleaned row:
// date_clean | session_id | exercise | canonical | muscle | lift_code | set# | weight | reps | rir | notes | volume
function row(date, sessionId, canonical, liftCode, weight, reps, { rir = 2, notes = '' } = {}) {
  return [date, sessionId, canonical, canonical, 'Chest', liftCode, 1, weight, reps, rir, notes, weight * reps];
}

const AS_OF = '2026-07-01';

const RICH_ROWS = [
  row('2025-03-14', 'S1', 'Bench Press', 'BEN01', 185, 5),
  row('2025-03-14', 'S1', 'Back Squat', 'SQT01', 225, 5),
  row('2025-05-30', 'S2', 'Bench Press', 'BEN01', 205, 5),
  row('2025-06-10', 'S3', 'Back Squat', 'SQT01', 245, 5),
  row('2026-05-20', 'S4', 'Bench Press', 'BEN01', 215, 4),
  row('2026-06-08', 'S5', 'Bench Press', 'BEN01', 225, 5),
  row('2026-06-22', 'S6', 'Bench Press', 'BEN01', 220, 6), // not a PR
  row('2026-06-22', 'S6', 'Back Squat', 'SQT01', 250, 3),
  row('2026-06-29', 'S7', 'Deadlift', 'DL01', 315, 5),
];

test('rich multi-year history: tenure, gaps, streak, PR progression, milestones', () => {
  const id = buildAthleteIdentity(RICH_ROWS, { asOf: AS_OF });

  assert.equal(id.first_session_date, '2025-03-14');
  assert.equal(id.tenure_months, 15, '2025-03-14 → 2026-07-01 is 15 whole months');
  assert.equal(id.days_since_last_session, 2, '2026-06-29 → 2026-07-01');
  assert.equal(id.longest_gap_days, 344, '2025-06-10 → 2026-05-20');

  // Consistency: sessions in the weeks of 06-22 and 06-29 → streak 2; window
  // (2026-05-07..07-01) holds 4 sessions → 0.5/week over 8 trailing weeks.
  assert.deepEqual(id.consistency, { current_weekly_streak: 2, sessions_per_week_8wk: 0.5 });

  // Bench PR events: 185 → 205 → 215 → 225. history keeps the LAST 3, in order.
  const bench = id.lift_prs['Bench Press'];
  assert.ok(bench, 'Bench Press must have a PR entry');
  assert.deepEqual(bench.history, [
    { weight: 205, reps: 5, date: '2025-05-30' },
    { weight: 215, reps: 4, date: '2026-05-20' },
    { weight: 225, reps: 5, date: '2026-06-08' },
  ]);
  assert.deepEqual(bench.current_best, { weight: 225, reps: 5, date: '2026-06-08' });

  // The 220×6 on 2026-06-22 beat nothing — it must not appear as a PR event.
  const benchDates = bench.history.map(h => h.date);
  assert.ok(!benchDates.includes('2026-06-22'), 'a non-PR set never enters PR history');

  // Milestones = PR events within 60 days of asOf (≥ 2026-05-02), newest first.
  assert.deepEqual(id.recent_milestones, [
    { exercise: 'Deadlift', weight: 315, reps: 5, date: '2026-06-29' },
    { exercise: 'Back Squat', weight: 250, reps: 3, date: '2026-06-22' },
    { exercise: 'Bench Press', weight: 225, reps: 5, date: '2026-06-08' },
    { exercise: 'Bench Press', weight: 215, reps: 4, date: '2026-05-20' },
  ]);
});

test('thin history (< 3 sessions): mostly-null object, never fabricated values', () => {
  const thin = [
    row('2026-06-20', 'S1', 'Bench Press', 'BEN01', 135, 10),
    row('2026-06-25', 'S2', 'Bench Press', 'BEN01', 155, 8),
  ];
  const id = buildAthleteIdentity(thin, { asOf: AS_OF });
  assert.equal(id.first_session_date, null);
  assert.equal(id.tenure_months, null);
  assert.equal(id.days_since_last_session, null);
  assert.equal(id.longest_gap_days, null);
  assert.equal(id.consistency, null);
  assert.deepEqual(id.lift_prs, {});
  assert.deepEqual(id.recent_milestones, []);
});

test('gap-heavy history: longest gap and days-since are real day counts', () => {
  const gappy = [
    row('2026-01-01', 'G1', 'Bench Press', 'BEN01', 135, 10),
    row('2026-01-03', 'G2', 'Bench Press', 'BEN01', 140, 10),
    row('2026-06-25', 'G3', 'Bench Press', 'BEN01', 145, 10),
  ];
  const id = buildAthleteIdentity(gappy, { asOf: AS_OF });
  assert.equal(id.longest_gap_days, 173, '2026-01-03 → 2026-06-25');
  assert.equal(id.days_since_last_session, 6);
  assert.equal(id.first_session_date, '2026-01-01');
});

test('single-lift history: one lift entry, consistency still present', () => {
  const single = [
    row('2026-06-01', 'L1', 'Overhead Press', 'OHP01', 95, 8),
    row('2026-06-08', 'L2', 'Overhead Press', 'OHP01', 100, 8),
    row('2026-06-15', 'L3', 'Overhead Press', 'OHP01', 105, 8),
  ];
  const id = buildAthleteIdentity(single, { asOf: AS_OF });
  assert.deepEqual(Object.keys(id.lift_prs), ['Overhead Press']);
  assert.deepEqual(id.lift_prs['Overhead Press'].current_best, { weight: 105, reps: 8, date: '2026-06-15' });
  assert.equal(id.lift_prs['Overhead Press'].history.length, 3);
  assert.ok(id.consistency && typeof id.consistency.current_weekly_streak === 'number');
});

test('warm-up sets never create a PR event or milestone, but still count as attendance', () => {
  const withWarmup = [
    row('2026-06-01', 'W1', 'Bench Press', 'BEN01', 185, 5),
    row('2026-06-08', 'W2', 'Bench Press', 'BEN01', 195, 5),
    // Heavier than every working set, but note-tagged as a warm-up.
    row('2026-06-15', 'W3', 'Bench Press', 'BEN01', 245, 3, { notes: 'warm-up' }),
    row('2026-06-15', 'W3', 'Bench Press', 'BEN01', 200, 5),
  ];
  const id = buildAthleteIdentity(withWarmup, { asOf: AS_OF });
  const bench = id.lift_prs['Bench Press'];
  assert.deepEqual(bench.current_best, { weight: 200, reps: 5, date: '2026-06-15' },
    'the tagged 245 warm-up must not register as the best');
  assert.ok(!bench.history.some(h => h.weight === 245), 'no PR event from a warm-up');
  assert.ok(!id.recent_milestones.some(m => m.weight === 245), 'no milestone from a warm-up');
  // The W3 session still counts toward attendance (3 distinct sessions → not thin).
  assert.equal(id.first_session_date, '2026-06-01');
});

test('asOf is injected, required, and rows after asOf are ignored — no clock, no future reads', () => {
  // Missing asOf → the safe mostly-null shape, never a fabricated "now".
  const none = buildAthleteIdentity(RICH_ROWS, {});
  assert.equal(none.first_session_date, null);
  assert.deepEqual(none.lift_prs, {});

  // A row dated after asOf must not exist from that vantage point.
  const withFuture = RICH_ROWS.concat([row('2026-08-01', 'F1', 'Bench Press', 'BEN01', 300, 1)]);
  const id = buildAthleteIdentity(withFuture, { asOf: AS_OF });
  assert.deepEqual(id.lift_prs['Bench Press'].current_best, { weight: 225, reps: 5, date: '2026-06-08' });

  // Deterministic: same inputs → deep-equal outputs (pure, no hidden clock).
  assert.deepEqual(
    buildAthleteIdentity(RICH_ROWS, { asOf: AS_OF }),
    buildAthleteIdentity(RICH_ROWS, { asOf: AS_OF })
  );
});

test('malformed input degrades to the mostly-null shape', () => {
  assert.deepEqual(buildAthleteIdentity(null, { asOf: AS_OF }).lift_prs, {});
  assert.deepEqual(buildAthleteIdentity([], { asOf: AS_OF }).lift_prs, {});
  assert.deepEqual(buildAthleteIdentity([['not-a-date', null]], { asOf: AS_OF }).lift_prs, {});
  assert.deepEqual(buildAthleteIdentity(RICH_ROWS, { asOf: 'garbage' }).lift_prs, {});
});
