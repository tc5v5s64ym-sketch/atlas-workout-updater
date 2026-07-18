'use strict';

// ── F10D — the single-confirmation closeout summary (pure assembly, no I/O) ─────
//
// Composes the ONE owner confirmation (owner directive, 2026-07-18) from the two
// truths that are never merged (design §0):
//
//   1. the RECOMMENDATION ledger — Session_Plan_Sets rows: the original accepted
//      plan (v1) and every explicit revision, read through the chain-validating
//      selectors (services/sessionPlanLedger.js) which fail closed on malformed
//      history;
//   2. the ACTUALS — the staged performed sets and the EXACT Log_Cleaned/Effort
//      rows the approved write will append (echoed verbatim, never recomputed).
//
// Rules enforced structurally here:
//   - a performed value NEVER appears as a target (unplanned actual sets carry no
//     target fields at all — there is nothing to conflate);
//   - each actual set is compared only to the recommendation EFFECTIVE for that
//     set (a revision after set 1 cannot change set 1's target);
//   - no_reliable_target is presented honestly (target null), never invented;
//   - malformed ledger history is SURFACED (item.malformed + diagnostics_sets and
//     the summary-level `malformed` flag) with no silently-selected target — the
//     seal refuses separately; the confirmation must show the owner why;
//   - substituted items join their actuals through performed_lift_code, so the
//     substitute's execution satisfies the ORIGINAL item and the planned lift is
//     never overwritten;
//   - target-vs-actual carries numeric deltas only — assessment WORDING is F10E.

const {
  parseRow,
  effectivePlan,
} = require('./sessionPlanLedger');

function _str(v) { return v == null ? '' : String(v).trim(); }
function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _lc(v) { return _str(v).toLowerCase(); }

