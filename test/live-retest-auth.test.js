'use strict';

// Unit coverage for the live-retest synthetic provenance + optional production
// authentication seam (scripts/live-retest.js, PR A).
//
// Every test here is deterministic and offline: `authenticateContext` takes an
// injectable `fetchImpl` and `logger`, so no network call and no browser is
// needed. The credential used throughout is a fake sentinel — the point of most
// of these tests is proving that sentinel can never reach a log, a report, an
// artifact, or a thrown error.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SYNTHETIC_ORIGIN,
  SYNTHETIC_HEADERS,
  ACCESS_CODE_ENV,
  SESSION_COOKIE_NAME,
  redactCredential,
  parseSessionCookie,
  authenticateContext,
  shouldProceedToNavigation,
  buildMarkdownReport
} = require('../scripts/live-retest');

// A distinctive fake credential: if it appears anywhere it is unmistakable.
const FAKE_CODE = 'SENTINEL-must-never-appear-6f2a1c';
const TOKEN = 'eyJfaWQiOiJvd25lciJ9.sig-abc123';
const SET_COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`;

// Minimal fakes ---------------------------------------------------------------

function fakeContext() {
  const added = [];
  const headers = [];
  return {
    added,
    headers,
    addCookies: async (c) => { added.push(...c); },
    setExtraHTTPHeaders: async (h) => { headers.push(h); }
  };
}

function fakeResponse(status, setCookie = null, body = '') {
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'set-cookie' ? setCookie : null) },
    text: async () => body,
    json: async () => { try { return JSON.parse(body); } catch { return null; } }
  };
}

// Captures every string the harness logs, so a test can assert on all output.
function recordingLogger() {
  const out = [];
  return { out, log: (...a) => out.push(a.join(' ')), error: (...a) => out.push(a.join(' ')) };
}

// ── 1. The synthetic header is attached ──────────────────────────────────────

test('synthetic provenance token is the playbook value', () => {
  assert.equal(SYNTHETIC_ORIGIN, 'playwright');
  assert.deepEqual({ ...SYNTHETIC_HEADERS }, { 'x-atlas-request-origin': 'playwright' });
});

test('SYNTHETIC_HEADERS is frozen so a caller cannot mutate provenance', () => {
  assert.throws(() => { 'use strict'; SYNTHETIC_HEADERS['x-atlas-request-origin'] = 'owner'; }, TypeError);
});

test('the login request carries the synthetic header', async () => {
  let seen = null;
  await authenticateContext({
    baseUrl: 'https://example.test',
    accessCode: FAKE_CODE,
    context: fakeContext(),
    logger: recordingLogger(),
    fetchImpl: async (_url, init) => { seen = init.headers; return fakeResponse(200, SET_COOKIE); }
  });
  assert.equal(seen['x-atlas-request-origin'], 'playwright');
  assert.equal(seen['Content-Type'], 'application/json');
});

test('the login request posts the credential as api_key to the real login route', async () => {
  let url = null; let body = null;
  await authenticateContext({
    baseUrl: 'https://example.test/',
    accessCode: FAKE_CODE,
    context: fakeContext(),
    logger: recordingLogger(),
    fetchImpl: async (u, init) => { url = u; body = init.body; return fakeResponse(200, SET_COOKIE); }
  });
  // Trailing slash on baseUrl must not double up.
  assert.equal(url, 'https://example.test/api/session/login');
  assert.deepEqual(JSON.parse(body), { api_key: FAKE_CODE });
});

// ── 2. Auth succeeds without logging the credential ─────────────────────────

test('a 200 login seeds the session cookie into the browser context', async () => {
  const context = fakeContext();
  const res = await authenticateContext({
    baseUrl: 'https://example.test',
    accessCode: FAKE_CODE,
    context,
    logger: recordingLogger(),
    fetchImpl: async () => fakeResponse(200, SET_COOKIE)
  });
  assert.deepEqual(res, { attempted: true, authenticated: true, status: 200, reason: 'ok' });
  assert.equal(context.added.length, 1);
  assert.equal(context.added[0].name, SESSION_COOKIE_NAME);
  assert.equal(context.added[0].value, TOKEN);
  assert.equal(context.added[0].httpOnly, true);
  assert.equal(context.added[0].secure, true);
});

test('a successful login logs nothing containing the credential or the token', async () => {
  const logger = recordingLogger();
  await authenticateContext({
    baseUrl: 'https://example.test',
    accessCode: FAKE_CODE,
    context: fakeContext(),
    logger,
    fetchImpl: async () => fakeResponse(200, SET_COOKIE)
  });
  const all = logger.out.join('\n');
  assert.ok(all.length > 0, 'it does log something');
  assert.ok(!all.includes(FAKE_CODE), 'credential absent from output');
  assert.ok(!all.includes(TOKEN), 'session token absent from output');
});

test('the returned auth summary is serializable and carries no secret', async () => {
  const res = await authenticateContext({
    baseUrl: 'https://example.test',
    accessCode: FAKE_CODE,
    context: fakeContext(),
    logger: recordingLogger(),
    fetchImpl: async () => fakeResponse(200, SET_COOKIE)
  });
  const json = JSON.stringify(res);
  assert.ok(!json.includes(FAKE_CODE));
  assert.ok(!json.includes(TOKEN));
  assert.deepEqual(Object.keys(res).sort(), ['attempted', 'authenticated', 'reason', 'status']);
});

// ── 3. Missing credentials preserve current behavior ────────────────────────

test('no credential: no fetch, no cookie, and the run is not marked attempted', async () => {
  const context = fakeContext();
  let called = false;
  const res = await authenticateContext({
    baseUrl: 'https://example.test',
    accessCode: null,
    context,
    logger: recordingLogger(),
    fetchImpl: async () => { called = true; return fakeResponse(200, SET_COOKIE); }
  });
  assert.equal(called, false, 'no login request is made');
  assert.equal(context.added.length, 0, 'no cookie is seeded');
  assert.deepEqual(res, { attempted: false, authenticated: false, status: null, reason: 'no_credential' });
});

test('no credential still proceeds to navigation (unauthenticated run preserved)', () => {
  const gate = shouldProceedToNavigation({ attempted: false, authenticated: false, reason: 'no_credential' });
  assert.equal(gate.proceed, true);
  assert.match(gate.reason, /unauthenticated/);
});

test('an empty-string credential is treated as absent, not as a login attempt', async () => {
  const res = await authenticateContext({
    baseUrl: 'https://example.test',
    accessCode: '',
    context: fakeContext(),
    logger: recordingLogger(),
    fetchImpl: async () => { throw new Error('must not be called'); }
  });
  assert.equal(res.attempted, false);
});

// ── 4. Failed auth stops authenticated navigation (never fails open) ────────

for (const [status, reason] of [[401, 'rejected'], [503, 'sessions_disabled'], [500, 'login_failed']]) {
  test(`HTTP ${status} → ${reason}, no cookie, and navigation is refused`, async () => {
    const context = fakeContext();
    const res = await authenticateContext({
      baseUrl: 'https://example.test',
      accessCode: FAKE_CODE,
      context,
      logger: recordingLogger(),
      fetchImpl: async () => fakeResponse(status, null, 'unauthorized')
    });
    assert.deepEqual(res, { attempted: true, authenticated: false, status, reason });
    assert.equal(context.added.length, 0, 'no cookie seeded on a failed login');

    const gate = shouldProceedToNavigation(res);
    assert.equal(gate.proceed, false, 'must not continue unauthenticated');
    assert.match(gate.reason, /refusing to continue unauthenticated/);
  });
}

test('a 200 with no Set-Cookie fails closed rather than proceeding session-less', async () => {
  const res = await authenticateContext({
    baseUrl: 'https://example.test',
    accessCode: FAKE_CODE,
    context: fakeContext(),
    logger: recordingLogger(),
    fetchImpl: async () => fakeResponse(200, null)
  });
  assert.equal(res.authenticated, false);
  assert.equal(res.reason, 'no_cookie');
  assert.equal(shouldProceedToNavigation(res).proceed, false);
});

test('a transport failure fails closed', async () => {
  const res = await authenticateContext({
    baseUrl: 'https://example.test',
    accessCode: FAKE_CODE,
    context: fakeContext(),
    logger: recordingLogger(),
    fetchImpl: async () => { throw new Error('ECONNRESET'); }
  });
  assert.deepEqual(res, { attempted: true, authenticated: false, status: 0, reason: 'transport_error' });
  assert.equal(shouldProceedToNavigation(res).proceed, false);
});

// ── 5. The credential never appears in reports, output, artifacts, or errors ──

test('redactCredential removes every occurrence', () => {
  assert.equal(redactCredential(`a ${FAKE_CODE} b ${FAKE_CODE}`, FAKE_CODE), 'a [REDACTED] b [REDACTED]');
});

test('redactCredential is safe on empty / absent inputs', () => {
  assert.equal(redactCredential(undefined, FAKE_CODE), '');
  assert.equal(redactCredential(null, FAKE_CODE), '');
  assert.equal(redactCredential('untouched', null), 'untouched');
  assert.equal(redactCredential('untouched', ''), 'untouched');
});

test('a rejected login never echoes the credential even when the server body contains it', async () => {
  const logger = recordingLogger();
  // Adversarial server: reflects the submitted credential back in its body.
  const res = await authenticateContext({
    baseUrl: 'https://example.test',
    accessCode: FAKE_CODE,
    context: fakeContext(),
    logger,
    fetchImpl: async () => fakeResponse(401, null, `bad key: ${FAKE_CODE}`)
  });
  const all = logger.out.join('\n') + JSON.stringify(res);
  assert.ok(!all.includes(FAKE_CODE), 'credential absent from logs and result');
});

test('a transport error whose message contains the credential is redacted before logging', async () => {
  const logger = recordingLogger();
  await authenticateContext({
    baseUrl: 'https://example.test',
    accessCode: FAKE_CODE,
    context: fakeContext(),
    logger,
    fetchImpl: async () => { throw new Error(`connect failed while sending ${FAKE_CODE}`); }
  });
  const all = logger.out.join('\n');
  assert.ok(!all.includes(FAKE_CODE), 'credential redacted from the thrown error');
  assert.ok(all.includes('[REDACTED]'), 'redaction marker present');
});

test('the markdown report never contains the credential or token, in any auth posture', () => {
  const postures = [
    { attempted: false, authenticated: false, status: null, reason: 'no_credential' },
    { attempted: true, authenticated: true, status: 200, reason: 'ok' },
    { attempted: true, authenticated: false, status: 401, reason: 'rejected' }
  ];
  for (const auth of postures) {
    const md = buildMarkdownReport(
      [{ scenario: 'bug-20260629-153258', bugId: 'BUG-20260629-153258', verdict: 'PASS', exitCode: 0, auth }],
      {}
    );
    assert.ok(!md.includes(FAKE_CODE), 'no credential in the report');
    assert.ok(!md.includes(TOKEN), 'no session token in the report');
    assert.match(md, /x-atlas-request-origin: playwright/, 'report states the synthetic marking');
  }
});

test('the report states the unauthenticated posture keeps INCONCLUSIVE semantics', () => {
  const md = buildMarkdownReport(
    [{ scenario: 'bug-20260629-153258', bugId: 'B', verdict: 'INCONCLUSIVE', exitCode: 0, auth: { attempted: false, authenticated: false } }],
    {}
  );
  assert.match(md, new RegExp(ACCESS_CODE_ENV));
  assert.match(md, /INCONCLUSIVE, never/);
});

test('the report names a failed authentication as a stop, not a silent downgrade', () => {
  const md = buildMarkdownReport(
    [{ scenario: 'bug-20260629-153258', bugId: 'B', verdict: 'ERROR', exitCode: 1, auth: { attempted: true, authenticated: false, status: 401, reason: 'rejected' } }],
    {}
  );
  assert.match(md, /authentication FAILED — the run stopped/);
});

// ── The INCONCLUSIVE hint must never contradict the run's real auth posture ──
// Regression guard for the first authenticated production run (2026-07-30): the
// hint was hardcoded to "likely an unauthenticated run", so an authed run was
// told to retest in an authed context — advice the owner had already followed.

const os = require('node:os');
const fsx = require('node:fs');
const pathx = require('node:path');
const { assertScenario } = require('../scripts/live-retest');

const HINT_TMP = pathx.join(os.tmpdir(), 'atlas-live-retest-auth-hint');
fsx.mkdirSync(HINT_TMP, { recursive: true });

// Force INCONCLUSIVE: no forbidden hit, one expected pattern that cannot match.
const INCONCLUSIVE_SCENARIO = { bugId: 'HINT', assertion: { forbidden: [/never-present/i], expected: [/will-not-match/i] } };

function hintFor(auth) {
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const verdict = assertScenario({
      scenarioKey: 'hint', scenario: INCONCLUSIVE_SCENARIO,
      navResult: { navigated: true, threadText: 'you missed a set Thinking…' },
      outputDir: HINT_TMP, auth
    });
    assert.equal(verdict, 'INCONCLUSIVE', 'fixture must produce INCONCLUSIVE');
  } finally {
    console.log = realLog;
  }
  return lines.join('\n');
}

test('an AUTHENTICATED inconclusive run is not told to retest in an authed context', () => {
  const out = hintFor({ attempted: true, authenticated: true, status: 200, reason: 'ok' });
  assert.ok(!/retest in an authed context/.test(out), 'must not repeat advice already followed');
  assert.match(out, /WAS authenticated/);
  assert.match(out, /not a credential problem/);
});

test('an UNAUTHENTICATED inconclusive run keeps the original hint', () => {
  const out = hintFor({ attempted: false, authenticated: false, status: null, reason: 'no_credential' });
  assert.match(out, /likely an unauthenticated run/);
  assert.match(out, /retest in an authed context/);
});

test('omitting auth entirely preserves the pre-existing hint (back-compat)', () => {
  const out = hintFor(undefined);
  assert.match(out, /likely an unauthenticated run/);
});

test('a rejected-credential run is not described as authenticated', () => {
  const out = hintFor({ attempted: true, authenticated: false, status: 401, reason: 'rejected' });
  assert.ok(!/WAS authenticated/.test(out));
});

test.after(() => { try { fsx.rmSync(HINT_TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// ── Cookie parsing ──────────────────────────────────────────────────────────

test('parseSessionCookie reads the real Set-Cookie shape from services/session.js', () => {
  const c = parseSessionCookie(SET_COOKIE, { url: 'https://example.test', now: 1_000_000_000_000 });
  assert.equal(c.name, SESSION_COOKIE_NAME);
  assert.equal(c.value, TOKEN);
  assert.equal(c.url, 'https://example.test');
  assert.equal(c.httpOnly, true);
  assert.equal(c.secure, true);
  assert.equal(c.sameSite, 'Lax');
  assert.equal(c.expires, 1_000_000_000 + 2592000);
});

test('parseSessionCookie omits Secure for a plain-http deployment and skips expires without Max-Age', () => {
  const c = parseSessionCookie(`${SESSION_COOKIE_NAME}=${TOKEN}; Path=/; HttpOnly; SameSite=Lax`, { url: 'http://127.0.0.1:3000' });
  assert.equal(c.secure, false);
  assert.equal(c.expires, undefined);
});

test('parseSessionCookie returns null when the session cookie is absent', () => {
  assert.equal(parseSessionCookie('other=1; Path=/', { url: 'https://example.test' }), null);
  assert.equal(parseSessionCookie('', { url: 'https://example.test' }), null);
  assert.equal(parseSessionCookie(null, { url: 'https://example.test' }), null);
});

test('parseSessionCookie picks the session cookie out of a multi-cookie header', () => {
  const c = parseSessionCookie(`csrf=xyz; Path=/, ${SESSION_COOKIE_NAME}=${TOKEN}; Path=/; HttpOnly`, { url: 'https://example.test' });
  assert.equal(c.value, TOKEN);
});
