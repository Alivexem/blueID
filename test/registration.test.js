'use strict';

/**
 * End-to-end registration, verification and benefit lifecycle, exercised
 * through the real service layer against a real MongoDB replica set.
 *
 * These cover the behaviours that only appear when the whole path runs:
 * transactions, index-backed uniqueness, audit writes, and the interaction
 * between authorization scope and the database.
 *
 * All identities are synthetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const database = require('../src/config/database');
const fishermanService = require('../src/modules/fishermen/fisherman.service');
const programmeService = require('../src/modules/programmes/programme.service');
const Fisherman = require('../src/modules/fishermen/fisherman.model');
const Programme = require('../src/modules/programmes/programme.model');
const Allocation = require('../src/modules/programmes/allocation.model');
const AuditLog = require('../src/modules/audit/audit.model');
const Counter = require('../src/modules/fishermen/counter.model');

/**
 * Populated refs need their models registered. The running app loads every
 * module through the router, so this is a harness concern rather than a
 * product one — but without it `populate('registeredBy')` throws
 * MissingSchemaError and masks the behaviour under test.
 */
require('../src/modules/users/user.model');
require('../src/modules/communities/community.model');
require('../src/modules/cooperatives/cooperative.model');
require('../src/modules/assets/boat.model');
require('../src/modules/assets/engine.model');
require('../src/modules/assets/equipment.model');
const { ROLES, FISHERMAN_STATUS, AUDIT_ACTIONS } = require('../src/config/constants');

let connected = false;
test.before(async () => {
  await database.connect();
  connected = true;
});
test.after(async () => {
  if (connected) await database.disconnect();
});

const oid = () => new (require('mongoose').Types.ObjectId)();

const enumeratorBak = {
  _id: oid(),
  role: ROLES.ENUMERATOR,
  scope: { lgas: ['BAK'], communities: [] },
};
const adminBak = {
  _id: oid(),
  role: ROLES.LGA_ADMIN,
  scope: { lgas: ['BAK'], communities: [] },
};
const adminOdu = {
  _id: oid(),
  role: ROLES.LGA_ADMIN,
  scope: { lgas: ['ODU'], communities: [] },
};
const stateAdmin = { _id: oid(), role: ROLES.STATE_ADMIN, scope: { lgas: [], communities: [] } };
const ministry = { _id: oid(), role: ROLES.MINISTRY_OFFICER, scope: { lgas: [] } };

/** A synthetic registration payload; `suffix` keeps identities distinct. */
const draft = (suffix, overrides = {}) => ({
  firstName: `Test${suffix}`,
  lastName: `Person${suffix}`,
  gender: 'MALE',
  estimatedYearOfBirth: 1980,
  lga: 'BAK',
  fishermanTypes: ['ARTISANAL'],
  phone: `080300000${String(suffix).padStart(2, '0')}`,
  ...overrides,
});

async function register(actor, suffix, overrides) {
  const { fisherman } = await fishermanService.create(draft(suffix, overrides), actor, {});
  return fisherman;
}

/** Verification requires a photograph, which uploads would normally set. */
async function withPhoto(fisherman) {
  fisherman.photo = { url: 'https://example.invalid/p.jpg', publicId: `test/${fisherman._id}` };
  await fisherman.save();
  return fisherman;
}

// ---------------------------------------------------------------------------
// 4. Registration by administrators and enumerators
// ---------------------------------------------------------------------------

test('an enumerator can register a fisherman in their own LGA', async () => {
  const fisherman = await register(enumeratorBak, 11);

  assert.equal(fisherman.lga, 'BAK');
  assert.equal(fisherman.status, FISHERMAN_STATUS.PENDING_VERIFICATION);
  assert.equal(String(fisherman.registeredBy), String(enumeratorBak._id));
  assert.equal(fisherman.blueId, undefined, 'registration must not issue a Blue ID');

  await Fisherman.collection.deleteMany({ _id: fisherman._id });
});

