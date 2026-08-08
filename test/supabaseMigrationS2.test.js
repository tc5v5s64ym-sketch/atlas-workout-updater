'use strict';

// The S2 proofs that need NO database: the row contract, the shadow lane's
// inertness, the divergence writer set, and the migration-safety guard.
//
// The proofs that DO need a real from-empty Postgres database live in test-pg/
// and run under `npm run test:pg` (§6.1 P2). They are outside test/ deliberately:
// `node --test` treats every file under a directory named `test` as a test file,
// so a suite requiring a live database would fail the ordinary `npm test` run on
// any machine without one — and a proof that quietly cannot run is worse than one
// that is missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const contract = require('../services/migrationRowContract');

const ROOT = path.join(__dirname, '..');

// Build a credential-shaped Postgres URI WITHOUT writing one into this file.
//
// Several proofs below need the exact shape the secret scanner exists to catch.
// A complete literal here would be a finding in this very file — the proof would
// fail CI for containing its own evidence. Keeping the '@' separator out of the
// source (it is only ever assembled at run time) means the SOURCE carries no
// credential-shaped string, while the assertion still receives the real one.
// No exemption, no allowlist, and no file gets a blanket pass.
const AT = String.fromCharCode(64);
const FAKE_PROJECT_REF = 'abcdefghijklmnopqrst'; // 20 chars — the project-reference shape
function credentialUri(user, password, host, tail = ':5432/postgres', scheme = 'postgres') {
  return `${scheme}://${user}:${password}${AT}${host}${tail}`;
}

// ── The row contract: §4 mapping, §4.7 blank-versus-null, and identity ────────

test('S2 contract: the session parent is DERIVED from the id contract, never invented', () => {
  assert.deepEqual(contract.parseSessionId('20260808-PM-03'), {
    session_id: '20260808-PM-03',
    session_date: '2026-08-08',
    period: 'PM',
    slot: 3,
  });
  // Anything that is not the YYYYMMDD-{AM|PM}-NN contract yields null rather than
  // a guessed parent, so the shadow write fails closed instead of minting a
  // session row that no allocator ever issued.
  for (const bad of ['GATE-H1', '2026-08-08-PM-03', '20260808-EV-01', '20260808-PM-00', '20260808-PM-1', '', null]) {
    assert.equal(contract.parseSessionId(bad), null, `expected ${JSON.stringify(bad)} to be unparseable`);
  }
});

test('S2 contract: §4.7 rule 1 — a blank numeric or date cell becomes NULL, never 0 and never an epoch', () => {
  const row = contract.rowFromSheet('logged_sets', [
    '', '20260808-AM-01', 'Back Squat', '', '', '', '1', '', '', '', '', '',
  ]);
  assert.equal(row.date_clean, null);
  assert.equal(row.weight, null);
  assert.equal(row.reps, null);
  assert.equal(row.rir, null);
  assert.equal(row.volume_calc, null);
  // A blank target is not a prescription of zero.
  const ledger = contract.rowFromSheet('session_plan_set_recommendations', [
    'k', '20260808-AM-01', '2026-08-08', '1', 'item-1', 'SQ01', '1', '3', '', '', '', 'accepted', '', 'reliable', '', '',
  ]);
  assert.equal(ledger.target_weight, null);
  assert.equal(ledger.target_reps, null);
  assert.equal(ledger.target_rir, null);
  assert.equal(ledger.supersedes_key, null);
  assert.equal(ledger.closeout_write_id, null);
});

test('S2 contract: §4.7 rule 2 — the vocabulary columns keep the EMPTY STRING, which is a member', () => {
  const closeout = contract.rowFromSheet('session_plan_events', [
    'k', '20260808-AM-01', '2026-08-08', '1', 'session_closeout', '', '', '', '', '', '', 'finalized', '',
  ]);
  // '' means "not applicable to this event type". A NULL-everything migration
  // would break exactly this, and plan_item_id feeds the idempotency key, so a
  // NULL there would change the key.
  assert.equal(closeout.outcome, '');
  assert.equal(closeout.plan_item_id, '');
  assert.equal(closeout.closeout_status, 'finalized');
});

