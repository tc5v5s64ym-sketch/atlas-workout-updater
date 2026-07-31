'use strict';

// Drift Guard 7 — BACKLOG INTAKE CLOSURE (owner ruling 2026-07-30).
// Synthetic-violation self-tests for scripts/check-backlog-intake.js: the guard must bite on a
// new backlog item and on a cap raise, must stay out of the way of removal/archival/correction
// work, and must not be satisfiable by justification prose.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, countItems, countLines, resolveBaseRef } = require('../scripts/check-backlog-intake');

const CONFIG = (cap) => JSON.stringify({ _note: 'shrink-only', backlog_max_lines: cap });

const ITEM_FINISHING_SET = '- `[correctness]` **Coach the finishing set.** The wrap line fires only on a batch.';
const ITEM_LIVE_RETEST = '- `[housekeeping]` **Finish the live-retest lane.** Do not build another test framework.';
const ITEM_PHASE_4 = '- `[trust-critical]` **Phase 4 owner proof.** Live evidence is the remaining gate.';

const BASE_BACKLOG = [
  '# Atlas — Backlog',
  '',
  '> FROZEN LEGACY INVENTORY — NO NEW INTAKE.',
  '',
  ITEM_FINISHING_SET,
  ITEM_LIVE_RETEST,
  ITEM_PHASE_4,
  '',
].join('\n');

const BASE_CAP = countLines(BASE_BACKLOG);
const BASE = { backlog: BASE_BACKLOG, config: CONFIG(BASE_CAP) };
const errorsOf = (r) => r.errors.join(' | ');

