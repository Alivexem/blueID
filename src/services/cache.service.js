'use strict';

const crypto = require('node:crypto');
const { client } = require('../config/redis');
const config = require('../config');
const logger = require('../config/logger');

/**
 * Cache facade over Upstash.
 *
 * Every method swallows its own errors. A cache outage must degrade the API to
 * "slower", never to "broken" — dashboard aggregations and reference lookups
 * all fall back to Mongo. Nothing here is ever the only copy of data.
 *
 * Two rules that exist because breaking them caused real defects:
 *
 *   1. A cache key for an authorization-dependent response must be derived
 *      from the SCOPE FILTER, not from a hand-picked subset of the user's
 *      attributes. Picking fields by hand means the day someone adds a new
 *      scope dimension, it silently does not reach the key and one officer is
 *      served another's data. `scopeHash` removes the choice.
 *
 *   2. A failed version read must disable caching, not fall back to version 1.
 *      Returning a default on error quietly moves reads and writes into a
 *      stale keyspace.
 */

const key = (...parts) => [config.redis.prefix, ...parts.filter((p) => p != null)].join(':');

/**
 * Version keys outlive every cached entry by a wide margin (30 days versus a
 * 900s maximum). If one is evicted anyway, no entry from the previous epoch
 * can still be alive, so the counter restarting at 1 cannot resurface stale
 * data.
 */
const VERSION_TTL_SECONDS = 30 * 24 * 60 * 60;

async function get(cacheKey) {
  try {
    const value = await client.get(key(cacheKey));
    if (value == null) return null;
    // The Upstash REST client already parses JSON; the memory fallback does not.
    return typeof value === 'string' ? safeParse(value) : value;
  } catch (err) {
    logger.warn({ err, cacheKey }, 'Cache read failed');
    return null;
  }
}

async function set(cacheKey, value, ttlSeconds = config.redis.ttl) {
  try {
    await client.set(key(cacheKey), value, { ex: ttlSeconds });
    return true;
  } catch (err) {
    logger.warn({ err, cacheKey }, 'Cache write failed');
    return false;
  }
}

async function del(...cacheKeys) {
  try {
    const keys = cacheKeys.flat().map((k) => key(k));
    if (!keys.length) return 0;
    return await client.del(...keys);
  } catch (err) {
    logger.warn({ err, cacheKeys }, 'Cache delete failed');
    return 0;
  }
}

/**
 * Read-through cache.
 *
 *   const stats = await cache.wrap(key, 120, () => compute());
 *
 * A null `cacheKey` means "do not cache" — `versionedKey` returns null when it
 * could not establish the namespace version, so an unreliable cache layer
 * turns into a direct read rather than a wrong answer.
 */
async function wrap(cacheKey, ttlSeconds, producer) {
  if (!cacheKey) return producer();

  const cached = await get(cacheKey);
  if (cached !== null) return cached;

  const fresh = await producer();
  if (fresh !== undefined && fresh !== null) {
    await set(cacheKey, fresh, ttlSeconds);
  }
  return fresh;
}

/**
 * Version-stamped namespaces: incrementing the version orphans every key built
 * from it, which invalidates a whole family of cached aggregates in O(1)
 * without scanning the keyspace.
 *
 * @returns {Promise<{version: number|null, ok: boolean}>}
 *   `ok: false` means the version could not be read — the caller must not
 *   cache, because it cannot know which epoch it is in.
 */
async function namespaceVersion(namespace) {
  const versionKey = key(`v:${namespace}`);

  try {
    const raw = await client.get(versionKey);

    if (raw == null) {
      /**
       * Absent means "never invalidated", which is version 0 — not 1.
       *
       * Defaulting to 1 made the FIRST bump of each namespace a no-op: the
       * initial `INCR` also returns 1, so the key was unchanged and stale
       * entries stayed live for their full TTL after a write that was meant
       * to invalidate them.
       */
      return { version: 0, ok: true };
    }

    const version = Number(raw);
    if (!Number.isFinite(version)) return { version: 0, ok: true };

    // Keep the epoch alive while it is in use.
    client.expire(versionKey, VERSION_TTL_SECONDS).catch(() => {});

    return { version, ok: true };
  } catch (err) {
    logger.warn({ err, namespace }, 'Cache version read failed — bypassing the cache');
    return { version: null, ok: false };
  }
}

async function bumpNamespace(namespace) {
  const versionKey = key(`v:${namespace}`);
  try {
    const version = await client.incr(versionKey);
    await client.expire(versionKey, VERSION_TTL_SECONDS);
    logger.debug({ namespace, version }, 'Cache namespace invalidated');
    return version;
  } catch (err) {
    logger.warn({ err, namespace }, 'Cache namespace bump failed');
    return null;
  }
}

/**
 * Builds a key that is invalidated automatically when the namespace is bumped.
 * Returns null when the version is unknown, which disables caching for that
 * call rather than risking a read from the wrong epoch.
 */
async function versionedKey(namespace, ...parts) {
  const { version, ok } = await namespaceVersion(namespace);
  if (!ok) return null;
  return `${namespace}:v${version}:${parts.join(':')}`;
}

/**
 * Fingerprints an authorization scope filter for use in a cache key.
 *
 * This is the whole defence against serving one officer's data to another:
 * the key is derived from the exact Mongo filter the cached result was
 * produced with, so two callers share an entry only when their visibility is
 * byte-for-byte identical. Adding a new scope dimension later changes the
 * filter and therefore the key, with no further code change.
 */
function scopeHash(...inputs) {
  const canonical = inputs.map((input) => stableStringify(input)).join('|');
  return crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

/**
 * JSON with deterministically ordered object keys, so `{a,b}` and `{b,a}`
 * fingerprint identically. ObjectIds and Dates are reduced to strings.
 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value instanceof Date) return `"${value.toISOString()}"`;

  if (typeof value === 'object') {
    // Mongoose ObjectId and similar wrappers.
    if (typeof value.toHexString === 'function') return `"${value.toHexString()}"`;
    if (value._bsontype) return `"${String(value)}"`;

    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `"${k}":${stableStringify(value[k])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

/**
 * Best-effort distributed lock, used so two concurrent sync batches from the
 * same device cannot interleave.
 *
 * ADVISORY ONLY. It reduces contention; it is not what makes synchronisation
 * correct. That guarantee comes from the unique index on `clientRecordId` in
 * MongoDB, which holds even with no lock at all — which is why failing to
 * acquire the lock is allowed to proceed rather than refuse a device's data.
 */
async function acquireLock(name, ttlSeconds = 30) {
  const lockKey = key('lock', name);
  try {
    const token = `${process.pid}-${Date.now()}`;
    const result = await client.set(lockKey, token, { ex: ttlSeconds, nx: true });
    return result === 'OK' ? { release: () => del(`lock:${name}`) } : null;
  } catch (err) {
    logger.warn({ err, name }, 'Lock unavailable — proceeding (Mongo enforces correctness)');
    return { release: async () => {} };
  }
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Namespaces used across the app; keeps key strings out of business logic. */
const NS = Object.freeze({
  DASHBOARD: 'dashboard',
  REFERENCE: 'reference',
  FISHERMEN: 'fishermen',
  PROGRAMMES: 'programmes',
  GIS: 'gis',
});

module.exports = {
  get,
  set,
  del,
  wrap,
  bumpNamespace,
  namespaceVersion,
  versionedKey,
  scopeHash,
  stableStringify,
  acquireLock,
  NS,
  VERSION_TTL_SECONDS,
};
