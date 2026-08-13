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
//
// ── WHAT P5 CLAIMS, EXACTLY ──────────────────────────────────────────────────
//
// *Live `Atlas Production` readiness run, 2026-08-13.* P5 claims EQUIVALENCE AFTER
// THE FROZEN OWNER-APPROVED MIGRATION DISPOSITIONS. It does not claim byte identity
// against the raw pre-migration tab, and it never did: the owner ruled some rows out
// of the migration (CARD_5 to CARD_9 and the prior 1046/1054 ruling), and Sheets
// still holds every one of them. A comparison against the RAW tab therefore measures
// the owner's own rulings as if they were data loss.
//
// That is what this module used to do. It read the Sheets side raw — through
// `getLogCompositeKeys()`, `getEffortSessionIds()` and `getSheetRows()` — and
// interpreted those rows HERE, with its own identityless rule. That was a second
// interpretation of the same tabs beside `migrationLegacyIdentityMap`, so a backfill
// and a sweep that both reported clean sat next to a readiness verdict reporting FAIL:
// the padded empty arrays the resolver classifies as `blank`, the rows the owner
// excluded, the surplus identical copies, and the translated legacy ids were all
// counted here as missing or unrepresentable rows.
//
// The second interpretation is GONE. Every Sheets input below comes from
// `legacyMap.resolveSheetRows`, the one resolver the backfill and the sweep already
// call, and its verdicts are consumed verbatim. What stays failing is what SHOULD
// fail: an unmapped legacy id, a genuinely identityless non-blank row, and an owner
// approval whose multiplicity the tab no longer matches all refuse readiness with a
// redacted, aggregate reason. No owner-actionable row is dropped to make a number
// agree.

const contract = require('./migrationRowContract');
const legacyMap = require('./migrationLegacyIdentityMap');

// ── The reads S4 moves, as they exist TODAY (the left-hand side) ─────────────
//
// Enumerated explicitly rather than discovered, so a read that S4 will move but
// that nobody listed here is a visible omission rather than a silent one. Each
// entry names the Sheets function that owns it now and the Supabase function
// below that is prospectively replacing it.
//
// `sheets` names the read S4 REMOVES. It is not the expression the comparison
// evaluates: the two key lists are DERIVED from the resolved tab (see
// `logCompositeKeysOf` and `effortSessionIdsOf`), because the raw functions
// deliberately still describe the pre-migration Sheets identities.
const MOVED_READS = Object.freeze([
  { id: 'log_composite_keys', sheets: 'sheets.getLogCompositeKeys()', tab: 'Log_Cleaned', supabase: 'logCompositeKeys()' },
  { id: 'effort_session_ids', sheets: 'sheets.getEffortSessionIds()', tab: 'Effort', supabase: 'effortSessionIds()' },
  { id: 'logged_sets_rows', sheets: "sheets.getSheetRows('Log_Cleaned')", tab: 'Log_Cleaned', supabase: "conceptRows('logged_sets')" },
  { id: 'session_effort_rows', sheets: "sheets.getSheetRows('Effort')", tab: 'Effort', supabase: "conceptRows('session_effort')" },
  { id: 'session_plan_events_rows', sheets: "sheets.getSheetRows('Session_Plans')", tab: 'Session_Plans', supabase: "conceptRows('session_plan_events')" },
  { id: 'session_plan_set_rows', sheets: "sheets.getSheetRows('Session_Plan_Sets')", tab: 'Session_Plan_Sets', supabase: "conceptRows('session_plan_set_recommendations')" },
  // The exercise catalog is NOT a moved read any more. A parity comparison asks
  // "does the new store return what the old authority returns?", and OWNER
  // CORRECTION 2026-08-13 removed the old authority for this concept: Supabase
  // owns the catalog outright. Comparing it against the Sheets tab would measure
  // drift from a tab that no longer decides anything, and would fail readiness the
  // moment the owner edited the catalog through `npm run atlas:catalog`.
]);

