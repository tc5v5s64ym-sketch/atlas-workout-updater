'use strict';

// The divergence repair worker. TEMPORARY — S4 deletes this module and proves it absent.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §3.8 (state transitions),
// §6.1 P7 (a divergence is not closable without closure_proof, by a lapsed lease,
// or by a timer), §7.1 rule 2 (Atlas never reconciles two authorities silently).
//
// ── THE CLOSURE RULE, WHICH IS THE WHOLE POINT ────────────────────────────────
// A divergence closes ONLY after an EXACT identity-and-content RE-COMPARISON of
// the two stores passes, and the closure records the proof of that comparison.
// It is never closed by a timer, never aged out, never closed because a repair
// statement reported success, and never closed because it looked old. A repair
// that ran is not a repair that worked.
//
// Three independent things enforce it:
//   1. this worker re-reads BOTH sides after repairing and compares them through
//      services/migrationRowContract.js — the same comparison the sweep used;
//   2. the close statement carries a matching claim token, so a lapsed lease
//      cannot close a row another worker now owns;
//   3. the table's own CHECK refuses a 'closed' row with no closure_proof, so a
//      second implementation could not close one either.
//
// ── WHAT IT MAY AND MAY NOT REPAIR ────────────────────────────────────────────
// Sheets is the live authority, so repair always means "make Supabase agree with
// Sheets" — never the reverse, and never an average or a most-recent-wins merge.
//
//   missing_in_supabase  → insert the Sheets row, parent-first. write_id is NULL,
//                          because the sweep genuinely cannot know it: Log_Cleaned
//                          and Effort carry no write_id column. It never fabricates one.
//   missing_in_sheets    → delete the Supabase-only row, but ONLY for logged_sets,
//                          because §8.2 grants the runtime DELETE there and nowhere
//                          else in the workout schema.
//   content_mismatch     → delete-then-reinsert, again ONLY for logged_sets.
//   exercise_catalog     → not repaired here. Its convergence path is the catalog
//                          sync's own transactional swap.
//
// Everything else stays OPEN with its attempt counted and its reason recorded, so
// it reaches the owner as owner action required. AN UNREPAIRABLE DIVERGENCE IS
// NEVER CLOSED. Leaving it open is the honest outcome; a repair worker that
// closed what it could not fix would make the S3 zero-divergence gate a lie.

const contract = require('./migrationRowContract');

const DEFAULT_LEASE_SECONDS = 120;

// The concepts this worker holds a grant to mutate. Kept beside the grant list it
// mirrors, so a future grant change that is not reflected here shows up as a
// permission error in the proof rather than as silent non-repair.
const DELETABLE_CONCEPTS = new Set(['logged_sets']);

function outcome(divergence, state, detail) {
  return {
    id: divergence.id,
    concept: divergence.concept,
    identity_key: divergence.identity_key,
    reason: divergence.reason,
    state,
    detail,
  };
}

// Re-read ONE identity from both stores and compare. This is the only thing that
// may authorise a close.
async function reCompare({ concept, identityKey, sheets, adapter }) {
  const spec = contract.conceptSpec(concept);
  const sheetRows = await sheets.getSheetRows(spec.tab);
  const supabaseRows = await adapter.listConcept(concept);

  const findIn = (rows, toCanonical) => {
    for (const raw of rows) {
      const row = toCanonical(raw);
      if (contract.identityKey(concept, row) === identityKey) return row;
    }
    return null;
  };

  const sheetRow = findIn(sheetRows, (cells) => contract.rowFromSheet(concept, cells));
  const supabaseRow = findIn(supabaseRows, (row) => contract.rowFromSupabase(concept, row));

  if (!sheetRow && !supabaseRow) {
    // Genuine convergence: neither store holds the identity. That IS agreement,
    // and it is the correct closure for a repaired Supabase-only orphan.
    return { converged: true, proof: `recompare: absent in both stores (identity=${identityKey})`, differences: [] };
  }
  if (!sheetRow || !supabaseRow) {
    return {
      converged: false,
      proof: null,
      differences: [{ field: '*', sheets: sheetRow ? 'present' : 'absent', supabase: supabaseRow ? 'present' : 'absent' }],
    };
  }
  const comparison = contract.compareRows(concept, sheetRow, supabaseRow);
  return {
    converged: comparison.equal,
    proof: comparison.equal
      ? `recompare: identity=${identityKey} present in both stores, ${spec.fields.filter((f) => f.compare !== false).length} compared fields equal`
      : null,
    differences: comparison.differences,
  };
}

