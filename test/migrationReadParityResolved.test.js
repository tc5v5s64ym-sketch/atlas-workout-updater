'use strict';

// S3 CUTOVER READINESS READS THE TAB THE FROZEN MAP DESCRIBES.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §6.2 P5, §4.5.
// Source: the live `Atlas Production` readiness run of 2026-08-13, where the
// backfill reconciled all four row concepts and the sweep completed on all five with
// zero missing, mismatch and divergence rows, while P5 reported 2 of 7 moved reads
// equal.
//
// ── THE DEFECT THESE PROOFS EXIST FOR ────────────────────────────────────────
// `services/migrationReadParity.js` interpreted the Sheets side ITSELF. It read
// `getLogCompositeKeys()`, `getEffortSessionIds()` and `getSheetRows()` raw, applied
// its own identityless rule, and compared the result against a database backfilled
// through `migrationLegacyIdentityMap.resolveSheetRows`. That was a second
// interpretation of the same tabs beside the frozen resolver, so every disposition
// the owner froze read as a difference: padded blank arrays, excluded rows, surplus
// identical copies and translated legacy ids.
//
// Every case below is RED-FIRST in the strongest available form: it asserts the
// counterexample as well as the fix. The raw comparison is executed alongside the
// resolved one and asserted UNEQUAL, so a green result here cannot come from a
// fixture that would have passed either way.
//
// ── AND THE REFUSALS COME FIRST ──────────────────────────────────────────────
// A readiness gate is only worth its green when a counterexample turns it red. An
// unmapped legacy id, a genuinely identityless non-blank row, a stale owner approval
// and an undisposed duplicate identity each still FAIL, with an aggregate redacted
// reason and no invented identity.
//
// SYNTHETIC THROUGHOUT. No production value, count, session id, exercise or
// fingerprint appears in this file, and the frozen production map is never loaded —
// every case declares its own synthetic map.
//
// TEMPORARY: deleted at S4 with the readiness machinery and the bridge.

const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../services/migrationRowContract');
const legacyMap = require('../services/migrationLegacyIdentityMap');
const parity = require('../services/migrationReadParity');

/* ══════════ synthetic fixtures ══════════ */

// Log_Cleaned contract order: date_clean, session_id, exercise, canonical_exercise,
// muscle_group, lift_code, set_number, weight, reps, rir, notes, volume_calc.
const logRow = (sessionId, { exercise = 'Bench Press', setNumber = '1', notes = '' } = {}) =>
  ['2026-05-20', sessionId, exercise, exercise, 'Chest', 'BP', setNumber, '135', '5', '2', notes, '675'];

// Effort contract order: date, session_id, duration, active_calories, total_calories,
// average_hr, peak_hr, location, notes.
const effRow = (sessionId, { date = '2026-05-20', duration = '01:02:03' } = {}) =>
  [date, sessionId, duration, '300', '400', '120', '150', 'Gym', ''];

// Session_Plans contract order (13 columns), keyed by idempotency_key.
const planRow = (key, sessionId) =>
  [key, sessionId, '2026-05-20', 'pv_synthetic', 'plan_item', `${key}-item`, '1', 'BP',
    'horizontal_push', 'completed', 'BP', '', '2026-05-20T10:00:00.000Z'];

// Session_Plan_Sets contract order (16 columns), keyed by idempotency_key.
const planSetRow = (key, sessionId) => {
  const spec = contract.conceptSpec('session_plan_set_recommendations');
  const cells = spec.sheetColumns.map(() => '');
  const put = (sheetColumn, value) => { cells[spec.sheetColumns.indexOf(sheetColumn)] = value; };
  put('idempotency_key', key);
  put('session_id', sessionId);
  put('recorded_at', '2026-05-20T10:00:00.000Z');
  return cells;
};

const BLANK_LOG = new Array(12).fill('');
const BLANK_EFFORT = new Array(9).fill('');

