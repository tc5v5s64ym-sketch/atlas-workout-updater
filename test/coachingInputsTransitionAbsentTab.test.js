'use strict';

// THE VERIFIED-ABSENT SOURCE TAB, THROUGH THE REAL TOOL AND THE REAL ABSENCE AUTHORITY.
//
// The production workbook holds no `Coaching_Notes`, `Constraints`, or `Deload_State`
// tab — all four coaching-input tabs are OPTIONAL (`config/sheetContract.js`), the
// runtime reads an absent tab as empty, and no write path can append to one. The
// transition tool must therefore treat a VERIFIED-absent tab as a zero-row source,
// gated by an explicit owner acknowledgment at --apply — while every failure that
// merely LOOKS like absence still refuses the whole run.
//
// The absence decision under test is the REAL `sheets.confirmTabMissing` from
// sheets.js, driven through the tool's real read path. The stub only supplies the
// workbook tab list and the thrown errors; it never re-implements the classifier.
// A mutant that trusts the "Unable to parse range" wording without the metadata
// check fails the existing-tab case below; a mutant that drops the acknowledgment
// gate fails the unacknowledged --apply case.

const test = require('node:test');
const assert = require('node:assert/strict');

// Capture the REAL absence authority before the stub replaces the module.
const realConfirmTabMissing = require('../sheets').confirmTabMissing;

// ── the Sheets stub: real classifier, injected workbook ──────────────────────
const sheetsState = { tabs: [], rows: {}, metadataError: null };

function rangeParseError(tab) {
  const message = `Unable to parse range: ${tab}!A:Z`;
  const error = new Error(message);
  error.status = 400;
  error.response = { status: 400, data: { error: { code: 400, message, status: 'INVALID_ARGUMENT' } } };
  return error;
}

function permissionError() {
  const message = 'The caller does not have permission';
  const error = new Error(message);
  error.status = 403;
  error.response = { status: 403, data: { error: { code: 403, message, status: 'PERMISSION_DENIED' } } };
  return error;
}

const fakeSheets = {
  getSheetRows: async (tab) => {
    if (Object.prototype.hasOwnProperty.call(sheetsState.rows, tab)) {
      return sheetsState.rows[tab].map((row) => [...row]);
    }
    throw rangeParseError(tab);
  },
  confirmTabMissing: (error, tab, opts) => realConfirmTabMissing(error, tab, {
    listTabs: async () => {
      if (sheetsState.metadataError) throw sheetsState.metadataError;
      return sheetsState.tabs.slice();
    },
    ...(opts || {}),
  }),
};
require.cache[require.resolve('../sheets')] = {
  id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets,
};

// ── the adapter stub: counts every write, plays back the read-after-apply ────
const adapterState = {
  transitionCalls: [],
  destinations: { coaching_notes: [], constraints: [], deload_state: [], modality_log: [] },
};
const fakeAdapter = {
  isConfigured: () => true,
  coachingNotes: async () => adapterState.destinations.coaching_notes.slice(),
  constraints: async () => adapterState.destinations.constraints.slice(),
  deloadStateRows: async () => adapterState.destinations.deload_state.slice(),
  modalityLogRows: async () => adapterState.destinations.modality_log.slice(),
  transitionCoachingInputs: async (payload) => {
    adapterState.transitionCalls.push(payload);
    adapterState.destinations.coaching_notes = payload.coachingNotes.slice();
    adapterState.destinations.constraints = payload.constraints.slice();
    adapterState.destinations.deload_state = payload.deloadState.slice();
    adapterState.destinations.modality_log = payload.modalityLog.slice();
    return {
      coaching_notes: payload.coachingNotes.length,
      constraints: payload.constraints.length,
      deload_state: payload.deloadState.length,
      modality_log: payload.modalityLog.length,
    };
  },
  close: async () => {},
};
require.cache[require.resolve('../services/supabaseAdapter')] = {
  id: require.resolve('../services/supabaseAdapter'),
  filename: require.resolve('../services/supabaseAdapter'), loaded: true, exports: fakeAdapter,
};

const { main } = require('../scripts/atlas-coaching-inputs-transition.js');

// The production shape this fix exists for: three coaching-input tabs never
// created, Modality_Log present with one carryable row.
const MODALITY_ROW = ['2026-08-01', '20260801-AM-01', 'steady_cardio', 'Bike', '1200', '', '', '', '', '5', '120', 'easy'];
function productionShape() {
  sheetsState.tabs = ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Modality_Log'];
  sheetsState.rows = { Modality_Log: [MODALITY_ROW] };
  sheetsState.metadataError = null;
  adapterState.transitionCalls.length = 0;
  adapterState.destinations = { coaching_notes: [], constraints: [], deload_state: [], modality_log: [] };
}

