'use strict';

const Device = require('./device.model');
const SyncBatch = require('./syncBatch.model');
const Fisherman = require('../fishermen/fisherman.model');
const Boat = require('../assets/boat.model');
const Engine = require('../assets/engine.model');
const Equipment = require('../assets/equipment.model');
const Allocation = require('../programmes/allocation.model');
const Community = require('../communities/community.model');
const Programme = require('../programmes/programme.model');
const Cooperative = require('../cooperatives/cooperative.model');

const fishermanService = require('../fishermen/fisherman.service');
const blueIdService = require('../../services/blueId.service');
const auditService = require('../../services/audit.service');
const cache = require('../../services/cache.service');

const config = require('../../config');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');
const { andFilters } = require('../../utils/query');
const database = require('../../config/database');
const queue = require('../../services/queue.service');
const { encodeCursor, cursorFilter, CURSOR_SORT } = require('../../utils/pagination');
const { sanitizeRecordData } = require('./sync.validation');
const {
  SYNC_BATCH_STATUS,
  SYNC_RECORD_RESULT,
  SYNC_ENTITIES,
  DEVICE_STATUS,
  REGISTRATION_CHANNEL,
  AUDIT_ACTIONS,
  LGAS,
  ROLES,
  FISHERMAN_TYPES,
  FISHING_TYPES,
  BOAT_TYPES,
  PROPULSION_TYPES,
  EQUIPMENT_TYPES,
  ASSET_CONDITION,
  ACQUISITION_SOURCE,
  GENDERS,
  COMMUNITY_TYPES,
} = require('../../config/constants');

/**
 * Two-way synchronisation for the offline-first field application
 * (concept note §2, §4d, §12).
 *
 * The requirement is absolute: "No information should be lost because the
 * device temporarily loses connectivity", and "the system should prevent
 * duplicate records when synchronization occurs". Those two pull in opposite
 * directions — aggressive retrying protects against loss but risks duplicates.
 * The design resolves it with identifiers minted on the device:
 *
 *   clientRecordId  a UUID generated when the enumerator saves the record,
 *                   offline, before the server has ever seen it. Every write
 *                   is an upsert keyed on it, so a batch replayed after a
 *                   dropped connection updates the same row instead of
 *                   creating a second fisherman. A unique index enforces this
 *                   even if two devices race.
 *
 *   clientBatchId   identifies the push itself. A device that never received
 *                   our response re-sends; we return the stored result rather
 *                   than reprocessing.
 *
 * Records rejected by validation are kept on the batch with their original
 * payload, so a correction can be made from the portal and nothing captured in
 * the field is thrown away.
 */

const ENTITY_MODELS = {
  [SYNC_ENTITIES.FISHERMAN]: Fisherman,
  [SYNC_ENTITIES.BOAT]: Boat,
  [SYNC_ENTITIES.ENGINE]: Engine,
  [SYNC_ENTITIES.EQUIPMENT]: Equipment,
  [SYNC_ENTITIES.ALLOCATION]: Allocation,
};

// ---------------------------------------------------------------------------
// Device registration
// ---------------------------------------------------------------------------

/**
 * Registers a field device and issues its sync secret.
 * The plaintext secret is returned exactly once — it is only ever stored
 * hashed, so a dump of this collection does not let anyone impersonate a
 * device.
 */
async function registerDevice(payload, actor, options = {}) {
  const { req } = options;

  const existing = await Device.findOne({ deviceCode: payload.deviceCode.toUpperCase() });
  if (existing && existing.status !== DEVICE_STATUS.REVOKED) {
    throw ApiError.conflict('A device is already registered with that code', {
      code: 'DEVICE_CODE_TAKEN',
    });
  }

  const device = existing || new Device();
  Object.assign(device, {
    deviceCode: payload.deviceCode.toUpperCase(),
    label: payload.label,
    hardwareId: payload.hardwareId,
    platform: payload.platform || 'ANDROID',
    model: payload.model,
    osVersion: payload.osVersion,
      appVersion: payload.appVersion,
    assignedTo: payload.assignedTo || actor._id,
    lga: payload.lga,
    communities: payload.communities || [],
    status: DEVICE_STATUS.ACTIVE,
    registeredBy: actor._id,
    revokedAt: undefined,
    revokedReason: undefined,
  });

  const secret = device.issueSecret();
  await device.save();

  await auditService.record({
    action: AUDIT_ACTIONS.DEVICE_REGISTERED,
    entity: { type: 'Device', id: device._id, label: device.deviceCode },
    lga: device.lga,
    req,
  });

  return { device, secret };
}

async function revokeDevice(id, { reason }, actor, options = {}) {
  const { req } = options;
  const device = await Device.findById(id);
  if (!device) throw ApiError.notFound('Device not found');

  device.status = DEVICE_STATUS.REVOKED;
  device.revokedBy = actor._id;
  device.revokedAt = new Date();
  device.revokedReason = reason;
  device.secretHash = undefined;
  await device.save();

  await auditService.record({
    action: AUDIT_ACTIONS.DEVICE_REVOKED,
    entity: { type: 'Device', id: device._id, label: device.deviceCode },
    lga: device.lga,
    metadata: { reason },
    req,
  });

  return device;
}