// A fully synthetic frozen map. `validate()` demands frozen, owner_approved and a
// sessions array; every other list is optional.
const synthMap = ({ sessions = [], excludedSessions = [], excludedRows = [], duplicates = [] } = {}) => ({
  frozen: true,
  owner_approved: true,
  sessions: sessions.map(([legacy, canonical]) => ({
    legacy_session_id: legacy,
    disposition: 'MAP',
    canonical_session_id: canonical,
    provenance: {
      date: 'source_derived_embedded_in_id',
      period: 'OWNER_DECLARED',
      slot: 'OWNER_DECLARED',
    },
    owner_ruling: 'SYNTHETIC_RULING',
  })),
  excluded_sessions: excludedSessions.map((sessionId) => ({
    session_id: sessionId, disposition: 'EXCLUDE', owner_ruling: 'SYNTHETIC_RULING',
  })),
  excluded_rows: excludedRows.map(([concept, cells]) => ({
    concept,
    row_fingerprint: legacyMap.rowFingerprint(cells),
    disposition: 'EXCLUDE',
    owner_ruling: 'SYNTHETIC_RULING',
  })),
  duplicate_dispositions: duplicates.map(([concept, cells, expected = 2, surviving = 1]) => ({
    concept,
    row_fingerprint: legacyMap.rowFingerprint(cells),
    disposition: 'EXCLUDE_SURPLUS_IDENTICAL',
    expected_occurrences: expected,
    surviving_copies: surviving,
    owner_ruling: 'SYNTHETIC_RULING',
  })),
});

// Inject a synthetic map at the ONE shared resolver seam the backfill, the sweep and
// now the readiness comparison all read. Nothing in production gains a map-injection
// hook: each consumer still calls the frozen file and only it.
function withMap(map, run) {
  const real = legacyMap.resolveSheetRows;
  legacyMap.resolveSheetRows = (concept, sheetRows, options = {}) => real(concept, sheetRows, { ...options, map });
  return Promise.resolve(run()).finally(() => { legacyMap.resolveSheetRows = real; });
}

const CATALOG_VERIFIED_AT = '2026-05-20T10:00:00.000Z';
const CATALOG_NOW = Date.parse(CATALOG_VERIFIED_AT) + 1000;

const CURRENT_CATALOG_HEADER = ['Canonical_Name', 'Muscle_Group', 'Lift_Code', 'Original_Variants'];
const LEGACY_CATALOG_HEADER = ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'];
const CATALOG_DATA = [
  ['Bench Press', 'Chest', 'BP', 'bench, bench press'],
  ['Back Squat', 'Legs', 'BSQ', 'squat, back squat'],
];
const mirrorOf = (dataRows) => dataRows.map(([display, muscle, lift, fourth]) => ({
  display_exercise: display, muscle_group: muscle, lift_code: lift, canonical_exercise: fourth,
}));

// A Sheets stub that counts its reads, so "one read per tab" is provable.
function stubSheets({ tabs = {}, catalog = [] } = {}) {
  const reads = [];
  return {
    reads,
    getSheetRows: async (tab) => { reads.push(tab); return (tabs[tab] || []).map((r) => r.slice()); },
    getExerciseCatalog: async () => catalog.map((r) => r.slice()),
    // Present so a call to either would be observable; the resolved comparison must
    // never reach them.
    getLogCompositeKeys: async () => { throw new Error('raw getLogCompositeKeys must not be compared'); },
    getEffortSessionIds: async () => { throw new Error('raw getEffortSessionIds must not be compared'); },
  };
}

// A Supabase stub built FROM the effective Sheets rows, which is what a clean
// backfill produces. `rowFromSheet` yields exactly the canonical object shape the
// driver returns.
function stubAdapter({ effective = {}, mirror = [], verifiedAt = CATALOG_VERIFIED_AT } = {}) {
  return {
    listConcept: async (concept) => (effective[concept] || []).map((cells) => contract.rowFromSheet(concept, cells)),
    currentCatalogGeneration: async () => ({
      sync_id: 1, source_row_count: mirror.length, verified_at: verifiedAt, content_hash: 'synthetic',
    }),
    readCatalogMirror: async () => mirror.map((row) => ({ ...row })),
  };
}

// The production-shaped tab set: canonical rows, two translated legacy ids, one
// owner-excluded row, one owner-approved identical Effort pair, and padded blanks.
const LEGACY_ID = '2026-05-20';
const CANONICAL_ID = '20260520-AM-01';
const OTHER_ID = '20260521-PM-01';
const EXCLUDED_LOG_ROW = logRow(CANONICAL_ID, { exercise: 'Test Fragment', setNumber: '9' });
const DUPLICATED_EFFORT_ROW = effRow(OTHER_ID);

