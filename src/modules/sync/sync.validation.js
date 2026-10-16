'use strict';

const { z } = require('zod');
const config = require('../../config');
const ApiError = require('../../utils/ApiError');
const { formatZodIssues } = require('../../middleware/validate');
const fishermanValidation = require('../fishermen/fisherman.validation');
const assetValidation = require('../assets/asset.validation');
const { SYNC_ENTITIES, DEVICE_STATUS, LGA_CODES, SYNC_BATCH_STATUS } = require('../../config/constants');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');
const uuid = z.string().uuid('Must be a UUID generated on the device');

const registerDevice = z.object({
  deviceCode: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and dashes only'),
  label: z.string().trim().max(120).optional(),
  hardwareId: z.string().trim().max(200).optional(),
  platform: z.enum(['ANDROID', 'IOS', 'WEB', 'OTHER']).optional(),
  model: z.string().trim().max(80).optional(),
  osVersion: z.string().trim().max(40).optional(),
  appVersion: z.string().trim().max(40).optional(),
  assignedTo: objectId.optional(),
  lga: z.enum(LGA_CODES).optional(),
  communities: z.array(objectId).max(50).optional(),
});

const revokeDevice = z.object({
  reason: z.string().trim().min(3, 'Give a reason for revoking this device').max(300),
});

/**
 * One record from the device's outbox.
 *
 * `data` is intentionally a passthrough object: it is validated by the
 * destination model's own schema during the write, so a field app running a
 * slightly older build is not rejected wholesale for sending an extra
 * property. Anything genuinely invalid comes back as a per-record rejection
 * with the field-level reason attached, which the app shows to the enumerator.
 */
const syncRecord = z.object({
  clientRecordId: uuid,
  entity: z.enum(Object.values(SYNC_ENTITIES)),
  operation: z.enum(['CREATE', 'UPDATE', 'DELETE']).default('CREATE'),
  /**
   * Accepted loosely HERE and validated per entity at apply time by
   * `sanitizeRecordData` below.
   *
   * The envelope stays permissive on purpose: a field app one version behind
   * must not have a whole batch rejected for an unrecognised property. The
   * allowlisting still happens — just per record, so an invalid one comes back
   * with field-level errors for the enumerator while the rest of the batch
   * commits.
   */
  data: z.object({}).passthrough(),
  capturedAt: z.coerce.date().optional(),
  /** Incremented by the device on each local edit; used to detect conflicts. */
  clientRevision: z.coerce.number().int().min(0).optional(),
  /** The server `updatedAt` the device last saw, for conflict detection. */
  baseUpdatedAt: z.coerce.date().optional(),
});

/**
 * Device-local references. A record captured offline cannot know the server
 * id of its owner, so it points at the owner's `clientRecordId` instead.
 */
const deviceRefs = {
  owner: objectId.optional(),
  ownerClientRecordId: uuid.optional(),
  boat: objectId.optional(),
  boatClientRecordId: uuid.optional(),
  fisherman: objectId.optional(),
  fishermanClientRecordId: uuid.optional(),
  /** Used only to LOCATE the owner; the server always rewrites it. */
  blueId: z.string().trim().max(40).optional(),
};

const withRefs = (schema) => schema.omit({ owner: true }).extend(deviceRefs);

/** What a device may send for an allocation captured at a distribution point. */
const allocationData = z.object({
  ...deviceRefs,
  programme: objectId,
  itemDescription: z.string().trim().max(300).optional(),
  quantity: z.coerce.number().min(0).max(100000).optional(),
  notes: z.string().trim().max(500).optional(),
  deliveredAt: z.coerce.date().optional(),
  receivedByName: z.string().trim().max(120).optional(),
  receivedByPhone: z.string().trim().max(20).optional(),
});

/**
 * Per-entity allowlists.
 *
 * These are the trust boundary for everything a device sends. Zod objects
 * strip unknown keys, so authority fields a client must never set — `blueId`,
 * `verification`, `status`, `duplicateFlags`, `verificationToken`, `match` —
 * simply do not survive parsing. Previously `data` was passed through
 * untouched into the model, and a device could assign itself a Blue ID that
 * the counter never issued.
 */
