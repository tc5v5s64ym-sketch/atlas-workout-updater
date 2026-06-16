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
function weeklyMuscleVolume(logRows, { days = 7 } = {}) {
  if (!Array.isArray(logRows) || logRows.length === 0) return emptyMuscleTally();

  const windowDays = Math.max(1, Number(days) || 7);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  // Accumulate raw counts; liftsContributing as Set to deduplicate
  const acc = {};
  for (const muscle of TAXONOMY) {
    acc[muscle] = { directSets: 0, indirectSets: 0, totalEffectiveSets: 0, _lifts: new Set() };
  }

  for (const raw of logRows) {
    const row = normalizeLogRow(raw);
    if (!row.date_clean || row.date_clean < cutoffIso) continue;

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
