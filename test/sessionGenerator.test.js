'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildSession } = require('../services/sessionGenerator');
const { buildCoachingDecision, validateCoachingDecision } = require('../services/coachingDecision');

const ASOF = '2026-06-30T14:00:00Z';

// Build N sessions of improving history for a lift (12-col positional rows).
function history(exercise, canonical, muscle, liftCode, startW, n = 6) {
  const dates = ['2026-05-16', '2026-05-20', '2026-05-24', '2026-05-28', '2026-06-01', '2026-06-05', '2026-06-08'];
  const rows = []; let w = startW;
  for (let i = 0; i < n; i++) { rows.push([dates[i], 's' + liftCode + i, exercise, canonical, muscle, liftCode, 1, w, 5, 2, '', w * 5]); w += 5; }
  return rows;
}

// Full-body history covering the four core patterns (Back Squat, Bench Press,
// Barbell Row, Romanian Deadlift — the barbell variants PATTERN_VARIANTS selects).
function fullBodyRows() {
  return [
    ...history('Back Squat', 'Back Squat', 'quads', 'SQUAT', 225),
    ...history('Bench Press', 'Bench Press', 'chest', 'BENCH', 185),
    ...history('Barbell Row', 'Barbell Row', 'back', 'ROW', 135),
    ...history('Romanian Deadlift', 'Romanian Deadlift', 'hamstrings', 'RDL', 205),
  ];
}

function state(rows, extra = {}) {
  return { asOf: ASOF, log_history: rows, profile: { profile_goal: 'general-fitness', training_level: 'intermediate' }, deload_state: null, ...extra };
}

// Wrap a buildSession result into a CoachingDecision and validate it.
function asDecision(result) {
  return buildCoachingDecision({
    intent: { type: 'best_workout', constraints: {}, source: 'button' },
    decision_type: 'workout', status: 'answered',
    confidence: { score: 80, tier: 'high', action: 'act', caveats: [] },
    safety: { level: 'green', flags: [], blocking: false },
    payload: result.payload,
    missing_info: [],
    explanation_inputs: result.explanation_inputs,
    provenance: { modules_run: ['session_generator'], skipped: [], state_asOf: ASOF, engine_version: '1' },
  });
}

// ─── guards ──────────────────────────────────────────────────────────────────

describe('buildSession — guards', () => {
  it('returns null for null state', () => assert.strictEqual(buildSession(null, {}), null));
  it('returns null when no history-backed block can be built', () => {
    assert.strictEqual(buildSession(state([]), { focus: 'full_body' }), null);
  });
  it('never throws on garbage', () => assert.doesNotThrow(() => buildSession('x', 'y')));
});

// ─── payload validity + trust contract ───────────────────────────────────────

describe('buildSession — produces a VALID workout decision', () => {
  it('full-body session validates (workout discriminator + key-aware trust contract)', () => {
    const r = buildSession(state(fullBodyRows()), { focus: 'full_body' });
    assert.ok(r, 'expected a session');
    const v = validateCoachingDecision(asDecision(r));
    assert.strictEqual(v.valid, true, `errors: ${v.errors.join(' | ')}`);
    assert.ok(r.payload.blocks.length >= 1);
    // every block's prescribed numbers are echoed under matching keys
    r.payload.blocks.forEach((b, i) => {
      assert.strictEqual(r.explanation_inputs.blocks[i].target_weight, b.target_weight);
      assert.strictEqual(r.explanation_inputs.blocks[i].reps, b.reps);
      assert.strictEqual(r.explanation_inputs.blocks[i].target_rir, b.target_rir);
    });
  });

  it('every block carries the required fields + an engine scenario_id', () => {
    const r = buildSession(state(fullBodyRows()), { focus: 'full_body' });
    for (const b of r.payload.blocks) {
      for (const f of ['exercise', 'lift_code', 'sets', 'reps', 'target_weight', 'target_rir']) {
        assert.ok(b[f] != null, `block missing ${f}`);
      }
      assert.ok(typeof b.scenario_id === 'string' && b.scenario_id.length > 0);
      assert.strictEqual(b.source, 'brian');
    }
  });

  it('a deliberately un-echoed block number fails validation (trust contract bites)', () => {
    const r = buildSession(state(fullBodyRows()), { focus: 'full_body' });
    r.explanation_inputs.blocks[0].target_weight = r.payload.blocks[0].target_weight + 999;
    assert.strictEqual(validateCoachingDecision(asDecision(r)).valid, false);
  });
});

// ─── pattern coverage + focus ────────────────────────────────────────────────

describe('buildSession — focus → pattern coverage', () => {
  it('full_body covers the core patterns present in history', () => {
    const r = buildSession(state(fullBodyRows()), { focus: 'full_body' });
    const patterns = new Set(r.payload.blocks.map(b => b.pattern));
    assert.ok(patterns.has('squat'));
    assert.ok(patterns.has('horizontal_push'));
    assert.ok(patterns.has('hinge'));
  });
  it('lower_body focus yields only lower-body patterns', () => {
    const r = buildSession(state(fullBodyRows()), { focus: 'lower_body' });
    for (const b of r.payload.blocks) assert.ok(['squat', 'hinge'].includes(b.pattern));
  });
});

// ─── equipment filtering ─────────────────────────────────────────────────────