test('S2 contract: §4.7 rule 3 — every other blank text cell becomes NULL', () => {
  const row = contract.rowFromSheet('session_effort', ['2026-08-08', '20260808-AM-01', '', '', '', '', '', '', '']);
  assert.equal(row.duration, null);
  assert.equal(row.location, null);
  assert.equal(row.notes, null);
});

test('S2 contract: §4.7 rule 4 — a NULL writes back an EMPTY CELL, so a round trip cannot change meaning', () => {
  const cells = ['2026-08-08', '20260808-AM-01', 'Back Squat', '', '', 'SQ01', '1', '225', '5', '', '', ''];
  const row = contract.rowFromSheet('logged_sets', cells);
  const back = contract.sheetCellsFromRow('logged_sets', row);
  assert.equal(back.length, 12);
  assert.deepEqual(back, ['2026-08-08', '20260808-AM-01', 'Back Squat', '', '', 'SQ01', '1', '225', '5', '', '', '']);
});

test('S2 contract: the export identity key is byte-for-byte the key the Sheets dedupe already builds', () => {
  const cells = ['2026-08-08', '20260808-AM-01', 'Back Squat', '', '', 'SQ01', '3', '225', '5', '2', '', ''];
  const row = contract.rowFromSheet('logged_sets', cells);
  // getLogCompositeKeys(): session_id||exercise||set_number, lower-cased whole.
  assert.equal(contract.identityKey('logged_sets', row), '20260808-am-01||back squat||3');
  // Case and surrounding space cannot produce a second identity for one row.
  const shouty = contract.rowFromSheet('logged_sets', [
    '2026-08-08', ' 20260808-AM-01 ', ' BACK SQUAT ', '', '', 'SQ01', '3', '225', '5', '2', '', '',
  ]);
  assert.equal(contract.identityKey('logged_sets', shouty), '20260808-am-01||back squat||3');
});

test('S2 contract: one Effort row per session IS the identity, and the plan tabs key on their idempotency key', () => {
  assert.equal(
    contract.identityKey('session_effort', contract.rowFromSheet('session_effort', ['2026-08-08', '20260808-AM-01'])),
    '20260808-am-01'
  );
  assert.equal(
    contract.identityKey('session_plan_events', { idempotency_key: '  abc123  ' }),
    'abc123'
  );
});

test('S2 contract: recorded_at is PROVENANCE and is excluded from the content comparison', () => {
  const base = ['k', '20260808-AM-01', '2026-08-08', '1', 'plan_accepted', 'item-1', '1', 'SQ01', 'squat', 'planned', '', '', '2026-08-08T10:00:00Z'];
  const later = [...base];
  later[12] = '2026-08-09T23:59:00Z';
  const comparison = contract.compareRows(
    'session_plan_events',
    contract.rowFromSheet('session_plan_events', base),
    contract.rowFromSheet('session_plan_events', later)
  );
  assert.equal(comparison.equal, true, 'a retry of the same logical event may legitimately differ in recorded_at');
});

test('S2 contract: a genuine difference is reported as SHAPES, never as workout values', () => {
  const sheetsRow = contract.rowFromSheet('logged_sets', [
    '2026-08-08', '20260808-AM-01', 'Back Squat', '', '', 'SQ01', '1', '235', '5', '2', 'top set', '1175',
  ]);
  const supabaseRow = contract.rowFromSheet('logged_sets', [
    '2026-08-08', '20260808-AM-01', 'Back Squat', '', '', 'SQ01', '1', '225', '8', '2', 'top set', '1175',
  ]);
  const comparison = contract.compareRows('logged_sets', sheetsRow, supabaseRow);
  assert.equal(comparison.equal, false);
  assert.deepEqual(comparison.differences.map((d) => d.field), ['weight', 'reps']);
  const serialized = JSON.stringify(comparison.differences);
  // A difference report that quoted the load and the rep count would be workout
  // data sitting in a migration-control table (§3.8).
  assert.equal(serialized.includes('235'), false);
  assert.equal(serialized.includes('225'), false);
  assert.equal(serialized.includes('"8"'), false);
});

