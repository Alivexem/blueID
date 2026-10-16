'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { JwksClient } = require('jwks-rsa');
const config = require('../config');
const logger = require('../config/logger');
const firebase = require('../config/firebase');
const { USER_STATUS, ROLES } = require('../config/constants');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const User = require('../modules/users/user.model');
const { assertPasswordChanged } = require('./requirePasswordChange');

/**
 * Identity boundary.
 *
 * Sign-in, sign-up, password reset and session refresh are owned entirely by
 * Firebase Authentication. This API never issues a token, never sees a
 * password and holds no session — it VERIFIES the ID token it is handed and
 * resolves it to a local user record.
 *
 * ROLES AND SCOPE COME FROM MONGODB, NEVER FROM THE TOKEN.
 *
 * Firebase custom claims would be the obvious place to put a role, and that is
 * precisely the trap: claims are baked into an ID token that stays valid for
 * up to an hour, so an administrator demoted five minutes ago would still
 * present an administrator token. Every request therefore re-reads the role
 * and the LGA scope from `users`, which makes a demotion or a suspension take
 * effect on the very next call.
 *
 * Modes (AUTH_MODE):
 *   firebase  Firebase ID tokens (the deployment default)
 *   jwt       HS256 against a shared secret — internal/service tokens
 *   jwks      RS256 against a remote JWKS, with a pinned issuer and audience
 *   disabled  development only — trusts x-debug-* headers
 */

let jwksClient = null;
if (config.auth.mode === 'jwks') {
  jwksClient = new JwksClient({
    jwksUri: config.auth.jwksUri,
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 10 * 60 * 1000,
    rateLimit: true,
    jwksRequestsPerMinute: 10,
  });
}

