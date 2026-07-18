/* F10 — Authoritative planned-slot completion identity.
 *
 * ONE ambiguity-safe, plan_item_id-keyed slot-completion selector. Every "what's
 * done / what's still on the plan" surface — recap, next-up, pin, handoff, closeout,
 * and the Workout Sheet — derives from THIS one selector, so they can never disagree
 * (F10 AC4). It is the generalization of planCompletion.mostRecentCompletablePlanItem
 * + planOutcome.resolveItemForOutcome across every consuming surface.
 *
 * PURE / DI / ES module — no DOM, no I/O, no LLM, no Sheets. The browser (app.js /
 * workoutSheet.js / coach-conversation.js via legacyBridge) and the Node test suite
 * run the IDENTICAL logic (same pattern as activeSession.js / planCompletion.js).
 *
 * IDENTITY RULE (owner F10 decision — do not re-ask):
 *   - A slot is keyed by its immutable `plan_item_id` (minted at acceptance,
 *     planAcceptance.js). The explicit item-outcome lane (activePlan.items[].outcome
 *     — 'completed' from the "Done with this exercise" button, 'skipped' from a skip)
 *     is AUTHORITATIVE and id-keyed (AC5).
 *   - Logs are name-sourced (sessionCompleted carries resolved names, not slot ids),
 *     so the log→slot attribution is UNAVOIDABLY a name match. This selector does it
 *     ONCE, SAFELY: each logged completion attributes to AT MOST ONE slot, keyed by
 *     slot POSITION, with EXACT identity outranking substring and AMBIGUITY REFUSAL.
 *     Two same-named slots stay slot-distinct — one logged set cannot complete every
 *     same-named slot (AC2); an ambiguous substring leaves the slots unresolved
 *     rather than guessing (AC3 / SESS-5).
 *   - A substituted slot RETAINS its original plan_item_id (applySessionSubstitution),
 *     so a recognized substitution or equipment/angle variant satisfies the ORIGINAL
 *     planned slot (AC1) — the deviation is recorded, the slot is still completed.
 *   - No plan_item_id (an engaged-but-unaccepted Coach's Pick) → the selector falls
 *     back to slot POSITION for distinctness; the same safe name attribution applies
 *     (the id-keyed lane fails closed to a hardened name path — architecture-map
 *     hard-case c).
 *   - Logged completions arrive NAME-DEDUPED (getSessionCompleted keeps one entry per
 *     distinct resolved name), so two IDENTICAL-name slots receive a single name
 *     completion: the FIRST completes, the rest stay pending. This is deliberate and
 *     fail-closed — name evidence cannot tell one slot's repeated sets from work spread
 *     across two identical slots, and fabricating the second from ambiguous multiplicity
 *     would re-introduce the over-completion bug F10 fixes. The remaining identical
 *     slot(s) complete via the AUTHORITATIVE id lane (an explicit "Done" →
 *     items[].outcome) or the F10A–F10E set-level ledger, never from name multiplicity.
 *
 * Name/liftCode are used ONLY as logged-evidence to attribute a log to a slot — never
 * as the authoritative completion key. That is the whole point of F10.
 */
import { variantSatisfies } from './activeSession.js';

