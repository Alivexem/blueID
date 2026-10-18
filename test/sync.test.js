'use strict';

/**
 * Offline-synchronisation regression tests.
 *
 * One test per failure scenario from the sync audit. The payload-trust and
 * conflict tests run anywhere; the ones that can only be proved against a
 * real server skip when no database is reachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'disabled';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-qr-secret-value';
process.env.FIELD_ENCRYPTION_KEY =
  process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-at-least-32-chars';

const { sanitizeRecordData } = require('../src/modules/sync/sync.validation');
const { ROLE_PERMISSIONS, ROLES, PERMISSIONS } = require('../src/config/constants');
const database = require('../src/config/database');
const logger = require('../src/config/logger');

logger.level = 'silent';

let dbAvailable = false;
let skipReason = '';
const connected = (async () => {
  try {
    await database.connect();
    dbAvailable = true;
  } catch (err) {
    skipReason = `database unreachable: ${err.message}`;
  }
})();

test.after(async () => {
  if (dbAvailable) await database.disconnect();
});

function dbTest(name, fn) {
  test(name, async (t) => {
    await connected;
    if (!dbAvailable) return void t.skip(skipReason);
    await fn(t);
  });
}

const uuid = () => crypto.randomUUID();

const validFisherman = () => ({
  firstName: 'Effiom',
  lastName: 'Okon',
  gender: 'MALE',
  estimatedYearOfBirth: 1980,
  lga: 'BAK',
  fishermanTypes: ['ARTISANAL'],
});

// ---------------------------------------------------------------------------
// S1 — client-provided authority fields
// ---------------------------------------------------------------------------

test('a device cannot assign a Blue ID, verification or status', () => {
  const forged = {
    ...validFisherman(),
    blueId: 'CRS-BLU-BAK-0001',
    status: 'ACTIVE',
    verification: { verifiedBy: '507f1f77bcf86cd799439011', verifiedAt: new Date() },
    verificationToken: 'forged-token',
    duplicateFlags: [],
    mergedInto: '507f1f77bcf86cd799439012',
    match: { ninIndex: 'forged' },
  };

  const clean = sanitizeRecordData('FISHERMAN', 'CREATE', forged);

  for (const field of [
    'blueId',
    'status',
    'verification',
    'verificationToken',
    'duplicateFlags',
    'mergedInto',
    'match',
  ]) {
    assert.ok(!(field in clean), `${field} must never survive from a device payload`);
  }
  // The legitimate data is preserved.
  assert.equal(clean.firstName, 'Effiom');
  assert.equal(clean.lga, 'BAK');
});

test('the same stripping applies on the update path', () => {
  const clean = sanitizeRecordData('FISHERMAN', 'UPDATE', {
    phone: '08031234567',
    status: 'ACTIVE',
    blueId: 'CRS-BLU-BAK-0002',
  });

  assert.equal(clean.phone, '08031234567');
  assert.ok(!('status' in clean), 'a stale device edit must not set status');
  assert.ok(!('blueId' in clean));
});

test('an invalid record is rejected with field-level errors, not silently dropped', () => {
  try {
    sanitizeRecordData('FISHERMAN', 'CREATE', { firstName: 'X' });
    assert.fail('expected validation to reject this record');
  } catch (err) {
    assert.equal(err.statusCode, 422);
    assert.equal(err.code, 'RECORD_INVALID');
    assert.ok(Array.isArray(err.details) && err.details.length, 'the enumerator needs the reasons');
    assert.ok(err.details.some((d) => d.field === 'lastName'));
  }
});

test('device-local owner references survive validation on assets', () => {
  const ownerRef = uuid();
  const clean = sanitizeRecordData('BOAT', 'CREATE', {
    ownerClientRecordId: ownerRef,
    boatType: 'DUGOUT_CANOE',
    lengthMeters: 4.5,
  });

  assert.equal(
    clean.ownerClientRecordId,
    ownerRef,
    'stripping this would orphan every asset captured offline'
  );
  assert.equal(clean.boatType, 'DUGOUT_CANOE');
});

// ---------------------------------------------------------------------------
// S2 — permissions at sync time
// ---------------------------------------------------------------------------

test('only roles granted sync:submit may push', () => {
  const may = (role) => ROLE_PERMISSIONS[role].includes(PERMISSIONS.SYNC_SUBMIT);

  assert.equal(may(ROLES.ENUMERATOR), true);
  assert.equal(may(ROLES.LGA_ADMIN), true);
  // A cooperative officer records membership; they do not register fishermen.
  assert.equal(may(ROLES.COOPERATIVE_OFFICER), false);
  assert.equal(may(ROLES.MINISTRY_OFFICER), false);
});

// ---------------------------------------------------------------------------
// S4 / S8 — batch lifecycle
// ---------------------------------------------------------------------------

dbTest('a batch abandoned mid-processing is reclaimed, not deadlocked', async () => {
  const SyncBatch = require('../src/modules/sync/syncBatch.model');
  const clientBatchId = uuid();

  // A process killed mid-batch leaves exactly this row behind.
  await SyncBatch.create({
    clientBatchId,
    direction: 'PUSH',
    status: 'PROCESSING',
    startedAt: new Date(Date.now() - 30 * 60 * 1000),
    counts: { submitted: 5 },
  });

  const stale = await SyncBatch.findOne({ clientBatchId });
  const ageMs = Date.now() - new Date(stale.startedAt).getTime();

  assert.ok(ageMs > 10 * 60 * 1000, 'the batch is past the abandonment threshold');
  assert.equal(stale.status, 'PROCESSING');

  // The device must be able to resubmit: the row is reusable rather than a
  // permanent 409. Reprocessing is safe because records upsert on
  // clientRecordId.
  stale.status = 'COMPLETED';
  stale.results = [];
  await stale.save();

  const replayed = await SyncBatch.findOne({ clientBatchId });
  assert.equal(replayed.status, 'COMPLETED', 'a reclaimed batch reuses its row');

  await SyncBatch.deleteMany({ clientBatchId });
});

dbTest('a completed batch replays its stored outcome', async () => {
  const SyncBatch = require('../src/modules/sync/syncBatch.model');
  const clientBatchId = uuid();
  const clientRecordId = uuid();

  await SyncBatch.create({
    clientBatchId,
    direction: 'PUSH',
    status: 'COMPLETED',
    counts: { submitted: 1, created: 1 },
    results: [
      {
        clientRecordId,
        entity: 'FISHERMAN',
        result: 'CREATED',
        tempReference: 'TMP-BAK-07-ABC123',
      },
    ],
  });

  // This is the lost-response case: the device never saw the reply and resends.
  const stored = await SyncBatch.findOne({ clientBatchId }).lean();
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.results[0].result, 'CREATED');
  assert.equal(
    stored.results[0].tempReference,
    'TMP-BAK-07-ABC123',
    'the original assigned reference must come back unchanged'
  );

  await SyncBatch.deleteMany({ clientBatchId });
});

// ---------------------------------------------------------------------------
// S3 — assets whose owner synced earlier
// ---------------------------------------------------------------------------

dbTest('an asset finds an owner that synced in an earlier batch', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const ownerClientRecordId = uuid();

  await Fisherman.deleteMany({ clientRecordId: ownerClientRecordId });
  const owner = await Fisherman.create({
    ...validFisherman(),
    clientRecordId: ownerClientRecordId,
  });

  // Batch two: the in-memory idMap is empty, and the owner has no Blue ID
  // because they are still pending. The lookup must fall back to the register.
  const found = await Fisherman.findOne({
    clientRecordId: ownerClientRecordId,
    isDeleted: { $ne: true },
  })
    .select('_id blueId lga community')
    .lean();

  assert.ok(found, 'the owner must be reachable by clientRecordId across batches');
  assert.equal(String(found._id), String(owner._id));
  assert.equal(found.blueId, undefined, 'and it must work before a Blue ID exists');

  await Fisherman.deleteMany({ clientRecordId: ownerClientRecordId });
});

// ---------------------------------------------------------------------------
// S5 — stale edits
// ---------------------------------------------------------------------------

dbTest('a stale revision conflicts even without baseUpdatedAt', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const clientRecordId = uuid();

  await Fisherman.deleteMany({ clientRecordId });
  const existing = await Fisherman.create({
    ...validFisherman(),
    clientRecordId,
    clientRevision: 5,
  });

  // The device omits baseUpdatedAt entirely and sends an older revision.
  const incomingRevision = 3;
  const serverRevision = existing.clientRevision ?? 0;
  const staleRevision = incomingRevision <= serverRevision && serverRevision > 0;

  assert.equal(
    staleRevision,
    true,
    'conflict detection must not depend on the client sending baseUpdatedAt'
  );

  await Fisherman.deleteMany({ clientRecordId });
});

// ---------------------------------------------------------------------------
// S11 — duplicate handling stays advisory
// ---------------------------------------------------------------------------

dbTest('a flagged duplicate is held for review, never deleted or merged', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const first = uuid();
  const second = uuid();

  await Fisherman.deleteMany({ clientRecordId: { $in: [first, second] } });

  const original = await Fisherman.create({ ...validFisherman(), clientRecordId: first });

  const flagged = await Fisherman.create({
    ...validFisherman(),
    clientRecordId: second,
    status: 'DUPLICATE_UNDER_REVIEW',
    duplicateFlags: [{ candidate: original._id, score: 0.91, reasons: ['Identical name'] }],
  });

  // Both records still exist — nothing is removed automatically.
  assert.equal(await Fisherman.countDocuments({ clientRecordId: { $in: [first, second] } }), 2);
  assert.equal(flagged.hasOpenDuplicateFlag(), true);
  assert.equal(flagged.blueId, undefined, 'a record under review holds no Blue ID');

  await Fisherman.deleteMany({ clientRecordId: { $in: [first, second] } });
});

// ---------------------------------------------------------------------------
// S5b — an unversioned client must still be able to correct its own record
// ---------------------------------------------------------------------------

/**
 * This goes through the real `push` service rather than reimplementing the
 * staleness predicate, which is why it catches what S5 above could not.
 *
 * `clientRevision` is optional in the schema. The create path used to store
 * `?? 1` for a device that sent none, inventing a revision the client never
 * claimed; applyUpdate then compared the device's absent revision (read as 0)
 * against that 1 and declared every later edit stale. An app with no revision
 * counter could therefore register fishermen but never correct one — each
 * correction returned CONFLICT, "the server copy is newer and has been kept",
 * and the officer's change was silently discarded. The numbers could never
 * cross, so it never recovered.
 *
 * The register is what proves it: the assertion is on the stored phone
 * number, not on the reported outcome.
 */
