'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const users = require('../users/user.repository');
const sessions = require('./session.repository');
const password = require('../../utils/password');
const emailService = require('../../services/email.service');
const auditService = require('../../services/audit.service');
const queue = require('../../services/queue.service');
const config = require('../../config');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');
const { USER_STATUS, AUDIT_ACTIONS } = require('../../config/constants');

/**
 * Local authentication.
 *
 * This service owns the whole credential lifecycle: sign-in, token refresh,
 * sign-out, password change and reset. No identity provider is involved.
 *
 * The token design is deliberately split:
 *
 *   ACCESS TOKEN   short-lived JWT, stateless, sent on every request. Fast to
 *                  verify, but impossible to withdraw before it expires —
 *                  hence the short life.
 *   REFRESH TOKEN  long-lived, opaque, stored hashed in `sessions`. Because
 *                  it is stored, it CAN be withdrawn: suspending an officer,
 *                  changing a password or signing out a device all work by
 *                  revoking rows.
 *
 * The access token carries identity only — never the role. Role and scope are
 * re-read from the database on every request, so a demotion takes effect on
 * the next call rather than whenever the token happens to expire.
 */

const ACCESS_TOKEN_TTL = config.auth.accessTokenTtl;
const REFRESH_TOKEN_TTL_MS = config.auth.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = config.auth.maxFailedLogins;
const LOCKOUT_MS = config.auth.lockoutMinutes * 60 * 1000;
const RESET_TOKEN_TTL_MS = config.auth.resetTokenTtlMinutes * 60 * 1000;

/** Everything a client needs after a successful sign-in. */
function issueAccessToken(user, sessionId) {
  return jwt.sign(
    { sub: String(user._id), sid: sessionId, typ: 'access' },
    config.auth.secret,
    {
      expiresIn: ACCESS_TOKEN_TTL,
      issuer: config.auth.issuer || 'blueid-api',
      ...(config.auth.audience ? { audience: config.auth.audience } : {}),
    }
  );
}

/** Creates a session row and returns the plaintext refresh token once. */
async function createSession(user, { family, req } = {}) {
  const token = crypto.randomBytes(48).toString('base64url');

  const session = await sessions.create({
    user: user.id,
    tokenHash: sessions.hashToken(token),
    family: family || crypto.randomUUID(),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    ipAddress: req?.ip,
    userAgent: req?.get?.('user-agent'),
    deviceCode: req?.get?.('x-device-id'),
  });

  return { token, session };
}

/**
 * The response shape for login and refresh.
 * `mustChangePassword` tells the client to route straight to a change screen.
 */
function authPayload(user, accessToken, refreshToken, session) {
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL,
    refreshExpiresAt: session.expiresAt,
    mustChangePassword: Boolean(user.mustChangePassword),
    user: {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
      role: user.role,
      status: user.status,
      scope: user.scope,
    },
  };
}

/**
 * Signs an officer in.
 *
 * Every failure returns the SAME generic error, whatever the cause — unknown
 * email, wrong password, suspended account. Distinguishing them would turn
 * this endpoint into an account-enumeration oracle, telling an attacker which
 * government addresses are registered. The specific reason goes to the log
 * and the audit trail, where an administrator can see it.
 */
