'use strict';

// Drift Guard 4 — completion-ladder evidence guard.
//
// Contract (Phase 2 Work item 3; Drift Guards §4): no capability may claim
// route_consumed or live_proven without a linked test or trace id. This is the
// evidence tripwire that keeps the completion ladder honest as capabilities
// climb toward live use in Phase 4 — a route_consumed / live_proven claim must
// be substantiated by a real linked artifact, never self-declared (the H-05/H-15
// disease this campaign cures). No capability trips it today (nothing yet claims
// those rungs), so a self-test (test/completionLadderGuard.test.js) proves the
// guard actually bites on a synthetic violation, i.e. it is a real failing check.
//
// It also fails on a structurally invalid ladder (shape / monotonicity /
// name-the-consumer) by delegating to services/capabilityManifest.validateManifest,
// so the ladder cannot drift out of contract without CI going red.
//
// Read-only, deterministic, no network. Exit 0 = clean, 1 = violations.

const path = require('node:path');
const fs   = require('node:fs');
const { validateManifest } = require('../services/capabilityManifest');

const ROOT      = path.join(__dirname, '..');
const CAPS_FILE = path.join(ROOT, 'config', 'coaching', 'manifests', 'capabilities.json');

// The rungs whose claim demands linked evidence.
const EVIDENCE_REQUIRED_RUNGS = Object.freeze(['route_consumed', 'live_proven']);
// A linked artifact is a test id or a trace id.
const EVIDENCE_TYPES = Object.freeze(new Set(['test', 'trace']));

// Pure: given the capabilities map, return an array of violation strings. A
// capability at route_consumed or live_proven must carry at least one evidence
// entry { type: 'test'|'trace', ref: '<non-empty>' }.
function findEvidenceViolations(capabilities) {
  const violations = [];
  for (const [id, cap] of Object.entries(capabilities || {})) {
    const l = (cap && cap.ladder) || {};
    const claimed = EVIDENCE_REQUIRED_RUNGS.filter(r => l[r] === true);
    if (!claimed.length) continue;
    const evidence = Array.isArray(cap.evidence) ? cap.evidence : [];
    const linked = evidence.filter(e =>
      e && EVIDENCE_TYPES.has(e.type) && typeof e.ref === 'string' && e.ref.trim());
    if (!linked.length) {
      violations.push(
        `capability '${id}' claims ${claimed.join(' + ')} but cites no linked test or trace id ` +
        `— add an "evidence" entry like { "type": "test"|"trace", "ref": "<id>" }`);
    }
  }
  return violations;
}

function readCapabilities() {
  return JSON.parse(fs.readFileSync(CAPS_FILE, 'utf8')).capabilities || {};
}

// Full guard: structural validity (shape/monotonicity/consumer) + the evidence
// rule. Returns an array of error strings (empty = clean).
function run() {
  const errors = [];
  const v = validateManifest();
  if (!v.valid) errors.push(...v.errors.map(e => `manifest invalid: ${e}`));
  errors.push(...findEvidenceViolations(readCapabilities()));
  return errors;
}

if (require.main === module) {
  const errors = run();
  if (errors.length) {
    console.error('❌ Completion-ladder guard (Drift Guard 4) FAILED:');
    for (const e of errors) console.error(`  • ${e}`);
    console.error('\nEvery capability at route_consumed or live_proven must cite a linked test or ' +
      'trace id in its "evidence" array. See docs/CAPABILITY_COMPLETION_LADDER.md.');
    process.exit(1);
  }
  const n = Object.keys(readCapabilities()).length;
  console.log(`✅ Completion-ladder guard (Drift Guard 4) OK — ${n} capabilities; every ` +
    'route_consumed/live_proven claim carries a linked test or trace id.');
}

module.exports = { findEvidenceViolations, run, readCapabilities, EVIDENCE_REQUIRED_RUNGS, EVIDENCE_TYPES };
