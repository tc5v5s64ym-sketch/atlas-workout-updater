'use strict';

// ── THE staged-proposal observation (TEMPORARY F-SB4B; sunset: F-SB4C) ─────────
//
// THE DEFECT THIS REPLACES (owner instruction, F-SB4B corrective 3). The harness
// inferred the replacement's identity from the network: it recorded every
// `GET /api/recommend/next/<code>` request, tagged each with the phase the driver
// happened to be in, and took the last one tagged `substitution_ask` as "the lift
// code the engine resolved for this proposal".
//
// That inference is EMPTY BY CONSTRUCTION on the lane Session 1 actually takes. The
// constraint lane (`checkAndSuggestSubstitute` → `stageSubstitutionProposal`) gets
// the substitute AND its prescription from `POST /api/suggest-substitute`; it
// resolves the lift code locally through `resolveCatalogExercise` and never calls
// `recommend/next` for the replacement at all. The `recommend/next/IDB01` calls that
// do occur are the NEXT-UP prescription fetched after the swap is applied — after
// the phase window has closed. So the captured identity was blank on both runs, and
// two scorecard conditions failed against a product that behaved correctly:
// `declared_conversation_observed` (the capture beat) and
// `session_plan_sets_binding_and_seal` (a blank expected replacement lift makes
// every revision row mismatch the declared multiset).
//
// Widening the phase window would not fix it — there is no request to widen onto.
// The identity was never on the wire; it was in the STAGED PROPOSAL.
//
// THE REPLACEMENT AUTHORITY. `store.pendingReplacement` is the single staged
// proposal every substitution lane writes (F-SB3 owner ruling 2026-08-02), and
// `renderReplacementProposal` dispatches it on `document` as
// `atlas:replacement-proposed` at the moment it is staged — after
// `setPendingReplacement`, before any approval, mutation, or durable read. This
// module listens for that event and records ONE complete immutable observation per
// staging:
//
//   * the replacement's lift code, name, and the engine's whole prescription
//     (weight / reps / RIR / set count), taken from the proposal object itself —
//     never parsed out of the visible proposal line;
//   * the source lift, its lift code, and its immutable `plan_item_id`, read off
//     the live plan at the slot THE PROPOSAL ITSELF resolved (`proposal.position`,
//     computed by `buildReplacementProposal.findSlotIndex` against the same plan
//     array) — so no second name-matching authority is introduced here;
//   * the plan as it stood at staging, which is what makes "captured before the
//     mutation" checkable rather than asserted.
//
// Every consumer — the capture beat, the ledger identity comparison, and the
// expected substitute set count — reads THIS observation. The phase-window
// inference is deleted; there is one authority and no reconciliation between two.
//
// FAIL-CLOSED. `assertObservationComplete` refuses an observation that is missing
// identity or prescription evidence, and refuses one whose plan state shows the
// mutation had already happened. A missing observation is a failure, never a
// licence to fall back on prose or on the durable rows.

const STAGED_PROPOSALS_KEY = '__atlasStagedProposals';

// The in-page installer, serialized by `page.addInitScript`. It runs before any
// application script on every navigation, so the listener is in place for the very
// first staged proposal. It takes NO timestamp and makes NO decision — it records.
function stagedProposalObserverScript(key) {
  const store = [];
  try {
    Object.defineProperty(window, key, { value: store, writable: false, configurable: false });
  } catch (_) {
    window[key] = store;
  }
  const nameOf = (e) => (e && (e.canonicalName || e.name)) || '';
  const numOrNull = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  document.addEventListener('atlas:replacement-proposed', (ev) => {
    const p = (ev && ev.detail && ev.detail.proposal) || null;
    const plan = (typeof window.getActivePlannedSession === 'function')
      ? window.getActivePlannedSession() : null;
    const exercises = (plan && Array.isArray(plan.exercises)) ? plan.exercises : [];
    const src = (p && p.source) || {};
    const rep = (p && p.replacement) || {};
    // The slot THE PROPOSAL resolved, not one this observer re-matched by name.
    const position = (p && Number.isInteger(p.position)) ? p.position : -1;
    const slot = (position >= 0 && position < exercises.length) ? exercises[position] : null;
    store.push(Object.freeze({
      seq: store.length + 1,
      proposal_id: (p && p.proposal_id) || '',
      status: (p && p.status) || '',
      plan_fingerprint: (p && p.plan_fingerprint) || '',
      position,
      source_name: src.name || '',
      source_lift_code: src.lift_code || '',
      source_plan_item_id: (slot && slot.plan_item_id) || '',
      // The name actually sitting in the resolved slot. It must still be the source
      // — that is the in-record proof this was captured before the mutation.
      source_slot_name: nameOf(slot),
      // The slot's IMMUTABLE accepted set count (stamped at acceptance). The ledger
      // revision grain is bounded by it, so it is recorded alongside the engine's
      // own prescribed count rather than being confused with it.
      source_accepted_set_count: (slot && slot.accepted_set_count != null)
        ? numOrNull(Number(slot.accepted_set_count)) : null,
      replacement_name: rep.name || '',
      replacement_lift_code: rep.lift_code || '',
      weight: numOrNull(rep.weight),
      reps: numOrNull(rep.reps),
      rir: numOrNull(rep.rir),
      // The ENGINE's prescribed set count for the substitute. It is genuinely
      // optional (a proposal can carry no set count), so it is recorded as an
      // explicit null rather than silently defaulted here.
      sets: numOrNull(rep.sets),
      load_state: rep.load_state || '',
      plan_names_at_staging: exercises.map(nameOf),
      plan_index_at_staging: (plan && Number.isInteger(plan.index)) ? plan.index : -1,
    }));
  }, true);
}

