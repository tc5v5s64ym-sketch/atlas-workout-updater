'use strict';

/**
 * Coach explanation guardrail (deterministic, no LLM).
 *
 * The rule engine owns the numbers; a coach explanation may only *word* them. This module:
 *   - validateCoachExplanation(text, lockedNumbers): flags ONLY clear prescription contradictions
 *     (wrong weight, wrong sets×reps, training-to-failure when RIR is locked ≥ 1). It tolerates
 *     harmless context numbers (dates, percentages, lift codes, rep ranges, RIR ranges that overlap
 *     the locked band, "1–2 in the tank").
 *   - buildTemplatedExplanation(prescription): a short, safe sentence assembled only from locked
 *     numbers + progression. Always passes its own validator. Cold start uses weight guidance.
 */

function buildTemplatedExplanation(rec = {}) {
  const name = rec.exerciseName || rec.exercise || 'This lift';
  const sets = Number.isFinite(rec.targetSets) ? rec.targetSets : null;
  const rr = rec.targetRepRange || {};
  const reps = Number.isFinite(rr.min) && Number.isFinite(rr.max) ? `${rr.min}–${rr.max}` : null;
  const ri = rec.targetRIR || {};
  const rir = Number.isFinite(ri.min) && Number.isFinite(ri.max) ? `${ri.min}–${ri.max}` : null;

  const hasWeight = Number.isFinite(rec.recommendedWeight);
  const loadPhrase = hasWeight
    ? `${rec.recommendedWeight} lb`
    : 'choose a load that lands near your target RIR';
  const setRep = sets && reps ? `${sets} sets of ${reps} reps` : (sets ? `${sets} sets` : 'your working sets');
  const rirPhrase = rir ? ` at RIR ${rir}` : '';

  const moves = {
    add_load: 'you earned a small load bump',
    add_rep: 'hold the load and add reps',
    add_set: 'add a set while recovery is good',
    reduce_stress: 'pull the stress back to recover',
    maintain: 'hold steady this session',
    increase_density_or_reps: 'add density or reps before load',
  };
  const move = moves[rec.progression] || 'stay the course';

  return `${name}: ${loadPhrase} for ${setRep}${rirPhrase} — ${move}.`;
}

function scrubContextNumbers(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')   // ISO dates
    .replace(/\b[a-z]{2,}\d{1,4}\b/g, ' ')    // lift codes like ben01
    .replace(/\b\d+(?:\.\d+)?\s*%/g, ' ');    // percentages
}

function validateCoachExplanation(text, lockedNumbers = {}) {
  const violations = [];
  const scrub = scrubContextNumbers(text);

  // 1. Weight — only numbers with a load unit or right after a load verb count as a "weight claim".
  if (Number.isFinite(lockedNumbers.recommendedWeight)) {
    const locked = lockedNumbers.recommendedWeight;
    const weightRe = /\b(\d{2,4})\s*(?:lb|lbs|pounds|#|kg|kgs)\b|\b(?:use|using|load|go to|going to|bump to|jump to|put on|set it at|lift)\s+(\d{2,4})\b/g;
    let m;
    while ((m = weightRe.exec(scrub)) !== null) {
      const w = Number(m[1] != null ? m[1] : m[2]);
      if (Number.isFinite(w) && w !== locked) {
        violations.push({ type: 'weight', found: w, locked });
      }
    }
  }

  // 2. Sets × reps — "5x10" style claims must match locked sets and fall inside the rep range.
  if (Number.isFinite(lockedNumbers.targetSets) && lockedNumbers.targetRepRange) {
    const { min, max } = lockedNumbers.targetRepRange;
    const sxr = /\b(\d{1,2})\s*[x×]\s*(\d{1,2})\b/g;
    let m;
    while ((m = sxr.exec(scrub)) !== null) {
      const sets = Number(m[1]);
      const reps = Number(m[2]);
      const setsBad = sets !== lockedNumbers.targetSets;
      const repsBad = Number.isFinite(min) && Number.isFinite(max) && (reps < min || reps > max);
      if (setsBad || repsBad) {
        violations.push({ type: 'sets_reps', found: `${sets}x${reps}`, locked: `${lockedNumbers.targetSets}x${min}-${max}` });
      }
    }
  }

  // 3. Failure / RIR — never advertise failure when a positive RIR is locked; flag stated RIR with
  //    no overlap with the locked band.
  const rir = lockedNumbers.targetRIR;
  if (rir && Number.isFinite(rir.min)) {
    const saysFailure = /\b(?:to failure|train(?:ing)? to failure|all[-\s]?out|max out|rir\s*0|0\s*(?:reps?\s*)?(?:in (?:the )?)?(?:reserve|tank))\b/.test(scrub);
    if (saysFailure && rir.min >= 1) {
      violations.push({ type: 'failure', found: 'to_failure', locked: `RIR ${rir.min}-${rir.max}` });
    }
    const rirRe = /\brir\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b|\b(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*(?:reps?\s*)?in (?:the )?(?:reserve|tank)\b/g;
    let m;
    while ((m = rirRe.exec(scrub)) !== null) {
      const a = Number(m[1] != null ? m[1] : m[3]);
      const b = m[2] != null ? Number(m[2]) : (m[4] != null ? Number(m[4]) : a);
      if (Number.isFinite(a)) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const overlaps = hi >= rir.min && lo <= rir.max;
        if (!overlaps) violations.push({ type: 'rir', found: `${lo}-${hi}`, locked: `${rir.min}-${rir.max}` });
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

module.exports = { buildTemplatedExplanation, validateCoachExplanation };
