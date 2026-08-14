'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertBackupCoversReceipts,
  verifyCountsMatch,
} = require('../scripts/atlas-supabase-restore-proof');

test('verifyCountsMatch passes when source and target counts agree', () => {
  const counts = {
    write_receipts: 1,
    coaching_notes: 1,
    constraints: 0,
    deload_state: 0,
    modality_log: 0,
    logged_sets: 0,
    workout_sessions: 0,
  };
  assert.equal(verifyCountsMatch(counts, { ...counts }), true);
});

test('verifyCountsMatch fails closed on any table mismatch', () => {
  assert.throws(
    () => verifyCountsMatch({ write_receipts: 1 }, { write_receipts: 0 }),
    (error) => error && error.code === 'RESTORE_COUNT_MISMATCH'
  );
});

test('assertBackupCoversReceipts refuses a backup older than live receipts', () => {
  assert.throws(
    () => assertBackupCoversReceipts({
      backupTakenAtMs: 1000,
      newestReceiptExpiresAtMs: 2000,
    }),
    (error) => error && error.code === 'BACKUP_TOO_OLD'
  );
});

test('assertBackupCoversReceipts accepts a backup that covers receipt obligations', () => {
  assert.equal(assertBackupCoversReceipts({
    backupTakenAtMs: 3000,
    newestReceiptExpiresAtMs: 2000,
  }), true);
});
