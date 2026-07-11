'use strict';

// ── GATE A eligible-window scorecard (Soul Plan PR-GATEA2) ───────────────────
//
// A PURE, READ-ONLY evaluator of a Brain_Shadow window. It counts an event toward
// the GATE A promotion floor (docs/ONE_BRAIN_PROMOTION_CRITERIA.md §3) ONLY when the
// row is genuine athlete-UI evidence — evidence_class === 'athlete_ui' AND
// evidence_eligible === TRUE — and FAILS CLOSED on everything else: synthetic,
// unknown, old (pre-provenance) rows, and malformed/contradictory eligibility. It
// never infers eligibility from timestamps, routes, volume, IP, or "human-like"
// behavior, and it performs NO I/O and NO writes (the caller supplies the rows).
//
// It does not promote anything. Numeric criteria are reported; the safety criteria
// that a scorecard cannot prove from columns (zero unsafe coaching, representative
// review) are flagged as requiring human review — a green scorecard is necessary,
// never sufficient, for the owner's §8 promotion decision. PR-A5 stays blocked until
// a fresh eligible window meets every criterion AND the owner explicitly promotes.

const { normalizeEvidenceClass, EVIDENCE_CLASSES } = require('./evidenceProvenance');

// The frozen Brain_Shadow column contract (PR-GATEA1, 19 columns).
const BRAIN_SHADOW_HEADER = Object.freeze([
  'captured_at', 'route', 'lift_code', 'mode', 'ok', 'reason', 'decision_type',
  'status', 'confidence_tier', 'skipped_json', 'comparable', 'diverged',
  'weight_delta', 'reps_delta', 'ms', 'app_version',
  'evidence_class', 'evidence_eligible', 'request_origin',
]);
const COL = Object.freeze(BRAIN_SHADOW_HEADER.reduce((m, name, i) => (m[name] = i, m), {}));
const PROVENANCE_COLS = Object.freeze(['evidence_class', 'evidence_eligible', 'request_origin']);

// Floor / tolerance calibration (docs/ONE_BRAIN_PROMOTION_CRITERIA.md §3/§5).
const FLOOR = 50;
const PREFERRED = 100;
const UPPER_BAND = 5;   // ±5 lb upper-body barbell
const LOWER_BAND = 10;  // ±10 lb lower-body barbell
const REP_BAND = 1;     // ±1 rep
const PLANNING_ROUTES = new Set(['/api/plan/today', '/api/plan/intent-recommendation']);
const IN_WORKOUT_ROUTES = new Set(['/api/recommend/next']);
const ENGINE_ERROR_REASONS = new Set(['orchestrator_error', 'assembly_error']);

function _isTrueCell(v) { return String(v == null ? '' : v).trim().toLowerCase() === 'true'; }
// A blank/whitespace cell means "not compared" (null), NOT 0 — the recorder writes
// an empty cell for the uncompared side of a one-sided comparable row and for a
// missing latency (services/brainShadow.js). Number('') is 0, so guard it explicitly
// to keep the scorecard fail-CLOSED (never a spurious 0-delta perfect match).
function _num(v) { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function _str(v) { return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()); }

// A default region resolver — HONEST by design: it returns 'unknown' rather than
// guessing upper/lower from a lift code. Callers may inject a real resolver; where a
// region can't be established, the tolerance for a 5<Δ≤10 lb event is flagged for
// review, never silently PASSed (a Δ≤5 event is inside BOTH bands, so region is moot).
function _defaultRegionOf() { return 'unknown'; }

// Parse one Brain_Shadow row array into a structured record. `has_provenance` is
// false when the row is a pre-GATEA1 (16-col) row or is otherwise missing the
// provenance cells — those can never be eligible.
function parseBrainShadowRow(row) {
  const r = Array.isArray(row) ? row : [];
  const has_provenance = r.length > COL.request_origin && r[COL.evidence_class] != null && r[COL.evidence_eligible] != null;
  return {
    captured_at: _str(r[COL.captured_at]),
    route: _str(r[COL.route]),
    lift_code: _str(r[COL.lift_code]),
    mode: _str(r[COL.mode]),
    ok: _isTrueCell(r[COL.ok]),
    reason: _str(r[COL.reason]),
    decision_type: _str(r[COL.decision_type]),
    status: _str(r[COL.status]),
    confidence_tier: _str(r[COL.confidence_tier]),
    skipped: (() => { try { const a = JSON.parse(r[COL.skipped_json]); return Array.isArray(a) ? a : []; } catch { return []; } })(),
    comparable: _isTrueCell(r[COL.comparable]),
    diverged: _isTrueCell(r[COL.diverged]),
    weight_delta: _num(r[COL.weight_delta]),
    reps_delta: _num(r[COL.reps_delta]),
    ms: _num(r[COL.ms]),
    app_version: _str(r[COL.app_version]),
    has_provenance,
    evidence_class: has_provenance ? normalizeEvidenceClass(r[COL.evidence_class]) : EVIDENCE_CLASSES.UNKNOWN,
    evidence_eligible_cell: has_provenance ? _isTrueCell(r[COL.evidence_eligible]) : false,
  };
}

