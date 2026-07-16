const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// PR-04: the duplicate-write shield must survive a process restart. These tests
// exercise the on-disk write-through layer of services/idempotency.js by
// simulating a Render redeploy — a fresh module load re-reading the JSON file.
//
// Isolated file per test so this suite never touches the production default
// (/tmp/atlas-idempotency.json) and never collides with the parallel test procs.

const MODULE_PATH = require.resolve('../services/idempotency');
const STALE_IN_PROGRESS_MS = 5 * 60 * 1000; // mirror of the module constant
const TTL_MS = 24 * 60 * 60 * 1000;

let TEST_FILE;
let fileCounter = 0;

// A fresh require simulates a restarted process: module-level state resets and
// the store rehydrates lazily from disk on first use.
function freshModule() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

function writeStoreFile(records) {
  fs.writeFileSync(TEST_FILE, JSON.stringify({ version: 1, records }));
}

beforeEach(() => {
  fileCounter += 1;
  TEST_FILE = path.join(os.tmpdir(), `atlas-idem-persist-${process.pid}-${fileCounter}.json`);
  process.env.ATLAS_IDEMPOTENCY_FILE = TEST_FILE;
  try { fs.unlinkSync(TEST_FILE); } catch (_) { /* not present yet */ }
  delete require.cache[MODULE_PATH];
});

afterEach(() => {
  try { fs.unlinkSync(TEST_FILE); } catch (_) { /* best-effort */ }
  delete require.cache[MODULE_PATH];
});

/* ===== write-through survives a restart (the headline behavior) ===== */

test('a completed write persists to disk and is replayed after a restart', () => {
  const a = freshModule();
  const begun = a.beginWrite('e2e', { endpoint: '/api/log-workout' });
  a.completeWrite('e2e', begun.token, { sheet_write: 'success', log_rows_written: 2 });

  // Simulate the redeploy: brand-new module instance, no in-memory carryover.
  const b = freshModule();
  const replay = b.beginWrite('e2e');
  assert.equal(replay.enabled, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.record.status, 'completed');
  assert.deepEqual(replay.record.response, { sheet_write: 'success', log_rows_written: 2 });
});

test('a fresh module load replays a completed record written to the file', () => {
  const now = 2_000_000;
  writeStoreFile([{
    write_id: 'done',
    status: 'completed',
    created_at_ms: now,
    created_at: new Date(now).toISOString(),
    metadata: {},
    response: { sheet_write: 'success', log_rows_written: 5 }
  }]);

  const mod = freshModule();
  const r = mod.beginWrite('done', {}, { now: now + 1000 });
  assert.equal(r.duplicate, true);
  assert.equal(r.record.status, 'completed');
  assert.deepEqual(r.record.response, { sheet_write: 'success', log_rows_written: 5 });
});

/* ===== stale in_progress recovery ===== */

test('an in_progress record older than the staleness window is treated as failed (retryable)', () => {
  const t0 = 3_000_000;
  writeStoreFile([{
    write_id: 'stuck',
    status: 'in_progress',
    created_at_ms: t0,
    created_at: new Date(t0).toISOString(),
    metadata: {},
    token: 'old-token'
  }]);

  const mod = freshModule();
  const r = mod.beginWrite('stuck', {}, { now: t0 + STALE_IN_PROGRESS_MS + 1 });
  assert.equal(r.duplicate, false);           // abandoned attempt → retryable
  assert.ok(r.token && r.token !== 'old-token');

  // The stale attempt's original token can never resurrect the record.
  assert.equal(mod.completeWrite('stuck', 'old-token', { sheet_write: 'success' }), false);
});

test('a recent in_progress record still blocks a retry as a duplicate after a restart', () => {
  const t0 = 4_000_000;
  writeStoreFile([{
    write_id: 'inflight',
    status: 'in_progress',
    created_at_ms: t0,
    created_at: new Date(t0).toISOString(),
    metadata: {},
    token: 'live-token'
  }]);

  const mod = freshModule();
  const r = mod.beginWrite('inflight', {}, { now: t0 + 1000 }); // well within the window
  assert.equal(r.duplicate, true);
  assert.equal(r.record.status, 'in_progress');
});

// WRITE-3: the load-time downgrade runs only once. An EARLY rehydration (record
// still fresh when the file was read) must still be downgraded by beginWrite once it
// ages past the window — otherwise the write_id wedges as a duplicate for up to 24h.
test('WRITE-3: a rehydrated in_progress record is downgraded in beginWrite once it ages past the window', () => {
  const t0 = 8_000_000;
  writeStoreFile([{
    write_id: 'early-rehydrate',
    status: 'in_progress',
    created_at_ms: t0,
    created_at: new Date(t0).toISOString(),
    metadata: { session_id: '20260101-AM-01' },
    token: 'crashed-token'
  }]);

  const mod = freshModule();
  // Early rehydration: first touch is WITHIN the window → still a live duplicate.
  const early = mod.beginWrite('early-rehydrate', {}, { now: t0 + 1000 });
  assert.equal(early.duplicate, true);
  assert.equal(early.record.status, 'in_progress');

  // Later, PAST the window, the SAME process must downgrade it (not wedge to 24h).
  const later = mod.beginWrite('early-rehydrate', {}, { now: t0 + STALE_IN_PROGRESS_MS + 1 });
  assert.equal(later.duplicate, false, 'stale rehydrated in_progress is retryable in beginWrite, not only at load');
  assert.ok(later.token && later.token !== 'crashed-token');

  // The crashed attempt's original token can never resurrect the record.
  assert.equal(mod.completeWrite('early-rehydrate', 'crashed-token', { sheet_write: 'success' }), false);
});

