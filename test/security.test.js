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

test('security: live write logging redacts workout and effort row contents', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  const logLines = source.split(/\r?\n/).filter(line => line.includes('console.log'));
  assert.ok(!logLines.some(line => line.includes('formattedLogRows')));
  assert.ok(!logLines.some(line => line.includes('formattedEffortRow')));
  assert.match(source, /event: 'append_log_rows'/);
  assert.match(source, /event: 'append_effort_row'/);
});
