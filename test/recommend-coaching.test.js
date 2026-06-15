'use strict';

// PR 1 — pure deterministic engine for the coaching fixes (Bugs 1–3).
// These pin the correctness-critical logic in isolation; nothing wires the new
// `justLoggedSet` option into a route yet, so existing behaviour can't change.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recommendNextSet, effortVerdict } = require('../services/analytics');

// 12-column-contract row in object form (the shape normalizeLogRow accepts).
function row({ date, session, weight, reps, rir, notes = '', code = 'BENCH01', name = 'Bench Press', mg = 'Chest' }) {
  return {
    date_clean: date, session_id: session, exercise: name, canonical_exercise: name,
    muscle_group: mg, lift_code: code, set_number: '1', weight, reps, rir, notes
  };
}

// ── effortVerdict — the effort read from logged RIR vs target (Bug 2) ──────────

test('effortVerdict: RIR well above target reads as easy — room to add load', () => {
  const v = effortVerdict(8, 2);
  assert.equal(v.level, 'easy');
  assert.match(v.headline, /reserve|add load/i);
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
