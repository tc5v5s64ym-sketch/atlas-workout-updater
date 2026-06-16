'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { weeklyMuscleVolume } = require('../services/muscleVolume');
const { TAXONOMY } = require('../services/muscleCoverage');

// ─── Fake log rows ─────────────────────────────────────────────────────────────
// Each row = one set. Columns: date, session_id, exercise, canonical_exercise,
// muscle_group, lift_code, set_number, weight, reps, rir, notes, volume_calc
// Hand-computed expected credits below — do not generate from code.

const TODAY = new Date().toISOString().slice(0, 10);

// 10 days ago — outside a 7-day window, inside a 14-day window
const D_OLD = (() => {
  const d = new Date(); d.setDate(d.getDate() - 10);
  return d.toISOString().slice(0, 10);
})();

// 3 days ago — inside any window ≥ 3
const D_RECENT = (() => {
  const d = new Date(); d.setDate(d.getDate() - 3);
  return d.toISOString().slice(0, 10);
})();

function row(date, exercise, setNum = '1') {
  return [date, 'S1', exercise, exercise, 'Test', 'T01', setNum, '100', '8', '2', '', '800'];
}

/* ─── Golden fixture (hand-computed) ─────────────────────────────────────────
 * Log (within 7-day window):
 *   Bench Press × 3 sets  → chest primary (3.0 direct), triceps secondary (1.5 indirect), front_delts secondary (1.5 indirect)
 *   Deadlift   × 2 sets   → glutes primary (2.0), hamstrings primary (2.0), lower_back primary (2.0)
 *                            traps secondary (1.0), lats secondary (1.0), forearms secondary (1.0)
 *   Lat Pulldown × 2 sets → lats primary (2.0), biceps secondary (1.0)
 *
 * Expected totals:
 *   chest:       directSets=3, indirectSets=0, totalEffectiveSets=3.0
 *   triceps:     directSets=0, indirectSets=3, totalEffectiveSets=1.5
 *   front_delts: directSets=0, indirectSets=3, totalEffectiveSets=1.5
 *   glutes:      directSets=2, indirectSets=0, totalEffectiveSets=2.0
 *   hamstrings:  directSets=2, indirectSets=0, totalEffectiveSets=2.0
 *   lower_back:  directSets=2, indirectSets=0, totalEffectiveSets=2.0
 *   traps:       directSets=0, indirectSets=2, totalEffectiveSets=1.0
 *   lats:        directSets=2, indirectSets=2, totalEffectiveSets=3.0   (Pulldown primary + Deadlift secondary)
 *   forearms:    directSets=0, indirectSets=2, totalEffectiveSets=1.0
 *   biceps:      directSets=0, indirectSets=2, totalEffectiveSets=1.0
 */

const FIXTURE_ROWS = [
  row(D_RECENT, 'Bench Press', '1'),
  row(D_RECENT, 'Bench Press', '2'),
  row(D_RECENT, 'Bench Press', '3'),
  row(TODAY,    'Deadlift',    '1'),
  row(TODAY,    'Deadlift',    '2'),
  row(TODAY,    'Lat Pulldown', '1'),
  row(TODAY,    'Lat Pulldown', '2'),
];

/* ─── structural guarantees ─────────────────────────────────────────────────── */

test('all 17 taxonomy muscles are present in the result', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  for (const muscle of TAXONOMY) {
    assert.ok(muscle in result, `missing muscle: ${muscle}`);
    const m = result[muscle];
    assert.ok(typeof m.directSets === 'number', `${muscle}.directSets must be number`);
    assert.ok(typeof m.indirectSets === 'number', `${muscle}.indirectSets must be number`);
    assert.ok(typeof m.totalEffectiveSets === 'number', `${muscle}.totalEffectiveSets must be number`);
    assert.ok(Array.isArray(m.liftsContributing), `${muscle}.liftsContributing must be array`);
  }
});

test('empty / bad inputs return zero-filled tally', () => {
  for (const bad of [[], null, undefined, 'nope']) {
    const result = weeklyMuscleVolume(bad);
    for (const muscle of TAXONOMY) {
      assert.ok(muscle in result, `${muscle} missing from result for input ${JSON.stringify(bad)}`);
      assert.equal(result[muscle].totalEffectiveSets, 0);
      assert.deepEqual(result[muscle].liftsContributing, []);
    }
  }
});

/* ─── golden fixture spot-checks ─────────────────────────────────────────────── */

test('Bench Press × 3 sets: chest = 3.0 direct effective sets', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  assert.equal(result.chest.directSets, 3);
  assert.equal(result.chest.indirectSets, 0);
  assert.equal(result.chest.totalEffectiveSets, 3.0);
  assert.ok(result.chest.liftsContributing.includes('Bench Press'));
});