function productionShapedCase() {
  const sheetTabs = {
    Log_Cleaned: [
      logRow(CANONICAL_ID),
      logRow(LEGACY_ID, { setNumber: '2' }),
      logRow(LEGACY_ID, { setNumber: '3' }),
      EXCLUDED_LOG_ROW,
      BLANK_LOG,
      BLANK_LOG,
    ],
    Effort: [
      effRow(CANONICAL_ID),
      DUPLICATED_EFFORT_ROW,
      DUPLICATED_EFFORT_ROW.slice(),
      BLANK_EFFORT,
      BLANK_EFFORT,
      BLANK_EFFORT,
    ],
    Session_Plans: [planRow('idem-1', CANONICAL_ID)],
    Session_Plan_Sets: [planSetRow('idem-set-1', CANONICAL_ID)],
  };
  // What the backfill wrote: legacy ids translated, the excluded row absent, one
  // surviving copy of the approved duplicate, no padded arrays.
  const effective = {
    logged_sets: [
      logRow(CANONICAL_ID),
      logRow(CANONICAL_ID, { setNumber: '2' }),
      logRow(CANONICAL_ID, { setNumber: '3' }),
    ],
    session_effort: [effRow(CANONICAL_ID), DUPLICATED_EFFORT_ROW],
    session_plan_events: sheetTabs.Session_Plans,
    session_plan_set_recommendations: sheetTabs.Session_Plan_Sets,
  };
  const map = synthMap({
    sessions: [[LEGACY_ID, CANONICAL_ID]],
    excludedRows: [['logged_sets', EXCLUDED_LOG_ROW]],
    duplicates: [['session_effort', DUPLICATED_EFFORT_ROW]],
  });
  return { sheetTabs, effective, map };
}

const readById = (result, id) => result.reads.find((r) => r.id === id);

/* ══════════ 1. THE DEFECT — every frozen disposition used to read as a difference ══════════ */

test('production-shaped tab: the RAW Sheets side disagrees on every concept, and the RESOLVED side agrees', async () => {
  const { sheetTabs, effective, map } = productionShapedCase();
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER, ...CATALOG_DATA] });
  const adapter = stubAdapter({ effective, mirror: mirrorOf(CATALOG_DATA) });

  // ── the counterexample: the comparison this module used to perform ──
  // Raw Log_Cleaned still holds the padded arrays and the owner-excluded fragment,
  // and still spells the legacy session id. Raw Effort still holds both identical
  // copies and 3 padded arrays.
  const rawLog = parity.compareCellSets('logged_sets', sheetTabs.Log_Cleaned,
    effective.logged_sets.map((c) => contract.sheetCellsFromRow('logged_sets', contract.rowFromSheet('logged_sets', c))));
  assert.equal(rawLog.equal, false, 'the raw Log_Cleaned comparison must be the failing one');
  const rawEffort = parity.compareCellSets('session_effort', sheetTabs.Effort,
    effective.session_effort.map((c) => contract.sheetCellsFromRow('session_effort', contract.rowFromSheet('session_effort', c))));
  assert.equal(rawEffort.equal, false, 'the raw Effort comparison must be the failing one');

  // ── the fix ──
  const result = await withMap(map, () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));

  assert.equal(result.ready, true, `every moved read must be equal; got ${JSON.stringify(result.reads.filter((r) => !r.equal))}`);
  assert.equal(result.reads.length, result.moved_read_count);
  for (const read of result.reads) {
    assert.equal(read.equal, true, `${read.id} must be equal`);
    assert.equal(read.error, null, `${read.id} must not have errored`);
  }
});

test('the two key lists are DERIVED from the resolved rows, never read raw', async () => {
  // Both raw readers throw in the stub. A run that touched either would surface the
  // throw as that read's `error`, so a clean pass is the proof that neither was called.
  const { sheetTabs, effective, map } = productionShapedCase();
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER, ...CATALOG_DATA] });
  const adapter = stubAdapter({ effective, mirror: mirrorOf(CATALOG_DATA) });

  const result = await withMap(map, () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));

  assert.equal(readById(result, 'log_composite_keys').equal, true);
  assert.equal(readById(result, 'log_composite_keys').error, null);
  assert.equal(readById(result, 'effort_session_ids').equal, true);
  assert.equal(readById(result, 'effort_session_ids').error, null);
});

