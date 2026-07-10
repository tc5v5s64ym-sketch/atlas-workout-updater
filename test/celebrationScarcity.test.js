'use strict';

// Soul Plan PR-B3 — celebration scarcity golden tests.
//
// The module derives new-ground history by RUNNING THE LIVE HELPERS
// (progressionVerdict ∘ progressionBand from services/analytics.js) over
// chronological prefixes — these tests pin the derived scarcity semantics:
// back-to-back new-ground days spend the budget; a drought clears it;
// multi-lift same-day events count once per the cap's unit; thin/empty
// history is clear with a null last event; asOf is injected (no clock);
// rows after asOf are invisible; caps default from the PR-B2 calibration.

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeCelebrationScarcity } = require('../services/celebrationScarcity');
const CALIBRATION = require('../config/coaching/register.calibration.json');

// 12-col Log_Cleaned row.
function row(date, sessionId, lift, weight, { reps = 5, notes = '' } = {}) {
  return [date, sessionId, lift, lift, 'Chest', lift.slice(0, 3).toUpperCase() + '01', 1, weight, reps, 2, notes, weight * reps];
}

// A lift needs prior history before anything can read new_ground (the live
// verdict needs a band). NOTE: by the live semantics EVERY session that beats
// the prior ceiling is a new-ground event — so the base history must descend
// (200 then 190, ceiling 200) or it would contain events of its own.
const BASE = [
  row('2026-06-01', 'S1', 'Bench Press', 200),
  row('2026-06-04', 'S2', 'Bench Press', 190),
];

test('a new-ground day is detected with the live band semantics (strictly beats the prior ceiling)', () => {
  const rows = [...BASE, row('2026-06-08', 'S3', 'Bench Press', 205)];
  const out = computeCelebrationScarcity(rows, { asOf: '2026-06-08' });
  assert.deepEqual(out.last_new_ground, { lift: 'BEN01', date: '2026-06-08' });
  assert.equal(out.new_ground_last_7d, 1);
  assert.equal(out.scarcityClear, true, "the day's own event never spends the budget against itself");

  // Matching (not beating) the ceiling is NOT new ground — strictly greater, like the live verdict.
  const flat = computeCelebrationScarcity([...BASE, row('2026-06-08', 'S3', 'Bench Press', 200)], { asOf: '2026-06-08' });
  assert.equal(flat.last_new_ground, null);
});

test('back-to-back new-ground days: the second computes scarcityClear false (budget spent)', () => {
  const rows = [
    ...BASE,
    row('2026-06-08', 'S3', 'Bench Press', 205), // event 1
    row('2026-06-09', 'S4', 'Bench Press', 210), // event 2, next day
  ];
  const day1 = computeCelebrationScarcity(rows, { asOf: '2026-06-08' });
  assert.equal(day1.scarcityClear, true, 'the first event day is clear');
  const day2 = computeCelebrationScarcity(rows, { asOf: '2026-06-09' });
  assert.equal(day2.scarcityClear, false, 'yesterday spent the 1-per-7-days budget');
  assert.deepEqual(day2.last_new_ground, { lift: 'BEN01', date: '2026-06-09' });
  assert.equal(day2.new_ground_last_7d, 2);
});

test('a 30-day drought clears the budget', () => {
  const rows = [
    ...BASE,
    row('2026-06-08', 'S3', 'Bench Press', 205),
    row('2026-07-09', 'S4', 'Bench Press', 210),
  ];
  const out = computeCelebrationScarcity(rows, { asOf: '2026-07-09' });
  assert.equal(out.scarcityClear, true, 'the June event is far outside the rolling window');
  assert.equal(out.new_ground_last_7d, 1);
  assert.equal(out.new_ground_last_30d, 1, 'only the July event is inside 30d of asOf');
});