// Read every observation this page recorded. Returns [] when the observer is absent
// — a caller must treat that as missing evidence, never as "nothing was staged".
async function readStagedProposals(page, key = STAGED_PROPOSALS_KEY) {
  return page.evaluate(k => (Array.isArray(window[k]) ? window[k].slice() : []), key);
}

// The newest observation, or null.
function latestStagedObservation(observations) {
  const list = Array.isArray(observations) ? observations.filter(Boolean) : [];
  return list.length ? list[list.length - 1] : null;
}

const nameKey = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');

// PURE, fail-closed: is this observation complete enough to be an authority?
// Returns { ok, problems }. `sets` is deliberately NOT required — the product
// contract allows a proposal without a prescribed set count — but it must be either
// a positive integer or an explicit null, so "absent" can never read as "2".
function assertObservationComplete(observation) {
  const problems = [];
  const o = (observation && typeof observation === 'object' && !Array.isArray(observation))
    ? observation : null;
  if (!o) return { ok: false, problems: ['no staged-proposal observation was captured at the moment the proposal was staged'] };

  const str = (v) => String(v == null ? '' : v).trim();
  if (!str(o.proposal_id)) problems.push('the observation carries no proposal id');
  if (!str(o.replacement_name)) problems.push('the observation carries no replacement name');
  if (!str(o.replacement_lift_code)) problems.push('the observation carries no replacement lift code');
  if (!str(o.source_name)) problems.push('the observation carries no source lift name');
  if (!str(o.source_plan_item_id)) problems.push('the observation carries no source plan_item_id from the live plan');
  if (typeof o.weight !== 'number') problems.push('the observation carries no prescribed weight');
  if (typeof o.reps !== 'number') problems.push('the observation carries no prescribed reps');
  if (!(o.sets === null || (Number.isInteger(o.sets) && o.sets > 0))) {
    problems.push(`the prescribed set count is neither a positive integer nor an explicit null (got ${JSON.stringify(o.sets)})`);
  }
  if (str(o.replacement_lift_code) && str(o.source_lift_code)
    && str(o.replacement_lift_code).toUpperCase() === str(o.source_lift_code).toUpperCase()) {
    problems.push(`the replacement lift code equals the source lift ${str(o.source_lift_code).toUpperCase()} — that is not a replacement`);
  }

  // Captured BEFORE the mutation: the resolved slot must still hold the source, the
  // plan must still contain the source, and it must not yet contain the replacement.
  const planNames = Array.isArray(o.plan_names_at_staging) ? o.plan_names_at_staging : null;
  if (!planNames) problems.push('the observation records no plan state, so "before the mutation" cannot be checked');
  else {
    const keys = planNames.map(nameKey);
    if (str(o.source_name) && !keys.includes(nameKey(o.source_name))) {
      problems.push(`the source ${o.source_name} was already gone from the plan when the proposal was observed`);
    }
    if (str(o.replacement_name) && keys.includes(nameKey(o.replacement_name))) {
      problems.push(`the replacement ${o.replacement_name} was already in the plan when the proposal was observed`);
    }
  }
  if (str(o.source_slot_name) && str(o.source_name)
    && nameKey(o.source_slot_name) !== nameKey(o.source_name)) {
    problems.push(`the proposal's resolved slot held "${o.source_slot_name}", not the source "${o.source_name}"`);
  } else if (!str(o.source_slot_name)) {
    problems.push('the proposal resolved no live plan slot for its source lift');
  }

  return { ok: problems.length === 0, problems };
}

// The identity `compareReplacementIdentity` compares every durable surface against.
function observationToIdentity(observation) {
  const o = observation && typeof observation === 'object' ? observation : {};
  return {
    replacementLiftCode: o.replacement_lift_code || '',
    sourceLiftCode: o.source_lift_code || '',
    sourcePlanItemId: o.source_plan_item_id || '',
  };
}

// The prescription the substitute slot actually carries, for the expected remaining
// work. `sets` is the ENGINE's own count when it prescribed one; when it did not,
// the slot keeps the source's accepted count (`applySessionSubstitution`), so the
// caller's declared count is the honest fallback — expressed at the one place that
// computes the expectation, never re-derived here from durable rows.
function observationToPrescription(observation) {
  const o = observation && typeof observation === 'object' ? observation : {};
  return {
    name: o.replacement_name || '',
    liftCode: o.replacement_lift_code || '',
    weight: typeof o.weight === 'number' ? o.weight : null,
    reps: typeof o.reps === 'number' ? o.reps : null,
    rir: typeof o.rir === 'number' ? o.rir : null,
    sets: Number.isInteger(o.sets) && o.sets > 0 ? o.sets : null,
  };
}

module.exports = {
  STAGED_PROPOSALS_KEY,
  stagedProposalObserverScript,
  readStagedProposals,
  latestStagedObservation,
  assertObservationComplete,
  observationToIdentity,
  observationToPrescription,
};
