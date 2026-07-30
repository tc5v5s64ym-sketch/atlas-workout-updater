/* #1189 — the prescription-only proposal: "keep this movement, the rest of the sets are now X".
 *
 * WHY THIS EXISTS. Before it, the only proposal lane was `pendingReplacement`, which is
 * movement-scoped end to end and explicitly rejects a same-movement proposal (app.js: "A no-op
 * (replacement collapses to the source) is not a replacement"). So a set-level change had nowhere
 * durable to live, and #1163's requirement — that identity and prescription come FROM THE STORED
 * PROPOSAL, never reconstructed from free text — could not be met.
 *
 * This module is PURE: it builds and judges proposals. It performs no I/O, renders nothing, and
 * calls no model. Persistence lives in store.js and the side effect (emitting the revision) lives
 * in the app shell, so the three boundaries stay separable and separately testable.
 *
 * FAIL-CLOSED THROUGHOUT. A proposal that cannot be fully substantiated is not built, and a
 * proposal that cannot be proven current is not approvable. Rewriting the remaining sets of a
 * session the athlete is mid-way through is not something to do on a guess.
 */

import { performedSetCount } from './sessionLedger.js';

const KIND = 'set_revision';

function _str(v) {
  return String(v == null ? '' : v).trim();
}

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// A short, stable, order-independent-of-clock fingerprint. Deterministic by construction: the same
// (item, movement, prescription, set count) always yields the same id, and any change to the
// prescription yields a different one — so a mutated proposal can never masquerade as the one the
// athlete was shown. Deliberately NOT time-based; `proposed_at` is staleness evidence, not identity.
function _fingerprint(parts) {
  const s = parts.map((p) => (p === null || p === undefined ? '~' : String(p))).join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Build a proposal, or return null. Null is the honest answer for anything incomplete: a missing
// plan item, a missing movement, or a prescription with no usable target. A target is never
// invented — an unresolved engine load simply means there is nothing to propose.
function buildSetRevisionProposal(params) {
  const p = params && typeof params === 'object' ? params : {};
  const plan_item_id = _str(p.plan_item_id);
  const planned_lift_code = _str(p.planned_lift_code);
  const prescribed_name = _str(p.prescribed_name);
  if (!plan_item_id || !planned_lift_code || !prescribed_name) return null;

  const src = p.prescription && typeof p.prescription === 'object' ? p.prescription : {};
  const weight = _num(src.weight);
  const reps = _num(src.reps);
  const rir = _num(src.rir);
  // A revision must change something measurable. Weight or reps is the minimum; RIR alone is a
  // coaching note, not a prescription change the ledger can carry.
  if (weight === null && reps === null) return null;

  // …and when the CURRENT target is known, it must actually differ. Testing presence rather than
  // change accepted a no-op — proposing the same 225x5 already prescribed — and approval then
  // appended `live_revision` rows for every future set, so the ledger and the closeout history
  // would report a revised plan that was never revised (Codex P2, this PR). An RIR-only change is
  // rejected here for the same reason the rule above gives.
  const cur = p.from && typeof p.from === 'object' ? p.from : null;
  if (cur) {
    const curWeight = _num(cur.weight);
    const curReps = _num(cur.reps);
    const weightChanged = weight !== null && weight !== curWeight;
    const repsChanged = reps !== null && reps !== curReps;
    if (!weightChanged && !repsChanged) return null;
  }

  const accepted_set_count = _num(p.accepted_set_count);
  if (accepted_set_count === null || accepted_set_count <= 0) return null;

  const from = p.from && typeof p.from === 'object'
    ? { weight: _num(p.from.weight), reps: _num(p.from.reps), rir: _num(p.from.rir) }
    : null;

  return {
    kind: KIND,
    proposal_id: `setrev:${plan_item_id}@${_fingerprint([plan_item_id, planned_lift_code, weight, reps, rir, accepted_set_count])}`,
    plan_item_id,
    planned_lift_code,
    prescribed_name,
    prescription: { weight, reps, rir },
    from,
    accepted_set_count,
    plan_version: _str(p.plan_version) || null,
    proposed_at: _str(p.proposed_at) || null,
  };
}

// Is this proposal still the one the athlete is looking at, against the plan as it stands now?
// Anything unprovable is stale. `plan` is the active planned session.
function isProposalCurrent(proposal, plan) {
  if (!proposal || proposal.kind !== KIND) return false;
  const s = plan && typeof plan === 'object' ? plan : null;
  if (!s || s.accepted !== true) return false;
  // The plan moved on — a proposal anchored to an older version describes a plan that no longer
  // exists, and applying it would revise sets the athlete never agreed to in their current form.
  if (proposal.plan_version && _str(s.plan_version) !== _str(proposal.plan_version)) return false;
  // The slot it targets must still be in the plan…
  const items = Array.isArray(s.exercises) ? s.exercises : [];
  const slot = items.find((e) => e && _str(e.plan_item_id) === _str(proposal.plan_item_id));
  if (!slot) return false;

  // …AND it must still be the same MOVEMENT. `applySessionSubstitution` swaps a slot in place and
  // deliberately PRESERVES its plan_item_id and plan_version (app.js: `plan_item_id:
  // originalItemId`), so an id-and-version check alone treats a proposal as current after the
  // movement changed underneath it. Approving that stale card would append a revision carrying the
  // OLD planned_lift_code to a slot that now holds a different lift, corrupting the effective
  // recommendation chain (Codex P1, this PR). A proposal is about one movement; if the movement
  // moved, the proposal is stale.
  const slotCode = _str(slot.lift_code || slot.liftCode);
  if (!slotCode) return false;                       // an unidentifiable slot cannot be proven current
  return slotCode === _str(proposal.planned_lift_code);
}

// Does `candidate` supersede `existing`? A newer proposal for the SAME plan item replaces the
// older one, so only one decision is ever outstanding per slot.
function supersedes(candidate, existing) {
  if (!candidate || !existing) return false;
  if (candidate.kind !== KIND || existing.kind !== KIND) return false;
  if (_str(candidate.plan_item_id) !== _str(existing.plan_item_id)) return false;
  return candidate.proposal_id !== existing.proposal_id;
}

// The approval decision, in one place so no caller can partially apply it. Returns a verdict
// rather than performing the side effect: `apply` is the ONLY true outcome, and every other
// outcome names why it refused, so the shell can render an honest reason.
//   'apply'      — approve it now
//   'stale'      — the plan moved or the slot is gone; clear it
//   'mismatch'   — the id does not name the active proposal (superseded, or nothing active)
//   'malformed'  — the request itself is unusable; keep the proposal
//   'not_consent'— no unambiguous endorsement; KEEP the proposal so a question can be answered
function decideApproval(request, active, plan, isEndorsement) {
  const r = request && typeof request === 'object' ? request : null;
  if (!r || !_str(r.proposal_id)) return 'malformed';
  if (!active || active.kind !== KIND) return 'mismatch';
  if (_str(r.proposal_id) !== _str(active.proposal_id)) return 'mismatch';
  if (!isProposalCurrent(active, plan)) return 'stale';
  const consent = typeof isEndorsement === 'function' ? isEndorsement(r.endorsement) : false;
  if (!consent) return 'not_consent';
  return 'apply';
}

// How many sets of this proposal's movement are still AHEAD, given the session buffer.
//
// This is a session-truth SELECTOR, so it lives here rather than in the app shell: the Phase-2
// app.js freeze forbids adding session-truth derivation to `src/app/app.js` (Codex P1, criterion 4
// step (b) — it was written there first, which was the freeze violation the review caught). Pure by
// construction: the caller passes the log in, and the performed count comes from the ledger's OWN
// selector — the same one `emitFutureSetRevision` bounds its revisions by — so the scope Atlas talks
// about and the scope it would actually revise can never disagree. A completed set is never counted
// as editable.
function futureSetCount(proposal, sessionLog) {
  const accepted = _num(proposal && proposal.accepted_set_count);
  if (accepted === null || accepted <= 0) return 0;
  const done = performedSetCount(sessionLog, proposal && proposal.prescribed_name);
  return Math.max(0, accepted - (Number.isFinite(done) ? done : 0));
}

export { KIND, buildSetRevisionProposal, isProposalCurrent, supersedes, decideApproval, futureSetCount };
