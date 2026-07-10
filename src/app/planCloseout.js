// ── Explicit session closeout capture (PR-H) — finalized / abandoned ──────────
//
// Pure, DOM-free, network-free helpers + a DI orchestrator for capturing an EXPLICIT
// session closeout on an ACCEPTED plan (docs/SESSION_PLANS_CAPTURE_SPEC.md §4.3).
// `finalized` = the athlete explicitly closed the session (Finish / End session) —
// NOT "all items completed". `abandoned` = the athlete explicitly discarded it
// (Start over / confirmed discard) with no intent to continue. Closeout is NEVER
// inferred from inactivity, browser close, navigation, timeout, reload, redeploy,
// missing state, or an incomplete plan; the implicit `endPlannedSession` cleanup
// paths must not emit — the caller wires this ONLY at the explicit affordances.
//
// Identity is the existing immutable `session_id` + `plan_version` off the accepted
// plan. Fails closed when the plan isn't an accepted session (no event). Session_Plans
// is a non-blocking sidecar: `runCloseout` never throws, so a sidecar failure cannot
// block or corrupt the local session close/discard; retries reuse the same event
// identity (the server's deterministic idempotency_key collapses duplicates).

export const CLOSEOUT_STATUSES = Object.freeze(['finalized', 'abandoned']);

function _str(v) { return v == null ? '' : String(v).trim(); }

// Build the POST /api/session-plans/closeout payload, or null (fail closed) when the
// plan isn't an accepted, identifiable session or the status is not in the frozen
// vocabulary.
export function buildCloseoutPayload(activePlan, closeoutStatus) {
  const plan = activePlan && typeof activePlan === 'object' ? activePlan : null;
  if (!plan || plan.accepted !== true) return null;
  const session_id = _str(plan.session_id);
  const plan_version = _str(plan.plan_version);
  const session_date = _str(plan.session_date);
  if (!session_id || !plan_version) return null;
  const cs = _str(closeoutStatus);
  if (!CLOSEOUT_STATUSES.includes(cs)) return null;
  return { session_id, session_date, plan_version, closeout_status: cs };
}

// Orchestrate one explicit closeout. DEPS: postCloseout(payload) → resolves the
// response body (or rejects). Returns { emitted, captured, reason }. `emitted:false`
// = failed closed (not an accepted session) — never an error. A POST failure is
// caught → { emitted:true, captured:false }; the local close/discard is never blocked.
export async function runCloseout(activePlan, closeoutStatus, deps) {
  const payload = buildCloseoutPayload(activePlan, closeoutStatus);
  if (!payload) return { emitted: false, captured: false, reason: 'no_identity' };
  const d = deps || {};
  try {
    const resp = typeof d.postCloseout === 'function' ? await d.postCloseout(payload) : null;
    const env = resp && resp.data && resp.data.session_plans ? resp.data.session_plans
      : (resp && resp.session_plans ? resp.session_plans : null);
    return { emitted: true, captured: !!(env && env.captured === true), reason: env ? env.status : null, payload };
  } catch (e) {
    return { emitted: true, captured: false, reason: 'error', payload };
  }
}
