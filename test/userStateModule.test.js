'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { buildUserState, _normalizeMuscle } = require('../services/userStateModule');

// Helpers — build minimal log entries in the 12-col Log_Cleaned shape.
function entry(overrides) {
  return {
    date_clean:          '2026-06-30',
    canonical_exercise:  'squat',
    muscle_group:        'quadriceps',
    weight:              100,
    reps:                5,
    rir:                 2,
    ...overrides,
  };
}

// Landmarks used in volume tests (from config/coaching/volume/landmarks.json):
//   quadriceps:       mev=8,  mav=12, mrv=20
//   pectoralis major: mev=8,  mav=12, mrv=20

const AS_OF = '2026-06-30';

// ─── _normalizeMuscle ────────────────────────────────────────────────────────

test('_normalizeMuscle: lowercases', () => {
  assert.strictEqual(_normalizeMuscle('Chest'), 'chest');
});

test('_normalizeMuscle: strips parenthetical qualifier', () => {
  assert.strictEqual(
    _normalizeMuscle('Quadriceps (rectus femoris, vastus medialis)'),
    'quadriceps',
  );
});

test('_normalizeMuscle: handles already-normalised input', () => {
  assert.strictEqual(_normalizeMuscle('quadriceps'), 'quadriceps');
});

// ─── buildUserState: invalid inputs ─────────────────────────────────────────

test('buildUserState: null → null', () => {
  assert.strictEqual(buildUserState(null, { asOf: AS_OF }), null);
});

test('buildUserState: non-array → null', () => {
  assert.strictEqual(buildUserState('log', { asOf: AS_OF }), null);
  assert.strictEqual(buildUserState(42,    { asOf: AS_OF }), null);
});

test('buildUserState: asOf missing → null', () => {
  assert.strictEqual(buildUserState([], {}), null);
  assert.strictEqual(buildUserState([]), null);
});

test('buildUserState: asOf invalid date → null', () => {
  assert.strictEqual(buildUserState([], { asOf: 'not-a-date' }), null);
});

// ─── buildUserState: empty input ─────────────────────────────────────────────

test('buildUserState: empty array → state with empty liftStates, muscleVolume, adherence', () => {
  const state = buildUserState([], { asOf: AS_OF });
  assert.deepEqual(state.liftStates,   {});
  assert.deepEqual(state.muscleVolume, {});
  assert.deepEqual(state.adherence,    { sessionsInWindow: 0, windowDays: 7, sessionsPerWeek: 0 });
  assert.strictEqual(state.asOf,       AS_OF);
  assert.strictEqual(state.windowDays, 7);
});

// ─── buildUserState: entry filtering ─────────────────────────────────────────

test('buildUserState: entries with null canonical_exercise are skipped', () => {
  const state = buildUserState(
    [entry({ canonical_exercise: null }),
     entry({ canonical_exercise: '' })],
    { asOf: AS_OF },
  );
  assert.deepEqual(state.liftStates, {});
});

test('buildUserState: entries with invalid date_clean are skipped', () => {
  const state = buildUserState(
    [entry({ date_clean: 'bad-date' }),
     entry({ date_clean: null })],
    { asOf: AS_OF },
  );
  assert.deepEqual(state.liftStates, {});
});

test('buildUserState: null/non-object entries are skipped', () => {
  const state = buildUserState([null, 42, 'oops', entry()], { asOf: AS_OF });
  assert.ok('squat' in state.liftStates);
  assert.strictEqual(Object.keys(state.liftStates).length, 1);
});

// ─── liftStates shape ────────────────────────────────────────────────────────

test('buildUserState: single entry produces liftState with correct shape', () => {
  const state = buildUserState([entry()], { asOf: AS_OF });
  const sq    = state.liftStates['squat'];
  assert.ok(sq, 'squat key present');
  assert.ok('e1rm'     in sq);
  assert.ok('pr'       in sq);
  assert.ok('staleness' in sq);
  assert.ok('current'        in sq.e1rm);
  assert.ok('trend'          in sq.e1rm);
  assert.ok('sessionsTracked' in sq.e1rm);
  assert.ok('bestE1rm'        in sq.pr);
  assert.ok('bestSetWeight'   in sq.pr);
  assert.ok('bestSetReps'     in sq.pr);
  assert.ok('daysSinceLastSession' in sq.staleness);
  assert.ok('lastSessionDate'      in sq.staleness);
});

