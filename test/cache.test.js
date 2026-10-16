'use strict';

/**
 * Cache and rate-limiting tests.
 *
 * The headline case is cross-scope leakage: two officers with different
 * visibility must never share a cache entry. That defect was invisible at the
 * route layer and only observable in the generated key, so it is asserted
 * directly here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/blueid-test';
process.env.AUTH_MODE = 'disabled';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-qr-secret-value';
process.env.FIELD_ENCRYPTION_KEY =
  process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-at-least-32-chars';

const cache = require('../src/services/cache.service');
const { buildScopeFilter } = require('../src/middleware/authorize');
const { ROLES } = require('../src/config/constants');

const COOP_A = '507f1f77bcf86cd799439031';
const COOP_B = '507f1f77bcf86cd799439032';
const COMMUNITY_A = '507f1f77bcf86cd799439021';
const COMMUNITY_B = '507f1f77bcf86cd799439022';

const officer = (overrides) => ({
  _id: '507f1f77bcf86cd799439011',
  role: ROLES.LGA_ADMIN,
  scope: { lgas: ['BAK'], communities: [] },
  ...overrides,
});

/** Mirrors how the dashboard builds its cache key. */
const dashboardKey = (actor, filters = {}) =>
  cache.scopeHash(
    buildScopeFilter(actor, { ownerField: null, cooperativeField: 'cooperative.id' }),
    filters
  );

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------

test('cooperative officers of different societies do not share a cache key', () => {
  const a = officer({ role: ROLES.COOPERATIVE_OFFICER, cooperative: COOP_A });
  const b = officer({ role: ROLES.COOPERATIVE_OFFICER, cooperative: COOP_B });

  assert.notEqual(
    dashboardKey(a),
    dashboardKey(b),
    'two cooperatives sharing a key serves one officer the other society’s figures'
  );
});

test('enumerators posted to different communities do not share a cache key', () => {
  const a = officer({
    role: ROLES.ENUMERATOR,
    scope: { lgas: ['BAK'], communities: [COMMUNITY_A] },
  });
  const b = officer({
    role: ROLES.ENUMERATOR,
    scope: { lgas: ['BAK'], communities: [COMMUNITY_B] },
  });

  // Same role, same LGA — the old key would have collided here.
  assert.notEqual(dashboardKey(a), dashboardKey(b));
});

test('a state-wide role and an unscoped LGA role do not share a cache key', () => {
  const stateAdmin = officer({ role: ROLES.STATE_ADMIN, scope: { lgas: [] } });
  const unscoped = officer({ role: ROLES.LGA_ADMIN, scope: { lgas: [] } });

  // One sees everything, the other nothing; both previously keyed as "all".
  assert.notEqual(dashboardKey(stateAdmin), dashboardKey(unscoped));
});

test('identical visibility shares a cache entry', () => {
  // Caching must still work — two officers with the same scope should hit.
  const a = officer({ _id: 'aaa', scope: { lgas: ['BAK'], communities: [] } });
  const b = officer({ _id: 'bbb', scope: { lgas: ['BAK'], communities: [] } });

  assert.equal(dashboardKey(a), dashboardKey(b));
});

test('different filters produce different keys', () => {
  const actor = officer({ role: ROLES.STATE_ADMIN, scope: { lgas: [] } });
  assert.notEqual(dashboardKey(actor, { lga: 'BAK' }), dashboardKey(actor, { lga: 'ODU' }));
});

// ---------------------------------------------------------------------------
// Fingerprint stability
// ---------------------------------------------------------------------------

test('the scope fingerprint is order-independent but value-sensitive', () => {
  assert.equal(
    cache.scopeHash({ lga: 'BAK', status: 'ACTIVE' }),
    cache.scopeHash({ status: 'ACTIVE', lga: 'BAK' }),
    'key order must not change the fingerprint'
  );
  assert.notEqual(cache.scopeHash({ lga: 'BAK' }), cache.scopeHash({ lga: 'ODU' }));
  // Nested structures and arrays must be covered too.
  assert.equal(
    cache.scopeHash({ $or: [{ a: 1 }, { b: 2 }] }),
    cache.scopeHash({ $or: [{ a: 1 }, { b: 2 }] })
  );
  assert.notEqual(
    cache.scopeHash({ $or: [{ a: 1 }] }),
    cache.scopeHash({ $or: [{ a: 2 }] })
  );
});

