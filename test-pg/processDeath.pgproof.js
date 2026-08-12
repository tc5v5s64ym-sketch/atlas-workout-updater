'use strict';

// §6.1 P5 — PROCESS DEATH IN THE EXACT WINDOW IS PROVEN DETECTABLE.
//
// "Kill the process after the Sheets append returns success and before the
// shadow write; restart; run the sweep; assert the omission is found, repaired,
// and closed with a passing re-comparison."
//
// This is the load-bearing S2 failure, and it is the one the design's first
// review found unclosed. The shadow write runs after the athlete-facing response
// is decided, so a death in that window leaves Supabase short the rows AND leaves
// the open-divergence count reading zero — a clean-looking migration with a
// missing workout in it.
//
// The fix is that NOTHING here depends on anything the dying process was supposed
// to write. The sweep re-derives the fact from Google Sheets, which is the live
// write authority throughout S2 and therefore holds every committed row. A test
// that only shows the sweep works on a tidy database does not discharge this.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// See test-pg/support/syntheticIdentityMap.js — the frozen exact-duplicate approvals
// describe production content a synthetic workbook cannot hold, and they fail closed.
require('./support/syntheticIdentityMap');

const { withOwner, resetSchema } = require('./support/db');
const adapter = require('../services/supabaseAdapter');
const { runSweep } = require('../services/migrationSweep');
const { runRepair } = require('../services/migrationRepair');

const CHILD = path.join(__dirname, 'support', 'deathChild.js');
const SESSION = '20260808-AM-11';
const DATE = '2026-08-08';

let sheetsFile;
let idempotencyFile;
let writeId;

test.beforeEach(async () => {
  await resetSchema();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-death-'));
  sheetsFile = path.join(dir, 'sheets.json');
  idempotencyFile = path.join(dir, 'idempotency.json');
  writeId = `death-proof-${path.basename(dir)}`;
});

test.after(async () => {
  await adapter.close();
});

function runChild(mode, extraEnv = {}) {
  return spawnSync(process.execPath, [CHILD], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      ATLAS_DEATH_SHEETS_FILE: sheetsFile,
      ATLAS_DEATH_SESSION_ID: SESSION,
      ATLAS_DEATH_DATE: DATE,
      ATLAS_DEATH_MODE: mode,
      ATLAS_DEATH_WRITE_ID: writeId,
      // The file-backed receipt store is process-adjacent /tmp state and is
      // SHARED between child processes by default. Left alone, the second run's
      // Save replays the first run's completed receipt, appends nothing, and
      // never reaches the shadow write — so the proof would silently stop
      // exercising the window it exists for.
      ATLAS_IDEMPOTENCY_FILE: idempotencyFile,
      ...extraEnv,
    },
    timeout: 60_000,
  });
}

// The Sheets state that survived the death, presented to the sweep exactly as
// the real sheets.js would present it.
function survivingSheets() {
  const tabs = JSON.parse(fs.readFileSync(sheetsFile, 'utf8'));
  return {
    async getSheetRows(tab) {
      return tabs[tab] || [];
    },
    _tabs: tabs,
  };
}

