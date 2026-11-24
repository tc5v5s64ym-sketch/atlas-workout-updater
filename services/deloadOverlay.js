'use strict';

// Deload overlay for the /api/recommend/next prescription — ONE choke point
// for number AND prose (#1773, Astra C-04).
//
// The route used to apply the deload cut to next_target.weight / target_rir
// only, leaving `recommendation` / `reasoning` prose built from the
// pre-overlay decision — so the card showed a 170 lb RIR 5 target beside
// "Repeat 185 × 8 to reconfirm this lift." Prescription text must render
// only after all overlays, from the final decision: this module applies the
// whole overlay (numbers + prose) or nothing, and never invents a number —
// every figure comes from computePrescription or the recommendation itself.
//
// Pure: no I/O, no LLM, no Sheets, no write. The route calls
// applyDeloadOverlay and keeps its existing in-place style; the decision
// (what the overlay is) lives here so unit tests can pin it without booting
// the server.

const { computePrescription } = require('./deloadProtocols');

function _sentence(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return null;
  return s.endsWith('.') ? s : `${s}.`;
}

// Deterministic deload prescription prose, rendered ONLY from the final
// decision (protocol + final weight/reps/RIR). No pre-overlay number can
// reach it: callers pass the prescription's own figures. The layoff fact
// (daysSinceLastSession) is preserved when present — it is still true under
// a deload — but it is never allowed to carry the stale load into the text.
function deloadOverlayText(protocol, { weight, reps, targetRir, daysSinceLastSession } = {}) {
  const w = Number(weight);
  const rir = Number(targetRir);
  const r = Number(reps);
  const recommendation = Number.isFinite(r)
    ? `Deload — ${w} × ${r} at RIR ${rir}.`
    : `Deload — ${w} at RIR ${rir}.`;
  const purpose = protocol ? _sentence(protocol.purpose) : null;
  const exit = protocol ? _sentence(protocol.exit) : null;
  let reasoning = 'Active deload — ';
  if (purpose) reasoning += `${purpose} `;
  reasoning += `Load cut to ${w} lb at RIR ${rir}.`;
  if (exit) reasoning += ` ${exit}`;
  const days = (daysSinceLastSession === null || daysSinceLastSession === undefined)
    ? null
    : Number(daysSinceLastSession);
  // null/undefined means "no history" (the no-history just-logged path) — never
  // render a layoff clause from it: Number(null) is 0, which would invent
  // "Last trained 0 days ago" for a lifter with no logged sessions (#1773 V7).
  if (days !== null && Number.isFinite(days)) {
    reasoning += days === 0 ? ' Last trained today.' : ` Last trained ${days} days ago.`;
  }
  return { recommendation, reasoning };
}

// Apply the active-deload overlay to a recommendNextSet result IN PLACE
// (matching the route's existing imperative style). Returns true when the
// overlay applied, false when it did not — in which case the recommendation
// is left byte-identical: no deload, no protocol, no next_target, no usable
// working weight (bodyweight / missing load), or a prescription failure all
// mean "no overlay", never a partial one. A deload RIR is never surfaced
// without its deload weight.
function applyDeloadOverlay(recommendation, deload) {
  if (!recommendation || typeof recommendation !== 'object') return false;
  if (!deload || typeof deload !== 'object' || deload.in_deload !== true) return false;
  const protocol = deload.protocol;
  if (!protocol || typeof protocol !== 'object') return false;
  const nt = recommendation.next_target;
  if (!nt || typeof nt !== 'object') return false;
  let prescription = null;
  try {
    prescription = computePrescription(protocol, { working_weight: nt.weight });
  } catch { return false; }
  if (!prescription || typeof prescription.weight !== 'number' || typeof prescription.target_rir !== 'number') {
    return false;
  }
  nt.weight = prescription.weight;
  recommendation.target_rir = prescription.target_rir;
  const text = deloadOverlayText(protocol, {
    weight: prescription.weight,
    reps: nt.reps,
    targetRir: prescription.target_rir,
    daysSinceLastSession: recommendation.days_since_last_session,
  });
  recommendation.recommendation = text.recommendation;
  recommendation.reasoning = text.reasoning;
  return true;
}

module.exports = { applyDeloadOverlay, deloadOverlayText };