// ─── e1RM estimation ─────────────────────────────────────────────────────────

test('buildUserState: reps > 20 do not contribute to e1RM but do track weight', () => {
  const state = buildUserState([entry({ reps: 25, weight: 60, rir: null })], { asOf: AS_OF });
  const sq    = state.liftStates['squat'];
  // e1RM estimation skipped (reps > 20), trend = insufficient_data
  assert.strictEqual(sq.e1rm.current,  null);
  assert.strictEqual(sq.e1rm.trend,    'insufficient_data');
  // Weight is still tracked for PR
  assert.strictEqual(sq.pr.bestSetWeight, 60);
});

test('buildUserState: weight = 0 entry does not contribute to PR', () => {
  const state = buildUserState([entry({ weight: 0 })], { asOf: AS_OF });
  const sq    = state.liftStates['squat'];
  assert.strictEqual(sq.pr.bestSetWeight, null);
  assert.strictEqual(sq.pr.bestE1rm,      null);
});

test('buildUserState: RIR-adjusted e1RM > plain Epley for same weight/reps', () => {
  // With rir=2 (2 reps in reserve), the adjusted e1RM should be higher
  // than plain Epley (which assumes the set was done close to failure).
  const withRir    = buildUserState([entry({ weight: 100, reps: 5, rir: 2 })], { asOf: AS_OF });
  const withoutRir = buildUserState([entry({ weight: 100, reps: 5, rir: null })], { asOf: AS_OF });
  const e1rmRir    = withRir.liftStates['squat'].e1rm.current;
  const e1rmPlain  = withoutRir.liftStates['squat'].e1rm.current;
  assert.ok(e1rmRir > e1rmPlain,
    `RIR-adjusted e1RM (${e1rmRir}) should be > plain (${e1rmPlain})`);
});

test('buildUserState: rir out of range (> 4) falls back to plain Epley', () => {
  const with5rir  = buildUserState([entry({ weight: 100, reps: 5, rir: 5 })], { asOf: AS_OF });
  const withoutRir = buildUserState([entry({ weight: 100, reps: 5, rir: null })], { asOf: AS_OF });
  // Should produce the same e1RM (both use plain Epley)
  assert.strictEqual(
    with5rir.liftStates['squat'].e1rm.current,
    withoutRir.liftStates['squat'].e1rm.current,
  );
});

// ─── PR tracking ─────────────────────────────────────────────────────────────

test('buildUserState: bestSetWeight is the heaviest weight across all entries', () => {
  const state = buildUserState([
    entry({ weight: 100, reps: 5 }),
    entry({ weight: 120, reps: 3, date_clean: '2026-06-25' }),
    entry({ weight: 80,  reps: 8, date_clean: '2026-06-20' }),
  ], { asOf: AS_OF });
  assert.strictEqual(state.liftStates['squat'].pr.bestSetWeight, 120);
  assert.strictEqual(state.liftStates['squat'].pr.bestSetReps,   3);
});

test('buildUserState: bestE1rm is the all-time best across all entries', () => {
  // 100 × 10 reps (Epley: 100 * (1 + 10/30) ≈ 133.33)
  // 110 × 3 reps  (Epley: 110 * (1 + 3/30) ≈ 121)
  const state = buildUserState([
    entry({ weight: 100, reps: 10, rir: null }),
    entry({ weight: 110, reps:  3, rir: null, date_clean: '2026-06-25' }),
  ], { asOf: AS_OF });
  const bestE1rm = state.liftStates['squat'].pr.bestE1rm;
  // 100 * (1 + 10/30) = 133.33 > 110 * (1 + 3/30) = 121
  assert.ok(bestE1rm > 130 && bestE1rm < 135, `bestE1rm ${bestE1rm} should be ~133`);
});

// ─── Staleness ───────────────────────────────────────────────────────────────