// Deterministic eligibility verdict + exclusion reason for one parsed row.
function _eligibility(p) {
  if (!p.has_provenance) return { eligible: false, reason: 'missing_provenance' };
  const classSaysUi = p.evidence_class === EVIDENCE_CLASSES.ATHLETE_UI;
  const cellSaysYes = p.evidence_eligible_cell === true;
  if (classSaysUi && cellSaysYes) return { eligible: true, reason: null };
  // class and eligibility cell disagree → contradictory / tampered → fail closed
  if (classSaysUi !== cellSaysYes) return { eligible: false, reason: 'malformed_eligibility' };
  // both agree it is not athlete_ui → excluded by class
  return { eligible: false, reason: p.evidence_class };
}

function _pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

function _latency(msList) {
  const xs = msList.filter(m => typeof m === 'number').sort((a, b) => a - b);
  if (!xs.length) return { count: 0, min: null, max: null, avg: null, p50: null };
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    count: xs.length, min: xs[0], max: xs[xs.length - 1],
    avg: Math.round(sum / xs.length), p50: xs[Math.floor((xs.length - 1) / 2)],
  };
}

// Tolerance verdict for a comparable progression event. Δ≤5 is inside both bands;
// >10 is out; 5<Δ≤10 depends on region (lower ok / upper out / unknown → review).
function _weightTolerance(absW, region) {
  if (absW <= UPPER_BAND) return 'within';
  if (absW > LOWER_BAND) return 'out';
  if (region === 'lower') return 'within';
  if (region === 'upper') return 'out';
  return 'review';
}

