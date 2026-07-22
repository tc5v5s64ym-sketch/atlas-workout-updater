'use strict';

// Coach-turn divergence report — Phase 3 ("shadow the packet and the trace", H-03/H-14).
//
// The nightly report that reads the Phase-3 shadow's structured log records and lists
// every place PRODUCTION contradicted or bypassed packet truth. It is the Phase-4 TODO:
// "make the live coach route consume the CoachTurnPacket, retiring route-local
// recomputation as the divergence list clears."
//
// Input is the `[coach-turn-shadow]` log lines (services/coachTurnPacketShadow.js) that
// the deployment emits — collected from the log stream over a week of real training and
// piped into scripts/atlas-divergence.js. Each self-contained record carries the packet
// summary, a bounded visible summary, and the concern-2 trace summary.
//
// Pure / deterministic — no I/O, no clock, no randomness. The CLI wrapper does the I/O.
//
// A "divergence" here is a place production did NOT flow through the canonical packet:
//   • embedded bypass  — the packet's embedded fact is null/empty, so production computed
//                        that fact route-locally instead of from the packet (H-03/H-08/
//                        H-11/H-12). This is expected in Phase 3 and clears in Phase 4/5.
//   • stage bypass     — the turn skipped a canonical spine stage that is NOT structurally
//                        absent on the read-only coach route (parser/write_proof are; a
//                        missing knowledge_retrieval is a genuine gap — H-06/Phase 6).
//   • invalid packet   — the assembled packet did not satisfy its own contract (a real
//                        defect to investigate, never hidden).
//   • visible↔packet   — the visible reply carried coaching prose while the packet's
//                        decision was null: the reply bypassed packet truth (the H-03
//                        headline the report exists to quantify).
//   • discussion ref.  — the route picked a disputed-lift referent (which lift a bare
//                        correction resolves to) that the packet does not carry: the
//                        referent is computed route-locally (services/coachDiscussionReferent
//                        + resolver tiers 2–3). Phase 4 makes discussion_referent a packet /
//                        WorkoutSession field, and a packet referent that DIFFERS from the
//                        route pick then becomes a mismatch to investigate.
//
// Public API:
//   parseShadowLines(text)     → record[]           (tolerant; skips non-matching lines)
//   analyzeDivergences(records)→ analysis object
//   formatReport(analysis,opts)→ string             (human-readable)
//   SHADOW_MARKER, CORE_STAGES, EXPECTED_ABSENT_STAGES

const SHADOW_MARKER = '[coach-turn-shadow]';

// The canonical spine stages a real coach turn threads through (concern 2).
const CORE_STAGES = ['intent', 'session_snapshot', 'engine_decision', 'coaching_strategy', 'model_response', 'validator_result', 'rendered_output'];

// Stages the read-only coach route legitimately never runs — their absence is structural,
// not a Phase-4 gap: parser (the client parses), write_proof (this route never writes).
const EXPECTED_ABSENT_STAGES = ['parser', 'write_proof'];

// Embedded facts whose null/empty value means production computed the fact route-locally
// rather than from the packet. `closeout` is excluded — this route is never a closeout turn.
const EMBEDDED_BYPASS = [
  { key: 'decision', label: 'decision', absent: (e) => e.decision === false, finding: 'H-03 — the coaching decision is computed route-locally; Phase 4 canonicalizes it' },
  { key: 'session', label: 'session', absent: (e) => e.session === false, finding: 'H-08 — session truth is not in the packet; Phase 4 consumes the client WorkoutSession' },
  { key: 'safety', label: 'safety', absent: (e) => e.safety === false, finding: 'H-12 — the safety verdict is route-local; Phase 5d wires one SafetyDecision' },
  { key: 'exercises', label: 'exercises', absent: (e) => (e.exercises || 0) === 0, finding: 'H-11 — no canonical ExerciseIdentity; Phase 5b builds the registry' },
  { key: 'athlete_profile_goal', label: 'athlete.profile_goal', absent: (e) => e.athlete_profile_goal === false, finding: 'the AthleteContext training goal was unset for the turn' },
];

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