test('buildUserState: daysSinceLastSession = 0 when trained on asOf', () => {
  const state = buildUserState([entry({ date_clean: AS_OF })], { asOf: AS_OF });
  assert.strictEqual(state.liftStates['squat'].staleness.daysSinceLastSession, 0);
});

test('buildUserState: daysSinceLastSession counts days back from asOf', () => {
  const state = buildUserState([entry({ date_clean: '2026-06-27' })], { asOf: AS_OF });
  // 2026-06-30 − 2026-06-27 = 3 days
  assert.strictEqual(state.liftStates['squat'].staleness.daysSinceLastSession, 3);
});

test('buildUserState: lastSessionDate is the most recent date trained', () => {
  const state = buildUserState([
    entry({ date_clean: '2026-06-25' }),
    entry({ date_clean: '2026-06-28' }),
    entry({ date_clean: '2026-06-22' }),
  ], { asOf: AS_OF });
  assert.strictEqual(state.liftStates['squat'].staleness.lastSessionDate, '2026-06-28');
});

test('buildUserState: no valid entries for lift → staleness null', () => {
  // Entry with invalid date contributes nothing
  const state = buildUserState([entry({ date_clean: 'bad' })], { asOf: AS_OF });
  // Entry is filtered before adding to any lift
  assert.deepEqual(state.liftStates, {});
});

// ─── e1RM trend ──────────────────────────────────────────────────────────────

test('buildUserState: 1 session → trend = insufficient_data', () => {
  const state = buildUserState([
    entry({ date_clean: '2026-06-28', weight: 100, reps: 5, rir: null }),
    entry({ date_clean: '2026-06-28', weight: 105, reps: 5, rir: null }),
  ], { asOf: AS_OF });
  // Two rows but same date → one session
  assert.strictEqual(state.liftStates['squat'].e1rm.trend, 'insufficient_data');
  assert.strictEqual(state.liftStates['squat'].e1rm.sessionsTracked, 1);
});

test('buildUserState: 2 sessions improving (> 2 % e1RM increase)', () => {
  // Session 1: 100 × 5 (Epley: 116.67), Session 2: 105 × 5 (Epley: 122.50)
  // delta ≈ (122.5 − 116.67) / 116.67 ≈ 5 % → improving
  const state = buildUserState([
    entry({ date_clean: '2026-06-20', weight: 100, reps: 5, rir: null }),
    entry({ date_clean: '2026-06-27', weight: 105, reps: 5, rir: null }),
  ], { asOf: AS_OF });
  assert.strictEqual(state.liftStates['squat'].e1rm.trend, 'improving');
});

test('buildUserState: 2 sessions declining (> 2 % e1RM decrease)', () => {
  // Session 1: 105 × 5 (122.50), Session 2: 100 × 5 (116.67)
  // delta ≈ −5 % → declining
  const state = buildUserState([
    entry({ date_clean: '2026-06-20', weight: 105, reps: 5, rir: null }),
    entry({ date_clean: '2026-06-27', weight: 100, reps: 5, rir: null }),
  ], { asOf: AS_OF });
  assert.strictEqual(state.liftStates['squat'].e1rm.trend, 'declining');
});

test('buildUserState: 2 sessions within 2 % threshold → stalling', () => {
  // Session 1: 100 × 5 (116.67), Session 2: 101 × 5 (117.83)
  // delta ≈ 1 % < threshold → stalling
  const state = buildUserState([
    entry({ date_clean: '2026-06-20', weight: 100, reps: 5, rir: null }),
    entry({ date_clean: '2026-06-27', weight: 101, reps: 5, rir: null }),
  ], { asOf: AS_OF });
  assert.strictEqual(state.liftStates['squat'].e1rm.trend, 'stalling');
});

test('buildUserState: multiple sets same session → only best e1RM counts for trend', () => {
  // Two sets on the same date; only the best e1RM feeds the session average.
  const state = buildUserState([
    entry({ date_clean: '2026-06-20', weight: 80,  reps: 5, rir: null }), // e1rm~93
    entry({ date_clean: '2026-06-20', weight: 100, reps: 5, rir: null }), // e1rm~117
    entry({ date_clean: '2026-06-27', weight: 110, reps: 5, rir: null }), // e1rm~128
  ], { asOf: AS_OF });
  // Session 1 best e1rm ~117, Session 2 ~128 → improving
  assert.strictEqual(state.liftStates['squat'].e1rm.trend, 'improving');
  assert.strictEqual(state.liftStates['squat'].e1rm.sessionsTracked, 2);
});