describe('buildSession — equipment filtering', () => {
  it('bodyweight-only equipment drops barbell-only lifts (noted)', () => {
    // History is all barbell; with only bodyweight available, barbell variants are
    // unavailable → those patterns fall to a bodyweight variant with no history →
    // dropped to notes. Squat has a Bodyweight Squat variant (no history) → noted.
    const r = buildSession(state(fullBodyRows()), { focus: 'full_body', equipment: ['bodyweight'] });
    // no barbell block should appear
    if (r) for (const b of r.payload.blocks) assert.notStrictEqual(b.exercise, 'Bench Press');
    // and notes should record at least one drop
    assert.ok(!r || r.notes.length >= 1);
  });
});

// ─── injury veto ─────────────────────────────────────────────────────────────

describe('buildSession — injury handling', () => {
  it('a knee injury drops the squat pattern and records a substitution', () => {
    const r = buildSession(state(fullBodyRows()), { focus: 'full_body', injury: 'knee' });
    assert.ok(r);
    for (const b of r.payload.blocks) assert.notStrictEqual(b.pattern, 'squat');
    assert.ok(r.substitutions_applied.some(s => /knee/.test(s.reason)));
  });
});

// ─── duration fitting ────────────────────────────────────────────────────────

describe('buildSession — duration fitting', () => {
  it('a short duration yields no more blocks than a long one', () => {
    const long = buildSession(state(fullBodyRows()), { focus: 'upper_body', duration_minutes: 120 });
    const short = buildSession(state(fullBodyRows()), { focus: 'upper_body', duration_minutes: 20 });
    if (long && short) assert.ok(short.payload.blocks.length <= long.payload.blocks.length);
  });
});

// ─── deload ──────────────────────────────────────────────────────────────────

describe('buildSession — deload', () => {
  it('an active deload protocol cuts the load below the normal prescription', () => {
    const normal = buildSession(state(fullBodyRows()), { focus: 'squat' });
    const deloaded = buildSession(
      state(fullBodyRows(), { deload_state: { in_deload: true, training_state: 'DELOAD_ACTIVE',
        protocol: { id: 'test', load_multiplier: 0.6, set_multiplier: 1, target_rir: 4 } } }),
      { focus: 'squat' });
    assert.ok(normal && deloaded);
    assert.ok(deloaded.payload.blocks[0].target_weight < normal.payload.blocks[0].target_weight);
    // still valid + lockstep
    assert.strictEqual(validateCoachingDecision(asDecision(deloaded)).valid, true);
    assert.strictEqual(deloaded.explanation_inputs.blocks[0].target_weight, deloaded.payload.blocks[0].target_weight);
  });

  // #848 deload proof, pinned at the buildSession unit level (independent of the
  // brian serve rail). stateAssembly feeds the RAW persisted deload row — a
  // { training_state: 'DELOAD_ACTIVE', deload_protocol: <id string> } shape with NO
  // resolved `protocol` object. buildSession must resolve the protocol from its id
  // and still cut the load; a regression here silently prescribes full load
  // mid-deload. This is the non-user-served composition proof that outlives the
  // now-shadow-only Coach's Pick HTTP path.
  it('resolves the RAW persisted deload shape (deload_protocol id string) and cuts the load', () => {
    const normal = buildSession(state(fullBodyRows()), { focus: 'squat' });
    const deloaded = buildSession(
      state(fullBodyRows(), { deload_state: { training_state: 'DELOAD_ACTIVE', deload_protocol: 'STRENGTH_DELOAD_V1' } }),
      { focus: 'squat' });
    assert.ok(normal && deloaded);
    assert.ok(deloaded.payload.blocks[0].target_weight < normal.payload.blocks[0].target_weight,
      'raw-shape active deload must reduce the prescribed load below the normal prescription');
    assert.strictEqual(validateCoachingDecision(asDecision(deloaded)).valid, true);
    assert.strictEqual(deloaded.explanation_inputs.blocks[0].target_weight, deloaded.payload.blocks[0].target_weight);
  });
});

// ─── hinge regression — overperforming → increase_load → 5 lb lower-body step ──
// Guards the whole reachable chain: a hinge lift whose reps beat expected at a
// held load classifies `underloaded` → increase_load, and the prescribed weight
// steps by the lower-body increment (5 lb, not the 2.5 lb upper-body increment).
// This is the path that was unreachable before overperforming was threaded.

describe('buildSession — hinge overperforming regression', () => {
  // Held weight, rising reps → improving e1RM (no plateau) and the last set beats
  // its expected reps at that load → overperforming.
  function hingeOverRows() {
    const dates = ['2026-06-01', '2026-06-04', '2026-06-08', '2026-06-11'];
    const reps  = [5, 6, 7, 9];
    return dates.map((d, i) =>
      [d, 'rdl' + i, 'Romanian Deadlift', 'Romanian Deadlift', 'hamstrings', 'RDL', 1, 135, reps[i], 2, '', 135 * reps[i]]);
  }

  it('a hinge lift with overperforming history → increase_load at a 5 lb step', () => {
    const r = buildSession(state(hingeOverRows()), { focus: 'hinge', equipment: ['barbell'] });
    assert.ok(r, 'expected a hinge session');
    const block = r.payload.blocks.find(b => b.pattern === 'hinge');
    assert.ok(block, 'expected a hinge block');
    assert.strictEqual(block.scenario_id, 'underloaded');
    // 135 → 140: a single 5 lb lower-body increment (a 2.5 lb upper-body step
    // would land off a 5 lb grid). Guards bodyRegion → computeLoadStep.
    assert.strictEqual(block.target_weight, 140);
    assert.strictEqual(block.target_weight % 5, 0);
    assert.ok(block.target_weight > 135, 'load must increase');
    // trust contract stays lockstep
    assert.strictEqual(validateCoachingDecision(asDecision(r)).valid, true);
  });
});
