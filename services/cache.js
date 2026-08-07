function createTtlCache(defaultTtlMs = 30000) {
  const store = new Map();
  function get(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      store.delete(key);
      return null;
    }
    return hit.value;
  }
  function set(key, value, ttlMs = defaultTtlMs) {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }
  // Drop ONE key. A caller that knows exactly what its write made stale should not have to
  // throw away entries that are still true. Deleting an absent key is a no-op, so a caller
  // may name a tab this cache never holds.
  function del(key) {
    return store.delete(key);
  }
  return { get, set, delete: del };
}

module.exports = { createTtlCache };
