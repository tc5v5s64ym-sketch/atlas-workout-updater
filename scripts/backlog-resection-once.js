'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKLOG = path.join(ROOT, 'BACKLOG.md');
const ARCHIVE = path.join(ROOT, 'BACKLOG_ARCHIVE.md');
const CONFIG = path.join(ROOT, 'config', 'paper-weight.json');
const REPORT = path.join(ROOT, 'docs', 'verification', 'BACKLOG_EDITORIAL_CLEANUP_2026-07-30.md');
const TODAY = '2026-07-30';
const CUT_HEADING = '## Recent discoveries & in-flight notes (reference — not the work queue)';

function countLines(text) { return (String(text).match(/\n/g) || []).length; }

function listIndent(line) {
  const m = /^(\s*)(?:[-*]|\d+\.)\s+/.exec(line);
  return m ? m[1].length : null;
}

function strongComplete(line) {
  return /✅|\[[xX]\]|\b(?:SHIPPED|FIXED|RESOLVED|COMPLETE|CLOSED|PASSED|LANDED)\b/.test(line);
}

function liveFirstLine(line) {
  if (/\[ \]/.test(line)) return true;
  if (/\[(?:trust-critical|correctness|polish|housekeeping|product-evidence|new-capability|note|tooling|data)\]/i.test(line)) return true;
  if (/\b(?:deferred|follow-?up|open|future|owner-reserved|owner-gated|awaiting|pending|watch|residual|needs owner|needs evidence|needs verification|not built|not scheduled|not approved|remaining gap)\b/i.test(line)) return true;
  if (/^[\s*-]*(?:🔴|◐|🔎|🚨|🎨|🎭|📋|🩺)/u.test(line)) return true;
  return false;
}

