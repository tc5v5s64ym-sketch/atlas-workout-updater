'use strict';

// The browser write blockade (kept under the owner ruling of 2026-07-31: "keep the
// browser write blockade — it is load-bearing and prevented real plan-ledger and
// flight-recorder writes").
//
// It is not a theoretical guard. In Actions run 30596164330 — an authenticated live
// run against production — it aborted six state-mutating requests the APP initiated
// on its own: `/api/session-plans/accept`, `/api/session-plan-sets/accept`, and four
// `/api/flight/ingest` posts. Without it those would have been real writes.
//
// SCOPE OF THE CLAIM. It stops WORKOUT AND SESSION STATE MUTATION. It is NOT a claim
// of zero Sheet writes — synthetic shadow telemetry (Intent_Shadow / Brain_Shadow)
// is still appended, correctly provenance-tagged, and Coach_Shadow / Coach_Response
// are contained server-side instead (test/coachShadowSyntheticContainment.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const blockade = require('../scripts/live-retest-write-blockade');
const { installWriteBlockade, buildMarkdownReport, SCENARIOS } = require('../scripts/live-retest');
const { routeDefinitions } = require('../config/routes');

const url = (p) => `https://atlas.example${p}`;
const classify = (method, p, body) => blockade.classifyOutboundRequest({ method, url: url(p), body });

// ── 1. The route set is derived, not hand-kept ───────────────────────────────

test('1a. the blockade list equals every writeCapable route in config/routes.js', () => {
  const expected = routeDefinitions.filter(r => r.writeCapable === true).map(r => r.path).sort();
  assert.deepEqual(blockade.WRITE_CAPABLE_ROUTES.map(r => r.path).sort(), expected);
  assert.ok(expected.length >= 18, 'the manifest genuinely lists write-capable routes');
});

test('1b. the test_mode allow-list equals the routes that ACTUALLY honor it in index.js', () => {
  // Re-derived from source so the allow-list cannot silently widen: a write-capable
  // handler honors test_mode only if it calls isTestModeEnabled().
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').split('\n');
  const starts = [];
  src.forEach((l, i) => {
    const m = l.match(/^app\.(post|put|patch|delete)\('([^']+)'/);
    if (m) starts.push({ line: i + 1, path: m[2] });
  });
  const writeCapable = new Set(routeDefinitions.filter(r => r.writeCapable === true).map(r => r.path));
  const derived = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].line;
    const to = i + 1 < starts.length ? starts[i + 1].line : src.length;
    if (writeCapable.has(starts[i].path) && /isTestModeEnabled\(/.test(src.slice(from - 1, to - 1).join('\n'))) {
      derived.push(starts[i].path);
    }
  }
  assert.deepEqual([...blockade.TEST_MODE_HONORING_ROUTES].sort(), derived.sort());
  assert.equal(derived.includes('/api/session-plans/accept'), false, 'the plan-ledger sidecars never dry-run');
});

// ── 2. Every category the owner named is aborted ─────────────────────────────

test('2a. Session_Plans, Session_Plan_Sets, Flight_Recorder, workout-log, closeout, revision and seal writes all abort', () => {
  const mustAbort = [
    // plan ledger + set ledger (incl. closeout, revision, seal/implicit)
    '/api/session-plans/accept', '/api/session-plans/outcome', '/api/session-plans/closeout',
    '/api/session-plan-sets/accept', '/api/session-plan-sets/revision', '/api/session-plan-sets/implicit',
    // flight recorder
    '/api/flight/ingest',
    // workout log + completion + undo
    '/api/log-workout', '/api/complete-workout', '/api/log-workout/undo-last'
  ];
  for (const p of mustAbort) {
    const d = classify('POST', p, JSON.stringify({ session_id: 's' }));
    assert.equal(d.allowed, false, `${p} must abort on a live (no test_mode) write`);
  }
});

test('2b. a route that IGNORES test_mode aborts even when the payload carries it', () => {
  // The fail-open Codex caught: keying the bypass on a payload field. Only the
  // handler honoring test_mode may buy passage.
  for (const p of [
    '/api/session-plans/accept', '/api/session-plans/outcome', '/api/session-plans/closeout',
    '/api/session-plan-sets/accept', '/api/session-plan-sets/revision', '/api/session-plan-sets/implicit',
    '/api/flight/ingest', '/api/log-workout/undo-last', '/api/deload/begin', '/api/deload/advance',
    '/api/deload/resolve', '/api/bug-report', '/api/coaching-notes', '/api/constraints'
  ]) {
    const d = classify('POST', p, JSON.stringify({ test_mode: true, items: [{ x: 1 }] }));
    assert.equal(d.allowed, false, `${p} ignores test_mode and must abort regardless`);
    assert.equal(d.reason, 'write_capable_route_ignores_test_mode');
  }
});

test('2c. the exact endpoints the implicit plan acceptance calls are aborted', () => {
  // The pair the live run actually hit (run 30596164330).
  for (const p of ['/api/session-plans/accept', '/api/session-plan-sets/accept']) {
    assert.equal(classify('POST', p, JSON.stringify({ session_id: 's' })).allowed, false);
  }
});

// ── 3. The preview flow and ordinary reads are unaffected ────────────────────