const ABSENT_CONCEPTS = ['coaching_notes', 'constraints', 'deload_state'];
const ACCEPT_FLAGS = ['--accept-absent-tab=Coaching_Notes,Constraints', '--accept-absent-tab=Deload_State'];

test('a verified-absent tab reads as a zero-row source and the dry run previews the apply refusal', async () => {
  productionShape();
  const report = await main([]);
  for (const name of ABSENT_CONCEPTS) {
    const entry = report.concepts.find((e) => e.concept === name);
    assert.equal(entry.source_tab_absent, true, `${name} must be verified absent`);
    assert.equal(entry.carryable_rows, 0);
    assert.equal(entry.status, 'refused_source_tab_absent', `${name}: the dry run must preview the apply verdict`);
  }
  const modality = report.concepts.find((e) => e.concept === 'modality_log');
  assert.equal(modality.source_tab_absent, false);
  assert.equal(modality.carryable_rows, 1);
  assert.equal(modality.status, 'dry_run');
  assert.equal(adapterState.transitionCalls.length, 0, 'a dry run writes nothing');
});

test('the same range error against a tab that EXISTS still refuses — wording alone is not absence', async () => {
  productionShape();
  // Coaching_Notes is IN the workbook tab list, but its read throws the identical
  // "Unable to parse range" error. confirmTabMissing must answer false and the
  // run must refuse. A mutant that trusts the wording carries zero rows here.
  sheetsState.tabs = [...sheetsState.tabs, 'Coaching_Notes'];
  await assert.rejects(() => main([]), /Unable to parse range/);
  assert.equal(adapterState.transitionCalls.length, 0);
});

test('unreadable spreadsheet metadata refuses — could not look is never evidence of absence', async () => {
  productionShape();
  sheetsState.metadataError = new Error('metadata read failed');
  await assert.rejects(() => main([]), /Unable to parse range/);
  assert.equal(adapterState.transitionCalls.length, 0);
});

test('a permission failure refuses — it is not range_unresolved and never reaches the tab list', async () => {
  productionShape();
  fakeSheets.getSheetRows = async () => { throw permissionError(); };
  try {
    await assert.rejects(() => main([]), /does not have permission/);
  } finally {
    fakeSheets.getSheetRows = async (tab) => {
      if (Object.prototype.hasOwnProperty.call(sheetsState.rows, tab)) {
        return sheetsState.rows[tab].map((row) => [...row]);
      }
      throw rangeParseError(tab);
    };
  }
  assert.equal(adapterState.transitionCalls.length, 0);
});

test('--apply refuses verified-absent tabs without the owner acknowledgment and writes nothing', async () => {
  productionShape();
  const report = await main(['--apply']);
  assert.deepEqual([...report.refusals].sort(), [...ABSENT_CONCEPTS].sort());
  assert.equal(adapterState.transitionCalls.length, 0, 'an unacknowledged absence must not write');
  assert.equal(process.exitCode, 1, 'the refused apply must exit nonzero');
  process.exitCode = 0;
});

test('--apply with the acknowledgment carries zero rows for absent tabs and the real rows for present ones', async () => {
  productionShape();
  const report = await main(['--apply', ...ACCEPT_FLAGS]);
  assert.deepEqual(report.refusals, []);
  assert.equal(adapterState.transitionCalls.length, 1);
  const payload = adapterState.transitionCalls[0];
  assert.deepEqual(payload.coachingNotes, []);
  assert.deepEqual(payload.constraints, []);
  assert.deepEqual(payload.deloadState, []);
  assert.equal(payload.modalityLog.length, 1);
  for (const name of ABSENT_CONCEPTS) {
    const entry = report.concepts.find((e) => e.concept === name);
    assert.equal(entry.absence_accepted, true);
    assert.equal(entry.status, 'applied');
    assert.equal(entry.inserted, 0);
  }
  const modality = report.concepts.find((e) => e.concept === 'modality_log');
  assert.equal(modality.status, 'applied');
  assert.equal(modality.inserted, 1);
});

test('the acknowledgment cannot bypass the destination-not-empty refusal', async () => {
  productionShape();
  adapterState.destinations.modality_log = [MODALITY_ROW];
  const report = await main(['--apply', ...ACCEPT_FLAGS]);
  assert.ok(report.refusals.includes('modality_log'));
  assert.equal(adapterState.transitionCalls.length, 0, 'an occupied destination refuses the whole transition');
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});
