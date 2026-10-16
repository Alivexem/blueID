'use strict';

/**
 * Local authentication tests.
 *
 * This service now owns the credential, so the controls that were previously
 * "delegated" — hashing, token lifetime, rotation, revocation, lockout,
 * enumeration resistance — are all ours to prove.
 *
 * Synthetic accounts and throwaway secrets only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.AUTH_MODE = 'local';
process.env.AUTH_JWT_SECRET =
  process.env.AUTH_JWT_SECRET || 'a-test-signing-secret-of-at-least-32-chars';

const database = require('../src/config/database');
const authService = require('../src/modules/auth/auth.service');
const password = require('../src/utils/password');
const User = require('../src/modules/users/user.model');
const Session = require('../src/modules/auth/session.model');
const { ROLES, USER_STATUS } = require('../src/config/constants');

let connected = false;
test.before(async () => {
  await database.connect();
  connected = true;
});
test.after(async () => {
  if (connected) await database.disconnect();
});

const req = { ip: '198.51.100.7', get: () => undefined };
const unique = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;

async function makeUser({ plaintext = 'correct-horse-battery-staple', ...overrides } = {}) {
  return User.create({
    email: `${unique('user')}@test.invalid`,
    firstName: 'Test',
    lastName: 'Officer',
    role: ROLES.ENUMERATOR,
    status: USER_STATUS.ACTIVE,
    scope: { lgas: ['BAK'] },
    passwordHash: await password.hash(plaintext),
    passwordChangedAt: new Date(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

test('passwords are hashed with Argon2id and are not reversible', async () => {
  const plaintext = 'a-perfectly-fine-passphrase';
  const hash = await password.hash(plaintext);

  assert.match(hash, /^\$argon2id\$/, 'must use Argon2id');
  assert.ok(!hash.includes(plaintext), 'the plaintext must not appear in the hash');
  assert.equal(await password.verify(hash, plaintext), true);
  assert.equal(await password.verify(hash, 'wrong'), false);

  // Salted: the same password hashes differently every time.
  assert.notEqual(hash, await password.hash(plaintext));
});

test('verification of an absent hash fails rather than throwing', async () => {
  // An account that never had a password must behave exactly like a wrong
  // password, not crash and not succeed.
  assert.equal(await password.verify(null, 'anything'), false);
  assert.equal(await password.verify('not-a-hash', 'anything'), false);
  assert.equal(await password.verify('', ''), false);
});

test('the password policy rejects weak and personal choices', () => {
  assert.equal(password.validate('short').valid, false);
  assert.equal(password.validate('password123').valid, false);
  assert.equal(password.validate('aaaaaaaaaaaaaa').valid, false);
  assert.equal(
    password.validate('effiom-okon-boat', { firstName: 'Effiom' }).valid,
    false,
    'a password containing the holder’s own name is guessable by anyone who knows them'
  );
  assert.equal(password.validate('tide-creek-lantern-77').valid, true);
});

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

test('a correct password returns an access and a refresh token', async () => {
  const user = await makeUser();
  const result = await authService.login(
    { email: user.email, password: 'correct-horse-battery-staple' },
    { req }
  );

  assert.ok(result.accessToken, 'access token issued');
  assert.ok(result.refreshToken, 'refresh token issued');
  assert.equal(result.tokenType, 'Bearer');
  assert.equal(result.user.role, ROLES.ENUMERATOR);

  // The refresh token is stored only as a hash.
  const stored = await Session.findOne({ tokenHash: Session.hashToken(result.refreshToken) });
  assert.ok(stored, 'session recorded');
  assert.notEqual(stored.tokenHash, result.refreshToken, 'the plaintext must not be stored');

  await User.collection.deleteMany({ _id: user._id });
});

test('the access token carries identity but never the role', async () => {
  const user = await makeUser();
  const { accessToken } = await authService.login(
    { email: user.email, password: 'correct-horse-battery-staple' },
    { req }
  );

  const [, payload] = accessToken.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());

  assert.equal(claims.sub, String(user._id));
  assert.ok(claims.sid, 'the session is named, so it can be revoked');
  assert.equal(claims.typ, 'access');
  assert.equal(
    claims.role,
    undefined,
    'a role in the token would go stale for up to its lifetime after a demotion'
  );

  await User.collection.deleteMany({ _id: user._id });
});

test('a wrong password and an unknown address are indistinguishable', async () => {
  const user = await makeUser();

  const wrongPassword = await authService
    .login({ email: user.email, password: 'definitely-wrong' }, { req })
    .catch((e) => e);
  const unknownEmail = await authService
    .login({ email: 'nobody@test.invalid', password: 'definitely-wrong' }, { req })
    .catch((e) => e);

  // Identical status, code AND message: the endpoint must not reveal which
  // government addresses are registered.
  assert.equal(wrongPassword.statusCode, unknownEmail.statusCode);
  assert.equal(wrongPassword.code, unknownEmail.code);
  assert.equal(wrongPassword.message, unknownEmail.message);
  assert.equal(wrongPassword.code, 'INVALID_CREDENTIALS');

  await User.collection.deleteMany({ _id: user._id });
});

test('a suspended account cannot sign in', async () => {
  const user = await makeUser({ status: USER_STATUS.SUSPENDED });

  await assert.rejects(
    () => authService.login({ email: user.email, password: 'correct-horse-battery-staple' }, { req }),
    (err) => err.code === 'ACCOUNT_INACTIVE'
  );

  await User.collection.deleteMany({ _id: user._id });
});

test('repeated failures lock the account, and the lock expires', async () => {
  const user = await makeUser();

  for (let i = 0; i < 8; i += 1) {
    await authService.login({ email: user.email, password: 'wrong' }, { req }).catch(() => {});
  }

  // Even the CORRECT password is refused while locked.
  await assert.rejects(
    () => authService.login({ email: user.email, password: 'correct-horse-battery-staple' }, { req }),
    (err) => err.code === 'ACCOUNT_LOCKED'
  );

  const locked = await User.findById(user._id).select('+lockedUntil');
  assert.ok(locked.lockedUntil > new Date());

  // Once the window passes, the account works again — a lockout must not be
  // a permanent denial of service against a legitimate officer.
  locked.lockedUntil = new Date(Date.now() - 1000);
  await locked.save();

  const result = await authService.login(
    { email: user.email, password: 'correct-horse-battery-staple' },
    { req }
  );
  assert.ok(result.accessToken, 'sign-in succeeds after the lock expires');

  await User.collection.deleteMany({ _id: user._id });
});

// ---------------------------------------------------------------------------
// Refresh rotation and theft detection
// ---------------------------------------------------------------------------

test('refreshing rotates the token and retires the old one', async () => {
  const user = await makeUser();
  const first = await authService.login(
    { email: user.email, password: 'correct-horse-battery-staple' },
    { req }
  );

  const second = await authService.refresh({ refreshToken: first.refreshToken }, { req });

  assert.ok(second.refreshToken);
  assert.notEqual(second.refreshToken, first.refreshToken, 'a new token must be issued');

  const old = await Session.findOne({ tokenHash: Session.hashToken(first.refreshToken) });
  assert.ok(old.rotatedAt, 'the old token is retired');

  await User.collection.deleteMany({ _id: user._id });
});

test('reusing a rotated refresh token revokes the whole family', async () => {
  const user = await makeUser();
  const first = await authService.login(
    { email: user.email, password: 'correct-horse-battery-staple' },
    { req }
  );
  const second = await authService.refresh({ refreshToken: first.refreshToken }, { req });

  /**
   * Presenting the retired token means it was probably captured and the thief
   * is racing the legitimate client. Both are signed out — a surprise
   * sign-out beats a silent impersonation.
   */
  await assert.rejects(
    () => authService.refresh({ refreshToken: first.refreshToken }, { req }),
    (err) => err.code === 'REFRESH_TOKEN_INVALID'
  );

  await assert.rejects(
    () => authService.refresh({ refreshToken: second.refreshToken }, { req }),
    (err) => err.code === 'REFRESH_TOKEN_INVALID',
    'the legitimate client’s token is revoked too'
  );

  await User.collection.deleteMany({ _id: user._id });
});

