'use strict';

// #1690 — a receipt cannot say completed/success for a write that failed,
// landed only in part, or was never verified. The record status and the
// body's sheet_write are one vocabulary, and a retry replays that word.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  beginWrite,
  completeWrite,
  peekWrite,
  resetIdempotencyStore,
  duplicateReplay,
  isSettledReceipt,
} = require('../services/idempotency');

test.beforeEach(() => {
  resetIdempotencyStore();
});

test('#1690: partial sheet_write is stored as partial, not completed', () => {
  const begun = beginWrite('partial-1', { endpoint: '/api/log-workout' });
  const body = {
    sheet_write: 'partial',
    sheet_written: true,
    idempotency_status: 'completed',
    log_rows_written: 1,
    effort_rows_written: 0,
  };
  assert.equal(completeWrite('partial-1', begun.token, body), true);
  const stored = peekWrite('partial-1');
  assert.equal(stored.status, 'partial');
  assert.equal(stored.response.sheet_write, 'partial');
  assert.equal(stored.response.idempotency_status, 'partial');
  assert.equal(body.idempotency_status, 'partial', 'the returned body is stamped to the same word');
  assert.equal(stored.completed_at, undefined, 'partial is not a completion');

  const again = beginWrite('partial-1', { endpoint: '/api/log-workout' });
  assert.equal(again.duplicate, true, 'a partial receipt is terminal — a retry must not append');
  const replay = duplicateReplay(again.record, 'partial-1');
  assert.equal(replay.terminal, true);
  assert.equal(replay.httpStatus, 500);
  assert.equal(replay.body.sheet_write, 'partial');
  assert.notEqual(replay.body.sheet_write, 'success');
  assert.notEqual(replay.body.sheet_write, 'skipped_duplicate');
});

test('#1690: unverified sheet_write is stored as unverified and replays unverified', () => {
  const begun = beginWrite('unverified-1', { endpoint: '/api/complete-workout' });
  const body = {
    status: 'error',
    data: {
      sheet_write: 'unverified',
      sheet_written: true,
      proof_mismatch: true,
      idempotency_status: 'completed',
      log_rows_written: 1,
    },
  };
  assert.equal(completeWrite('unverified-1', begun.token, body), true);
  const stored = peekWrite('unverified-1');
  assert.equal(stored.status, 'unverified');
  assert.equal(stored.response.data.sheet_write, 'unverified');
  assert.equal(stored.response.data.idempotency_status, 'unverified');
  assert.equal(isSettledReceipt(stored.status), true);

  const again = beginWrite('unverified-1');
  assert.equal(again.duplicate, true);
  const replay = duplicateReplay(again.record, 'unverified-1');
  assert.equal(replay.httpStatus, 500);
  assert.equal(replay.body.sheet_write, 'unverified');
  assert.equal(replay.body.proof_mismatch, true);
  assert.equal(replay.body.sheet_written, false, 'a replay must not carry a confirmed-write flag');
});

test('#1690: a committed finalization failure cannot be stored as success', () => {
  const begun = beginWrite('finalize-1', { endpoint: '/api/log-workout' });
  const body = {
    sheet_write: 'success',
    idempotency_status: 'completed',
    post_processing_error: true,
    log_rows_written: 2,
    effort_rows_written: 1,
  };
  completeWrite('finalize-1', begun.token, body);
  const stored = peekWrite('finalize-1');
  assert.equal(stored.status, 'unverified');
  assert.equal(stored.response.sheet_write, 'unverified');
  assert.equal(stored.response.proof_mismatch, true);
  assert.notEqual(stored.response.sheet_write, 'success');
  assert.equal(body.sheet_write, 'unverified');

  const replay = duplicateReplay(beginWrite('finalize-1').record, 'finalize-1');
  assert.equal(replay.terminal, true);
  assert.equal(replay.httpStatus, 500);
  assert.equal(replay.body.sheet_write, 'unverified');
});

test('#1690: a verified success stays completed and replays as a duplicate save', () => {
  const begun = beginWrite('ok-1', { endpoint: '/api/log-workout' });
  const body = {
    sheet_write: 'success',
    idempotency_status: 'completed',
    log_rows_written: 1,
    log_write_verification: { verified: true, authority: 'append_receipt' },
  };
  completeWrite('ok-1', begun.token, body);
  const stored = peekWrite('ok-1');
  assert.equal(stored.status, 'completed');
  assert.equal(stored.response.sheet_write, 'success');
  assert.ok(stored.completed_at);
  const replay = duplicateReplay(beginWrite('ok-1').record, 'ok-1');
  assert.equal(replay.terminal, false);
  assert.equal(replay.completed, true);
  assert.equal(replay.httpStatus, 200);
});

test('#1690: a historical completed receipt whose body says partial still replays as partial', () => {
  const begun = beginWrite('legacy-partial', { endpoint: '/api/log-workout' });
  completeWrite('legacy-partial', begun.token, { sheet_write: 'success', log_rows_written: 1 });
  const stored = peekWrite('legacy-partial');
  stored.status = 'completed';
  stored.response.sheet_write = 'partial';
  stored.response.idempotency_status = 'completed';
  const replay = duplicateReplay(stored, 'legacy-partial');
  assert.equal(replay.terminal, true);
  assert.equal(replay.body.sheet_write, 'partial');
  assert.equal(replay.httpStatus, 500);
});

test('#1690: notes without a sheet_write word stay completed', () => {
  const begun = beginWrite('note-1', { endpoint: '/api/coaching-notes' });
  const body = { sheet_written: true, note_written: true };
  completeWrite('note-1', begun.token, body);
  assert.equal(peekWrite('note-1').status, 'completed');
  assert.equal(body.idempotency_status, undefined);
});

test('#1690: the log-workout finalization catch does not record success', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const marker = 'Failed to finalize workout response after append';
  const block = src.slice(src.indexOf(marker), src.indexOf(marker) + 1400);
  assert.doesNotMatch(block, /sheet_write:\s*'success'/);
  assert.match(block, /sheet_write:\s*'unverified'/);
});

test('#1690: screenshot duplicate acceptance requires an original success word', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'app.js'), 'utf8');
  const idx = app.indexOf("pendingWrite.mode === 'screenshot'");
  const branch = app.slice(idx, idx + 1600);
  assert.match(branch, /original_sheet_written === true/);
  assert.match(branch, /original_sheet_write === 'success'/);
});
