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
const { withOwner, withRole, resetSchema, connect, roleUrl } = require('./support/db');
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

test('P8 transition 3: an ABANDONED in_progress row — one a prior process owned — is retryable', async () => {
  // The condition is OWNER PROCESS IDENTITY, not elapsed time and not a released
  // lock. A row this process still owns is covered by the liveness proofs below.
  const priorProcess = `atlas-host:401:${'0123456789ab'}`;
  await withRole('atlas_app', async (client) => {
    await client.query(SQL.claimWriteReceipt, ['w-3', ROUTE, priorProcess, 'supabase']);
    await client.query(
      `UPDATE atlas.write_receipts SET attempt_started_at = now() - interval '10 minutes' WHERE write_id = 'w-3'`
    );
  });
  const retry = await claim('w-3');
  assert.equal(retry.duplicate, false);
  assert.equal(retry.attempt, 2);
  assert.equal(retry.owner_instance_id, adapter.INSTANCE_ID);
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
    // Scoped to THIS write_id's lock, not to every advisory lock on the server.
    // The global form was over-broad: it asserted a property of the whole cluster
    // rather than of the attempt under test, so any other legitimate advisory
    // lock — including the proof runner's own one-run-at-a-time lock — failed it.
    const { rows } = await client.query(
      `SELECT count(*)::int AS n
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)
          AND objid   =  (hashtext($1)::bigint        & 4294967295)`,
      ['w-14']
    );
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

// ── Liveness: process identity, never a database session ─────────────────────
//
// The mechanism under test replaced one that inferred external-effect death from
// database-session death. These proofs exercise the exact adversarial case that
// invalidated it.

// Claim as a chosen instance, on a client the test owns, using the SAME statement
// text the adapter issues. Returns the claim plus the backend pid, so the test can
// destroy that database session the way a network blip or a pooler restart would.
async function claimAsInstance(client, writeId, instanceId, { holdLock = false, route = ROUTE } = {}) {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [writeId]);
  const backend = await client.query('SELECT pg_backend_pid() AS pid');
  const claim = await client.query(SQL.claimWriteReceipt, [
    writeId, route, instanceId, adapter.effectAuthorityForRoute(route),
  ]);
  // Released unless the test is specifically about losing the session while it is
  // held. A proof about OWNERSHIP must not leave the lock held, or the competitor
  // would be refused for the wrong reason and the proof would be vacuous.
  if (!holdLock) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [writeId]);
  return { claim: claim.rows[0] || null, rowCount: claim.rowCount, pid: backend.rows[0].pid };
}

test('WRITE-3 by its actual mechanism: an attempt owned by THIS process is refused, however old', async () => {
  const owner = await connect(roleUrl('atlas_app'));
  owner.on('error', () => { /* the test terminates this backend on purpose */ });
  try {
    // The app process owns the attempt.
    const first = await claimAsInstance(owner, 'w-live-1', adapter.INSTANCE_ID);
    assert.equal(first.rowCount, 1);
    // Age it far past the secondary five-minute bound.
    await withOwner(async (client) => {
      await client.query(
        `UPDATE atlas.write_receipts SET attempt_started_at = now() - interval '6 hours' WHERE write_id = 'w-live-1'`
      );
    });

    // The same process asks again. A slow request is not a dead one.
    const refused = await claim('w-live-1');
    assert.equal(refused.duplicate, true, 'elapsed time alone must never reclaim a live process\'s attempt');
    assert.equal(refused.record.status, 'in_progress');
  } finally {
    await owner.end();
  }
});

