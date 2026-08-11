'use strict';

// THE RECEIPT MIGRATION SEAM, against the REAL module.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.3 ("The receipt
// migration seam"), §5.5a. Gate: §6.2 P13.
//
// P13 is explicit that a fixture which builds a record map directly and bypasses
// the exported functions does NOT discharge it — the seam is the thing under test.
// So every assertion here goes through services/idempotency.js's own exports, and
// the memory-only case is produced by making persistence genuinely fail rather than
// by setting a flag.
//
// EXACT SUNSET: S4 deletes the seam, both routes and this store together, and
// §6.3 P16 proves no caller remains. This suite dies with them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-seam-'));
const STORE_FILE = path.join(STORE_DIR, 'atlas-idempotency.json');
process.env.ATLAS_IDEMPOTENCY_FILE = STORE_FILE;

const {
  beginWrite, completeWrite, peekWrite, resetIdempotencyStore,
  exportLiveReceipts, importReceipts, handoverPreconditions, PROCESS_ID,
} = require('../services/idempotency');

function useStoreFile(file) {
  process.env.ATLAS_IDEMPOTENCY_FILE = file;
  resetIdempotencyStore();
}

test.beforeEach(() => useStoreFile(STORE_FILE));
test.after(() => { try { fs.rmSync(STORE_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

// Force a REAL persistence failure: point the store at a path whose parent is a
// FILE, so mkdirSync throws ENOTDIR and the module falls back to memory-only
// exactly as it does on a full or read-only disk. No flag is set by hand.
function forcePersistDisabled() {
  const blocker = path.join(STORE_DIR, `blocker-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(blocker, 'not a directory');
  useStoreFile(path.join(blocker, 'atlas-idempotency.json'));
  const probe = beginWrite('persist-probe', { endpoint: '/api/log-workout' });
  completeWrite('persist-probe', probe.token, { sheet_write: 'success' });
  const snapshot = exportLiveReceipts();
  assert.equal(snapshot.persist_disabled, true, 'the store must have genuinely fallen back to memory-only');
  return snapshot;
}

/* ══════════ export: the memory-only record a disk read loses ══════════ */

test('P13 — exportLiveReceipts returns a MEMORY-ONLY record that never reached disk', () => {
  forcePersistDisabled();
  const begun = beginWrite('memory-only-receipt', { endpoint: '/api/complete-workout' });
  completeWrite('memory-only-receipt', begun.token, { sheet_write: 'success', log_rows_written: 4 });

  const snapshot = exportLiveReceipts();
  const carried = snapshot.records.find((r) => r.write_id === 'memory-only-receipt');
  assert.ok(carried, 'the live map is the source, not the file');
  assert.equal(carried.status, 'completed');
  assert.deepEqual(carried.response, { sheet_write: 'success', log_rows_written: 4 });

  // THE COMPLETENESS EVIDENCE §5.5a REQUIRES.
  assert.equal(snapshot.persist_disabled, true);
  assert.equal(snapshot.disk_vs_map.disk_is_complete, false,
    'a disk-based capture would silently lose this receipt, and the snapshot must say so');
  assert.ok(snapshot.disk_vs_map.only_in_map.includes('memory-only-receipt'));
  assert.equal(snapshot.disk_vs_map.disk_readable, false);
});

test('P13 — the export is read-only: it changes no record and no status', () => {
  const begun = beginWrite('untouched-by-export', { endpoint: '/api/log-workout' });
  const before = peekWrite('untouched-by-export');
  exportLiveReceipts();
  exportLiveReceipts();
  const after = peekWrite('untouched-by-export');
  assert.equal(after.status, before.status);
  assert.equal(after.token, begun.token, 'an export must never invalidate a live attempt token');
  assert.deepEqual(after.metadata, before.metadata);
});

test('P13 — every export carries the same process_id for the life of the process', () => {
  assert.equal(exportLiveReceipts().process_id, PROCESS_ID);
  assert.equal(exportLiveReceipts().process_id, PROCESS_ID);
  assert.ok(/.+:\d+:[0-9a-f]{12}/.test(PROCESS_ID), 'a reused pid alone would let a replacement look like the captured process');
});

test('P13 — disk_vs_map reports a faithful disk as complete', () => {
  const begun = beginWrite('persisted-receipt', { endpoint: '/api/bodyweight' });
  completeWrite('persisted-receipt', begun.token, { sheet_write: 'success' });
  const snapshot = exportLiveReceipts();
  assert.equal(snapshot.persist_disabled, false);
  assert.equal(snapshot.disk_vs_map.disk_readable, true);
  assert.deepEqual(snapshot.disk_vs_map.only_in_map, []);
  assert.equal(snapshot.disk_vs_map.disk_is_complete, true);
});

/* ══════════ import: into an ALREADY-RUNNING process ══════════ */

const CARRIED = Object.freeze({
  write_id: 'restored-into-a-live-process',
  status: 'completed',
  created_at_ms: Date.now(),
  created_at: new Date().toISOString(),
  metadata: { endpoint: '/api/log-workout' },
  response: { sheet_write: 'success', log_rows_written: 3 },
});

test('P13 — importReceipts replaces the live map, and peekWrite sees a record never loaded from disk', () => {
  // Make ensureLoaded run first, exactly as a live process already has.
  assert.equal(peekWrite('anything'), null);

  const result = importReceipts([{ ...CARRIED }]);
  assert.equal(result.applied, true);
  assert.deepEqual(result.accepted, [CARRIED.write_id]);
  assert.equal(result.process_id, PROCESS_ID);

  const seen = peekWrite(CARRIED.write_id);
  assert.ok(seen, 'THE LIVE DECIDER must see it — this is the whole point of the seam');
  assert.equal(seen.status, 'completed');
  assert.deepEqual(seen.response, { sheet_write: 'success', log_rows_written: 3 });

  // And the live duplicate decision now replays it rather than starting fresh.
  const duplicate = beginWrite(CARRIED.write_id);
  assert.equal(duplicate.duplicate, true, 'a lost-response retry must replay, not repeat the write');
  assert.deepEqual(duplicate.record.response, { sheet_write: 'success', log_rows_written: 3 });
});

test('P13 — THE NEGATIVE: writing /tmp instead does NOT restore the live map', () => {
  // A live process: ensureLoaded has already run.
  assert.equal(peekWrite('force-the-load'), null);

  // The "just write the JSON file" approach the seam exists to replace.
  fs.writeFileSync(STORE_FILE, JSON.stringify({
    version: 1,
    records: [{ ...CARRIED, write_id: 'written-straight-to-disk' }],
  }));

  assert.equal(peekWrite('written-straight-to-disk'), null,
    'ensureLoaded set loaded = true BEFORE reading, so the disk is read once per process — ' +
    'a file written afterwards never reaches the live map');

  // The seam succeeds on exactly the same input.
  const result = importReceipts([{ ...CARRIED, write_id: 'written-straight-to-disk' }]);
  assert.equal(result.applied, true);
  assert.ok(peekWrite('written-straight-to-disk'), 'the seam restores what the file write could not');
});

test('P13 — a memory-only receipt survives the import path too', () => {
  forcePersistDisabled();
  const result = importReceipts([{ ...CARRIED }]);
  assert.equal(result.applied, true);
  assert.equal(result.persisted, false, 'honest rather than optimistic: it reports the durability it does NOT have');
  assert.equal(result.persist_disabled, true);
  assert.ok(peekWrite(CARRIED.write_id), 'the record is live in memory regardless');
});

test('P13 — import REPLACES rather than merges, and a replaced map is not silently re-read from disk', () => {
  const begun = beginWrite('pre-existing', { endpoint: '/api/constraints' });
  completeWrite('pre-existing', begun.token, { sheet_write: 'success' });
  assert.ok(peekWrite('pre-existing'));

  const result = importReceipts([{ ...CARRIED }]);
  assert.equal(result.applied, true);
  assert.equal(result.map_size_after, 1);
  assert.equal(peekWrite('pre-existing'), null, 'the carried set is the authority after a handover');
  assert.ok(peekWrite(CARRIED.write_id));
});

/* ══════════ import validation — all-or-nothing, fail closed ══════════ */

for (const [label, record, reason] of [
  ['a non-object', 'not-a-record', 'not_an_object'],
  ['a missing write_id', { status: 'failed', created_at_ms: Date.now() }, 'write_id_missing'],
  ['an unnormalized write_id', { write_id: '  padded  ', status: 'failed', created_at_ms: Date.now() }, 'write_id_not_normalized'],
  ['a missing created_at_ms', { write_id: 'x', status: 'failed' }, 'created_at_ms_invalid'],
  ['an unknown status', { write_id: 'x', status: 'ambiguous', created_at_ms: Date.now() }, 'status_invalid'],
  ['a completed record with no response body', { write_id: 'x', status: 'completed', created_at_ms: Date.now() }, 'completed_without_response'],
  ['a non-object metadata', { write_id: 'x', status: 'failed', created_at_ms: Date.now(), metadata: 'nope' }, 'metadata_invalid'],
]) {
  test(`P13 — import refuses ${label} and changes nothing`, () => {
    const begun = beginWrite('must-survive-a-refused-import', { endpoint: '/api/log-workout' });
    completeWrite('must-survive-a-refused-import', begun.token, { sheet_write: 'success' });

    const result = importReceipts([record]);
    assert.equal(result.applied, false);
    assert.equal(result.rejected[0].reason, reason);
    assert.ok(peekWrite('must-survive-a-refused-import'),
      'a refused import must leave live duplicate protection exactly as it was');
  });
}

test('P13 — one bad record aborts a whole otherwise-valid batch', () => {
  const good = { ...CARRIED };
  const bad = { write_id: 'bad', status: 'nope', created_at_ms: Date.now() };
  const result = importReceipts([good, bad]);
  assert.equal(result.applied, false);
  assert.deepEqual(result.accepted, [good.write_id], 'the report still says which records passed validation');
  assert.equal(result.rejected.length, 1);
  assert.equal(peekWrite(good.write_id), null,
    'a partial replacement would delete duplicate protection for every rejected id');
});

test('P13 — a duplicate write_id inside one payload is refused', () => {
  const result = importReceipts([{ ...CARRIED }, { ...CARRIED }]);
  assert.equal(result.applied, false);
  assert.equal(result.rejected[0].reason, 'duplicate_write_id_in_payload');
});

test('P13 — a non-array payload is refused', () => {
  for (const payload of [undefined, null, 'records', { records: [] }, 42]) {
    const result = importReceipts(payload);
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'records_not_an_array');
  }
});

/* ══════════ the single-instance invariant, proven three ways ══════════ */

test('P13 — more than one live process ABORTS the cutover, and never triggers a scale-down', () => {
  const verdict = handoverPreconditions({ platformLiveProcessCount: 3, observedProcessIds: [PROCESS_ID] });
  assert.equal(verdict.abort, true);
  assert.equal(verdict.proceed, false);
  assert.ok(verdict.reasons.includes('more_than_one_live_process'));
  assert.equal(verdict.scale_down_recommended, false,
    'reducing to one instance destroys the in-memory receipts the handover is about to capture');
  assert.match(verdict.remedy, /Do NOT scale down/);
});

test('P13 — two distinct process_ids across the handover abort rather than merge', () => {
  const verdict = handoverPreconditions({
    platformLiveProcessCount: 1,
    observedProcessIds: [PROCESS_ID, `${PROCESS_ID}-other`],
  });
  assert.equal(verdict.abort, true);
  assert.ok(verdict.reasons.includes('process_id_changed_across_handover'));
});

test('P13 — an unknown platform count aborts; both signals are required', () => {
  for (const count of [undefined, null, 0, -1, 'one', 1.5]) {
    const verdict = handoverPreconditions({ platformLiveProcessCount: count, observedProcessIds: [PROCESS_ID] });
    assert.equal(verdict.abort, true, `a count of ${String(count)} is not proof of a single instance`);
  }
  assert.equal(
    handoverPreconditions({ platformLiveProcessCount: 1, observedProcessIds: [] }).abort, true,
    'a platform count alone can be stale — an observed process_id is required too'
  );
  assert.equal(
    handoverPreconditions({ platformLiveProcessCount: 1, observedProcessIds: [PROCESS_ID, PROCESS_ID] }).proceed,
    true,
    'one live process, one observed identity, agreeing — the only proceeding case'
  );
});

test('P13 — THE LOSS IT PREVENTS, demonstrated: retiring a process erases a memory-only receipt', () => {
  const snapshot = forcePersistDisabled();
  const file = process.env.ATLAS_IDEMPOTENCY_FILE;

  const begun = beginWrite('lives-only-in-this-process', { endpoint: '/api/log-workout' });
  completeWrite('lives-only-in-this-process', begun.token, { sheet_write: 'success' });
  assert.ok(peekWrite('lives-only-in-this-process'), 'it is live in this map');
  assert.equal(snapshot.persist_disabled, true);
  assert.equal(fs.existsSync(file), false, 'and it reached no file');

  // Retire the process. This is exactly what "reduce to one instance first" does
  // to every process it retires.
  resetIdempotencyStore();

  assert.equal(peekWrite('lives-only-in-this-process'), null, 'gone from every surviving map');
  assert.equal(fs.existsSync(file), false, 'and gone from the file, because it was never there');
});

/* ══════════ no second secret exists to configure ══════════ */

test('P13 — the seam introduces NO new secret, proven by source scan', () => {
  const root = path.join(__dirname, '..');
  const sources = [
    fs.readFileSync(path.join(root, 'index.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'services', 'idempotency.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'services', 'writeFreeze.js'), 'utf8'),
  ].join('\n');

  // An earlier design added a cutover-only migration token. A server cannot verify
  // a secret it does not hold, and configuring one on Render REDEPLOYS — which is
  // the restart this seam exists to avoid, and which destroys the in-memory map it
  // exists to read. It was deleted rather than given a framework; nothing may
  // reintroduce it under another name.
  for (const forbidden of [
    /ATLAS_MIGRATION_TOKEN/, /MIGRATION_SECRET/, /x-atlas-migration/i, /ATLAS_CUTOVER_KEY/,
  ]) {
    assert.equal(forbidden.test(sources), false,
      `the seam must authenticate with the EXISTING API key and the proven freeze only (${forbidden})`);
  }

  // And the two conditions that DO gate it are both present on the routes.
  const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(indexSource, /req\.authMethod !== 'api_key'/,
    'the API-key path specifically — a session cookie must not satisfy it');
  assert.match(indexSource, /requireFrozenWindow/,
    'and a successful current-request read proving frozen = true');
});
