'use strict';

// Drift Guard 6 — AUTO-ARCHIVE JOB (Phase 2).
//
// Moves BACKLOG.md items that carry an explicit `[archive-ready: YYYY-MM-DD]` tag into
// BACKLOG_ARCHIVE.md and ratchets the paper-weight cap (config/paper-weight.json
// `backlog_max_lines`) down to the trimmed size. It is the companion to the staleness
// sub-rule in scripts/check-paper-weight.js: when that check fails ("archive-ready item
// older than N days"), run `npm run archive:backlog -- --apply` to clear it.
//
// SAFETY: the job acts ONLY on the explicit tag — never on a free-text ✅ / "shipped" /
// "FIXED" heuristic. The 2026-07-20 archive reconciliation
// (docs/verification/BACKLOG_RECONCILIATION_2026-07-20.md) proved a heuristic cannot
// safely tell a fully-shipped item from a ✅-with-open-follow-up one, so archival requires
// a human to tag the item. Default is a DRY RUN; pass --apply to write files.

const fs = require('node:fs');
const path = require('node:path');
const { countLines } = require('./check-paper-weight');

const ROOT = path.join(__dirname, '..');
const BACKLOG = path.join(ROOT, 'BACKLOG.md');
const ARCHIVE = path.join(ROOT, 'BACKLOG_ARCHIVE.md');
const CONFIG = path.join(ROOT, 'config', 'paper-weight.json');

const TAG_RE = /\[archive-ready:\s*\d{4}-\d{2}-\d{2}\s*\]/;

// A structural boundary at column 0: a top-level list bullet, a heading, or a horizontal rule.
// An indented sub-bullet ("  - child") is NOT a boundary — it belongs to its parent item's block.
function isBlockBoundary(line) {
  return /^[-*] /.test(line) || /^#{1,6}\s/.test(line) || /^---\s*$/.test(line);
}

/**
 * Split BACKLOG text into the lines to KEEP and the tagged item BLOCKS to move.
 * A block = a top-level bullet whose line carries the tag, plus every following line up to
 * (not including) the next structural boundary — i.e. the bullet and all its indented
 * children / continuation. Pure; never throws.
 */
function extractArchiveReadyBlocks(backlogText) {
  const lines = String(backlogText).split('\n');
  const keptLines = [];
  const moved = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^[-*] /.test(line) && TAG_RE.test(line)) {
      const block = [line];
      let j = i + 1;
      while (j < lines.length && !isBlockBoundary(lines[j])) { block.push(lines[j]); j++; }
      moved.push({ line: i + 1, text: block.join('\n').replace(/\s+$/, '') });
      i = j;
      continue;
    }
    keptLines.push(line);
    i++;
  }
  const keptText = keptLines.join('\n').replace(/\n{3,}/g, '\n\n');
  return { keptText, moved };
}

/**
 * Pure planner. Given the current BACKLOG / ARCHIVE text, parsed config, and a YYYY-MM-DD
 * `todayStr`, return the new file contents + the ratcheted cap. `changed:false` (a no-op)
 * when nothing is tagged. Never throws.
 */
function planArchive({ backlogText, archiveText, config, todayStr }) {
  const cap = config && config.backlog_max_lines;
  const { keptText, moved } = extractArchiveReadyBlocks(backlogText);
  if (!moved.length) {
    return { changed: false, count: 0, moved: [], newBacklogText: backlogText, newArchiveText: archiveText, newCap: cap };
  }
  const header = `## Auto-archived ${todayStr}`;
  const intro = 'Items moved out of [`BACKLOG.md`](./BACKLOG.md) by `npm run archive:backlog` after being '
    + 'explicitly tagged `[archive-ready]` (a human-confirmed fully-shipped-with-no-open-follow-up signal). '
    + 'Historical record only — nothing here is actionable.';
  const section = `\n\n${header}\n\n${intro}\n\n` + moved.map((m) => m.text).join('\n\n') + '\n';
  const newArchiveText = String(archiveText).replace(/\s*$/, '') + section;
  const newBacklogText = keptText.replace(/\s*$/, '') + '\n';
  const newCap = countLines(newBacklogText);
  return { changed: true, count: moved.length, moved, newBacklogText, newArchiveText, newCap };
}

function iso(d) { return d.toISOString().slice(0, 10); }

function run(apply) {
  const backlogText = fs.readFileSync(BACKLOG, 'utf8');
  const archiveText = fs.readFileSync(ARCHIVE, 'utf8');
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const todayStr = iso(new Date());
  const plan = planArchive({ backlogText, archiveText, config, todayStr });

  if (!plan.changed) {
    console.log('✅ archive-backlog: no [archive-ready]-tagged items — nothing to move (no-op).');
    return 0;
  }

  console.log(`archive-backlog: ${plan.count} tagged item(s) to move; BACKLOG ${countLines(backlogText)} → ${plan.newCap} lines (cap ratchets to ${plan.newCap}).`);
  for (const m of plan.moved) {
    const first = m.text.split('\n')[0].slice(0, 100);
    console.log(`  • line ${m.line}: ${first}${first.length >= 100 ? '…' : ''}`);
  }

  if (!apply) {
    console.log('\n(dry run — pass --apply to write BACKLOG.md, BACKLOG_ARCHIVE.md, and ratchet config/paper-weight.json)');
    return 0;
  }

  const newConfig = { ...config, backlog_max_lines: plan.newCap };
  const note = `${todayStr}: archive-backlog moved ${plan.count} [archive-ready] item(s) to BACKLOG_ARCHIVE.md; cap ratcheted ${config.backlog_max_lines} → ${plan.newCap}.`;
  newConfig._raise_log = config._raise_log ? `${config._raise_log} ${note}` : note;

  fs.writeFileSync(BACKLOG, plan.newBacklogText);
  fs.writeFileSync(ARCHIVE, plan.newArchiveText);
  fs.writeFileSync(CONFIG, JSON.stringify(newConfig, null, 2) + '\n');
  console.log(`\n✅ Applied. Moved ${plan.count} item(s); cap now ${plan.newCap}. Review the diff and commit.`);
  return 0;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  try {
    process.exit(run(apply));
  } catch (e) {
    console.error(`archive-backlog failed: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { extractArchiveReadyBlocks, planArchive };
