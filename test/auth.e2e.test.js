'use strict';

/**
 * Authentication, end to end over HTTP, in the mode production runs.
 *
 * The existing auth tests exercise the service layer. This one drives a real
 * server with real requests, because the parts most likely to be wrong in
 * production are the ones between the service and the wire: whether the
 * middleware is actually mounted, whether a guard is reachable, whether a
 * token minted by login is accepted by the next request.
 *
 * AUTH_MODE is forced to `local` here. The default development environment
 * runs `disabled`, which trusts x-debug headers — so without this the real
 * sign-in path would never be executed by any test, and the first time
 * anyone tried it would be in production.
 *
 * Synthetic accounts and throwaway secrets only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

process.env.AUTH_MODE = 'local';
process.env.AUTH_JWT_SECRET = 'e2e-only-signing-secret-at-least-32-chars-long';

const database = require('../src/config/database');
const User = require('../src/modules/users/user.model');
const Session = require('../src/modules/auth/session.model');
const passwordUtil = require('../src/utils/password');
const { ROLES, USER_STATUS } = require('../src/config/constants');

const PREFIX = '/api/v1';
let server;
let origin;
let account;
const PASSWORD = 'a-correct-horse-battery-staple-99';

test.before(async () => {
  await database.connect();

  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  account = await User.create({
    email: `e2e-${crypto.randomBytes(4).toString('hex')}@auth.test.invalid`,
    firstName: 'Ada',
    lastName: 'Operator',
    role: ROLES.STATE_ADMIN,
    status: USER_STATUS.ACTIVE,
    scope: { lgas: ['BAK'], communities: [] },
    passwordHash: await passwordUtil.hash(PASSWORD),
    passwordChangedAt: new Date(),
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (account) {
    await Session.collection.deleteMany({ user: account._id });
    await User.collection.deleteMany({ _id: account._id });
  }
  await database.disconnect();
});

async function call(method, path, { body, token } = {}) {
  const response = await fetch(`${origin}${PREFIX}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, body: payload };
}

const login = (email, password) => call('POST', '/auth/login', { body: { email, password } });

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('signing in returns a usable token pair', async () => {
  const { status, body } = await login(account.email, PASSWORD);

  assert.equal(status, 200, JSON.stringify(body));
  const data = body.data || body;

  assert.ok(data.accessToken, 'an access token');
  assert.ok(data.refreshToken, 'a refresh token');
  assert.equal(data.tokenType, 'Bearer');
  assert.equal(data.mustChangePassword, false);

  // The two must be different kinds of thing — a refresh token that works
  // as an access token would make the short access lifetime pointless.
  assert.notEqual(data.accessToken, data.refreshToken);

  // No credential material in the response.
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes(PASSWORD), 'the password must not be echoed');
  assert.ok(!/passwordHash|resetTokenHash/.test(serialised), 'no hashes in the body');
});

test('the token actually opens an authenticated endpoint', async () => {
  const { body } = await login(account.email, PASSWORD);
  const token = (body.data || body).accessToken;

  const me = await call('GET', '/users/me', { token });
  assert.equal(me.status, 200, JSON.stringify(me.body));

  const profile = me.body.data || me.body;
  assert.equal(profile.email, account.email);
  assert.equal(profile.role, ROLES.STATE_ADMIN);
  assert.equal(profile.passwordHash, undefined, 'the hash must never reach a response');
});

test('no token, a junk token and a refresh token are all refused', async () => {
  const { body } = await login(account.email, PASSWORD);
  const { refreshToken } = body.data || body;

  const none = await call('GET', '/users/me');
  assert.equal(none.status, 401);
  assert.equal((none.body.error || {}).code, 'TOKEN_MISSING');

  const junk = await call('GET', '/users/me', { token: 'not-a-real-token' });
  assert.equal(junk.status, 401);
  assert.equal((junk.body.error || {}).code, 'TOKEN_INVALID');

  // A refresh token is long-lived; accepting it as an access token would
  // defeat the whole split.
  const wrongKind = await call('GET', '/users/me', { token: refreshToken });
  assert.equal(wrongKind.status, 401);
  assert.ok(['WRONG_TOKEN_TYPE', 'TOKEN_INVALID'].includes((wrongKind.body.error || {}).code));
});

// ---------------------------------------------------------------------------
// Failure is indistinguishable
// ---------------------------------------------------------------------------

test('a wrong password and an unknown address answer identically', async () => {
  const wrong = await login(account.email, 'definitely-not-the-password');
  const unknown = await login('nobody-here@auth.test.invalid', 'definitely-not-the-password');

  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);

  // Same code and same message, or the endpoint tells an attacker which
  // government addresses are registered.
  assert.equal(wrong.body.error.code, unknown.body.error.code);
  assert.equal(wrong.body.error.message, unknown.body.error.message);
  assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test('refreshing issues a new pair and retires the old refresh token', async () => {
  const first = (await login(account.email, PASSWORD)).body.data;

  const refreshed = await call('POST', '/auth/refresh', {
    body: { refreshToken: first.refreshToken },
  });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));

  const second = refreshed.body.data || refreshed.body;
  assert.ok(second.accessToken && second.refreshToken);
  assert.notEqual(second.refreshToken, first.refreshToken, 'the token rotated');

  // The new access token works.
  const me = await call('GET', '/users/me', { token: second.accessToken });
  assert.equal(me.status, 200);
});

test('reusing a spent refresh token signs the whole family out', async () => {
  const first = (await login(account.email, PASSWORD)).body.data;
  const second = (
    await call('POST', '/auth/refresh', { body: { refreshToken: first.refreshToken } })
  ).body.data;

  // Presenting the retired token means a copy is in circulation. There is no
  // way to tell which holder is legitimate, so both are signed out — a
  // surprise sign-out beats a silent impersonation.
  const replay = await call('POST', '/auth/refresh', {
    body: { refreshToken: first.refreshToken },
  });
  assert.equal(replay.status, 401);

  const afterwards = await call('POST', '/auth/refresh', {
    body: { refreshToken: second.refreshToken },
  });
  assert.equal(afterwards.status, 401, 'the legitimate token is revoked too');
});

// ---------------------------------------------------------------------------
// Sign-out
// ---------------------------------------------------------------------------

test('signing out kills the access token at its next use', async () => {
  const session = (await login(account.email, PASSWORD)).body.data;

  assert.equal((await call('GET', '/users/me', { token: session.accessToken })).status, 200);

  await call('POST', '/auth/logout', { body: { refreshToken: session.refreshToken } });

  // The access token is still cryptographically valid and unexpired. It is
  // refused because the session it names is revoked, which is the point of
  // carrying a session id in the token at all.
  const after = await call('GET', '/users/me', { token: session.accessToken });
  assert.equal(after.status, 401);
  assert.equal(after.body.error.code, 'SESSION_REVOKED');
});

// ---------------------------------------------------------------------------
// Password change
// ---------------------------------------------------------------------------

test('changing a password requires the current one and ends every session', async () => {
  const a = (await login(account.email, PASSWORD)).body.data;
  const b = (await login(account.email, PASSWORD)).body.data;
  const NEW_PASSWORD = 'a-different-correct-horse-77';

  const wrongCurrent = await call('POST', '/auth/change-password', {
    token: a.accessToken,
    body: { currentPassword: 'not-it', newPassword: NEW_PASSWORD },
  });
  assert.equal(wrongCurrent.status, 401, 'knowing the session is not enough');

  const changed = await call('POST', '/auth/change-password', {
    token: a.accessToken,
    body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  // Every session ends, including the other device's.
  assert.equal((await call('GET', '/users/me', { token: b.accessToken })).status, 401);

  assert.equal((await login(account.email, PASSWORD)).status, 401, 'old password dead');
  assert.equal((await login(account.email, NEW_PASSWORD)).status, 200, 'new password works');

  // Put it back for the tests that follow.
  const fresh = (await login(account.email, NEW_PASSWORD)).body.data;
  await call('POST', '/auth/change-password', {
    token: fresh.accessToken,
    body: { currentPassword: NEW_PASSWORD, newPassword: PASSWORD },
  });
});

// ---------------------------------------------------------------------------
// A temporary password is contained
// ---------------------------------------------------------------------------

test('an account on a temporary password can change it and nothing else', async () => {
  const temporary = 'issued-by-an-administrator-42';
  const holder = await User.create({
    email: `temp-${crypto.randomBytes(4).toString('hex')}@auth.test.invalid`,
    firstName: 'Temp',
    lastName: 'Holder',
    role: ROLES.STATE_ADMIN,
    status: USER_STATUS.ACTIVE,
    passwordHash: await passwordUtil.hash(temporary),
    passwordChangedAt: new Date(),
    mustChangePassword: true,
  });

  const session = (await login(holder.email, temporary)).body.data;
  assert.equal(session.mustChangePassword, true, 'the client is told');

  // Refused everywhere a normal session would work, including routes this
  // STATE_ADMIN would otherwise be entitled to.
  for (const path of ['/fishermen', '/users', '/dashboard/summary']) {
    const blocked = await call('GET', path, { token: session.accessToken });
    assert.equal(blocked.status, 403, `${path} must be refused`);
    assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  }

  // The way out stays open.
  assert.equal((await call('GET', '/users/me', { token: session.accessToken })).status, 200);

  const changed = await call('POST', '/auth/change-password', {
    token: session.accessToken,
    body: { currentPassword: temporary, newPassword: 'now-a-password-i-chose-11' },
  });
  assert.equal(changed.status, 200);

  // And afterwards the account is ordinary.
  const after = (await login(holder.email, 'now-a-password-i-chose-11')).body.data;
  assert.equal(after.mustChangePassword, false);
  assert.equal((await call('GET', '/dashboard/summary', { token: after.accessToken })).status, 200);

  await Session.collection.deleteMany({ user: holder._id });
  await User.collection.deleteMany({ _id: holder._id });
});

// ---------------------------------------------------------------------------
// A deactivated account loses access immediately
// ---------------------------------------------------------------------------

test('suspending an account ends its live sessions at the next request', async () => {
  const victim = await User.create({
    email: `susp-${crypto.randomBytes(4).toString('hex')}@auth.test.invalid`,
    firstName: 'Soon',
    lastName: 'Suspended',
    role: ROLES.ENUMERATOR,
    status: USER_STATUS.ACTIVE,
    passwordHash: await passwordUtil.hash(PASSWORD),
    passwordChangedAt: new Date(),
  });

  const session = (await login(victim.email, PASSWORD)).body.data;
  assert.equal((await call('GET', '/users/me', { token: session.accessToken })).status, 200);

  // Suspended directly, as an administrator endpoint would. The status is
  // re-read on every request, so the still-valid token stops working now
  // rather than when it expires.
  await User.updateOne({ _id: victim._id }, { $set: { status: USER_STATUS.SUSPENDED } });

  const after = await call('GET', '/users/me', { token: session.accessToken });
  assert.equal(after.status, 403);
  assert.equal(after.body.error.code, 'ACCOUNT_INACTIVE');

  /**
   * Signing in with the CORRECT password on a suspended account answers
   * 403 ACCOUNT_INACTIVE, not the generic 401.
   *
   * That is a deliberate trade. A suspended officer needs to know why they
   * cannot get in, or they conclude they have forgotten the password and
   * the support queue fills with resets that will not help. The cost is
   * that someone holding a correct password learns it is still correct —
   * acceptable, because the account is suspended and they still cannot act.
   * A WRONG password on the same account is indistinguishable from any
   * other failure, which is the case that would leak account existence.
   */
  const blocked = await login(victim.email, PASSWORD);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'ACCOUNT_INACTIVE');

  const wrongOnSuspended = await login(victim.email, 'not-the-password');
  assert.equal(wrongOnSuspended.status, 401, 'a wrong password still reads as a wrong password');
  assert.equal(wrongOnSuspended.body.error.code, 'INVALID_CREDENTIALS');

  await Session.collection.deleteMany({ user: victim._id });
  await User.collection.deleteMany({ _id: victim._id });
});

