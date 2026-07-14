'use strict';

/**
 * Server-side intelligence enrichment for POST /api/coach/message.
 *
 * enrichCoachFacts(facts, allLog) takes the client-provided facts and the
 * full log rows, computes the 5 deferred intelligence signals, and returns
 * a new facts object ready for coach.sanitizeFacts. Never mutates the input.
 *
 * Signals produced:
 *   rec.working_weight   — RIR-zone–anchored working weight (resolveWorkingWeight)
 *   rec.trend            — e1RM trajectory verdict (detectTrend)
 *   rec.readiness_signal — fatigue inference from trend + deviation history (computeReadiness)
 *   deviation            — logged reps vs. historical expectation at today's weight
 *   evidence_context     — benchmark + confidence that backed the deviation read
 *
 * All enrichments are best-effort: missing or insufficient data leaves the
 * signal as null (sanitizeFacts forwards null gracefully to the model).
 *
 * Pure logic — no I/O, no LLM, no Sheets writes. The caller is responsible
 * for fetching allLog before calling this function.
 */

const { resolveWorkingWeight, computeBenchmark } = require('./exerciseBenchmark');
const { normalizeLogRow, progressionBand, progressionVerdict } = require('./analytics');
const { detectTrend } = require('./trendDetector');
const { computeReadiness } = require('./readinessSignal');
const { computeExpectedPerformance } = require('./expectedPerformance');
const { classifyDeviation } = require('./performanceDeviation');
const { buildProgressionHistory } = require('./progressionHistory');
const { normalizeExerciseKey, canonicalLiftCodeFor } = require('./exerciseEnrichment');
const { isWarmupNote } = require('./warmupTag');

// 12-column Log_Cleaned indices used for cross-lift contamination guarding.
const COL_EXERCISE  = 2; // raw logged name
const COL_CANONICAL = 3; // canonical_exercise
const COL_LIFT      = 5; // lift_code

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function sameNumber(a, b) {
  const na = numOrNull(a);
  const nb = numOrNull(b);
  return na !== null && nb !== null && na === nb;
}

function pickTopTodaySet(todaySets) {
  if (!Array.isArray(todaySets)) return null;
  return todaySets.reduce((best, set) => {
    if (!set || typeof set !== 'object') return best;
    const weight = numOrNull(set.weight);
    const reps = numOrNull(set.reps);
    if (!isPositiveFinite(weight) || !isPositiveFinite(reps)) return best;
    const rir = set.rir == null ? null : numOrNull(set.rir);
    const current = { weight, reps, rir };
    if (!best) return current;
    if (weight !== best.weight) return weight > best.weight ? current : best;
    const bestRir = best.rir === null ? Infinity : best.rir;
    const currentRir = rir === null ? Infinity : rir;
    return currentRir <= bestRir ? current : best;
  }, null);
}

function targetRirFor(facts) {
  const rec = facts && facts.rec && typeof facts.rec === 'object' ? facts.rec : {};
  const candidates = [facts && facts.targetRir, rec.target_rir, rec.targetRir, 2];
  for (const value of candidates) {
    const n = numOrNull(value);
    if (n !== null) return n;
  }
  return 2;
}

function isOnTargetSet(set, targetRir) {
  if (!set || !isPositiveFinite(numOrNull(set.weight)) || !isPositiveFinite(numOrNull(set.reps))) return false;
  const rir = numOrNull(set.rir);
  return rir !== null && targetRir !== null && rir === targetRir;
}

function rowsForLift(allLog, liftCode, exerciseName) {
  const cleanLog = cleanLogForLift(Array.isArray(allLog) ? allLog : [], liftCode, exerciseName);
  const code = String(liftCode || '').trim().toUpperCase();
  return cleanLog
    .map(normalizeLogRow)
    .filter(row => row.lift_code === code && !isWarmupNote(row.notes));
}

