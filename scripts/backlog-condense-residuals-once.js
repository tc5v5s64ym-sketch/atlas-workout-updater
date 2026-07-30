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

const RULES = [
  {
    name: 'coach-first opener shipped narrative',
    match: /Coach-first home opener — DIRECTION APPROVED/,
    replacement: [
      '- `[polish]` **Home opener residuals only.** The deterministic coach-first opener is shipped. Optional remaining display work: add one muted, tappable glance row if passive state is still wanted; and make the opener robust when a cached response beats the `atlas:glance-ready` listener by stashing/applying the last opener.',
      '- `[correctness]` **Server-owned opener posture remains future and owner-gated.** Varying the angle, withdrawing ignored advice, LLM-authored opening voice, and next-session forecasting belong in a future `/api/coach/opening`/Brain-owned decision lane. The client must not invent those coaching decisions.',
    ],
  },
  {
    name: 'G1 guardrail shipped narrative',
    match: /G1 — never silently merge a stacked second exercise/,
    replacement: [
      '- `[correctness]` **KB-backed stacked-bubble splitter remains unbuilt.** The shipped G1 guardrail now refuses ambiguous stacked input instead of silently merging sets. The remaining feature is to split one-bubble multi-exercise input only when the Exercise KB confidently identifies the next exercise; otherwise preserve the refuse-to-merge clarification.',
    ],
  },
  {
    name: 'return-after-layoff shipped narrative',
    match: /Return-after-layoff \/ catch-up guard/,
    replacement: [
      '- `[polish]` **Word the live return-after-layoff signal in coach voice.** The deterministic layoff guard and volume reduction are shipped end-to-end. The remaining owner-gated surface is how the coach briefly explains the existing `returning_from_layoff`/`watch` fact without sounding apologetic or inventing recovery state.',
    ],
  },
  {
    name: 'chat mode shipped half',
    match: /Chat-path register \(deferred within B4\)/,
    replacement: [
      '- `[correctness]` **Chat-path register half remains owner-gated.** Chat `coach_mode` is shipped, but routine/elevated/max register selection and any profanity permission for free-form replies remain deliberately null until an owner-approved register contract is defined. `ATLAS_COACH_PROFANITY` stays off.',
    ],
  },
];

function applyRules(text) {
  const lines = text.split('\n');
  const archived = [];
  for (const rule of RULES) {
    const index = lines.findIndex((line) => indentOf(line) === 0 && rule.match.test(line));
    if (index < 0) throw new Error(`missing expected block: ${rule.name}`);
    const end = itemEnd(lines, index, 0);
    archived.push({ name: rule.name, block: lines.slice(index, end).join('\n').replace(/\s+$/, '') });
    lines.splice(index, end - index, ...rule.replacement);
  }
  return { text: lines.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\s+$/, '') + '\n', archived };
}

function removeDuplicateArchiveSections(text) {
  // The exact pre-resection snapshot already preserves these records verbatim. Later append-only
  // audit sections duplicated them; keep the verification report instead of a second copy.
  return text
    .replace(/\n\n## Final editorial prune — 2026-07-30[\s\S]*?(?=\n\n## F10\/current-state reconciliation — 2026-07-30|$)/, '')
    .replace(/\n\n## F10\/current-state reconciliation — 2026-07-30[\s\S]*$/, '')
    .replace(/\s+$/, '') + '\n';
}

function main() {
  const before = fs.readFileSync(BACKLOG, 'utf8');
  const { text: after, archived } = applyRules(before);
  const oldLines = countLines(before);
  const newLines = countLines(after);
  if (newLines >= oldLines) throw new Error(`residual condensation did not shrink (${oldLines} -> ${newLines})`);

  let archive = removeDuplicateArchiveSections(fs.readFileSync(ARCHIVE, 'utf8'));
  const section = [
    '',
    `## Condensed shipped-parent narratives — ${TODAY}`,
    '',
    'The active backlog now carries only the remaining action from each block below. The full shipped-parent narrative is preserved here.',
    '',
    ...archived.flatMap(({ name, block }) => [`### ${name}`, '', block, '']),
  ].join('\n').replace(/\s+$/, '') + '\n';
  archive = archive.replace(/\s+$/, '') + '\n\n' + section;

  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  cfg._note = 'Drift Guard 6 (PAPER-WEIGHT). CI fails when BACKLOG.md exceeds backlog_max_lines or when a human-confirmed [archive-ready: YYYY-MM-DD] item remains longer than stale_after_days. Ordinary maintenance remains explicit-tag-only and never guesses from free-text completion words. The owner-authorized 2026-07-30 editorial reconciliation/resection is complete; completed history lives in BACKLOG_ARCHIVE.md, while BACKLOG.md is the concise open/deferred ledger. Run `npm run archive:backlog -- --apply` for future tagged items; lower the cap whenever the file shrinks, and raise it only with recorded justification.';
  const cap = Math.min(cfg.backlog_max_lines, newLines);
  cfg.backlog_max_lines = cap;
  cfg._raise_log = `${cfg._raise_log || ''} ${TODAY}: condensed 4 shipped-parent narratives to their live residuals, removed duplicate archive copies already preserved in the exact historical snapshot, BACKLOG ${oldLines} -> ${newLines}; cap -> ${cap}.`.trim();

  const reportBefore = fs.readFileSync(REPORT, 'utf8').replace(/\s+$/, '');
  const reportAdd = [
    '', '',
    '## Residual condensation pass',
    '',
    '- Shipped-parent narratives condensed: **4**',
    `- ` + '`BACKLOG.md`' + ` lines: **${oldLines} → ${newLines}**`,
    '- Duplicate archive copies removed: **yes; exact historical snapshot retained**',
    '- Paper-weight note updated to reflect completed resection: **yes**',
    '- Runtime/code behavior changed: **no**',
    '',
  ].join('\n');

  fs.writeFileSync(BACKLOG, after);
  fs.writeFileSync(ARCHIVE, archive);
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  fs.writeFileSync(REPORT, reportBefore + reportAdd);

  for (const rel of ['scripts/backlog-condense-residuals-once.js', '.github/workflows/backlog-condense-residuals-once.yml']) {
    try { fs.unlinkSync(path.join(ROOT, rel)); } catch (_) { /* no-op */ }
  }
  console.log(`Condensed ${archived.length} blocks; BACKLOG ${oldLines}->${newLines}; cap ${cap}`);
}

main();
