'use strict';

const { LGA_CODES, FISHERMAN_STATUS, GENDERS, FISHERMAN_TYPES, FISHING_TYPES,
  PROGRAMME_TYPES, PROGRAMME_STATUS, ALLOCATION_STATUS, SYNC_ENTITIES,
  AUDIT_ACTIONS, ROLE_VALUES, USER_STATUS, DEVICE_STATUS, EQUIPMENT_TYPES,
  BOAT_TYPES, COMMUNITY_TYPES, FACILITY_KEYS } = require('../config/constants');

const enumOf = (o) => Object.values(o);
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

/** Standard reusable responses. */
const R = {
  401: { $ref: '#/components/responses/Unauthenticated' },
  403: { $ref: '#/components/responses/Forbidden' },
  404: { $ref: '#/components/responses/NotFound' },
  409: { $ref: '#/components/responses/Conflict' },
  422: { $ref: '#/components/responses/ValidationError' },
  429: { $ref: '#/components/responses/RateLimited' },
  503: { $ref: '#/components/responses/Unavailable' },
};

/** Wraps a payload schema in the success envelope. */
const okJson = (description, dataSchema, extra = {}) => ({
  description,
  content: {
    'application/json': {
      schema: {
        allOf: [
          ref('SuccessEnvelope'),
          { type: 'object', properties: { data: dataSchema, ...extra } },
        ],
      },
    },
  },
});

const listJson = (description, itemSchema) => ({
  description,
  content: {
    'application/json': {
      schema: {
        allOf: [
          ref('SuccessEnvelope'),
          {
            type: 'object',
            properties: {
              data: { type: 'array', items: itemSchema },
              meta: { type: 'object', properties: { pagination: ref('Pagination') } },
            },
          },
        ],
      },
    },
  },
});

const idParam = (name = 'id', description = 'MongoDB ObjectId.') => ({
  name, in: 'path', required: true, schema: { type: 'string', format: 'objectid' }, description,
});

const pageParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 },
    description: 'Deep offsets are refused past ~10,000 skipped documents; narrow the filters or export instead.' },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
];

/** Notes which capability a route demands, rendered into the description. */
const needs = (...perms) =>
  `\n\n**Requires:** \`${perms.join('`, `')}\``;

const scopeNote =
  '\n\n**Scope:** results are restricted to the caller\'s LGAs/communities. An out-of-scope record returns **404**, not 403 — confirming existence would itself disclose information.';

