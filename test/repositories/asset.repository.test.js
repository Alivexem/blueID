'use strict';

/**
 * Boat, engine and equipment repository tests.
 *
 * The concept note is explicit that one Blue ID may carry several boats and
 * engines (§4c), and that most artisanal canoes have no registration number
 * at all — so "unique when present" has to mean exactly that, and the
 * absence of a number must never block a registration.
 *
 * The sync cursor is tested on each kind rather than once, because the
 * precision trap it guards against is silent: a device re-pulls page one
 * forever and nothing errors.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const database = require('../../src/config/database');
const fishermen = require('../../src/modules/fishermen/fisherman.repository');
const boats = require('../../src/modules/assets/boat.repository');
const engines = require('../../src/modules/assets/engine.repository');
const equipment = require('../../src/modules/assets/equipment.repository');

const TAG = crypto.randomBytes(4).toString('hex');
let owner;
let otherOwner;

test.before(async () => {
  await database.connect();
  owner = await fishermen.create(
    { firstName: 'Asset', lastName: 'Owner', gender: 'MALE', lga: 'BAK', clientRecordId: `${TAG}-owner` },
    {}
  );
  otherOwner = await fishermen.create(
    { firstName: 'Second', lastName: 'Owner', gender: 'MALE', lga: 'OBU', clientRecordId: `${TAG}-owner2` },
    {}
  );
});

test.after(async () => {
  for (const repo of [boats, engines, equipment]) {
    await repo.hardDelete({ clientRecordIdLike: `${TAG}-%` }).catch(() => {});
  }
  await fishermen.hardDelete({ clientRecordIdLike: `${TAG}-%` }).catch(() => {});
  await database.disconnect();
});

let n = 0;
const rec = () => `${TAG}-${(n += 1)}`;

// ---------------------------------------------------------------------------
// §4c: several assets per Blue ID
// ---------------------------------------------------------------------------

test('one fisherman can own several boats and several engines', async () => {
  // The brief says so in as many words: "The system should allow more than
  // one boat or engine to be connected to a single Blue ID."
  const a = await boats.create({ owner: owner.id, lga: 'BAK', boatType: 'DUGOUT_CANOE', clientRecordId: rec() });
  const b = await boats.create({ owner: owner.id, lga: 'BAK', boatType: 'PLANK_CANOE', clientRecordId: rec() });
  const e1 = await engines.create({ owner: owner.id, lga: 'BAK', manufacturer: 'Yamaha', clientRecordId: rec() });
  const e2 = await engines.create({ owner: owner.id, lga: 'BAK', manufacturer: 'Suzuki', clientRecordId: rec() });

  assert.notEqual(a.id, b.id);
  assert.equal((await boats.findByOwner(owner.id)).length >= 2, true);
  assert.equal((await engines.findByOwner(owner.id)).length >= 2, true);
  assert.ok(e1.id && e2.id);
});

test('a canoe with no registration number is still registrable', async () => {
  // Most artisanal canoes have never been registered with anyone. Requiring
  // a number would stop an enumerator recording the boat in front of them.
  const first = await boats.create({ owner: owner.id, lga: 'BAK', boatType: 'DUGOUT_CANOE', clientRecordId: rec() });
  const second = await boats.create({ owner: owner.id, lga: 'BAK', boatType: 'DUGOUT_CANOE', clientRecordId: rec() });

  assert.equal(first.registrationNumber, undefined);
  assert.equal(second.registrationNumber, undefined);
  assert.notEqual(first.id, second.id, 'two unregistered canoes coexist');
});

test('a registration number, once given, cannot be given twice', async () => {
  const number = `CRS-BT-${TAG}`;
  await boats.create({ owner: owner.id, lga: 'BAK', boatType: 'WOODEN_BOAT', registrationNumber: number, clientRecordId: rec() });

  await assert.rejects(
    () => boats.create({ owner: otherOwner.id, lga: 'OBU', boatType: 'WOODEN_BOAT', registrationNumber: number, clientRecordId: rec() }),
    (err) => /duplicate key|unique/i.test(err.message)
  );

  const found = await boats.findByRegistrationNumber(number);
  assert.equal(String(found.owner), String(owner.id));
});

test('an engine serial cannot be registered twice', async () => {
  // The serial is how a programme proves the engine it issued is the one
  // still in use, and how the same engine registered twice is caught.
  const serial = `SN-${TAG}`;
  await engines.create({ owner: owner.id, lga: 'BAK', manufacturer: 'Yamaha', serialNumber: serial, clientRecordId: rec() });

  await assert.rejects(
    () => engines.create({ owner: otherOwner.id, lga: 'OBU', manufacturer: 'Yamaha', serialNumber: serial, clientRecordId: rec() }),
    (err) => /duplicate key|unique/i.test(err.message)
  );
});

test('equipment has no unique identifier, because nets do not have serials', async () => {
  const a = await equipment.create({ owner: owner.id, lga: 'BAK', type: 'FISHING_NET', quantity: 6, clientRecordId: rec() });
  const b = await equipment.create({ owner: owner.id, lga: 'BAK', type: 'FISHING_NET', quantity: 4, clientRecordId: rec() });

  assert.notEqual(a.id, b.id);
  assert.equal(a.quantity, 6, 'quantity is a column, not six rows');

  // `specification` is JSONB because a mesh size, a capacity and a brand are
  // not one attribute under different names.
  const net = await equipment.create({
    owner: owner.id, lga: 'BAK', type: 'FISHING_NET', clientRecordId: rec(),
    specification: { meshSizeInches: 2.5, lengthMeters: 100, brand: 'Generic' },
  });
  assert.equal(net.specification.meshSizeInches, 2.5);
  assert.ok(b.id);
});

// ---------------------------------------------------------------------------
// Replay safety
// ---------------------------------------------------------------------------

test('a replayed sync cannot duplicate an asset', async () => {
  for (const [repo, payload] of [
    [boats, { boatType: 'DUGOUT_CANOE' }],
    [engines, { manufacturer: 'Yamaha' }],
    [equipment, { type: 'COLD_BOX' }],
  ]) {
    const recordId = rec();
    // eslint-disable-next-line no-await-in-loop
    await repo.create({ owner: owner.id, lga: 'BAK', clientRecordId: recordId, ...payload });
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => repo.create({ owner: owner.id, lga: 'BAK', clientRecordId: recordId, ...payload }),
      (err) => /duplicate key|unique/i.test(err.message),
      `${repo.label} must refuse a replayed client record id`
    );
  }
});

test('a stale revision is refused on an asset too', async () => {
  const boat = await boats.create({ owner: owner.id, lga: 'BAK', boatType: 'PLANK_CANOE', clientRecordId: rec() });

  const ok = await boats.updateIfUnchanged(boat.id, { condition: 'GOOD' }, 0);
  assert.equal(ok.updated, true);

  const stale = await boats.updateIfUnchanged(boat.id, { condition: 'POOR' }, 0);
  assert.equal(stale.updated, false);
  assert.equal(stale.reason, 'revision conflict');

  assert.equal((await boats.findById(boat.id)).condition, 'GOOD');
});

// ---------------------------------------------------------------------------
// The sync cursor, on every kind
// ---------------------------------------------------------------------------

for (const [name, repo, payload] of [
  ['boats', boats, { boatType: 'DUGOUT_CANOE' }],
  ['engines', engines, { manufacturer: 'Yamaha' }],
  ['equipment', equipment, { type: 'FISHING_NET' }],
]) {
  test(`the ${name} sync cursor advances instead of repeating a page`, async () => {
    // The failure this guards is silent: a cursor read back as a JS Date
    // loses microseconds, so it never moves past a tie and the device
    // re-pulls the same page forever with no error.
    const made = [];
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      made.push(await repo.create({ owner: otherOwner.id, lga: 'YAK', clientRecordId: rec(), ...payload }));
    }
    const ids = new Set(made.map((m) => m.id));

    const seen = [];
    let cursor = { since: '1970-01-01T00:00:00Z', lastId: null };

    for (let page = 0; page < 20; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await repo.pullSince({ ...cursor, limit: 3, lgas: ['YAK'] });
      if (!batch.items.length) break;
      for (const row of batch.items) if (ids.has(row.id)) seen.push(row.id);
      cursor = batch.cursor;
    }

    assert.equal(seen.length, 7, 'every record pulled');
    assert.equal(new Set(seen).size, 7, 'and none pulled twice');
  });
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

test('a transferred boat moves LGA with its new owner', async () => {
  const boat = await boats.create({ owner: owner.id, lga: 'BAK', boatType: 'FIBREGLASS_BOAT', clientRecordId: rec() });

  const moved = await boats.transfer(boat.id, {
    toOwnerId: otherOwner.id,
    toLga: 'OBU',
    toBlueId: null,
  });

  assert.equal(String(moved.owner), String(otherOwner.id));
  assert.equal(moved.lga, 'OBU', 'the LGA follows the owner');

  // It must now be visible to Obudu officers and invisible to Bakassi ones,
  // because scope is enforced on the asset's own LGA.
  assert.ok(await boats.findById(boat.id, { scope: { lgas: ['OBU'] } }));
  assert.equal(await boats.findById(boat.id, { scope: { lgas: ['BAK'] } }), null);
});

// ---------------------------------------------------------------------------
// Scope and lifecycle
// ---------------------------------------------------------------------------

test('an officer cannot read assets outside their LGA', async () => {
  const mine = await boats.create({ owner: owner.id, lga: 'BAK', boatType: 'DUGOUT_CANOE', clientRecordId: rec() });
  const theirs = await boats.create({ owner: otherOwner.id, lga: 'OBU', boatType: 'DUGOUT_CANOE', clientRecordId: rec() });

  const scope = { lgas: ['BAK'] };
  assert.ok(await boats.findById(mine.id, { scope }));
  assert.equal(await boats.findById(theirs.id, { scope }), null);

  const { items } = await boats.list({ limit: 200 }, { scope });
  assert.ok(!items.some((b) => b.lga === 'OBU'));
});

test('an officer with no LGA sees no assets', async () => {
  const { total } = await boats.list({ limit: 200 }, { scope: { lgas: [] } });
  assert.equal(total, 0);
});

test('a removed asset leaves the list but stays auditable', async () => {
  const boat = await boats.create({ owner: owner.id, lga: 'BAK', boatType: 'TRAWLER', clientRecordId: rec() });
  await boats.softDelete(boat.id, { reason: 'recorded in error' });

  assert.equal(await boats.findById(boat.id), null);
  assert.ok(await boats.findById(boat.id, { includeDeleted: true }));
});

// ---------------------------------------------------------------------------
// The register's assets cannot be orphaned
// ---------------------------------------------------------------------------

test('a fisherman holding assets cannot be hard-deleted out from under them', async () => {
  const holder = await fishermen.create(
    { firstName: 'Holds', lastName: 'Assets', gender: 'MALE', lga: 'BAK', clientRecordId: rec() },
    {}
  );
  await boats.create({ owner: holder.id, lga: 'BAK', boatType: 'DUGOUT_CANOE', clientRecordId: rec() });

  // ON DELETE RESTRICT. A boat whose owner no longer exists is a record the
  // Ministry cannot act on, so the database refuses rather than cascading.
  await assert.rejects(
    () => fishermen.hardDelete({ id: holder.id }),
    (err) => /violates foreign key|still referenced/i.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// Dashboard aggregates (§7)
// ---------------------------------------------------------------------------

test('fleet and power aggregates group correctly', async () => {
  await engines.create({ owner: owner.id, lga: 'BAK', manufacturer: 'Yamaha', horsepower: 40, clientRecordId: rec() });
  await engines.create({ owner: owner.id, lga: 'BAK', manufacturer: 'Suzuki', horsepower: 15, clientRecordId: rec() });

  const byType = await boats.countByType({ lgas: ['BAK'] });
  assert.ok(byType.length > 0);
  assert.ok(byType.every((r) => typeof r.count === 'number'), 'counts are numbers, not strings');

  const power = await engines.horsepowerByLga({ lgas: ['BAK'] });
  const bakassi = power.find((r) => r.lga === 'BAK');
  assert.ok(bakassi.totalHorsepower >= 55, `expected at least 55hp, got ${bakassi.totalHorsepower}`);
  assert.ok(typeof bakassi.averageHorsepower === 'number');
});