// Build the progression sub-scorecard from its eligible rows + the engine-error rows
// observed across the whole eligible window (crashes have no decision_type).
function _progression(rows, engineErrors, regionOf) {
  const events = rows.filter(p => p.decision_type === 'progression');
  const answered = events.filter(p => p.status === 'answered' && p.ok);
  const clarifications = events.filter(p => p.decision_type === 'progression' && (p.status === 'needs_clarification' || p.reason === 'needs_clarification'));
  const okFalse = events.filter(p => !p.ok);
  const comparable = answered.filter(p => p.comparable && (p.weight_delta != null || p.reps_delta != null));

  let within = 0, out = 0, exact = 0, regionReview = 0;
  let maxW = 0, maxR = 0;
  const outList = [];
  const upper = { total: 0, within: 0, max: 0 };
  const lower = { total: 0, within: 0, max: 0 };
  let repWithin = 0, repTotal = 0;
  for (const p of comparable) {
    const absW = p.weight_delta != null ? Math.abs(p.weight_delta) : null;
    const absR = p.reps_delta != null ? Math.abs(p.reps_delta) : null;
    if (absW != null) maxW = Math.max(maxW, absW);
    if (absR != null) maxR = Math.max(maxR, absR);
    const region = _str(regionOf(p.lift_code)) || 'unknown';
    const wv = absW == null ? 'within' : _weightTolerance(absW, region);
    if (region === 'upper' && absW != null) { upper.total++; upper.max = Math.max(upper.max, absW); if (absW <= UPPER_BAND) upper.within++; }
    if (region === 'lower' && absW != null) { lower.total++; lower.max = Math.max(lower.max, absW); if (absW <= LOWER_BAND) lower.within++; }
    if (absR != null) { repTotal++; if (absR <= REP_BAND) repWithin++; }
    const rv = absR == null ? 'within' : (absR <= REP_BAND ? 'within' : 'out');
    if (wv === 'review') { regionReview++; continue; } // ambiguous → neither within nor out
    if (wv === 'out' || rv === 'out') { out++; outList.push({ lift_code: p.lift_code, weight_delta: p.weight_delta, reps_delta: p.reps_delta, at: p.captured_at }); }
    else { within++; if ((p.weight_delta || 0) === 0 && (p.reps_delta || 0) === 0) exact++; }
  }

  const confByTier = {};
  for (const p of events) if (p.confidence_tier) confByTier[p.confidence_tier] = (confByTier[p.confidence_tier] || 0) + 1;
  const okFalseByReason = {};
  for (const p of okFalse) { const k = p.reason || 'unspecified'; okFalseByReason[k] = (okFalseByReason[k] || 0) + 1; }
  const routeDist = {};
  const flow = { planning: 0, in_workout: 0, undeterminable: 0 };
  for (const p of events) {
    if (p.route) routeDist[p.route] = (routeDist[p.route] || 0) + 1;
    if (PLANNING_ROUTES.has(p.route)) flow.planning++;
    else if (IN_WORKOUT_ROUTES.has(p.route)) flow.in_workout++;
    else flow.undeterminable++;
  }
  const skippedDist = {};
  for (const p of events) for (const s of p.skipped) skippedDist[s] = (skippedDist[s] || 0) + 1;

  const orchestratorErrors = engineErrors.filter(p => p.reason === 'orchestrator_error').length;
  const assemblyErrors = engineErrors.filter(p => p.reason === 'assembly_error').length;
  const dates = new Set(events.map(p => (p.captured_at || '').slice(0, 10)).filter(Boolean));
  const lifts = new Set(events.map(p => p.lift_code).filter(Boolean));

  const eligible_events = events.length;
  const floor_met = eligible_events >= FLOOR;
  const preferred_met = eligible_events >= PREFERRED;
  const agreementPct = comparable.length ? _pct(within, comparable.length - regionReview || comparable.length) : null;
  const agreement_ok = comparable.length > 0 && out === 0 && regionReview === 0;

  // Region-aware overall tolerance verdict — never auto-PASS on ambiguity.
  const tolerance_result = out > 0 ? 'FAIL' : (regionReview > 0 ? 'REVIEW' : (comparable.length > 0 ? 'PASS' : 'n/a'));

  const hasEngineError = (orchestratorErrors + assemblyErrors) > 0;
  // The scorecard never emits a promotion PASS for progression: safety (zero unsafe
  // coaching) requires human review. It reports FAIL on an automatic blocker, else
  // EXTEND with the numeric booleans that gate the owner's §8 decision.
  const classification = hasEngineError ? 'FAIL' : 'EXTEND';

  return {
    eligible_events,
    comparable_events: comparable.length,
    ok_count: answered.length,
    ok_false_count: okFalse.length,
    ok_false_by_reason: okFalseByReason,
    orchestrator_error_count: orchestratorErrors,
    assembly_error_count: assemblyErrors,
    clarification_count: clarifications.length,
    within_tolerance_count: within,
    out_of_tolerance_count: out,
    exact_match_count: exact,
    region_undeterminable_count: regionReview,
    max_abs_weight_delta: maxW,
    max_abs_rep_delta: maxR,
    agreement_pct: agreementPct,
    agreement_ok,
    tolerance_result,
    upper_body_tolerance: upper.total ? { within: upper.within, total: upper.total, max_abs_delta: upper.max, result: upper.within === upper.total ? 'PASS' : 'FAIL' } : { result: 'n/a' },
    lower_body_tolerance: lower.total ? { within: lower.within, total: lower.total, max_abs_delta: lower.max, result: lower.within === lower.total ? 'PASS' : 'FAIL' } : { result: 'n/a' },
    rep_tolerance: repTotal ? { within: repWithin, total: repTotal, result: repWithin === repTotal ? 'PASS' : 'FAIL' } : { result: 'n/a' },
    confidence_tier_distribution: confByTier,
    latency: _latency(events.map(p => p.ms)),
    skipped_capability_distribution: skippedDist,
    route_distribution: routeDist,
    flow_distribution: flow,
    distinct_utc_dates: dates.size,
    distinct_lift_codes: lifts.size,
    floor_met,
    preferred_met,
    variety: (dates.size >= 3 && lifts.size >= 3) ? (floor_met ? 'proven' : 'incomplete') : (eligible_events === 0 ? 'unknowable' : 'incomplete'),
    out_of_tolerance: outList,
    classification,
  };
}