const _exports = (function () {
  'use strict';

  const STATUS = { PENDING: 'pending', COMPLETED: 'completed', SKIPPED: 'skipped' };

  const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();

  // Accept a bare name string or a { name/exercise, liftCode/lift_code } record.
  function toName(ref) {
    if (ref && typeof ref === 'object') {
      return String(ref.name || ref.exercise || ref.canonical_exercise || '').trim();
    }
    return String(ref == null ? '' : ref).trim();
  }
  function toCode(ref) {
    if (ref && typeof ref === 'object') return String(ref.liftCode || ref.lift_code || '').trim();
    return '';
  }

  // Singular-normalize for exact logged-evidence matching — mirrors the executor's
  // normalizeExerciseName so a plural logged name still matches its singular slot,
  // WITHOUT collapsing distinct movements (word count + words preserved; only a
  // trailing non-"ss" -s on a >3-char word is dropped).
  // keep in sync with normalizeExerciseName in services/sessionPlanExecutor.js
  function normKey(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/).filter(Boolean)
      .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
      .join(' ');
  }

  // The recognized-variant rule (an equipment/angle/grip variant of a base movement
  // satisfies its bare base slot) is single-homed in activeSession.js and imported
  // above, so this selector and the recap's reconcileSubstitutedRemaining can never
  // diverge on which variants count.

  // The loosest alias tier — DIRECTIONAL on purpose. A logged name attributes to a
  // slot only when it is an ABBREVIATION CONTAINED IN the slot name ("Lat pull" ⊂
  // "Lat Pulldown", "Bench" ⊂ "Bench Press"). The reverse direction (the logged name
  // ADDS words to the slot) is NOT an abbreviation — it is either a recognized
  // variant (handled by the qualifier-gated tier 3) or a DIFFERENT movement
  // ("Romanian Deadlift" over a bare "Deadlift" slot), which must never complete the
  // slot. Used ONLY with an ambiguity refusal — >1 unclaimed slot → resolve NONE
  // (reuse of findMatchIndex's unique-only rule).
  function abbreviationMatch(cLc, rLc) {
    return !!(cLc && rLc && rLc.includes(cLc));
  }

  // Build 1:1 per-slot descriptors from the active plan's exercises (visible order).
  // Each carries its immutable plan_item_id (when accepted), display name, liftCode,
  // array position (`order` — the distinctness key), and its authoritative id-keyed
  // explicit outcome (if any). Accepts the raw activePlannedSession OR any
  // { exercises, items } shape.
  function buildSlots(activePlan) {
    const exs = activePlan && Array.isArray(activePlan.exercises) ? activePlan.exercises : [];
    const items = activePlan && Array.isArray(activePlan.items) ? activePlan.items : [];
    const outcomeById = new Map();
    for (const it of items) {
      if (it && it.plan_item_id != null) outcomeById.set(String(it.plan_item_id), it.outcome);
    }
    return exs.map((ex, i) => {
      const name = String((ex && (ex.canonicalName || ex.name)) || '').trim();
      const planItemId = ex && ex.plan_item_id != null ? String(ex.plan_item_id) : null;
      // F10S1 — the slot's REQUIRED set count (the accepted prescription's `sets`).
      // A positive integer engages the multiplicity rule below; null (no known
      // count) keeps the legacy any-attributed-log-completes rule.
      const sets = Number(ex && ex.sets);
      return {
        plan_item_id: planItemId,
        name,
        liftCode: String((ex && (ex.liftCode || ex.lift_code)) || '').trim(),
        order: i,
        explicit: planItemId ? (outcomeById.get(planItemId) || null) : null,
        requiredSets: Number.isInteger(sets) && sets >= 1 ? sets : null,
      };
    });
  }

  // F10S1 — count the performed sets that belong to an attributed slot: sessionLog
  // rows (per-set, RAW names) whose singular-normalized name matches the attributed
  // completion identity OR the slot's own name (a variant's rows match the former; a
  // substituted slot's rows match the latter). Floored at 1 when the slot has an
  // attribution — the attribution itself is proof of at least one performed set even
  // when alias-form raw rows defeat the name match (fail-closed toward IN PROGRESS,
  // never a silent zero and never a silent completion).
  function countPerformedSets(sessionLog, attributedName, slotName) {
    const keys = new Set([normKey(attributedName), normKey(slotName)].filter(Boolean));
    if (!keys.size) return 1;
    let n = 0;
    for (const r of (Array.isArray(sessionLog) ? sessionLog : [])) {
      const k = normKey(r && (r.canonical || r.exercise || r.name));
      if (k && keys.has(k)) n += 1;
    }
    return Math.max(n, 1);
  }

  /**
   * planSlotStatuses(activePlan, completedNames, sessionLog?) →
   *   [{ plan_item_id, name, liftCode, order, status,
   *      attributedName, performedSets, requiredSets }]   (1:1 with exercises, in order)
   *
   * status ∈ 'completed' | 'skipped' | 'pending'.
   *
   * activePlan: { exercises:[{name|canonicalName, liftCode, plan_item_id?, sets?}], items?:[{plan_item_id, outcome}] }
   * completedNames: resolved logged completions (name strings or { name, liftCode }),
   *   in log order — e.g. getSessionCompleted().
   * sessionLog (F10S1): the per-set raw log rows (e.g. getSessionLog()) — REQUIRED for
   *   the multiplicity rule. With it, a slot whose required set count is known completes
   *   only when its performed-set count reaches that count; below it the slot stays
   *   PENDING (in progress — one performed set never completes a 3-set slot, the July 18
   *   smoke failure). Without it (legacy callers/tests), attribution completes as before.
   *   The explicit id-outcome lane is AUTHORITATIVE either way.
   */
  function planSlotStatuses(activePlan, completedNames, sessionLog) {
    const slots = buildSlots(activePlan);
    const countable = Array.isArray(sessionLog);

    // 1) Seed from the AUTHORITATIVE id-keyed explicit item outcomes (AC5). An
    //    explicit "Done with this exercise" (completed) or a skip is definitive. A
    //    `substituted` item records the deviation but its COMPLETION still comes from
    //    logged evidence on the substitute identity the slot now carries — so it
    //    stays PENDING here until that substitute is logged.
    for (const s of slots) {
      if (s.explicit === STATUS.COMPLETED) s.status = STATUS.COMPLETED;
      else if (s.explicit === STATUS.SKIPPED) s.status = STATUS.SKIPPED;
      else s.status = STATUS.PENDING;
      s.attributedName = null;
      s.performedSets = 0;
    }

    // 2) Attribute each logged completion name to AT MOST ONE still-pending slot,
    //    keyed by slot position so duplicate names stay distinct. Tiers, highest
    //    first, over the UNCLAIMED pending slots:
    //      1. exact singular-normalized name
    //      2. exact liftCode (when the completion carries one)
    //      3. recognized variant of a bare base slot
    //      4. UNIQUE bidirectional substring (ambiguous → refuse)
    //    A lower tier is consulted only when every higher tier found nothing.
    const claimed = new Set(); // slot.order values already claimed by a logged set
    const eligible = () => slots.filter(s => s.status === STATUS.PENDING && !claimed.has(s.order));

    for (const raw of (Array.isArray(completedNames) ? completedNames : [])) {
      const cName = toName(raw);
      if (!cName) continue;
      const cKey = normKey(cName);
      const cLc = lc(cName);
      const cCode = toCode(raw);

      const cand = eligible();
      let target =
        cand.find(s => normKey(s.name) === cKey) ||
        (cCode ? cand.find(s => s.liftCode && lc(s.liftCode) === lc(cCode)) : null) ||
        cand.find(s => variantSatisfies(cLc, lc(s.name)));
      if (!target) {
        const subs = cand.filter(s => abbreviationMatch(cLc, lc(s.name)));
        if (subs.length === 1) target = subs[0]; // unique → attribute; ambiguous → refuse
      }
      if (target) {
        // F10S1 — attribution claims the slot; COMPLETION additionally requires the
        // performed-set count to reach the slot's required set count (when both the
        // count and per-set evidence are available). Below the count the slot stays
        // PENDING (in progress) — one performed set never completes a 3-set slot.
        target.attributedName = cName;
        claimed.add(target.order);
        const performed = countable ? countPerformedSets(sessionLog, cName, target.name) : null;
        if (performed != null) target.performedSets = performed;
        const multiplicityKnown = countable && target.requiredSets != null;
        if (!multiplicityKnown || performed >= target.requiredSets) target.status = STATUS.COMPLETED;
      } else {
        // Second-chance ATTRIBUTION (reporting only, status untouched): a name that
        // matched no pending slot may still belong to an already-RESOLVED one (the
        // athlete logged a set, then tapped the explicit Done — the slot completed via
        // the id lane before this name could claim it). Recording the attachment here
        // keeps such names recognized as PLAN work, so a consumer folding "unattributed
        // completions" into off-plan inserts (getCanonicalSession) never duplicates an
        // explicitly-completed planned lift as a phantom extra exercise.
        const resolved = slots.filter(s => s.status !== STATUS.PENDING && !s.attributedName && !claimed.has(s.order));
        const late =
          resolved.find(s => normKey(s.name) === cKey) ||
          (cCode ? resolved.find(s => s.liftCode && lc(s.liftCode) === lc(cCode)) : null) ||
          resolved.find(s => variantSatisfies(cLc, lc(s.name)));
        if (late) {
          late.attributedName = cName;
          claimed.add(late.order);
          if (countable) late.performedSets = countPerformedSets(sessionLog, cName, late.name);
        }
      }
    }

    return slots.map(s => ({
      plan_item_id: s.plan_item_id, name: s.name, liftCode: s.liftCode, order: s.order, status: s.status,
      attributedName: s.attributedName, performedSets: s.performedSets, requiredSets: s.requiredSets,
    }));
  }

  // ── Derived selectors (every consumer reads THESE — no parallel completion state) ─

  // The still-to-do slots (status 'pending', real name), in visible order. An
  // in-progress slot (attributed but below its required set count) stays here.
  function remainingSlots(activePlan, completedNames, sessionLog) {
    return planSlotStatuses(activePlan, completedNames, sessionLog).filter(s => s.status === STATUS.PENDING && s.name);
  }

  // Pending slot NAMES in order — the slot-distinct replacement for the old name-Set
  // remaining computation (a duplicate name appears once PER still-pending slot).
  function remainingSlotNames(activePlan, completedNames, sessionLog) {
    return remainingSlots(activePlan, completedNames, sessionLog).map(s => s.name);
  }

  // The first still-to-do slot (next up), or null when the plan is complete/empty.
  function firstUnloggedSlot(activePlan, completedNames, sessionLog) {
    return remainingSlots(activePlan, completedNames, sessionLog)[0] || null;
  }

  // Is a specific slot (by plan_item_id) complete? Fails closed (false) without an id.
  function isSlotComplete(activePlan, completedNames, planItemId, sessionLog) {
    const id = String(planItemId == null ? '' : planItemId);
    if (!id) return false;
    return planSlotStatuses(activePlan, completedNames, sessionLog)
      .some(s => s.plan_item_id === id && s.status === STATUS.COMPLETED);
  }

  // True when the plan has at least one real slot and NONE remain pending (completed
  // and skipped both count as resolved — mirrors the canonical session's isComplete).
  function isPlanComplete(activePlan, completedNames, sessionLog) {
    const named = planSlotStatuses(activePlan, completedNames, sessionLog).filter(s => s.name);
    return named.length > 0 && named.every(s => s.status !== STATUS.PENDING);
  }

  return {
    STATUS,
    planSlotStatuses,
    remainingSlots,
    remainingSlotNames,
    firstUnloggedSlot,
    isSlotComplete,
    isPlanComplete,
    // exposed for focused tests / reuse
    normKey,
  };
})();

export const {
  STATUS,
  planSlotStatuses,
  remainingSlots,
  remainingSlotNames,
  firstUnloggedSlot,
  isSlotComplete,
  isPlanComplete,
  normKey,
} = _exports;

// Re-export the single-home variant rule (owned by activeSession.js) so consumers can
// import it from the F10 module alongside the selectors.
export { variantSatisfies };
