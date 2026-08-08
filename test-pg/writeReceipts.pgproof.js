'use strict';

// §6.1 P8, P8a, P8a0, P8c — the write_receipts state machine.
//
// NOT WIRED IN S2. The file-backed store in services/idempotency.js remains the
// sole receipt authority through S2 and S3; these proofs exist because S2 owns
// the schema and the state machine is a deterministic S2 proof target. S4 wires
// it, adds the foreign keys, and deletes the file store.
//
// The failure this table exists to make impossible: a `write_id` consumed by a
// FAILED attempt. `ON CONFLICT DO NOTHING` would read a failed row as a
// duplicate, so the athlete's retry of a Save that never committed would be
// refused. That is a lost workout, not a protected one.

const test = require('node:test');
const assert = require('node:assert');
const { withOwner, withRole, resetSchema } = require('./support/db');
const adapter = require('../services/supabaseAdapter');
const { SQL } = adapter;

const ROUTE = '/api/log-workout';

test.beforeEach(async () => {
  await resetSchema();
});

test.after(async () => {
  await adapter.close();
});

// Claim through the adapter's real attempt seam, and return the attempt.
async function claim(writeId, route = ROUTE) {
  return adapter.withWriteAttempt(writeId, route, async (attempt) => attempt);
}

test('P8 transition 1: no row → in_progress, attempt 1, a fresh token', async () => {
  const attempt = await claim('w-1');
  assert.equal(attempt.duplicate, false);
  assert.equal(attempt.attempt, 1);
  assert.ok(attempt.attempt_token);
  assert.equal(attempt.session_id, null);
});

test('P8 transition 2: a FAILED attempt does NOT consume the write_id', async () => {
  const first = await claim('w-2');
  assert.equal(await adapter.failWriteReceipt('w-2', first.attempt_token), true);

  const retry = await claim('w-2');
  assert.equal(retry.duplicate, false, 'a failed record is retryable — a prior attempt released without committing');
  assert.equal(retry.attempt, 2);
  assert.notEqual(retry.attempt_token, first.attempt_token);
});

test('P8 transition 3: a STALE in_progress row is retryable once nothing holds its lock', async () => {
  const first = await claim('w-3');
  await withOwner(async (client) => {
    await client.query(
      `UPDATE atlas.write_receipts SET attempt_started_at = now() - interval '10 minutes' WHERE write_id = 'w-3'`
    );
  });
  const retry = await claim('w-3');
  assert.equal(retry.duplicate, false);
  assert.equal(retry.attempt, 2);
  assert.notEqual(retry.attempt_token, first.attempt_token);
});

test('P8 transition 4: a FRESH in_progress row and a COMPLETED row are genuine duplicates', async () => {
  await claim('w-4a');
  const dupe = await claim('w-4a');
  assert.equal(dupe.duplicate, true, 'a fresh in_progress attempt is not abandoned');
  assert.equal(dupe.record.status, 'in_progress');

  const done = await claim('w-4b');
  await adapter.completeWriteReceipt('w-4b', done.attempt_token, { message: 'ok' }, 2, 'A2:L3');
  const replay = await claim('w-4b');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.record.status, 'completed');
  // The exact body replayed to a duplicate retry.
  assert.deepEqual(replay.record.response_body, { message: 'ok' });
  assert.equal(replay.record.rows_written, 2);
});

test('P8: a SUPERSEDED attempt\'s late completeWrite is discarded, not applied', async () => {
  const first = await claim('w-5');
  await adapter.failWriteReceipt('w-5', first.attempt_token);
  const second = await claim('w-5');

  // The first attempt finally comes back, carrying its obsolete token.
  const applied = await adapter.completeWriteReceipt('w-5', first.attempt_token, { stale: true });
  assert.equal(applied, false, 'a stale attempt must not overwrite a newer one');

  await withOwner(async (client) => {
    const { rows } = await client.query(`SELECT status, response_body FROM atlas.write_receipts WHERE write_id = 'w-5'`);
    assert.equal(rows[0].status, 'in_progress');
    assert.equal(rows[0].response_body, null);
  });
  assert.equal(await adapter.completeWriteReceipt('w-5', second.attempt_token, { ok: true }), true);
});

test('P8c: failWrite INVALIDATES the token, so a late completeWrite cannot resurrect a released attempt', async () => {
  const attempt = await claim('w-6');
  await adapter.failWriteReceipt('w-6', attempt.attempt_token);

  // The exact sequence the design names: fail, then late-complete with the SAME
  // token, BEFORE any retry replaces it.
  const resurrected = await adapter.completeWriteReceipt('w-6', attempt.attempt_token, { resurrected: true });
  assert.equal(resurrected, false);

  await withOwner(async (client) => {
    const { rows } = await client.query(`SELECT status, attempt_token FROM atlas.write_receipts WHERE write_id = 'w-6'`);
    assert.equal(rows[0].status, 'failed', 'the failed attempt must not become completed');
    assert.equal(rows[0].attempt_token, null);
  });
});