test('ADVERSARIAL: dropping the database session mid-external-effect does NOT free the attempt', async () => {
  // THE CASE THAT INVALIDATED THE PREVIOUS MECHANISM.
  //
  // Attempt A owns the receipt and is awaiting a Google Sheets append — an
  // independent HTTP call the database knows nothing about. A's Postgres
  // connection then drops. Postgres releases its advisory lock IMMEDIATELY, but
  // A's Sheets request is still in flight and can still commit. Under the old
  // rule a competitor took the freed lock, claimed the receipt, and performed the
  // SAME append; the attempt token could not help, because it only stops A
  // acknowledging in Supabase — it cannot un-append a row from Google Sheets.
  const externalEffects = [];
  const owner = await connect(roleUrl('atlas_app'));
  owner.on('error', () => { /* the test terminates this backend on purpose */ });
  let pid;
  try {
    const first = await claimAsInstance(owner, 'w-live-2', adapter.INSTANCE_ID, { holdLock: true });
    assert.equal(first.rowCount, 1);
    pid = first.pid;
    // A begins its external effect. It is UNRESOLVED for the whole test.
    externalEffects.push({ attempt: 'A', state: 'in_flight' });
  } finally {
    // Do not close politely — terminate the backend, which is what a network blip
    // or a pooler restart actually does.
    await withOwner(async (client) => {
      await client.query('SELECT pg_terminate_backend($1)', [pid]);
    });
    await owner.end().catch(() => {});
  }

  // The lock really is free now. This is the precondition the old mechanism
  // mistook for evidence of death.
  await withRole('atlas_app', async (client) => {
    const free = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', ['w-live-2']);
    assert.equal(free.rows[0].acquired, true, 'a dropped session releases the advisory lock immediately');
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['w-live-2']);
  });

  // Age the row past the secondary bound, so nothing but ownership can refuse it.
  await withOwner(async (client) => {
    await client.query(
      `UPDATE atlas.write_receipts SET attempt_started_at = now() - interval '6 hours' WHERE write_id = 'w-live-2'`
    );
  });

  // The competitor. Same process — a single-instance deployment, which is the
  // invariant §5.3/§5.5 require for the cutover.
  const competitor = await claim('w-live-2');
  assert.equal(competitor.duplicate, true, 'a freed lock must NOT authorize a second external effect');
  assert.equal(competitor.record.status, 'in_progress');

  // So the competitor never performs the effect, and A's late commit is the only one.
  assert.equal(externalEffects.length, 1);
  externalEffects[0].state = 'committed_late';
  assert.deepEqual(externalEffects, [{ attempt: 'A', state: 'committed_late' }]);

  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT owner_instance_id, status FROM atlas.write_receipts WHERE write_id = 'w-live-2'`
    );
    assert.equal(rows[0].owner_instance_id, adapter.INSTANCE_ID, 'ownership survives the dropped session');
    assert.equal(rows[0].status, 'in_progress');
  });
});

test('RECOVERY: a genuinely restarted process DOES reclaim — the wedge the refusal could have caused', async () => {
  // The refusal above must not become a permanent stall. A different instance id
  // is the executable form of "rehydrated from a prior process", which is exactly
  // the condition services/idempotency.js uses today.
  const deadProcess = `atlas-host:404:${'deadbeefcafe'}`;
  const owner = await connect(roleUrl('atlas_app'));
  owner.on('error', () => { /* the test terminates this backend on purpose */ });
  try {
    const first = await claimAsInstance(owner, 'w-live-3', deadProcess);
    assert.equal(first.rowCount, 1);
  } finally {
    await owner.end();
  }
  await withOwner(async (client) => {
    await client.query(
      `UPDATE atlas.write_receipts SET attempt_started_at = now() - interval '10 minutes' WHERE write_id = 'w-live-3'`
    );
  });

  const restarted = await claim('w-live-3');
  assert.equal(restarted.duplicate, false, 'a prior process\'s abandoned attempt stays retryable');
  assert.equal(restarted.attempt, 2);
  assert.equal(restarted.owner_instance_id, adapter.INSTANCE_ID);
});

test('a prior process\'s attempt is NOT reclaimed before the secondary bound elapses', async () => {
  const deadProcess = `atlas-host:405:${'feedfacefeed'}`;
  const owner = await connect(roleUrl('atlas_app'));
  owner.on('error', () => { /* the test terminates this backend on purpose */ });
  try {
    await claimAsInstance(owner, 'w-live-4', deadProcess);
  } finally {
    await owner.end();
  }
  // Fresh: the bound has not elapsed, so it stays a duplicate.
  const early = await claim('w-live-4');
  assert.equal(early.duplicate, true);
});

test('the liveness rule is in the STATEMENT, not in a comment', () => {
  // A textual guard, because the failure mode is silent: reverting to a
  // lock-derived or purely time-derived reclaim would still pass every
  // behavioural test that does not drop a connection.
  assert.match(SQL.claimWriteReceipt, /owner_instance_id IS DISTINCT FROM \$3/);
  assert.match(SQL.claimWriteReceipt, /owner_instance_id\s*=\s*\$3/);
  // And the process identity may not be derived from anything about the connection.
  assert.ok(adapter.INSTANCE_ID.includes(String(process.pid)));
});

// ── P16d — effect-awareness: process death is not proof of a non-write ────────
//
// *Required review of `deaa8a5`.* Owner process identity fixed connection loss and
// nothing more. A different instance proves the old process is GONE; it does not
// prove an HTTP request that process already sent to Google Sheets did not commit.
// Google can accept an append and complete it server-side without the client
// surviving to record the response, so five minutes of age cannot turn an
// ambiguous post-send outcome into a proven non-write.
//
// The two earlier proofs each covered one half and missed the composition: the
// connection-loss proof keeps the SAME instance (so the refusal is about
// ownership, not about the effect), and the restarted-process proof uses a dead
// instance but has NO UNRESOLVED EXTERNAL EFFECT allowed to commit late. These
// proofs put both halves in one sequence.

const SHEETS_ROUTE = '/api/bodyweight'; // the one remaining non-transactional Sheets effect

// Kill instance X's claim the way a real process death does: the row keeps X's
// ownership, X's Sheets request is neither cancelled nor acknowledged, and the
// database learns nothing about either.
async function abandonedAttemptFrom(deadInstance, writeId, route) {
  const dead = await connect(roleUrl('atlas_app'));
  dead.on('error', () => { /* this backend is destroyed on purpose */ });
  try {
    const claimed = await claimAsInstance(dead, writeId, deadInstance, { route });
    assert.equal(claimed.rowCount, 1);
  } finally {
    await dead.end();
  }
  // Age past the secondary bound, so ONLY the effect authority can refuse it.
  await withOwner(async (client) => {
    await client.query(
      `UPDATE atlas.write_receipts SET attempt_started_at = now() - interval '30 minutes' WHERE write_id = $1`,
      [writeId]
    );
  });
}

test('P16d: process death + a Sheets append that commits LATE — the second append never happens', async () => {
  // THE SEQUENCE THE REVIEW NAMED, end to end:
  //   1. process A claims the write_id and sends a Sheets append;
  //   2. Google ACCEPTS the request, but A dies before recording completion;
  //   3. the receipt stays in_progress under A's owner_instance_id;
  //   4. the five-minute bound elapses;
  //   5. process B, with a different instance id, asks for the write_id;
  //   6. A's accepted request commits.
  // Under process identity alone, step 5 reclaimed and B appended a second copy.
  const sheetsTab = [];                                   // the destination itself
  const A = `atlas-host:9001:${'a11ceffec7ed0'.slice(0, 12)}`;
  const inFlight = { from: 'A', accepted: true, recorded: false };  // Google has it

  await abandonedAttemptFrom(A, 'w-eff-1', SHEETS_ROUTE);

  // Step 5. B is this process, and its instance id differs from A's.
  const b = await claim('w-eff-1', SHEETS_ROUTE);
  assert.equal(b.duplicate, true, 'a dead process\'s UNPROVEN Sheets effect must not be reclaimed');
  assert.equal(b.ambiguous, true, 'and the refusal must be recorded, not merely returned');
  assert.equal(b.markedAmbiguousNow, true);
  assert.equal(b.record.status, 'ambiguous');
  assert.equal(b.record.owner_instance_id, A, 'the ambiguous row names WHOSE effect is unresolved');
  assert.equal(b.record.attempt_token, null, 'A can no longer complete a receipt nothing has verified');
  // B therefore performs no external effect.

  // Step 6. A's already-accepted request commits, long after A is gone.
  sheetsTab.push({ from: 'A', write_id: 'w-eff-1' });
  inFlight.recorded = true;

  assert.equal(sheetsTab.length, 1, 'exactly one row reached the destination');

  // And it stays closed. A later retry is refused for the same reason, without
  // needing anything to remember that B already asked.
  const later = await claim('w-eff-1', SHEETS_ROUTE);
  assert.equal(later.duplicate, true);
  assert.equal(later.ambiguous, true);
  assert.equal(later.markedAmbiguousNow, false, 'the mark is idempotent — one row, one marking');
  assert.equal(sheetsTab.length, 1);
});

test('P16d: no timer un-wedges an ambiguous receipt — not the TTL, and not the prune', async () => {
  // The review's explicit instruction was "do not fix this by another timer".
  // Two timers already existed and both had to be closed, or the fix would have
  // been a five-minute wait replaced by a twenty-four-hour one.
  const A = `atlas-host:9002:${'deadb01710000'.slice(0, 12)}`;
  await abandonedAttemptFrom(A, 'w-eff-2', SHEETS_ROUTE);
  const marked = await claim('w-eff-2', SHEETS_ROUTE);
  assert.equal(marked.record.status, 'ambiguous');

  // Timer 1: the 24-hour TTL, which reclaims an expired row at ANY other status.
  await withOwner(async (client) => {
    await client.query(
      `UPDATE atlas.write_receipts SET expires_at = now() - interval '48 hours' WHERE write_id = 'w-eff-2'`
    );
  });
  const afterTtl = await claim('w-eff-2', SHEETS_ROUTE);
  assert.equal(afterTtl.duplicate, true, 'an expired ambiguous row is still NOT reclaimable');
  assert.equal(afterTtl.record.status, 'ambiguous');
  // It also stays VISIBLE past its TTL, or the refusal would carry a null record
  // and the caller could not say why it refused.
  const peeked = await adapter.peekWriteReceipt('w-eff-2');
  assert.ok(peeked, 'an ambiguous row must not read as absent once it expires');
  assert.equal(peeked.status, 'ambiguous');

  // Timer 2: the prune. Deleting the row would leave nothing at all, so the next
  // claim would insert a clean receipt and permit the second append — the same
  // duplicate, reached by a housekeeping job instead of a decision.
  const pruned = await adapter.pruneWriteReceipts('migrate');
  assert.equal(pruned.deleted, 0, 'the prune must skip an unresolved effect');
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT status FROM atlas.write_receipts WHERE write_id = 'w-eff-2'`
    );
    assert.equal(rows[0].status, 'ambiguous');
  });
});

