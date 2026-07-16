'use strict';

// Durable owner session (F04C) — a signed, HttpOnly session cookie that lets Dale
// authenticate once per device instead of keeping the raw Atlas API key in browser
// localStorage. The cookie is an HMAC-signed bearer token; the browser can present
// it but JavaScript cannot read it (HttpOnly) and cannot forge it (the signing
// secret never leaves the server).
//
// Design / safety:
//   * The signing secret is ATLAS_SESSION_SECRET — a NEW server-side Render secret.
//     When it is absent, sessions are simply DISABLED (sessionsEnabled() === false)
//     and auth falls back to the existing x-atlas-api-key header, so nothing breaks
//     before the owner sets it. The secret is read dynamically (never cached at
//     load) so it can be provisioned without a code change.
//   * This module NEVER weakens the existing gate: a valid cookie is an ADDITIONAL
//     accepted credential alongside the exact API key; an unauthenticated request
//     still fails closed.
//   * The secret and the API key are never logged, echoed, or placed in a token
//     payload — the token carries only {v, sub, iat, exp, nonce}.

const crypto = require('crypto');

const COOKIE_NAME = 'atlas_session';
// ~120 days — comfortably inside the card's 90–180 day window; survives app-shell /
// service-worker refreshes because it is a cookie, not localStorage.
const DEFAULT_TTL_MS = 120 * 24 * 60 * 60 * 1000;
// Slide the expiry forward once a session is more than half-consumed, so an active
// owner is not forced to re-authenticate on a hard 120-day boundary.
const RENEW_AFTER_MS = 60 * 24 * 60 * 60 * 1000;

function sessionSecret() {
  return process.env.ATLAS_SESSION_SECRET || '';
}

function sessionsEnabled() {
  return Boolean(sessionSecret());
}

function b64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

// token = "<payload-base64url>.<sig-base64url>"
function signSession(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(hmac(secret, body));
  return `${body}.${sig}`;
}

// Returns the payload object when the token is authentic and unexpired, else null.
// Fails closed on any malformed input, signature mismatch, or expiry.
function verifySession(token, secret, now = Date.now()) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expected;
  try {
    expected = b64urlEncode(hmac(secret, body));
  } catch (_) {
    return null;
  }
  const given = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return null;
  if (!crypto.timingSafeEqual(given, want)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  return payload;
}

function issueToken(secret, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const payload = {
    v: 1,
    sub: 'owner',
    iat: now,
    exp: now + ttlMs,
    nonce: crypto.randomBytes(9).toString('base64url')
  };
  return { token: signSession(payload, secret), payload, maxAgeMs: ttlMs };
}

function shouldRenew(payload, now = Date.now()) {
  if (!payload || typeof payload.iat !== 'number') return false;
  return now - payload.iat > RENEW_AFTER_MS;
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const rawVal = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(rawVal);
    } catch (_) {
      out[key] = rawVal;
    }
  }
  return out;
}

// Production requests arrive over HTTPS through Render's proxy (trust proxy = 1),
// so req.secure / x-forwarded-proto is authoritative. Local dev over http omits
// Secure so the cookie still works; tests drive cookies manually regardless.
function isSecureRequest(req) {
  if (!req) return false;
  if (req.secure === true) return true;
  const proto = String((req.get && req.get('x-forwarded-proto')) || '').split(',')[0].trim();
  return proto === 'https';
}

// SameSite=Lax (not Strict): Strict withholds the cookie on a session-restore /
// cold-reopen top-level navigation (observed on iOS Safari — the durable session
// looked "logged out" after close→reopen). Lax presents the cookie on same-site
// top-level navigations, re-establishing the session, while still NOT sending it
// on cross-site subresource requests or cross-site POST — so CSRF on the write
// routes stays blocked, and the explicit same-origin Origin check below is kept as
// defense-in-depth.
function buildSetCookie(token, { maxAgeMs = DEFAULT_TTL_MS, secure = true } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function buildClearCookie({ secure = true } = {}) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

// CSRF defense for cookie-authenticated STATE-CHANGING requests. SameSite=Strict
// already stops the cookie from riding a cross-site request; this is the
// belt-and-suspenders origin check on top. Absent Origin is allowed (same-origin
// GET/navigation, or a Strict cookie that a cross-site context could not attach);
// a present Origin must match the app's own host.
function isAllowedOrigin(originHeader, req) {
  if (!originHeader) return true;
  let originHost;
  try {
    originHost = new URL(originHeader).host;
  } catch (_) {
    return false;
  }
  const reqHost = req && req.get ? req.get('host') : null;
  if (reqHost && originHost === reqHost) return true;
  // Also honor the operator-configured app origins (CORS_ORIGIN in prod) and the
  // scripts' ATLAS_BASE_URL, so a correctly-configured deploy always matches.
  for (const envVal of [process.env.CORS_ORIGIN, process.env.ATLAS_BASE_URL]) {
    for (const candidate of String(envVal || '').split(',')) {
      const trimmed = candidate.trim();
      if (!trimmed || trimmed === '*') continue;
      try {
        if (new URL(trimmed).host === originHost) return true;
      } catch (_) { /* malformed configured origin → skip */ }
    }
  }
  return false;
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_TTL_MS,
  RENEW_AFTER_MS,
  sessionSecret,
  sessionsEnabled,
  signSession,
  verifySession,
  issueToken,
  shouldRenew,
  parseCookies,
  isSecureRequest,
  buildSetCookie,
  buildClearCookie,
  isAllowedOrigin
};
