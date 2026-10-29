'use strict';

// Drift Guard 6 — PAPER-WEIGHT GUARD (Phase 2), narrowed 2026-10-28.
// BACKLOG.md is a frozen pointer stub to the GitHub Issues backlog: the guard
// fails if the stub loses its board pointer or grows past its stub bound.
// The pre-migration ledger rules (size cap, [archive-ready] staleness over
// BACKLOG contents) were retired by the 2026-10-28 owner ruling; the
// archive-ready marker helpers remain, shared with the auto-archive job.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, countLines, findArchiveReady, archiveReadyTags } = require('../scripts/check-paper-weight');

const cfg = (n) => ({ backlog_stub_max_lines: n, _note: 'frozen pointer stub bound; see the 2026-10-28 ruling.' });
const POINTER = 'Board: https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues?q=label%3Abacklog\n';
const stubOf = (extraLines) => '# Atlas — Backlog · MOVED TO GITHUB ISSUES\n\n' + POINTER + 'x\n'.repeat(extraLines);

// A fixed reference "today" so helper tests never depend on the wall clock.
const TODAY = new Date('2026-07-20T12:00:00Z');
const daysAgo = (n) => {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

describe('Drift Guard 6 — paper-weight (narrowed: frozen stub integrity)', () => {
  it('passes on the real repository (BACKLOG is the intact pointer stub)', () => {
    const r = analyze();
    assert.equal(r.valid, true, r.errors && r.errors.join(' | '));
  });

  it('passes an intact stub at or below the bound', () => {
    assert.equal(analyze({ config: cfg(40), backlog: stubOf(0) }).valid, true);
    assert.equal(analyze({ config: cfg(40), backlog: stubOf(10) }).valid, true);
  });

  it('fails when the stub grows past its bound (a ledger regrowing in the file)', () => {
    const r = analyze({ config: cfg(5), backlog: stubOf(10) });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('frozen-stub bound')));
  });

  it('fails when the stub loses its Issues-board pointer', () => {
    const r = analyze({ config: cfg(40), backlog: '# Atlas — Backlog\n\n- an item crept back in\n' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('pointer')));
  });

  it('fails when the stub bound is missing or not a positive integer', () => {
    assert.equal(analyze({ config: { _note: 'x' }, backlog: stubOf(0) }).valid, false);
    assert.equal(analyze({ config: { backlog_stub_max_lines: 0, _note: 'x' }, backlog: stubOf(0) }).valid, false);
  });

  it('fails when the config note is missing', () => {
    assert.equal(analyze({ config: { backlog_stub_max_lines: 40 }, backlog: stubOf(0) }).valid, false);
  });

  it('no longer enforces backlog contents: a stale [archive-ready] tag in the stub text is not this guard\'s failure', () => {
    // Staleness over ledger contents was retired with the migration; the tag is
    // now the archive job's signal only. This stub carries an ancient tag but is
    // intact and within bound, so the narrowed guard passes.
    const text = stubOf(0) + `- moved long ago [archive-ready: ${daysAgo(90)}]\n`;
    const r = analyze({ config: cfg(40), backlog: text });
    assert.equal(r.valid, true, r.errors && r.errors.join(' | '));
  });

  it('countLines matches wc -l semantics (newline count)', () => {
    assert.equal(countLines('a\nb\nc\n'), 3);
    assert.equal(countLines(''), 0);
  });
});

describe('Drift Guard 6 — archive-ready marker helpers (unchanged; shared with the archive job)', () => {
  it('classifies fresh and stale tags by age', () => {
    const tags = findArchiveReady(`- done [archive-ready: ${daysAgo(0)}]\n- old [archive-ready: ${daysAgo(30)}]\n`, TODAY);
    assert.equal(tags.length, 2);
    assert.equal(tags[0].ageDays, 0);
    assert.equal(tags[1].ageDays, 30);
    assert.equal(tags.every((t) => !t.malformed), true);
  });

  it('flags a malformed archive-ready date (never silently passes)', () => {
    const tags = findArchiveReady('- oops [archive-ready: 2026-13-45]\n', TODAY);
    assert.equal(tags.length, 1);
    assert.equal(tags[0].malformed, true);
  });

  it('flags markers whose colon/date separator itself is mistyped (detect by name)', () => {
    for (const marker of ['[archive-ready]', '[archive-ready : 2026-07-01]', '[archive-ready:]', '[ARCHIVE-READY 2026-07-01]']) {
      const tags = archiveReadyTags(`- typo ${marker}`);
      assert.equal(tags.length, 1, `expected one tag for "${marker}"`);
      assert.equal(tags[0].valid, false, `expected malformed for "${marker}"`);
    }
  });

  it('accepts the canonical marker with or without a space after the colon', () => {
    for (const marker of ['[archive-ready: 2026-07-18]', '[archive-ready:2026-07-18]']) {
      const tags = archiveReadyTags(`- done ${marker}`);
      assert.equal(tags.length, 1);
      assert.equal(tags[0].valid, true, `expected valid for "${marker}"`);
    }
  });
});
