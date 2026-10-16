'use strict';

const { R, okJson, listJson, idParam, pageParams, ref, needs, scopeNote, enumOf } = require('./paths');
const { LGA_CODES, PROGRAMME_TYPES, PROGRAMME_STATUS, ALLOCATION_STATUS, SYNC_ENTITIES,
  AUDIT_ACTIONS, DEVICE_STATUS, SYNC_BATCH_STATUS, COMMUNITY_TYPES, FACILITY_KEYS,
  FISHERMAN_STATUS, GENDERS, FISHERMAN_TYPES } = require('../config/constants');

module.exports = {
  // =========================================================================
  // Programmes and benefits
  // =========================================================================
  '/api/v1/programmes': {
    get: { tags: ['Programmes'], summary: 'List interventions',
      description: 'Government programmes: engine and net distribution, grants, loans, training, insurance and so on.' + needs('dashboard:view'),
      parameters: [...pageParams,
        { name: 'status', in: 'query', schema: { type: 'string', enum: enumOf(PROGRAMME_STATUS) } },
        { name: 'type', in: 'query', schema: { type: 'string', enum: enumOf(PROGRAMME_TYPES) } },
        { name: 'year', in: 'query', schema: { type: 'integer' } },
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'search', in: 'query', schema: { type: 'string' } }],
      responses: { 200: listJson('Programmes.', ref('Programme')), 401: R[401], 403: R[403] } },
    post: { tags: ['Programmes'], summary: 'Create an intervention',
      description:
        'Eligibility is stored as machine-readable criteria, which is what lets the portal answer "who qualifies?" as a query rather than a manual exercise.' + needs('programme:manage'),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['name', 'code', 'type', 'year'],
        properties: {
          name: { type: 'string' }, code: { type: 'string', example: 'OED-2026' },
          type: { type: 'string', enum: enumOf(PROGRAMME_TYPES) },
          description: { type: 'string' }, year: { type: 'integer' },
          implementingAgency: { type: 'string' }, fundingSource: { type: 'string' },
          status: { type: 'string', enum: enumOf(PROGRAMME_STATUS) },
          startDate: { type: 'string', format: 'date' }, endDate: { type: 'string', format: 'date' },
          itemDescription: { type: 'string' }, unitValue: { type: 'number' },
          targetBeneficiaries: { type: 'integer' }, totalBudget: { type: 'number' },
          eligibility: ref('Eligibility') } } } } },
      responses: { 201: okJson('Created.', ref('Programme')), 401: R[401], 403: R[403], 409: R[409], 422: R[422] } },
  },

  '/api/v1/programmes/{id}': {
    get: { tags: ['Programmes'], summary: 'Get an intervention', parameters: [idParam()],
      description: needs('dashboard:view').trim(),
      responses: { 200: okJson('Programme.', ref('Programme')), 401: R[401], 403: R[403], 404: R[404] } },
    patch: { tags: ['Programmes'], summary: 'Update an intervention',
      description: 'Eligibility criteria are **locked once allocations exist** — they are part of the record of how beneficiaries were chosen.' + needs('programme:manage'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: okJson('Updated.', ref('Programme')), 401: R[401], 403: R[403], 409: R[409] } },
    delete: { tags: ['Programmes'], summary: 'Remove an intervention',
      description: 'Refused once allocations exist — archive it instead. State administrators only.',
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'],
        properties: { reason: { type: 'string' } } } } } },
      responses: { 204: { description: 'Removed.' }, 401: R[401], 403: R[403], 409: R[409] } },
  },

  '/api/v1/programmes/{id}/status': {
    patch: { tags: ['Programmes'], summary: 'Open, close or archive',
      parameters: [idParam()],
      description: needs('programme:manage').trim(),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'],
        properties: { status: { type: 'string', enum: enumOf(PROGRAMME_STATUS) }, note: { type: 'string' } } } } } },
      responses: { 200: okJson('Status changed.', ref('Programme')), 401: R[401], 403: R[403] } },
  },

  '/api/v1/programmes/{id}/eligible': {
    get: { tags: ['Programmes'], summary: 'Pre-screened beneficiary list',
      description:
        'Everyone who meets the programme\'s criteria **and has not already received it**. Excludes anyone holding an active allocation under this programme, and anyone who received the same programme type inside the configured window.' + scopeNote + needs('benefit:allocate'),
      parameters: [idParam(), ...pageParams,
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'community', in: 'query', schema: { type: 'string', format: 'objectid' } },
        { name: 'search', in: 'query', schema: { type: 'string' } }],
      responses: { 200: listJson('Eligible fishermen.', ref('Fisherman')), 401: R[401], 403: R[403], 404: R[404] } },
  },

  '/api/v1/programmes/{id}/eligible/{fishermanId}': {
    get: { tags: ['Programmes'], summary: 'Explain one person\'s eligibility',
      description: 'Returns `eligible` plus the specific reasons for a refusal — a flat "not eligible" is not actionable for the officer at the desk.' + needs('benefit:allocate'),
      parameters: [idParam(), idParam('fishermanId', 'The candidate.')],
      responses: { 200: okJson('Eligibility decision with reasons.', { type: 'object', properties: {
        eligible: { type: 'boolean' },
        reasons: { type: 'array', items: { type: 'string' } },
        fisherman: { type: 'object' }, programme: { type: 'object' } } }),
        401: R[401], 403: R[403], 404: R[404] } },
  },

  '/api/v1/programmes/{id}/allocations': {
    post: { tags: ['Benefits'], summary: 'Allocate a benefit',
      description:
        'Records that a benefit has been assigned to a Blue ID holder.\n\n' +
        '**Protections, all enforced server-side:**\n' +
        '- One active allocation per person per programme — a database index, not a check.\n' +
        '- The beneficiary target is claimed atomically, so concurrent requests cannot over-allocate a budgeted programme.\n' +
        '- A Blue ID is required: no benefit may be recorded against an unverified record.\n' +
        '- `overrideEligibility` allows a documented exception, but it **cannot** reach a beneficiary who is DECEASED, SUSPENDED, INACTIVE or under duplicate review. No written reason lifts that floor.\n\n' +
        'This records an entitlement. **It moves no money** — there is no wallet or payment rail in this system.' + needs('benefit:allocate'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['fisherman'],
        properties: {
          fisherman: { type: 'string', format: 'objectid' },
          itemDescription: { type: 'string' }, quantity: { type: 'number' }, value: { type: 'number' },
          status: { type: 'string', enum: enumOf(ALLOCATION_STATUS) },
          notes: { type: 'string' },
          overrideEligibility: { type: 'boolean' },
          overrideReason: { type: 'string', minLength: 10, description: 'Required when overriding. Recorded in the audit trail.' } } } } } },
      responses: { 201: okJson('Allocation recorded.', ref('Allocation')),
        401: R[401], 403: R[403], 404: R[404],
        409: { description: 'Already allocated, or the programme is full.', content: { 'application/json': { schema: ref('ErrorEnvelope') } } },
        422: { description: 'Not eligible, or the beneficiary\'s status forbids allocation.', content: { 'application/json': { schema: ref('ErrorEnvelope') } } } } },
  },

  '/api/v1/programmes/allocations': {
    get: { tags: ['Benefits'], summary: 'List allocations',
      description: 'The "who received what, when, under which intervention" view.' + scopeNote + needs('fisherman:read'),
      parameters: [...pageParams,
        { name: 'programme', in: 'query', schema: { type: 'string', format: 'objectid' } },
        { name: 'fisherman', in: 'query', schema: { type: 'string', format: 'objectid' } },
        { name: 'blueId', in: 'query', schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: enumOf(ALLOCATION_STATUS) } },
        { name: 'programmeType', in: 'query', schema: { type: 'string', enum: enumOf(PROGRAMME_TYPES) } },
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }],
      responses: { 200: listJson('Allocations.', ref('Allocation')), 401: R[401], 403: R[403] } },
  },

  '/api/v1/programmes/allocations/{allocationId}/deliver': {
    post: { tags: ['Benefits'], summary: 'Record a delivery',
      description:
        'Marks the benefit delivered and captures proof of collection (a signature or photograph taken at handover).\n\n' +
        'This is the **only** way to reach `DELIVERED` — setting the status directly is refused, because it would skip the acknowledgement, the delivery timestamp and the counter.' + needs('benefit:deliver'),
      parameters: [idParam('allocationId')],
      requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: {
        acknowledgement: { type: 'string', format: 'binary', description: 'Signature or photo captured at handover.' },
        deliveredAt: { type: 'string', format: 'date-time' },
        receivedByName: { type: 'string' }, receivedByPhone: { type: 'string' },
        notes: { type: 'string' } } } } } },
      responses: { 200: okJson('Delivered.', ref('Allocation')), 401: R[401], 403: R[403], 404: R[404], 409: R[409] } },
  },

  '/api/v1/programmes/allocations/{allocationId}/status': {
    patch: { tags: ['Benefits'], summary: 'Approve, reject or revoke',
      description:
        'Transitions are enforced:\n\n' +
        '- `PENDING` → APPROVED, REJECTED, REVOKED\n' +
        '- `APPROVED` → REVOKED, REJECTED\n' +
        '- `DELIVERED` → REVOKED only\n' +
        '- `REJECTED` / `REVOKED` → **terminal**\n\n' +
        'DELIVERED is unreachable here by design — use the deliver endpoint so proof is captured.\n\n' +
        '**Separation of duties:** you cannot approve an allocation you raised. Revoking frees the slot so a corrected allocation can be made, and the original record is preserved.' + needs('benefit:approve'),
      parameters: [idParam('allocationId')],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'],
        properties: { status: { type: 'string', enum: enumOf(ALLOCATION_STATUS) },
          reason: { type: 'string', description: 'Required when rejecting or revoking.' } } } } } },
      responses: { 200: okJson('Status changed.', ref('Allocation')), 401: R[401], 403: R[403], 404: R[404], 409: R[409] } },
  },

  '/api/v1/programmes/beneficiaries/{fishermanId}': {
    get: { tags: ['Benefits'], summary: 'One person\'s benefit history',
      description: 'Everything this Blue ID holder has received, with totals by programme type.' + needs('fisherman:read'),
      parameters: [idParam('fishermanId')],
      responses: { 200: okJson('Benefit history.', { type: 'object', properties: {
        fisherman: { type: 'object' },
        allocations: { type: 'array', items: ref('Allocation') },
        summary: { type: 'object' } } }), 401: R[401], 403: R[403], 404: R[404] } },
  },

  // =========================================================================
  // Offline synchronisation
  // =========================================================================
  '/api/v1/sync/status': {
    get: { tags: ['Sync'], summary: 'Connectivity probe',
      description: 'Cheap check the field app makes before attempting a sync. Outside the sync rate limit.',
      responses: { 200: okJson('Server time and sync configuration.', { type: 'object' }), 401: R[401] } },
  },

  '/api/v1/sync/bootstrap': {
    get: { tags: ['Sync'], summary: 'Reference data for a field trip',
      description:
        'Communities, open programmes, cooperatives, the LGA list and the dropdown enumerations — everything the app caches so an enumerator can work all day with no network. Fetch once before travelling.',
      parameters: [
        { name: 'deviceCode', in: 'query', schema: { type: 'string' } },
        { name: 'x-device-secret', in: 'header', schema: { type: 'string' } }],
      responses: { 200: okJson('Offline reference data.', { type: 'object' }), 401: R[401], 403: R[403] } },
  },

  '/api/v1/sync/push': {
    post: { tags: ['Sync'], summary: 'Upload records captured offline',
      description:
        'Submits a batch of records captured without a network.\n\n' +
        '**Always returns 2xx when the batch is accepted for processing, even if individual records fail** — the per-record outcomes are the payload. A non-2xx would make the device retry the whole batch including records already stored.\n\n' +
        '**Idempotency.** `clientBatchId` identifies the push: re-sending it returns the original result rather than reprocessing. `clientRecordId` identifies each record: every write is an upsert on it, so a retry after a dropped connection updates the same row instead of creating a second fisherman.\n\n' +
        '**Device authentication is required** — the device code is an identifier, the secret is the credential (header `x-device-secret` or body `deviceSecret`).\n\n' +
        '**Nothing is lost.** Rejected records are retained server-side with their payload and field-level errors, retrievable from the rejected-records endpoint.\n\n' +
        'Records are applied fishermen-first, so assets can resolve their owner. An asset whose owner synced in an earlier batch is matched by `ownerClientRecordId`.' + needs('sync:submit'),
      parameters: [
        { name: 'x-device-id', in: 'header', schema: { type: 'string' } },
        { name: 'x-device-secret', in: 'header', schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('SyncPushRequest') } } },
      responses: {
        201: okJson('Batch processed.', ref('SyncPushResponse')),
        200: okJson('Batch replayed; the original result is returned.', ref('SyncPushResponse')),
        400: { description: 'Batch too large.' },
        401: { description: 'Missing or invalid device credentials.', content: { 'application/json': { schema: ref('ErrorEnvelope') } } },
        403: { description: 'Device suspended or revoked, or the role lacks sync:submit.' },
        409: { description: 'This batch is still being processed.' },
        429: R[429] } },
  },

  '/api/v1/sync/pull': {
    get: { tags: ['Sync'], summary: 'Download changes',
      description:
        'Returns records changed since the supplied cursors, plus tombstones for withdrawn records.\n\n' +
        '**Cursors are per entity.** Send back the `cursors` object from the previous pull. A single shared cursor would silently skip records, because entities drain at different rates.\n\n' +
        'Enumerators must present device credentials; portal roles need not.' + scopeNote + needs('fisherman:read'),
      parameters: [
        { name: 'cursors', in: 'query', schema: { type: 'string' },
          description: 'JSON object of per-entity cursors, e.g. {"FISHERMAN":"<cursor>"}. Omit for a first full sync.' },
        { name: 'since', in: 'query', schema: { type: 'string' }, description: 'Legacy single cursor, applied to every entity.' },
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
        { name: 'entities', in: 'query', schema: { type: 'array', items: { type: 'string', enum: enumOf(SYNC_ENTITIES) } } },
        { name: 'deviceCode', in: 'query', schema: { type: 'string' } },
        { name: 'x-device-secret', in: 'header', schema: { type: 'string' } }],
      responses: { 200: okJson('Changes since the cursors.', ref('SyncPullResponse')), 401: R[401], 403: R[403], 429: R[429] } },
  },

  '/api/v1/sync/devices': {
    get: { tags: ['Sync'], summary: 'List enrolled devices',
      description: needs('device:manage').trim(),
      parameters: [...pageParams,
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: enumOf(DEVICE_STATUS) } }],
      responses: { 200: listJson('Devices.', ref('Device')), 401: R[401], 403: R[403] } },
    post: { tags: ['Sync'], summary: 'Enrol a field device',
      description:
        'Registers a device and issues its sync secret.\n\n' +
        '**The secret is returned exactly once and is never retrievable again** — only its hash is stored. Record it at enrolment.' + needs('device:manage'),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['deviceCode'],
        properties: {
          deviceCode: { type: 'string', example: 'BAK-07', description: 'Short human-readable code, also used in the temporary field reference.' },
          label: { type: 'string' }, hardwareId: { type: 'string' },
          platform: { type: 'string', enum: ['ANDROID', 'IOS', 'WEB', 'OTHER'] },
          model: { type: 'string' }, osVersion: { type: 'string' }, appVersion: { type: 'string' },
          assignedTo: { type: 'string', format: 'objectid' },
          lga: { type: 'string', enum: LGA_CODES },
          communities: { type: 'array', items: { type: 'string', format: 'objectid' } } } } } } },
      responses: { 201: okJson('Enrolled. Store the secret now.', { type: 'object', properties: {
        device: ref('Device'), syncSecret: { type: 'string', description: 'Shown once.' } } }),
        401: R[401], 403: R[403], 409: R[409] } },
  },

  '/api/v1/sync/devices/{id}/revoke': {
    post: { tags: ['Sync'], summary: 'Revoke a device',
      description:
        'Clears the enrolment secret and marks the device revoked, so a lost or stolen tablet immediately stops submitting and pulling — without disturbing the enumerator\'s own account.' + needs('device:manage'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'],
        properties: { reason: { type: 'string', minLength: 3 } } } } } },
      responses: { 200: okJson('Revoked.', ref('Device')), 401: R[401], 403: R[403], 404: R[404] } },
  },

  '/api/v1/sync/batches': {
    get: { tags: ['Sync'], summary: 'Sync history',
      description: 'Batch receipts for monitoring device activity.' + needs('device:manage'),
      parameters: [...pageParams,
        { name: 'deviceCode', in: 'query', schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: enumOf(SYNC_BATCH_STATUS) } }],
      responses: { 200: listJson('Batches.', { type: 'object' }), 401: R[401], 403: R[403] } },
  },

  '/api/v1/sync/batches/{id}': {
    get: { tags: ['Sync'], summary: 'One batch receipt', parameters: [idParam()],
      description: needs('device:manage').trim(),
      responses: { 200: okJson('Batch.', { type: 'object' }), 401: R[401], 403: R[403], 404: R[404] } },
  },

  '/api/v1/sync/batches/{id}/rejected': {
    get: { tags: ['Sync'], summary: 'Records the server could not accept',
      description:
        'Returns each rejected payload with the reason it failed, so an operator can correct the capture and resubmit it as a new batch. This is what makes "no field data is lost" true in practice rather than only in the database.\n\nThe read is audited — it returns personal data that never passed validation.' + needs('device:manage'),
      parameters: [idParam()],
      responses: { 200: okJson('Rejected captures with reasons.', { type: 'object' }), 401: R[401], 403: R[403], 404: R[404] } },
  },

  // =========================================================================
  // Verification
  // =========================================================================
  '/api/v1/verify/{blueId}': {
    get: { tags: ['Verification'], summary: 'Verify a Blue ID',
      description:
        'Checks a Blue ID typed in by an official.\n\n' +
        '**Reachable without a session**, because the realistic scenario is an officer at a landing site on a device that is not signed in. Two things keep that safe: the anonymous response carries identity and status only (no photograph, no contact details, no benefit history), and the endpoint is rate limited per IP so the register cannot be walked by enumerating numbers.\n\n' +
        'A signed-in officer may add `detailed=true` for assets, cooperative, benefit history and programme eligibility.',
      security: [{}, { BearerAuth: [] }],
      parameters: [
        { name: 'blueId', in: 'path', required: true, schema: { type: 'string' }, example: 'CRS-BLU-BAK-0001' },
        { name: 'detailed', in: 'query', schema: { type: 'boolean' }, description: 'Ignored unless authenticated.' }],
      responses: { 200: okJson('Verification result. `found:false` for an unknown ID — this is not a 404.', ref('VerificationResult')), 429: R[429] } },
  },

  '/api/v1/verify/scan': {
    post: { tags: ['Verification'], summary: 'Verify a scanned QR code',
      description:
        'Validates a scanned card.\n\n' +
        'The HMAC is checked **first, offline and without a database hit**, so a forged or corrupted code is rejected before it can be used to probe the register. The payload carries an opaque token, not the Blue ID.\n\n' +
        'A card superseded by a reissue returns `CARD_SUPERSEDED` — a lost card stops working.',
      security: [{}, { BearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['payload'],
        properties: { payload: { type: 'string', description: 'The full scanned string or URL.' },
          detailed: { type: 'boolean' } } } } } },
      responses: { 200: okJson('Verification result.', ref('VerificationResult')), 429: R[429] } },
  },

  '/api/v1/verify/{blueId}/status-line': {
    get: { tags: ['Verification'], summary: 'One-line status for SMS/USSD',
      description:
        'Returns a single short line suitable for a 160-character message. Intended for a future SMS/USSD gateway so fishermen with basic handsets can confirm their Blue ID.\n\n' +
        'Machine-to-machine only: requires the service API key, and service credentials are **read-only**.',
      security: [{ ServiceApiKey: [] }],
      parameters: [{ name: 'blueId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: okJson('Status line.', { type: 'object', properties: {
        text: { type: 'string', example: 'CRS-BLU-BAK-0001: Effiom Okon, Abana. Status: Active.' },
        valid: { type: 'boolean' } } }), 401: R[401] } },
  },
};
