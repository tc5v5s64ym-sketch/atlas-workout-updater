'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveConstraints } = require('../services/constraintResolver');
const { buildIntentEnvelope, validateIntentEnvelope } = require('../services/intentEnvelope');

const row = (kind, target, rule, date = '2026-07-01', note = null) => ({ date, kind, target, rule, note });

describe('constraintResolver — guards and purity', () => {
  test('total: garbage input never throws and returns an empty resolution', () => {
    for (const input of [undefined, null, 42, 'x', {}, { stored: 'nope', request: 7 }]) {
      const out = resolveConstraints(input);
      assert.deepEqual(out.constraints, {});
      assert.deepEqual(out.applied, []);
      assert.ok(Array.isArray(out.ignored));
    }
  });

  test('malformed stored rows are ignored with a reason, never dropped silently', () => {
    const out = resolveConstraints({ stored: [null, {}, { kind: 'injury' }, row('injury', 'knee', 'avoid')] });
    const reasons = out.ignored.map(i => i.reason);
    assert.ok(reasons.includes('malformed_row'));
    assert.equal(out.constraints.injury, 'knee');
  });

  test('pure: inputs are not mutated', () => {
    const stored = [row('preference', 'Leg Press', 'avoid')];
    const request = { focus: 'push', exclude_exercises: ['Dips'] };
    const storedCopy = JSON.parse(JSON.stringify(stored));
    const requestCopy = JSON.parse(JSON.stringify(request));
    resolveConstraints({ stored, request });
    assert.deepEqual(stored, storedCopy);
    assert.deepEqual(request, requestCopy);
  });
});

describe('constraintResolver — stored-row mapping', () => {
  test('injury rows map body-area text to the vocabulary enum (any rule verb — safety is additive)', () => {
    for (const rule of ['avoid', 'limit', 'substitute']) {
      const out = resolveConstraints({ stored: [row('injury', 'right shoulder pain', rule)] });
      assert.equal(out.constraints.injury, 'shoulder', `rule=${rule} must still protect the joint`);
    }
    assert.equal(resolveConstraints({ stored: [row('injury', 'lower back', 'avoid')] }).constraints.injury, 'lower_back');
    assert.equal(resolveConstraints({ stored: [row('injury', 'tweaked my Knee', 'avoid')] }).constraints.injury, 'knee');
  });

  test('unrecognized injury areas are surfaced in ignored, not guessed', () => {
    const out = resolveConstraints({ stored: [row('injury', 'general fatigue', 'avoid')] });
    assert.equal(out.constraints.injury, undefined);
    assert.equal(out.ignored[0].reason, 'injury_area_unrecognized');
  });

  test('equipment avoid/substitute rows narrow the available set; positional arrays accepted', () => {
    const out = resolveConstraints({ stored: [['2026-07-01', 'equipment', 'barbells', 'avoid', null]] });
    assert.ok(Array.isArray(out.constraints.equipment));
    assert.ok(!out.constraints.equipment.includes('barbell'));
    assert.ok(out.constraints.equipment.includes('dumbbell'));
  });

  test('rule=limit is not resolvable in v1 — surfaced, not applied', () => {
    const out = resolveConstraints({ stored: [row('equipment', 'machines', 'limit'), row('preference', 'Squat', 'limit')] });
    assert.equal(out.constraints.equipment, undefined);
    assert.equal(out.constraints.exclude_exercises, undefined);
    assert.equal(out.ignored.filter(i => i.reason === 'limit_not_resolvable_v1').length, 2);
  });

  test('preference avoid/substitute rows become exclude_exercises', () => {
    const out = resolveConstraints({ stored: [row('preference', 'Leg Press', 'avoid'), row('preference', 'Behind-the-neck Press', 'substitute')] });
    assert.deepEqual(out.constraints.exclude_exercises, ['Leg Press', 'Behind-the-neck Press']);
  });

  test('unknown kinds are surfaced in ignored', () => {
    const out = resolveConstraints({ stored: [row('mood', 'monday', 'avoid')] });
    assert.equal(out.ignored[0].reason, 'unknown_kind');
  });
});