test('S2 contract: numeric equality is compared NUMERICALLY, so a Postgres string never reads as a mismatch', () => {
  const fromSheet = contract.rowFromSheet('logged_sets', [
    '2026-08-08', '20260808-AM-01', 'Back Squat', '', '', 'SQ01', '1', '225', '5', '2', '', '1125',
  ]);
  // numeric arrives from the driver as text, and integers as numbers.
  const fromDatabase = contract.rowFromSupabase('logged_sets', {
    date_clean: '2026-08-08', session_id: '20260808-AM-01', exercise: 'Back Squat',
    canonical_exercise: null, muscle_group: null, lift_code: 'SQ01',
    set_number: 1, weight: '225.0', reps: 5, rir: '2.00', notes: null, volume_calc: '1125',
  });
  assert.deepEqual(contract.compareRows('logged_sets', fromSheet, fromDatabase).differences, []);
});

test('S2 contract: a DATE is normalised to its calendar day, so no timezone shifts a workout', () => {
  const fromSheet = contract.rowFromSheet('session_effort', ['2026-08-08', '20260808-AM-01']);
  // The adapter pins the driver's DATE parser to the wire text; this proves the
  // contract is still correct if a Date instance ever reaches it.
  const fromDatabase = contract.rowFromSupabase('session_effort', {
    effort_date: new Date('2026-08-08T00:00:00Z'), session_id: '20260808-AM-01',
  });
  assert.deepEqual(contract.compareRows('session_effort', fromSheet, fromDatabase).differences, []);
});

test('S2 contract: a short Sheets row is a row with blank trailing cells, not an error', () => {
  // Sheets omits trailing empty cells, so the mapper must tolerate it.
  const row = contract.rowFromSheet('logged_sets', ['2026-08-08', '20260808-AM-01', 'Back Squat']);
  assert.equal(row.set_number, null);
  assert.equal(row.notes, null);
});

test('S2 contract: the catalog content hash is order-independent and change-sensitive', () => {
  const header = ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'];
  const a = [header, ['Back Squat', 'Legs', 'SQ01', 'Back Squat'], ['Bench Press', 'Chest', 'BEN01', 'Bench Press']];
  const b = [header, ['Bench Press', 'Chest', 'BEN01', 'Bench Press'], ['Back Squat', 'Legs', 'SQ01', 'Back Squat']];
  const hash = (rows) => contract.catalogContentHash(contract.normalizeCatalogRows(rows));
  assert.equal(hash(a), hash(b), 'row order in the tab is not part of the catalog identity');

  const edited = [header, ['Back Squat', 'Legs', 'SQ02', 'Back Squat'], ['Bench Press', 'Chest', 'BEN01', 'Bench Press']];
  assert.notEqual(hash(a), hash(edited), 'an owner edit MUST change the identity, or the sync could never see it');
});

// ── The shadow lane is inert by default and can never fail a Save ─────────────

function loadShadowFresh() {
  delete require.cache[require.resolve('../services/migrationShadow')];
  delete require.cache[require.resolve('../services/supabaseAdapter')];
  return require('../services/migrationShadow');
}