test('a suspension taken mid-session ends it at the next refresh', async () => {
  const user = await makeUser();
  const session = await authService.login(
    { email: user.email, password: 'correct-horse-battery-staple' },
    { req }
  );

  await User.updateOne({ _id: user._id }, { $set: { status: USER_STATUS.SUSPENDED } });

  await assert.rejects(
    () => authService.refresh({ refreshToken: session.refreshToken }, { req }),
    (err) => err.code === 'ACCOUNT_INACTIVE'
  );

  const live = await Session.countDocuments({ user: user._id, revokedAt: null });
  assert.equal(live, 0, 'every session is revoked, not just the one presented');

  await User.collection.deleteMany({ _id: user._id });
});

// ---------------------------------------------------------------------------
// Password change and reset
// ---------------------------------------------------------------------------

test('changing a password requires the current one and ends other sessions', async () => {
  const user = await makeUser();
  await authService.login({ email: user.email, password: 'correct-horse-battery-staple' }, { req });
  await authService.login({ email: user.email, password: 'correct-horse-battery-staple' }, { req });

  await assert.rejects(
    () =>
      authService.changePassword(
        user,
        { currentPassword: 'not-the-current-one', newPassword: 'brand-new-passphrase-99' },
        { req }
      ),
    (err) => err.code === 'INVALID_CREDENTIALS',
    'an unattended signed-in session must not be enough to take the account over'
  );

  const result = await authService.changePassword(
    user,
    { currentPassword: 'correct-horse-battery-staple', newPassword: 'brand-new-passphrase-99' },
    { req }
  );

  assert.ok(result.sessionsRevoked >= 2, 'every other device is signed out');

  // The new password works and the old one does not.
  assert.ok(await authService.login({ email: user.email, password: 'brand-new-passphrase-99' }, { req }));
  await assert.rejects(() =>
    authService.login({ email: user.email, password: 'correct-horse-battery-staple' }, { req })
  );

  await User.collection.deleteMany({ _id: user._id });
});