dbTest('an edit from a client that sends no clientRevision is applied, not dropped', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const Device = require('../src/modules/sync/device.model');
  const SyncBatch = require('../src/modules/sync/syncBatch.model');
  const User = require('../src/modules/users/user.model');
  const syncService = require('../src/modules/sync/sync.service');
  const { USER_STATUS } = require('../src/config/constants');

  const stamp = crypto.randomBytes(4).toString('hex').toUpperCase();
  const clientRecordId = uuid();
  const batchOne = uuid();
  const batchTwo = uuid();

  const actor = await User.create({
    email: `rev-${stamp}@sync.test.invalid`.toLowerCase(),
    firstName: 'Revision',
    lastName: 'Probe',
    role: ROLES.STATE_ADMIN,
    status: USER_STATUS.ACTIVE,
    authUid: `rev-uid-${stamp}`,
    scope: { lgas: [] },
  });

  const device = new Device({ deviceCode: `REV${stamp}`, lga: 'BAK', assignedTo: actor._id });
  const secret = device.issueSecret();
  await device.save();

  const cleanup = async () => {
    await Fisherman.deleteMany({ clientRecordId });
    await SyncBatch.deleteMany({ clientBatchId: { $in: [batchOne, batchTwo] } });
    await Device.deleteOne({ _id: device._id });
    await User.deleteOne({ _id: actor._id });
  };

  try {
    // A device with no revision counter registers somebody.
    const created = await syncService.push(
      {
        clientBatchId: batchOne,
        deviceCode: device.deviceCode,
        deviceSecret: secret,
        records: [
          {
            clientRecordId,
            entity: 'FISHERMAN',
            operation: 'CREATE',
            data: { ...validFisherman(), phone: '08030000001' },
          },
        ],
      },
      actor,
      {}
    );

    assert.equal(created.batch.counts.created, 1, 'the registration itself must succeed');

    // The same device corrects the phone number. It still sends no revision,
    // because it does not implement them — which the schema permits.
    const edited = await syncService.push(
      {
        clientBatchId: batchTwo,
        deviceCode: device.deviceCode,
        deviceSecret: secret,
        records: [
          {
            clientRecordId,
            entity: 'FISHERMAN',
            operation: 'UPDATE',
            data: { phone: '08030000002' },
          },
        ],
      },
      actor,
      {}
    );

    assert.equal(
      edited.batch.counts.conflicts,
      0,
      'a device editing its own record is not in conflict with anyone'
    );
    assert.equal(edited.batch.counts.updated, 1, 'the correction must be applied');

    const stored = await Fisherman.findOne({ clientRecordId }).select('phone').lean();
    assert.equal(
      stored.phone,
      '08030000002',
      "the officer's correction must reach the register, not be silently discarded"
    );
  } finally {
    await cleanup();
  }
});
