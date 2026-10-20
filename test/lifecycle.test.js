'use strict';

/**
 * Business-rule regression tests.
 *
 * One test per invariant the lifecycle audit found unenforced. These are the
 * rules that distinguish a register from a spreadsheet, so each failure mode
 * is asserted directly rather than inferred from a route returning 200.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'disabled';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-qr-secret-value';
process.env.FIELD_ENCRYPTION_KEY =
  process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-at-least-32-chars';

const {
  FISHERMAN_TRANSITIONS,
  ALLOCATION_TRANSITIONS,
  ROLE_PERMISSIONS,
  ROLES,
  PERMISSIONS,
} = require('../src/config/constants');
const { hasPermission, assertNotSelfApproval } = require('../src/middleware/authorize');
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

const canMove = (table, from, to) => (table[from] || []).includes(to);

// ---------------------------------------------------------------------------
// Fisherman lifecycle
// ---------------------------------------------------------------------------

test('death is terminal and cannot be reversed by a status edit', () => {
  assert.deepEqual(FISHERMAN_TRANSITIONS.DECEASED, []);
  assert.equal(canMove(FISHERMAN_TRANSITIONS, 'DECEASED', 'ACTIVE'), false);
  assert.equal(canMove(FISHERMAN_TRANSITIONS, 'DECEASED', 'PENDING_VERIFICATION'), false);
});

test('a record under duplicate review cannot be activated directly', () => {
  // Releasing it is a review DECISION, which is recorded and attributable —
  // not a status overwrite that leaves no trace of who judged what.
  assert.equal(canMove(FISHERMAN_TRANSITIONS, 'DUPLICATE_UNDER_REVIEW', 'ACTIVE'), false);
  assert.equal(canMove(FISHERMAN_TRANSITIONS, 'DUPLICATE_UNDER_REVIEW', 'INACTIVE'), true);
});

test('suspension is reversible, as an appeal must be', () => {
  assert.equal(canMove(FISHERMAN_TRANSITIONS, 'ACTIVE', 'SUSPENDED'), true);
  assert.equal(canMove(FISHERMAN_TRANSITIONS, 'SUSPENDED', 'ACTIVE'), true);
});

test('a pending record cannot jump to ACTIVE without verification', () => {
  // The table permits PENDING -> ACTIVE, but `changeStatus` additionally
  // refuses it without a Blue ID, which only verify() can issue.
  const source = require('node:fs').readFileSync(
    require.resolve('../src/modules/fishermen/fisherman.service.js'),
    'utf8'
  );
  assert.match(source, /NOT_VERIFIED/, 'activation must require an issued Blue ID');
  assert.match(source, /INVALID_STATUS_TRANSITION/, 'transitions must be enforced');
});

// ---------------------------------------------------------------------------
// Allocation lifecycle
// ---------------------------------------------------------------------------

test('delivery cannot be claimed without going through the delivery path', () => {
  // Setting DELIVERED directly would skip the acknowledgement capture, the
  // deliveredAt/By record and the counter increment.
  assert.equal(canMove(ALLOCATION_TRANSITIONS, 'PENDING', 'DELIVERED'), false);
  assert.equal(canMove(ALLOCATION_TRANSITIONS, 'APPROVED', 'DELIVERED'), false);
});

test('a delivered benefit can be revoked but never un-delivered', () => {
  assert.deepEqual(ALLOCATION_TRANSITIONS.DELIVERED, ['REVOKED']);
  assert.equal(canMove(ALLOCATION_TRANSITIONS, 'DELIVERED', 'PENDING'), false);
});

test('rejected and revoked allocations are terminal', () => {
  assert.deepEqual(ALLOCATION_TRANSITIONS.REJECTED, []);
  assert.deepEqual(ALLOCATION_TRANSITIONS.REVOKED, []);
});

// ---------------------------------------------------------------------------
// Separation of duties
// ---------------------------------------------------------------------------

test('allocating and approving a benefit are different grants', () => {
  // One officer raising and signing off the same disbursement is the classic
  // benefit-fraud path.
  assert.equal(hasPermission({ role: ROLES.LGA_ADMIN }, PERMISSIONS.BENEFIT_ALLOCATE), true);
  assert.equal(hasPermission({ role: ROLES.LGA_ADMIN }, PERMISSIONS.BENEFIT_APPROVE), false);
  assert.equal(hasPermission({ role: ROLES.MINISTRY_OFFICER }, PERMISSIONS.BENEFIT_APPROVE), true);
});

test('merging requires its own grant, above verification', () => {
  // A merge retires one identity into another and moves its benefit history.
  assert.equal(hasPermission({ role: ROLES.LGA_ADMIN }, PERMISSIONS.REGISTRATION_VERIFY), true);
  assert.equal(hasPermission({ role: ROLES.LGA_ADMIN }, PERMISSIONS.DUPLICATE_MERGE), false);
  assert.equal(hasPermission({ role: ROLES.STATE_ADMIN }, PERMISSIONS.DUPLICATE_MERGE), true);
});

test('an officer cannot resolve a duplicate on their own capture', () => {
  const actorId = '507f1f77bcf86cd799439011';
  const record = { registeredBy: actorId };

  assert.throws(
    () =>
      assertNotSelfApproval(
        { _id: actorId, role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] } },
        record,
        { action: 'resolve a duplicate review for' }
      ),
    /cannot resolve a duplicate review for a record you submitted/i
  );
});

test('every role that can allocate is below the role that approves', () => {
  const allocators = Object.entries(ROLE_PERMISSIONS)
    .filter(([, perms]) => perms.includes(PERMISSIONS.BENEFIT_ALLOCATE))
    .map(([role]) => role);

  assert.ok(allocators.length > 0);
  // At least one role must be able to allocate without also approving,
  // otherwise separation of duties is decorative.
  assert.ok(
    allocators.some((role) => !ROLE_PERMISSIONS[role].includes(PERMISSIONS.BENEFIT_APPROVE)),
    'no role can allocate without also approving — the separation is nominal'
  );
});

// ---------------------------------------------------------------------------
// Permanence (requires a database)
// ---------------------------------------------------------------------------

dbTest('an issued Blue ID cannot be rewritten', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const clientRecordId = crypto.randomUUID();

  await Fisherman.collection.deleteMany({ clientRecordId });
  const created = await Fisherman.create({
    clientRecordId,
    firstName: 'Effiom',
    lastName: 'Okon',
    gender: 'MALE',
    estimatedYearOfBirth: 1980,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
    blueId: 'CRS-BLU-BAK-8001',
  });

  const loaded = await Fisherman.findById(created._id);
  loaded.blueId = 'CRS-BLU-BAK-8002';

  await assert.rejects(
    () => loaded.save(),
    /permanent and cannot be changed/i,
    'a Blue ID is printed on a card — it must never be reassigned'
  );

  // The update-operator path is blocked too, since it skips `save`.
  await assert.rejects(
    () => Fisherman.updateOne({ _id: created._id }, { $set: { blueId: 'CRS-BLU-BAK-8003' } }),
    /may only be assigned to a record that does not already hold one/i
  );

  await assert.rejects(
    () => Fisherman.updateOne({ _id: created._id }, { $unset: { blueId: '' } }),
    /cannot be removed once issued/i
  );

  const unchanged = await Fisherman.findById(created._id).lean();
  assert.equal(unchanged.blueId, 'CRS-BLU-BAK-8001');

  await Fisherman.collection.deleteMany({ clientRecordId });
});

dbTest('issuance to an unissued record is still permitted', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const clientRecordId = crypto.randomUUID();

  await Fisherman.collection.deleteMany({ clientRecordId });
  const created = await Fisherman.create({
    clientRecordId,
    firstName: 'Bassey',
    lastName: 'Asuquo',
    gender: 'MALE',
    estimatedYearOfBirth: 1985,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
  });

  // This is exactly how verify() claims a record: a conditional update
  // restricted to records that hold no number yet.
  const claimed = await Fisherman.findOneAndUpdate(
    { _id: created._id, blueId: { $in: [null, undefined] } },
    { $set: { blueId: 'CRS-BLU-BAK-8010' } },
    { new: true }
  );

  assert.equal(claimed.blueId, 'CRS-BLU-BAK-8010', 'first issuance must succeed');

  await Fisherman.collection.deleteMany({ clientRecordId });
});

dbTest('benefit history cannot be deleted, only revoked', async () => {
  const mongoose = require('mongoose');
  const Allocation = require('../src/modules/programmes/allocation.model');

  const programme = new mongoose.Types.ObjectId();
  const allocation = await Allocation.create({
    programme,
    fisherman: new mongoose.Types.ObjectId(),
    blueId: 'CRS-BLU-BAK-8020',
    lga: 'BAK',
    allocatedBy: new mongoose.Types.ObjectId(),
    status: 'DELIVERED',
  });

  // An allocation is evidence that public money was issued to a named person.
  await assert.rejects(
    () => Allocation.deleteOne({ _id: allocation._id }),
    /cannot be deleted/i
  );
  await assert.rejects(() => Allocation.deleteMany({ programme }), /cannot be deleted/i);
  await assert.rejects(
    () => Allocation.findOneAndDelete({ _id: allocation._id }),
    /cannot be deleted/i
  );

  // Revoking is the supported correction, and it preserves the record.
  await Allocation.updateOne({ _id: allocation._id }, { $set: { status: 'REVOKED' } });
  const revoked = await Allocation.findById(allocation._id).lean();
  assert.equal(revoked.status, 'REVOKED');
  assert.equal(revoked.isActiveAllocation, false, 'and it frees the slot for a re-issue');

  await Allocation.collection.deleteMany({ programme });
});

dbTest('an allocation cannot be moved to a different programme', async () => {
  const mongoose = require('mongoose');
  const Allocation = require('../src/modules/programmes/allocation.model');

  const programme = new mongoose.Types.ObjectId();
  const created = await Allocation.create({
    programme,
    fisherman: new mongoose.Types.ObjectId(),
    blueId: 'CRS-BLU-BAK-8030',
    lga: 'BAK',
    allocatedBy: new mongoose.Types.ObjectId(),
    status: 'APPROVED',
  });

  const loaded = await Allocation.findById(created._id);
  loaded.programme = new mongoose.Types.ObjectId();

  await assert.rejects(
    () => loaded.save(),
    /cannot be moved to a different programme/i,
    're-attributing a disbursement would falsify which intervention paid for it'
  );

  await Allocation.collection.deleteMany({ programme });
});

// ---------------------------------------------------------------------------
// Cooperative membership by Blue ID
// ---------------------------------------------------------------------------

/**
 * A cooperative officer holds the Blue ID, not the database id.
 *
 * `POST /cooperatives/{id}/members` accepted only the 24-character `_id`,
 * which nothing outside the system publishes. Sending `CRS-BLU-BAK-0001` —
 * the number printed on the card and encoded in the QR — was rejected at
 * validation, so the client had to resolve it first through a separate
 * endpoint to do something it already had the identifier for.
 *
 * These go through the real service, because the fix is a lookup change and
 * asserting on a regex would not prove a member was actually added.
 */