describe('constraintResolver — merge precedence', () => {
  test('request keys pass through verbatim (focus, duration, target_lift)', () => {
    const request = { focus: 'push', duration_minutes: 30, target_lift: 'BP01' };
    const out = resolveConstraints({ stored: [], request });
    assert.deepEqual(out.constraints, request);
  });

  test('exclude_exercises is the case-insensitive union, request first', () => {
    const out = resolveConstraints({
      stored: [row('preference', 'leg press', 'avoid'), row('preference', 'Dips', 'avoid')],
      request: { exclude_exercises: ['Leg Press'] },
    });
    assert.deepEqual(out.constraints.exclude_exercises, ['Leg Press', 'Dips']);
  });

  test('single injury slot: request injury wins; losers are surfaced, not silent', () => {
    const out = resolveConstraints({
      stored: [row('injury', 'knee', 'avoid', '2026-06-01')],
      request: { injury: 'shoulder' },
    });
    assert.equal(out.constraints.injury, 'shoulder');
    assert.ok(out.ignored.some(i => i.reason === 'single_injury_slot_v1'));
  });

  test('single injury slot: most recent stored injury wins without a request', () => {
    const out = resolveConstraints({
      stored: [row('injury', 'knee', 'avoid', '2026-06-01'), row('injury', 'shoulder', 'avoid', '2026-07-01')],
    });
    assert.equal(out.constraints.injury, 'shoulder');
    assert.ok(out.ignored.some(i => i.reason === 'single_injury_slot_v1'));
  });

  test('request equipment intersects stored allowances', () => {
    const out = resolveConstraints({
      stored: [row('equipment', 'barbell', 'avoid')],
      request: { equipment: ['Barbell', 'dumbbell'] },
    });
    assert.deepEqual(out.constraints.equipment, ['dumbbell']);
  });

  test('hard equipment conflict: the request (present-tense truth) wins, recorded', () => {
    const out = resolveConstraints({
      stored: [row('equipment', 'dumbbells', 'avoid')],
      request: { equipment: ['dumbbell'] },
    });
    assert.deepEqual(out.constraints.equipment, ['dumbbell']);
    assert.ok(out.ignored.some(i => i.reason === 'equipment_conflict_request_wins'));
  });

  test('no stored equipment rules → the request equipment (or absence) passes through untouched', () => {
    assert.equal(resolveConstraints({ stored: [] }).constraints.equipment, undefined);
    assert.deepEqual(
      resolveConstraints({ stored: [], request: { equipment: ['bands'] } }).constraints.equipment,
      ['bands']
    );
  });
});

describe('constraintResolver — contract alignment', () => {
  test('resolved constraints validate inside a best_workout IntentEnvelope', () => {
    const out = resolveConstraints({
      stored: [
        row('injury', 'shoulder', 'avoid'),
        row('equipment', 'machines', 'avoid'),
        row('preference', 'Behind-the-neck Press', 'avoid'),
      ],
      request: { focus: 'full_body', duration_minutes: 45 },
    });
    const envelope = buildIntentEnvelope({
      type: 'best_workout', source: 'button', actor: 'user',
      asOf: '2026-07-02T12:00:00Z', constraints: out.constraints,
    });
    const verdict = validateIntentEnvelope(envelope);
    assert.equal(verdict.valid, true, JSON.stringify(verdict.errors || verdict));
  });

  test('applied provenance covers every mapped row (applied ∪ ignored = stored)', () => {
    const stored = [
      row('injury', 'knee', 'avoid'),
      row('equipment', 'cables', 'avoid'),
      row('preference', 'Dips', 'substitute'),
      row('mood', 'monday', 'avoid'),
    ];
    const out = resolveConstraints({ stored });
    assert.equal(out.applied.length, 3);
    assert.equal(out.ignored.filter(i => i.reason === 'unknown_kind').length, 1);
  });
});
