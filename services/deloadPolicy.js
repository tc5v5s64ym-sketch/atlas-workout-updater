'use strict';

// Deload policy helpers — the deterministic deload DECISIONS that were previously
// inline in analytics.js, housed here so the deload logic lives in one place
// (Step 1C, docs/FIX_PLAN.md). This is a pure extract: behaviour is unchanged for
// every input the callers pass (the only addition is a defensive non-array guard in
// detectDeloadRecovery, which analytics never hit because it always passes an array).
//
// Scope note (premise correction, 2026-06-24): the DELOAD_SPEC.md *trigger
// criteria* (the "5 behaviours" — stagnation, regression, RIR drift, multi-lift
// stagnation, recovery signals) are ALREADY housed in the dedicated deload
// subsystem (services/deloadEngine.js, deloadFatigueScore.js, deloadStateMachine.js,
// deloadEscalationLadder.js, recoveryDeloadSelection.js). What remained scattered
// inside analytics.js — and is what this module captures — is the *post-deload
// recovery* decision and the deload *filler-weight* policy. `suggestDeloads` is left
// in analytics.js for now because it is built on `detectStalls` (core analytics) and
// moving it would introduce a circular dependency; see BACKLOG for that follow-up.
//
// Pure / deterministic: no Sheets, no LLM, no I/O. The engine owns the numbers.

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

// The lifter's documented working weight for a lift, from a recommendation: the
// top of their recent working sets, falling back to their best, then the next
// target. Used to keep deload accessories anchored on what they actually lift.
function recentWorkingWeight(rec) {
  const sets = rec && Array.isArray(rec.last_working_sets) ? rec.last_working_sets : [];
  const weights = sets.map(s => Number(s.weight)).filter(isPositiveFinite);
  if (weights.length) return Math.max(...weights);
  if (rec && isPositiveFinite(rec.best_weight)) return rec.best_weight;
  const nt = rec && rec.next_target ? Number(rec.next_target.weight) : NaN;
  return isPositiveFinite(nt) ? nt : null;
}

// Deload load for an accessory/filler on a deload day. NEVER its next_target
// (that's a progression — a step UP). Hold the documented working weight —
// the deload cut comes via fewer sets, not a weight reduction. Falls back to
// the next target only if no history exists.
function deloadFillerWeight(rec) {
  const working = recentWorkingWeight(rec);
  if (!isPositiveFinite(working)) return rec && rec.next_target ? rec.next_target.weight : null;
  return working; // hold the working weight; volume cut happens via target_sets
}

// Post-deload recovery path: is the most recent session a ONE-OFF deload? If so the next session
// should return to the pre-deload working weight and resume normal progression —
// not carry the lighter deload load forward as the new baseline.
//
// Two signals, note text primary:
//   1. Explicit — any row in the last session has a note matching /deload/i.
//      Definitive when present, but rarely persisted to the sheet today (the
//      deload plan reason is not written into the row's notes column), so it is
//      mostly a safety net until an explicit deload marker is persisted (future
//      write-path PR).
//   2. Heuristic (the workhorse) — the last session's top working weight is ≥7%
//      below the established working weight (the heaviest of the prior few
//      sessions), with at least two prior sessions to anchor "established".
// Returns { isDeload, preDeloadWeight, lastTop, dropPct, signal } or null.
function detectDeloadRecovery(rows) {
  const order = [];
  const topBySession = new Map();
  const notesBySession = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const sid = row.session_id || '';
    if (!topBySession.has(sid)) { order.push(sid); topBySession.set(sid, 0); notesBySession.set(sid, []); }
    if (isPositiveFinite(row.weight)) topBySession.set(sid, Math.max(topBySession.get(sid), row.weight));
    if (row.notes) notesBySession.get(sid).push(String(row.notes));
  }
  if (order.length < 3) return null; // need ≥2 prior sessions plus the last one

  const lastSid = order[order.length - 1];
  const lastTop = topBySession.get(lastSid) || 0;
  if (!isPositiveFinite(lastTop)) return null;

  const recentPriorTops = order.slice(0, -1).slice(-3).map(s => topBySession.get(s)).filter(isPositiveFinite);
  if (recentPriorTops.length < 2) return null;
  const established = Math.max(...recentPriorTops);
  if (!isPositiveFinite(established) || lastTop >= established) return null;

  const explicit = (notesBySession.get(lastSid) || []).some(n => /deload/i.test(n));
  const dropPct = (established - lastTop) / established;
  if (!explicit && dropPct < 0.07) return null;

  return {
    isDeload: true,
    preDeloadWeight: established,
    lastTop,
    dropPct: Math.round(dropPct * 100),
    signal: explicit ? 'note' : 'heuristic'
  };
}

module.exports = {
  recentWorkingWeight,
  deloadFillerWeight,
  detectDeloadRecovery
};