// Parse a log stream into shadow records. Robust to a leading log timestamp/prefix before
// the marker and to interleaved unrelated lines. A malformed record is skipped, not fatal.
function parseShadowLines(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const at = rawLine.indexOf(SHADOW_MARKER);
    if (at === -1) continue;
    const json = rawLine.slice(at + SHADOW_MARKER.length).trim();
    if (!json) continue;
    try {
      const rec = JSON.parse(json);
      if (_isPlainObject(rec)) out.push(rec);
    } catch (_) { /* skip a malformed record — never fatal */ }
  }
  return out;
}

function _pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; }

// Analyze the records into an aggregate divergence report.
function analyzeDivergences(records) {
  const recs = Array.isArray(records) ? records.filter(_isPlainObject) : [];
  const total = recs.length;

  let packetsValid = 0;
  const invalidExamples = [];
  const embeddedBypass = {};
  for (const f of EMBEDDED_BYPASS) embeddedBypass[f.key] = 0;
  const stageBypass = {};       // genuine (non-structural) missing stages
  let tracesPresent = 0;
  let tracesInvalid = 0;
  let fullSpineTurns = 0;
  const spineGap = {};          // core stages missing from the trace
  let visibleNullDecision = 0;  // reply carried coaching prose while decision was null
  let visibleErrors = 0;
  let withEmbedded = 0;
  let withReferent = 0;         // turns where the route picked a discussion referent
  let referentRouteLocal = 0;   // route picked a referent the packet does not carry (Phase-4 TODO)
  let referentMismatch = 0;     // packet carries a referent that DIFFERS from the route's pick

  for (const r of recs) {
    if (r.packet_valid === true) packetsValid += 1;
    else if (invalidExamples.length < 10) invalidExamples.push({ turn_id: r.turn_id || null, errors: Array.isArray(r.packet_errors) ? r.packet_errors : [] });

    const e = _isPlainObject(r.embedded) ? r.embedded : null;
    if (e) {
      withEmbedded += 1;
      for (const f of EMBEDDED_BYPASS) if (f.absent(e)) embeddedBypass[f.key] += 1;
    }

    const t = _isPlainObject(r.trace) ? r.trace : null;
    if (t) {
      tracesPresent += 1;
      if (t.valid === false) tracesInvalid += 1;
      const present = new Set(Array.isArray(t.stages) ? t.stages.map((s) => s && s.stage) : []);
      const missingCore = CORE_STAGES.filter((s) => !present.has(s));
      if (missingCore.length === 0) fullSpineTurns += 1;
      for (const s of missingCore) spineGap[s] = (spineGap[s] || 0) + 1;
      const missing = Array.isArray(t.missing) ? t.missing : [];
      for (const s of missing) {
        if (EXPECTED_ABSENT_STAGES.includes(s)) continue;
        stageBypass[s] = (stageBypass[s] || 0) + 1;
      }
    }

    const v = _isPlainObject(r.visible) ? r.visible : null;
    if (v && v.error_present === true) visibleErrors += 1;
    if (v && v.message_present === true && e && e.decision === false) visibleNullDecision += 1;

    // Discussion referent: the route's pick vs the packet's field. A pick with no packet
    // referent is the route-local signal Phase 4 clears; a differing packet referent is a
    // genuine contradiction to investigate.
    const ref = _isPlainObject(r.referent) ? r.referent : null;
    if (ref && ref.route != null) {
      withReferent += 1;
      if (ref.packet == null) referentRouteLocal += 1;
      else if (String(ref.packet) !== String(ref.route)) referentMismatch += 1;
    }
  }

  return {
    total,
    packets_valid: packetsValid,
    packets_invalid: total - packetsValid,
    invalid_examples: invalidExamples,
    with_embedded: withEmbedded,
    embedded_bypass: embeddedBypass,
    traces_present: tracesPresent,
    traces_invalid: tracesInvalid,
    full_spine_turns: fullSpineTurns,
    spine_gap: spineGap,
    stage_bypass: stageBypass,
    visible_null_decision: visibleNullDecision,
    visible_errors: visibleErrors,
    with_referent: withReferent,
    referent_route_local: referentRouteLocal,
    referent_mismatch: referentMismatch,
  };
}

function _line(label, count, total, note) {
  const pct = _pct(count, total);
  return `  ${label.padEnd(22)} ${String(count).padStart(5)}/${total} (${pct}%)${note ? '   → ' + note : ''}`;
}