test('P8a0: a brand-new receipt carries a NON-NULL expires_at and is immediately visible to peekWrite', async () => {
  await claim('w-7');
  // A receipt that is invisible the instant it is created is not a duplicate shield.
  const peeked = await adapter.peekWriteReceipt('w-7');
  assert.ok(peeked, 'peekWrite must see a receipt the moment it is claimed');
  assert.ok(peeked.expires_at instanceof Date);
  assert.ok(peeked.expires_at.getTime() > Date.now());
});

test('P8a0: an EXPIRED COMPLETED row is reclaimed atomically IN THE CLAIM, with attempt and created_at reset', async () => {
  const first = await claim('w-8');
  await adapter.completeWriteReceipt('w-8', first.attempt_token, { old: true });
  await withOwner(async (client) => {
    await client.query(
      `UPDATE atlas.write_receipts
          SET expires_at = now() - interval '1 minute',
              created_at = now() - interval '48 hours'
        WHERE write_id = 'w-8'`
    );
  });

  // NO housekeeping job runs here. The file store prunes synchronously before
  // every beginWrite; filtering on read while deleting on a timer is not the same
  // thing, and the write_id would be wedged until cleanup ran.
  const reclaimed = await claim('w-8');
  assert.equal(reclaimed.duplicate, false, 'an expired row is reclaimable at ANY status');
  assert.equal(reclaimed.attempt, 1, 'prune-then-insert produces a genuinely NEW record');
  assert.equal(reclaimed.session_id, null, 'an expired reclaim starts clean');

  await withOwner(async (client) => {
    const { rows } = await client.query(`SELECT created_at, response_body FROM atlas.write_receipts WHERE write_id = 'w-8'`);
    assert.ok(Date.now() - rows[0].created_at.getTime() < 60_000, 'created_at is reset by a reclaim');
    assert.equal(rows[0].response_body, null);
  });
});

test('P8a: the TTL epoch RESETS on a retry — a receipt first attempted at 23h59m survives its retry window', async () => {
  const first = await claim('w-9');
  await adapter.failWriteReceipt('w-9', first.attempt_token);
  // Age the record to just under 24 hours old, still live.
  await withOwner(async (client) => {
    await client.query(
      `UPDATE atlas.write_receipts
          SET created_at = now() - interval '23 hours 59 minutes',
              attempt_started_at = now() - interval '23 hours 59 minutes',
              expires_at = now() + interval '1 minute'
        WHERE write_id = 'w-9'`
    );
  });

  const retry = await claim('w-9');
  assert.equal(retry.duplicate, false);
  await adapter.completeWriteReceipt('w-9', retry.attempt_token, { ok: true });

  // Advance past the ORIGINAL expiry but well inside 24 hours of the retry. Under
  // a created_at-based predicate the receipt would have vanished a minute later,
  // taking duplicate replay with it.
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT expires_at > now() + interval '20 hours' AS still_live FROM atlas.write_receipts WHERE write_id = 'w-9'`
    );
    assert.equal(rows[0].still_live, true, 'a newly-owned attempt gets a FRESH 24-hour lifetime');
  });
  const peeked = await adapter.peekWriteReceipt('w-9');
  assert.ok(peeked);
  assert.deepEqual(peeked.response_body, { ok: true });
});

test('peekWrite: an expired row reads as ABSENT, exactly as today', async () => {
  await claim('w-10');
  await withOwner(async (client) => {
    await client.query(`UPDATE atlas.write_receipts SET expires_at = now() - interval '1 second' WHERE write_id = 'w-10'`);
  });
  assert.equal(await adapter.peekWriteReceipt('w-10'), null);
});

test('WRITE-2: a LIVE retry preserves the server-minted session_id; an EXPIRED reclaim clears it', async () => {
  const first = await claim('w-11');
  // The ordering the design specifies: claim first, then mint, then persist under
  // the token — so it becomes impossible to mint a server id without first owning
  // the write attempt.
  assert.equal(await adapter.persistReceiptSessionId('w-11', first.attempt_token, '20260808-AM-01'), true);
  // IS NULL means a reused id is never rewritten.
  assert.equal(await adapter.persistReceiptSessionId('w-11', first.attempt_token, '20260808-AM-99'), false);

  await adapter.failWriteReceipt('w-11', first.attempt_token);
  const retry = await claim('w-11');
  assert.equal(retry.session_id, '20260808-AM-01', 'a live retry must reuse the id the prior attempt minted');

  await withOwner(async (client) => {
    await client.query(`UPDATE atlas.write_receipts SET expires_at = now() - interval '1 minute' WHERE write_id = 'w-11'`);
  });
  const reclaimed = await claim('w-11');
  assert.equal(reclaimed.session_id, null, 'an expired reclaim is a NEW logical record and starts clean');
});

test('an obsolete attempt cannot overwrite a newer attempt\'s session_id', async () => {
  const first = await claim('w-12');
  await adapter.failWriteReceipt('w-12', first.attempt_token);
  const second = await claim('w-12');
  assert.equal(await adapter.persistReceiptSessionId('w-12', first.attempt_token, '20260808-AM-55'), false);
  assert.equal(await adapter.persistReceiptSessionId('w-12', second.attempt_token, '20260808-AM-02'), true);
});

// ── The advisory lock: liveness, not a timer ──────────────────────────────────

test('WRITE-3 by its actual mechanism: a stale row whose owner is STILL LIVE is refused', async () => {
  await claim('w-13');
  await withOwner(async (client) => {
    await client.query(
      `UPDATE atlas.write_receipts SET attempt_started_at = now() - interval '30 minutes' WHERE write_id = 'w-13'`
    );
  });

  // Hold the lock on a separate live connection, exactly as a slow in-flight
  // attempt would. A slow request is not a dead one.
  await withRole('atlas_app', async (holder) => {
    const held = await holder.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', ['w-13']);
    assert.equal(held.rows[0].acquired, true);

    const refused = await claim('w-13');
    assert.equal(refused.acquired, false);
    assert.equal(refused.duplicate, true);
    // A FACT about the other process — its connection is open — not a guess from
    // elapsed time. Reclaiming on elapsed time alone proves the OPPOSITE of WRITE-3.
    assert.equal(refused.reason, 'attempt_live_elsewhere');

    await holder.query('SELECT pg_advisory_unlock(hashtext($1))', ['w-13']);
  });

  // Once that connection releases — which is exactly what a process death does —
  // the stale row becomes reclaimable.
  const reclaimed = await claim('w-13');
  assert.equal(reclaimed.duplicate, false);
  assert.equal(reclaimed.attempt, 2);
});

test('the advisory lock is released on EVERY exit path, including a thrown attempt body', async () => {
  await assert.rejects(
    adapter.withWriteAttempt('w-14', ROUTE, async () => {
      throw new Error('the route blew up mid-attempt');
    }),
    /blew up mid-attempt/
  );
  // A lock released only on the happy path leaks on precisely the paths that
  // matter, and a leaked lock would falsely refuse this next claim as a duplicate.
  const after = await claim('w-14');
  assert.equal(after.acquired, true);

  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`
    );
    // Only this test's own claim above may hold one, and that call has returned.
    assert.equal(rows[0].n, 0, 'no advisory lock survives a completed attempt');
  });
});

