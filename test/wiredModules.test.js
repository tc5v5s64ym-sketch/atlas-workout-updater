'use strict';

// Wired-or-deleted guard (Remediation PR-13).
//
// Every services/*.js must be reachable from a production entrypoint (static
// require/import graph seeded from index.js/sheets.js/middleware.js, scripts/*,
// config/* recursively, the frontend entry, and the declarative capability
// manifest's module.file strings) — OR be explicitly listed in
// config/wiring-allowlist.json. A module nothing runs is dead weight; this test
// makes that state fail CI so it is wired, deleted, or (temporarily, with an
// expiry) allowlisted. The allowlist's staged entries expire, so a module can
// never sit unwired forever.
//
// See scripts/check-wired-modules.js for the analysis.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  analyze, extractSpecifiers,
  classifyEdges, localBindings, isReferenced, reachableSemantic, reachableFiles,
  blankStringLiterals,
} = require('../scripts/check-wired-modules');

test('wiring guard: every services/*.js is wired or validly allowlisted', () => {
  const r = analyze();
  const problems = [];
  if (r.unwired.length) problems.push(`UNWIRED (wire/delete/allowlist): ${r.unwired.join(', ')}`);
  if (r.expired.length) problems.push(`EXPIRED allowlist entries (wire or delete now): ${r.expired.join(', ')}`);
  if (r.staleAllow.length) problems.push(`STALE allowlist entries (remove): ${r.staleAllow.join(', ')}`);
  if (r.allowErrors.length) problems.push(`MALFORMED allowlist entries: ${r.allowErrors.join(', ')}`);
  assert.equal(problems.length, 0, `\n${problems.join('\n')}`);
  assert.equal(r.ok, true);
});

test('wiring guard: orphan detection positively finds production-unreachable modules', () => {
  // Positive coverage for the core detection: every allowlisted / testOnly module
  // is genuinely unreachable from production — that is WHY it is listed — so it
  // must appear in the raw `orphans` set. This proves the graph walk actually
  // surfaces orphans (allowlisting only moves them out of `unwired`, not `orphans`).
  const r = analyze();
  const listed = [...r.allowlisted, ...r.testOnly];
  assert.ok(listed.length >= 1, 'there is at least one listed module to check');
  for (const f of listed) {
    assert.ok(r.orphans.includes(f), `${f} must be detected as an orphan (unreachable from production)`);
  }
});

test('wiring guard: the staged allowlist stays small (brief target ≤ 14)', () => {
  // The allowlist is an escape hatch, not a dumping ground. testOnly tooling is a
  // separate category and not subject to this cap.
  // (The B1–B3 window raised this to 11; PR-B4 wired those three and dropped it to 8.
  // Phase 2 Work item 2 (docs/CANONICAL_CONTRACTS.md) then stages each canonical
  // contract's pure build/validate module — ExerciseIdentity, AthleteContext,
  // WorkoutSession, InteractionTrace, SafetyDecision, CloseoutTransaction — ahead of
  // its wiring phase (Phases 3/4/5b/5d/5e/5g), each with an expiry + roadmap, so the
  // cap is 14 for this window; it drops sharply (toward 8) as those phases wire the
  // contracts and retire the entries. CoachTurnPacket is ratified last.)
  const r = analyze();
  assert.ok(r.allowlisted.length <= 14,
    `staged allowlist has ${r.allowlisted.length} entries (> 14): ${r.allowlisted.join(', ')}`);
});

test('wiring guard: a commented-out require is not counted as a real edge', () => {
  // Precision: a documented/commented-out import must not keep a dead module
  // silently "wired" (the false negative that would defeat the guard).
  const src = [
    "const a = require('./real');",
    "// const b = require('./commented-line');",
    "/* const c = require('./commented-block'); */",
    "const url = 'https://example.com/not-a-comment';", // '//' inside a string is preserved
    "import d from './imported';",
  ].join('\n');
  const specs = extractSpecifiers(src);
  assert.ok(specs.includes('./real'), 'real require is an edge');
  assert.ok(specs.includes('./imported'), 'real import is an edge');
  assert.ok(!specs.includes('./commented-line'), 'a // commented require is NOT an edge');
  assert.ok(!specs.includes('./commented-block'), 'a /* */ commented require is NOT an edge');
});

test('wiring guard: expiry mechanism fails once a staged entry passes its date', () => {
  // Prove the forcing function works: run the analysis as if it were far in the
  // future — every dated staged entry must then read as expired and fail the guard.
  const future = analyze({ today: new Date('2099-01-01T00:00:00Z') });
  assert.ok(future.expired.length >= 1, 'a past-dated staged entry must surface as expired');
  assert.equal(future.ok, false, 'expired staged entries must fail the guard');
});

// ── semantic reachability (Phase 2 Work item 1a) ────────────────────────────

test('semantic guard: a referenced binding is a used edge; an unreferenced one is inert', () => {
  const used = classifyEdges("const live = require('./live'); live();");
  assert.deepEqual(used, [{ spec: './live', bindings: ['live'], used: true, sideEffect: false }]);

  const dead = classifyEdges("const dead = require('./dead'); // never called again");
  assert.equal(dead.length, 1);
  assert.equal(dead[0].spec, './dead');
  assert.equal(dead[0].used, false, 'a require whose binding is never referenced is inert');
});