test('buildUserState: trendSessions caps the look-back window', () => {
  // 4 sessions: 3 declining (early), 1 strongly recovering (latest).
  // With trendSessions=2 we only see the last 2 → improving.
  const entries = [
    entry({ date_clean: '2026-06-01', weight: 120, reps: 5, rir: null }),
    entry({ date_clean: '2026-06-08', weight: 110, reps: 5, rir: null }),
    entry({ date_clean: '2026-06-22', weight: 100, reps: 5, rir: null }),
    entry({ date_clean: '2026-06-29', weight: 115, reps: 5, rir: null }),
  ];
  const state = buildUserState(entries, { asOf: AS_OF, trendSessions: 2 });
  // Only last 2 sessions: 100 × 5 vs 115 × 5 → improving
  assert.strictEqual(state.liftStates['squat'].e1rm.trend, 'improving');
});

// ─── Multiple lifts ───────────────────────────────────────────────────────────

test('buildUserState: multiple lifts tracked independently', () => {
  const state = buildUserState([
    entry({ canonical_exercise: 'squat',     muscle_group: 'quadriceps', weight: 100 }),
    entry({ canonical_exercise: 'bench press', muscle_group: 'pectoralis major', weight: 80 }),
  ], { asOf: AS_OF });
  assert.ok('squat'       in state.liftStates);
  assert.ok('bench press' in state.liftStates);
  assert.strictEqual(Object.keys(state.liftStates).length, 2);
});

// ─── Muscle volume ────────────────────────────────────────────────────────────

test('buildUserState: sets in window counted per muscle', () => {
  const rows = Array.from({ length: 4 }, () =>
    entry({ date_clean: AS_OF, muscle_group: 'quadriceps' }),
  );
  const state = buildUserState(rows, { asOf: AS_OF });
  assert.strictEqual(state.muscleVolume['quadriceps'].weeklySets, 4);
});

test('buildUserState: sets outside window excluded from muscleVolume', () => {
  const state = buildUserState([
    entry({ date_clean: '2026-06-29', muscle_group: 'quadriceps' }), // in window
    entry({ date_clean: '2026-06-22', muscle_group: 'quadriceps' }), // boundary (asOf - 7 = 2026-06-23)
    entry({ date_clean: '2026-06-15', muscle_group: 'quadriceps' }), // outside
  ], { asOf: AS_OF, windowDays: 7 });
  // Only 2026-06-29 and 2026-06-23 are within [2026-06-23, 2026-06-30].
  // 2026-06-22 < 2026-06-23 → excluded.
  assert.strictEqual(state.muscleVolume['quadriceps'].weeklySets, 1);
});

test('buildUserState: muscle normalization — capitalised name matches landmark', () => {
  const rows = Array.from({ length: 9 }, () =>
    entry({ muscle_group: 'Quadriceps', date_clean: AS_OF }),
  );
  const state = buildUserState(rows, { asOf: AS_OF });
  // quadriceps mev=8, mav=12 → 9 sets → mev_to_mav zone
  assert.ok('quadriceps' in state.muscleVolume);
  assert.strictEqual(state.muscleVolume['quadriceps'].zone, 'mev_to_mav');
});

test('buildUserState: parenthetical muscle name normalises correctly', () => {
  const rows = Array.from({ length: 3 }, () =>
    entry({ muscle_group: 'Quadriceps (rectus femoris)', date_clean: AS_OF }),
  );
  const state = buildUserState(rows, { asOf: AS_OF });
  assert.ok('quadriceps' in state.muscleVolume);
});

test('buildUserState: known muscle gets zone + landmarks', () => {
  const rows = Array.from({ length: 10 }, () =>
    entry({ muscle_group: 'quadriceps', date_clean: AS_OF }),
  );
  const state = buildUserState(rows, { asOf: AS_OF });
  const v = state.muscleVolume['quadriceps'];
  assert.ok(['below_mev','mev_to_mav','mav_to_mrv','above_mrv'].includes(v.zone));
  assert.ok(v.landmarks && typeof v.landmarks.mev === 'number');
});

