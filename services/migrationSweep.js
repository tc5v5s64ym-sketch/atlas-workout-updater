'use strict';

// The reconciliation sweep — THE COMPLETENESS AUTHORITY for S2 and S3.
// TEMPORARY: S4 deletes this module and proves it absent.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.2 ("The sweep is the
// completeness authority, not the inline record"), §3.8, §6.1 P5 and P6.
//
// ── WHY THIS EXISTS RATHER THAN A QUEUE OR A RETRY ────────────────────────────
// The shadow write runs after the athlete-facing response is decided. If the
// process dies after the Sheets write succeeds but before either the shadow write
// or its divergence row lands, Supabase lacks the rows AND the open-divergence
// count still reads zero. Any mechanism that depends on something the dying
// process was supposed to write has the same hole one level down.
//
// So this sweep depends on NOTHING in flight. Google Sheets is the write
// authority throughout S2 and S3, so it holds every committed row. The sweep
// enumerates every Sheets row of the four migrated tabs by its EXPORT IDENTITY
// KEY, enumerates every Supabase counterpart, and opens a divergence for every
// element of the symmetric difference. A process death anywhere in the window is
// therefore detectable BY CONSTRUCTION — not detectable if a handler ran.
//
// It is read-only against both stores except for the divergence rows it opens.
// It repairs nothing; services/migrationRepair.js does that.
//
// HONESTY RULE: a sweep that could not read a concept reports that concept
// INCOMPLETE and the run `complete: false`. A partial sweep is never a zero.

const contract = require('./migrationRowContract');
const legacyMap = require('./migrationLegacyIdentityMap');

const DEFAULT_CONCEPTS = contract.CONCEPT_NAMES;

function emptyConceptResult(concept) {
  return {
    concept,
    complete: false,
    sheets_rows: 0,
    supabase_rows: 0,
    missing_in_supabase: 0,
    missing_in_sheets: 0,
    content_mismatch: 0,
    divergences_opened: 0,
    error: null,
  };
}

// Index a side by identity key. A duplicate identity on the Sheets side is
// reported rather than silently collapsed: two rows with one identity is itself a
// defect the composite-key constraint refuses on the Supabase side.
//
// AN IDENTITYLESS ROW IS COUNTED, NOT DROPPED. *Required review of `65310b3`,
// finding 3.* This used to `continue` past a row with no export identity, so an
// authoritative Sheets row that Supabase can never represent disappeared from both
// sides of the comparison and the sweep still reported a clean zero. It is now
// returned as a count, and the caller makes the concept INCOMPLETE — which is the
// mechanism that already stops a gate reading a zero (§5.2 point 3).
//
// The old guard did not even catch the case it was written for: `!key || key ===
// '||'` misses `'||||'`, which is what an all-blank three-part logged_sets key
// actually joins to, so such a row was indexed under a meaningless key. One shared
// predicate on the row contract now decides it for every concept.
// A PADDED EMPTY SHEETS ARRAY IS NOT A ROW. `values.get` returns every row above a
// stray one below the data block as an all-blank array; those are the absence of a
// row, not authoritative history, so they are counted as `blank` and never as
// `identityless`. The predicate is the row contract's, shared with the backfill, so
// the two consumers cannot disagree about which arrays are rows. It matches arrays
// only, so the Supabase side — objects — is untouched. A row with even one
// populated cell is still a row and still counts as identityless.
function indexByIdentity(concept, rows, toCanonical) {
  const index = new Map();
  const duplicates = [];
  let identityless = 0;
  let blank = 0;
  for (const raw of rows) {
    if (contract.isBlankSheetRow(raw)) {
      blank += 1;
      continue;
    }
    const row = toCanonical(raw);
    const key = contract.identityKey(concept, row);
    if (contract.isIdentityless(key)) {
      identityless += 1;
      continue;
    }
    if (index.has(key)) {
      duplicates.push(key);
      continue;
    }
    index.set(key, row);
  }
  return { index, duplicates, identityless, blank };
}