// buildCloseoutSummary({ session, ledgerRows, items, actualRows, logRowsPreview,
//                        effortRowPreview, sealPreview })
//   session         — { session_id, session_date }
//   ledgerRows      — raw Session_Plan_Sets rows (header stripped)
//   items           — the client closeout context: [{ plan_item_id,
//                     planned_lift_code, performed_lift_code?, name?, outcome? }]
//   actualRows      — the staged performed sets, in performed order:
//                     [{ lift_code, canonical_exercise|exercise, set_number,
//                        weight, reps, rir }]
//   logRowsPreview  — the EXACT Log_Cleaned rows the write will append (echoed)
//   effortRowPreview— the EXACT Effort row (or null)
//   sealPreview     — { would_seal, already_sealed } from the seal dry-run (optional)
function buildCloseoutSummary(input) {
  const {
    session = {}, ledgerRows = [], items = [], actualRows = [],
    logRowsPreview = [], effortRowPreview = null, sealPreview = null,
  } = input && typeof input === 'object' ? input : {};

  const session_id = _str(session.session_id);
  const session_date = _str(session.session_date);

  // Parse the session's ledger rows once. Structurally-unparseable rows count as
  // malformed history (surfaced; the per-set selectors fail closed regardless).
  const sessionLedger = (Array.isArray(ledgerRows) ? ledgerRows : []).filter(row => {
    const p = parseRow(row);
    return p.rec ? (p.rec.session_id === session_id || !session_id) : true;
  });
  const parsed = sessionLedger.map(parseRow);
  const unparseable = parsed.some(p => p.malformed);
  const recs = parsed.filter(p => !p.malformed).map(p => p.rec);

  // The item universe: the client's accepted-item context UNION ledger-only items
  // (implicit_unplanned recommendations have no accepted-spine entry).
  const clientItems = (Array.isArray(items) ? items : [])
    .map(it => (it && typeof it === 'object' ? it : {}))
    .filter(it => _str(it.plan_item_id));
  const byId = new Map(clientItems.map(it => [_str(it.plan_item_id), { ...it }]));
  for (const r of recs) {
    if (!byId.has(r.plan_item_id)) {
      byId.set(r.plan_item_id, { plan_item_id: r.plan_item_id, planned_lift_code: r.planned_lift_code });
    }
  }

  // Actual sets in performed order; each may be claimed by exactly one item.
  const actuals = (Array.isArray(actualRows) ? actualRows : [])
    .map(a => (a && typeof a === 'object' ? a : {}))
    .map(a => ({
      lift_code: _str(a.lift_code),
      name: _str(a.canonical_exercise) || _str(a.exercise),
      set_number: _num(a.set_number),
      weight: _num(a.weight),
      reps: _num(a.reps),
      rir: _num(a.rir),
      claimed: false,
    }));

  const summaryItems = [];
  const noReliableIds = [];
  let anyMalformed = unparseable;

  for (const [plan_item_id, it] of byId) {
    const itemRecs = recs.filter(r => r.plan_item_id === plan_item_id);
    const v1 = itemRecs.filter(r => r.version === 1).sort((a, b) => a.setIndex - b.setIndex);
    const source = v1.length ? v1[0].recommendation_source : null;

    const original_sets = v1.map(r => ({
      set_index: r.setIndex,
      target_weight: r.confidence === 'reliable' ? _num(r.target_weight) : null,
      target_reps: r.confidence === 'reliable' ? _num(r.target_reps) : null,
      target_rir: r.confidence === 'reliable' ? _num(r.target_rir) : null,
      no_reliable_target: r.confidence !== 'reliable',
    }));

    // The final effective plan through the chain-validating selector — each set
    // fails closed independently on malformed history.
    const eff = itemRecs.length ? effectivePlan(sessionLedger, plan_item_id) : [];
    const diagnostics_sets = [];
    const effective_sets = eff.map(e => {
      if (e.confidence === 'no_reliable_target' && e.reason === 'malformed_chain') {
        diagnostics_sets.push({ set_index: e.set_index, diagnostics: e.diagnostics });
        return { set_index: e.set_index, target_weight: null, target_reps: null, target_rir: null, plan_version: null, source: null, malformed: true };
      }
      if (e.confidence === 'no_reliable_target') {
        return { set_index: e.set_index, target_weight: null, target_reps: null, target_rir: null, plan_version: e.plan_version || null, source: e.recommendation_source || null, no_reliable_target: true };
      }
      return {
        set_index: e.set_index, target_weight: e.target_weight, target_reps: e.target_reps,
        target_rir: e.target_rir, plan_version: e.plan_version, source: e.recommendation_source,
      };
    });
    const malformed = diagnostics_sets.length > 0;
    if (malformed) anyMalformed = true;
    const revised = effective_sets.some(e => (e.plan_version || 1) > 1);
    const no_reliable_target = effective_sets.some(e => e.no_reliable_target === true);
    if (no_reliable_target) noReliableIds.push(plan_item_id);

    // Claim this item's actuals: the performed lift is the substitute when one was
    // recorded, else the planned lift. Ordinal pairing — the k-th performed set of
    // that lift answers the k-th effective target set.
    const matchCode = _lc(it.performed_lift_code) || _lc(it.planned_lift_code);
    const itemActuals = actuals.filter(a => !a.claimed && matchCode && _lc(a.lift_code) === matchCode);
    for (const a of itemActuals) a.claimed = true;

    const target_vs_actual = [];
    const setCount = Math.max(effective_sets.length, itemActuals.length);
    for (let k = 0; k < setCount; k += 1) {
      const eSet = effective_sets[k] || null;
      const a = itemActuals[k] || null;
      const entry = {
        set_index: eSet ? eSet.set_index : null,
        target_weight: eSet ? (eSet.target_weight != null ? eSet.target_weight : null) : null,
        target_reps: eSet ? (eSet.target_reps != null ? eSet.target_reps : null) : null,
        target_rir: eSet ? (eSet.target_rir != null ? eSet.target_rir : null) : null,
        actual_weight: a ? a.weight : null,
        actual_reps: a ? a.reps : null,
        actual_rir: a ? a.rir : null,
      };
      if (eSet && eSet.no_reliable_target) entry.no_reliable_target = true;
      if (eSet && eSet.malformed) entry.malformed = true;
      if (!eSet && a) entry.extra = true;
      if (eSet && !a) entry.unperformed = true;
      if (entry.target_weight != null && entry.actual_weight != null) entry.weight_delta = entry.actual_weight - entry.target_weight;
      if (entry.target_reps != null && entry.actual_reps != null) entry.reps_delta = entry.actual_reps - entry.target_reps;
      if (entry.target_rir != null && entry.actual_rir != null) entry.rir_delta = entry.actual_rir - entry.target_rir;
      target_vs_actual.push(entry);
    }

    summaryItems.push({
      plan_item_id,
      planned_lift_code: _str(it.planned_lift_code) || (v1.length ? v1[0].planned_lift_code : ''),
      performed_lift_code: _str(it.performed_lift_code) || null,
      name: _str(it.name) || null,
      outcome: _str(it.outcome) || null,
      source,
      revised,
      no_reliable_target,
      malformed,
      diagnostics_sets,
      original_sets,
      effective_sets,
      target_vs_actual,
    });
  }

  // Whatever no item claimed is honestly UNPLANNED — actual truth with NO target
  // fields at all (nothing exists to conflate with a plan).
  const unplannedByCode = new Map();
  for (const a of actuals) {
    if (a.claimed) continue;
    const key = _lc(a.lift_code) || _lc(a.name);
    if (!unplannedByCode.has(key)) unplannedByCode.set(key, { lift_code: a.lift_code, name: a.name, sets: [] });
    unplannedByCode.get(key).sets.push({ set_number: a.set_number, weight: a.weight, reps: a.reps, rir: a.rir });
  }

  return {
    session_id,
    session_date,
    has_stored_plan: recs.length > 0,
    malformed: anyMalformed,
    items: summaryItems,
    unplanned: [...unplannedByCode.values()],
    no_reliable_target_items: noReliableIds,
    rows_to_write: {
      log: Array.isArray(logRowsPreview) ? logRowsPreview : [],
      effort: effortRowPreview == null ? null : effortRowPreview,
    },
    rows_to_seal: {
      count: sealPreview && sealPreview.would_seal != null ? Number(sealPreview.would_seal) : 0,
      already_sealed: sealPreview && sealPreview.already_sealed != null ? Number(sealPreview.already_sealed) : 0,
    },
  };
}

// Bound + sanitize the CLIENT-supplied closeout context items before they reach
// the summary (the same discipline as planStateFromContext): cap the list, keep
// only the known fields, trim + cap every string. The seal itself never depends
// on these — they only label the confirmation.
const MAX_CONTEXT_ITEMS = 50;
const MAX_FIELD_LEN = 200;
function _cap(v) { return _str(v).slice(0, MAX_FIELD_LEN); }
function boundCloseoutContextItems(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, MAX_CONTEXT_ITEMS)
    .map(it => (it && typeof it === 'object' ? it : {}))
    .map(it => ({
      plan_item_id: _cap(it.plan_item_id),
      planned_lift_code: _cap(it.planned_lift_code),
      performed_lift_code: _cap(it.performed_lift_code) || undefined,
      name: _cap(it.name) || undefined,
      outcome: _cap(it.outcome) || undefined,
    }))
    .filter(it => it.plan_item_id);
}

module.exports = { buildCloseoutSummary, boundCloseoutContextItems };
