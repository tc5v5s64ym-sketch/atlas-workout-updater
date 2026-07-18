/* F10B — client-side session recommendation ledger (mid-session revisions + reload).
 *
 * Holds the durable set-level REVISIONS the session accumulates so the effective plan
 * survives a reload. The ACCEPTED plan (v1) is already reconstructable from the
 * snapshot-persisted activePlannedSession; this module owns the revisions (append-only)
 * and the rules that keep them honest (owner F10B contract, design §4 amendment A1):
 *   - a revision targets FUTURE (unperformed) sets only — a completed set is FROZEN;
 *   - a performed value NEVER creates a revision — only an EXPLICIT Atlas recommendation
 *     (a substitution/pivot or an endorsed change) does; logging a set adds nothing here;
 *   - append-only: a revision is only ever added, never mutated (a re-trigger for an
 *     already-recorded (item, set, version) is a no-op);
 *   - plan_version per (item, set) is the LINEAR revision counter (v1 = accepted, so the
 *     first revision is v2); supersedes_key is derived server-side from version N-1.
 *
 * PURE / ES module — no DOM, no I/O. app.js holds the revisions in the session store
 * (persisted in the reload snapshot) and posts each to the dry-run /revision checkpoint.
 */
const _exports = (function () {
  'use strict';

  const _str = (v) => String(v == null ? '' : v).trim();
  const _num = (v) => {
    if (v === 0 || v === '0') return 0;
    const n = Number(v);
    return v == null || v === '' || !Number.isFinite(n) ? null : n;
  };
  const _posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 ? n : null; };

  // Singular-normalize an exercise name for counting performed sets — mirrors the
  // executor / planSlotStatuses so a plural logged form still counts against its slot.
  // keep in sync with normalizeExerciseName in services/sessionPlanExecutor.js
  function normName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/).filter(Boolean)
      .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
      .join(' ');
  }

  // How many sets of `exerciseName` are already PERFORMED this session (from the
  // session log). This is the frozen floor: a revision may target only set indexes
  // ABOVE this count. sessionLog: [{ exercise, weight, reps, rir }].
  function performedSetCount(sessionLog, exerciseName) {
    const key = normName(exerciseName);
    if (!key) return 0;
    return (Array.isArray(sessionLog) ? sessionLog : [])
      .filter(r => r && normName(r.exercise) === key).length;
  }

  // The plan_version for the NEXT revision of (plan_item_id, set_index): one past the
  // highest version already recorded for that set, or 2 when none (v1 is the accepted
  // plan, never stored in the revision list).
  function nextRevisionVersion(sessionRevisions, plan_item_id, set_index) {
    const cur = currentRevision(sessionRevisions, plan_item_id, set_index);
    return (cur ? Number(cur.plan_version) : 1) + 1; // v1 accepted → first revision v2
  }

  // The highest-version revision already recorded for (item, set), or null.
  function currentRevision(sessionRevisions, plan_item_id, set_index) {
    const pid = _str(plan_item_id);
    const si = Number(set_index);
    let best = null;
    let bestV = 0;
    for (const r of (Array.isArray(sessionRevisions) ? sessionRevisions : [])) {
      if (r && _str(r.plan_item_id) === pid && Number(r.set_index) === si) {
        const v = Number(r.plan_version);
        if (Number.isInteger(v) && v > bestV) { bestV = v; best = r; }
      }
    }
    return best;
  }

  /**
   * buildFutureRevisions({ plan_item_id, planned_lift_code, target_weight, target_reps,
   *   target_rir, target_set_count, performedCount, sessionRevisions }) → revision[]
   *
   * One revision per FUTURE set (set_index in performedCount+1 .. target_set_count),
   * each carrying the EXPLICIT recommendation's targets and source 'live_revision'.
   * Returns [] when there is no identity, no real explicit target (weight AND reps must
   * be finite — a revision never fabricates a target), or no future sets remain (every
   * set already performed → nothing to revise, completed targets stay frozen).
   */
  function buildFutureRevisions(opts = {}) {
    const pid = _str(opts.plan_item_id);
    const code = _str(opts.planned_lift_code);
    const setCount = _posInt(opts.target_set_count);
    const w = _num(opts.target_weight);
    const reps = _num(opts.target_reps);
    const rir = _num(opts.target_rir);
    const done = Math.max(0, Number(opts.performedCount) || 0);
    if (!pid || !code || setCount == null) return [];
    if (w == null || reps == null) return []; // no explicit target → never fabricate a revision
    const out = [];
    for (let set_index = done + 1; set_index <= setCount; set_index += 1) {
      // Idempotent: if the current effective revision for this set already carries the
      // SAME targets, a re-trigger (e.g. a double-fired substitution) adds nothing — no
      // redundant version. A genuinely-different recommendation still appends a revision.
      const cur = currentRevision(opts.sessionRevisions, pid, set_index);
      if (cur && _num(cur.target_weight) === w && _num(cur.target_reps) === reps && _num(cur.target_rir) === (rir == null ? null : rir)) {
        continue;
      }
      out.push({
        plan_item_id: pid,
        planned_lift_code: code,
        set_index,
        plan_version: nextRevisionVersion(opts.sessionRevisions, pid, set_index),
        target_set_count: setCount,
        target_weight: w,
        target_reps: reps,
        target_rir: rir == null ? null : rir,
        recommendation_source: 'live_revision',
      });
    }
    return out;
  }

  // Append revisions APPEND-ONLY: never mutate an existing row; a re-trigger for an
  // already-recorded (item, set, version) is a no-op. Returns a NEW array.
  function appendRevisions(sessionRevisions, newRevisions) {
    const base = Array.isArray(sessionRevisions) ? sessionRevisions.slice() : [];
    const key = (r) => `${_str(r.plan_item_id)}|${Number(r.set_index)}|${Number(r.plan_version)}`;
    const seen = new Set(base.map(key));
    for (const r of (Array.isArray(newRevisions) ? newRevisions : [])) {
      if (!r || !_str(r.plan_item_id)) continue;
      const k = key(r);
      if (seen.has(k)) continue;
      seen.add(k);
      base.push(r);
    }
    return base;
  }

  return { normName, performedSetCount, nextRevisionVersion, buildFutureRevisions, appendRevisions };
})();

export const {
  normName,
  performedSetCount,
  nextRevisionVersion,
  buildFutureRevisions,
  appendRevisions,
} = _exports;