async function sweepRowConcept({ concept, sheets, adapter, openDivergences }) {
  const result = emptyConceptResult(concept);
  const spec = contract.conceptSpec(concept);

  let sheetRows;
  try {
    sheetRows = await sheets.getSheetRows(spec.tab);
  } catch (error) {
    result.error = `sheets_read_failed: ${error.message}`;
    return result;
  }

  let supabaseRows;
  try {
    supabaseRows = await adapter.listConcept(concept);
  } catch (error) {
    result.error = `supabase_read_failed: ${error.message}`;
    return result;
  }

  // THE SAME RESOLVER THE BACKFILL USES, and this is not optional. Sheets holds the
  // legacy session string while Supabase holds the canonical one, so a map-unaware
  // sweep beside a map-aware backfill would open a divergence for every translated
  // row. One resolver means one verdict per row for both consumers.
  const resolved = legacyMap.resolveSheetRows(concept, sheetRows);
  const left = indexByIdentity(concept, [...resolved.rows, ...resolved.unmappedRows], (row) => row);
  const right = indexByIdentity(concept, supabaseRows, (row) => contract.rowFromSupabase(concept, row));

  result.sheets_rows = left.index.size;
  result.supabase_rows = right.index.size;
  result.sheets_duplicate_identities = left.duplicates.length;
  result.sheets_identityless = resolved.counts.no_identity;
  result.supabase_identityless = right.identityless;
  // Padding, reported for transparency. It is deliberately NOT a completeness
  // input: an absent row cannot diverge.
  result.sheets_blank_rows = resolved.counts.blank;
  result.sheets_excluded_by_owner_ruling = resolved.counts.excluded_row + resolved.counts.excluded_session;
  result.sheets_translated_from_legacy = resolved.counts.translated;
  result.sheets_surplus_identical_excluded = resolved.counts.surplus_identical;
  result.sheets_duplicate_multiplicity_mismatch = resolved.counts.duplicate_multiplicity_mismatch;
  // A legacy id the frozen map does not cover makes the concept INCOMPLETE, exactly
  // as an identityless row does. The sweep may not reconcile a tab it cannot read.
  result.sheets_unmapped_legacy = resolved.counts.unmapped_legacy;

  const toOpen = [];

  // A DUPLICATE SHEETS IDENTITY IS A FINDING, NOT A STATISTIC.
  //
  // Sheets has no unique constraint, so a tab can legitimately end up holding two
  // rows under one export identity — a hand edit, or history predating the code
  // dedupe. Supabase's unique index can hold only ONE of them, so the two stores
  // can never agree about that identity, and whichever row the index kept will
  // compare equal to the first Sheets row the sweep happened to index.
  //
  // Counting it and moving on made the run report a clean zero while an
  // authoritative row was unrepresentable in the destination — and the S3/S4
  // gates read exactly that zero. So each duplicate opens a DURABLE divergence,
  // and the concept is reported INCOMPLETE: a sweep cannot reconcile a tab whose
  // identities are not unique, and saying otherwise is the false green this whole
  // lane exists to prevent. The repair worker refuses these deliberately — only
  // the owner can decide which Sheets row is real.
  for (const key of new Set(left.duplicates)) {
    toOpen.push({
      concept,
      identityKey: key,
      sessionId: contract.sessionIdOf(concept, left.index.get(key) || {}),
      reason: 'content_mismatch',
      comparison: {
        duplicate_identity_in_sheets: true,
        occurrences: left.duplicates.filter((d) => d === key).length + 1,
      },
    });
    result.content_mismatch += 1;
  }

  // In Sheets, absent from Supabase — the process-death case, and the ordinary
  // "the shadow write threw" case. Sheets is the authority, so the row is real.
  for (const [key, row] of left.index) {
    if (!right.index.has(key)) {
      toOpen.push({
        concept,
        identityKey: key,
        sessionId: contract.sessionIdOf(concept, row),
        reason: 'missing_in_supabase',
        comparison: null,
      });
      result.missing_in_supabase += 1;
      continue;
    }
    const comparison = contract.compareRows(concept, row, right.index.get(key));
    if (!comparison.equal) {
      toOpen.push({
        concept,
        identityKey: key,
        sessionId: contract.sessionIdOf(concept, row),
        reason: 'content_mismatch',
        comparison: { differences: comparison.differences },
      });
      result.content_mismatch += 1;
    }
  }

  // In Supabase, absent from Sheets — a shadow row whose Sheets counterpart was
  // undone, or a row no live authority ever committed. Either way Sheets decides,
  // so the Supabase row is the one that is wrong.
  for (const [key, row] of right.index) {
    if (left.index.has(key)) continue;
    toOpen.push({
      concept,
      identityKey: key,
      sessionId: contract.sessionIdOf(concept, row),
      reason: 'missing_in_sheets',
      comparison: null,
    });
    result.missing_in_sheets += 1;
  }

  if (openDivergences) {
    for (const divergence of toOpen) {
      try {
        const opened = await adapter.openDivergence({ ...divergence, detectedBy: 'sweep' });
        if (opened.created) result.divergences_opened += 1;
      } catch (error) {
        result.error = `divergence_open_failed: ${error.message}`;
        return result;
      }
    }
  }

  // Complete means "the sweep could reconcile this concept", not "the sweep
  // finished running". A tab holding two rows under one identity is not
  // reconcilable, and that must reach the exit code rather than a field nobody
  // prints.
  //
  // AN IDENTITYLESS ROW MAKES IT INCOMPLETE FOR THE SAME REASON, and this is the
  // whole of finding 3's fix. Sheets is the authority and holds a row with no
  // export identity: it cannot be matched, it cannot be compared, and it cannot
  // even be given a divergence, because a divergence is keyed BY identity. The
  // honest answer is that this concept is NOT reconcilable — never a zero, and
  // never an invented key to make it representable. Only the owner can decide what
  // an identityless authoritative row means.
  const problems = [];
  if (left.duplicates.length > 0) {
    problems.push(
      `sheets_duplicate_identities: ${left.duplicates.length} row(s) share an export identity, which Supabase cannot represent`
    );
  }
  if (resolved.counts.no_identity > 0) {
    problems.push(
      `sheets_identityless: ${resolved.counts.no_identity} authoritative row(s) have NO export identity, so they cannot be ` +
      'reconciled, repaired, or recorded as a divergence. OWNER ACTION REQUIRED; no worker may invent an identity'
    );
  }
  // AND THE SAME FOR AN UNMAPPED LEGACY ID. Its row carries an identity Supabase
  // will never hold, because only the frozen map can translate it. Reconciling
  // around it would compare a legacy key against a canonical one and report a
  // divergence that no repair could ever close.
  if (resolved.counts.unmapped_legacy > 0) {
    problems.push(
      `sheets_unmapped_legacy: ${resolved.counts.unmapped_legacy} row(s) carry a legacy session_id absent from the ` +
      `frozen legacy identity map (${resolved.unmapped.length} distinct id(s)). OWNER ACTION REQUIRED; the map is ` +
      'frozen and no worker may invent an entry'
    );
  }
  // AND THE SAME FOR A STALE EXACT-DUPLICATE APPROVAL. The frozen entry claims a
  // multiplicity the tab does not have, so no copy was removed and the sweep may not
  // certify a tab against a ruling that no longer describes it.
  if (resolved.counts.duplicate_multiplicity_mismatch > 0) {
    problems.push(
      `duplicate_multiplicity_mismatch: ${resolved.counts.duplicate_multiplicity_mismatch} owner-approved ` +
      'exact-duplicate disposition(s) do not match the rows present, so no surplus copy was removed. ' +
      'OWNER ACTION REQUIRED; the map is frozen and no worker may re-approve a multiplicity'
    );
  }
  if (right.identityless > 0) {
    problems.push(
      `supabase_identityless: ${right.identityless} mirrored row(s) have no export identity and cannot be compared`
    );
  }
  result.complete = problems.length === 0;
  if (!result.complete) result.error = problems.join(' · ');
  return result;
}