dbTest('a fisherman can be added to a cooperative by Blue ID or by id', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const Cooperative = require('../src/modules/cooperatives/cooperative.model');
  const service = require('../src/modules/cooperatives/cooperative.service');
  const { USER_STATUS } = require('../src/config/constants');

  const stamp = crypto.randomBytes(4).toString('hex');
  const actor = {
    _id: new (require('mongoose').Types.ObjectId)(),
    role: ROLES.STATE_ADMIN,
    status: USER_STATUS.ACTIVE,
    scope: { lgas: [] },
    fullName: 'Coop Probe',
  };

  const society = await Cooperative.create({
    name: `Probe Society ${stamp}`,
    lga: 'BAK',
    registrationNumber: `PRB-${stamp}`,
  });

  const base = {
    gender: 'MALE',
    estimatedYearOfBirth: 1980,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
  };

  const byBlueId = await Fisherman.create({
    ...base, firstName: 'Blue', lastName: `Ref${stamp}`,
    blueId: `CRS-BLU-BAK-9${stamp.slice(0, 3).replace(/\D/g, '0').padEnd(3, '0')}`,
  });
  const byObjectId = await Fisherman.create({ ...base, firstName: 'Id', lastName: `Ref${stamp}` });

  const cleanup = async () => {
    await Fisherman.deleteMany({ _id: { $in: [byBlueId._id, byObjectId._id] } });
    await Cooperative.deleteOne({ _id: society._id });
  };

  try {
    // The identifier an officer actually has.
    const added = await service.addMember(
      society._id,
      { fishermanId: byBlueId.blueId },
      actor,
      {}
    );
    assert.equal(
      String(added._id),
      String(byBlueId._id),
      'a Blue ID must resolve to the fisherman it identifies'
    );
    assert.equal(String(added.cooperative.id), String(society._id), 'and the membership must stick');

    // Lower case, as somebody will inevitably type it.
    const removedThenRe = await service.removeMember(society._id, byBlueId.blueId.toLowerCase(), actor, {});
    assert.ok(removedThenRe, 'Blue ID lookup must be case-insensitive');

    // The original form still works — this widens the input, it does not move it.
    const second = await service.addMember(
      society._id,
      { fishermanId: String(byObjectId._id) },
      actor,
      {}
    );
    assert.equal(String(second._id), String(byObjectId._id), 'the database id must still be accepted');
  } finally {
    await cleanup();
  }
});

dbTest('an unknown Blue ID is not found, and says nothing more', async () => {
  const service = require('../src/modules/cooperatives/cooperative.service');
  const Cooperative = require('../src/modules/cooperatives/cooperative.model');
  const { USER_STATUS } = require('../src/config/constants');

  const stamp = crypto.randomBytes(4).toString('hex');
  const actor = {
    _id: new (require('mongoose').Types.ObjectId)(),
    role: ROLES.STATE_ADMIN,
    status: USER_STATUS.ACTIVE,
    scope: { lgas: [] },
    fullName: 'Coop Probe',
  };
  const society = await Cooperative.create({
    name: `Probe Society ${stamp}`,
    lga: 'BAK',
    registrationNumber: `PRB2-${stamp}`,
  });

  try {
    await assert.rejects(
      () => service.addMember(society._id, { fishermanId: 'CRS-BLU-BAK-9999' }, actor, {}),
      (err) => err.statusCode === 404,
      'a Blue ID nobody holds must be a 404, like an id outside the caller’s scope'
    );
  } finally {
    await Cooperative.deleteOne({ _id: society._id });
  }
});
