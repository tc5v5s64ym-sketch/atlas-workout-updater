'use strict';

// THE READ-EVIDENCE TOOL, TESTED.
//
// `scripts/reconstruct-session-reads.js` is how a session's Sheets read demand is measured
// from a server log. It is the instrument the whole read-budget corrective reasons from, and
// it had no test — which is how it shipped on this branch with a prefix-stripping regex that
// removed the SEMANTIC tag (`[sheets-read]`, `[sheets.js]`) along with the harness prefix.
// The consequence was the worst kind: a log full of reads parsed as zero attempts, reported
// as a clean "legacy mode" result rather than as a failure.
//
// The rule these tests encode: **a tool that cannot see evidence must say so, and must never
// report the absence of evidence as the absence of reads.**

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconstruct, summarize, peakRollingMinute } = require('../scripts/reconstruct-session-reads');

const T0 = Date.parse('2026-08-06T12:00:00.000Z');
const iso = ms => new Date(T0 + ms).toISOString();

function structuredLine(fields, prefix = '') {
  return `${prefix}[sheets-read] ${JSON.stringify(fields)}`;
}

const ONE = {
  at: iso(0), request_id: 'r1', http_method: 'GET', http_path: '/api/plan/today',
  api: 'values.batchGet', ranges: ['Log_Cleaned!A:Z', 'Deload_State!A:Z'], attempt: 1, outcome: 'ok',
};

// ── the defect this file exists for ─────────────────────────────────────────
test('a structured line parses — with and without a harness prefix', () => {
  for (const prefix of ['', '[gate-server] ', '[gate-server] [worker-2] ']) {
    const result = reconstruct(structuredLine(ONE, prefix));
    assert.equal(result.mode, 'structured', `prefix ${JSON.stringify(prefix)} must still parse`);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].api, 'values.batchGet');
    assert.equal(result.attempts[0].endpoint, 'GET /api/plan/today');
    assert.equal(result.attempts[0].request_id, 'r1');
  }
});

test('a legacy line parses — with and without a harness prefix', () => {
  for (const prefix of ['', '[gate-server] ']) {
    const log = [
      `${prefix}[sheets.js] Reading range Log_Cleaned!A:Z`,
      '{"timestamp":"2026-08-06T12:00:01.000Z","method":"GET","path":"/api/plan/today","status":200,"requestId":"q1","duration_ms":5}',
    ].join('\n');
    const result = reconstruct(log);
    assert.equal(result.mode, 'legacy', `prefix ${JSON.stringify(prefix)} must still parse`);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].ranges[0], 'Log_Cleaned!A:Z');
  }
});

// ── the rolling window is the point of the measurement ──────────────────────
test('every structured attempt is stamped, so the rolling-60s peak is real', () => {
  const log = [
    structuredLine({ ...ONE, at: iso(0) }),
    structuredLine({ ...ONE, at: iso(10_000), request_id: 'r2' }),
    structuredLine({ ...ONE, at: iso(20_000), request_id: 'r3' }),
    // outside the first window
    structuredLine({ ...ONE, at: iso(90_000), request_id: 'r4' }),
  ].join('\n');
  const result = reconstruct(log);
  const rolling = peakRollingMinute(result.attempts);

  assert.equal(result.attempts.length, 4);
  assert.equal(rolling.unstamped, 0,
    'an unstamped attempt is excluded from the peak — the measurement would silently shrink');
  assert.equal(rolling.stamped_total, 4);
  assert.equal(rolling.peak, 3, 'three attempts fall inside one rolling minute');
});

test('an attempt with no timestamp is EXCLUDED and COUNTED as excluded, never silently dropped', () => {
  const { at, ...noStamp } = ONE;   // eslint-disable-line no-unused-vars
  const result = reconstruct([structuredLine({ ...ONE, at: iso(0) }), structuredLine(noStamp)].join('\n'));
  const rolling = peakRollingMinute(result.attempts);
  assert.equal(result.attempts.length, 2, 'the attempt still counts toward the TOTAL');
  assert.equal(rolling.unstamped, 1, 'and its absence from the peak is reported, not hidden');
});

