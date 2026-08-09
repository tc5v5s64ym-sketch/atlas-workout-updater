'use strict';

// THE PROSPECTIVE S4 READ PATHS, and the parity verdict that proves them.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.3 (PR S3: "prove
// cutover readiness"), §5.4 step 3 (the reads S4 moves), §6.2 P1, P4 and P5.
//
// ── S3 MOVES NO READ, AND THIS MODULE IS WHY IT DOES NOT HAVE TO ─────────────
// Ruling D5: reads and writes move together, at S4. Nothing here has a production
// consumer, nothing here is called from a request path, and Google Sheets decides
// every athlete-facing read until the cutover. What this module is, exactly, is the
// answer to a question S4 must not be asked for the first time under deadline:
// "does the backfilled database return what the workbook returns today?"
//
// ── THE NO-ORPHAN ACCOUNTING ─────────────────────────────────────────────────
// Named consumer: the S4 cutover, which moves these implementations onto the live
// Save and read paths. Closure condition: S4 wires them and deletes the Sheets
// hot-path reads (§5.4 step 3). `compareReadPaths` is the temporary half — it is
// the readiness proof, and it dies with the backfill machinery at S4. This is the
// slice §6.2 P1/P5 name, not a speculative layer.
//
// ── WHY THE COMPARISON IS NOT JUST THE RECONCILIATION AGAIN ──────────────────
// §6.2 P3 proves the ROWS match. This proves the READS match, which is a different
// claim: the duplicate-guard reads and the catalog read are DERIVED PROJECTIONS of
// those rows, so a byte-perfect row backfill can still produce a different
// composite-key list if the projection differs by a trim, a case fold or a header
// skip. Those projections are what the Save path actually consults, so they are
// what cutover readiness has to be about.

const contract = require('./migrationRowContract');
const catalogMirror = require('./exerciseCatalogMirror');

// ── The reads S4 moves, as they exist TODAY (the left-hand side) ─────────────
//
// Enumerated explicitly rather than discovered, so a read that S4 will move but
// that nobody listed here is a visible omission rather than a silent one. Each
// entry names the Sheets function that owns it now and the Supabase function
// below that is prospectively replacing it.
const MOVED_READS = Object.freeze([
  { id: 'log_composite_keys', sheets: 'sheets.getLogCompositeKeys()', tab: 'Log_Cleaned', supabase: 'logCompositeKeys()' },
  { id: 'effort_session_ids', sheets: 'sheets.getEffortSessionIds()', tab: 'Effort', supabase: 'effortSessionIds()' },
  { id: 'logged_sets_rows', sheets: "sheets.getSheetRows('Log_Cleaned')", tab: 'Log_Cleaned', supabase: "conceptRows('logged_sets')" },
  { id: 'session_effort_rows', sheets: "sheets.getSheetRows('Effort')", tab: 'Effort', supabase: "conceptRows('session_effort')" },
  { id: 'session_plan_events_rows', sheets: "sheets.getSheetRows('Session_Plans')", tab: 'Session_Plans', supabase: "conceptRows('session_plan_events')" },
  { id: 'session_plan_set_rows', sheets: "sheets.getSheetRows('Session_Plan_Sets')", tab: 'Session_Plan_Sets', supabase: "conceptRows('session_plan_set_recommendations')" },
  { id: 'exercise_catalog', sheets: 'sheets.getExerciseCatalog()', tab: 'Exercise_Catalog', supabase: 'exerciseCatalogRows()' },
]);

// The Sheets tabs whose in-request reads the cutover removes. Everything else the
// Save path reads stays on Sheets after S4 and is NOT part of P4's zero.
const MIGRATED_TABS = Object.freeze([
  'Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets', 'Exercise_Catalog',
]);

// ── The prospective Supabase implementations (the right-hand side) ───────────

// sheets.js:890-913 builds `session_id||exercise||set_number`, each part trimmed
// and lower-cased, skipping any row missing one of the three and any header row.
// contract.identity('logged_sets') is byte-for-byte that key — which is the point:
// the duplicate guard the Save path consults must not change meaning at cutover.
async function logCompositeKeys({ adapter }) {
  const rows = await adapter.listConcept('logged_sets');
  const keys = [];
  for (const raw of rows) {
    const row = contract.rowFromSupabase('logged_sets', raw);
    if (!row.session_id || !row.exercise || row.set_number === null) continue;
    keys.push(contract.identityKey('logged_sets', row));
  }
  return keys;
}

// sheets.js:883-888 reads Effort column B, trims, and drops the header. The
// unique session_id of atlas.session_effort IS that list.
async function effortSessionIds({ adapter }) {
  const rows = await adapter.listConcept('session_effort');
  return rows
    .map((raw) => contract.rowFromSupabase('session_effort', raw))
    .filter((row) => row.session_id)
    .map((row) => String(row.session_id).trim());
}

// A concept's rows in the SHEETS CELL SHAPE — the 12/9/13/16-cell arrays every
// current consumer of getSheetRows() already parses. The projection is
// contract.sheetCellsFromRow, the declared inverse of the mapping the backfill
// used, so no third representation is invented here.
//
// NO HEADER ROW. getSheetRows() returns one because a spreadsheet has one; a table
// does not. Consumers skip it by identity today, and the parity comparison below
// is identity-keyed for exactly this reason.
async function conceptRows(concept, { adapter }) {
  const rows = await adapter.listConcept(concept);
  return rows.map((raw) => contract.sheetCellsFromRow(concept, contract.rowFromSupabase(concept, raw)));
}

