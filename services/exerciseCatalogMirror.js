'use strict';

// The Exercise_Catalog read mirror and its freshness authority.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §3.7 (ruling D1), §6.1
// P7b and P7b1.
//
// PERMANENT — this is not bridge machinery. Google Sheets stays the EDITING
// authority for Exercise_Catalog; Supabase becomes the Save-path READ mirror.
//
// ── WHAT IS AND IS NOT WIRED IN S2 ────────────────────────────────────────────
// `syncCatalog` HAS a live S2 consumer: the reconciliation sweep compares the
// Sheets catalog's content hash against the current verified generation, so a
// generation must exist for that comparison to mean anything.
// `readCatalogForSave` has NO S2 consumer and moves no read: S2 must not move any
// read. Its consumer is the S4 Save path (§3.7). It is built and proven here
// because the rule it enforces — fail closed past the age bound — is the property
// P7b requires proven before the schema is applied, and because the whole point of
// the mirror is that its SERVING rule cannot be invented later under deadline.
//
// ── THE RULE THAT IS EASY TO GET BACKWARDS ────────────────────────────────────
// A CHANGED SOURCE IS NOT A FAILURE. Sheets is the editing authority, so a
// different content_hash is the normal, expected signal that the owner edited the
// catalog — and ingesting it is the entire purpose of the swap. Classifying an
// ordinary catalog edit as a failure would let the generation age until Saves
// 503'd. Only a read failure, an empty or materially shrunken source, a failed
// verification, or a failed swap is a failure.
//
// ── AND THE ONE THAT IS EASY TO SOFTEN ────────────────────────────────────────
// The mirror is FAIL-CLOSED, matching the live cache exactly: sheets.js drops its
// catalog entry at expiry so no path below can fall back to it, and a failed
// refresh throws. There is no stale-after-expiry fallback here either. Serving
// stale content would enrich Saves indefinitely from content that disagrees with
// the editing authority.

const contract = require('./migrationRowContract');

// Proposed default 3600 s, with a sync interval well below it so a single failed
// sync never reaches the bound. Owner-settable; the RULE is not.
const DEFAULT_MAX_AGE_SECONDS = 3600;

// A source that lost more than this fraction of its rows is refused rather than
// allowed to replace a good catalog with a truncated one.
const DEFAULT_MAX_SHRINK_FRACTION = 0.25;

