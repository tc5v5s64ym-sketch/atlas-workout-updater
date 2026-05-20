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
  return { get, set };
}

module.exports = { createTtlCache };
