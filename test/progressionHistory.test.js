'use strict';

// buildProgressionHistory composes the EXISTING progression rules into four
// history-aware coaching facts — current verdict, previous verdict, consecutive
// on-target sessions, and the next engine-authorized progression checkpoint. These
// tests prove it reuses analytics.progressionVerdict/progressionBand and
// rules/progressionRules.holdUntilClean verbatim (no invented thresholds, no
// re-derived numbers) and passes the engine's decision through unchanged.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildProgressionHistory } = require('../services/progressionHistory');
const { progressionBand, progressionVerdict } = require('../services/analytics');
const { holdUntilClean } = require('../rules/progressionRules');

// Minimal normalized Log_Cleaned row (analytics.normalizeLogRow shape).
function row(date, session, weight, reps, rir) {
  return {
    date_clean: date, session_id: session, exercise: 'Back Squat',
    canonical_exercise: 'Back Squat', muscle_group: 'Quads', lift_code: 'SQ01',
    set_number: '1', weight, reps, rir, notes: '',
  };
}

// Four squat sessions: 185 → 195 → 205 (new ground) → 205 (held clean). Two clean
// sessions at the current load (205), so holdUntilClean holds at "2 of 3".
function squatHistory() {
  return [
    row('2026-06-01', 'S1', 185, 6, 2), row('2026-06-01', 'S1', 185, 6, 2),
    row('2026-06-08', 'S2', 195, 6, 2), row('2026-06-08', 'S2', 195, 6, 2),
    row('2026-06-15', 'S3', 205, 6, 2), row('2026-06-15', 'S3', 205, 6, 2),
    row('2026-06-22', 'S4', 205, 6, 2), row('2026-06-22', 'S4', 205, 6, 2),
  ];
}

describe('buildProgressionHistory — the four history-aware facts', () => {
  it('current + previous verdicts equal analytics.progressionVerdict on the same inputs (no re-derivation)', () => {
    const rows = squatHistory();
    const h = buildProgressionHistory(rows, 'SQ01');

    // Current: latest session (S4, top 205) vs the band EXCLUDING S4.
    const curExpected = progressionVerdict(205, progressionBand(rows, 'S4')).level;
    assert.equal(h.current_verdict, curExpected);
    assert.equal(h.current_verdict, 'in_pocket'); // 205 sits inside the 185–205 band

    // Previous: prior session (S3, top 205) vs the band of sessions BEFORE it (S1,S2).
    const priorRows = rows.filter(r => r.session_id === 'S1' || r.session_id === 'S2');
    const prevExpected = progressionVerdict(205, progressionBand(priorRows, null)).level;
    assert.equal(h.previous_verdict, prevExpected);
    assert.equal(h.previous_verdict, 'new_ground'); // 205 cleared the earlier 185–195 ceiling
  });

  it('consecutive on-target + next checkpoint come straight from holdUntilClean (engine decision, verbatim)', () => {
    const rows = squatHistory();
    const h = buildProgressionHistory(rows, 'SQ01');
    const hc = holdUntilClean(rows, 'SQ01');

    // The checkpoint decision is the ENGINE'S — passed through, never fabricated.
    assert.equal(h.next_checkpoint.decision, hc.decision);
    assert.equal(h.next_checkpoint.decision, 'hold');
    assert.equal(h.next_checkpoint.criterion_progress, hc.criterion_progress);
    assert.equal(h.next_checkpoint.criterion_progress, '2 of 3 clean sessions at 205');
    // The counts are parsed from the engine's own string — nothing invented.
    assert.equal(h.next_checkpoint.clean_sessions, 2);
    assert.equal(h.next_checkpoint.required_sessions, 3);
    assert.equal(h.next_checkpoint.load, 205);
    assert.equal(h.consecutive_on_target, 2, 'the on-target count is the engine clean-session count');
  });

  it('a met standard surfaces the engine LOAD decision (still never authorized here — just worded)', () => {
    // Three clean sessions at 205 → holdUntilClean authorizes the load.
    const rows = squatHistory().concat([
      row('2026-06-29', 'S5', 205, 6, 2), row('2026-06-29', 'S5', 205, 6, 2),
    ]);
    const h = buildProgressionHistory(rows, 'SQ01');
    const hc = holdUntilClean(rows, 'SQ01');
    assert.equal(hc.decision, 'load');
    assert.equal(h.next_checkpoint.decision, 'load', 'the engine decision is surfaced verbatim');
    assert.equal(h.consecutive_on_target, 3);
    assert.equal(h.next_checkpoint.required_sessions, 3);
  });

  it('a single session has no prior band: current + previous null, checkpoint still reads', () => {
    const rows = [row('2026-06-01', 'S1', 185, 6, 2), row('2026-06-01', 'S1', 185, 6, 2)];
    const h = buildProgressionHistory(rows, 'SQ01');
    assert.equal(h.current_verdict, null, 'no prior band to judge the only session against');
    assert.equal(h.previous_verdict, null, 'there is no previous session');
    assert.equal(h.next_checkpoint.decision, 'hold');
    assert.equal(h.consecutive_on_target, 1, '1 clean session logged so far at the load');
  });

  it('empty / unknown-lift / bad input → all-null (no throw, never fabricates)', () => {
    const allNull = { current_verdict: null, previous_verdict: null, consecutive_on_target: null, next_checkpoint: null };
    assert.deepEqual(buildProgressionHistory([], 'SQ01'), allNull);
    assert.deepEqual(buildProgressionHistory(squatHistory(), 'BP01'), allNull, 'no rows for the lift → no data');
    assert.deepEqual(buildProgressionHistory(null, 'SQ01'), allNull);
    assert.deepEqual(buildProgressionHistory(squatHistory(), ''), allNull);
  });

  it('every checkpoint number appears in holdUntilClean output — nothing is invented', () => {
    const rows = squatHistory();
    const h = buildProgressionHistory(rows, 'SQ01');
    const hc = holdUntilClean(rows, 'SQ01');
    // The parsed counts must be re-findable verbatim in the engine string it parsed.
    for (const n of [h.next_checkpoint.clean_sessions, h.next_checkpoint.required_sessions, h.next_checkpoint.load]) {
      assert.match(hc.criterion_progress, new RegExp(`\\b${n}\\b`), `${n} must come from the engine string`);
    }
  });
});
