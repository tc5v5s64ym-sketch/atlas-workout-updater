/* #1189 — the PRESCRIPTION-ONLY set-revision proposal (propose → approve → revise).
 *
 * A sibling of activeReplacement.js, not an extension of it. The replacement lane is
 * movement-scoped end to end — its proposal id, position and approve executor are all built
 * around source → replacement, and it rejects a prescription-only change outright ("a no-op
 * (replacement collapses to the source) is not a replacement"). This lane carries the other
 * case: the movement STAYS in the plan and only its remaining prescription changes.
 *
 *   Before approval: the plan is untouched; nothing is revised.
 *   After approval:  the FUTURE (unperformed) sets of ONE accepted slot take the new target.
 *   Reject:          the proposal is cleared and the plan is left exactly as it was.
 *
 * This module owns the PURE logic — proposal construction, the deterministic fingerprint that
 * makes a re-tap idempotent and a changed proposal un-masqueradable, the staleness test, the
 * proposal line, and follow-up classification. The proposal STATE lives in the store
 * (getPendingSetRevision / setPendingSetRevision); the revision itself is emitted by app.js's
 * existing `emitEndorsedSetRevision` entry point (#1188). No new machinery.
 *
 * FAIL-CLOSED throughout. Approving rewrites every remaining set of a movement the athlete is
 * training against, so anything short of an unambiguous decision leaves the proposal pending
 * and the plan untouched. Numbers are never invented here — the caller resolves them from the
 * read-only engine and passes them in.
 *
 * DETERMINISTIC by contract: no model call, no DOM, no I/O, no clock. The engine owns the
 * decision; the LLM never does.
 */

import { isExplicitEndorsement } from './endorsedSetRevision.js';