test('stableStringify normalises ObjectId-like values and dates', () => {
  const objectIdLike = { toHexString: () => '507f1f77bcf86cd799439011' };
  assert.equal(
    cache.stableStringify(objectIdLike),
    '"507f1f77bcf86cd799439011"',
    'an ObjectId must fingerprint by value, not by instance'
  );
  assert.equal(
    cache.stableStringify(new Date('2026-01-01T00:00:00.000Z')),
    '"2026-01-01T00:00:00.000Z"'
  );
});

// ---------------------------------------------------------------------------
// Caching behaviour
// ---------------------------------------------------------------------------

test('wrap bypasses the cache when the key is null', async () => {
  let calls = 0;
  const producer = async () => {
    calls += 1;
    return { value: calls };
  };

  // A null key means the namespace version was unreadable — the producer must
  // run every time rather than risk reading from the wrong epoch.
  await cache.wrap(null, 60, producer);
  await cache.wrap(null, 60, producer);

  assert.equal(calls, 2, 'a null key must never be cached');
});

test('a cached value is reused and an invalidation orphans it', async () => {
  const ns = cache.NS.DASHBOARD;
  const keyA = await cache.versionedKey(ns, 'test', 'scope');

  let calls = 0;
  const producer = async () => ({ n: ++calls });

  assert.deepEqual(await cache.wrap(keyA, 60, producer), { n: 1 });
  assert.deepEqual(await cache.wrap(keyA, 60, producer), { n: 1 }, 'second read should hit');

  await cache.bumpNamespace(ns);
  const keyB = await cache.versionedKey(ns, 'test', 'scope');

  assert.notEqual(keyA, keyB, 'a bump must change the key');
  assert.deepEqual(await cache.wrap(keyB, 60, producer), { n: 2 }, 'the old entry is orphaned');
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test('counters are created with their expiry in one operation', async () => {
  /**
   * `INCR` followed by a separate `EXPIRE` can leave a key with no TTL if the
   * second call is lost — and an immortal counter means a permanent lockout.
   * `SET ... NX EX` establishes the lifetime atomically.
   */
  const { client } = require('../src/config/redis');
  const key = `test:ttl:${Date.now()}`;

  const first = await client.set(key, 0, { ex: 60, nx: true });
  assert.equal(first, 'OK', 'the first writer creates the key');

  const second = await client.set(key, 0, { ex: 60, nx: true });
  assert.equal(second, null, 'NX must not overwrite an existing counter');

  assert.equal(await client.incr(key), 1);
  assert.equal(await client.incr(key), 2, 'the counter still increments normally');

  await client.del(key);
});

test('the memory fallback honours NX, so the sync lock actually locks', async () => {
  const { client } = require('../src/config/redis');
  const key = `test:lock:${Date.now()}`;

  assert.equal(await client.set(key, 'first', { ex: 30, nx: true }), 'OK');
  assert.equal(
    await client.set(key, 'second', { ex: 30, nx: true }),
    null,
    'a fallback that ignored NX would hand the lock to every caller'
  );

  await client.del(key);
});

test('identify keys by account before IP, and normalises IPv6 to a /64', () => {
  const { identify } = require('../src/middleware/rateLimiter');
  const req = (overrides) => ({ get: () => undefined, ip: '1.2.3.4', ...overrides });

  assert.equal(identify(req({ principalId: 'abc' })), 'u:abc');
  assert.equal(identify(req({ user: { id: 'xyz' } })), 'u:xyz');
  assert.equal(identify(req()), 'ip:1.2.3.4');

  // A subscriber is routinely handed a whole /64; keying the full address
  // would let them rotate freely within it.
  const v6 = identify(req({ ip: '2001:0db8:85a3:0000:1111:2222:3333:4444' }));
  assert.match(v6, /^ip:2001:0db8:85a3:0000::\/64$/);
});
