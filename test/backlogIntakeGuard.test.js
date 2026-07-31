'use strict';

// Drift Guard 7 — BOUNDED BACKLOG LEDGER (owner ruling 2026-07-30, final form 2026-07-31).
//
// BACKLOG.md has fixed capacity: item count, line count, and backlog_max_lines may never grow.
// A net-neutral replacement — one item in, one item out — is the INTENDED bounded-intake
// operation, so these tests prove it passes, and that anything which grows the ledger fails.
// The guard is mechanical: it counts, and never judges whether a removal was honest.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, countItems, countLines, resolveBaseRef } = require('../scripts/check-backlog-intake');

const CONFIG = (cap) => JSON.stringify({ _note: 'shrink-only', backlog_max_lines: cap });

const ITEM_FINISHING_SET = '- `[correctness]` **Coach the finishing set.** The wrap line fires only on a batch.';
const ITEM_LIVE_RETEST = '- `[housekeeping]` **Finish the live-retest lane.** Do not build another test framework.';
const ITEM_PHASE_4 = '- `[trust-critical]` **Phase 4 owner proof.** Live evidence is the remaining gate.';

const BASE_BACKLOG = [
  '# Atlas — Backlog · BOUNDED EVIDENCE LEDGER',
  '',
  '> Fixed capacity: items, lines, and the cap may never grow.',
  '',
  ITEM_FINISHING_SET,
  ITEM_LIVE_RETEST,
  ITEM_PHASE_4,
  '',
].join('\n');

const BASE_CAP = countLines(BASE_BACKLOG);
const BASE = { backlog: BASE_BACKLOG, config: CONFIG(BASE_CAP) };
const errorsOf = (r) => r.errors.join(' | ');
const at = (backlog, cap = BASE_CAP) => ({ backlog, config: CONFIG(cap) });

// A compact bounded-backlog entry: one line, every required fact stated.
const NEW_ITEM = '- `[correctness]` **Closeout banner double-fires on reload.** status: READY · impact: '
  + 'summary shown twice · evidence: src/app/closeout.js:212 · acceptance: one banner per sealed session · '
  + 'not-now: outside this PR · review: 2026-09-15';