/**
 * Resolves and AUTHENTICATES the device a sync request claims to come from.
 *
 * A device code alone is not a credential — it is printed on the tablet and
 * appears in exports. The enrolment secret issued at registration must be
 * presented with every sync call, which is what makes `revokeDevice` mean
 * something: clearing the hash immediately stops a lost tablet from
 * submitting, without disturbing the enumerator's own account.
 *
 * @param {string} deviceCode
 * @param {string} secret     plaintext enrolment secret from x-device-secret
 * @param {object} [options]  { require: boolean }
 */
async function resolveDevice(deviceCode, secret, options = {}) {
  const { require: mustHaveDevice = false } = options;

  if (!deviceCode) {
    if (mustHaveDevice) {
      throw ApiError.unauthorized('This endpoint requires an enrolled device', {
        code: 'DEVICE_REQUIRED',
      });
    }
    return null;
  }

  // secretHash is `select: false`; it must be requested explicitly.
  const device = await Device.findOne({ deviceCode: String(deviceCode).toUpperCase() }).select(
    '+secretHash'
  );

  if (!device) {
    throw ApiError.unauthorized('This device is not registered', {
      code: 'DEVICE_NOT_REGISTERED',
    });
  }
  if (device.status !== DEVICE_STATUS.ACTIVE) {
    throw ApiError.forbidden('This device has been suspended or revoked', {
      code: 'DEVICE_NOT_ACTIVE',
      details: { status: device.status },
    });
  }

  if (!device.secretHash) {
    throw ApiError.unauthorized('This device has no active enrolment — re-enrol it', {
      code: 'DEVICE_NOT_ENROLLED',
    });
  }
  if (!device.verifySecret(secret)) {
    logger.warn(
      { deviceCode: device.deviceCode },
      'Rejected a sync request presenting an invalid device secret'
    );
    throw ApiError.unauthorized('Invalid device credentials', {
      code: 'DEVICE_SECRET_INVALID',
    });
  }

  return device;
}

// ---------------------------------------------------------------------------
// Push — device to server
// ---------------------------------------------------------------------------

/**
 * Accepts a batch of records captured offline.
 *
 * Processing is per-record rather than all-or-nothing: one malformed
 * registration must not reject a day's work from a whole community. Each
 * record's outcome is reported back so the device can mark it synced, show the
 * enumerator a correction, or retry.
 */
