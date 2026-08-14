const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createCorsMiddleware,
  createRateLimiter,
  parseAllowedOrigins,
  requireApiKey,
  timingSafeStringEqual
} = require('../middleware');

const repoRoot = path.resolve(__dirname, '..');

function mockReq({ headers = {}, method = 'GET', ip = '127.0.0.1', path = '/api/test' } = {}) {
  return {
    method,
    path,
    ip,
    socket: { remoteAddress: ip },
    requestId: 'req-test',
    header(name) {
      return headers[String(name).toLowerCase()];
    }
  };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
}

test('security: API key middleware uses exact secret matching', () => {
  assert.equal(timingSafeStringEqual('secret-key', 'secret-key'), true);
  assert.equal(timingSafeStringEqual('secret-key', 'wrong-key'), false);
  assert.equal(timingSafeStringEqual('', 'secret-key'), false);

  const middleware = requireApiKey('secret-key');
  const acceptedReq = mockReq({ headers: { 'x-atlas-api-key': 'secret-key' } });
  const acceptedRes = mockRes();
  let nextCalled = false;
  middleware(acceptedReq, acceptedRes, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(acceptedRes.ended, false);

  const rejectedReq = mockReq({ headers: { 'x-atlas-api-key': 'wrong-key' } });
  const rejectedRes = mockRes();
  middleware(rejectedReq, rejectedRes, () => { throw new Error('next should not be called'); });
  assert.equal(rejectedRes.statusCode, 401);
  assert.deepEqual(rejectedRes.body, { status: 'error', message: 'Unauthorized', requestId: 'req-test' });
});

test('security: CORS defaults to allow-list behavior instead of wildcard', () => {
  assert.deepEqual(parseAllowedOrigins('https://a.example, https://b.example'), ['https://a.example', 'https://b.example']);

  const middleware = createCorsMiddleware({ allowedOrigins: 'https://atlas.example' });
  const allowedReq = mockReq({ headers: { origin: 'https://atlas.example' } });
  const allowedRes = mockRes();
  let allowedNext = false;
  middleware(allowedReq, allowedRes, () => { allowedNext = true; });
  assert.equal(allowedNext, true);
  assert.equal(allowedRes.headers['access-control-allow-origin'], 'https://atlas.example');
  assert.equal(allowedRes.headers.vary, 'Origin');
  // #1165 — x-atlas-turn-id is NOT a CORS-safelisted response header, so without an explicit
  // expose-headers the browser hides it from a cross-origin frontend: the coach request would
  // succeed while the client silently read null and correlation simply never happened. That
  // failure is invisible without this assertion.
  //
  // #1173 item 1 — x-atlas-turn-pairing carries the preview-established pairing token and has
  // the identical exposure requirement: hidden, every live write fails closed to `unpaired`.
  // Both are opaque ids and carry no data, so exposing them leaks nothing.
  assert.equal(allowedRes.headers['access-control-expose-headers'], 'x-atlas-turn-id, x-atlas-turn-pairing');

  const blockedReq = mockReq({ method: 'OPTIONS', headers: { origin: 'https://unknown.example' } });
  const blockedRes = mockRes();
  middleware(blockedReq, blockedRes, () => { throw new Error('next should not be called'); });
  assert.equal(blockedRes.statusCode, 403);
  assert.equal(blockedRes.body.message, 'CORS origin not allowed');
});

test('security: rate limiter blocks requests over the configured window', () => {
  let currentTime = 1000;
  const middleware = createRateLimiter({
    name: 'test',
    max: 2,
    windowMs: 1000,
    now: () => currentTime,
    keyGenerator: req => req.ip
  });

  for (let i = 0; i < 2; i += 1) {
    const res = mockRes();
    let nextCalled = false;
    middleware(mockReq({ ip: '10.0.0.1' }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  }

  const blockedRes = mockRes();
  middleware(mockReq({ ip: '10.0.0.1' }), blockedRes, () => { throw new Error('next should not be called'); });
  assert.equal(blockedRes.statusCode, 429);
  assert.equal(blockedRes.body.message, 'Too many requests');
  assert.equal(blockedRes.headers['x-ratelimit-limit'], '2');

  currentTime = 2100;
  const resetRes = mockRes();
  let resetNext = false;
  middleware(mockReq({ ip: '10.0.0.1' }), resetRes, () => { resetNext = true; });
  assert.equal(resetNext, true);
  assert.equal(resetRes.statusCode, 200);
});

test('security: rate limiter prunes expired windows so the hits map stays bounded (ME-6)', () => {
  let currentTime = 1000;
  const middleware = createRateLimiter({
    name: 'prune',
    max: 5,
    windowMs: 1000,
    now: () => currentTime,
    keyGenerator: req => req.ip
  });

  // Three distinct clients hit within window 1 → three tracked windows.
  for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
    middleware(mockReq({ ip }), mockRes(), () => {});
  }
  assert.equal(middleware.trackedKeyCount(), 3, 'three distinct clients are tracked in-window');

  // Advance past the window; a single request from a NEW client must prune all three
  // expired entries before adding its own — the map cannot grow unbounded.
  currentTime = 2500;
  middleware(mockReq({ ip: '10.0.0.9' }), mockRes(), () => {});
  assert.equal(middleware.trackedKeyCount(), 1, 'expired windows pruned; only the live client remains');

  // And pruning is behaviour-preserving: a returning client past its window still gets
  // a fresh allowance (not a stale blocked count).
  let next = false;
  const res = mockRes();
  middleware(mockReq({ ip: '10.0.0.1' }), res, () => { next = true; });
  assert.equal(next, true);
  assert.equal(res.statusCode, 200, 'a returning client after expiry gets a fresh window');
});

test('security: live write logging redacts workout and effort row contents', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  const logLines = source.split(/\r?\n/).filter(line => line.includes('console.log'));
  assert.ok(!logLines.some(line => line.includes('formattedLogRows')));
  assert.ok(!logLines.some(line => line.includes('formattedEffortRow')));
  // ONE EVENT, because there is one write. The Save used to log `append_log_rows`
  // and `append_effort_row` separately because it issued two Google Sheets appends
  // that could half-succeed; the S4 cutover makes it one Supabase transaction, so
  // there is one `workout_saved` line carrying both counts. What this test actually
  // guards is unchanged: the log names WHAT happened and HOW MANY rows, never the
  // athlete's loads, reps or notes.
  assert.match(source, /event: 'workout_saved'/);
  assert.ok(!logLines.some(line => line.includes('rowsToWrite')), 'no row payload in a log line');
});
