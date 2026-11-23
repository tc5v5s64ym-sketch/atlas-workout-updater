'use strict';

// Issue #1769 — [P2][Astra D06] Correction extraction binds the wrong
// actor's number; stale provenance markers bless replacements.
//
// Regression family of #1737/#1732. The #1737 resolver takes the FIRST
// number-with-unit in the athlete's message, whoever stated it and whenever:
// 'my friend lifted 315 lb; my set was actually 140 lb' resolves to 315
// (the friend's number), and a stale userEdited marker on the field lets
// the buffer fold the replacement in as athlete-typed (#1732's fix only
// stops applyProposedEdit STAMPING the marker — it never cleared a marker
// that predated the edit).
//
// Invariant: only explicit current-athlete correction claims are parsed, or
// ambiguity is refused. Provenance belongs to a value/version, not
// permanently to its input element.
//
// Acceptance probes D06-F1..F7 (resolver) + the stale-marker E2E probe in
// tests/e2e/propose-edit-stale-provenance-1769.spec.js. Written against the
// fixed behavior FIRST (failing-first at base b557bb44: every F-probe below
// resolves to the wrong actor's number, a signed/fraction/kg number, or a
// non-null edit).

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveProposeEdit, extractAthleteValues } = require('../services/proposeEditResolver');

// Two logged Bench sets, as currentPreviewRowsForChat sends them.
const PREVIEW = [
  { exercise: 'Bench Press', weight: 135, reps: 5, rir: 2 },
  { exercise: 'Bench Press', weight: 135, reps: 5, rir: 2 },
];
const MODEL_EDIT = { action: 'update_set', index: 0, weight: 410, reps: 12, rir: 0 };

test('D06-F1. friend/other-actor: the friend\'s 315 never binds; the athlete\'s 140 does', () => {
  assert.deepEqual(
    resolveProposeEdit(MODEL_EDIT, 'my friend lifted 315 lb; my set was actually 140 lb', PREVIEW),
    { action: 'update_set', index: 0, weight: 140 },
  );
  assert.deepEqual(
    resolveProposeEdit(MODEL_EDIT, 'he did 405 lb, mine was 315 lb', PREVIEW),
    { action: 'update_set', index: 0, weight: 315 },
  );
  assert.deepEqual(
    resolveProposeEdit(MODEL_EDIT, 'my spotter hit 225 lb and I did 185 lb', PREVIEW),
    { action: 'update_set', index: 0, weight: 185 },
  );
  // A message that states ONLY another actor's number carries no athlete value.
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'my friend lifted 315 lb', PREVIEW),
    null,
  );
});

test('D06-F2. past: a past-session number never binds as a current correction', () => {
  assert.deepEqual(
    resolveProposeEdit(MODEL_EDIT, 'yesterday I did 315 lb; today my set was actually 140 lb', PREVIEW),
    { action: 'update_set', index: 0, weight: 140 },
  );
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'yesterday I did 315 lb', PREVIEW),
    null,
    'a purely past statement states no current correction — refused, not bound',
  );
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'last time I did 315 lb', PREVIEW),
    null,
  );
});

test('D06-F3. future: a planned number never binds as a current correction', () => {
  assert.deepEqual(
    resolveProposeEdit(MODEL_EDIT, 'I will do 315 lb next set; my set was actually 140 lb', PREVIEW),
    { action: 'update_set', index: 0, weight: 140 },
  );
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'I will lift 315 lb next session', PREVIEW),
    null,
    'a purely future statement states no current correction — refused, not bound',
  );
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'going to hit 315 lb tomorrow', PREVIEW),
    null,
  );
});

test('D06-F4. sign: a signed number is never read as a positive weight', () => {
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'my set was actually -140 lb', PREVIEW),
    null,
    '"-140 lb" is not a 140 lb correction — the sign refuses the value',
  );
  assert.deepEqual(
    extractAthleteValues('really -140'),
    {},
    'a signed shorthand number is dropped, not read positive',
  );
});

test('D06-F5. fraction: a number inside a fraction is never read as a weight', () => {
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'my set was 140 1/2 lb', PREVIEW),
    null,
    '"140 1/2 lb" is not a 2 lb correction — the denominator refuses the value',
  );
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'my set was 140/2 lb', PREVIEW),
    null,
    'a numerator is not a weight either — the fraction refuses the value',
  );
});

test('D06-F6. unit: a kg number is never read as a lb weight (no silent conversion)', () => {
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'my set was actually 140 kg', PREVIEW),
    null,
    '140 kg is not 140 lb — refused, not converted',
  );
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'my set was actually 140 kg; my friend lifted 315 lb', PREVIEW),
    null,
    'the athlete\'s kg value refuses and the friend\'s lb value never binds',
  );
  assert.deepEqual(
    resolveProposeEdit(MODEL_EDIT, 'my friend did 140 kg; I did 315 lb', PREVIEW),
    { action: 'update_set', index: 0, weight: 315 },
    'the athlete\'s own lb number still binds when the kg number belongs to the friend',
  );
});

test('D06-F7. ambiguity is refused: two different current-athlete weights bind nothing', () => {
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'my set was 140, actually 150', PREVIEW),
    null,
    'two conflicting corrections in one message refuse the weight, not first-match it',
  );
});

