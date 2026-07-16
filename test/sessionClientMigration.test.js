'use strict';

// Source-introspection guard for the F04C client auth model. The browser MUST be
// server-authoritative: it never guesses whether its HttpOnly session cookie is valid.
// There is no persistent localStorage "connected" flag (a flag is a client-side guess,
// and a guess is exactly what produced split-brain auth — Settings claiming connected
// while Coach demanded a key). A single module-level `serverAuthState`, written ONLY by
// real server responses, is the one truth both Settings and every read derive from.
// (Runtime behavior is covered browser-side in tests/e2e/session-auth.spec.js and
// server-side in api-smoke; this pins the wiring against silent reversion.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('api.js sends the session cookie and only sends the key header when a key exists', () => {
  const api = read('src/app/api.js');
  assert.match(api, /credentials: 'same-origin'/, 'the api() fetch must send same-origin cookies');
  // The key header is conditional, not unconditionally attached.
  assert.match(api, /if \(key\) headers\['x-atlas-api-key'\] = key;/);
  for (const fn of ['isConnected', 'authState', 'refreshSessionStatus', 'sessionLogin', 'sessionLogout']) {
    assert.match(api, new RegExp(`export (async )?function ${fn}\\b`), `api.js must export ${fn}`);
  }
});

test('there is NO persistent client-side connected flag (removed authority)', () => {
  const api = read('src/app/api.js');
  assert.doesNotMatch(api, /atlas_connected/, 'the atlas_connected localStorage flag must be gone');
  assert.doesNotMatch(api, /CONNECTED_FLAG/, 'the CONNECTED_FLAG constant must be gone');
  assert.doesNotMatch(api, /markConnected|markDisconnected/, 'the flag-writing markers must be gone');
  // No client module may resurrect the flag as an auth authority.
  const dir = path.join(ROOT, 'src', 'app');
  const offenders = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .filter(f => /atlas_connected|CONNECTED_FLAG/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(offenders, [], `these modules still reference the removed connected flag: ${offenders.join(', ')}`);
});

test('isConnected() is server-authoritative and OPTIMISTIC (false only on a confirmed negative)', () => {
  const api = read('src/app/api.js');
  // A single tri-state, defaulting to the optimistic 'unknown'.
  assert.match(api, /let serverAuthState = 'unknown'/, 'a single server-authoritative auth state must exist');
  // The gate returns false ONLY when the server has confirmed unauthenticated — never
  // from a synchronous local flag/key guess. 'unknown' and 'authenticated' both allow the
  // attempt, so a cookie-only owner is never pre-blocked on reopen.
  assert.match(api, /export function isConnected\(\)\s*\{\s*return serverAuthState !== 'unauthenticated';\s*\}/,
    'isConnected() must be `return serverAuthState !== "unauthenticated"` (optimistic)');
  // It must NOT fall back to a stored key or a persistent flag.
  const body = api.slice(api.indexOf('export function isConnected()'), api.indexOf('export function isConnected()') + 200);
  assert.doesNotMatch(body, /getApiKey|localStorage/, 'isConnected() must not consult the raw key or localStorage');
});

test('only real server responses write the auth state', () => {
  const api = read('src/app/api.js');
  assert.match(api, /function setAuthenticated\(\) \{ serverAuthState = 'authenticated'; \}/);
  assert.match(api, /function setUnauthenticated\(\) \{ serverAuthState = 'unauthenticated'; \}/);
  // A 2xx from a protected api() call confirms authenticated; a 401 confirms the negative.
  assert.match(api, /setAuthenticated\(\);\s*\n\s*return json;/, 'a 2xx api() response marks authenticated');
  assert.match(api, /if \(err && err\.status === 401\) setUnauthenticated\(\);/, 'a 401 api() response marks unauthenticated');
  // Login success / a rejected key / logout all flip the state from the server verdict.
  assert.match(api, /if \(res\.ok\) setAuthenticated\(\);/, 'login success marks authenticated');
  assert.match(api, /else if \(res\.status === 401\) setUnauthenticated\(\)/, 'a rejected key marks unauthenticated');
  assert.match(api, /export async function sessionLogout\(\)[\s\S]{0,300}setUnauthenticated\(\);/, 'logout marks unauthenticated');
});

test('a status timeout/transport failure NEVER flips the owner to disconnected', () => {
  const api = read('src/app/api.js');
  // refreshSessionStatus writes the state ONLY from server data; the catch (timeout/abort/
  // transport) must leave serverAuthState untouched — no setUnauthenticated in the catch.
  const fn = api.slice(api.indexOf('export async function refreshSessionStatus'), api.indexOf('export async function sessionLogin'));
  assert.match(fn, /if \(data\.authenticated\) \{\s*\n\s*setAuthenticated\(\);/, 'authenticated:true marks authenticated');
  assert.match(fn, /else if \(data\.sessions_enabled\) \{[\s\S]{0,200}setUnauthenticated\(\);/, 'a sessions-enabled negative status marks unauthenticated');
  const catchBlock = fn.slice(fn.indexOf('} catch'));
  assert.doesNotMatch(catchBlock, /setUnauthenticated|setAuthenticated/, 'the status catch must not touch the auth state (a network hiccup is not a verdict)');
  // The status probe must also never write a localStorage flag.
  assert.doesNotMatch(fn, /localStorage/, 'refreshSessionStatus must not persist any client flag');
});

test('the settings connect flow prefers a session and drops the raw key on success', () => {
  const app = read('src/app/app.js');
  assert.match(app, /const result = await sessionLogin\(key\);/);
  assert.match(app, /result\.ok[\s\S]{0,160}localStorage\.removeItem\(API_KEY_STORAGE\)/,
    'a successful connect must remove the raw key from localStorage');
  // Disconnect logs out AND clears any legacy key.
  assert.match(app, /await sessionLogout\(\);[\s\S]{0,120}localStorage\.removeItem\(API_KEY_STORAGE\)/);
});

test('Settings reflects the SERVER verdict on load (one truth, never a second)', () => {
  const app = read('src/app/app.js');
  // A reconcile derives the Settings box from the server-authoritative authState(), so
  // Settings and Coach can never disagree about authentication.
  assert.match(app, /function reflectSettingsAuth\(\)/, 'a Settings reconcile must exist');
  assert.match(app, /authState\(\)/, 'the reconcile must read the server-authoritative state');
  assert.match(app, /reflectSettingsAuth\(\);/, 'the bootstrap must call the reconcile after the status probe');
});

test('the startup bootstrap migrates a legacy key into a session then deletes it', () => {
  const app = read('src/app/app.js');
  assert.match(app, /refreshSessionStatus\(\)/, 'bootstrap refreshes session status before the first loads');
  assert.match(app, /sessions_enabled && !status\.authenticated/);
  assert.match(app, /const migrated = await sessionLogin\(legacyKey\);[\s\S]{0,120}localStorage\.removeItem\(API_KEY_STORAGE\)/,
    'a legacy key must be migrated to a cookie and then removed');
});

test('no connection gate keys off the raw key alone (all use isConnected)', () => {
  const app = read('src/app/app.js');
  assert.equal((app.match(/!getApiKey\(\)/g) || []).length, 0,
    'every "not connected" gate must use isConnected(), not !getApiKey()');
  assert.ok(app.includes('isConnected('), 'app.js consults isConnected()');
});

test('the Settings UI connects/disconnects and does not advertise permanent key storage', () => {
  const html = read('src/app/index.html');
  assert.match(html, />Connect</);
  assert.match(html, /id="clear-key-btn"[^>]*>Disconnect</);
  assert.doesNotMatch(html, /stored only in this browser \(localStorage\) and sent as/);
  assert.match(html, /session cookie/i);
});

// Every client module that decides "is the owner connected?" must consult isConnected()
// — which is now server-authoritative and optimistic. A `!getApiKey()` gate would falsely
// prompt on a fully-authenticated cookie-only session (getApiKey() is empty after
// migration). This pins that no module regresses to the raw key.
test('F04C: no client module gates connection on the raw key alone', () => {
  const dir = path.join(ROOT, 'src', 'app');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
    const count = (fs.readFileSync(path.join(dir, f), 'utf8').match(/!\s*getApiKey\(\)/g) || []).length;
    if (count) offenders.push(`${f}:${count}`);
  }
  assert.deepEqual(offenders, [], `these modules still gate on the raw key (empty after cookie migration → a false prompt): ${offenders.join(', ')}`);
});

test('F04C: the coach/plan/progress/drawer gates consult isConnected', () => {
  for (const rel of ['src/app/coach-conversation.js', 'src/app/progressView.js', 'src/app/dom.js', 'src/app/drawer.js']) {
    assert.match(read(rel), /!isConnected\(\)/, `${rel} must gate connection on isConnected()`);
  }
  assert.match(read('src/app/app.js'), /window\.isConnected = isConnected/);
});

// The user-visible "not connected" copy is a CONNECT prompt (server-401-driven), never a
// "set your API key" prompt — the key model is gone and the cookie is what authenticates.
test('F04C: the not-connected copy prompts to Connect, not to set a key', () => {
  for (const rel of ['src/app/app.js', 'src/app/progressView.js', 'src/app/coach-conversation.js']) {
    assert.doesNotMatch(read(rel), /Set your API key in Settings/, `${rel} must not tell the owner to set an API key`);
  }
});