async function login({ email, password: plaintext }, options = {}) {
  const { req } = options;
  const genericFailure = () =>
    new ApiError(401, 'Email address or password is incorrect', {
      code: 'INVALID_CREDENTIALS',
    });

  const normalisedEmail = String(email || '').trim().toLowerCase();

  const user = await users.findForAuthentication(normalisedEmail);

  if (!user) {
    // Spend comparable time, so a missing account is not detectable by how
    // quickly the request comes back.
    await password.verify(null, plaintext);
    logger.warn({ email: normalisedEmail, ip: req?.ip }, 'Sign-in attempt for an unknown address');
    throw genericFailure();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordFailure(user, 'account locked', req);
    throw new ApiError(423, 'This account is temporarily locked after repeated failed sign-ins', {
      code: 'ACCOUNT_LOCKED',
      details: { until: user.lockedUntil },
    });
  }

  const correct = await password.verify(user.passwordHash, plaintext);

  if (!correct) {
    await recordFailure(user, 'wrong password', req);
    throw genericFailure();
  }

  // Status is checked AFTER the password, so a wrong password on a suspended
  // account still reads as a wrong password rather than confirming the
  // account exists.
  if (user.status === USER_STATUS.SUSPENDED || user.status === USER_STATUS.DISABLED) {
    await recordFailure(user, `status ${user.status}`, req);
    throw new ApiError(403, 'This account has been deactivated', { code: 'ACCOUNT_INACTIVE' });
  }
  if (user.status === USER_STATUS.PENDING) {
    throw new ApiError(403, 'This account is awaiting administrator approval', {
      code: 'ACCOUNT_PENDING',
    });
  }

  // Transparently upgrade a hash made with weaker parameters.
  if (password.needsRehash(user.passwordHash)) {
    await users.update(user.id, { passwordHash: await password.hash(plaintext) });
  }

  await users.registerLoginSuccess(user.id, { ip: req?.ip });

  const { token: refreshToken, session } = await createSession(user, { req });
  const accessToken = issueAccessToken(user, String(session.id));

  await auditService.record({
    action: AUDIT_ACTIONS.LOGIN,
    entity: { type: 'User', id: user.id, label: user.fullName },
    metadata: { sessionId: String(session.id) },
    req: { ...req, user },
  });

  return authPayload(user, accessToken, refreshToken, session);
}

/** Counts a failed attempt and locks the account once the threshold is hit. */
async function recordFailure(user, reason, req) {
  /**
   * One UPDATE, not read-modify-write.
   *
   * The previous version read the count, incremented it in JavaScript and
   * saved, so two simultaneous attempts both read the same number and both
   * wrote the same successor — an attacker running requests in parallel got
   * roughly twice the attempts the lockout was meant to allow.
   */
  const state = await users.registerLoginFailure(user.id, {
    threshold: MAX_FAILED_ATTEMPTS,
    lockMinutes: Math.round(LOCKOUT_MS / 60000),
  });

  if (state?.lockedUntil) {
    logger.warn(
      { userId: String(user.id), ip: req?.ip, until: state.lockedUntil },
      'Account locked after repeated failed sign-ins'
    );
  }

  // The real reason is written here, not returned: the caller gets one
  // generic failure whatever went wrong, so the endpoint cannot be used to
  // discover which addresses are registered.
  await auditService.recordFailure({
    action: AUDIT_ACTIONS.LOGIN,
    entity: { type: 'User', id: user.id, label: user.fullName },
    reason,
    req,
  });
}

/**
 * Exchanges a refresh token for a new pair, rotating the old one away.
 *
 * Presenting a token that has already been rotated means something is wrong —
 * most likely it was captured and the thief is racing the legitimate client.
 * The entire session family is revoked, which signs both parties out. A
 * surprise sign-out is a far better outcome than a silent impersonation.
 */
async function refresh({ refreshToken }, options = {}) {
  const { req } = options;
  const invalid = () =>
    new ApiError(401, 'Your session has ended, please sign in again', {
      code: 'REFRESH_TOKEN_INVALID',
    });

  if (!refreshToken) throw invalid();

  const session = await sessions.findByToken(refreshToken);
  if (!session) throw invalid();

  if (session.rotatedAt) {
    await sessions.revokeFamily(session.family, 'refresh token reused — possible theft');
    logger.error(
      { userId: String(session.user), family: session.family, ip: req?.ip },
      'Refresh token reuse detected — the whole session family has been revoked'
    );
    await auditService.recordFailure({
      action: AUDIT_ACTIONS.LOGIN,
      entity: { type: 'User', id: session.user },
      reason: 'refresh token reuse',
      req,
    });
    throw invalid();
  }

  if (session.revokedAt || session.expiresAt <= new Date()) throw invalid();

  const user = await users.findById(session.user);
  if (!user) throw invalid();

  // A suspension taken while the session was alive ends it here too.
  if (user.status !== USER_STATUS.ACTIVE) {
    await sessions.revokeAllForUser(user.id, `status ${user.status}`);
    throw new ApiError(403, 'This account is no longer active', { code: 'ACCOUNT_INACTIVE' });
  }

  const { token: newToken, session: newSession } = await createSession(user, {
    family: session.family,
    req,
  });

  /**
   * Retire the presented token, conditionally on it still being live.
   *
   * If this does not match, another refresh rotated it between the check
   * above and here — which is the reuse case, not a double success. The
   * new session is revoked so the race does not leave a stray credential.
   */
  const rotated = await sessions.rotate(session.id, { nextTokenHash: newSession.tokenHash });
  if (!rotated) {
    await sessions.revoke(newSession.id, 'lost a concurrent refresh');
    await sessions.revokeFamily(session.family, 'concurrent refresh — possible theft');
    throw invalid();
  }

  const accessToken = issueAccessToken(user, String(newSession.id));
  return authPayload(user, accessToken, newToken, newSession);
}

