'use strict';

// F10A — Session_Plan_Sets recommendation ledger (services/sessionPlanLedger.js).
// The executable contract for docs/SESSION_PLANS_LEDGER_DESIGN.md (approved with 3
// amendments). Pure module — no Sheets I/O. Covers: the 16-column schema, the
// deterministic idempotency_key, the accepted-plan (v1) + explicit-revision builders,
// the July 16 dips fixture (65 planned / 60 performed — the failure the ledger
// prevents), and the chain-validating effectiveRecommendation() that FAILS CLOSED to
// no_reliable_target + diagnostics on every malformed-history shape (amendment 3).

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../services/sessionPlanLedger');
const { sessionPlanSetsColumns } = require('../config/columns');
const { optionalSheetTabs } = require('../config/sheetContract');

const SESSION = { session_id: 'S1', session_date: '2026-07-16' };
const keyFor = (plan_item_id, plan_version, set_index) =>
  L.idempotencyKey({ session_id: 'S1', plan_version, plan_item_id, set_index });
const col = (name) => sessionPlanSetsColumns.indexOf(name);

// ── Schema ────────────────────────────────────────────────────────────────────

test('schema: Session_Plan_Sets is the 16-column owner-approved order + an optional tab', () => {
  assert.deepEqual(sessionPlanSetsColumns, [
    'idempotency_key', 'session_id', 'session_date', 'plan_version', 'plan_item_id',
    'planned_lift_code', 'set_index', 'target_set_count', 'target_weight', 'target_reps',
    'target_rir', 'recommendation_source', 'supersedes_key', 'confidence',
    'closeout_write_id', 'recorded_at',
  ]);
  assert.ok(optionalSheetTabs.includes('Session_Plan_Sets'), 'the tab is optional (503/no-op until the owner creates it)');
});

// ── idempotency_key ─────────────────────────────────────────────────────────────

test('idempotency_key: deterministic over (session_id, plan_version, plan_item_id, set_index) only', () => {
  const base = { session_id: 'S1', plan_version: 1, plan_item_id: 'pi_a', set_index: 2 };
  assert.equal(L.idempotencyKey(base), L.idempotencyKey({ ...base }), 'same identity → same key (retry-safe)');
  // Targets / source / timestamp must NOT affect the key.
  assert.equal(
    L.idempotencyKey({ ...base, target_weight: 65, recommendation_source: 'accepted', recorded_at: 'X' }),
    L.idempotencyKey({ ...base, target_weight: 999, recommendation_source: 'live_revision', recorded_at: 'Y' }),
  );
  // A different version / set / item → a different key.
  assert.notEqual(L.idempotencyKey(base), L.idempotencyKey({ ...base, plan_version: 2 }));
  assert.notEqual(L.idempotencyKey(base), L.idempotencyKey({ ...base, set_index: 3 }));
  assert.notEqual(L.idempotencyKey(base), L.idempotencyKey({ ...base, plan_item_id: 'pi_b' }));
});

// ── buildAcceptedRows (ledger v1) ────────────────────────────────────────────────

test('buildAcceptedRows: the July 16 dips plan → three v1 rows (65×5, 3 sets), ordering + id preserved', () => {
  const rows = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2 },
  ], { recordedAt: '2026-07-16T18:00:00Z' });

  assert.equal(rows.length, 3, 'one row per set_index 1..3');
  rows.forEach((r, i) => {
    assert.equal(r[col('plan_version')], '1');
    assert.equal(r[col('plan_item_id')], 'pi_dip');
    assert.equal(r[col('set_index')], String(i + 1));
    assert.equal(r[col('target_set_count')], '3');
    assert.equal(r[col('target_weight')], '65');
    assert.equal(r[col('target_reps')], '5');
    assert.equal(r[col('target_rir')], '2');
    assert.equal(r[col('recommendation_source')], 'accepted');
    assert.equal(r[col('supersedes_key')], '', 'v1 has no predecessor');
    assert.equal(r[col('confidence')], 'reliable');
    assert.equal(r[col('closeout_write_id')], '', 'not sealed until closeout (F10D)');
    assert.equal(r[col('idempotency_key')], keyFor('pi_dip', 1, i + 1));
  });
});

