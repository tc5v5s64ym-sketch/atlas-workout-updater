const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// After a process restart, an `in_progress` record whose attempt began longer
// ago than this window is treated as ABANDONED (the process that started it
// died mid-write) and made retryable. Recent `in_progress` records are kept as
// duplicates so a fast crash-then-retry is still refused. Either way the
// composite-key sheet dedupe (INVARIANTS W1–W3 second line of defense) guards
// against an actual double-write; this only decides whether the retry proceeds.
const STALE_IN_PROGRESS_MS = 5 * 60 * 1000;

// Durable store: the writeRecords map is write-through persisted to a single
// JSON file so the duplicate-write shield survives a Render restart mid-session.
// Persistence is best-effort — a disk failure NEVER fails a workout write; the
// module falls back to in-memory operation with one structured warning.
const DEFAULT_IDEMPOTENCY_FILE = '/tmp/atlas-idempotency.json';

const writeRecords = new Map();
let loaded = false;
let persistDisabled = false;
let persistWarned = false;
let loadWarned = false;

function idempotencyFilePath() {
  return process.env.ATLAS_IDEMPOTENCY_FILE || DEFAULT_IDEMPOTENCY_FILE;
}

function warnOnce(flagName, event, err) {
  // One structured warn per failure class per process — enough to surface the
  // degradation without spamming the log on every subsequent write.
  const already = flagName === 'load' ? loadWarned : persistWarned;
  if (already) return;
  if (flagName === 'load') loadWarned = true; else persistWarned = true;
  try {
    console.warn(JSON.stringify({
      level: 'warn',
      module: 'idempotency',
      event,
      file: idempotencyFilePath(),
      error: err && err.message ? err.message : String(err)
    }));
  } catch (_) { /* logging must never throw into the write path */ }
}

function normalizeWriteId(writeId) {
  if (writeId === undefined || writeId === null) return null;
  const normalized = String(writeId).trim();
  return normalized || null;
}

function pruneExpired(now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  for (const [writeId, record] of writeRecords.entries()) {
    if (now - record.created_at_ms > ttlMs) {
      writeRecords.delete(writeId);
    }
  }
}

// Rehydrate the map from disk on first use. Prunes by the 24h TTL on load and
// downgrades stale `in_progress` records to `failed`. Any read/parse failure is
// swallowed (corrupt file → start empty) so a bad file can never wedge writes.
function loadFromDisk(now, ttlMs) {
  let raw;
  try {
    raw = fs.readFileSync(idempotencyFilePath(), 'utf8');
  } catch (err) {
    // ENOENT is the normal cold-start case — not a degradation worth warning on.
    if (err && err.code !== 'ENOENT') warnOnce('load', 'load_read_failed', err);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnOnce('load', 'load_parse_failed', err);
    return;
  }

  const records = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.records) ? parsed.records : []);

  for (const record of records) {
    if (!record || typeof record.write_id !== 'string') continue;
    if (typeof record.created_at_ms !== 'number') continue;
    if (now - record.created_at_ms > ttlMs) continue; // TTL prune on load

    if (record.status === 'in_progress' && (now - record.created_at_ms) > STALE_IN_PROGRESS_MS) {
      // Abandoned mid-flight write from a prior process → mark failed (retryable)
      // and invalidate its token so a stale completeWrite can never resurrect it.
      writeRecords.set(record.write_id, {
        ...record,
        status: 'failed',
        token: null,
        rehydrated: false,
        failed_at_ms: now,
        failed_at: new Date(now).toISOString()
      });
      continue;
    }

    // WRITE-3: tag a still-fresh in_progress record rehydrated from a prior process
    // so beginWrite can downgrade it once it ages past the staleness window. The
    // load-time downgrade above runs only once; an EARLY rehydration (record still
    // within the window when the file was read) would otherwise keep the write_id
    // wedged as a duplicate until the 24h TTL, because the downgrade never re-runs.
    writeRecords.set(
      record.write_id,
      record.status === 'in_progress' ? { ...record, rehydrated: true } : record
    );
  }
}

function ensureLoaded(now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  if (loaded) return;
  loaded = true; // set before loading so a throw can't trigger repeated reloads
  try {
    loadFromDisk(now, ttlMs);
  } catch (err) {
    warnOnce('load', 'load_failed', err);
  }
}

