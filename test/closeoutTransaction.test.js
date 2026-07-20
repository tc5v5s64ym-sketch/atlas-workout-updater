'use strict';

// CloseoutTransaction contract — Phase 2 Work item 2 (docs/CANONICAL_CONTRACTS.md).
//
// The atomic session-closeout write as one proven transaction: log_rows (sets) +
// effort_row + seal (plan closeout) + the trust-loop proof envelope. Pure builder
// + total validator + a boundary adapter over closeoutSummary. Read-only; not yet
// wired (Phase 5g consumes it). The W1/W3 proof invariants (docs/INVARIANTS.md §2)
// are enforced by the validator.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  buildCloseoutTransaction,
  validateCloseoutTransaction,
  fromCloseoutSummary,
  SHEET_WRITE_STATES,
  _resetForTesting,
} = require('../services/closeoutTransaction');

beforeEach(() => _resetForTesting());

// a valid DRY-RUN transaction (W1: nothing written)
const dryRun = () => ({
  schema_version: SCHEMA_VERSION,
  session_id: 's_2026_07_20',
  session_date: '2026-07-20',
  test_mode: true,
  log_rows: [{ exercise: 'Bench', weight: 185, reps: 5 }],
  effort_row: { duration: 42, average_hr: 130, peak_hr: 165 },
  seal: { count: 2, already_sealed: 0 },
  proof: { sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true, log_rows_written: null, logAppendedRange: null },
});

// a valid LIVE SUCCESS transaction — the REAL POST /api/log-workout success shape
// (index.js): sheet_write='success' + log_rows_written + logAppendedRange, and it
// does NOT emit sheet_written/no_write_confirmed (so they are null here).
const liveSuccess = () => ({
  schema_version: SCHEMA_VERSION,
  session_id: 's_2026_07_20',
  session_date: '2026-07-20',
  test_mode: false,
  log_rows: [{ exercise: 'Bench', weight: 185, reps: 5 }],
  effort_row: null,
  seal: { count: 2, already_sealed: 0 },
  proof: { sheet_write: 'success', sheet_written: null, no_write_confirmed: null, log_rows_written: 3, logAppendedRange: 'Log_Cleaned!A2:L4' },
});

describe('buildCloseoutTransaction', () => {
  it('stamps schema_version; defaults session_date/effort null, log_rows [], seal counts 0, proof nullables null', () => {
    const tx = buildCloseoutTransaction({ session_id: 's1', test_mode: true, proof: { sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true } });
    assert.equal(tx.schema_version, SCHEMA_VERSION);
    assert.equal(tx.session_date, null);
    assert.deepEqual(tx.log_rows, []);
    assert.equal(tx.effort_row, null);
    assert.deepEqual(tx.seal, { count: 0, already_sealed: 0 });
    assert.equal(tx.proof.log_rows_written, null);
    assert.equal(tx.proof.logAppendedRange, null);
  });
  it('does not invent test_mode (fails validation when unspecified — fail closed, W2)', () => {
    const tx = buildCloseoutTransaction({ session_id: 's1', proof: {} });
    assert.equal(tx.test_mode, undefined);
    assert.equal(validateCloseoutTransaction(tx).valid, false);
  });
  it('tolerates junk input without throwing', () => {
    assert.deepEqual(buildCloseoutTransaction(undefined).log_rows, []);
    assert.equal(buildCloseoutTransaction(null).session_id, undefined);
  });
});

