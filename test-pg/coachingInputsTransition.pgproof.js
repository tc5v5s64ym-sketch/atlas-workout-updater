'use strict';

// The one-time coaching-input carry-over is one authority transition, not four
// loosely related imports. This proof drives the real atlas_migrate transaction
// against Postgres and proves: all concepts land together, a rerun refuses all,
// and one invalid row rolls every concept back.

const test = require('node:test');
const assert = require('node:assert/strict');
const { roleUrl, resetSchema, withRole } = require('./support/db');

process.env.ATLAS_SUPABASE_MIGRATE_URL = roleUrl('atlas_migrate');
const adapter = require('../services/supabaseAdapter');

const payload = () => ({
  coachingNotes: [{ date: '2026-08-01', note: 'Protect the left shoulder.' }],
  constraints: [{
    date: '2026-08-01', kind: 'joint', target: 'shoulder',
    rule: 'avoid_overhead', note: 'owner supplied',
  }],
  deloadState: [['2026-08-01T00:00:00Z', 'NORMAL', '', '', '', '', '']],
  modalityLog: [['2026-08-01', '20260801-AM-01', 'steady_cardio', 'Bike', '1200', '', '', '', '', '5', '120', 'easy']],
});

async function counts() {
  return withRole('atlas_migrate', async (client) => (await client.query(`
    SELECT
      (SELECT count(*)::int FROM atlas.coaching_notes) AS coaching_notes,
      (SELECT count(*)::int FROM atlas.constraints) AS constraints,
      (SELECT count(*)::int FROM atlas.deload_state) AS deload_state,
      (SELECT count(*)::int FROM atlas.modality_log) AS modality_log
  `)).rows[0]);
}

test('coaching-input transition is atomic, one-shot, and all-concept', async () => {
  await resetSchema();

  const inserted = await adapter.transitionCoachingInputs(payload());
  assert.deepEqual(inserted, {
    coaching_notes: 1, constraints: 1, deload_state: 1, modality_log: 1,
  });
  assert.deepEqual(await counts(), {
    coaching_notes: 1, constraints: 1, deload_state: 1, modality_log: 1,
  });

  await assert.rejects(
    () => adapter.transitionCoachingInputs(payload()),
    (error) => error && error.code === 'COACHING_INPUT_DESTINATION_NOT_EMPTY'
  );
  assert.deepEqual(await counts(), {
    coaching_notes: 1, constraints: 1, deload_state: 1, modality_log: 1,
  });

  await resetSchema();
  const invalid = payload();
  invalid.coachingNotes[0].note = '   '; // violates the database CHECK
  await assert.rejects(() => adapter.transitionCoachingInputs(invalid));
  assert.deepEqual(await counts(), {
    coaching_notes: 0, constraints: 0, deload_state: 0, modality_log: 0,
  }, 'one invalid concept rolls the entire transition back');
});

test.after(async () => adapter.close());