test('P4/§5.2: with no Supabase configured the shadow lane is DISABLED and does nothing', () => {
  const saved = { url: process.env.ATLAS_SUPABASE_APP_URL, flag: process.env.ATLAS_SUPABASE_SHADOW_WRITE };
  try {
    delete process.env.ATLAS_SUPABASE_APP_URL;
    delete process.env.ATLAS_SUPABASE_SHADOW_WRITE;
    const shadow = loadShadowFresh();
    assert.deepEqual(
      shadow.shadowSave({ sessionId: '20260808-AM-01', logCells: [['2026-08-08', '20260808-AM-01', 'Back Squat']] }),
      { shadow: 'disabled' }
    );
    assert.deepEqual(shadow.shadowPlanEvents([['k', '20260808-AM-01']]), { shadow: 'disabled' });
    assert.deepEqual(shadow.shadowPlanSetSeal('20260808-AM-01', 'w-1'), { shadow: 'disabled' });
  } finally {
    if (saved.url === undefined) delete process.env.ATLAS_SUPABASE_APP_URL;
    else process.env.ATLAS_SUPABASE_APP_URL = saved.url;
    if (saved.flag === undefined) delete process.env.ATLAS_SUPABASE_SHADOW_WRITE;
    else process.env.ATLAS_SUPABASE_SHADOW_WRITE = saved.flag;
    loadShadowFresh();
  }
});

test('P4/§5.2: the FLAG ALONE does not enable the lane — a connection must exist too', () => {
  const saved = { url: process.env.ATLAS_SUPABASE_APP_URL, flag: process.env.ATLAS_SUPABASE_SHADOW_WRITE };
  try {
    delete process.env.ATLAS_SUPABASE_APP_URL;
    process.env.ATLAS_SUPABASE_SHADOW_WRITE = '1';
    const shadow = loadShadowFresh();
    // A flag on an unconfigured deployment would turn every Save into a logged
    // failure for no benefit.
    assert.deepEqual(shadow.shadowSave({ sessionId: '20260808-AM-01', logCells: [[]] }), { shadow: 'disabled' });
  } finally {
    if (saved.url === undefined) delete process.env.ATLAS_SUPABASE_APP_URL;
    else process.env.ATLAS_SUPABASE_APP_URL = saved.url;
    if (saved.flag === undefined) delete process.env.ATLAS_SUPABASE_SHADOW_WRITE;
    else process.env.ATLAS_SUPABASE_SHADOW_WRITE = saved.flag;
    loadShadowFresh();
  }
});

test('P4: a shadow write that THROWS never reaches the caller, and the divergence attempt is best-effort', async () => {
  const shadowPath = require.resolve('../services/migrationShadow');
  const adapterPath = require.resolve('../services/supabaseAdapter');
  const realAdapter = require(adapterPath);
  const saved = require.cache[adapterPath];
  const calls = [];
  require.cache[adapterPath] = {
    id: adapterPath, filename: adapterPath, loaded: true,
    exports: {
      ...realAdapter,
      isShadowWriteEnabled: () => true,
      async shadowSave() { throw new Error('the database is on fire'); },
      async openDivergence(args) { calls.push(args); return { id: 1, created: true }; },
    },
  };
  delete require.cache[shadowPath];
  const shadow = require(shadowPath);
  try {
    // The call is SYNCHRONOUS and returns a descriptor, not a promise the caller
    // could await into the response path.
    const returned = shadow.shadowSave({
      sessionId: '20260808-AM-01',
      logCells: [['2026-08-08', '20260808-AM-01', 'Back Squat', '', '', 'SQ01', '1']],
      route: '/api/log-workout',
      writeId: 'w-1',
    });
    assert.deepEqual(returned, { shadow: 'scheduled' });
    assert.equal(typeof returned.then, 'undefined', 'a route must not be able to await the shadow lane');

    await shadow._drain();
    assert.equal(shadow._counters().failed, 1);
    assert.equal(calls.length, 1, 'the inline divergence is an optimisation, attempted after the failure');
    assert.equal(calls[0].reason, 'shadow_write_failed');
    assert.equal(calls[0].detectedBy, 'inline_shadow');
    // A SHAPE, not the workout: the failure class only.
    assert.deepEqual(calls[0].comparison, { error_class: 'unknown' });
  } finally {
    require.cache[adapterPath] = saved;
    delete require.cache[shadowPath];
    require(shadowPath);
  }
});