async function repairOne({ divergence, sheets, adapter, leaseSeconds }) {
  const claim = await adapter.claimDivergence(divergence.id, leaseSeconds);
  if (!claim) return outcome(divergence, 'not_claimed', 'another worker holds a live lease');
  const token = claim.repair_claim_token;

  const concept = divergence.concept;
  if (concept === contract.CATALOG_CONCEPT) {
    await adapter.releaseDivergence(divergence.id, token, {
      not_repairable_here: 'exercise_catalog converges through the catalog sync swap, not the repair worker',
    });
    return outcome(divergence, 'left_open', 'catalog convergence is the sync job, not this worker');
  }

  let repairDetail = null;
  try {
    if (divergence.reason === 'missing_in_supabase') {
      const spec = contract.conceptSpec(concept);
      const sheetRows = await sheets.getSheetRows(spec.tab);
      let source = null;
      for (const cells of sheetRows) {
        const row = contract.rowFromSheet(concept, cells);
        if (contract.identityKey(concept, row) === divergence.identity_key) {
          source = row;
          break;
        }
      }
      if (!source) {
        // The authority no longer holds the row either. Do NOT insert something
        // Sheets does not have; fall through to the re-comparison, which will see
        // "absent in both" and close on genuine convergence.
        repairDetail = 'source row absent from Sheets at repair time';
      } else {
        const inserted = await adapter.repairInsert(concept, source);
        repairDetail = `inserted=${inserted.inserted}`;
      }
    } else if (divergence.reason === 'missing_in_sheets' || divergence.reason === 'content_mismatch') {
      if (!DELETABLE_CONCEPTS.has(concept)) {
        await adapter.releaseDivergence(divergence.id, token, {
          not_repairable: `no declared principal may mutate ${concept} for reason ${divergence.reason}`,
        });
        return outcome(divergence, 'left_open', `owner action required: ${concept}/${divergence.reason}`);
      }
      const deleted = await adapter.repairDeleteLoggedSet(divergence.identity_key);
      repairDetail = `deleted=${deleted.deleted}`;
      if (divergence.reason === 'content_mismatch') {
        const spec = contract.conceptSpec(concept);
        const sheetRows = await sheets.getSheetRows(spec.tab);
        for (const cells of sheetRows) {
          const row = contract.rowFromSheet(concept, cells);
          if (contract.identityKey(concept, row) === divergence.identity_key) {
            const inserted = await adapter.repairInsert(concept, row);
            repairDetail += ` reinserted=${inserted.inserted}`;
            break;
          }
        }
      }
    } else if (divergence.reason === 'shadow_write_failed') {
      // An inline record of a KNOWN failure. It carries the session, not the row,
      // so the repair is "re-derive from Sheets", which is exactly what the sweep
      // already did for every affected identity. Re-comparing is the whole job.
      repairDetail = 'inline record; convergence decided by re-comparison';
    } else {
      await adapter.releaseDivergence(divergence.id, token, { unhandled_reason: divergence.reason });
      return outcome(divergence, 'left_open', `unhandled reason ${divergence.reason}`);
    }
  } catch (error) {
    await adapter.releaseDivergence(divergence.id, token, { repair_error: String(error.message).slice(0, 500) });
    return outcome(divergence, 'left_open', `repair failed: ${error.message}`);
  }

  // THE ONLY PATH TO 'closed'.
  let verdict;
  try {
    verdict = await reCompare({ concept, identityKey: divergence.identity_key, sheets, adapter });
  } catch (error) {
    await adapter.releaseDivergence(divergence.id, token, { recompare_error: String(error.message).slice(0, 500) });
    return outcome(divergence, 'left_open', `re-comparison failed: ${error.message}`);
  }

  if (!verdict.converged) {
    await adapter.releaseDivergence(divergence.id, token, { differences: verdict.differences });
    return outcome(divergence, 'left_open', `re-comparison did not converge (${repairDetail})`);
  }

  const closed = await adapter.closeDivergence(divergence.id, token, verdict.proof, { differences: [] });
  if (!closed) {
    // The claim token no longer matched — another worker took the lease. Leaving
    // it to that worker is correct; forcing the close would be closing a row this
    // worker does not own.
    return outcome(divergence, 'left_open', 'claim token no longer matched at close');
  }
  return outcome(divergence, 'closed', `${repairDetail}; ${verdict.proof}`);
}

async function runRepair({ sheets, adapter, limit = 200, leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
  const open = await adapter.listOpenDivergences(limit);
  const results = [];
  for (const divergence of open) {
    results.push(await repairOne({ divergence, sheets, adapter, leaseSeconds }));
  }
  const summary = await adapter.divergenceSummary();
  return {
    examined: open.length,
    closed: results.filter((r) => r.state === 'closed').length,
    left_open: results.filter((r) => r.state === 'left_open').length,
    not_claimed: results.filter((r) => r.state === 'not_claimed').length,
    results,
    open_after: Number(summary.open_count || 0),
  };
}

module.exports = { runRepair, repairOne, reCompare, DELETABLE_CONCEPTS };