test('plan_version is the INTEGER revision counter, distinct from the Session_Plans pv_ token (join is by plan_item_id)', () => {
  // The acceptance flow carries an opaque pv_… token as session.plan_version; the
  // ledger's plan_version is the integer set-revision counter (1 = accepted). They are
  // different dimensions — the ledger row's plan_version is 1, NOT the pv_ token — and
  // the join back to the Session_Plans item is by the globally-unique plan_item_id.
  const [r] = L.buildAcceptedRows(
    { session_id: 'S1', session_date: '2026-07-16', plan_version: 'pv_abc123' },
    [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 1, target_weight: 65, target_reps: 5, target_rir: 2 }],
  );
  assert.equal(r[col('plan_version')], '1', 'integer revision counter, never the pv_ token');
  assert.equal(r[col('plan_item_id')], 'pi_dip', 'plan_item_id is the authoritative Session_Plans join key');
  // The idempotency key uses the integer version too (retry-stable, pv-token-independent).
  assert.equal(r[col('idempotency_key')], keyFor('pi_dip', 1, 1));
});

test('buildAcceptedRows: a no_reliable_target item carries blank targets, confidence flag set', () => {
  const [r] = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_x', planned_lift_code: 'X01', target_set_count: 1, target_weight: 100, confidence: 'no_reliable_target' },
  ]);
  assert.equal(r[col('confidence')], 'no_reliable_target');
  assert.equal(r[col('target_weight')], '', 'no invented target when confidence is no_reliable_target');
  assert.equal(r[col('target_reps')], '');
});

test('buildAcceptedRows: bodyweight target_weight 0 is preserved (Log_Cleaned convention)', () => {
  const [r] = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_bw', planned_lift_code: 'PU01', target_set_count: 1, target_weight: 0, target_reps: 8 },
  ]);
  assert.equal(r[col('target_weight')], '0');
});

test('buildAcceptedRows: rejects a missing lift code / non-positive set count (never invents identity)', () => {
  assert.throws(() => L.buildAcceptedRows(SESSION, [{ plan_item_id: 'pi', planned_lift_code: '', target_set_count: 1 }]), /lift code/);
  assert.throws(() => L.buildAcceptedRows(SESSION, [{ plan_item_id: 'pi', planned_lift_code: 'A1', target_set_count: 0 }]), /positive integer/);
  assert.throws(() => L.buildAcceptedRows(SESSION, [{ plan_item_id: '', planned_lift_code: 'A1', target_set_count: 1 }]), /plan_item_id/);
});

// ── buildImplicitRows (F10C — the implicit_unplanned recommendation) ─────────────

test('buildImplicitRows: an unannounced-exercise recommendation → ONE v1 row, set 1, one set', () => {
  const rows = L.buildImplicitRows(SESSION, [
    { plan_item_id: 'pi_hc', planned_lift_code: 'HCURL', target_weight: 30, target_reps: 12, target_rir: 1 },
  ], { recordedAt: '2026-07-16T18:30:00Z' });

  assert.equal(rows.length, 1, 'one implicit row per item (one next set only)');
  const r = rows[0];
  assert.equal(r[col('plan_version')], '1');
  assert.equal(r[col('plan_item_id')], 'pi_hc');
  assert.equal(r[col('set_index')], '1');
  assert.equal(r[col('target_set_count')], '1', 'exactly one next set (rule 1)');
  assert.equal(r[col('target_weight')], '30');
  assert.equal(r[col('target_reps')], '12');
  assert.equal(r[col('target_rir')], '1');
  assert.equal(r[col('recommendation_source')], 'implicit_unplanned');
  assert.equal(r[col('supersedes_key')], '', 'a standalone recommendation supersedes nothing');
  assert.equal(r[col('confidence')], 'reliable');
  assert.equal(r[col('closeout_write_id')], '', 'not sealed until closeout (F10D)');
  assert.equal(r[col('idempotency_key')], keyFor('pi_hc', 1, 1));
});

