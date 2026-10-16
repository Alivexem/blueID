'use strict';

const config = require('../config');
const schemas = require('./schemas');
const { paths: corePaths, ref } = require('./paths');
const assetPaths = require('./paths2');
const programmePaths = require('./paths3');
const remainingPaths = require('./paths4');
const authPaths = require('./paths5');
const { ROLES, ROLE_PERMISSIONS, LGAS } = require('../config/constants');

const pkg = require('../../package.json');

/** Reusable error responses, so each operation lists them by reference. */
const responses = {
  Unauthenticated: {
    description: 'No valid token. Codes: `TOKEN_MISSING`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`.',
    content: { 'application/json': { schema: ref('ErrorEnvelope') } },
  },
  Forbidden: {
    description:
      'Authenticated but not permitted. Codes: `MISSING_PERMISSION`, `ACCOUNT_PENDING`, `ACCOUNT_INACTIVE`, `EMAIL_NOT_VERIFIED`, `SELF_APPROVAL_FORBIDDEN`, `PASSWORD_CHANGE_REQUIRED`.',
    content: { 'application/json': { schema: ref('ErrorEnvelope') } },
  },
  NotFound: {
    description:
      'The record does not exist — **or** is outside your scope. The two are deliberately indistinguishable, because confirming existence would itself disclose information.',
    content: { 'application/json': { schema: ref('ErrorEnvelope') } },
  },
  Conflict: {
    description:
      'The request conflicts with the current state. Codes: `DUPLICATE_KEY`, `ALREADY_VERIFIED`, `ALREADY_ALLOCATED`, `PROGRAMME_FULL`, `INVALID_STATUS_TRANSITION`, `DUPLICATE_REVIEW_PENDING`, `STALE_UPDATE`.',
    content: { 'application/json': { schema: ref('ErrorEnvelope') } },
  },
  ValidationError: {
    description: 'The body or query failed validation. `error.details` lists the offending fields.',
    content: { 'application/json': { schema: ref('ErrorEnvelope') } },
  },
  RateLimited: {
    description: 'Rate limit exceeded. Check `RateLimit-Reset` and `Retry-After`.',
    content: { 'application/json': { schema: ref('ErrorEnvelope') } },
  },
  Unavailable: {
    description: 'A dependency is unavailable. Code: `DATABASE_UNAVAILABLE`. Retry shortly.',
    content: { 'application/json': { schema: ref('ErrorEnvelope') } },
  },
};

const ROLE_NOTES = {
  SUPER_ADMIN: 'Oversight only — creates accounts and reads the audit trail. Holds no operational grant.',
  STATE_ADMIN: 'Full operational authority state-wide. The role that actually runs the register.',
  MINISTRY_OFFICER: 'Programmes, verification and reporting. Cannot register or edit a fisherman.',
  LGA_ADMIN: 'Full operations, confined to their own Local Government Areas.',
  ENUMERATOR: 'Field registration and offline sync. Cannot verify their own submissions.',
  COOPERATIVE_OFFICER: 'Their own cooperative and its membership.',
};

const roleTable = Object.values(ROLES)
  .map((r) => `| \`${r}\` | ${ROLE_PERMISSIONS[r].length} | ${ROLE_NOTES[r] || ''} |`)
  .join('\n');