// Atomic write-through: serialize to a temp file, then rename over the target.
// On any failure we fall back to in-memory only (persistDisabled) and warn once.
function persist() {
  if (persistDisabled) return;

  const file = idempotencyFilePath();
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = JSON.stringify({ version: 1, records: [...writeRecords.values()] });

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
  } catch (err) {
    persistDisabled = true;
    warnOnce('persist', 'persist_failed', err);
    try { fs.unlinkSync(tmp); } catch (_) { /* best-effort cleanup */ }
  }
}

function beginWrite(writeId, metadata = {}, options = {}) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId) {
    return { enabled: false, write_id: null };
  }

  const now = options.now || Date.now();
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  ensureLoaded(now, ttlMs);
  pruneExpired(now, ttlMs);

  let existing = writeRecords.get(normalizedWriteId);
  // WRITE-3: an in_progress record rehydrated from a prior (crashed) process that
  // has now aged past the staleness window is ABANDONED — downgrade it here too,
  // not only at disk load. Without this, an early post-crash rehydration would keep
  // the write_id wedged as a duplicate until the 24h TTL, because the load-time
  // downgrade never re-runs in this process. Only rehydrated records are eligible:
  // an in_process in_progress record may still be running, so it stays a duplicate.
  if (existing && existing.status === 'in_progress' && existing.rehydrated === true
      && (now - existing.created_at_ms) > STALE_IN_PROGRESS_MS) {
    existing = {
      ...existing,
      status: 'failed',
      token: null,
      rehydrated: false,
      failed_at_ms: now,
      failed_at: new Date(now).toISOString()
    };
    writeRecords.set(normalizedWriteId, existing);
    persist();
  }
  // A 'failed' record is retryable: a prior attempt released without committing,
  // so fall through and start a clean attempt. Only 'in_progress' / 'completed'
  // records are genuine duplicates that must be refused or replayed.
  if (existing && existing.status !== 'failed') {
    persist(); // pruneExpired above may have dropped other expired records
    // Return a record isolated from the store: { ...existing } is only a shallow
    // copy, so clone the mutable nested fields too. Otherwise a caller mutating
    // the replayed response/metadata would corrupt the stored record.
    return {
      enabled: true,
      duplicate: true,
      write_id: normalizedWriteId,
      record: {
        ...existing,
        metadata: { ...existing.metadata },
        ...(existing.response ? { response: { ...existing.response } } : {})
      }
    };
  }

  const token = `${normalizedWriteId}:${now}:${Math.random().toString(36).slice(2)}`;
  const record = {
    write_id: normalizedWriteId,
    status: 'in_progress',
    created_at_ms: now,
    created_at: new Date(now).toISOString(),
    metadata: { ...metadata },
    token
  };

  writeRecords.set(normalizedWriteId, record);
  persist();
  return {
    enabled: true,
    duplicate: false,
    write_id: normalizedWriteId,
    token
  };
}

function completeWrite(writeId, token, response = {}, options = {}) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId) return false;

  ensureLoaded();
  const existing = writeRecords.get(normalizedWriteId);
  if (!existing || existing.token !== token) return false;

  const now = options.now || Date.now();
  writeRecords.set(normalizedWriteId, {
    ...existing,
    status: 'completed',
    completed_at_ms: now,
    completed_at: new Date(now).toISOString(),
    response: { ...response }
  });
  persist();
  return true;
}

function failWrite(writeId, token) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId) return false;

  ensureLoaded();
  const existing = writeRecords.get(normalizedWriteId);
  if (!existing || existing.token !== token) return false;

  // Mark the record 'failed' rather than deleting it. The id stays retryable
  // (beginWrite starts a clean attempt for a 'failed' record, superseding this
  // one), and until that retry the released attempt is observable as 'failed'
  // rather than silently vanishing. The token is invalidated so a stale
  // completeWrite for this released attempt can never resurrect it.
  const now = Date.now();
  writeRecords.set(normalizedWriteId, {
    ...existing,
    status: 'failed',
    token: null,
    failed_at_ms: now,
    failed_at: new Date(now).toISOString()
  });
  persist();
  return true;
}