describe('validateCloseoutTransaction — shape', () => {
  it('accepts a valid dry-run and a valid live-success transaction', () => {
    assert.equal(validateCloseoutTransaction(dryRun()).valid, true, validateCloseoutTransaction(dryRun()).errors.join(' | '));
    assert.equal(validateCloseoutTransaction(liveSuccess()).valid, true, validateCloseoutTransaction(liveSuccess()).errors.join(' | '));
  });
  it('rejects a non-object and a wrong schema_version', () => {
    assert.equal(validateCloseoutTransaction(null).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), schema_version: 2 }).valid, false);
  });
  it('requires a non-empty session_id and a boolean test_mode', () => {
    assert.equal(validateCloseoutTransaction({ ...dryRun(), session_id: '' }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), test_mode: 'true' }).valid, false);
  });
  it('requires session_date present (explicit-null): null or a strict ISO date', () => {
    const noKey = { ...dryRun() }; delete noKey.session_date;
    assert.equal(validateCloseoutTransaction(noKey).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), session_date: null }).valid, true);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), session_date: '2026-13-40' }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), session_date: 'July 20 2026' }).valid, false);
  });
  it('rejects calendar-invalid ISO dates rather than normalizing them (Codex #1093)', () => {
    assert.equal(validateCloseoutTransaction({ ...dryRun(), session_date: '2026-02-29' }).valid, false); // 2026 is not a leap year
    assert.equal(validateCloseoutTransaction({ ...dryRun(), session_date: '2026-04-31' }).valid, false); // April has 30 days
    assert.equal(validateCloseoutTransaction({ ...dryRun(), session_date: '2026-00-10' }).valid, false); // month 0
    assert.equal(validateCloseoutTransaction({ ...dryRun(), session_date: '2028-02-29' }).valid, true);  // 2028 IS a leap year
  });
  it('requires log_rows to be an array of plain DATA objects (reject Date/array entries)', () => {
    assert.equal(validateCloseoutTransaction({ ...dryRun(), log_rows: 'x' }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), log_rows: [new Date()] }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), log_rows: [[]] }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), log_rows: [] }).valid, true);
  });
  it('requires effort_row present (explicit-null): null or a plain object (reject Date/array)', () => {
    const noKey = { ...dryRun() }; delete noKey.effort_row;
    assert.equal(validateCloseoutTransaction(noKey).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), effort_row: new Date() }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), effort_row: [] }).valid, false);
  });
  it('requires seal counts to be non-negative integers', () => {
    assert.equal(validateCloseoutTransaction({ ...dryRun(), seal: { count: -1, already_sealed: 0 } }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), seal: { count: 1.5, already_sealed: 0 } }).valid, false);
  });
  it('validates the proof enum and the explicit-null proof nullables', () => {
    assert.equal(validateCloseoutTransaction({ ...dryRun(), proof: { ...dryRun().proof, sheet_write: 'nope' } }).valid, false);
    for (const st of SHEET_WRITE_STATES) {
      // skipped states are compatible with a dry-run; only assert the enum is accepted structurally
      const tx = { ...dryRun(), proof: { ...dryRun().proof, sheet_write: st } };
      if (st === 'success') continue; // success under dry-run is a W1 violation, tested below
      assert.equal(validateCloseoutTransaction(tx).valid, true, `state ${st}`);
    }
    const noKey = { ...dryRun(), proof: { ...dryRun().proof } }; delete noKey.proof.log_rows_written;
    assert.equal(validateCloseoutTransaction(noKey).valid, false);
  });
  it('treats sheet_written / no_write_confirmed as explicit-null nullable booleans', () => {
    // present-but-null is valid on a live success (the real route omits them)
    assert.equal(validateCloseoutTransaction({ ...liveSuccess(), proof: { ...liveSuccess().proof, sheet_written: null, no_write_confirmed: null } }).valid, true);
    // an omitted key is rejected (explicit-null presence)
    const noSW = { ...dryRun(), proof: { ...dryRun().proof } }; delete noSW.proof.sheet_written;
    assert.equal(validateCloseoutTransaction(noSW).valid, false);
    const noNWC = { ...dryRun(), proof: { ...dryRun().proof } }; delete noNWC.proof.no_write_confirmed;
    assert.equal(validateCloseoutTransaction(noNWC).valid, false);
    // a wrong type is rejected
    assert.equal(validateCloseoutTransaction({ ...dryRun(), proof: { ...dryRun().proof, sheet_written: 'false' } }).valid, false);
  });
  it('the contract declares every nullable proof field the validator accepts as null (Codex #1094)', () => {
    const contract = require('../config/coaching/contracts/closeout-transaction.contract.json');
    // the declared schema metadata must match what the validator treats as nullable,
    // or a consumer reading the contract would reject the supported live-success shape.
    for (const f of ['sheet_written', 'no_write_confirmed', 'log_rows_written', 'logAppendedRange']) {
      assert.ok(contract.nullable_proof_fields.includes(f), `contract.nullable_proof_fields must list '${f}'`);
    }
  });
});