function comparableOnTargetStreak(rows, topSet, targetRir) {
  if (!isOnTargetSet(topSet, targetRir)) return 0;
  const bySession = new Map();
  for (const row of rows) {
    if (!row.session_id) continue;
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
    bySession.get(row.session_id).push(row);
  }
  const sessions = [...bySession.entries()]
    .map(([sessionId, sessionRows]) => ({
      sessionId,
      rows: sessionRows,
      sortKey: sessionRows.reduce((max, row) => {
        const key = `${row.date_clean || ''}|${row.session_id || ''}|${Number(row.set_number) || 0}`;
        return key > max ? key : max;
      }, ''),
    }))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  let streak = 1;
  for (const session of sessions) {
    const comparable = session.rows.filter(row => sameNumber(row.weight, topSet.weight) && sameNumber(row.reps, topSet.reps));
    if (!comparable.length) continue;
    if (comparable.some(row => isOnTargetSet(row, targetRir))) streak += 1;
    else break;
  }
  return streak;
}

function buildLiveSetContext(facts, allLog) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const liftCode = typeof f.liftCode === 'string' ? f.liftCode.trim().toUpperCase() : '';
  const topSet = pickTopTodaySet(f.todaySets);
  const targetRir = targetRirFor(f);
  const baseProgression = {
    top_weight: topSet ? topSet.weight : null,
    top_reps: topSet ? topSet.reps : null,
    top_rir: topSet ? topSet.rir : null,
    target_rir: targetRir,
    prior_ceiling: null,
    verdict_level: null,
    comparable_on_target_streak: null,
    increase_threshold: 3,
    next_action: null,
  };

  const out = (register, progression, progression_verdict = null) => ({
    coach_mode: 'deterministic_live_set',
    register,
    exercise: typeof f.exerciseName === 'string' ? f.exerciseName.trim() : null,
    progression_context: progression,
    progression_verdict,
  });

  if (!liftCode || !topSet) {
    return out('conservative_hold', { ...baseProgression, next_action: 'hold' });
  }

  const rows = rowsForLift(allLog, liftCode, f.exerciseName);
  const band = progressionBand(rows, null);
  const verdict = band ? progressionVerdict(topSet.weight, band) : null;
  const currentOnTarget = isOnTargetSet(topSet, targetRir);
  const streak = currentOnTarget ? comparableOnTargetStreak(rows, topSet, targetRir) : 0;
  const progression = {
    ...baseProgression,
    prior_ceiling: verdict ? verdict.ceiling : (band && Number.isFinite(Number(band.ceiling)) ? Number(band.ceiling) : null),
    verdict_level: verdict ? verdict.level : null,
    comparable_on_target_streak: currentOnTarget ? streak : null,
  };

  if (verdict && verdict.level === 'new_ground') {
    return out('new_ground', { ...progression, next_action: 'prove_again' }, verdict);
  }
  if (currentOnTarget && streak >= 3) {
    return out('on_target_increase', { ...progression, next_action: 'increase_load' }, verdict);
  }
  if (currentOnTarget) {
    return out('on_target_hold', { ...progression, next_action: 'prove_again' }, verdict);
  }
  return out('conservative_hold', { ...progression, next_action: 'hold' }, verdict);
}

function flightRecorderContext(liveSetContext) {
  const ctx = liveSetContext && typeof liveSetContext === 'object' ? liveSetContext : null;
  const p = ctx && ctx.progression_context && typeof ctx.progression_context === 'object'
    ? ctx.progression_context
    : {};
  return {
    coach_mode: ctx ? ctx.coach_mode || 'deterministic_live_set' : 'deterministic_live_set',
    register: ctx ? ctx.register || 'conservative_hold' : 'conservative_hold',
    progression_context: {
      verdict_level: p.verdict_level || null,
      top_weight: numOrNull(p.top_weight),
      top_reps: numOrNull(p.top_reps),
      top_rir: p.top_rir == null ? null : numOrNull(p.top_rir),
      target_rir: p.target_rir == null ? null : numOrNull(p.target_rir),
      prior_ceiling: p.prior_ceiling == null ? null : numOrNull(p.prior_ceiling),
      comparable_on_target_streak: p.comparable_on_target_streak == null ? null : numOrNull(p.comparable_on_target_streak),
      increase_threshold: p.increase_threshold == null ? null : numOrNull(p.increase_threshold),
      next_action: typeof p.next_action === 'string' ? p.next_action : null,
    },
  };
}

