'use strict';

// Frontend ES-module import-reassignment guard (PR-09b regression).
//
// Named ES imports are immutable bindings. Reassigning one (`x = v;` where `x`
// was `import { x } ...`) throws a runtime TypeError ("Assignment to constant
// variable") the moment that line executes — silently, as an unhandled promise
// rejection when the write sits inside an async function. `node --check` and a
// bare dynamic import both MISS it (the module still links and loads; the throw
// only fires when the offending code path runs with a live DOM/fetch), so the
// smoke e2e reads green while a real code path is broken.
//
// This bit PR-09b: `atlasServerVersion` was extracted to bugReport.js as an
// exported `let`, imported into app.js, then still reassigned in app.js's
// populateBuildInfo() — so the build-version badge silently failed to populate.
// The two sibling foreign-written lets (atlasLastError, historyLoaded) were
// routed through a mutable object (sharedState.js) instead; PR-24 folded them
// into the store as getter/action pairs and deleted sharedState.js — the store
// pattern is exactly what lets cross-module state be shared without an import
// reassignment (writes go through an action, never a rebound binding).
//
// The guard is static (no DOM needed): for every frontend ES module, collect
// the names it imports and assert none is used as an assignment target at
// statement position. Scans src/app + public mirrors.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

function moduleFiles() {
  const out = [];
  for (const dir of [path.join(repoRoot, 'src', 'app'), path.join(repoRoot, 'public')]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js')) continue;
      const full = path.join(dir, name);
      const src = fs.readFileSync(full, 'utf8');
      if (/^\s*import\s/m.test(src)) out.push({ rel: path.relative(repoRoot, full), src });
    }
  }
  return out;
}

// Local binding names introduced by `import ... from '...'` statements.
function importedNames(src) {
  const names = new Set();
  // Grab each import statement head up to `from`.
  for (const m of src.matchAll(/^\s*import\s+([^;]*?)\s+from\s+['"][^'"]+['"]/gm)) {
    let clause = m[1].trim();
    // Named block: { a, b as c }
    const brace = clause.match(/\{([^}]*)\}/);
    if (brace) {
      for (const spec of brace[1].split(',')) {
        const s = spec.trim();
        if (!s) continue;
        const asMatch = s.match(/\bas\s+([A-Za-z0-9_$]+)/);
        names.add(asMatch ? asMatch[1] : s.split(/\s+/)[0]);
      }
      clause = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ');
    }
    // Namespace: * as ns
    const ns = clause.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);
    if (ns) { names.add(ns[1]); clause = clause.replace(/\*\s+as\s+[A-Za-z0-9_$]+/, ''); }
    // Default: leading bareword
    const def = clause.trim().match(/^([A-Za-z0-9_$]+)/);
    if (def) names.add(def[1]);
  }
  names.delete('');
  return names;
}

// Does `src` assign to `name` at statement position (not `==`, not `=>`,
// not a `.name =` property write, not a declaration)?
function reassignsName(src, name) {
  const n = name.replace(/[$]/g, '\\$&');
  // preceded by a statement boundary (not `.`), then name, then an assignment op
  // whose next char is neither `=` (equality) nor `>` (arrow).
  const re = new RegExp(
    `(?:^|[;{}()]|=>)\\s*${n}\\s*(?:\\+\\+|--|(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[+\\-*/%&|^])?=(?![=>]))`,
    'm'
  );
  return re.test(src);
}

test('self-check: the guard actually detects an import reassignment', () => {
  const bad = "import { atlasServerVersion } from './bugReport.js';\nfunction f(v){ atlasServerVersion = v; }\n";
  assert.ok(importedNames(bad).has('atlasServerVersion'), 'extracts the imported name');
  assert.ok(reassignsName(bad, 'atlasServerVersion'), 'flags the reassignment');
  // and does NOT false-positive on reads, equality, arrows, or property writes
  const ok = "import { x } from './y.js';\nconst a = x === 3;\nconst g = x => x;\nobj.x = 1;\nif (a == x) {}\n";
  assert.ok(!reassignsName(ok, 'x'), 'ignores reads / equality / arrow / property write');
});

test('no frontend ES module reassigns one of its imported bindings', () => {
  const files = moduleFiles();
  assert.ok(files.length > 0, 'sanity: found frontend ES modules to scan');
  const offenders = [];
  for (const { rel, src } of files) {
    for (const name of importedNames(src)) {
      if (reassignsName(src, name)) offenders.push(`${rel}: reassigns imported '${name}'`);
    }
  }
  assert.deepEqual(offenders, [], `import bindings are immutable — reassigning throws at runtime:\n${offenders.join('\n')}`);
});
