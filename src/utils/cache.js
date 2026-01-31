// In-memory cache with stale-while-revalidate pattern
// Serves cached data instantly, refreshes in background after TTL expires

import { logger } from './logger.js';

const store = new Map();

/**
 * Get or compute a cached value.
 * - If cached and fresh: returns cached value instantly
 * - If cached but stale: returns cached value instantly AND triggers background refresh
 * - If not cached: computes, caches, and returns
 *
 * @param {string} key - Cache key
 * @param {Function} computeFn - Async function to compute the value
 * @param {number} ttlMs - Time-to-live in ms before background refresh (default 5 min)
 * @returns {Promise<any>} The cached or computed value
 */
export async function cached(key, computeFn, ttlMs = 5 * 60 * 1000) {
  const entry = store.get(key);
  const now = Date.now();

  if (entry) {
    if (now - entry.computedAt < ttlMs) {
      // Fresh — serve from cache
      return entry.value;
    }

    // Stale — serve cached but refresh in background
    if (!entry.refreshing) {
      entry.refreshing = true;
      computeFn()
        .then(value => {
          store.set(key, { value, computedAt: Date.now(), refreshing: false });
        })
        .catch(err => {
          entry.refreshing = false;
          logger.error('Cache background refresh failed', { key, error: err.message });
        });
    }
    return entry.value;
  }

  // Not cached — compute synchronously (first request pays the cost)
  const value = await computeFn();
  store.set(key, { value, computedAt: now, refreshing: false });
  return value;
}

/**
 * Invalidate a specific cache key or all keys matching a prefix
 * @param {string} keyOrPrefix - Exact key or prefix to match
 */
export function invalidate(keyOrPrefix) {
  if (store.has(keyOrPrefix)) {
    store.delete(keyOrPrefix);
    return;
  }
  // Prefix match
  for (const key of store.keys()) {
    if (key.startsWith(keyOrPrefix)) {
      store.delete(key);
    }
  }
}

/**
 * Invalidate all cache entries for a pharmacy
 * @param {string} pharmacyId
 */
export function invalidatePharmacy(pharmacyId) {
  invalidate(`pharmacy:${pharmacyId}`);
}

/**
 * Get cache stats for debugging
 */
export function cacheStats() {
  const entries = [];
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    entries.push({
      key,
      ageSeconds: Math.round((now - entry.computedAt) / 1000),
      refreshing: entry.refreshing,
    });
  }
  return { size: store.size, entries };
}