test('an administrator can register directly', async () => {
  const fisherman = await register(adminBak, 12);
  assert.equal(fisherman.status, FISHERMAN_STATUS.PENDING_VERIFICATION);
  await Fisherman.collection.deleteMany({ _id: fisherman._id });
});

// ---------------------------------------------------------------------------
// 2. Cross-LGA denial
// ---------------------------------------------------------------------------

test('an officer cannot register into another LGA', async () => {
  await assert.rejects(
    () => fishermanService.create(draft(13, { lga: 'ODU' }), adminBak, {}),
    /outside your scope/i
  );
});

test('an officer cannot read a record from another LGA', async () => {
  const fisherman = await register(adminBak, 14);

  // Deliberately reported as "not found": confirming existence would itself
  // disclose that a record with that id exists.
  await assert.rejects(
    () => fishermanService.getById(fisherman._id, adminOdu, {}),
    /not found/i
  );

  // And the same record IS reachable by an officer in its own LGA.
  const visible = await fishermanService.getById(fisherman._id, adminBak, {});
  assert.equal(String(visible.id), String(fisherman._id));

  await Fisherman.collection.deleteMany({ _id: fisherman._id });
});

test('a scoped list never returns another LGA’s records', async () => {
  const mine = await register(adminBak, 15);
  const theirs = await Fisherman.create({ ...draft(16), lga: 'ODU', registeredBy: adminOdu._id });

  const { items } = await fishermanService.list({ limit: 200 }, adminBak);
  const ids = items.map((i) => String(i._id));

  assert.ok(ids.includes(String(mine._id)));
  assert.ok(!ids.includes(String(theirs._id)), 'cross-LGA record leaked into a scoped list');

  await Fisherman.collection.deleteMany({ _id: { $in: [mine._id, theirs._id] } });
});

// ---------------------------------------------------------------------------
// 1 / 3. Authorization and privilege escalation
// ---------------------------------------------------------------------------

test('an enumerator cannot verify a record', async () => {
  const fisherman = await withPhoto(await register(enumeratorBak, 17));

  await assert.rejects(
    () => fishermanService.verify(fisherman._id, enumeratorBak, {}),
    /only authorised administrators/i
  );

  await Fisherman.collection.deleteMany({ _id: fisherman._id });
});

test('an officer cannot verify a record they registered themselves', async () => {
  const fisherman = await withPhoto(await register(adminBak, 18));

  await assert.rejects(
    () => fishermanService.verify(fisherman._id, adminBak, {}),
    /cannot verify a record you submitted/i
  );

  // A different administrator may.
  const otherAdmin = { _id: oid(), role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] } };
  const verified = await fishermanService.verify(fisherman._id, otherAdmin, {});
  assert.match(verified.blueId, /^CRS-BLU-BAK-\d+$/);

  await Fisherman.collection.deleteMany({ _id: fisherman._id });
});

// ---------------------------------------------------------------------------
// 5. Blue ID uniqueness under concurrency
// ---------------------------------------------------------------------------

test('concurrent verification issues exactly one Blue ID and burns none', async () => {
  const fisherman = await withPhoto(await register(enumeratorBak, 19));

  const before = await Counter.peek('blueid:BAK');

  const verifiers = [
    { _id: oid(), role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] } },
    { _id: oid(), role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] } },
    { _id: oid(), role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] } },
  ];

  const results = await Promise.allSettled(
    verifiers.map((v) => fishermanService.verify(fisherman._id, v, {}))
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1, 'exactly one verification may succeed');

  const after = await Counter.peek('blueid:BAK');
  assert.equal(after, before + 1, 'a losing caller must not consume a sequence number');

  const stored = await Fisherman.findById(fisherman._id).lean();
  assert.equal(stored.blueId, succeeded[0].value.blueId);

  await Fisherman.collection.deleteMany({ _id: fisherman._id });
});

