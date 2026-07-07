'use strict';

// Exercise Truth Audit — reconciled + BLOCKING (PR-06, Atlas Remediation Plan v2).
//
// PR-05 shipped this as report-only. PR-06 reconciled the two hand-maintained JSON
// sources (catalog B + coaching ontology C) to Dale's history convention and flips
// the test to blocking:
//   1. FAIL on any catalog↔coaching (B↔C) Type-1 conflict — the editable sources
//      must agree on every shared alias.
//   2. The parser (A) / enrichment (D) anchored residuals — where B and C agree but a
//      frozen source diverges — must EXACTLY match the documented allowlist
//      (docs/verification/EXERCISE_TRUTH_ALLOWLIST.json). New drift in either
//      direction fails until it is consciously triaged there (owner decision, Option 1:
//      parser/enrichment unification is deferred to PR-14 / PR-15).
//   3. Regenerate docs/verification/EXERCISE_TRUTH_AUDIT.md as committed evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runAudit, formatMarkdown, partitionType1 } = require('../services/exerciseTruthAudit');

const REPORT_PATH = path.join(__dirname, '../docs/verification/EXERCISE_TRUTH_AUDIT.md');
const ALLOWLIST_PATH = path.join(__dirname, '../docs/verification/EXERCISE_TRUTH_ALLOWLIST.json');

test('exercise truth audit — all four sources load; regenerates the report', () => {
  const audit = runAudit();

  assert.ok(audit, 'runAudit() must return a result');
  assert.ok(Array.isArray(audit.type1), 'type1 must be an array');
  assert.ok(Array.isArray(audit.type2), 'type2 must be an array');
  assert.ok(Array.isArray(audit.type3), 'type3 must be an array');

  const { blocking, anchored } = partitionType1(audit.type1);

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║     EXERCISE TRUTH AUDIT — PR-06 (blocking) ║');
  console.log('╚════════════════════════════════════════════╝');
  for (const [id, s] of Object.entries(audit.sources)) {
    console.log(`  ${id}: canonicals=${s.canonicalCount}  aliases=${s.aliasCount}`);
  }
  console.log(`\nType 1 blocking (B↔C):   ${blocking.length}  (must be 0)`);
  console.log(`Type 1 anchored (A/D):   ${anchored.length}  (allowlisted)`);
  console.log(`Type 2 missing canonical: ${audit.stats.type2}`);
  console.log(`Type 3 case/punct:        ${audit.stats.type3}`);
  console.log('(Full report → docs/verification/EXERCISE_TRUTH_AUDIT.md)\n');

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, formatMarkdown(audit), 'utf8');
  assert.ok(fs.existsSync(REPORT_PATH), 'Report file must be written');
});

test('BLOCKING: zero catalog↔coaching (B↔C) Type-1 conflicts', () => {
  const { blocking } = partitionType1(runAudit().type1);
  const detail = blocking
    .map(({ alias, bySource }) => `  "${alias}": ${Object.entries(bySource).map(([k, v]) => `${k}="${v}"`).join('  ')}`)
    .join('\n');
  assert.equal(
    blocking.length, 0,
    `The catalog (B) and coaching (C) JSON must agree on every shared alias.\n` +
    `${blocking.length} unreconciled B↔C conflict(s):\n${detail}\n` +
    `Fix by editing the JSON data sources so both resolve to the same canonical (see ` +
    `docs/verification/EXERCISE_TRUTH_AUDIT.md → reconciliation policy).`
  );
});

test('ANCHORED: parser/enrichment residuals exactly match the documented allowlist', () => {
  const { anchored } = partitionType1(runAudit().type1);
  const doc = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));

  // Every allowlist entry must cite a reason and a resolving PR.
  for (const e of doc.allowlist) {
    assert.ok(e.alias, 'allowlist entry needs an alias');
    assert.ok(e.reason && e.reason.length > 10, `allowlist "${e.alias}" needs a reason`);
    assert.ok(/PR-1[45]/.test(e.resolves_in), `allowlist "${e.alias}" must link its resolving PR (PR-14 / PR-15)`);
  }

  const anchoredSet = new Set(anchored.map(a => a.alias));
  const allowSet = new Set(doc.allowlist.map(e => e.alias));

  const undocumented = [...anchoredSet].filter(a => !allowSet.has(a));
  const stale = [...allowSet].filter(a => !anchoredSet.has(a));

  assert.equal(
    undocumented.length, 0,
    `New parser/enrichment-anchored Type-1 residual(s) not in the allowlist: ${undocumented.join(', ')}.\n` +
    `Add each to docs/verification/EXERCISE_TRUTH_ALLOWLIST.json with a reason + resolving PR, ` +
    `or reconcile it in the JSON if it is actually a B↔C disagreement.`
  );
  assert.equal(
    stale.length, 0,
    `Allowlist entries no longer needed (resolved — remove them): ${stale.join(', ')}.`
  );
});
