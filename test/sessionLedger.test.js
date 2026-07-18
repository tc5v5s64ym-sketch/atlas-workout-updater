'use strict';

// F10B-REVISION-WIRING-1 — client session ledger (src/app/sessionLedger.js). Pure.
// Pins the owner F10B contract: a revision targets FUTURE (unperformed) sets only; a
// completed set is frozen; a revision never fabricates a target; append-only; the
// linear plan_version counter (v1 accepted → first revision v2).

const test = require('node:test');
const assert = require('node:assert/strict');

let L;
test.before(async () => { L = await import('../src/app/sessionLedger.js'); });

const log = (...names) => names.map(n => ({ exercise: n, weight: 100, reps: 5, rir: 2 }));

test('performedSetCount: counts a lift\'s logged sets (plural/singular tolerant)', () => {
  const sessionLog = log('Weighted Dip', 'Weighted Dips', 'Cable Row');
  assert.equal(L.performedSetCount(sessionLog, 'Weighted Dip'), 2);
  assert.equal(L.performedSetCount(sessionLog, 'Cable Row'), 1);
  assert.equal(L.performedSetCount(sessionLog, 'Bench Press'), 0);
  assert.equal(L.performedSetCount([], 'Anything'), 0);
});

test('nextRevisionVersion: v1 accepted → first revision is v2, then linear', () => {
  assert.equal(L.nextRevisionVersion([], 'pi_1', 2), 2, 'first revision of a set is v2');
  const revs = [{ plan_item_id: 'pi_1', set_index: 2, plan_version: 2 }];
  assert.equal(L.nextRevisionVersion(revs, 'pi_1', 2), 3, 'next is v3');
  assert.equal(L.nextRevisionVersion(revs, 'pi_1', 3), 2, 'a different set is independent (v2)');
  assert.equal(L.nextRevisionVersion(revs, 'pi_2', 2), 2, 'a different item is independent');
});

test('buildFutureRevisions: revises FUTURE sets only — performed sets stay frozen', () => {
  // 3-set item, 1 set already performed → revise sets 2 and 3 only.
  const revs = L.buildFutureRevisions({
    plan_item_id: 'pi_dip', planned_lift_code: 'DBP01', target_weight: 60, target_reps: 8, target_rir: 2,
    target_set_count: 3, performedCount: 1, sessionRevisions: [],
  });
  assert.deepEqual(revs.map(r => r.set_index), [2, 3], 'set 1 (performed) is NOT revised');
  assert.ok(revs.every(r => r.plan_version === 2 && r.recommendation_source === 'live_revision'));
  assert.ok(revs.every(r => r.target_weight === 60 && r.target_reps === 8 && r.target_rir === 2));
  assert.equal(revs[0].planned_lift_code, 'DBP01');
});

test('buildFutureRevisions: no future sets (all performed) → no revision', () => {
  assert.deepEqual(L.buildFutureRevisions({
    plan_item_id: 'pi_dip', planned_lift_code: 'DBP01', target_weight: 60, target_reps: 8, target_rir: 2,
    target_set_count: 3, performedCount: 3, sessionRevisions: [],
  }), []);
});

test('buildFutureRevisions: an incomplete target (missing weight or reps) is NEVER fabricated into a revision', () => {
  const base = { plan_item_id: 'pi_dip', planned_lift_code: 'DBP01', target_set_count: 3, performedCount: 0, sessionRevisions: [] };
  assert.deepEqual(L.buildFutureRevisions({ ...base, target_reps: 8, target_rir: 2 }), [], 'no weight → no revision');
  assert.deepEqual(L.buildFutureRevisions({ ...base, target_weight: 60, target_rir: 2 }), [], 'no reps → no revision');
  // rir is optional — a weight+reps target with no rir still revises (rir null).
  const r = L.buildFutureRevisions({ ...base, target_weight: 60, target_reps: 8 });
  assert.equal(r.length, 3);
  assert.equal(r[0].target_rir, null);
});

test('buildFutureRevisions: bodyweight 0 is a real target', () => {
  const r = L.buildFutureRevisions({
    plan_item_id: 'pi_bw', planned_lift_code: 'PU01', target_weight: 0, target_reps: 8, target_rir: 2,
    target_set_count: 1, performedCount: 0, sessionRevisions: [],
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].target_weight, 0);
});

test('buildFutureRevisions: idempotent for an identical re-trigger; a changed target appends a new version', () => {
  const opts = { plan_item_id: 'pi_1', planned_lift_code: 'A1', target_weight: 60, target_reps: 8, target_rir: 2, target_set_count: 2, performedCount: 0, sessionRevisions: [] };
  const first = L.buildFutureRevisions(opts);
  assert.deepEqual(first.map(r => [r.set_index, r.plan_version]), [[1, 2], [2, 2]]);
  // Same targets, with the first revisions already recorded → nothing new (idempotent).
  assert.deepEqual(L.buildFutureRevisions({ ...opts, sessionRevisions: first }), []);
  // A genuinely-different recommendation → a new version (v3) per future set.
  const changed = L.buildFutureRevisions({ ...opts, target_weight: 80, sessionRevisions: first });
  assert.deepEqual(changed.map(r => [r.set_index, r.plan_version]), [[1, 3], [2, 3]]);
  assert.ok(changed.every(r => r.target_weight === 80));
});

test('appendRevisions: append-only — a re-trigger for an existing (item,set,version) is a no-op', () => {
  const first = L.appendRevisions([], [
    { plan_item_id: 'pi_1', set_index: 2, plan_version: 2, target_weight: 60 },
    { plan_item_id: 'pi_1', set_index: 3, plan_version: 2, target_weight: 60 },
  ]);
  assert.equal(first.length, 2);
  // Re-append the SAME revisions → unchanged (append-only, no duplicate rows).
  const again = L.appendRevisions(first, [{ plan_item_id: 'pi_1', set_index: 2, plan_version: 2, target_weight: 60 }]);
  assert.equal(again.length, 2, 'no duplicate (item,set,version)');
  // A genuinely NEW version appends.
  const v3 = L.appendRevisions(again, [{ plan_item_id: 'pi_1', set_index: 2, plan_version: 3, target_weight: 55 }]);
  assert.equal(v3.length, 3);
  // The prior rows are never mutated (append-only history).
  assert.equal(v3[0].target_weight, 60);
});
