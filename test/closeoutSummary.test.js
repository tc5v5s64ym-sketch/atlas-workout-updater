'use strict';

// F10D — the single-confirmation closeout summary (pure assembly, no I/O).
// buildCloseoutSummary composes the ONE owner confirmation from the two truths:
// the recommendation ledger (Session_Plan_Sets rows — original v1 + revisions) and
// the staged actuals (the exact rows the write will append). It NEVER copies a
// performed value backward as a plan, NEVER invents a target, and fails closed on
// malformed ledger history (the seal refuses separately; the summary SURFACES it).

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../services/sessionPlanLedger');
const { buildCloseoutSummary } = require('../services/closeoutSummary');

const SESSION = { session_id: 'S1', session_date: '2026-07-18' };

// The owner's canonical July-16 case: dips 65×5 ×3 accepted; Atlas explicitly
// revises sets 2–3 to 60 mid-session; athlete performs 60 on set 1 anyway.
function dipsLedger({ revise = true } = {}) {
  const rows = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2 },
  ], { recordedAt: 't1' });
  if (revise) {
    for (const set_index of [2, 3]) {
      rows.push(L.buildRevisionRow(SESSION, {
        plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index, plan_version: 2, target_set_count: 3,
        target_weight: 60, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision',
      }, { recordedAt: 't2' }));
    }
  }
  return rows;
}

const dipActual = (set_number, weight) => ({
  exercise: 'Weighted Dip', canonical_exercise: 'Weighted Dip', lift_code: 'DIP01',
  set_number, weight, reps: 5, rir: 2,
});

const ITEMS = [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', name: 'Weighted Dip', outcome: 'completed' }];

test('two truths: original v1 AND final effective plan are both present and distinct after a revision', () => {
  const s = buildCloseoutSummary({
    session: SESSION, ledgerRows: dipsLedger(), items: ITEMS,
    actualRows: [dipActual(1, 60), dipActual(2, 60), dipActual(3, 60)],
    logRowsPreview: [['r1'], ['r2'], ['r3']], effortRowPreview: ['e'],
  });
  assert.equal(s.has_stored_plan, true);
  const item = s.items.find(i => i.plan_item_id === 'pi_dip');
  assert.ok(item, 'the dip item is summarized');
  // Original plan (v1): 65 on every set — immutable, never rewritten by the actual 60.
  assert.deepEqual(item.original_sets.map(x => x.target_weight), [65, 65, 65]);
  // Final effective plan: set 1 frozen at 65 (performed before any revision could
  // target it); sets 2–3 explicitly revised to 60.
  assert.deepEqual(item.effective_sets.map(x => x.target_weight), [65, 60, 60]);
  assert.deepEqual(item.effective_sets.map(x => x.plan_version), [1, 2, 2]);
  assert.equal(item.revised, true);
  // Target-vs-actual: numeric deltas only (facts — F10E owns assessment wording).
  assert.deepEqual(item.target_vs_actual.map(x => x.weight_delta), [-5, 0, 0]);
  assert.equal(item.target_vs_actual[0].target_weight, 65, 'set 1 compared to ITS effective target (65), never the revised 60');
  assert.equal(item.target_vs_actual[0].actual_weight, 60);
});

test('substitution: actuals join the ORIGINAL item through performed_lift_code; plan identity is preserved', () => {
  const ledger = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_bsq', planned_lift_code: 'SQ01', target_set_count: 2, target_weight: 225, target_reps: 5, target_rir: 2 },
  ], { recordedAt: 't1' });
  const s = buildCloseoutSummary({
    session: SESSION, ledgerRows: ledger,
    items: [{ plan_item_id: 'pi_bsq', planned_lift_code: 'SQ01', performed_lift_code: 'FSQ01', name: 'Back Squat', outcome: 'substituted' }],
    actualRows: [
      { exercise: 'Front Squat', canonical_exercise: 'Front Squat', lift_code: 'FSQ01', set_number: 1, weight: 185, reps: 7, rir: 2 },
      { exercise: 'Front Squat', canonical_exercise: 'Front Squat', lift_code: 'FSQ01', set_number: 2, weight: 185, reps: 7, rir: 2 },
    ],
    logRowsPreview: [], effortRowPreview: null,
  });
  const item = s.items.find(i => i.plan_item_id === 'pi_bsq');
  assert.equal(item.outcome, 'substituted');
  assert.equal(item.performed_lift_code, 'FSQ01');
  assert.equal(item.planned_lift_code, 'SQ01', 'the plan truth is the ORIGINAL lift — never overwritten');
  assert.equal(item.target_vs_actual.length, 2, 'the substitute\'s actuals satisfy the original item');
  assert.equal(item.target_vs_actual[0].actual_weight, 185);
  assert.equal(s.unplanned.length, 0, 'the substitute is NOT unplanned — it is the original item\'s execution');
});