async function push(payload, actor, options = {}) {
  const { req } = options;
  const { clientBatchId, records } = payload;

  if (records.length > config.sync.maxBatchSize) {
    throw ApiError.badRequest(
      `A batch may contain at most ${config.sync.maxBatchSize} records`,
      { code: 'BATCH_TOO_LARGE', details: { submitted: records.length } }
    );
  }

  // --- Replay protection ---------------------------------------------------
  const existingBatch = await SyncBatch.findOne({ clientBatchId });

  let abandonedBatch = null;
  if (existingBatch) {
    const resolved = resolveExistingBatch(existingBatch, clientBatchId);
    if (resolved) return resolved;
    // Abandoned mid-processing: reuse the row rather than creating a second
    // one, which would collide on the unique clientBatchId.
    abandonedBatch = existingBatch;
  }

  // Device enrolment is authenticated on every push — a device code is an
  // identifier, not a credential.
  const device = await resolveDevice(
    payload.deviceCode || req?.get('x-device-id'),
    payload.deviceSecret || req?.get('x-device-secret'),
    { require: true }
  );

  // One batch at a time per device, so two pushes cannot interleave and
  // produce half-linked owner references.
  const lock = await cache.acquireLock(`sync:${device?.deviceCode || actor._id}`, 120);
  if (!lock) {
    throw ApiError.conflict('Another synchronisation from this device is in progress', {
      code: 'SYNC_IN_PROGRESS',
    });
  }

  /**
   * Race-safe creation.
   *
   * Two concurrent pushes of the same batch both pass the check above, and
   * one then loses on the unique index. Surfacing that as a bare
   * DUPLICATE_KEY conflict told the device nothing useful; re-reading and
   * returning the winner's outcome is what it actually needs.
   */
  const batchFields = {
    clientBatchId,
    device: device?._id,
    deviceCode: device?.deviceCode,
    user: actor._id,
    direction: 'PUSH',
    status: SYNC_BATCH_STATUS.PROCESSING,
    counts: { submitted: records.length },
    appVersion: payload.appVersion,
    networkType: payload.networkType,
    capturedFrom: payload.capturedFrom,
    capturedTo: payload.capturedTo,
    requestId: req?.id,
    ipAddress: req?.ip,
  };

  let batch;
  try {
    if (abandonedBatch) {
      // Reset the reclaimed row and reprocess into it.
      Object.assign(abandonedBatch, batchFields, { startedAt: new Date(), results: [], error: undefined });
      batch = await abandonedBatch.save();
    } else {
      batch = await SyncBatch.create(batchFields);
    }
  } catch (err) {
    if (err.code === 11000) {
      // Another push won the race. Return its outcome rather than a bare
      // duplicate-key conflict, which tells the device nothing actionable.
      await lock.release();
      const winner = await SyncBatch.findOne({ clientBatchId });
      const resolved = winner && resolveExistingBatch(winner, clientBatchId);
      if (resolved) return resolved;
      throw ApiError.conflict('This batch is already being processed', {
        code: 'BATCH_IN_PROGRESS',
      });
    }
    await lock.release();
    throw err;
  }

  /**
   * Maps a device-local clientRecordId to the server _id created in this
   * batch. A boat captured offline references its owner by the owner's
   * clientRecordId, because the device never knew the server id — this is how
   * that reference is resolved.
   */
  const idMap = new Map();
  const results = [];

  try {
    // Fishermen first: assets and allocations depend on them existing.
    const ordered = [...records].sort(
      (a, b) => entityOrder(a.entity) - entityOrder(b.entity)
    );

    for (const record of ordered) {
      // eslint-disable-next-line no-await-in-loop -- records must apply in order
      const result = await applyRecord(record, { actor, device, batch, idMap, req });
      results.push(result);
      if (result.serverId && record.clientRecordId) {
        idMap.set(record.clientRecordId, result.serverId);
      }
    }

    const counts = tallyResults(results, records.length);
    batch.results = results;
    batch.counts = counts;
    batch.rejectedPayloads = records.filter((r) =>
      results.find((x) => x.clientRecordId === r.clientRecordId && x.result === SYNC_RECORD_RESULT.REJECTED)
    );
    batch.complete(
      counts.rejected === 0
        ? SYNC_BATCH_STATUS.COMPLETED
        : counts.rejected === records.length
          ? SYNC_BATCH_STATUS.FAILED
          : SYNC_BATCH_STATUS.PARTIAL
    );
    await batch.save();

    if (device) {
      device.lastSyncAt = new Date();
      device.lastSeenAt = new Date();
      device.stats.recordsPushed += counts.created + counts.updated;
      device.stats.batchesProcessed += 1;
      device.stats.lastBatchAt = new Date();
      await device.save();
    }

    await auditService.record({
      action: AUDIT_ACTIONS.SYNC_PUSH,
      entity: { type: 'SyncBatch', id: batch._id, label: clientBatchId },
      lga: device?.lga,
      metadata: counts,
      req,
    });
    await cache.bumpNamespace(cache.NS.DASHBOARD);

    // Follow-up work is queued, not done inline: the device is waiting for its
    // acknowledgement and must not pay for a mail round trip or an aggregate.
    if (counts.rejected > 0) {
      await queue.enqueueSafe(
        queue.JOB_TYPES.SYNC_FAILURE_NOTIFY,
        {
          deviceCode: device?.deviceCode,
          rejected: counts.rejected,
          batchId: String(batch._id),
          lga: device?.lga,
        },
        { dedupeKey: `sync-failure:${batch._id}`, req }
      );
    }
    if (counts.created > 0 && device?.lga) {
      await queue.enqueueSafe(
        queue.JOB_TYPES.COMMUNITY_STATS_RECALCULATE,
        { lga: device.lga },
        {
          // Coalesce to one recalculation per LGA per 10-minute window.
          dedupeKey: `community-stats:${device.lga}:${Math.floor(Date.now() / 600000)}`,
          priority: -1,
          req,
        }
      );
    }

    return { batch, replayed: false };
  } catch (err) {
    batch.status = SYNC_BATCH_STATUS.FAILED;
    batch.error = err.message;
    batch.results = results;
    batch.complete(SYNC_BATCH_STATUS.FAILED);
    await batch.save().catch(() => {});
    throw err;
  } finally {
    await lock.release();
  }
}

/**
 * How long a batch may sit in PROCESSING before it is treated as abandoned.
 *
 * A process killed mid-batch — OOM, eviction, SIGKILL — leaves the row at
 * PROCESSING with no error handler ever running. Without a timeout the device
 * received BATCH_IN_PROGRESS forever and could never resubmit, which is the
 * one outcome the offline design exists to prevent.
 *
 * Reprocessing an abandoned batch is safe because every per-record write is
 * an upsert on `clientRecordId`: records already committed are recognised and
 * updated, not duplicated.
 */
const ABANDONED_BATCH_MS = 10 * 60 * 1000;

/**
 * Decides what to do with a batch we have seen before.
 *
 * @returns the response to send, or null when the batch was abandoned and
 *   should be reprocessed.
 */
function resolveExistingBatch(batch, clientBatchId) {
  if (batch.status !== SYNC_BATCH_STATUS.PROCESSING) {
    logger.info({ clientBatchId }, 'Replayed sync batch — returning the stored result');
    return { batch, replayed: true };
  }

  const age = Date.now() - new Date(batch.startedAt || batch.createdAt).getTime();
  if (age < ABANDONED_BATCH_MS) {
    throw ApiError.conflict('This batch is still being processed', { code: 'BATCH_IN_PROGRESS' });
  }

  logger.warn(
    { clientBatchId, ageMs: age },
    'Reclaiming a batch abandoned mid-processing — records are idempotent, so it is safe to reprocess'
  );
  return null;
}