test('buildUserState: unknown muscle gets null zone but tracks set count', () => {
  const state = buildUserState([
    entry({ muscle_group: 'unknown muscle group', date_clean: AS_OF }),
    entry({ muscle_group: 'unknown muscle group', date_clean: AS_OF }),
  ], { asOf: AS_OF });
  const v = state.muscleVolume['unknown muscle group'];
  assert.ok(v, 'key present');
  assert.strictEqual(v.weeklySets, 2);
  assert.strictEqual(v.zone,      null);
  assert.strictEqual(v.landmarks, null);
});

// ─── Adherence ───────────────────────────────────────────────────────────────

test('buildUserState: sessionsInWindow counts distinct dates in window', () => {
  const state = buildUserState([
    entry({ date_clean: '2026-06-28' }),
    entry({ date_clean: '2026-06-28' }), // same date = same session
    entry({ date_clean: '2026-06-29' }),
    entry({ date_clean: '2026-06-30' }),
  ], { asOf: AS_OF });
  assert.strictEqual(state.adherence.sessionsInWindow, 3);
});

test('buildUserState: sessions outside window excluded from adherence', () => {
  const state = buildUserState([
    entry({ date_clean: '2026-06-30' }), // in
    entry({ date_clean: '2026-06-10' }), // out
  ], { asOf: AS_OF, windowDays: 7 });
  assert.strictEqual(state.adherence.sessionsInWindow, 1);
});

test('buildUserState: sessionsPerWeek = sessions / windowDays * 7', () => {
  const state = buildUserState([
    entry({ date_clean: '2026-06-24' }),
    entry({ date_clean: '2026-06-27' }),
    entry({ date_clean: '2026-06-30' }),
  ], { asOf: AS_OF, windowDays: 7 });
  // 3 sessions in 7 days → 3/7*7 = 3.0
  assert.strictEqual(state.adherence.sessionsPerWeek, 3);
});

test('buildUserState: windowDays = 14 adjusts sessionsPerWeek', () => {
  const state = buildUserState([
    entry({ date_clean: '2026-06-24' }),
    entry({ date_clean: '2026-06-28' }),
  ], { asOf: AS_OF, windowDays: 14 });
  // 2 sessions in 14 days → 2/14*7 = 1.0
  assert.strictEqual(state.adherence.sessionsPerWeek, 1);
});

test('buildUserState: different exercises same date = one adherence session', () => {
  const state = buildUserState([
    entry({ canonical_exercise: 'squat',      date_clean: AS_OF }),
    entry({ canonical_exercise: 'bench press', date_clean: AS_OF }),
  ], { asOf: AS_OF });
  assert.strictEqual(state.adherence.sessionsInWindow, 1);
});

// ─── Default options ──────────────────────────────────────────────────────────

test('buildUserState: windowDays defaults to 7', () => {
  const state = buildUserState([], { asOf: AS_OF });
  assert.strictEqual(state.windowDays, 7);
});

test('buildUserState: invalid windowDays falls back to 7', () => {
  assert.strictEqual(buildUserState([], { asOf: AS_OF, windowDays: 0    }).windowDays, 7);
  assert.strictEqual(buildUserState([], { asOf: AS_OF, windowDays: -1   }).windowDays, 7);
  assert.strictEqual(buildUserState([], { asOf: AS_OF, windowDays: 'x'  }).windowDays, 7);
});

test('buildUserState: trendSessions < 2 falls back to 5', () => {
  // With only 2 sessions present, trendSessions=1 → falls back to 5, uses both.
  const state = buildUserState([
    entry({ date_clean: '2026-06-20', weight: 100, reps: 5, rir: null }),
    entry({ date_clean: '2026-06-27', weight: 105, reps: 5, rir: null }),
  ], { asOf: AS_OF, trendSessions: 1 });
  // Both sessions still visible (default 5 >= 2 sessions available)
  assert.strictEqual(state.liftStates['squat'].e1rm.sessionsTracked, 2);
  assert.strictEqual(state.liftStates['squat'].e1rm.trend, 'improving');
});
