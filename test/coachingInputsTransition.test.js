'use strict';

// Proves the coaching-input transition:
// - reads normally when the tab exists in the verified production workbook;
// - treats metadata-confirmed absence as zero rows only after workbook identity matches;
// - refuses wrong workbook, missing expected identity on --apply, and unverified failures.

const test = require('node:test');
const assert = require('node:assert/strict');

const EXPECTED_ENV = 'ATLAS_COACHING_INPUTS_EXPECTED_SHEETS_ID';
const PRODUCTION_ID = 'prod-workbook-id-abc12345';
const WRONG_ID = 'wrong-workbook-id-xyz98765';

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

function withEnv(overrides, fn) {
  const saved = {
    GOOGLE_SHEETS_ID: process.env.GOOGLE_SHEETS_ID,
    [EXPECTED_ENV]: process.env[EXPECTED_ENV],
  };
  Object.assign(process.env, overrides);
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

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

test('readSource returns rows when the tab reads successfully in the verified workbook', async () => {
  await withEnv({
    GOOGLE_SHEETS_ID: PRODUCTION_ID,
    [EXPECTED_ENV]: PRODUCTION_ID,
  }, async () => {
    const { readSource } = loadHarness({
      getSheetRows: async () => [['2026-08-01', 'note one'], ['', '']],
      confirmTabMissing: async () => false,
    });
    const result = await readSource(concept, { workbookVerified: true });
    assert.equal(result.source_status, 'read');
    assert.equal(result.rows.length, 1);
  });
});

test('readSource treats a verified-absent tab as zero rows when workbook identity matches', async () => {
  await withEnv({
    GOOGLE_SHEETS_ID: PRODUCTION_ID,
    [EXPECTED_ENV]: PRODUCTION_ID,
  }, async () => {
    const { readSource } = loadHarness({
      getSheetRows: async () => { throw RANGE_ERROR(); },
      confirmTabMissing: async () => true,
    });
    const result = await readSource(concept, { workbookVerified: true });
    assert.equal(result.source_status, 'verified_absent');
    assert.deepEqual(result.rows, []);
  });
});

test('readSource refuses when tab is absent but workbook identity does not match', async () => {
  await withEnv({
    GOOGLE_SHEETS_ID: WRONG_ID,
    [EXPECTED_ENV]: PRODUCTION_ID,
  }, async () => {
    const { resolveSourceWorkbookIdentity } = loadHarness({
      getSheetRows: async () => { throw RANGE_ERROR(); },
      confirmTabMissing: async () => true,
    });
    const identity = resolveSourceWorkbookIdentity({ requireExpected: false });
    assert.equal(identity.ok, false);
    assert.match(identity.reason, /does not match expected production workbook/);
  });
});

test('resolveSourceWorkbookIdentity refuses --apply when expected production identity is missing', async () => {
  await withEnv({
    GOOGLE_SHEETS_ID: PRODUCTION_ID,
    [EXPECTED_ENV]: '',
  }, async () => {
    const { resolveSourceWorkbookIdentity } = loadHarness({
      getSheetRows: async () => [],
      confirmTabMissing: async () => false,
    });
    const identity = resolveSourceWorkbookIdentity({ requireExpected: true });
    assert.equal(identity.ok, false);
    assert.match(identity.reason, /required for --apply/);
  });
});

test('readSource refuses transient read failures without claiming absence', async () => {
  await withEnv({
    GOOGLE_SHEETS_ID: PRODUCTION_ID,
    [EXPECTED_ENV]: PRODUCTION_ID,
  }, async () => {
    const { readSource } = loadHarness({
      getSheetRows: async () => { throw TRANSIENT_ERROR(); },
      confirmTabMissing: async () => false,
    });
    await assert.rejects(
      () => readSource(concept, { workbookVerified: true }),
      /Failed to read source tab/
    );
  });
});

test('readSource refuses metadata-confirmed absence without verified workbook identity', async () => {
  await withEnv({
    GOOGLE_SHEETS_ID: PRODUCTION_ID,
    [EXPECTED_ENV]: '',
  }, async () => {
    const { readSource } = loadHarness({
      getSheetRows: async () => { throw RANGE_ERROR(); },
      confirmTabMissing: async () => true,
    });
    await assert.rejects(
      () => readSource(concept, { workbookVerified: false }),
      /not verified as the expected production workbook/
    );
  });
});
