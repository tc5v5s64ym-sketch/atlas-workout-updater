'use strict';

// Soul Plan PR-B4 slice 3 — profanity + its deterministic guards.
//
// Pins the three-layer defense that makes profanity safe:
//   (1) grantRegister's certified cell (celebrate × max × scarcity-clear × enabled);
//   (2) the engine-confirmed-new_ground route gate (confirmTodayNewGround) — a
//       client-forged verdict can't reach the cell;
//   (3) the finalizeCoachVoice suppressor (findRegisterViolations) — the final net
//       that strips profanity the model emits without the granted permission, and
//       celebration/PR vocabulary outside an earned moment.
// Plus the production default: profanity is OFF unless ATLAS_COACH_PROFANITY=on.

const test = require('node:test');
const assert = require('node:assert/strict');

const { findRegisterViolations } = require('../services/coach');
const { grantRegister } = require('../services/registerPermissions');
const { confirmTodayNewGround } = require('../services/liveIntelligence');

// 12-col Log_Cleaned row helper.
function row(date, sessionId, canonical, liftCode, weight, reps, { rir = 2, notes = '' } = {}) {
  return [date, sessionId, canonical, canonical, 'Chest', liftCode, 1, weight, reps, rir, notes, weight * reps];
}

// ── (3) the suppressor: findRegisterViolations ────────────────────────────────

test('suppressor: profanity in prose is a violation unless profanity_ok is granted', () => {
  const withProfanity = 'That was a shit-hot pull.';
  assert.ok(findRegisterViolations(withProfanity, { mode: 'celebrate', register: { profanity_ok: false } })
    .some(v => v.code === 'profanity_without_permission'), 'profanity without the permission is a violation');
  assert.equal(findRegisterViolations(withProfanity, { mode: 'celebrate', register: { profanity_ok: true } })
    .filter(v => v.code === 'profanity_without_permission').length, 0,
    'granted profanity is allowed');
  // No register at all → treated as not granted.
  assert.ok(findRegisterViolations(withProfanity, { mode: 'celebrate' }).some(v => v.code === 'profanity_without_permission'));
  // Clean prose → no violation.
  assert.deepEqual(findRegisterViolations('Solid work — right on target.', { mode: 'note', register: { profanity_ok: false } }), []);
});

test('suppressor: MILD casual words (hell/damn/crap) are NOT treated as profanity (review #948 narrowing)', () => {
  // These double as normal coaching prose and are casual register, not the D1
  // swearing gate — they must pass even when profanity is ungranted.
  for (const line of ['That was a hell of a set.', 'Damn good work.', 'Your form on that last rep was crap.']) {
    assert.deepEqual(
      findRegisterViolations(line, { mode: 'note', register: { profanity_ok: false } }), [],
      `"${line}" is casual register, not profanity`);
  }
  // But genuine profanity still fires — incl. the one-word 'dickhead' (review #948).
  for (const bad of ['That was fucking strong.', 'Don\'t be a dickhead about the rest times.', 'dickheads everywhere']) {
    assert.ok(findRegisterViolations(bad, { mode: 'note', register: { profanity_ok: false } })
      .some(v => v.code === 'profanity_without_permission'), `"${bad}" must fire`);
  }
});

test('suppressor: celebration/PR vocabulary is a violation outside celebrate/praise', () => {
  const pr = 'That was a new PR — personal best!';
  assert.ok(findRegisterViolations(pr, { mode: 'note', register: { profanity_ok: false } })
    .some(v => v.code === 'celebration_vocab_outside_earned_mode'), 'PR language in a note is a violation');
  assert.equal(findRegisterViolations(pr, { mode: 'celebrate', register: { profanity_ok: false } })
    .filter(v => v.code === 'celebration_vocab_outside_earned_mode').length, 0, 'PR language in celebrate is fine');
  assert.equal(findRegisterViolations(pr, { mode: 'praise', register: { profanity_ok: false } })
    .filter(v => v.code === 'celebration_vocab_outside_earned_mode').length, 0, 'PR language in praise is fine');
});

