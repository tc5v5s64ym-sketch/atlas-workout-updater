'use strict';

// Soul Plan PR-B2 — register permissions golden + property tests.
//
// Pins the iron invariants (D1–D5, config/coaching/register.calibration.json):
// casual-by-default except safety/refuse; humor only in low-stakes modes;
// profanity reachable ONLY in the celebrate × max × scarcity-clear × owner-
// ceiling cell; max only for celebrate (+ owner-enabled comeback-beat praise);
// safety forces the fully-conservative grant; totality (garbage → conservative,
// never a throw). Plus: the calibration file schema-validates, a malformed
// shape fails fast, and the mode vocabulary stays in lockstep with coachMode.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  grantRegister,
  validateCalibration,
  KNOWN_MODES,
  CALIBRATION,
} = require('../services/registerPermissions');
const { COACH_MODES } = require('../services/coachMode');

const CLEAR = { scarcityClear: true };
const SPENT = { scarcityClear: false };

test('mode vocabulary stays in lockstep with services/coachMode.js', () => {
  assert.deepEqual([...KNOWN_MODES].sort(), [...COACH_MODES].sort(),
    'registerPermissions and coachMode must agree on the mode vocabulary');
});

test('calibration file: shipped data validates; malformed shapes fail fast', () => {
  assert.equal(validateCalibration(CALIBRATION), CALIBRATION);
  assert.throws(() => validateCalibration(null), /invalid/);
  assert.throws(() => validateCalibration({ schema_version: 2 }), /schema_version/);
  // The D1 profanity cell is pinned IN THE SCHEMA — a config edit that moves the
  // certified cell (e.g. to praise, or dropping the scarcity requirement) is
  // rejected at load, not silently obeyed.
  const drifted = JSON.parse(JSON.stringify(CALIBRATION));
  drifted.profanity.requires.mode = 'praise';
  assert.throws(() => validateCalibration(drifted), /celebrate/);
});

// ── Iron invariants, table-driven across every mode ───────────────────────────

test('safety and refuse force the fully-conservative grant', () => {
  for (const mode of ['safety', 'refuse']) {
    assert.deepEqual(grantRegister({ mode, scarcity: CLEAR }), {
      intensity: 'routine', casual_ok: false, humor_ok: false, profanity_ok: false,
    }, mode);
  }
});

test('casual_ok is true by default (the register, not a reward) except safety/refuse', () => {
  for (const mode of KNOWN_MODES) {
    const { casual_ok } = grantRegister({ mode });
    const expected = mode !== 'safety' && mode !== 'refuse';
    assert.equal(casual_ok, expected, `casual_ok for ${mode}`);
  }
});

test('humor_ok only in low-stakes modes; never correct/challenge/safety/reassure/refuse or celebrations', () => {
  for (const mode of KNOWN_MODES) {
    const { humor_ok } = grantRegister({ mode });
    const expected = ['nod', 'note', 'educate'].includes(mode);
    assert.equal(humor_ok, expected, `humor_ok for ${mode}`);
  }
});

test('max intensity only for celebrate — plus the owner-enabled comeback-beat praise', () => {
  for (const mode of KNOWN_MODES) {
    const { intensity } = grantRegister({ mode, scarcity: CLEAR });
    if (mode === 'celebrate') assert.equal(intensity, 'max', mode);
    else if (['praise', 'challenge'].includes(mode)) assert.equal(intensity, 'elevated', mode);
    else assert.equal(intensity, 'routine', mode);
  }
  // The D1 second certified moment: an earned comeback beat may carry MAX energy…
  const comeback = grantRegister({ mode: 'praise', scarcity: CLEAR, moment: { comeback_beat: true } });
  assert.equal(comeback.intensity, 'max');
  // …but NOT profanity (celebrate is the only profanity cell in this module).
  assert.equal(comeback.profanity_ok, false, 'comeback-beat praise never grants profanity here');
  // Owner can switch the comeback max off.
  const disabled = grantRegister({ mode: 'praise', scarcity: CLEAR, moment: { comeback_beat: true }, ownerPrefs: { max_on_comeback_beat_praise: false } });
  assert.equal(disabled.intensity, 'elevated');
});

// ── The profanity property: enumerate the whole space, one certified cell ─────

test('property: no path grants profanity outside celebrate × max × scarcity-clear × owner-ceiling', () => {
  const scarcities = [undefined, null, true, false, CLEAR, SPENT, { scarcityClear: 'yes' }, {}];
  const prefCorners = [undefined, {}, { profanity_enabled: false }, { profanity_enabled: true },
    { max_on_comeback_beat_praise: false }, { profanity_enabled: false, max_on_comeback_beat_praise: false }];
  const moments = [undefined, {}, { comeback_beat: true }, { comeback_beat: 'yes' }];
  let granted = 0;
  for (const mode of [...KNOWN_MODES, 'made_up_mode', undefined, 42]) {
    for (const scarcity of scarcities) {
      for (const ownerPrefs of prefCorners) {
        for (const moment of moments) {
          const g = grantRegister({ mode, scarcity, ownerPrefs, moment });
          // Every grant is shape-valid (total function).
          assert.ok(['routine', 'elevated', 'max'].includes(g.intensity));
          assert.equal(typeof g.casual_ok, 'boolean');
          assert.equal(typeof g.humor_ok, 'boolean');
          assert.equal(typeof g.profanity_ok, 'boolean');
          if (g.profanity_ok) {
            granted++;
            assert.equal(mode, 'celebrate', 'profanity outside celebrate');
            assert.equal(g.intensity, 'max', 'profanity outside max');
            const clear = scarcity === true || (scarcity && scarcity.scarcityClear === true);
            assert.equal(clear, true, 'profanity without explicit scarcity clear');
            assert.notEqual(ownerPrefs && ownerPrefs.profanity_enabled, false, 'profanity past a disabled ceiling');
          }
        }
      }
    }
  }
  assert.ok(granted > 0, 'the certified cell itself must be reachable (control)');
});

test('profanity: absent or ambiguous scarcity reads as NOT clear (conservative)', () => {
  assert.equal(grantRegister({ mode: 'celebrate' }).profanity_ok, false, 'no scarcity input → no profanity');
  assert.equal(grantRegister({ mode: 'celebrate', scarcity: SPENT }).profanity_ok, false);
  assert.equal(grantRegister({ mode: 'celebrate', scarcity: { scarcityClear: 'yes' } }).profanity_ok, false);
  assert.equal(grantRegister({ mode: 'celebrate', scarcity: CLEAR }).profanity_ok, true, 'control: the certified cell grants');
  assert.equal(grantRegister({ mode: 'celebrate', scarcity: true }).profanity_ok, true, 'boolean shorthand accepted');
});

test('totality: garbage input → the most-conservative grant, never a throw', () => {
  for (const input of [undefined, null, {}, { mode: 'made_up' }, { mode: 42 }, { mode: ['celebrate'] }]) {
    assert.deepEqual(grantRegister(input), {
      intensity: 'routine', casual_ok: false, humor_ok: false, profanity_ok: false,
    }, JSON.stringify(input));
  }
});