test('P4: even a failing INLINE DIVERGENCE cannot escape the lane', async () => {
  const shadowPath = require.resolve('../services/migrationShadow');
  const adapterPath = require.resolve('../services/supabaseAdapter');
  const realAdapter = require(adapterPath);
  const saved = require.cache[adapterPath];
  require.cache[adapterPath] = {
    id: adapterPath, filename: adapterPath, loaded: true,
    exports: {
      ...realAdapter,
      isShadowWriteEnabled: () => true,
      async shadowSave() { throw new Error('primary failure'); },
      async openDivergence() { throw new Error('and the divergence write failed too'); },
    },
  };
  delete require.cache[shadowPath];
  const shadow = require(shadowPath);
  try {
    shadow.shadowSave({ sessionId: '20260808-AM-01', logCells: [['2026-08-08', '20260808-AM-01', 'X', '', '', '', '1']] });
    // No unhandled rejection, no throw. The sweep is the completeness authority
    // precisely so a total failure of this lane costs detection nothing.
    await shadow._drain();
    assert.equal(shadow._counters().failed >= 1, true);
  } finally {
    require.cache[adapterPath] = saved;
    delete require.cache[shadowPath];
    require(shadowPath);
  }
});

test('P4: a SYNCHRONOUS throw inside the lane cannot reach the route either', () => {
  const shadowPath = require.resolve('../services/migrationShadow');
  const adapterPath = require.resolve('../services/supabaseAdapter');
  const realAdapter = require(adapterPath);
  const saved = require.cache[adapterPath];
  require.cache[adapterPath] = {
    id: adapterPath, filename: adapterPath, loaded: true,
    exports: {
      ...realAdapter,
      // The one call the lane makes BEFORE deferring anything. Every caller has
      // already committed rows to Sheets and decided its response, so a throw
      // here would be caught by the route's own error handling and could turn a
      // successful Save into a reported failure.
      isShadowWriteEnabled() { throw new Error('configuration blew up'); },
    },
  };
  delete require.cache[shadowPath];
  const shadow = require(shadowPath);
  try {
    assert.deepEqual(
      shadow.shadowSave({ sessionId: '20260808-AM-01', logCells: [['2026-08-08', '20260808-AM-01', 'X', '', '', '', '1']] }),
      { shadow: 'dispatch_failed' }
    );
  } finally {
    require.cache[adapterPath] = saved;
    delete require.cache[shadowPath];
    require(shadowPath);
  }
});

test('the shadow lane classifies failures into shapes, never into workout content', () => {
  const shadow = require('../services/migrationShadow');
  assert.equal(shadow.classifyError({ code: 'SESSION_ID_UNPARSEABLE' }), 'session_id_unparseable');
  assert.equal(shadow.classifyError(new Error('duplicate key value violates unique constraint "x"')), 'unique_violation');
  assert.equal(shadow.classifyError(new Error('insert violates foreign key constraint')), 'foreign_key_violation');
  assert.equal(shadow.classifyError(new Error('connect ECONNREFUSED 10.0.0.1:5432')), 'unavailable');
});

// ── P7c0: no PERMANENT mechanism writes to migration_divergences ──────────────

test('P7c0: the COMPLETE writer set of atlas.migration_divergences is exactly three temporary modules', () => {
  // The invariant: no permanent or post-S4 mechanism writes to this table. A
  // permanent mechanism writing to a DROPPED table is a defect that only appears
  // after cutover, so the enumeration must be complete for the proof to mean
  // anything. The earlier version of this gate named only two writers.
  const DECLARED_WRITERS = [
    'services/migrationShadow.js', // the inline shadow lane
    'services/migrationSweep.js', // the reconciliation sweep
    'services/migrationRepair.js', // the repair worker (open → repairing → closed)
  ];
  // The adapter is the only holder of the SQL, so a writer is any module that
  // calls one of its divergence-mutating operations.
  const MUTATORS = ['openDivergence', 'claimDivergence', 'releaseDivergence', 'closeDivergence'];

  const sources = [];
  for (const dir of ['services', 'scripts', 'routes', 'config']) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.js')) sources.push(path.join(dir, name));
    }
  }
  sources.push('index.js', 'sheets.js', 'middleware.js', 'response.js');

  const writers = [];
  for (const rel of sources) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    if (rel === 'services/supabaseAdapter.js') continue; // the SQL holder, not a caller
    const text = fs.readFileSync(file, 'utf8');
    const mutates = MUTATORS.some((op) => new RegExp(`\\b(?:adapter|supabase)\\.${op}\\s*\\(`).test(text));
    if (mutates) writers.push(rel);
  }

  assert.deepEqual(
    writers.sort(),
    [...DECLARED_WRITERS].sort(),
    'a module outside the three temporary bridge components writes to atlas.migration_divergences'
  );
});

