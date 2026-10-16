# Blue ID — Backend API

Cross River State **Blue ID & Fisheries Information Management System**: the
central register of fishermen, boats, engines, cooperatives and government
interventions across the state's 18 Local Government Areas.

Node.js · Express · MongoDB · Redis (Upstash) · Cloudinary · Brevo

---

## Quick start

```bash
npm install
cp .env.example .env.local        # then fill in MONGODB_URI
npm run db:indexes                # REQUIRED — creates the uniqueness constraints
npm run seed                      # reference data + a bootstrap admin
npm run dev                       # http://localhost:5000/api/v1
```

> **`npm run db:indexes` is not optional.** `autoIndex` is disabled in
> production, so until it runs, Blue ID uniqueness, sync replay protection and
> duplicate-benefit prevention are **not enforced** — and the failure is
> silent, because the database simply accepts the duplicates. `/health/ready`
> fails while any critical index is missing.

`.env.local` ships with working development defaults (`AUTH_MODE=disabled`,
in-memory cache fallback), so the API runs against nothing but a MongoDB URI.

```bash
npm test          # unit tests; DB-backed tests skip when no database is reachable
npm start         # production
```

To run the integration tests, point `MONGODB_URI` at a **disposable** database —
they write and delete records:

```bash
MONGODB_URI="mongodb+srv://.../blueid-test" npm test
```

---

## Architecture

```
src/
├── server.js            process lifecycle, graceful shutdown, worker startup
├── app.js               Express wiring, security headers, CORS, rate limiting
├── config/              env validation, logger, Mongo, Redis, Cloudinary, constants
├── middleware/          auth, authorization, validation, uploads, errors
├── modules/             one folder per domain concern
│   ├── fishermen/       the register, Blue ID issuance, duplicate review
│   ├── assets/          boats, engines, equipment
│   ├── programmes/      interventions, eligibility, benefit allocations
│   ├── sync/            offline device sync, enrolment, batch receipts
│   ├── verification/    Blue ID and QR verification
│   ├── communities/     fishing communities and infrastructure
│   ├── cooperatives/    societies and membership
│   ├── dashboard/       executive aggregates
│   ├── gis/             GeoJSON map layers
│   ├── reports/         CSV / Excel / PDF exports
│   ├── users/           operator accounts, roles, scope
│   ├── audit/           append-only audit trail
│   └── outbox/          durable job queue
├── services/            cross-cutting: cache, queue, media, email, Blue ID, duplicates
├── workers/             background job runtime and handlers
└── utils/               errors, pagination, query composition, normalisation, crypto
```

Each module follows the same shape: `model` → `service` (business rules and
authorization) → `controller` (HTTP) → `routes` (guards and validation).
**Authorization lives in the service layer**, so a route cannot forget it.

### Data stores

**MongoDB is the source of truth. Redis is disposable.** If Redis is flushed or
restored from an older snapshot, the register stays correct and no queued work
is lost — the job queue lives in MongoDB, not Redis.

| Concern | Store |
|---|---|
| Register, assets, programmes, audit, jobs | MongoDB |
| Cache, dashboard aggregates, rate limits, sync locks | Redis (Upstash) |
| Photographs, acknowledgement slips | Cloudinary (`authenticated` delivery) |
| Transactional email | Brevo |
| Identity (tokens, passwords, reset) | Firebase Authentication |

Redis is optional in development: without it the API falls back to a bounded
in-process cache. It is **required in production**, where it carries
distributed rate limits.

---

## Authentication and authorization

**This API does not implement login.** Sign-in, sign-up, password reset and
token refresh belong to **Firebase Authentication**. This service never sees a
password, never issues a token and holds no session — it verifies the ID token
it is handed and maps the subject to a local `User` record.

```
AUTH_MODE=firebase  Firebase ID tokens (production default)
AUTH_MODE=jwt       HS256 against AUTH_JWT_SECRET — internal/service tokens
AUTH_MODE=jwks      RS256 against a remote JWKS; issuer AND audience required
AUTH_MODE=disabled  development only — trusts x-debug-uid / x-debug-role headers
```

Verification goes through the Admin SDK rather than a hand-rolled JWKS check,
for two reasons that are not optional:

- **Audience pinning.** Google signs every Firebase project's tokens with the
  same keys, so a signature check alone accepts a token from *any* project.
  `verifyIdToken` pins `aud` to this project and `iss` to
  `securetoken.google.com/<projectId>`. In `jwks` mode the config schema
  refuses to boot without both pinned manually.
- **Revocation.** `verifyIdToken(token, /* checkRevoked */ true)` rejects a
  token whose refresh tokens have been revoked, instead of honouring it for the
  remainder of its hour.

### Roles come from MongoDB, never from the token

Firebase custom claims are the obvious place to put a role — and the wrong one.
Claims are baked into an ID token valid for up to an hour, so an administrator
demoted five minutes ago would still present an administrator token. Every
request re-reads role and scope from `users`, which makes demotion, suspension
and scope changes effective on the **next call**.

Suspending an officer also calls `revokeRefreshTokens` (and `disabled: true`
for a full disable), so the two systems cannot drift apart. If Firebase is
unreachable the local status check still blocks the account; the failure is
logged rather than silently leaving access open.

