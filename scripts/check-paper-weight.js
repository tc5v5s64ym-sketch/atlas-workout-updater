'use strict';

// Drift Guard 6 — PAPER-WEIGHT GUARD (Phase 2), NARROWED 2026-10-28.
//
// Spec: docs/ATLAS_V1_EXECUTION_PLAN.md "OWNER RULING — 2026-10-28 — BACKLOG MOVES TO
// THE GITHUB ISSUES BOARD" and CLAUDE.md Guard 6. The backlog now lives as GitHub
// Issues (label `backlog`); BACKLOG.md is a frozen pointer stub. The pre-migration
// rules — the shrink-only size cap on the ledger (config `backlog_max_lines`) and
// the [archive-ready] staleness rule over ledger contents — enforced backlog
// CONTENTS and were retired with the migration. What survives, narrowed to the
// post-migration failure mode (findings quietly re-accumulating in the file
// instead of the Issues board):
//
//  STUB INTEGRITY: BACKLOG.md must exist, must carry the Issues-board pointer
//  (the `label:backlog` issues query URL), and must not exceed
//  config/paper-weight.json `backlog_stub_max_lines`.
//
// The archive-ready marker helpers below are UNCHANGED: scripts/archive-backlog.js
// still imports them (countLines, archiveReadyTags) to move explicitly tagged
// items to BACKLOG_ARCHIVE.md, and the tag remains the only archival signal —
// nothing here guesses archivability from free text (2026-07-20 reconciliation,
// docs/verification/BACKLOG_RECONCILIATION_2026-07-20.md).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKLOG = path.join(ROOT, 'BACKLOG.md');
const CONFIG = path.join(ROOT, 'config', 'paper-weight.json');

// The pointer the frozen stub must carry: the GitHub Issues board query for the
// backlog label. Exact substring of the stub's board URL.
const BOARD_POINTER = 'issues?q=label%3Abacklog';

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
 * Pure analysis (narrowed form). `config` (parsed paper-weight.json) and `backlog`
 * (BACKLOG.md text) are injectable for tests; default to the real files.
 * Never throws.
 */
function analyze({ config, backlog } = {}) {
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

  const errors = [];
  const stubMax = cfg && cfg.backlog_stub_max_lines;
  if (!Number.isInteger(stubMax) || stubMax <= 0) {
    return { valid: false, errors: ['backlog_stub_max_lines: must be a positive integer (the frozen-stub line bound)'] };
  }
  if (typeof cfg._note !== 'string' || !cfg._note.trim()) {
    errors.push('config/paper-weight.json: a non-empty _note is required');
  }

  // Stub integrity 1 — the Issues-board pointer must be present.
  if (!String(text).includes(BOARD_POINTER)) {
    errors.push(
      'BACKLOG.md no longer carries the GitHub Issues backlog pointer ' +
      `(${BOARD_POINTER}) — it is a frozen pointer stub since the 2026-10-28 migration; ` +
      'restore the pointer instead of editing the stub back into a ledger.',
    );
  }

  // Stub integrity 2 — the stub must stay within its line bound.
  const lines = countLines(text);
  if (lines > stubMax) {
    errors.push(
      `BACKLOG.md has ${lines} lines but the frozen-stub bound is ${stubMax} — ` +
      'the backlog lives on the GitHub Issues board (label: backlog); open an Issue instead of adding items here.',
    );
  }

  return { valid: errors.length === 0, errors, lines, stubMaxLines: stubMax };
}

if (require.main === module) {
  const r = analyze();
  if (!r.valid) {
    console.error('❌ Paper-weight guard FAILED:\n- ' + r.errors.join('\n- '));
    process.exit(1);
  }
  console.log(`✅ Paper-weight guard OK — BACKLOG.md is the frozen pointer stub (${r.lines}/${r.stubMaxLines} lines) to the GitHub Issues backlog.`);
}

module.exports = { analyze, countLines, findArchiveReady, parseIsoDayUtc, archiveReadyTags };
