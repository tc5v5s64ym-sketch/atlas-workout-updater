'use strict';

// PR 1 — pure deterministic engine for the coaching fixes (Bugs 1–3).
// These pin the correctness-critical logic in isolation; nothing wires the new
// `justLoggedSet` option into a route yet, so existing behaviour can't change.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recommendNextSet, effortVerdict, progressionVerdict } = require('../services/analytics');

// 12-column-contract row in object form (the shape normalizeLogRow accepts).
function row({ date, session, weight, reps, rir, notes = '', code = 'BENCH01', name = 'Bench Press', mg = 'Chest' }) {
  return {
    date_clean: date, session_id: session, exercise: name, canonical_exercise: name,
    muscle_group: mg, lift_code: code, set_number: '1', weight, reps, rir, notes
  };
}

// ── effortVerdict — the effort read from logged RIR vs target (Bug 2) ──────────

test('effortVerdict: RIR far above target reads as far_easy — under-effort, add weight', () => {
  const v = effortVerdict(8, 2);   // 6 in reserve above a target of 2 — way too light
  assert.equal(v.level, 'far_easy');
  assert.match(v.headline, /too light|under-effort|add real weight/i);
  assert.doesNotMatch(v.headline, /within target|on target/i);
});

test('effortVerdict: RIR moderately above target stays easy — room to add', () => {
  const v = effortVerdict(4, 2);   // 2 in reserve — within target, a little room
  assert.equal(v.level, 'easy');
  assert.match(v.headline, /reserve|add load/i);
});

test('effortVerdict: the far_easy boundary sits at target + 5', () => {
  assert.equal(effortVerdict(6, 2).level, 'easy');      // 4 over → still easy
  assert.equal(effortVerdict(7, 2).level, 'far_easy');  // 5 over → far too easy
  // The shrugs repro: RIR 10 against a RIR-4 target must read as far too light.
  assert.equal(effortVerdict(10, 4).level, 'far_easy');
});

test('effortVerdict: RIR 0 is acknowledged as failure', () => {
  const v = effortVerdict(0, 2);
  assert.equal(v.level, 'failure');
  assert.match(v.headline, /failure/i);
});

test('effortVerdict: RIR at target is on_target', () => {
  assert.equal(effortVerdict(2, 2).level, 'on_target');
});

test('effortVerdict: just under target is a hard grinder (not failure)', () => {
  const v = effortVerdict(1, 3);
  assert.equal(v.level, 'hard');
  assert.doesNotMatch(v.headline, /failure/i);
});

test('effortVerdict: no RIR logged → null (nothing to read)', () => {
  assert.equal(effortVerdict(null, 2), null);
  assert.equal(effortVerdict(undefined, 2), null);
});

// ── progressionVerdict — the load read of today's top set vs the lifter's band ──

const BAND = { range_low: 200, range_high: 225, ceiling: 230 }; // midpoint 212.5

test('progressionVerdict: top below the band reads as under_shot', () => {
  const v = progressionVerdict(185, BAND);
  assert.equal(v.level, 'under_shot');
  assert.match(v.headline, /under your range/i);
  // Every number it cites comes from the band/top — nothing invented.
  assert.deepEqual([v.range_low, v.range_high, v.ceiling], [200, 225, 230]);
});

test('progressionVerdict: top in the upper half of the band reads as in_pocket', () => {
  assert.equal(progressionVerdict(215, BAND).level, 'in_pocket');     // above midpoint
  assert.equal(progressionVerdict(225, BAND).level, 'in_pocket');     // at range_high
});

test('progressionVerdict: top in the lower half of the band reads as maintenance_drift', () => {
  assert.equal(progressionVerdict(205, BAND).level, 'maintenance_drift'); // below midpoint
  assert.equal(progressionVerdict(200, BAND).level, 'maintenance_drift'); // at range_low
});

test('progressionVerdict: top above the band but under the ceiling reads as progressing', () => {
  const v = progressionVerdict(228, BAND);
  assert.equal(v.level, 'progressing');
  assert.match(v.headline, /climbing|pushing/i);
});

test('progressionVerdict: top above the ceiling reads as new_ground', () => {
  const v = progressionVerdict(235, BAND);
  assert.equal(v.level, 'new_ground');
  assert.match(v.headline, /new working weight|previous best/i);
});

test('progressionVerdict: a flat band — beating their usual weight is new ground', () => {
  // They have only ever done 225; ceiling == band, so 230 is a fresh best.
  assert.equal(progressionVerdict(230, { range_low: 225, range_high: 225, ceiling: 225 }).level, 'new_ground');
  assert.equal(progressionVerdict(225, { range_low: 225, range_high: 225, ceiling: 225 }).level, 'in_pocket');
});