### Provisioning

Officers are **invited**: an account is created by email, and the first sign-in
binds the Firebase subject to it. The binding requires `email_verified`, since
an unverified address would otherwise let anyone claim a pending
`STATE_ADMIN` invitation. `AUTH_AUTO_PROVISION` must be `false` in production
and the config schema enforces it.

### Abuse controls

Failed authentications are counted per IP in Redis; past
`AUTH_MAX_FAILURES_PER_WINDOW` (default 20 / 15 min) further attempts are
refused, and the counter clears on a successful sign-in. Every 401 and 403 is
written to the audit trail — a trail that records only successes cannot
evidence an attempted intrusion.

Machine-to-machine access (`x-api-key`) is **enforced read-only**: a non-GET
behind `serviceAuth` is refused, so a future route cannot quietly gain write
access with a static shared key.

### Three layers of access control

1. **Capability** — `requirePermission(PERMISSIONS.REGISTRATION_VERIFY)` on the
   route. Permissions are explicit (`fisherman:read`, `benefit:approve`, …) and
   mapped to roles in `config/constants.js`, so "may register" and "may approve
   a ₦1.8m engine" are separable.
2. **Scope filter** — `buildScopeFilter(user)` merged into every list and
   aggregate query. An LGA administrator in Bakassi cannot read Odukpani's
   register.
3. **Object check** — `assertCanAccessRecord(user, doc)` after loading a
   document. Knowing an id is never enough (IDOR defence).

Layers 2 and 3 share one implementation, so a row visible in a list is always
openable by the same user.

### Roles

| Role | Scope | Notable capabilities |
|---|---|---|
| `SUPER_ADMIN` | State-wide | Everything |
| `STATE_ADMIN` | State-wide | Everything incl. role assignment |
| `MINISTRY_OFFICER` | State-wide | Programmes, benefit **approval**, exports |
| `LGA_ADMIN` | Assigned LGAs | Verify, allocate benefits, devices, users |
| `COOPERATIVE_OFFICER` | Own cooperative | Membership |
| `ENUMERATOR` | Own records + posting | Register, edit, sync, deliver |

**Separation of duties:** an enumerator cannot verify, and no officer may
verify a record they registered or approve an allocation they raised.

---

## Blue ID

Format `CRS-BLU-BAK-0001` — state · fisheries · LGA code · sequence.

- Issued **only on verification**, never at registration.
- Sequences come from an atomic MongoDB counter, never a count of rows, so
  concurrent sync batches cannot collide. Issuance runs in a transaction.
- Permanent: never reused, even after a deletion or a merge.
- **Not a secret** — it is an identifier, not an authorization mechanism.

### QR codes

The printed card's QR carries a **random opaque token**, never the Blue ID and
never a name: a card photographed by a stranger leaks nothing. An HMAC lets an
official confirm a card is genuine offline; live status needs a lookup.
Reissuing a card rotates the token, so a lost card stops validating.

---

## Offline-first synchronisation

The field application works with no network for a full day and synchronises on
reconnection. Two device-minted identifiers make that safe:

- **`clientRecordId`** — a UUID generated on the device before the server ever
  sees the record. Every write upserts on it, so a replayed batch updates the
  same row instead of creating a second fisherman. Enforced by a unique index.
- **`clientBatchId`** — identifies the push. A device that never received the
  response re-sends and gets the stored result back.

Other guarantees:

- **Device enrolment is authenticated.** Every sync call presents the secret
  issued at registration (`x-device-secret`); the code alone is not a
  credential. Revoking a device clears the hash and immediately stops it.
- **Per-entity cursors.** Each entity advances its own keyset cursor, so no
  record is ever skipped because another entity drained faster.
- **Conflicts are surfaced, not silently resolved.** `SYNC_CONFLICT_STRATEGY`
  defaults to `server_wins`; the device keeps its copy and is told.
- **Nothing is lost.** Rejected records are retained on the batch with their
  payload and field-level errors, so they can be corrected from the portal.

```
GET  /api/v1/sync/bootstrap   reference data for a field trip
GET  /api/v1/sync/pull        changes since the device's cursors
POST /api/v1/sync/push        a batch of offline records
```

---

## Duplicate detection

Suspected duplicates are **flagged for administrative review, never
auto-deleted**. Matching runs in two stages: an indexed blocking query narrows
candidates, then each is scored on weighted signals (NIN, phone, name
similarity, birth year, community, next-of-kin).

- A matching NIN is decisive on its own.
- A shared phone number is **not** — handsets are commonly shared.
- Names are matched phonetically and by token set, so spelling variants and
  reordered names still match.

A record with an open duplicate flag cannot be verified, so a duplicate never
acquires a permanent Blue ID. Merges move assets and benefit history to the
surviving record and are fully reversible through the audit trail.

---

## Privacy and security

- **NIN is encrypted at rest** (AES-256-GCM) with a key held outside the
  database, and searchable only through a keyed blind index. Reading one
  requires `fisherman:read_sensitive` and is written to the audit trail;
  everyone else sees `*******8901`.
