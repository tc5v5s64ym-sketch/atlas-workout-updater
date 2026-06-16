'use strict';

// Weekly volume per muscle, expressed as effective sets.
// Pure functions, no I/O. Consumes log rows + the coverage map.
//
// Credit: primary muscle → 1.0 per set; secondary → 0.5 per set.
// Every row in the log represents one set.
//
// Output (per muscle, all 17 taxonomy muscles always present):
//   { directSets, indirectSets, totalEffectiveSets, liftsContributing: [] }

const { normalizeLogRow } = require('./analytics');
const { musclesFor, TAXONOMY } = require('./muscleCoverage');

function emptyMuscleTally() {
  const result = {};
  for (const muscle of TAXONOMY) {
    result[muscle] = { directSets: 0, indirectSets: 0, totalEffectiveSets: 0, liftsContributing: [] };
  }
  return result;
}

// Summarize effective sets per muscle over a rolling window.
// logRows — raw array-of-arrays or array-of-objects from the sheet
// options.days — rolling window size (default 7)
// options.today — optional YYYY-MM-DD anchor for the window's far edge. When
//   omitted the window ends at the real "now" (original behavior). Passing a
//   reference date (e.g. the most recent training date) makes the window
//   deterministic and clock-independent — used by coverage-aware stall logic.
// options.excludeLiftCode — optional lift_code to drop entirely, so a muscle's
//   volume can be measured FROM OTHER LIFTS (used to ask "is this stalled lift's
//   muscle already covered without it?").
function weeklyMuscleVolume(logRows, { days = 7, today = null, excludeLiftCode = null } = {}) {
  if (!Array.isArray(logRows) || logRows.length === 0) return emptyMuscleTally();

  const windowDays = Math.max(1, Number(days) || 7);
  // Anchor at an explicit reference date when given (noon UTC keeps the calendar
  // day stable across time zones), else "now" — preserving the original path.
  const anchored = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today);
  const anchor = anchored ? new Date(`${today}T12:00:00Z`) : new Date();
  const cutoff = new Date(anchor.getTime());
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const anchorIso = anchor.toISOString().slice(0, 10);
  const exclude = excludeLiftCode ? String(excludeLiftCode).trim().toUpperCase() : null;

  // Accumulate raw counts; liftsContributing as Set to deduplicate
  const acc = {};
  for (const muscle of TAXONOMY) {
    acc[muscle] = { directSets: 0, indirectSets: 0, totalEffectiveSets: 0, _lifts: new Set() };
  }

  for (const raw of logRows) {
    const row = normalizeLogRow(raw);
    if (!row.date_clean || row.date_clean < cutoffIso) continue;
    if (anchored && row.date_clean > anchorIso) continue;  // upper bound only when explicitly anchored
    if (exclude && row.lift_code === exclude) continue;

    const liftName = row.canonical_exercise || row.exercise;
    if (!liftName) continue;

    const { primary, secondary, needsReview } = musclesFor(liftName);
    if (needsReview) continue;

    for (const muscle of primary) {
      if (acc[muscle]) {
        acc[muscle].directSets += 1;
        acc[muscle].totalEffectiveSets += 1;
        acc[muscle]._lifts.add(liftName);
      }
    }
    for (const muscle of secondary) {
      if (acc[muscle]) {
        acc[muscle].indirectSets += 1;
        acc[muscle].totalEffectiveSets += 0.5;
        acc[muscle]._lifts.add(liftName);
      }
    }
  }

  // Finalize: convert Set → sorted array, round fractional totals
  const result = {};
  for (const [muscle, data] of Object.entries(acc)) {
    result[muscle] = {
      directSets: data.directSets,
      indirectSets: data.indirectSets,
      totalEffectiveSets: Math.round(data.totalEffectiveSets * 10) / 10,
      liftsContributing: [...data._lifts].sort(),
    };
  }
  return result;
}

module.exports = { weeklyMuscleVolume };