// computeScorecard(rows, { header, asOf, regionOf })
function computeScorecard(rows, opts = {}) {
  const header = Array.isArray(opts.header) ? opts.header.map(_str) : BRAIN_SHADOW_HEADER.slice();
  // Fail closed: the active tab MUST carry the provenance columns.
  for (const c of PROVENANCE_COLS) {
    if (!header.map(h => h.toLowerCase()).includes(c)) {
      throw new Error(`GATE A scorecard: missing provenance column "${c}" in the Brain_Shadow header — refusing to score a pre-provenance window.`);
    }
  }
  const regionOf = typeof opts.regionOf === 'function' ? opts.regionOf : _defaultRegionOf;
  const asOf = _str(opts.asOf) || null;

  const parsed = (Array.isArray(rows) ? rows : []).map(parseBrainShadowRow);
  const eligibleRows = [];
  const excluded = { total: 0, by_class: {}, by_reason: {} };
  for (const p of parsed) {
    const v = _eligibility(p);
    if (v.eligible) { eligibleRows.push(p); continue; }
    excluded.total++;
    excluded.by_class[p.evidence_class] = (excluded.by_class[p.evidence_class] || 0) + 1;
    excluded.by_reason[v.reason] = (excluded.by_reason[v.reason] || 0) + 1;
  }

  // Engine crashes (orchestrator/assembly errors) among ELIGIBLE rows are an
  // automatic blocker regardless of decision_type (a crash carries no type).
  const engineErrors = eligibleRows.filter(p => ENGINE_ERROR_REASONS.has(p.reason));

  const progression = _progression(eligibleRows, engineErrors, regionOf);

  // Per-decision-type classification — never averaged across unlike types.
  const by_decision_type = {};
  const types = new Set(eligibleRows.map(p => p.decision_type).filter(Boolean));
  for (const t of types) {
    if (t === 'progression') { by_decision_type[t] = { classification: progression.classification, eligible_events: progression.eligible_events }; continue; }
    if (t === 'workout' || t === 'best_workout') {
      by_decision_type[t] = {
        classification: 'INELIGIBLE',
        reason: 'block-level divergence metric does not exist; workout orchestrations are comparable:false, so agreement cannot be computed (docs/ONE_BRAIN_PROMOTION_CRITERIA.md §6).',
        eligible_events: eligibleRows.filter(p => p.decision_type === t).length,
      };
      continue;
    }
    by_decision_type[t] = { classification: 'EXTEND', reason: 'no promotion criteria defined for this decision type in Brain_Shadow', eligible_events: eligibleRows.filter(p => p.decision_type === t).length };
  }

  // Safety criteria a scorecard cannot prove from numeric columns. Never claim
  // "zero recorded errors ⇒ zero unsafe coaching."
  const safety = {
    zero_orchestrator_errors: { status: engineErrors.length === 0 ? 'automatically_proven' : 'automatically_failed', count: engineErrors.length },
    zero_unsafe_recommendations: { status: 'requires_human_review', note: 'Unsafe means a load/rep a competent coach would refuse (violates an active deload, ignores an injury constraint, implausible jump). This is NOT provable from shadow columns; the absence of a recorded error is not proof. Review the representative sample.' },
    ok_false_explainable: { status: progression.ok_false_count === 0 ? 'automatically_proven' : 'requires_human_review', count: progression.ok_false_count },
    trust_loop_intact: { status: 'unavailable', note: 'Not observable from Brain_Shadow; verified by the preview→approve→write test suite + LT cards, not this scorecard.' },
    workout_responsiveness: { status: 'unavailable', note: 'Latency summary is reported, but felt in-workout responsiveness is a human judgment.' },
  };

  const representative_review = {
    note: 'Hand-review these before any promotion — numeric bars do not substitute for representative judgment.',
    largest_weight_divergences: [...progression.out_of_tolerance].sort((a, b) => Math.abs(b.weight_delta || 0) - Math.abs(a.weight_delta || 0)).slice(0, 10),
    all_out_of_tolerance: progression.out_of_tolerance,
    engine_errors: engineErrors.map(p => ({ reason: p.reason, route: p.route, at: p.captured_at })),
    ok_false_examples: eligibleRows.filter(p => !p.ok && p.decision_type === 'progression').slice(0, 10).map(p => ({ reason: p.reason, lift_code: p.lift_code, at: p.captured_at })),
    region_undeterminable: progression.region_undeterminable_count,
  };

  return {
    generated_as_of: asOf,
    window: {
      total_rows: parsed.length,
      first_captured_at: eligibleRows.length ? eligibleRows.map(p => p.captured_at).filter(Boolean).sort()[0] : null,
      last_captured_at: eligibleRows.length ? eligibleRows.map(p => p.captured_at).filter(Boolean).sort().slice(-1)[0] : null,
    },
    eligible: { total: eligibleRows.length },
    excluded,
    progression,
    by_decision_type,
    intent_routing: { classification: 'SEPARATE', note: 'Intent routing is a separate promotion evaluated from Intent_Shadow, not from Brain_Shadow (docs/ONE_BRAIN_PROMOTION_CRITERIA.md §4). Not scored here.' },
    safety,
    representative_review,
    promotion_note: 'This scorecard is necessary but NOT sufficient for promotion. PR-A5 stays blocked until a fresh eligible window meets every numeric criterion, the representative + safety review passes, and the owner makes the explicit §8 promotion decision.',
  };
}