test('Bench Press × 3 sets: triceps = 1.5 indirect effective sets (0.5 × 3)', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  assert.equal(result.triceps.directSets, 0);
  assert.equal(result.triceps.indirectSets, 3);
  assert.equal(result.triceps.totalEffectiveSets, 1.5);
  assert.ok(result.triceps.liftsContributing.includes('Bench Press'));
});

test('Bench Press × 3 sets: front_delts = 1.5 indirect effective sets', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  assert.equal(result.front_delts.totalEffectiveSets, 1.5);
  assert.equal(result.front_delts.directSets, 0);
});

test('Deadlift × 2 sets: glutes + hamstrings + lower_back each = 2.0 direct', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  for (const muscle of ['glutes', 'hamstrings', 'lower_back']) {
    assert.equal(result[muscle].directSets, 2, `${muscle}.directSets`);
    assert.equal(result[muscle].totalEffectiveSets, 2.0, `${muscle}.totalEffectiveSets`);
    assert.ok(result[muscle].liftsContributing.includes('Deadlift'));
  }
});

test('Deadlift × 2 sets: traps + forearms = 1.0 indirect effective sets (0.5 × 2)', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  for (const muscle of ['traps', 'forearms']) {
    assert.equal(result[muscle].directSets, 0, `${muscle}.directSets`);
    assert.equal(result[muscle].indirectSets, 2, `${muscle}.indirectSets`);
    assert.equal(result[muscle].totalEffectiveSets, 1.0, `${muscle}.totalEffectiveSets`);
  }
});

test('lats: Pulldown primary (2×1.0) + Deadlift secondary (2×0.5) = 3.0 effective', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  assert.equal(result.lats.directSets, 2);    // from Lat Pulldown
  assert.equal(result.lats.indirectSets, 2);  // from Deadlift
  assert.equal(result.lats.totalEffectiveSets, 3.0);
  assert.ok(result.lats.liftsContributing.includes('Deadlift'));
  assert.ok(result.lats.liftsContributing.includes('Lat Pulldown'));
});

test('biceps: Lat Pulldown secondary (2×0.5) = 1.0 indirect effective sets', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  assert.equal(result.biceps.directSets, 0);
  assert.equal(result.biceps.indirectSets, 2);
  assert.equal(result.biceps.totalEffectiveSets, 1.0);
});

test('untrained muscles (e.g. side_delts, quads, calves) have zero effective sets', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  for (const muscle of ['side_delts', 'quads', 'calves', 'abs', 'obliques']) {
    assert.equal(result[muscle].totalEffectiveSets, 0, `${muscle} should be 0`);
    assert.deepEqual(result[muscle].liftsContributing, []);
  }
});

/* ─── rolling window ─────────────────────────────────────────────────────────── */

test('rows outside the window are excluded', () => {
  const withOld = [
    ...FIXTURE_ROWS,
    row(D_OLD, 'Shrugs', '1'),  // 10 days ago, outside 7-day window
    row(D_OLD, 'Shrugs', '2'),
  ];
  const result7  = weeklyMuscleVolume(withOld, { days: 7 });
  const result14 = weeklyMuscleVolume(withOld, { days: 14 });

  assert.equal(result7.traps.directSets, 0, 'Shrugs (10 days ago) excluded from 7-day window');
  assert.equal(result14.traps.directSets, 2, 'Shrugs (10 days ago) included in 14-day window');
});

test('boundary is inclusive: row at exactly cutoff day is included', () => {
  const exactCutoff = (() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  const result = weeklyMuscleVolume([row(exactCutoff, 'Shrugs', '1')], { days: 7 });
  assert.equal(result.traps.directSets, 1, 'row at exactly cutoff day must be included');
});

test('boundary is exclusive one day beyond: row at cutoff+1 days is excluded', () => {
  const beyondCutoff = (() => {
    const d = new Date(); d.setDate(d.getDate() - 8);
    return d.toISOString().slice(0, 10);
  })();
  const result = weeklyMuscleVolume([row(beyondCutoff, 'Shrugs', '1')], { days: 7 });
  assert.equal(result.traps.directSets, 0, 'row one day beyond cutoff must be excluded');
});

/* ─── liftsContributing ─────────────────────────────────────────────────────── */

test('liftsContributing is deduplicated (same lift in multiple sets = one entry)', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  const benchOccurrences = result.chest.liftsContributing.filter(l => l === 'Bench Press');
  assert.equal(benchOccurrences.length, 1, 'Bench Press appears exactly once');
});

test('liftsContributing is sorted alphabetically', () => {
  const result = weeklyMuscleVolume(FIXTURE_ROWS);
  const lifts = result.lats.liftsContributing;
  assert.deepEqual(lifts, [...lifts].sort());
});

