'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKLOG = path.join(ROOT, 'BACKLOG.md');
const ARCHIVE = path.join(ROOT, 'BACKLOG_ARCHIVE.md');
const CONFIG = path.join(ROOT, 'config', 'paper-weight.json');
const REPORT = path.join(ROOT, 'docs', 'verification', 'BACKLOG_EDITORIAL_CLEANUP_2026-07-30.md');
const TODAY = '2026-07-30';

function countLines(text) {
  return (String(text).match(/\n/g) || []).length;
}

function itemStart(line) {
  const m = /^(\s*)[-*]\s+/.exec(line);
  return m ? m[1].length : null;
}

function isBoundary(line, indent) {
  if (/^#{1,6}\s/.test(line) || /^---\s*$/.test(line)) return true;
  const nextIndent = itemStart(line);
  return nextIndent !== null && nextIndent <= indent;
}

function headingAt(lines, index) {
  const stack = [];
  for (let i = 0; i < index; i += 1) {
    const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
    if (!m) continue;
    const level = m[1].length;
    stack.splice(level - 1);
    stack[level - 1] = m[2].trim();
  }
  return stack.filter(Boolean).join(' › ');
}

function strongCompletion(firstLine) {
  return /✅|\[[xX]\]|~~.*(?:RESOLVED|FIXED|SHIPPED|COMPLETE|CLOSED).*~~/.test(firstLine);
}

function hasLiveWork(block) {
  let s = block.toLowerCase();
  // Explicitly harmless phrases that otherwise contain open/remaining words.
  s = s
    .replace(/no open sub-?item\.?/g, '')
    .replace(/no open follow-?up[s]?\.?/g, '')
    .replace(/no remaining (?:gap|work|item|issue)s?\.?/g, '')
    .replace(/nothing (?:left|remaining|open)\.?/g, '')
    .replace(/all .* (?:complete|closed|shipped|fixed)/g, '');

  const liveSignals = [
    /\bfollow-?up\b/,
    /\bdeferred\b/,
    /\bopen\b/,
    /\bremaining\b/,
    /\bawait(?:ing|s)?\b/,
    /\bpending\b/,
    /\bneeds? owner\b/,
    /\bowner[- ](?:gated|reserved|action|decision)\b/,
    /\bfuture\b/,
    /\bwatch\b/,
    /\bnot (?:built|scheduled|approved|fixed|complete|done|wired|started)\b/,
    /\bneeds? (?:an? )?(?:owner )?live re-?test\b/,
    /\bneeds? verification\b/,
    /\bneeds? evidence\b/,
    /\bblocked\b/,
    /\bpartially\b/,
    /\bpossible follow-?up\b/,
    /\bdiscovered follow-?up\b/,
    /\bresidual\b/,
  ];
  return liveSignals.some((re) => re.test(s));
}

function archiveCompletedItems(text) {
  const lines = text.split('\n');
  const candidates = [];

  for (let i = 0; i < lines.length; i += 1) {
    const indent = itemStart(lines[i]);
    if (indent === null || !strongCompletion(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !isBoundary(lines[j], indent)) j += 1;
    const block = lines.slice(i, j).join('\n').replace(/\s+$/, '');
    if (!block || hasLiveWork(block)) continue;
    candidates.push({ start: i, end: j, block, heading: headingAt(lines, i) });
  }

  // Avoid selecting a child inside a selected parent.
  const selected = [];
  for (const candidate of candidates.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (selected.some((x) => candidate.start >= x.start && candidate.end <= x.end)) continue;
    selected.push(candidate);
  }

  for (const item of selected.sort((a, b) => b.start - a.start)) {
    lines.splice(item.start, item.end - item.start);
  }

  let kept = lines.join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+\n/g, '\n');

  kept = kept.replace(/^\*\*Current as of:\*\*.*$/m,
    '**Current as of:** 2026-07-30 (owner-authorized editorial cleanup; completed records archived).');

  kept = kept.replace(
    /^> ⏳ \*\*Reconciling status before acting:\*\*[\s\S]*?\n\n(?=### Open P0 \/ P1 index)/m,
    '> ⏳ **Reconciled 2026-07-30:** strongly completed records with no open/deferred child were moved to `BACKLOG_ARCHIVE.md`. Ambiguous entries and shipped items that still carry a live follow-up remain here. The execution plan, issue state, tests, and git history still outrank stale prose.\n\n',
  );

  kept = kept.replace(
    /> 🗂️ \*\*Completed & cancelled items have moved to \[`BACKLOG_ARCHIVE\.md`\][\s\S]*?\n\n(?=Seeded from)/m,
    '> 🗂️ **Completed and cancelled records live in [`BACKLOG_ARCHIVE.md`](./BACKLOG_ARCHIVE.md).** This file should contain only open, in-progress, deferred, evidence-gated, or owner-reserved work. A shipped parent remains only when its attached follow-up cannot yet be separated safely.\n\n',
  );

  return { kept, moved: selected.sort((a, b) => a.start - b.start) };
}

function main() {
  const backlogBefore = fs.readFileSync(BACKLOG, 'utf8');
  const archiveBefore = fs.readFileSync(ARCHIVE, 'utf8');
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

  const { kept, moved } = archiveCompletedItems(backlogBefore);
  if (!moved.length) throw new Error('cleanup found no safely archivable completed items');

  const grouped = new Map();
  for (const item of moved) {
    const key = item.heading || 'Unsectioned completed records';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item.block);
  }

  const archiveSection = [
    '',
    '',
    `## Editorial archive ${TODAY}`,
    '',
    'Owner-authorized reconciliation of `BACKLOG.md`. These records were explicitly marked complete/resolved and carried no open, deferred, pending, evidence-gated, or owner-reserved child in their Markdown block. Historical record only; nothing below is actionable.',
    '',
    ...Array.from(grouped.entries()).flatMap(([heading, blocks]) => [
      `### ${heading}`,
      '',
      ...blocks.flatMap((block) => [block, '']),
    ]),
  ].join('\n').replace(/\s+$/, '') + '\n';

  const backlogAfter = kept.replace(/\s+$/, '') + '\n';
  const archiveAfter = archiveBefore.replace(/\s+$/, '') + archiveSection;
  const oldLines = countLines(backlogBefore);
  const newLines = countLines(backlogAfter);
  if (newLines >= oldLines) throw new Error(`cleanup did not shrink backlog (${oldLines} -> ${newLines})`);

  const newConfig = {
    ...config,
    backlog_max_lines: Math.min(config.backlog_max_lines, newLines),
    _raise_log: `${config._raise_log || ''} ${TODAY}: owner-authorized editorial cleanup archived ${moved.length} strongly completed item block(s); BACKLOG ${oldLines} -> ${newLines} lines; cap ratcheted ${config.backlog_max_lines} -> ${Math.min(config.backlog_max_lines, newLines)}.`.trim(),
  };

  const report = [
    '# BACKLOG editorial cleanup — 2026-07-30',
    '',
    '## Result',
    '',
    `- Completed blocks archived: **${moved.length}**`,
    `- ` + '`BACKLOG.md`' + ` lines: **${oldLines} → ${newLines}**`,
    `- Paper-weight cap: **${config.backlog_max_lines} → ${newConfig.backlog_max_lines}**`,
    '- Runtime/code behavior changed: **no**',
    '',
    '## Safety rule used',
    '',
    'A list-item block moved only when its own first line carried a strong completion marker (`✅`, `[x]`, or a struck-through resolved/fixed marker) and the whole block contained no open/deferred/pending/evidence/owner-gated signal. Anything ambiguous stayed in `BACKLOG.md`.',
    '',
    '## Archived blocks',
    '',
    ...moved.map((item) => `- ${item.block.split('\n')[0].replace(/^\s*[-*]\s+/, '').slice(0, 220)}${item.block.split('\n')[0].length > 220 ? '…' : ''}`),
    '',
    '## Deliberately retained',
    '',
    '- Every unchecked checklist item.',
    '- Every shipped parent that still contains an explicit follow-up, deferred item, watch, owner decision, evidence gate, or live re-test requirement.',
    '- All unmarked prose, even when it looks historical, because deleting it safely requires a separate explicit editorial judgment rather than a completion-marker heuristic.',
    '',
  ].join('\n');

  fs.writeFileSync(BACKLOG, backlogAfter);
  fs.writeFileSync(ARCHIVE, archiveAfter);
  fs.writeFileSync(CONFIG, JSON.stringify(newConfig, null, 2) + '\n');
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, report);

  // Remove the one-time machinery so the final PR contains only the governed docs/config diff.
  for (const relative of [
    'scripts/backlog-editorial-cleanup-once.js',
    '.github/workflows/backlog-editorial-cleanup-once.yml',
  ]) {
    try { fs.unlinkSync(path.join(ROOT, relative)); } catch (_) { /* no-op */ }
  }

  console.log(`Archived ${moved.length} completed blocks; BACKLOG ${oldLines} -> ${newLines}; cap -> ${newConfig.backlog_max_lines}`);
}

main();