/** Fishermen before their assets, assets before allocations. */
function entityOrder(entity) {
  const order = {
    [SYNC_ENTITIES.FISHERMAN]: 0,
    [SYNC_ENTITIES.BOAT]: 1,
    [SYNC_ENTITIES.ENGINE]: 2,
    [SYNC_ENTITIES.EQUIPMENT]: 3,
    [SYNC_ENTITIES.ALLOCATION]: 4,
  };
  return order[entity] ?? 9;
}

/** Applies one record and returns its outcome. Never throws. */
async function applyRecord(record, context) {
  const { entity, clientRecordId } = record;
  const base = { clientRecordId, entity };

  try {
    const Model = ENTITY_MODELS[entity];
    if (!Model) {
      return { ...base, result: SYNC_RECORD_RESULT.REJECTED, message: `Unknown entity: ${entity}` };
    }

    const existing = await Model.findOne({ clientRecordId });

    /**
     * The device's payload is allowlisted here, per entity. Authority fields
     * (blueId, verification, status, duplicateFlags) are stripped before any
     * of it reaches a model — a device may report what it observed, never
     * what the register concluded.
     */
    const operation = existing ? 'UPDATE' : 'CREATE';
    const sanitized = sanitizeRecordData(entity, operation, record.data || {});
    const safeRecord = { ...record, data: sanitized };

    if (record.operation === 'DELETE') {
      return applyDelete(record, existing, context, base);
    }
    if (existing) {
      return applyUpdate(safeRecord, existing, context, base);
    }
    return applyCreate(safeRecord, context, base);
  } catch (err) {
    // A failure here is data we must not lose: report it, keep the payload.
    logger.warn({ err, clientRecordId, entity }, 'Sync record rejected');
    return {
      ...base,
      result: SYNC_RECORD_RESULT.REJECTED,
      message: err.message,
      validationErrors: normaliseValidationErrors(err),
    };
  }
}

async function applyCreate(record, context, base) {
  const { actor, device, idMap, req } = context;
  const data = resolveReferences(record.data, idMap);

  if (record.entity === SYNC_ENTITIES.FISHERMAN) {
    const { fisherman, duplicates } = await fishermanService.create(
      { ...data, clientRecordId: record.clientRecordId, capturedAt: record.capturedAt },
      actor,
      { req, channel: REGISTRATION_CHANNEL.MOBILE_OFFLINE, device }
    );

    fisherman.syncedAt = new Date();
    /**
     * Record the revision the client CLAIMED, and nothing more.
     *
     * This used to store `?? 1` when the device sent no revision, which
     * invented a version the client had never claimed. The update path then
     * held the device's own later edits stale against that invention —
     * `incoming (absent -> 0) <= server (1)` — so an app that does not keep a
     * revision counter could create records but never correct one. Every
     * subsequent edit came back CONFLICT, "the server copy is newer and has
     * been kept", forever, because the numbers could never cross.
     *
     * It is silent as far as the register is concerned: the push succeeds, the
     * batch completes, and the officer's correction is simply gone.
     *
     * `clientRevision` is optional in the schema and every model defaults it
     * to 0, so 0 is the honest value for "this client does not do revisions" —
     * and it is what the `serverRevision > 0` guard in applyUpdate was already
     * written to recognise.
     */
    fisherman.clientRevision = record.clientRevision ?? 0;
    if (!fisherman.tempReference) {
      fisherman.tempReference = blueIdService.temporaryReference(
        device?.deviceCode,
        record.clientRecordId
      );
    }
    await fisherman.save();

    return {
      ...base,
      result: duplicates.hasDuplicate
        ? SYNC_RECORD_RESULT.FLAGGED_DUPLICATE
        : SYNC_RECORD_RESULT.CREATED,
      serverId: fisherman._id,
      blueId: fisherman.blueId,
      tempReference: fisherman.tempReference,
      duplicateOf: duplicates.matches[0]?.candidateId,
      duplicateScore: duplicates.highestScore,
      message: duplicates.hasDuplicate
        ? 'Saved and held for duplicate review'
        : 'Saved, awaiting verification',
    };
  }

  const Model = ENTITY_MODELS[record.entity];
  const owner = await resolveOwner(data, idMap);

  const doc = await Model.create({
    ...data,
    ...(owner ? { owner: owner._id, blueId: owner.blueId, lga: owner.lga } : {}),
    clientRecordId: record.clientRecordId,
    device: device?._id,
    registeredBy: actor._id,
    capturedAt: record.capturedAt,
    syncedAt: new Date(),
    // Same reasoning as the fisherman branch above: store only what the
    // client claimed, so its own later edits are not judged stale.
    clientRevision: record.clientRevision ?? 0,
  });

  await auditService.recordChange({ action: AUDIT_ACTIONS.CREATE, doc, req, metadata: { viaSync: true } });

  return { ...base, result: SYNC_RECORD_RESULT.CREATED, serverId: doc._id, blueId: doc.blueId };
}

