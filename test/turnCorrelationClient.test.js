'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const CLIENT_PATH = path.join(ROOT, 'src', 'app', 'turnCorrelation.js');

async function loadClient() {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}-${Math.random()}`);
}

const TURN_A = 'turn:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TURN_B = 'turn:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_A = `pair:${'a'.repeat(32)}`;
const TOKEN_B = `pair:${'b'.repeat(32)}`;
const SESSION_A = '20260725-PM-01';
const SESSION_B = '20260725-PM-02';

function deterministicIds() {
  let n = 0;
  return () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function headers(turnId, pairingToken) {
  return {
    get(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-atlas-turn-id') return turnId;
      if (key === 'x-atlas-turn-pairing') return pairingToken;
      return null;
    },
  };
}

for (const completionOrder of ['B-then-A', 'A-then-B']) {
  test(`client correlation: A then B initiation retains only B when responses complete ${completionOrder}`, async () => {
    const { createTurnCorrelation } = await loadClient();
    const protocol = createTurnCorrelation({ randomUUID: deterministicIds() });
    assert.equal(protocol.captureTurn({ sessionId: SESSION_A, turnId: TURN_A }), true);

    const previewA = protocol.beginPreview({ sessionId: SESSION_A });
    const previewB = protocol.beginPreview({ sessionId: SESSION_A });

    assert.match(previewA.initiation_nonce, /^init:[0-9a-f-]{36}$/);
    assert.match(previewB.initiation_nonce, /^init:[0-9a-f-]{36}$/);
    assert.deepEqual(previewB.correlation.retire_initiation_nonces, [previewA.initiation_nonce],
      'B must explicitly retire A at initiation, before either response can win');

    if (completionOrder === 'B-then-A') {
      assert.equal(protocol.completePreview(previewB, headers(TURN_A, TOKEN_B)), true);
      assert.equal(protocol.completePreview(previewA, headers(TURN_A, TOKEN_A)), false,
        'a late A response must not overwrite B');
    } else {
      assert.equal(protocol.completePreview(previewA, headers(TURN_A, TOKEN_A)), false,
        'A is already superseded as soon as B is initiated');
      assert.equal(protocol.completePreview(previewB, headers(TURN_A, TOKEN_B)), true);
    }

    assert.equal(protocol.approvalClaim(previewA), null, 'A can never produce an approval claim');
    assert.deepEqual(protocol.approvalClaim(previewB), {
      turn_id: TURN_A,
      initiation_nonce: previewB.initiation_nonce,
      pairing_token: TOKEN_B,
    });
  });
}

test('client correlation: a newer coach turn and another session cannot contaminate a pending preview', async () => {
  const { createTurnCorrelation } = await loadClient();
  const protocol = createTurnCorrelation({ randomUUID: deterministicIds() });
  protocol.captureTurn({ sessionId: SESSION_A, turnId: TURN_A });
  protocol.captureTurn({ sessionId: SESSION_B, turnId: TURN_B });

  const a = protocol.beginPreview({ sessionId: SESSION_A });
  const b = protocol.beginPreview({ sessionId: SESSION_B });

  assert.equal(protocol.completePreview(a, headers(TURN_B, TOKEN_A)), false,
    'a response naming another session turn must fail closed');
  assert.equal(protocol.completePreview(b, headers(TURN_B, TOKEN_B)), true);
  assert.equal(protocol.approvalClaim(a), null);
  assert.equal(protocol.approvalClaim(b).turn_id, TURN_B);
});

test('client correlation: malformed, missing, stale, and forged response claims never become approval claims', async () => {
  const { createTurnCorrelation } = await loadClient();
  const protocol = createTurnCorrelation({ randomUUID: deterministicIds() });
  protocol.captureTurn({ sessionId: SESSION_A, turnId: TURN_A });

  const cases = [
    headers(null, TOKEN_A),
    headers(TURN_A, null),
    headers('not-a-turn', TOKEN_A),
    headers(TURN_A, 'not-a-token'),
    headers(TURN_B, TOKEN_A),
  ];
  for (const responseHeaders of cases) {
    const preview = protocol.beginPreview({ sessionId: SESSION_A });
    assert.equal(protocol.completePreview(preview, responseHeaders), false);
    assert.equal(protocol.approvalClaim(preview), null);
  }

  const stale = protocol.beginPreview({ sessionId: SESSION_A });
  const newest = protocol.beginPreview({ sessionId: SESSION_A });
  assert.equal(protocol.completePreview(stale, headers(TURN_A, TOKEN_A)), false);
  assert.equal(protocol.completePreview(newest, headers(TURN_A, TOKEN_B)), true);

  // A token from another initiation is a forged association even when both token shapes are valid.
  assert.equal(protocol.approvalClaim(stale), null);
  assert.equal(protocol.approvalClaim(newest).pairing_token, TOKEN_B);
});

test('client correlation: state and retirement diagnostics never expose pairing capabilities', async () => {
  const { createTurnCorrelation } = await loadClient();
  const protocol = createTurnCorrelation({ randomUUID: deterministicIds() });
  protocol.captureTurn({ sessionId: SESSION_A, turnId: TURN_A });
  const a = protocol.beginPreview({ sessionId: SESSION_A });
  protocol.completePreview(a, headers(TURN_A, TOKEN_A));
  const b = protocol.beginPreview({ sessionId: SESSION_A });

  const diagnostic = protocol.diagnosticSnapshot();
  const serialized = JSON.stringify(diagnostic);
  assert.ok(!serialized.includes(TOKEN_A), 'diagnostics must not expose the pairing token');
  assert.ok(!serialized.includes('fingerprint'), 'diagnostics must not expose payload fingerprints');
  assert.deepEqual(b.correlation.retire_initiation_nonces, [a.initiation_nonce]);
});

test('client correlation: seal retry reuses the preview claim while write_id may change and effort_row may be removed', async () => {
  const { createTurnCorrelation } = await loadClient();
  const protocol = createTurnCorrelation({ randomUUID: deterministicIds() });
  protocol.captureTurn({ sessionId: SESSION_A, turnId: TURN_A });
  const preview = protocol.beginPreview({ sessionId: SESSION_A });
  protocol.completePreview(preview, headers(TURN_A, TOKEN_A));

  const first = {
    session_id: SESSION_A,
    write_id: 'write-1',
    effort_row: { session_id: SESSION_A, duration: 60 },
    correlation: protocol.approvalClaim(preview),
  };
  const retry = {
    ...first,
    write_id: 'write-2',
    correlation: protocol.approvalClaim(preview),
  };
  delete retry.effort_row;

  assert.deepEqual(retry.correlation, first.correlation,
    'the documented seal retry remains the same approved preview even though its write_id is re-minted');
  assert.equal(retry.write_id, 'write-2');
  assert.equal('effort_row' in retry, false);
});

test('client correlation: the production app wires the protocol through every real preview/approve route', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app', 'app.js'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'src', 'app', 'api.js'), 'utf8');
  const coach = fs.readFileSync(path.join(ROOT, 'src', 'app', 'coach-conversation.js'), 'utf8');

  assert.match(app, /from '\.\/turnCorrelation\.js'/);
  assert.match(api, /responseHeaders/, 'api() must expose response headers without putting them in response bodies');
  assert.match(coach, /captureTurnResponse/, 'the real coach round-trip must retain the canonical server turn id');

  for (const route of ['/api/log-workout', '/api/complete-workout', '/api/log-modality', '/api/bodyweight']) {
    const routeUses = [...app.matchAll(new RegExp(route.replaceAll('/', '\\/'), 'g'))].length;
    assert.ok(routeUses >= 2, `${route} must still have a real preview and approval path`);
  }

  assert.match(app, /beginCorrelatedPreview/, 'real previews must initiate correlation before the request');
  assert.match(app, /completeCorrelatedPreview/, 'real response headers must complete the same initiation');
  assert.match(app, /approvalCorrelation/, 'real approvals must attach only their staged preview claim');
  assert.match(app, /form\.append\('correlation'/, 'multipart screenshot/effort paths must carry the additive envelope');
});

