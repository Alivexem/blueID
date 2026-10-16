'use strict';

const Boat = require('./boat.model');
const Engine = require('./engine.model');
const Equipment = require('./equipment.model');
const Fisherman = require('../fishermen/fisherman.model');

const duplicateService = require('../../services/duplicate.service');
const auditService = require('../../services/audit.service');
const mediaService = require('../../services/media.service');
const cache = require('../../services/cache.service');

const ApiError = require('../../utils/ApiError');
const { paginate, resolvePagination } = require('../../utils/pagination');
const {
  buildScopeFilter,
  assertCanAccessRecord,
  assertCanAccessLga,
} = require('../../middleware/authorize');
const { andFilters } = require('../../utils/query');
const { AUDIT_ACTIONS } = require('../../config/constants');

/**
 * Boats, engines and fishing equipment (concept note §4c).
 *
 * All three share a shape — they belong to a Blue ID holder, they carry an
 * LGA for scoping, and they may have arrived through a government programme —
 * so one service handles them generically rather than three near-identical
 * copies. `kind` selects the collection.
 */

const MODELS = { BOAT: Boat, ENGINE: Engine, EQUIPMENT: Equipment };
const LABELS = { BOAT: 'Boat', ENGINE: 'Engine', EQUIPMENT: 'Equipment' };

function modelFor(kind) {
  const Model = MODELS[kind];
  if (!Model) throw ApiError.badRequest(`Unknown asset type: ${kind}`);
  return Model;
}

/** Loads the owner and confirms the caller may write to their LGA. */
async function loadOwner(ownerId, actor) {
  const owner = await Fisherman.findOne({ _id: ownerId, isDeleted: { $ne: true } })
    .select('_id blueId lga community fullName status')
    .lean();
  if (!owner) throw ApiError.notFound('Fisherman not found');
  assertCanAccessLga(actor, owner.lga);
  return owner;
}

/**
 * Registers an asset against a fisherman.
 *
 * Boat registration numbers and engine serial numbers are unique state-wide,
 * so a conflict here usually means the item is already recorded against
 * someone else — the response names the existing holder rather than returning
 * a bare duplicate-key error, because that is the actionable fact for the
 * officer on the ground.
 */
async function create(kind, payload, actor, options = {}) {
  const { req, device = null } = options;
  const Model = modelFor(kind);
  const owner = await loadOwner(payload.owner, actor);

  if (kind === 'BOAT' && payload.registrationNumber) {
    await assertAssetIdentifierFree({
      boatRegistrationNumber: payload.registrationNumber,
      ownerId: owner._id,
    });
  }
  if (kind === 'ENGINE' && payload.serialNumber) {
    await assertAssetIdentifierFree({ engineSerialNumber: payload.serialNumber, ownerId: owner._id });
  }

  const doc = await Model.create({
    ...payload,
    owner: owner._id,
    blueId: owner.blueId,
    lga: owner.lga,
    community: payload.community || owner.community,
    registeredBy: actor._id,
    device: device?._id,
    syncedAt: new Date(),
  });

  await auditService.recordChange({ action: AUDIT_ACTIONS.CREATE, doc, req });
  await cache.bumpNamespace(cache.NS.DASHBOARD);

  return doc;
}

/** Raises a conflict naming the current holder of a unique asset identifier. */
async function assertAssetIdentifierFree({ boatRegistrationNumber, engineSerialNumber, ownerId }) {
  const conflicts = await duplicateService.findAssetConflicts({
    boatRegistrationNumber,
    engineSerialNumber,
    excludeOwnerId: ownerId,
  });
  if (!conflicts.length) return;

  const conflict = conflicts[0];
  throw ApiError.conflict(
    conflict.type === 'ENGINE_SERIAL'
      ? 'That engine serial number is already registered to another fisherman'
      : 'That boat registration number is already registered to another fisherman',
    {
      code: 'ASSET_ALREADY_REGISTERED',
      details: { ...conflict },
    }
  );
}

async function list(kind, query, actor) {
  const Model = modelFor(kind);
  const pagination = resolvePagination(query);

  const scope = buildScopeFilter(actor, {
    ownerField: 'registeredBy',
    cooperativeField: null,
  });
  const direct = { isDeleted: { $ne: true } };

  if (query.owner) direct.owner = query.owner;
  if (query.blueId) direct.blueId = query.blueId.toUpperCase();
  if (query.lga) {
    assertCanAccessLga(actor, query.lga);
    direct.lga = query.lga;
  }
  if (query.community) direct.community = query.community;
  if (query.isActive != null) direct.isActive = query.isActive;
  if (kind === 'BOAT' && query.boatType) direct.boatType = query.boatType;
  if (kind === 'ENGINE' && query.manufacturer) {
    // Anchored: an unanchored regex cannot use the {lga, manufacturer} index
    // and degrades into a collection scan.
    direct.manufacturer = new RegExp(`^${escapeRegex(query.manufacturer)}`, 'i');
  }
  if (kind === 'EQUIPMENT' && query.type) direct.type = query.type;
  if (query.acquisitionSource) direct.acquisitionSource = query.acquisitionSource;

  return paginate(Model, andFilters(scope, direct), pagination, {
    sort: { createdAt: -1 },
    populate: [{ path: 'owner', select: 'fullName blueId lga communityName phone' }],
  });
}

