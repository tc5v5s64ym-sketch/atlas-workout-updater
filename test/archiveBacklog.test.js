'use strict';

// Drift Guard 6 — AUTO-ARCHIVE JOB (Phase 2).
// Pure planner tests for scripts/archive-backlog.js — no filesystem I/O.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractArchiveReadyBlocks, planArchive } = require('../scripts/archive-backlog');
const { countLines } = require('../scripts/check-paper-weight');

const cfg = (n) => ({ backlog_max_lines: n, _note: 'x' });
const T = '2026-07-20';

describe('Drift Guard 6 — auto-archive job (planArchive)', () => {
  it('is a no-op when nothing is tagged [archive-ready]', () => {
    const backlog = '# Backlog\n\n- open one\n- open two\n';
    const p = planArchive({ backlogText: backlog, archiveText: '# Archive\n', config: cfg(4), todayStr: T });
    assert.equal(p.changed, false);
    assert.equal(p.count, 0);
    assert.equal(p.newBacklogText, backlog);
    assert.equal(p.newCap, 4);
  });

  it('moves a single tagged top-level item and ratchets the cap down', () => {
    const backlog = '# Backlog\n\n- keep me open\n- shipped and done [archive-ready: 2026-07-01]\n- keep me too\n';
    const before = countLines(backlog);
    const p = planArchive({ backlogText: backlog, archiveText: '# Archive\n', config: cfg(before), todayStr: T });
    assert.equal(p.changed, true);
    assert.equal(p.count, 1);
    // The tagged item is gone from BACKLOG…
    assert.ok(!p.newBacklogText.includes('shipped and done'));
    assert.ok(p.newBacklogText.includes('keep me open'));
    assert.ok(p.newBacklogText.includes('keep me too'));
    // …and present in the ARCHIVE under a dated auto-archived header, tag preserved.
    assert.ok(p.newArchiveText.includes(`## Auto-archived ${T}`));
    assert.ok(p.newArchiveText.includes('shipped and done [archive-ready: 2026-07-01]'));
    // Cap ratchets to the new (smaller) line count.
    assert.equal(p.newCap, countLines(p.newBacklogText));
    assert.ok(p.newCap < before);
  });

  it('moves a tagged item together with its indented children (block, not just the bullet)', () => {
    const backlog = [
      '# Backlog',
      '',
      '- done parent [archive-ready: 2026-07-02]',
      '  - a child line',
      '  - another child',
      '- a sibling that stays',
      '',
    ].join('\n');
    const { keptText, moved } = extractArchiveReadyBlocks(backlog);
    assert.equal(moved.length, 1);
    assert.ok(moved[0].text.includes('done parent'));
    assert.ok(moved[0].text.includes('a child line'));
    assert.ok(moved[0].text.includes('another child'));
    // Children must not be orphaned in the kept text.
    assert.ok(!keptText.includes('a child line'));
    assert.ok(!keptText.includes('another child'));
    assert.ok(keptText.includes('a sibling that stays'));
  });

  it('moves several tagged items and keeps the untagged ones', () => {
    const backlog = '# B\n\n- one [archive-ready: 2026-06-01]\n- two open\n- three [archive-ready: 2026-06-02]\n- four open\n';
    const p = planArchive({ backlogText: backlog, archiveText: '# Archive\n', config: cfg(countLines(backlog)), todayStr: T });
    assert.equal(p.count, 2);
    assert.ok(!p.newBacklogText.includes('one [archive-ready'));
    assert.ok(!p.newBacklogText.includes('three [archive-ready'));
    assert.ok(p.newBacklogText.includes('two open'));
    assert.ok(p.newBacklogText.includes('four open'));
  });

  it('never RAISES the cap — an over-cap file still over cap after archiving keeps its committed cap', () => {
    // 6-line backlog but a committed cap of 4 (already over). Removing one tagged item leaves
    // 5 lines — still over 4. The cap must stay 4 (grow-only guard never weakened), not rise to 5.
    const backlog = '# B\n\n- open one\n- open two\n- shipped [archive-ready: 2026-06-01]\n- open three\n';
    assert.equal(countLines(backlog), 6);
    const p = planArchive({ backlogText: backlog, archiveText: '# A\n', config: cfg(4), todayStr: T });
    assert.equal(p.changed, true);
    assert.ok(countLines(p.newBacklogText) > 4, 'still over the committed cap after one removal');
    assert.equal(p.newCap, 4, 'cap must not be raised above its committed value');
  });

  it('ratchets the cap DOWN when archiving brings the file under the committed cap', () => {
    const backlog = '# B\n\n- open one\n- shipped [archive-ready: 2026-06-01]\n';
    const before = countLines(backlog);
    const p = planArchive({ backlogText: backlog, archiveText: '# A\n', config: cfg(before), todayStr: T });
    assert.equal(p.newCap, countLines(p.newBacklogText));
    assert.ok(p.newCap < before);
  });

  it('is idempotent — a second run over the result moves nothing', () => {
    const backlog = '# B\n\n- open\n- done [archive-ready: 2026-07-01]\n';
    const first = planArchive({ backlogText: backlog, archiveText: '# Archive\n', config: cfg(countLines(backlog)), todayStr: T });
    const second = planArchive({ backlogText: first.newBacklogText, archiveText: first.newArchiveText, config: cfg(first.newCap), todayStr: T });
    assert.equal(second.changed, false);
    assert.equal(second.count, 0);
  });

  it('only the exact tag triggers a move — prose mentioning archive-ready is untouched', () => {
    const backlog = '# B\n\n- discusses the archive-ready convention but is not tagged\n';
    const p = planArchive({ backlogText: backlog, archiveText: '# Archive\n', config: cfg(countLines(backlog)), todayStr: T });
    assert.equal(p.changed, false);
    assert.equal(p.count, 0);
  });
});