test('buildImplicitRows: a no_reliable_target item → blank targets, confidence no_reliable_target (no invention)', () => {
  const rows = L.buildImplicitRows(SESSION, [
    { plan_item_id: 'pi_x', planned_lift_code: 'KRAISE', confidence: 'no_reliable_target' },
  ]);
  const r = rows[0];
  assert.equal(r[col('target_weight')], '', 'no target invented');
  assert.equal(r[col('target_reps')], '');
  assert.equal(r[col('target_rir')], '');
  assert.equal(r[col('target_set_count')], '1', 'still one set (the recommendation slot exists)');
  assert.equal(r[col('recommendation_source')], 'implicit_unplanned');
  assert.equal(r[col('confidence')], 'no_reliable_target');
});

test('buildImplicitRows: bodyweight 0 is a real target (preserved, not blanked)', () => {
  const rows = L.buildImplicitRows(SESSION, [
    { plan_item_id: 'pi_pu', planned_lift_code: 'PULLUP', target_weight: 0, target_reps: 8, target_rir: 2 },
  ]);
  assert.equal(rows[0][col('target_weight')], '0');
  assert.equal(rows[0][col('confidence')], 'reliable');
});

test('buildImplicitRows: rejects a missing lift code / plan_item_id (never invents identity)', () => {
  assert.throws(() => L.buildImplicitRows(SESSION, [{ plan_item_id: 'pi', planned_lift_code: '' }]), /lift code/);
  assert.throws(() => L.buildImplicitRows(SESSION, [{ plan_item_id: '', planned_lift_code: 'A1' }]), /plan_item_id/);
});

// ── buildRevisionRow (explicit, future-set-only) ─────────────────────────────────

test('buildRevisionRow: an explicit live_revision appends v2 with supersedes_key set', () => {
  const r = L.buildRevisionRow(SESSION, {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 2, plan_version: 2,
    target_set_count: 3, target_weight: 60, target_reps: 5, target_rir: 2,
    recommendation_source: 'live_revision', supersedes_key: keyFor('pi_dip', 1, 2),
  });
  assert.equal(r[col('plan_version')], '2');
  assert.equal(r[col('target_weight')], '60');
  assert.equal(r[col('recommendation_source')], 'live_revision');
  assert.equal(r[col('supersedes_key')], keyFor('pi_dip', 1, 2));
  assert.equal(r[col('idempotency_key')], keyFor('pi_dip', 2, 2));
});

test('buildRevisionRow: supersedes_key is DERIVED from the immediately-prior version when omitted', () => {
  // A revision chain is linear (v1→v2→…), so the row a vN revision replaces is always
  // version N-1 of the same (item, set). The client need not track prior keys — the
  // builder derives supersedes_key = idempotencyKey(session_id, N-1, item, set).
  const r = L.buildRevisionRow(SESSION, {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 2, plan_version: 2,
    target_set_count: 3, target_weight: 60, target_reps: 5, target_rir: 2,
    recommendation_source: 'live_revision', // no supersedes_key provided
  });
  assert.equal(r[col('supersedes_key')], keyFor('pi_dip', 1, 2), 'derived to the v1 row key');
  // A v3 derives to the v2 key; the derived value forms a clean chain the validator accepts.
  const r3 = L.buildRevisionRow(SESSION, {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 2, plan_version: 3,
    target_set_count: 3, target_weight: 55, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision',
  });
  assert.equal(r3[col('supersedes_key')], keyFor('pi_dip', 2, 2));
  assert.equal(L.supersedesKeyFor(SESSION, { plan_item_id: 'pi_dip', set_index: 2, plan_version: 2 }), keyFor('pi_dip', 1, 2));
  // An explicitly-provided supersedes_key still wins (back-compat).
  const explicit = L.buildRevisionRow(SESSION, {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 2, plan_version: 2, target_set_count: 3,
    target_weight: 60, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision', supersedes_key: 'explicit0000key0',
  });
  assert.equal(explicit[col('supersedes_key')], 'explicit0000key0');
});