// WRITE-2: read-only lookup of the current record for a write_id. The
// complete-workout route uses it to recover a SERVER-MINTED session id stamped on a
// prior attempt so a retry reuses that id instead of minting a fresh one — a fresh
// id would slip past the composite-key (Log) and duplicate-session (Effort) dedupes
// and double-write the whole workout. Rehydrates from disk so a crashed prior
// attempt is visible; never mutates the store (no prune, no downgrade).
function peekWrite(writeId, options = {}) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId) return null;
  const now = options.now || Date.now();
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  ensureLoaded(now, ttlMs);
  const existing = writeRecords.get(normalizedWriteId);
  if (!existing) return null;
  if (now - existing.created_at_ms > ttlMs) return null; // expired → treat as absent
  return {
    ...existing,
    metadata: { ...existing.metadata },
    ...(existing.response ? { response: { ...existing.response } } : {})
  };
}

// ── THE RECEIPT MIGRATION SEAM — TEMPORARY, S3 ONLY ──────────────────────────
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.3 ("The receipt
// migration seam — the only way into the live receipt authority"), §5.5a, §6.2 P13.
//
// EXACT SUNSET: S4 deletes this store in full — both functions below, both
// /api/migration/receipts/* routes, ATLAS_IDEMPOTENCY_FILE and the file itself —
// in one PR, and §6.3 P16 proves no caller of any of them remains. The seam exists
// solely to migrate off this store, so it dies with it. It survives a rollback
// exactly as the store does, because a rollback restores the S3 build.
//
// ── WHY IT HAS TO EXIST AT ALL ───────────────────────────────────────────────
// §5.5a reads the LIVE IN-MEMORY MAP of the frozen old process and restores a
// reverse-mapped set into that SAME LIVE PROCESS before writes reopen. Neither was
// possible: `writeRecords` and `persistDisabled` are module-private, no export can
// enumerate or replace the record set, and `ensureLoaded` sets `loaded = true`
// BEFORE reading, so the disk is read once per process — writing the JSON file
// after the process is live does NOT restore its map. Two functions close that,
// and nothing else. This is not a generic administration API.

// The OS process that answers the handover call. Minted once, with a random suffix
// because a pid is reused after a restart and a reused identity would let a
// replacement process look like the one whose map was captured.
//
// Deliberately independent of services/supabaseAdapter.js's INSTANCE_ID: this store
// is the pre-cutover authority and holds no Supabase connection, and requiring the
// adapter here would pull a database client into every consumer of the receipt
// store. They answer different questions — that one owns a Supabase receipt row,
// this one identifies the process whose private map is being carried.
const PROCESS_ID = `${require('os').hostname()}:${process.pid}:${require('crypto').randomBytes(6).toString('hex')}`;

// Read the persisted file WITHOUT touching `loaded` or the live map. This is
// evidence collection, not rehydration: §5.5a needs to know exactly which receipts
// exist ONLY in memory, because those are the ones a disk-based capture would lose.
function readDiskRecords() {
  let raw;
  try {
    raw = fs.readFileSync(idempotencyFilePath(), 'utf8');
  } catch (err) {
    return { readable: false, reason: err && err.code === 'ENOENT' ? 'absent' : 'unreadable', records: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { readable: false, reason: 'unparseable', records: [] };
  }
  const records = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.records) ? parsed.records : []);
  return { readable: true, reason: null, records: records.filter((r) => r && typeof r.write_id === 'string') };
}

// A SNAPSHOT of the live map, plus the disk-vs-map comparison §5.5a requires as
// completeness evidence. READ-ONLY: it changes no record, no status and no token.
//
// `ensureLoaded()` is called deliberately. The live authority for this process is
// whatever `beginWrite` would decide against, and `beginWrite` calls it — so a
// snapshot that skipped it would export a different set from the one actually
// deciding duplicates.
function exportLiveReceipts() {
  ensureLoaded();
  const map = [...writeRecords.values()].map((record) => ({ ...record }));
  const disk = readDiskRecords();

  const mapIds = new Set(map.map((r) => r.write_id));
  const diskById = new Map(disk.records.map((r) => [r.write_id, r]));

  // ONLY_IN_MAP IS THE WHOLE POINT. Each of these is a receipt that exists nowhere
  // but this process's memory — the exact loss a "read the file instead" capture
  // takes, and the exact loss retiring this process would cause.
  const onlyInMap = map.filter((r) => !diskById.has(r.write_id)).map((r) => r.write_id);
  const onlyOnDisk = disk.records.filter((r) => !mapIds.has(r.write_id)).map((r) => r.write_id);
  const statusDiffers = map
    .filter((r) => diskById.has(r.write_id) && diskById.get(r.write_id).status !== r.status)
    .map((r) => r.write_id);

  return {
    process_id: PROCESS_ID,
    // TRUE means persistence FAILED earlier and this process has been memory-only
    // since. Every record here is then unrecoverable from disk, which is why the
    // flag travels with the snapshot rather than being inferred from it.
    persist_disabled: persistDisabled,
    disk_vs_map: {
      disk_readable: disk.readable,
      disk_reason: disk.reason,
      disk_record_count: disk.records.length,
      map_record_count: map.length,
      only_in_map: onlyInMap,
      only_on_disk: onlyOnDisk,
      status_differs: statusDiffers,
      // The one-line verdict the runbook checks: is the disk a faithful stand-in
      // for this map? When false, only THIS export can carry the authority.
      disk_is_complete: disk.readable && onlyInMap.length === 0 && statusDiffers.length === 0,
    },
    records: map,
  };
}