// Concise human-readable Markdown. Emits only bounded tokens/numbers — no raw
// request bodies, URLs, headers, or secrets.
function renderMarkdown(sc) {
  const p = sc.progression;
  const L = [];
  L.push('# GATE A — eligible-window scorecard (read-only)');
  L.push('');
  L.push(`_As of ${sc.generated_as_of || 'n/a'} · window ${sc.window.first_captured_at || '—'} → ${sc.window.last_captured_at || '—'} · ${sc.window.total_rows} rows read_`);
  L.push('');
  L.push(`**Eligible (athlete_ui) events: ${sc.eligible.total}** · excluded ${sc.excluded.total} (` +
    Object.entries(sc.excluded.by_reason).map(([k, v]) => `${k}: ${v}`).join(', ') + ')');
  L.push('');
  L.push('## Progression');
  L.push(`- Eligible events: **${p.eligible_events}** — floor (≥${FLOOR}) ${p.floor_met ? '✅ met' : '❌ not met'}; preferred (≥${PREFERRED}) ${p.preferred_met ? '✅' : '—'}`);
  L.push(`- Variety: **${p.variety}** (${p.distinct_utc_dates} UTC dates, ${p.distinct_lift_codes} lifts)`);
  L.push(`- Comparable: ${p.comparable_events} · within-tolerance ${p.within_tolerance_count} · out ${p.out_of_tolerance_count} · exact ${p.exact_match_count} · region-undeterminable ${p.region_undeterminable_count}`);
  L.push(`- Max |Δweight| ${p.max_abs_weight_delta} · max |Δrep| ${p.max_abs_rep_delta} · agreement ${p.agreement_pct == null ? 'n/a' : p.agreement_pct + '%'}`);
  L.push(`- Tolerance: overall **${p.tolerance_result}** · upper ${p.upper_body_tolerance.result} · lower ${p.lower_body_tolerance.result} · rep ${p.rep_tolerance.result}`);
  L.push(`- Engine: ok ${p.ok_count} · ok:false ${p.ok_false_count} · orchestrator_error ${p.orchestrator_error_count} · assembly_error ${p.assembly_error_count} · clarification ${p.clarification_count}`);
  L.push(`- Latency ms: min ${p.latency.min} · p50 ${p.latency.p50} · max ${p.latency.max} · avg ${p.latency.avg}`);
  L.push(`- **Classification: ${p.classification}**`);
  L.push('');
  L.push('## Other decision types');
  for (const [t, d] of Object.entries(sc.by_decision_type)) if (t !== 'progression') L.push(`- ${t}: **${d.classification}** — ${d.reason || ''}`);
  L.push(`- intent_routing: **${sc.intent_routing.classification}** — separate lane (Intent_Shadow)`);
  L.push('');
  L.push('## Safety (requires review — numeric columns cannot prove these)');
  for (const [k, v] of Object.entries(sc.safety)) L.push(`- ${k}: **${v.status}**${v.count != null ? ` (${v.count})` : ''}`);
  L.push('');
  L.push(`> ${sc.promotion_note}`);
  return L.join('\n');
}

module.exports = {
  BRAIN_SHADOW_HEADER,
  COL,
  FLOOR,
  PREFERRED,
  parseBrainShadowRow,
  computeScorecard,
  renderMarkdown,
};
