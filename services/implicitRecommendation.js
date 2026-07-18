'use strict';

/**
 * F10C — the deterministic IMPLICIT recommendation for an UNANNOUNCED exercise.
 *
 * When the athlete simply logs an exercise Atlas never proposed and never announced,
 * Atlas forms an independent recommendation for it — the plan it WOULD have given — so
 * target-vs-actual stays honest and never circular. Owner-binding contract
 * (docs/SESSION_PLANS_LEDGER_DESIGN.md §4A, Dale 2026-07-18):
 *
 *   1. one next set only (target_set_count = 1);
 *   2. never collapse the engine's rep/RIR RANGE into a scalar (no midpoint/boundary/default);
 *   3. a target needs an EXACT weight AND reps AND rir from trustworthy PRE-session history;
 *   4. the current session (incl. the just-logged set) is excluded from the evidence;
 *   5. absent / incomplete / ambiguous / range-only → no_reliable_target, no row;
 *   6. changing the just-submitted set can never move the target (follows from rule 4);
 *   7. a performed value never auto-becomes the recommendation.
 *
 * The deterministic engine (services/recommendationPolicy.js) emits rep and RIR as
 * {min,max} RANGES — rule 2 forbids collapsing them. So the only EXACT scalars available
 * are the engine's pinned load (`recommendedWeight`, which is undefined on a cold start —
 * then there is only `weightGuidance`, i.e. "only ranges", rule 5) and the reps & rir of
 * the exact most-recent prior WORKING SET. The derived target is therefore:
 *   target_weight = recommendedWeight   (the engine's exact load call),
 *   target_reps   = the exact prior set's reps,
 *   target_rir    = the exact prior set's rir,
 * and if ANY of the three is not exactly derivable → no_reliable_target.
 *
 * Blank history is never fabricated: a missing load leaves `recommendedWeight` undefined,
 * and a blank prior reps/rir reads as null (strict) — each → no_reliable_target, never 0.
 *
 * PURE / deterministic: no I/O, no writes, no LLM. The caller supplies the full
 * Log_Cleaned rows plus the current session id; this module excludes the current session
 * and reads only what the deterministic engine derives from the remaining prior history.
 */

const { normalizeLogRow, recommendNextSet } = require('./analytics');
const { buildRecommendation } = require('./recommendationPipeline');

const _str = (v) => String(v == null ? '' : v).trim();

// STRICT exact scalar: '' / null / undefined / non-finite → null; a real 0 is preserved
// (bodyweight load, RIR 0). It NEVER coerces a blank into 0 — that would fabricate a
// target the athlete never demonstrated (owner rules 3 + 5).
function _exactNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Rule 4 (the leakage guarantee): drop every row from the CURRENT session before any
// evidence is read. Match by session_id (canonical); fall back to the session date only
// when no session id is supplied. normalizeLogRow reads either an array or object row.
function _priorRows(logRows, currentSessionId, currentSessionDate) {
  const sid = _str(currentSessionId).toLowerCase();
  const sdate = _str(currentSessionDate);
  return (Array.isArray(logRows) ? logRows : []).filter((raw) => {
    const n = normalizeLogRow(raw);
    if (sid) return _str(n.session_id).toLowerCase() !== sid;
    if (sdate) return _str(n.date_clean) !== sdate;
    return true; // no session identity to exclude by — caller should always supply one
  });
}

// The most-recent prior working set for the lift — the same selection the engine's
// history layer uses (the latest by date_clean among recommendNextSet's working sets).
// Returns a normalized set object (blank reps/rir preserved as null) or null.
function _mostRecentWorkingSet(priorRows, liftCode) {
  const rec = recommendNextSet(priorRows, liftCode);
  const sets = rec && Array.isArray(rec.last_working_sets) ? rec.last_working_sets : [];
  if (!sets.length) return null;
  return sets.reduce((a, b) => (String((b && b.date_clean) || '') >= String((a && a.date_clean) || '') ? b : a));
}

function _noTarget(reason) {
  return { confidence: 'no_reliable_target', target_set_count: 1, reason };
}

/**
 * deriveImplicitRecommendation({ logRows, effortRows, liftCode, exerciseName,
 *   currentSessionId, currentSessionDate, today, goal, constraints }) → result
 *
 *   result.confidence === 'reliable'
 *     → { confidence, target_set_count: 1, target_weight, target_reps, target_rir,
 *         planned_lift_code, reason: 'derived' }
 *   result.confidence === 'no_reliable_target'
 *     → { confidence, target_set_count: 1, reason }
 *
 * Deterministic and leakage-safe: the current session is excluded first, so the just-
 * logged set can never influence its own target (rule 6). A performed value never
 * becomes the recommendation (rule 7) — only prior evidence is ever read.
 */
function deriveImplicitRecommendation(opts = {}) {
  const liftCode = _str(opts.liftCode);
  if (!liftCode) return _noTarget('no_lift_code');

  const priorRows = _priorRows(opts.logRows, opts.currentSessionId, opts.currentSessionDate);
  if (!priorRows.length) return _noTarget('no_prior_history');

  const lastSet = _mostRecentWorkingSet(priorRows, liftCode);
  if (!lastSet) return _noTarget('no_prior_working_set');

  // reps & rir come from the exact prior working set (the engine offers only ranges for
  // these — rule 2 — so a blank reps/rir is no_reliable_target, never a fabricated 0).
  const target_reps = _exactNum(lastSet.reps);
  const target_rir = _exactNum(lastSet.rir);

  // weight is the engine's pinned load call over the SAME pre-session history — undefined
  // on a cold start (only weightGuidance = "only ranges", rule 5).
  const rec = buildRecommendation({
    liftCode,
    exerciseName: _str(opts.exerciseName) || undefined,
    logRows: priorRows,
    effortRows: opts.effortRows,
    today: opts.today,
    explicitGoal: opts.goal,
    constraints: opts.constraints,
  });
  const target_weight = _exactNum(rec && rec.recommendation ? rec.recommendation.recommendedWeight : null);

  if (target_weight == null) return _noTarget('no_exact_weight');
  if (target_reps == null) return _noTarget('no_exact_reps');
  if (target_rir == null) return _noTarget('no_exact_rir');

  return {
    confidence: 'reliable',
    target_set_count: 1,
    target_weight,
    target_reps,
    target_rir,
    planned_lift_code: liftCode,
    reason: 'derived',
  };
}

module.exports = { deriveImplicitRecommendation };
