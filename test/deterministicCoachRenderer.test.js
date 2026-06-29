'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderCoachEvent, EVENT_TYPES, fmtSet, hashIndex } = require('../services/deterministicCoachRenderer');

// A rich input touching every field a renderer reads.
const FULL_INPUT = {
  exercise: 'Bench Press',
  target: { weight: 225, reps: 8, rir: 2, sets: 3 },
  actual: { weight: 225, reps: 8, rir: 2 },
  previousHistory: { best_weight: 235 },
  trainingGap: '3 weeks',
  progressionStatus: 'holding at your working weight',
  sessionContext: { next_exercise: 'Seated Row', sets_written: 12, error: 'network timeout' },
  mutationContext: { prescribed: 'Barbell Row', logged: 'Seated Row', canonical: 'Seated Row' },
  readinessContext: null,
};

// Collect every digit-run present anywhere in the input — the renderer may only
// surface numbers that appear here (the "no invented facts" guarantee).
function inputDigitSet(input) {
  const set = new Set((JSON.stringify(input).match(/\d+/g) || []));
  return set;
}

function outputDigits(message) {
  return message.match(/\d+/g) || [];
}

function sentenceCount(message) {
  return (message.match(/[.!?]+(\s|$)/g) || []).length;
}

test('deterministicCoachRenderer: exposes all 17 spec event types', () => {
  const expected = [
    'set_logged', 'target_hit', 'reps_missed', 'rir_too_low', 'rir_too_high',
    'hold_weight', 'progress_next_time', 'next_up_handoff', 'substitution_accepted',
    'skipped_exercise', 'inserted_accessory', 'identity_corrected', 'warmup_logged',
    'first_session_back', 'coach_unavailable', 'save_succeeded', 'save_failed',
  ];
  for (const e of expected) assert.ok(EVENT_TYPES.includes(e), `missing event type: ${e}`);
  assert.equal(EVENT_TYPES.length, expected.length, 'no unexpected extra event types');
});

test('deterministicCoachRenderer: every event renders a non-empty, ≤3-sentence message with the right shape', () => {
  for (const e of EVENT_TYPES) {
    const out = renderCoachEvent(e, FULL_INPUT);
    assert.equal(typeof out.message, 'string', `${e}: message is a string`);
    assert.ok(out.message.length > 0, `${e}: message is non-empty`);
    assert.equal(typeof out.evidenceCited, 'boolean', `${e}: evidenceCited is a boolean`);
    assert.ok(sentenceCount(out.message) <= 3, `${e}: ≤3 sentences (got "${out.message}")`);
  }
});

test('deterministicCoachRenderer: NEVER invents a number — every output digit appears in the input (full input)', () => {
  const allowed = inputDigitSet(FULL_INPUT);
  for (const e of EVENT_TYPES) {
    const { message } = renderCoachEvent(e, FULL_INPUT);
    for (const d of outputDigits(message)) {
      assert.ok(allowed.has(d), `${e}: output number "${d}" not present in input — hallucinated. msg="${message}"`);
    }
  }
});

test('deterministicCoachRenderer: NEVER invents a number — empty input yields ZERO digits in any message', () => {
  for (const e of EVENT_TYPES) {
    const { message } = renderCoachEvent(e, {});
    assert.equal(outputDigits(message).length, 0, `${e}: emitted a number from an empty input: "${message}"`);
  }
});

test('deterministicCoachRenderer: pure / deterministic — same input yields identical output', () => {
  for (const e of EVENT_TYPES) {
    const a = renderCoachEvent(e, FULL_INPUT);
    const b = renderCoachEvent(e, FULL_INPUT);
    assert.deepEqual(a, b, `${e}: not deterministic`);
  }
});

test('deterministicCoachRenderer: evidenceCited is true exactly when a concrete number is surfaced', () => {
  for (const e of EVENT_TYPES) {
    const { message, evidenceCited } = renderCoachEvent(e, FULL_INPUT);
    const hasNum = outputDigits(message).length > 0;
    assert.equal(evidenceCited, hasNum, `${e}: evidenceCited (${evidenceCited}) must match presence of a number (${hasNum}) in "${message}"`);
  }
});