// Step 376 — guard against cross-lift history contamination.
//
// Every downstream analytics function (computeBenchmark, resolveWorkingWeight,
// detectTrend, computeExpectedPerformance) pools history by liftCode alone. If
// two genuinely different exercises ended up sharing one liftCode — a generated-
// code collision from the pre-override era, or a catalog data-entry slip — their
// rows merge, and the coach can cite a foreign lift's working range (the live
// bug: Leg Extension at 60 lb described as below a "recent range of 105–170"
// pulled from an unrelated lift).
//
// We only intervene when the contamination is actually visible: rows carrying
// the target liftCode disagree on canonical_exercise. In that case we keep only
// the rows whose exercise matches today's lift (by normalized name, or by
// canonical liftCode for known variants like "Lateral Raise"/"Lateral Raises").
// If we cannot confidently identify the target's own rows, ALL same-liftCode
// rows are dropped so the analytics degrade to null and the coach suppresses the
// claim rather than citing foreign history — the roadmap's "suppress, don't
// contaminate".
//
// When the same-liftCode rows agree on a single canonical name (the normal case,
// and what every existing fixture exercises), allLog is returned unchanged — so
// this is a no-op except under real contamination.
function cleanLogForLift(allLog, liftCode, exerciseName) {
  const target = String(liftCode || '').toUpperCase().trim();
  if (!target) return allLog;

  const rowName = r => r[COL_CANONICAL] || r[COL_EXERCISE];
  const sameCode = [];
  const others = [];
  for (const r of allLog) {
    if (Array.isArray(r) && String(r[COL_LIFT] || '').toUpperCase().trim() === target) sameCode.push(r);
    else others.push(r);
  }

  const distinctCanon = new Set(sameCode.map(r => normalizeExerciseKey(rowName(r))).filter(Boolean));
  if (distinctCanon.size <= 1) return allLog; // clean (or unverifiable) — no change

  // Contamination present: retain only rows that belong to today's exercise.
  const wantNorm = normalizeExerciseKey(exerciseName);
  const wantCode = canonicalLiftCodeFor(exerciseName);
  const kept = sameCode.filter(r => {
    const norm = normalizeExerciseKey(rowName(r));
    if (norm && wantNorm && norm === wantNorm) return true;
    const code = canonicalLiftCodeFor(rowName(r));
    if (wantCode && code && wantCode === code) return true;
    return false;
  });
  // others carry different liftCodes (ignored by the per-lift filters anyway);
  // kept is the verified same-lift subset. Empty kept ⇒ no clean evidence ⇒ the
  // claim is suppressed downstream.
  return others.concat(kept);
}

function enrichCoachFacts(facts, allLog) {
  if (!facts || typeof facts !== 'object') return facts;
  const liftCode = typeof facts.liftCode === 'string' ? facts.liftCode.trim() : null;
  if (!liftCode || !Array.isArray(allLog)) return facts;

  // Restrict history to the target lift before any per-lift analytics run, so a
  // colliding liftCode can never leak a foreign lift's numbers into the coach.
  const cleanLog = cleanLogForLift(allLog, liftCode, facts.exerciseName);

  const working_weight = resolveWorkingWeight(liftCode, cleanLog);
  const trend = detectTrend(liftCode, cleanLog);
  // Deviation history tracking is deferred (BACKLOG); empty array is consistent
  // with what /api/recommend/next currently passes to computeReadiness.
  const readiness_signal = computeReadiness(trend, []);
  const benchmark = computeBenchmark(liftCode, cleanLog);

  // Use the highest-weight set from todaySets as the deviation reference: it is
  // the most representative working set and the one the coach should react to.
  const todaySets = Array.isArray(facts.todaySets) ? facts.todaySets : [];
  const topSet = todaySets.reduce((best, s) => {
    if (!s || typeof s !== 'object') return best;
    const w = Number(s.weight);
    return (Number.isFinite(w) && w > (best !== null ? Number(best.weight) : 0)) ? s : best;
  }, null);

  let deviation = null;
  let evidence_context = null;
  if (topSet !== null && Number.isFinite(Number(topSet.weight)) && Number(topSet.weight) > 0) {
    const expected = computeExpectedPerformance(liftCode, cleanLog, topSet.weight);
    deviation = classifyDeviation(topSet, expected);
    if (expected && expected.basis) {
      evidence_context = {
        reference_sets: [],
        date_range:     null,
        benchmark:      (benchmark && typeof benchmark.workingWeight === 'number')
                          ? benchmark.workingWeight
                          : null,
        confidence:     expected.basis.confidence || null,
      };
    }
  }

  // Merge computed signals into rec, preserving any client-forwarded recommendation
  // fields (next_target, recommendation text, etc.) that the coach should see.
  const existingRec = facts.rec && typeof facts.rec === 'object' ? facts.rec : {};
  const live_set_context = buildLiveSetContext(facts, cleanLog);
  const rec = {
    ...existingRec,
    working_weight,
    trend,
    readiness_signal,
    progression_verdict: live_set_context.progression_verdict || null,
  };

  // History-aware progression facts — computed SERVER-SIDE from the same lift-restricted
  // log (no client influence), reusing the existing progression rules only. Best-effort:
  // all-null when there isn't enough history (sanitizeFacts drops an empty history).
  const progression_history = buildProgressionHistory(cleanLog.map(normalizeLogRow), liftCode);

  return { ...facts, rec, deviation, evidence_context, progression_history, live_set_context };
}