// The Sheets tabs whose in-request reads the cutover removes. Everything else the
// Save path reads stays on Sheets after S4 and is NOT part of P4's zero.
const MIGRATED_TABS = Object.freeze([
  'Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets', 'Exercise_Catalog',
]);

// ── TWO DIFFERENT LISTS, AND CONFLATING THEM WAS A DEFECT ────────────────────
//
// MIGRATED_TABS is "tabs whose in-request Sheets reads S4 must delete".
// MOVED_READS is "reads whose Supabase replacement is proven equal by §6.2 P5".
//
// They used to be the same set, so it was safe to require every migrated-tab read
// to be covered by a moved read. OWNER CORRECTION 2026-08-13 separated them:
// Exercise_Catalog's Sheets read must still disappear (so it stays in
// MIGRATED_TABS), but it is NOT proven by parity, because parity compares two
// stores and the catalog now has one. Its Sheets read goes away because Supabase
// OWNS the concept, not because a compared replacement matched.
//
// A tab listed here is accounted for by an authority change instead of by a parity
// proof. It is deliberately a short, explicit list: an unaccounted migrated-tab
// read must still fail, because that is a read S4 could not delete.
const SUPABASE_OWNED_TABS = Object.freeze(['Exercise_Catalog']);

// ── The two DERIVED projections, defined once and applied to BOTH sides ───────

// sheets.js:890-913 builds `session_id||exercise||set_number`, each part trimmed
// and lower-cased, skipping any row missing one of the three and any header row.
// contract.identityKey('logged_sets') is byte-for-byte that key — which is the
// point: the duplicate guard the Save path consults must not change meaning at
// cutover.
//
// ONE FUNCTION, CALLED ON BOTH SIDES. A second copy of this skip would be a second
// answer to "what does the duplicate guard see", which is the class of defect this
// module exists to DETECT rather than to contain. The skip is not a representability
// decision — that is `contract.isIdentityless`'s job, and the frozen resolver applies
// it before these rows are built. `atlas.logged_sets` declares these columns NOT NULL
// in any case, so the skip is unreachable against a valid mirror.
function logCompositeKeysOf(rows) {
  const keys = [];
  for (const row of rows) {
    if (!row.session_id || !row.exercise || row.set_number === null) continue;
    keys.push(contract.identityKey('logged_sets', row));
  }
  return keys;
}

// sheets.js:883-888 reads Effort column B, trims, and drops the header. The
// unique session_id of atlas.session_effort IS that list.
function effortSessionIdsOf(rows) {
  return rows.filter((row) => row.session_id).map((row) => String(row.session_id).trim());
}

// ── The prospective Supabase implementations (the right-hand side) ───────────

async function logCompositeKeys({ adapter }) {
  const rows = await adapter.listConcept('logged_sets');
  return logCompositeKeysOf(rows.map((raw) => contract.rowFromSupabase('logged_sets', raw)));
}

