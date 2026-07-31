'use strict';

// Drift Guard 7 — BACKLOG INTAKE CLOSURE (owner ruling 2026-07-30).
//
// Spec: docs/ATLAS_V1_EXECUTION_PLAN.md "OWNER RULING — 2026-07-30 — Backlog intake closed"
// and "Drift guards" #7. Published in CLAUDE.md.
//
// BACKLOG.md is a FROZEN LEGACY INVENTORY. A new finding gets one disposition — FIX NOW,
// REJECT, or OWNER DECISION REQUIRED — never a backlog line. Owner correction 2026-07-31:
// GitHub Issues are not a replacement backlog, so "file it as an issue" is not a disposition.
//
// The guard is deliberately MECHANICAL: it compares three counts between the PR base and the
// head and never reads or classifies prose. Nothing written in the diff — a rationale, an
// owner-sounding note, a justification in config/paper-weight.json — can make it pass.
//
//  1. BACKLOG.md top-level work items (column-0 bullets) may not increase.
//  2. BACKLOG.md lines may not increase. This covers a finding written as a paragraph, a
//     table row, or an indented child instead of a bullet, without classifying any text.
//  3. config/paper-weight.json `backlog_max_lines` may not increase. The cap is permanently
//     non-increasing; CI may never be made green by raising it.
//
// It FAILS CLOSED: a base ref that cannot be resolved, fetched, or parsed is an error, never a
// silent pass, because an unreadable base leaves nothing to compare against.
//
// Removal, archival, deduplication, and in-place correction all pass — none of them raise a
// count. KNOWN LIMIT: deleting one item and adding a different one keeps every count flat, so
// this guard does not catch that swap. Catching it needs semantic diff matching, which the
// owner ruling deliberately excludes; PR review and the merge card's "Additional findings"
// field cover it.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BACKLOG_REL = 'BACKLOG.md';
const CONFIG_REL = 'config/paper-weight.json';

/**
 * Count real lines, INCLUDING a final line with no terminating newline. `wc -l` semantics
 * (newline characters only) would let a builder append content while dropping the trailing
 * newline: the file gains a line in the diff but the newline count is unchanged, which passes
 * the growth check. Counting content lines closes that.
 */
function countLines(text) {
  const s = String(text);
  if (s === '') return 0;
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

// A top-level work item is a column-0 list item. Markdown accepts "-", "*", and "+" as
// unordered markers and "1." / "1)" as ordered ones; all of them are counted, because any of
// them adds an item — a builder converting an existing blank line to "+ new work" would
// otherwise add an item without adding a line.
const TOP_LEVEL_ITEM_RE = /^([-*+]|\d+[.)])\s/;

/**
 * Count top-level work items. Fenced code blocks are skipped so an example bullet inside ```
 * never counts. Pure; never throws.
 */
function countItems(text) {
  let items = 0;
  let inFence = false;
  for (const line of String(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence && TOP_LEVEL_ITEM_RE.test(line)) items++;
  }
  return items;
}

function parseConfig(value, label, errors) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); }
  catch (e) { errors.push(`${label}: cannot parse ${CONFIG_REL} (${e.message})`); return null; }
}

function capOf(config) {
  const cap = config && config.backlog_max_lines;
  return Number.isInteger(cap) && cap > 0 ? cap : null;
}

/**
 * Pure analysis of one diff. `base` and `head` are `{ backlog: string, config: object|string }`.
 * A missing base backlog reads as empty, so a re-created file reports its items as new intake
 * rather than passing. Never throws.
 */
