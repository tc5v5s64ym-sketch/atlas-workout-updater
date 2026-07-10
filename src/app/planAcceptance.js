// ── Plan acceptance — the "Start this plan" authoritative boundary (PR-F) ──────
//
// Pure, DOM-free, network-free helpers + a dependency-injected orchestrator for the
// ONLY authoritative plan-acceptance action (docs/SESSION_PLANS_CAPTURE_SPEC.md §5):
// the user pressing "Start this plan" on the displayed plan card. Identity is
// client-generated OPAQUE UUID-backed tokens (pv_/pi_), minted ONCE at acceptance,
// stored in active-session state before the request, and reused on retry/reload —
// NEVER content-derived, NEVER a timestamp/Math.random (owner decision §4.4).
//
// This module holds no state and touches no globals: app.js injects the crypto
// source, the store setters, the persist call, the workout-start call, and the
// /api/session-plans/accept POST, so the whole flow is unit-testable in Node without
// a DOM. Session_Plans is a NON-BLOCKING sidecar — the workout starts regardless of
// the flag, a disabled response, a missing tab, or a sidecar failure, and no
// memory/persistence language is shown unless the endpoint proves captured===true.

export const PV_PREFIX = 'pv_';
export const PI_PREFIX = 'pi_';

// User-facing copy when a plan item lacks resolved canonical identity — acceptance
// is blocked and NO partial snapshot is created.
export const UNRESOLVED_PLAN_MESSAGE =
  "Atlas couldn't start that plan because one exercise wasn't fully resolved.";

// A canonical lift code: non-empty, no whitespace (mirrors the server route +
// sessionPlanEvents._requireLiftCode).
const CANONICAL_CODE = /^\S+$/;