test('D06-F8. thousands: a thousands head is never read as the whole number', () => {
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'really 1,000', PREVIEW),
    null,
    '"1,000" is not a 1 lb correction — the thousands head refuses the value',
  );
  assert.deepEqual(
    extractAthleteValues('actually 137.5 lb'),
    { weight: 137.5 },
    'a decimal weight still binds',
  );
  assert.deepEqual(
    extractAthleteValues('my set was 140, 8 reps'),
    { weight: 140, reps: 8 },
    'a comma followed by a space is a clause break, not a thousands group',
  );
});

test('D06-C1. controls — the #1737 pinned behaviors still bind', () => {
  assert.deepEqual(extractAthleteValues('really 140'), { weight: 140 });
  assert.deepEqual(extractAthleteValues('change set 1 to 235'), { weight: 235 });
  assert.deepEqual(extractAthleteValues('make it 140x8 rir 2'), { weight: 140, reps: 8, rir: 2 });
  assert.deepEqual(extractAthleteValues('that was 8 reps'), { reps: 8 });
  assert.deepEqual(extractAthleteValues('actually 137.5 lb'), { weight: 137.5 });
  assert.deepEqual(extractAthleteValues('yeah that looks right'), {});
  assert.deepEqual(extractAthleteValues('really 5000'), {});
  assert.deepEqual(
    resolveProposeEdit(MODEL_EDIT, 'my set was actually 140 lb, not 315 lb', PREVIEW),
    { action: 'update_set', index: 0, weight: 140 },
    'an explicitly negated number never binds and never creates a conflict',
  );
  assert.deepEqual(
    resolveProposeEdit(MODEL_EDIT, 'my friend lifted 315 lb; my set was actually 140x8', PREVIEW),
    { action: 'update_set', index: 0, weight: 140, reps: 8 },
    'the athlete\'s own WxR still binds beside a friend clause',
  );
});

// Pre-review regressions (fresh-context adversarial pass on head 9f893a07:
// NOT READY, 5 blocking + 3 advisory). Each P-probe failed on 9f893a07
// (verified by direct execution) and passes with the fixes in
// services/proposeEditResolver.js. A1 (bare proper name binds) is a
// documented limitation, not a probe: the text is lowercased first, so no
// deterministic fix exists. A4 (applyUpdateToLastRow keeps the marker) is
// intentionally not fixed: that value is deterministic athlete-parsed text,
// and clearing the marker there would drop the athlete's update on rebuild.

test('D06-P1. REGRESSION (pre-review B1): a WxR weight with a trailing unit keeps the weight', () => {
  assert.deepEqual(extractAthleteValues('my set was 140x8 lb'), { weight: 140, reps: 8 });
  assert.deepEqual(extractAthleteValues('my set was 140 x 8 lb'), { weight: 140, reps: 8 });
  assert.deepEqual(extractAthleteValues('my set was 140x8 pounds'), { weight: 140, reps: 8 });
  assert.deepEqual(extractAthleteValues('my set was 140x8lb'), { weight: 140, reps: 8 });
  assert.deepEqual(extractAthleteValues('my set was 140x8, 8 lb'), { weight: 140, reps: 8 });
  assert.deepEqual(
    resolveProposeEdit(MODEL_EDIT, 'my set was 140x8 lb', PREVIEW),
    { action: 'update_set', index: 0, weight: 140, reps: 8 },
  );
});

test('D06-P2. kg via WxR (pre-review B2): a WxR stated in kg never binds as lb', () => {
  assert.deepEqual(extractAthleteValues('my set was 140x8 kg'), {});
  assert.deepEqual(extractAthleteValues('my set was 140 x 8 kg'), {});
});

test('D06-P3. digit fraction-of (pre-review B3): "1/2 of 140 lb" is 70 lb, never 140', () => {
  assert.deepEqual(extractAthleteValues('my set was 1/2 of 140 lb'), {});
  assert.deepEqual(extractAthleteValues('my set was 3/4 of 200 lb'), {});
});

test('D06-P4. "or" ambiguity (pre-review B4): "140 or 150" binds neither', () => {
  assert.deepEqual(extractAthleteValues('my set was 140 or 150'), {});
  assert.deepEqual(extractAthleteValues('my set was 140, or 150'), {});
  assert.deepEqual(
    extractAthleteValues('my set was 140 lb or 8 reps'),
    { weight: 140, reps: 8 },
    'an "or" across different fields still binds both',
  );
});

test('D06-P5. longer role phrases (pre-review B5): a three-word role still belongs to the other actor', () => {
  assert.equal(
    resolveProposeEdit(MODEL_EDIT, 'my very old gym buddy did 315 lb', PREVIEW),
    null,
  );
  assert.deepEqual(
    resolveProposeEdit(MODEL_EDIT, 'my very old gym buddy did 315 lb; my set was 140 lb', PREVIEW),
    { action: 'update_set', index: 0, weight: 140 },
  );
});

test('D06-P6. unicode minus (pre-review A2): an en-dash/minus-signed number is dropped like ASCII "-"', () => {
  assert.deepEqual(extractAthleteValues('my set was –140 lb'), {});
  assert.deepEqual(extractAthleteValues('my set was −140 lb'), {});
});