/**
 * Applies an update to a record the server already has.
 *
 * Conflicts are decided by `SYNC_CONFLICT_STRATEGY`. The default is
 * server_wins, because the server-side copy has usually been through
 * administrative verification, while the device's copy is raw field capture.
 * The device's version is never discarded silently — a CONFLICT outcome tells
 * the app to keep its copy and surface it.
 */
async function applyUpdate(record, existing, context, base) {
  const { actor, idMap, req } = context;
  const data = resolveReferences(record.data, idMap);

  const incomingRevision = record.clientRevision ?? 0;
  const serverRevision = existing.clientRevision ?? 0;

  /**
   * Conflict detection must not depend on the client opting in.
   *
   * It previously required `baseUpdatedAt`, so a device that simply omitted
   * the field never conflicted and always won — including against a record an
   * administrator had since verified. Two independent signals are now checked,
   * and either one is enough:
   *
   *   - the server copy changed after the point the device last saw, or
   *   - the server already holds a revision at or ahead of the incoming one.
   */
  const serverChangedSince = Boolean(
    record.baseUpdatedAt && existing.updatedAt > new Date(record.baseUpdatedAt)
  );
  const staleRevision = incomingRevision <= serverRevision && serverRevision > 0;

  if (serverChangedSince || staleRevision) {
    if (config.sync.conflictStrategy === 'server_wins') {
      return {
        ...base,
        result: SYNC_RECORD_RESULT.CONFLICT,
        serverId: existing._id,
        blueId: existing.blueId,
        message: 'The server copy is newer and has been kept',
      };
    }
    if (config.sync.conflictStrategy === 'manual') {
      return {
        ...base,
        result: SYNC_RECORD_RESULT.CONFLICT,
        serverId: existing._id,
        message: 'Conflicting edit — an administrator must resolve this record',
      };
    }
    // client_wins falls through and applies the device's version.
  }

  // A verified record's identity fields are authoritative; a late-arriving
  // offline edit must not quietly rewrite a Blue ID holder's details.
  if (record.entity === SYNC_ENTITIES.FISHERMAN && existing.blueId) {
    for (const field of ['firstName', 'lastName', 'nin', 'dateOfBirth', 'lga']) {
      delete data[field];
    }
  }

  const before = existing.toObject();
  Object.assign(existing, data, {
    syncedAt: new Date(),
    clientRevision: Math.max(incomingRevision, existing.clientRevision ?? 0),
  });
  await existing.save();

  await auditService.recordChange({
    action: AUDIT_ACTIONS.UPDATE,
    doc: existing,
    before,
    req,
    metadata: { viaSync: true, actor: actor._id },
  });

  return {
    ...base,
    result: SYNC_RECORD_RESULT.UPDATED,
    serverId: existing._id,
    blueId: existing.blueId,
  };
}

/**
 * Applies a deletion captured on the device.
 *
 * `operation` used to be accepted by the schema and then ignored entirely, so
 * a DELETE was silently applied as an UPDATE: the enumerator saw the record
 * disappear locally and believed it had propagated, while it stayed live in
 * the register.
 *
 * Deletion is deliberately narrow. A device may withdraw only its own
 * unverified capture — a mistaken double entry, typically. Anything verified,
 * or captured by someone else, needs an administrator, because removing a
 * Blue ID holder from the register is not a field decision.
 */
async function applyDelete(record, existing, context, base) {
  const { actor, req } = context;

  if (!existing) {
    // Nothing to remove: the device is ahead of us, which is a success.
    return {
      ...base,
      result: SYNC_RECORD_RESULT.DUPLICATE_IGNORED,
      message: 'Record not present on the server — nothing to delete',
    };
  }

  if (existing.blueId) {
    return {
      ...base,
      result: SYNC_RECORD_RESULT.REJECTED,
      serverId: existing._id,
      blueId: existing.blueId,
      message: 'A record holding a Blue ID can only be withdrawn by an administrator',
    };
  }

  if (existing.registeredBy && String(existing.registeredBy) !== String(actor._id)) {
    return {
      ...base,
      result: SYNC_RECORD_RESULT.REJECTED,
      serverId: existing._id,
      message: 'You can only withdraw a registration you captured',
    };
  }

  existing.isDeleted = true;
  existing.deletedAt = new Date();
  existing.deletedBy = actor._id;
  await existing.save();

  await auditService.record({
    action: AUDIT_ACTIONS.DELETE,
    entity: { type: record.entity, id: existing._id, label: existing.fullName },
    lga: existing.lga,
    metadata: { viaSync: true, clientRecordId: record.clientRecordId },
    req,
  });

  return { ...base, result: SYNC_RECORD_RESULT.UPDATED, serverId: existing._id, message: 'Withdrawn' };
}