// PR-B4 slice 3 — engine-confirmed new-ground gate for the profanity permission.
//
// The coaching MODE (services/coachMode.js) is derived from `rec.progression_verdict`
// / `rec.effort_verdict`, which are CLIENT-INFLUENCED (enrichCoachFacts preserves the
// client's `rec`). A client could forge `progression_verdict.level:'new_ground'` →
// `celebrate` → `max` → the certified profanity cell. So the forwarded profanity
// permission must NOT be gated on the client-derivable mode alone.
//
// confirmTodayNewGround recomputes TODAY's progression verdict SERVER-SIDE from the
// log — mirroring analyzeLift's just-logged branch (today's top working weight vs the
// band over all prior rows for the lift, services/analytics.js). The route gates the
// profanity permission on this signal.
//
// HONEST SCOPE (raised by the #948 review): the band is server-computed from allLog,
// but `todayTop` comes from `facts.todaySets` — the just-logged set, which is NOT in
// the sheet yet and is therefore inherently CLIENT-ASSERTED. So this gate raises the
// bar (a forger must now claim a plausible PR weight, not merely flip a verdict flag)
// but does NOT fully close client trust: a client that claims a believable new-ground
// weight can still reach the cell. That residual is bounded here — an ABSURD forged
// weight (e.g. 99999) is rejected by the plausibility cap below — and is low-impact
// (single-owner, read-only endpoint, profanity staged OFF, worst case one swear in the
// owner's own reply). The layer-3 suppressor is the other net. Residual filed in
// BACKLOG. A full close would require reacting only to a WRITTEN set. Pure — no I/O.
const MAX_PLAUSIBLE_PR_FACTOR = 1.5; // a real new-ground PR is incremental, not ≫ the prior ceiling
function confirmTodayNewGround(facts, allLog) {
  if (!facts || typeof facts !== 'object' || !Array.isArray(allLog)) return false;
  const liftCode = typeof facts.liftCode === 'string' ? facts.liftCode.trim().toUpperCase() : '';
  if (!liftCode) return false;
  const todaySets = Array.isArray(facts.todaySets) ? facts.todaySets : [];
  const todayTop = todaySets.reduce((m, s) => {
    const w = Number(s && s.weight);
    return Number.isFinite(w) && w > m ? w : m;
  }, 0);
  if (!(todayTop > 0)) return false;
  const rows = allLog.map(normalizeLogRow).filter(r => r && r.lift_code === liftCode);
  if (!rows.length) return false;
  // today's set is not in the sheet yet → band is built from all prior rows.
  const band = progressionBand(rows);
  const verdict = progressionVerdict(todayTop, band);
  if (!verdict || verdict.level !== 'new_ground') return false;
  // Plausibility cap — reject an implausibly large "PR" (a forged / fat-fingered
  // weight far above the prior ceiling). A genuine new ground is an increment.
  const ceiling = band && Number.isFinite(band.ceiling) ? band.ceiling : null;
  if (ceiling == null || todayTop > ceiling * MAX_PLAUSIBLE_PR_FACTOR) return false;
  return true;
}

module.exports = { enrichCoachFacts, confirmTodayNewGround, cleanLogForLift, buildLiveSetContext, flightRecorderContext };
