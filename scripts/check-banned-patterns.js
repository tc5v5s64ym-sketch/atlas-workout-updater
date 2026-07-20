'use strict';

// Drift Guard 2 — BANNED-PATTERN GUARD (Phase 2; grow-only list).
//
// Spec: docs/ATLAS_V1_EXECUTION_PLAN.md "Drift guards" #2 — forbidden in production
// paths: normal-path receipt templates; route-local recomputation of packet-owned
// facts; legacy analytics imports for promoted decision types; duplicate safety
// classifiers; session-truth selectors outside WorkoutSession. "Add each pattern as
// its finding is retired." Published in CLAUDE.md.
//
// Only H-02 (the normal-path routine receipt) is retired so far (Soul gate, Phase 1),
// so the registry enforces exactly that today and GROWS as later findings retire
// (packet-owned recomputation → Phase 4, duplicate classifiers → Phase 5d, …).
//
// Owner ruling (2026-07-20): a "receipt template" is a CONTENTLESS acknowledgement
// (e.g. "On plan — logged."). A brief, data-grounded wrap line (templatedOnPlanWrapLine)
// carries facts and is NOT a receipt — it stays legal. The retired receipt itself is
// legal ONLY inside the documented OUTAGE-ONLY fallback (templatedAckLine); this guard
// pins it there and fails the build if it reappears anywhere else on a production path.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src/app', 'services']; // production coach/client paths (tests excluded)

// Grow-only. Each entry: a retired finding's forbidden production-path pattern, plus
// the functions where an occurrence is still sanctioned (e.g. an outage-only fallback).
const BANNED_PATTERNS = [
  {
    id: 'normal-path-receipt',
    finding: 'H-02',
    re: /on plan\s*[—–-]\s*logged/i,
    allowFns: ['templatedAckLine'], // the one sanctioned OUTAGE-ONLY home
    note: 'contentless "On plan — logged." receipt retired from the normal path (Soul gate); legal ONLY inside the OUTAGE-ONLY templatedAckLine fallback (2026-07-20 owner ruling). A data-grounded wrap line (templatedOnPlanWrapLine) is not a receipt.',
  },
];

const FN_DECL = /\bfunction\s+([A-Za-z_$][\w$]*)/;
const FN_EXPR = /\b([A-Za-z_$][\w$]*)\s*[=:]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/;

// Blank out comment content while preserving line count/positions, so the guard
// matches only what the coach actually RENDERS (a string literal) — never a comment
// that legitimately documents the retired receipt (e.g. "…'On plan — logged.' is gone").
// String literals are preserved (only // and /* */ comments are stripped). It does not
// track `//` inside a string — acceptable for these narrow, receipt-style patterns.
function stripComments(content) {
  const lines = String(content).split('\n');
  let inBlock = false;
  return lines.map((line) => {
    let out = '';
    for (let i = 0; i < line.length; i += 1) {
      if (inBlock) {
        if (line[i] === '*' && line[i + 1] === '/') { inBlock = false; i += 1; }
        continue;
      }
      if (line[i] === '/' && line[i + 1] === '*') { inBlock = true; i += 1; continue; }
      if (line[i] === '/' && line[i + 1] === '/') break; // rest of the line is a comment
      out += line[i];
    }
    return out;
  });
}

// The name of the nearest function declaration at or above line `idx`, or null.
function enclosingFn(lines, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    const m = lines[i].match(FN_DECL) || lines[i].match(FN_EXPR);
    if (m) return m[1];
  }
  return null;
}

function _walk(absDir, out) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) _walk(abs, out);
    else if (e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(abs);
  }
}

function _defaultFiles() {
  const out = [];
  for (const d of SCAN_DIRS) _walk(path.join(ROOT, d), out);
  return out.map((abs) => ({ path: path.relative(ROOT, abs), content: fs.readFileSync(abs, 'utf8') }));
}

/**
 * Pure analysis. `files` is an optional [{ path, content }] list (injected for tests);
 * defaults to the real production files under SCAN_DIRS. Never throws.
 */
function analyze(files) {
  const list = Array.isArray(files) ? files : _defaultFiles();
  const violations = [];
  for (const { path: rel, content } of list) {
    const lines = stripComments(content); // match rendered code only, not comments
    for (const pat of BANNED_PATTERNS) {
      lines.forEach((line, i) => {
        if (!pat.re.test(line)) return;
        const fn = enclosingFn(lines, i);
        if (!pat.allowFns.includes(fn)) {
          violations.push({ file: rel, line: i + 1, pattern: pat.id, finding: pat.finding, fn: fn || '(top level)' });
        }
      });
    }
  }
  return { valid: violations.length === 0, violations };
}

if (require.main === module) {
  const r = analyze();
  if (!r.valid) {
    console.error('❌ Banned-pattern guard FAILED — forbidden production-path pattern(s):');
    for (const v of r.violations) console.error(`  - ${v.file}:${v.line}  [${v.pattern} / ${v.finding}]  in ${v.fn}`);
    const seen = new Set(r.violations.map((v) => v.pattern));
    for (const pat of BANNED_PATTERNS) if (seen.has(pat.id)) console.error(`    · ${pat.id}: ${pat.note}`);
    process.exit(1);
  }
  console.log(`✅ Banned-pattern guard OK — none of the ${BANNED_PATTERNS.length} retired pattern(s) present on a production path.`);
}

module.exports = { analyze, BANNED_PATTERNS, enclosingFn };