test('buildRevisionRow: a performed value can never revise — only live_revision/user_endorsed (amendment 1)', () => {
  const base = {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 2, plan_version: 2,
    target_set_count: 3, target_weight: 60, target_reps: 5, supersedes_key: keyFor('pi_dip', 1, 2),
  };
  assert.throws(() => L.buildRevisionRow(SESSION, { ...base, recommendation_source: 'accepted' }), /recommendation_source/);
  assert.throws(() => L.buildRevisionRow(SESSION, { ...base, recommendation_source: 'engine' }), /recommendation_source/);
  assert.throws(() => L.buildRevisionRow(SESSION, { ...base, recommendation_source: 'implicit_unplanned' }), /recommendation_source/);
  // v1 is the accepted plan, never a revision.
  assert.throws(() => L.buildRevisionRow(SESSION, { ...base, plan_version: 1, recommendation_source: 'live_revision' }), /plan_version ≥ 2/);
});

// ── effectiveRecommendation — the dips case (the failure the ledger prevents) ────

test('effectiveRecommendation: dips set 1 stays 65 (frozen); an explicit revision moves ONLY future sets to 60', () => {
  const v1 = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2 },
  ]);
  // Athlete performed 60 → that is a Log_Cleaned actual and NEVER a revision. The
  // ledger is still just v1. effective(set 1) is 65.
  assert.equal(L.effectiveRecommendation(v1, 'pi_dip', 1).target_weight, 65, 'set 1 frozen at 65');
  assert.equal(L.effectiveRecommendation(v1, 'pi_dip', 2).target_weight, 65, 'absent an explicit revision, set 2 stays 65');

  // Only an EXPLICIT Atlas recommendation for future sets appends v2 (sets 2 & 3, not 1).
  const rev2 = L.buildRevisionRow(SESSION, {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 2, plan_version: 2,
    target_set_count: 3, target_weight: 60, target_reps: 5, target_rir: 2,
    recommendation_source: 'live_revision', supersedes_key: keyFor('pi_dip', 1, 2),
  });
  const rev3 = L.buildRevisionRow(SESSION, {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 3, plan_version: 2,
    target_set_count: 3, target_weight: 60, target_reps: 5, target_rir: 2,
    recommendation_source: 'live_revision', supersedes_key: keyFor('pi_dip', 1, 3),
  });
  const all = [...v1, rev2, rev3];
  assert.equal(L.effectiveRecommendation(all, 'pi_dip', 1).target_weight, 65, 'set 1 (already performed) is NEVER rewritten to 60');
  assert.equal(L.effectiveRecommendation(all, 'pi_dip', 2).target_weight, 60, 'set 2 effective target is the v2 revision');
  assert.equal(L.effectiveRecommendation(all, 'pi_dip', 2).plan_version, 2);
  assert.equal(L.effectiveRecommendation(all, 'pi_dip', 3).target_weight, 60);
});

test('effectiveRecommendation: no rows / a no_reliable_target flag both surface honestly (no invented target)', () => {
  assert.deepEqual(L.effectiveRecommendation([], 'pi_dip', 1),
    { confidence: 'no_reliable_target', reason: 'no_matching_row', plan_item_id: 'pi_dip', set_index: 1 });
  const flagged = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_u', planned_lift_code: 'U01', target_set_count: 1, confidence: 'no_reliable_target' },
  ]);
  const eff = L.effectiveRecommendation(flagged, 'pi_u', 1);
  assert.equal(eff.confidence, 'no_reliable_target');
  assert.equal(eff.reason, 'flagged');
  assert.equal(eff.target_weight, undefined, 'a flagged item never yields a numeric target');
});

// ── effectiveRecommendation — FAIL CLOSED on malformed chains (amendment 3) ──────

// Craft raw rows (as a hand-edit / corruption could) that parse individually but form
// a bad chain. effectiveRecommendation must return no_reliable_target + diagnostics,
// never a silently-selected max-version row.
const raw = (over) => L.toRow({
  session_id: 'S1', session_date: '2026-07-16', plan_version: 1, plan_item_id: 'pi_dip',
  planned_lift_code: 'DIP01', set_index: 1, target_set_count: 3, target_weight: 65,
  target_reps: 5, target_rir: 2, recommendation_source: 'accepted', supersedes_key: '',
  confidence: 'reliable', closeout_write_id: '', recorded_at: '', ...over,
});
const failsClosed = (rows, reason) => {
  const eff = L.effectiveRecommendation(rows, 'pi_dip', 1);
  assert.equal(eff.confidence, 'no_reliable_target', `${reason}: must fail closed, never a target`);
  assert.equal(eff.reason, 'malformed_chain');
  assert.equal(eff.diagnostics.reason, reason);
  assert.ok(eff.target_weight === undefined, 'never a silently-selected max-version target');
};