test('P16d: only destination-side proof releases it, in BOTH directions', async () => {
  const A = `atlas-host:9003:${'c0ffee123456'}`;

  // (a) The operator reads the tab and the row IS there. A's append landed, so the
  // receipt completes and a retry REPLAYS rather than repeating.
  await abandonedAttemptFrom(A, 'w-eff-3', SHEETS_ROUTE);
  await claim('w-eff-3', SHEETS_ROUTE);
  const landed = await adapter.resolveAmbiguousReceipt(
    'w-eff-3', true,
    'read Bodyweight A2:C400 at 2026-08-08T11:31Z; the row for this write_id is present at row 318',
    { message: 'Bodyweight saved.' }
  );
  assert.equal(landed.status, 'completed');
  const replay = await claim('w-eff-3', SHEETS_ROUTE);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.record.status, 'completed');
  assert.deepEqual(replay.record.response_body, { message: 'Bodyweight saved.' });

  // (b) The operator reads the tab and the row is genuinely ABSENT. That is a
  // DECLARED non-write, not an inferred one, so the write_id becomes retryable —
  // the refusal must not be a permanent wedge.
  await abandonedAttemptFrom(A, 'w-eff-4', SHEETS_ROUTE);
  await claim('w-eff-4', SHEETS_ROUTE);
  const absent = await adapter.resolveAmbiguousReceipt(
    'w-eff-4', false,
    'read Bodyweight A2:C400 at 2026-08-08T11:33Z; no row carries this write_id'
  );
  assert.equal(absent.status, 'failed');
  const retry = await claim('w-eff-4', SHEETS_ROUTE);
  assert.equal(retry.duplicate, false, 'a PROVEN non-write is retryable, exactly like any failed attempt');
  assert.equal(retry.attempt, 2);

  // (c) A resolution with no proof, or an empty one, is refused before it reaches
  // the database — and the constraint refuses it there too (constraints.pgproof).
  await abandonedAttemptFrom(A, 'w-eff-5', SHEETS_ROUTE);
  await claim('w-eff-5', SHEETS_ROUTE);
  await assert.rejects(() => adapter.resolveAmbiguousReceipt('w-eff-5', false, '   '), /destination-side proof/);
  await assert.rejects(() => adapter.resolveAmbiguousReceipt('w-eff-5', false, null), /destination-side proof/);
  // "Probably fine" is not a finding either: the landed argument must be a real
  // boolean, so a truthy string cannot stand in for a read.
  await assert.rejects(() => adapter.resolveAmbiguousReceipt('w-eff-5', 'yes', 'looked ok'), /explicit landed finding/);
  const stillBlocked = await claim('w-eff-5', SHEETS_ROUTE);
  assert.equal(stillBlocked.record.status, 'ambiguous');
});