// Mint an opaque UUID from a cryptographic source ONLY. crypto.randomUUID when
// available, else a v4 UUID from crypto.getRandomValues. Returns null when no
// cryptographic source exists — the caller then blocks acceptance rather than fall
// back to a timestamp/Math.random identity (owner rule §4.4).
export function cryptoUuid(cryptoObj) {
  const c = cryptoObj || null;
  if (!c) return null;
  if (typeof c.randomUUID === 'function') {
    try { return c.randomUUID(); } catch { /* fall through to getRandomValues */ }
  }
  if (typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    const h = [];
    for (let i = 0; i < 16; i++) h.push(b[i].toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
  }
  return null;
}

// Mint a prefixed opaque id (pv_… / pi_…), or null when no crypto is available.
export function mintId(prefix, cryptoObj) {
  const uuid = cryptoUuid(cryptoObj);
  return uuid ? `${prefix}${uuid}` : null;
}

// Build the immutable accepted-plan items from the displayed plan's normalized
// exercises. Each MUST carry a canonical liftCode; one immutable pi_ id is minted
// per item. Returns { ok:true, items } or { ok:false, reason } — a single
// unresolved item blocks the whole acceptance (no partial snapshot). Extra/off-plan
// lifts are never here: this maps ONLY the displayed plan's exercises 1:1.
export function buildAcceptedItems(exercises, mintItemId) {
  const list = Array.isArray(exercises) ? exercises : [];
  if (!list.length) return { ok: false, reason: 'empty_plan' };
  const items = [];
  for (let i = 0; i < list.length; i++) {
    const ex = list[i] || {};
    const code = ex.liftCode == null ? '' : String(ex.liftCode).trim();
    if (!CANONICAL_CODE.test(code)) return { ok: false, reason: 'unresolved_item' };
    const planItemId = mintItemId();
    if (!planItemId) return { ok: false, reason: 'no_crypto' };
    items.push({
      plan_item_id: planItemId,
      planned_order: i + 1,
      planned_lift_code: code,
      movement_pattern: ex.movementPattern || ex.movement_pattern || null,
      outcome: 'planned',
      performed_lift_code: null,
    });
  }
  return { ok: true, items };
}

// The /api/session-plans/accept item payload (spec §4.1) — identity + planned
// metadata only; no loads/reps/RIR. movement_pattern omitted when unresolved.
export function toAcceptPayloadItem(item) {
  const out = {
    plan_item_id: item.plan_item_id,
    planned_order: item.planned_order,
    planned_lift_code: item.planned_lift_code,
  };
  if (item.movement_pattern) out.movement_pattern = item.movement_pattern;
  return out;
}

// Choose user-facing copy from the /accept envelope. ONLY captured===true licenses
// memory/persistence language; every other state (disabled / tab_missing /
// header_mismatch / error / unknown / no response) stays neutral.
export function acceptCopy(envelope) {
  if (envelope && envelope.captured === true) return { memory: true, text: 'Plan captured.' };
  return { memory: false, text: 'Plan started.' };
}

// Orchestrate one acceptance. DEPS (all injected by app.js):
//   crypto        — the cryptographic source (window.crypto)
//   guard         — a mutable object; guard.busy prevents a concurrent double-tap
//                   from minting a second revision
//   sessionId, sessionDate — the reused workout session id + today's date
//   setActivePlan(plan)    — store setter (setActivePlannedSession)
//   persist()              — snapshot persist (saveSessionSnapshot)
//   startWorkout(plan)     — begin the workout (banner + first lift)
//   postAccept(payload)    — POST /api/session-plans/accept → resolves the response
//                            body (or rejects on transport/HTTP error)
//
// Returns { started, blocked, ignored, captured, message, plan_version }. The
// workout is started for EVERY non-blocked acceptance, before and independent of the
// sidecar POST; a sidecar failure never unwinds the local accepted snapshot.
export async function runAcceptance(rec, deps) {
  const d = deps || {};
  const guard = d.guard || {};
  if (guard.busy) return { started: false, ignored: true, message: null };

  const exercises = (rec && Array.isArray(rec.exercises)) ? rec.exercises : [];
  const built = buildAcceptedItems(exercises, () => mintId(PI_PREFIX, d.crypto));
  if (!built.ok) {
    return { started: false, blocked: true, message: UNRESOLVED_PLAN_MESSAGE, reason: built.reason };
  }
  const planVersion = mintId(PV_PREFIX, d.crypto);
  if (!planVersion) {
    return { started: false, blocked: true, message: UNRESOLVED_PLAN_MESSAGE, reason: 'no_crypto' };
  }

  guard.busy = true; // held: this card is spent — a repeat tap can't mint a 2nd revision

  const accepted = {
    label: (rec && rec.label) || 'Recommended session',
    intentId: (rec && (rec.id != null ? rec.id : rec.intentId)) || null,
    session_id: d.sessionId || null,
    session_date: d.sessionDate || null,
    plan_version: planVersion,
    accepted: true,
    items: built.items,
    exercises,
    index: 0,
  };

  // Store + persist the immutable accepted identity BEFORE the request, then start
  // the workout. All three happen regardless of the sidecar outcome.
  if (typeof d.setActivePlan === 'function') d.setActivePlan(accepted);
  if (typeof d.persist === 'function') d.persist();
  if (typeof d.startWorkout === 'function') d.startWorkout(accepted);

  const payload = {
    session_id: accepted.session_id,
    session_date: accepted.session_date,
    plan_version: planVersion,
    items: built.items.map(toAcceptPayloadItem),
  };

  let captured = false;
  let copy = acceptCopy(null); // neutral by default (covers flag OFF / no response)
  try {
    const resp = typeof d.postAccept === 'function' ? await d.postAccept(payload) : null;
    const env = resp && resp.data && resp.data.session_plans ? resp.data.session_plans
      : (resp && resp.session_plans ? resp.session_plans : null);
    copy = acceptCopy(env);
    captured = copy.memory === true;
  } catch {
    // Sidecar failure — keep the accepted snapshot, no retry with new IDs, neutral copy.
    copy = acceptCopy(null);
    captured = false;
  }

  return { started: true, captured, message: copy.text, plan_version: planVersion, payload };
}
