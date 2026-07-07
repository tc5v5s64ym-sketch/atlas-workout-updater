'use strict';

// §1.5 asset-coverage guard (Minefield Map PR-09; closes the audit INFRA-2 residual).
//
// The service worker precaches SHELL_ASSETS by URL and serves cache-first. If a JS
// file the app loads is NOT in SHELL_ASSETS, an offline (or post-cache-bump) open
// fetches a file the cache doesn't have → a mid-gym white screen. This test fails if:
//   (1) any `<script src>` in index.html is missing from SHELL_ASSETS, or
//   (2) any app JS file in public/ (except sw.js, which never caches itself) is missing.
// PR-09b adds new module files here — this guard forces them into SHELL_ASSETS too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');

function shellAssets() {
  const sw = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
  const block = sw.slice(sw.indexOf('SHELL_ASSETS'), sw.indexOf('];', sw.indexOf('SHELL_ASSETS')));
  return new Set([...block.matchAll(/'([^']+)'/g)].map(m => m[1]));
}

test('§1.5: every <script src> in index.html is precached in SHELL_ASSETS', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const assets = shellAssets();
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]);
  assert.ok(srcs.length > 0, 'index.html must load at least one script');
  for (const src of srcs) {
    const url = src.startsWith('/') ? src : `/app/${src.replace(/^\.?\//, '')}`;
    assert.ok(assets.has(url), `index.html loads "${src}" (${url}) but it is not in SHELL_ASSETS`);
  }
});

test('§1.5: every app JS file in public/ (except sw.js) is precached in SHELL_ASSETS', () => {
  const assets = shellAssets();
  const jsFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.js') && f !== 'sw.js');
  assert.ok(jsFiles.length > 0, 'public/ must contain app JS files');
  for (const f of jsFiles) {
    assert.ok(assets.has(`/app/${f}`), `public/${f} is not in SHELL_ASSETS (offline open would 404 it)`);
  }
});
