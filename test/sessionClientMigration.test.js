'use strict';

// Source-introspection guard for the F04C client migration: the browser must move
// off a raw localStorage key onto the durable session cookie, and never regress to
// persisting the key once a session is available. (The runtime behavior is covered
// server-side in api-smoke; this pins the client wiring against silent reversion.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('api.js sends the session cookie and only sends the key header when a key exists', () => {
  const api = read('src/app/api.js');
  assert.match(api, /credentials: 'same-origin'/, 'the api() fetch must send same-origin cookies');
  // The key header is now conditional, not unconditionally attached.
  assert.match(api, /if \(key\) headers\['x-atlas-api-key'\] = key;/);
  for (const fn of ['isConnected', 'refreshSessionStatus', 'sessionLogin', 'sessionLogout']) {
    assert.match(api, new RegExp(`export (async )?function ${fn}\\b`), `api.js must export ${fn}`);
  }
  // isConnected treats a live session, the PERSISTENT connected flag, OR a stored
  // key as connected. The persistent flag is what survives a reopen (sessionActive
  // resets to false on reload), so a cookie-only owner is not falsely prompted.
  assert.match(api, /export const CONNECTED_FLAG = 'atlas_connected'/);
  assert.match(api, /if \(sessionActive\) return true;/);
  assert.match(api, /localStorage\.getItem\(CONNECTED_FLAG\) === '1'\) return true/);
});

test('the persistent connected flag is set on login/auth and cleared on logout/de-auth', () => {
  const api = read('src/app/api.js');
  // Login success and a confirmed-authenticated status set the flag (via markConnected).
  assert.match(api, /function markConnected\(\)[\s\S]{0,120}setItem\(CONNECTED_FLAG, '1'\)/);
  assert.match(api, /function markDisconnected\(\)[\s\S]{0,120}removeItem\(CONNECTED_FLAG\)/);
  assert.match(api, /if \(res\.ok\) markConnected\(\)/, 'sessionLogin success marks connected');
  assert.match(api, /if \(data\.authenticated\) markConnected\(\)/, 'a confirmed-authenticated status marks connected');
  assert.match(api, /markDisconnected\(\)/, 'logout clears the flag');
  // A status check must NEVER clear the durable flag (a not-sent cookie on a
  // Safari cold-reopen would otherwise falsely log the owner out).
  assert.doesNotMatch(api, /else if \(data\.sessions_enabled\) \{?\s*markDisconnected/, 'refreshSessionStatus must not clear the flag on a not-authenticated status');
});

test('the settings connect flow prefers a session and drops the raw key on success', () => {
  const app = read('src/app/app.js');
  // On a successful login the raw key is removed from localStorage.
  assert.match(app, /const result = await sessionLogin\(key\);/);
  assert.match(app, /result\.ok[\s\S]{0,160}localStorage\.removeItem\(API_KEY_STORAGE\)/,
    'a successful connect must remove the raw key from localStorage');
  // Disconnect logs out AND clears any legacy key.
  assert.match(app, /await sessionLogout\(\);[\s\S]{0,120}localStorage\.removeItem\(API_KEY_STORAGE\)/);
});

test('the startup bootstrap migrates a legacy key into a session then deletes it', () => {
  const app = read('src/app/app.js');
  assert.match(app, /refreshSessionStatus\(\)/, 'bootstrap refreshes session status before the first loads');
  assert.match(app, /sessions_enabled && !status\.authenticated/);
  assert.match(app, /const migrated = await sessionLogin\(legacyKey\);[\s\S]{0,120}localStorage\.removeItem\(API_KEY_STORAGE\)/,
    'a legacy key must be migrated to a cookie and then removed');
});

test('no connection gate still keys off the raw key alone (all use isConnected)', () => {
  const app = read('src/app/app.js');
  assert.equal((app.match(/!getApiKey\(\)/g) || []).length, 0,
    'every "not connected" gate must use isConnected(), not !getApiKey()');
  assert.ok(app.includes('isConnected('), 'app.js consults isConnected()');
});

test('the Settings UI connects/disconnects and does not advertise permanent key storage', () => {
  const html = read('src/app/index.html');
  assert.match(html, />Connect</);
  assert.match(html, /id="clear-key-btn"[^>]*>Disconnect</);
  // The old "stored only in this browser (localStorage) … x-atlas-api-key header"
  // sentence is gone — the copy now describes the session-cookie exchange.
  assert.doesNotMatch(html, /stored only in this browser \(localStorage\) and sent as/);
  assert.match(html, /session cookie/i);
});

// F04C live-validation regression (reload/reopen showed "Set your API key" even
// though the session cookie was valid): every client module that decides "is the
// owner connected?" must consult isConnected() — a durable cookie OR a legacy key.
// After the cookie migration getApiKey() is empty, so a `!getApiKey()` gate falsely
// prompts for a key on a fully-authenticated session. This reproduces that failure.
test('F04C live-fix: no client module gates connection on the raw key alone', () => {
  const dir = path.join(ROOT, 'src', 'app');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
    const count = (fs.readFileSync(path.join(dir, f), 'utf8').match(/!\s*getApiKey\(\)/g) || []).length;
    if (count) offenders.push(`${f}:${count}`);
  }
  assert.deepEqual(offenders, [], `these modules still gate on the raw key (empty after cookie migration → a false "Set your API key" prompt): ${offenders.join(', ')}`);
});

test('F04C live-fix: the coach/plan/progress/drawer gates consult isConnected', () => {
  for (const rel of ['src/app/coach-conversation.js', 'src/app/progressView.js', 'src/app/dom.js', 'src/app/drawer.js']) {
    assert.match(read(rel), /!isConnected\(\)/, `${rel} must gate connection on isConnected()`);
  }
  // isConnected is exposed as a global for the browser-global modules (drawer,
  // coach-conversation) that reuse app.js globals rather than importing.
  assert.match(read('src/app/app.js'), /window\.isConnected = isConnected/);
});
