const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 3107);

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function safePublicPath(urlPath) {
  const relative = urlPath.replace(/^\/app\/?/, '') || 'index.html';
  const resolved = path.resolve(publicDir, relative);
  if (!resolved.startsWith(publicDir)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') {
    return send(res, 200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8');
  }
  if (url.pathname.startsWith('/api/')) {
    return send(res, 501, JSON.stringify({ error: 'API calls must be mocked by Playwright tests.' }), 'application/json; charset=utf-8');
  }
  if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
    const filePath = safePublicPath(url.pathname);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return send(res, 404, 'Not found');
    }
    return send(res, 200, fs.readFileSync(filePath), types[path.extname(filePath)] || 'application/octet-stream');
  }
  return send(res, 302, '', 'text/plain; charset=utf-8');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Atlas test app server listening on http://127.0.0.1:${port}/app/\n`);
});
