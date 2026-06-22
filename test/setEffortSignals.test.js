'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeSetSequence,
  assessNextMoveConflict,
  EFFORT_REASON_CODES,
} = require('../services/setEffortSignals');

// Sets are written as [weight, reps, rir] for readability (the module also accepts
// parser objects {weight, reps, rir}).

// ---------------------------------------------------------------------------
// Fixture 1 — warmup/feeder high-RIR sets are NOT sandbagging.
// ---------------------------------------------------------------------------
test('setEffortSignals: bench_warmup_high_rir_not_sandbagging', () => {
  const a = analyzeSetSequence(
    [[135, 10, 5], [185, 10, 2], [235, 6, 2]],
    { exerciseName: 'Bench Press' }
  );
  // 135 @ RIR 5 is early, light (<85% of 235), high RIR → warmup/feeder, ignored.
  assert.deepEqual(a.set_classes, ['warmup_feeder', 'work', 'work']);
  assert.ok(a.reason_codes.includes(EFFORT_REASON_CODES.WARMUP_FEEDER_IGNORED));
  // No high-RIR callout: 185/235 @ RIR 2 are on target, warmup is excluded.
  assert.equal(a.signals.high_rir_workset_underdosed, false);
  assert.equal(a.signals.redline_set, false);
  assert.equal(a.signals.pressing_readiness_yellow, false);
  assert.equal(a.progression_verdict, 'neutral');
});

// ---------------------------------------------------------------------------
// Fixture 2 — RIR 0 redline + same-load rep drop blocks pressing progression.
// ---------------------------------------------------------------------------
test('setEffortSignals: bench_redline_rep_drop_blocks_progression', () => {
  const a = analyzeSetSequence(
    [[135, 10, 5], [185, 10, 2], [235, 6, 2], [235, 6, 0], [235, 4, 1]],
    { exerciseName: 'Bench Press' }
  );
  assert.equal(a.signals.redline_set, true);          // 235 x6 @0
  assert.equal(a.signals.rep_drop_after_redline, true); // 235 x4 after the redline
  assert.equal(a.signals.pressing_readiness_yellow, true); // compound press → yellow
  assert.equal(a.blocks_progression, true);
  assert.equal(a.progression_verdict, 'block');
  for (const rc of [
    EFFORT_REASON_CODES.WARMUP_FEEDER_IGNORED,
    EFFORT_REASON_CODES.REDLINE_SET,
    EFFORT_REASON_CODES.REP_DROP_AFTER_REDLINE,
    EFFORT_REASON_CODES.PRESSING_READINESS_YELLOW,
  ]) {
    assert.ok(a.reason_codes.includes(rc), `expected reason code ${rc}`);
  }
});

test('setEffortSignals: repeated redline on the same load is flagged', () => {
  const a = analyzeSetSequence(
    [[235, 5, 0], [235, 4, 0]],
    { exerciseName: 'Bench Press' }
  );
  assert.equal(a.signals.redline_set, true);
  assert.equal(a.signals.repeated_redline, true);
  // A single redline set is not "repeated".
  const single = analyzeSetSequence([[225, 5, 0]], { exerciseName: 'Bench Press' });
  assert.equal(single.signals.repeated_redline, false);
});

// ---------------------------------------------------------------------------
// Fixture 3 — bench redline before weighted dips reroutes a pull first.
// ---------------------------------------------------------------------------
test('setEffortSignals: bench_redline_before_weighted_dips_reroutes', () => {
  const a = analyzeSetSequence(
    [[235, 6, 2], [235, 6, 0], [235, 4, 1]],
    { exerciseName: 'Bench Press' }
  );
  const conflict = assessNextMoveConflict(a, ['Weighted Dips', 'Seated Row']);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.next_exercise, 'Weighted Dips');
  assert.equal(conflict.suggestion.type, 'reroute_pull_first');
  assert.equal(conflict.suggestion.pull_first, 'Seated Row');
  assert.equal(conflict.suggestion.defer_press, 'Weighted Dips');
  assert.ok(conflict.reason_codes.includes(EFFORT_REASON_CODES.SAME_PRIME_MOVER_CONFLICT));
  assert.ok(conflict.reason_codes.includes(EFFORT_REASON_CODES.REROUTE_PULL_FIRST));
});