test('deterministicCoachRenderer: target_hit cites the set and a next-action (spec example shape)', () => {
  const out = renderCoachEvent('target_hit', FULL_INPUT);
  assert.match(out.message, /225×8 at RIR 2/, 'cites the actual set');
  assert.match(out.message, /225/, 'names the hold weight');
  assert.equal(out.evidenceCited, true);
});

test('deterministicCoachRenderer: reps_missed grounds in the actual + target reps, no invented diff', () => {
  const out = renderCoachEvent('reps_missed', { exercise: 'Squat', target: { reps: 8, weight: 315 }, actual: { reps: 5, weight: 315 } });
  // Only 5, 8, 315 may appear — never a derived "3" (the diff).
  const allowed = new Set(['5', '8', '315']);
  for (const d of outputDigits(out.message)) assert.ok(allowed.has(d), `unexpected number ${d} in "${out.message}"`);
  assert.match(out.message, /5/);
  assert.match(out.message, /8/);
});

test('deterministicCoachRenderer: coach_unavailable is confident output, not an apology', () => {
  const out = renderCoachEvent('coach_unavailable', FULL_INPUT);
  assert.doesNotMatch(out.message, /sorry|unavailable|down|offline|error|can't|cannot/i, 'no apology / system-status language');
  assert.ok(out.message.length > 0);
});

test('deterministicCoachRenderer: save_failed keeps the data reassurance and is actionable', () => {
  const out = renderCoachEvent('save_failed', FULL_INPUT);
  assert.match(out.message, /still here|try (saving )?again/i, 'reassures sets are kept + actionable retry');
});

test('deterministicCoachRenderer: unknown event type returns an empty message (caller falls back)', () => {
  assert.deepEqual(renderCoachEvent('not_an_event', FULL_INPUT), { message: '', evidenceCited: false });
});

test('deterministicCoachRenderer: never throws on null / malformed input', () => {
  for (const e of EVENT_TYPES) {
    assert.doesNotThrow(() => renderCoachEvent(e, null));
    assert.doesNotThrow(() => renderCoachEvent(e, { actual: 'nope', target: 42 }));
  }
});

test('deterministicCoachRenderer: ≥2 distinct phrasing variants per event (deterministic selection)', () => {
  // Drive the variant picker across many seeds, varying EVERY field a renderer
  // keys its seed on, so each event genuinely exercises both phrasings.
  for (const e of EVENT_TYPES) {
    const seen = new Set();
    for (let i = 0; i < 24; i += 1) {
      const out = renderCoachEvent(e, {
        exercise: `Lift ${i}`,
        target: { weight: 100 + i, reps: 5 + (i % 4), rir: i % 3, sets: 3 },
        actual: { weight: 100 + i, reps: 5 + (i % 4), rir: i % 3 },
        trainingGap: `${i} weeks`,
        progressionStatus: { next_weight: 150 + i },
        sessionContext: { next_exercise: `Next ${i}`, sets_written: i, error: `err ${i}` },
        mutationContext: { prescribed: `Presc ${i}`, logged: `Logd ${i}`, canonical: `Canon ${i}` },
      });
      seen.add(out.message);
    }
    assert.ok(seen.size >= 2, `${e}: expected ≥2 phrasing variants, saw ${seen.size}`);
  }
});

test('deterministicCoachRenderer: hashIndex is stable and bounded', () => {
  assert.equal(hashIndex('abc', 2), hashIndex('abc', 2));
  for (let i = 0; i < 50; i += 1) {
    const idx = hashIndex(`seed-${i}`, 3);
    assert.ok(idx >= 0 && idx < 3);
  }
  assert.equal(hashIndex('x', 0), 0, 'n<1 guards to 0');
});

test('fmtSet: only surfaces present fields, never invents', () => {
  assert.equal(fmtSet({ weight: 225, reps: 8, rir: 2 }), '225×8 at RIR 2');
  assert.equal(fmtSet({ weight: 225, reps: 8 }), '225×8');
  assert.equal(fmtSet({ reps: 8 }), '8 reps');
  assert.equal(fmtSet({ weight: 225 }), '225 lb');
  assert.equal(fmtSet({ rir: 2 }), 'RIR 2');
  assert.equal(fmtSet({}), null);
  assert.equal(fmtSet(null), null);
});
