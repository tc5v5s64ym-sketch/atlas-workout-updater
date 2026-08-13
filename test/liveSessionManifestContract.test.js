'use strict';

// THE RECONSTRUCTED BODY IS A SECOND AUTHORITY — this is what keeps it honest.
//
// `test/fixtures/liveSessionManifest.json` records methods, paths, query strings and timing,
// never bodies: a captured body would carry the athlete's own words and workout data. That
// privacy choice has a cost the exact-head review caught. The harness reconstructs each POST
// body, and a reconstructed body that does not match what the client sends measures the
// wrong branch of the route — silently, because most routes answer 200 either way.
//
// It really happened: `/api/suggest-substitute` was reconstructed as `{ exercise, reason }`,
// field names the route does not read. `current_exercise` was therefore undefined, the route
// returned "No recommendation" immediately, and the session was budgeted against a request
// that never read history. The manifest alone could not show it.
//
// So the acceptance authority is the manifest PLUS these branch-defining inputs, and this
// file is the join between them: every key the harness sends must be a key its named client
// producer actually sends, checked against the client's own source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CLIENT_BODY_PRODUCERS, bodyFor, MANIFEST } = require('./helpers/liveSessionHarness');

const repoRoot = path.join(__dirname, '..');
const CLIENT_SOURCES = ['src/app/app.js', 'src/app/coach-conversation.js', 'src/app/nav.js']
  .map(rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8'))
  .join('\n');

/** Every POST path the captured session contains. */
function postPathsInManifest() {
  return [...new Set(MANIFEST.requests.filter(r => r.method === 'POST').map(r => r.path))].sort();
}

test('every POST the session makes has a declared client producer', () => {
  const declared = Object.keys(CLIENT_BODY_PRODUCERS).sort();
  assert.deepEqual(postPathsInManifest(), declared,
    'a POST in the captured manifest has no declared producer, or a producer is declared ' +
    'for a request the session never made. The reconstruction must cover exactly the ' +
    'session, no more and no less.');
});

test('the harness sends only keys its client producer sends', () => {
  for (const [route, producer] of Object.entries(CLIENT_BODY_PRODUCERS)) {
    const clientKeys = producer.keys;
    // Occurrence 0 and the last occurrence, so a route whose body legitimately changes
    // across the session (the Saves: previews then the closeout) is covered on both shapes.
    const occurrences = MANIFEST.requests.filter(r => r.path === route).length;
    for (const index of new Set([0, Math.max(0, occurrences - 1)])) {
      const body = bodyFor(route, index, 'contract');
      if (body === undefined) continue;
      for (const key of Object.keys(body)) {
        assert.ok(clientKeys.includes(key),
          `${route} occurrence ${index}: the harness sends "${key}", which is not a key the ` +
          `client producer sends (${clientKeys.join(', ')}). Either the client changed and ` +
          'this table must follow it, or the reconstruction invented a field.');
      }
    }
  }
});

// The declared key list is itself a claim about the client. This checks it against the
// client's own source: every declared key must appear near that route's `api(...)` call.
// Deliberately a TEXT check — it cannot execute the browser bundle, and a key that the
// client stopped sending will stop appearing beside its call.
test('each declared producer key really appears in the client source for that route', () => {
  for (const [route, producer] of Object.entries(CLIENT_BODY_PRODUCERS)) {
    const callIndex = CLIENT_SOURCES.indexOf(`'${route}'`);
    assert.ok(callIndex !== -1,
      `no client call to ${route} found in the searched sources — the producer table names ` +
      'a route the client no longer calls, or it moved to a file not searched here');
    // An ASSEMBLED body is a variable at the call site, so its fields are not there to
    // find. Those routes are verified by the branch-outcome assertion instead; checking
    // for their field names here would pass on a coincidence and prove nothing.
    if (producer.shape !== 'inline') continue;
    // A generous window: the call, its options object and the body literal.
    const window = CLIENT_SOURCES.slice(callIndex, callIndex + 1400);
    for (const key of producer.keys) {
      assert.ok(window.includes(key),
        `${route} declares client key "${key}", but it does not appear beside the client's ` +
        'own call. The declaration is not evidence unless the client really sends it.');
    }
  }
});

test('every producer declares how its body is built, and assembled ones are covered elsewhere', () => {
  // This used to read `test/liveSessionReadBudget.test.js` by name. S4 deleted that
  // suite with the rest of the read-budget authority (design §5.4), so a single
  // named file is no longer the right question to ask — and hard-coding a deleted
  // path would have made this guard fail for a reason unrelated to what it proves.
  //
  // It now asks the question it always meant: does ANY surviving suite pin this
  // route's outcome? If none does, the route's assembled body is genuinely
  // unverified and this fails, which is the guarantee. A suite may move without
  // silently dropping the coverage it carried.
  const suites = fs.readdirSync(path.join(repoRoot, 'test'))
    .filter((file) => file.endsWith('.test.js') && file !== 'liveSessionManifestContract.test.js')
    .map((file) => fs.readFileSync(path.join(repoRoot, 'test', file), 'utf8'));

  for (const [route, producer] of Object.entries(CLIENT_BODY_PRODUCERS)) {
    assert.ok(['inline', 'assembled'].includes(producer.shape),
      `${route} must declare shape 'inline' or 'assembled'`);
    if (producer.shape !== 'assembled') continue;
    const covered = suites.some((text) => text.includes(`'${route}':`) || text.includes(`POST ${route} ->`));
    assert.ok(covered,
      `${route} is declared 'assembled', which means its body is verified by a branch ` +
      'outcome assertion — but no surviving suite pins an outcome for it, so nothing ' +
      'verifies it at all');
  }
});

// The specific defect, pinned so it cannot return.
test('suggest-substitute sends the fields the route actually reads', () => {
  const body = bodyFor('/api/suggest-substitute', 0, 'contract');
  assert.ok(body.message, 'the route gates on the athlete\'s message');
  assert.ok(body.current_exercise, 'the route returns immediately without current_exercise');
  assert.ok(!('exercise' in body) && !('reason' in body),
    'the old reconstruction used field names the route does not read at all');

  // And the route's own documented contract still names these two.
  const server = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  const routeIndex = server.indexOf("app.post('/api/suggest-substitute'");
  assert.ok(routeIndex !== -1);
  const handler = server.slice(routeIndex, routeIndex + 600);
  assert.match(handler, /current_exercise: currentExercise/,
    'the route still destructures current_exercise — if it stopped, this body must follow');
});
