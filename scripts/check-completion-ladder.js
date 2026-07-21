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
// A linked artifact is validated, not merely non-blank (a bare "trust me" string
// would defeat the guard's purpose):
//   • type: 'test'  — ref is a path to an EXISTING test file under test/ or
//     tests/ ending .test.js/.spec.js, with an optional '#<test name>' anchor.
//   • type: 'trace' — ref matches the defined trace-id format
//     <trace|flight|turn|session>:<token> (a Flight Recorder / InteractionTrace
//     id; the turn id minted at Phase 3's first trusted boundary).
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
// A test artifact lives under test/ or tests/ and is a real test/spec file.
const TEST_FILE_RE = /^(?:test|tests)\/.+\.(?:test|spec)\.js$/;
// A trace id: a recognized prefix + a non-empty token. Deterministically checkable
// in CI without reaching the (Sheets-backed) trace store.
const TRACE_ID_RE  = /^(?:trace|flight|turn|session):[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

// Is a single evidence entry a genuinely linked test or trace id?
function evidenceIsLinked(e, root) {
  if (!e || typeof e.ref !== 'string' || !e.ref.trim()) return false;
  const ref = e.ref.trim();
  if (e.type === 'test') {
    // Drop an optional '#<test name>' anchor; validate + resolve the file part.
    const file = ref.split('#')[0].trim();
    if (!TEST_FILE_RE.test(file)) return false;
    return fs.existsSync(path.join(root, file));
  }
  if (e.type === 'trace') {
    return TRACE_ID_RE.test(ref);
  }
  return false;
}

// Pure over (capabilities, root): return an array of violation strings. A
// capability at route_consumed or live_proven must carry at least one evidence
// entry that resolves to a real linked test artifact or a well-formed trace id.
function findEvidenceViolations(capabilities, opts) {
  const root = (opts && opts.root) || ROOT;
  const violations = [];
  for (const [id, cap] of Object.entries(capabilities || {})) {
    const l = (cap && cap.ladder) || {};
    const claimed = EVIDENCE_REQUIRED_RUNGS.filter(r => l[r] === true);
    if (!claimed.length) continue;
    const evidence = Array.isArray(cap.evidence) ? cap.evidence : [];
    const linked = evidence.filter(e => evidenceIsLinked(e, root));
    if (!linked.length) {
      violations.push(
        `capability '${id}' claims ${claimed.join(' + ')} but cites no linked test or trace id ` +
        `— add an "evidence" entry: { "type": "test", "ref": "test/<file>.test.js[#name]" } ` +
        `(an existing test file) or { "type": "trace", "ref": "trace|flight|turn|session:<id>" }`);
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

module.exports = {
  findEvidenceViolations, evidenceIsLinked, run, readCapabilities,
  EVIDENCE_REQUIRED_RUNGS, TEST_FILE_RE, TRACE_ID_RE,
};