test('progressionVerdict: no band or no top → null (nothing to read)', () => {
  assert.equal(progressionVerdict(225, null), null);
  assert.equal(progressionVerdict(225, { range_low: null, range_high: null }), null);
  assert.equal(progressionVerdict(null, BAND), null);
  assert.equal(progressionVerdict(0, BAND), null);
});

test('recommendNextSet: attaches a progression_verdict from real history', () => {
  // Two prior sessions at 225 set the band; a light just-logged 203 under-shoots it.
  const rows = [
    row({ date: '2026-06-01', session: 's1', weight: 225, reps: 5, rir: 0 }),
    row({ date: '2026-06-08', session: 's2', weight: 225, reps: 5, rir: 0 })
  ];
  const rec = recommendNextSet(rows, 'BENCH01', {
    today: '2026-06-10', justLoggedSet: { weight: 203, reps: 5, rir: 5 }
  });
  assert.ok(rec.progression_verdict, 'progression_verdict must be present with history');
  assert.equal(rec.progression_verdict.level, 'under_shot');
  assert.equal(rec.progression_verdict.range_low, 225);
  assert.equal(rec.progression_verdict.range_high, 225);
});

test('recommendNextSet: a fresh top working set reads as new_ground', () => {
  const rows = [
    row({ date: '2026-06-01', session: 's1', weight: 200, reps: 5, rir: 2 }),
    row({ date: '2026-06-08', session: 's2', weight: 210, reps: 5, rir: 2 })
  ];
  const rec = recommendNextSet(rows, 'BENCH01', {
    today: '2026-06-10', justLoggedSet: { weight: 215, reps: 5, rir: 1 }
  });
  assert.equal(rec.progression_verdict.level, 'new_ground');
});

test('recommendNextSet: no history → progression_verdict is null', () => {
  const rec = recommendNextSet([], 'BENCH01', { today: '2026-06-10' });
  assert.equal(rec.progression_verdict, null);
});

// ── Bug 1 — just-logged set anchors the recommendation, not stale history ──────

test('recommendNextSet: a just-logged RIR 5 set reads as room to progress, never near failure', () => {
  // History's last session ended at 225 near failure — the stale signal that
  // used to leak into the in-workout "Next". The just-logged 203 × 5 @ RIR 5
  // (not yet in the sheet under session-level save) must win.
  const rows = [
    row({ date: '2026-06-01', session: 's1', weight: 225, reps: 5, rir: 0 }),
    row({ date: '2026-06-08', session: 's2', weight: 225, reps: 5, rir: 0 })
  ];
  const rec = recommendNextSet(rows, 'BENCH01', {
    today: '2026-06-10', justLoggedSet: { weight: 203, reps: 5, rir: 5 }
  });
  assert.match(rec.recommendation, /room|progress/i);
  assert.doesNotMatch(rec.recommendation, /failure/i);
  assert.doesNotMatch(rec.reasoning, /failure/i);
  assert.equal(rec.effort_verdict.level, 'easy');
  // Anchored on the just-logged 203 (+5 lb), not history's 225.
  assert.equal(rec.next_target.weight, 208);
});

test('recommendNextSet: a just-logged failure set holds the load and acknowledges failure', () => {
  const rows = [row({ date: '2026-06-08', session: 's1', weight: 135, reps: 8, rir: 2 })];
  const rec = recommendNextSet(rows, 'BENCH01', {
    today: '2026-06-10', justLoggedSet: { weight: 185, reps: 5, rir: 0 }
  });
  assert.equal(rec.effort_verdict.level, 'failure');
  assert.match(rec.recommendation, /hold|failure/i);
  assert.equal(rec.next_target.weight, 185); // holds the just-logged load, no bump
});

test('recommendNextSet: a just-logged set on a brand-new lift still gets an effort read', () => {
  const rec = recommendNextSet([], 'NEWLIFT', {
    today: '2026-06-10', justLoggedSet: { weight: 100, reps: 10, rir: 6 }
  });
  assert.equal(rec.effort_verdict.level, 'easy');
  assert.match(rec.recommendation, /room|progress/i);
});

// ── Bug 3 — post-deload recovery returns to the pre-deload working weight ──────

