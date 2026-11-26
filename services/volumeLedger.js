'use strict';

// Weekly volume ledger — Corpus V2 §F.6, issue #1341.
//
// Assembles the hard-sets-per-muscle-per-week ledger the coach surfaces: every
// taxonomy muscle's actual hard sets against its MUSCLE_TARGETS band, the
// muscles over band (surplus), and redirect candidates that move surplus volume
// to under-target muscles.
//
// Pure, read-only, no I/O. The engine computes; the coach only words it.
//
// Design notes:
//   - Hard sets = working sets only. Note-tagged warm-ups are excluded via
//     weeklyMuscleVolume's excludeWarmups option — scoped to this ledger. Warm-ups
//     still count toward total session volume elsewhere (owner rule 2026-06-25).
//   - Status vocabulary is the ledger's own: under (< min), adequate
//     (min..max inclusive), surplus (> max). This differs deliberately from
//     computeUnderCoverage's 'optimal' (>= max): at the ceiling is adequate,
//     only strictly-over is surplus.
//   - Redirect candidates are deterministic arithmetic on ledger facts:
//     suggestedSets = min(surplusSets, deficitSets). They name a direction, not
//     a prescription — the coach words them, the athlete decides.
//   - Skip accounting is NOT in this slice: recording a skip category needs a
//     new additive Session_Plans column (schema change, owner-gated; #1341
//     determination). The ledger carries no skip counts until that lands.

const { weeklyMuscleVolume } = require('./muscleVolume');
const { MUSCLE_TARGETS } = require('./underCoverage');
const { TAXONOMY } = require('./muscleCoverage');

// Stable ordered list for consistent output ordering.
const TAXONOMY_LIST = [...TAXONOMY];

// Status of one muscle's hard-set actuals against its band.
function ledgerStatus(effectiveSets, min, max) {
  if (effectiveSets < min) return 'under';
  if (effectiveSets > max) return 'surplus';
  return 'adequate';
}

// Build the weekly volume ledger for the log rows in a rolling window.
//
// logRows — raw log rows (array-of-arrays or array-of-objects)
// options.days — rolling window size (default 7; the MUSCLE_TARGETS band is
//   defined per 7 days — callers passing a different window must scale the band
//   themselves, so the ledger always uses 7 unless told otherwise)
// options.today — YYYY-MM-DD anchor for the window (default: real "now")
//
// Returns:
//   {
//     windowDays, asOf,
//     muscles: { [muscle]: {
//       directSets, indirectSets, totalEffectiveSets, currentEffectiveSets,
//       targetRange: { min, max }, status: 'under'|'adequate'|'surplus',
//       surplusSets, deficitSets, liftsContributing: [] } },
//     surplus: [{ muscle, surplusSets }],
//     redirectCandidates: [{ fromMuscle, surplusSets, toMuscle, deficitSets,
//       suggestedSets }],
//   }
// currentEffectiveSets === totalEffectiveSets (hard sets only); both keys are
// carried so consumers of either vocabulary read the same number.
function buildVolumeLedger(logRows, options = {}) {
  const { days = 7, today = null } = options || {};
  const volume = weeklyMuscleVolume(logRows, { days, today, excludeWarmups: true });

  const asOf = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)
    ? today
    : new Date().toISOString().slice(0, 10);

  const muscles = {};
  const surplus = [];
  const under = [];
  for (const muscle of TAXONOMY_LIST) {
    const tally = volume[muscle] || { directSets: 0, indirectSets: 0, totalEffectiveSets: 0, liftsContributing: [] };
    const { min, max } = MUSCLE_TARGETS[muscle];
    const eff = tally.totalEffectiveSets || 0;
    const status = ledgerStatus(eff, min, max);
    const surplusSets = status === 'surplus' ? Math.round((eff - max) * 10) / 10 : 0;
    const deficitSets = status === 'under' ? Math.round((min - eff) * 10) / 10 : 0;
    muscles[muscle] = {
      directSets: tally.directSets,
      indirectSets: tally.indirectSets,
      totalEffectiveSets: eff,
      currentEffectiveSets: eff,
      targetRange: { min, max },
      status,
      surplusSets,
      deficitSets,
      liftsContributing: tally.liftsContributing,
    };
    if (status === 'surplus') surplus.push({ muscle, surplusSets });
    if (status === 'under') under.push({ muscle, deficitSets });
  }

  // Redirect candidates: each surplus muscle offers its surplus to the most
  // under-target muscles first (largest deficit first, then taxonomy order for
  // determinism). At most 3 candidates per surplus muscle.
  const redirectCandidates = [];
  const rankedUnder = [...under].sort(
    (a, b) => b.deficitSets - a.deficitSets || TAXONOMY_LIST.indexOf(a.muscle) - TAXONOMY_LIST.indexOf(b.muscle)
  );
  for (const s of surplus) {
    for (const u of rankedUnder.slice(0, 3)) {
      redirectCandidates.push({
        fromMuscle: s.muscle,
        surplusSets: s.surplusSets,
        toMuscle: u.muscle,
        deficitSets: u.deficitSets,
        suggestedSets: Math.min(s.surplusSets, u.deficitSets),
      });
    }
  }

  return {
    windowDays: Math.max(1, Number(days) || 7),
    asOf,
    muscles,
    surplus,
    redirectCandidates,
  };
}

module.exports = { buildVolumeLedger, ledgerStatus };