test('P7c0: the catalog sync and the export-state path do NOT write to migration_divergences', () => {
  // Named individually because these are the two PERMANENT mechanisms an earlier
  // version of the design routed through this table. Post-cutover mirror failures
  // are mirror state and live in the export columns on atlas.workout_sessions.
  for (const rel of ['services/exerciseCatalogMirror.js', 'scripts/atlas-catalog-sync.js']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(/openDivergence|migration_divergences/.test(text), false, `${rel} must not touch the divergence table`);
  }
  const adapter = fs.readFileSync(path.join(ROOT, 'services', 'supabaseAdapter.js'), 'utf8');
  // The export-state statement writes the permanent columns, not a divergence.
  assert.match(adapter, /updateExportState:/);
  assert.match(adapter, /sheets_export_error = \$3/);
});

// ── S2 boundaries the diff itself must keep ──────────────────────────────────

test('S2 boundary: atlas.write_freeze appears in NO migration file — it belongs to S3', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(
      /CREATE TABLE[^;]*write_freeze/i.test(text),
      false,
      `${file} creates atlas.write_freeze; S3 creates it alongside the control that reads it`
    );
  }
});

test('S2 boundary: the migration set declares exactly the eleven tables of §3.1-§3.9', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const created = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of text.matchAll(/CREATE TABLE\s+atlas\.(\w+)/gi)) created.push(match[1]);
  }
  assert.deepEqual(created.sort(), [
    'exercise_catalog_mirror',
    'exercise_catalog_sync',
    'logged_sets',
    'migration_divergences',
    'session_effort',
    'session_plan_events',
    'session_plan_set_recommendations',
    'sheets_mirror_allocations',
    'sheets_mirror_cursor',
    'workout_sessions',
    'write_receipts',
  ]);
});

test('S2 boundary: no migration file sets a role PASSWORD — credentials never enter the repository', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(/PASSWORD\s+'/i.test(text), false, `${file} sets a password; §8.4 forbids a committed credential`);
    assert.match(text.includes('CREATE ROLE') ? text : 'NOLOGIN', /NOLOGIN/);
  }
});

test('S2 boundary: the shadow lane stores NO write_id — the column is not even a parameter', () => {
  const { SQL } = require('../services/supabaseAdapter');
  // §3.6: S2/S3 always store write_id = NULL. A column that is always null makes
  // S4's foreign key addable by construction; one sometimes populated from an
  // authority that does not exist yet does not.
  assert.match(SQL.insertLoggedSet, /write_id\)\s*\n?\s*VALUES[^;]*NULL\)/);
  assert.match(SQL.insertSessionEffort, /write_id\)\s*\n?\s*VALUES[^;]*NULL\)/);
});

test('S2 boundary: the adapter exposes NO generic query escape hatch', () => {
  const adapter = require('../services/supabaseAdapter');
  // §5.2: no generic repository layer, no ORM, no query-builder abstraction. An
  // exported query() would make every caller a second holder of the client.
  for (const forbidden of ['query', 'raw', 'exec', 'sql', 'transaction', 'withClient', 'withTransaction']) {
    assert.equal(typeof adapter[forbidden], 'undefined', `the adapter must not export ${forbidden}()`);
  }
});