test('recommendNextSet: after a deload, next returns to the pre-deload working weight', () => {
  const rows = [
    row({ date: '2026-05-20', session: 'd1', weight: 200, reps: 5, rir: 1 }),
    row({ date: '2026-05-27', session: 'd2', weight: 200, reps: 5, rir: 1 }),
    row({ date: '2026-06-03', session: 'd3', weight: 200, reps: 5, rir: 1 }),
    row({ date: '2026-06-10', session: 'd4', weight: 180, reps: 5, rir: 4 }) // deload, ~10% lighter
  ];
  const rec = recommendNextSet(rows, 'BENCH01', { today: '2026-06-12' });
  assert.equal(rec.next_target.weight, 200); // back to 200, not the 180 deload
  assert.match(rec.recommendation, /deload done|back to 200/i);
});

test('recommendNextSet: an explicit deload note triggers recovery even on a small drop', () => {
  const rows = [
    row({ date: '2026-05-27', session: 'd1', weight: 200, reps: 5, rir: 1 }),
    row({ date: '2026-06-03', session: 'd2', weight: 200, reps: 5, rir: 1 }),
    row({ date: '2026-06-10', session: 'd3', weight: 192, reps: 5, rir: 3, notes: 'Deload — 10% lighter, focus on clean reps' })
  ];
  const rec = recommendNextSet(rows, 'BENCH01', { today: '2026-06-12' });
  assert.equal(rec.next_target.weight, 200);
  assert.match(rec.recommendation, /deload done|back to 200/i);
});

test('recommendNextSet: steady progression is NOT mistaken for a deload', () => {
  const rows = [
    row({ date: '2026-05-27', session: 'p1', weight: 185, reps: 5, rir: 2 }),
    row({ date: '2026-06-03', session: 'p2', weight: 190, reps: 5, rir: 2 }),
    row({ date: '2026-06-10', session: 'p3', weight: 195, reps: 5, rir: 2 })
  ];
  const rec = recommendNextSet(rows, 'BENCH01', { today: '2026-06-12' });
  assert.doesNotMatch(rec.recommendation, /deload/i);
});

// ── Deload is engine-driven (PR 6b/7) ─────────────────────────────────────────
//
// The in-session deload reaction is no longer a recommendNextSet option — an
// active deload comes from the deload engine (services/deloadEngine) and is
// surfaced on /api/recommend/next's `deload` field, with the coach narrating it.
// recommendNextSet no longer reads intentId/deload for a deload branch; what
// remains here is the post-deload weight recovery (above) and that an intent
// still tunes the target RIR via the rir policy (below).

test('intent still tunes target RIR even without a deload branch (recovery RIR holds, never chases)', () => {
  const rows = [
    row({ date: '2026-06-03', session: 's1', weight: 135, reps: 8, rir: 3 }),
    row({ date: '2026-06-10', session: 's2', weight: 135, reps: 8, rir: 3 })
  ];
  // No intentId → normal day. Default target RIR 3, just-logged RIR 3 → on target
  // → chase reps. The identical set with intentId 'deload_reset' holds instead.
  const normal = recommendNextSet(rows, 'BENCH01', {
    today: '2026-06-12', justLoggedSet: { weight: 135, reps: 8, rir: 3 }
  });
  assert.match(normal.recommendation, /chase|9 reps/i);
  assert.doesNotMatch(normal.recommendation, /deload/i);

  const deload = recommendNextSet(rows, 'BENCH01', {
    today: '2026-06-12', justLoggedSet: { weight: 135, reps: 8, rir: 3 }, intentId: 'deload_reset'
  });
  assert.doesNotMatch(deload.recommendation, /chase|progress/i);
  assert.match(deload.recommendation, /hold|deload/i);
});

// ── Shape + backward compatibility ────────────────────────────────────────────

test('recommendNextSet: attaches a deterministic target_rir', () => {
  const rows = [row({ date: '2026-06-10', session: 's1', weight: 185, reps: 5, rir: 2 })];
  const rec = recommendNextSet(rows, 'BENCH01', { today: '2026-06-11' });
  assert.ok(Number.isFinite(rec.target_rir));
});

test('recommendNextSet: without a logged set or deload, effort_verdict is null and history logic is unchanged', () => {
  const rows = [
    row({ date: '2026-06-03', session: 's1', weight: 185, reps: 5, rir: 2 }),
    row({ date: '2026-06-10', session: 's2', weight: 185, reps: 5, rir: 2 })
  ];
  const rec = recommendNextSet(rows, 'BENCH01', { today: '2026-06-11' });
  assert.equal(rec.effort_verdict, null);
  assert.match(rec.recommendation, /increase/i); // stable reps over two sessions → progression
});
