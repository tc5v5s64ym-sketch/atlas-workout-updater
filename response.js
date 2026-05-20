function buildBase(req, status, message) {
  const base = { status, message, requestId: req.requestId };
  const start = req.requestStartMs || Date.now();
  base.duration_ms = Date.now() - start;
  return base;
}

function success(req, res, message, data = undefined, statusCode = 200) {
  const payload = buildBase(req, 'ok', message);
  if (data !== undefined) payload.data = data;
  return res.status(statusCode).json(payload);
}

function error(req, res, message, details = undefined, statusCode = 400) {
  const payload = buildBase(req, 'error', message);
  if (details !== undefined && details !== null) payload.details = details;
  return res.status(statusCode).json(payload);
}

module.exports = { success, error };
