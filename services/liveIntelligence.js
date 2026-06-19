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

function enrichCoachFacts(facts, allLog) {
  if (!facts || typeof facts !== 'object') return facts;
  const liftCode = typeof facts.liftCode === 'string' ? facts.liftCode.trim() : null;
  if (!liftCode || !Array.isArray(allLog)) return facts;

  const working_weight = resolveWorkingWeight(liftCode, allLog);
  const trend = detectTrend(liftCode, allLog);
  // Deviation history tracking is deferred (BACKLOG); empty array is consistent
  // with what /api/recommend/next currently passes to computeReadiness.
  const readiness_signal = computeReadiness(trend, []);
  const benchmark = computeBenchmark(liftCode, allLog);

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
    const expected = computeExpectedPerformance(liftCode, allLog, topSet.weight);
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
