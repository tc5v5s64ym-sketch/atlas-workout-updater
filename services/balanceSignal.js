'use strict';

// STATUS (2026-07 architecture audit): DARK — no runtime consumer; intentional
// build-ahead from the PR 3.x coaching series (BACKLOG: "balance signal — pure
// data (39 tests)"). Wiring target not yet named.

// Balance-signal engine. Pure, read-only.
//
// Computes antagonist volume ratios across 4 structural pairs:
//   1. horizontal_push : horizontal_pull
//   2. vertical_push   : vertical_pull
//   3. anterior        : posterior  (overall chain balance)
//   4. quad            : hamstring
//
// Pairs 1–3 count working sets by movement pattern (1 per logged set, using
// patternFor). Pair 4 uses totalEffectiveSets from weeklyMuscleVolume (direct
// 1.0 + indirect 0.5 credit) because Leg Curl and Leg Extension share the
// same 'knee_isolation' pattern and cannot be distinguished at pattern level.
//
// Returns an array of 4 records in canonical pair order:
//   { pair, aSets, bSets, ratio, status, reason }
// status ∈ { 'balanced' | 'worth_a_nudge' | 'real_gap' }
// ratio is aSets/bSets rounded to 2 dp, or null when both sides are 0
// or the denominator is 0 (denominator-zero is a real_gap, see status).
//
// Sibling to services/underCoverage.js — nothing surfaces this yet.
// Consumed by the Phase 4 session builder (COACH_PLAN.md PR 4.x).

const { normalizeLogRow } = require('./analytics');
const { patternFor } = require('./movementPattern');
const { weeklyMuscleVolume } = require('./muscleVolume');

// Threshold bands (wide, per SESSION_DESIGN.md Rule B — tune against real logs).
const BALANCED_LOW  = 0.75;
const BALANCED_HIGH = 1.4;
const GAP_THRESHOLD = 2.0;   // ratio >= this OR <= 1/this → real_gap

// Canonical pair definitions.
// type 'pattern': aSets/bSets = working-set counts grouped by movement pattern
// type 'muscle' : aSets/bSets = totalEffectiveSets from weeklyMuscleVolume
const PAIRS = [
  {
    pair: 'horizontal_push:horizontal_pull',
    label: { a: 'horizontal-push', b: 'horizontal-pull' },
    type: 'pattern',
    aSide: ['horizontal_push'],
    bSide: ['horizontal_pull'],
  },
  {
    pair: 'vertical_push:vertical_pull',
    label: { a: 'vertical-push', b: 'vertical-pull' },
    type: 'pattern',
    aSide: ['vertical_push'],
    bSide: ['vertical_pull'],
  },
  {
    pair: 'anterior:posterior',
    label: { a: 'anterior', b: 'posterior' },
    type: 'pattern',
    aSide: ['horizontal_push', 'vertical_push', 'squat'],
    bSide: ['hinge', 'horizontal_pull', 'vertical_pull'],
  },
  {
    pair: 'quad:hamstring',
    label: { a: 'quad', b: 'hamstring' },
    type: 'muscle',
    aSide: ['quads'],
    bSide: ['hamstrings'],
  },
];

function computeRatio(aSets, bSets) {
  if (aSets === 0 && bSets === 0) return null;
  if (bSets === 0) return null;  // denominator zero → real_gap via status
  return Math.round((aSets / bSets) * 100) / 100;
}

function computeStatus(aSets, bSets, ratio) {
  if (aSets === 0 && bSets === 0) return 'balanced';
  if (bSets === 0) return 'real_gap';  // ratio is null but A dominates completely
  if (ratio >= BALANCED_LOW && ratio <= BALANCED_HIGH) return 'balanced';
  if (ratio >= GAP_THRESHOLD || ratio <= (1 / GAP_THRESHOLD)) return 'real_gap';
  return 'worth_a_nudge';
}

function buildReason(pairDef, aSets, bSets, status) {
  const { label } = pairDef;
  if (aSets === 0 && bSets === 0) {
    return `No ${label.a} or ${label.b} volume this week — nothing to compare.`;
  }
  if (status === 'balanced') {
    return `${aSets} ${label.a} sets vs ${bSets} ${label.b} — within the balanced range.`;
  }
  const heavier      = aSets >= bSets ? label.a : label.b;
  const lighter      = aSets >= bSets ? label.b : label.a;
  const heavierSets  = Math.max(aSets, bSets);
  const lighterSets  = Math.min(aSets, bSets);
  const intensity    = status === 'real_gap' ? 'significantly' : 'slightly';
  return `${heavierSets} ${heavier} sets vs ${lighterSets} ${lighter} — ${heavier} volume is ${intensity} ahead; worth a ${lighter} balance slot.`;
}

// Compute balance signal for all 4 antagonist pairs.
//
// logRows   — raw log rows (array-of-arrays or array-of-objects)
// options.days  — rolling window size in days (default 7)
// options.today — YYYY-MM-DD anchor for the window (default: real "now")
function computeBalanceSignal(logRows, options = {}) {
  const { days = 7, today = null } = options || {};

  if (!Array.isArray(logRows) || logRows.length === 0) {
    return PAIRS.map(pairDef => ({
      pair:   pairDef.pair,
      aSets:  0,
      bSets:  0,
      ratio:  null,
      status: 'balanced',
      reason: buildReason(pairDef, 0, 0, 'balanced'),
    }));
  }

  // Build rolling window bounds (mirrors weeklyMuscleVolume exactly).
  const windowDays = Math.max(1, Number(days) || 7);
  const anchored   = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today);
  const anchor     = anchored ? new Date(`${today}T12:00:00Z`) : new Date();
  const cutoff     = new Date(anchor.getTime());
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffIso  = cutoff.toISOString().slice(0, 10);
  const anchorIso  = anchor.toISOString().slice(0, 10);

  // Accumulate working-set counts by movement pattern.
  const patternCounts = {};
  for (const raw of logRows) {
    const row = normalizeLogRow(raw);
    if (!row.date_clean || row.date_clean < cutoffIso) continue;
    if (anchored && row.date_clean > anchorIso) continue;

    const liftName = row.canonical_exercise || row.exercise;
    if (!liftName) continue;

    const { pattern, needsReview } = patternFor(liftName);
    if (needsReview) continue;

    patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
  }

  // Muscle-level effective sets for the quad:hamstring pair.
  const muscleVol = weeklyMuscleVolume(logRows, { days, today });

  return PAIRS.map(pairDef => {
    let aSets, bSets;

    if (pairDef.type === 'pattern') {
      aSets = pairDef.aSide.reduce((s, p) => s + (patternCounts[p] || 0), 0);
      bSets = pairDef.bSide.reduce((s, p) => s + (patternCounts[p] || 0), 0);
    } else {
      aSets = pairDef.aSide.reduce((s, m) => s + ((muscleVol[m] && muscleVol[m].totalEffectiveSets) || 0), 0);
      bSets = pairDef.bSide.reduce((s, m) => s + ((muscleVol[m] && muscleVol[m].totalEffectiveSets) || 0), 0);
    }

    const ratio  = computeRatio(aSets, bSets);
    const status = computeStatus(aSets, bSets, ratio);
    const reason = buildReason(pairDef, aSets, bSets, status);

    return { pair: pairDef.pair, aSets, bSets, ratio, status, reason };
  });
}

module.exports = { computeBalanceSignal };
