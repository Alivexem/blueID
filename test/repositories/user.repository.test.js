'use strict';

/**
 * User repository tests.
 *
 * These cover the three behaviours that were implicit in the Mongoose schema
 * and are now explicit in SQL — hidden credential columns, the soft-delete
 * filter, and the computed full name — plus the atomic lockout counter,
 * which was a read-modify-write before and is now one statement.
 *
 * Synthetic accounts only; the database is created and dropped by the run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const database = require('../../src/config/database');
const users = require('../../src/modules/users/user.repository');
const { ROLES, USER_STATUS } = require('../../src/config/constants');

test.before(async () => {
  await database.connect();
});
test.after(async () => {
  await users.hardDelete({ emailLike: '%@repo.test.invalid' }).catch(() => {});
  await database.disconnect();
});

const unique = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}@repo.test.invalid`;

async function makeUser(overrides = {}) {
  return users.create({
    email: unique('officer'),
    firstName: 'Ada',
    lastName: 'Effiom',
    role: ROLES.ENUMERATOR,
    status: USER_STATUS.ACTIVE,
    scope: { lgas: ['BAK'], communities: [] },
    passwordHash: 'argon2-placeholder-not-a-real-hash',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('a created account comes back in the shape the API already returns', async () => {
  const user = await makeUser({ firstName: 'Eno', lastName: 'Bassey' });

  // camelCase, not the snake_case the columns use.
  assert.equal(user.firstName, 'Eno');
  assert.equal(user.lastName, 'Bassey');
  assert.equal(user.mustChangePassword, false);

  // `fullName` was a Mongoose virtual; it is now computed in SQL, so it can
  // also be sorted and searched on.
  assert.equal(user.fullName, 'Eno Bassey');

  // `scope` is nested, as the authorization middleware expects, even though
  // the table stores two flat arrays.
  assert.deepEqual(user.scope.lgas, ['BAK']);
  assert.deepEqual(user.scope.communities, []);
  assert.equal(user.scopeLgas, undefined, 'the flat columns must not leak');

  // Both identifiers, so code written against either keeps working.
  assert.ok(user.id);
  assert.equal(String(user._id), String(user.id));
});

test('credential columns are absent unless the query asks for them', async () => {
  const user = await makeUser();

  const plain = await users.findById(user.id);
  for (const hidden of ['passwordHash', 'resetTokenHash', 'failedLoginAttempts', 'lockedUntil']) {
    assert.equal(plain[hidden], undefined, `${hidden} must not be in the default projection`);
  }

  const full = await users.findById(user.id, { withCredentials: true });
  assert.equal(full.passwordHash, 'argon2-placeholder-not-a-real-hash');
});

test('an email lookup is case-insensitive, and the stored address is lowered', async () => {
  const address = unique('MiXeD').toUpperCase();
  const user = await users.create({
    email: address,
    firstName: 'Case',
    lastName: 'Test',
    role: ROLES.ENUMERATOR,
    status: USER_STATUS.ACTIVE,
  });

  assert.equal(user.email, address.toLowerCase());
  assert.ok(await users.findByEmail(address));
  assert.ok(await users.findByEmail(address.toLowerCase()));
});

test('two accounts cannot share an address', async () => {
  const address = unique('clash');
  await users.create({ email: address, firstName: 'A', lastName: 'One', role: ROLES.ENUMERATOR });

  await assert.rejects(
    () => users.create({ email: address, firstName: 'B', lastName: 'Two', role: ROLES.ENUMERATOR }),
    (err) => /duplicate key|unique/i.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------

test('a removed account disappears from every ordinary read', async () => {
  const user = await makeUser();
  await users.softDelete(user.id, {});

  assert.equal(await users.findById(user.id), null, 'findById');
  assert.equal(await users.findByEmail(user.email), null, 'findByEmail');

  const { items } = await users.list({ limit: 200 });
  assert.ok(!items.some((u) => u.id === user.id), 'list');

  // Still retrievable deliberately, for an administrator investigating.
  const removed = await users.findById(user.id, { includeDeleted: true });
  assert.equal(removed.isDeleted, true);
});

// ---------------------------------------------------------------------------
// Lockout
// ---------------------------------------------------------------------------

test('the failure counter is atomic and locks at the threshold', async () => {
  const user = await makeUser();

  for (let i = 1; i <= 7; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const state = await users.registerLoginFailure(user.id, { threshold: 8, lockMinutes: 15 });
    assert.equal(state.failedLoginAttempts, i);
    assert.equal(state.lockedUntil, undefined, `must not lock at ${i} failures`);
  }

  const locked = await users.registerLoginFailure(user.id, { threshold: 8, lockMinutes: 15 });
  assert.equal(locked.failedLoginAttempts, 8);
  assert.ok(locked.lockedUntil instanceof Date, 'the eighth failure locks the account');
  assert.ok(locked.lockedUntil > new Date(), 'the lock is in the future');

  await users.registerLoginSuccess(user.id, { ip: '198.51.100.7' });
  const after = await users.findById(user.id, { withCredentials: true });
  assert.equal(after.failedLoginAttempts, 0);
  assert.equal(after.lockedUntil, undefined, 'a success clears the lock');
  assert.equal(after.lastLoginIp, '198.51.100.7');
});

test('concurrent failures each count, rather than overwriting one another', async () => {
  // The Mongoose version read the document, incremented in JavaScript and
  // saved, so two simultaneous attempts both wrote 1 and an attacker got
  // twice the budget. One UPDATE cannot lose a count that way.
  const user = await makeUser();

  await Promise.all(
    Array.from({ length: 6 }, () =>
      users.registerLoginFailure(user.id, { threshold: 8, lockMinutes: 15 })
    )
  );

  const state = await users.findById(user.id, { withCredentials: true });
  assert.equal(state.failedLoginAttempts, 6, 'every concurrent failure was counted');
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test('an LGA administrator sees only staff who share an LGA', async () => {
  const bakassi = await makeUser({ scope: { lgas: ['BAK'], communities: [] } });
  const obudu = await makeUser({ scope: { lgas: ['OBU'], communities: [] } });

  const { items } = await users.list({ limit: 200, scopeLgas: ['BAK'] });
  const ids = items.map((u) => u.id);

  assert.ok(ids.includes(bakassi.id), 'their own LGA is visible');
  assert.ok(!ids.includes(obudu.id), 'another LGA is not');
});

test('an administrator with no LGA sees nobody, not everybody', async () => {
  await makeUser({ scope: { lgas: ['BAK'], communities: [] } });

  // An empty scope is a restriction. Treating it as a wildcard is the classic
  // way a scope filter leaks the whole table.
  const { items } = await users.list({ limit: 200, scopeLgas: [] });
  assert.equal(items.length, 0);
});

test('an unknown key in a payload cannot become a column', async () => {
  const user = await users.create({
    email: unique('strict'),
    firstName: 'Mass',
    lastName: 'Assign',
    role: ROLES.ENUMERATOR,
    // None of these are columns; they must be dropped rather than reaching SQL.
    isDeleted: false,
    somethingInvented: 'nope',
    '; DROP TABLE users; --': 'nope',
  });

  assert.ok(user.id);
  assert.equal(user.somethingInvented, undefined);

  const stillThere = await users.count({});
  assert.ok(stillThere > 0, 'the users table still exists');
});