test('3a. a test_mode dry-run on a honoring route is allowed, in every shape the app sends', () => {
  for (const body of [
    JSON.stringify({ log_rows: [], test_mode: true }),
    JSON.stringify({ log_rows: [], test_mode: 'true' }),
    '------x\r\nContent-Disposition: form-data; name="test_mode"\r\n\r\ntrue\r\n------x--'
  ]) {
    const d = classify('POST', '/api/log-workout', body);
    assert.equal(d.allowed, true, `the preview flow must keep working: ${String(body).slice(0, 40)}`);
    assert.equal(d.dryRun, true);
  }
});

test('3b. read-only routes pass, and the match is method-sensitive', () => {
  for (const [m, p] of [['POST', '/api/coach/message'], ['POST', '/api/coach/ask'], ['GET', '/api/history/recent'], ['POST', '/api/session/login']]) {
    assert.equal(classify(m, p, '{}').allowed, true, `${m} ${p} must pass`);
  }
  assert.equal(classify('GET', '/api/constraints', '').allowed, true, 'GET is not the write-capable method here');
});

// ── 4. Fails closed ──────────────────────────────────────────────────────────

test('4a. missing, unreadable, or unparseable requests abort', () => {
  assert.equal(classify('POST', '/api/log-workout', JSON.stringify({})).allowed, false, 'no test_mode = live write');
  assert.equal(classify('POST', '/api/log-workout', '<<unreadable>>').allowed, false);
  assert.equal(classify('POST', '/api/log-workout').allowed, false, 'a missing body fails closed');
  assert.equal(blockade.classifyOutboundRequest({ method: 'POST', url: 'not a url', body: '{}' }).allowed, false);
});

// ── 5. The installed interceptor behaves ─────────────────────────────────────

test('5a. installWriteBlockade aborts a live write, continues a dry-run, and records path+reason only', async () => {
  const outcomes = [];
  const blocked = [];
  const logs = [];
  const context = { async route(_pattern, handler) { context._handler = handler; } };
  await installWriteBlockade(context, { onBlocked: b => blocked.push(b), logger: { log() {}, error: m => logs.push(m) } });
  assert.equal(typeof context._handler, 'function');

  const fire = (method, u, body) => context._handler({
    request: () => ({ method: () => method, url: () => u, postData: () => body }),
    continue: async () => { outcomes.push(`continue:${u}`); },
    abort: async (reason) => { outcomes.push(`abort:${u}:${reason}`); }
  });

  await fire('POST', url('/api/session-plans/accept'), JSON.stringify({ secret: 'PRIVATE WORKOUT TEXT' }));
  await fire('POST', url('/api/log-workout'), JSON.stringify({ test_mode: true }));
  await fire('POST', url('/api/coach/message'), JSON.stringify({ x: 1 }));

  assert.deepEqual(outcomes, [
    `abort:${url('/api/session-plans/accept')}:blockedbyclient`,
    `continue:${url('/api/log-workout')}`,
    `continue:${url('/api/coach/message')}`
  ]);
  assert.deepEqual(blocked, [{ path: '/api/session-plans/accept', reason: 'write_capable_route_ignores_test_mode' }]);
  // Never the request body — on an authenticated run that is the owner's private content.
  assert.equal(JSON.stringify(blocked).includes('PRIVATE WORKOUT TEXT'), false);
  assert.equal(logs.join('\n').includes('PRIVATE WORKOUT TEXT'), false);
});

// ── 6. The safety claim is stated honestly ───────────────────────────────────

test('6a. the report claims no state mutation, and explicitly disclaims zero Sheet writes', () => {
  const md = buildMarkdownReport([{ scenario: 'x', bugId: 'B', verdict: 'PASS', exitCode: 0 }]);
  assert.match(md, /mutates no workout or session state/);
  assert.match(md, /not\* a claim of zero Sheet writes/);
  assert.match(md, /Intent_Shadow \/ Brain_Shadow/);
  assert.doesNotMatch(md, /never writes to Google Sheets/,
    'the retired absolute claim must never come back');
});

test('6b. the harness source carries no retired absolute no-write claim', () => {
  for (const f of ['scripts/live-retest.js', 'scripts/live-retest-write-blockade.js', '.github/workflows/live-retest.yml']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /never writes to Google Sheets/, `${f} must not claim zero Sheet writes`);
    assert.doesNotMatch(src, /no Sheets writes/, `${f} must not claim zero Sheet writes`);
  }
});

// ── 7. The Golden Session scaffolding is gone (owner ruling item 7) ──────────

test('7a. no golden-session scenario or adapter remains', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(SCENARIOS, 'golden-session'), false,
    'the Golden Session catalogue was removed — it was not required for the containment fix');
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'scripts', 'live-retest-golden-session.js')), false);
  const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'live-retest.yml'), 'utf8');
  assert.doesNotMatch(yml, /golden-session/, 'the workflow no longer offers the Golden Session replay');
});

test('7b. the pre-existing scenario set is exactly what it was before the adapter', () => {
  assert.deepEqual(Object.keys(SCENARIOS), [
    'bug-20260629-153258', 'bug-20260629-153312', 'bug-20260629-003505',
    'bug-20260629-002945', 'bug-20260629-204817', 'coach-response-settlement'
  ]);
});
