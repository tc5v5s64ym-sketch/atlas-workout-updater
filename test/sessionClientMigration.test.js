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
  // isConnected treats an active session OR a stored key as connected.
  assert.match(api, /return sessionActive \|\| Boolean\(getApiKey\(\)\)/);
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