test('the prune deletes only EXPIRED rows, and nothing waits for it', async () => {
  const live = await claim('w-15');
  await adapter.completeWriteReceipt('w-15', live.attempt_token, { ok: true });
  await claim('w-16');
  await withOwner(async (client) => {
    await client.query(`UPDATE atlas.write_receipts SET expires_at = now() - interval '1 hour' WHERE write_id = 'w-16'`);
  });

  const pruned = await adapter.pruneWriteReceipts('migrate');
  assert.equal(pruned.deleted, 1);
  await withOwner(async (client) => {
    const { rows } = await client.query('SELECT write_id FROM atlas.write_receipts');
    assert.deepEqual(rows.map((r) => r.write_id), ['w-15']);
  });
});

test('the claim executes as atlas_app under its ACTUAL grants, not as a superuser', async () => {
  // The adapter's own connection is the atlas_app credential (run-pg-proof.js
  // sets ATLAS_SUPABASE_APP_URL to it), so every claim above already ran as the
  // real role. This asserts that explicitly rather than leaving it implied.
  await claim('w-17');
  await withRole('atlas_app', async (client) => {
    const { rows } = await client.query('SELECT current_user AS role');
    assert.equal(rows[0].role, 'atlas_app');
  });
  await withOwner(async (client) => {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM atlas.write_receipts WHERE write_id = 'w-17'`);
    assert.equal(rows[0].n, 1);
  });
});

test('the claim statement is a compare-and-set — ON CONFLICT DO NOTHING is not reintroduced', async () => {
  // A textual guard on the exact statement, because the failure mode is silent:
  // DO NOTHING here would consume a write_id on one transient failure, and every
  // behavioural test above would still pass for the completed and fresh cases.
  assert.match(SQL.claimWriteReceipt, /ON CONFLICT \(write_id\) DO UPDATE/);
  assert.doesNotMatch(SQL.claimWriteReceipt, /ON CONFLICT[^)]*\)\s*DO NOTHING/);
  assert.match(SQL.claimWriteReceipt, /status\s*=\s*'failed'/);
  assert.match(SQL.failWriteReceipt, /attempt_token\s*=\s*NULL/);
});
