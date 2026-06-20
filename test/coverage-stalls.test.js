'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { annotateStallsForDeload, COVERED_EFFECTIVE_SETS } = require('../services/coverageStalls');
const { scoreIntents } = require('../services/analytics');

// 12-column Log_Cleaned row. One row = one set.
function row(date, session, name, muscle, code, weight, reps, set = '1', rir = 2) {
  return [date, session, name, name, muscle, code, String(set), String(weight), String(reps), String(rir), ''];
}

// A lift's sets across N set-numbers on one date.
function sets(date, session, name, muscle, code, weight, reps, count) {
  return Array.from({ length: count }, (_, i) => row(date, session, name, muscle, code, weight, reps, i + 1));
}

function stall(liftCode, exercise, extra = {}) {
  return { liftCode, exercise, sessions_stalled: 3, last_best_weight: 100, ...extra };
}

/* ───────────────────────────────────────────────────────────────────────────
 * PR 2.1 golden fixtures (hand-computed). COVERED_EFFECTIVE_SETS defaults to 2.
 * Coverage window self-anchors to the latest log date, so fixed dates are
 * deterministic regardless of the wall clock.
 * ────────────────────────────────────────────────────────────────────────── */

test('sanity: the coverage threshold is the documented default', () => {
  assert.equal(COVERED_EFFECTIVE_SETS, 2);
});

test('fixture 1: Shrugs flat + traps covered by other lifts → ignored_for_deload', () => {
  // Deadlift gives traps 0.5/set (secondary). 6 deadlift sets → traps 3.0 eff. sets ≥ 2.
  const logRows = [
    ...sets('2026-06-10', 'S1', 'Shrugs', 'Traps', 'SHR01', 135, 12, 3),     // the stalled lift itself
    ...sets('2026-06-11', 'D1', 'Deadlift', 'Back', 'DL01', 405, 5, 3),       // traps coverage from elsewhere
    ...sets('2026-06-12', 'D2', 'Deadlift', 'Back', 'DL01', 405, 5, 3),
  ];
  const [out] = annotateStallsForDeload([stall('SHR01', 'Shrugs', { last_best_weight: 135 })], logRows);

  assert.equal(out.ignored_for_deload, true, 'a covered accessory stall must be downgraded');
  assert.match(out.ignored_reason, /traps/);
  assert.match(out.ignored_reason, /covered by other lifts/i);
  // Downgraded, not erased — the original stall fields survive.
  assert.equal(out.liftCode, 'SHR01');
  assert.equal(out.sessions_stalled, 3);
});

test('fixture 2: Shrugs flat + traps NOT covered → still flags', () => {
  const logRows = sets('2026-06-10', 'S1', 'Shrugs', 'Traps', 'SHR01', 135, 12, 3); // only the stalled lift
  const [out] = annotateStallsForDeload([stall('SHR01', 'Shrugs')], logRows);

  assert.equal(out.ignored_for_deload, false, 'an uncovered accessory stall keeps feeding');
  assert.equal(out.ignored_reason, null);
});

test('fixture 3: main lift flat, no coverage → still flags', () => {
  const logRows = sets('2026-06-10', 'S1', 'Back Squat', 'Quads', 'SQ01', 315, 5, 3);
  const [out] = annotateStallsForDeload([stall('SQ01', 'Back Squat')], logRows);

  assert.equal(out.ignored_for_deload, false, 'a main-lift stall always feeds');
});

/* ─── self-exclusion: a lift can't cover its own muscle ─────────────────────── */

test('a stalled accessory does NOT cover its own muscle (self-exclusion)', () => {
  // 8 Shrug sets alone would be 8.0 traps eff. sets — but the lift excludes itself,
  // so its own volume can never make it look "covered".
  const logRows = sets('2026-06-10', 'S1', 'Shrugs', 'Traps', 'SHR01', 135, 12, 8);
  const [out] = annotateStallsForDeload([stall('SHR01', 'Shrugs')], logRows);
  assert.equal(out.ignored_for_deload, false, 'self-volume must not count as coverage');
});

/* ─── multi-primary accessory: EVERY primary must be covered ────────────────── */

