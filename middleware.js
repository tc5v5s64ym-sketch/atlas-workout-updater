const crypto = require('crypto');

function createRequestContext(req, res, next) {
  const requestId = crypto.randomUUID().slice(0, 8);
  req.requestId = requestId;
  res.locals.requestId = requestId;
  req.requestStartMs = Date.now();
  next();
}

// Auth accepts EITHER of two credentials, checked in this order — the addition of
// the cookie path never weakens the gate; an unauthenticated request still fails
// closed with 401:
//   1. x-atlas-api-key header (timing-safe) — the machine/script path and the
//      bounded legacy path browsers used before durable sessions.
//   2. A signed, unexpired `atlas_session` cookie (F04C) — the browser path, only
//      when ATLAS_SESSION_SECRET is set. For state-changing (non-GET) requests a
//      same-origin Origin is additionally required (CSRF defense atop SameSite).
function requireApiKey(atlasApiKey, { publicPaths = [], session = require('./services/session') } = {}) {
  const allow = new Set(publicPaths);
  return function apiKeyMiddleware(req, res, next) {
    // Match publicPaths against BOTH the mount-relative path (req.path is stripped
    // of the '/api' mount prefix inside app.use('/api', …)) and the full original
    // URL, so a caller can list either '/api/session/login' or '/session/login'.
    const fullPath = (req.originalUrl || req.url || '').split('?')[0];
    if (allow.has(req.path) || allow.has(fullPath)) return next();

    const incomingApiKey = req.header('x-atlas-api-key');
    if (incomingApiKey && timingSafeStringEqual(incomingApiKey, atlasApiKey)) {
      req.authMethod = 'api_key';
      return next();
    }

    const secret = session.sessionSecret();
    if (secret) {
      const cookies = session.parseCookies(req.header('cookie'));
      const payload = session.verifySession(cookies[session.COOKIE_NAME], secret, Date.now());
      if (payload) {
        const method = String(req.method || '').toUpperCase();
        const stateChanging = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
        if (stateChanging && !session.isAllowedOrigin(req.header('origin'), req)) {
          return res.status(403).json({ status: 'error', message: 'Cross-origin request refused', requestId: req.requestId });
        }
        req.authMethod = 'session';
        req.session = payload;
        // Honest rotation: extend an actively-used session so the owner is not
        // forced to re-authenticate on the hard expiry boundary.
        if (session.shouldRenew(payload, Date.now())) {
          const rotated = session.issueToken(secret);
          res.setHeader('Set-Cookie', session.buildSetCookie(rotated.token, {
            maxAgeMs: rotated.maxAgeMs,
            secure: session.isSecureRequest(req)
          }));
        }
        return next();
      }
    }

    return res.status(401).json({ status: 'error', message: 'Unauthorized', requestId: req.requestId });
  };
}

function timingSafeStringEqual(candidate, expected) {
  if (!candidate || !expected) return false;
  const candidateHash = crypto.createHash('sha256').update(String(candidate)).digest();
  const expectedHash = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

function parseAllowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function createCorsMiddleware({ allowedOrigins = process.env.CORS_ORIGIN || '' } = {}) {
  const allowed = new Set(parseAllowedOrigins(allowedOrigins));
  const allowAny = allowed.has('*');
  return function corsMiddleware(req, res, next) {
    const origin = req.header('origin');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-atlas-api-key');
    // #1165 — x-atlas-turn-id is not a CORS-safelisted response header, so a cross-origin
    // frontend (the existing CORS_ORIGIN support) would have the browser hide it: the coach
    // request would succeed while the client silently read null, and correlation would just
    // never happen. Exposing it costs nothing — it carries an opaque turn id, no data.
    // #1173 item 1 — x-atlas-turn-pairing carries the preview-established pairing token and
    // has the identical exposure requirement: unexposed, the browser hides it, the client reads
    // null, and every live write would fail closed to `unpaired`. Both are opaque ids, no data.
    res.setHeader('Access-Control-Expose-Headers', 'x-atlas-turn-id, x-atlas-turn-pairing');

    if (origin && (allowAny || allowed.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowAny ? '*' : origin);
    }

    if (req.method === 'OPTIONS') {
      if (origin && !allowAny && !allowed.has(origin)) {
        return res.status(403).json({ status: 'error', message: 'CORS origin not allowed', requestId: req.requestId });
      }
      return res.status(204).end();
    }

    return next();
  };
}

function createRateLimiter({
  windowMs = 60 * 1000,
  max = 300,
  name = 'default',
  keyGenerator = req => req.ip || req.socket?.remoteAddress || 'unknown',
  now = () => Date.now()
} = {}) {
  const hits = new Map();

  function rateLimitMiddleware(req, res, next) {
    if (req.method === 'OPTIONS') return next();

    const key = `${name}:${keyGenerator(req)}`;
    const currentTime = now();

    // Prune expired windows so `hits` cannot grow unbounded — without this, one entry
    // per distinct `name:ip` lives forever. An expired entry is already treated as a
    // fresh window on next access (the record reset below), so deleting it changes no
    // rate-limit behaviour; it only frees memory. Deleting visited keys mid-iteration
    // is safe for a Map.
    for (const [k, v] of hits) {
      if (v.resetAt <= currentTime) hits.delete(k);
    }

    const existing = hits.get(key);
    const record = existing && existing.resetAt > currentTime
      ? existing
      : { count: 0, resetAt: currentTime + windowMs };

    record.count += 1;
    hits.set(key, record);

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - record.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(record.resetAt / 1000)));

    if (record.count > max) {
      const retryAfterMs = Math.max(0, record.resetAt - currentTime);
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({
        status: 'error',
        message: 'Too many requests',
        requestId: req.requestId,
        retry_after_ms: retryAfterMs
      });
    }

    return next();
  }

  // Read-only introspection for tests/diagnostics: how many windows are currently
  // tracked (after pruning). Never consulted by request handling.
  rateLimitMiddleware.trackedKeyCount = () => hits.size;

  return rateLimitMiddleware;
}

module.exports = {
  createCorsMiddleware,
  createRateLimiter,
  createRequestContext,
  parseAllowedOrigins,
  requireApiKey,
  timingSafeStringEqual
};