const ENTITY_SCHEMAS = {
  [SYNC_ENTITIES.FISHERMAN]: {
    CREATE: fishermanValidation.createFisherman,
    UPDATE: fishermanValidation.updateFisherman,
  },
  [SYNC_ENTITIES.BOAT]: {
    CREATE: withRefs(assetValidation.createBoat),
    UPDATE: withRefs(assetValidation.createBoat).partial(),
  },
  [SYNC_ENTITIES.ENGINE]: {
    CREATE: withRefs(assetValidation.createEngine),
    UPDATE: withRefs(assetValidation.createEngine).partial(),
  },
  [SYNC_ENTITIES.EQUIPMENT]: {
    CREATE: withRefs(assetValidation.createEquipment),
    UPDATE: withRefs(assetValidation.createEquipment).partial(),
  },
  [SYNC_ENTITIES.ALLOCATION]: {
    CREATE: allocationData,
    UPDATE: allocationData.partial(),
  },
};

/**
 * Validates and strips one record's payload.
 *
 * @throws {ApiError} 422 with field-level details, which `applyRecord` turns
 *   into a per-record REJECTED outcome rather than failing the batch.
 */
function sanitizeRecordData(entity, operation, data) {
  const schema = ENTITY_SCHEMAS[entity]?.[operation === 'UPDATE' ? 'UPDATE' : 'CREATE'];

  if (!schema) {
    throw ApiError.badRequest(`Unsupported entity for synchronisation: ${entity}`, {
      code: 'UNSUPPORTED_ENTITY',
    });
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw ApiError.unprocessable('This record failed validation', {
      code: 'RECORD_INVALID',
      details: formatZodIssues(parsed.error),
    });
  }

  return parsed.data;
}

const pushBatch = z.object({
  clientBatchId: uuid,
  deviceCode: z.string().trim().max(24).optional(),
  /** Enrolment secret; may also be sent as the x-device-secret header. */
  deviceSecret: z.string().trim().max(200).optional(),
  appVersion: z.string().trim().max(40).optional(),
  networkType: z.string().trim().max(20).optional(),
  capturedFrom: z.coerce.date().optional(),
  capturedTo: z.coerce.date().optional(),
  /**
   * Capped at the configured batch size so an over-large batch is rejected
   * with a field-level validation error, rather than passing validation and
   * then failing wholesale in the service.
   */
  records: z
    .array(syncRecord)
    .min(1, 'Send at least one record')
    .max(config.sync.maxBatchSize, `A batch may contain at most ${config.sync.maxBatchSize} records`),
});

const entityList = z
  .union([z.enum(Object.values(SYNC_ENTITIES)), z.array(z.enum(Object.values(SYNC_ENTITIES)))])
  .optional()
  .transform((v) => (v == null ? undefined : Array.isArray(v) ? v : [v]));

const pullChanges = z.object({
  /**
   * Per-entity cursors from the previous pull, as JSON:
   *   {"FISHERMAN":"<cursor>","BOAT":"<cursor>"}
   * Omit for a first full sync.
   */
  cursors: z
    .union([z.string(), z.record(z.string())])
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      if (typeof value !== 'string') return value;
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : undefined;
      } catch {
        return undefined;
      }
    }),
  /** Legacy single cursor, applied to every entity. */
  since: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(config.sync.maxBatchSize).optional(),
  deviceCode: z.string().trim().max(24).optional(),
  deviceSecret: z.string().trim().max(200).optional(),
  entities: entityList,
});

const bootstrapQuery = z.object({
  deviceCode: z.string().trim().max(24).optional(),
  deviceSecret: z.string().trim().max(200).optional(),
});

const listBatches = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  deviceCode: z.string().trim().max(24).optional(),
  status: z.enum(Object.values(SYNC_BATCH_STATUS)).optional(),
});

const listDevices = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  lga: z.enum(LGA_CODES).optional(),
  status: z.enum(Object.values(DEVICE_STATUS)).optional(),
});

const idParam = z.object({ id: objectId });

module.exports = {
  sanitizeRecordData,
  ENTITY_SCHEMAS,
  registerDevice,
  revokeDevice,
  pushBatch,
  pullChanges,
  bootstrapQuery,
  listBatches,
  listDevices,
  idParam,
};