async function getById(kind, id, actor) {
  const Model = modelFor(kind);
  const doc = await Model.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate('owner', 'fullName blueId lga communityName phone status')
    .populate('allocation', 'programmeCode itemDescription allocatedAt status');
  if (!doc) throw ApiError.notFound(`${LABELS[kind]} not found`);
  assertCanAccessRecord(actor, doc, { cooperativeField: null });

  const result = doc.toJSON();
  if (result.photo?.publicId) result.photo = mediaService.withSignedUrl(result.photo);
  return result;
}

async function update(kind, id, payload, actor, options = {}) {
  const { req } = options;
  const Model = modelFor(kind);
  const doc = await Model.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!doc) throw ApiError.notFound(`${LABELS[kind]} not found`);
  assertCanAccessRecord(actor, doc, { cooperativeField: null });

  if (kind === 'BOAT' && payload.registrationNumber && payload.registrationNumber !== doc.registrationNumber) {
    await assertAssetIdentifierFree({
      boatRegistrationNumber: payload.registrationNumber,
      ownerId: doc.owner,
    });
  }
  if (kind === 'ENGINE' && payload.serialNumber && payload.serialNumber !== doc.serialNumber) {
    await assertAssetIdentifierFree({ engineSerialNumber: payload.serialNumber, ownerId: doc.owner });
  }

  const before = doc.toObject();
  // Ownership moves are a transfer, not an edit — see `transfer`.
  delete payload.owner;
  delete payload.blueId;
  Object.assign(doc, payload);
  await doc.save();

  await auditService.recordChange({ action: AUDIT_ACTIONS.UPDATE, doc, before, req });
  await cache.bumpNamespace(cache.NS.DASHBOARD);

  return doc;
}

/**
 * Transfers an asset to another fisherman.
 *
 * Boats and engines change hands often. Modelling it explicitly — rather than
 * letting someone edit the owner field — means the move lands in the audit
 * trail, which matters when the asset was issued under a government programme
 * and the ministry later asks where it went.
 */
async function transfer(kind, id, { newOwnerId, reason }, actor, options = {}) {
  const { req } = options;
  const Model = modelFor(kind);
  const doc = await Model.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!doc) throw ApiError.notFound(`${LABELS[kind]} not found`);
  assertCanAccessRecord(actor, doc, { cooperativeField: null });

  const newOwner = await loadOwner(newOwnerId, actor);
  if (String(newOwner._id) === String(doc.owner)) {
    throw ApiError.badRequest('That fisherman already owns this asset');
  }

  const previousOwner = doc.owner;
  const before = doc.toObject();

  doc.owner = newOwner._id;
  doc.blueId = newOwner.blueId;
  doc.lga = newOwner.lga;
  doc.community = newOwner.community;
  await doc.save();

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: { type: LABELS[kind], id: doc._id, blueId: doc.blueId },
    lga: doc.lga,
    changes: auditService.diff(before, doc.toObject()),
    metadata: { transfer: true, from: previousOwner, to: newOwner._id, reason },
    req,
  });

  return doc;
}

async function softDelete(kind, id, actor, options = {}) {
  const { req, reason } = options;
  const Model = modelFor(kind);
  const doc = await Model.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!doc) throw ApiError.notFound(`${LABELS[kind]} not found`);
  assertCanAccessRecord(actor, doc, { cooperativeField: null });

  doc.isDeleted = true;
  doc.deletedAt = new Date();
  doc.isActive = false;
  await doc.save();

  await auditService.record({
    action: AUDIT_ACTIONS.DELETE,
    entity: { type: LABELS[kind], id: doc._id, blueId: doc.blueId },
    lga: doc.lga,
    metadata: { reason },
    req,
  });
  await cache.bumpNamespace(cache.NS.DASHBOARD);

  return doc;
}

async function setPhoto(kind, id, buffer, actor, options = {}) {
  const { req } = options;
  const Model = modelFor(kind);
  const doc = await Model.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!doc) throw ApiError.notFound(`${LABELS[kind]} not found`);
  assertCanAccessRecord(actor, doc, { cooperativeField: null });

  const previous = doc.photo?.publicId;
  doc.photo = await mediaService.uploadAssetPhoto(buffer, {
    kind,
    lga: doc.lga,
    ownerBlueId: doc.blueId,
  });
  await doc.save();

  if (previous && previous !== doc.photo.publicId) {
    mediaService.destroy(previous).catch(() => {});
  }

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: { type: LABELS[kind], id: doc._id, blueId: doc.blueId },
    lga: doc.lga,
    changes: [{ field: 'photo', from: previous, to: doc.photo.publicId }],
    req,
  });

  return doc;
}

/** Everything one fisherman owns, in a single call for the profile view. */
async function listForOwner(ownerId, actor) {
  const owner = await loadOwner(ownerId, actor);
  const [boats, engines, equipment] = await Promise.all([
    Boat.find({ owner: owner._id, isDeleted: { $ne: true } }).lean(),
    Engine.find({ owner: owner._id, isDeleted: { $ne: true } }).populate('boat', 'name registrationNumber boatType').lean(),
    Equipment.find({ owner: owner._id, isDeleted: { $ne: true } }).lean(),
  ]);
  return { owner, boats, engines, equipment };
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  create,
  list,
  getById,
  update,
  transfer,
  softDelete,
  setPhoto,
  listForOwner,
  MODELS,
};