function numOrNull(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

function key(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9?\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalize a prescription to the three fields a revision actually carries. `sets` is
// deliberately excluded: the revision is bounded by the ACCEPTED (v1) set count, never by the
// engine's own set count — the same rule emitFutureSetRevision enforces.
function prescriptionOf(p) {
  const o = p && typeof p === 'object' ? p : {};
  return { weight: numOrNull(o.weight), reps: numOrNull(o.reps), rir: numOrNull(o.rir) };
}

function samePrescription(a, b) {
  return a.weight === b.weight && a.reps === b.reps && a.rir === b.rir;
}

// A deterministic fingerprint of everything the proposal asserts — identity, movement, target,
// and the ledger grain it is bounded by. The same proposal recomputes the same id (so a re-tap
// or a reload is idempotent) and a CHANGED proposal cannot masquerade as it. Same discipline as
// the replacement lane's `repl:` ids, and clock-free for exactly that reason.
function setRevisionFingerprint(parts) {
  const p = parts || {};
  const rx = prescriptionOf(p.prescription);
  return [
    key(p.plan_item_id),
    key(p.planned_lift_code),
    rx.weight, rx.reps, rx.rir,
    numOrNull(p.accepted_set_count),
  ].join('|');
}

/**
 * Build the ONE pending set-revision proposal, or null when there is nothing to propose.
 *
 * Returns null — never a half-formed proposal — when the slot carries no ledger identity, the
 * movement has no canonical code, the engine resolved no usable target, or the "revision" would
 * change nothing. Proposing a change to exactly what is already prescribed is not a revision,
 * and staging one would ask the athlete to approve a no-op.
 *
 * Does NOT mutate anything and does NOT read a clock: `proposed_at` is supplied by the caller so
 * the id above stays deterministic.
 */
function buildSetRevisionProposal(params) {
  const p = params && typeof params === 'object' ? params : {};
  const planItemId = p.plan_item_id;
  const liftCode = p.planned_lift_code;
  const prescribedName = p.prescribed_name;
  if (!planItemId || !liftCode || !prescribedName) return null;

  const prescription = prescriptionOf(p.prescription);
  // A revision with no load and no rep target builds no revision downstream — refuse here
  // rather than staging a proposal that could only ever fail on approval.
  if (prescription.weight == null || prescription.reps == null) return null;

  const from = prescriptionOf(p.from);
  if (samePrescription(prescription, from)) return null;   // nothing would change

  const acceptedSetCount = numOrNull(p.accepted_set_count);
  if (acceptedSetCount == null || acceptedSetCount <= 0) return null;   // no v1 grain to bound it

  return {
    kind: 'set_revision',                 // discriminates from a pendingReplacement
    proposal_id: `setrev:${key(planItemId)}@${setRevisionFingerprint({
      plan_item_id: planItemId,
      planned_lift_code: liftCode,
      prescription,
      accepted_set_count: acceptedSetCount,
    })}`,
    plan_item_id: planItemId,             // the accepted slot — identity, never a name
    planned_lift_code: liftCode,          // UNCHANGED; the movement does not move
    prescribed_name: prescribedName,      // display only
    prescription,
    accepted_set_count: acceptedSetCount,
    from,
    proposed_at: p.proposed_at || null,
    plan_version: p.plan_version || null, // staleness anchor
    status: 'pending',
  };
}

// Find the accepted slot this proposal is about, BY IDENTITY. Matching by name would let a
// duplicate movement slot, a rename, or a swap redirect the revision to work the athlete never
// endorsed — the plan_item_id is the only thing that cannot drift.
function findSlotByItemId(exercises, planItemId) {
  const list = Array.isArray(exercises) ? exercises : [];
  if (!planItemId) return null;
  return list.find((e) => e && (e.plan_item_id || e.planItemId) === planItemId) || null;
}

/**
 * A proposal is fresh ONLY while everything it asserted still holds: the plan version it was
 * anchored to, the slot it identified, and the movement that slot carries. Anything else is
 * stale and must be refused and cleared, never applied to whatever the plan became.
 *
 * The "every set already performed" case is deliberately NOT tested here — it is enforced
 * underneath by the revision builder, which produces no future sets and therefore reports no
 * capture, so it can never be reported as a revision that did not happen.
 */
function isSetRevisionProposalFresh(proposal, exercises, planVersion) {
  if (!proposal || typeof proposal !== 'object') return false;
  if (proposal.kind !== 'set_revision') return false;
  // A proposal anchored to a plan version only matches that version. A proposal with no anchor
  // has no way to detect a re-accepted plan, so it is never fresh.
  if (!proposal.plan_version || proposal.plan_version !== planVersion) return false;
  const slot = findSlotByItemId(exercises, proposal.plan_item_id);
  if (!slot) return false;
  const code = slot.liftCode || slot.lift_code || '';
  return code === proposal.planned_lift_code;   // the movement moved under it → stale
}

// The proposed target line, or null when nothing authoritative resolved. Never invents a number.
function formatSetRevisionPrescription(prescription) {
  const rx = prescriptionOf(prescription);
  const parts = [];
  if (rx.weight != null) parts.push(`${rx.weight} lb`);
  if (rx.reps != null) parts.push(`${rx.reps} reps`);
  if (rx.rir != null) parts.push(`@ ${rx.rir} RIR`);
  return parts.length ? parts.join(' ') : null;
}

// The one-line proposal statement, e.g. "Keep Back Squat and take the rest of the sets to
// 185 lb 5 reps @ 2 RIR (from 225 lb 5 reps @ 2 RIR)." Names the movement explicitly so the
// athlete can see it is NOT being swapped.
function formatSetRevisionProposalLine(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const name = p.prescribed_name || 'that lift';
  const to = formatSetRevisionPrescription(p.prescription);
  if (!to) return `Keep ${name} — I don't have an authoritative target for the rest of the sets yet.`;
  const from = formatSetRevisionPrescription(p.from);
  return from
    ? `Keep ${name} and take the rest of the sets to ${to} (from ${from}).`
    : `Keep ${name} and take the rest of the sets to ${to}.`;
}

// ── follow-up classification (relative to a pending proposal) ──────────────────

// An unambiguous decline. Anchored to the WHOLE utterance so "no, replace it with bench" is a
// new command rather than a decline of this proposal.
const DECLINES = [
  'no', 'nope', 'nah', 'na', 'no thanks', 'not yet', 'not now', 'not today',
  'skip it', 'skip that', 'leave it', 'leave it alone', 'keep it', 'keep it as is',
  'cancel', 'nevermind', 'never mind', 'forget it', 'nvm', 'scratch that',
  'stay', 'stay as is', 'dont', 'do not', 'dont change it', 'do not change it',
];

// Bounded conversational lead-ins that may precede a decline without weakening it.
const LEAD_INS = ['ok', 'okay', 'k', 'alright', 'right', 'well', 'so', 'um', 'uh'];

function stripLeadIns(s) {
  let out = s;
  for (let i = 0; i < 3; i += 1) {
    const before = out;
    for (const lead of LEAD_INS) out = out.replace(new RegExp(`^${lead}(\\s+|$)`), '');
    if (out === before) break;
  }
  return out.trim();
}

function isExplicitDecline(text) {
  const s = normalize(text);
  if (!s) return false;
  if (s.includes('?')) return false;                 // a question is a question, not a decline
  const body = stripLeadIns(s);
  return DECLINES.includes(body);
}

// A question about the proposal — "why that weight?", "what would that do?", "how come?".
// This is the Ask Why case: it is NEITHER approval nor rejection, so the proposal must survive
// the turn so Atlas can answer and the athlete can still decide.
//
// The wh-words are unambiguous on their own. The AUXILIARY forms require a following pronoun,
// because a bare auxiliary opens an imperative far more often than a question in gym speech —
// "do it" is consent, not a question. (The classifier below also tests endorsement before
// reaching here, so an affirmative can never be swallowed as a question.)
const WH_LEAD_RE = /^(?:why|how|what|which|when|where|who)\b/;
const AUX_QUESTION_RE = /^(?:is|are|am|was|were|does|do|did|should|could|would|can|will|have|has)\s+(?:i|you|we|they|he|she|that|this|these|those|the|my)\b/;

function isProposalQuestion(text) {
  const s = normalize(text);
  if (!s) return false;
  return s.includes('?') || WH_LEAD_RE.test(s) || AUX_QUESTION_RE.test(s);
}

/**
 * Classify a follow-up turn against the pending proposal:
 *   'approve' — an unambiguous endorsement (the shared #1188 test — `yes`, `yeah do it`,
 *               `go ahead`, optionally after a bounded lead-in).
 *   'reject'  — an unambiguous decline.
 *   'query'   — a question the proposal answers directly; the proposal STAYS pending.
 *   null      — not a response to this proposal (including a bare `ok`/`sure`/`hmm`, which in
 *               gym conversation is as often "I heard you" as "do it"). Keep it pending and
 *               route the message normally.
 *
 * A literal `?` decides first — `isExplicitEndorsement` already refuses anything containing one,
 * and an unanswered question that fell through to `null` would silently strand the athlete. The
 * unpunctuated question LEADS are tested LAST so an imperative that happens to open with an
 * auxiliary ("do it") is read as the consent it is, not as a question.
 */
function classifySetRevisionFollowup(text, proposal) {
  if (!proposal || typeof proposal !== 'object' || proposal.kind !== 'set_revision') return null;
  const s = normalize(text);
  if (!s) return null;
  if (s.includes('?')) return 'query';
  if (isExplicitEndorsement(s)) return 'approve';
  if (isExplicitDecline(s)) return 'reject';
  if (isProposalQuestion(s)) return 'query';
  return null;
}

export {
  buildSetRevisionProposal,
  isSetRevisionProposalFresh,
  setRevisionFingerprint,
  findSlotByItemId,
  formatSetRevisionPrescription,
  formatSetRevisionProposalLine,
  isExplicitDecline,
  isProposalQuestion,
  classifySetRevisionFollowup,
};