// ---------------------------------------------------------------------------
// Password recovery reveals nothing
// ---------------------------------------------------------------------------

test('forgot-password answers the same for a real and an unknown address', async () => {
  const real = await call('POST', '/auth/forgot-password', { body: { email: account.email } });
  const fake = await call('POST', '/auth/forgot-password', {
    body: { email: 'no-such-person@auth.test.invalid' },
  });

  assert.equal(real.status, fake.status);
  assert.deepEqual(
    real.body.message ?? real.body.data,
    fake.body.message ?? fake.body.data,
    'the two answers must be identical'
  );
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test('guessing one account does not lock out a colleague at the same office', async () => {
  /**
   * The failure this guards against is operational, not an attack.
   *
   * An LGA office is behind one NAT. Keyed on the IP alone, five officers
   * arriving at eight o'clock with a couple of mistyped passwords between
   * them would lock out the whole building — reported, correctly, as the
   * system being down.
   *
   * So the tight limit is per address-from-this-IP. Exhausting it for one
   * account must leave every other account at that office working.
   */
  const victim = `hammered-${crypto.randomBytes(4).toString('hex')}@auth.test.invalid`;
  const limit = Number(process.env.AUTH_LOGIN_ATTEMPTS_PER_ACCOUNT);

  let sawLimit = false;
  for (let i = 0; i < limit + 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { status } = await login(victim, 'wrong-password-every-time');
    if (status === 429) {
      sawLimit = true;
      break;
    }
  }
  assert.ok(sawLimit, 'repeated attempts on one account are rate limited');

  // The colleague, from the same IP, signs in normally.
  const colleague = await login(account.email, PASSWORD);
  assert.equal(colleague.status, 200, 'another account at the same office is unaffected');
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

test('the documented bootstrap command produces an account that can sign in', async () => {
  /**
   * This is step one of every deployment, and nothing else tests it.
   *
   * `npm run create:admin` is run once on a new server to create the first
   * Super Administrator — the account that creates every other account. If
   * it produced something that could not sign in, the discovery would be on
   * a production box with no way in at all.
   *
   * Run as a real subprocess, against the same database, so what is tested
   * is the command as the runbook gives it.
   */
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const run = promisify(execFile);

  const email = `bootstrap-${crypto.randomBytes(4).toString('hex')}@auth.test.invalid`;

  const { stdout } = await run(
    process.execPath,
    ['src/scripts/createAdmin.js', `--email=${email}`, '--first=Boot', '--last=Strap', '--role=SUPER_ADMIN'],
    { cwd: process.cwd(), env: { ...process.env } }
  );

  // The generated password is printed once to stdout, deliberately not to
  // the log, so a log shipper does not carry it off the machine.
  const match = /Password:\s*(\S+)/.exec(stdout);
  assert.ok(match, `the command must print the password once:\n${stdout}`);
  const temporaryPassword = match[1];

  const signedIn = await login(email, temporaryPassword);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));

  const session = signedIn.body.data;
  assert.equal(session.user.role, ROLES.SUPER_ADMIN);
  assert.equal(session.mustChangePassword, true, 'a generated password must be replaced');

  // And it is contained until replaced — the whole point of the flag.
  const blocked = await call('GET', '/users', { token: session.accessToken });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

  // Choosing a password opens the account up.
  const chosen = 'the-first-real-administrator-pw-8';
  const changed = await call('POST', '/auth/change-password', {
    token: session.accessToken,
    body: { currentPassword: temporaryPassword, newPassword: chosen },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  const after = (await login(email, chosen)).body.data;
  assert.equal(after.mustChangePassword, false);
  const users = await call('GET', '/users', { token: after.accessToken });
  assert.equal(users.status, 200, 'the Super Administrator can now manage accounts');

  await Session.collection.deleteMany({ user: after.user.id });
  await User.collection.deleteMany({ email });
});
