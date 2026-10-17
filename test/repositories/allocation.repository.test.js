'use strict';

/**
 * Programme and allocation repository tests.
 *
 * §6 of the concept note gives this table its reason to exist: every benefit
 * tied to a Blue ID, so government can see who received assistance, and so
 * one person cannot collect twice from one programme. That rule is a
 * database index here, and these tests attack it the ways it would actually
 * be attacked — two officers at once, a replayed sync, a corrected re-issue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const database = require('../../src/config/database');
const fishermen = require('../../src/modules/fishermen/fisherman.repository');
const users = require('../../src/modules/users/user.repository');
const programmes = require('../../src/modules/programmes/programme.repository');
const allocations = require('../../src/modules/programmes/allocation.repository');
const { ROLES, USER_STATUS } = require('../../src/config/constants');

const TAG = crypto.randomBytes(4).toString('hex');
let officer;
let ada;
let eno;

test.before(async () => {
  await database.connect();
  officer = await users.create({
    email: `alloc-${TAG}@repo.test.invalid`,
    firstName: 'Alloc', lastName: 'Officer',
    role: ROLES.STATE_ADMIN, status: USER_STATUS.ACTIVE,
  });
  ada = await fishermen.create(
    { firstName: 'Ada', lastName: 'Beneficiary', gender: 'FEMALE', lga: 'BAK', clientRecordId: `${TAG}-ada`,
      blueId: `CRS-BLU-BAK-${TAG}A`, status: 'ACTIVE' },
    {}
  );
  eno = await fishermen.create(
    { firstName: 'Eno', lastName: 'Beneficiary', gender: 'MALE', lga: 'BAK', clientRecordId: `${TAG}-eno`,
      blueId: `CRS-BLU-BAK-${TAG}E`, status: 'ACTIVE' },
    {}
  );
});

test.after(async () => {
  await allocations.hardDelete({ clientRecordIdLike: `${TAG}-%` }).catch(() => {});
  for (const f of [ada, eno]) {
    if (f) await allocations.hardDelete({ programme: null }).catch(() => {});
  }
  await programmes.hardDelete({ codeLike: `${TAG}%` }).catch(() => {});
  await fishermen.hardDelete({ clientRecordIdLike: `${TAG}-%` }).catch(() => {});
  await users.hardDelete({ id: officer.id }).catch(() => {});
  await database.disconnect();
});

let n = 0;
async function makeProgramme(overrides = {}) {
  n += 1;
  return programmes.create({
    name: `Engines ${n}`,
    code: `${TAG}P${n}`,
    type: 'OUTBOARD_ENGINE_DISTRIBUTION',
    year: 2026,
    status: 'OPEN',
    createdBy: officer.id,
    ...overrides,
  });
}

const allocate = (programme, fisherman, overrides = {}) =>
  allocations.create({
    programme: programme.id,
    programmeCode: programme.code,
    programmeType: programme.type,
    fisherman: fisherman.id,
    blueId: fisherman.blueId,
    fishermanName: fisherman.fullName,
    lga: fisherman.lga,
    allocatedBy: officer.id,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// The duplicate-benefit guarantee (§6)
// ---------------------------------------------------------------------------

test('one person cannot collect twice from one programme', async () => {
  const programme = await makeProgramme();
  await allocate(programme, ada);

  await assert.rejects(
    () => allocate(programme, ada),
    (err) => {
      assert.ok(allocations.isDuplicateBenefit(err), 'the duplicate-benefit index is what refuses');
      return true;
    }
  );
});

test('two officers allocating at the same instant: only one succeeds', async () => {
  // The case a check-then-insert cannot cover, because the window between
  // the check and the insert is exactly where both pass.
  const programme = await makeProgramme();

  const results = await Promise.allSettled([
    allocate(programme, ada),
    allocate(programme, ada),
    allocate(programme, ada),
  ]);

  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');

  assert.equal(ok.length, 1, 'exactly one allocation is issued');
  assert.equal(refused.length, 2);
  assert.ok(refused.every((r) => allocations.isDuplicateBenefit(r.reason)));
});

test('the same person may be served by a different programme', async () => {
  const engines = await makeProgramme();
  const nets = await makeProgramme({ type: 'FISHING_NET_DISTRIBUTION' });

  await allocate(engines, eno);
  const second = await allocate(nets, eno);

  assert.ok(second.id, 'a different programme is a different entitlement');
});

test('a revoked allocation frees the person for a corrected re-issue', async () => {
  const programme = await makeProgramme();
  const first = await allocate(programme, ada);

  // Blocked while it stands.
  await assert.rejects(() => allocate(programme, ada));

  await allocations.changeStatus(first.id, {
    status: 'REVOKED', actorId: officer.id, reason: 'issued against the wrong record',
  });

  const reissued = await allocate(programme, ada);
  assert.ok(reissued.id, 'the correction is allowed');

  // And the revoked one is still there — who received what is a fact the
  // Ministry keeps, not something cleaned up.
  const history = await allocations.findByFisherman(ada.id);
  assert.ok(history.some((a) => a.id === first.id && a.status === 'REVOKED'));
});

test('a rejected allocation also frees the person', async () => {
  const programme = await makeProgramme();
  const first = await allocate(programme, eno);
  await allocations.changeStatus(first.id, { status: 'REJECTED', actorId: officer.id, reason: 'not eligible' });

  const second = await allocate(programme, eno);
  assert.ok(second.id);
});

test('a replayed sync cannot issue a second benefit', async () => {
  const programme = await makeProgramme();
  const recordId = `${TAG}-replay`;

  await allocate(programme, ada, { clientRecordId: recordId });
  await assert.rejects(
    () => allocate(programme, eno, { clientRecordId: recordId }),
    (err) => /duplicate key|unique/i.test(err.message),
    'the replay key refuses even for a different person'
  );
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('the active flag mirrors the status rather than being set by hand', async () => {
  const programme = await makeProgramme();
  const a = await allocate(programme, ada);
  assert.equal(a.isActiveAllocation, true, 'PENDING counts against the programme');

  const approved = await allocations.changeStatus(a.id, { status: 'APPROVED', actorId: officer.id });
  assert.equal(approved.isActiveAllocation, true);
  assert.ok(approved.approvedAt);

  const delivered = await allocations.changeStatus(a.id, { status: 'DELIVERED', actorId: officer.id });
  assert.equal(delivered.isActiveAllocation, true);
  assert.ok(delivered.deliveredAt);

  const revoked = await allocations.changeStatus(a.id, { status: 'REVOKED', actorId: officer.id, reason: 'recovered' });
  assert.equal(revoked.isActiveAllocation, false, 'revoking releases the entitlement');
  assert.equal(revoked.revokedReason, 'recovered');
});

test('delivery records the proof captured at handover', async () => {
  const programme = await makeProgramme();
  const a = await allocate(programme, eno);

  const delivered = await allocations.recordDelivery(a.id, {
    acknowledgement: { receivedByName: 'Eno Beneficiary', signedAt: new Date().toISOString() },
    deliveredBy: officer.id,
  });

  assert.equal(delivered.status, 'DELIVERED');
  assert.equal(delivered.acknowledgement.receivedByName, 'Eno Beneficiary');
});

test('a revoked allocation cannot then be marked delivered', async () => {
  const programme = await makeProgramme();
  const a = await allocate(programme, ada);
  await allocations.changeStatus(a.id, { status: 'REVOKED', actorId: officer.id, reason: 'withdrawn' });

  const attempted = await allocations.recordDelivery(a.id, { deliveredBy: officer.id });
  assert.equal(attempted, null, 'a withdrawn benefit cannot be delivered');
});

test('benefit history survives a soft delete', async () => {
  const programme = await makeProgramme();
  const a = await allocate(programme, eno);
  await allocations.softDelete(a.id, { reason: 'created in error' });

  assert.equal(await allocations.findById(a.id), null, 'out of ordinary reads');
  assert.ok(await allocations.findById(a.id, { includeDeleted: true }), 'still auditable');

  // And it no longer blocks the person.
  assert.ok(await allocate(programme, eno));
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test('the eligible list excludes anyone already served', async () => {
  const programme = await makeProgramme();

  const before = await allocations.findEligible(programme.id, { lga: 'BAK', limit: 500 });
  const beforeIds = before.items.map((f) => f.id);
  assert.ok(beforeIds.includes(ada.id), 'a verified fisherman is eligible');

  await allocate(programme, ada);

  const after = await allocations.findEligible(programme.id, { lga: 'BAK', limit: 500 });
  assert.ok(!after.items.some((f) => f.id === ada.id), 'and is excluded once served');
});

test('an unverified fisherman is not eligible', async () => {
  // No Blue ID means no verified identity to tie a benefit to, which is the
  // whole premise of §6.
  const unverified = await fishermen.create(
    { firstName: 'Not', lastName: 'Verified', gender: 'MALE', lga: 'BAK', clientRecordId: `${TAG}-unver` },
    {}
  );
  const programme = await makeProgramme();

  const { items } = await allocations.findEligible(programme.id, { lga: 'BAK', limit: 500 });
  assert.ok(!items.some((f) => f.id === unverified.id));
});

test('hasActiveAllocation answers the question the UI asks', async () => {
  const programme = await makeProgramme();
  assert.equal(await allocations.hasActiveAllocation(programme.id, ada.id), false);
  await allocate(programme, ada);
  assert.equal(await allocations.hasActiveAllocation(programme.id, ada.id), true);
});

// ---------------------------------------------------------------------------
// Programme counters
// ---------------------------------------------------------------------------

test('counters move relatively, so concurrent allocations do not lose one', async () => {
  const programme = await makeProgramme();

  // A recount would have each of these read the same total and write the
  // same successor.
  await Promise.all(Array.from({ length: 5 }, () => programmes.bumpCounters(programme.id, { allocated: 1 })));

  const after = await programmes.findById(programme.id);
  assert.equal(after.allocatedCount, 5, 'every increment landed');
});

test('a recount reconciles counters that have drifted', async () => {
  const programme = await makeProgramme();
  await allocate(programme, ada);
  const delivered = await allocate(programme, eno);
  await allocations.changeStatus(delivered.id, { status: 'DELIVERED', actorId: officer.id });

  // Simulate drift, as a restore or a manual correction would cause.
  await programmes.bumpCounters(programme.id, { allocated: 99 });

  const reconciled = await programmes.recountFromAllocations(programme.id);
  assert.equal(reconciled.allocatedCount, 2);
  assert.equal(reconciled.deliveredCount, 1);
});

// ---------------------------------------------------------------------------
// Scope and reporting
// ---------------------------------------------------------------------------

test('an officer cannot read allocations outside their LGA', async () => {
  const programme = await makeProgramme();
  const mine = await allocate(programme, ada);

  assert.ok(await allocations.findById(mine.id, { scope: { lgas: ['BAK'] } }));
  assert.equal(await allocations.findById(mine.id, { scope: { lgas: ['OBU'] } }), null);
  assert.equal(await allocations.findById(mine.id, { scope: { lgas: [] } }), null, 'empty scope sees nothing');
});

test('the summary counts statuses and unique beneficiaries', async () => {
  const programme = await makeProgramme();
  const a = await allocate(programme, ada);
  await allocate(programme, eno);
  await allocations.changeStatus(a.id, { status: 'DELIVERED', actorId: officer.id });

  const summary = await allocations.summary({ programmeId: programme.id });
  assert.equal(summary.total, 2);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.uniqueBeneficiaries, 2);
  assert.equal(typeof summary.total, 'number', 'counts are numbers, not strings');
});
