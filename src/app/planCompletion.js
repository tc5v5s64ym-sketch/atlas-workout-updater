/* Mid-plan completed-boundary eligibility (PR-I5, owner-approved "target last-logged
 * item"). PURE / DI — no DOM, no I/O — so it is unit-testable in Node and loadable in
 * the browser.
 *
 * The explicit `completed` outcome is authored ONLY by an explicit "Done with
 * <exercise>" tap — logging a set and cursor movement never emit it. The plan cursor
 * auto-advances past a just-logged item, so the *current* slot rarely holds the
 * performed-set evidence the button needs; this selects the MOST RECENTLY LOGGED
 * accepted item that is still unresolved, so a mid-plan item stays reachable after the
 * cursor has moved on.
 *
 * IDENTITY RULE: the returned target carries the slot's immutable `plan_item_id`. The
 * caller completes strictly by that id — never by name, lift code, or array position.
 * A name is used ONLY as logged-evidence (logs are name-keyed) and for the button
 * label; two slots sharing a lift code stay unambiguous because each is its own
 * plan_item_id.
 */
const _exports = (function () {
  'use strict';

  const _s = (v) => String(v == null ? '' : v).trim().toLowerCase();

  /**
   * mostRecentCompletablePlanItem(plan, loggedNames) →
   *   { plan_item_id, name } | null
   *
   * plan: { accepted, exercises:[{plan_item_id,name,canonicalName}], items:[{plan_item_id,outcome}] }
   * loggedNames: exercise names in log order (earliest → latest), e.g. getSessionCompleted().
   *
   * Eligible slot = still present in exercises (skipped items were spliced out), its
   * item.outcome is NOT 'completed' (no re-complete), and its current exercise name has
   * logged evidence. Among eligible slots, the one whose name was logged LATEST wins
   * (target the last-logged item). Returns null when nothing is completable.
   */
  function mostRecentCompletablePlanItem(plan, loggedNames) {
    if (!plan || plan.accepted !== true || !Array.isArray(plan.exercises)) return null;
    const items = Array.isArray(plan.items) ? plan.items : [];
    const outcomeOf = (id) => {
      const it = items.find(x => x && x.plan_item_id === id);
      return it ? it.outcome : null;
    };
    const logged = (Array.isArray(loggedNames) ? loggedNames : []).map(_s);

    let best = null;
    let bestIdx = -1;
    for (const slot of plan.exercises) {
      if (!slot || !slot.plan_item_id) continue;               // fail closed — no identity
      if (outcomeOf(slot.plan_item_id) === 'completed') continue; // already resolved
      const key = _s(slot.canonicalName || slot.name);
      if (!key) continue;
      const lastIdx = logged.lastIndexOf(key);                 // most-recent evidence
      if (lastIdx === -1) continue;                            // no performed set → not yet completable
      if (lastIdx > bestIdx) { bestIdx = lastIdx; best = { plan_item_id: slot.plan_item_id, name: slot.name }; }
    }
    return best;
  }

  return { mostRecentCompletablePlanItem };
})();

export const { mostRecentCompletablePlanItem } = _exports;
