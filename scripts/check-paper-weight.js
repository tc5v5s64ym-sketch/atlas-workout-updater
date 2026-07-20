'use strict';

// Drift Guard 6 — PAPER-WEIGHT GUARD (Phase 2).
//
// Spec: docs/ATLAS_V1_EXECUTION_PLAN.md "Drift guards" #6 — "CI fails when BACKLOG.md
// exceeds its size cap or contains shipped items older than seven days; an auto-archive
// job keeps it clean." Published in CLAUDE.md.
//
// Enforces the SIZE CAP now (shrink-only ratchet): BACKLOG.md may not exceed
// config/paper-weight.json `backlog_max_lines`. The cap ratchets DOWN as the backlog
// archive editorial pass trims the file; raising it needs a recorded justification.
//
// The STALENESS sub-rule (shipped items > 7 days) and the AUTO-ARCHIVE job are deferred
// to that editorial pass (see the config `_note`): a reliable fully-shipped-vs-open-
// follow-up detector is the same per-item judgment BACKLOG.md's header says a mechanical
// pass cannot safely make. Wiring a false-positive-prone staleness gate now would fail
// CI on the many ✅-with-open-follow-up items the file deliberately keeps.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKLOG = path.join(ROOT, 'BACKLOG.md');
const CONFIG = path.join(ROOT, 'config', 'paper-weight.json');

function countLines(text) { return (String(text).match(/\n/g) || []).length; } // matches `wc -l`

/**
 * Pure analysis. `config` (parsed paper-weight.json) and `backlog` (BACKLOG.md text)
 * are injectable for tests; default to the real files. Never throws.
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
  const cap = cfg && cfg.backlog_max_lines;
  if (!Number.isInteger(cap) || cap <= 0) {
    return { valid: false, errors: ['backlog_max_lines: must be a positive integer (the shrink-only size cap)'] };
  }
  if (typeof cfg._note !== 'string' || !cfg._note.trim()) {
    errors.push('config/paper-weight.json: a non-empty _note is required');
  }
  const lines = countLines(text);
  if (lines > cap) {
    errors.push(`BACKLOG.md has ${lines} lines but the cap is ${cap} — trim/archive shipped items (do not raise the cap without a recorded justification).`);
  }
  return { valid: errors.length === 0, errors, lines, cap };
}

if (require.main === module) {
  const r = analyze();
  if (!r.valid) {
    console.error('❌ Paper-weight guard FAILED:\n- ' + r.errors.join('\n- '));
    process.exit(1);
  }
  console.log(`✅ Paper-weight guard OK — BACKLOG.md ${r.lines}/${r.cap} lines (shrink-only; cap ratchets down as the archive pass trims it).`);
}

module.exports = { analyze, countLines };