// The catalog read, served from the mirror and FAIL-CLOSED past the age bound —
// the same 503 posture the expired Sheets cache produces today. Stale content is
// never served silently, and never served at all.
async function exerciseCatalogRows({ adapter, now = Date.now() }) {
  const served = await catalogMirror.readCatalogForSave({ adapter, now });
  return served.rows.map((row) => [
    row.display_exercise, row.muscle_group ?? '', row.lift_code ?? '', row.canonical_exercise ?? '',
  ]);
}

// ── The parity verdict (§6.2 P5) ─────────────────────────────────────────────

// Compare two key lists as MULTISETS. Neither store promises an order — Sheets
// returns row order, Postgres returns whatever the plan produces — and no consumer
// depends on one (the Save path calls `.includes()`). Sorting is therefore the
// honest comparison, and a differing COUNT is still caught, because a multiset
// keeps duplicates.
function compareKeyLists(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  if (a.length !== b.length) {
    return { equal: false, detail: `sheets=${a.length} supabase=${b.length}` };
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      // The differing element is an identity key, not a workout value — but it
      // does carry an exercise name, so only its SHAPE is reported (§3.8).
      return { equal: false, detail: `element ${i} differs: ${contract.shapeOf(a[i])} vs ${contract.shapeOf(b[i])}` };
    }
  }
  return { equal: true, detail: null };
}

// Identity-keyed, field-by-field, through contract.compareRows — the same
// comparison the sweep and the repair worker use. Two comparison implementations
// would be two authorities.
function compareCellSets(concept, sheetCellRows, supabaseCellRows) {
  const index = (cellRows) => {
    const map = new Map();
    for (const cells of cellRows) {
      const row = contract.rowFromSheet(concept, cells);
      const key = contract.identityKey(concept, row);
      if (!key || key === '||' || key === '') continue;   // header rows and blanks
      if (!map.has(key)) map.set(key, row);
    }
    return map;
  };
  const left = index(sheetCellRows);
  const right = index(supabaseCellRows);

  if (left.size !== right.size) {
    return { equal: false, detail: `sheets=${left.size} rows, supabase=${right.size} rows` };
  }
  for (const [key, row] of left) {
    const counterpart = right.get(key);
    if (!counterpart) return { equal: false, detail: 'an identity present in Sheets is absent from Supabase' };
    const comparison = contract.compareRows(concept, row, counterpart);
    if (!comparison.equal) {
      return { equal: false, detail: `field difference: ${comparison.differences.map((d) => d.field).join(', ')}` };
    }
  }
  return { equal: true, detail: null };
}

// Run EVERY moved read on both sides and report per-read equality.
//
// A read that THREW is reported as not equal with its error, never skipped. A
// comparison that could not run is not a passing comparison, and the `ready` flag
// below is the one the S3 gate reads.
async function compareReadPaths({ sheets, adapter, now = Date.now() } = {}) {
  const results = [];

  async function check(id, leftFn, rightFn, compare) {
    const entry = MOVED_READS.find((r) => r.id === id);
    try {
      const [left, right] = [await leftFn(), await rightFn()];
      const verdict = compare(left, right);
      results.push({ ...entry, equal: verdict.equal, detail: verdict.detail, error: null });
    } catch (error) {
      results.push({ ...entry, equal: false, detail: null, error: error.message });
    }
  }

  await check(
    'log_composite_keys',
    () => sheets.getLogCompositeKeys(),
    () => logCompositeKeys({ adapter }),
    compareKeyLists
  );
  await check(
    'effort_session_ids',
    () => sheets.getEffortSessionIds(),
    () => effortSessionIds({ adapter }),
    compareKeyLists
  );

  const rowConcepts = [
    ['logged_sets_rows', 'logged_sets'],
    ['session_effort_rows', 'session_effort'],
    ['session_plan_events_rows', 'session_plan_events'],
    ['session_plan_set_rows', 'session_plan_set_recommendations'],
  ];
  for (const [id, concept] of rowConcepts) {
    await check(
      id,
      () => sheets.getSheetRows(contract.conceptSpec(concept).tab),
      () => conceptRows(concept, { adapter }),
      (left, right) => compareCellSets(concept, left, right)
    );
  }

  // The catalog compares through its own content hash, because that hash IS the
  // mirror generation's identity (§3.7) and normalizing both sides the same way is
  // what makes "the same catalog" mean one thing rather than two.
  await check(
    'exercise_catalog',
    () => sheets.getExerciseCatalog(),
    () => exerciseCatalogRows({ adapter, now }),
    (left, right) => {
      const leftHash = contract.catalogContentHash(contract.normalizeCatalogRows(left));
      const rightHash = contract.catalogContentHash(contract.normalizeCatalogRows(right));
      return leftHash === rightHash
        ? { equal: true, detail: null }
        : { equal: false, detail: 'catalog content hashes differ' };
    }
  );

  return {
    // READY means every declared moved read was RUN and returned the same answer
    // on both sides. A read that threw makes this false; so does an empty list, so
    // a comparison set that silently shrank cannot report readiness.
    ready: results.length === MOVED_READS.length && results.every((r) => r.equal === true),
    reads: results,
    moved_read_count: MOVED_READS.length,
  };
}

module.exports = {
  MOVED_READS,
  MIGRATED_TABS,
  logCompositeKeys,
  effortSessionIds,
  conceptRows,
  exerciseCatalogRows,
  compareReadPaths,
  compareKeyLists,
  compareCellSets,
};
