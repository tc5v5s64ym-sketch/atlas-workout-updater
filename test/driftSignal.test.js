'use strict';

// Soul Plan PR-B5a Part 1 — drift-signal golden fixtures.
//
// Pins each drift kind on its shape, the guards (deload / layoff / thin history
// never read as drift), and totality (garbage → not drifting, never throws).

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectDrift } = require('../services/driftSignal');

const ASOF = '2026-06-20';
// A recent log row so the layoff guard (≥7 days) does not suppress in the
// drift-positive fixtures.
const recentLog = [['2026-06-19', 'S9', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', 1, 185, 5, 2, '', 925]];

function pvc(date, planned, completed) { return { date, planned, completed }; }

// ── Kind 1: skipped_pattern_streak ────────────────────────────────────────────

test('skipped_pattern_streak: the same pattern planned-not-done for 3 consecutive sessions', () => {
  // Deadlift/RDL are both `hinge` — planned every session, never performed.
  const sessions = [
    pvc('2026-06-08', ['Bench Press', 'Deadlift'], ['Bench Press']),
    pvc('2026-06-14', ['Back Squat', 'Romanian Deadlift'], ['Back Squat']),
    pvc('2026-06-19', ['Overhead Press', 'Deadlift'], ['Overhead Press']),
  ];
  const out = detectDrift(recentLog, sessions, [], { asOf: ASOF });
  assert.equal(out.drifting, true);
  assert.equal(out.kind, 'skipped_pattern_streak');
  assert.equal(out.evidence.pattern, 'hinge');
  assert.equal(out.evidence.streak, 3);
  assert.deepEqual(out.evidence.sessions, ['2026-06-19', '2026-06-14', '2026-06-08']);
});

test('skipped_pattern_streak: does NOT fire if the pattern was performed in any session', () => {
  const sessions = [
    pvc('2026-06-08', ['Bench Press', 'Deadlift'], ['Bench Press']),
    pvc('2026-06-14', ['Back Squat', 'Romanian Deadlift'], ['Back Squat', 'Romanian Deadlift']), // did hinge
    pvc('2026-06-19', ['Overhead Press', 'Deadlift'], ['Overhead Press']),
  ];
  const out = detectDrift(recentLog, sessions, [], { asOf: ASOF });
  assert.notEqual(out.kind, 'skipped_pattern_streak');
});

// ── Kind 2: plan_deviation ────────────────────────────────────────────────────

test('plan_deviation: ≥50% of planned lifts unperformed across 3 sessions', () => {
  const sessions = [
    pvc('2026-06-08', ['Bench Press', 'Seated Row', 'Overhead Press', 'Pull Up'], ['Bench Press']),        // 75% missed, mixed patterns
    pvc('2026-06-14', ['Back Squat', 'Leg Press', 'Bench Press', 'Seated Row'], ['Back Squat', 'Leg Press']), // 50% missed
    pvc('2026-06-19', ['Deadlift', 'Overhead Press', 'Bench Press', 'Pull Up'], ['Deadlift']),               // 75% missed
  ];
  const out = detectDrift(recentLog, sessions, [], { asOf: ASOF });
  assert.equal(out.drifting, true);
  assert.equal(out.kind, 'plan_deviation');
  assert.equal(out.evidence.sessions_checked, 3);
  assert.ok(out.evidence.deviation_pct >= 50);
});

test('plan_deviation: does NOT fire when most planned work is completed', () => {
  const sessions = [
    pvc('2026-06-08', ['Bench Press', 'Seated Row'], ['Bench Press', 'Seated Row']),
    pvc('2026-06-14', ['Back Squat', 'Leg Press'], ['Back Squat', 'Leg Press']),
    pvc('2026-06-19', ['Deadlift', 'Overhead Press'], ['Deadlift', 'Overhead Press']),
  ];
  const out = detectDrift(recentLog, sessions, [], { asOf: ASOF });
  assert.equal(out.drifting, false);
});

// ── Kind 3: sandbag_persistence ───────────────────────────────────────────────

test('sandbag_persistence: consistent_underperformance with ≥3 sessions below', () => {
  const memory = [{ liftCode: 'BEN01', patterns: [{ type: 'consistent_underperformance', details: { sessions_below: 3, sessions_checked: 4 } }] }];
  // Thin plan history is fine — sandbag reads from memory patterns, not the plan.
  const out = detectDrift(recentLog, [], memory, { asOf: ASOF });
  assert.equal(out.drifting, true);
  assert.equal(out.kind, 'sandbag_persistence');
  assert.deepEqual(out.evidence, { liftCode: 'BEN01', sessions_below: 3, sessions_checked: 4 });
});

test('sandbag_persistence: a single below session does not fire (needs persistence)', () => {
  const memory = [{ liftCode: 'BEN01', patterns: [{ type: 'consistent_underperformance', details: { sessions_below: 1, sessions_checked: 4 } }] }];
  assert.equal(detectDrift(recentLog, [], memory, { asOf: ASOF }).drifting, false);
});

// ── Guards: legitimate windows are NEVER drift ────────────────────────────────

test('guard: an active deload suppresses drift', () => {
  const drifting = [
    pvc('2026-06-08', ['Bench Press', 'Deadlift'], ['Bench Press']),
    pvc('2026-06-14', ['Back Squat', 'Romanian Deadlift'], ['Back Squat']),
    pvc('2026-06-19', ['Overhead Press', 'Deadlift'], ['Overhead Press']),
  ];
  const out = detectDrift(recentLog, drifting, [], { asOf: ASOF, deloadState: { training_state: 'ACTIVE_DELOAD' } });
  assert.equal(out.drifting, false);
  assert.equal(out.evidence.suppressed, 'deload');
  // NORMAL state does not suppress.
  assert.equal(detectDrift(recentLog, drifting, [], { asOf: ASOF, deloadState: { training_state: 'NORMAL' } }).drifting, true);
});

test('guard: a real layoff (≥7 days away) suppresses drift', () => {
  const drifting = [
    pvc('2026-06-08', ['Bench Press', 'Deadlift'], ['Bench Press']),
    pvc('2026-06-14', ['Back Squat', 'Romanian Deadlift'], ['Back Squat']),
    pvc('2026-06-19', ['Overhead Press', 'Deadlift'], ['Overhead Press']),
  ];
  // Last log 20 days before asOf → layoff → suppressed.
  const staleLog = [['2026-05-31', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', 1, 185, 5, 2, '', 925]];
  const out = detectDrift(staleLog, drifting, [], { asOf: '2026-06-20' });
  assert.equal(out.drifting, false);
  assert.equal(out.evidence.suppressed, 'layoff');
});

test('guard: thin plan history never fires a plan/pattern drift', () => {
  const twoSessions = [
    pvc('2026-06-14', ['Bench Press', 'Deadlift'], ['Bench Press']),
    pvc('2026-06-19', ['Overhead Press', 'Deadlift'], ['Overhead Press']),
  ];
  assert.equal(detectDrift(recentLog, twoSessions, [], { asOf: ASOF }).drifting, false);
});

// ── Totality ──────────────────────────────────────────────────────────────────

test('totality: garbage / empty inputs → not drifting, never throws', () => {
  for (const args of [
    [null, null, null, {}],
    [[], [], [], { asOf: ASOF }],
    ['x', 'y', 'z', null],
    [recentLog, [{}], [{}], { asOf: ASOF }],
    [recentLog, [{ planned: 'nope' }], [{ patterns: 'nope' }], { asOf: ASOF }],
  ]) {
    const out = detectDrift(...args);
    assert.equal(out.drifting, false, `garbage ${JSON.stringify(args[1])} must not drift`);
    assert.equal(typeof out, 'object');
  }
});