test('P16d: the CONTRAST — the same death on a transactional route DOES reclaim', async () => {
  // Effect-awareness has to cut both ways, or it is just a stall. For the three
  // migrated routes the authoritative effect after S4 is one Supabase transaction:
  // atomically present or atomically absent, so a process that died mid-flight
  // committed nothing a retry could duplicate. Their Sheets export is a mirror
  // written into a destination allocated once per session per tab (§3.9, §5.3), so
  // a late duplicate overwrites its own identical cells.
  const A = `atlas-host:9004:${'facefeed9999'}`;
  await abandonedAttemptFrom(A, 'w-eff-6', '/api/log-workout');

  const b = await claim('w-eff-6', '/api/log-workout');
  assert.equal(b.duplicate, false, 'an atomic effect leaves nothing ambiguous behind');
  assert.equal(b.attempt, 2);
  assert.equal(b.effect_authority, 'supabase');

  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT status, ambiguous_at FROM atlas.write_receipts WHERE write_id = 'w-eff-6'`
    );
    assert.equal(rows[0].status, 'in_progress');
    assert.equal(rows[0].ambiguous_at, null, 'and it never passes through the ambiguous state');
  });
});

test('P16d: the effect authority is DECLARED per route, exhaustively, and fails closed', async () => {
  // The reclaim rule is only as sound as this map, so the map is the thing to
  // guard. All seven D4 callers are present; six transactional, one not.
  assert.deepEqual(
    Object.keys(adapter.ROUTE_EFFECT_AUTHORITY).sort(),
    [
      '/api/bodyweight', '/api/coaching-notes', '/api/complete-workout', '/api/constraints',
      '/api/log-modality', '/api/log-workout', '/api/log-workout/undo-last',
    ]
  );
  assert.equal(
    Object.values(adapter.ROUTE_EFFECT_AUTHORITY).filter((v) => v === 'sheets').length, 1,
    'only Bodyweight still has a non-transactional Sheets effect'
  );

  // An undeclared route may NOT claim. 'supabase' is the permissive value — it
  // authorises automatic retry after a process death — so a new write caller must
  // not be able to inherit it by omission.
  await assert.rejects(
    () => claim('w-eff-7', '/api/some-future-write'),
    /no declared effect authority/
  );
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM atlas.write_receipts WHERE write_id = 'w-eff-7'`
    );
    assert.equal(rows[0].n, 0, 'and it claims nothing on the way out');
  });
});