test('setEffortSignals: same_prime_mover with no pull queued caps the next press', () => {
  const a = analyzeSetSequence(
    [[235, 6, 2], [235, 6, 0], [235, 4, 1]],
    { exerciseName: 'Bench Press' }
  );
  const conflict = assessNextMoveConflict(a, ['Incline Bench Press']);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.suggestion.type, 'cap_next_press');
  assert.equal(conflict.suggestion.press, 'Incline Bench Press');
  assert.ok(conflict.reason_codes.includes(EFFORT_REASON_CODES.CAP_NEXT_PRESS));
});

// ---------------------------------------------------------------------------
// Fixture 4 — a high-RIR working set is flagged underdosed (no fatigue warning).
// ---------------------------------------------------------------------------
test('setEffortSignals: high_rir_workset_callout', () => {
  const a = analyzeSetSequence(
    [[20, 15, 5], [20, 15, 5], [20, 15, 5]],
    { exerciseName: 'Lateral Raise' }
  );
  assert.equal(a.signals.high_rir_workset_underdosed, true);
  assert.equal(a.signals.redline_set, false);
  assert.equal(a.signals.pressing_readiness_yellow, false); // not a fatigue/yellow signal
  assert.equal(a.progression_verdict, 'bump');
  assert.ok(a.reason_codes.includes(EFFORT_REASON_CODES.HIGH_RIR_WORKSET_UNDERDOSED));
});

// ---------------------------------------------------------------------------
// Fixture 5 — isolation RIR 0 is caution-only, not a heavy-compound block.
// ---------------------------------------------------------------------------
test('setEffortSignals: isolation_rir0_not_treated_like_heavy_compound', () => {
  const iso = analyzeSetSequence([[30, 12, 0]], { exerciseName: 'Cable Fly' });
  assert.equal(iso.is_compound, false);
  assert.equal(iso.signals.redline_set, true);
  assert.equal(iso.blocks_progression, false);
  assert.equal(iso.caution_only_redline, true);
  assert.equal(iso.progression_verdict, 'caution');
  assert.equal(iso.signals.pressing_readiness_yellow, false);

  // Same RIR 0 on a heavy compound DOES block — the severity differs by role.
  const compound = analyzeSetSequence([[225, 5, 0]], { exerciseName: 'Bench Press' });
  assert.equal(compound.is_compound, true);
  assert.equal(compound.blocks_progression, true);
  assert.equal(compound.progression_verdict, 'block');
});

// ---------------------------------------------------------------------------
// Fixture 6 — one hard set without same-prime-mover overlap does not derail work.
// ---------------------------------------------------------------------------
test('setEffortSignals: no_overreaction_to_one_hard_set_without_overlap', () => {
  // (a) a single hard (non-redline) set is not a fatigue event.
  const hard = analyzeSetSequence([[225, 5, 1]], { exerciseName: 'Bench Press' });
  assert.equal(hard.signals.redline_set, false);
  assert.equal(hard.signals.pressing_readiness_yellow, false);
  const noConflictA = assessNextMoveConflict(hard, ['Seated Row']);
  assert.equal(noConflictA.conflict, false);
  assert.equal(noConflictA.suggestion, null);

  // (b) even a single redline does not derail an UNRELATED (pull) next move.
  const redline = analyzeSetSequence([[225, 5, 0]], { exerciseName: 'Bench Press' });
  assert.equal(redline.signals.pressing_readiness_yellow, true);
  const noConflictB = assessNextMoveConflict(redline, ['Seated Row']);
  assert.equal(noConflictB.conflict, false);
  assert.equal(noConflictB.suggestion, null);
});

// ---------------------------------------------------------------------------
// Guard — a near-top heavy set at RIR 4 is NOT a warmup (load threshold honored).
// ---------------------------------------------------------------------------
test('setEffortSignals: heavy near-top set at high RIR is work, not warmup', () => {
  // 225 is >= 85% of 235, so it is a working set even at RIR 4.
  const a = analyzeSetSequence(
    [[225, 5, 4], [235, 5, 2]],
    { exerciseName: 'Bench Press' }
  );
  assert.deepEqual(a.set_classes, ['work', 'work']);
  assert.ok(!a.reason_codes.includes(EFFORT_REASON_CODES.WARMUP_FEEDER_IGNORED));
});

// ---------------------------------------------------------------------------
// Defensive — empty / malformed input returns null without throwing.
// ---------------------------------------------------------------------------
test('setEffortSignals: empty input returns null', () => {
  assert.equal(analyzeSetSequence([], { exerciseName: 'Bench Press' }), null);
  assert.equal(analyzeSetSequence(null), null);
  const c = assessNextMoveConflict(null, ['Seated Row']);
  assert.equal(c.conflict, false);
});
