'use strict';

// Comparable-session selector (#1338, Corpus V2 §F.2) — nearest rep/RIR band,
// same fresh/fatigued context class, validity guards that return null instead
// of falling back to the most recent session.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { selectComparableSession, COMPARABLE_BANDS } = require('../services/comparableSessionSelector');

// Minimal normalized Log_Cleaned row (analytics.normalizeLogRow shape).
function row(date, session, weight, reps, rir, notes = '') {
  return {
    date_clean: date, session_id: session, exercise: 'Bench Press',
    canonical_exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BENCH',
    set_number: '1', weight, reps, rir, notes,
  };
}

// Today's working set, as the caller (recommendNextSet) holds it: the last
// working set of the current session.
function today(session, weight, reps, rir, date) {
  return { date_clean: date, session_id: session, weight, reps, rir, notes: '' };
}

describe('selectComparableSession — nearest band, same context class', () => {
  it('returns null when the only prior session is outside every band (P1 shape)', () => {
    const rows = [
      row('2026-05-10', 'S1', 135, 6, 5),
      row('2026-05-12', 'S2', 225, 6, 2),
    ];
    // 135x6 @RIR 5 vs 225x6 @RIR 2: same rep count, but 40% lighter by e1RM
    // and RIR 3 apart — no valid comparison, never the most recent by default.
    assert.equal(selectComparableSession(rows, 'BENCH', today('S2', 225, 6, 2, '2026-05-12')), null);
  });

  it('skips a different-band intervening session and returns the nearest-band one (P2 shape)', () => {
    const rows = [
      row('2026-05-01', 'S1', 225, 6, 2),
      row('2026-05-05', 'S2', 225, 10, 2),
      row('2026-05-08', 'S3', 225, 6, 2),
    ];
    const found = selectComparableSession(rows, 'BENCH', today('S3', 225, 6, 2, '2026-05-08'));
    assert.equal(found.session_id, 'S1');
    assert.deepEqual(found.distance, { reps: 0, rir: 0, e1rm_pct: 0 });
  });

  it('returns the most recent session when it is comparable (control)', () => {
    const rows = [
      row('2026-05-10', 'S1', 225, 5, 2),
      row('2026-05-12', 'S2', 235, 5, 3),
    ];
    const found = selectComparableSession(rows, 'BENCH', today('S2', 235, 5, 3, '2026-05-12'));
    assert.equal(found.session_id, 'S1');
  });

  it('excludes a deload session even when its numbers are in-band', () => {
    const rows = [
      row('2026-05-01', 'S0', 225, 6, 2),
      row('2026-05-03', 'S1', 225, 6, 2),
      // S2 tops 205 — 8.9% below the established 225 (engine deload rule: ≥7%)
      // — so it is a deload session, although 205x6 @RIR 3 sits inside the
      // rep/RIR/load bands of today's 225x6 @RIR 2.
      row('2026-05-05', 'S2', 205, 6, 3),
      row('2026-05-08', 'S3', 225, 6, 2),
    ];
    const found = selectComparableSession(rows, 'BENCH', today('S3', 225, 6, 2, '2026-05-08'));
    assert.equal(found.session_id, 'S1'); // the working session, not the nearer deload
  });

  it('excludes a re-entry session after a 14+ day gap', () => {
    const rows = [
      row('2026-05-01', 'S1', 225, 6, 2),
      // S2 is the first session after a 19-day gap: re-entry, not working.
      row('2026-05-20', 'S2', 225, 6, 2),
      row('2026-05-22', 'S3', 225, 6, 2),
    ];
    const found = selectComparableSession(rows, 'BENCH', today('S3', 225, 6, 2, '2026-05-22'));
    assert.equal(found.session_id, 'S1');
  });

  it('a deload today compares against deload priors (same class, symmetric)', () => {
    const rows = [
      row('2026-05-01', 'S0', 225, 6, 2),
      row('2026-05-03', 'S1', 225, 6, 2),
      row('2026-05-05', 'S2', 205, 6, 3), // deload (8.9% below 225)
      row('2026-05-08', 'S3', 200, 6, 3), // today: 11% below 225, also deload
    ];
    const found = selectComparableSession(rows, 'BENCH', today('S3', 200, 6, 3, '2026-05-08'));
    assert.equal(found.session_id, 'S2');
    assert.equal(found.context_class, 'deload');
  });

  it('skips a candidate with no recorded RIR', () => {
    const rows = [
      row('2026-05-01', 'S1', 225, 6, null),
      row('2026-05-05', 'S2', 225, 6, 2),
      row('2026-05-08', 'S3', 225, 6, 2),
    ];
    const found = selectComparableSession(rows, 'BENCH', today('S3', 225, 6, 2, '2026-05-08'));
    assert.equal(found.session_id, 'S2');
  });

  it('returns null when the only candidate has no recorded RIR', () => {
    const rows = [
      row('2026-05-10', 'S1', 225, 6, null),
      row('2026-05-12', 'S2', 225, 6, 2),
    ];
    assert.equal(selectComparableSession(rows, 'BENCH', today('S2', 225, 6, 2, '2026-05-12')), null);
  });

  it('nearest band beats recency on a tie of class', () => {
    const rows = [
      row('2026-05-01', 'S1', 225, 6, 2), // Δreps 0
      row('2026-05-05', 'S2', 225, 7, 2), // Δreps 1, more recent
      row('2026-05-08', 'S3', 225, 6, 2),
    ];
    const found = selectComparableSession(rows, 'BENCH', today('S3', 225, 6, 2, '2026-05-08'));
    assert.equal(found.session_id, 'S1');
  });

  it('warm-up-note rows never form a session', () => {
    const rows = [
      row('2026-05-01', 'S1', 225, 6, 2, 'warm-up'),
      row('2026-05-05', 'S2', 225, 6, 2),
      row('2026-05-08', 'S3', 225, 6, 2),
    ];
    const found = selectComparableSession(rows, 'BENCH', today('S3', 225, 6, 2, '2026-05-08'));
    assert.equal(found.session_id, 'S2');
  });

  it('returns null when there is no prior session at all', () => {
    const rows = [row('2026-05-12', 'S2', 225, 6, 2)];
    assert.equal(selectComparableSession(rows, 'BENCH', today('S2', 225, 6, 2, '2026-05-12')), null);
  });

  it('returns null when the current set has no RIR (comparability cannot be judged)', () => {
    const rows = [
      row('2026-05-10', 'S1', 225, 6, 2),
      row('2026-05-12', 'S2', 225, 6, null),
    ];
    assert.equal(selectComparableSession(rows, 'BENCH', today('S2', 225, 6, null, '2026-05-12')), null);
  });

  it('rep band: Δreps 2 is in, Δreps 3 is out', () => {
    const inBand = [
      row('2026-05-05', 'S1', 200, 8, 2),
      row('2026-05-08', 'S2', 225, 6, 2),
    ];
    // 200x8 e1RM 253 vs 225x6 e1RM 270: 6.3% apart — the corpus 6-vs-8 case.
    assert.equal(selectComparableSession(inBand, 'BENCH', today('S2', 225, 6, 2, '2026-05-08')).session_id, 'S1');
    const outBand = [
      row('2026-05-05', 'S1', 200, 9, 2),
      row('2026-05-08', 'S2', 225, 6, 2),
    ];
    assert.equal(selectComparableSession(outBand, 'BENCH', today('S2', 225, 6, 2, '2026-05-08')), null);
  });

  it('RIR band: ΔRIR 1 is in, ΔRIR 2 is out', () => {
    const inBand = [
      row('2026-05-05', 'S1', 225, 6, 3),
      row('2026-05-08', 'S2', 225, 6, 2),
    ];
    assert.equal(selectComparableSession(inBand, 'BENCH', today('S2', 225, 6, 2, '2026-05-08')).session_id, 'S1');
    const outBand = [
      row('2026-05-05', 'S1', 225, 6, 4),
      row('2026-05-08', 'S2', 225, 6, 2),
    ];
    assert.equal(selectComparableSession(outBand, 'BENCH', today('S2', 225, 6, 2, '2026-05-08')), null);
  });

  it('load band: e1RM within ±15% is in, beyond it is out', () => {
    const inBand = [
      row('2026-05-05', 'S1', 195, 6, 2), // e1RM 234 vs 270: 13.3% apart
      row('2026-05-08', 'S2', 225, 6, 2),
    ];
    assert.equal(selectComparableSession(inBand, 'BENCH', today('S2', 225, 6, 2, '2026-05-08')).session_id, 'S1');
    const outBand = [
      row('2026-05-05', 'S1', 190, 6, 2), // e1RM 228 vs 270: 15.6% apart
      row('2026-05-08', 'S2', 225, 6, 2),
    ];
    assert.equal(selectComparableSession(outBand, 'BENCH', today('S2', 225, 6, 2, '2026-05-08')), null);
  });

  it('exposes its bands (pinned, not silent)', () => {
    assert.deepEqual(COMPARABLE_BANDS, {
      maxRepDelta: 2, maxRirDelta: 1, maxE1rmDeltaPct: 15,
      deloadDropPct: 7, reentryGapDays: 14,
    });
  });
});