/* ─── unknown lifts are skipped ─────────────────────────────────────────────── */

test('unknown/needsReview lifts contribute no volume', () => {
  const rows = [
    row(TODAY, 'Alien Barbell Spinoza Machine', '1'),
    row(TODAY, 'Bench Press', '1'),
  ];
  const result = weeklyMuscleVolume(rows);
  assert.equal(result.chest.directSets, 1);
  // nothing weird landed in any muscle from the unknown lift
  for (const muscle of TAXONOMY) {
    assert.ok(result[muscle].totalEffectiveSets <= 1.5,
      `${muscle} should not have unexpected volume from unknown lift`);
  }
});

/* ─── object-form rows (pre-normalized) ─────────────────────────────────────── */

test('accepts pre-normalized object-form rows', () => {
  const objectRows = [
    { date_clean: TODAY, session_id: 'S1', exercise: 'Shrugs', canonical_exercise: 'Shrugs',
      muscle_group: 'Traps', lift_code: 'SH01', set_number: '1', weight: 80, reps: 12, rir: 2, notes: '' },
  ];
  const result = weeklyMuscleVolume(objectRows);
  assert.equal(result.traps.directSets, 1);
  assert.equal(result.traps.totalEffectiveSets, 1.0);
});

/* ─── today anchor (deterministic window) ────────────────────────────────────
 * Hand-computed: anchor 2026-06-14, days=7 → cutoff 2026-06-07.
 * Row at 2026-06-07 is included; row at 2026-06-06 is excluded.
 * ─────────────────────────────────────────────────────────────────────────── */

function fixedRow(date, exercise, liftCode, setNum = '1') {
  return [date, 'S1', exercise, exercise, 'Test', liftCode, setNum, '100', '8', '2', '', '800'];
}

test('today option: anchors the window to a fixed date', () => {
  const rows = [
    fixedRow('2026-06-07', 'Shrugs', 'SH01', '1'), // at exactly cutoff → included
    fixedRow('2026-06-06', 'Shrugs', 'SH01', '2'), // one day before cutoff → excluded
  ];
  const result = weeklyMuscleVolume(rows, { today: '2026-06-14', days: 7 });
  assert.equal(result.traps.directSets, 1, 'row at cutoff day included');
  assert.equal(result.traps.totalEffectiveSets, 1.0);
});

test('today option: rows after the anchor are excluded', () => {
  const rows = [
    fixedRow('2026-06-14', 'Shrugs', 'SH01', '1'), // at anchor → included
    fixedRow('2026-06-15', 'Shrugs', 'SH01', '2'), // one day after anchor → excluded
  ];
  const result = weeklyMuscleVolume(rows, { today: '2026-06-14', days: 7 });
  assert.equal(result.traps.directSets, 1, 'row after anchor excluded');
});

/* ─── excludeLiftCode option ─────────────────────────────────────────────────
 * Deadlift (DL01) × 3 sets: traps secondary 0.5/set = 1.5.
 * Bench Press (BP01) × 2 sets: chest primary 1.0/set = 2.0.
 * Excluding DL01 removes traps contribution; chest from BP01 remains.
 * ─────────────────────────────────────────────────────────────────────────── */

test('excludeLiftCode: excluded lift contributes no volume', () => {
  const rows = [
    fixedRow('2026-06-14', 'Deadlift', 'DL01', '1'),
    fixedRow('2026-06-14', 'Deadlift', 'DL01', '2'),
    fixedRow('2026-06-14', 'Deadlift', 'DL01', '3'),
    fixedRow('2026-06-14', 'Bench Press', 'BP01', '1'),
    fixedRow('2026-06-14', 'Bench Press', 'BP01', '2'),
  ];
  const result = weeklyMuscleVolume(rows, { today: '2026-06-14', excludeLiftCode: 'DL01' });
  assert.equal(result.traps.indirectSets, 0, 'Deadlift excluded → traps = 0');
  assert.equal(result.traps.totalEffectiveSets, 0);
  assert.equal(result.chest.directSets, 2, 'Bench Press not excluded → chest = 2');
});

test('excludeLiftCode is case-insensitive (stored as uppercase in log)', () => {
  const rows = [
    fixedRow('2026-06-14', 'Deadlift', 'DL01', '1'),
  ];
  const lower = weeklyMuscleVolume(rows, { today: '2026-06-14', excludeLiftCode: 'dl01' });
  const upper = weeklyMuscleVolume(rows, { today: '2026-06-14', excludeLiftCode: 'DL01' });
  assert.equal(lower.hamstrings.directSets, 0, 'lower-case excludeLiftCode works');
  assert.equal(upper.hamstrings.directSets, 0, 'upper-case excludeLiftCode works');
});