test('each migrated tab is read ONCE, and every read derived from it sees that one resolution', async () => {
  const { sheetTabs, effective, map } = productionShapedCase();
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER, ...CATALOG_DATA] });
  const adapter = stubAdapter({ effective, mirror: mirrorOf(CATALOG_DATA) });

  await withMap(map, () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));

  assert.deepEqual(sheets.reads, ['Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets']);
});

/* ══════════ 2. Each disposition on its own ══════════ */

test('a MAPPED legacy session id is compared as its canonical id', async () => {
  const sheetTabs = { Log_Cleaned: [logRow(LEGACY_ID)], Effort: [], Session_Plans: [], Session_Plan_Sets: [] };
  const effective = { logged_sets: [logRow(CANONICAL_ID)] };
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER] });
  const adapter = stubAdapter({ effective, mirror: [] });
  const map = synthMap({ sessions: [[LEGACY_ID, CANONICAL_ID]] });

  const result = await withMap(map, () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));
  assert.equal(readById(result, 'logged_sets_rows').equal, true);
  assert.equal(readById(result, 'log_composite_keys').equal, true);

  // The counterexample: without the translation the two ids are different keys.
  const raw = parity.compareKeyLists(
    [contract.identityKey('logged_sets', contract.rowFromSheet('logged_sets', logRow(LEGACY_ID)))],
    [contract.identityKey('logged_sets', contract.rowFromSheet('logged_sets', logRow(CANONICAL_ID)))]
  );
  assert.equal(raw.equal, false);
});

test('a frozen row-level EXCLUDE is absent from both sides', async () => {
  const sheetTabs = {
    Log_Cleaned: [logRow(CANONICAL_ID), EXCLUDED_LOG_ROW], Effort: [], Session_Plans: [], Session_Plan_Sets: [],
  };
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER] });
  const adapter = stubAdapter({ effective: { logged_sets: [logRow(CANONICAL_ID)] }, mirror: [] });
  const map = synthMap({ excludedRows: [['logged_sets', EXCLUDED_LOG_ROW]] });

  const result = await withMap(map, () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));
  assert.equal(readById(result, 'logged_sets_rows').equal, true);
  assert.equal(readById(result, 'log_composite_keys').equal, true);
});

test('a frozen session-level EXCLUDE is absent from both sides', async () => {
  const sheetTabs = { Log_Cleaned: [], Effort: [effRow(CANONICAL_ID), effRow(OTHER_ID)], Session_Plans: [], Session_Plan_Sets: [] };
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER] });
  const adapter = stubAdapter({ effective: { session_effort: [effRow(CANONICAL_ID)] }, mirror: [] });
  const map = synthMap({ excludedSessions: [OTHER_ID] });

  const result = await withMap(map, () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));
  assert.equal(readById(result, 'session_effort_rows').equal, true);
  assert.equal(readById(result, 'effort_session_ids').equal, true);
});

test('an APPROVED exact-duplicate pair keeps exactly the approved surviving count', async () => {
  const sheetTabs = {
    Log_Cleaned: [],
    Effort: [DUPLICATED_EFFORT_ROW, DUPLICATED_EFFORT_ROW.slice()],
    Session_Plans: [],
    Session_Plan_Sets: [],
  };
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER] });
  const adapter = stubAdapter({ effective: { session_effort: [DUPLICATED_EFFORT_ROW] }, mirror: [] });
  const map = synthMap({ duplicates: [['session_effort', DUPLICATED_EFFORT_ROW]] });

  const result = await withMap(map, () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));
  assert.equal(readById(result, 'effort_session_ids').equal, true, 'one surviving copy, one Supabase row');
  assert.equal(readById(result, 'session_effort_rows').equal, true);
});

