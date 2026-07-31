'use strict';

// Drift Guard 7 — BOUNDED BACKLOG LEDGER (owner ruling 2026-07-30, final form 2026-07-31).
//
// Spec: docs/ATLAS_V1_EXECUTION_PLAN.md "OWNER RULING — bounded backlog ledger" and
// "Drift guards" #7. Published in CLAUDE.md.
//
// BACKLOG.md is a BOUNDED, ACTIVELY CONSUMED evidence ledger of proven deferred work. It
// preserves findings; it never selects work, authorizes a PR, or competes with the execution
// plan. Intake is allowed — under a fixed capacity.
//
// THE FIXED-CAPACITY RULE. BACKLOG.md may never grow in top-level item count, in total line
// count, or in config/paper-weight.json `backlog_max_lines`. A PR that adds an item must
// archive, reject, resolve, deduplicate, or promote enough existing content that all three
// counts stay flat or fall.
//
// So a NET-NEUTRAL REPLACEMENT — one item in, one item out — is the intended bounded-intake
// operation, not a loophole. This guard deliberately permits it and cannot judge whether the
// removed content was genuinely fixed, stale, duplicated, rejected, archived, or promoted.
// That honesty check belongs to exact-head review and to the merge card, where a PR adding an
// item must name the added item, the removed item, and the resulting counts. Removing a
// valuable item merely to make room is a review failure, never a green build.
//
// The guard is MECHANICAL — three counts, no prose classification, no semantic similarity
// matching. Nothing written in the diff (a rationale, an owner-sounding note, a justification
// in config/paper-weight.json) changes its answer:
//
//  1. BACKLOG.md top-level items may not increase.
//  2. BACKLOG.md lines may not increase. This also covers an item written as a paragraph, a
//     table row, or an indented child instead of a bullet, without classifying any text.
//  3. `backlog_max_lines` may not increase. The cap is permanently non-increasing; CI may
//     never be made green by raising it.
//
// It FAILS CLOSED: a base ref that cannot be resolved, fetched, or parsed is an error, never a
// silent pass, because an unreadable base leaves nothing to compare against.
//
// Removal, archival, deduplication, promotion into the execution plan, and in-place correction
// all pass — none of them raises a count.

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

// A top-level work item is a list item at the outer level. Markdown accepts "-", "*", and "+"
// as unordered markers and "1." / "1)" as ordered ones; all count, because any of them adds an
// item — a builder converting an existing blank line to "+ new work" would otherwise add an
// item without adding a line.
//
// Leading space: 0 or 1. A marker indented one space is still a sibling, because a "- " parent's
// content starts at column 2, so only an indent of 2 or more makes the bullet that parent's
// CHILD. Accepting 0-1 closes the " - new item" bypass without reclassifying the file's nested
// children (BACKLOG.md today: 282 bullets at column 0, 48 at two spaces, 7 at four, none at one).
const TOP_LEVEL_ITEM_RE = /^ ?([-*+]|\d+[.)])\s/;

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
      `${BACKLOG_REL} grew by ${headItems - baseItems} item(s) (${baseItems} → ${headItems}). The backlog is a `
      + 'BOUNDED ledger: adding an item requires archiving, rejecting, resolving, deduplicating, or promoting '
      + 'enough existing content to keep the item count flat or falling. Either make room, or give the finding a '
      + 'different disposition: FIX NOW, REJECT, or OWNER DECISION REQUIRED.',
    );
  }

  if (headLines > baseLines) {
    errors.push(
      `${BACKLOG_REL} grew ${baseLines} → ${headLines} lines. The bounded ledger never grows: an added item has `
      + 'to be paid for by removing, archiving, or promoting at least as many lines. Keep the entry compact.',
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
      `${CONFIG_REL}: backlog_max_lines rose ${baseCap} → ${headCap}. The cap is permanently non-increasing — `
      + 'never raise it to make CI pass or to fit a new item. Archive or promote existing records instead '
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
    const msg = 'Drift Guard 7 — bounded backlog: no base ref given (pass one, or set GITHUB_BASE_REF).';
    if (requireBase) { console.error(`❌ ${msg}`); return 1; }
    console.log(`⏭️  ${msg} Skipped — this guard compares a PR against its base.`);
    return 0;
  }

  let mergeBase;
  try { mergeBase = gitRev(['merge-base', baseRef, 'HEAD']); }
  catch (e) {
    console.error(`❌ Drift Guard 7 — bounded backlog: cannot resolve the merge base of "${baseRef}" and HEAD (${String(e.stderr || e.message).trim()}).`);
    return 1;
  }

  const base = { backlog: showAt(mergeBase, BACKLOG_REL), config: showAt(mergeBase, CONFIG_REL) };
  if (!base.backlog || !base.config) {
    console.error(
      `❌ Drift Guard 7 — bounded backlog: cannot read ${!base.backlog ? BACKLOG_REL : CONFIG_REL} at the base `
      + `commit ${mergeBase.slice(0, 8)} — failing closed. Fetch the base ref and re-run.`,
    );
    return 1;
  }
  const head = { backlog: readWorkingTree(BACKLOG_REL), config: readWorkingTree(CONFIG_REL) };
  const r = analyze({ base, head });

  if (!r.valid) {
    console.error(`❌ Bounded-backlog guard FAILED (base ${mergeBase.slice(0, 8)}):\n- ` + r.errors.join('\n- '));
    return 1;
  }
  const delta = r.headItems === r.baseItems && r.headLines === r.baseLines ? 'flat' : 'reduced';
  console.log(
    `✅ Bounded-backlog guard OK — capacity ${delta} (items ${r.baseItems} → ${r.headItems}, `
    + `lines ${r.baseLines} → ${r.headLines}, cap ${r.baseCap} → ${r.headCap}); base ${mergeBase.slice(0, 8)}. `
    + 'A net-neutral replacement is intentional bounded intake; review verifies the removal was honest.',
  );
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2), process.env));
}

module.exports = { analyze, countItems, countLines, resolveBaseRef };