const description = `
The backend for the **Cross River State Blue ID & Fisheries Information Management System** — the
authoritative register of fishermen, boats, engines, cooperatives and government interventions across
the state's ${LGAS.length} Local Government Areas.

---

## Authentication

This API owns authentication end to end. There is **no external identity provider** in the default
configuration: it hashes passwords with Argon2id, issues its own tokens, and handles reset.

### Signing in

\`\`\`
POST /api/v1/auth/login   { "email": "...", "password": "..." }
\`\`\`

returns an **access token** and a **refresh token**:

| Token | Lifetime | Stored? | Purpose |
|---|---|---|---|
| Access | short (15m default) | no — stateless JWT | Sent on every request as \`Authorization: Bearer <token>\` |
| Refresh | long (30d default) | yes, hashed | Exchanged at \`/auth/refresh\` for a new pair |

The split is deliberate. Access tokens are fast to verify but **cannot be withdrawn**, so they are
short-lived. Refresh tokens are stored precisely so they **can** be withdrawn: suspending an officer,
changing a password or signing out a device all work by revoking them.

### Refresh rotation and theft detection

Every refresh issues a new token and retires the old one. Presenting an already-rotated token
revokes the **entire session family** — the most likely explanation is that it was stolen, and
signing both parties out beats letting an impersonation continue quietly. Treat
\`REFRESH_TOKEN_INVALID\` as "sign in again", never as a transient error to retry.

### Roles come from MongoDB, never from the token

The access token carries identity only — the user id and the session id. Role and scope are re-read
from the database on **every** request, so a demotion, suspension or scope change takes effect on the
next call rather than whenever the token expires. The session named in the token is checked too, so
a sign-out or password change invalidates outstanding access tokens at their next use.

### Account protection

- **8** consecutive failures locks the account for **15 minutes** (\`423 ACCOUNT_LOCKED\`).
- Login is limited to **10 attempts per IP per 15 minutes**; password reset to **5 per hour**.
- Every login failure returns the **same generic error**, so the endpoint cannot be used to discover
  which addresses are registered. The real reason goes to the audit trail.
- \`/auth/forgot-password\` always reports success for the same reason.

### Who has an account

Only **operators** — the people who run the system. There are ${Object.keys(ROLES).length} roles:

| Role | Capabilities | |
|---|---|---|
${roleTable}

**\`SUPER_ADMIN\` is deliberately the smallest role, not the largest.** It exists to put the other
accounts in place and to watch what is done with them: it cannot register or edit a fisherman, verify
a registration, issue a Blue ID, move an asset, run a programme, allocate a benefit, or export the
register. Those powers belong to \`STATE_ADMIN\`. The separation is the point — the account that
creates every other account must not also be able to act under them, or the audit trail it exists to
police becomes a record of its own work.

It still outranks everyone, which is what lets it create a \`STATE_ADMIN\`. **Rank governs who you may
create; it never governs what you may do.** Every route that gates on rank also gates on a permission.

**Fishermen do not have accounts.** They are the *subject* of records, never users of the API. They
are registered by an officer and identified by their Blue ID.

---

## Three layers of access control

Every request passes through all three:

1. **Capability** — does this role hold the permission the route demands? Listed per operation below.
2. **Scope** — which rows may this user see? Merged into every query inside the service layer, so a
   route cannot forget it. An LGA administrator in Bakassi cannot read Odukpani's register.
3. **Object check** — may this user touch *this* record? Applied after loading. Knowing an id is
   never sufficient.

---

## Response shape

Success:
\`\`\`json
{ "success": true, "data": { }, "meta": { }, "requestId": "..." }
\`\`\`

Failure:
\`\`\`json
{ "success": false, "error": { "code": "...", "message": "...", "details": [] }, "requestId": "..." }
\`\`\`

**Branch on \`error.code\`, never on the message text** — messages are written for humans and may
change. Quote \`requestId\` when reporting a problem; it ties the response to the audit trail.

---

## Rate limits

Limits are shared across instances and keyed to your account where one is known, otherwise to your
IP. Responses carry \`RateLimit-Limit\`, \`RateLimit-Remaining\` and \`RateLimit-Reset\`.

| Surface | Budget |
|---|---|
| General | ${config.rateLimit.max} / ${config.rateLimit.windowMs / 60000} min |
| Sync | ${config.rateLimit.syncMax} / min (deliberately generous — a device back from a week offline pushes many batches) |
| Public verification | 30 / min per IP |
| Exports | 20 / 5 min |

---

## A note on the word "transaction"

Where this documentation says *transaction*, it means a **database transaction** — a group of writes
that either all succeed or all roll back, used so that issuing a Blue ID or recording a benefit
cannot half-happen.

**There is no wallet, payment rail, or money movement anywhere in this system.** Programmes carry a
\`unitValue\` and allocations carry a \`value\`, but those are *recorded amounts for budgeting and
reporting*. Recording that someone received a ₦1.85m outboard engine is not the same as paying them,
and this API does not do the latter.
`.trim();

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Blue ID & Fisheries Information Management System API',
    version: pkg.version,
    description,
    contact: { name: 'Cross River State Department of Blue Economy' },
    license: { name: 'Proprietary — Government of Cross River State' },
  },

  servers: [
    { url: config.app.baseUrl, description: `Current environment (${config.env})` },
    { url: 'http://localhost:5000', description: 'Local development' },
  ],

  tags: [
    { name: 'Service', description: 'Health, readiness and reference vocabularies.' },
    { name: 'Authentication', description: 'Sign-in, token refresh, sign-out and password management. This service owns the credential.' },
    { name: 'Users', description: 'Operator accounts, roles and geographic scope. Not fishermen.' },
    { name: 'Fishermen', description: 'The register: registration, verification, Blue ID issuance, duplicate review.' },
    { name: 'Boats', description: 'Vessels tied to a Blue ID. One person may own several.' },
    { name: 'Engines', description: 'Outboard and inboard engines. Serial numbers are unique state-wide.' },
    { name: 'Equipment', description: 'Nets, cold boxes, safety kit, GPS units.' },
    { name: 'Cooperatives', description: 'Fishing societies and their membership.' },
    { name: 'Programmes', description: 'Government interventions and machine-readable eligibility.' },
    { name: 'Benefits', description: 'Allocations: who received what, when, under which intervention.' },
    { name: 'Sync', description: 'Offline-first field synchronisation and device enrolment.' },
    { name: 'Verification', description: 'Blue ID and QR card verification, including public checks.' },
    { name: 'Dashboard', description: 'Executive aggregates and infrastructure gaps.' },
    { name: 'GIS', description: 'GeoJSON map layers.' },
    { name: 'Reports', description: 'CSV, Excel and PDF exports. All audited.' },
    { name: 'Media', description: 'Photograph access and upload credentials.' },
    { name: 'Audit', description: 'Append-only trail of privileged activity, including denied attempts.' },
    { name: 'Reference data', description: 'Communities and their infrastructure.' },
  ],

  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'The **access token** returned by `POST /api/v1/auth/login` or `/auth/refresh`. Short-lived — refresh it rather than extending its life. A refresh token is NOT accepted here and is refused with `WRONG_TOKEN_TYPE`.\n\nIn local development with `AUTH_MODE=disabled`, send `x-debug-uid` and `x-debug-role` headers instead.',
      },
      ServiceApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description:
          'Machine-to-machine key for trusted government integrations. **Read-only** — any non-GET request is refused.',
      },
      DeviceSecret: {
        type: 'apiKey',
        in: 'header',
        name: 'x-device-secret',
        description:
          'Enrolment secret issued when a field device is registered, shown exactly once. Required on every sync push. The device code is an identifier, not a credential.',
      },
    },
    schemas,
    responses,
  },

  security: [{ BearerAuth: [] }],

  paths: {
    ...corePaths,
    ...assetPaths,
    ...programmePaths,
    ...remainingPaths,
    ...authPaths,
  },
};

module.exports = spec;