test('BLANK padding is never a difference, at any volume', async () => {
  // The shape of the live case, generalised: a tab whose real content is one row and
  // whose read is mostly padded empty arrays.
  const padding = new Array(50).fill(BLANK_EFFORT);
  const sheetTabs = {
    Log_Cleaned: [], Effort: [effRow(CANONICAL_ID), ...padding], Session_Plans: [], Session_Plan_Sets: [],
  };
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER] });
  const adapter = stubAdapter({ effective: { session_effort: [effRow(CANONICAL_ID)] }, mirror: [] });

  const result = await withMap(synthMap(), () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));
  assert.equal(readById(result, 'session_effort_rows').equal, true);
  assert.equal(readById(result, 'effort_session_ids').equal, true);

  // The counterexample: the raw comparison counts every padded array as a row.
  const raw = parity.compareCellSets('session_effort', sheetTabs.Effort,
    [contract.sheetCellsFromRow('session_effort', contract.rowFromSheet('session_effort', effRow(CANONICAL_ID)))]);
  assert.equal(raw.equal, false);
});

/* ══════════ 3. THE REFUSALS — what must still fail closed ══════════ */

test('a GENUINE identityless non-blank row still FAILS readiness', async () => {
  // One populated cell is enough to make it a row. Its export identity is empty, so
  // Supabase can never represent it and only the owner can say what it means.
  const identityless = new Array(12).fill('');
  identityless[10] = 'a stray note';
  const sheetTabs = {
    Log_Cleaned: [logRow(CANONICAL_ID), identityless], Effort: [], Session_Plans: [], Session_Plan_Sets: [],
  };
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER] });
  const adapter = stubAdapter({ effective: { logged_sets: [logRow(CANONICAL_ID)] }, mirror: [] });

  const result = await withMap(synthMap(), () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));

  assert.equal(result.ready, false);
  for (const id of ['logged_sets_rows', 'log_composite_keys']) {
    const read = readById(result, id);
    assert.equal(read.equal, false, `${id} must refuse`);
    assert.match(read.detail, /identityless rows=1/);
    assert.match(read.detail, /OWNER ACTION REQUIRED/);
    assert.equal(read.detail.includes('a stray note'), false, 'the reason is redacted');
  }
});

test('an UNMAPPED legacy session id still FAILS readiness — nothing is guessed', async () => {
  const sheetTabs = {
    Log_Cleaned: [logRow('2026-05-19')], Effort: [], Session_Plans: [], Session_Plan_Sets: [],
  };
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER] });
  const adapter = stubAdapter({ effective: { logged_sets: [] }, mirror: [] });
  // The map covers a DIFFERENT legacy id, so this one is genuinely uncovered.
  const map = synthMap({ sessions: [[LEGACY_ID, CANONICAL_ID]] });

  const result = await withMap(map, () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));

  assert.equal(result.ready, false);
  for (const id of ['logged_sets_rows', 'log_composite_keys']) {
    const read = readById(result, id);
    assert.equal(read.equal, false);
    assert.match(read.detail, /unmapped legacy session ids=1/);
    assert.equal(read.detail.includes('2026-05-19'), false, 'the reason is redacted');
  }
});

test('a STALE duplicate approval still FAILS readiness — the map and the data have parted', async () => {
  // The owner approved two identical copies. The tab now holds one, so the approval
  // describes content the tab no longer has.
  const sheetTabs = {
    Log_Cleaned: [], Effort: [DUPLICATED_EFFORT_ROW], Session_Plans: [], Session_Plan_Sets: [],
  };
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER] });
  const adapter = stubAdapter({ effective: { session_effort: [DUPLICATED_EFFORT_ROW] }, mirror: [] });
  const map = synthMap({ duplicates: [['session_effort', DUPLICATED_EFFORT_ROW]] });

  const result = await withMap(map, () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));

  assert.equal(result.ready, false);
  const read = readById(result, 'session_effort_rows');
  assert.equal(read.equal, false);
  assert.match(read.detail, /stale duplicate approvals=1/);
});

test('an UNDISPOSED duplicate identity still FAILS — it is never collapsed into one row', async () => {
  // Two Effort rows for one session, differing in content, with no owner disposition.
  // Supabase's unique index can hold only one of them.
  const sheetTabs = {
    Log_Cleaned: [],
    Effort: [effRow(CANONICAL_ID), effRow(CANONICAL_ID, { duration: '00:45:00' })],
    Session_Plans: [],
    Session_Plan_Sets: [],
  };
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER] });
  const adapter = stubAdapter({ effective: { session_effort: [effRow(CANONICAL_ID)] }, mirror: [] });

  const result = await withMap(synthMap(), () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));

  assert.equal(result.ready, false);
  const read = readById(result, 'session_effort_rows');
  assert.equal(read.equal, false, 'the second authoritative row must not be discarded to make the sizes agree');
  assert.match(read.detail, /duplicate export identities cannot be compared: sheets=1/);
  assert.equal(read.detail.includes('00:45:00'), false, 'the reason is redacted');
});

