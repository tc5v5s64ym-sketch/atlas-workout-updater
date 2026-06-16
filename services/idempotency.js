const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const writeRecords = new Map();

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

function beginWrite(writeId, metadata = {}, options = {}) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId) {
    return { enabled: false, write_id: null };
  }

  const now = options.now || Date.now();
  pruneExpired(now, options.ttlMs || DEFAULT_TTL_MS);

  const existing = writeRecords.get(normalizedWriteId);
  // A 'failed' record is retryable: a prior attempt released without committing,
  // so fall through and start a clean attempt. Only 'in_progress' / 'completed'
  // records are genuine duplicates that must be refused or replayed.
  if (existing && existing.status !== 'failed') {
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
  return true;
}

function failWrite(writeId, token) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId) return false;

  const existing = writeRecords.get(normalizedWriteId);
  if (!existing || existing.token !== token) return false;

  // Mark the record 'failed' rather than deleting it. The id stays retryable
  // (beginWrite starts a clean attempt for a 'failed' record), but the record is
  // retained for audit instead of silently vanishing. The token is invalidated
  // so a stale completeWrite for this released attempt can never resurrect it.
  const now = Date.now();
  writeRecords.set(normalizedWriteId, {
    ...existing,
    status: 'failed',
    token: null,
    failed_at_ms: now,
    failed_at: new Date(now).toISOString()
  });
  return true;
}

function resetIdempotencyStore() {
  writeRecords.clear();
}

module.exports = {
  beginWrite,
  completeWrite,
  failWrite,
  normalizeWriteId,
  resetIdempotencyStore
};
