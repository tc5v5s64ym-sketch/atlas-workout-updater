'use strict';

/**
 * Thin history adapter — wraps existing analytics so the recommendation engine can consume a
 * lift's recent history. NO new training math: it only reshapes outputs of
 * services/analytics.js into the policy's input contract.
 *
 *   { previousPerformance: { weight, reps, rir, completed },
 *     recentTrends:        { fatigueStatus, performanceDrop, recentPR, recentStall, rirTrend? },
 *     raw }   // raw is for tests/debugging only and must NOT be leaked from the API.
 */

const {
  recommendNextSet,
  buildExerciseDetail,
  detectStalls,
  detectRecentPrs,
  computeFatigueStatus,
} = require('./analytics');

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function safe(fn, fallback) {
  try {
    const out = fn();
    return out == null ? fallback : out;
  } catch (_e) {
    return fallback;
  }
}

function buildLiftHistory(logRows, liftCode, { effortRows, today } = {}) {
  const rows = Array.isArray(logRows) ? logRows : [];
  const code = String(liftCode == null ? '' : liftCode).trim();

  // Cold start: no rows or no lift → empty objects so the policy falls back to its defaults
  // (preferred rep range, no progression, no invented weight).
  if (!code || rows.length === 0) {
    return { previousPerformance: {}, recentTrends: {}, raw: {} };
  }

  const rec = safe(() => recommendNextSet(rows, code), {});
  const detail = safe(() => buildExerciseDetail(rows, code), {});
  const stalls = safe(() => detectStalls(rows), []) || [];
  const prs = safe(() => detectRecentPrs(rows), []) || [];
  const refDate = today ? new Date(today) : new Date();
  const fatigue = safe(() => computeFatigueStatus(rows, refDate), {}) || {};

  const sets = Array.isArray(rec.last_working_sets) ? rec.last_working_sets : [];
  const lastSet = sets.length ? sets[sets.length - 1] : null;

  const upper = code.toUpperCase();
  const recentPR = prs.some((p) => String(p && p.liftCode || '').toUpperCase() === upper);
  const recentStall = stalls.some((s) => String(s && s.liftCode || '').toUpperCase() === upper);
  const performanceDrop = rec.e1rm_trend === 'down' || detail.volume_trend === 'down';

  const previousPerformance = lastSet
    ? { weight: num(lastSet.weight), reps: num(lastSet.reps), rir: num(lastSet.rir), completed: true }
    : {};

  const recentTrends = {
    fatigueStatus: fatigue.status === 'high' ? 'high' : 'low',
    performanceDrop: Boolean(performanceDrop),
    recentPR,
    recentStall,
  };
  if (performanceDrop || recentStall) recentTrends.rirTrend = 'falling';

  return { previousPerformance, recentTrends, raw: { rec, detail, stalls, prs, fatigue } };
}

module.exports = { buildLiftHistory };
