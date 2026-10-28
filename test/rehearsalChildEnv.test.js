'use strict';

// F-SB4B child-env bites (TEMPORARY; sunset: F-SB4C). Proves the network
// passthrough list in tests/e2e/gate/rehearsal-child-env.js carries exactly
// the plumbing it claims — most importantly NODE_USE_ENV_PROXY: on Node 24
// the global fetch (undici) that services/coach.js uses ignores the proxy
// variables unless that switch is set, so without it a proxy-only-egress
// environment fails the gate server's model-up probe ("fetch failed") and
// the rehearsal refuses to start even though the provider is reachable
// through the proxy. A list that silently dropped the switch would refuse
// every rehearsal in such an environment while claiming network plumbing
// crosses the boundary.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  NETWORK_PASSTHROUGH, pickNetworkPassthrough, assertNoWorkbookId,
} = require('../tests/e2e/gate/rehearsal-child-env');

describe('NETWORK_PASSTHROUGH — the declared plumbing list', () => {
  it('is exactly the proxy-routing, env-proxy switch, and CA-trust names', () => {
    assert.deepEqual([...NETWORK_PASSTHROUGH], [
      'HTTPS_PROXY', 'https_proxy',
      'HTTP_PROXY', 'http_proxy',
      'NO_PROXY', 'no_proxy',
      'NODE_USE_ENV_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'NIX_SSL_CERT_FILE',
    ]);
  });
});

describe('pickNetworkPassthrough — NODE_USE_ENV_PROXY crossing', () => {
  it('carries the switch when the parent env sets it', () => {
    const picked = pickNetworkPassthrough({
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://proxy.example:8080',
    });
    assert.equal(picked.NODE_USE_ENV_PROXY, '1');
    assert.equal(picked.HTTPS_PROXY, 'http://proxy.example:8080');
  });

  it('omits the switch when the parent env does not set it', () => {
    const picked = pickNetworkPassthrough({ HTTPS_PROXY: 'http://proxy.example:8080' });
    assert.equal(Object.prototype.hasOwnProperty.call(picked, 'NODE_USE_ENV_PROXY'), false);
  });

  it('omits the switch when it is set to an empty string, like every other name', () => {
    const picked = pickNetworkPassthrough({ NODE_USE_ENV_PROXY: '' });
    assert.deepEqual(picked, {});
  });

  it('never sweeps in names outside the list — workbook ids and credentials stay behind', () => {
    const picked = pickNetworkPassthrough({
      GOOGLE_SHEETS_ID: 'some-workbook',
      GEMINI_API_KEY: 'some-key',
      NODE_USE_ENV_PROXY: '1',
    });
    assert.deepEqual(picked, { NODE_USE_ENV_PROXY: '1' });
  });
});

describe('assertNoWorkbookId — unchanged fail-closed claim', () => {
  it('refuses a child env carrying a workbook id', () => {
    assert.throws(() => assertNoWorkbookId({ GOOGLE_SHEETS_ID: 'x' }), /GOOGLE_SHEETS_ID/);
  });

  it('accepts a child env carrying only the picked plumbing', () => {
    assert.doesNotThrow(() => assertNoWorkbookId(pickNetworkPassthrough({ NODE_USE_ENV_PROXY: '1' })));
  });
});
