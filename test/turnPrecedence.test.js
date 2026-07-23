'use strict';

// Phase 4 first concern — services/turnPrecedence.js.
//
// ONE authoritative current-message decision owns whether a turn requests a substitution,
// retiring the substitution lane's route-local `intent || isConstraintMessage` interpretation
// that let a malfunction complaint ("Are you broken?" — /\bbroken\b/) invoke substitution and
// contradict the active plan (Phase-3 divergence summary, FR-20260723120852-hw56ws9y turn 4).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { decideTurnPrecedence, isTurnPrecedenceEnabled, LANES } = require('../services/turnPrecedence');

describe('turnPrecedence — decideTurnPrecedence', () => {
  it('a malfunction complaint is an aside, NOT a substitution (the FR turn-4 fix)', () => {
    // "Are you broken?" trips isConstraintMessage (/\bbroken\b/) but is authoritatively a
    // malfunction aside, so it must not invoke substitution.
    const d = decideTurnPrecedence({ message: 'Are you broken?' });
    assert.equal(d.lane, LANES.ASIDE);
    assert.equal(d.allowSubstitution, false);
  });

  it('a greeting / presence check cannot invoke substitution', () => {
    for (const m of ['Hello atlas are you there?', 'hey', 'you there?']) {
      const d = decideTurnPrecedence({ message: m });
      assert.equal(d.allowSubstitution, false, `"${m}" must not authorize a substitution`);
      assert.equal(d.lane, LANES.ASIDE);
    }
  });

  it('a genuine equipment/exercise constraint IS a substitution (aside guard yields to a named lift)', () => {
    // "the bench is broken" contains a lift word, so the aside guard vetoes the aside and it
    // resolves as a real constraint — substitution proceeds.
    const d = decideTurnPrecedence({ message: 'the bench is broken' });
    assert.equal(d.lane, LANES.SUBSTITUTION);
    assert.equal(d.allowSubstitution, true);
  });

  it('the rack being taken is a constraint substitution', () => {
    const d = decideTurnPrecedence({ message: 'the squat rack is taken' });
    assert.equal(d.allowSubstitution, true);
    assert.equal(d.lane, LANES.SUBSTITUTION);
  });

  it('an explicit substitute intent from the client is authoritative even without a constraint keyword', () => {
    const d = decideTurnPrecedence({ message: 'swap rdls out for bench press', intent: 'substitute' });
    assert.equal(d.lane, LANES.SUBSTITUTION);
    assert.equal(d.allowSubstitution, true);
  });

  it('a prescription question is not a substitution (falls through — never reaches the substitute recommender)', () => {
    const d = decideTurnPrecedence({ message: 'What weight and how many reps?' });
    assert.equal(d.lane, LANES.NONE);
    assert.equal(d.allowSubstitution, false);
  });

  it('a warm-up question is not a substitution', () => {
    const d = decideTurnPrecedence({ message: 'No warm up sets for bench?' });
    assert.equal(d.allowSubstitution, false);
  });

  it('a clarification is not a substitution', () => {
    const d = decideTurnPrecedence({ message: 'Whoa, I was just asking for bench' });
    assert.equal(d.allowSubstitution, false);
  });

  it('the aside veto outranks a coincidental constraint keyword even with an explicit intent tag', () => {
    // Defense in depth: a malfunction aside must never substitute even if the client mistagged it.
    const d = decideTurnPrecedence({ message: 'ugh you are broken again', intent: 'substitute' });
    assert.equal(d.lane, LANES.ASIDE);
    assert.equal(d.allowSubstitution, false);
  });

  it('is total on malformed input', () => {
    assert.equal(decideTurnPrecedence(null).allowSubstitution, false);
    assert.equal(decideTurnPrecedence({}).allowSubstitution, false);
    assert.equal(decideTurnPrecedence({ message: 42 }).allowSubstitution, false);
    assert.equal(decideTurnPrecedence({ message: '' }).lane, LANES.NONE);
  });
});

describe('turnPrecedence — isTurnPrecedenceEnabled', () => {
  it('is inert by default (absent / off) — the live route is unchanged until the owner gate', () => {
    assert.equal(isTurnPrecedenceEnabled({}), false);
    assert.equal(isTurnPrecedenceEnabled({ ATLAS_TURN_PRECEDENCE: '' }), false);
    assert.equal(isTurnPrecedenceEnabled({ ATLAS_TURN_PRECEDENCE: 'off' }), false);
    assert.equal(isTurnPrecedenceEnabled({ ATLAS_TURN_PRECEDENCE: 'shadow' }), false);
  });

  it('enables on the documented on-values', () => {
    for (const v of ['on', 'On', 'ON', '1', 'true', 'enforce', 'enabled']) {
      assert.equal(isTurnPrecedenceEnabled({ ATLAS_TURN_PRECEDENCE: v }), true, `"${v}" should enable`);
    }
  });
});
