'use strict';

// Proves the coaching-input transition treats a VERIFIED-ABSENT tab as a valid
// zero-row source, while every unverified failure still refuses.

const test = require('node:test');
const assert = require('node:assert/strict');

const RANGE_ERROR = () => {
  const error = new Error('Unable to parse range: Coaching_Notes!A:Z');
  error.response = { status: 400, data: { error: { message: 'Unable to parse range: Coaching_Notes!A:Z' } } };
  return error;
};

const TRANSIENT_ERROR = () => {
  const error = new Error('The service is currently unavailable.');
  error.response = { status: 503 };
  return error;
};

function loadHarness({ getSheetRows, confirmTabMissing }) {
  const scriptPath = require.resolve('../scripts/atlas-coaching-inputs-transition.js');
  const sheetsPath = require.resolve('../sheets');
  delete require.cache[scriptPath];
  delete require.cache[sheetsPath];
  require.cache[sheetsPath] = {
    id: sheetsPath,
    filename: sheetsPath,
    loaded: true,
    exports: {
      getSheetRows,
      confirmTabMissing,
    },
  };
  return require('../scripts/atlas-coaching-inputs-transition');
}

const concept = { tab: 'Coaching_Notes', name: 'coaching_notes' };

test('readSource returns rows when the tab reads successfully', async () => {
  const { readSource } = loadHarness({
    getSheetRows: async () => [['2026-08-01', 'note one'], ['', '']],
    confirmTabMissing: async () => false,
  });
  const result = await readSource(concept);
  assert.equal(result.source_status, 'read');
  assert.equal(result.rows.length, 1);
});

test('readSource treats a verified-absent tab as zero rows', async () => {
  const { readSource } = loadHarness({
    getSheetRows: async () => { throw RANGE_ERROR(); },
    confirmTabMissing: async () => true,
  });
  const result = await readSource(concept);
  assert.equal(result.source_status, 'verified_absent');
  assert.deepEqual(result.rows, []);
});

test('readSource refuses when absence cannot be verified', async () => {
  const { readSource } = loadHarness({
    getSheetRows: async () => { throw RANGE_ERROR(); },
    confirmTabMissing: async () => false,
  });
  await assert.rejects(
    () => readSource(concept),
    /Refusing to treat an unverified source as empty/
  );
});

test('readSource refuses transient read failures without claiming absence', async () => {
  const { readSource } = loadHarness({
    getSheetRows: async () => { throw TRANSIENT_ERROR(); },
    confirmTabMissing: async () => false,
  });
  await assert.rejects(
    () => readSource(concept),
    /Failed to read source tab/
  );
});