test('a Sheets read that THREW is reported as an error, never as a pass', async () => {
  const sheets = {
    getSheetRows: async (tab) => { if (tab === 'Effort') throw new Error('sheets read failed'); return []; },
    getExerciseCatalog: async () => [CURRENT_CATALOG_HEADER],
  };
  const adapter = stubAdapter({ effective: {}, mirror: [] });

  const result = await withMap(synthMap(), () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));

  assert.equal(result.ready, false);
  assert.equal(readById(result, 'effort_session_ids').error, 'sheets read failed');
  assert.equal(readById(result, 'session_effort_rows').error, 'sheets read failed');
});

/* ══════════ 4. THE CATALOG ══════════ */

test('the CURRENT header form is recognised, and never normalised as data', () => {
  const withHeader = contract.normalizeCatalogRows([CURRENT_CATALOG_HEADER, ...CATALOG_DATA]);
  const withoutHeader = contract.normalizeCatalogRows(CATALOG_DATA);
  assert.equal(withHeader.length, CATALOG_DATA.length);
  assert.equal(
    contract.catalogContentHash(withHeader),
    contract.catalogContentHash(withoutHeader),
    'a header-bearing read and a header-stripped read must hash to the same catalog'
  );
  assert.equal(withHeader.some((row) => row.exercise === 'canonical_name'), false);
});

test('the LEGACY header form is still recognised', () => {
  const withHeader = contract.normalizeCatalogRows([LEGACY_CATALOG_HEADER, ...CATALOG_DATA]);
  assert.equal(withHeader.length, CATALOG_DATA.length);
  assert.equal(
    contract.catalogContentHash(withHeader),
    contract.catalogContentHash(contract.normalizeCatalogRows(CATALOG_DATA))
  );
});

test('a data row is not mistaken for a header', () => {
  assert.equal(contract.isCatalogHeaderRow(['Bench Press', 'Chest', 'BP', 'bench']), false);
  assert.equal(contract.isCatalogHeaderRow(CURRENT_CATALOG_HEADER), true);
  assert.equal(contract.isCatalogHeaderRow(LEGACY_CATALOG_HEADER), true);
  assert.equal(contract.isCatalogHeaderRow(null), false);
});

/* ── A HEADER IS THE WHOLE ROW, NEVER ITS FIRST CELL ────────────────────────── */
//
// *ChatGPT pre-review of this change, 2026-08-13.* Recognising a header from its
// FIRST CELL alone is a false green pointed the other way: an exercise legitimately
// named `Exercise` would be discarded as a header on BOTH sides, the two content
// hashes would agree, and readiness would certify a catalog that had silently lost a
// real entry.
//
// These cases are mutation-resistant by construction. Each one asserts the row's
// PRESENCE in the normalised output and pins the content hash to the hash of the same
// catalog written without any header. Narrowing recognition back to the first cell
// makes the row vanish, which moves the hash and fails both assertions — a mutation
// cannot pass by matching a looser string.

// The four-column data rows whose FIRST cell is exactly a header name. Their
// remaining cells carry catalog content, so each is a row, not a header.
const HEADER_LOOKALIKE_DATA_ROWS = [
  ['Exercise', 'Core', 'EXR', 'exercise, the movement'],
  ['Canonical_Name', 'Back', 'CNM', 'canonical name row'],
  ['Lift Code', 'Arms', 'LFC', 'lift code row'],
];

