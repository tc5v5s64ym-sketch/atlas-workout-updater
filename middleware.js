const crypto = require('crypto');

function createRequestContext(req, res, next) {
  const requestId = crypto.randomUUID().slice(0, 8);
  req.requestId = requestId;
  res.locals.requestId = requestId;
  req.requestStartMs = Date.now();
  next();
}

function requireApiKey(atlasApiKey, { publicPaths = [] } = {}) {
  const allow = new Set(publicPaths);
  return function apiKeyMiddleware(req, res, next) {
    if (allow.has(req.path)) return next();
    const incomingApiKey = req.header('x-atlas-api-key');
    if (!timingSafeStringEqual(incomingApiKey, atlasApiKey)) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized', requestId: req.requestId });
    }
    return next();
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

  return function rateLimitMiddleware(req, res, next) {
    if (req.method === 'OPTIONS') return next();

    const key = `${name}:${keyGenerator(req)}`;
    const currentTime = now();

    // Prune expired entries so the Map never grows without bound.
    // Safe to delete during for-of iteration in Node's single-threaded model.
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
  };
}

module.exports = {
  createCorsMiddleware,
  createRateLimiter,
  createRequestContext,
  parseAllowedOrigins,
  requireApiKey,
  timingSafeStringEqual
};
