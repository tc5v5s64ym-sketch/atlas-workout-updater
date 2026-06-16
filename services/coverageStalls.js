'use strict';

// Coverage-aware stall annotation (read-only, pure).
//
// detectStalls() flags every flat lift. But a flat *accessory* whose primary
// muscle is already getting enough recent volume from OTHER lifts isn't a
// program-level gap — letting it feed whole-program deload triggering produces
// false deloads (the live Shrugs / Dumbbell-Curl example in BACKLOG.md).
//
// This DOWNGRADES such a stall — marks it `ignored_for_deload: true` with a
// human-readable `ignored_reason` — it never erases it. Main- and
// secondary-role stalls, and accessory stalls whose muscle is NOT covered,
// always keep feeding the deload trigger.
//
// Consumes the Phase-1 data layers: weeklyMuscleVolume (effective-set credit)
// and muscleCoverage (which muscles a lift trains).

const { weeklyMuscleVolume } = require('./muscleVolume');
const { musclesFor } = require('./muscleCoverage');
const { isAccessory } = require('./liftRole');
const { normalizeDate } = require('./validation');

// Effective sets/week from OTHER lifts at or above which a muscle counts as
// already "covered" — enough recent stimulus that a flat isolation lift on it
// isn't a deload-worthy program gap. Coaching constant, deliberately modest so
// secondary contributions (rows/deadlifts → traps & biceps at 0.5/set) can
// clear it. Tunable at Hold Point 2 against the real training log.
const COVERED_EFFECTIVE_SETS = 2;

// Most recent training date across the log, used to anchor the coverage window
// so it lines up with the recent training block the stall was measured over
// (rather than the wall clock).
function latestLogDate(logRows) {
  let max = '';
  for (const raw of Array.isArray(logRows) ? logRows : []) {
    const value = Array.isArray(raw) ? raw[0] : (raw && (raw.date_clean || raw.date || raw.dateClean));
    const d = normalizeDate(value);
    if (d && d > max) max = d;
  }
  return max || null;
}

// Annotate each stall with { ignored_for_deload, ignored_reason }. Returns a new
// array; never mutates the input stalls.
//
// stalls   — output of detectStalls(): [{ liftCode, exercise, ... }]
// logRows  — the same recent log the stalls were computed from
// options.days — coverage window (default 7)
// options.today — anchor date (default: most recent training date in logRows)
// options.coveredThreshold — effective-set floor for "covered" (default COVERED_EFFECTIVE_SETS)
function annotateStallsForDeload(stalls, logRows, options = {}) {
  const list = Array.isArray(stalls) ? stalls : [];
  if (list.length === 0) return [];

  const {
    days = 7,
    today = latestLogDate(logRows),
    coveredThreshold = COVERED_EFFECTIVE_SETS,
  } = options || {};

  return list.map(stall => {
    const base = { ...stall, ignored_for_deload: false, ignored_reason: null };
    const name = stall && stall.exercise ? String(stall.exercise) : '';

    // Only accessories can be downgraded; main & secondary lifts always feed.
    if (!name || !isAccessory(name)) return base;

    const { primary, needsReview } = musclesFor(name);
    // Unknown / non-catalog lift → safe default: keep feeding, never guess.
    if (needsReview || !primary || primary.length === 0) return base;

    // Effective sets on each primary muscle FROM OTHER LIFTS (this lift excluded).
    const volume = weeklyMuscleVolume(logRows, { days, today, excludeLiftCode: stall.liftCode });
    const coverage = primary.map(muscle => ({
      muscle,
      sets: (volume[muscle] && volume[muscle].totalEffectiveSets) || 0,
    }));

    // Downgrade only when EVERY primary muscle is covered — err toward keeping
    // the stall, never suppress a real one.
    if (!coverage.every(c => c.sets >= coveredThreshold)) return base;

    const detail = coverage.map(c => `${c.muscle}: ${c.sets} eff. sets`).join(', ');
    return {
      ...base,
      ignored_for_deload: true,
      ignored_reason:
        `${name} is an accessory whose primary muscle${primary.length > 1 ? 's are' : ' is'} ` +
        `already covered by other lifts (${detail}) — not counted toward a program deload.`,
    };
  });
}

module.exports = { annotateStallsForDeload, latestLogDate, COVERED_EFFECTIVE_SETS };
