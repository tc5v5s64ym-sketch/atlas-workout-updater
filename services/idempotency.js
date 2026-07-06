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
        failed_at_ms: now,
        failed_at: new Date(now).toISOString()
      });
      continue;
    }

    writeRecords.set(record.write_id, record);
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

  const existing = writeRecords.get(normalizedWriteId);
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
  completeWrite,
  failWrite,
  normalizeWriteId,
  resetIdempotencyStore
};