// The fifth concept. Its identity is the sync generation's content_hash, not an
// export identity key, so it is compared generation-to-source rather than
// row-to-row (§3.8).
//
// During S2/S3 ONLY: an unexplained catalog drift is a migration concern, because
// Sheets is still the live authority in that era. After S4 normal edits converge
// through the permanent sync and nothing writes here (gate P7c0).
async function sweepCatalog({ sheets, adapter, openDivergences }) {
  const result = emptyConceptResult(contract.CATALOG_CONCEPT);

  let sourceRows;
  try {
    sourceRows = await sheets.getSheetRows('Exercise_Catalog');
  } catch (error) {
    result.error = `sheets_read_failed: ${error.message}`;
    return result;
  }

  let generation;
  try {
    generation = await adapter.currentCatalogGeneration();
  } catch (error) {
    result.error = `supabase_read_failed: ${error.message}`;
    return result;
  }

  const normalized = contract.normalizeCatalogRows(sourceRows);
  const sourceHash = contract.catalogContentHash(normalized);
  result.sheets_rows = normalized.length;
  result.supabase_rows = generation ? Number(generation.source_row_count || 0) : 0;

  const mirrorHash = generation ? generation.content_hash : null;
  if (mirrorHash !== sourceHash) {
    result.content_mismatch = 1;
    if (openDivergences) {
      try {
        const opened = await adapter.openDivergence({
          concept: contract.CATALOG_CONCEPT,
          // The generation's content_hash IS this concept's identity.
          identityKey: sourceHash,
          reason: 'content_mismatch',
          detectedBy: 'sweep',
          comparison: {
            mirror_generation: generation ? generation.sync_id : null,
            mirror_hash_present: Boolean(mirrorHash),
            source_row_count: normalized.length,
          },
        });
        if (opened.created) result.divergences_opened += 1;
      } catch (error) {
        result.error = `divergence_open_failed: ${error.message}`;
        return result;
      }
    }
  }

  result.complete = true;
  return result;
}

