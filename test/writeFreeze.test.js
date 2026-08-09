'use strict';

// THE WRITE-ADMISSION CONTROL, proven at the unit level.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §3.10, §5.3; gates §6.2
// P11 (control loss cannot reopen writes; no env/file override) and P12 (dormant).
// Owner ruling D7 — APPROVED 2026-08-09, permanent, no sunset.
//
// The from-empty Postgres proof (test-pg/writeFreeze.pgproof.js) owns the schema,
// the grants, restart-free activation and the replacement-instance posture. THIS
// file owns the decision logic, and it owns the cases a database cannot easily
// produce on demand: a hung read, a torn row, two rows, a nulled column.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const writeFreeze = require('../services/writeFreeze');

const APP_URL = 'ATLAS_SUPABASE_APP_URL';

// A valid §3.10 row, as the driver returns it.
function validRow(overrides = {}) {
  return {
    id: true,
    frozen: false,
    reason: 'dormant — seeded by the S3 migration; writes open',
    set_by: 'migration:S3',
    set_at: new Date('2026-08-09T00:00:00Z'),
    ...overrides,
  };
}

function adapterReturning(rows) {
  return { readWriteFreeze: async () => rows };
}

function adapterThrowing(error) {
  return { readWriteFreeze: async () => { throw error; } };
}

let savedAppUrl;
beforeEach(() => {
  savedAppUrl = process.env[APP_URL];
  // ARMED for every test below unless a test says otherwise. Arming is what makes
  // the control live; the dormant case is proven explicitly further down.
  process.env[APP_URL] = 'postgres://atlas_app:x@127.0.0.1:5432/atlas_test';
  writeFreeze.__resetArmingForTests();
});

test.afterEach(() => {
  if (savedAppUrl === undefined) delete process.env[APP_URL];
  else process.env[APP_URL] = savedAppUrl;
  writeFreeze.__resetArmingForTests();
});

/* ===== the admitting case, and it is the ONLY admitting case ===== */

test('exactly one valid row saying frozen = false admits the write', async () => {
  const verdict = await writeFreeze.admitWrite('/api/log-workout', { adapter: adapterReturning([validRow()]) });
  assert.equal(verdict.open, true);
  assert.equal(verdict.armed, true);
  assert.equal(verdict.code, 'open');
});

test('exactly one valid row saying frozen = true refuses, and carries the owner reason', async () => {
  const row = validRow({ frozen: true, reason: 'cutover window — §5.5 step 1', set_by: 'dale' });
  const verdict = await writeFreeze.admitWrite('/api/log-workout', { adapter: adapterReturning([row]) });
  assert.equal(verdict.open, false);
  assert.equal(verdict.code, 'frozen');
  assert.equal(verdict.detail, 'cutover window — §5.5 step 1');
  assert.equal(verdict.set_by, 'dale');
});

/* ===== EVERY ambiguity is frozen (§5.3) ===== */

test('a query error is frozen, not a fallback', async () => {
  const verdict = await writeFreeze.admitWrite('/api/log-workout', {
    adapter: adapterThrowing(new Error('connection terminated unexpectedly')),
  });
  assert.equal(verdict.open, false);
  assert.equal(verdict.code, 'read_failed');
});

test('an unconfigured runtime role — SUPABASE_NOT_CONFIGURED — is frozen once armed', async () => {
  const err = new Error('Supabase is not configured for role "app"');
  err.code = 'SUPABASE_NOT_CONFIGURED';
  const verdict = await writeFreeze.admitWrite('/api/log-workout', { adapter: adapterThrowing(err) });
  assert.equal(verdict.open, false);
  assert.equal(verdict.code, 'read_failed');
});

test('no result is frozen', async () => {
  const verdict = await writeFreeze.admitWrite('/api/log-workout', { adapter: adapterReturning([]) });
  assert.equal(verdict.open, false);
  assert.equal(verdict.code, 'row_missing');
});

test('more than one row is frozen — the control never guesses which one is real', async () => {
  const verdict = await writeFreeze.admitWrite('/api/log-workout', {
    adapter: adapterReturning([validRow(), validRow({ frozen: true })]),
  });
  assert.equal(verdict.open, false);
  assert.equal(verdict.code, 'row_not_unique');
});

