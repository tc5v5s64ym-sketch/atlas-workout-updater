'use strict';

// #1341 — Weekly volume ledger (Corpus V2 §F.6). Failing-first tests for the
// ledger core: hard-set counting (warm-ups excluded), per-muscle actuals vs the
// MUSCLE_TARGETS band, surplus flag + redirect candidates, and the volume_ledger
// emission the corpus detector reads. Skip-category persistence is NOT in this
// slice (new Session_Plans column = schema change, owner-gated; follow-up PR).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildVolumeLedger, countSkips } = require('../services/volumeLedger');
const { foldSessionPlans } = require('../services/sessionPlanReader');
const { buildPlanAcceptedEvents, buildItemOutcomeEvent, buildSessionCloseoutEvent } = require('../services/sessionPlanEvents');
const { weeklyMuscleVolume } = require('../services/muscleVolume');
const { TAXONOMY } = require('../services/muscleCoverage');
const { sanitizeChatContext } = require('../services/coach');

// ─── Fake log rows ─────────────────────────────────────────────────────────────
// Each row = one set. Columns: date, session_id, exercise, canonical_exercise,
// muscle_group, lift_code, set_number, weight, reps, rir, notes, volume_calc
// Hand-computed expected credits below — do not generate from code.

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
const D_RECENT = isoDaysAgo(3);
const D_OLD = isoDaysAgo(10); // outside a 7-day window

function row(date, exercise, setNum = '1', notes = '') {
  return [date, 'S1', exercise, exercise, 'Test', 'T01', setNum, '100', '8', '2', notes, '800'];
}

// Probe-1 fixture (from the #1341 verify-first determination): 2 working + 2
// warm-up-tagged Bench Press sets. Bench Press → chest primary (1.0/set),
// triceps + front_delts secondary (0.5/set). Hard-set expectation: chest 2.
const PROBE1_ROWS = [
  row(D_RECENT, 'Bench Press', '1'),
  row(D_RECENT, 'Bench Press', '2'),
  row(D_RECENT, 'Bench Press', '3', 'warm-up'),
  row(D_RECENT, 'Bench Press', '4', 'warm-up'),
];

// Probe-2 fixture: quads 15 working sets (over the 12 max) + chest 2 working
// sets (under the 4 min) — the surplus → redirect case.
function probe2Rows() {
  const rows = [row(D_RECENT, 'Bench Press', '1'), row(D_RECENT, 'Bench Press', '2')];
  for (let i = 1; i <= 15; i += 1) rows.push(row(D_RECENT, 'Back Squat', String(i)));
  return rows;
}

test('#1341 ledger: warm-up sets do not count as hard sets (probe-1 fixture)', () => {
  const ledger = buildVolumeLedger(PROBE1_ROWS, { days: 7 });
  assert.equal(ledger.muscles.chest.directSets, 2, 'chest hard sets exclude warm-ups');
  assert.equal(ledger.muscles.chest.totalEffectiveSets, 2, 'chest effective sets exclude warm-ups');
  assert.equal(ledger.muscles.triceps.indirectSets, 2, 'triceps indirect sets exclude warm-ups');
  assert.equal(ledger.muscles.triceps.totalEffectiveSets, 1, 'triceps effective sets exclude warm-ups');
});

test('#1341 ledger: weeklyMuscleVolume gains an excludeWarmups option, default off', () => {
  const hard = weeklyMuscleVolume(PROBE1_ROWS, { days: 7, excludeWarmups: true });
  assert.equal(hard.chest.directSets, 2, 'excludeWarmups drops warm-up rows');
  const all = weeklyMuscleVolume(PROBE1_ROWS, { days: 7 });
  assert.equal(all.chest.directSets, 4, 'default counting is unchanged (warm-ups still count generally)');
});

test('#1341 ledger: per-muscle status vs the target band (under / adequate / surplus)', () => {
  const ledger = buildVolumeLedger(probe2Rows(), { days: 7 });
  const chest = ledger.muscles.chest;
  assert.deepEqual(chest.targetRange, { min: 4, max: 12 });
  assert.equal(chest.currentEffectiveSets, 2);
  assert.equal(chest.status, 'under');
  const quads = ledger.muscles.quads;
  assert.deepEqual(quads.targetRange, { min: 4, max: 12 });
  assert.equal(quads.currentEffectiveSets, 15);
  assert.equal(quads.status, 'surplus');
  assert.equal(quads.surplusSets, 3, 'surplus is the over-max remainder');
});