test('a weak new password is rejected with every reason listed', async () => {
  const user = await makeUser();

  const err = await authService
    .changePassword(user, { currentPassword: 'correct-horse-battery-staple', newPassword: 'short' }, { req })
    .catch((e) => e);

  assert.equal(err.statusCode, 422);
  assert.equal(err.code, 'WEAK_PASSWORD');
  assert.ok(Array.isArray(err.details) && err.details.length > 0);

  await User.collection.deleteMany({ _id: user._id });
});

test('forgot-password reveals nothing about which accounts exist', async () => {
  const user = await makeUser();

  const real = await authService.forgotPassword({ email: user.email }, { req });
  const ghost = await authService.forgotPassword({ email: 'nobody@test.invalid' }, { req });

  assert.deepEqual(real, ghost, 'the two responses must be byte-identical');

  await User.collection.deleteMany({ _id: user._id });
});

test('a reset token works once and is then dead', async () => {
  const user = await makeUser();
  await authService.forgotPassword({ email: user.email }, { req });

  // Recreate the token the way the emailed link carries it.
  const token = crypto.randomBytes(32).toString('base64url');
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        resetTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        resetTokenExpiresAt: new Date(Date.now() + 60_000),
      },
    }
  );

  await authService.resetPassword({ token, newPassword: 'a-fresh-new-passphrase' }, { req });
  assert.ok(await authService.login({ email: user.email, password: 'a-fresh-new-passphrase' }, { req }));

  // Replaying the same link must fail — it may have been captured in an inbox.
  await assert.rejects(
    () => authService.resetPassword({ token, newPassword: 'another-passphrase-123' }, { req }),
    (err) => err.code === 'RESET_TOKEN_INVALID'
  );

  await User.collection.deleteMany({ _id: user._id });
});

test('an expired reset token is refused', async () => {
  const user = await makeUser();
  const token = crypto.randomBytes(32).toString('base64url');

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        resetTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        resetTokenExpiresAt: new Date(Date.now() - 1000),
      },
    }
  );

  await assert.rejects(
    () => authService.resetPassword({ token, newPassword: 'a-fresh-new-passphrase' }, { req }),
    (err) => err.code === 'RESET_TOKEN_INVALID'
  );

  await User.collection.deleteMany({ _id: user._id });
});

// ---------------------------------------------------------------------------
// Sign-out
// ---------------------------------------------------------------------------

test('signing out revokes the session and is idempotent', async () => {
  const user = await makeUser();
  const session = await authService.login(
    { email: user.email, password: 'correct-horse-battery-staple' },
    { req }
  );

  await authService.logout({ refreshToken: session.refreshToken }, user, { req });

  const revoked = await Session.findOne({ tokenHash: Session.hashToken(session.refreshToken) });
  assert.ok(revoked.revokedAt);

  // Calling again, and with an unknown token, must still succeed so a client
  // can always clear its own state.
  await authService.logout({ refreshToken: session.refreshToken }, user, { req });
  await authService.logout({ refreshToken: 'never-existed' }, user, { req });

  await assert.rejects(() => authService.refresh({ refreshToken: session.refreshToken }, { req }));

  await User.collection.deleteMany({ _id: user._id });
});

