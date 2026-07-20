'use strict';

// Drift Guard 3 — WIRING GUARD HARDENED (Phase 2).
// The staged allowlist is shrink-only: `modules` may never exceed
// staged_modules_ceiling, and the ceiling carries an owner-gate note.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../scripts/check-allowlist-ratchet');

const mods = (n) => Array.from({ length: n }, (_, i) => ({ file: `services/m${i}.js`, expires: '2026-12-31', roadmap: 'x' }));
const good = (n = 3, ceiling = 3) => ({ staged_modules_ceiling: ceiling, _ceiling_note: 'shrink-only ratchet; raises need an owner-gate note.', modules: mods(n) });

describe('Drift Guard 3 — wiring-guard ratchet', () => {
  it('passes on the real repository (count within the committed ceiling)', () => {
    const r = analyze();
    assert.equal(r.valid, true, r.errors && r.errors.join(' | '));
  });

  it('passes when the count is at or below the ceiling', () => {
    assert.equal(analyze(good(3, 3)).valid, true);
    assert.equal(analyze(good(2, 3)).valid, true); // a removal is fine (shrink)
  });

  it('fails when modules grow past the ceiling', () => {
    const r = analyze(good(4, 3));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('shrink-only ratchet')));
  });

  it('fails when the ceiling is missing or not a non-negative integer', () => {
    assert.equal(analyze({ _ceiling_note: 'x', modules: mods(2) }).valid, false);
    assert.equal(analyze({ staged_modules_ceiling: -1, _ceiling_note: 'x', modules: mods(0) }).valid, false);
  });

  it('fails when the owner-gate ceiling note is missing', () => {
    assert.equal(analyze({ staged_modules_ceiling: 3, modules: mods(2) }).valid, false);
  });

  it('fails closed on a malformed allowlist', () => {
    assert.equal(analyze({}).valid, false);
    assert.equal(analyze({ modules: 'nope' }).valid, false);
  });
});
