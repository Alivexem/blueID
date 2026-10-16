'use strict';

const base = require('./paths');
const { R, okJson, listJson, idParam, pageParams, ref, needs, scopeNote, enumOf } = base;
const { LGA_CODES, BOAT_TYPES, EQUIPMENT_TYPES, ACQUISITION_SOURCE, PROGRAMME_TYPES,
  PROGRAMME_STATUS, ALLOCATION_STATUS, SYNC_ENTITIES, AUDIT_ACTIONS, DEVICE_STATUS,
  SYNC_BATCH_STATUS, COMMUNITY_TYPES, FACILITY_KEYS, FISHERMAN_STATUS, GENDERS,
  FISHERMAN_TYPES } = require('../config/constants');

/** Boats, engines and equipment share one route shape. */
function assetPaths(kind, tag, schemaName, createProps) {
  const lower = kind.toLowerCase();
  return {
    [`/api/v1/${lower}s`]: {
      get: {
        tags: [tag], summary: `List ${lower}s`,
        description: `Assets are scoped to the caller like their owners are.${scopeNote}` + needs('fisherman:read'),
        parameters: [...pageParams,
          { name: 'owner', in: 'query', schema: { type: 'string', format: 'objectid' } },
          { name: 'blueId', in: 'query', schema: { type: 'string' } },
          { name: 'lga', in: 'query', schema: { type: 'string', enum: LGA_CODES } },
          { name: 'community', in: 'query', schema: { type: 'string', format: 'objectid' } },
          { name: 'isActive', in: 'query', schema: { type: 'boolean' } },
          { name: 'acquisitionSource', in: 'query', schema: { type: 'string', enum: enumOf(ACQUISITION_SOURCE) },
            description: 'Use GOVERNMENT_PROGRAMME to find assets issued through an intervention.' },
          ...(kind === 'BOAT' ? [{ name: 'boatType', in: 'query', schema: { type: 'string', enum: enumOf(BOAT_TYPES) } }] : []),
          ...(kind === 'ENGINE' ? [{ name: 'manufacturer', in: 'query', schema: { type: 'string' },
            description: 'Prefix match, so the index is used.' }] : []),
          ...(kind === 'EQUIPMENT' ? [{ name: 'type', in: 'query', schema: { type: 'string', enum: enumOf(EQUIPMENT_TYPES) } }] : []),
        ],
        responses: { 200: listJson(`${tag}.`, ref(schemaName)), 401: R[401], 403: R[403] },
      },
      post: {
        tags: [tag], summary: `Register a ${lower}`,
        description:
          `Attaches the ${lower} to a fisherman. The owner's Blue ID, LGA and community are copied onto the record, so listings and exports need no join.` +
          (kind === 'BOAT' ? '\n\nA registration number already recorded against a **different** owner returns 409 naming the existing holder — the actionable fact for an officer in the field.' : '') +
          (kind === 'ENGINE' ? '\n\nSerial numbers are unique state-wide. A clash returns 409 naming the current holder, which is how "was this engine already given to someone else?" gets answered.' : '') +
          needs('asset:manage'),
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
          required: ['owner', ...(kind === 'BOAT' ? ['boatType'] : kind === 'ENGINE' ? ['manufacturer'] : ['type'])],
          properties: createProps } } } },
        responses: { 201: okJson('Registered.', ref(schemaName)), 401: R[401], 403: R[403], 404: R[404], 409: R[409], 422: R[422] },
      },
    },

    [`/api/v1/${lower}s/{id}`]: {
      get: { tags: [tag], summary: `Get a ${lower}`, parameters: [idParam()],
        description: scopeNote.trim() + needs('fisherman:read'),
        responses: { 200: okJson(`The ${lower}.`, ref(schemaName)), 401: R[401], 403: R[403], 404: R[404] } },
      patch: { tags: [tag], summary: `Update a ${lower}`,
        description: 'Ownership cannot be changed here — use the transfer endpoint, so the move is recorded.' + needs('asset:manage'),
        parameters: [idParam()],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: createProps } } } },
        responses: { 200: okJson('Updated.', ref(schemaName)), 401: R[401], 403: R[403], 404: R[404], 409: R[409] } },
      delete: { tags: [tag], summary: `Withdraw a ${lower}`, parameters: [idParam()],
        description: 'Soft delete.' + needs('asset:manage'),
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'],
          properties: { reason: { type: 'string', minLength: 3 } } } } } },
        responses: { 204: { description: 'Withdrawn.' }, 401: R[401], 403: R[403], 404: R[404] } },
    },

    [`/api/v1/${lower}s/{id}/photo`]: {
      post: { tags: [tag], summary: `Upload a ${lower} photograph`,
        description: 'Multipart. Verified by magic bytes and stripped of EXIF before storage.' + needs('asset:manage'),
        parameters: [idParam()],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object',
          properties: { photo: { type: 'string', format: 'binary' } } } } } },
        responses: { 200: okJson('Uploaded.', { type: 'object', properties: { photo: ref('Media') } }),
          400: { description: 'Not a real image.' }, 401: R[401], 403: R[403], 404: R[404] } },
    },

    [`/api/v1/${lower}s/{id}/transfer`]: {
      post: { tags: [tag], summary: `Transfer a ${lower} to another owner`,
        description:
          `Boats and engines change hands often. Modelling the move explicitly — rather than letting someone edit the owner field — puts it in the audit trail, which matters when the asset was issued under a government programme and the ministry later asks where it went.` + needs('asset:transfer'),
        parameters: [idParam()],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
          required: ['newOwnerId', 'reason'],
          properties: { newOwnerId: { type: 'string', format: 'objectid' }, reason: { type: 'string', minLength: 3 } } } } } },
        responses: { 200: okJson('Transferred.', ref(schemaName)), 401: R[401], 403: R[403], 404: R[404] } },
    },
  };
}

