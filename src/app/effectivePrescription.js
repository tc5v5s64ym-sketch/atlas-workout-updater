/* The EFFECTIVE current prescription for an accepted plan slot (#1189 successor, owner P2).
 *
 * A set-level revision is recorded in the session ledger and DELIBERATELY does not rewrite the
 * accepted plan slot — the accepted (v1) prescription stays as historical evidence. So after one
 * revision, `slot.weight` / `slot.reps` / `slot.rir` are stale: they describe what the athlete
 * agreed to at plan acceptance, not what the remaining sets are actually prescribed at now.
 *
 * Anything that asks "would this change anything?" must ask it against the EFFECTIVE prescription,
 * folded from:
 *   1. the accepted-plan prescription (v1),
 *   2. prior applicable set-level revisions (the highest version recorded per set),
 *   3. the completed-set count (performed sets are frozen and are never revised),
 *   4. the remaining future-set scope (what is actually left to change).
 *
 * Comparing against v1 instead lets a target that merely REPEATS what the future sets already
 * carry look like a change: a proposal is staged, the revision builder dedupes it away on
 * approval, and Atlas reports a revision that never happened. That is the precise harm the
 * no-op guard exists to prevent, routed around rather than triggered.
 *
 * PURE / ES module — no DOM, no I/O, no clock, no model call. The engine owns the numbers.
 */

import { performedSetCount, currentRevision } from './sessionLedger.js';

function numOrNull(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * effectivePrescription({ slot, sessionLog, sessionRevisions }) → {
 *   prescription: { weight, reps, rir },   // what the NEXT future set is actually prescribed at
 *   performed,                             // frozen sets already logged against this slot
 *   acceptedSetCount,                      // the v1 grain a revision is bounded by
 *   nextSetIndex,                          // the first revisable set (1-based)
 *   futureSetsRemain,                       // false ⇒ nothing is revisable; propose nothing
 *   source,                                // 'revision' when a prior revision governs, else 'accepted'
 * }
 *
 * `slot` is an accepted plan exercise (carrying plan_item_id, sets, and the v1 weight/reps/rir).
 * Returns null when the slot carries no ledger identity or no accepted set count — there is no
 * grain to bound a revision by, so nothing downstream may claim one.
 */
function effectivePrescription(input) {
  const o = input && typeof input === 'object' ? input : {};
  const slot = o.slot && typeof o.slot === 'object' ? o.slot : null;
  if (!slot) return null;
  const planItemId = slot.plan_item_id || slot.planItemId || null;
  const acceptedSetCount = numOrNull(slot.sets);
  if (!planItemId || acceptedSetCount == null || acceptedSetCount <= 0) return null;

  const name = slot.canonicalName || slot.name || '';
  // Performed sets are the frozen floor — a revision may only target set indexes above it. This
  // is the SAME count the revision builder bounds itself by, read from the same selector, so the
  // proposal and the emit can never disagree about which sets are still in scope.
  const performed = performedSetCount(Array.isArray(o.sessionLog) ? o.sessionLog : [], name);
  const nextSetIndex = performed + 1;
  const futureSetsRemain = acceptedSetCount > performed;

  // The highest-version revision recorded for the next future set governs it. When none exists,
  // the accepted (v1) prescription still stands.
  const revision = futureSetsRemain
    ? currentRevision(Array.isArray(o.sessionRevisions) ? o.sessionRevisions : [], planItemId, nextSetIndex)
    : null;
  const prescription = revision
    ? {
      weight: numOrNull(revision.target_weight),
      reps: numOrNull(revision.target_reps),
      rir: numOrNull(revision.target_rir),
    }
    : {
      weight: numOrNull(slot.weight),
      reps: numOrNull(slot.reps),
      rir: numOrNull(slot.rir),
    };

  return {
    prescription,
    performed,
    acceptedSetCount,
    nextSetIndex,
    futureSetsRemain,
    source: revision ? 'revision' : 'accepted',
  };
}

/**
 * Would `target` actually change the effective prescription? Weight and reps are the load-bearing
 * fields: an RIR-only difference is not a prescription change (the merged proposal builder refuses
 * one for the same reason), and a field the engine did not resolve cannot be a change.
 */
function changesEffectivePrescription(target, effective) {
  const t = target && typeof target === 'object' ? target : {};
  const cur = effective && typeof effective === 'object' ? effective : {};
  const weight = numOrNull(t.weight);
  const reps = numOrNull(t.reps);
  const weightChanged = weight !== null && weight !== numOrNull(cur.weight);
  const repsChanged = reps !== null && reps !== numOrNull(cur.reps);
  return weightChanged || repsChanged;
}

export { effectivePrescription, changesEffectivePrescription };
