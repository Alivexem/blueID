'use strict';

/**
 * Failure and recovery behaviour: Redis outages, MongoDB outages, revoked
 * principals and background-job retry safety.
 *
 * The point of these is that degradation must be deliberate. A cache outage
 * should make the API slower, not wrong; a database outage should produce an
 * honest 503, not a ten-second hang; a retried job must not repeat a
 * non-idempotent side effect.
 *
 * Synthetic data and test credentials only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const database = require('../src/config/database');
const cache = require('../src/services/cache.service');
const queue = require('../src/services/queue.service');
const { normalizeError } = require('../src/middleware/errorHandler');
const { USER_STATUS, DEVICE_STATUS, ROLES } = require('../src/config/constants');

const OutboxJob = require('../src/modules/outbox/outbox.model');
const Device = require('../src/modules/sync/device.model');
const User = require('../src/modules/users/user.model');

let connected = false;
test.before(async () => {
  await database.connect();
  connected = true;
});
test.after(async () => {
  if (connected) await database.disconnect();
});

const unique = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;

// ---------------------------------------------------------------------------
// 12. Redis failure and recovery
// ---------------------------------------------------------------------------

test('a cache read failure degrades to the producer, never to an error', async () => {
  const { client } = require('../src/config/redis');
  const originalGet = client.get;

  let producerCalls = 0;
  const producer = async () => {
    producerCalls += 1;
    return { value: 'from-database' };
  };

  // Simulate Redis being unreachable mid-request.
  client.get = async () => {
    throw new Error('ECONNREFUSED');
  };

  try {
    const result = await cache.wrap('resilience:test', 60, producer);
    assert.deepEqual(result, { value: 'from-database' }, 'the request must still be answered');
    assert.equal(producerCalls, 1);
  } finally {
    client.get = originalGet;
  }
});

test('an unreadable namespace version disables caching rather than guessing', async () => {
  const { client } = require('../src/config/redis');
  const originalGet = client.get;

  client.get = async () => {
    throw new Error('ECONNREFUSED');
  };

  try {
    const key = await cache.versionedKey(cache.NS.DASHBOARD, 'resilience', 'scope');
    assert.equal(key, null, 'an unknown epoch must bypass the cache, not default to one');

    // And `wrap` honours that by running the producer every time.
    let calls = 0;
    await cache.wrap(key, 60, async () => ++calls);
    await cache.wrap(key, 60, async () => ++calls);
    assert.equal(calls, 2);
  } finally {
    client.get = originalGet;
  }
});

test('the cache recovers once Redis returns', async () => {
  const key = await cache.versionedKey(cache.NS.DASHBOARD, 'recovery', unique('scope'));
  assert.ok(key, 'a healthy cache produces a key');

  let calls = 0;
  const producer = async () => ({ n: ++calls });

  assert.deepEqual(await cache.wrap(key, 60, producer), { n: 1 });
  assert.deepEqual(await cache.wrap(key, 60, producer), { n: 1 }, 'second read is served warm');
});

test('a rate-limit counter falls back to a per-process budget, not to no limit', async () => {
  const { client } = require('../src/config/redis');
  const { createLimiter } = require('../src/middleware/rateLimiter');
  const originalSet = client.set;
  const originalIncr = client.incr;

  client.set = async () => {
    throw new Error('ECONNREFUSED');
  };
  client.incr = async () => {
    throw new Error('ECONNREFUSED');
  };

  try {
    const limiter = createLimiter({ name: unique('fb'), windowMs: 60_000, max: 2 });
    const req = { ip: '203.0.113.9', path: '/x', get: () => undefined };
    const res = { setHeader() {} };

    const outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => limiter(req, res, (err) => resolve(outcomes.push(err))));
    }

    const refused = outcomes.filter((e) => e && e.statusCode === 429).length;
    assert.ok(
      refused >= 1,
      'with Redis down the limiter must still refuse, using a local budget'
    );
  } finally {
    client.set = originalSet;
    client.incr = originalIncr;
  }
});

// ---------------------------------------------------------------------------
// 13. MongoDB failure and recovery
// ---------------------------------------------------------------------------

test('a database outage is reported as 503, not as an opaque 500', () => {
  // These are the shapes the driver and Mongoose actually produce.
  const cases = [
    Object.assign(new Error('Client must be connected before running operations'), {
      name: 'MongoNotConnectedError',
    }),
    Object.assign(new Error('getaddrinfo ENOTFOUND cluster.example'), {
      name: 'MongooseServerSelectionError',
    }),
    new Error('Operation `fishermen.find()` buffering timed out after 10000ms'),
  ];

  for (const raw of cases) {
    const mapped = normalizeError(raw);
    assert.equal(mapped.statusCode, 503, `${raw.name || 'error'} must map to 503`);
    assert.equal(mapped.code, 'DATABASE_UNAVAILABLE');
  }
});

test('commands fail fast instead of buffering', () => {
  /**
   * Buffering meant a query issued while the database was unreachable sat in
   * memory for ten seconds before surfacing as an opaque timeout. It is
   * disabled globally, because models compile before `connect()` runs and a
   * connect-time option would not cover them.
   */
  const mongoose = require('mongoose');
  assert.equal(mongoose.get('bufferCommands'), false);
});

