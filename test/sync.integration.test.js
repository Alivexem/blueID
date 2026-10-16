'use strict';

/**
 * Integration tests for the guarantees that cannot be verified without a real
 * database: Blue ID uniqueness under concurrency, sync replay safety, device
 * revocation and duplicate-benefit prevention.
 *
 * These are the items the pre-production tracker calls out, and they are
 * exactly the ones that a unit test cannot prove, because the guarantee comes
 * from a MongoDB index or an atomic operator rather than from application
 * logic.
 *
 * `npm test` starts a disposable in-process MongoDB replica set (see
 * test/setup/globalSetup.js) and builds the indexes before anything runs, so
 * these execute by default. The skip guard below only matters when a single
 * file is run without that global setup.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'disabled';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-qr-secret-value';
process.env.FIELD_ENCRYPTION_KEY =
  process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-at-least-32-chars';

const database = require('../src/config/database');
const logger = require('../src/config/logger');

/** Probe the database once; every test is skipped if it is unreachable. */
let dbAvailable = false;
let skipReason = '';

async function connect() {
  try {
    await database.connect();
    dbAvailable = true;
  } catch (err) {
    skipReason = `database unreachable: ${err.message}`;
  }
}

const connected = connect();

// Keep test output readable.
logger.level = 'silent';

test.after(async () => {
  if (dbAvailable) await database.disconnect();
});

/** Wraps a test so it skips rather than fails without a database. */
function dbTest(name, fn) {
  test(name, async (t) => {
    await connected;
    if (!dbAvailable) {
      t.skip(skipReason);
      return;
    }
    await fn(t);
  });
}

const uuid = () => crypto.randomUUID();
const unique = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;

// ---------------------------------------------------------------------------
// Blue ID allocation
// ---------------------------------------------------------------------------

dbTest('concurrent allocations never issue the same Blue ID', async () => {
  const Counter = require('../src/modules/fishermen/counter.model');
  const blueIdService = require('../src/services/blueId.service');

  const testKey = unique('TESTLGA');
  await Counter.deleteOne({ _id: `blueid:${testKey}` });

  // 25 simultaneous allocations against a counter that does not yet exist —
  // this is the race that a read-then-write implementation loses.
  const results = await Promise.all(
    Array.from({ length: 25 }, () => Counter.next(`blueid:${testKey}`))
  );

  const unique_ = new Set(results);
  assert.equal(unique_.size, results.length, 'a sequence number was issued twice');
  assert.equal(Math.max(...results), results.length, 'the sequence has a gap');

  await Counter.deleteOne({ _id: `blueid:${testKey}` });

  // And the real issuer refuses an unknown LGA outright.
  await assert.rejects(() => blueIdService.issue('ZZZ'), /Unknown Local Government Area/);
});

// ---------------------------------------------------------------------------
// Sync idempotency
// ---------------------------------------------------------------------------

dbTest('replaying a registration does not create a second fisherman', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const clientRecordId = uuid();

  const base = {
    clientRecordId,
    firstName: 'Effiom',
    lastName: 'Okon',
    gender: 'MALE',
    estimatedYearOfBirth: 1980,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
  };

  await Fisherman.deleteMany({ clientRecordId });
  await Fisherman.create(base);

  // The device never saw the response and sends the same record again.
  await assert.rejects(
    () => Fisherman.create(base),
    (err) => err.code === 11000,
    'the unique index on clientRecordId must reject a replay'
  );

  const count = await Fisherman.countDocuments({ clientRecordId });
  assert.equal(count, 1, 'a replay created a duplicate record');

  await Fisherman.deleteMany({ clientRecordId });
});

dbTest('a replayed batch returns the original result instead of reprocessing', async () => {
  const SyncBatch = require('../src/modules/sync/syncBatch.model');
  const clientBatchId = uuid();

  await SyncBatch.deleteMany({ clientBatchId });
  await SyncBatch.create({
    clientBatchId,
    direction: 'PUSH',
    status: 'COMPLETED',
    counts: { submitted: 3, created: 3 },
  });

  await assert.rejects(
    () => SyncBatch.create({ clientBatchId, direction: 'PUSH' }),
    (err) => err.code === 11000,
    'clientBatchId must be unique so a replay is detectable'
  );

  const existing = await SyncBatch.findOne({ clientBatchId }).lean();
  assert.equal(existing.counts.created, 3, 'the original outcome must be recoverable');

  await SyncBatch.deleteMany({ clientBatchId });
});

// ---------------------------------------------------------------------------
// Device credentials
// ---------------------------------------------------------------------------

dbTest('device secrets verify, and revocation stops a device working', async () => {
  const Device = require('../src/modules/sync/device.model');
  const deviceCode = unique('TST').toUpperCase();

  await Device.deleteMany({ deviceCode });

  const device = new Device({ deviceCode, lga: 'BAK', platform: 'ANDROID' });
  const secret = device.issueSecret();
  await device.save();

  const loaded = await Device.findOne({ deviceCode }).select('+secretHash');
  assert.equal(loaded.verifySecret(secret), true, 'the issued secret must verify');
  assert.equal(loaded.verifySecret('wrong-secret'), false);
  assert.equal(loaded.verifySecret(''), false);
  assert.equal(loaded.verifySecret(null), false);

  // The plaintext is never stored.
  assert.notEqual(loaded.secretHash, secret);
  // And it is never serialised.
  assert.equal(loaded.toJSON().secretHash, undefined);

  // Revocation clears the hash, so the old secret can no longer authenticate.
  loaded.status = 'REVOKED';
  loaded.secretHash = undefined;
  await loaded.save();

  const revoked = await Device.findOne({ deviceCode }).select('+secretHash');
  assert.equal(revoked.verifySecret(secret), false, 'a revoked device must not authenticate');

  await Device.deleteMany({ deviceCode });
});

