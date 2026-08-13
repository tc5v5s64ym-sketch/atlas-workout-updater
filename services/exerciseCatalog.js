'use strict';

// The exercise catalog, read from its sole authority: Supabase.
//
// AUTHORITY: OWNER CORRECTION 2026-08-13, recorded in
// docs/ATLAS_V1_EXECUTION_PLAN.md. It supersedes ruling D1.
//
// ── WHAT THIS REPLACED ────────────────────────────────────────────────────────
//
// services/exerciseCatalogMirror.js, deleted with this change. That module held a
// background sync from a Google Sheets tab, a generation table, a content hash, a
// verified timestamp, a shrink guard, a CATALOG_MIRROR_MAX_AGE bound and a
// currency verdict — every one of them an answer to "how stale is our copy of a
// Google Sheets tab". Past the bound it threw a 503 and the athlete's Save failed.
//
// That chain — Sheets tab -> background sync -> freshness clock -> stale mirror ->
// Save 503 — is the reason a Google Sheets quota exhaustion could invalidate a
// workout and the Phase 4 test campaign. The owner ruled one winner: Supabase.
// With no upstream there is no staleness, so there is no clock, no bound, and no
// stale-serving decision to get wrong.
//
// ── WHAT DID NOT COME BACK ────────────────────────────────────────────────────
//
// No cache. sheets.js kept a 60-second cross-request cache here because the read
// was an expensive quota-metered HTTP call to Google and the catalog was the
// single most-read range of the session that starved. A Supabase SELECT over a
// few hundred reference rows on an indexed primary key is not that read, and a
// cache would reintroduce a staleness question the owner correction exists to
// delete. If this read ever becomes a measured cost, the fix is a measurement,
// not a speculative cache.
//
// No fallback to Google Sheets. One winner means one winner: if Supabase is
// unreachable the Save fails the same way any other authoritative read failure
// fails it, and it says so.
//
// ── THE SHAPE, AND WHY IT IS THE SHEETS SHAPE ─────────────────────────────────
//
// Consumers receive a header row followed by data rows, exactly as
// `sheets.getExerciseCatalog()` returned. That is deliberate: `buildExerciseCatalogMap`
// and `buildExerciseCatalogEntries` already parse that shape correctly and are
// covered by their own tests, so the authority moves underneath them without a
// single parse site changing. The columns are `config/columns.js`'s
// `exerciseCatalogColumns`, which is the owner-approved order.

const { exerciseCatalogColumns } = require('../config/columns');

/**
 * The catalog, in the header-plus-rows shape every consumer already parses.
 *
 * @param {object}   deps
 * @param {object}   deps.adapter  services/supabaseAdapter.js (injectable for tests)
 * @returns {Promise<string[][]>}  `[header, ...rows]`, or `[]` when the catalog is empty
 */
async function readExerciseCatalogRows({ adapter } = {}) {
  const client = adapter || require('./supabaseAdapter');
  const rows = await client.readExerciseCatalog();
  // An empty catalog is reported as empty rather than as a lone header. A caller
  // that sees `[]` is seeing the authority, not a projection artefact — the same
  // honesty rule sheets.js applied when it refused to cache an empty read.
  if (!rows.length) return [];
  return [
    [...exerciseCatalogColumns],
    ...rows.map((row) => [
      row.display_exercise == null ? '' : String(row.display_exercise),
      row.muscle_group == null ? '' : String(row.muscle_group),
      row.lift_code == null ? '' : String(row.lift_code),
      row.canonical_exercise == null ? '' : String(row.canonical_exercise),
    ]),
  ];
}

/**
 * The inverse projection, used by the owner maintenance CLI only.
 *
 * `exercise` is the lower-cased lookup key the resolver uses and the table's
 * primary key; `display_exercise` preserves the operator's capitalisation.
 */
function catalogRowFromInput(input) {
  const display = String(input.exercise ?? input.display_exercise ?? '').trim();
  if (!display) {
    const err = new Error('Every catalog row needs an `exercise` name.');
    err.code = 'CATALOG_ROW_INVALID';
    throw err;
  }
  return {
    exercise: display.toLowerCase(),
    display_exercise: display,
    muscle_group: emptyToNull(input.muscle_group),
    lift_code: emptyToNull(input.lift_code),
    canonical_exercise: emptyToNull(input.canonical_exercise) ?? display,
  };
}

function emptyToNull(value) {
  const text = value == null ? '' : String(value).trim();
  return text === '' ? null : text;
}

module.exports = {
  readExerciseCatalogRows,
  catalogRowFromInput,
};