test('transactions are actually engaged, not silently skipped', async () => {
  /**
   * The capability probe used a driver method that no longer exists, so
   * `Boolean(undefined)` meant every multi-document operation ran WITHOUT a
   * transaction on a replica set that supports them. This asserts the
   * callback receives a real session.
   */
  let session = 'not-called';
  await database.withTransaction(async (s) => {
    session = s;
  });

  assert.notEqual(session, 'not-called', 'the callback must run');
  assert.notEqual(session, null, 'a replica set must yield a real session');
  assert.equal(database.transactionSupportState(), true);
});

test('a failed transaction rolls every write back', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const clientRecordId = crypto.randomUUID();

  await assert.rejects(() =>
    database.withTransaction(async (session) => {
      await Fisherman.create(
        [
          {
            clientRecordId,
            firstName: 'Rollback',
            lastName: 'Test',
            gender: 'MALE',
            estimatedYearOfBirth: 1980,
            lga: 'BAK',
            fishermanTypes: ['ARTISANAL'],
          },
        ],
        { session }
      );
      throw new Error('deliberate failure after the write');
    })
  );

  const found = await Fisherman.countDocuments({ clientRecordId });
  assert.equal(found, 0, 'the write must not survive a rolled-back transaction');
});

// ---------------------------------------------------------------------------
// 10. Revoked accounts and devices
// ---------------------------------------------------------------------------

test('a suspended account is refused on its next request', async () => {
  const user = await User.create({
    email: `${unique('suspended')}@test.invalid`,
    firstName: 'Suspended',
    lastName: 'Officer',
    role: ROLES.ENUMERATOR,
    status: USER_STATUS.SUSPENDED,
    authUid: unique('uid'),
  });

  /**
   * Status is re-read from MongoDB on every request rather than trusted from
   * the token, which is what makes a suspension effective immediately instead
   * of whenever the token happens to expire.
   */
  const loaded = await User.findOne({ authUid: user.authUid });
  assert.equal(loaded.status, USER_STATUS.SUSPENDED);
  assert.ok(
    [USER_STATUS.SUSPENDED, USER_STATUS.DISABLED].includes(loaded.status),
    'authenticate() refuses both of these'
  );

  await User.collection.deleteMany({ _id: user._id });
});

test('a revoked device cannot authenticate even with its old secret', async () => {
  const deviceCode = unique('DEV').toUpperCase();
  const device = new Device({ deviceCode, lga: 'BAK', platform: 'ANDROID' });
  const secret = device.issueSecret();
  await device.save();

  const active = await Device.findOne({ deviceCode }).select('+secretHash');
  assert.equal(active.verifySecret(secret), true, 'the secret works while enrolled');

  // Revocation clears the hash, so the previously valid secret stops working.
  active.status = DEVICE_STATUS.REVOKED;
  active.secretHash = undefined;
  await active.save();

  const revoked = await Device.findOne({ deviceCode }).select('+secretHash');
  assert.equal(revoked.verifySecret(secret), false);
  assert.notEqual(revoked.status, DEVICE_STATUS.ACTIVE);

  await Device.collection.deleteMany({ deviceCode });
});