test('skipped item: no actuals → every set unperformed; nothing invented', () => {
  const ledger = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_ohp', planned_lift_code: 'OHP01', target_set_count: 2, target_weight: 115, target_reps: 6, target_rir: 2 },
  ], { recordedAt: 't1' });
  const s = buildCloseoutSummary({
    session: SESSION, ledgerRows: ledger,
    items: [{ plan_item_id: 'pi_ohp', planned_lift_code: 'OHP01', name: 'Overhead Press', outcome: 'skipped' }],
    actualRows: [], logRowsPreview: [], effortRowPreview: null,
  });
  const item = s.items.find(i => i.plan_item_id === 'pi_ohp');
  assert.equal(item.outcome, 'skipped');
  assert.deepEqual(item.target_vs_actual.map(x => x.unperformed), [true, true]);
  assert.ok(item.target_vs_actual.every(x => x.actual_weight == null), 'no fabricated actuals');
});

test('no_reliable_target: flagged honestly on the item; never a fabricated number', () => {
  const ledger = L.buildAcceptedRows(SESSION, [
    { plan_item_id: 'pi_row', planned_lift_code: 'ROW01', target_set_count: 1, confidence: 'no_reliable_target' },
  ], { recordedAt: 't1' });
  const s = buildCloseoutSummary({
    session: SESSION, ledgerRows: ledger,
    items: [{ plan_item_id: 'pi_row', planned_lift_code: 'ROW01', name: 'Seated Row', outcome: 'completed' }],
    actualRows: [{ exercise: 'Seated Row', canonical_exercise: 'Seated Row', lift_code: 'ROW01', set_number: 1, weight: 95, reps: 10, rir: 2 }],
    logRowsPreview: [], effortRowPreview: null,
  });
  const item = s.items.find(i => i.plan_item_id === 'pi_row');
  assert.equal(item.no_reliable_target, true);
  assert.equal(item.target_vs_actual[0].no_reliable_target, true);
  assert.equal(item.target_vs_actual[0].target_weight, null, 'no invented target');
  assert.equal(item.target_vs_actual[0].actual_weight, 95, 'the actual still shows');
  assert.ok(s.no_reliable_target_items.includes('pi_row'));
});

test('implicit_unplanned ledger row: surfaces as an implicit item with its one-set target', () => {
  const ledger = L.buildImplicitRows(SESSION, [
    { plan_item_id: 'pi_curl', planned_lift_code: 'CURL01', target_weight: 30, target_reps: 12, target_rir: 2 },
  ], { recordedAt: 't1' });
  const s = buildCloseoutSummary({
    session: SESSION, ledgerRows: ledger, items: [],
    actualRows: [{ exercise: 'Hammer Curl', canonical_exercise: 'Hammer Curl', lift_code: 'CURL01', set_number: 1, weight: 30, reps: 12, rir: 2 }],
    logRowsPreview: [], effortRowPreview: null,
  });
  const item = s.items.find(i => i.plan_item_id === 'pi_curl');
  assert.ok(item, 'the implicit recommendation appears in the confirmation');
  assert.equal(item.source, 'implicit_unplanned');
  assert.deepEqual(item.effective_sets.map(x => x.target_weight), [30]);
  assert.equal(item.target_vs_actual[0].weight_delta, 0);
  assert.equal(s.unplanned.length, 0, 'matched to the implicit item, not dumped in unplanned');
});

test('legacy session (no ledger rows): has_stored_plan false; actuals listed as unplanned; nothing fabricated', () => {
  const s = buildCloseoutSummary({
    session: SESSION, ledgerRows: [], items: [],
    actualRows: [dipActual(1, 60)],
    logRowsPreview: [['r1']], effortRowPreview: ['e'],
  });
  assert.equal(s.has_stored_plan, false);
  assert.equal(s.items.length, 0);
  assert.equal(s.unplanned.length, 1);
  assert.equal(s.unplanned[0].lift_code, 'DIP01');
  assert.equal(s.unplanned[0].sets.length, 1);
});

test('malformed ledger chain: the item fails closed with diagnostics; summary flags it; no target selected', () => {
  const rows = dipsLedger({ revise: false });
  rows.push(rows[0].slice()); // duplicate (item,set,version) → duplicate_version
  const s = buildCloseoutSummary({
    session: SESSION, ledgerRows: rows, items: ITEMS,
    actualRows: [dipActual(1, 60)], logRowsPreview: [], effortRowPreview: null,
  });
  assert.equal(s.malformed, true, 'the confirmation must SURFACE malformed history');
  const item = s.items.find(i => i.plan_item_id === 'pi_dip');
  assert.equal(item.malformed, true);
  assert.ok(item.diagnostics_sets.length >= 1, 'diagnostics identify the offending set chain');
  const set1 = item.target_vs_actual.find(x => x.set_index === 1);
  assert.equal(set1.target_weight, null, 'no silently-selected max-version target');
});