function headingPath(lines, index) {
  const stack = [];
  for (let i = 0; i < index; i += 1) {
    const m = /^(#{2,6})\s+(.+)$/.exec(lines[i]);
    if (!m) continue;
    const level = m[1].length - 1;
    stack.splice(level);
    stack[level - 1] = m[2].trim();
  }
  return stack.filter(Boolean).join(' › ') || 'Unsectioned residuals';
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

function stripCompletedChildren(block) {
  const lines = block.split('\n');
  const remove = [];
  for (let i = 1; i < lines.length; i += 1) {
    const indent = listIndent(lines[i]);
    if (indent === null || !strongComplete(lines[i])) continue;
    const end = itemEnd(lines, i, indent);
    const child = lines.slice(i, end).join('\n');
    if (!/\b(?:deferred|follow-?up|open|future|owner-reserved|owner-gated|awaiting|pending|watch|residual|needs owner|needs evidence|needs verification|not built|not scheduled|not approved)\b/i.test(child)) {
      remove.push({ start: i, end });
    }
  }
  for (const r of remove.sort((a, b) => b.start - a.start)) lines.splice(r.start, r.end - r.start);
  return lines.join('\n').replace(/\s+$/, '');
}

function firstLineKey(block) {
  return block.split('\n')[0]
    .toLowerCase()
    .replace(/[`*_~#[\]()]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractResiduals(remainder) {
  const lines = remainder.split('\n');
  const candidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    const indent = listIndent(lines[i]);
    if (indent === null) continue;
    const first = lines[i];
    if (!liveFirstLine(first) || strongComplete(first)) continue;
    // Historical questions/checklists explicitly superseded by the canonical execution plan.
    if (/open questions for dale|owner live-validation checklist|order of the day/i.test(first)) continue;
    const end = itemEnd(lines, i, indent);
    const block = stripCompletedChildren(lines.slice(i, end).join('\n'));
    if (!block.trim()) continue;
    candidates.push({ start: i, end, indent, heading: headingPath(lines, i), block });
  }

  // Keep the highest-level active item when it contains another active child; otherwise keep the child.
  const selected = [];
  for (const c of candidates.sort((a, b) => a.start - b.start || a.indent - b.indent)) {
    const parent = selected.find((p) => c.start > p.start && c.end <= p.end);
    if (parent) continue;
    selected.push(c);
  }

  const seen = new Set();
  return selected.filter((item) => {
    const key = firstLineKey(item.block);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function main() {
  const before = fs.readFileSync(BACKLOG, 'utf8');
  const cut = before.indexOf(CUT_HEADING);
  if (cut < 0) throw new Error('expected backlog cut heading not found');

  let prefix = before.slice(0, cut).replace(/\s+$/, '');
  const remainder = before.slice(cut).replace(/\s+$/, '');
  const residuals = extractResiduals(remainder);

  prefix = prefix
    .replace('### Open P0 / P1 index (reconciled 2026-07-20)', '### Open P0 / P1 index (reconciled 2026-07-30)')
    .replace('(Verified open 2026-07-20.)', '(Retained pending current-state verification.)')
    .replace(/- \*\*Open P2 residuals\*\*[\s\S]*?\n(?=- \*\*Historical caution)/,
      '- **Open P2 residuals:** PARSE-6, SESS-6, and SESS-7 remain explicit open findings. The former SESS-4/SESS-5 completion-identity cluster is superseded by the Phase-4 canonical-session and single-revision-state-machine work; current residuals are tracked by Issues #1199–#1202 and the Phase-4 gate below.\n')
    .replace(/- \*\*Historical caution:\*\*.*\n/, '');

  const current = [
    '## Current campaign carryovers (2026-07-30)',
    '',
    '- `[trust-critical]` **Phase 4 owner proof / Issue #1163 remains open.** Code criteria for canonical session provenance, discussion referent, and one revision state machine landed through PRs #1194–#1198. The remaining gate is live evidence: one real endorsed load/rep revision must create a durable `Session_Plan_Sets` row; completed sets must stay frozen; one trace must span the first athlete turn through the sealed write; no silent, duplicate, substituted, or false-success outcome may occur. Phase 5 does not begin until this passes.',
    '- `[housekeeping]` **Finish the existing live-retest lane; do not build another test framework.** PR #1203 adds authenticated, synthetic, preview-only production testing and privacy-safe public-run handling. After it is independently reviewed and merged, the existing runner still needs the bounded response-settle condition, the Golden Session fixture adapter, privacy-safe evidence capture, and an explicitly owner-authorized write posture. Synthetic runs never count as owner/gym evidence.',
    '- `[housekeeping]` **Deferred Phase-4 audit follow-ups:** Issue #1199 (positionless scope), #1200 (fixed-size source slicing), #1201 (five audit follow-ups), and #1202 (proposal accepts weight OR reps while revision currently requires both). Do not pull these ahead of the live gate unless a blocking failure proves one is load-bearing.',
    '',
  ].join('\n');

  const grouped = new Map();
  for (const item of residuals) {
    if (!grouped.has(item.heading)) grouped.set(item.heading, []);
    grouped.get(item.heading).push(item.block);
  }

  const ledger = [
    '## Open and deferred ledger (re-sectioned 2026-07-30)',
    '',
    '> The historical roadmap prose and shipped implementation narratives were moved intact to `BACKLOG_ARCHIVE.md`. The entries below are the surviving open/deferred/owner-gated list items extracted from that source. Their source headings are retained for context; they do not select work.',
    '',
    ...Array.from(grouped.entries()).flatMap(([heading, blocks]) => [
      `### ${heading}`,
      '',
      ...blocks.flatMap((b) => [b.replace(/^\s+/, ''), '']),
    ]),
  ].join('\n').replace(/\s+$/, '');

  const after = `${prefix}\n\n---\n\n${current}${ledger}\n`;
  const oldLines = countLines(before);
  const newLines = countLines(after);
  if (newLines >= oldLines) throw new Error(`resection did not shrink backlog (${oldLines} -> ${newLines})`);
  if (residuals.length < 40) throw new Error(`residual extraction suspiciously small: ${residuals.length}`);

  const archiveBefore = fs.readFileSync(ARCHIVE, 'utf8').replace(/\s+$/, '');
  const archiveAddition = [
    '', '',
    `## Historical backlog source snapshot — ${TODAY}`,
    '',
    'This is the exact pre-resection remainder of `BACKLOG.md`, preserved before the current file was rebuilt as a concise open/deferred ledger. It includes shipped implementation narratives, historical campaign labels, superseded checklists, and the source context for every extracted residual. Historical record only; the execution plan and current `BACKLOG.md` govern.',
    '',
    remainder,
    '',
  ].join('\n');

  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const newCap = Math.min(cfg.backlog_max_lines, newLines);
  cfg.backlog_max_lines = newCap;
  cfg._raise_log = `${cfg._raise_log || ''} ${TODAY}: owner-authorized re-section moved the historical backlog remainder intact to BACKLOG_ARCHIVE.md and retained ${residuals.length} open/deferred blocks; BACKLOG ${oldLines} -> ${newLines} lines; cap ratcheted to ${newCap}.`.trim();

  const reportBefore = fs.readFileSync(REPORT, 'utf8').replace(/\s+$/, '');
  const reportAddition = [
    '', '',
    '## Second pass — historical re-section',
    '',
    `- Open/deferred blocks retained: **${residuals.length}**`,
    `- ` + '`BACKLOG.md`' + ` lines: **${oldLines} → ${newLines}**`,
    `- Historical remainder preserved intact in ` + '`BACKLOG_ARCHIVE.md`' + ': **yes**',
    '- Current Phase-4 carryovers added explicitly: **yes**',
    '- Runtime/code behavior changed: **no**',
    '',
    'The second pass did not delete the old prose. It archived the entire historical remainder verbatim, then rebuilt the active file from action-shaped unchecked/deferred/owner-gated bullets. Any ambiguous item was retained rather than guessed complete.',
    '',
  ].join('\n');

  fs.writeFileSync(BACKLOG, after);
  fs.writeFileSync(ARCHIVE, archiveBefore + archiveAddition);
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  fs.writeFileSync(REPORT, reportBefore + reportAddition);

  for (const rel of ['scripts/backlog-resection-once.js', '.github/workflows/backlog-resection-once.yml']) {
    try { fs.unlinkSync(path.join(ROOT, rel)); } catch (_) { /* no-op */ }
  }

  console.log(`Resectioned BACKLOG ${oldLines} -> ${newLines}; retained ${residuals.length} active blocks; cap ${newCap}`);
}

main();