test('§8.5 / P10: the migration applier refuses every hosted Supabase host, with no override', () => {
  const { assertTargetAllowed } = require('../scripts/apply-supabase-migrations');
  // Assembled at runtime for the same reason as the scanner fixtures above: a
  // complete hosted connection string written as a literal here would be a
  // finding in this very file.
  for (const host of [
    credentialUri('u', 'p', `db.${FAKE_PROJECT_REF}.supabase.co`),
    credentialUri('u', 'p', 'aws-0-us-west-2.pooler.supabase.com'),
    credentialUri('u', 'p', 'something.supabase.com', ':6543/postgres', 'postgresql'),
  ]) {
    assert.throws(() => assertTargetAllowed(host), (err) => err.code === 'HOSTED_TARGET_REFUSED');
  }
  // A disposable local/CI database is allowed.
  assert.equal(assertTargetAllowed('postgres://postgres:x@127.0.0.1:5432/atlas_proof'), true);
  assert.throws(() => assertTargetAllowed(''), (err) => err.code === 'NO_TARGET');
});

test('§8.5 / P10: the repository-half safety guard passes on this head', () => {
  const { analyze } = require('../scripts/check-supabase-migration-safety');
  assert.deepEqual(analyze(), []);
});

test('§8.5 / P10: the safety guard actually BITES — a synthetic violation fails it', () => {
  // A guard that has never been shown to fail is a comment.
  const guard = fs.readFileSync(path.join(ROOT, 'scripts', 'check-supabase-migration-safety.js'), 'utf8');
  assert.match(guard, /supabase\\s\+db\\s\+push/, 'the hosted-apply command list must include `supabase db push`');
  assert.match(guard, /SUPABASE_ACCESS_TOKEN/, 'the production-secret list must include the CLI access token');

  // And prove the patterns match the text they claim to.
  const { HOSTED_APPLY_COMMANDS, PRODUCTION_SECRET_NAMES } = require('../scripts/check-supabase-migration-safety');
  const offendingWorkflow = 'run: supabase db push --linked\nenv:\n  TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}\n';
  assert.equal(HOSTED_APPLY_COMMANDS.some((p) => p.test(offendingWorkflow)), true);
  assert.equal(PRODUCTION_SECRET_NAMES.some((p) => p.test(offendingWorkflow)), true);
});

// ── The secret scanner learned the Supabase shapes ────────────────────────────

test('§8.4: the secret scanner catches every Supabase credential shape this design can leak', () => {
  const { rules } = require('../scripts/check-changed-files-for-secrets');
  const hits = (text, file = 'some-file.js') => rules.filter((rule) => rule.test(text, file)).map((r) => r.name);

  // EVERY fixture below is ASSEMBLED AT RUNTIME, never written as a literal.
  // These are the exact shapes the scanner exists to catch, so a complete one
  // sitting in this file would be caught by the scanner on this very file — the
  // proof would fail CI for containing its own evidence. Interpolation breaks the
  // pattern in the SOURCE while producing the real shape at RUN TIME, which is
  // where the assertion needs it. No exemption, no allowlist, no file gets a pass.
  const REF = FAKE_PROJECT_REF;
  const PASSWORD = 's3cr3tPassw0rd';
  const KEY_BODY = 'abcdefghijklmnopqrstuvwxyz012345';

  assert.ok(
    hits(`DB=${credentialUri('atlas_app', PASSWORD, 'aws-0-us-west-2.pooler.supabase.com')}`)
      .includes('postgres-connection-string-with-password')
  );
  assert.ok(hits('ATLAS_SUPABASE_APP_URL=postgres://real-value-here/db')
    .includes('supabase-role-url-assignment'));
  // The project reference is treated as a secret, exactly as the production Sheet
  // ID is. Both the host form and the pooler-username form.
  assert.ok(hits(`host: db.${REF}.supabase.co`).includes('supabase-project-reference'));
  assert.ok(hits(`user: postgres.${REF}`).includes('supabase-project-reference'));
  assert.ok(hits(`KEY=sb_secret_${KEY_BODY}`).includes('supabase-api-key'));

  // And it does not fire on the password-less shapes every doc and example uses.
  assert.deepEqual(hits('postgres://localhost:5432/atlas_proof'), []);
  assert.deepEqual(hits('ATLAS_SUPABASE_APP_URL=replace_me', '.env.example'), []);
  assert.deepEqual(hits('# ATLAS_SUPABASE_APP_URL=replace_me'), []);

  // A LOOPBACK credential is deliberately not a finding: it cannot be a
  // production credential, and the repository legitimately carries several.
  assert.deepEqual(hits('postgres://postgres:postgres@127.0.0.1:5432/postgres'), []);
  assert.deepEqual(hits('postgres://nobody:nothing@localhost:1/nonexistent'), []);
  // But a hosted credential in the SAME file shape still fails.
  assert.ok(
    hits(credentialUri('atlas_app', PASSWORD, `db.${REF}.supabase.co`))
      .includes('postgres-connection-string-with-password')
  );
});

