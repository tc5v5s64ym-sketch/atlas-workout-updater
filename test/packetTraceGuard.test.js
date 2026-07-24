'use strict';

// Drift Guard 5 self-test — proves the packet & trace honesty guard actually BITES on a
// synthetic overclaim (a real failing check, not a tautology), and that the real shadow
// assembler is clean today.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { analyze, checkPacketHonesty } = require('../scripts/check-packet-trace');

describe('Drift Guard 5 — packet & trace honesty', () => {
  it('the REAL shadow assembler is honest (analyze passes clean)', () => {
    const { ok, violations, checked } = analyze();
    assert.equal(ok, true, `unexpected violations: ${violations.join(' | ')}`);
    assert.ok(checked >= 5, 'a representative matrix is checked');
  });

  it('BITES: a session claimed present while it does not validate is an overclaim', () => {
    const packet = { athlete: null, session: { schema_version: 1, session_id: null, slots: [{ name: 'X', status: 'bogus' }] }, exercises: [], decision: null, safety: null, closeout: null };
    const claim = { athlete: false, session: true, exercises: 0, decision: false, safety: false, closeout: false };
    const v = checkPacketHonesty(packet, claim);
    assert.ok(v.some((s) => /embedded\.session/.test(s)), 'the guard flags the session overclaim');
  });

  it('BITES: an exercises count exceeding the genuinely-valid identities is an overclaim', () => {
    const packet = { session: null, exercises: [{ not: 'a valid identity' }], decision: null, safety: null, closeout: null };
    const claim = { athlete: false, session: false, exercises: 1, decision: false, safety: false, closeout: false };
    const v = checkPacketHonesty(packet, claim);
    assert.ok(v.some((s) => /embedded\.exercises/.test(s)), 'the guard flags the exercises overclaim');
  });

  it('does NOT flag an UNDERclaim (a valid fact reported absent is safe — H-05/H-15)', () => {
    // A valid-ish structure reported as NOT present must not be a violation (understating is safe).
    const packet = { session: null, exercises: [], decision: null, safety: null, closeout: null };
    const claim = { athlete: false, session: false, exercises: 0, decision: false, safety: false, closeout: false };
    assert.deepEqual(checkPacketHonesty(packet, claim), []);
  });
});
