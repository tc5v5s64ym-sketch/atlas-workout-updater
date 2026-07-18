'use strict';

// F10C — the leakage-safe IMPLICIT recommendation for an UNANNOUNCED exercise
// (services/implicitRecommendation.js). Pins the owner 7-point contract (design §4A):
// one next set only; an EXACT weight/reps/rir from PRE-session history or nothing; the
// current session (incl. the just-logged set) is excluded so it can never move its own
// target; the engine's rep/RIR RANGE is never collapsed; a blank prior value is never
// fabricated into 0; absent/ambiguous/range-only → no_reliable_target (no row).

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveImplicitRecommendation } = require('../services/implicitRecommendation');

// A prior working set (object row — normalizeLogRow reads either an array or object).
function row(session_id, date, over = {}) {
  return {
    date_clean: date, session_id, exercise: 'Cable Row', canonical_exercise: 'Cable Row',
    muscle_group: 'back', lift_code: 'CROW', set_number: 1, weight: 100, reps: 8, rir: 2,
    notes: '', volume_calc: 800, ...over,
  };
}

// Two prior-session working sets (session S_prior) — the trustworthy pre-session history.
const PRIOR = [row('S_prior', '2026-07-01'), row('S_prior', '2026-07-01', { set_number: 2 })];

test('reliable: engine load call + the exact prior reps & rir, exactly one set', () => {
  const r = deriveImplicitRecommendation({
    logRows: PRIOR, liftCode: 'CROW', exerciseName: 'Cable Row',
    currentSessionId: 'S_now', today: '2026-07-15',
  });
  assert.equal(r.confidence, 'reliable');
  assert.equal(r.target_set_count, 1, 'one next set only (rule 1)');
  assert.equal(r.target_reps, 8, 'the exact prior reps (never a range collapse)');
  assert.equal(r.target_rir, 2, 'the exact prior rir (never a range collapse)');
  assert.ok(Number.isFinite(r.target_weight) && r.target_weight > 0, 'an exact engine load');
  assert.equal(r.planned_lift_code, 'CROW');
});

test('LEAKAGE (rule 6): changing the just-submitted current set never changes the target', () => {
  const derive = (currentSet) => deriveImplicitRecommendation({
    logRows: [...PRIOR, currentSet], liftCode: 'CROW', exerciseName: 'Cable Row',
    currentSessionId: 'S_now', today: '2026-07-15',
  });
  const a = derive(row('S_now', '2026-07-15', { weight: 999, reps: 1, rir: 0 }));
  const b = derive(row('S_now', '2026-07-15', { weight: 50, reps: 20, rir: 4 }));
  const c = derive(row('S_now', '2026-07-15', { weight: 135, reps: 5, rir: 3 }));
  assert.deepEqual(a, b, 'a wild vs a light current set derive the SAME target');
  assert.deepEqual(b, c);
  assert.equal(a.confidence, 'reliable', 'and it is a real target, not a vacuous match');
});

test('the current session is EXCLUDED (rule 4): only-current-session history → no_reliable_target', () => {
  // The lift appears ONLY in the current session → no prior evidence → no target.
  const r = deriveImplicitRecommendation({
    logRows: [row('S_now', '2026-07-15', { weight: 200, reps: 5, rir: 1 })],
    liftCode: 'CROW', currentSessionId: 'S_now', today: '2026-07-15',
  });
  assert.equal(r.confidence, 'no_reliable_target');
  assert.equal(r.target_set_count, 1);
});

test('no prior history at all → no_reliable_target (never invents a target, rule 5)', () => {
  const r = deriveImplicitRecommendation({ logRows: [], liftCode: 'CROW', currentSessionId: 'S_now' });
  assert.equal(r.confidence, 'no_reliable_target');
});

test('a blank prior rir is NOT fabricated into 0 → no_reliable_target (rule 3)', () => {
  const r = deriveImplicitRecommendation({
    logRows: [row('S_prior', '2026-07-01', { rir: '' })],
    liftCode: 'CROW', currentSessionId: 'S_now', today: '2026-07-15',
  });
  assert.equal(r.confidence, 'no_reliable_target', 'a missing rir must not become rir:0');
});

test('no lift code → no_reliable_target', () => {
  const r = deriveImplicitRecommendation({ logRows: PRIOR, liftCode: '', currentSessionId: 'S_now' });
  assert.equal(r.confidence, 'no_reliable_target');
});