function getSigningKey(header, callback) {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

const verifyOptions = () => ({
  ...(config.auth.issuer ? { issuer: config.auth.issuer } : {}),
  ...(config.auth.audience ? { audience: config.auth.audience } : {}),
  clockTolerance: 10, // field devices drift; 10s of slack avoids spurious 401s
});

/**
 * Verifies a bearer token and returns its claims.
 *
 * In `firebase` mode this delegates to the Admin SDK, which pins the audience
 * to the project and checks whether the token has been revoked — neither of
 * which a hand-rolled JWKS verification does by default.
 */
async function verifyToken(token) {
  /**
   * Local mode: the access token is one this service signed. It carries
   * identity only — `sub` (the user id) and `sid` (the session) — never the
   * role, which is re-read from the database on every request.
   */
  if (config.auth.mode === 'local') {
    const claims = jwt.verify(token, config.auth.secret, {
      algorithms: ['HS256'],
      issuer: config.auth.issuer || 'blueid-api',
      ...(config.auth.audience ? { audience: config.auth.audience } : {}),
      clockTolerance: 10,
    });

    if (claims.typ !== 'access') {
      // A refresh token must never be accepted as an access token: it is
      // long-lived, and treating it as one would defeat the whole split.
      const err = new Error('Not an access token');
      err.code = 'WRONG_TOKEN_TYPE';
      throw err;
    }
    return claims;
  }

  if (config.auth.mode === 'firebase') {
    const decoded = await firebase.verifyIdToken(token);
    return {
      ...decoded,
      sub: decoded.uid || decoded.sub,
      uid: decoded.uid,
      email_verified: decoded.email_verified === true,
    };
  }

  return new Promise((resolve, reject) => {
    if (config.auth.mode === 'jwks') {
      jwt.verify(token, getSigningKey, { algorithms: ['RS256'], ...verifyOptions() }, (err, decoded) =>
        err ? reject(err) : resolve(decoded)
      );
      return;
    }
    jwt.verify(token, config.auth.secret, { algorithms: ['HS256'], ...verifyOptions() }, (err, decoded) =>
      err ? reject(err) : resolve(decoded)
    );
  });
}

function extractBearer(req) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

/**
 * Maps provider errors onto stable API codes. Clients — especially the field
 * app, which must decide whether to refresh a token or ask the enumerator to
 * sign in again — branch on `code`, never on the message.
 */
function translateAuthError(err) {
  const firebaseCodes = {
    'auth/id-token-expired': ['Session expired, please sign in again', 'TOKEN_EXPIRED'],
    'auth/id-token-revoked': ['This session has been ended, please sign in again', 'TOKEN_REVOKED'],
    'auth/user-disabled': ['This account has been disabled', 'ACCOUNT_DISABLED'],
    'auth/user-not-found': ['This account no longer exists', 'ACCOUNT_NOT_FOUND'],
    'auth/argument-error': ['Invalid authentication token', 'TOKEN_INVALID'],
  };

  if (err.code && firebaseCodes[err.code]) {
    const [message, code] = firebaseCodes[err.code];
    const status = code === 'TOKEN_EXPIRED' || code === 'TOKEN_REVOKED' ? 401 : 403;
    return new ApiError(status, message, { code });
  }
  if (err.code === 'FIREBASE_NOT_CONFIGURED') {
    return ApiError.unavailable('Authentication is not configured on this server', {
      code: 'AUTH_NOT_CONFIGURED',
    });
  }
  if (err.code === 'WRONG_TOKEN_TYPE') {
    return new ApiError(401, 'Use an access token, not a refresh token', {
      code: 'WRONG_TOKEN_TYPE',
    });
  }
  if (err.name === 'TokenExpiredError') {
    return new ApiError(401, 'Session expired, please sign in again', { code: 'TOKEN_EXPIRED' });
  }
  if (err.name === 'NotBeforeError') {
    return new ApiError(401, 'Token is not yet valid', { code: 'TOKEN_NOT_ACTIVE' });
  }
  return new ApiError(401, 'Invalid authentication token', { code: 'TOKEN_INVALID' });
}

/**
 * Dev-only principal from headers, so the API can be exercised with curl
 * before the client's auth is wired up. Refused in production by the config
 * schema, and again here as a second line of defence.
 */
function debugClaims(req) {
  if (config.isProduction) throw ApiError.unauthorized();
  return {
    [config.auth.uidClaim]: req.get('x-debug-uid') || 'dev-user',
    [config.auth.emailClaim]: req.get('x-debug-email') || 'dev@blueid.local',
    email_verified: true,
    role: req.get('x-debug-role') || ROLES.SUPER_ADMIN,
    name: req.get('x-debug-name') || 'Development User',
  };
}

/** Did the identity provider actually verify this email address? */
function hasVerifiedEmail(claims) {
  if (config.auth.mode === 'disabled') return true;
  if (!config.auth.requireVerifiedEmail) return true;
  return claims.email_verified === true;
}

/**
 * Resolves the verified token to a local user, which carries the role and the
 * geographic scope. The token contributes identity only.
 */
async function resolveUser(claims, req) {
  const authUid = claims[config.auth.uidClaim] || claims.sub || claims.uid;
  if (!authUid) {
    throw new ApiError(401, 'Token is missing a subject claim', { code: 'TOKEN_NO_SUBJECT' });
  }

  /**
   * Local mode: `sub` IS the user id, so there is no provider subject to
   * bind and no auto-provisioning — an account exists only because an
   * administrator created it.
   *
   * The session named by `sid` is checked too, so signing out, a password
   * change or a suspension kills outstanding access tokens at their next use
   * instead of leaving them valid until they expire.
   */
  if (config.auth.mode === 'local') {
    const localUser = await User.findOne({ _id: authUid, isDeleted: { $ne: true } });
    if (!localUser) {
      throw new ApiError(401, 'This account no longer exists', { code: 'ACCOUNT_NOT_FOUND' });
    }

    if (claims.sid) {
      const Session = require('../modules/auth/session.model');
      const session = await Session.findById(claims.sid).select('revokedAt expiresAt user');

      const sessionUsable =
        session &&
        !session.revokedAt &&
        session.expiresAt > new Date() &&
        String(session.user) === String(localUser._id);

      if (!sessionUsable) {
        throw new ApiError(401, 'Your session has ended, please sign in again', {
          code: 'SESSION_REVOKED',
        });
      }
    }

    assertUsable(localUser);
    await touch(localUser, req);
    return localUser;
  }

  const rawEmail = (claims[config.auth.emailClaim] || claims.email || '').toLowerCase() || undefined;
  const emailVerified = hasVerifiedEmail(claims);
  // An unverified address is not an identifier; it is a claim by the holder.
  const email = emailVerified ? rawEmail : undefined;

  let user = await User.findOne({ authUid });

  /**
   * An invited officer is pre-created by email, and the first sign-in binds
   * the provider subject to that invitation.
   *
   * The verified-email requirement is what makes this safe. Without it, anyone
   * able to sign up with an arbitrary unverified address could claim a pending
   * STATE_ADMIN invitation and inherit state-wide access to the register.
   */
  if (!user && rawEmail) {
    const invited = await User.findOne({
      email: rawEmail,
      authUid: { $in: [null, ''] },
      isDeleted: { $ne: true },
    });

    if (invited && !emailVerified) {
      logger.warn(
        { authUid, email: rawEmail, invitedUserId: String(invited._id) },
        'Refused to bind an invitation to an unverified email address'
      );
      throw new ApiError(403, 'Verify your email address before signing in', {
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    if (invited) {
      invited.authUid = authUid;
      if (invited.status === USER_STATUS.PENDING) invited.status = USER_STATUS.ACTIVE;
      user = invited;
      logger.info({ authUid, email: rawEmail }, 'Invitation claimed by a verified email');
    }
  }

  if (!user) {
    if (!config.auth.autoProvision) {
      throw new ApiError(403, 'No Blue ID account is linked to this login', {
        code: 'USER_NOT_PROVISIONED',
      });
    }
    if (!emailVerified) {
      throw new ApiError(403, 'Verify your email address before signing in', {
        code: 'EMAIL_NOT_VERIFIED',
      });
    }
    user = new User({
      authUid,
      email,
      firstName: claims.given_name || claims.name || 'Pending',
      lastName: claims.family_name || 'User',
      // Never taken from the token: a self-asserted role would be escalation.
      // The dev bypass is the sole exception and cannot run in production.
      role: config.auth.mode === 'disabled' ? claims.role : ROLES.ENUMERATOR,
      status: config.auth.mode === 'disabled' ? USER_STATUS.ACTIVE : USER_STATUS.PENDING,
    });
    logger.info({ authUid, email }, 'Auto-provisioned a pending user from a verified token');
  }

  assertUsable(user);
  await touch(user, req);
  return user;
}

/** Refuses an account that exists but must not act. */
function assertUsable(user) {
  if (user.isDeleted) {
    throw new ApiError(403, 'This account has been removed', { code: 'ACCOUNT_REMOVED' });
  }
  if (user.status === USER_STATUS.SUSPENDED || user.status === USER_STATUS.DISABLED) {
    throw new ApiError(403, 'This account has been deactivated', { code: 'ACCOUNT_INACTIVE' });
  }
  if (user.status === USER_STATUS.PENDING) {
    throw new ApiError(403, 'This account is awaiting administrator approval', {
      code: 'ACCOUNT_PENDING',
    });
  }
}

/** Records activity, throttled to one write per 15 minutes per user. */
async function touch(user, req) {
  const stale = !user.lastSeenAt || Date.now() - user.lastSeenAt.getTime() > 15 * 60 * 1000;
  if (stale || user.isModified()) {
    user.lastSeenAt = new Date();
    user.lastDeviceId = req?.get?.('x-device-id') || user.lastDeviceId;
    await user.save();
  }
}

/**
 * Cryptographically identifies the caller WITHOUT a database lookup, so the
 * rate limiter (which runs before the route's own `authenticate`) can key on
 * an account rather than an IP address.
 *
 * It verifies the signature, so `req.principalId` cannot be forged to dodge a
 * limit, and it never throws: an invalid or missing token simply leaves the
 * request anonymous for the limiter to handle by IP, and the real 401 is
 * raised later by `authenticate`.
 */
const attachPrincipal = async (req, res, next) => {
  try {
    if (config.auth.mode === 'disabled') {
      req.principalId = req.get('x-debug-uid') || undefined;
      return next();
    }

    const token = extractBearer(req);
    if (!token) return next();

    const claims = await verifyToken(token);
    const uid = claims[config.auth.uidClaim] || claims.sub || claims.uid;
    if (uid) {
      req.principalId = String(uid);
      // Cache the verified claims so `authenticate` does not verify twice.
      req.verifiedClaims = claims;
    }
  } catch {
    // Anonymous for limiting purposes; `authenticate` produces the 401.
  }
  return next();
};

/** Requires a valid token. */
const authenticate = asyncHandler(async function authenticate(req, res, next) {
  let claims;

  if (config.auth.mode === 'disabled') {
    claims = debugClaims(req);
  } else if (req.verifiedClaims) {
    // Already verified by `attachPrincipal` earlier in the chain.
    claims = req.verifiedClaims;
  } else {
    const token = extractBearer(req);
    if (!token) {
      throw new ApiError(401, 'Missing bearer token', { code: 'TOKEN_MISSING' });
    }
    try {
      claims = await verifyToken(token);
    } catch (err) {
      throw translateAuthError(err);
    }
  }

  req.auth = claims;
  req.user = await resolveUser(claims, req);

  /**
   * A password the holder did not choose grants the right to replace it and
   * nothing else. Enforced here rather than in each router, so a route cannot
   * be mounted around it.
   */
  assertPasswordChanged(req.user, req);

  // Proving a valid token clears the failure counter for this source, so a
  // mistyped session does not penalise the officer who then signs in properly.
  require('./rateLimiter')
    .clearAuthFailures(req)
    .catch(() => {});

  next();
});

/**
 * Attaches a user when a token is present but does not require one. Used by
 * endpoints that behave differently for signed-in staff, never to protect data.
 */
const optionalAuthenticate = asyncHandler(async function optionalAuthenticate(req, res, next) {
  if (config.auth.mode !== 'disabled' && !extractBearer(req)) return next();
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    // The route treats the caller as anonymous, but a rejected token is still
    // worth knowing about — it usually means an expired session, not an attack.
    req.authError = err.code;
    logger.debug({ code: err.code }, 'Optional authentication did not succeed');
  }
  next();
});

/**
 * Machine-to-machine access for trusted government integrations (concept note
 * §12). Grants a READ-ONLY service principal, never a user session: the key is
 * static and shared, so it must not be able to change the register.
 */
const serviceAuth = (req, res, next) => {
  const key = req.get('x-api-key');

  if (!config.auth.serviceApiKey || !key || !constantTimeEquals(key, config.auth.serviceApiKey)) {
    return next(new ApiError(401, 'Invalid service credentials', { code: 'SERVICE_KEY_INVALID' }));
  }

  // Enforced, not merely declared: a future route mounted behind this guard
  // cannot quietly gain write access with a shared key.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next(
      ApiError.forbidden('Service credentials are read-only', {
        code: 'SERVICE_READ_ONLY',
      })
    );
  }

  req.service = { name: req.get('x-service-name') || 'unknown-service', readOnly: true };
  next();
};

/**
 * Compares two secrets without leaking their contents through timing.
 * Both sides are hashed first so the comparison is over fixed-length buffers
 * regardless of input length — `timingSafeEqual` throws on a length mismatch,
 * which would itself be an oracle.
 */
function constantTimeEquals(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

module.exports = {
  authenticate,
  attachPrincipal,
  optionalAuthenticate,
  serviceAuth,
  verifyToken,
  constantTimeEquals,
  hasVerifiedEmail,
  translateAuthError,
};
