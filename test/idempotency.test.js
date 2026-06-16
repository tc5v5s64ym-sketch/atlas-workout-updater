const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  beginWrite, completeWrite, failWrite, normalizeWriteId, resetIdempotencyStore
} = require('../services/idempotency');

// The store is module-level singleton state; start every test from clean.
beforeEach(() => resetIdempotencyStore());

/* ===== normalizeWriteId ===== */

test('normalizeWriteId trims and rejects empty / blank / nullish ids', () => {
  assert.equal(normalizeWriteId('  abc  '), 'abc');
  assert.equal(normalizeWriteId('x'), 'x');
  assert.equal(normalizeWriteId(123), '123');
  assert.equal(normalizeWriteId(''), null);
  assert.equal(normalizeWriteId('   '), null);
  assert.equal(normalizeWriteId(null), null);
  assert.equal(normalizeWriteId(undefined), null);
});

/* ===== beginWrite: disabled passthrough ===== */

test('beginWrite is a disabled passthrough when write_id is missing or blank', () => {
  assert.deepEqual(beginWrite(undefined), { enabled: false, write_id: null });
  assert.deepEqual(beginWrite(null), { enabled: false, write_id: null });
  assert.deepEqual(beginWrite('   '), { enabled: false, write_id: null });
});

/* ===== beginWrite: fresh write ===== */

test('beginWrite registers a fresh in-progress write and returns a token', () => {
  const r = beginWrite('w1', { path: '/api/log-workout' });
  assert.equal(r.enabled, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.write_id, 'w1');
  assert.ok(typeof r.token === 'string' && r.token.length > 0);
});

test('beginWrite trims the write_id before keying, so padded ids collide', () => {
  const a = beginWrite('  w-trim  ');
  assert.equal(a.write_id, 'w-trim');
  const b = beginWrite('w-trim');            // same logical id
  assert.equal(b.duplicate, true);
});

/* ===== duplicate detection + replay ===== */

test('a repeated write_id is flagged duplicate and replays the stored record', () => {
  const first = beginWrite('dup', { foo: 'bar' });
  completeWrite('dup', first.token, { sheet_write: 'success', log_rows_written: 3 });

  const second = beginWrite('dup');
  assert.equal(second.enabled, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.record.status, 'completed');
  assert.deepEqual(second.record.response, { sheet_write: 'success', log_rows_written: 3 });
});

test('an in-progress write_id replayed before completion is still a duplicate', () => {
  beginWrite('pending');
  const again = beginWrite('pending');
  assert.equal(again.duplicate, true);
  assert.equal(again.record.status, 'in_progress');
});

test('the duplicate record is a copy — mutating it does not corrupt the store', () => {
  const first = beginWrite('iso');
  completeWrite('iso', first.token, { n: 1 });
  const dup = beginWrite('iso');
  dup.record.response.n = 999;               // mutate the returned copy
  const again = beginWrite('iso');
  assert.equal(again.record.response.n, 1);  // store unchanged
});

/* ===== completeWrite: token discipline + isolation ===== */

test('completeWrite requires the matching token and a known id', () => {
  const r = beginWrite('tok');
  assert.equal(completeWrite('tok', 'wrong-token', {}), false); // bad token: no-op
  assert.equal(completeWrite('nope', r.token, {}), false);      // unknown id
  assert.equal(completeWrite('   ', r.token, {}), false);       // blank id
  assert.equal(completeWrite('tok', r.token, { ok: true }), true);
  assert.equal(beginWrite('tok').record.status, 'completed');
});

test('completeWrite clones the response — later mutation does not leak in', () => {
  const r = beginWrite('clone');
  const resp = { a: 1 };
  completeWrite('clone', r.token, resp);
  resp.a = 2;                                 // mutate caller's object afterward
  assert.equal(beginWrite('clone').record.response.a, 1);
});

/* ===== failWrite: marks the record failed but keeps the id retryable ===== */

test('failWrite frees the id for a clean retry', () => {
  const r = beginWrite('retry');
  assert.equal(failWrite('retry', 'wrong'), false);  // wrong token: no-op
  assert.equal(failWrite('retry', r.token), true);
  const retry = beginWrite('retry');
  assert.equal(retry.duplicate, false);              // failed → retryable, not a duplicate
  assert.ok(retry.token);
  assert.notEqual(retry.token, r.token);             // a fresh attempt with a new token
});

test('failWrite marks the record failed (not deleted) and invalidates the released token', () => {
  const r = beginWrite('mark-failed');
  assert.equal(failWrite('mark-failed', r.token), true);
  // The released attempt's token can no longer commit — a stale completeWrite for
  // the abandoned attempt must never resurrect the record.
  assert.equal(completeWrite('mark-failed', r.token, { sheet_write: 'success' }), false);
  // The id is still retryable: a fresh attempt starts in_progress, not a duplicate.
  const retry = beginWrite('mark-failed');
  assert.equal(retry.duplicate, false);
  assert.equal(beginWrite('mark-failed').record.status, 'in_progress');
});

test('failWrite on an unknown or blank id returns false', () => {
  assert.equal(failWrite('ghost', 'x'), false);
  assert.equal(failWrite('', 'x'), false);
});

/* ===== TTL expiry / pruning ===== */

test('records older than the 24h TTL are pruned and treated as fresh', () => {
  const t0 = 1_000_000;
  const first = beginWrite('ttl', {}, { now: t0 });
  completeWrite('ttl', first.token, { ok: true }, { now: t0 });

  const within = beginWrite('ttl', {}, { now: t0 + 60 * 1000 });        // < TTL
  assert.equal(within.duplicate, true);

  const past = beginWrite('ttl', {}, { now: t0 + 25 * 60 * 60 * 1000 }); // > 24h
  assert.equal(past.duplicate, false);
  assert.ok(past.token);
});

test('a custom ttlMs controls pruning', () => {
  const t0 = 5_000_000;
  const first = beginWrite('ttl2', {}, { now: t0, ttlMs: 1000 });
  assert.equal(first.duplicate, false);
  const within = beginWrite('ttl2', {}, { now: t0 + 500, ttlMs: 1000 });
  assert.equal(within.duplicate, true);
  const past = beginWrite('ttl2', {}, { now: t0 + 1500, ttlMs: 1000 });
  assert.equal(past.duplicate, false);
});

/* ===== independence + reset ===== */

test('distinct write_ids are independent', () => {
  const a = beginWrite('a');
  const b = beginWrite('b');
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, false);
  assert.notEqual(a.token, b.token);
  assert.equal(completeWrite('a', a.token, {}), true);
  assert.equal(beginWrite('b').record.status, 'in_progress'); // b untouched
});

test('resetIdempotencyStore clears all records', () => {
  const r = beginWrite('z');
  completeWrite('z', r.token, {});
  resetIdempotencyStore();
  assert.equal(beginWrite('z').duplicate, false);  // gone after reset
});
