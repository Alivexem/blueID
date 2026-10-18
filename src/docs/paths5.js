'use strict';

const { R, okJson, idParam, ref, needs } = require('./paths');

const authResponse = {
  type: 'object',
  properties: {
    accessToken: { type: 'string', description: 'Short-lived JWT. Send as `Authorization: Bearer <token>`.' },
    refreshToken: { type: 'string', description: 'Opaque, long-lived. Store securely; it is rotated on every use.' },
    tokenType: { type: 'string', enum: ['Bearer'] },
    expiresIn: { type: 'string', example: '15m', description: 'Access-token lifetime.' },
    refreshExpiresAt: { type: 'string', format: 'date-time' },
    mustChangePassword: {
      type: 'boolean',
      description:
        'True when this account is using a password it was issued rather than one it chose. ' +
        'The restriction is enforced by the server, not by the client: while it is true, every ' +
        'endpoint except `POST /auth/change-password`, `POST /auth/logout`, `POST /auth/logout-all`, ' +
        '`GET /auth/sessions` and `GET /users/me` returns `403 PASSWORD_CHANGE_REQUIRED`, whatever ' +
        'the role. Route straight to a change-password screen.',
    },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'objectid' },
        email: { type: 'string', format: 'email' },
        fullName: { type: 'string' },
        role: { type: 'string' },
        status: { type: 'string' },
        scope: { type: 'object' },
      },
    },
  },
};