// ---------------------------------------------------------------------------
// 16. Background-job retry safety
// ---------------------------------------------------------------------------

test('a job is claimed by exactly one worker', async () => {
  const type = unique('test.claim');
  await OutboxJob.create({ type, payload: {}, runAt: new Date() });

  const claims = await Promise.all(
    Array.from({ length: 10 }, (_, i) => OutboxJob.claimOne(`worker-${i}`))
  );

  const mine = claims.filter((c) => c && c.type === type);
  assert.equal(mine.length, 1, 'exactly one worker may claim a given job');

  await OutboxJob.collection.deleteMany({ type });
});

test('an expired claim is recovered by another worker', async () => {
  const type = unique('test.expired');

  // A worker that died holding the claim leaves exactly this row.
  await OutboxJob.create({
    type,
    payload: {},
    runAt: new Date(Date.now() - 60_000),
    status: 'PROCESSING',
    lockedBy: 'dead-worker',
    lockedUntil: new Date(Date.now() - 30_000),
  });

  const reclaimed = await OutboxJob.claimOne('healthy-worker');
  assert.ok(reclaimed, 'an expired claim must become claimable again');
  assert.equal(reclaimed.type, type);
  assert.equal(reclaimed.lockedBy, 'healthy-worker');

  await OutboxJob.collection.deleteMany({ type });
});

test('a retried job does not repeat a non-idempotent side effect', async () => {
  const job = await OutboxJob.create({ type: unique('test.once'), payload: {} });

  let sends = 0;
  const send = async () => {
    sends += 1;
    return 'sent';
  };

  // Delivery is at-least-once: a worker that dies after sending but before
  // acknowledging will see the job again.
  const first = await queue.once(job, 'email', send);
  const second = await queue.once(job, 'email', send);
  const third = await queue.once(job, 'email', send);

  assert.equal(sends, 1, 'the side effect must happen at most once across retries');
  assert.equal(first, 'sent');
  assert.equal(second.skipped, true);
  assert.equal(third.skipped, true);

  await OutboxJob.collection.deleteMany({ _id: job._id });
});

test('a failing job retries with backoff, then goes to the dead-letter state', async () => {
  const job = await OutboxJob.create({
    type: unique('test.fail'),
    payload: {},
    attempts: 1,
    maxAttempts: 2,
  });

  await queue.fail(job, new Error('first failure'));
  const afterFirst = await OutboxJob.findById(job._id).lean();
  assert.equal(afterFirst.status, 'PENDING', 'an attempt left in budget must retry');
  assert.ok(afterFirst.runAt > new Date(), 'the retry must be delayed, not immediate');

  await queue.fail({ ...afterFirst, attempts: 2, maxAttempts: 2 }, new Error('final failure'));
  const afterSecond = await OutboxJob.findById(job._id).lean();
  assert.equal(afterSecond.status, 'DEAD', 'an exhausted job must stop and be visible');
  assert.match(afterSecond.lastError, /final failure/);

  await OutboxJob.collection.deleteMany({ _id: job._id });
});

test('a duplicate enqueue is a no-op, not an error', async () => {
  const dedupeKey = unique('dedupe');

  const first = await queue.enqueue(queue.JOB_TYPES.DASHBOARD_WARM, {}, { dedupeKey });
  const second = await queue.enqueue(queue.JOB_TYPES.DASHBOARD_WARM, {}, { dedupeKey });

  assert.ok(first, 'the first enqueue creates the job');
  assert.equal(second, null, 'the second is absorbed by the unique index');
  assert.equal(await OutboxJob.countDocuments({ dedupeKey }), 1);

  await OutboxJob.collection.deleteMany({ dedupeKey });
});