test('#1341 ledger: surplus names redirect candidates to under-target muscles', () => {
  const ledger = buildVolumeLedger(probe2Rows(), { days: 7 });
  // Hand-computed: 15 Back Squats credit quads 15 direct + glutes 15 direct +
  // lower_back 7.5 indirect (0.5/set) — all three over their maxima.
  assert.equal(ledger.surplus.length, 3, 'three surplus muscles');
  assert.deepEqual(
    ledger.surplus.map((s) => [s.muscle, s.surplusSets]),
    [['lower_back', 1.5], ['quads', 3], ['glutes', 7]],
    'surplus is the over-max remainder, taxonomy order'
  );
  // Candidates rank under-target muscles by largest deficit first: lats (0/4)
  // is the largest deficit, so quads → lats leads with suggested min(3, 4) = 3.
  const toLats = ledger.redirectCandidates.find(
    (c) => c.fromMuscle === 'quads' && c.toMuscle === 'lats'
  );
  assert.ok(toLats, 'a redirect candidate names the most under-target muscle');
  assert.equal(toLats.deficitSets, 4, 'lats is 4 sets short of its minimum');
  assert.equal(toLats.suggestedSets, 3, 'suggested is min(surplus, deficit)');
  assert.equal(ledger.muscles.chest.deficitSets, 2, 'chest is 2 sets short of its minimum');
});

test('#1341 ledger: empty log yields all 17 muscles, all under, no surplus', () => {
  const ledger = buildVolumeLedger([], { days: 7 });
  assert.equal(ledger.windowDays, 7);
  assert.deepEqual(Object.keys(ledger.muscles).sort(), [...TAXONOMY].sort());
  assert.ok(Object.values(ledger.muscles).every((m) => m.status === 'under'));
  assert.deepEqual(ledger.surplus, []);
  assert.deepEqual(ledger.redirectCandidates, []);
});

test('#1341 ledger: rows outside the 7-day window do not count', () => {
  const rows = [row(D_OLD, 'Bench Press', '1'), row(D_OLD, 'Bench Press', '2'), ...PROBE1_ROWS];
  const ledger = buildVolumeLedger(rows, { days: 7 });
  assert.equal(ledger.muscles.chest.directSets, 2, '10-day-old sets are outside the window');
});

test('#1341 ledger: sanitizeChatContext forwards volume_ledger, sanitized', () => {
  const clean = sanitizeChatContext({
    volume_ledger: {
      windowDays: 7,
      muscles: {
        chest: { currentEffectiveSets: 2, targetRange: { min: 4, max: 12 }, status: 'under', secret: 'INJECTED' },
        quads: { currentEffectiveSets: 15, targetRange: { min: 4, max: 12 }, status: 'surplus' },
      },
      surplus: [{ muscle: 'quads', surplusSets: 3 }],
      redirectCandidates: [{ fromMuscle: 'quads', toMuscle: 'chest', deficitSets: 2, suggestedSets: 2 }],
    },
  });
  assert.ok(clean.volume_ledger, 'volume_ledger survives sanitization');
  assert.equal(clean.volume_ledger.muscles.chest.status, 'under');
  assert.ok(!('secret' in clean.volume_ledger.muscles.chest), 'unknown keys do not leak through');
  assert.equal(clean.volume_ledger.surplus[0].muscle, 'quads');
});

test('#1341 ledger: sanitizeChatContext yields a null volume_ledger when absent', () => {
  const clean = sanitizeChatContext({});
  assert.equal(clean.volume_ledger, null);
});

// ── skip-category accounting (#1341 follow-up) ───────────────────────────────
// The ledger counts categorized skips per muscle per week from folded
// Session_Plans sessions. Muscle attribution reuses musclesFor on the resolved
// lift NAME (the catalog resolves planned_lift_code → name at the call site);
// a skip counts 1 against EACH primary muscle, mirroring how a performed set
// credits each primary. Totals count skipped ITEMS (a multi-primary skip is one
// item, counted once in total). Error sessions never contribute.

const SKIP_TODAY = '2026-07-10';
const SKIP_NAMES = { BEN01: 'Bench Press', SQ01: 'Back Squat', OHP01: 'Overhead Press' };
const liftNameFor = (code) => SKIP_NAMES[code] || null;

