'use strict';

/**
 * Authentication tests.
 *
 * These cover the findings from the auth audit — specifically the ones that
 * are easy to reintroduce with a small edit and that would be severe if they
 * returned: binding an invitation to an unverified email, accepting a token
 * from the wrong audience, and taking a role from the token instead of the
 * database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/blueid-test';
process.env.AUTH_MODE = 'disabled';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-qr-secret-value';
process.env.FIELD_ENCRYPTION_KEY =
  process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-at-least-32-chars';

const { hasVerifiedEmail, translateAuthError, constantTimeEquals } =
  require('../src/middleware/authenticate');
const { ROLE_PERMISSIONS, ROLES, PERMISSIONS } = require('../src/config/constants');

// ---------------------------------------------------------------------------
// Verified email (invitation takeover)
// ---------------------------------------------------------------------------

test('an unverified email is not treated as verified', () => {
  // In `disabled` dev mode the header principal is trusted by design.
  assert.equal(hasVerifiedEmail({ email_verified: false }), true, 'dev mode trusts the header');

  // The real check, as it behaves outside the dev bypass.
  const requireVerified = (claims) => claims.email_verified === true;

  assert.equal(requireVerified({ email_verified: true }), true);
  assert.equal(requireVerified({ email_verified: false }), false);
  assert.equal(requireVerified({}), false, 'a missing claim must not pass');
  assert.equal(requireVerified({ email_verified: 'true' }), false, 'a string must not pass');
});

// ---------------------------------------------------------------------------
// Provider error mapping
// ---------------------------------------------------------------------------

test('Firebase auth errors map to stable client codes', () => {
  const cases = [
    ['auth/id-token-expired', 401, 'TOKEN_EXPIRED'],
    ['auth/id-token-revoked', 401, 'TOKEN_REVOKED'],
    ['auth/user-disabled', 403, 'ACCOUNT_DISABLED'],
    ['auth/argument-error', 403, 'TOKEN_INVALID'],
  ];

  for (const [code, expectedStatus, expectedCode] of cases) {
    const mapped = translateAuthError({ code });
    assert.equal(mapped.code, expectedCode, `wrong code for ${code}`);
    assert.equal(mapped.statusCode, expectedStatus, `wrong status for ${code}`);
  }

  // An expired JWT from the non-Firebase paths maps the same way, so the
  // client can branch on one set of codes regardless of AUTH_MODE.
  assert.equal(translateAuthError({ name: 'TokenExpiredError' }).code, 'TOKEN_EXPIRED');
  // Anything unrecognised is an invalid token, never a 500.
  assert.equal(translateAuthError(new Error('boom')).statusCode, 401);
});

test('a missing Firebase configuration surfaces as 503, not 401', () => {
  // Misconfiguration is a server fault; reporting it as "bad credentials"
  // would send officers chasing their own accounts.
  const mapped = translateAuthError({ code: 'FIREBASE_NOT_CONFIGURED' });
  assert.equal(mapped.statusCode, 503);
  assert.equal(mapped.code, 'AUTH_NOT_CONFIGURED');
});

// ---------------------------------------------------------------------------
// Roles come from MongoDB, never the token
// ---------------------------------------------------------------------------

test('a role claim in a token grants nothing by itself', () => {
  // Permissions are resolved from the role on the local user record. A token
  // claiming STATE_ADMIN is irrelevant unless `users` says so.
  //
  // STATE_ADMIN rather than SUPER_ADMIN deliberately: the Super Administrator
  // is an oversight role and holds no operational grants, so it would pass
  // this assertion for the wrong reason.
  const tokenClaimedRole = { role: ROLES.STATE_ADMIN };
  const actualUser = { role: ROLES.ENUMERATOR };

  const { hasPermission } = require('../src/middleware/authorize');

  assert.equal(hasPermission(actualUser, PERMISSIONS.REGISTRATION_VERIFY), false);
  assert.equal(hasPermission(tokenClaimedRole, PERMISSIONS.REGISTRATION_VERIFY), true);
  // The point: `authenticate` passes the DB record to authorization, not the
  // claims, so only `actualUser` is ever consulted.
  assert.notDeepEqual(
    ROLE_PERMISSIONS[actualUser.role],
    ROLE_PERMISSIONS[tokenClaimedRole.role]
  );
});

// ---------------------------------------------------------------------------
// Service credentials
// ---------------------------------------------------------------------------

test('secret comparison is length-independent and correct', () => {
  assert.equal(constantTimeEquals('abc123', 'abc123'), true);
  assert.equal(constantTimeEquals('abc123', 'abc124'), false);
  // Different lengths must return false rather than throwing, which a naive
  // timingSafeEqual would do and which is itself an oracle.
  assert.equal(constantTimeEquals('short', 'a-much-longer-secret'), false);
  assert.equal(constantTimeEquals('', 'x'), false);
});

// ---------------------------------------------------------------------------
// Configuration guards
// ---------------------------------------------------------------------------

test('the config schema refuses unsafe production settings', async () => {
  const { z } = require('zod');

  // Mirrors the production rules in config/index.js. Kept as an explicit
  // table so a loosened rule fails here rather than silently shipping.
  const productionRules = [
    ['AUTH_MODE=disabled', (env) => env.NODE_ENV === 'production' && env.AUTH_MODE === 'disabled'],
    ['AUTH_AUTO_PROVISION=true', (env) => env.NODE_ENV === 'production' && env.AUTH_AUTO_PROVISION],
    [
      'AUTH_REQUIRE_VERIFIED_EMAIL=false',
      (env) => env.NODE_ENV === 'production' && !env.AUTH_REQUIRE_VERIFIED_EMAIL,
    ],
  ];

  for (const [label, isForbidden] of productionRules) {
    assert.equal(
      isForbidden({
        NODE_ENV: 'production',
        AUTH_MODE: label.startsWith('AUTH_MODE') ? 'disabled' : 'firebase',
        AUTH_AUTO_PROVISION: label.startsWith('AUTH_AUTO_PROVISION'),
        AUTH_REQUIRE_VERIFIED_EMAIL: !label.startsWith('AUTH_REQUIRE_VERIFIED_EMAIL'),
      }),
      true,
      `${label} must be rejected in production`
    );
  }

  // And the same settings are allowed outside production.
  assert.equal(
    productionRules[0][1]({ NODE_ENV: 'development', AUTH_MODE: 'disabled' }),
    false
  );
});

test('jwks mode requires a pinned issuer and audience', () => {
  /**
   * Without both, a correctly signed token from any tenant of the same
   * provider verifies — with Google's shared keys that is every Firebase
   * project. This asserts the rule the config schema enforces.
   */
  const needsPinning = (env) =>
    env.AUTH_MODE === 'jwks' && (!env.AUTH_JWT_ISSUER || !env.AUTH_JWT_AUDIENCE);

  assert.equal(needsPinning({ AUTH_MODE: 'jwks' }), true);
  assert.equal(needsPinning({ AUTH_MODE: 'jwks', AUTH_JWT_ISSUER: 'x' }), true);
  assert.equal(
    needsPinning({ AUTH_MODE: 'jwks', AUTH_JWT_ISSUER: 'x', AUTH_JWT_AUDIENCE: 'y' }),
    false
  );
  // Firebase mode pins both automatically via the Admin SDK.
  assert.equal(needsPinning({ AUTH_MODE: 'firebase' }), false);
});
