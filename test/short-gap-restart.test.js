'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scoreIntents, shortGapRestartNote } = require('../services/analytics');

// Short-gap restart posture (owner-approved 2026-07-03, PR-3). A 3–6 day gap is
// below the layoff threshold (no detraining, no make-up-volume cap — those stay
// owner-gated at 7/14/28) but more than a rest day, so the coach frames the
// recommended TRAINING session as a clean restart. WORDING ONLY — it changes no
// prescribed number and touches no threshold.

// 12-column Log_Cleaned row (one row = one set) + a lift's sets across a date.
function row(date, session, name, muscle, code, weight, reps, set = '1', rir = '2') {
  return [date, session, name, name, muscle, code, String(set), String(weight), String(reps), String(rir), ''];
}
function sets(date, session, name, muscle, code, weight, reps, count) {
  return Array.from({ length: count }, (_, i) => row(date, session, name, muscle, code, weight, reps, i + 1));
}
// A mixed-compound history whose last session is a fixed date; the gap is set by
// the `today` passed to scoreIntents. Chosen so a primary training intent leads.
function history() {
  return [
    ...sets('2026-06-20', 'A', 'Bench Press', 'chest', 'BEN01', 185, 5, 3),
    ...sets('2026-06-20', 'A', 'Barbell Row', 'upper_back', 'ROW01', 155, 8, 3),
    ...sets('2026-06-24', 'B', 'Back Squat', 'quads', 'SQ01', 275, 5, 3),
    ...sets('2026-06-24', 'B', 'Overhead Press', 'front_delts', 'OHP01', 115, 6, 3),
    ...sets('2026-06-29', 'C', 'Bench Press', 'chest', 'BEN01', 190, 5, 3),
    ...sets('2026-06-29', 'C', 'Deadlift', 'hamstrings', 'DL01', 315, 5, 3),
  ];
}
const TRAINING = new Set(['build_strength', 'build_muscle', 'fix_blind_spots', 'balanced']);

// ── shortGapRestartNote — pure window guard (3–6 days) ──────────────────────
test('shortGapRestartNote: fires only in the 3–6 day window; the wording carries the gap', () => {
  assert.equal(shortGapRestartNote(2), null, '<3 days is still rest-day territory');
  assert.equal(shortGapRestartNote(3), 'Back after 3 days off — settle in with clean, controlled reps.');
  assert.equal(shortGapRestartNote(5), 'Back after 5 days off — settle in with clean, controlled reps.');
  assert.equal(shortGapRestartNote(6), 'Back after 6 days off — settle in with clean, controlled reps.');
  assert.equal(shortGapRestartNote(7), null, '>=7 days is the layoff path, not a short-gap restart');
  assert.equal(shortGapRestartNote(0), null);
  assert.equal(shortGapRestartNote(null), null);
  assert.equal(shortGapRestartNote(undefined), null);
  assert.equal(shortGapRestartNote(NaN), null);
});

// ── Integration: the recommended TRAINING session leads with the restart note ─
test('scoreIntents: a 3–6 day gap prepends the restart posture to the recommended training intent (wording only)', () => {
  const r = scoreIntents(history(), [], { today: '2026-07-04' });  // 5 days after the last session
  assert.equal(r.todays_read.days_since_last_session, 5, 'severity-independent gap is surfaced on todays_read');
  const top = r.intents.find(i => i.recommended);
  assert.ok(TRAINING.has(top.id), `a primary training intent leads this fixture (got ${top.id})`);
  assert.equal(top.why_today[0], 'Back after 5 days off — settle in with clean, controlled reps.',
    'the reentry note leads why_today, so the opener words it first');
  assert.ok((top.reason_codes || []).includes('short_gap_restart'), 'tagged for downstream surfaces');
  // WORDING ONLY — no make-up-volume cap at a sub-7-day gap (that stays 7/14/28).
  assert.ok(!(top.reason_codes || []).includes('returning_from_layoff'), 'not the layoff path');
  assert.ok((top.exercises || []).every(e => !e || e.readiness_note !== 'returning_from_layoff'),
    'no layoff volume cap applied — the prescribed numbers are untouched');
});

// ── Control: below 3 days (rest-day territory) — no restart note ─────────────
test('scoreIntents: a sub-3-day gap does NOT add the restart posture (but still surfaces the gap)', () => {
  const r = scoreIntents(history(), [], { today: '2026-06-30' });  // 1 day after
  assert.equal(r.todays_read.days_since_last_session, 1);
  assert.ok(r.intents.every(i => !(i.reason_codes || []).includes('short_gap_restart')),
    'no restart posture this soon');
  const top = r.intents.find(i => i.recommended);
  assert.doesNotMatch(top.why_today[0] || '', /Back after \d+ days off/, 'no reentry note one day out');
});

// ── Control: 7+ days is the layoff path, never the short-gap restart ─────────
test('scoreIntents: a 7+ day gap takes the layoff path, never the short-gap restart', () => {
  const r = scoreIntents(history(), [], { today: '2026-07-09' });  // 10 days after
  assert.equal(r.todays_read.days_since_last_session, 10);
  assert.ok(r.intents.every(i => !(i.reason_codes || []).includes('short_gap_restart')),
    'the restart posture is gated below 7 days');
  assert.ok(r.intents.some(i => (i.reason_codes || []).includes('returning_from_layoff')),
    'the layoff cap owns 7+ days');
});
