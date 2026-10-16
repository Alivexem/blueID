'use strict';

const { Redis } = require('@upstash/redis');
const config = require('./index');
const logger = require('./logger');

/**
 * Upstash Redis over its REST API.
 *
 * Caching is an optimisation, never a dependency: when Upstash is not
 * configured (fresh clone, local dev) we fall back to a bounded in-process map
 * so the API still runs. Nothing in the domain layer should care which is live.
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
}

let client;
let usingMemory = false;

if (config.redis.enabled) {
  client = new Redis({
    url: config.redis.url,
    token: config.redis.token,
    // The REST client retries idempotent reads; keep it short so a slow cache
    // never dominates a request.
    retry: { retries: 2, backoff: (attempt) => Math.min(100 * 2 ** attempt, 500) },
  });
  logger.info('Redis: Upstash REST client initialised');
} else {
  client = new MemoryStore();
  usingMemory = true;
  const message = 'Redis not configured — using in-memory cache fallback';
  if (config.isProduction) logger.error(message);
  else logger.warn(message);
}

async function ping() {
  const started = Date.now();
  await client.ping();
  return Date.now() - started;
}

module.exports = {
  client,
  isMemoryFallback: () => usingMemory,
  isEnabled: () => config.redis.enabled,
  ping,
};