/**
 * Rewrites device-local references into server ids.
 * `ownerClientRecordId` -> `owner`, `boatClientRecordId` -> `boat`.
 */
function resolveReferences(data = {}, idMap) {
  const resolved = { ...data };

  const mappings = [
    ['ownerClientRecordId', 'owner'],
    ['boatClientRecordId', 'boat'],
    ['fishermanClientRecordId', 'fisherman'],
  ];

  for (const [clientKey, serverKey] of mappings) {
    if (!resolved[clientKey]) continue;
    const mapped = idMap.get(resolved[clientKey]);
    if (mapped) {
      resolved[serverKey] = mapped;
      delete resolved[clientKey];
    }
    /**
     * An UNRESOLVED key is deliberately kept.
     *
     * Deleting it unconditionally meant a boat captured the day after its
     * owner — and therefore pushed in a later batch, where `idMap` no longer
     * holds the owner — lost its only link and was rejected as
     * OWNER_UNRESOLVED on every retry, permanently. `resolveOwner` now looks
     * the owner up by `clientRecordId`, which the server already stores.
     */
  }
  return resolved;
}

/** Finds the owning fisherman, by server id or by device-local id. */
async function resolveOwner(data, idMap) {
  let ownerId = data.owner || data.fisherman;

  if (!ownerId && data.ownerClientRecordId) {
    // Same batch first, then the register — the owner may have synced days ago.
    ownerId = idMap.get(data.ownerClientRecordId);

    if (!ownerId) {
      const byClientRecord = await Fisherman.findOne({
        clientRecordId: data.ownerClientRecordId,
        isDeleted: { $ne: true },
      })
        .select('_id blueId lga community')
        .lean();
      if (byClientRecord) return byClientRecord;
    }
  }
  if (!ownerId && data.blueId) {
    const byBlueId = await Fisherman.findOne({ blueId: String(data.blueId).toUpperCase() })
      .select('_id blueId lga')
      .lean();
    if (byBlueId) return byBlueId;
  }
  if (!ownerId) {
    throw ApiError.badRequest('The record does not identify which fisherman it belongs to', {
      code: 'OWNER_UNRESOLVED',
    });
  }

  const owner = await Fisherman.findById(ownerId).select('_id blueId lga').lean();
  if (!owner) {
    throw ApiError.badRequest('The fisherman this record belongs to could not be found', {
      code: 'OWNER_NOT_FOUND',
    });
  }
  return owner;
}

/**
 * Flattens whatever a failed write threw into `{ field, message }` pairs the
 * field app can render next to the offending input — a Mongoose validation
 * error, an ApiError carrying Zod issues, or neither.
 */
function normaliseValidationErrors(err) {
  if (err?.errors && typeof err.errors === 'object') {
    return Object.entries(err.errors).map(([field, detail]) => ({
      field,
      message: detail?.message || String(detail),
    }));
  }
  if (Array.isArray(err?.details)) {
    return err.details.map((d) => ({
      field: d.field || d.path || 'unknown',
      message: d.message || String(d),
    }));
  }
  return undefined;
}