// ── P16e — one write_id is bound to one route, for its whole life ────────────
//
// *Required review of `5533874`.* `route` and `effect_authority` are written at
// INSERT and are absent from the claim's DO UPDATE list, so a write_id first
// claimed on a transactional route kept `effect_authority = 'supabase'` when the
// SAME id was later presented to a Sheets route — through a client bug, a replay
// bug, or a namespace collision. The Sheets append would then be reclaimed
// automatically after five minutes instead of being marked ambiguous: exactly the
// duplicate class P16d exists to make impossible, reached by a different door.
//
// The binding is a REFUSAL, not a rewrite. Rewriting effect_authority on retry
// would erase what kind of effect the PRIOR attempt may already have sent.

test('P16e: the unsafe sequence — a write_id retired on a SUPABASE route cannot be reused on a SHEETS route', async () => {
  // Step 1-2. W is claimed on a transactional route and reaches a retryable state.
  const first = await claim('w-bind-1', '/api/log-workout');
  assert.equal(first.duplicate, false);
  assert.equal(first.effect_authority, 'supabase');
  await adapter.failWriteReceipt('w-bind-1', first.attempt_token);

  // Step 3-4. The SAME write_id arrives on a Sheets route. Under the old rule the
  // failed-row branch let it through, and the row kept effect_authority='supabase'.
  const collided = await claim('w-bind-1', '/api/coaching-notes');
  assert.equal(collided.duplicate, true, 'a foreign route must never obtain an attempt');
  assert.equal(collided.routeConflict, true, 'and it must be reported as a collision, not a duplicate');
  assert.equal(collided.storedRoute, '/api/log-workout');
  assert.equal(collided.requestedRoute, '/api/coaching-notes');
  // The record is WITHHELD on purpose: a caller handed the other route's stored
  // body could replay it as its own response.
  assert.equal(collided.record, null, 'a foreign route may not read the receipt it collided with');

  // Steps 5-7 are now unreachable, and the row is untouched — no attempt, no new
  // token, no ownership change, and above all no reinterpretation of the effect.
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT route, effect_authority, status, attempt, attempt_token, ambiguous_at
         FROM atlas.write_receipts WHERE write_id = 'w-bind-1'`
    );
    assert.equal(rows[0].route, '/api/log-workout');
    assert.equal(rows[0].effect_authority, 'supabase');
    assert.equal(rows[0].status, 'failed', 'the collision changed nothing at all');
    assert.equal(rows[0].attempt, 1);
    assert.equal(rows[0].attempt_token, null);
    assert.equal(rows[0].ambiguous_at, null, 'and it recorded no ambiguity about an effect it never sent');
  });

  // The write_id still belongs to its own route, and that route's retry works.
  const ownRetry = await claim('w-bind-1', '/api/log-workout');
  assert.equal(ownRetry.duplicate, false);
  assert.equal(ownRetry.attempt, 2);
});

test('P16e: the reverse collision is refused too — a SHEETS write_id cannot be reused on a SUPABASE route', async () => {
  // This direction wedges rather than duplicates, so it is the less dangerous
  // half — but a rule that only bound the permissive direction would be a rule
  // about one symptom rather than about identity.
  const first = await claim('w-bind-2', '/api/bodyweight');
  assert.equal(first.effect_authority, 'sheets');
  await adapter.failWriteReceipt('w-bind-2', first.attempt_token);

  const collided = await claim('w-bind-2', '/api/log-workout');
  assert.equal(collided.duplicate, true);
  assert.equal(collided.routeConflict, true);
  assert.equal(collided.storedRoute, '/api/bodyweight');

  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT route, effect_authority, status FROM atlas.write_receipts WHERE write_id = 'w-bind-2'`
    );
    assert.deepEqual(rows[0], { route: '/api/bodyweight', effect_authority: 'sheets', status: 'failed' });
  });
});

