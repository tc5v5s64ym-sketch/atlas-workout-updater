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
function listIndent(line) {
  const m = /^(\s*)(?:[-*]|\d+\.)\s+/.exec(line);
  return m ? m[1].length : null;
}
function itemEnd(lines, start, indent) {
  let j = start + 1;
  while (j < lines.length) {
    if (/^#{1,6}\s/.test(lines[j]) || /^---\s*$/.test(lines[j])) break;
    const n = listIndent(lines[j]);
    if (n !== null && n <= indent) break;
    j += 1;
  }
  return j;
}
function strongComplete(line) {
  return /✅|\[[xX]\]|\b(?:SHIPPED|FIXED|RESOLVED|COMPLETE|CLOSED|PASSED|LANDED)\b/.test(line);
}
function hasUnresolvedWork(block) {
  let s = block.toLowerCase();
  // A completed child can still have an open nested follow-up; preserve only genuinely live signals.
  s = s.replace(/^.*$/m, (first) => first.replace(/follow-?up/g, ''));
  s = s
    .replace(/no open (?:item|sub-?item|follow-?up)s?\.?/g, '')
    .replace(/no remaining (?:work|gap|item)s?\.?/g, '')
    .replace(/nothing (?:left|remaining|open)\.?/g, '')
    .replace(/follow-?up \([^)]*\) — done/g, '')
    .replace(/follow-?up \([^)]*\) — fixed/g, '')
    .replace(/follow-?up \([^)]*\) — resolved/g, '');
  return /\b(?:deferred|open|remaining|awaiting|pending|watch|residual|needs owner|needs evidence|needs verification|not built|not scheduled|not approved|owner-gated|owner-reserved|future work|next slice|later slice)\b/i.test(s);
}
function directChildren(lines, start, end, parentIndent) {
  let childIndent = null;
  for (let i = start + 1; i < end; i += 1) {
    const n = listIndent(lines[i]);
    if (n !== null && n > parentIndent && (childIndent === null || n < childIndent)) childIndent = n;
  }
  if (childIndent === null) return [];
  const out = [];
  for (let i = start + 1; i < end; i += 1) {
    if (listIndent(lines[i]) !== childIndent) continue;
    const e = Math.min(itemEnd(lines, i, childIndent), end);
    out.push({ start: i, end: e, indent: childIndent, block: lines.slice(i, e).join('\n') });
    i = e - 1;
  }
  return out;
}
function deindent(block, amount) {
  return block.split('\n').map((line) => line.slice(Math.min(amount, (line.match(/^\s*/) || [''])[0].length))).join('\n');
}
function exactResolved(first) {
  return /PLAN-LEDGER-1|Workout Sheet \+ name-keyed completion vs a duplicate-name plan|PR-24 slice-3 divergence|\*\*SESS-4\*\*|\*\*SESS-5\*\*/i.test(first);
}

function main() {
  const before = fs.readFileSync(BACKLOG, 'utf8');
  const lines = before.split('\n');
  const targets = [];

  for (let i = 0; i < lines.length; i += 1) {
    const indent = listIndent(lines[i]);
    if (indent === null) continue;
    const end = itemEnd(lines, i, indent);
    const block = lines.slice(i, end).join('\n').replace(/\s+$/, '');
    const exact = exactResolved(lines[i]);
    const complete = strongComplete(lines[i]) && !hasUnresolvedWork(block);
    if (!exact && !complete) continue;

    const promoted = directChildren(lines, i, end, indent)
      .filter((c) => !strongComplete(lines[c.start]) || hasUnresolvedWork(c.block))
      .map((c) => deindent(c.block, c.indent - indent));
    targets.push({ start: i, end, block, promoted, reason: exact ? 'F10/current-state resolved' : 'completed child' });
    i = end - 1;
  }

  const selected = targets.filter((t, idx) => !targets.some((p, j) => j !== idx && t.start > p.start && t.end <= p.end));
  for (const t of selected.sort((a, b) => b.start - a.start)) {
    const repl = t.promoted.flatMap((b, idx) => (idx ? ['', ...b.split('\n')] : b.split('\n')));
    lines.splice(t.start, t.end - t.start, ...repl);
  }

  let after = lines.join('\n')
    .replace('The former SESS-4/SESS-5 completion-identity cluster is superseded by the Phase-4 canonical-session and single-revision-state-machine work;', 'The former SESS-4/SESS-5 completion-identity cluster was closed by F10 authoritative planned-slot completion identity;')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\s+$/, '') + '\n';

  const oldLines = countLines(before);
  const newLines = countLines(after);
  if (!selected.length || newLines >= oldLines) throw new Error(`no safe shrink: selected=${selected.length}, ${oldLines}->${newLines}`);

  const archiveBefore = fs.readFileSync(ARCHIVE, 'utf8').replace(/\s+$/, '');
  const archiveSection = [
    '', '',
    `## F10/current-state reconciliation — ${TODAY}`,
    '',
    'Records removed from the active backlog after verification against the canonical execution plan: F10 is COMPLETE and explicitly resolves SESS-4, SESS-5, the PR-24 remaining-state divergence, and Workout Sheet duplicate-name completion identity; the set-level ledger exists and the remaining production proof is tracked by the current Phase-4 carryover. Other completed child records below had no unresolved work in their block.',
    '',
    ...selected.flatMap((t) => [`<!-- ${t.reason} -->`, t.block, '']),
  ].join('\n').replace(/\s+$/, '') + '\n';

  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const cap = Math.min(cfg.backlog_max_lines, newLines);
  cfg.backlog_max_lines = cap;
  cfg._raise_log = `${cfg._raise_log || ''} ${TODAY}: verified F10/current-state reconciliation archived ${selected.length} resolved/completed block(s); BACKLOG ${oldLines} -> ${newLines}; cap -> ${cap}.`.trim();

  const reportBefore = fs.readFileSync(REPORT, 'utf8').replace(/\s+$/, '');
  const reportAdd = [
    '', '',
    '## F10/current-state verification pass',
    '',
    '- Canonical verification: `docs/ATLAS_V1_EXECUTION_PLAN.md` records F10 COMPLETE and names SESS-4, SESS-5, PR-24 slice-3, and Workout Sheet duplicate-name identity as its resolved findings.',
    `- Resolved/completed blocks archived: **${selected.length}**`,
    `- ` + '`BACKLOG.md`' + ` lines: **${oldLines} → ${newLines}**`,
    '- Historical text discarded: **no**',
    '- Runtime/code behavior changed: **no**',
    '',
  ].join('\n');

  fs.writeFileSync(BACKLOG, after);
  fs.writeFileSync(ARCHIVE, archiveBefore + archiveSection);
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  fs.writeFileSync(REPORT, reportBefore + reportAdd);

  for (const rel of ['scripts/backlog-f10-reconcile-once.js', '.github/workflows/backlog-f10-reconcile-once.yml']) {
    try { fs.unlinkSync(path.join(ROOT, rel)); } catch (_) { /* no-op */ }
  }
  console.log(`Archived ${selected.length}; BACKLOG ${oldLines}->${newLines}; cap ${cap}`);
}

main();