describe('Drift Guard 7 — bounded backlog ledger', () => {
  it('passes when nothing changes', () => {
    const r = analyze({ base: BASE, head: at(BASE_BACKLOG) });
    assert.equal(r.valid, true, errorsOf(r));
  });

  // (a) net-neutral bounded intake passes — one item in, one item out
  it('passes a net-neutral replacement: an item added and an older one removed', () => {
    const head = BASE_BACKLOG.replace(ITEM_LIVE_RETEST, NEW_ITEM);
    const r = analyze({ base: BASE, head: at(head) });
    assert.equal(r.valid, true, errorsOf(r));
    assert.equal(r.headItems, r.baseItems, 'item count stays flat');
    assert.equal(r.headLines, r.baseLines, 'line count stays flat');
  });

  it('passes intake that reduces the ledger: one item in, two out', () => {
    const head = BASE_BACKLOG
      .replace(`${ITEM_LIVE_RETEST}\n`, '')
      .replace(ITEM_PHASE_4, NEW_ITEM);
    const r = analyze({ base: BASE, head: at(head, BASE_CAP - 1) });
    assert.equal(r.valid, true, errorsOf(r));
    assert.ok(r.headItems < r.baseItems);
  });

  // (b) net growth fails
  it('fails an item added without removing anything', () => {
    const r = analyze({ base: BASE, head: at(`${BASE_BACKLOG}${NEW_ITEM}\n`) });
    assert.equal(r.valid, false);
    assert.ok(/grew by 1 item/.test(errorsOf(r)), errorsOf(r));
    assert.ok(/BOUNDED ledger/.test(errorsOf(r)), errorsOf(r));
    assert.ok(/archiving, rejecting, resolving, deduplicating, or promoting/.test(errorsOf(r)), errorsOf(r));
  });

  it('fails a two-for-one trade that still grows the item count', () => {
    const head = BASE_BACKLOG.replace(ITEM_LIVE_RETEST, `${NEW_ITEM}\n${NEW_ITEM.replace('Closeout', 'Second')}`);
    const r = analyze({ base: BASE, head: at(head) });
    assert.equal(r.valid, false);
    assert.ok(/grew by 1 item/.test(errorsOf(r)), errorsOf(r));
  });

  it('fails a replacement whose entry is longer than the space it freed', () => {
    const verbose = [NEW_ITEM, '  - extra detail line one', '  - extra detail line two'].join('\n');
    const head = BASE_BACKLOG.replace(ITEM_LIVE_RETEST, verbose);
    const r = analyze({ base: BASE, head: at(head) });
    assert.equal(r.valid, false);
    assert.ok(/grew \d+ → \d+ lines/.test(errorsOf(r)), errorsOf(r));
    assert.ok(/bounded ledger never grows/.test(errorsOf(r)), errorsOf(r));
  });

  it('fails growth written as prose, or hidden as an indented child', () => {
    const prose = analyze({ base: BASE, head: at(`${BASE_BACKLOG}\nA new finding, written as a paragraph.\n`) });
    assert.equal(prose.valid, false);
    assert.ok(/grew \d+ → \d+ lines/.test(errorsOf(prose)), errorsOf(prose));

    const child = analyze({
      base: BASE,
      head: at(BASE_BACKLOG.replace(ITEM_PHASE_4, `${ITEM_PHASE_4}\n  - also: rebuild the catalogue.`)),
    });
    assert.equal(child.valid, false);
    assert.ok(/grew \d+ → \d+ lines/.test(errorsOf(child)), errorsOf(child));
  });

  it('fails growth appended without a terminating newline', () => {
    const r = analyze({ base: BASE, head: at(`${BASE_BACKLOG}A finding with no trailing newline.`) });
    assert.equal(r.valid, false);
    assert.ok(/grew \d+ → \d+ lines/.test(errorsOf(r)), errorsOf(r));
  });

  // Codex P2 — a one-space-indented marker is still a top-level Markdown item, so writing one
  // over an existing blank line adds an item while every count stays flat.
  it('fails a one-space-indented item written over an existing blank line', () => {
    const head = BASE_BACKLOG.replace(`\n\n${ITEM_FINISHING_SET}`, `\n - \`[polish]\` **Snuck in.** no trade\n${ITEM_FINISHING_SET}`);
    const r = analyze({ base: BASE, head: at(head) });
    assert.equal(r.valid, false, 'a one-space bullet is a sibling, not a child');
    assert.ok(/grew by 1 item/.test(errorsOf(r)), errorsOf(r));
    assert.equal(r.headLines, r.baseLines, 'lines are flat — the item count is what bites');
  });

  it('still treats a two-space bullet as a child, not a new item', () => {
    assert.equal(countItems('- parent\n  - child\n'), 1);
    assert.equal(countItems('- parent\n - sibling\n'), 2);
  });

  it('fails a "+" or ordered item written over an existing blank line', () => {
    for (const marker of ['+ ', '1. ', '1) ']) {
      const head = BASE_BACKLOG.replace(`\n\n${ITEM_FINISHING_SET}`, `\n${marker}new work\n${ITEM_FINISHING_SET}`);
      const r = analyze({ base: BASE, head: at(head) });
      assert.equal(r.valid, false, `marker "${marker}" must fail`);
      assert.ok(/grew by 1 item/.test(errorsOf(r)), errorsOf(r));
      assert.equal(r.headLines, r.baseLines, 'the line count is unchanged — the item count is what bites');
    }
  });

  // (c) cap growth fails
  it('fails when backlog_max_lines increases', () => {
    const r = analyze({ base: BASE, head: at(BASE_BACKLOG, BASE_CAP + 1) });
    assert.equal(r.valid, false);
    assert.ok(new RegExp(`backlog_max_lines rose ${BASE_CAP} → ${BASE_CAP + 1}`).test(errorsOf(r)), errorsOf(r));
    assert.ok(/permanently non-increasing/.test(errorsOf(r)));
    assert.ok(/never raise it to make CI pass or to fit a new item/.test(errorsOf(r)), errorsOf(r));
  });

  it('fails a cap raise even when a justification is written into _raise_log', () => {
    const r = analyze({
      base: BASE,
      head: {
        backlog: BASE_BACKLOG,
        config: JSON.stringify({
          _note: 'shrink-only',
          _raise_log: 'Owner-approved raise to fit one more item; see the PR discussion.',
          backlog_max_lines: BASE_CAP + 30,
        }),
      },
    });
    assert.equal(r.valid, false);
    assert.ok(/backlog_max_lines rose/.test(errorsOf(r)), errorsOf(r));
  });

  it('cannot be satisfied by justification prose beside the new item', () => {
    const head = `${BASE_BACKLOG}${NEW_ITEM}\n  - justification: the owner would want this preserved.\n`;
    const r = analyze({ base: BASE, head: at(head) });
    assert.equal(r.valid, false);
    assert.ok(/grew by 1 item/.test(errorsOf(r)), errorsOf(r));
  });

  // (d) deletion and archival pass
  it('passes when an item is deleted', () => {
    const r = analyze({ base: BASE, head: at(BASE_BACKLOG.replace(`${ITEM_FINISHING_SET}\n`, '')) });
    assert.equal(r.valid, true, errorsOf(r));
    assert.equal(r.headItems, 2);
  });

  it('passes when an item is archived out, with or without the cap ratchet', () => {
    const head = BASE_BACKLOG.replace(`${ITEM_PHASE_4}\n`, '');
    assert.equal(analyze({ base: BASE, head: at(head) }).valid, true);
    assert.equal(analyze({ base: BASE, head: at(head, BASE_CAP - 1) }).valid, true);
  });

  it('passes an in-place correction that does not grow the file', () => {
    const head = BASE_BACKLOG.replace(ITEM_FINISHING_SET, '- `[correctness]` **Coach the finishing set.** Corrected.');
    const r = analyze({ base: BASE, head: at(head) });
    assert.equal(r.valid, true, errorsOf(r));
  });

  it('passes when a duplicate pair is merged into one', () => {
    const dup = BASE_BACKLOG.replace(ITEM_FINISHING_SET, `${ITEM_FINISHING_SET}\n${ITEM_FINISHING_SET}`);
    const base = { backlog: dup, config: CONFIG(countLines(dup)) };
    const r = analyze({ base, head: at(BASE_BACKLOG) });
    assert.equal(r.valid, true, errorsOf(r));
  });

  it('passes when an item is promoted into the execution plan and removed from here', () => {
    const r = analyze({ base: BASE, head: at(BASE_BACKLOG.replace(`${ITEM_PHASE_4}\n`, ''), BASE_CAP - 1) });
    assert.equal(r.valid, true, errorsOf(r));
  });

  // (e) unrelated files remain unaffected
  it('passes when only unrelated files change', () => {
    const r = analyze({ base: BASE, head: at(BASE_BACKLOG) });
    assert.equal(r.valid, true, errorsOf(r));
    assert.deepEqual(r.errors, []);
  });

  it('fails closed when the base cannot be read', () => {
    const r = analyze({ base: { backlog: BASE_BACKLOG, config: '' }, head: at(BASE_BACKLOG) });
    assert.equal(r.valid, false);
    assert.ok(/cannot read backlog_max_lines at the PR base/.test(errorsOf(r)), errorsOf(r));
  });

  it('fails when the head cap is missing or not a positive integer', () => {
    assert.equal(analyze({ base: BASE, head: { backlog: BASE_BACKLOG, config: '{"_note":"x"}' } }).valid, false);
    assert.equal(analyze({ base: BASE, head: at(BASE_BACKLOG, 0) }).valid, false);
  });

  it('passes on the real repository files against themselves', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    const files = {
      backlog: fs.readFileSync(path.join(root, 'BACKLOG.md'), 'utf8'),
      config: fs.readFileSync(path.join(root, 'config', 'paper-weight.json'), 'utf8'),
    };
    assert.equal(analyze({ base: files, head: files }).valid, true);
  });
});

describe('Drift Guard 7 — counting and base resolution', () => {
  it('counts only column-0 list items and ignores fenced examples', () => {
    const text = [
      '# Title',
      '- real item one',
      '  - indented child, not an item',
      '```',
      '- example bullet inside a fence',
      '```',
      '* real item two',
      '+ real item three',
      '1. real item four',
      '',
    ].join('\n');
    assert.equal(countItems(text), 4);
  });

  it('counts a final line that has no terminating newline', () => {
    assert.equal(countLines('a\nb\n'), 2);
    assert.equal(countLines('a\nb'), 2);
    assert.equal(countLines(''), 0);
  });

  it('resolves the base ref from an argument, ATLAS_BASE_REF, or GITHUB_BASE_REF', () => {
    assert.equal(resolveBaseRef(['origin/main'], {}), 'origin/main');
    assert.equal(resolveBaseRef(['origin/main...HEAD'], {}), 'origin/main');
    assert.equal(resolveBaseRef(['--require-base'], { ATLAS_BASE_REF: 'abc123' }), 'abc123');
    assert.equal(resolveBaseRef([], { GITHUB_BASE_REF: 'main' }), 'origin/main');
    assert.equal(resolveBaseRef([], {}), null);
  });
});