test('Blue IDs issued in parallel are all distinct', async () => {
  const people = await Promise.all([20, 21, 22, 23, 24].map((n) => register(enumeratorBak, n)));
  await Promise.all(people.map(withPhoto));

  const verifier = { _id: oid(), role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] } };
  const verified = await Promise.all(
    people.map((p) => fishermanService.verify(p._id, verifier, {}))
  );

  const ids = verified.map((v) => v.blueId);
  assert.equal(new Set(ids).size, ids.length, `duplicate Blue ID issued: ${ids.join(', ')}`);

  await Fisherman.collection.deleteMany({ _id: { $in: people.map((p) => p._id) } });
});

// ---------------------------------------------------------------------------
// 14. Audit events for privileged operations
// ---------------------------------------------------------------------------

test('verification writes an audit entry naming the actor and the Blue ID', async () => {
  const fisherman = await withPhoto(await register(enumeratorBak, 25));
  const verifier = { _id: oid(), role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] }, email: 'v@test.invalid' };

  const verified = await fishermanService.verify(fisherman._id, verifier, {
    req: { id: 'test-request-id', ip: '127.0.0.1', get: () => undefined, user: verifier },
  });

  const entries = await AuditLog.find({
    'entity.id': fisherman._id,
    action: AUDIT_ACTIONS.BLUE_ID_ISSUED,
  }).lean();

  assert.equal(entries.length, 1, 'issuing a permanent identifier must be audited');
  assert.equal(entries[0].entity.blueId, verified.blueId);
  assert.equal(String(entries[0].actor.user), String(verifier._id));
  assert.equal(entries[0].context.requestId, 'test-request-id', 'audit must correlate to the request');

  await AuditLog.collection.deleteMany({ 'entity.id': fisherman._id });
  await Fisherman.collection.deleteMany({ _id: fisherman._id });
});

// ---------------------------------------------------------------------------
// 7. Concurrent benefit allocation
// ---------------------------------------------------------------------------

test('a programme cannot be over-allocated past its target', async () => {
  const programme = await Programme.create({
    name: 'Concurrency test programme',
    code: `CONC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    type: 'GRANT',
    year: 2026,
    status: 'OPEN',
    targetBeneficiaries: 2,
    eligibility: { requiresVerifiedBlueId: false },
  });

  // Five distinct, verified beneficiaries competing for two slots.
  const people = await Promise.all([30, 31, 32, 33, 34].map((n) => register(enumeratorBak, n)));
  await Promise.all(people.map(withPhoto));
  const verifier = { _id: oid(), role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] } };
  await Promise.all(people.map((p) => fishermanService.verify(p._id, verifier, {})));

  const results = await Promise.allSettled(
    people.map((p) =>
      programmeService.allocate(
        programme._id,
        { fisherman: p._id, overrideEligibility: true, overrideReason: 'synthetic test fixture' },
        adminBak,
        {}
      )
    )
  );

  const granted = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(granted, 2, `expected exactly 2 allocations for 2 slots, got ${granted}`);

  const stored = await Programme.findById(programme._id).lean();
  assert.equal(stored.allocatedCount, 2, 'the counter must match the allocations');

  const actual = await Allocation.countDocuments({ programme: programme._id });
  assert.equal(actual, 2);

  await Allocation.collection.deleteMany({ programme: programme._id });
  await Programme.collection.deleteMany({ _id: programme._id });
  await Fisherman.collection.deleteMany({ _id: { $in: people.map((p) => p._id) } });
});

test('the same person cannot receive one programme twice, even concurrently', async () => {
  const programme = await Programme.create({
    name: 'Double benefit test',
    code: `DBL-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    type: 'GRANT',
    year: 2026,
    status: 'OPEN',
    eligibility: { requiresVerifiedBlueId: false },
  });

  const person = await withPhoto(await register(enumeratorBak, 35));
  const verifier = { _id: oid(), role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] } };
  await fishermanService.verify(person._id, verifier, {});

  const attempts = await Promise.allSettled(
    [1, 2, 3].map(() =>
      programmeService.allocate(
        programme._id,
        { fisherman: person._id, overrideEligibility: true, overrideReason: 'synthetic test fixture' },
        adminBak,
        {}
      )
    )
  );

  const granted = attempts.filter((r) => r.status === 'fulfilled').length;
  assert.equal(granted, 1, 'the uniqueness index must refuse a second active allocation');

  await Allocation.collection.deleteMany({ programme: programme._id });
  await Programme.collection.deleteMany({ _id: programme._id });
  await Fisherman.collection.deleteMany({ _id: person._id });
});