test('the exact rows to write and seal are echoed verbatim (what you approve is what is written)', () => {
  const ledger = dipsLedger({ revise: false });
  const logRowsPreview = [['2026-07-18', 'S1', 'Weighted Dip', 'Weighted Dip', 'Chest', 'DIP01', '1', '60', '5', '2', '', '300']];
  const s = buildCloseoutSummary({
    session: SESSION, ledgerRows: ledger, items: ITEMS,
    actualRows: [dipActual(1, 60)],
    logRowsPreview, effortRowPreview: ['2026-07-18', 'S1', '00:42:00'],
    sealPreview: { would_seal: 3, already_sealed: 0 },
  });
  assert.deepEqual(s.rows_to_write.log, logRowsPreview, 'byte-identical echo of the write rows');
  assert.deepEqual(s.rows_to_write.effort, ['2026-07-18', 'S1', '00:42:00']);
  assert.equal(s.rows_to_seal.count, 3);
  assert.equal(s.session_id, 'S1');
  assert.equal(s.session_date, '2026-07-18');
});

test('a performed value NEVER appears as a target: actual-only lifts carry no target fields at all', () => {
  const s = buildCloseoutSummary({
    session: SESSION, ledgerRows: [], items: [],
    actualRows: [dipActual(1, 60)], logRowsPreview: [], effortRowPreview: null,
  });
  const up = s.unplanned[0];
  assert.equal('target_weight' in up.sets[0], false, 'no target field exists to be conflated with the actual');
  assert.equal(up.sets[0].weight, 60);
});

// ── F-SB3: substitution coherence detector (owner ruling 2026-08-02) ──────────
//
// Pure, canonical-state-only. It reads the closeout context's structured items and the ONE
// unresolved substitution proposal — never exercise similarity, never freeform prose. The
// failure condition is a CONTRADICTION, not incompleteness.

const { detectSubstitutionContradictions, boundCloseoutPendingSubstitution } = require('../services/closeoutSummary');

const codes = ctx => detectSubstitutionContradictions(ctx).map(x => x.code);

test('F-SB3 detector: a coherent closeout reports nothing', () => {
  assert.deepEqual(codes({ items: [
    { plan_item_id: 'pi_1', planned_lift_code: 'SQ01', outcome: 'completed' },
    { plan_item_id: 'pi_2', planned_lift_code: 'BEN01', outcome: 'skipped' },          // honest unfinished lift
    { plan_item_id: 'pi_3', performed_lift_code: 'IDB01', outcome: 'substituted' },    // bound swap
    { plan_item_id: 'pi_4', planned_lift_code: 'SR01' },                               // started, no outcome
  ] }), []);
  assert.deepEqual(codes({}), [], 'no context at all is not a contradiction');
  assert.deepEqual(codes({ items: [] }), []);
});

test('F-SB3 detector: a substituted outcome with no performed lift is a contradiction', () => {
  assert.deepEqual(codes({ items: [{ plan_item_id: 'pi_1', outcome: 'substituted' }] }),
    ['substitution_outcome_without_performed_lift']);
});

test('F-SB3 detector: one logged movement cannot satisfy two planned slots', () => {
  assert.deepEqual(codes({ items: [
    { plan_item_id: 'pi_1', performed_lift_code: 'IDB01', outcome: 'substituted' },
    { plan_item_id: 'pi_2', performed_lift_code: 'idb01', outcome: 'substituted' },
  ] }), ['duplicate_substitution_binding']);
});

test("F-SB3 detector: the owner's exact shape — an unresolved proposal over a still-pending source", () => {
  const ctx = {
    items: [{ plan_item_id: 'pi_ben', planned_lift_code: 'BEN01', name: 'Bench Press' }],
    pending_substitution: {
      source_plan_item_id: 'pi_ben', source_name: 'Bench Press',
      replacement_name: 'Incline Dumbbell Press', replacement_lift_code: 'IDB01',
    },
  };
  assert.deepEqual(codes(ctx), ['unresolved_substitution_proposal']);
  // A source slot the athlete actually COMPLETED (they did the original lift instead)
  // resolves the proposal by declining it — no contradiction.
  ctx.items[0].outcome = 'completed';
  assert.deepEqual(codes(ctx), []);
  // …and a source slot that was canonically substituted is resolved too.
  ctx.items[0].outcome = 'substituted';
  ctx.items[0].performed_lift_code = 'IDB01';
  assert.deepEqual(codes(ctx), []);
  // A proposal whose source is a SKIPPED slot is still unresolved: the athlete asked for a
  // swap, the swap never happened, and the lift was never done.
  ctx.items[0].outcome = 'skipped';
  delete ctx.items[0].performed_lift_code;
  assert.deepEqual(codes(ctx), ['unresolved_substitution_proposal']);
});

test('F-SB3 detector: the pending proposal is bounded, and a proposal with no identity is ignored', () => {
  assert.equal(boundCloseoutPendingSubstitution(null), null);
  assert.equal(boundCloseoutPendingSubstitution({ source_name: 'Bench Press' }), null,
    'without the source plan_item_id there is no ledger identity to test against');
  const bounded = boundCloseoutPendingSubstitution({
    source_plan_item_id: ' pi_ben ', source_name: 'x'.repeat(500),
    replacement_name: 'Incline Dumbbell Press', replacement_lift_code: 'IDB01', junk: 'dropped',
  });
  assert.equal(bounded.source_plan_item_id, 'pi_ben');
  assert.equal(bounded.source_name.length, 200, 'every string is capped');
  assert.equal('junk' in bounded, false, 'unknown fields never reach the verdict');
});
