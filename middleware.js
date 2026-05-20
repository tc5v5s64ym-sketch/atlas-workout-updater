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
    if (!incomingApiKey || incomingApiKey !== atlasApiKey) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized', requestId: req.requestId });
    }
    return next();
  };
}

module.exports = { createRequestContext, requireApiKey };