test('fail closed: duplicate version', () => {
  failsClosed([raw({ set_index: 1, plan_version: 1, target_weight: 65 }), raw({ set_index: 1, plan_version: 1, target_weight: 70 })], 'duplicate_version');
});

test('fail closed: fork (two revisions supersede the same predecessor)', () => {
  const v1 = raw({ set_index: 1, plan_version: 1 });
  const v2 = raw({ set_index: 1, plan_version: 2, recommendation_source: 'live_revision', supersedes_key: keyFor('pi_dip', 1, 1) });
  const v3fork = raw({ set_index: 1, plan_version: 3, recommendation_source: 'live_revision', supersedes_key: keyFor('pi_dip', 1, 1) });
  failsClosed([v1, v2, v3fork], 'fork');
});

test('fail closed: a revision with a blank supersedes_key', () => {
  const v1 = raw({ set_index: 1, plan_version: 1 });
  const v2 = raw({ set_index: 1, plan_version: 2, recommendation_source: 'live_revision', supersedes_key: '' });
  failsClosed([v1, v2], 'missing_supersedes');
});

test('fail closed: a dangling supersedes_key (predecessor absent)', () => {
  const v1 = raw({ set_index: 1, plan_version: 1 });
  const v2 = raw({ set_index: 1, plan_version: 2, recommendation_source: 'live_revision', supersedes_key: 'deadbeefdeadbeef' });
  failsClosed([v1, v2], 'dangling_supersedes');
});

test('fail closed: a cross-reference (supersedes a row from a different set)', () => {
  // v1 for set 1 and set 2; a "v2 of set 1" that supersedes set 2's v1 key.
  const s1v1 = raw({ set_index: 1, plan_version: 1 });
  const s2v1 = raw({ set_index: 2, plan_version: 1 });
  const s1v2cross = raw({ set_index: 1, plan_version: 2, recommendation_source: 'live_revision', supersedes_key: keyFor('pi_dip', 1, 2) });
  failsClosed([s1v1, s2v1, s1v2cross], 'cross_reference');
});

test('fail closed: non-contiguous versions (v1 then v3, no v2)', () => {
  const v1 = raw({ set_index: 1, plan_version: 1 });
  const v3 = raw({ set_index: 1, plan_version: 3, recommendation_source: 'live_revision', supersedes_key: keyFor('pi_dip', 1, 1) });
  failsClosed([v1, v3], 'non_contiguous_version');
});

test('fail closed: v1 carries a supersedes_key', () => {
  failsClosed([raw({ set_index: 1, plan_version: 1, supersedes_key: 'somethingsomething' })], 'v1_has_supersedes');
});

// ── effectivePlan / planHistory ─────────────────────────────────────────────────

test('effectivePlan: the per-set FINAL effective targets, in set order', () => {
  const v1 = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2 },
  ]);
  const rev2 = L.buildRevisionRow(SESSION, {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 2, plan_version: 2, target_set_count: 3,
    target_weight: 60, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision', supersedes_key: keyFor('pi_dip', 1, 2),
  });
  const plan = L.effectivePlan([...v1, rev2], 'pi_dip');
  assert.deepEqual(plan.map(p => [p.set_index, p.target_weight]), [[1, 65], [2, 60], [3, 65]]);
});

test('planHistory: the full original + revised chain per set, malformed sets surfaced', () => {
  const v1 = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 2, target_weight: 65, target_reps: 5, target_rir: 2 },
  ]);
  const rev2 = L.buildRevisionRow(SESSION, {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 2, plan_version: 2, target_set_count: 2,
    target_weight: 60, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision', supersedes_key: keyFor('pi_dip', 1, 2),
  });
  const hist = L.planHistory([...v1, rev2], 'pi_dip');
  const set2 = hist.find(h => h.set_index === 2);
  assert.equal(set2.ok, true);
  assert.deepEqual(set2.versions.map(v => [v.plan_version, v.target_weight]), [[1, 65], [2, 60]], 'v1 65 preserved verbatim, v2 60 appended');
});
