'use strict';

// Drift Guard 1 — AUTHORITY CONSISTENCY (Phase 2).
//
// Spec: docs/ATLAS_V1_EXECUTION_PLAN.md "Drift guards" #1 — "one declared
// active-campaign line must match exactly across CLAUDE.md, the execution plan,
// and the docs index; every open issue labeled `owner-instruction` must be
// referenced in the plan; otherwise CI fails." Published in CLAUDE.md.
//
// This guard enforces PART A deterministically (no network): the single canonical
// active-campaign marker is present and consistent across the three authority
// documents, and both CLAUDE.md and the docs index name the execution plan as the
// sole work-selection authority. If any doc drops or diverges from the marker, or
// stops naming the plan as the authority, the build fails — closing H-01
// (conflicting execution authority) at the paper layer.
//
// PART B — "every OPEN issue labeled `owner-instruction` is referenced in the
// plan" — requires the GitHub API (open-issue state is not in the repo) and is a
// documented follow-up (BACKLOG `[housekeeping]`), to be added as a workflow step
// with the authenticated token; this script stays pure/offline so it is unit-testable.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// The one canonical active-campaign identifier. Exactly this string must appear in
// every authority document; changing the active campaign means changing it in ALL
// of them in one PR (that is the point of the guard).
const CAMPAIGN_MARKER = 'Atlas Recovery Campaign (Issue #1073)';
const PLAN_PATH = 'docs/ATLAS_V1_EXECUTION_PLAN.md';
const AUTHORITY_DOCS = ['CLAUDE.md', PLAN_PATH, 'docs/DOCS_INDEX.md'];
// Docs that must additionally declare the plan the sole authority (the plan itself
// need not point at itself).
const AUTHORITY_DECLARERS = ['CLAUDE.md', 'docs/DOCS_INDEX.md'];
const SOLE_AUTHORITY_RE = /sole\s+(active\s+)?(execution|work-selection)/i;

/**
 * Pure analysis. `readFile(relPath) => string` is injectable so the guard can be
 * unit-tested against synthetic drift without touching real files. Total: a read
 * failure becomes an error entry, never a throw.
 */
function analyze(readFile) {
  const read = typeof readFile === 'function'
    ? readFile
    : (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const errors = [];

  // 1. the canonical marker appears in EVERY authority document
  for (const f of AUTHORITY_DOCS) {
    let text;
    try { text = read(f); }
    catch (e) { errors.push(`${f}: cannot read (${e.message})`); continue; }
    const count = text.split(CAMPAIGN_MARKER).length - 1;
    if (count < 1) errors.push(`${f}: missing the canonical active-campaign marker "${CAMPAIGN_MARKER}"`);
  }

  // 2. CLAUDE.md and the docs index both name the plan as the sole authority
  for (const f of AUTHORITY_DECLARERS) {
    let text;
    try { text = read(f); }
    catch (e) { errors.push(`${f}: cannot read (${e.message})`); continue; }
    if (!text.includes(PLAN_PATH)) errors.push(`${f}: does not name ${PLAN_PATH} as the execution authority`);
    if (!SOLE_AUTHORITY_RE.test(text)) errors.push(`${f}: missing the "sole … authority" declaration for the plan`);
  }

  return { valid: errors.length === 0, errors };
}

if (require.main === module) {
  const r = analyze();
  if (!r.valid) {
    console.error('❌ Authority consistency FAILED:\n- ' + r.errors.join('\n- '));
    process.exit(1);
  }
  console.log(`✅ Authority consistency OK — "${CAMPAIGN_MARKER}" declared consistently across ${AUTHORITY_DOCS.join(', ')}, plan named as the sole authority.`);
}

module.exports = { analyze, CAMPAIGN_MARKER, PLAN_PATH, AUTHORITY_DOCS, AUTHORITY_DECLARERS };