for (const dataRow of HEADER_LOOKALIKE_DATA_ROWS) {
  test(`a data row whose first cell is "${dataRow[0]}" is KEPT as data, not discarded as a header`, () => {
    assert.equal(contract.isCatalogHeaderRow(dataRow), false,
      'only the complete four-column header shape is a header');

    const rows = [...CATALOG_DATA, dataRow];
    const normalized = contract.normalizeCatalogRows([CURRENT_CATALOG_HEADER, ...rows]);

    // PRESENCE, not just a count: the row itself must survive, with its own cells.
    const kept = normalized.find((row) => row.exercise === dataRow[0].toLowerCase());
    assert.ok(kept, `${dataRow[0]} must survive normalisation as a catalog entry`);
    assert.equal(kept.display_exercise, dataRow[0]);
    assert.equal(kept.muscle_group, dataRow[1]);
    assert.equal(kept.lift_code, dataRow[2]);
    assert.equal(kept.canonical_exercise, dataRow[3]);
    assert.equal(normalized.length, rows.length);

    // And the hash is the headerless catalog's hash — the value a first-cell rule
    // could not produce, because it would be one row short.
    assert.equal(
      contract.catalogContentHash(normalized),
      contract.catalogContentHash(contract.normalizeCatalogRows(rows)),
      'dropping the look-alike row would move the content hash'
    );
  });
}

test('BOTH real headers are still skipped, in every tolerated spelling', () => {
  // The tolerance is the live reader's: case, surrounding space, and `_` versus space.
  const spellings = [
    CURRENT_CATALOG_HEADER,
    LEGACY_CATALOG_HEADER,
    ['canonical name', 'muscle group', 'lift code', 'original variants'],
    ['CANONICAL_NAME', 'MUSCLE_GROUP', 'LIFT_CODE', 'ORIGINAL_VARIANTS'],
    ['  Exercise  ', 'Muscle Group', 'Lift_Code', 'Canonical Exercise'],
  ];
  const headerless = contract.catalogContentHash(contract.normalizeCatalogRows(CATALOG_DATA));

  for (const header of spellings) {
    assert.equal(contract.isCatalogHeaderRow(header), true, `${header[0]} must be recognised`);
    const normalized = contract.normalizeCatalogRows([header, ...CATALOG_DATA]);
    assert.equal(normalized.length, CATALOG_DATA.length, `${header[0]} must not be normalised as data`);
    assert.equal(contract.catalogContentHash(normalized), headerless);
  }
});

test('a PARTIAL header match is data — every one of the four columns has to agree', () => {
  // One column off in each position. None of these is the declared header shape.
  const partials = [
    ['Canonical_Name', 'Muscle_Group', 'Lift_Code', 'Notes'],
    ['Canonical_Name', 'Muscle_Group', 'Weight', 'Original_Variants'],
    ['Canonical_Name', 'Bodypart', 'Lift_Code', 'Original_Variants'],
    ['Exercise', 'Muscle_Group', 'Lift Code', 'Original_Variants'],       // the two forms crossed
    ['Canonical_Name', 'Muscle_Group', 'Lift_Code', 'Canonical_Exercise'], // and crossed the other way
  ];
  for (const row of partials) {
    assert.equal(contract.isCatalogHeaderRow(row), false,
      `${row.join('|')} is not a complete declared header form`);
    assert.equal(contract.normalizeCatalogRows([row]).length, 1, 'and it is kept as one catalog entry');
  }
});

// FIVE CATALOG-PARITY TESTS WERE DELETED HERE, not adapted.
//
// They proved that the catalog read satisfied its live consumer, that both header
// forms compared equal, that an owner edit in Google Sheets diverged until the
// mirror synced, and that a mirror past CATALOG_MIRROR_MAX_AGE failed closed.
//
// Every one of them asserts a relationship between TWO stores. OWNER CORRECTION
// 2026-08-13 left one: Supabase owns the catalog, it is no longer a moved read,
// and compareReadPaths does not compare it. An owner edit is now the authority
// changing, not drift to be detected.
//
// The surviving catalog properties are proven in test-pg/exerciseCatalog.pgproof.js.

/* ══════════ 5. The claim this module is allowed to make ══════════ */

test('READY still requires every declared moved read to have RUN and agreed', async () => {
  const { sheetTabs, effective, map } = productionShapedCase();
  const sheets = stubSheets({ tabs: sheetTabs, catalog: [CURRENT_CATALOG_HEADER, ...CATALOG_DATA] });
  const adapter = stubAdapter({ effective, mirror: mirrorOf(CATALOG_DATA) });

  const result = await withMap(map, () => parity.compareReadPaths({ sheets, adapter, now: CATALOG_NOW }));
  assert.equal(result.reads.length, parity.MOVED_READS.length);
  assert.deepEqual(result.reads.map((r) => r.id), parity.MOVED_READS.map((r) => r.id),
    'the report covers the declared reads, in the declared order');
});