test('a benefit cannot be allocated to a deceased beneficiary even with an override', async () => {
  const programme = await Programme.create({
    name: 'Deceased guard test',
    code: `DEC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    type: 'GRANT',
    year: 2026,
    status: 'OPEN',
    eligibility: { requiresVerifiedBlueId: false },
  });

  const person = await withPhoto(await register(enumeratorBak, 36));
  const verifier = { _id: oid(), role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] } };
  await fishermanService.verify(person._id, verifier, {});
  await fishermanService.changeStatus(
    person._id,
    { status: FISHERMAN_STATUS.DECEASED, reason: 'synthetic test fixture' },
    stateAdmin,
    {}
  );

  await assert.rejects(
    () =>
      programmeService.allocate(
        programme._id,
        { fisherman: person._id, overrideEligibility: true, overrideReason: 'attempting to bypass' },
        adminBak,
        {}
      ),
    /cannot be allocated to a record with status DECEASED/i,
    'no written reason may authorise paying a deceased beneficiary'
  );

  await Programme.collection.deleteMany({ _id: programme._id });
  await Fisherman.collection.deleteMany({ _id: person._id });
});

// ---------------------------------------------------------------------------
// 11. Sensitive data protection
// ---------------------------------------------------------------------------

test('a NIN is never returned to a caller without the sensitive grant', async () => {
  const fisherman = await register(enumeratorBak, 40, { nin: '12345678901' });

  // An enumerator holds no `fisherman:read_sensitive` grant.
  const asEnumerator = await fishermanService.getById(fisherman._id, enumeratorBak, {});
  assert.equal(asEnumerator.nin, undefined);
  assert.equal(asEnumerator.ninMasked, undefined, 'not even a masked form without the grant');

  // An administrator sees it masked by default.
  const asAdmin = await fishermanService.getById(fisherman._id, adminBak, {});
  assert.equal(asAdmin.nin, undefined, 'the NIN is not returned unless explicitly requested');
  assert.equal(asAdmin.ninMasked, '*******8901');

  // Asking for it explicitly discloses it AND writes an audit entry.
  const disclosed = await fishermanService.getById(fisherman._id, adminBak, {
    includeNin: true,
    req: { id: 'nin-read', ip: '127.0.0.1', get: () => undefined, user: adminBak },
  });
  assert.equal(disclosed.nin, '12345678901');

  const audits = await AuditLog.find({
    'entity.id': fisherman._id,
    action: AUDIT_ACTIONS.VIEW_SENSITIVE,
  }).lean();
  assert.equal(audits.length, 1, 'reading a NIN must be recorded');
  assert.equal(audits[0].metadata.field, 'nin');

  await AuditLog.collection.deleteMany({ 'entity.id': fisherman._id });
  await Fisherman.collection.deleteMany({ _id: fisherman._id });
});

test('serialising a record never leaks internal matching keys', async () => {
  const fisherman = await register(enumeratorBak, 41, { nin: '10987654321' });
  const json = fisherman.toJSON();

  assert.equal(json.match, undefined, 'blind index and phonetic keys are internal');
  assert.equal(json.nin, undefined);
  assert.equal(json.verificationToken, undefined, 'the QR token is a card credential');

  await Fisherman.collection.deleteMany({ _id: fisherman._id });
});

// ---------------------------------------------------------------------------
// 15. Pagination limits
// ---------------------------------------------------------------------------

test('pagination is bounded and deep offsets are refused', async () => {
  const { items, pagination } = await fishermanService.list({ limit: 5000 }, stateAdmin);

  assert.ok(items.length <= 200, 'the page size must be capped regardless of the request');
  assert.ok(pagination.limit <= 200);

  await assert.rejects(
    async () => fishermanService.list({ page: 100000, limit: 25 }, stateAdmin),
    /too deep/i
  );
});
