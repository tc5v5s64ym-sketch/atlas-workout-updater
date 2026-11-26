// ── Explicit item-outcome capture (PR-G1/G2) — skipped / substituted / completed ─
//
// Pure, DOM-free, network-free helpers + a DI orchestrator for capturing an
// EXPLICIT per-item outcome on an ACCEPTED plan (docs/SESSION_PLANS_CAPTURE_SPEC.md
// §4.2). Three genuinely-explicit outcomes: `skipped` (a typed "skip X" or "Next" on
// a not-yet-logged current slot) and `substituted` (a typed / declared swap) — PR-G1;
// and `completed` — PR-G2, emitted ONLY by the explicit "Done with this exercise"
// button (never by logging a set, "Next", or chat text). NO inference from logged
// sets anywhere here.
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
// Skip categories (#1341 follow-up): the reason a skipped item was skipped.
// The client only ever sends 'deliberate' — the skip tap / "Next" is an explicit
// athlete choice. 'time' / 'truncated' are closeout-derived categories with no
// client emitter in this slice; the server accepts and counts them.
export const SKIP_CATEGORIES = Object.freeze(['deliberate', 'time', 'truncated']);
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
// `skipped` may carry skip_category (#1341 follow-up); an invalid category is
// DROPPED, never forwarded — the skip itself is the primary fact, and forwarding
// a bad category would make the server 400 the whole outcome and lose the skip.
// A category on a non-skipped outcome is likewise dropped, never forwarded.
export function buildOutcomePayload(activePlan, { plan_item_id, outcome, performed_lift_code, skip_category } = {}) {
  const plan = activePlan && typeof activePlan === 'object' ? activePlan : null;
  if (!plan || plan.accepted !== true) return null;
  const session_id = _str(plan.session_id);
  const plan_version = _str(plan.plan_version);
  const session_date = _str(plan.session_date);
  if (!session_id || !plan_version) return null;
  const oc = _str(outcome);
  // skipped/substituted (PR-G1) + completed (PR-G2, the explicit "Done with this
  // exercise" boundary). `completed` carries NO performed code (like skipped).
  if (oc !== 'skipped' && oc !== 'substituted' && oc !== 'completed') return null;
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
  if (oc === 'skipped') {
    const cat = _str(skip_category);
    if (cat && SKIP_CATEGORIES.includes(cat)) outItem.skip_category = cat;
  }
  return { session_id, session_date, plan_version, item: outItem };
}

// Orchestrate one explicit outcome. DEPS: postOutcome(payload) → resolves the
// response body (or rejects on transport/HTTP error); mintOperationId() mints a
// #1780 ledger operation ID for the event (optional; absent ⇒ the field stays
// absent and the capture takes the legacy path). Returns
// { emitted, captured, reason }. `emitted:false` = failed closed (no identity / not
// accepted) — never an error. A POST failure is caught → { emitted:true,
// captured:false }; the workout is never blocked.
export async function runOutcome(activePlan, outcomeInput, deps) {
  const payload = buildOutcomePayload(activePlan, outcomeInput || {});
  if (!payload) return { emitted: false, captured: false, reason: 'no_identity' };
  const d = deps || {};
  // #1780 — mint the ledger operation ID for this deliberate event once,
  // before the first submission. The minter arrives as a dep (app.js
  // injects the app.js minter); absent, the field stays absent and the
  // capture takes the legacy path. Never blocks the outcome.
  if (typeof d.mintOperationId === 'function') {
    try {
      const operationId = await d.mintOperationId();
      if (operationId) payload.operation_id = operationId;
    } catch { /* a mint failure leaves the field absent — legacy path */ }
  }
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