// ── The status document cannot report a false zero ────────────────────────────

test('§3.8: atlas:status reports UNOBSERVED rather than a zero-divergence result', () => {
  const { normalizeSupabaseMigration, assembleStatus, ALLOWED_KEYS } = require('../services/atlasStatus');

  const unobserved = normalizeSupabaseMigration(null);
  assert.equal(unobserved.observed, false);
  // The load-bearing assertion: an unread divergence table is UNKNOWN, never a
  // clean zero, and a count that was never taken stays null.
  assert.equal(unobserved.open_divergences, null);
  assert.equal(unobserved.catalog_generation_age_seconds, null);

  // A caller cannot smuggle a count in without claiming it was observed.
  const lying = normalizeSupabaseMigration({ observed: false, open_divergences: 0, catalog_servable: true });
  assert.equal(lying.open_divergences, null);
  assert.equal(lying.catalog_servable, null);

  const observed = normalizeSupabaseMigration({
    observed: true, configured: true, shadow_write_enabled: true,
    open_divergences: 3, oldest_open_divergence_at: '2026-08-08T00:00:00.000Z',
    catalog_generation_age_seconds: 120, catalog_servable: true,
  });
  assert.equal(observed.open_divergences, 3);
  assert.equal(observed.catalog_servable, true);

  // The block is inside the closed redaction whitelist, and an unobserved read is
  // reported as an unavailable source rather than passing silently.
  assert.ok(ALLOWED_KEYS.includes('supabase_migration'));
  const status = assembleStatus({ plan_text: '', test_text: '' });
  assert.ok(Object.keys(status).every((key) => ALLOWED_KEYS.includes(key)));
  assert.equal(status.supabase_migration.observed, false);
  assert.ok(status.unavailable_sources.some((s) => s.source === 'supabase_migration'));
});

test('§8.1/§8.4: the status block carries no credential and no project reference', () => {
  const { normalizeSupabaseMigration } = require('../services/atlasStatus');
  const block = normalizeSupabaseMigration({
    observed: true, configured: true, shadow_write_enabled: false,
    open_divergences: 0, oldest_open_divergence_at: null,
    catalog_generation_age_seconds: 10, catalog_servable: true,
    // A caller passing a connection string must not get it published.
    connection: credentialUri('atlas_app', 'pw', `db.${FAKE_PROJECT_REF}.supabase.co`),
  });
  assert.equal(JSON.stringify(block).includes('supabase.co'), false);
  assert.equal(JSON.stringify(block).includes('atlas_app'), false);
  assert.deepEqual(Object.keys(block).sort(), [
    'catalog_generation_age_seconds', 'catalog_servable', 'configured',
    'observed', 'oldest_open_divergence_at', 'open_divergences', 'reason',
    'shadow_write_enabled',
  ]);
});