module.exports = {
  '/api/v1/auth/login': {
    post: {
      tags: ['Authentication'],
      summary: 'Sign in',
      security: [],
      description:
        'Exchanges sign-in details for an access token and a refresh token.\n\n' + '**Send either `userId` or `email`.** The portal\'s administration section asks for "User ID" and Password, because that is what an officer is handed; accounts created by invitation are identified by their email address. Both work on this endpoint. The `userId` lookup is case-insensitive.\n\n' +
        '**A wrong password and an unknown address answer identically** — same status, same code, same message. Distinguishing them would turn this endpoint into an account-enumeration oracle, telling an attacker which government addresses are registered. The real reason is written to the audit trail, where an administrator can see it.\n\n' + 'The one exception is a **correct** password on a deactivated account, which answers `403 ACCOUNT_INACTIVE` rather than the generic failure. A suspended officer needs to know why they cannot sign in, or they conclude they have forgotten their password and the reset will not help them. A wrong password on that same account is still indistinguishable from any other failure.\n\n' +
        '**Lockout and rate limits, in three layers.** Eight consecutive failures hold that *account* shut for 15 minutes and return `423 ACCOUNT_LOCKED`, wherever the attempts come from. On top of that, this endpoint allows 10 attempts per *account from one IP* per 15 minutes, under a ceiling of 60 attempts from that IP across all accounts — two tiers, because an LGA office is behind one NAT and a single key would either lock out the whole building or let an attacker rotate accounts freely. Exceeding either returns `429`.\n\n' +
        '**Temporary credentials.** If `mustChangePassword` is true the sign-in succeeded, but the token it returned is good for only five routes — changing the password, listing and ending sessions, and reading your own profile. Everything else answers `403 PASSWORD_CHANGE_REQUIRED` until a password is chosen. This applies to every role, SUPER_ADMIN included.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['password'],
              description: 'Exactly one of `userId` or `email` is required.',
              properties: {
                userId: {
                  type: 'string',
                  description: 'The staff identifier the portal labels "User ID". Case-insensitive.',
                  example: 'superadmin',
                },
                email: { type: 'string', format: 'email' },
                password: { type: 'string', format: 'password' },
              },
            },
            examples: {
              byUserId: {
                summary: 'Administration section — User ID and password',
                value: { userId: 'superadmin', password: 'your-password' },
              },
              byEmail: {
                summary: 'An invited officer — email and password',
                value: { email: 'officer@crossriverstate.gov.ng', password: 'your-password' },
              },
            },
          },
        },
      },
      responses: {
        200: okJson('Signed in.', authResponse),
        401: {
          description: 'Generic failure — code `INVALID_CREDENTIALS`. Do not infer anything further from it.',
          content: { 'application/json': { schema: ref('ErrorEnvelope') } },
        },
        403: {
          description: 'Account is suspended (`ACCOUNT_INACTIVE`) or awaiting approval (`ACCOUNT_PENDING`).',
          content: { 'application/json': { schema: ref('ErrorEnvelope') } },
        },
        423: {
          description: 'Locked after repeated failures. `details.until` carries the release time.',
          content: { 'application/json': { schema: ref('ErrorEnvelope') } },
        },
        429: R[429],
      },
    },
  },

  '/api/v1/auth/refresh': {
    post: {
      tags: ['Authentication'],
      summary: 'Renew a session',
      security: [],
      description:
        'Exchanges a refresh token for a **new pair**, retiring the old token.\n\n' +
        '**Reuse detection.** Presenting a token that has already been rotated means something is wrong — most likely it was captured and the thief is racing the legitimate client. The entire session family is then revoked, signing both parties out. A surprise sign-out is a far better outcome than a silent impersonation, so treat a `REFRESH_TOKEN_INVALID` here as "sign in again", not as a transient error to retry.\n\n' +
        'Always store the **new** refresh token from the response; the one you sent is dead.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['refreshToken'],
          properties: { refreshToken: { type: 'string' } } } } },
      },
      responses: {
        200: okJson('New token pair.', authResponse),
        401: { description: 'Invalid, expired, revoked or **reused** token — code `REFRESH_TOKEN_INVALID`.',
          content: { 'application/json': { schema: ref('ErrorEnvelope') } } },
        403: { description: 'The account is no longer active.' },
      },
    },
  },

  '/api/v1/auth/logout': {
    post: {
      tags: ['Authentication'],
      summary: 'Sign out of this session',
      security: [],
      description:
        'Revokes the supplied refresh token. **Idempotent** — an unknown or already-revoked token still returns success, so a client can always clear its state.\n\n' +
        'The access token is stateless and remains cryptographically valid until it expires, but it is tied to this session and will be refused on its next use.',
      requestBody: {
        content: { 'application/json': { schema: { type: 'object',
          properties: { refreshToken: { type: 'string' } } } } },
      },
      responses: { 200: okJson('Signed out.', { type: 'object', properties: { ok: { type: 'boolean' } } }) },
    },
  },

  '/api/v1/auth/logout-all': {
    post: {
      tags: ['Authentication'],
      summary: 'Sign out everywhere',
      description: 'Revokes every session for the caller, on every device. The usual response to losing a phone.',
      responses: {
        200: okJson('All sessions ended.', { type: 'object', properties: { sessionsRevoked: { type: 'integer' } } }),
        401: R[401],
      },
    },
  },

  '/api/v1/auth/sessions': {
    get: {
      tags: ['Authentication'],
      summary: 'List your active sessions',
      description:
        'Where this account is currently signed in — IP, user agent, device and last use — so an officer can spot a session they do not recognise.',
      responses: {
        200: okJson('Active sessions.', { type: 'array', items: { type: 'object', properties: {
          ipAddress: { type: 'string' }, userAgent: { type: 'string' },
          deviceCode: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          lastUsedAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' } } } }),
        401: R[401],
      },
    },
  },

  '/api/v1/auth/change-password': {
    post: {
      tags: ['Authentication'],
      summary: 'Change your own password',
      description:
        'Requires the **current** password even though you are already authenticated: an unattended signed-in session should not be enough to take the account over permanently.\n\n' +
        'Every other session is signed out afterwards, because changing a password is the usual response to suspecting one is compromised. The caller keeps the session they used.\n\n' +
        'Minimum 12 characters. The password may not contain your own name or email local-part, and may not be a known-common choice.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', format: 'password' },
            newPassword: { type: 'string', format: 'password', minLength: 12 } } } } },
      },
      responses: {
        200: okJson('Changed.', { type: 'object', properties: {
          ok: { type: 'boolean' }, sessionsRevoked: { type: 'integer' } } }),
        401: { description: 'The current password is wrong — `INVALID_CREDENTIALS`.' },
        422: { description: 'The new password was rejected — `WEAK_PASSWORD`, with each problem listed in `details`.',
          content: { 'application/json': { schema: ref('ErrorEnvelope') } } },
      },
    },
  },

  '/api/v1/auth/forgot-password': {
    post: {
      tags: ['Authentication'],
      summary: 'Request a password reset',
      security: [],
      description:
        'Emails a single-use reset link valid for 30 minutes.\n\n' +
        '**Always reports success**, even for an address with no account — saying "no such user" would let anyone test which government addresses are registered. Do not use the response to decide whether an account exists; it cannot tell you.\n\n' +
        'Limited to 5 requests per IP per hour.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['email'],
          properties: { email: { type: 'string', format: 'email' } } } } },
      },
      responses: {
        200: okJson('Always returned, regardless of whether the address exists.',
          { type: 'object', properties: { ok: { type: 'boolean' } } }),
        429: R[429],
      },
    },
  },

  '/api/v1/auth/reset-password': {
    post: {
      tags: ['Authentication'],
      summary: 'Complete a password reset',
      security: [],
      description:
        'Sets a new password using the token from the emailed link.\n\n' +
        'The token is **single-use** and cleared on success, so a link captured from an inbox cannot be replayed. Every existing session is revoked, since a reset is how someone recovers a compromised account.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object',
          required: ['token', 'newPassword'],
          properties: { token: { type: 'string' },
            newPassword: { type: 'string', format: 'password', minLength: 12 } } } } },
      },
      responses: {
        200: okJson('Password set. Sign in with it.', { type: 'object', properties: { ok: { type: 'boolean' } } }),
        400: { description: 'The link is invalid, already used or expired — `RESET_TOKEN_INVALID`.' },
        422: { description: 'The password was rejected — `WEAK_PASSWORD`.' },
        429: R[429],
      },
    },
  },

  '/api/v1/auth/users/{id}/reset-password': {
    post: {
      tags: ['Authentication'],
      summary: 'Reset another user\'s password (administrative)',
      description:
        'Issues a **temporary password, returned once** and flagged `mustChangePassword`. Every session for that account is revoked.\n\n' +
        'Until the holder sets their own password their next sign-in is confined to the change-password flow — the reset cannot be used to hand somebody a working credential they never replace.\n\n' +
        'Use this when an officer cannot access their email. Share the password through a channel the person can verify — it is not emailed, and it will not be shown again.' + needs('user:manage'),
      parameters: [idParam()],
      responses: {
        201: okJson('Temporary password issued.', { type: 'object', properties: {
          temporaryPassword: { type: 'string', description: 'Shown once. Not recoverable.' },
          mustChangePassword: { type: 'boolean' } } }),
        401: R[401], 403: R[403], 404: R[404],
      },
    },
  },
};
