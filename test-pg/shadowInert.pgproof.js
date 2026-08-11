'use strict';

// §6.1 P3 — THE SHADOW WRITE IS PROVEN INERT, against a real database.
//
// P3 asks for a browser-level test showing the athlete-facing response is
// byte-identical with the shadow write enabled and disabled. That gate is
// discharged in two rungs, and both are needed:
//
//   • tests/e2e/supabase-shadow-inert.spec.js — the BROWSER rung. It drives the
//     real UI against the real server and compares the response the client
//     actually receives, with the lane off and with the lane on. It runs in the
//     ordinary Playwright job, with no database, so the "on" case there is a
//     shadow that FAILS.
//   • this file — the DATABASE rung. It runs the same real route through the real
//     app with the lane on and SUCCEEDING against the from-empty Postgres
//     database, which the browser job cannot do. Without it, "enabled" would only
//     ever have meant "enabled and broken".
//
// Byte-identity is asserted after normalising exactly three envelope fields that
// are non-deterministic by construction — requestId, duration_ms, and timestamp.
// Everything else, including every proof field, is compared verbatim.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withOwner, resetSchema } = require('./support/db');
const adapter = require('../services/supabaseAdapter');

const CHILD = path.join(__dirname, 'support', 'deathChild.js');
const SESSION = '20260808-PM-09';
const DATE = '2026-08-08';

test.beforeEach(async () => {
  await resetSchema();
});

test.after(async () => {
  await adapter.close();
});

// One Save through the real route, in its own process with its own isolated
// Sheets file and receipt store, under the given shadow posture.
function saveOnce(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-inert-'));
  const child = spawnSync(process.execPath, [CHILD], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      ATLAS_DEATH_SHEETS_FILE: path.join(dir, 'sheets.json'),
      ATLAS_DEATH_SESSION_ID: SESSION,
      ATLAS_DEATH_DATE: DATE,
      ATLAS_DEATH_MODE: 'survive',
      // A distinct write_id and receipt store per run, or the second Save would
      // replay the first as a duplicate and the comparison would be vacuous.
      ATLAS_DEATH_WRITE_ID: `inert-${path.basename(dir)}`,
      ATLAS_IDEMPOTENCY_FILE: path.join(dir, 'idempotency.json'),
      ...extraEnv,
    },
    timeout: 60_000,
  });
  assert.equal(child.status, 0, `the Save must succeed; stdout:\n${child.stdout}\n${child.stderr}`);
  const line = child.stdout.split('\n').find((l) => l.startsWith('RESPONSE '));
  assert.ok(line, `no response line; stdout:\n${child.stdout}`);
  const status = Number(line.slice('RESPONSE '.length, line.indexOf(' ', 'RESPONSE '.length)));
  const raw = line.slice(line.indexOf(' ', 'RESPONSE '.length) + 1);
  return { status, raw };
}

// Exactly four fields are normalised, and each is non-deterministic for a reason
// that has nothing to do with the shadow lane. ANYTHING ELSE differing is a real
// difference and must fail this proof.
//
//   requestId / duration_ms / timestamp — per-request envelope values;
//   write_id — varied BY THIS HARNESS on purpose. The two runs must not share
//              one, or the second Save would replay the first as a duplicate and
//              the comparison would be vacuous. The value is echoed back in the
//              body, so it is normalised rather than allowed to mask a genuine
//              difference elsewhere.
function normalize(raw) {
  return raw
    .replace(/"requestId":"[^"]*"/g, '"requestId":"<normalized>"')
    .replace(/"duration_ms":\d+/g, '"duration_ms":<normalized>')
    .replace(/"timestamp":"[^"]*"/g, '"timestamp":"<normalized>"')
    .replace(/"write_id":"inert-[^"]*"/g, '"write_id":"<normalized>"');
}

test('P3: the response is BYTE-IDENTICAL with the shadow write disabled and enabled-and-succeeding', async () => {
  const off = saveOnce({ ATLAS_SUPABASE_SHADOW_WRITE: '0' });
  await resetSchema();
  const on = saveOnce({ ATLAS_SUPABASE_SHADOW_WRITE: '1' });

  assert.equal(off.status, 200);
  assert.equal(on.status, 200);
  assert.equal(normalize(on.raw), normalize(off.raw));

  // And the "on" run genuinely wrote — otherwise this proves the lane is absent,
  // not that it is inert.
  await withOwner(async (client) => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM atlas.logged_sets');
    assert.equal(rows[0].n, 2, 'the enabled run must actually have mirrored the Save');
  });
});

// ── HOW A SHADOW FAILURE IS PRODUCED, AND WHY IT CHANGED AT S3 ────────────────
//
// This test used to point the adapter at an unreachable database. Until S3 that
// meant exactly one thing: the shadow write fails. From S3 on it means TWO, because
// the seven beginWrite routes read atlas.write_freeze before any side effect and
// refuse when that read fails (§5.3, owner ruling D7) — so an unreachable database
// would refuse the Save and this test would be measuring the freeze, not the shadow.
//
// The database therefore stays REACHABLE and the shadow write is broken a different
// way: atlas_app's INSERT on logged_sets is revoked for the duration. That is a
// genuine, total shadow failure — the parent row inserts, the child insert is
// refused with 42501, and the whole shadow transaction rolls back — while the
// freeze read succeeds and admits the write, which is the condition P3 is about.
//
// It is also a stronger failure than unreachability: it proves the athlete is
// unaffected by a shadow write that fails HALFWAY THROUGH ITS OWN TRANSACTION.
async function withShadowWriteBroken(fn) {
  await withOwner((client) => client.query('REVOKE INSERT ON atlas.logged_sets FROM atlas_app'));
  try {
    return fn();
  } finally {
    await withOwner((client) => client.query('GRANT INSERT ON atlas.logged_sets TO atlas_app'));
  }
}

async function mirroredRowCount() {
  return withOwner(async (client) => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM atlas.logged_sets');
    return rows[0].n;
  });
}

test('P3: the response is BYTE-IDENTICAL when the shadow write FAILS outright', async () => {
  const off = saveOnce({ ATLAS_SUPABASE_SHADOW_WRITE: '0' });

  // Measured either side of the broken run, so the claim is "this run mirrored
  // NOTHING" rather than "the table happens to be empty" — which would depend on
  // what every earlier statement in this file left behind.
  const before = await mirroredRowCount();
  const broken = await withShadowWriteBroken(() => saveOnce({ ATLAS_SUPABASE_SHADOW_WRITE: '1' }));
  const after = await mirroredRowCount();

  assert.equal(broken.status, 200, `the Save must succeed from Sheets alone:\n${broken.raw}`);
  assert.equal(normalize(broken.raw), normalize(off.raw));
  assert.equal(after, before,
    'a shadow write that silently succeeded would make this proof vacuous — it must have failed outright');
});

test('P3: no proof field, status code, or visible claim mentions the shadow lane', () => {
  const { raw, status } = saveOnce({ ATLAS_SUPABASE_SHADOW_WRITE: '1' });
  assert.equal(status, 200);
  const lower = raw.toLowerCase();
  for (const leak of ['supabase', 'shadow', 'divergence', 'postgres', 'mirror']) {
    assert.equal(lower.includes(leak), false, `the athlete-facing response leaked "${leak}"`);
  }
  const body = JSON.parse(raw);
  // The W1-W3 proof fields are untouched and still come from the Sheets append.
  assert.equal(body.data.sheet_write, 'success');
  assert.equal(body.data.test_mode, false);
  assert.equal(body.data.log_rows_written, 2);
});