async function effortSessionIds({ adapter }) {
  const rows = await adapter.listConcept('session_effort');
  return effortSessionIdsOf(rows.map((raw) => contract.rowFromSupabase('session_effort', raw)));
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
//
// ── AN IDENTITYLESS ROW FAILS THE COMPARISON; IT DOES NOT VANISH ─────────────
//
// *Required Atlas Contract / Systems Review of `a29129e`.* This function used to
// re-derive the retired rule — `!key || key === '||' || key === ''` — which is the
// duplicate interpretation the row contract exists to replace, AND which never
// caught the reviewed case: an all-blank three-part logged_sets identity joins to
// `'||||'`, not `'||'`. So such a row was indexed under a meaningless key here
// while the sweep and the backfill were correctly failing on it.
//
// Swapping the condition for `contract.isIdentityless(key)` alone would have been
// the WRONG fix: it would still `continue`, dropping authoritative evidence from
// both sides so the sizes matched and parity reported equal. Cutover readiness
// would then be green on a tab holding a row Supabase can never represent.
//
// So the rule is consumed from its one authority, and a hit is a FAILURE. Applied
// to BOTH sides, because an unrepresentable row is unrepresentable whichever store
// holds it. No identity is invented — only the owner decides what such a row means.
//
// ── A DUPLICATE IDENTITY DOES NOT VANISH EITHER ──────────────────────────────
//
// *Live `Atlas Production` readiness run, 2026-08-13.* `if (!map.has(key))` kept the
// first row under a repeated identity and DISCARDED the rest. Both sides then held
// one row per identity, the sizes agreed, and readiness reported equal on a tab
// holding a second authoritative row Supabase's unique index can never accept. That
// is the same silent-drop class as the identityless row above, one level along, and
// the sweep already treats it as a finding rather than a statistic.
//
// The owner-approved exact duplicates are gone before this function ever sees them —
// `resolveSheetRows` removes only the surplus copies the owner froze, at the exact
// multiplicity the owner froze. What reaches here is therefore an UNDISPOSED
// duplicate, and readiness refuses it.
function compareCellSets(concept, sheetCellRows, supabaseCellRows) {
  const index = (cellRows) => {
    const map = new Map();
    let identityless = 0;
    let duplicates = 0;
    for (const cells of cellRows) {
      const row = contract.rowFromSheet(concept, cells);
      const key = contract.identityKey(concept, row);
      if (contract.isIdentityless(key)) {
        identityless += 1;
        continue;
      }
      if (map.has(key)) {
        duplicates += 1;
        continue;
      }
      map.set(key, row);
    }
    return { map, identityless, duplicates };
  };
  const leftSide = index(sheetCellRows);
  const rightSide = index(supabaseCellRows);
  const left = leftSide.map;
  const right = rightSide.map;

  if (leftSide.identityless > 0 || rightSide.identityless > 0) {
    // Counts only — a redacted reason, never a value (§3.8). The row cannot be
    // matched, compared or repaired, so readiness must refuse rather than average
    // over it.
    return {
      equal: false,
      detail: `identityless rows cannot be compared: sheets=${leftSide.identityless}, `
        + `supabase=${rightSide.identityless}. OWNER ACTION REQUIRED; no identity is invented`,
    };
  }

  if (leftSide.duplicates > 0 || rightSide.duplicates > 0) {
    return {
      equal: false,
      detail: `duplicate export identities cannot be compared: sheets=${leftSide.duplicates}, `
        + `supabase=${rightSide.duplicates}. OWNER ACTION REQUIRED; only the owner decides `
        + 'which row is authoritative',
    };
  }

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

// The four row concepts, each with the read ids DERIVED from its tab. Declared once
// so one tab is read once and resolved once, and every read derived from it sees the
// same rows. Two resolutions of one tab could disagree; one cannot.
const ROW_CONCEPTS = Object.freeze([
  { concept: 'logged_sets', rowsRead: 'logged_sets_rows' },
  { concept: 'session_effort', rowsRead: 'session_effort_rows' },
  { concept: 'session_plan_events', rowsRead: 'session_plan_events_rows' },
  { concept: 'session_plan_set_recommendations', rowsRead: 'session_plan_set_rows' },
]);

// ── THE THREE VERDICTS THAT STILL REFUSE ─────────────────────────────────────
//
// The frozen map disposes of a padded blank array, an owner-excluded row, an
// owner-approved surplus identical copy and a mapped legacy id. It disposes of
// nothing else, and these three say so:
//
//   no_identity                      a real non-blank row with an empty export
//                                    identity — Supabase can never represent it;
//   unmapped_legacy                  a legacy session id the frozen map does not
//                                    cover — nothing is guessed;
//   duplicate_multiplicity_mismatch  an owner approval whose multiplicity the tab no
//                                    longer matches — the map and the data parted.
//
// Each one means readiness cannot compare the tab, so it REFUSES rather than compare
// a set it knows is short. Counts only — a redacted reason, never a value (§3.8). The
// sweep is the lane that opens a durable divergence for these; readiness reports.
function resolutionRefusal(resolution) {
  const counts = resolution.counts;
  const reasons = [];
  if (counts.no_identity > 0) reasons.push(`identityless rows=${counts.no_identity}`);
  if (counts.unmapped_legacy > 0) reasons.push(`unmapped legacy session ids=${counts.unmapped_legacy}`);
  if (counts.duplicate_multiplicity_mismatch > 0) {
    reasons.push(`stale duplicate approvals=${counts.duplicate_multiplicity_mismatch}`);
  }
  if (reasons.length === 0) return null;
  return `the frozen migration dispositions do not cover this tab: ${reasons.join(', ')}. `
    + 'OWNER ACTION REQUIRED; no identity is invented and no row is dropped to make a count agree';
}

// Read one migrated tab and resolve it through the ONE resolver. A read failure and
// a refusal are returned rather than thrown, because both are verdicts the report has
// to carry per read.
async function resolveTab(concept, { sheets }) {
  try {
    const sheetRows = await sheets.getSheetRows(contract.conceptSpec(concept).tab);
    const resolution = legacyMap.resolveSheetRows(concept, sheetRows);
    return { resolution, refusal: resolutionRefusal(resolution), error: null };
  } catch (error) {
    return { resolution: null, refusal: null, error: error.message };
  }
}

// Run EVERY moved read on both sides and report per-read equality.
//
// A read that THREW is reported as not equal with its error, never skipped. A
// comparison that could not run is not a passing comparison, and the `ready` flag
// below is the one the S3 gate reads.
async function compareReadPaths({ sheets, adapter, now = Date.now() } = {}) {
  const results = [];

  function record(id, verdict) {
    const entry = MOVED_READS.find((r) => r.id === id);
    results.push({
      ...entry,
      equal: verdict.equal === true,
      detail: verdict.detail || null,
      error: verdict.error || null,
    });
  }

  // One read and one resolution per migrated tab, shared by every read derived
  // from it.
  const tabs = new Map();
  for (const { concept } of ROW_CONCEPTS) {
    tabs.set(concept, await resolveTab(concept, { sheets }));
  }

  // Compare one read whose Sheets side is a resolved tab. A tab that could not be
  // read, or that the frozen map does not fully cover, is reported NOT equal with its
  // exact reason and the Supabase side is never consulted: an unrunnable comparison
  // is not a passing one.
  async function check(id, concept, project, rightFn, compare) {
    const tab = tabs.get(concept);
    if (tab.error) return record(id, { equal: false, error: tab.error });
    if (tab.refusal) return record(id, { equal: false, detail: tab.refusal });
    try {
      return record(id, compare(project(tab.resolution.rows), await rightFn()));
    } catch (error) {
      return record(id, { equal: false, error: error.message });
    }
  }

  await check('log_composite_keys', 'logged_sets', logCompositeKeysOf,
    () => logCompositeKeys({ adapter }), compareKeyLists);
  await check('effort_session_ids', 'session_effort', effortSessionIdsOf,
    () => effortSessionIds({ adapter }), compareKeyLists);

  for (const { concept, rowsRead } of ROW_CONCEPTS) {
    await check(
      rowsRead,
      concept,
      // Back to the Sheets CELL SHAPE, so both sides are compared at the level the
      // prospective read actually returns. `sheetCellsFromRow` is the declared
      // inverse of `rowFromSheet`, so this invents no third representation.
      (rows) => rows.map((row) => contract.sheetCellsFromRow(concept, row)),
      () => conceptRows(concept, { adapter }),
      (left, right) => compareCellSets(concept, left, right)
    );
  }

  // The catalog used to be compared here by content hash against the Sheets tab.
  // It is not compared at all now, because it has no second store to disagree
  // with (see MOVED_READS above).

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
  SUPABASE_OWNED_TABS,
  logCompositeKeys,
  effortSessionIds,
  conceptRows,
  compareReadPaths,
  compareKeyLists,
  compareCellSets,
};