test('P5: the process dies in the exact window, and the Sheets rows survive it', async () => {
  const child = runChild('die');
  assert.equal(child.status, 9, `child should have died in the window; stdout:\n${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /DIED_IN_WINDOW/);

  const sheets = survivingSheets();
  const logRows = sheets._tabs.Log_Cleaned || [];
  // The athlete's workout IS committed to the live authority.
  assert.equal(logRows.length, 2, 'both sets reached Google Sheets before the death');
  assert.equal(logRows[0][1], SESSION);

  // And Supabase has nothing — not even a session parent.
  await withOwner(async (client) => {
    const sessions = await client.query('SELECT count(*)::int AS n FROM atlas.workout_sessions');
    const sets = await client.query('SELECT count(*)::int AS n FROM atlas.logged_sets');
    assert.equal(sessions.rows[0].n, 0);
    assert.equal(sets.rows[0].n, 0);
  });

  // THE DEFECT THIS GATE EXISTS FOR: the divergence count reads zero, because the
  // dying process never got to write the inline record either. Anything that
  // trusted the inline lane would report a healthy migration right here.
  const summary = await adapter.divergenceSummary();
  assert.equal(summary.open_count, 0, 'the inline lane cannot have recorded anything — the process was dead');
});

test('P5: the sweep finds the omission INDEPENDENTLY of the dying process', async () => {
  const child = runChild('die');
  assert.equal(child.status, 9);

  const sheets = survivingSheets();
  // The sweep depends on no in-flight state, no queue, and no record the crashed
  // process was meant to write — only on the live write authority.
  const swept = await runSweep({ sheets, adapter, includeCatalog: false });
  assert.equal(swept.complete, true);
  assert.equal(swept.totals.missing_in_supabase, 2, 'both committed sets are detected as missing');

  const open = await adapter.listOpenDivergences(50);
  assert.equal(open.length, 2);
  for (const divergence of open) {
    assert.equal(divergence.concept, 'logged_sets');
    assert.equal(divergence.reason, 'missing_in_supabase');
    assert.equal(divergence.detected_by, 'sweep');
    assert.equal(divergence.session_id, SESSION);
  }
});

test('P5: the omission is repaired and CLOSED with a passing re-comparison', async () => {
  const child = runChild('die');
  assert.equal(child.status, 9);

  const sheets = survivingSheets();
  await runSweep({ sheets, adapter, includeCatalog: false });
  const repaired = await runRepair({ sheets, adapter });

  assert.equal(repaired.examined, 2);
  assert.equal(repaired.closed, 2);
  assert.equal(repaired.left_open, 0);
  assert.equal(repaired.open_after, 0);

  await withOwner(async (client) => {
    // The session PARENT was created by the repair, parent-first, in the same
    // transaction as its child — the schema starts empty and the backfill is S3's.
    const parent = await client.query('SELECT session_id, period, slot FROM atlas.workout_sessions');
    assert.deepEqual(parent.rows, [{ session_id: SESSION, period: 'AM', slot: 11 }]);

    const sets = await client.query('SELECT set_number, weight, write_id FROM atlas.logged_sets ORDER BY set_number');
    assert.deepEqual(sets.rows.map((r) => r.set_number), [1, 2]);
    // The sweep genuinely cannot know the write_id — Log_Cleaned has no such
    // column — so it stores NULL rather than fabricating one.
    assert.deepEqual(sets.rows.map((r) => r.write_id), [null, null]);

    const divergences = await client.query(
      'SELECT state, closure_proof, closed_at FROM atlas.migration_divergences ORDER BY id'
    );
    for (const row of divergences.rows) {
      assert.equal(row.state, 'closed');
      assert.ok(row.closed_at);
      // Never a timestamp alone: the proof names the re-comparison that earned it.
      assert.match(row.closure_proof, /^recompare: identity=.* present in both stores/);
    }
  });

  // And a second sweep over the repaired state is a genuine, COMPLETE zero.
  const final = await runSweep({ sheets, adapter, includeCatalog: false });
  assert.equal(final.complete, true);
  assert.equal(final.divergences_found, 0);
});

test('P5 control: with the shadow write intact, the same Save mirrors and the sweep is clean first time', async () => {
  // The negative that makes the positive mean something: the harness is not
  // simply failing to mirror. Same child, same route, same rows — the only
  // difference is that the process survives the shadow write.
  const child = runChild('survive');
  assert.equal(child.status, 0, `child should have completed; stdout:\n${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /RESPONSE 200/);

  await withOwner(async (client) => {
    const sets = await client.query('SELECT count(*)::int AS n FROM atlas.logged_sets');
    assert.equal(sets.rows[0].n, 2, 'the shadow write mirrored the Save');
  });

  const swept = await runSweep({ sheets: survivingSheets(), adapter, includeCatalog: false });
  assert.equal(swept.complete, true);
  assert.equal(swept.divergences_found, 0);
});

test('P5: Sheets remains the response authority even when the shadow path fails outright', async () => {
  // ── HOW THE SHADOW IS BROKEN, AND WHY IT CHANGED AT S3 ─────────────────────
  //
  // This used to point the adapter at a database that does not exist. Until S3
  // that meant only "the shadow write fails"; from S3 on it ALSO means the write
  // is refused, because the seven beginWrite routes read atlas.write_freeze before
  // any side effect and refuse when that read fails (§5.3, owner ruling D7).
  // Measuring the freeze here would silently stop measuring the shadow.
  //
  // So the database stays REACHABLE — the freeze read succeeds and admits — and
  // atlas_app's INSERT on logged_sets is revoked instead. The shadow transaction
  // then fails partway through and rolls back, which is a stricter failure than
  // never connecting at all.
  await withOwner((client) => client.query('REVOKE INSERT ON atlas.logged_sets FROM atlas_app'));
  let child;
  try {
    child = runChild('survive');
  } finally {
    await withOwner((client) => client.query('GRANT INSERT ON atlas.logged_sets TO atlas_app'));
  }

  assert.equal(child.status, 0, `the Save must not fail with the shadow path down; stdout:\n${child.stdout}\n${child.stderr}`);
  const line = child.stdout.split('\n').find((l) => l.startsWith('RESPONSE '));
  assert.ok(line, 'the route answered');
  assert.match(line, /^RESPONSE 200 /);
  const body = JSON.parse(line.slice('RESPONSE 200 '.length));
  // No shadow failure leaks into the athlete-facing response, its status, or its
  // proof fields.
  assert.equal(body.data.sheet_write, 'success');
  assert.equal(body.data.log_rows_written, 2);
  assert.equal(JSON.stringify(body).toLowerCase().includes('supabase'), false);
  assert.equal(JSON.stringify(body).toLowerCase().includes('shadow'), false);

  // The rows are on the live authority, and the sweep will find the omission
  // later — which is exactly the intended division of labour.
  const tabs = JSON.parse(fs.readFileSync(sheetsFile, 'utf8'));
  assert.equal((tabs.Log_Cleaned || []).length, 2);
});
