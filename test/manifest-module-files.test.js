'use strict';

// Guard: every capability's declared module file resolves on disk.
//
// The capability manifest is declarative — services/capabilityManifest.js never
// require()s the module.file strings, so a typo'd path is invisible at runtime:
// the capability simply can never be wired, and flipping its status from
// 'missing' would silently no-op. (Found in the 2026-07-05 architecture audit:
// movement_patterns pointed at services/movementPatternModule.js while the
// shipped module is services/movementPatternsModule.js.) This test makes that
// class of drift fail loudly.
//
// Deliberately NOT a require() check: status:'missing' capabilities may name a
// file that does not exist yet (equipmentModule, nutritionModule) — those are
// declared build-ahead slots, so only non-missing capabilities must resolve.
// A 'missing' capability whose file DOES exist is also flagged: its status is
// stale and should be flipped (or the file renamed) — that mismatch is exactly
// the movement_patterns bug in reverse.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const caps = require(path.join(ROOT, 'config', 'coaching', 'manifests', 'capabilities.json'));

test('manifest: every non-missing capability module.file resolves on disk', () => {
  const broken = [];
  for (const [id, cap] of Object.entries(caps.capabilities)) {
    if (cap.status === 'missing') continue;
    const file = cap.module && cap.module.file;
    if (typeof file !== 'string' || !fs.existsSync(path.join(ROOT, file))) {
      broken.push(`${id} → ${file}`);
    }
  }
  assert.deepEqual(broken, [],
    `non-missing capabilities whose module.file does not exist: ${broken.join('; ')}`);
});

test('manifest: every non-missing capability module.export is exported by its file', () => {
  const broken = [];
  for (const [id, cap] of Object.entries(caps.capabilities)) {
    if (cap.status === 'missing') continue;
    const mod = require(path.join(ROOT, cap.module.file));
    if (typeof mod[cap.module.export] !== 'function') {
      broken.push(`${id} → ${cap.module.file}#${cap.module.export}`);
    }
  }
  assert.deepEqual(broken, [],
    `non-missing capabilities whose declared export is absent: ${broken.join('; ')}`);
});

test("manifest: a status:'missing' capability must not point at a file that exists (stale status or filename drift)", () => {
  const stale = [];
  for (const [id, cap] of Object.entries(caps.capabilities)) {
    if (cap.status !== 'missing') continue;
    const file = cap.module && cap.module.file;
    if (typeof file === 'string' && fs.existsSync(path.join(ROOT, file))) {
      stale.push(`${id} → ${file}`);
    }
  }
  assert.deepEqual(stale, [],
    `capabilities marked 'missing' whose file exists — flip the status or fix the path: ${stale.join('; ')}`);
});