test('credential fields are never serialised', async () => {
  const user = await makeUser();
  const loaded = await User.findById(user._id).select('+passwordHash +resetTokenHash');
  const json = JSON.stringify(loaded.toJSON());

  for (const field of ['passwordHash', 'resetTokenHash', 'argon2', 'failedLoginAttempts', 'lockedUntil']) {
    assert.ok(!json.includes(field), `${field} must not reach a response body`);
  }

  await User.collection.deleteMany({ _id: user._id });
});

// ---------------------------------------------------------------------------
// Temporary credentials
// ---------------------------------------------------------------------------

/**
 * Drives the REAL `authenticate` middleware rather than the guard in
 * isolation. That is deliberate: the bug this covers was not a broken check,
 * it was a correct check nobody had wired into the request path. A unit test
 * of `assertPasswordChanged` would have passed throughout.
 */
function runAuthenticate(request) {
  const { authenticate } = require('../src/middleware/authenticate');
  return new Promise((resolve, reject) => {
    authenticate(request, {}, (err) => (err ? reject(err) : resolve()));
  });
}

function signedRequest(token, method, url) {
  return {
    method,
    url,
    originalUrl: url,
    ip: '198.51.100.7',
    get(header) {
      return String(header).toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined;
    },
  };
}

test('a password the holder did not choose unlocks only the change-password route', async () => {
  const issued = 'issued-by-the-administrator';
  const { apiPrefix } = require('../src/config').app;

  // A SUPER_ADMIN deliberately: the most privileged role in the system must be
  // just as contained as any other while it holds a handover credential.
  const user = await makeUser({
    plaintext: issued,
    role: ROLES.SUPER_ADMIN,
    mustChangePassword: true,
  });

  // Signing in must still succeed, or the holder could never escape the flag.
  const session = await authService.login({ email: user.email, password: issued }, { req });
  assert.equal(session.mustChangePassword, true, 'the client is told a change is due');

  const refused = [
    ['GET', '/fishermen'],
    ['POST', '/users'],
    ['GET', '/dashboard/summary'],
    ['GET', '/audit'],
    ['POST', '/sync/push'],
  ];

  for (const [method, path] of refused) {
    await assert.rejects(
      () => runAuthenticate(signedRequest(session.accessToken, method, apiPrefix + path)),
      (err) => {
        assert.equal(err.statusCode, 403, `${method} ${path} status`);
        assert.equal(err.code, 'PASSWORD_CHANGE_REQUIRED', `${method} ${path} code`);
        return true;
      },
      `${method} ${path} must be refused while the password is temporary`
    );
  }

  // The way out, and the ways to give up and sign out, stay open.
  const permitted = [
    ['POST', '/auth/change-password'],
    ['GET', '/auth/sessions'],
    ['POST', '/auth/logout-all'],
    ['GET', '/users/me'],
  ];

  for (const [method, path] of permitted) {
    await runAuthenticate(signedRequest(session.accessToken, method, apiPrefix + path));
  }

  // Choosing a password clears the flag and opens the rest of the API.
  await authService.changePassword(
    user,
    { currentPassword: issued, newPassword: 'a-passphrase-of-my-own' },
    { req }
  );

  const after = await authService.login(
    { email: user.email, password: 'a-passphrase-of-my-own' },
    { req }
  );
  assert.equal(after.mustChangePassword, false);
  await runAuthenticate(signedRequest(after.accessToken, 'GET', `${apiPrefix}/fishermen`));

  await Session.collection.deleteMany({ user: user._id });
  await User.collection.deleteMany({ _id: user._id });
});

test('every invited officer is flagged, whoever chose the password', async () => {
  // The flag is not a super-admin special case: it is set for every account
  // created through POST /users, including one given an explicit password,
  // because in that case the administrator knows it.
  const source = require('node:fs').readFileSync('src/modules/users/user.service.js', 'utf8');
  const createBlock = source.slice(source.indexOf('const user = await User.create('));

  assert.match(
    createBlock.slice(0, 400),
    /mustChangePassword:\s*true/,
    'User.create in invite() must set mustChangePassword unconditionally'
  );
});
