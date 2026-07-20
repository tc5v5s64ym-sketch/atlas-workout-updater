'use strict';

// Drift Guard 6 — PAPER-WEIGHT GUARD (Phase 2).
// BACKLOG.md must not exceed the committed shrink-only line cap.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, countLines } = require('../scripts/check-paper-weight');

const cfg = (n) => ({ backlog_max_lines: n, _note: 'shrink-only size cap; raises need a recorded justification.' });
const backlogOf = (n) => 'x\n'.repeat(n); // n newlines → countLines === n

// A fixed reference "today" so staleness tests never depend on the wall clock.
const TODAY = new Date('2026-07-20T12:00:00Z');
const daysAgo = (n) => {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

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

  // --- Staleness sub-rule: [archive-ready: DATE] tags older than 7 days fail. ---

  it('passes when no item is tagged [archive-ready] (the current file state)', () => {
    const r = analyze({ config: cfg(100), backlog: '- shipped thing\n- open thing\n', today: TODAY });
    assert.equal(r.valid, true);
    assert.equal(r.archiveReady, 0);
    assert.equal(r.stale, 0);
  });

  it('passes a fresh archive-ready tag (<= 7 days old)', () => {
    const fresh = `- done [archive-ready: ${daysAgo(0)}]\n- also [archive-ready: ${daysAgo(7)}]\n`;
    const r = analyze({ config: cfg(100), backlog: fresh, today: TODAY });
    assert.equal(r.valid, true, r.errors && r.errors.join(' | '));
    assert.equal(r.archiveReady, 2);
    assert.equal(r.stale, 0);
  });

  it('fails when an archive-ready tag is older than 7 days', () => {
    const stale = `- lingering [archive-ready: ${daysAgo(8)}]\n`;
    const r = analyze({ config: cfg(100), backlog: stale, today: TODAY });
    assert.equal(r.valid, false);
    assert.equal(r.stale, 1);
    assert.ok(r.errors.some((e) => e.includes('archive-ready') && e.includes('older than')));
    assert.ok(r.errors.some((e) => e.includes('archive:backlog')));
  });

  it('fails on a malformed archive-ready date (never silently passes)', () => {
    const bad = '- oops [archive-ready: 2026-13-45]\n';
    const r = analyze({ config: cfg(100), backlog: bad, today: TODAY });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('malformed')));
  });

  it('reports both a cap overflow and a stale tag together', () => {
    const both = `- x [archive-ready: ${daysAgo(30)}]\n` + backlogOf(200);
    const r = analyze({ config: cfg(100), backlog: both, today: TODAY });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('BACKLOG.md has')));
    assert.ok(r.errors.some((e) => e.includes('older than')));
  });
});