test('multi-primary accessory: feeds unless ALL primaries are covered', () => {
  // Hammer Curl → primary biceps + forearms. Cover biceps (Lat Pulldown, biceps
  // secondary 0.5/set × 6 = 3.0) but NOT forearms → not all covered → still flags.
  const bicepsOnly = [
    ...sets('2026-06-11', 'H1', 'Hammer Curl', 'Biceps', 'HC01', 35, 10, 3),
    ...sets('2026-06-11', 'P1', 'Lat Pulldown', 'Back', 'LPD01', 150, 10, 3),
    ...sets('2026-06-12', 'P2', 'Lat Pulldown', 'Back', 'LPD01', 150, 10, 3),
  ];
  const [a] = annotateStallsForDeload([stall('HC01', 'Hammer Curl')], bicepsOnly);
  assert.equal(a.ignored_for_deload, false, 'forearms uncovered → Hammer Curl still feeds');

  // Now also cover forearms (Deadlift, forearms secondary 0.5/set × 6 = 3.0) → ignored.
  const bothCovered = [
    ...bicepsOnly,
    ...sets('2026-06-11', 'D1', 'Deadlift', 'Back', 'DL01', 405, 5, 3),
    ...sets('2026-06-12', 'D2', 'Deadlift', 'Back', 'DL01', 405, 5, 3),
  ];
  const [b] = annotateStallsForDeload([stall('HC01', 'Hammer Curl')], bothCovered);
  assert.equal(b.ignored_for_deload, true, 'biceps + forearms both covered → downgraded');
});

/* ─── unknown / non-catalog accessory → safe default ───────────────────────── */

test('an accessory unknown to the coverage map keeps feeding (never guessed)', () => {
  // "Calf Raise" is an accessory by liftRole, but has no muscleCoverage pattern
  // → needsReview → must not be downgraded on a guess. (Tricep Pushdown is now
  // mapped to triceps, so it no longer serves as the "unknown" example.)
  const logRows = [
    ...sets('2026-06-11', 'B1', 'Bench Press', 'Chest', 'BP01', 225, 5, 6),
    ...sets('2026-06-12', 'B2', 'Bench Press', 'Chest', 'BP01', 225, 5, 6),
  ];
  const [out] = annotateStallsForDeload([stall('CR01', 'Calf Raise')], logRows);
  assert.equal(out.ignored_for_deload, false);
});

/* ─── empty / malformed inputs ─────────────────────────────────────────────── */

test('empty stalls or logRows are handled safely', () => {
  assert.deepEqual(annotateStallsForDeload([], []), []);
  assert.deepEqual(annotateStallsForDeload(null, []), []);
  const [out] = annotateStallsForDeload([stall('SHR01', 'Shrugs')], []);
  assert.equal(out.ignored_for_deload, false, 'no log → nothing covered → feeds');
});

test('does not mutate the input stall objects', () => {
  const input = stall('SHR01', 'Shrugs');
  annotateStallsForDeload([input], sets('2026-06-10', 'D', 'Deadlift', 'Back', 'DL01', 405, 5, 8));
  assert.ok(!('ignored_for_deload' in input), 'input stall must be left untouched');
});

/* ───────────────────────────────────────────────────────────────────────────
 * Behavioral payoff through the real scoreIntents() deload gate.
 * ────────────────────────────────────────────────────────────────────────── */

const TODAY = '2026-06-14'; // ~1 week after the last session → stalled lifts read as rested

function flat3(name, muscle, code, weight, reps) {
  return [
    row('2026-06-01', `${code}-1`, name, muscle, code, weight, reps),
    row('2026-06-04', `${code}-2`, name, muscle, code, weight, reps),
    row('2026-06-07', `${code}-3`, name, muscle, code, weight, reps),
  ];
}

test('scoreIntents: a covered accessory stall does NOT tip a lone main stall into a deload', () => {
  const rows = [
    ...flat3('Back Squat', 'Quads', 'SQ01', 315, 5),   // main stall — feeds (1)
    ...flat3('Shrugs', 'Traps', 'SHR01', 135, 12),     // accessory stall — traps covered ↓
    // Deadlift (not stalled: 2 sessions) covers traps from elsewhere: 6 sets × 0.5 = 3.0.
    ...sets('2026-06-04', 'DL-1', 'Deadlift', 'Back', 'DL01', 405, 5, 3),
    ...sets('2026-06-07', 'DL-2', 'Deadlift', 'Back', 'DL01', 405, 5, 3),
  ];
  const result = scoreIntents(rows, [], { today: TODAY });
  assert.equal(result.intents.find(i => i.id === 'deload_reset'), undefined,
    'Shrugs is downgraded (traps covered) → only the squat feeds → no whole-program deload');
});

test('scoreIntents: control — without the covering lift, the two stalls DO trigger a deload', () => {
  const rows = [
    ...flat3('Back Squat', 'Quads', 'SQ01', 315, 5),
    ...flat3('Shrugs', 'Traps', 'SHR01', 135, 12),     // traps now uncovered → feeds
  ];
  const result = scoreIntents(rows, [], { today: TODAY });
  assert.ok(result.intents.find(i => i.id === 'deload_reset'),
    'two uncovered stalls (one main, one accessory) still trigger a deload');
});