describe('Drift Guard 7 — backlog intake closure', () => {
  it('passes when BACKLOG.md and the cap are untouched', () => {
    const r = analyze({ base: BASE, head: { backlog: BASE_BACKLOG, config: CONFIG(BASE_CAP) } });
    assert.equal(r.valid, true, errorsOf(r));
    assert.equal(r.headItems, 3);
  });

  // (a) a new backlog item fails
  it('fails when a new work item is added', () => {
    const head = BASE_BACKLOG + '- `[polish]` **New idea found during review.** Reword the closeout summary.\n';
    const r = analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP) } });
    assert.equal(r.valid, false);
    assert.ok(/adds 1 work item\(s\) \(3 → 4\)/.test(errorsOf(r)), errorsOf(r));
    assert.ok(/FIX NOW|REJECT|FILE AS GITHUB ISSUE/.test(errorsOf(r)));
  });

  it('fails when an existing item is duplicated', () => {
    const head = BASE_BACKLOG.replace(ITEM_FINISHING_SET, `${ITEM_FINISHING_SET}\n${ITEM_FINISHING_SET}`);
    const r = analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP) } });
    assert.equal(r.valid, false);
    assert.ok(/adds 1 work item/.test(errorsOf(r)), errorsOf(r));
  });

  // (b) a cap increase fails
  it('fails when backlog_max_lines increases relative to the base', () => {
    const r = analyze({ base: BASE, head: { backlog: BASE_BACKLOG, config: CONFIG(BASE_CAP + 1) } });
    assert.equal(r.valid, false);
    assert.ok(new RegExp(`backlog_max_lines rose ${BASE_CAP} → ${BASE_CAP + 1}`).test(errorsOf(r)), errorsOf(r));
    assert.ok(/permanently non-increasing/.test(errorsOf(r)));
  });

  it('passes when the cap ratchets down', () => {
    const head = BASE_BACKLOG.replace(`${ITEM_LIVE_RETEST}\n`, '');
    const r = analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP - 1) } });
    assert.equal(r.valid, true, errorsOf(r));
  });

  // (c) deleting an item passes
  it('passes when an item is deleted', () => {
    const head = BASE_BACKLOG.replace(`${ITEM_FINISHING_SET}\n`, '');
    const r = analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP) } });
    assert.equal(r.valid, true, errorsOf(r));
    assert.equal(r.headItems, 2);
  });

  // (d) archiving an existing item passes
  it('passes when an item is archived (moved out of BACKLOG.md)', () => {
    const head = BASE_BACKLOG.replace(`${ITEM_PHASE_4}\n`, '');
    // The archive job also ratchets the cap down; with or without that, archival passes.
    assert.equal(analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP) } }).valid, true);
    assert.equal(analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP - 1) } }).valid, true);
  });

  // (e) editing unrelated files passes
  it('passes when only unrelated files change (BACKLOG.md and the cap are identical)', () => {
    const r = analyze({ base: BASE, head: { backlog: BASE_BACKLOG, config: CONFIG(BASE_CAP) } });
    assert.equal(r.valid, true, errorsOf(r));
    assert.deepEqual(r.errors, []);
  });

  // (f) justification prose cannot satisfy the guard
  it('fails a new item even when justification prose is added beside it', () => {
    const head = BASE_BACKLOG
      + '- `[polish]` **Deferred to BACKLOG per review.** Justification: the owner would want this.\n';
    const r = analyze({
      base: BASE,
      head: {
        backlog: head,
        config: JSON.stringify({
          _note: 'shrink-only',
          _raise_log: 'Justification: recorded owner approval for this intake.',
          backlog_max_lines: BASE_CAP,
        }),
      },
    });
    assert.equal(r.valid, false);
    assert.ok(/adds 1 work item/.test(errorsOf(r)), errorsOf(r));
  });

  it('fails a cap raise even when a justification is written into _raise_log', () => {
    const r = analyze({
      base: BASE,
      head: {
        backlog: BASE_BACKLOG,
        config: JSON.stringify({
          _note: 'shrink-only',
          _raise_log: 'Owner-approved raise for one more item; see the PR discussion.',
          backlog_max_lines: BASE_CAP + 30,
        }),
      },
    });
    assert.equal(r.valid, false);
    assert.ok(/backlog_max_lines rose/.test(errorsOf(r)), errorsOf(r));
  });

  it('fails intake written as prose rather than as a bullet (the file may not grow)', () => {
    const head = BASE_BACKLOG + '\nNew finding from review: the closeout banner double-fires on reload.\n';
    const r = analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP) } });
    assert.equal(r.valid, false);
    assert.ok(/grew \d+ → \d+ lines/.test(errorsOf(r)), errorsOf(r));
    assert.ok(r.headLines > r.baseLines);
  });

  it('fails intake hidden as an indented child of an existing item', () => {
    const head = BASE_BACKLOG.replace(ITEM_PHASE_4, `${ITEM_PHASE_4}\n  - also: rebuild the golden-session catalogue.`);
    const r = analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP) } });
    assert.equal(r.valid, false);
    assert.ok(/grew \d+ → \d+ lines/.test(errorsOf(r)), errorsOf(r));
  });

  // Codex P1 — appended intake that drops the trailing newline keeps the newline count flat.
  it('fails prose appended without a terminating newline', () => {
    const head = BASE_BACKLOG + 'New finding from review: the closeout banner double-fires.';
    const r = analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP) } });
    assert.equal(r.valid, false);
    assert.ok(/grew \d+ → \d+ lines/.test(errorsOf(r)), errorsOf(r));
  });

  // Codex P1 — "+" and ordered markers are valid Markdown list items; converting an existing
  // blank line to one adds an item without adding a line.
  it('fails a "+" or ordered item written over an existing blank line', () => {
    for (const marker of ['+ ', '1. ', '1) ']) {
      const head = BASE_BACKLOG.replace(`\n\n${ITEM_FINISHING_SET}`, `\n${marker}new work\n${ITEM_FINISHING_SET}`);
      const r = analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP) } });
      assert.equal(r.valid, false, `marker "${marker}" must fail`);
      assert.ok(/adds 1 work item/.test(errorsOf(r)), errorsOf(r));
      assert.equal(r.headLines, r.baseLines, 'the line count is unchanged — the item count is what bites');
    }
  });

  // Correction, dedup, and reduction stay possible.
  it('passes when an existing item is corrected in place', () => {
    const head = BASE_BACKLOG.replace(
      ITEM_FINISHING_SET,
      '- `[correctness]` **Coach the finishing set.** Corrected: it fires only on a batch of two.',
    );
    const r = analyze({ base: BASE, head: { backlog: head, config: CONFIG(BASE_CAP) } });
    assert.equal(r.valid, true, errorsOf(r));
  });

  it('passes when two duplicate items are merged into one', () => {
    const dupText = BASE_BACKLOG.replace(ITEM_FINISHING_SET, `${ITEM_FINISHING_SET}\n${ITEM_FINISHING_SET}`);
    const base = { backlog: dupText, config: CONFIG(countLines(dupText)) };
    const r = analyze({ base, head: { backlog: BASE_BACKLOG, config: CONFIG(BASE_CAP) } });
    assert.equal(r.valid, true, errorsOf(r));
  });

  it('reports a re-created BACKLOG.md as new intake rather than passing it', () => {
    const r = analyze({
      base: { backlog: '', config: CONFIG(BASE_CAP) },
      head: { backlog: BASE_BACKLOG, config: CONFIG(BASE_CAP) },
    });
    assert.equal(r.valid, false);
    assert.ok(/adds 3 work item/.test(errorsOf(r)), errorsOf(r));
  });

  it('fails closed when the base cap cannot be read (an unfetched base is never a pass)', () => {
    const unreadable = analyze({ base: { backlog: BASE_BACKLOG, config: '' }, head: { backlog: BASE_BACKLOG, config: CONFIG(BASE_CAP + 50) } });
    assert.equal(unreadable.valid, false);
    assert.ok(/cannot read backlog_max_lines at the PR base/.test(errorsOf(unreadable)), errorsOf(unreadable));

    const corrupt = analyze({ base: { backlog: BASE_BACKLOG, config: '{ not json' }, head: { backlog: BASE_BACKLOG, config: CONFIG(BASE_CAP) } });
    assert.equal(corrupt.valid, false);
    assert.ok(/cannot parse/.test(errorsOf(corrupt)), errorsOf(corrupt));
  });

  it('fails when the head cap is missing or not a positive integer', () => {
    assert.equal(analyze({ base: BASE, head: { backlog: BASE_BACKLOG, config: '{"_note":"x"}' } }).valid, false);
    assert.equal(analyze({ base: BASE, head: { backlog: BASE_BACKLOG, config: CONFIG(0) } }).valid, false);
  });

  it('passes on the real repository files against themselves (no diff, no intake)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    const files = {
      backlog: fs.readFileSync(path.join(root, 'BACKLOG.md'), 'utf8'),
      config: fs.readFileSync(path.join(root, 'config', 'paper-weight.json'), 'utf8'),
    };
    const r = analyze({ base: files, head: files });
    assert.equal(r.valid, true, errorsOf(r));
  });
});

describe('Drift Guard 7 — item counting and base resolution', () => {
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
    assert.equal(countLines('a\nb\nc'), 3);
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
