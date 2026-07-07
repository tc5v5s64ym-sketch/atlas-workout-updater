'use strict';

// app.js → satellite bridge coverage guard (Minefield Map PR-09).
//
// app.js is now an ES module; the still-classic satellites (nav/drawer/chat/
// coach-conversation) read a set of app.js top-level symbols as BARE globals, which
// only resolve because app.js re-exposes them on `window` (the transitional bridge).
// eslint.config.js's `appPublicGlobals` is the canonical list of those cross-file
// identifiers. This test fails if any app.js-DEFINED symbol in that list is not on the
// bridge — the exact gap that silently disabled the coach's authoritative next-exercise
// path when `getPlanTodayByName` was dropped (the `typeof` guards degrade quietly, so
// no behavioral test catches it). It also guards PR-09b, which grows/shrinks this surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const eslintSrc = fs.readFileSync(path.join(repoRoot, 'eslint.config.js'), 'utf8');

// The names eslint declares as app.js public globals for the satellite files.
function appPublicGlobalNames() {
  const block = eslintSrc.slice(
    eslintSrc.indexOf('const appPublicGlobals = {'),
    eslintSrc.indexOf('};', eslintSrc.indexOf('const appPublicGlobals = {'))
  );
  return [...block.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map(m => m[1]);
}

// app.js top-level declarations (function / async function / const / let / var).
function appTopLevelDecls() {
  const decls = new Set();
  for (const m of appSrc.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm)) decls.add(m[1]);
  for (const m of appSrc.matchAll(/^(?:const|let|var)\s+([A-Za-z0-9_]+)/gm)) decls.add(m[1]);
  return decls;
}

// Symbols app.js re-exposes on window (the bridge).
function bridged() {
  return new Set([...appSrc.matchAll(/^window\.([A-Za-z0-9_]+)\s*=/gm)].map(m => m[1]));
}

test('every app.js-defined symbol in eslint appPublicGlobals is re-exposed on the window bridge', () => {
  const names = appPublicGlobalNames();
  assert.ok(names.length >= 15, `expected the appPublicGlobals list, got ${names.length} names`);
  const decls = appTopLevelDecls();
  const onWindow = bridged();
  // Only app.js-DEFINED names must be bridged here; entries like activeSession /
  // coachVoiceTemplates / displayBlockNormalizer / sessionQuestion are satellite
  // modules re-exposed by legacyBridge.js, not by app.js.
  const appOwned = names.filter(n => decls.has(n));
  assert.ok(appOwned.includes('getPlanTodayByName'), 'sanity: getPlanTodayByName is an app.js-owned public global');
  const missing = appOwned.filter(n => !onWindow.has(n));
  assert.deepEqual(missing, [], `app.js public globals missing from the window bridge: ${missing.join(', ')}`);
});
