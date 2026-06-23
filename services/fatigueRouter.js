'use strict';

// Live Fatigue Router — cross-pattern / cross-modality (Taxonomy §6, SPE §7; PR 483).
//
// Generalizes PR 477's pressing-specific reroute to ANY pattern and modality:
// given the fatigue just logged and the planned next move, decide whether to keep
// it, reduce/delay/optional it, promote a rested antagonist, block a PR attempt,
// or reduce cardio intensity / circuit density. Deterministic + explainable; the
// form-breakdown signal must come from an OBJECTIVE logged flag, never inferred
// from rep counts (consistent with the existing form-signal guardrail).
//
// PURE / read-only: no I/O, no LLM, no Sheets, NO write path, NO Log_Cleaned schema
// change, and NOT wired into the live session/coach path. Takes already-classified
// inputs (pattern / muscles / modalityCategory / fatigue_signal) so it stays
// decoupled — the wiring layer computes those via patternFor / musclesFor /
// exerciseModality and threads the governor's fatigue_signal. Routing is a
// SUGGESTION only; it never auto-reorders or writes.

// Routing actions (the full vocabulary the router can emit).
const ROUTE_ACTIONS = Object.freeze([
  'keep',                 // proceed as planned
  'reduce',               // same-muscle fatigue → fewer sets / lower load on the next item
  'make_optional',        // same-muscle fatigue, no rested alternative → mark the next item optional
  'promote_alternative',  // move a rested / antagonist movement up instead
  'block_pr',             // accumulated failure → suppress a PR attempt until recovery shows
  'reduce_intensity',     // cardio after hard legs → lower zone / duration
  'reduce_density',       // circuit form/fatigue breakdown → cut rounds / density
]);

function asArray(v) { return Array.isArray(v) ? v : []; }
function lc(v) { return String(v == null ? '' : v).toLowerCase(); }

// Does the next move tax the SAME muscle/pattern that was just fatigued?
function sharesLoad(justLogged, nextMove) {
  const jm = new Set(asArray(justLogged.muscles).map(lc).filter(Boolean));
  const nm = asArray(nextMove.muscles).map(lc).filter(Boolean);
  if (nm.some((m) => jm.has(m))) return true;
  const jp = lc(justLogged.pattern);
  const np = lc(nextMove.pattern);
  return !!jp && jp === np;
}

function result(action, reason, extra) {
  return Object.assign({ action, reason }, extra || {});
}

/**
 * Decide how to route the next planned move given the fatigue just logged.
 *
 * @param {object} input
 * @param {object} input.justLogged  { pattern, muscles[], fatigue_signal('none'|'elevated'|'high'), repeated_rir0 }
 * @param {object} input.nextMove    { pattern, muscles[], modalityCategory, is_pr_attempt }
 * @param {object|null} [input.restedAlternative]  { pattern, muscles[], available } — an antagonist/rested option
 * @param {boolean} [input.heavy_lower_block_done]  a heavy lower-body block preceded a cardio piece
 * @param {boolean} [input.form_breakdown]          OBJECTIVE logged round-quality breakdown (circuits)
 * @returns {{action:string, reason:string, target?:string}}
 */
function routeNextMove(input = {}) {
  const justLogged = input.justLogged && typeof input.justLogged === 'object' ? input.justLogged : {};
  const nextMove = input.nextMove && typeof input.nextMove === 'object' ? input.nextMove : {};
  const fatigue = lc(justLogged.fatigue_signal) || 'none';
  const modality = lc(nextMove.modalityCategory);
  const same = sharesLoad(justLogged, nextMove);

  // 1. Block a PR attempt after accumulated failure on the same load (highest
  //    priority — never green-light a max attempt into a fatigued pattern).
  if (nextMove.is_pr_attempt && justLogged.repeated_rir0 && same) {
    return result('block_pr', 'Repeated RIR 0 on this lift — suppress the PR attempt until recovery shows.', { target: nextMove.pattern || null });
  }

  // 2. Cross-modality carryover.
  //    Cardio after a heavy lower-body block → reduce zone/duration.
  if (modality === 'cardio' && input.heavy_lower_block_done) {
    return result('reduce_intensity', 'Heavy lower-body work just done — keep the following cardio easy (Zone 2, reduced duration).', { target: nextMove.pattern || 'cardio' });
  }
  //    Circuit with objective form/round-quality breakdown → cut density.
  if (modality === 'circuit' && input.form_breakdown) {
    return result('reduce_density', 'Round quality broke down — cut rounds / lower density rather than push through.', { target: nextMove.pattern || 'circuit' });
  }

  // 3. Same-muscle / same-pattern fatigue carryover.
  if (same && (fatigue === 'high' || fatigue === 'elevated')) {
    const alt = input.restedAlternative;
    if (fatigue === 'high' && alt && alt.available) {
      return result('promote_alternative', 'Just-fatigued pattern is up next — promote a rested / antagonist movement instead.', { target: alt.pattern || null });
    }
    if (fatigue === 'high') {
      return result('make_optional', 'High fatigue on the muscle that is up next, no rested alternative — make the next item optional.', { target: nextMove.pattern || null });
    }
    return result('reduce', 'Elevated fatigue on the muscle that is up next — reduce sets / load on it.', { target: nextMove.pattern || null });
  }

  // 4. Nothing to adjust.
  return result('keep', 'No fatigue conflict with the next move — proceed as planned.', { target: nextMove.pattern || null });
}

module.exports = { routeNextMove, ROUTE_ACTIONS };