function maxAgeSeconds() {
  const raw = Number(process.env.ATLAS_CATALOG_MIRROR_MAX_AGE_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_SECONDS;
}

function maxShrinkFraction() {
  const raw = Number(process.env.ATLAS_CATALOG_MIRROR_MAX_SHRINK);
  return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : DEFAULT_MAX_SHRINK_FRACTION;
}

class CatalogSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Validate the SOURCE before anything is written. An empty read is never written,
// matching sheets.js's "An empty catalog is never cached".
function validateSource(normalized, previousRowCount) {
  if (normalized.length === 0) {
    throw new CatalogSyncError('EMPTY_SOURCE', 'The catalog source read as empty; an empty catalog is never written.');
  }
  if (previousRowCount > 0) {
    const shrink = (previousRowCount - normalized.length) / previousRowCount;
    if (shrink > maxShrinkFraction()) {
      throw new CatalogSyncError(
        'SOURCE_SHRANK',
        `The catalog source lost ${(shrink * 100).toFixed(1)}% of its rows ` +
          `(${previousRowCount} -> ${normalized.length}); refusing to replace a good catalog with a truncated one.`
      );
    }
  }
}

// One sync attempt. Returns a result rather than throwing, because the caller is
// a background job whose failure must be DURABLE (status='failed', last_error)
// rather than a thrown stack that vanishes with the process.
async function syncCatalog({ sheets, adapter } = {}) {
  let previous = null;
  try {
    previous = await adapter.currentCatalogGeneration();
  } catch (error) {
    return { ok: false, code: 'GENERATION_READ_FAILED', error: error.message, sync_id: null };
  }
  const previousRowCount = previous ? Number(previous.source_row_count || 0) : 0;

  let sourceRows;
  try {
    sourceRows = await sheets.getSheetRows('Exercise_Catalog');
  } catch (error) {
    // A read failure never advances currency and never records a generation it
    // could not read. There is no sync row to attach it to yet, so the previous
    // generation simply keeps ageing toward the bound — which is the fail-closed
    // outcome, not a silent success.
    return { ok: false, code: 'SOURCE_READ_FAILED', error: error.message, sync_id: null };
  }

  const normalized = contract.normalizeCatalogRows(sourceRows);
  const contentHash = contract.catalogContentHash(normalized);

  let syncId;
  try {
    // The hash is recorded on the ATTEMPT, not stamped at verification: §8.2
    // grants atlas_app no UPDATE on content_hash, and a failed generation that
    // records the content it attempted is better provenance anyway.
    syncId = await adapter.beginCatalogSync(normalized.length, contentHash);
  } catch (error) {
    return { ok: false, code: 'SYNC_BEGIN_FAILED', error: error.message, sync_id: null };
  }

  try {
    validateSource(normalized, previousRowCount);
    await adapter.commitCatalogSwap(syncId, normalized);
  } catch (error) {
    // status='failed' with last_error, leaving the PREVIOUS verified generation
    // current. A failure cannot buy the mirror more time.
    try {
      await adapter.failCatalogSync(syncId, error);
    } catch {
      /* the swap already failed; a failure to record it must not mask the cause */
    }
    return { ok: false, code: error.code || 'SWAP_FAILED', error: error.message, sync_id: syncId };
  }

  return {
    ok: true,
    sync_id: syncId,
    rows: normalized.length,
    content_hash: contentHash,
    // A changed hash is the normal edit case. It is reported, never recorded as a
    // failure, and currency advances.
    changed: !previous || previous.content_hash !== contentHash,
  };
}

// Freshness, as a verdict rather than a boolean, so a refusal always carries its
// exact reason.
function currencyVerdict(generation, now = Date.now()) {
  if (!generation) {
    return { servable: false, reason: 'catalog_mirror_never_synced', age_seconds: null };
  }
  const verifiedAt = generation.verified_at instanceof Date
    ? generation.verified_at.getTime()
    : Date.parse(generation.verified_at);
  if (!Number.isFinite(verifiedAt)) {
    return { servable: false, reason: 'catalog_mirror_generation_unverified', age_seconds: null };
  }
  const ageSeconds = Math.max(0, Math.floor((now - verifiedAt) / 1000));
  if (ageSeconds > maxAgeSeconds()) {
    return {
      servable: false,
      reason: 'catalog_mirror_stale',
      age_seconds: ageSeconds,
      max_age_seconds: maxAgeSeconds(),
    };
  }
  return { servable: true, reason: null, age_seconds: ageSeconds, max_age_seconds: maxAgeSeconds() };
}

// The S4 Save-path read. NOT WIRED IN S2 — no production caller exists yet, by
// design (§5.2 forbids moving a read).
//
// Past the bound the Save FAILS CLOSED with an explicit reason — the same 503
// posture the expired cache produces today. Stale content is never served
// silently, and never served at all.
async function readCatalogForSave({ adapter, now = Date.now() } = {}) {
  const generation = await adapter.currentCatalogGeneration();
  const verdict = currencyVerdict(generation, now);
  if (!verdict.servable) {
    const err = new Error(
      `Exercise catalog mirror is not servable: ${verdict.reason}` +
        (verdict.age_seconds === null ? '' : ` (age ${verdict.age_seconds}s > ${verdict.max_age_seconds}s)`)
    );
    err.code = 'CATALOG_MIRROR_UNAVAILABLE';
    err.reason = verdict.reason;
    err.status = 503;
    throw err;
  }
  const rows = await adapter.readCatalogMirror();
  return { generation, rows, currency: verdict };
}

module.exports = {
  syncCatalog,
  readCatalogForSave,
  currencyVerdict,
  validateSource,
  maxAgeSeconds,
  maxShrinkFraction,
  CatalogSyncError,
  DEFAULT_MAX_AGE_SECONDS,
};