/** Ends the current session. Idempotent: an unknown token still succeeds. */
async function logout({ refreshToken }, actor, options = {}) {
  const { req } = options;

  if (refreshToken) {
    await sessions.revokeByToken(refreshToken, 'signed out');
  }

  if (actor) {
    await auditService.record({
      action: AUDIT_ACTIONS.LOGIN,
      entity: { type: 'User', id: actor._id, label: actor.fullName },
      metadata: { event: 'logout' },
      req,
    });
  }

  return { ok: true };
}

/** Signs the account out of every device. */
async function logoutAll(actor, options = {}) {
  const { req } = options;
  const result = await sessions.revokeAllForUser(actor.id, 'signed out everywhere');

  await auditService.record({
    action: AUDIT_ACTIONS.LOGIN,
    entity: { type: 'User', id: actor._id, label: actor.fullName },
    metadata: { event: 'logout-all', sessionsRevoked: result.modifiedCount },
    req,
  });

  return { sessionsRevoked: result.modifiedCount };
}

/** The caller's own active sessions, so they can spot one they don't know. */
async function listSessions(actor) {
  return sessions.listLiveForUser(actor.id)
    .sort({ lastUsedAt: -1 })
    .select('ipAddress userAgent deviceCode createdAt lastUsedAt expiresAt')
    .lean();
}

/**
 * Changes the caller's own password.
 *
 * Requires the current password even though the caller is authenticated: an
 * unattended logged-in session should not be enough to take over the account
 * permanently. Every other session is signed out afterwards, because a
 * password change is the usual response to suspecting one is compromised.
 */
async function changePassword(actor, { currentPassword, newPassword }, options = {}) {
  const { req } = options;

  const user = await users.findById(actor.id, { withCredentials: true });
  if (!user) throw ApiError.notFound('Account not found');

  const correct = await password.verify(user.passwordHash, currentPassword);
  if (!correct) {
    await auditService.recordFailure({
      action: AUDIT_ACTIONS.UPDATE,
      entity: { type: 'User', id: user._id },
      reason: 'wrong current password',
      req,
    });
    throw new ApiError(401, 'Your current password is incorrect', { code: 'INVALID_CREDENTIALS' });
  }

  assertPasswordAcceptable(newPassword, user);

  if (await password.verify(user.passwordHash, newPassword)) {
    throw ApiError.badRequest('Choose a password you have not used here before', {
      code: 'PASSWORD_UNCHANGED',
    });
  }

  await users.update(user.id, {
    passwordHash: await password.hash(newPassword),
    passwordChangedAt: new Date(),
    mustChangePassword: false,
  });

  const revoked = await sessions.revokeAllForUser(user.id, 'password changed');

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: { type: 'User', id: user.id, label: user.fullName },
    metadata: { event: 'password-changed', sessionsRevoked: revoked.modifiedCount },
    req,
  });

  return { ok: true, sessionsRevoked: revoked.modifiedCount };
}

/**
 * Starts a password reset.
 *
 * ALWAYS reports success, even for an address with no account. Saying "no
 * such user" would let anyone test which government addresses are registered.
 */
