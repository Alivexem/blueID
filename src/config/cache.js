'use strict';

const config = require('./index');
const logger = require('./logger');

/**
 * In-process cache.
 *
 * This deployment runs a single application instance on a server inside
 * Nigeria, so there is no external cache. Upstash was removed deliberately:
 * it held personal data — `verify:line:<BlueID>` cached a fisherman's name,
 * community and status — on infrastructure outside the country, which NITDA's
 * National Cloud Policy does not permit for identity data.
 *
 * WHAT THIS COSTS, AND WHY IT IS ACCEPTABLE HERE
 *
 * A per-process store is not shared, so with more than one instance:
 *
 *   - each instance caches separately (harmless, just less effective)
 *   - rate limits count per instance, so N instances allow N times the limit
 *   - `acquireLock` no longer excludes other instances
 *
 * The last is the dangerous one: the sync pipeline uses a lock to stop one
 * device's batch being processed twice concurrently, and processing a benefit
 * allocation twice is exactly the duplication this register exists to prevent.
 *
 * So: ONE INSTANCE ONLY. `assertSingleInstance()` runs at boot and refuses to
 * start a second in production. To scale out, move the lock to a PostgreSQL
 * advisory lock — shared, transactional, and no second datastore. The
 * Postgres migration makes that a few lines; see OPERATIONS.md.
 */

const MEMORY_LIMIT = 1000;

class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  #isExpired(entry) {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  async get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (this.#isExpired(entry)) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Honours `nx` and `xx`. This matters: the distributed lock used to
   * serialise sync batches is built on SET NX, and a fallback that ignored it
   * silently granted every caller the lock.
   */
  async set(key, value, opts = {}) {
    const existing = this.map.get(key);
    const isLive = existing && !this.#isExpired(existing);

    if (opts.nx && isLive) return null;
    if (opts.xx && !isLive) return null;

    if (!this.map.has(key) && this.map.size >= MEMORY_LIMIT) {
      // Cheap eviction: drop the oldest insertion.
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    const ttl = opts.ex ?? null;
    this.map.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
    return 'OK';
  }

  /** List operations backing the in-process job queue fallback. */
  async lpush(key, ...values) {
    const entry = this.map.get(key);
    const list = entry && !this.#isExpired(entry) && Array.isArray(entry.value) ? entry.value : [];
    list.unshift(...values.flat());
    this.map.set(key, { value: list, expiresAt: null });
    return list.length;
  }

  async rpop(key, count = 1) {
    const entry = this.map.get(key);
    if (!entry || this.#isExpired(entry) || !Array.isArray(entry.value)) return null;
    const taken = entry.value.splice(-count, count).reverse();
    return count === 1 ? (taken[0] ?? null) : taken;
  }

  async llen(key) {
    const entry = this.map.get(key);
    if (!entry || this.#isExpired(entry) || !Array.isArray(entry.value)) return 0;
    return entry.value.length;
  }

  async del(...keys) {
    let removed = 0;
    for (const key of keys.flat()) {
      if (this.map.delete(key)) removed += 1;
    }
    return removed;
  }

  async incr(key) {
    const current = Number((await this.get(key)) ?? 0);
    const next = current + 1;
    const entry = this.map.get(key);
    this.map.set(key, { value: next, expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async expire(key, seconds) {
    const entry = this.map.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async keys(pattern) {
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return [...this.map.keys()].filter((k) => regex.test(k));
  }

  async ping() {
    return 'PONG';
  }

  async flushall() {
    this.map.clear();
    return 'OK';
  }

  size() {
    return this.map.size;
  }
}

const client = new MemoryStore();

async function ping() {
  const started = Date.now();
  await client.ping();
  return Date.now() - started;
}

/**
 * Refuses to run more than one instance in production.
 *
 * The cache, the rate limiter and the sync lock are all per-process. A second
 * instance does not degrade them gracefully — it breaks the lock's only
 * guarantee. Catching that at boot is far better than discovering it as a
 * duplicated benefit allocation months later.
 */
function assertSingleInstance() {
  const instances = Number(process.env.WEB_CONCURRENCY || process.env.INSTANCES || 1);

  if (config.isProduction && instances > 1) {
    throw new Error(
      `This build keeps its cache, rate limits and sync lock in process, so it must run as a single instance (found ${instances}). ` +
        'To scale out, move the sync lock to a PostgreSQL advisory lock first — see OPERATIONS.md.'
    );
  }
}

module.exports = {
  client,
  ping,
  assertSingleInstance,
  size: () => client.size(),
  /** Retained so callers that branched on these keep working. */
  isMemoryFallback: () => true,
  isEnabled: () => true,
};