// WRITE-2: a crashed attempt that server-minted a session id stamps it into the
// record; peekWrite recovers it (read-only) so a retry can reuse the same id.
test('WRITE-2: peekWrite recovers the server-minted session id from a prior attempt without mutating the store', () => {
  const t0 = 8_500_000;
  writeStoreFile([{
    write_id: 'mint-crash',
    status: 'in_progress',
    created_at_ms: t0,
    created_at: new Date(t0).toISOString(),
    metadata: { endpoint: '/api/complete-workout', session_id: '20260101-AM-03' },
    token: 'crashed-token'
  }]);

  const mod = freshModule();
  const peeked = mod.peekWrite('mint-crash', { now: t0 + 1000 });
  assert.ok(peeked);
  assert.equal(peeked.metadata.session_id, '20260101-AM-03');

  // peek is read-only: it must not create a record or downgrade the in_progress one.
  const stillInFlight = mod.beginWrite('mint-crash', {}, { now: t0 + 1000 });
  assert.equal(stillInFlight.duplicate, true);
  assert.equal(stillInFlight.record.status, 'in_progress');

  // An unknown write_id peeks as null (no record minted).
  assert.equal(mod.peekWrite('never-seen', { now: t0 + 1000 }), null);
});

/* ===== TTL prune on load ===== */

test('records older than the 24h TTL are pruned on load, not replayed', () => {
  const t0 = 5_000_000;
  writeStoreFile([{
    write_id: 'ancient',
    status: 'completed',
    created_at_ms: t0,
    created_at: new Date(t0).toISOString(),
    metadata: {},
    response: { ok: true }
  }]);

  const mod = freshModule();
  const r = mod.beginWrite('ancient', {}, { now: t0 + TTL_MS + 1 });
  assert.equal(r.duplicate, false);           // expired → gone, fresh attempt
  assert.ok(r.token);
});

/* ===== corrupt-file recovery ===== */

test('a corrupt idempotency file is recovered from — the store starts empty and writes succeed', () => {
  fs.writeFileSync(TEST_FILE, '{ this is not: valid json ]');

  const mod = freshModule();
  const r = mod.beginWrite('after-corrupt');
  assert.equal(r.enabled, true);
  assert.equal(r.duplicate, false);
  assert.ok(r.token);
  // And it re-establishes a valid file for the next write.
  assert.ok(fs.existsSync(TEST_FILE));
  assert.equal(mod.completeWrite('after-corrupt', r.token, { ok: true }), true);
});

test('a legacy bare-array file shape still loads', () => {
  const now = 6_000_000;
  fs.writeFileSync(TEST_FILE, JSON.stringify([{
    write_id: 'legacy',
    status: 'completed',
    created_at_ms: now,
    created_at: new Date(now).toISOString(),
    metadata: {},
    response: { ok: 1 }
  }]));

  const mod = freshModule();
  const r = mod.beginWrite('legacy', {}, { now: now + 1000 });
  assert.equal(r.duplicate, true);
  assert.deepEqual(r.record.response, { ok: 1 });
});

/* ===== persistence failure never fails a write ===== */

test('a persistence failure falls back to in-memory and never fails the write', () => {
  // Point the store at a directory: the atomic rename onto it fails every time.
  const dir = path.join(os.tmpdir(), `atlas-idem-dir-${process.pid}-${fileCounter}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  fs.mkdirSync(dir, { recursive: true });
  process.env.ATLAS_IDEMPOTENCY_FILE = dir;

  const mod = freshModule();
  const r = mod.beginWrite('degraded', { endpoint: '/api/log-workout' });
  assert.equal(r.enabled, true);              // the write proceeds regardless
  assert.equal(r.duplicate, false);
  assert.ok(r.token);

  // In-memory dedupe still works even though nothing reached disk.
  assert.equal(mod.completeWrite('degraded', r.token, { ok: true }), true);
  assert.equal(mod.beginWrite('degraded').duplicate, true);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* cleanup */ }
});

/* ===== reset clears the file ===== */

test('resetIdempotencyStore deletes the persisted file', () => {
  const mod = freshModule();
  const r = mod.beginWrite('to-clear');
  mod.completeWrite('to-clear', r.token, { ok: true });
  assert.ok(fs.existsSync(TEST_FILE));

  mod.resetIdempotencyStore();
  assert.equal(fs.existsSync(TEST_FILE), false);
  // And the id is fresh again.
  assert.equal(mod.beginWrite('to-clear').duplicate, false);
});