const IMPORTABLE_STATUSES = new Set(['in_progress', 'completed', 'failed']);

// Validate ONE incoming record against the shape this store actually persists.
// Returns null when valid, or the reason it is not.
function receiptRejectionReason(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not_an_object';
  if (typeof record.write_id !== 'string' || record.write_id.trim() === '') return 'write_id_missing';
  if (normalizeWriteId(record.write_id) !== record.write_id) return 'write_id_not_normalized';
  if (typeof record.created_at_ms !== 'number' || !Number.isFinite(record.created_at_ms)) return 'created_at_ms_invalid';
  if (typeof record.status !== 'string' || !IMPORTABLE_STATUSES.has(record.status)) return 'status_invalid';
  if (record.metadata !== undefined && (typeof record.metadata !== 'object' || record.metadata === null || Array.isArray(record.metadata))) {
    return 'metadata_invalid';
  }
  if (record.response !== undefined && record.response !== null && (typeof record.response !== 'object' || Array.isArray(record.response))) {
    return 'response_invalid';
  }
  // A completed record with no response body cannot replay a lost response, which
  // is the one thing carrying it across the boundary is for.
  if (record.status === 'completed' && (record.response === undefined || record.response === null)) {
    return 'completed_without_response';
  }
  return null;
}

// REPLACE the live map with a verified set, and persist it.
//
// ── ALL-OR-NOTHING, AND WHY THAT IS THE FAIL-CLOSED READING ──────────────────
// §5.3 asks for a "verified reverse-mapped set" and a per-record accepted/rejected
// report. A set containing an unverifiable member is not verified, so a rejection
// aborts the whole replacement and CHANGES NOTHING. The alternative — replacing the
// map with the subset that happened to validate — would silently delete live
// duplicate-write protection for every rejected id, which is the exact class of
// loss this seam exists to prevent. The report is still returned either way.
//
// A duplicate write_id in the payload is a rejection too: two records claiming one
// id means the caller does not know what it is carrying.
function importReceipts(records) {
  const sizeBefore = writeRecords.size;
  const accepted = [];
  const rejected = [];

  if (!Array.isArray(records)) {
    return {
      process_id: PROCESS_ID, applied: false, reason: 'records_not_an_array',
      accepted: [], rejected: [], map_size_before: sizeBefore, map_size_after: sizeBefore,
      persisted: false, persist_disabled: persistDisabled,
    };
  }

  const seen = new Set();
  for (const record of records) {
    const reason = receiptRejectionReason(record) || (seen.has(record.write_id) ? 'duplicate_write_id_in_payload' : null);
    if (reason) {
      rejected.push({ write_id: record && typeof record.write_id === 'string' ? record.write_id : null, reason });
      continue;
    }
    seen.add(record.write_id);
    accepted.push(record);
  }

  if (rejected.length > 0) {
    return {
      process_id: PROCESS_ID, applied: false, reason: 'rejected_records_present',
      accepted: accepted.map((r) => r.write_id), rejected,
      map_size_before: sizeBefore, map_size_after: sizeBefore,
      persisted: false, persist_disabled: persistDisabled,
    };
  }

  writeRecords.clear();
  for (const record of accepted) {
    // Copied, never referenced: the caller's array must not stay aliased to live
    // safety state. Nested mutables are copied for the same reason beginWrite
    // clones them on the way out.
    writeRecords.set(record.write_id, {
      ...record,
      metadata: { ...(record.metadata || {}) },
      ...(record.response ? { response: { ...record.response } } : {}),
    });
  }

  // MARK LOADED. Without this, a later first call to ensureLoaded() in this process
  // would read the file and overwrite the set just restored — the same
  // read-once-per-process behaviour that made the seam necessary, turned against it.
  loaded = true;
  persist();

  return {
    process_id: PROCESS_ID, applied: true, reason: null,
    accepted: accepted.map((r) => r.write_id), rejected: [],
    map_size_before: sizeBefore, map_size_after: writeRecords.size,
    // Honest rather than optimistic: a persist that failed leaves the set live in
    // memory and says so, instead of reporting a durability it does not have.
    persisted: !persistDisabled, persist_disabled: persistDisabled,
  };
}