// Build folded sessions from builder rows: items are { plan_item_id,
// planned_lift_code, outcome, skip_category? }.
function foldedSkips(sessions) {
  const rows = [];
  for (const s of sessions) {
    const session = { session_id: s.id, session_date: s.date, plan_version: 'v1' };
    const items = s.items.map((it) => ({ plan_item_id: it.plan_item_id, planned_order: 1, planned_lift_code: it.planned_lift_code, movement_pattern: 'horizontal_push' }));
    rows.push(...buildPlanAcceptedEvents(session, items, { recordedAt: 'r0' }));
    for (const it of s.items) {
      rows.push(buildItemOutcomeEvent(session, { ...it, movement_pattern: 'horizontal_push' }, { recordedAt: 'r1' }));
    }
    rows.push(buildSessionCloseoutEvent(session, 'finalized', { recordedAt: 'rz' }));
  }
  return foldSessionPlans(rows);
}

test('#1341 skips: countSkips totals + byCategory from folded sessions', () => {
  const planSessions = foldedSkips([{
    id: 'S1', date: '2026-07-08', items: [
      { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'skipped', skip_category: 'deliberate' },
      { plan_item_id: 'i2', planned_lift_code: 'BEN01', outcome: 'skipped', skip_category: 'deliberate' },
      { plan_item_id: 'i3', planned_lift_code: 'SQ01', outcome: 'skipped', skip_category: 'time' },
      { plan_item_id: 'i4', planned_lift_code: 'OHP01', outcome: 'skipped' }, // uncategorized
      { plan_item_id: 'i5', planned_lift_code: 'BEN01', outcome: 'completed' }, // not a skip
    ],
  }]);
  const skips = countSkips(planSessions, { days: 7, today: SKIP_TODAY, liftNameFor });
  assert.equal(skips.total, 4, 'four skipped items (the completed one is not a skip)');
  assert.deepEqual(skips.byCategory, { deliberate: 2, time: 1, truncated: 0, uncategorized: 1 });
  assert.equal(skips.planDataAvailable, true);
});

test('#1341 skips: byMuscle attributes each primary muscle (mirrors set credit)', () => {
  const planSessions = foldedSkips([{
    id: 'S1', date: '2026-07-08', items: [
      { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'skipped', skip_category: 'deliberate' },
      { plan_item_id: 'i2', planned_lift_code: 'SQ01', outcome: 'skipped', skip_category: 'time' },
    ],
  }]);
  const skips = countSkips(planSessions, { days: 7, today: SKIP_TODAY, liftNameFor });
  // Bench Press → chest primary; Back Squat → quads + glutes primary.
  assert.equal(skips.byMuscle.chest.total, 1);
  assert.deepEqual(skips.byMuscle.chest.byCategory, { deliberate: 1, time: 0, truncated: 0, uncategorized: 0 });
  assert.deepEqual(skips.byMuscle.chest.lifts, ['BEN01']);
  assert.equal(skips.byMuscle.quads.total, 1);
  assert.equal(skips.byMuscle.glutes.total, 1, 'a multi-primary skip counts against each primary');
  assert.deepEqual(skips.byMuscle.quads.lifts, ['SQ01']);
  assert.equal(skips.total, 2, 'total counts skipped ITEMS, not muscle attributions');
});

test('#1341 skips: an unresolvable lift code lands in the unknown bucket (never dropped)', () => {
  const planSessions = foldedSkips([{
    id: 'S1', date: '2026-07-08', items: [
      { plan_item_id: 'i1', planned_lift_code: 'XXX01', outcome: 'skipped', skip_category: 'truncated' },
    ],
  }]);
  const withoutResolver = countSkips(planSessions, { days: 7, today: SKIP_TODAY });
  assert.equal(withoutResolver.total, 1);
  assert.equal(withoutResolver.byMuscle.unknown.total, 1);
  assert.deepEqual(withoutResolver.byMuscle.unknown.lifts, ['XXX01']);
  const withResolver = countSkips(planSessions, { days: 7, today: SKIP_TODAY, liftNameFor });
  assert.equal(withResolver.byMuscle.unknown.total, 1, 'an unknown code stays unknown even with a resolver');
  // A code the catalog DOES name, but to a lift no muscle pattern matches, is
  // equally unknown — never guessed into a muscle.
  const namedUnknown = countSkips(planSessions, {
    days: 7, today: SKIP_TODAY, liftNameFor: (code) => (code === 'XXX01' ? 'Zanzibar Press' : SKIP_NAMES[code] || null),
  });
  assert.equal(namedUnknown.byMuscle.unknown.total, 1, 'an unmapped lift name stays unknown');
  assert.equal(namedUnknown.byMuscle.unknown.byCategory.truncated, 1);
});

