const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const chatSrc = fs.readFileSync(path.join(repoRoot, 'public', 'chat.js'), 'utf8');

// The owner-reported inversion: a pasted multi-exercise workout's ✓ confirmation /
// coaching rendered ABOVE the user's paste bubble. The fix paints the user bubble
// first thing in the submit handler so it always precedes any Atlas response.

test('chat.js exposes addUserBubble and no longer paints on form submit (app.js owns it)', () => {
  assert.match(chatSrc, /window\.atlasAddUserBubble\s*=\s*addUserBubble/, 'chat.js must expose the bubble painter');
  // chat.js must NOT paint the user bubble on the form submit event anymore — that
  // raced app.js and caused the inversion. (The effort-image attachment bubble stays.)
  assert.doesNotMatch(chatSrc, /form\.addEventListener\('submit'[\s\S]*addUserBubble/,
    'chat.js submit listener must not paint the user bubble (app.js does, first)');
});

test('app.js paints the user bubble at the very top of the logger-form submit handler', () => {
  const start = appSrc.indexOf("getElementById('logger-form').addEventListener('submit'");
  assert.ok(start >= 0, 'logger-form submit handler exists');
  // Look at the first stretch of the handler body (enough to cover the comment
  // block + paint + the first routing branch).
  const head = appSrc.slice(start, start + 1400);
  assert.match(head, /window\.atlasAddUserBubble/, 'must paint via the shared bubble painter');
  // The paint must come BEFORE the first routing branch (the session-request check),
  // so the user bubble precedes any coach/preview/reaction append.
  const paintIdx = head.indexOf('atlasAddUserBubble');
  const firstRouteIdx = head.indexOf('looksLikeSessionRequest');
  assert.ok(paintIdx >= 0 && firstRouteIdx >= 0 && paintIdx < firstRouteIdx,
    'the bubble paint must precede the first routing branch');
});