// ---------------------------------------------------------------------------
// Duplicate benefits
// ---------------------------------------------------------------------------

dbTest('the same fisherman cannot be allocated twice under one programme', async () => {
  const mongoose = require('mongoose');
  const Allocation = require('../src/modules/programmes/allocation.model');

  const programme = new mongoose.Types.ObjectId();
  const fisherman = new mongoose.Types.ObjectId();

  const base = {
    programme,
    fisherman,
    blueId: 'CRS-BLU-BAK-9999',
    lga: 'BAK',
    allocatedBy: new mongoose.Types.ObjectId(),
    status: 'APPROVED',
  };

  await Allocation.collection.deleteMany({ programme }); // driver: bypasses the ODM guard
  await Allocation.create(base);

  await assert.rejects(
    () => Allocation.create(base),
    (err) => err.code === 11000,
    'a second active allocation must be refused by the index'
  );

  // Revoking frees the slot so a corrected allocation can be made — the index
  // is partial precisely so a mistake is recoverable.
  await Allocation.updateOne({ programme, fisherman }, { $set: { status: 'REVOKED' } });
  const reissued = await Allocation.create({ ...base, status: 'PENDING' });
  assert.ok(reissued._id, 'a revoked allocation must not block a re-issue');

  await Allocation.collection.deleteMany({ programme }); // driver: bypasses the ODM guard
});

// ---------------------------------------------------------------------------
// Encrypted NIN storage
// ---------------------------------------------------------------------------

dbTest('a NIN is stored encrypted and is searchable only by blind index', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const fieldCrypto = require('../src/utils/fieldCrypto');

  const clientRecordId = uuid();
  const nin = '12345678901';

  await Fisherman.deleteMany({ clientRecordId });
  const created = await Fisherman.create({
    clientRecordId,
    firstName: 'Bassey',
    lastName: 'Asuquo',
    gender: 'MALE',
    estimatedYearOfBirth: 1985,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
    nin,
  });

  // Read the raw document, bypassing the model's select:false.
  const raw = await Fisherman.collection.findOne({ _id: created._id });
  assert.notEqual(raw.nin, nin, 'the NIN must not be stored in plaintext');
  assert.ok(String(raw.nin).startsWith('v1:'), 'the NIN must be stored as versioned ciphertext');
  assert.equal(raw.match.ninIndex, fieldCrypto.blindIndex(nin));

  // Equality search works through the index.
  const found = await Fisherman.findOne({ 'match.ninIndex': fieldCrypto.blindIndex(nin) }).select(
    '+nin'
  );
  assert.equal(String(found._id), String(created._id));
  assert.equal(found.getNin(), nin, 'the NIN must decrypt for an authorised read');
  assert.equal(found.getMaskedNin(), '*******8901');

  // Default serialisation never carries it.
  assert.equal(found.toJSON().nin, undefined);

  await Fisherman.deleteMany({ clientRecordId });
});

// ---------------------------------------------------------------------------
// Audit immutability
// ---------------------------------------------------------------------------

dbTest('audit entries cannot be rewritten or deleted', async () => {
  const AuditLog = require('../src/modules/audit/audit.model');

  const entry = await AuditLog.create({
    action: 'CREATE',
    entity: { type: 'TestEntity', label: unique('audit') },
    actor: { service: 'test' },
  });

  await assert.rejects(
    () => AuditLog.updateOne({ _id: entry._id }, { $set: { action: 'DELETE' } }),
    /immutable/i,
    'the audit trail must reject updates'
  );
  await assert.rejects(
    () => AuditLog.deleteOne({ _id: entry._id }),
    /immutable/i,
    'the audit trail must reject deletes'
  );

  // Clean up through the driver, which bypasses the guard by design.
  await AuditLog.collection.deleteOne({ _id: entry._id });
});

// ---------------------------------------------------------------------------
// Job queue durability
// ---------------------------------------------------------------------------

dbTest('a job is claimed by exactly one worker', async () => {
  const OutboxJob = require('../src/modules/outbox/outbox.model');
  const type = unique('test.job');

  await OutboxJob.deleteMany({ type });
  await OutboxJob.create({ type, payload: {}, runAt: new Date() });

  // Ten workers race for one job.
  const claims = await Promise.all(
    Array.from({ length: 10 }, (_, i) => OutboxJob.claimOne(`worker-${i}`))
  );

  const successful = claims.filter(Boolean);
  assert.equal(successful.length, 1, 'exactly one worker may claim a job');
  assert.equal(successful[0].attempts, 1);

  await OutboxJob.deleteMany({ type });
});

dbTest('a deduped job is enqueued only once', async () => {
  const OutboxJob = require('../src/modules/outbox/outbox.model');
  const queue = require('../src/services/queue.service');

  const dedupeKey = unique('dedupe');
  const type = queue.JOB_TYPES.DASHBOARD_WARM;

  await OutboxJob.deleteMany({ dedupeKey });

  const first = await queue.enqueue(type, {}, { dedupeKey });
  const second = await queue.enqueue(type, {}, { dedupeKey });

  assert.ok(first, 'the first enqueue should create a job');
  assert.equal(second, null, 'a duplicate enqueue should be a no-op, not an error');
  assert.equal(await OutboxJob.countDocuments({ dedupeKey }), 1);

  await OutboxJob.deleteMany({ dedupeKey });
});
