'use strict';

// Exercise Identity Bridge — inert mapping data (Migration PR-A).
//
// PR-A builds the permanent identity bridge that future enrichment-inversion
// migrations (plan §6 PR-B onward) will consume. This PR ships DATA ONLY and MUST
// produce zero runtime behaviour change. These tests prove exactly that:
//   1. Both bridge JSON files are well-formed and internally consistent.
//   2. Every lift_code in the bridge matches services/exerciseEnrichment.js
//      (knownLiftCodeOverrides) for each of its override names — the bridge does
//      not invent or drift lift codes.
//   3. Every catalog exercise_id / primary_muscle token referenced is real.
//   4. All 17 catalog primary_muscle tokens are covered by the muscle bridge, and
//      each proposed label classifies under services/analytics.js exactly as the
//      bridge records (rear_delts -> pull, posterior chain -> hinge, etc.).
//   5. INERTNESS: no production file (index.js / sheets.js / middleware.js /
//      services / routes / config / scripts / public / src) references either
//      bridge file. Nothing consumes the bridge yet — that is the whole point.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const liftBridge = require('../data/lift_code_bridge.v1.json');
const muscleBridge = require('../data/muscle_group_bridge.v1.json');
const catalog = require('../data/exercise_catalog.v1.json');
const { generateLiftCode, knownLiftCodeOverrides } = require('../services/exerciseEnrichment');
const { classifyMuscleGroup } = require('../services/analytics');

const catalogList = Array.isArray(catalog) ? catalog : catalog.exercises || [];
const catalogIds = new Set(catalogList.map(e => e.exercise_id));
const primaryTokens = new Set();
for (const e of catalogList) for (const m of e.primary_muscles || []) primaryTokens.add(m);

test('lift bridge: shape is well-formed and inert', () => {
  assert.equal(liftBridge.kind, 'lift_code_bridge');
  assert.equal(liftBridge.status, 'inert');
  assert.ok(liftBridge.bridge && typeof liftBridge.bridge === 'object');
});

test('lift bridge: every exercise_id is real and code matches the enrichment overrides', () => {
  for (const [exId, entry] of Object.entries(liftBridge.bridge)) {
    assert.ok(catalogIds.has(exId), `${exId} must be a real catalog exercise_id`);
    assert.match(entry.lift_code, /^[A-Z]+\d{2}$/, `${exId} lift_code shape`);
    // The bridge lift_code must equal what the current enrichment produces for
    // each override name it claims — the identity contract, not a guess.
    for (const name of entry.override_names) {
      assert.equal(
        generateLiftCode(name),
        entry.lift_code,
        `override "${name}" must still generate ${entry.lift_code}`
      );
    }
  }
});

test('lift bridge: every resolved override maps back to its exercise_id key (no cross-wiring)', () => {
  // Each override name appears under exactly one exercise_id, and that pairing is
  // the one we generated. Guards against an id accidentally claiming a name that
  // enrichment routes to a different code.
  const seen = new Map(); // name -> exId
  for (const [exId, entry] of Object.entries(liftBridge.bridge)) {
    for (const name of entry.override_names) {
      assert.ok(!seen.has(name), `override "${name}" listed under two ids`);
      seen.set(name, exId);
    }
  }
});

test('lift bridge: unresolved codes are genuinely unresolvable (documented, not dropped)', () => {
  // BC01 (generic curl) has no single catalog identity. It must be recorded as
  // unresolved with a reason, never silently mapped to an arbitrary id.
  const unresolved = liftBridge.unresolved_lift_codes || {};
  for (const [code, info] of Object.entries(unresolved)) {
    assert.ok(info.reason, `${code} needs a documented reason`);
    assert.ok(Array.isArray(info.override_names) && info.override_names.length);
    // The code is real (something in enrichment emits it) but resolves to no id.
    const emits = [...knownLiftCodeOverrides.values()].includes(code);
    assert.ok(emits, `${code} should be a real enrichment lift_code`);
    for (const id of info.candidate_exercise_ids || []) {
      assert.ok(catalogIds.has(id), `${code} candidate ${id} must be a real exercise_id`);
    }
  }
});

test('muscle bridge: covers all catalog primary_muscle tokens', () => {
  const mapped = muscleBridge.primary_muscle_to_muscle_group;
  for (const token of primaryTokens) {
    assert.ok(mapped[token], `primary_muscle "${token}" must be mapped`);
    assert.ok(mapped[token].label, `${token} needs a label`);
  }
  assert.equal(muscleBridge.all_primary_muscle_tokens_covered, true);
  assert.deepEqual(muscleBridge.uncovered_tokens, []);
});

test('muscle bridge: recorded classifies_as matches services/analytics.js today', () => {
  // The bridge is UNCALIBRATED against the live sheet, but its recorded
  // classification must be truthful about the CURRENT classifier so the owner can
  // trust the flagged decision points. rear_delts must be pull; posterior chain
  // must be hinge — the two orderings that matter.
  for (const [token, m] of Object.entries(muscleBridge.primary_muscle_to_muscle_group)) {
    assert.equal(
      classifyMuscleGroup(m.label),
      m.classifies_as,
      `label "${m.label}" (${token}) classifies as ${classifyMuscleGroup(m.label)}, bridge says ${m.classifies_as}`
    );
  }
  assert.equal(classifyMuscleGroup('Rear Delts'), 'pull');
  assert.equal(classifyMuscleGroup('Posterior Chain'), 'hinge');
});

test('INERTNESS: no production code references either bridge file', () => {
  // Data-only PR. If any runtime module starts importing/reading the bridge, this
  // fails until that consumer arrives in a later, behaviour-changing PR.
  const names = ['lift_code_bridge.v1', 'muscle_group_bridge.v1'];
  const roots = [
    'index.js', 'sheets.js', 'middleware.js',
    'services', 'routes', 'config', 'scripts', 'public', 'src',
  ];
  const offenders = [];
  const walk = p => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const f of fs.readdirSync(p)) walk(path.join(p, f));
      return;
    }
    if (!/\.(js|mjs|cjs|ts)$/.test(p)) return;
    const text = fs.readFileSync(p, 'utf8');
    if (names.some(n => text.includes(n))) offenders.push(path.relative(ROOT, p));
  };
  for (const r of roots) {
    const abs = path.join(ROOT, r);
    if (fs.existsSync(abs)) walk(abs);
  }
  assert.deepEqual(offenders, [], `bridge must be inert; consumed by: ${offenders.join(', ')}`);
});
