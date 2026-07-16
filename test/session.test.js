'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const session = require('../services/session');

const SECRET = 'unit-test-session-secret-value-not-real';
const NOW = 1_752_624_000_000; // fixed ms for deterministic expiry math

// --- sign / verify ----------------------------------------------------------

test('signSession + verifySession round-trips an authentic, unexpired token', () => {
  const { token, payload } = session.issueToken(SECRET, NOW);
  const verified = session.verifySession(token, SECRET, NOW + 1000);
  assert.ok(verified, 'a fresh token verifies');
  assert.equal(verified.sub, 'owner');
  assert.equal(verified.exp, payload.exp);
});

test('verifySession rejects a tampered signature', () => {
  const { token } = session.issueToken(SECRET, NOW);
  const tampered = `${token.slice(0, -1)}${token.slice(-1) === 'A' ? 'B' : 'A'}`;
  assert.equal(session.verifySession(tampered, SECRET, NOW), null);
});

test('verifySession rejects a tampered payload (re-encoded body, old signature)', () => {
  const { token } = session.issueToken(SECRET, NOW);
  const sig = token.slice(token.indexOf('.') + 1);
  const forgedBody = Buffer.from(JSON.stringify({ v: 1, sub: 'owner', iat: NOW, exp: NOW + 1e12, nonce: 'x' })).toString('base64url');
  assert.equal(session.verifySession(`${forgedBody}.${sig}`, SECRET, NOW), null);
});

test('verifySession rejects an expired token', () => {
  const { token, payload } = session.issueToken(SECRET, NOW, 1000);
  assert.equal(session.verifySession(token, SECRET, payload.exp + 1), null);
  assert.ok(session.verifySession(token, SECRET, payload.exp - 1), 'still valid one ms before expiry');
});

test('verifySession rejects a token signed with a different secret', () => {
  const { token } = session.issueToken(SECRET, NOW);
  assert.equal(session.verifySession(token, 'a-different-secret', NOW), null);
});

test('verifySession fails closed on missing/malformed input', () => {
  assert.equal(session.verifySession('', SECRET, NOW), null);
  assert.equal(session.verifySession('no-dot', SECRET, NOW), null);
  assert.equal(session.verifySession('a.b.c', SECRET, NOW), null);
  assert.equal(session.verifySession('.sigonly', SECRET, NOW), null);
  assert.equal(session.verifySession('bodyonly.', SECRET, NOW), null);
  assert.equal(session.verifySession(session.issueToken(SECRET, NOW).token, '', NOW), null);
});

test('issueToken carries no secret or api key in the payload', () => {
  const { token, payload } = session.issueToken(SECRET, NOW);
  assert.equal(typeof payload.nonce, 'string');
  assert.ok(payload.exp > payload.iat);
  const decoded = Buffer.from(token.slice(0, token.indexOf('.')), 'base64url').toString('utf8');
  assert.ok(!decoded.includes(SECRET), 'the signing secret must never appear in the token body');
});

// --- cookies ----------------------------------------------------------------

test('parseCookies handles multiple pairs, spacing, and junk', () => {
  const c = session.parseCookies('atlas_session=abc.def; other=1;   spaced = 2 ;broken');
  assert.equal(c.atlas_session, 'abc.def');
  assert.equal(c.other, '1');
  assert.equal(c.spaced, '2');
  assert.equal(session.parseCookies('').atlas_session, undefined);
  assert.equal(session.parseCookies(null).atlas_session, undefined);
});

test('buildSetCookie sets HttpOnly, Secure, SameSite=Lax, Path, and Max-Age', () => {
  const c = session.buildSetCookie('tok', { maxAgeMs: 120 * 86400000, secure: true });
  assert.match(c, /^atlas_session=tok/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=\d+/);
});

test('buildSetCookie omits Secure only when explicitly insecure (local dev)', () => {
  assert.doesNotMatch(session.buildSetCookie('tok', { secure: false }), /Secure/);
});

test('buildClearCookie expires the cookie immediately (Max-Age=0)', () => {
  const c = session.buildClearCookie({ secure: true });
  assert.match(c, /^atlas_session=;/);
  assert.match(c, /Max-Age=0/);
  assert.match(c, /HttpOnly/);
});

// --- origin / secure / renew ------------------------------------------------

test('isAllowedOrigin allows same-host and absent, rejects cross-origin', () => {
  const req = { get: name => (name === 'host' ? 'atlas.example.com' : null) };
  assert.equal(session.isAllowedOrigin('https://atlas.example.com', req), true);
  assert.equal(session.isAllowedOrigin(undefined, req), true, 'absent Origin is allowed (Strict cookie / same-origin)');
  assert.equal(session.isAllowedOrigin('https://evil.example.com', req), false);
  assert.equal(session.isAllowedOrigin('not a url', req), false);
});

test('isAllowedOrigin honors a configured CORS_ORIGIN', () => {
  const prev = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://app.example.com, https://other.example.com';
  try {
    const req = { get: () => 'internal-host' };
    assert.equal(session.isAllowedOrigin('https://app.example.com', req), true);
    assert.equal(session.isAllowedOrigin('https://nope.example.com', req), false);
  } finally {
    if (prev === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = prev;
  }
});

test('isSecureRequest reflects req.secure and x-forwarded-proto', () => {
  assert.equal(session.isSecureRequest({ secure: true, get: () => '' }), true);
  assert.equal(session.isSecureRequest({ secure: false, get: n => (n === 'x-forwarded-proto' ? 'https' : '') }), true);
  assert.equal(session.isSecureRequest({ secure: false, get: n => (n === 'x-forwarded-proto' ? 'http,https' : '') }), false);
  assert.equal(session.isSecureRequest({ secure: false, get: () => '' }), false);
});

test('shouldRenew is false for a fresh session and true past the halfway mark', () => {
  const { payload } = session.issueToken(SECRET, NOW);
  assert.equal(session.shouldRenew(payload, NOW + 1000), false);
  assert.equal(session.shouldRenew(payload, NOW + session.RENEW_AFTER_MS + 1000), true);
});

test('sessionsEnabled reflects ATLAS_SESSION_SECRET presence', () => {
  const prev = process.env.ATLAS_SESSION_SECRET;
  try {
    delete process.env.ATLAS_SESSION_SECRET;
    assert.equal(session.sessionsEnabled(), false);
    process.env.ATLAS_SESSION_SECRET = 'x';
    assert.equal(session.sessionsEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.ATLAS_SESSION_SECRET; else process.env.ATLAS_SESSION_SECRET = prev;
  }
});