const sharedAsset = {
  owner: { type: 'string', format: 'objectid' },
  community: { type: 'string', format: 'objectid' },
  condition: { type: 'string', enum: ['NEW', 'GOOD', 'FAIR', 'POOR', 'NOT_WORKING'] },
  yearAcquired: { type: 'integer' },
  acquisitionSource: { type: 'string', enum: enumOf(ACQUISITION_SOURCE) },
  allocation: { type: 'string', format: 'objectid' },
  estimatedValue: { type: 'number' },
  notes: { type: 'string' },
};

const paths = Object.assign(
  {},
  assetPaths('BOAT', 'Boats', 'Boat', {
    ...sharedAsset,
    registrationNumber: { type: 'string' }, name: { type: 'string' },
    boatType: { type: 'string', enum: enumOf(BOAT_TYPES) },
    canoeType: { type: 'string' },
    material: { type: 'string', enum: ['WOOD', 'FIBREGLASS', 'ALUMINIUM', 'STEEL', 'OTHER'] },
    lengthMeters: { type: 'number' }, widthMeters: { type: 'number' },
    crewCapacity: { type: 'integer' }, cargoCapacityKg: { type: 'number' },
    propulsion: { type: 'string', enum: ['PADDLE', 'SAIL', 'OUTBOARD_ENGINE', 'INBOARD_ENGINE'] },
  }),
  assetPaths('ENGINE', 'Engines', 'Engine', {
    ...sharedAsset,
    boat: { type: 'string', format: 'objectid' },
    manufacturer: { type: 'string' }, model: { type: 'string' },
    horsepower: { type: 'number' }, serialNumber: { type: 'string' },
    engineType: { type: 'string', enum: ['OUTBOARD', 'INBOARD'] },
    fuelType: { type: 'string', enum: ['PETROL', 'DIESEL', 'ELECTRIC', 'OTHER'] },
    lastServicedAt: { type: 'string', format: 'date' },
  }),
  assetPaths('EQUIPMENT', 'Equipment', 'Equipment', {
    ...sharedAsset,
    type: { type: 'string', enum: enumOf(EQUIPMENT_TYPES) },
    description: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string' },
    specification: { type: 'object', properties: {
      meshSizeInches: { type: 'number' }, lengthMeters: { type: 'number' },
      capacityLitres: { type: 'number' }, brand: { type: 'string' } } },
  }),
  {
    '/api/v1/assets/owner/{ownerId}': {
      get: {
        tags: ['Boats'], summary: 'Everything one fisherman owns',
        description: 'Boats, engines and equipment in a single call, for the profile view.' + needs('fisherman:read'),
        parameters: [idParam('ownerId', 'The fisherman.')],
        responses: { 200: okJson('Owned assets.', { type: 'object', properties: {
          owner: { type: 'object' },
          boats: { type: 'array', items: ref('Boat') },
          engines: { type: 'array', items: ref('Engine') },
          equipment: { type: 'array', items: ref('Equipment') } } }),
          401: R[401], 403: R[403], 404: R[404] },
      },
    },
  }
);

module.exports = paths;
