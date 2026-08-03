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

// F10B — build the Session_Plan_Sets ledger v1 items (set-level recommendations) for
// the accepted plan. Joins the immutable accepted items (identity + code) with the
// displayed prescription (weight/reps/sets/rir), 1:1 by index. Only an item with a
// positive-integer set count is a set-level recommendation; an item without one is
// NOT invented into the ledger (it has no stored plan — F10E reads it as benchmark/
// trend). An item with a set count but missing load/reps is kept as a
// `no_reliable_target` recommendation (the set count is real; the target is honestly
// absent — never fabricated). Pure — no I/O.
export function buildLedgerAcceptedItems(items, exercises) {
  const list = Array.isArray(items) ? items : [];
  const exs = Array.isArray(exercises) ? exercises : [];
  const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 ? n : null; };
  const numOrNull = (v) => {
    if (v === 0 || v === '0') return 0;
    const n = Number(v);
    return v == null || v === '' || !Number.isFinite(n) ? null : n;
  };
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {};
    const ex = exs[i] || {};
    const target_set_count = posInt(ex.sets);
    if (target_set_count == null) continue; // no set-level recommendation → not in the ledger
    const target_weight = numOrNull(ex.weight);
    const target_reps = numOrNull(ex.reps);
    const target_rir = numOrNull(ex.rir);
    const reliable = target_weight != null && target_reps != null;
    out.push({
      plan_item_id: item.plan_item_id,
      planned_lift_code: item.planned_lift_code,
      target_set_count,
      target_weight,
      target_reps,
      target_rir,
      confidence: reliable ? 'reliable' : 'no_reliable_target',
    });
  }
  return out;
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
//   sessionId     — the ESTABLISHED workout session id, or null. Null means no
//                   identity exists yet; the client NEVER derives one (its old
//                   `${date}-{AM|PM}-01` mint re-used the first same-period
//                   session's identity). The /accept response carries the
//                   server-allocated identity, which is adopted below.
//   sessionDate   — today's date
//   setActivePlan(plan)    — store setter (setActivePlannedSession)
//   persist()              — snapshot persist (saveSessionSnapshot)
//   adoptSessionId(sid)    — record the server-allocated identity as the session's
//                            established one (DOM field + re-persist)
//   startWorkout(plan)     — begin the workout (banner + first lift)
//   postAccept(payload)    — POST /api/session-plans/accept → resolves the response
//                            body (or rejects on transport/HTTP error)
//
// Returns { started, blocked, ignored, captured, message, plan_version, session_id }.
// The workout is started for EVERY non-blocked acceptance, before and independent of
// the sidecar POST; a sidecar failure never unwinds the local accepted snapshot.
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

  // The identity the session already OWNS, if any. When null, no id is sent and no id
  // is derived — the server allocator is the one authority, and its response names
  // the identity this acceptance was durably written under.
  const establishedSessionId = d.sessionId || null;

  const accepted = {
    label: (rec && rec.label) || 'Recommended session',
    intentId: (rec && (rec.id != null ? rec.id : rec.intentId)) || null,
    session_id: establishedSessionId,
    session_date: d.sessionDate || null,
    plan_version: planVersion,
    accepted: true,
    items: built.items,
    // Tag each execution-view entry with its immutable plan_item_id (PR-G1). items[]
    // is built 1:1 from exercises, so items[i] ↔ exercises[i]. The tag travels with
    // the object through reorder/advance and is persisted in the snapshot, so a later
    // skip/substitution reads the item identity DIRECTLY off the slot — never
    // recovered by lift-code / name / array position (owner: fail closed if missing).
    exercises: exercises.map((ex, i) => ({ ...ex, plan_item_id: built.items[i].plan_item_id })),
    index: 0,
  };

  // Store + persist the immutable accepted identity BEFORE the request, then start
  // the workout. All three happen regardless of the sidecar outcome.
  if (typeof d.setActivePlan === 'function') d.setActivePlan(accepted);
  if (typeof d.persist === 'function') d.persist();
  if (typeof d.startWorkout === 'function') d.startWorkout(accepted);

  // F10B — durably checkpoint the accepted plan as the set-level ledger v1 the moment
  // it is accepted (design amendment A2: durable at creation; session state is a cache
  // reconstructed from these rows on reload). A NON-BLOCKING sidecar — DRY-RUN until
  // the owner enables live writes at F10D — that never blocks the workout, never
  // unwinds the accepted snapshot, and never touches the preview→approve→write path.
  const ledgerItems = buildLedgerAcceptedItems(built.items, exercises);
  const postLedger = (sid) => {
    if (!ledgerItems.length || typeof d.postLedgerCheckpoint !== 'function') return;
    Promise.resolve(d.postLedgerCheckpoint({
      session_id: sid,
      session_date: accepted.session_date,
      plan_version: planVersion,
      items: ledgerItems,
    })).catch(() => { /* sidecar failure never unwinds the accepted plan */ });
  };
  // An established identity checkpoints immediately, as before. An unestablished one
  // CANNOT: the ledger row's identity is the server's to allocate, so the checkpoint
  // waits below for /accept to name it — and is skipped entirely when it never does
  // (a row under a client-guessed id would be the exact merge this removes).
  if (establishedSessionId) postLedger(establishedSessionId);

  // No decided session identity is ever sent when none is established: the key is
  // OMITTED, not blanked, so the server's allocation path is unambiguous.
  const payload = {
    ...(establishedSessionId ? { session_id: establishedSessionId } : {}),
    session_date: accepted.session_date,
    plan_version: planVersion,
    items: built.items.map(toAcceptPayloadItem),
  };

  let captured = false;
  let copy = acceptCopy(null); // neutral by default (covers flag OFF / no response)
  let resp = null;
  try {
    resp = typeof d.postAccept === 'function' ? await d.postAccept(payload) : null;
  } catch {
    // ONE bounded recovery retry, unestablished only (Codex P1, this PR): a lost
    // response — including postAccept's own 10s abort — may follow a COMPLETED
    // server-side write, and without the response the allocated identity is
    // unrecoverable here: outcome/closeout would fail closed and a later save could
    // allocate a different id, splitting one workout. The identical pv_ payload is
    // idempotent — the route resolves a retry from the durable plan_accepted rows
    // and returns the ORIGINAL identity, so this recovers an id but can never mint
    // a second one. postAccept arms its own bound per call, so acceptance still
    // settles. An ESTABLISHED identity needs no recovery — no retry, as before.
    if (!establishedSessionId && typeof d.postAccept === 'function') {
      try { resp = await d.postAccept(payload); } catch { resp = null; }
    }
  }
  if (resp) {
    const env = resp.data && resp.data.session_plans ? resp.data.session_plans
      : (resp.session_plans ? resp.session_plans : null);
    // Adopt the server-allocated identity: the response's session_id is the identity
    // the acceptance was durably written under, and from here on it is the session's
    // established one — Session_Plan_Sets, Log_Cleaned/Effort, closeout, seal, undo
    // and readback all address it. `accepted` is the live store object, so the
    // mutation is visible to every consumer holding the active plan.
    const serverSessionId = resp.data && typeof resp.data.session_id === 'string'
      ? resp.data.session_id.trim()
      : (typeof resp.session_id === 'string' ? resp.session_id.trim() : '');
    if (!establishedSessionId && serverSessionId) {
      accepted.session_id = serverSessionId;
      if (typeof d.adoptSessionId === 'function') d.adoptSessionId(serverSessionId);
      postLedger(serverSessionId);
    }
    copy = acceptCopy(env);
    captured = copy.memory === true;
  }
  // Both attempts failed → keep the accepted snapshot, no retry with new IDs, neutral
  // copy. No identity is adopted or invented: the session stays unnamed and the write
  // path's server allocator names it at save time.

  return { started: true, captured, message: copy.text, plan_version: planVersion, payload, session_id: accepted.session_id };
}
