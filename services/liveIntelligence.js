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
const { detectTrend } = require('./trendDetector');
const { computeReadiness } = require('./readinessSignal');
const { computeExpectedPerformance } = require('./expectedPerformance');
const { classifyDeviation } = require('./performanceDeviation');
const { normalizeExerciseKey, canonicalLiftCodeFor } = require('./exerciseEnrichment');

// 12-column Log_Cleaned indices used for cross-lift contamination guarding.
const COL_EXERCISE  = 2; // raw logged name
const COL_CANONICAL = 3; // canonical_exercise
const COL_LIFT      = 5; // lift_code

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
  const rec = { ...existingRec, working_weight, trend, readiness_signal };

  return { ...facts, rec, deviation, evidence_context };
}

module.exports = { enrichCoachFacts };