function tallyResults(results, submitted) {
  const counts = {
    submitted,
    created: 0,
    updated: 0,
    duplicatesIgnored: 0,
    flaggedDuplicates: 0,
    conflicts: 0,
    rejected: 0,
  };
  const key = {
    [SYNC_RECORD_RESULT.CREATED]: 'created',
    [SYNC_RECORD_RESULT.UPDATED]: 'updated',
    [SYNC_RECORD_RESULT.DUPLICATE_IGNORED]: 'duplicatesIgnored',
    [SYNC_RECORD_RESULT.FLAGGED_DUPLICATE]: 'flaggedDuplicates',
    [SYNC_RECORD_RESULT.CONFLICT]: 'conflicts',
    [SYNC_RECORD_RESULT.REJECTED]: 'rejected',
  };
  for (const r of results) {
    const field = key[r.result];
    if (field) counts[field] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Pull — server to device
// ---------------------------------------------------------------------------

/**
 * Returns everything in the caller's scope that changed after `cursor`.
 *
 * Keyset paging on (updatedAt, _id) rather than page numbers: a device may
 * take many requests to drain a large change set, and offset paging would skip
 * records as new writes shift the window.
 */
async function pull(query, actor, options = {}) {
  const { req } = options;
  const limit = Math.min(query.limit || 100, config.sync.maxBatchSize);
  const entities = query.entities?.length ? query.entities : Object.values(SYNC_ENTITIES);

  /**
   * An enumerator pulls through the field application, so their device must
   * authenticate. Without this, revoking a lost tablet stopped it submitting
   * but not pulling — the register could still be drained onto it with the
   * officer's token alone. Portal roles read through the web UI and have no
   * device to present.
   */
  const deviceRequired = actor.role === ROLES.ENUMERATOR;
  const device =
    query.deviceCode || deviceRequired
      ? await resolveDevice(query.deviceCode, query.deviceSecret, { require: deviceRequired })
      : null;

  /**
   * Cursors are PER ENTITY. The device sends back the map it received; a bare
   * `since` string is accepted as a starting point for every entity so an
   * older client still works.
   */
  const incoming = parseCursors(query.cursors, query.since);

  const changes = {};
  const cursors = {};
  const hasMore = {};

  for (const entity of entities) {
    const Model = ENTITY_MODELS[entity];
    if (!Model) continue;

    const entityCursor = incoming[entity] ?? null;
    const scope = buildDeviceScope(actor, device, Model);

    const filter = andFilters(scope, cursorFilter(entityCursor), { isDeleted: { $ne: true } });

    // eslint-disable-next-line no-await-in-loop -- entities are read in turn
    const queryBuilder = Model.find(filter).sort(CURSOR_SORT).limit(limit + 1);
    if (entity === SYNC_ENTITIES.FISHERMAN) {
      // Never ship the matching keys or the encrypted NIN to a device.
      queryBuilder.select('-match -nin -verificationToken');
    }
    // eslint-disable-next-line no-await-in-loop
    const docs = await queryBuilder.lean();

    const page = docs.slice(0, limit);
    hasMore[entity] = docs.length > limit;
    changes[entity] = page;

    // Each entity advances only its own cursor.
    cursors[entity] = page.length
      ? encodeCursor({ updatedAt: page[page.length - 1].updatedAt, id: page[page.length - 1]._id })
      : entityCursor;
  }

  // Tombstones: a device must learn about records withdrawn since it last
  // synced, otherwise it keeps showing a deleted registration indefinitely.
  const deletions = await collectDeletions(entities, incoming, actor, device);

  if (device) {
    device.lastSeenAt = new Date();
    for (const [entity, cursor] of Object.entries(cursors)) {
      if (cursor) device.lastSyncCursors.set(entity, cursor);
    }
    device.stats.recordsPulled += Object.values(changes).reduce((n, arr) => n + arr.length, 0);
    await device.save();
  }

  await auditService.record({
    action: AUDIT_ACTIONS.SYNC_PULL,
    entity: { type: 'Device', id: device?._id, label: device?.deviceCode || 'portal' },
    metadata: {
      entities,
      counts: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.length])),
    },
    req,
  });

  return {
    changes,
    deletions,
    cursors,
    hasMore,
    /** True while any entity still has pages outstanding. */
    moreAvailable: Object.values(hasMore).some(Boolean),
    serverTime: new Date(),
  };
}

/**
 * Normalises the cursor input into `{ ENTITY: cursor }`.
 * Accepts the map a modern client returns, or a single legacy `since` string
 * applied to every entity.
 */
function parseCursors(cursors, since) {
  const result = {};

  if (cursors && typeof cursors === 'object') {
    for (const [entity, cursor] of Object.entries(cursors)) {
      if (typeof cursor === 'string' && cursor) result[entity] = cursor;
    }
  }

  if (since) {
    for (const entity of Object.values(SYNC_ENTITIES)) {
      if (!result[entity]) result[entity] = since;
    }
  }

  return result;
}

/** Tombstones since each entity's own cursor. */
async function collectDeletions(entities, incomingCursors, actor, device) {
  const { decodeCursor } = require('../../utils/pagination');
  const deletions = {};

  for (const entity of entities) {
    const Model = ENTITY_MODELS[entity];
    if (!Model) continue;

    const decoded = decodeCursor(incomingCursors[entity]);
    if (!decoded) continue; // first sync: nothing was ever sent, so nothing to retract

    const scope = buildDeviceScope(actor, device, Model);
    // eslint-disable-next-line no-await-in-loop
    const docs = await Model.find(
      andFilters(scope, { isDeleted: true, deletedAt: { $gt: decoded.updatedAt } })
    )
      .select('_id clientRecordId')
      .limit(500)
      .lean();

    if (docs.length) {
      deletions[entity] = docs.map((d) => ({ id: d._id, clientRecordId: d.clientRecordId }));
    }
  }

  return deletions;
}

/**
 * A device pulls only its own LGA/communities — not the whole state.
 *
 * The scope is built per MODEL, because the collections differ: `Engine` has
 * no `community` field, so filtering it by community matched nothing and
 * engines never reached a community-scoped device at all. Where the field is
 * absent we fall back to the LGA.
 */
function buildDeviceScope(actor, device, Model) {
  const { buildScopeFilter } = require('../../middleware/authorize');

  const hasField = (name) => Boolean(Model?.schema?.path(name));

  const userScope = buildScopeFilter(actor, {
    communityField: hasField('community') ? 'community' : null,
    ownerField: hasField('registeredBy') ? 'registeredBy' : null,
    cooperativeField: hasField('cooperative.id') ? 'cooperative.id' : null,
  });

  if (!device) return userScope;

  const deviceScope = {};
  if (device.communities?.length && hasField('community')) {
    deviceScope.community = { $in: device.communities };
  } else if (device.lga && hasField('lga')) {
    deviceScope.lga = device.lga;
  }

  return andFilters(userScope, deviceScope);
}