test('#1341 skips: sessions outside the window and error sessions do not count', () => {
  const inWindow = foldedSkips([{
    id: 'S1', date: '2026-07-08', items: [
      { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'skipped', skip_category: 'deliberate' },
    ],
  }]);
  const old = foldedSkips([{
    id: 'S0', date: '2026-07-01', items: [
      { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'skipped', skip_category: 'deliberate' },
    ],
  }]);
  const future = foldedSkips([{
    id: 'S2', date: '2026-07-11', items: [
      { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'skipped', skip_category: 'deliberate' },
    ],
  }]);
  // An error session: corrupt data must never feed the accounting (fail closed).
  const errorSession = [{ session_id: 'SERR', plan_version: 'v1', date: '2026-07-08', status: 'error', items: [{ plan_item_id: 'i1', planned_lift_code: 'BEN01', movement_pattern: 'horizontal_push', outcome: 'skipped', performed_lift_code: null, skip_category: 'deliberate' }], planned: ['BEN01'], completed: [] }];
  const skips = countSkips([...inWindow, ...old, ...future, ...errorSession], { days: 7, today: SKIP_TODAY, liftNameFor });
  assert.equal(skips.total, 1, 'only the in-window, non-error skip counts');
  assert.equal(skips.byMuscle.chest.total, 1);
});

test('#1341 skips: buildVolumeLedger carries the skips section when plan data is supplied', () => {
  const planSessions = foldedSkips([{
    id: 'S1', date: '2026-07-08', items: [
      { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'skipped', skip_category: 'deliberate' },
    ],
  }]);
  // Log rows dated against the same anchor (PROBE1_ROWS are dated relative to
  // real-now, which is after this fixed anchor and would fall outside the window).
  const logRows = [row('2026-07-08', 'Bench Press', '1'), row('2026-07-08', 'Bench Press', '2')];
  const ledger = buildVolumeLedger(logRows, { days: 7, today: SKIP_TODAY, planSessions, liftNameFor });
  assert.equal(ledger.skips.total, 1);
  assert.equal(ledger.skips.byCategory.deliberate, 1);
  assert.equal(ledger.skips.byMuscle.chest.total, 1);
  assert.equal(ledger.skips.planDataAvailable, true);
  // The set accounting is untouched by the skip input.
  assert.equal(ledger.muscles.chest.directSets, 2);
});

test('#1341 skips: buildVolumeLedger without plan data reports zero skips, planDataAvailable:false', () => {
  const ledger = buildVolumeLedger(PROBE1_ROWS, { days: 7, today: SKIP_TODAY });
  assert.deepEqual(ledger.skips, {
    total: 0,
    byCategory: { deliberate: 0, time: 0, truncated: 0, uncategorized: 0 },
    byMuscle: {},
    planDataAvailable: false,
  });
});

test('#1341 skips: sanitizeChatContext forwards skips, sanitized and bounded', () => {
  const clean = sanitizeChatContext({
    volume_ledger: {
      windowDays: 7,
      muscles: {
        chest: { currentEffectiveSets: 2, targetRange: { min: 4, max: 12 }, status: 'under' },
      },
      surplus: [],
      redirectCandidates: [],
      skips: {
        total: 2,
        byCategory: { deliberate: 2, time: 0, truncated: 0, uncategorized: 0, injected: 9 },
        byMuscle: {
          chest: { total: 2, byCategory: { deliberate: 2, time: 0, truncated: 0, uncategorized: 0 }, lifts: ['BEN01'], secret: 'INJECTED' },
        },
        planDataAvailable: true,
        secret: 'INJECTED',
      },
    },
  });
  assert.ok(clean.volume_ledger, 'volume_ledger survives sanitization');
  assert.equal(clean.volume_ledger.skips.total, 2);
  assert.equal(clean.volume_ledger.skips.byCategory.deliberate, 2);
  assert.ok(!('injected' in clean.volume_ledger.skips.byCategory), 'unknown category keys do not leak through');
  assert.equal(clean.volume_ledger.skips.byMuscle.chest.total, 2);
  assert.deepEqual(clean.volume_ledger.skips.byMuscle.chest.lifts, ['BEN01']);
  assert.ok(!('secret' in clean.volume_ledger.skips.byMuscle.chest), 'unknown muscle keys do not leak through');
  assert.ok(!('secret' in clean.volume_ledger.skips), 'unknown skips keys do not leak through');
  assert.equal(clean.volume_ledger.skips.planDataAvailable, true);
});