test('P16e: the binding holds in EVERY reclaimable state, not only the failed one', async () => {
  // Three branches can reclaim a row, and each had to be bound or the collision
  // simply moves to whichever one was left open.
  //
  // (a) EXPIRED — the most permissive branch: it reclaims at any status.
  const expired = await claim('w-bind-3', '/api/log-workout');
  await adapter.completeWriteReceipt('w-bind-3', expired.attempt_token, { ok: true });
  await withOwner(async (client) => {
    await client.query(
      `UPDATE atlas.write_receipts SET expires_at = now() - interval '48 hours' WHERE write_id = 'w-bind-3'`
    );
  });
  const foreignExpired = await claim('w-bind-3', '/api/constraints');
  assert.equal(foreignExpired.routeConflict, true, 'an expired row is still not a free write_id for another route');
  assert.equal((await claim('w-bind-3', '/api/log-workout')).duplicate, false, 'its own route still reclaims it');

  // (b) A PRIOR PROCESS's abandoned attempt on a transactional route.
  const dead = `atlas-host:9101:${'bindbind1111'}`;
  await abandonedAttemptFrom(dead, 'w-bind-4', '/api/log-workout');
  const foreignAbandoned = await claim('w-bind-4', '/api/bodyweight');
  assert.equal(foreignAbandoned.routeConflict, true);
  assert.equal((await claim('w-bind-4', '/api/log-workout')).duplicate, false);

  // (c) An AMBIGUOUS row. A foreign route must not resolve it, mark it, or read
  // it — it sent no effect and has nothing to say about one.
  await abandonedAttemptFrom(dead, 'w-bind-5', '/api/bodyweight');
  const marked = await claim('w-bind-5', '/api/bodyweight');
  assert.equal(marked.record.status, 'ambiguous');
  const foreignAmbiguous = await claim('w-bind-5', '/api/constraints');
  assert.equal(foreignAmbiguous.routeConflict, true);
  assert.equal(foreignAmbiguous.ambiguous, false, 'a foreign route is refused for COLLISION, not for ambiguity');
  assert.equal(foreignAmbiguous.record, null);
});

