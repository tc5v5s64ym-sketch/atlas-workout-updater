'use strict';

// Drift Guard 6 — PAPER-WEIGHT GUARD (Phase 2).
// BACKLOG.md must not exceed the committed shrink-only line cap.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, countLines } = require('../scripts/check-paper-weight');

const cfg = (n) => ({ backlog_max_lines: n, _note: 'shrink-only size cap; raises need a recorded justification.' });
const backlogOf = (n) => 'x\n'.repeat(n); // n newlines → countLines === n

describe('Drift Guard 6 — paper-weight', () => {
  it('passes on the real repository (BACKLOG within its cap)', () => {
    const r = analyze();
    assert.equal(r.valid, true, r.errors && r.errors.join(' | '));
  });

  it('passes at or below the cap (a trim is fine)', () => {
    assert.equal(analyze({ config: cfg(100), backlog: backlogOf(100) }).valid, true);
    assert.equal(analyze({ config: cfg(100), backlog: backlogOf(60) }).valid, true);
  });

  it('fails when BACKLOG exceeds the cap', () => {
    const r = analyze({ config: cfg(100), backlog: backlogOf(101) });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('BACKLOG.md has')));
  });

  it('fails when the cap is missing or not a positive integer', () => {
    assert.equal(analyze({ config: { _note: 'x' }, backlog: backlogOf(1) }).valid, false);
    assert.equal(analyze({ config: { backlog_max_lines: 0, _note: 'x' }, backlog: backlogOf(1) }).valid, false);
  });

  it('fails when the config note is missing', () => {
    assert.equal(analyze({ config: { backlog_max_lines: 100 }, backlog: backlogOf(1) }).valid, false);
  });

  it('countLines matches wc -l semantics (newline count)', () => {
    assert.equal(countLines('a\nb\nc\n'), 3);
    assert.equal(countLines(''), 0);
  });
});