test('suppressor: chat may cite a personal best fact but may not invent a new earned event', () => {
  const chatCtx = {
    mode: 'silent',
    register: { profanity_ok: false },
    allow_personal_best_reference: true,
    personal_best_facts: [{ exercise: 'Bench Press', weight: 225, reps: 5 }],
  };
  assert.deepEqual(
    findRegisterViolations('Your personal best on Bench Press is 225 x 5.', chatCtx),
    [],
    'an exact engine-owned historical fact remains answerable in free-form chat'
  );
  for (const groundedVariant of [
    'Your Bench Press personal best is 225 × 5.',
    'Your personal best on bench is 225 × 5.',
  ]) {
    assert.deepEqual(
      findRegisterViolations(groundedVariant, chatCtx),
      [],
      `natural wording and a deterministic lift alias must preserve the engine-owned fact: ${groundedVariant}`
    );
  }
  for (const invented of [
    'Your personal best on Bench Press is 405 x 5.',
    'Your personal best on Back Squat is 225 x 5.',
    'Your personal best on Bench Press is 225 x 8.',
  ]) {
    assert.ok(
      findRegisterViolations(invented, chatCtx)
        .some(v => v.code === 'celebration_vocab_outside_earned_mode'),
      `non-engine personal-best fact must remain blocked: ${invented}`
    );
  }
  assert.ok(
    findRegisterViolations('That is a new record — you crushed it.', chatCtx)
      .some(v => v.code === 'celebration_vocab_outside_earned_mode'),
    'new-event and hype language remains blocked outside an earned mode'
  );
  for (const unearned of [
    'That was your personal best!',
    'You just hit a personal best.',
    'You just set it — your personal best is 225.',
    'Your personal best is 225, and you achieved it today.',
    'Your personal best on bench is 225 — and you just hit it.',
  ]) {
    assert.ok(
      findRegisterViolations(unearned, chatCtx)
        .some(v => v.code === 'celebration_vocab_outside_earned_mode'),
      `current-event claim must remain blocked: ${unearned}`
    );
  }
});

test('suppressor: profanity_only (plan voice) strips profanity but allows a real PR reference', () => {
  // The plan "why today" voice may legitimately cite a personal best in its rationale.
  const planPr = 'Today pushes toward your personal best on bench.';
  assert.deepEqual(findRegisterViolations(planPr, { mode: null, register: { profanity_ok: false }, profanity_only: true }), [],
    'a real PR reference in plan rationale must not be suppressed');
  // But profanity is still stripped on the plan voice.
  assert.ok(findRegisterViolations('This fucking session is heavy.', { mode: null, register: { profanity_ok: false }, profanity_only: true })
    .some(v => v.code === 'profanity_without_permission'), 'profanity is still backstopped on the plan voice');
  // Without profanity_only, the same PR reference IS suppressed (set-reaction default).
  assert.ok(findRegisterViolations(planPr, { mode: 'note', register: { profanity_ok: false } })
    .some(v => v.code === 'celebration_vocab_outside_earned_mode'), 'the set-reaction default still gates PR vocab');
});

test('suppressor: totality — empty/garbage input never throws', () => {
  assert.deepEqual(findRegisterViolations('', {}), []);
  assert.deepEqual(findRegisterViolations(null, null), []);
  assert.deepEqual(findRegisterViolations(42, { mode: 'note' }), []);
});

// ── (2) the engine gate: confirmTodayNewGround ────────────────────────────────

const HISTORY = [
  row('2026-05-01', 'S1', 'Bench Press', 'BEN01', 185, 5),
  row('2026-05-08', 'S2', 'Bench Press', 'BEN01', 195, 5),
  row('2026-05-15', 'S3', 'Bench Press', 'BEN01', 205, 5),
];

test('engine gate: confirms new_ground only when today\'s top clears the engine\'s own ceiling', () => {
  // 225 clears the 205 ceiling (and is within the 1.5× plausibility cap) → new_ground.
  assert.equal(confirmTodayNewGround({ liftCode: 'BEN01', todaySets: [{ weight: 225, reps: 3 }] }, HISTORY), true);
  // 200 is within the band, not new ground.
  assert.equal(confirmTodayNewGround({ liftCode: 'BEN01', todaySets: [{ weight: 200, reps: 5 }] }, HISTORY), false);
  // No prior history for the lift → cannot confirm.
  assert.equal(confirmTodayNewGround({ liftCode: 'SQT01', todaySets: [{ weight: 400, reps: 1 }] }, HISTORY), false);
  // Missing inputs → false, never throws.
  assert.equal(confirmTodayNewGround({}, HISTORY), false);
  assert.equal(confirmTodayNewGround({ liftCode: 'BEN01', todaySets: [] }, HISTORY), false);
  assert.equal(confirmTodayNewGround({ liftCode: 'BEN01', todaySets: [{ weight: 225, reps: 3 }] }, null), false);
});