function analyze({ base, head } = {}) {
  const errors = [];
  const baseBacklog = (base && base.backlog) || '';
  const headBacklog = (head && head.backlog) || '';
  const baseCap = capOf(parseConfig(base && base.config, 'base', errors));
  const headCap = capOf(parseConfig(head && head.config, 'head', errors));

  const baseItems = countItems(baseBacklog);
  const headItems = countItems(headBacklog);
  const baseLines = countLines(baseBacklog);
  const headLines = countLines(headBacklog);

  if (headItems > baseItems) {
    errors.push(
      `${BACKLOG_REL} adds ${headItems - baseItems} work item(s) (${baseItems} → ${headItems}) — backlog intake `
      + 'is CLOSED (owner ruling 2026-07-30). Give the finding a disposition instead: FIX NOW (fix it in this PR), '
      + 'REJECT (record the rationale in the PR discussion), or OWNER DECISION REQUIRED (stop and report it to '
      + 'the owner — no GitHub issue, no backlog line).',
    );
  }

  if (headLines > baseLines) {
    errors.push(
      `${BACKLOG_REL} grew ${baseLines} → ${headLines} lines. The frozen inventory never grows; it may only be `
      + 'corrected, deduplicated, archived, or reduced, so a correction must be net-neutral or reducing.',
    );
  }

  // Fail closed: without a readable base cap there is nothing to compare against, so the
  // cap rule would silently pass. An unfetched or unparseable base is a failure, never a skip.
  if (baseCap === null) {
    errors.push(
      `${CONFIG_REL}: cannot read backlog_max_lines at the PR base — failing closed. `
      + 'Fetch the base ref (`git fetch --no-tags origin <base>`) and re-run.',
    );
  }

  if (headCap === null) {
    errors.push(`${CONFIG_REL}: backlog_max_lines must be a positive integer (head).`);
  } else if (baseCap !== null && headCap > baseCap) {
    errors.push(
      `${CONFIG_REL}: backlog_max_lines rose ${baseCap} → ${headCap}. The paper-weight cap is permanently `
      + 'non-increasing — do not raise it to make CI pass. Archive or reduce the file instead '
      + '(`npm run archive:backlog -- --apply`).',
    );
  }

  return { valid: errors.length === 0, errors, baseItems, headItems, baseLines, headLines, baseCap, headCap };
}

// ---------------------------------------------------------------------------
// CLI — resolve the PR base from git, then run the pure analysis.
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A ref or object id, whitespace stripped. File CONTENT is never trimmed — see showAt. */
function gitRev(args) { return git(args).trim(); }

/** The base ref to diff against: an explicit argument, else the PR base branch from CI. */
function resolveBaseRef(argv, env) {
  const explicit = argv.find((a) => a && !a.startsWith('-'));
  if (explicit) return explicit.replace(/\.{2,3}HEAD$/, '');
  if (env.ATLAS_BASE_REF) return env.ATLAS_BASE_REF;
  if (env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`;
  return null;
}

/**
 * File content at a commit, verbatim, or '' when the file did not exist there. The content is
 * never trimmed: trimming would drop the trailing newline and make every base file read one
 * line shorter than the working tree, which false-fails the line-growth check.
 */
function showAt(rev, rel) {
  try { return git(['show', `${rev}:${rel}`]); }
  catch { return ''; }
}

function readWorkingTree(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
  catch { return ''; }
}

function run(argv, env) {
  const requireBase = argv.includes('--require-base');
  const baseRef = resolveBaseRef(argv, env);

  if (!baseRef) {
    const msg = 'Drift Guard 7 — backlog intake: no base ref given (pass one, or set GITHUB_BASE_REF).';
    if (requireBase) { console.error(`❌ ${msg}`); return 1; }
    console.log(`⏭️  ${msg} Skipped — this guard compares a PR against its base.`);
    return 0;
  }

  let mergeBase;
  try { mergeBase = gitRev(['merge-base', baseRef, 'HEAD']); }
  catch (e) {
    console.error(`❌ Drift Guard 7 — backlog intake: cannot resolve the merge base of "${baseRef}" and HEAD (${String(e.stderr || e.message).trim()}).`);
    return 1;
  }

  const base = { backlog: showAt(mergeBase, BACKLOG_REL), config: showAt(mergeBase, CONFIG_REL) };
  if (!base.backlog || !base.config) {
    console.error(
      `❌ Drift Guard 7 — backlog intake: cannot read ${!base.backlog ? BACKLOG_REL : CONFIG_REL} at the base `
      + `commit ${mergeBase.slice(0, 8)} — failing closed. Fetch the base ref and re-run.`,
    );
    return 1;
  }
  const head = { backlog: readWorkingTree(BACKLOG_REL), config: readWorkingTree(CONFIG_REL) };
  const r = analyze({ base, head });

  if (!r.valid) {
    console.error(`❌ Backlog-intake guard FAILED (base ${mergeBase.slice(0, 8)}):\n- ` + r.errors.join('\n- '));
    return 1;
  }
  console.log(
    `✅ Backlog-intake guard OK — no new intake (items ${r.baseItems} → ${r.headItems}, `
    + `lines ${r.baseLines} → ${r.headLines}, cap ${r.baseCap} → ${r.headCap}); base ${mergeBase.slice(0, 8)}.`,
  );
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2), process.env));
}

module.exports = { analyze, countItems, countLines, resolveBaseRef };