test('a read that does not return an array is frozen', async () => {
  const verdict = await writeFreeze.admitWrite('/api/log-workout', {
    adapter: { readWriteFreeze: async () => ({ frozen: false }) },
  });
  assert.equal(verdict.open, false);
  assert.equal(verdict.code, 'read_malformed');
});

// A MALFORMED ROW IS THE CASE A LOOSER CHECK WOULD MISS. Each of these would pass
// a naive `if (row.frozen)` test and open writes.
for (const [label, row] of [
  ['frozen is null', validRow({ frozen: null })],
  ['frozen is the string "false"', validRow({ frozen: 'false' })],
  ['frozen is absent', (() => { const r = validRow(); delete r.frozen; return r; })()],
  ['id is not the single-row key', validRow({ id: false })],
  ['reason is empty', validRow({ reason: '' })],
  ['set_by is absent', (() => { const r = validRow(); delete r.set_by; return r; })()],
  ['the row is null', null],
]) {
  test(`a malformed row is frozen — ${label}`, async () => {
    const verdict = await writeFreeze.admitWrite('/api/log-workout', { adapter: adapterReturning([row]) });
    assert.equal(verdict.open, false, `${label} must NOT admit a write`);
    assert.equal(verdict.code, 'row_malformed');
  });
}

test('a hung read is frozen at the bound rather than hanging the request', async () => {
  const never = { readWriteFreeze: () => new Promise(() => {}) };
  const started = Date.now();
  const verdict = await writeFreeze.admitWrite('/api/log-workout', { adapter: never });
  assert.equal(verdict.open, false);
  assert.equal(verdict.code, 'read_timeout');
  assert.ok(
    Date.now() - started < writeFreeze.FREEZE_READ_TIMEOUT_MS + 1500,
    'the refusal must arrive at the bound, not when the query eventually gives up'
  );
});

/* ===== §6.2 P11 — a previously open value may never authorize a later write ===== */

test('an earlier successful frozen = false does NOT authorize the next request when its read fails', async () => {
  let calls = 0;
  const flaky = {
    readWriteFreeze: async () => {
      calls += 1;
      if (calls === 1) return [validRow()];              // open, read successfully
      throw new Error('connection terminated unexpectedly');
    },
  };
  const first = await writeFreeze.admitWrite('/api/log-workout', { adapter: flaky });
  assert.equal(first.open, true, 'the first request read the row and may proceed');

  const second = await writeFreeze.admitWrite('/api/log-workout', { adapter: flaky });
  assert.equal(second.open, false, 'THE RACE THIS CONTROL EXISTS TO CLOSE: a retained open value must not admit a write');
  assert.equal(second.code, 'read_failed');
});

test('permission is per request — every admission issues its own read', async () => {
  let calls = 0;
  const counting = { readWriteFreeze: async () => { calls += 1; return [validRow()]; } };
  await writeFreeze.admitWrite('/api/log-workout', { adapter: counting });
  await writeFreeze.admitWrite('/api/log-workout', { adapter: counting });
  await writeFreeze.admitWrite('/api/log-workout', { adapter: counting });
  assert.equal(calls, 3, 'there is no cache; three requests are three reads');
});

test('lifting a freeze takes effect on the next request, with no restart', async () => {
  let frozen = true;
  const live = { readWriteFreeze: async () => [validRow({ frozen })] };
  assert.equal((await writeFreeze.admitWrite('/api/log-workout', { adapter: live })).open, false);
  frozen = false;                                        // the owner runs the UPDATE
  assert.equal((await writeFreeze.admitWrite('/api/log-workout', { adapter: live })).open, true);
});

/* ===== §6.2 P11 — no environment variable and no file can open writes ===== */

