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
//   - Skip accounting (#1341 follow-up) IS in this slice: `skips` counts
//     categorized skips per muscle per week from folded Session_Plans sessions
//     (options.planSessions), with the lift name resolved by options.liftNameFor.
//     Without plan data the section is present but empty with
//     planDataAvailable:false — the ledger shape never varies by caller.

const { weeklyMuscleVolume } = require('./muscleVolume');
const { musclesFor } = require('./muscleCoverage');
const { MUSCLE_TARGETS } = require('./underCoverage');
const { TAXONOMY } = require('./muscleCoverage');
const { SKIP_CATEGORIES } = require('./sessionPlanEvents');

// Stable ordered list for consistent output ordering.
const TAXONOMY_LIST = [...TAXONOMY];

// The four skip-category buckets, zero-filled for shape stability. A skip with
// no recorded category (pre-migration row / old client) counts as 'uncategorized'.
function _emptyByCategory() {
  return { deliberate: 0, time: 0, truncated: 0, uncategorized: 0 };
}

// Count categorized skips per muscle per week from folded Session_Plans sessions
// (services/sessionPlanReader.js foldSessionPlans output).
//
// planSessions — folded sessions [{ date, status, items: [{ planned_lift_code,
//   outcome, skip_category }] }]; options.days / options.today use the SAME
//   rolling-window rule as weeklyMuscleVolume (anchor at today, cutoff = anchor -
//   days; the upper bound applies only when an explicit anchor is given).
// options.liftNameFor — optional resolver: planned_lift_code → canonical lift
//   NAME, so musclesFor (name-based, the same attribution the set accounting
//   uses) can attribute the skip. A code the resolver cannot name lands in the
//   'unknown' muscle bucket — never dropped, never guessed.
//
// Rules (all deliberate, all documented):
//   - Only items with outcome==='skipped' count; error sessions never contribute
//     (fail closed — corrupt data must not feed the accounting). Open / finalized /
//     abandoned sessions all count: a recorded skip is a recorded skip.
//   - A skip counts 1 against EACH primary muscle of its lift (mirroring how a
//     performed set credits each primary); secondary muscles are NOT credited —
//     a skipped bench is not a missed triceps set. `total` counts skipped ITEMS,
//     so the byMuscle totals can exceed it on multi-primary lifts.
//   - A session with no date cannot be placed in a week and is excluded.
function countSkips(planSessions, options = {}) {
  const { days = 7, today = null, liftNameFor = null } = options || {};
  const windowDays = Math.max(1, Number(days) || 7);
  const anchored = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today);
  const anchor = anchored ? new Date(`${today}T12:00:00Z`) : new Date();
  const cutoff = new Date(anchor.getTime());
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const anchorIso = anchor.toISOString().slice(0, 10);

  const byCategory = _emptyByCategory();
  const byMuscle = {};
  let total = 0;

  const sessions = Array.isArray(planSessions) ? planSessions : [];
  for (const sess of sessions) {
    if (!sess || typeof sess !== 'object') continue;
    if (sess.status === 'error') continue;
    const date = typeof sess.date === 'string' ? sess.date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < cutoffIso) continue;
    if (anchored && date > anchorIso) continue;
    const items = Array.isArray(sess.items) ? sess.items : [];
    for (const it of items) {
      if (!it || it.outcome !== 'skipped') continue;
      const category = SKIP_CATEGORIES.includes(it.skip_category) ? it.skip_category : 'uncategorized';
      total += 1;
      byCategory[category] += 1;
      const code = typeof it.planned_lift_code === 'string' ? it.planned_lift_code : '';
      const name = typeof liftNameFor === 'function' ? liftNameFor(code) : null;
      const { primary, needsReview } = name ? musclesFor(name) : { primary: [], needsReview: true };
      const muscles = (!needsReview && primary.length > 0) ? primary : ['unknown'];
      for (const muscle of muscles) {
        if (!byMuscle[muscle]) byMuscle[muscle] = { total: 0, byCategory: _emptyByCategory(), lifts: [] };
        const bucket = byMuscle[muscle];
        bucket.total += 1;
        bucket.byCategory[category] += 1;
        if (code && !bucket.lifts.includes(code) && bucket.lifts.length < 12) bucket.lifts.push(code);
      }
    }
  }

  return { total, byCategory, byMuscle, planDataAvailable: true };
}

// The empty skips section: no plan data was supplied, so nothing was counted —
// distinct from a week with zero recorded skips (planDataAvailable:true, total 0).
function _emptySkips() {
  return { total: 0, byCategory: _emptyByCategory(), byMuscle: {}, planDataAvailable: false };
}

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
// options.planSessions — folded Session_Plans sessions (foldSessionPlans output)
//   for the skip accounting; absent ⇒ the skips section is empty with
//   planDataAvailable:false (the chat/coach paths supply none — zero additional
//   Sheets reads there — and the volume route supplies the folded sessions)
// options.liftNameFor — planned_lift_code → canonical lift name resolver for
//   skip muscle attribution (the catalog resolves it at the call site)
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
//     skips: { total, byCategory: { deliberate, time, truncated, uncategorized },
//       byMuscle: { [muscle]: { total, byCategory, lifts: [planned_lift_codes] } },
//       planDataAvailable },
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
    skips: options.planSessions
      ? countSkips(options.planSessions, { days, today, liftNameFor: options.liftNameFor || null })
      : _emptySkips(),
  };
}

module.exports = { buildVolumeLedger, countSkips, ledgerStatus };
