'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKLOG = path.join(ROOT, 'BACKLOG.md');
const ARCHIVE = path.join(ROOT, 'BACKLOG_ARCHIVE.md');
const CONFIG = path.join(ROOT, 'config', 'paper-weight.json');
const REPORT = path.join(ROOT, 'docs', 'verification', 'BACKLOG_EDITORIAL_CLEANUP_2026-07-30.md');
const TODAY = '2026-07-30';

function countLines(text) { return (String(text).match(/\n/g) || []).length; }
function indentOf(line) {
  const m = /^(\s*)(?:[-*]|\d+\.)\s+/.exec(line);
  return m ? m[1].length : null;
}
function strongComplete(line) {
  return /✅|\[[xX]\]|\b(?:SHIPPED|FIXED|RESOLVED|COMPLETE|CLOSED|PASSED|LANDED|RATIFIED)\b/.test(line);
}
function liveLine(line) {
  return /\[ \]|\[(?:trust-critical|correctness|polish|housekeeping|product-evidence|new-capability|note|tooling|data)\]|\b(?:deferred|follow-?up|open|future|owner-reserved|owner-gated|awaiting|pending|watch|residual|needs owner|needs evidence|needs verification|not built|not scheduled|not approved|remaining gap)\b/i.test(line);
}
function itemEnd(lines, start, indent) {
  let j = start + 1;
  while (j < lines.length) {
    if (/^#{1,6}\s/.test(lines[j]) || /^---\s*$/.test(lines[j])) break;
    const n = indentOf(lines[j]);
    if (n !== null && n <= indent) break;
    j += 1;
  }
  return j;
}
function directChildren(lines, start, end, parentIndent) {
  const starts = [];
  let childIndent = null;
  for (let i = start + 1; i < end; i += 1) {
    const n = indentOf(lines[i]);
    if (n === null || n <= parentIndent) continue;
    if (childIndent === null || n < childIndent) childIndent = n;
  }
  if (childIndent === null) return [];
  for (let i = start + 1; i < end; i += 1) {
    if (indentOf(lines[i]) !== childIndent) continue;
    const childEnd = itemEnd(lines, i, childIndent);
    starts.push({ start: i, end: Math.min(childEnd, end), indent: childIndent });
    i = childEnd - 1;
  }
  return starts;
}
function deindent(block, amount) {
  return block.split('\n').map((line) => {
    let out = line;
    let left = amount;
    while (left > 0 && out.startsWith(' ')) { out = out.slice(1); left -= 1; }
    return out;
  }).join('\n');
}
function parentIsObsoleteContainer(first) {
  return /owner Work-mode smoke test — FAILED stabilization gate|owner live-session stabilization findings \(LT-012 FAIL|correctness-mission discoveries|Deep-review audit filed 2026-07-07|P0 coach-trust findings 2026-06-25|Owner live-validation checklist|Historical lane|Navigation for this file/i.test(first);
}

function prune(text) {
  const lines = text.split('\n');
  const archived = [];
  const promoted = [];
  const targets = [];

  for (let i = 0; i < lines.length; i += 1) {
    const indent = indentOf(lines[i]);
    if (indent === null) continue;
    const end = itemEnd(lines, i, indent);
    const first = lines[i];
    const completed = strongComplete(first);
    const obsolete = parentIsObsoleteContainer(first);
    if (!completed && !obsolete) continue;

    const children = directChildren(lines, i, end, indent);
    const keepChildren = [];
    for (const child of children) {
      const childFirst = lines[child.start];
      if (!strongComplete(childFirst) && liveLine(childFirst)) {
        keepChildren.push(deindent(lines.slice(child.start, child.end).join('\n'), child.indent - indent));
      }
    }

    // A completed item whose own first line still explicitly says follow-up/deferred is a live item, not history.
    if (completed && liveLine(first) && !obsolete) continue;
    targets.push({ start: i, end, original: lines.slice(i, end).join('\n').replace(/\s+$/, ''), replacements: keepChildren });
    i = end - 1;
  }

  // Remove child targets already covered by a parent target.
  const selected = targets.filter((t, idx) => !targets.some((p, j) => j !== idx && t.start > p.start && t.end <= p.end));
  for (const t of selected.sort((a, b) => b.start - a.start)) {
    const replacementLines = t.replacements.flatMap((b, idx) => (idx ? ['', ...b.split('\n')] : b.split('\n')));
    lines.splice(t.start, t.end - t.start, ...replacementLines);
    archived.push(t.original);
    promoted.push(...t.replacements);
  }

  let out = lines.join('\n')
    .replace(/\n---\n\n---\n/g, '\n---\n')
    .replace(/(Issue #1199[^\n]+)\n## Open and deferred ledger/, '$1\n\n## Open and deferred ledger')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+\n/g, '\n');

  // Remove empty headings left by pruning.
  const outLines = out.split('\n');
  for (let i = outLines.length - 1; i >= 0; i -= 1) {
    if (!/^###\s/.test(outLines[i])) continue;
    let j = i + 1;
    while (j < outLines.length && !/^#{2,3}\s/.test(outLines[j])) j += 1;
    const body = outLines.slice(i + 1, j).join('\n').trim();
    if (!body) outLines.splice(i, j - i);
  }
  out = outLines.join('\n').replace(/\s+$/, '') + '\n';
  return { out, archived: archived.reverse(), promoted };
}

function main() {
  const before = fs.readFileSync(BACKLOG, 'utf8');
  const { out, archived, promoted } = prune(before);
  if (!archived.length) throw new Error('final prune found nothing');
  const oldLines = countLines(before);
  const newLines = countLines(out);
  if (newLines >= oldLines) throw new Error(`final prune did not shrink (${oldLines} -> ${newLines})`);

  const archiveBefore = fs.readFileSync(ARCHIVE, 'utf8').replace(/\s+$/, '');
  const archiveSection = [
    '', '',
    `## Final editorial prune — ${TODAY}`,
    '',
    'Completed nested records and superseded historical container bullets removed from the active ledger after their live child follow-ups were promoted. Historical text remains here; nothing was discarded.',
    '',
    ...archived.flatMap((b) => [b, '']),
  ].join('\n').replace(/\s+$/, '') + '\n';

  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const newCap = Math.min(cfg.backlog_max_lines, newLines);
  cfg.backlog_max_lines = newCap;
  cfg._raise_log = `${cfg._raise_log || ''} ${TODAY}: final editorial prune archived ${archived.length} completed/superseded container block(s), promoted ${promoted.length} live child block(s), BACKLOG ${oldLines} -> ${newLines}; cap -> ${newCap}.`.trim();

  const reportBefore = fs.readFileSync(REPORT, 'utf8').replace(/\s+$/, '');
  const reportAdd = [
    '', '',
    '## Final pass — nested completion and stale-container prune',
    '',
    `- Completed/superseded blocks archived: **${archived.length}**`,
    `- Live child blocks promoted: **${promoted.length}**`,
    `- ` + '`BACKLOG.md`' + ` lines: **${oldLines} → ${newLines}**`,
    '- Historical text discarded: **no**',
    '- Runtime/code behavior changed: **no**',
    '',
  ].join('\n');

  fs.writeFileSync(BACKLOG, out);
  fs.writeFileSync(ARCHIVE, archiveBefore + archiveSection);
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  fs.writeFileSync(REPORT, reportBefore + reportAdd);

  for (const rel of ['scripts/backlog-final-prune-once.js', '.github/workflows/backlog-final-prune-once.yml']) {
    try { fs.unlinkSync(path.join(ROOT, rel)); } catch (_) { /* no-op */ }
  }

  console.log(`Final prune: ${archived.length} archived, ${promoted.length} promoted; BACKLOG ${oldLines} -> ${newLines}; cap ${newCap}`);
}

main();
