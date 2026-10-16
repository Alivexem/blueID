'use strict';

/**
 * NoSQL injection and mass-assignment rejection.
 *
 * `sanitizeFilter` is deliberately off (it corrupts every internal operator
 * query — see config/database.js), so the boundary defences are what stand
 * between a crafted request and the query layer. These tests prove they hold.
 *
 * All data here is synthetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const listSchema = require('../src/modules/fishermen/fisherman.validation').listFishermen;
const createSchema = require('../src/modules/fishermen/fisherman.validation').createFisherman;
const { sanitizeRecordData } = require('../src/modules/sync/sync.validation');
const { andFilters, assertScalar, resolveSort } = require('../src/utils/query');
const fishermanService = require('../src/modules/fishermen/fisherman.service');
const { ROLES } = require('../src/config/constants');

const database = require('../src/config/database');

let connected = false;
test.before(async () => {
  await database.connect();
  connected = true;
});
test.after(async () => {
  if (connected) await database.disconnect();
});

const admin = {
  _id: '507f1f77bcf86cd799439011',
  role: ROLES.STATE_ADMIN,
  scope: { lgas: [], communities: [] },
};

// ---------------------------------------------------------------------------
// Operator injection through query parameters
// ---------------------------------------------------------------------------

test('an operator object in a query parameter is rejected', () => {
  // The classic payload: ?status[$ne]=DELETED arrives as an object.
  const payloads = [
    { status: { $ne: 'DELETED' } },
    { lga: { $gt: '' } },
    { community: { $ne: null } },
    { search: { $regex: '.*' } },
  ];

  for (const payload of payloads) {
    const result = listSchema.safeParse(payload);
    assert.equal(
      result.success,
      false,
      `${JSON.stringify(payload)} must not pass validation and reach a filter`
    );
  }
});

test('enum parameters accept only known values', () => {
  assert.equal(listSchema.safeParse({ lga: 'BAK' }).success, true);
  assert.equal(listSchema.safeParse({ lga: 'ZZZ' }).success, false);
  assert.equal(listSchema.safeParse({ status: 'ACTIVE' }).success, true);
  assert.equal(listSchema.safeParse({ status: 'NOT_A_STATUS' }).success, false);
});

test('identifiers must look like identifiers', () => {
  assert.equal(listSchema.safeParse({ community: '507f1f77bcf86cd799439011' }).success, true);
  assert.equal(listSchema.safeParse({ community: { $ne: null } }).success, false);
  assert.equal(listSchema.safeParse({ community: 'not-an-id' }).success, false);
});

test('a sort parameter outside the allowlist falls back, never passes through', () => {
  const allowed = ['createdAt', 'fullName'];
  assert.deepEqual(resolveSort('fullName', allowed), { fullName: 1 });
  assert.deepEqual(resolveSort('-fullName', allowed), { fullName: -1 });
  // An attempt to sort by an unindexed or internal field is ignored.
  assert.deepEqual(resolveSort('match.ninIndex', allowed), { createdAt: -1 });
  assert.deepEqual(resolveSort({ $where: '1' }, allowed), { createdAt: -1 });
});

test('assertScalar refuses a non-primitive filter value', () => {
  assert.equal(assertScalar('BAK'), 'BAK');
  assert.equal(assertScalar(42), 42);
  assert.throws(() => assertScalar({ $ne: null }, 'lga'), /Invalid value supplied for lga/);
  assert.throws(() => assertScalar(['a'], 'lga'), /Invalid value/);
});

test('a crafted search term reaches the query as a literal, not an operator', async () => {
  // Even if an attacker supplies regex metacharacters, the text search path
  // treats them as text and the phone path normalises to digits.
  const filter = fishermanService.buildListFilter({ search: '.*' }, admin);
  const serialised = JSON.stringify(filter);

  assert.doesNotMatch(serialised, /\$where/);
  assert.doesNotMatch(serialised, /\$regex/, 'free text must not become a regex');
});

// ---------------------------------------------------------------------------
// Mass assignment
// ---------------------------------------------------------------------------

test('authority fields are stripped from a create payload', () => {
  const parsed = createSchema.safeParse({
    firstName: 'Effiom',
    lastName: 'Okon',
    gender: 'MALE',
    estimatedYearOfBirth: 1980,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
    // Everything below is an attempt to assign authority.
    blueId: 'CRS-BLU-BAK-0001',
    status: 'ACTIVE',
    verification: { verifiedAt: new Date() },
    isDeleted: false,
    registeredBy: '507f1f77bcf86cd799439099',
    match: { ninIndex: 'forged' },
  });

  assert.equal(parsed.success, true, 'the legitimate fields must still validate');
  for (const field of ['blueId', 'status', 'verification', 'isDeleted', 'registeredBy', 'match']) {
    assert.ok(!(field in parsed.data), `${field} must not survive validation`);
  }
});

test('the sync path strips the same fields', () => {
  const clean = sanitizeRecordData('FISHERMAN', 'CREATE', {
    firstName: 'Bassey',
    lastName: 'Asuquo',
    gender: 'MALE',
    estimatedYearOfBirth: 1985,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
    blueId: 'CRS-BLU-BAK-0002',
    verificationToken: 'forged',
  });

  assert.ok(!('blueId' in clean));
  assert.ok(!('verificationToken' in clean));
});

// ---------------------------------------------------------------------------
// Scope composition cannot be subverted
// ---------------------------------------------------------------------------

test('a search clause cannot displace the authorization scope', () => {
  const scope = { $or: [{ registeredBy: 'user-1' }, { lga: { $in: ['BAK'] } }] };
  const search = { $or: [{ 'match.normalizedPhone': '+2348031234567' }] };

  const combined = andFilters(scope, { isDeleted: { $ne: true } }, search);
  const serialised = JSON.stringify(combined);

  assert.match(serialised, /registeredBy/, 'the scope clause survived');
  assert.match(serialised, /normalizedPhone/, 'the search clause survived');
  assert.ok(combined.$and, 'conflicting operators are combined, not overwritten');
});

// ---------------------------------------------------------------------------
// The filter actually executes (proves the query is well-formed)
// ---------------------------------------------------------------------------

test('a scoped list filter executes against MongoDB without a cast error', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');

  /**
   * This is the regression guard for the `sanitizeFilter` defect: with it
   * enabled, `{ isDeleted: { $ne: true } }` was rewritten to
   * `{ isDeleted: { $eq: { $ne: true } } }` and every query in the
   * application threw a CastError. Building the filter is not enough — it has
   * to run.
   */
  const enumerator = {
    _id: '507f1f77bcf86cd799439012',
    role: ROLES.ENUMERATOR,
    scope: { lgas: ['BAK'], communities: [] },
  };

  for (const query of [
    {},
    { status: 'ACTIVE' },
    { lga: 'BAK' },
    { search: 'Effiom' },
    { search: '08031234567' },
    { hasBlueId: true },
    { flagged: true },
  ]) {
    const filter = fishermanService.buildListFilter(query, enumerator);
    // eslint-disable-next-line no-await-in-loop
    const count = await Fisherman.countDocuments(filter);
    assert.equal(typeof count, 'number', `query ${JSON.stringify(query)} must execute`);
  }
});

test('soft-delete exclusion returns records, not a cast error', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const clientRecordId = crypto.randomUUID();

  await Fisherman.create({
    clientRecordId,
    firstName: 'Visible',
    lastName: 'Record',
    gender: 'MALE',
    estimatedYearOfBirth: 1990,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
  });

  const found = await Fisherman.find({ clientRecordId, isDeleted: { $ne: true } });
  assert.equal(found.length, 1, 'the $ne operator must reach MongoDB intact');

  await Fisherman.collection.deleteMany({ clientRecordId });
});
