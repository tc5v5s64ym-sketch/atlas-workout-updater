'use strict';

// PR-05 (Atlas Remediation Plan v2) — Exercise Truth Audit
// This test ALWAYS PASSES. Its job is to:
//   1. Load all four exercise-knowledge sources without error.
//   2. Print the full disagreement inventory to the test log.
//   3. Write docs/verification/EXERCISE_TRUTH_AUDIT.md (committed as evidence for PR-06).
// PR-06 will flip this test from report-only to blocking on Type-1 conflicts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runAudit, formatMarkdown } = require('../services/exerciseTruthAudit');

const REPORT_PATH = path.join(__dirname, '../docs/verification/EXERCISE_TRUTH_AUDIT.md');

test('exercise truth audit — all four sources load without error', () => {
  const audit = runAudit();

  assert.ok(audit, 'runAudit() must return a result');
  assert.ok(Array.isArray(audit.type1), 'type1 must be an array');
  assert.ok(Array.isArray(audit.type2), 'type2 must be an array');
  assert.ok(Array.isArray(audit.type3), 'type3 must be an array');

  // Print the disagreement inventory to the test log
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║        EXERCISE TRUTH AUDIT — PR-05        ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
  for (const [id, s] of Object.entries(audit.sources)) {
    console.log(`  ${id}: ${s.label}`);
    console.log(`     canonicals=${s.canonicalCount}  alias-entries=${s.aliasCount}${
      s.orphanedAliasIds && s.orphanedAliasIds.length
        ? `  orphaned-ids=${s.orphanedAliasIds.length}`
        : ''
    }`);
  }
  console.log('');
  console.log(`Type 1 — Alias conflicts:           ${audit.stats.type1}`);
  console.log(`Type 2 — Missing canonicals:        ${audit.stats.type2}`);
  console.log(`Type 3 — Case/punct mismatches:     ${audit.stats.type3}`);

  if (audit.type1.length > 0) {
    console.log('\n── Type 1: Alias Conflicts ──────────────────────────────────');
    for (const { alias, bySource } of audit.type1) {
      console.log(`  "${alias}":`);
      for (const [src, canonical] of Object.entries(bySource)) {
        console.log(`    ${src}: "${canonical}"`);
      }
    }
  }

  if (audit.type3.length > 0) {
    console.log('\n── Type 3: Case/Punctuation Mismatches ──────────────────────');
    for (const { normKey: key, forms } of audit.type3) {
      console.log(`  [${key}]: ${forms.join(' vs ')}`);
    }
  }

  console.log('\n(Full report → docs/verification/EXERCISE_TRUTH_AUDIT.md)\n');

  // Write the markdown report
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, formatMarkdown(audit), 'utf8');

  assert.ok(fs.existsSync(REPORT_PATH), 'Report file must be written to docs/verification/');
});

test('exercise truth audit — every Type-1 entry spans at least two sources', () => {
  const { type1 } = runAudit();
  for (const entry of type1) {
    assert.ok(
      Object.keys(entry.bySource).length >= 2,
      `Type 1 entry for alias "${entry.alias}" must involve ≥2 sources; got ${JSON.stringify(entry.bySource)}`
    );
  }
});

test('exercise truth audit — every Type-3 entry has at least two canonical forms', () => {
  const { type3 } = runAudit();
  for (const entry of type3) {
    assert.ok(
      entry.forms.length >= 2,
      `Type 3 entry for normKey "${entry.normKey}" must have ≥2 forms; got ${JSON.stringify(entry.forms)}`
    );
  }
});