- **Uploads are checked by file signature**, not by the declared content type,
  and EXIF (including GPS) is stripped on the way to Cloudinary.
- **Photographs are `authenticated` assets** served via short-lived signed
  URLs, so a leaked URL expires.
- **Exports are audited** with their filters and row count, and CSV cells are
  guarded against spreadsheet formula injection.
- **The audit trail is append-only** — updates and deletes are rejected at the
  model layer.
- Logs redact tokens, secrets, NINs and signed media URLs.
- `sanitizeFilter` is enabled globally and every filter is built from an
  allowlist, blocking NoSQL operator injection.

---

## Background jobs

Jobs live in MongoDB (`outbox` collection) and are claimed with an atomic
`findOneAndUpdate`, so any number of workers can run safely.

For critical work the job row is written **inside the same transaction** as the
business change (transactional outbox), closing the dual-write gap where a
crash between "save record" and "enqueue notification" loses the notification.

Handlers are idempotent, retried with exponential backoff and jitter, and moved
to a dead-letter state after `WORKER_MAX_ATTEMPTS`. Queue depth and the age of
the oldest due job are reported by `/health/ready`.

Workers run in-process by default; set `WORKER_ENABLED=false` to run the same
image as an API-only node alongside a dedicated worker fleet.

---

## API surface

All routes are under `API_PREFIX` (default `/api/v1`).

| Area | Base |
|---|---|
| Register | `/fishermen` |
| Assets | `/boats`, `/engines`, `/equipment`, `/assets/owner/:id` |
| Programmes | `/programmes`, `/programmes/allocations` |
| Sync | `/sync` |
| Verification | `/verify/:blueId`, `/verify/scan` |
| Dashboard | `/dashboard` |
| GIS | `/gis` |
| Reports | `/reports/*.csv`, `*.xlsx`, `*.pdf` |
| Reference | `/communities`, `/cooperatives`, `/reference/constants` |
| Administration | `/users`, `/audit`, `/media` |
| Health | `/health/live`, `/health/ready` |

Every response uses one envelope:

```jsonc
{ "success": true,  "data": {}, "meta": {}, "requestId": "…" }
{ "success": false, "error": { "code": "…", "message": "…", "details": [] }, "requestId": "…" }
```

Clients branch on `error.code`, never on the message text.

---

## Environment

`.env.local` (development) and `.env` (deployed) are git-ignored;
`.env.example` is the only committed template. See it for the full list.

Production additionally **requires**: `FIELD_ENCRYPTION_KEY` (32+ chars),
`QR_SIGNING_SECRET`, `FIREBASE_PROJECT_ID`, Redis credentials, and a
non-wildcard `CORS_ORIGINS`. It **rejects** `AUTH_MODE=disabled`,
`AUTH_AUTO_PROVISION=true` and `AUTH_REQUIRE_VERIFIED_EMAIL=false`.

Token verification needs `FIREBASE_PROJECT_ID`. Disabling accounts and revoking
refresh tokens additionally needs `FIREBASE_CLIENT_EMAIL` and
`FIREBASE_PRIVATE_KEY` (a service account), or Application Default Credentials
when running on Google infrastructure.

**Firebase project settings to verify** — these are outside this repo and the
backend cannot enforce them: restrict the enabled sign-in providers, require
email verification, disable self-signup if you provision by invitation only,
and set an appropriate password policy.

---

## Operational notes

- **MongoDB Atlas**: use a dedicated least-privilege database user, restrict
  network access to the application's egress addresses, and enable automated
  backups with point-in-time recovery. Transactions require a replica set,
  which Atlas provides; on a standalone `mongod` the code falls back to
  non-transactional execution.
### Deploy sequence

```bash
npm run deploy:db          # db:indexes && db:migrate
npm run db:indexes:check   # CI gate — exits non-zero if any are missing
npm run db:validators      # optional: $jsonSchema in warn mode
```

| Command | Purpose |
|---|---|
| `db:indexes` | Create/verify indexes. Add `--prune` to drop undeclared ones. |
| `db:indexes:check` | Verify only. Suitable as a deploy gate. |
| `db:migrate` | Apply outstanding migrations (`--dry`, `--status`). |
| `db:validators` | Apply `$jsonSchema` validators (`--enforce` to reject writes). |

Migrations are recorded in `migrations` and are idempotent. Run
`db:migrate -- --dry` first on production data.

- **Indexes** are declared in the models and auto-created outside production
  only. Unique constraints use partial indexes keyed on `$type`, not `sparse`,
  because a sparse unique index still indexes an explicit `null`.
- **Deep pagination** is capped; past ~10,000 skipped documents callers are
  asked to narrow filters or export instead.
- Set `TRUST_PROXY=true` behind a load balancer, or rate limits and the audit
  trail will record the balancer's address.

### Before go-live

The seeded communities are an **illustrative starter set**, not an
authoritative list — replace them with the Department of Blue Economy's
official register. The 18 LGA codes in `config/constants.js` are permanent:
they are embedded in every Blue ID ever issued and must never be renumbered.

Confirm applicable Nigerian data-protection requirements with the responsible
data protection officer before processing live personal data.