const paths = {
  // =========================================================================
  // Service
  // =========================================================================
  '/health/live': {
    get: {
      tags: ['Service'],
      summary: 'Liveness probe',
      description: 'Confirms the process is running. Touches no dependency, so a slow database never causes a restart of a healthy server.',
      security: [],
      responses: {
        200: okJson('Process is up.', { type: 'object', properties: { status: { type: 'string' }, uptime: { type: 'integer' } } }),
      },
    },
  },

  '/health/ready': {
    get: {
      tags: ['Service'],
      summary: 'Readiness probe',
      description:
        'Reports whether this instance can serve traffic.\n\n' +
        'Anonymous callers receive **up/down only**. The detailed body names internal collections, integration state and any missing database constraints, so it is released only to a caller presenting `x-probe-key`.\n\n' +
        'Fails (503) when MongoDB is unreachable, when a critical index is missing, or during graceful shutdown (`draining`).',
      security: [],
      parameters: [
        { name: 'x-probe-key', in: 'header', schema: { type: 'string' },
          description: 'Internal probe key. Without it the response is `{status}` only.' },
      ],
      responses: {
        200: { description: 'Ready.' },
        503: { description: 'Not ready, or draining during shutdown.' },
      },
    },
  },

  '/api/v1': {
    get: {
      tags: ['Service'],
      summary: 'API index',
      description: 'Lists the available endpoint groups. Useful as a connectivity check.',
      security: [],
      responses: { 200: { description: 'Service metadata and endpoint map.' } },
    },
  },

  '/api/v1/reference/constants': {
    get: {
      tags: ['Service'],
      summary: 'Enumerations and LGA list',
      description:
        'Every enumeration the portal and field app build dropdowns from, plus the 18 Cross River LGAs and the Blue ID format. Clients should read vocabularies from here rather than hard-coding them.',
      security: [],
      responses: { 200: { description: 'Reference vocabularies.' } },
    },
  },

  // =========================================================================
  // Users
  // =========================================================================
  '/api/v1/users/me': {
    get: {
      tags: ['Users'],
      summary: 'Current operator profile',
      description:
        'Resolves the bearer token to this operator\'s record, role, geographic scope and derived permissions. The portal calls this immediately after sign-in.\n\n' +
        'Role and scope are read from MongoDB on every request — never from the token — so a demotion or suspension takes effect on the next call rather than when the token expires.',
      responses: { 200: okJson('The caller.', ref('Me')), 401: R[401], 403: R[403] },
    },
    patch: {
      tags: ['Users'],
      summary: 'Update own contact details',
      description: 'Self-service. Role, scope and status cannot be changed here — that would be privilege escalation.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: {
          firstName: { type: 'string' }, lastName: { type: 'string' },
          phone: { type: 'string' }, designation: { type: 'string' } } } } },
      },
      responses: { 200: okJson('Updated.', ref('User')), 401: R[401], 422: R[422] },
    },
  },

  '/api/v1/users': {
    get: {
      tags: ['Users'],
      summary: 'List operators',
      description: 'Administrators see only staff working in their own LGAs.' + needs('user:manage'),
      parameters: [
        ...pageParams,
        { name: 'role', in: 'query', schema: { type: 'string', enum: ROLE_VALUES } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: enumOf(USER_STATUS) } },
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Matches name or email.' },
      ],
      responses: { 200: listJson('Operators.', ref('User')), 401: R[401], 403: R[403] },
    },
    post: {
      tags: ['Users'],
      summary: 'Invite an operator',
      description:
        'Creates the account **with a credential** and emails an invitation.\n\n' +
        'Omit `password` and the system generates a temporary one, returned **once** in this response as `temporaryPassword` and never recoverable afterwards. Pass it to the officer by whatever channel you trust; it is not emailed.\n\n' +
        'Either way the account is flagged `mustChangePassword` — a generated one because nobody has chosen it yet, an administrator-supplied one because the administrator knows it. Until the holder replaces it their sign-in reaches only `/auth/change-password`, `/auth/logout`, `/auth/logout-all`, `/auth/sessions` and `/users/me`; everything else answers `403 PASSWORD_CHANGE_REQUIRED`. That is enforced server-side, not left to the client.\n\n' +
        'You cannot create a role at or above your own, or assign an LGA outside your own scope. `SUPER_ADMIN` can therefore never be created here — it exists only via the server-side bootstrap command.' + needs('user:manage'),
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object',
          required: ['email', 'firstName', 'lastName', 'role'],
          properties: {
            email: { type: 'string', format: 'email' },
            firstName: { type: 'string' }, lastName: { type: 'string' },
            phone: { type: 'string' },
            role: { type: 'string', enum: ROLE_VALUES },
            scope: { type: 'object', properties: {
              lgas: { type: 'array', items: { type: 'string', enum: LGA_CODES } },
              communities: { type: 'array', items: { type: 'string', format: 'objectid' } } } },
            cooperative: { type: 'string', format: 'objectid', description: 'Required for COOPERATIVE_OFFICER.' },
            staffId: { type: 'string' }, designation: { type: 'string' },
          } } } },
      },
      responses: {
        201: okJson('Account created. A generated password appears here once.', {
          type: 'object',
          properties: {
            user: ref('User'),
            temporaryPassword: {
              type: 'string',
              description: 'Present only when the system generated it. Shown once; not recoverable.',
            },
            mustChangePassword: { type: 'boolean' },
          },
        }),
        401: R[401], 403: R[403], 409: R[409], 422: R[422],
      },
    },
  },

  '/api/v1/users/{id}': {
    get: {
      tags: ['Users'], summary: 'Get an operator',
      description: 'The account, its role and its geographic scope. Credential fields are never returned.' + needs('user:manage'),
      parameters: [idParam()],
      responses: { 200: okJson('Operator.', ref('User')), 401: R[401], 403: R[403], 404: R[404] },
    },
    patch: {
      tags: ['Users'], summary: 'Update an operator',
      description: 'Role and scope changes are privileged and cannot escalate. You cannot change your own role.' + needs('user:manage'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
        firstName: { type: 'string' }, lastName: { type: 'string' }, phone: { type: 'string' },
        role: { type: 'string', enum: ROLE_VALUES },
        scope: { type: 'object' }, cooperative: { type: 'string' },
        staffId: { type: 'string' }, designation: { type: 'string' } } } } } },
      responses: { 200: okJson('Updated.', ref('User')), 401: R[401], 403: R[403], 404: R[404], 422: R[422] },
    },
  },

  '/api/v1/users/{id}/activate': {
    post: {
      tags: ['Users'], summary: 'Approve a pending account',
      description: 'Activates an account that was auto-provisioned on first sign-in, assigning its role and scope.' + needs('user:manage'),
      parameters: [idParam()],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
        role: { type: 'string', enum: ROLE_VALUES }, scope: { type: 'object' } } } } } },
      responses: { 200: okJson('Activated.', ref('User')), 401: R[401], 403: R[403], 404: R[404] },
    },
  },

  '/api/v1/users/{id}/status': {
    patch: {
      tags: ['Users'], summary: 'Suspend or reinstate an operator',
      description:
        'Suspending revokes every live session for the account immediately, so an access token already in someone\'s hands stops working on its next request rather than when it expires. The status is re-read on every request, which is what makes that true.\n\n' +
        'You cannot change your own status, or the status of an account at or above your own role.' +
        needs('user:manage'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['status', 'reason'],
        properties: { status: { type: 'string', enum: enumOf(USER_STATUS) }, reason: { type: 'string', minLength: 3 } } } } } },
      responses: { 200: okJson('Status changed.', ref('User')), 401: R[401], 403: R[403], 404: R[404] },
    },
  },

  // =========================================================================
  // Fishermen
  // =========================================================================
  '/api/v1/fishermen': {
    get: {
      tags: ['Fishermen'], summary: 'List / search the register',
      description:
        '`search` accepts a Blue ID, a phone number (any Nigerian format) or a name. A name search uses the text index; an NIN is matched through its blind index.' + scopeNote + needs('fisherman:read'),
      parameters: [
        ...pageParams,
        { name: 'search', in: 'query', schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: enumOf(FISHERMAN_STATUS) } },
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'community', in: 'query', schema: { type: 'string', format: 'objectid' } },
        { name: 'gender', in: 'query', schema: { type: 'string', enum: enumOf(GENDERS) } },
        { name: 'fishermanType', in: 'query', schema: { type: 'string', enum: enumOf(FISHERMAN_TYPES) } },
        { name: 'fishingType', in: 'query', schema: { type: 'string', enum: enumOf(FISHING_TYPES) } },
        { name: 'cooperative', in: 'query', schema: { type: 'string', format: 'objectid' } },
        { name: 'hasBlueId', in: 'query', schema: { type: 'boolean' }, description: 'Filter verified vs pending.' },
        { name: 'flagged', in: 'query', schema: { type: 'boolean' }, description: 'Only records with an open duplicate review.' },
        { name: 'registeredFrom', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'registeredTo', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['createdAt', '-createdAt', 'fullName', '-fullName', 'updatedAt', '-updatedAt'] },
          description: 'Allowlisted. An unrecognised field falls back to newest first.' },
      ],
      responses: { 200: listJson('Matching records.', ref('Fisherman')), 401: R[401], 403: R[403] },
    },
    post: {
      tags: ['Fishermen'], summary: 'Register a fisherman',
      description:
        'Creates a record with status `PENDING_VERIFICATION`. **No Blue ID is issued here** — that happens on verification.\n\n' +
        'Duplicate screening runs automatically. If a strong match is found the record is saved with status `DUPLICATE_UNDER_REVIEW` and the response carries `duplicateReview`; the record is **never** rejected or deleted, so no field data is lost.' + needs('fisherman:create'),
      requestBody: { required: true, content: { 'application/json': { schema: ref('FishermanCreate') } } },
      responses: {
        201: okJson('Registered.', { type: 'object', properties: {
          fisherman: ref('Fisherman'),
          duplicateReview: { nullable: true, allOf: [ref('DuplicateMatchResult')] } } }),
        401: R[401], 403: R[403], 422: R[422],
      },
    },
  },

  '/api/v1/fishermen/check-duplicates': {
    post: {
      tags: ['Fishermen'], summary: 'Pre-submission duplicate probe',
      description:
        'Call this as the enumerator types, so a likely duplicate surfaces while the fisherman is still standing there — far cheaper to resolve then than in an administrative review later. Writes nothing.' + needs('fisherman:create'),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['firstName', 'lastName', 'lga'],
        properties: { firstName: { type: 'string' }, lastName: { type: 'string' }, middleName: { type: 'string' },
          phone: { type: 'string' }, nin: { type: 'string' }, lga: { type: 'string', enum: LGA_CODES },
          community: { type: 'string', format: 'objectid' },
          dateOfBirth: { type: 'string', format: 'date' }, estimatedYearOfBirth: { type: 'integer' } } } } } },
      responses: { 200: okJson('Candidate matches.', ref('DuplicateMatchResult')), 401: R[401], 403: R[403] },
    },
  },

  '/api/v1/fishermen/blue-id/{blueId}': {
    get: {
      tags: ['Fishermen'], summary: 'Look up by Blue ID',
      parameters: [{ name: 'blueId', in: 'path', required: true, schema: { type: 'string' }, example: 'CRS-BLU-BAK-0001' }],
      description: 'Full record including assets and benefit history.' + scopeNote + needs('fisherman:read'),
      responses: { 200: okJson('The record.', ref('Fisherman')), 401: R[401], 403: R[403], 404: R[404] },
    },
  },

  '/api/v1/fishermen/{id}': {
    get: {
      tags: ['Fishermen'], summary: 'Get one record',
      description:
        'Returns the record with its boats, engines, equipment and allocations.\n\n' +
        '`includeNin=true` additionally requires `fisherman:read_sensitive` and **writes an audit entry** — reading a National Identification Number is a privileged act, not an ordinary field read.' + scopeNote + needs('fisherman:read'),
      parameters: [idParam(),
        { name: 'includeNin', in: 'query', schema: { type: 'boolean' }, description: 'Discloses the full NIN. Audited.' },
        { name: 'includeAssets', in: 'query', schema: { type: 'boolean', default: true } }],
      responses: { 200: okJson('The record.', ref('Fisherman')), 401: R[401], 403: R[403], 404: R[404] },
    },
    patch: {
      tags: ['Fishermen'], summary: 'Correct a record',
      description:
        'Authority fields (blueId, status, verification, duplicateFlags) are stripped if sent.\n\n' +
        'An **enumerator** may only edit a registration they captured, and only while it is unverified — after verification the data is authoritative. Changing an identity field re-opens duplicate screening.' + needs('fisherman:edit'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: ref('FishermanCreate') } } },
      responses: { 200: okJson('Updated.', { type: 'object', properties: { fisherman: ref('Fisherman'), duplicateReview: { nullable: true } } }),
        401: R[401], 403: R[403], 404: R[404], 409: R[409], 422: R[422] },
    },
    delete: {
      tags: ['Fishermen'], summary: 'Withdraw a record (soft delete)',
      description:
        'Soft delete — the row remains for audit. **Cascades** to the person\'s boats, engines and equipment so state totals stop counting them. Benefit allocations are deliberately preserved: they record that public money was issued.' + needs('fisherman:delete'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'],
        properties: { reason: { type: 'string', minLength: 3 } } } } } },
      responses: { 204: { description: 'Withdrawn.' }, 401: R[401], 403: R[403], 404: R[404] },
    },
  },

  '/api/v1/fishermen/{id}/photo': {
    post: {
      tags: ['Fishermen'], summary: 'Upload the passport photograph',
      description:
        'Multipart upload. The file is checked by **magic bytes**, not by its declared content type, cropped to a face-centred square, stripped of EXIF (including GPS) and stored with `authenticated` delivery.\n\nA photograph is required before a Blue ID can be issued.' + needs('fisherman:edit'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object',
        properties: { photo: { type: 'string', format: 'binary' } } } } } },
      responses: { 200: okJson('Uploaded.', { type: 'object', properties: { photo: ref('Media') } }),
        400: { description: 'Not a real image, or the content does not match the declared type.' },
        401: R[401], 403: R[403], 404: R[404] },
    },
  },

  '/api/v1/fishermen/{id}/verify': {
    post: {
      tags: ['Fishermen'], summary: 'Verify and issue the Blue ID',
      description:
        'The **only** path that mints a Blue ID. Runs in a database transaction: the sequence is allocated and the record claimed atomically, so concurrent verifications cannot issue two numbers or burn one.\n\n' +
        'Refuses when: a Blue ID already exists, a duplicate review is still open, or no photograph has been uploaded.\n\n' +
        '**Separation of duties:** you cannot verify a record you registered yourself.' + needs('registration:verify'),
      parameters: [idParam()],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { notes: { type: 'string' } } } } } },
      responses: {
        200: okJson('Verified; Blue ID issued.', ref('Fisherman')),
        401: R[401], 403: R[403], 404: R[404],
        409: { description: 'Already verified, or a duplicate review is pending.', content: { 'application/json': { schema: ref('ErrorEnvelope') } } },
      },
    },
  },

  '/api/v1/fishermen/{id}/status': {
    patch: {
      tags: ['Fishermen'], summary: 'Change lifecycle status',
      description:
        'Transitions are enforced by a state machine:\n\n' +
        '- `PENDING_VERIFICATION` → ACTIVE (only via verification), DUPLICATE_UNDER_REVIEW, INACTIVE, DECEASED\n' +
        '- `ACTIVE` → SUSPENDED, INACTIVE, DECEASED, DUPLICATE_UNDER_REVIEW\n' +
        '- `SUSPENDED` → ACTIVE, INACTIVE, DECEASED\n' +
        '- `INACTIVE` → ACTIVE, DECEASED\n' +
        '- `DUPLICATE_UNDER_REVIEW` → INACTIVE, DECEASED (release it by *resolving the review*, not by editing status)\n' +
        '- `DECEASED` → **terminal**\n\n' +
        'An invalid move returns 409 `INVALID_STATUS_TRANSITION`.' + needs('registration:status'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['status', 'reason'],
        properties: { status: { type: 'string', enum: enumOf(FISHERMAN_STATUS) }, reason: { type: 'string', minLength: 3 } } } } } },
      responses: { 200: okJson('Status changed.', ref('Fisherman')), 401: R[401], 403: R[403], 404: R[404], 409: R[409] },
    },
  },

  '/api/v1/fishermen/{id}/duplicates': {
    get: {
      tags: ['Fishermen'], summary: 'Re-run duplicate detection',
      description: 'Scores this record against the register on demand.' + needs('fisherman:read'),
      parameters: [idParam()],
      responses: { 200: okJson('Candidates.', ref('DuplicateMatchResult')), 401: R[401], 403: R[403], 404: R[404] },
    },
  },

  '/api/v1/fishermen/{id}/duplicates/resolve': {
    post: {
      tags: ['Fishermen'], summary: 'Decide a duplicate review',
      description:
        'Records an administrator\'s decision.\n\n' +
        '- `NOT_DUPLICATE` — clears the flag; the record returns to its normal lifecycle.\n' +
        '- `MARKED_DUPLICATE` — holds the record under review.\n' +
        '- `MERGED` — moves assets and benefit history onto the surviving record and retires this one. Runs in a transaction; where both records hold an active allocation for the same programme the loser\'s is revoked rather than duplicated. **Additionally requires `duplicate:merge`.**\n\n' +
        '**Separation of duties:** you cannot resolve a review on a record you captured.' + needs('duplicate:resolve'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['flagId', 'resolution'],
        properties: { flagId: { type: 'string', format: 'objectid' },
          resolution: { type: 'string', enum: ['NOT_DUPLICATE', 'MERGED', 'MARKED_DUPLICATE'] },
          note: { type: 'string' },
          survivorId: { type: 'string', format: 'objectid', description: 'For MERGED; defaults to the flagged candidate.' } } } } } },
      responses: { 200: okJson('Decision recorded.', ref('Fisherman')), 401: R[401], 403: R[403], 404: R[404], 409: R[409] },
    },
  },

  '/api/v1/fishermen/{id}/qr': {
    get: {
      tags: ['Fishermen'], summary: 'QR code for the printed card',
      description:
        'Returns the QR code to print on the physical Blue ID card.\n\n' +
        'The code encodes an **opaque random token**, never the Blue ID and never a name — a card photographed by a stranger leaks nothing. An HMAC lets an official confirm the card is genuine offline; live status still needs a lookup. Issuing one is audited.' + needs('fisherman:read'),
      parameters: [idParam(),
        { name: 'format', in: 'query', schema: { type: 'string', enum: ['png', 'svg', 'json'], default: 'png' },
          description: 'SVG is preferred for printing; JSON returns a data URL.' }],
      responses: {
        200: { description: 'QR code.', content: {
          'image/png': { schema: { type: 'string', format: 'binary' } },
          'image/svg+xml': { schema: { type: 'string' } },
          'application/json': { schema: ref('SuccessEnvelope') } } },
        400: { description: 'No Blue ID has been issued yet.' },
        401: R[401], 403: R[403], 404: R[404],
      },
    },
  },

  '/api/v1/fishermen/{id}/reissue-card': {
    post: {
      tags: ['Fishermen'], summary: 'Reissue a lost or stolen card',
      description: 'Rotates the opaque QR token so the previous card stops validating. The **Blue ID itself never changes** — it is permanent.' + needs('registration:verify'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'],
        properties: { reason: { type: 'string', minLength: 3 } } } } } },
      responses: { 200: okJson('Card reissued.', { type: 'object', properties: { qrVersion: { type: 'integer' } } }),
        401: R[401], 403: R[403], 404: R[404] },
    },
  },
};

module.exports = { paths, R, okJson, listJson, idParam, pageParams, ref, needs, scopeNote, enumOf };