test('semantic guard: value-passed / indirectly-invoked bindings are USED (no false positive)', () => {
  // The classifyIntent regression: a binding assigned to another variable and
  // invoked indirectly is still consumed — it must not be flagged inert.
  const edges = classifyEdges("const { classifyIntent } = require('./intentRouter');\nlet _classify = classifyIntent;\n_classify();");
  assert.equal(edges[0].used, true, 'a binding passed by value is referenced → used');
});

test('semantic guard: side-effect, re-export, and dynamic import edges fail safe as used', () => {
  const sideEffect = classifyEdges("require('./boot');");
  assert.deepEqual(sideEffect, [{ spec: './boot', bindings: [], used: true, sideEffect: true }]);

  const reExport = classifyEdges("module.exports = require('./inner');");
  assert.equal(reExport.find((e) => e.spec === './inner').used, true, 're-export carries no binding → used');

  const dynamic = classifyEdges("async function f(){ const m = await import('./lazy'); return m; }");
  assert.ok(dynamic.some((e) => e.spec === './lazy' && e.used), 'dynamic import is treated as used');
});

test('semantic guard: destructure renames resolve to the local name', () => {
  assert.deepEqual(localBindings('{ a, b as c, d: e }'), ['a', 'c', 'e']);
  assert.deepEqual(localBindings('* as ns'), ['ns']);
  assert.deepEqual(localBindings('single'), ['single']);
  // The renamed local (c), not the source name (b), is what usage looks for.
  const edges = classifyEdges("const { helper: doThing } = require('./h'); doThing();");
  assert.equal(edges[0].used, true);
  const unusedRename = classifyEdges("const { helper: doThing } = require('./h'); helper;");
  assert.equal(unusedRename[0].used, false, 'referencing the SOURCE name is not referencing the local binding');
});

test('semantic guard: isReferenced respects $/_ identifier boundaries', () => {
  assert.equal(isReferenced('$fn', 'const $fn = x; $fn();'), true);
  assert.equal(isReferenced('fn', 'const fn = x; fnOther();'), false, '`fn` is not a use of `fnOther`');
});

test('semantic guard: reachableSemantic excludes a module reached ONLY through an inert edge', () => {
  // Integration proof through the real graph walk: a module that is file-required
  // but whose binding is never referenced (and everything reachable only past it)
  // is dropped by semantic reachability, yet still present in file reachability.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-sem-'));
  try {
    const w = (name, src) => fs.writeFileSync(path.join(dir, name), src);
    w('root.js', "const live = require('./live'); live();\nconst dead = require('./deadImport'); // binding never used\n");
    w('live.js', "module.exports = function(){ return require('./viaLive'); };\n");
    w('viaLive.js', 'module.exports = 1;\n');
    w('deadImport.js', "module.exports = require('./onlyViaDead');\n");
    w('onlyViaDead.js', 'module.exports = 2;\n');

    const roots = [path.join(dir, 'root.js')];
    const rels = (set) => new Set([...set].map((f) => path.basename(f)));
    const fileR = rels(reachableFiles(roots));
    const semR = rels(reachableSemantic(roots));

    // File reachability follows the dead require and everything past it.
    assert.ok(fileR.has('deadImport.js') && fileR.has('onlyViaDead.js'), 'file walk reaches the inert subtree');
    // Semantic reachability stops at the inert edge.
    assert.ok(semR.has('live.js') && semR.has('viaLive.js'), 'semantic walk keeps the live subtree');
    assert.ok(!semR.has('deadImport.js'), 'inert edge is not followed');
    assert.ok(!semR.has('onlyViaDead.js'), 'nothing reachable only past an inert edge survives');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('semantic guard: a binding named only inside a string literal is NOT a reference', () => {
  // Codex #229: a string mention (`logger.debug('helper')`) must not keep an
  // otherwise-unused import semantically reachable.
  const stringOnly = classifyEdges("const helper = require('./service');\nlogger.debug('helper');");
  const edge = stringOnly.find((e) => e.spec === './service');
  assert.equal(edge.used, false, 'a name that only appears inside a string is not a real use');

  // …but a template interpolation `${helper}` IS a real use and stays reachable.
  const interpolated = classifyEdges("const helper = require('./service');\nconst msg = `hi ${helper}`;");
  assert.equal(interpolated.find((e) => e.spec === './service').used, true, '${binding} is a genuine reference');
});

test('blankStringLiterals blanks string bodies but preserves ${…} interpolations', () => {
  assert.equal(blankStringLiterals("a('helper')"), "a('      ')");
  assert.equal(blankStringLiterals('const s = `x ${helper} y`;'), 'const s = `  ${helper}  `;');
});

test('semantic guard: a shared specifier also loaded for side effects survives (Codex #238)', () => {
  // A module bound-but-unused AND separately required for side effects must keep
  // its real side-effect edge — the binding must not suppress it.
  const edges = classifyEdges("const unused = require('./service');\nrequire('./service');");
  const usedForSpec = edges.filter((e) => e.spec === './service').some((e) => e.used);
  assert.equal(usedForSpec, true, 'the bare side-effect require keeps ./service reachable');
});

test('semantic guard: analyze() reports the inert category (empty today, grow-only)', () => {
  const r = analyze();
  assert.ok(Array.isArray(r.inert), 'analyze exposes an inert list');
  assert.ok(Array.isArray(r.inertUnwired), 'analyze exposes inertUnwired');
  // Today every file-reachable service is also semantically reachable, so the
  // semantic set never shrinks below the file set for a WIRED module.
  assert.ok(r.reachableCount <= r.fileReachableCount, 'semantic reachability is a subset of file reachability');
});
