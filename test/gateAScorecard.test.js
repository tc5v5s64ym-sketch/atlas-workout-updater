'use strict';

// PR-GATEA2 — read-only GATE A eligible-window scorecard.
//
// Evaluates a Brain_Shadow window using ONLY eligible evidence
// (evidence_class === 'athlete_ui' AND evidence_eligible === TRUE), fail-closed.
// Old/unknown/synthetic/malformed rows are excluded and reported by class+reason.
// Pure — no Sheets, no network, no writes; deterministic given injected rows + asOf.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BRAIN_SHADOW_HEADER,
  computeScorecard,
  renderMarkdown,
} = require('../services/gateAScorecard');

// Brain_Shadow row factory (the frozen 19-column order, PR-GATEA1).
// at, route, lift_code, mode, ok, reason, decision_type, status, confidence_tier,
// skipped_json, comparable, diverged, weight_delta, reps_delta, ms, app_version,
// evidence_class, evidence_eligible, request_origin
function row(o = {}) {
  return [
    o.at ?? '2026-08-01T10:00:00.000Z',
    o.route ?? '/api/recommend/next',
    o.lift_code ?? 'BENCH',
    o.mode ?? 'hybrid',
    o.ok === false ? 'FALSE' : 'TRUE',
    o.reason ?? '',
    o.decision_type ?? 'progression',
    o.status ?? 'answered',
    o.confidence_tier ?? 'high',
    o.skipped ?? '[]',
    o.comparable === false ? 'FALSE' : (o.comparable === true || o.weight_delta != null || o.reps_delta != null ? 'TRUE' : 'FALSE'),
    o.diverged ? 'TRUE' : 'FALSE',
    o.weight_delta ?? '',
    o.reps_delta ?? '',
    o.ms ?? 5,
    o.app_version ?? 'v129',
    o.evidence_class ?? 'athlete_ui',
    o.evidence_eligible ?? 'TRUE',
    o.request_origin ?? 'athlete_ui',
  ];
}
// an eligible progression event with a comparable in-tolerance decision
const eligible = (o = {}) => row({ weight_delta: 0, reps_delta: 0, ...o });
// N eligible events across distinct dates/lifts (variety)
function manyEligible(n) {
  const lifts = ['BENCH', 'SQUAT', 'OHP', 'DEADLIFT', 'ROW'];
  return Array.from({ length: n }, (_, i) => eligible({
    at: `2026-08-${String((i % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
    lift_code: lifts[i % lifts.length],
    weight_delta: 0, reps_delta: 0,
  }));
}
const OPTS = { header: BRAIN_SHADOW_HEADER, asOf: '2026-09-01T00:00:00.000Z' };

// ── Eligibility filtering (fail-closed) ──────────────────────────────────────

test('counts only athlete_ui + eligible rows; excludes synthetic / unknown / old / malformed', () => {
  const rows = [
    eligible(),                                            // counts
    eligible({ evidence_class: 'synthetic', evidence_eligible: 'FALSE', request_origin: 'smoke' }), // excluded synthetic
    eligible({ evidence_class: 'unknown', evidence_eligible: 'FALSE', request_origin: 'missing' }), // excluded unknown
    ['2026-08-01T10:00:00.000Z', '/api/recommend/next', 'BENCH', 'hybrid', 'TRUE', '', 'progression', 'answered', 'high', '[]', 'TRUE', 'FALSE', 0, 0, 5, 'v100'], // OLD 16-col row → no provenance → excluded
    eligible({ evidence_class: 'athlete_ui', evidence_eligible: 'FALSE' }), // MALFORMED: class ok but eligible cell FALSE → excluded (fail closed)
    eligible({ evidence_class: 'unknown', evidence_eligible: 'TRUE' }),     // MALFORMED: eligible TRUE but class not athlete_ui → excluded
  ];
  const sc = computeScorecard(rows, OPTS);
  assert.equal(sc.eligible.total, 1, 'only the one genuinely eligible row counts');
  assert.equal(sc.excluded.total, 5);
  assert.equal(sc.excluded.by_class.synthetic, 1);
  assert.equal(sc.excluded.by_class.unknown >= 1, true);
  assert.ok(sc.excluded.by_reason.malformed_eligibility >= 2, 'contradictory class/eligible pairs are malformed-excluded');
});

test('boolean/case normalization: TRUE/true/True and stray whitespace all mean eligible; anything else fails closed', () => {
  const rows = [
    eligible({ evidence_eligible: 'true' }),
    eligible({ evidence_eligible: ' TRUE ' }),
    eligible({ evidence_class: 'Athlete_UI', evidence_eligible: 'True' }),
    eligible({ evidence_eligible: 'yes' }),   // not a recognized TRUE token → fail closed
    eligible({ evidence_eligible: '1' }),     // not TRUE/true → fail closed (eligible cell is TRUE/FALSE only)
  ];
  const sc = computeScorecard(rows, OPTS);
  assert.equal(sc.eligible.total, 3, 'only TRUE/true/True (trim/case) count; yes/1 fail closed');
});

test('missing provenance columns in the header → HARD FAILURE (never silently counts)', () => {
  const oldHeader = BRAIN_SHADOW_HEADER.slice(0, 16); // pre-GATEA1 header, no provenance cols
  assert.throws(() => computeScorecard([eligible()], { header: oldHeader, asOf: OPTS.asOf }),
    /provenance column|evidence_class|missing/i);
});

test('fails closed if an active-tab row LACKS provenance cells yet would otherwise look eligible', () => {
  // a row truncated to 16 cols (no evidence_* cells) must never be counted, even with the full header
  const truncated = eligible().slice(0, 16);
  const sc = computeScorecard([eligible(), truncated], OPTS);
  assert.equal(sc.eligible.total, 1, 'the provenance-less row is excluded');
  assert.ok(sc.excluded.by_reason.missing_provenance >= 1);
});

// ── Per-decision-type separation ─────────────────────────────────────────────

test('progression is evaluated separately from workout; unlike types are never averaged together', () => {
  const rows = [
    eligible({ decision_type: 'progression', weight_delta: 0 }),
    eligible({ decision_type: 'workout', comparable: false }),
  ];
  const sc = computeScorecard(rows, OPTS);
  assert.equal(sc.progression.eligible_events, 1);
  assert.ok(sc.by_decision_type.workout, 'workout reported as its own type');
  assert.notEqual(sc.by_decision_type.workout.classification, 'PASS');
});

test('workout / Coach’s Pick is INELIGIBLE without block-level divergence metrics', () => {
  const rows = manyEligible(60).map(r => { r[6] = 'workout'; r[10] = 'FALSE'; return r; }); // 60 workout, non-comparable
  const sc = computeScorecard(rows, OPTS);
  assert.equal(sc.by_decision_type.workout.classification, 'INELIGIBLE');
  assert.match(sc.by_decision_type.workout.reason, /block-level|divergence|comparable/i);
});

// ── Floor / preferred / variety ──────────────────────────────────────────────

test('49 eligible varied events → floor NOT met; 50 → met; 100 → preferred met', () => {
  assert.equal(computeScorecard(manyEligible(49), OPTS).progression.floor_met, false);
  assert.equal(computeScorecard(manyEligible(50), OPTS).progression.floor_met, true);
  assert.equal(computeScorecard(manyEligible(50), OPTS).progression.preferred_met, false);
  assert.equal(computeScorecard(manyEligible(100), OPTS).progression.preferred_met, true);
});

test('variety is reported from distinct dates + lift codes, never inferred as PASS when unknowable', () => {
  const sc = computeScorecard(manyEligible(50), OPTS);
  assert.ok(sc.progression.distinct_utc_dates >= 5);
  assert.ok(sc.progression.distinct_lift_codes >= 5);
  assert.ok(['proven', 'incomplete', 'unknowable'].includes(sc.progression.variety));
});

// ── Tolerance ────────────────────────────────────────────────────────────────

test('tolerance: |Δweight|≤5 within (both bands); >10 out; rep tolerance ±1; max deltas + out-of-tolerance extracted', () => {
  const rows = [
    eligible({ weight_delta: 5, reps_delta: 1 }),    // within (edge)
    eligible({ weight_delta: -5, reps_delta: -1 }),  // within
    eligible({ weight_delta: 12, reps_delta: 0 }),   // OUT (>10)
    eligible({ weight_delta: 0, reps_delta: 3 }),    // OUT (reps > 1)
    eligible({ weight_delta: 0, reps_delta: 0 }),    // exact match
  ];
  const sc = computeScorecard(rows, OPTS);
  const p = sc.progression;
  assert.equal(p.comparable_events, 5);
  assert.equal(p.max_abs_weight_delta, 12);
  assert.equal(p.max_abs_rep_delta, 3);
  assert.equal(p.exact_match_count, 1);
  assert.equal(p.out_of_tolerance_count, 2, 'the 12-lb and 3-rep rows are out of tolerance');
  assert.equal(p.within_tolerance_count, 3);
  assert.ok(Array.isArray(p.out_of_tolerance) && p.out_of_tolerance.length === 2);
});

test('tolerance region split: 5<Δ≤10 with an undeterminable region is flagged for review, never silently PASSed', () => {
  const rows = [eligible({ weight_delta: 8, reps_delta: 0, lift_code: 'MYSTERY_LIFT' })];
  const sc = computeScorecard(rows, OPTS);
  assert.ok(sc.progression.region_undeterminable_count >= 1);
  assert.notEqual(sc.progression.tolerance_result, 'PASS', 'ambiguous region tolerance is not an automatic PASS');
});

// ── Engine health blockers ───────────────────────────────────────────────────

test('an orchestrator/assembly error among eligible rows is an automatic blocker; ok:false reasons reported', () => {
  const rows = [
    ...manyEligible(50),
    eligible({ ok: false, reason: 'orchestrator_error', decision_type: '', status: '' }),
    eligible({ ok: false, reason: 'invalid_decision' }),
  ];
  const sc = computeScorecard(rows, OPTS);
  assert.ok(sc.progression.orchestrator_error_count >= 1);
  assert.equal(sc.progression.floor_met, true);
  assert.equal(sc.progression.classification, 'FAIL', 'any engine error blocks progression regardless of the count floor');
  assert.ok(sc.progression.ok_false_by_reason.invalid_decision >= 1);
});

// ── Safety fields are never auto-passed from numeric columns ──────────────────

test('safety criteria distinguish auto-proven / auto-failed / requires-human-review / unavailable — never "0 errors ⇒ 0 unsafe"', () => {
  const sc = computeScorecard(manyEligible(60), OPTS);
  const safety = sc.safety;
  assert.ok(safety.zero_unsafe_recommendations);
  assert.equal(safety.zero_unsafe_recommendations.status, 'requires_human_review',
    'zero recorded errors must NOT be claimed as proof of zero unsafe coaching');
  assert.ok(['automatically_proven', 'automatically_failed', 'requires_human_review', 'unavailable']
    .includes(safety.zero_orchestrator_errors.status));
  // representative-review section exists
  assert.ok(sc.representative_review, 'a representative-review section is produced');
});

// ── Determinism + no leakage ─────────────────────────────────────────────────

test('deterministic: same rows + asOf → identical JSON', () => {
  const a = JSON.stringify(computeScorecard(manyEligible(50), OPTS));
  const b = JSON.stringify(computeScorecard(manyEligible(50), OPTS));
  assert.equal(a, b);
});

test('renderMarkdown produces a concise human-readable report and leaks no raw request bodies/secrets', () => {
  const md = renderMarkdown(computeScorecard(manyEligible(50), OPTS));
  assert.match(md, /GATE A/i);
  assert.match(md, /progression/i);
  assert.match(md, /50/);
  assert.ok(!/x-atlas-api-key|GOOGLE_PRIVATE_KEY|BEGIN PRIVATE KEY/i.test(md), 'no secret material in the report');
});
