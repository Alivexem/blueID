'use strict';

const { R, okJson, listJson, idParam, pageParams, ref, needs, scopeNote, enumOf } = require('./paths');
const { LGA_CODES, COMMUNITY_TYPES, FACILITY_KEYS, AUDIT_ACTIONS, FISHERMAN_STATUS,
  GENDERS, FISHERMAN_TYPES, ALLOCATION_STATUS } = require('../config/constants');

module.exports = {
  // =========================================================================
  // Communities
  // =========================================================================
  '/api/v1/communities/reference': {
    get: { tags: ['Reference data'], summary: 'Flat community list',
      description: 'Lightweight list for dropdowns and offline caching. Cached server-side.',
      responses: { 200: okJson('Communities in scope.', { type: 'array', items: ref('Community') }), 401: R[401] } },
  },

  '/api/v1/communities': {
    get: { tags: ['Reference data'], summary: 'List fishing communities',
      description:
        'The `lacking` filter is how the infrastructure-gap questions are answered — e.g. `lacking=coldStorage` returns every community without cold storage.' + scopeNote,
      parameters: [...pageParams,
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'type', in: 'query', schema: { type: 'string', enum: enumOf(COMMUNITY_TYPES) } },
        { name: 'isActive', in: 'query', schema: { type: 'boolean' } },
        { name: 'search', in: 'query', schema: { type: 'string' } },
        { name: 'lacking', in: 'query', schema: { type: 'string', enum: [...FACILITY_KEYS] },
          description: 'Communities WITHOUT this facility.' },
        { name: 'has', in: 'query', schema: { type: 'string', enum: [...FACILITY_KEYS] } }],
      responses: { 200: listJson('Communities.', ref('Community')), 401: R[401], 403: R[403] } },
    post: { tags: ['Reference data'], summary: 'Add a community',
      description: needs('community:manage').trim(),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['name', 'lga'],
        properties: {
          name: { type: 'string' }, code: { type: 'string' },
          lga: { type: 'string', enum: LGA_CODES }, ward: { type: 'string' },
          type: { type: 'string', enum: enumOf(COMMUNITY_TYPES) },
          location: ref('GeoPoint'),
          landingSites: { type: 'array', items: { type: 'object' } },
          facilities: { type: 'object' }, accessibility: { type: 'object' },
          estimatedPopulation: { type: 'integer' }, estimatedFishermen: { type: 'integer' },
          developmentNeeds: { type: 'array', items: { type: 'string' } } } } } } },
      responses: { 201: okJson('Created.', ref('Community')), 401: R[401], 403: R[403], 409: R[409] } },
  },

  '/api/v1/communities/{id}': {
    get: { tags: ['Reference data'], summary: 'Get a community', parameters: [idParam()],
      description: 'Includes live registered-fishermen and boat counts.',
      responses: { 200: okJson('Community.', ref('Community')), 401: R[401], 403: R[403], 404: R[404] } },
    patch: { tags: ['Reference data'], summary: 'Update a community', parameters: [idParam()],
      description: needs('community:manage').trim(),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: okJson('Updated.', ref('Community')), 401: R[401], 403: R[403], 404: R[404] } },
    delete: { tags: ['Reference data'], summary: 'Remove a community',
      description: 'Refused while registered fishermen reference it — deactivate instead. State administrators only.',
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'],
        properties: { reason: { type: 'string' } } } } } },
      responses: { 204: { description: 'Removed.' }, 401: R[401], 403: R[403], 409: R[409] } },
  },

  '/api/v1/communities/recalculate-stats': {
    post: { tags: ['Reference data'], summary: 'Refresh community counters',
      description:
        'Queues a recalculation of the denormalised per-community counts. Returns **202** — the work runs in the background, because it aggregates across every community in scope and would otherwise hold a connection open for an unbounded time. State administrators only.',
      requestBody: { content: { 'application/json': { schema: { type: 'object',
        properties: { lga: { type: 'string', enum: LGA_CODES } } } } } },
      responses: { 202: okJson('Queued.', { type: 'object', properties: {
        jobId: { type: 'string', nullable: true }, queued: { type: 'boolean' } } }), 401: R[401], 403: R[403] } },
  },

  // =========================================================================
  // Cooperatives
  // =========================================================================
  '/api/v1/cooperatives': {
    get: { tags: ['Cooperatives'], summary: 'List cooperative societies',
      description: 'A cooperative officer only ever sees their own society.' + scopeNote,
      parameters: [...pageParams,
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'community', in: 'query', schema: { type: 'string', format: 'objectid' } },
        { name: 'isActive', in: 'query', schema: { type: 'boolean' } },
        { name: 'search', in: 'query', schema: { type: 'string' } }],
      responses: { 200: listJson('Cooperatives.', ref('Cooperative')), 401: R[401], 403: R[403] } },
    post: { tags: ['Cooperatives'], summary: 'Register a cooperative',
      description: needs('cooperative:manage').trim(),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['name', 'lga'],
        properties: {
          name: { type: 'string' }, registrationNumber: { type: 'string' },
          lga: { type: 'string', enum: LGA_CODES }, community: { type: 'string', format: 'objectid' },
          address: { type: 'string' }, registeredAt: { type: 'string', format: 'date' },
          officers: { type: 'array', items: { type: 'object' } },
          contactPhone: { type: 'string' }, contactEmail: { type: 'string', format: 'email' },
          bankDetails: { type: 'object', description: 'Bank name and account NAME only, plus the last four digits. Full account numbers are deliberately out of scope — this system issues no payments.' } } } } } },
      responses: { 201: okJson('Registered.', ref('Cooperative')), 401: R[401], 403: R[403], 409: R[409] } },
  },

  '/api/v1/cooperatives/{id}': {
    get: { tags: ['Cooperatives'], summary: 'Get a cooperative', parameters: [idParam()],
      responses: { 200: okJson('Cooperative.', ref('Cooperative')), 401: R[401], 403: R[403], 404: R[404] } },
    patch: { tags: ['Cooperatives'], summary: 'Update a cooperative', parameters: [idParam()],
      description: needs('cooperative:manage').trim(),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: okJson('Updated.', ref('Cooperative')), 401: R[401], 403: R[403], 404: R[404] } },
    delete: { tags: ['Cooperatives'], summary: 'Remove a cooperative',
      description: 'Refused while it still has members. State administrators only.',
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'],
        properties: { reason: { type: 'string' } } } } } },
      responses: { 204: { description: 'Removed.' }, 401: R[401], 403: R[403], 409: R[409] } },
  },

  '/api/v1/cooperatives/{id}/members': {
    get: { tags: ['Cooperatives'], summary: 'List members', parameters: [idParam(), ...pageParams],
      responses: { 200: listJson('Members.', ref('Fisherman')), 401: R[401], 403: R[403], 404: R[404] } },
    post: { tags: ['Cooperatives'], summary: 'Add a member',
      description: 'Refused if the fisherman already belongs to another society.' + needs('cooperative:manage'),
      parameters: [idParam()],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['fishermanId'],
        properties: { fishermanId: { type: 'string', format: 'objectid' }, membershipNumber: { type: 'string' } } } } } },
      responses: { 200: okJson('Added.', ref('Fisherman')), 401: R[401], 403: R[403], 404: R[404], 409: R[409] } },
  },

  '/api/v1/cooperatives/{id}/members/{fishermanId}': {
    delete: { tags: ['Cooperatives'], summary: 'Remove a member',
      parameters: [idParam(), idParam('fishermanId')],
      description: needs('cooperative:manage').trim(),
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } } },
      responses: { 204: { description: 'Removed.' }, 401: R[401], 403: R[403], 404: R[404] } },
  },

  '/api/v1/cooperatives/recount-members': {
    post: { tags: ['Cooperatives'], summary: 'Rebuild membership counts',
      description: 'Queues a rebuild of `memberCount` from the register. Returns 202. State administrators only.',
      responses: { 202: okJson('Queued.', { type: 'object' }), 401: R[401], 403: R[403] } },
  },

  // =========================================================================
  // Dashboard
  // =========================================================================
  '/api/v1/dashboard/summary': {
    get: { tags: ['Dashboard'], summary: 'Executive summary',
      description:
        'Headline figures: total registered, verified, awaiting verification, under duplicate review, by gender, by fisherman type and fishing type, boats, engines, cooperative members and interventions delivered.\n\n' +
        'Computed as a live aggregation rather than from maintained counters — a counter drifts, and a wrong number on a ministry dashboard is worse than a slow one. Cached briefly, keyed on the caller\'s scope so one LGA never sees another\'s figures.' + scopeNote + needs('dashboard:view'),
      parameters: [
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'community', in: 'query', schema: { type: 'string', format: 'objectid' } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }],
      responses: { 200: okJson('Summary figures.', { type: 'object' }), 401: R[401], 403: R[403] } },
  },

  '/api/v1/dashboard/communities': {
    get: { tags: ['Dashboard'], summary: 'Fishermen by community',
      description: 'Per-community breakdown with gender split, verified count, boat owners and boats.' + needs('dashboard:view'),
      parameters: [{ name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } }],
      responses: { 200: okJson('Community rows.', { type: 'array', items: { type: 'object' } }), 401: R[401], 403: R[403] } },
  },

  '/api/v1/dashboard/infrastructure-gaps': {
    get: { tags: ['Dashboard'], summary: 'Communities lacking facilities',
      description:
        'Which communities lack cold storage, landing sites, ice plants, processing facilities or boat repair — the list investment planning is built from. Each gap list is ordered by registered fishermen, so the biggest need surfaces first.' + needs('dashboard:view'),
      parameters: [{ name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } }],
      responses: { 200: okJson('Totals and per-facility gap lists.', { type: 'object' }), 401: R[401], 403: R[403] } },
  },

  '/api/v1/dashboard/trend': {
    get: { tags: ['Dashboard'], summary: 'Registration volume over time',
      description: needs('dashboard:view').trim(),
      parameters: [{ name: 'granularity', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'], default: 'month' } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } }],
      responses: { 200: okJson('Periods with registered and verified counts.', { type: 'array', items: { type: 'object' } }), 401: R[401], 403: R[403] } },
  },

  '/api/v1/dashboard/capacity': {
    get: { tags: ['Dashboard'], summary: 'Fisheries capacity by LGA',
      description: 'Answers "how much fishing capacity exists in each LGA?" — fishermen, boats, engines, total horsepower and estimated monthly catch.' + needs('dashboard:view'),
      parameters: [{ name: 'waterfrontOnly', in: 'query', schema: { type: 'boolean' },
        description: 'Restrict to the LGAs with a waterfront.' }],
      responses: { 200: okJson('Per-LGA capacity.', { type: 'array', items: { type: 'object' } }), 401: R[401], 403: R[403] } },
  },

  '/api/v1/dashboard/programmes': {
    get: { tags: ['Dashboard'], summary: 'Programme delivery performance',
      description: 'Allocation and delivery rates against target per intervention.' + needs('dashboard:view'),
      parameters: [{ name: 'year', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: okJson('Programme performance.', { type: 'array', items: { type: 'object' } }), 401: R[401], 403: R[403] } },
  },

  '/api/v1/dashboard/enumerators': {
    get: { tags: ['Dashboard'], summary: 'Enumerator productivity',
      description: 'Registrations, verified count, flagged count and last activity per field officer. Management information, so it needs the audit grant.' + needs('audit:read'),
      parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } }],
      responses: { 200: okJson('Per-enumerator activity.', { type: 'array', items: { type: 'object' } }), 401: R[401], 403: R[403] } },
  },

  // =========================================================================
  // GIS
  // =========================================================================
  '/api/v1/gis/communities': {
    get: { tags: ['GIS'], summary: 'Community map layer',
      description:
        'GeoJSON FeatureCollection of mapped fishing communities, each carrying its statistics and a `missingFacilities` list for styling. Drops straight into Leaflet, Mapbox or QGIS.' + scopeNote + needs('dashboard:view'),
      parameters: [{ name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } }],
      responses: { 200: okJson('GeoJSON FeatureCollection.', { type: 'object' }), 401: R[401], 403: R[403] } },
  },

  '/api/v1/gis/communities/{id}': {
    get: { tags: ['GIS'], summary: 'Community detail panel',
      description: 'The click-through statistics for one community: fishermen by gender, type and fishing type, boats, engines, catch estimate and infrastructure present/missing.' + needs('dashboard:view'),
      parameters: [idParam()],
      responses: { 200: okJson('Community statistics.', { type: 'object' }), 401: R[401], 403: R[403], 404: R[404] } },
  },

  '/api/v1/gis/registration-points': {
    get: { tags: ['GIS'], summary: 'Registration density layer',
      description:
        'Anonymised GeoJSON points for a heat/density layer. Returns **coordinates only** — no names, Blue IDs or contact details. A map layer does not need to identify anyone, and shipping the register to the browser for every pin would be an unnecessary exposure.' + needs('dashboard:view'),
      parameters: [{ name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 10000 } }],
      responses: { 200: okJson('Anonymised FeatureCollection.', { type: 'object' }), 401: R[401], 403: R[403] } },
  },

  '/api/v1/gis/nearby': {
    get: { tags: ['GIS'], summary: 'Communities near a point',
      description: 'Geospatial search — "what is near this landing site?". Returns distance in kilometres.' + needs('dashboard:view'),
      parameters: [
        { name: 'longitude', in: 'query', required: true, schema: { type: 'number' } },
        { name: 'latitude', in: 'query', required: true, schema: { type: 'number' } },
        { name: 'radiusKm', in: 'query', schema: { type: 'number', default: 10, maximum: 200 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }],
      responses: { 200: okJson('Nearby communities with distances.', { type: 'array', items: { type: 'object' } }), 401: R[401], 403: R[403] } },
  },

  // =========================================================================
  // Reports
  // =========================================================================
  '/api/v1/reports/register.csv': {
    get: { tags: ['Reports'], summary: 'Export the register (CSV)',
      description:
        'Streamed so a state-wide export does not build in memory. Capped at 100,000 rows.\n\n' +
        'Cells beginning with `=`, `+`, `-` or `@` are prefixed with an apostrophe, because these files are opened in Excel and would otherwise be interpreted as formulas.\n\n' +
        '**NINs are never exported.** Every export is audited with its filters and row count.' + needs('report:export'),
      parameters: [
        { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
        { name: 'community', in: 'query', schema: { type: 'string', format: 'objectid' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: enumOf(FISHERMAN_STATUS) } },
        { name: 'gender', in: 'query', schema: { type: 'string', enum: enumOf(GENDERS) } },
        { name: 'fishermanType', in: 'query', schema: { type: 'string', enum: enumOf(FISHERMAN_TYPES) } },
        { name: 'hasBlueId', in: 'query', schema: { type: 'boolean' } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }],
      responses: { 200: { description: 'CSV stream.', content: { 'text/csv': { schema: { type: 'string' } } } },
        401: R[401], 403: R[403], 429: R[429] } },
  },

  '/api/v1/reports/register.xlsx': {
    get: { tags: ['Reports'], summary: 'Export the register (Excel)',
      description: 'Streamed workbook with a frozen header and an **About** sheet recording who generated it, when, and under which filters — so the file is self-describing when it is passed around.' + needs('report:export'),
      parameters: [{ name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } }],
      responses: { 200: { description: 'XLSX stream.',
        content: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } } } },
        401: R[401], 403: R[403], 429: R[429] } },
  },

  '/api/v1/reports/statistics.xlsx': {
    get: { tags: ['Reports'], summary: 'Statistical workbook',
      description: 'Multi-sheet analysis: Summary, By Community, Capacity by LGA and Infrastructure Gaps.' + needs('report:export'),
      parameters: [{ name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } }],
      responses: { 200: { description: 'XLSX stream.' }, 401: R[401], 403: R[403], 429: R[429] } },
  },

  '/api/v1/reports/summary.pdf': {
    get: { tags: ['Reports'], summary: 'Executive summary (PDF)',
      description: 'Branded one-document summary with headline tiles and a capacity table, for circulation inside the ministry. Every page carries a confidentiality footer.' + needs('report:export'),
      parameters: [{ name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } }],
      responses: { 200: { description: 'PDF stream.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
        401: R[401], 403: R[403], 429: R[429] } },
  },

  '/api/v1/reports/boats.csv': {
    get: { tags: ['Reports'], summary: 'Boat register (CSV)',
      description: needs('report:export').trim(),
      parameters: [{ name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } }],
      responses: { 200: { description: 'CSV stream.' }, 401: R[401], 403: R[403] } },
  },

  '/api/v1/reports/engines.csv': {
    get: { tags: ['Reports'], summary: 'Engine register (CSV)',
      description: needs('report:export').trim(),
      parameters: [{ name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } }],
      responses: { 200: { description: 'CSV stream.' }, 401: R[401], 403: R[403] } },
  },

  '/api/v1/reports/programmes/{id}/beneficiaries.csv': {
    get: { tags: ['Reports'], summary: 'Beneficiary list (CSV)',
      description: 'The document a distribution exercise is run from, and the record of who received what.' + needs('report:export'),
      parameters: [idParam(), { name: 'status', in: 'query', schema: { type: 'string', enum: enumOf(ALLOCATION_STATUS) } }],
      responses: { 200: { description: 'CSV stream.' }, 401: R[401], 403: R[403], 404: R[404] } },
  },

  // =========================================================================
  // Media
  // =========================================================================
  '/api/v1/media/signed-url': {
    get: { tags: ['Media'], summary: 'Short-lived URL for a stored image',
      description:
        'Images are stored with `authenticated` delivery, so a stored URL expires and must be re-minted.\n\n' +
        'You name a **record**, not a storage id — the server authorises the record and supplies the asset id from it. Accepting a caller-supplied id would let anyone read a photograph in an LGA they cannot access, because storage ids are predictable. The read is audited.' + needs('fisherman:read'),
      parameters: [
        { name: 'kind', in: 'query', required: true, schema: { type: 'string', enum: ['FISHERMAN', 'BOAT', 'ENGINE', 'EQUIPMENT', 'ALLOCATION'] } },
        { name: 'id', in: 'query', required: true, schema: { type: 'string', format: 'objectid' } },
        { name: 'expiresIn', in: 'query', schema: { type: 'integer', minimum: 60, maximum: 3600, default: 600 } }],
      responses: { 200: okJson('Signed URL.', { type: 'object', properties: {
        url: { type: 'string' }, expiresIn: { type: 'integer' } } }), 401: R[401], 403: R[403], 404: R[404] } },
  },

  '/api/v1/media/file/{publicId}': {
    get: { tags: ['Media'], summary: 'Fetch a stored image', security: [],
      description:
        'Serves the image bytes. **Only reachable with a valid signature** from `/media/signed-url`.\n\n' +
        'This endpoint takes no bearer token on purpose: a browser rendering `<img src>` sends no `Authorization` header, so the HMAC in the query string is the authorisation. It is minted only after the caller has been authorised against the record the image belongs to, and expires in minutes.\n\n' +
        'A missing, altered, expired or reused signature returns **404, not 403** — a 403 would confirm an image exists at that path, which is a membership oracle over the register.\n\n' +
        'Only present when the deployment stores media locally (`MEDIA_DRIVER=local`).',
      parameters: [
        { name: 'publicId', in: 'path', required: true, schema: { type: 'string' },
          description: 'Storage path, e.g. `fishermen/BAK/3f/CRS-BLU-BAK-000123.jpg`. Taken from the signed URL, never constructed by hand.' },
        { name: 'e', in: 'query', required: true, schema: { type: 'integer' }, description: 'Expiry, Unix seconds.' },
        { name: 's', in: 'query', required: true, schema: { type: 'string' }, description: 'base64url HMAC-SHA256 signature.' }],
      responses: {
        200: { description: 'The image.', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
        404: { description: 'No such image, or the signature is absent, altered or expired.' } } },
  },

  '/api/v1/media/upload-signature': {
    post: { tags: ['Media'], summary: 'Credentials for a device upload',
      description:
        'Returns what the field app needs to upload a photograph. **Branch on `strategy`:**\n\n' +
        '- `api-upload` (local storage, the default) — this server is the store. POST the image to the returned `uploadUrl` with a bearer token.\n' +
        '- `direct` (Cloudinary) — upload straight to the returned `uploadUrl` with the signature supplied, keeping a day of photographs off this API.\n\n' +
        'The target id is derived server-side from the authorised record, so an upload cannot be aimed at someone else\'s asset.' + needs('fisherman:edit'),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['kind', 'id'],
        properties: { kind: { type: 'string', enum: ['FISHERMAN', 'BOAT', 'ENGINE', 'EQUIPMENT', 'ALLOCATION'] },
          id: { type: 'string', format: 'objectid' } } } } } },
      responses: { 200: okJson('Upload parameters and signature.', { type: 'object' }), 401: R[401], 403: R[403], 404: R[404] } },
  },

  '/api/v1/media/upload': {
    post: { tags: ['Media'], summary: 'Server-side image upload',
      description: 'Used by the web portal, where the file is already in a form post. Magic-byte checked and EXIF-stripped.' + needs('fisherman:edit'),
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object',
        properties: { file: { type: 'string', format: 'binary' },
          kind: { type: 'string', enum: ['FISHERMAN', 'BOAT', 'ENGINE', 'EQUIPMENT', 'ALLOCATION'] },
          id: { type: 'string', format: 'objectid' } } } } } },
      responses: { 200: okJson('Uploaded.', ref('Media')), 400: { description: 'Not a real image.' },
        401: R[401], 403: R[403], 404: R[404] } },
  },

  // =========================================================================
  // Audit
  // =========================================================================
  '/api/v1/audit': {
    get: { tags: ['Audit'], summary: 'Search the audit trail',
      description:
        'Append-only record of who did what. Includes **denied** attempts — a 401 or 403 writes a FAILURE entry, so an attempted intrusion is evidence rather than silence.\n\n' +
        'Administrators see activity in their own LGAs; state-wide roles see everything.' + needs('audit:read'),
      parameters: [...pageParams,
        { name: 'action', in: 'query', schema: { type: 'string', enum: enumOf(AUDIT_ACTIONS) } },
        { name: 'entityType', in: 'query', schema: { type: 'string', example: 'Fisherman' } },
        { name: 'entityId', in: 'query', schema: { type: 'string', format: 'objectid' } },
        { name: 'blueId', in: 'query', schema: { type: 'string' } },
        { name: 'userId', in: 'query', schema: { type: 'string', format: 'objectid' } },
        { name: 'outcome', in: 'query', schema: { type: 'string', enum: ['SUCCESS', 'FAILURE'] } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } }],
      responses: { 200: listJson('Audit entries.', ref('AuditEntry')), 401: R[401], 403: R[403] } },
  },

  '/api/v1/audit/{entityType}/{entityId}': {
    get: { tags: ['Audit'], summary: 'Full history of one record',
      description: 'Every recorded change to a single record, newest first — the "who changed this" view.' + needs('audit:read'),
      parameters: [
        { name: 'entityType', in: 'path', required: true, schema: { type: 'string' }, example: 'Fisherman' },
        idParam('entityId'),
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200, default: 50 } }],
      responses: { 200: okJson('History.', { type: 'array', items: ref('AuditEntry') }), 401: R[401], 403: R[403] } },
  },
};