// Human-readable report. `opts.source` names where the records came from.
function formatReport(analysis, opts = {}) {
  const a = analysis || {};
  const total = a.total || 0;
  const source = opts.source ? ` (from ${opts.source})` : '';
  const lines = [];
  lines.push(`Atlas Phase 3 — coach-turn divergence report${source}`);
  lines.push(`${total} coach turn(s) shadowed.`);
  lines.push('');

  if (total === 0) {
    lines.push('No [coach-turn-shadow] records found. Is ATLAS_INTERACTION_TRACE=shadow set on the');
    lines.push('deployment, and were the logs collected while real turns ran?');
    return lines.join('\n');
  }

  lines.push('Packet validity:');
  if (a.packets_invalid === 0) lines.push(`  ✓ ${a.packets_valid}/${total} assembled packets are schema-valid.`);
  else {
    lines.push(`  ✗ ${a.packets_invalid}/${total} packets are INVALID — investigate:`);
    for (const ex of a.invalid_examples) lines.push(`      ${ex.turn_id || '(no id)'}: ${ex.errors.slice(0, 3).join('; ')}`);
  }
  lines.push('');

  lines.push('Bypassed packet truth (production computed the fact route-locally, not from the packet):');
  for (const f of EMBEDDED_BYPASS) {
    const c = (a.embedded_bypass && a.embedded_bypass[f.key]) || 0;
    if (c > 0) lines.push(_line(f.label, c, a.with_embedded || total, f.finding));
  }
  if (EMBEDDED_BYPASS.every((f) => ((a.embedded_bypass && a.embedded_bypass[f.key]) || 0) === 0)) {
    lines.push('  (none — every embedded fact was populated)');
  }
  lines.push('');

  lines.push('Visible ↔ packet contradiction:');
  lines.push(_line('reply w/ null decision', a.visible_null_decision || 0, total, 'the visible coaching reply had no canonical packet decision (the H-03 headline)'));
  if (a.visible_errors) lines.push(_line('degraded/outage replies', a.visible_errors, total, 'informational — LLM outage/degrade path'));
  lines.push('');

  lines.push('Discussion referent (the lift a bare correction resolves to):');
  if ((a.with_referent || 0) === 0) {
    lines.push('  (no turn picked a discussion referent in this window)');
  } else {
    lines.push(_line('route-local referent', a.referent_route_local || 0, a.with_referent || total,
      'the route picked a referent the packet does not carry — Phase 4 makes discussion-referent a CoachTurnPacket/WorkoutSession field set at answer time'));
    if (a.referent_mismatch) lines.push(_line('referent MISMATCH', a.referent_mismatch, a.with_referent || total,
      'the packet referent DIFFERS from the route pick — investigate'));
  }
  lines.push('');

  lines.push('Trace spine health:');
  lines.push(`  full 7-stage spine present on ${a.full_spine_turns}/${a.traces_present} traced turn(s).`);
  const spineGapKeys = Object.keys(a.spine_gap || {});
  if (spineGapKeys.length) {
    lines.push('  core stages MISSING from some turns (a real spine gap):');
    for (const s of spineGapKeys.sort()) lines.push(_line(s, a.spine_gap[s], a.traces_present, 'core stage absent'));
  }
  const stageBypassKeys = Object.keys(a.stage_bypass || {});
  if (stageBypassKeys.length) {
    lines.push('  canonical stages the turn bypassed (non-structural):');
    for (const s of stageBypassKeys.sort()) lines.push(_line(s, a.stage_bypass[s], a.traces_present, s === 'knowledge_retrieval' ? 'H-06 — research not wired (Phase 6)' : 'bypassed'));
  }
  if (a.traces_invalid) lines.push(`  ✗ ${a.traces_invalid} trace(s) invalid (mis-threaded turn id / out-of-order stage) — investigate.`);
  lines.push(`  (parser and write_proof are absent by design on the read-only coach route.)`);
  lines.push('');

  lines.push('Read this as the Phase-4 TODO: each bypass above is a fact the live route must');
  lines.push('take FROM the packet instead of recomputing. The list clears as Phase 4/5 wire out.');
  return lines.join('\n');
}

module.exports = {
  SHADOW_MARKER,
  CORE_STAGES,
  EXPECTED_ABSENT_STAGES,
  parseShadowLines,
  analyzeDivergences,
  formatReport,
};
