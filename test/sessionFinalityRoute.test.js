'use strict';

// #1692 D1 — GET /api/session/finality, the resume path's server check.
// Read-only: answers whether Session_Plans holds the session as `finalized`
// (services/closeoutFinality.js, the same reader the undo guard uses).
// `unknown` fails closed with 503; a missing session_id is a 400. The
// finality reader is stubbed (require.cache) so these tests exercise the HTTP
// surface deterministically without Sheets. (Auth is global app-level
// middleware in index.js, not in this router.)

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const fakeFinality = {
  isSessionFinalized: async (sid) => {
    if (sid === 'sess-final-1') return { finalized: true };
    if (sid === 'sess-unknown-1') return { unknown: true };
    return { finalized: false };
  },
};
const finalityPath = require.resolve('../services/closeoutFinality');
require.cache[finalityPath] = { id: finalityPath, filename: finalityPath, loaded: true, exports: fakeFinality };

const fakeCapture = {
  isEnabled: () => true,
  validateHeader: async () => ({ ok: true }),
  captureAccept: async () => ({ status: 'written' }),
  captureOutcome: async () => ({ status: 'written' }),
  captureCloseout: async () => ({ status: 'written' }),
};
const capturePath = require.resolve('../services/sessionPlanCapture');
require.cache[capturePath] = { id: capturePath, filename: capturePath, loaded: true, exports: fakeCapture };

const registerSessionPlanRoutes = require('../routes/sessionPlans');

let baseUrl, server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(registerSessionPlanRoutes());
  await new Promise(resolve => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.after(() => { if (server) server.close(); });

async function get(path) {
  const r = await fetch(`${baseUrl}${path}`);
  return { status: r.status, body: await r.json() };
}

test('finality: a finalized session answers finalized:true', async () => {
  const { status, body } = await get('/api/session/finality?session_id=sess-final-1');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.session_id, 'sess-final-1');
  assert.equal(body.data.finalized, true);
});

test('finality: an open session answers finalized:false', async () => {
  const { status, body } = await get('/api/session/finality?session_id=sess-open-1');
  assert.equal(status, 200);
  assert.equal(body.data.finalized, false);
});

test('finality: unknown fails closed with 503, never a guessed false', async () => {
  const { status, body } = await get('/api/session/finality?session_id=sess-unknown-1');
  assert.equal(status, 503);
  assert.equal(body.details.error_code, 'session_finality_check_unavailable');
});

test('finality: a missing session_id is a 400', async () => {
  const { status } = await get('/api/session/finality');
  assert.equal(status, 400);
  assert.equal((await get('/api/session/finality?session_id=%20')).status, 400);
});