// Run the sweep over every declared concept.
//
// `openDivergences: false` makes it a pure detector, which is what the status
// tool and a dry-run want. The default is true, because the whole point of the
// sweep is that its findings become durable rows nothing in flight can lose.
async function runSweep({
  sheets,
  adapter,
  concepts = DEFAULT_CONCEPTS,
  includeCatalog = true,
  openDivergences = true,
} = {}) {
  const results = [];
  for (const concept of concepts) {
    results.push(await sweepRowConcept({ concept, sheets, adapter, openDivergences }));
  }
  if (includeCatalog) {
    results.push(await sweepCatalog({ sheets, adapter, openDivergences }));
  }

  const complete = results.every((r) => r.complete);
  const totals = results.reduce(
    (acc, r) => ({
      missing_in_supabase: acc.missing_in_supabase + r.missing_in_supabase,
      missing_in_sheets: acc.missing_in_sheets + r.missing_in_sheets,
      content_mismatch: acc.content_mismatch + r.content_mismatch,
      divergences_opened: acc.divergences_opened + r.divergences_opened,
    }),
    { missing_in_supabase: 0, missing_in_sheets: 0, content_mismatch: 0, divergences_opened: 0 }
  );

  return {
    // A SWEEP THAT HAS NOT COMPLETED IS NOT A ZERO (§5.2 point 3). Every gate that
    // reads a zero must read this flag with it.
    complete,
    concepts: results,
    totals,
    divergences_found: totals.missing_in_supabase + totals.missing_in_sheets + totals.content_mismatch,
  };
}

module.exports = {
  runSweep,
  sweepRowConcept,
  sweepCatalog,
  DEFAULT_CONCEPTS,
  // Exported for the S3 backfill reconciliation report (§6.2 P3), which must index
  // both sides by the SAME export identity this sweep uses. A second indexing
  // implementation would be a second answer to "which Supabase row is this Sheets
  // row?", and the sweep is the completeness authority — the report is a report.
  indexByIdentity,
};