// ── THE SINGLE-INSTANCE HANDOVER PRECONDITION (§5.3) ─────────────────────────
//
// A pure decision, so the runbook's rule is executable rather than prose. It is
// part of the seam and dies with it at S4.
//
// ── WHY IT REFUSES RATHER THAN COLLECTS ──────────────────────────────────────
// ENUMERATION IS NOT ADDRESSABILITY. Learning from the platform that three
// processes exist does not let a request reach a chosen one, and a load balancer
// may legally route every call to the same instance forever — so "call export
// until every process is covered" is an instruction with no mechanism. The design
// refuses the collector and constrains the situation instead.
//
// ── AND IT MUST NEVER RECOMMEND A SCALE-DOWN ─────────────────────────────────
// Reducing to one instance DESTROYS THE AUTHORITY IT WAS ABOUT TO CAPTURE: this
// store is per-process, persistence is best-effort, and a process may hold an
// unexpired receipt ONLY in its private in-memory map. Retiring it erases that
// receipt before any export runs. So more than one live process ABORTS the
// cutover; it does not trigger a remedy.
//
// Both signals are required and neither is sufficient: a platform count can be
// stale, and a repeated process_id can be a routing coincidence. A disagreement
// aborts.
function handoverPreconditions({ platformLiveProcessCount, observedProcessIds } = {}) {
  const reasons = [];

  if (!Number.isInteger(platformLiveProcessCount) || platformLiveProcessCount < 1) {
    reasons.push('platform_process_count_unknown');
  } else if (platformLiveProcessCount > 1) {
    reasons.push('more_than_one_live_process');
  }

  const ids = Array.isArray(observedProcessIds) ? observedProcessIds.filter((id) => typeof id === 'string' && id) : [];
  if (ids.length === 0) reasons.push('no_process_id_observed');
  else if (new Set(ids).size > 1) reasons.push('process_id_changed_across_handover');

  return {
    proceed: reasons.length === 0,
    abort: reasons.length > 0,
    reasons,
    // Stated in the RESULT, so a caller cannot read an abort as a work item.
    remedy: reasons.length === 0
      ? null
      : 'ABORT the cutover. Do NOT scale down: retiring a process erases the in-memory ' +
        'receipts this handover exists to carry. Single-instance operation is a pre-existing ' +
        'S3 → S4 invariant, and if it was ever broken the cutover stays ineligible until a full ' +
        'receipt TTL horizon (24h) has elapsed under a stable single instance.',
    scale_down_recommended: false,
  };
}

function resetIdempotencyStore() {
  writeRecords.clear();
  // State is authoritatively empty and the file is gone — mark loaded so a
  // subsequent call in the same process does not rehydrate a stale/foreign file.
  loaded = true;
  persistDisabled = false;
  persistWarned = false;
  loadWarned = false;
  try {
    fs.unlinkSync(idempotencyFilePath());
  } catch (err) {
    if (err && err.code !== 'ENOENT') warnOnce('persist', 'reset_unlink_failed', err);
  }
}

module.exports = {
  beginWrite,
  peekWrite,
  completeWrite,
  failWrite,
  normalizeWriteId,
  resetIdempotencyStore,

  // The S3 receipt migration seam (§5.3). TEMPORARY — S4 deletes these two with
  // the store itself and proves no caller remains (§6.3 P16).
  exportLiveReceipts,
  importReceipts,
  handoverPreconditions,
  PROCESS_ID
};
