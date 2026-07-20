'use strict';

// Drift Guard 6 — PAPER-WEIGHT GUARD (Phase 2).
//
// Spec: docs/ATLAS_V1_EXECUTION_PLAN.md "Drift guards" #6 — "CI fails when BACKLOG.md
// exceeds its size cap or contains shipped items older than seven days; an auto-archive
// job keeps it clean." Published in CLAUDE.md.
//
// Enforces two of the three parts here (the third — the auto-archive JOB — is
// scripts/archive-backlog.js, run to clear a staleness failure):
//
//  1. SIZE CAP (shrink-only ratchet): BACKLOG.md may not exceed
//     config/paper-weight.json `backlog_max_lines`. The cap ratchets DOWN as the
//     archive job trims the file; raising it needs a recorded justification.
//
//  2. STALENESS (shipped items > 7 days): CI fails when an item explicitly tagged
//     `[archive-ready: YYYY-MM-DD]` lingers more than `stale_after_days` (default 7)
//     past that date. The tag is an EXPLICIT, human-confirmed signal — the guard
//     never guesses archivability from free text, because the 2026-07-20 archive
//     reconciliation proved you cannot reliably tell a fully-shipped item from a
//     ✅-with-open-follow-up item by heuristics (docs/verification/BACKLOG_RECONCILIATION_2026-07-20.md).
//     So the staleness rule cannot false-fail the many ✅-with-open-follow-up items the
//     file deliberately keeps; it only fires on an item a human deliberately marked ready.
//     Clear a staleness failure by running `npm run archive:backlog -- --apply`.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKLOG = path.join(ROOT, 'BACKLOG.md');
const CONFIG = path.join(ROOT, 'config', 'paper-weight.json');

const DEFAULT_STALE_AFTER_DAYS = 7;

// Matches the archive-ready MARKER by name, independent of its ": date" syntax — the whole
// bracket payload (everything after "archive-ready" up to "]") is captured and then validated,
// so a mistyped marker (`[archive-ready]`, `[archive-ready : 2026-07-01]`, `[archive-ready: someday]`,
// `[archive-ready: 2026-7-01]`) is reported MALFORMED rather than silently slipping past staleness.
// Detecting on the strict ": YYYY-MM-DD" shape here would let any such typo bypass the guard.
const ARCHIVE_READY_RE = /\[archive-ready\b([^\]]*)\]/gi;

// Classify one marker's payload (the text between "archive-ready" and "]"). The canonical form
// is exactly ": <token>"; anything else (no colon, space before the colon, empty, extra tokens)
// is malformed. A canonical payload's token is then validated as a real YYYY-MM-DD calendar date.
function classifyArchiveReadyPayload(payload) {
  const canon = /^:\s*(\S+?)\s*$/.exec(payload);
  const dateStr = canon ? canon[1] : (String(payload).trim() || '(empty)');
  const ms = canon ? parseIsoDayUtc(canon[1]) : NaN;
  return { dateStr, ms: Number.isNaN(ms) ? null : ms, valid: !Number.isNaN(ms) };
}

// Every archive-ready marker on a single line, classified. Shared by the staleness check and the
// auto-archive job so the two can never disagree on what counts as a valid archival marker.
function archiveReadyTags(line) {
  const out = [];
  for (const m of String(line).matchAll(ARCHIVE_READY_RE)) out.push(classifyArchiveReadyPayload(m[1]));
  return out;
}

function countLines(text) { return (String(text).match(/\n/g) || []).length; } // matches `wc -l`

// Parse a YYYY-MM-DD string to a UTC-midnight epoch (ms). Returns NaN if invalid.
function parseIsoDayUtc(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return NaN;
  const [, y, mo, d] = m.map(Number);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // Reject calendar-impossible dates (e.g. 2026-13-45).
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  return t;
}

// UTC-midnight epoch (ms) for a Date's calendar day.
function dayUtc(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// Every archive-ready tag in the text, with its 1-based line number and age in whole days
// relative to `today` (a Date). Malformed dates are reported so they can't silently pass.
function findArchiveReady(text, today) {
  const nowDay = dayUtc(today);
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const tag of archiveReadyTags(lines[i])) {
      const ageDays = tag.valid ? Math.floor((nowDay - tag.ms) / 86400000) : NaN;
      out.push({ line: i + 1, dateStr: tag.dateStr, ageDays, malformed: !tag.valid });
    }
  }
  return out;
}

/**
 * Pure analysis. `config` (parsed paper-weight.json), `backlog` (BACKLOG.md text), and
 * `today` (a Date) are injectable for tests; default to the real files / real clock.
 * Never throws.
 */
function analyze({ config, backlog, today } = {}) {
  let cfg = config;
  if (cfg === undefined) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
    catch (e) { return { valid: false, errors: [`cannot read config/paper-weight.json: ${e.message}`] }; }
  }
  let text = backlog;
  if (text === undefined) {
    try { text = fs.readFileSync(BACKLOG, 'utf8'); }
    catch (e) { return { valid: false, errors: [`cannot read BACKLOG.md: ${e.message}`] }; }
  }
  const now = today instanceof Date ? today : new Date();

  const errors = [];
  const cap = cfg && cfg.backlog_max_lines;
  if (!Number.isInteger(cap) || cap <= 0) {
    return { valid: false, errors: ['backlog_max_lines: must be a positive integer (the shrink-only size cap)'] };
  }
  if (typeof cfg._note !== 'string' || !cfg._note.trim()) {
    errors.push('config/paper-weight.json: a non-empty _note is required');
  }

  // 1. Size cap.
  const lines = countLines(text);
  if (lines > cap) {
    errors.push(`BACKLOG.md has ${lines} lines but the cap is ${cap} — trim/archive shipped items (do not raise the cap without a recorded justification).`);
  }

  // 2. Staleness on explicit [archive-ready: DATE] tags.
  const staleAfter = Number.isInteger(cfg.stale_after_days) && cfg.stale_after_days > 0
    ? cfg.stale_after_days : DEFAULT_STALE_AFTER_DAYS;
  const tags = findArchiveReady(text, now);
  const stale = [];
  for (const t of tags) {
    if (t.malformed) {
      errors.push(`BACKLOG.md line ${t.line}: malformed [archive-ready: ${t.dateStr}] date — use YYYY-MM-DD.`);
      continue;
    }
    if (t.ageDays > staleAfter) stale.push(t);
  }
  if (stale.length) {
    const list = stale.map((t) => `line ${t.line} (${t.dateStr}, ${t.ageDays}d)`).join(', ');
    errors.push(
      `BACKLOG.md has ${stale.length} archive-ready item(s) older than ${staleAfter} days: ${list}. ` +
      `Run \`npm run archive:backlog -- --apply\` to move them to BACKLOG_ARCHIVE.md and ratchet the cap.`,
    );
  }

  return { valid: errors.length === 0, errors, lines, cap, archiveReady: tags.length, stale: stale.length };
}

if (require.main === module) {
  const r = analyze();
  if (!r.valid) {
    console.error('❌ Paper-weight guard FAILED:\n- ' + r.errors.join('\n- '));
    process.exit(1);
  }
  const staleNote = r.archiveReady
    ? ` · ${r.archiveReady} archive-ready item(s), none stale`
    : '';
  console.log(`✅ Paper-weight guard OK — BACKLOG.md ${r.lines}/${r.cap} lines (shrink-only; cap ratchets down as the archive job trims it)${staleNote}.`);
}

module.exports = { analyze, countLines, findArchiveReady, parseIsoDayUtc, archiveReadyTags };