test('no environment variable opens writes while the row says frozen', async () => {
  const adapter = adapterReturning([validRow({ frozen: true })]);
  const attempts = {
    ATLAS_WRITE_FREEZE: '0',
    ATLAS_WRITE_FREEZE_OVERRIDE: '1',
    ATLAS_WRITES_OPEN: 'true',
    ATLAS_DISABLE_WRITE_FREEZE: '1',
    ATLAS_SUPABASE_SHADOW_WRITE: '0',
    NODE_ENV: 'development',
  };
  const saved = {};
  for (const [key, value] of Object.entries(attempts)) { saved[key] = process.env[key]; process.env[key] = value; }
  try {
    const verdict = await writeFreeze.admitWrite('/api/log-workout', { adapter });
    assert.equal(verdict.open, false, 'a local override would be a second authority over the same question');
    assert.equal(verdict.code, 'frozen');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('clearing the connection string does NOT disarm a live process — the read simply fails', async () => {
  // Arm the process on a successful read.
  const adapter = adapterReturning([validRow({ frozen: true })]);
  assert.equal((await writeFreeze.admitWrite('/api/log-workout', { adapter })).code, 'frozen');

  // Now remove the configuration the way an "unset it to bypass" attempt would.
  delete process.env[APP_URL];
  const err = new Error('Supabase is not configured for role "app"');
  err.code = 'SUPABASE_NOT_CONFIGURED';
  const verdict = await writeFreeze.admitWrite('/api/log-workout', { adapter: adapterThrowing(err) });
  assert.equal(verdict.open, false, 'arming is monotonic: it can add refusals and can never remove one');
  assert.equal(verdict.armed, true);
});

/* ===== §6.2 P12 — dormant ===== */

test('with no runtime Supabase role configured the control is dormant and writes proceed', async () => {
  delete process.env[APP_URL];
  writeFreeze.__resetArmingForTests();
  const verdict = await writeFreeze.admitWrite('/api/log-workout', {
    adapter: adapterThrowing(new Error('this adapter must never be consulted while dormant')),
  });
  assert.equal(verdict.open, true);
  assert.equal(verdict.armed, false);
  assert.equal(verdict.code, 'not_armed');
});

/* ===== the migration window (the receipt seam's second condition) ===== */

test('the migration window opens ONLY on a proven frozen = true', async () => {
  const open = await writeFreeze.requireFrozenWindow('/api/migration/receipts/export', {
    adapter: adapterReturning([validRow({ frozen: false })]),
  });
  assert.equal(open.allowed, false, 'writes being open means the owner has not opened a migration window');
  assert.equal(open.code, 'open');

  const frozen = await writeFreeze.requireFrozenWindow('/api/migration/receipts/export', {
    adapter: adapterReturning([validRow({ frozen: true })]),
  });
  assert.equal(frozen.allowed, true);
});

test('the migration window stays shut when the freeze read fails, is missing, or is malformed', async () => {
  for (const [label, adapter] of [
    ['a read failure', adapterThrowing(new Error('down'))],
    ['no row', adapterReturning([])],
    ['two rows', adapterReturning([validRow({ frozen: true }), validRow({ frozen: true })])],
    ['a malformed row', adapterReturning([validRow({ frozen: 'true' })])],
  ]) {
    const verdict = await writeFreeze.requireFrozenWindow('/api/migration/receipts/import', { adapter });
    assert.equal(verdict.allowed, false, `${label} must not open the migration window`);
  }
});

test('the migration window is shut while the control is dormant, so the seam is inert', async () => {
  delete process.env[APP_URL];
  writeFreeze.__resetArmingForTests();
  const verdict = await writeFreeze.requireFrozenWindow('/api/migration/receipts/export', {
    adapter: adapterThrowing(new Error('never consulted')),
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'not_armed');
});

/* ===== the refusal body ===== */

test('a refusal states its reason and carries the no-write proof fields', () => {
  const body = writeFreeze.refusalBody({ open: false, armed: true, code: 'frozen', detail: 'cutover window' });
  assert.equal(body.error_code, 'writes_frozen');
  assert.equal(body.freeze_state, 'frozen');
  assert.equal(body.freeze_reason, 'cutover window');
  assert.equal(body.sheet_written, false);
  assert.equal(body.no_write_confirmed, true);
});

test('a control FAILURE does not report the owner reason it never read', () => {
  const body = writeFreeze.refusalBody({ open: false, armed: true, code: 'read_failed', detail: 'connection lost' });
  assert.equal(body.freeze_state, 'read_failed');
  assert.equal(body.freeze_reason, null, 'only a row actually read may supply a reason');
  assert.equal(body.no_write_confirmed, true);
});