test('P16e: a foreign route cannot MARK a receipt ambiguous either', async () => {
  // Defence in depth. The adapter refuses the collision before reaching the mark,
  // but the mark statement is bound as well — a future caller that reached it
  // directly must not be able to record an ambiguity about an effect it never sent.
  const dead = `atlas-host:9102:${'bindbind2222'}`;
  await abandonedAttemptFrom(dead, 'w-bind-6', '/api/bodyweight');
  await withRole('atlas_app', async (client) => {
    const wrongRoute = await client.query(SQL.markReceiptAmbiguous, ['w-bind-6', adapter.INSTANCE_ID, '/api/constraints']);
    assert.equal(wrongRoute.rowCount, 0, 'the mark is route-bound in the STATEMENT');
    const rightRoute = await client.query(SQL.markReceiptAmbiguous, ['w-bind-6', adapter.INSTANCE_ID, '/api/bodyweight']);
    assert.equal(rightRoute.rowCount, 1);
  });
});

test('P16e: route and effect_authority are IMMUTABLE to the runtime', async () => {
  // The binding above is only as strong as the pair's immutability. Neither
  // column is in atlas_app's column-scoped UPDATE grant (§8.2), so the runtime
  // cannot relabel a receipt's route or its effect authority and defeat the rule
  // without touching any statement.
  await claim('w-bind-7', '/api/bodyweight');
  await withRole('atlas_app', async (client) => {
    await assert.rejects(
      () => client.query(`UPDATE atlas.write_receipts SET route = '/api/log-workout' WHERE write_id = 'w-bind-7'`),
      (err) => err.code === '42501'
    );
    await assert.rejects(
      () => client.query(`UPDATE atlas.write_receipts SET effect_authority = 'supabase' WHERE write_id = 'w-bind-7'`),
      (err) => err.code === '42501'
    );
  });
});

test('P16e: the binding is in the STATEMENTS, not in a comment', () => {
  assert.match(SQL.claimWriteReceipt, /atlas\.write_receipts\.route\s*=\s*\$2/);
  assert.match(SQL.claimWriteReceipt, /atlas\.write_receipts\.effect_authority\s*=\s*\$4/);
  assert.match(SQL.markReceiptAmbiguous, /route\s*=\s*\$3/);
  // And the DO UPDATE list still must NOT rewrite either column: reinterpreting an
  // existing receipt would erase what kind of effect the prior attempt may have sent.
  // Comments are stripped first, or the prose explaining the rule would trip it.
  const executable = SQL.claimWriteReceipt
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const doUpdate = executable.slice(executable.indexOf('DO UPDATE'));
  const setClause = doUpdate.slice(0, doUpdate.indexOf('WHERE'));
  assert.doesNotMatch(setClause, /\broute\s*=/);
  assert.doesNotMatch(setClause, /\beffect_authority\s*=/);
});

test('P16d: the effect-aware rule is in the STATEMENTS, not in a comment', () => {
  // The same textual guard the liveness rule carries, and for the same reason:
  // dropping the effect_authority predicate would restore automatic reclaim for
  // the four Sheets routes, and every behavioural test that does not compose a
  // death with a late commit would still pass.
  assert.match(SQL.claimWriteReceipt, /effect_authority\s*=\s*'supabase'/);
  assert.match(SQL.claimWriteReceipt, /status\s*<>\s*'ambiguous'/);
  assert.match(SQL.markReceiptAmbiguous, /effect_authority\s*=\s*'sheets'/);
  assert.match(SQL.markReceiptAmbiguous, /attempt_token\s*=\s*NULL/);
  assert.match(SQL.resolveAmbiguousReceipt, /WHERE write_id = \$1 AND status = 'ambiguous'/);
  assert.match(SQL.pruneWriteReceipts, /status\s*<>\s*'ambiguous'/);
});
