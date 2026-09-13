// Minimal in-memory cache with a time-to-live.
// Good enough for a single backend instance; swap for Redis if you scale
// to multiple server instances (each instance would otherwise cache separately).

const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlSeconds) {
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

module.exports = { get, set };
