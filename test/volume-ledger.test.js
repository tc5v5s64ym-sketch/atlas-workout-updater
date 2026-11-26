'use strict';

// #1341 — Weekly volume ledger (Corpus V2 §F.6). Failing-first tests for the
// ledger core: hard-set counting (warm-ups excluded), per-muscle actuals vs the
// MUSCLE_TARGETS band, surplus flag + redirect candidates, and the volume_ledger
// emission the corpus detector reads. Skip-category persistence is NOT in this
// slice (new Session_Plans column = schema change, owner-gated; follow-up PR).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildVolumeLedger } = require('../services/volumeLedger');
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