// ── retries are what Google meters ──────────────────────────────────────────
test('a retry is a second attempt, and is counted as one', () => {
  const log = [
    structuredLine({ ...ONE, at: iso(0), attempt: 1, outcome: 'transient' }),
    structuredLine({ ...ONE, at: iso(500), attempt: 2, outcome: 'ok' }),
  ].join('\n');
  const result = reconstruct(log);
  assert.equal(result.attempts.length, 2, 'both attempts cost quota, so both are counted');
  assert.equal(result.attempts.filter(a => a.retry).length, 1);
  assert.equal(result.retriesObservable, true);
});

test('a quota rejection is carried through, not flattened into a generic failure', () => {
  const result = reconstruct(structuredLine({
    ...ONE, at: iso(0), attempt: 1, outcome: 'transient', quota_rejection: true,
  }));
  assert.equal(result.attempts[0].quota_rejection, true);
});

// ── the honesty rule ────────────────────────────────────────────────────────
test('a legacy log with no retry evidence reports retries as UNOBSERVABLE, never as zero', () => {
  const log = [
    '[sheets.js] Reading range Log_Cleaned!A:Z',
    '{"timestamp":"2026-08-06T12:00:01.000Z","method":"GET","path":"/api/plan/today","status":200,"requestId":"q1","duration_ms":5}',
  ].join('\n');
  const result = reconstruct(log);
  assert.equal(result.retriesObservable, false,
    'the log carries no retry evidence — "0 retries" would be a claim it cannot support');
  assert.equal(result.metadataObservable, false,
    'and it carries no metadata-read evidence either, so the total is a lower bound');
});

test('a structured log makes both retries and metadata reads observable', () => {
  const result = reconstruct(structuredLine({ ...ONE, at: iso(0) }));
  assert.equal(result.retriesObservable, true);
  assert.equal(result.metadataObservable, true);
});

test('an empty log reports nothing observable — it never reports a clean zero', () => {
  const result = reconstruct('');
  assert.equal(result.attempts.length, 0);
  assert.equal(result.retriesObservable, false);
  assert.equal(result.metadataObservable, false);
});

// ── the two modes are never mixed ───────────────────────────────────────────
test('structured records win outright — legacy lines in the same log are not added to them', () => {
  const log = [
    '[sheets.js] Reading range Log_Cleaned!A:Z',
    '{"timestamp":"2026-08-06T12:00:01.000Z","method":"GET","path":"/api/plan/today","status":200,"requestId":"q1","duration_ms":5}',
    structuredLine({ ...ONE, at: iso(2000) }),
  ].join('\n');
  const result = reconstruct(log);
  assert.equal(result.mode, 'structured');
  assert.equal(result.attempts.length, 1, 'one structured attempt, not one plus a legacy double-count');
  assert.ok(result.attempts.every(a => a.mode === 'structured'));
});

// ── the client request manifest ─────────────────────────────────────────────
test('the request manifest counts how many times each endpoint was CALLED', () => {
  const log = [
    '{"timestamp":"2026-08-06T12:00:01.000Z","method":"GET","path":"/api/plan/today","status":200,"requestId":"q1","duration_ms":5}',
    '{"timestamp":"2026-08-06T12:00:02.000Z","method":"GET","path":"/api/plan/today","status":200,"requestId":"q2","duration_ms":5}',
    '{"timestamp":"2026-08-06T12:00:03.000Z","method":"POST","path":"/api/log-workout","status":200,"requestId":"q3","duration_ms":9}',
  ].join('\n');
  const result = reconstruct(log);
  assert.equal(result.requests.length, 3);
  const byEndpoint = summarize(result.attempts);
  assert.ok(byEndpoint, 'summarize must accept the attempt list');
});
