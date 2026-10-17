'use strict';

/**
 * Session and counter repository tests.
 *
 * Both exist to be correct under concurrency, so both are tested that way.
 * A Blue ID handed to two people, or a stolen refresh token that keeps
 * working, are the kind of failure that is discovered months later at a
 * landing site rather than by an error in a log.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const database = require('../../src/config/database');
const sessions = require('../../src/modules/auth/session.repository');
const counters = require('../../src/modules/fishermen/counter.repository');
const users = require('../../src/modules/users/user.repository');
const { ROLES, USER_STATUS } = require('../../src/config/constants');

let user;

test.before(async () => {
  await database.connect();
  user = await users.create({
    email: `session-${crypto.randomBytes(4).toString('hex')}@repo.test.invalid`,
    firstName: 'Session',
    lastName: 'Owner',
    role: ROLES.ENUMERATOR,
    status: USER_STATUS.ACTIVE,
  });
});

test.after(async () => {
  if (user) {
    await sessions.hardDelete({ userId: user.id }).catch(() => {});
    await users.hardDelete({ id: user.id }).catch(() => {});
  }
  await database.disconnect();
});

const token = () => crypto.randomBytes(24).toString('hex');

async function makeSession(overrides = {}) {
  const raw = token();
  const session = await sessions.create({
    user: user.id,
    tokenHash: sessions.hashToken(raw),
    family: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 30 * 86400_000),
    ipAddress: '198.51.100.7',
    ...overrides,
  });
  return { raw, session };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('the refresh token itself is never stored', async () => {
  const { raw, session } = await makeSession();

  assert.ok(!JSON.stringify(session).includes(raw), 'the raw token must not be in the row');
  assert.equal(session.tokenHash, sessions.hashToken(raw));

  // It is still findable by presenting the token, which is hashed first.
  const found = await sessions.findByToken(raw);
  assert.equal(found.id, session.id);
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test('rotating retires the old token and records its successor', async () => {
  const { session } = await makeSession();
  const nextHash = sessions.hashToken(token());

  assert.equal(await sessions.rotate(session.id, { nextTokenHash: nextHash }), true);

  const after = await sessions.findById(session.id);
  assert.ok(after.rotatedAt, 'rotatedAt is set');
  assert.equal(after.rotatedTo, nextHash);
});

test('two refreshes racing cannot both succeed', async () => {
  // Whichever loses sees zero rows updated, and the caller reads that as a
  // reuse — which is the correct reading, because only one of the two can be
  // the legitimate holder.
  const { session } = await makeSession();

  const outcomes = await Promise.all([
    sessions.rotate(session.id, { nextTokenHash: sessions.hashToken(token()) }),
    sessions.rotate(session.id, { nextTokenHash: sessions.hashToken(token()) }),
    sessions.rotate(session.id, { nextTokenHash: sessions.hashToken(token()) }),
  ]);

  assert.equal(outcomes.filter(Boolean).length, 1, 'exactly one rotation wins');
});

test('reusing a rotated token revokes the whole family', async () => {
  const family = crypto.randomUUID();
  const first = await makeSession({ family });
  const second = await makeSession({ family });
  const unrelated = await makeSession();

  await sessions.rotate(first.session.id, { nextTokenHash: sessions.hashToken(token()) });

  const { modifiedCount } = await sessions.revokeFamily(family, 'refresh token reused');
  assert.ok(modifiedCount >= 1);

  assert.ok((await sessions.findById(first.session.id)).revokedAt, 'the reused one');
  assert.ok((await sessions.findById(second.session.id)).revokedAt, 'its sibling');
  assert.equal(
    (await sessions.findById(unrelated.session.id)).revokedAt,
    undefined,
    'a different sign-in is untouched'
  );
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

test('a revoked, rotated or expired session is not usable', async () => {
  const live = await makeSession();
  assert.ok(await sessions.findUsable(live.session.id, user.id), 'a fresh session is usable');

  const revoked = await makeSession();
  await sessions.revoke(revoked.session.id, 'signed out');
  assert.equal(await sessions.findUsable(revoked.session.id, user.id), null, 'revoked');

  const expired = await makeSession({ expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await sessions.findUsable(expired.session.id, user.id), null, 'expired');

  // A session belonging to someone else is not usable by this caller even
  // with the right id — the holder is checked, not just the session.
  assert.equal(
    await sessions.findUsable(live.session.id, '00000000-0000-0000-0000-000000000000'),
    null,
    'another user'
  );
});

test('signing out everywhere can keep the current session', async () => {
  const keep = await makeSession();
  await makeSession();
  await makeSession();

  const { modifiedCount } = await sessions.revokeAllForUser(user.id, 'signed out everywhere', {
    exceptId: keep.session.id,
  });

  assert.ok(modifiedCount >= 2);
  assert.equal((await sessions.findById(keep.session.id)).revokedAt, undefined);
});

test('signing out twice is harmless', async () => {
  const { raw } = await makeSession();
  assert.equal(await sessions.revokeByToken(raw, 'signed out'), 1);
  assert.equal(await sessions.revokeByToken(raw, 'signed out'), 0, 'already revoked');
  assert.equal(await sessions.revokeByToken('never-existed', 'signed out'), 0);
});

// ---------------------------------------------------------------------------
// The Blue ID sequence
// ---------------------------------------------------------------------------

test('the sequence never hands out a number twice, even under load', async () => {
  const key = `test:blueid:${crypto.randomBytes(4).toString('hex')}`;

  // Fifty enumerators syncing at once is an ordinary Monday morning.
  const issued = await Promise.all(Array.from({ length: 50 }, () => counters.next(key)));

  assert.equal(new Set(issued).size, 50, 'every number is distinct');
  assert.deepEqual(
    [...issued].sort((a, b) => a - b),
    Array.from({ length: 50 }, (_, i) => i + 1),
    'and they are 1..50 with no gaps'
  );

  await counters.reset(key);
});

test('an abandoned registration gives its number back', async () => {
  const key = `test:blueid:${crypto.randomBytes(4).toString('hex')}`;
  await counters.next(key); // 1

  // A sequence would burn the number here and leave a permanent gap in a
  // scheme the Ministry reads as a count. A counter row rolls back.
  await assert.rejects(
    database.withTransaction(async (client) => {
      const n = await counters.next(key, client);
      assert.equal(n, 2);
      throw new Error('registration abandoned');
    })
  );

  assert.equal(await counters.peek(key), 1, 'the rolled-back number was returned');
  assert.equal(await counters.next(key), 2, 'and is reissued to the next registration');

  await counters.reset(key);
});

test('a counter can be raised after a restore but never lowered', async () => {
  const key = `test:blueid:${crypto.randomBytes(4).toString('hex')}`;

  // A backup predating the last registrations would leave the counter behind
  // the register, and the next issue would collide with a printed card.
  await counters.ensureAtLeast(key, 42);
  assert.equal(await counters.peek(key), 42);

  await counters.ensureAtLeast(key, 7);
  assert.equal(await counters.peek(key), 42, 'a stale value cannot move it backwards');

  assert.equal(await counters.next(key), 43);
  await counters.reset(key);
});