test('multi-lift same-day new grounds count once per the cap unit (one moment-day)', () => {
  const rows = [
    ...BASE,
    row('2026-06-01', 'S1', 'Back Squat', 250),
    row('2026-06-04', 'S2', 'Back Squat', 230),
    row('2026-06-08', 'S3', 'Bench Press', 205), // event
    row('2026-06-08', 'S3', 'Back Squat', 260),  // event, same day
    row('2026-06-10', 'S4', 'Bench Press', 215), // judged two days later
  ];
  const sameDay = computeCelebrationScarcity(rows.slice(0, -1), { asOf: '2026-06-08' });
  assert.equal(sameDay.new_ground_last_7d, 1, 'two same-day events are one event day');
  assert.equal(sameDay.scarcityClear, true, 'their own day never spends the budget');
  const later = computeCelebrationScarcity(rows, { asOf: '2026-06-10' });
  assert.equal(later.scarcityClear, false, 'the one prior moment-day spends the 1-unit budget');
});

test('empty / thin / invalid input → clear with null last event, never a throw', () => {
  for (const input of [[], null, undefined, [['garbage']], BASE.slice(0, 1)]) {
    const out = computeCelebrationScarcity(input, { asOf: '2026-07-01' });
    assert.deepEqual(out, {
      scarcityClear: true, last_new_ground: null, new_ground_last_7d: 0, new_ground_last_30d: 0,
    }, JSON.stringify(input));
  }
  // Missing asOf → the safe empty shape (no clock is ever read).
  assert.equal(computeCelebrationScarcity(BASE, {}).last_new_ground, null);
});

test('rows after asOf are invisible; warm-ups never create an event', () => {
  const future = computeCelebrationScarcity(
    [...BASE, row('2026-08-01', 'S9', 'Bench Press', 300)], { asOf: '2026-06-05' });
  assert.equal(future.last_new_ground, null, 'a future event does not exist yet');

  const warm = computeCelebrationScarcity(
    [...BASE, row('2026-06-08', 'S3', 'Bench Press', 245, { notes: 'warm-up' }),
      row('2026-06-08', 'S3', 'Bench Press', 188)],
    { asOf: '2026-06-08' });
  assert.equal(warm.last_new_ground, null, 'a tagged heavy warm-up is not new ground');
});

test('caps: override param wins; defaults come from the PR-B2 calibration', () => {
  assert.equal(CALIBRATION.profanity.cap.rolling_days, 7, 'default window is the owner cap');
  const rows = [
    ...BASE,
    row('2026-06-08', 'S3', 'Bench Press', 205),
    row('2026-06-09', 'S4', 'Bench Press', 210),
  ];
  // With a 2-per-window cap, yesterday's single event no longer spends it all.
  const loose = computeCelebrationScarcity(rows, { asOf: '2026-06-09', caps: { max_per_window: 2 } });
  assert.equal(loose.scarcityClear, true);
  // With a 1-day window, yesterday's event has already rolled out.
  const shortWin = computeCelebrationScarcity(rows, { asOf: '2026-06-10', caps: { rolling_days: 1 } });
  assert.equal(shortWin.scarcityClear, true);
});

test('blank session_id: grouping matches progressionBand (collapsed to one session), never diverges or throws', () => {
  // Malformed input — every real Log_Cleaned row carries a session_id. With blank
  // ids, our per-session grouping keys on '' exactly like progressionBand, so
  // blank-session rows collapse into ONE session instead of splitting by day.
  const blank = [
    row('2026-06-01', '', 'Bench Press', 200),
    row('2026-06-04', '', 'Bench Press', 190),
    row('2026-06-08', '', 'Bench Press', 205),
  ];
  const out = computeCelebrationScarcity(blank, { asOf: '2026-06-08' });
  // All three rows are one '' session → no prior session exists to form a band →
  // no new_ground event fires (matching how progressionBand sees this input).
  assert.equal(out.last_new_ground, null);
  assert.equal(out.scarcityClear, true);
});

test('determinism: same inputs, same output (pure, no hidden clock)', () => {
  const rows = [...BASE, row('2026-06-08', 'S3', 'Bench Press', 205)];
  assert.deepEqual(
    computeCelebrationScarcity(rows, { asOf: '2026-06-08' }),
    computeCelebrationScarcity(rows, { asOf: '2026-06-08' })
  );
});
