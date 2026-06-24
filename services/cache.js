// maxSize: optional entry cap. When reached, the oldest-inserted entry is
// evicted before the new one is added (insertion-order eviction via Map).
function createTtlCache(defaultTtlMs = 30000, maxSize = Infinity) {
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
    if (Number.isFinite(maxSize) && store.size >= maxSize && !store.has(key)) {
      store.delete(store.keys().next().value);
    }
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }
  return { get, set };
}

module.exports = { createTtlCache };