/**
 * Reference data the field app caches so an enumerator can work all day with
 * no network: communities, open programmes, cooperatives and the LGA list.
 * Fetched once at the start of a field trip and refreshed opportunistically.
 */
async function bootstrap(query, actor) {
  const device = query.deviceCode
    ? await resolveDevice(query.deviceCode, query.deviceSecret)
    : null;
  const lgaFilter = device?.lga ? { lga: device.lga } : {};

  const [communities, programmes, cooperatives] = await Promise.all([
    Community.find({ ...lgaFilter, isActive: true, isDeleted: { $ne: true } })
      .select('name lga ward type location landingSites facilities')
      .lean(),
    Programme.find({ status: 'OPEN', isDeleted: { $ne: true } })
      .select('name code type year itemDescription eligibility')
      .lean(),
    Cooperative.find({ ...lgaFilter, isActive: true, isDeleted: { $ne: true } })
      .select('name registrationNumber lga communityName')
      .lean(),
  ]);

  return {
    lgas: LGAS,
    communities,
    programmes,
    cooperatives,
    /**
     * Only the vocabularies the field app renders.
     *
     * This previously returned the entire constants module, which includes
     * ROLE_PERMISSIONS — the complete authorization matrix — to any
     * authenticated caller. A client needs the dropdown enums, not a map of
     * what every role in the system is allowed to do.
     */
    constants: {
      FISHERMAN_TYPES,
      FISHING_TYPES,
      BOAT_TYPES,
      PROPULSION_TYPES,
      EQUIPMENT_TYPES,
      ASSET_CONDITION,
      ACQUISITION_SOURCE,
      GENDERS,
      COMMUNITY_TYPES,
    },
    serverTime: new Date(),
    syncConfig: {
      maxBatchSize: config.sync.maxBatchSize,
      conflictStrategy: config.sync.conflictStrategy,
    },
  };
}

/** Sync history for a device, for the portal's monitoring view. */
async function listBatches(query, actor) {
  const { paginate, resolvePagination } = require('../../utils/pagination');
  const pagination = resolvePagination(query);
  const filter = {};
  if (query.deviceCode) filter.deviceCode = query.deviceCode.toUpperCase();
  if (query.status) filter.status = query.status;

  return paginate(SyncBatch, filter, pagination, {
    sort: { createdAt: -1 },
    populate: [{ path: 'user', select: 'firstName lastName role' }],
  });
}

/**
 * Returns the raw payloads of records this batch could not accept, paired
 * with the reason each failed.
 *
 * `rejectedPayloads` is stored `select: false` and was never selected by any
 * route, so the retained data was unreachable — the "nothing captured in the
 * field is lost" guarantee held in the database but not operationally. This
 * is the path that makes it real: an administrator retrieves the capture,
 * corrects it, and resubmits it as a new batch.
 *
 * The read is audited because it returns personal data that never passed
 * validation and therefore never entered the register.
 */
async function getRejectedRecords(id, actor, options = {}) {
  const { req } = options;

  const batch = await SyncBatch.findById(id)
    .select('+rejectedPayloads')
    .populate('device', 'deviceCode lga')
    .lean();

  if (!batch) throw ApiError.notFound('Sync batch not found');

  const failures = (batch.results || []).filter(
    (r) => r.result === SYNC_RECORD_RESULT.REJECTED
  );
  const reasons = new Map(failures.map((r) => [r.clientRecordId, r]));

  await auditService.record({
    action: AUDIT_ACTIONS.VIEW_SENSITIVE,
    entity: { type: 'SyncBatch', id: batch._id, label: batch.clientBatchId },
    lga: batch.device?.lga,
    metadata: { field: 'rejectedPayloads', count: failures.length },
    req,
  });

  return {
    batchId: batch._id,
    clientBatchId: batch.clientBatchId,
    deviceCode: batch.deviceCode,
    rejected: (batch.rejectedPayloads || []).map((payload) => {
      const outcome = reasons.get(payload.clientRecordId);
      return {
        clientRecordId: payload.clientRecordId,
        entity: payload.entity,
        capturedAt: payload.capturedAt,
        data: payload.data,
        reason: outcome?.message,
        validationErrors: outcome?.validationErrors,
      };
    }),
  };
}

async function getBatch(id) {
  const batch = await SyncBatch.findById(id)
    .populate('user', 'firstName lastName role')
    .populate('device', 'deviceCode label lga');
  if (!batch) throw ApiError.notFound('Sync batch not found');
  return batch;
}

async function listDevices(query) {
  const { paginate, resolvePagination } = require('../../utils/pagination');
  const pagination = resolvePagination(query);
  const filter = {};
  if (query.lga) filter.lga = query.lga;
  if (query.status) filter.status = query.status;

  return paginate(Device, filter, pagination, {
    sort: { lastSeenAt: -1 },
    populate: [{ path: 'assignedTo', select: 'firstName lastName email role' }],
  });
}

module.exports = {
  registerDevice,
  revokeDevice,
  listDevices,
  push,
  pull,
  bootstrap,
  listBatches,
  getBatch,
  getRejectedRecords,
};