async function forgotPassword({ email }, options = {}) {
  const { req } = options;
  const normalisedEmail = String(email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'If that address has an account, a reset link has been sent' };

  const user = await users.findByEmail(normalisedEmail);
  if (!user || user.status === USER_STATUS.DISABLED) {
    logger.info({ email: normalisedEmail }, 'Password reset requested for an unknown or disabled address');
    return generic;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await users.update(user.id, {
    resetTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  });

  const resetUrl = `${config.app.portalUrl}/reset-password?token=${token}`;

  await queue.enqueueSafe(
    queue.JOB_TYPES.EMAIL_SEND,
    {
      to: user.email,
      subject: `${config.app.name} — reset your password`,
      text: `Open this link to choose a new password. It expires in ${config.auth.resetTokenTtlMinutes} minutes and can be used once.\n\n${resetUrl}`,
      html: emailService.layout({
        title: 'Reset your password',
        body: `<p>Hello ${user.firstName},</p>
               <p>Open the link below to choose a new password. It expires in
               <strong>${config.auth.resetTokenTtlMinutes} minutes</strong> and can be used once.</p>
               <p style="margin:20px 0;"><a href="${resetUrl}" style="background:#0B4F6C;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600;">Choose a new password</a></p>
               <p style="font-size:13px;color:#5b6b75;">If you did not request this, you can ignore it — your password has not changed.</p>`,
      }),
      tags: ['password-reset'],
    },
    { dedupeKey: `reset:${user._id}:${Math.floor(Date.now() / 60000)}`, req }
  );

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: { type: 'User', id: user.id, label: user.fullName },
    metadata: { event: 'password-reset-requested' },
    req,
  });

  return generic;
}

/**
 * Completes a reset. The token is single-use: it is cleared on success, so a
 * link captured from an inbox cannot be replayed.
 */
async function resetPassword({ token, newPassword }, options = {}) {
  const { req } = options;

  const tokenHash = crypto.createHash('sha256').update(String(token || '')).digest('hex');

  const user = await users.findByResetToken(tokenHash);

  // The expiry is checked here rather than in the lookup so a stale token
  // and an unknown token give the same answer — a reset link that has
  // expired should not confirm that it was ever real.
  const expired = !user?.resetTokenExpiresAt || new Date(user.resetTokenExpiresAt) <= new Date();

  if (!user || expired) {
    throw new ApiError(400, 'That reset link is invalid or has expired', {
      code: 'RESET_TOKEN_INVALID',
    });
  }

  assertPasswordAcceptable(newPassword, user);

  await users.update(user.id, {
    passwordHash: await password.hash(newPassword),
    passwordChangedAt: new Date(),
    mustChangePassword: false,
    // Single use: clearing the token is what stops a link captured from an
    // inbox being replayed.
    resetTokenHash: null,
    resetTokenExpiresAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    // Completing a reset proves control of the address, which is what a
    // pending invitation was waiting for.
    ...(user.status === USER_STATUS.PENDING ? { status: USER_STATUS.ACTIVE } : {}),
  });

  const revoked = await sessions.revokeAllForUser(user.id, 'password reset');

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: { type: 'User', id: user.id, label: user.fullName },
    metadata: { event: 'password-reset-completed', sessionsRevoked: revoked.modifiedCount },
    req,
  });

  return { ok: true };
}

/** Shared policy check, raising a 422 with every problem at once. */
function assertPasswordAcceptable(candidate, user) {
  const { valid, problems } = password.validate(candidate, {
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
  });

  if (!valid) {
    throw ApiError.unprocessable('That password is not acceptable', {
      code: 'WEAK_PASSWORD',
      details: problems.map((message) => ({ field: 'newPassword', message })),
    });
  }
}

/** Administrative reset: issues a temporary password, shown once. */
async function adminResetPassword(userId, actor, options = {}) {
  const { req } = options;

  const user = await users.findById(userId);
  if (!user) throw ApiError.notFound('Account not found');

  const temporary = password.generateTemporary();
  await users.update(user.id, {
    passwordHash: await password.hash(temporary),
    passwordChangedAt: new Date(),
    mustChangePassword: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
  });

  const revoked = await sessions.revokeAllForUser(user.id, 'administrative password reset');

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: { type: 'User', id: user.id, label: user.fullName },
    metadata: { event: 'admin-password-reset', sessionsRevoked: revoked.modifiedCount },
    req,
  });

  return { temporaryPassword: temporary, mustChangePassword: true };
}

module.exports = {
  login,
  refresh,
  logout,
  logoutAll,
  listSessions,
  changePassword,
  forgotPassword,
  resetPassword,
  adminResetPassword,
  issueAccessToken,
  createSession,
  assertPasswordAcceptable,
  ACCESS_TOKEN_TTL,
};