test('engine gate: an ABSURD forged weight is rejected by the plausibility cap (review #948)', () => {
  // todayTop is inherently client-asserted (the just-logged set isn't in the sheet).
  // The gate can't fully verify it, but an implausible "PR" far above the 205 ceiling
  // (a forged / fat-fingered weight) is rejected — killing the 99999-forgery path.
  assert.equal(confirmTodayNewGround({ liftCode: 'BEN01', todaySets: [{ weight: 99999, reps: 1 }] }, HISTORY), false,
    'a wildly implausible weight must not confirm new_ground');
  // 205 * 1.5 = 307.5 → 307 passes, 320 is rejected as implausible.
  assert.equal(confirmTodayNewGround({ liftCode: 'BEN01', todaySets: [{ weight: 305, reps: 1 }] }, HISTORY), true);
  assert.equal(confirmTodayNewGround({ liftCode: 'BEN01', todaySets: [{ weight: 320, reps: 1 }] }, HISTORY), false);
});

// ── (1) the certified cell + the full gate chain (property test) ──────────────

test('property: profanity_ok is granted ONLY in the full certified cell', () => {
  const MODES = ['silent', 'nod', 'note', 'praise', 'celebrate', 'correct', 'challenge', 'reassure', 'educate', 'refuse', 'safety'];
  for (const mode of MODES) {
    for (const scarcityClear of [true, false]) {
      for (const enabled of [true, false]) {
        const g = grantRegister({ mode, scarcity: { scarcityClear }, ownerPrefs: { profanity_enabled: enabled } });
        const shouldGrant = mode === 'celebrate' && scarcityClear === true && enabled === true;
        assert.equal(g.profanity_ok, shouldGrant,
          `profanity_ok for mode=${mode} scarcityClear=${scarcityClear} enabled=${enabled} must be ${shouldGrant}`);
        if (g.profanity_ok) assert.equal(g.intensity, 'max', 'profanity only ever rides max intensity');
      }
    }
  }
});

test('production default: profanity is OFF unless explicitly enabled (env staging)', () => {
  // grantRegister defaults to the calibration file (enabled:true), but the ROUTE
  // passes ownerPrefs.profanity_enabled = (ATLAS_COACH_PROFANITY === 'on'), which is
  // false unless the owner sets it. Simulate the route's default-off call:
  const off = grantRegister({ mode: 'celebrate', scarcity: { scarcityClear: true }, ownerPrefs: { profanity_enabled: false } });
  assert.equal(off.profanity_ok, false, 'default-off env → no profanity even in the celebrate/max/clear cell');
  const on = grantRegister({ mode: 'celebrate', scarcity: { scarcityClear: true }, ownerPrefs: { profanity_enabled: true } });
  assert.equal(on.profanity_ok, true, 'owner-enabled → the certified cell grants it');
});

// ── route-level engine gate (source introspection) ───────────────────────────

const fs = require('node:fs');
const path = require('node:path');
const coachOpsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'coachOps.js'), 'utf8');

test('route: profanity is env-gated off by default AND gated on the engine\'s own new_ground', () => {
  assert.match(coachOpsSrc, /const profanityLive = process\.env\.ATLAS_COACH_PROFANITY === 'on'/,
    'profanity must be env-gated (default off)');
  assert.match(coachOpsSrc, /if \(register\.profanity_ok && !engineNewGround\) register\.profanity_ok = false/,
    'a forged client verdict must be blocked by the engine-confirmed-new_ground gate');
  assert.match(coachOpsSrc, /engineNewGround = confirmTodayNewGround\(rawFacts, allLog\)/,
    'the engine gate must recompute new_ground server-side');
});
