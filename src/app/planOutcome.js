// ── Explicit item-outcome capture (PR-G1) — skipped / substituted ─────────────
//
// Pure, DOM-free, network-free helpers + a DI orchestrator for capturing an
// EXPLICIT per-item outcome on an ACCEPTED plan (docs/SESSION_PLANS_CAPTURE_SPEC.md
// §4.2). PR-G1 ships only the two genuinely-explicit outcomes — `skipped` (a typed
// "skip X" or "Next" on a not-yet-logged current slot) and `substituted` (a typed /
// declared swap). `completed` is PR-G2 (its own explicit "Done with this exercise"
// button); NO inference from logged sets anywhere here.
//
// Identity is taken DIRECTLY from the immutable accepted `items[]` by `plan_item_id`
// — the caller reads the id off the tagged execution slot (planAcceptance.js tags
// each exercise at acceptance) and passes it in. Identity is NEVER recovered by
// lift-code, name, or array position. If the plan is not accepted, has no
// `plan_version`, or the `plan_item_id` is missing/unknown, the outcome FAILS CLOSED
// (no event emitted, no fallback matching) — the workout action still proceeds.
//
// Session_Plans is a non-blocking sidecar: `runOutcome` never throws, a failed POST
// leaves the workout untouched, retries reuse the same event identity (the server's
// deterministic idempotency_key collapses duplicates), and the immutable accepted
// snapshot is never mutated.

export const ITEM_OUTCOMES = Object.freeze(['completed', 'skipped', 'substituted']);
const CANONICAL_CODE = /^\S+$/;

function _str(v) { return v == null ? '' : String(v).trim(); }

// Find the accepted item for an outcome by plan_item_id ONLY. Returns the item or
// null — never a lift-code/name/position fallback.
export function resolveItemForOutcome(activePlan, planItemId) {
  const id = _str(planItemId);
  if (!id) return null;
  const items = activePlan && Array.isArray(activePlan.items) ? activePlan.items : [];
  return items.find(it => it && _str(it.plan_item_id) === id) || null;
}

// Build the POST /api/session-plans/outcome payload for an explicit outcome, or null
// (fail closed) when the plan is not an accepted, identifiable session. `outcome` ∈
// skipped | substituted (PR-G1). `substituted` requires a canonical performed code
// and preserves the item's planned_lift_code; `skipped` carries no performed code.
export function buildOutcomePayload(activePlan, { plan_item_id, outcome, performed_lift_code } = {}) {
  const plan = activePlan && typeof activePlan === 'object' ? activePlan : null;
  if (!plan || plan.accepted !== true) return null;
  const session_id = _str(plan.session_id);
  const plan_version = _str(plan.plan_version);
  const session_date = _str(plan.session_date);
  if (!session_id || !plan_version) return null;
  const oc = _str(outcome);
  if (oc !== 'skipped' && oc !== 'substituted') return null; // PR-G1 scope
  // Identity by plan_item_id ONLY — fail closed if the accepted item is unknown.
  const item = resolveItemForOutcome(plan, plan_item_id);
  if (!item) return null;
  const planned_lift_code = _str(item.planned_lift_code);
  if (!CANONICAL_CODE.test(planned_lift_code)) return null; // never invent identity
  const outItem = {
    plan_item_id: _str(item.plan_item_id),
    planned_order: item.planned_order == null ? '' : item.planned_order,
    planned_lift_code,
    outcome: oc,
  };
  if (item.movement_pattern) outItem.movement_pattern = item.movement_pattern;
  if (oc === 'substituted') {
    const performed = _str(performed_lift_code);
    if (!CANONICAL_CODE.test(performed)) return null; // substituted REQUIRES a valid performed code
    outItem.performed_lift_code = performed;
  }
  return { session_id, session_date, plan_version, item: outItem };
}

// Orchestrate one explicit outcome. DEPS: postOutcome(payload) → resolves the
// response body (or rejects on transport/HTTP error). Returns
// { emitted, captured, reason }. `emitted:false` = failed closed (no identity / not
// accepted) — never an error. A POST failure is caught → { emitted:true,
// captured:false }; the workout is never blocked.
export async function runOutcome(activePlan, outcomeInput, deps) {
  const payload = buildOutcomePayload(activePlan, outcomeInput || {});
  if (!payload) return { emitted: false, captured: false, reason: 'no_identity' };
  const d = deps || {};
  try {
    const resp = typeof d.postOutcome === 'function' ? await d.postOutcome(payload) : null;
    const env = resp && resp.data && resp.data.session_plans ? resp.data.session_plans
      : (resp && resp.session_plans ? resp.session_plans : null);
    return { emitted: true, captured: !!(env && env.captured === true), reason: env ? env.status : null, payload };
  } catch (e) {
    // Sidecar failure — never block the workout; retries reuse the same identity.
    return { emitted: true, captured: false, reason: 'error', payload };
  }
}