describe('validateCloseoutTransaction — Invariant W1 (dry-run never writes)', () => {
  it('rejects a dry-run that claims a write happened', () => {
    assert.equal(validateCloseoutTransaction({ ...dryRun(), proof: { ...dryRun().proof, sheet_written: true } }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), proof: { ...dryRun().proof, no_write_confirmed: false } }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), proof: { ...dryRun().proof, sheet_write: 'success' } }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), proof: { ...dryRun().proof, log_rows_written: 3 } }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...dryRun(), proof: { ...dryRun().proof, logAppendedRange: 'Log_Cleaned!A2:L4' } }).valid, false);
  });
  it('allows log_rows_written 0 on a dry-run (nothing written)', () => {
    assert.equal(validateCloseoutTransaction({ ...dryRun(), proof: { ...dryRun().proof, log_rows_written: 0 } }).valid, true);
  });
});

describe('validateCloseoutTransaction — Invariant W3 (live writes require proof)', () => {
  it('rejects a live success missing a W3-required proof field (range or positive row count)', () => {
    assert.equal(validateCloseoutTransaction({ ...liveSuccess(), proof: { ...liveSuccess().proof, logAppendedRange: null } }).valid, false);
    assert.equal(validateCloseoutTransaction({ ...liveSuccess(), proof: { ...liveSuccess().proof, log_rows_written: 0 } }).valid, false);
  });
  it('a live success matches the real route: sheet_written/no_write_confirmed omitted (null), and booleans also accepted (Codex #1093)', () => {
    // the real POST /api/log-workout success emits neither field → null; W3 does not require them
    assert.equal(validateCloseoutTransaction(liveSuccess()).valid, true, validateCloseoutTransaction(liveSuccess()).errors.join(' | '));
    // a caller that DOES supply them still validates (nullable boolean)
    const withBooleans = { ...liveSuccess(), proof: { ...liveSuccess().proof, sheet_written: true, no_write_confirmed: false } };
    assert.equal(validateCloseoutTransaction(withBooleans).valid, true);
  });
  it('a non-success live write (e.g. skipped_duplicate) does not require the write proof', () => {
    const skipped = { ...liveSuccess(), proof: { sheet_write: 'skipped_duplicate', sheet_written: false, no_write_confirmed: false, log_rows_written: null, logAppendedRange: null } };
    assert.equal(validateCloseoutTransaction(skipped).valid, true, validateCloseoutTransaction(skipped).errors.join(' | '));
  });
});

describe('fromCloseoutSummary (boundary adapter over closeoutSummary output)', () => {
  const summary = {
    session_id: 's_2026_07_20',
    session_date: '2026-07-20',
    rows_to_write: {
      log: [{ exercise: 'Bench', weight: 185, reps: 5 }, { exercise: 'Bench', weight: 185, reps: 5 }],
      effort: { duration: 42, average_hr: 130, peak_hr: 165 },
    },
    rows_to_seal: { count: 2, already_sealed: 1 },
  };
  it('maps a summary + dry-run proof into a valid dry-run transaction', () => {
    const tx = fromCloseoutSummary(summary, {
      test_mode: true,
      proof: { sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true, log_rows_written: null, logAppendedRange: null },
    });
    assert.equal(tx.session_id, 's_2026_07_20');
    assert.equal(tx.log_rows.length, 2);
    assert.deepEqual(tx.seal, { count: 2, already_sealed: 1 });
    assert.equal(validateCloseoutTransaction(tx).valid, true, validateCloseoutTransaction(tx).errors.join(' | '));
  });
  it('maps a summary + the REAL live-success proof (no sheet_written/no_write_confirmed) into a valid transaction (Codex #1093)', () => {
    const tx = fromCloseoutSummary(summary, {
      test_mode: false,
      // the actual POST /api/log-workout success response shape (index.js): it omits
      // sheet_written and no_write_confirmed — the adapter must still produce a valid tx.
      proof: { sheet_write: 'success', log_rows_written: 2, logAppendedRange: 'Log_Cleaned!A2:L3' },
    });
    assert.equal(tx.proof.sheet_written, null);
    assert.equal(tx.proof.no_write_confirmed, null);
    assert.equal(validateCloseoutTransaction(tx).valid, true, validateCloseoutTransaction(tx).errors.join(' | '));
  });
  it('tolerates junk input without throwing (fails validation, never crashes)', () => {
    assert.equal(validateCloseoutTransaction(fromCloseoutSummary(null, {})).valid, false);
    assert.equal(validateCloseoutTransaction(fromCloseoutSummary(undefined, undefined)).valid, false);
  });
});
