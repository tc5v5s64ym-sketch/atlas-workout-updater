const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// CLIENT-5: the effort-card cleanup registry in src/app/app.js was dead code —
// registerEffortCardCleanup had zero callers anywhere in the repo, so the
// registry was always empty and runEffortCardCleanups() (called from
// invalidatePreview) was a permanent no-op. These pins keep the dead surface
// from creeping back while anchoring the live invalidation behaviour that
// must survive the deletion.

const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'app.js'), 'utf8');

test('CLIENT-5: the dead effort-card cleanup registry is gone', () => {
  assert.doesNotMatch(appSource, /registerEffortCardCleanup/, 'no register function remains');
  assert.doesNotMatch(appSource, /runEffortCardCleanups/, 'no runner remains');
  assert.doesNotMatch(appSource, /effortCardCleanups/, 'no registry array remains');
});

test('CLIENT-5: invalidatePreview keeps its live behaviour', () => {
  const start = appSource.indexOf('function invalidatePreview()');
  assert.ok(start >= 0, 'invalidatePreview still exists');
  const body = appSource.slice(start, start + 900);
  assert.match(body, /previewRequestSeq\+\+/, 'invalidation still supersedes in-flight previews');
  assert.match(body, /pendingWrite = null/, 'invalidation still clears the pending write');
  assert.match(body, /previewPanel\.hidden = true/, 'invalidation still hides the preview panel');
  assert.match(body, /btn\.disabled = true/, 'invalidation still disables the approve button');
});
