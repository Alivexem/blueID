'use strict';

const Cooperative = require('./cooperative.model');
const Fisherman = require('../fishermen/fisherman.model');

const auditService = require('../../services/audit.service');
const cache = require('../../services/cache.service');
const ApiError = require('../../utils/ApiError');
const { paginate, resolvePagination } = require('../../utils/pagination');
const { buildScopeFilter, assertCanAccessLga, resolveWritableLga } = require('../../middleware/authorize');
const { AUDIT_ACTIONS, ROLES } = require('../../config/constants');

/**
 * Fishing cooperative societies.
 *
 * Membership matters operationally: several programmes restrict eligibility to
 * cooperative members, so joining and leaving a society is recorded on the
 * fisherman's own record (`cooperative.id`) and mirrored in `memberCount` here.
 * The fisherman's record is the source of truth — the count is a cached
 * convenience, refreshed by `recountMembers`.
 */

async function create(payload, actor, options = {}) {
  const { req } = options;
  const lga = resolveWritableLga(actor, payload.lga);

  const cooperative = await Cooperative.create({ ...payload, lga });

  await auditService.recordChange({ action: AUDIT_ACTIONS.CREATE, doc: cooperative, req });
  await cache.bumpNamespace(cache.NS.REFERENCE);

  return cooperative;
}

async function list(query, actor) {
  const pagination = resolvePagination(query);
  const filter = { isDeleted: { $ne: true } };

  if (query.lga) {
    assertCanAccessLga(actor, query.lga);
    filter.lga = query.lga;
  } else {
    Object.assign(filter, buildScopeFilter(actor, { ownerField: null, communityField: null, cooperativeField: '_id' }));
  }

  // A cooperative officer only ever sees their own society.
  if (actor.role === ROLES.COOPERATIVE_OFFICER && actor.cooperative) {
    filter._id = actor.cooperative;
  }

  if (query.community) filter.community = query.community;
  if (query.isActive != null) filter.isActive = query.isActive;
  if (query.search) filter.$text = { $search: query.search };

  return paginate(Cooperative, filter, pagination, {
    sort: { lga: 1, name: 1 },
    populate: [{ path: 'community', select: 'name lga' }],
  });
}

async function getById(id, actor) {
  const cooperative = await Cooperative.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate('community', 'name lga type')
    .lean();
  if (!cooperative) throw ApiError.notFound('Cooperative not found');
  assertCanAccessLga(actor, cooperative.lga);

  if (actor.role === ROLES.COOPERATIVE_OFFICER && String(actor.cooperative) !== String(id)) {
    throw ApiError.forbidden('You may only view your own cooperative');
  }

  const memberCount = await Fisherman.countDocuments({
    'cooperative.id': id,
    isDeleted: { $ne: true },
  });

  return { ...cooperative, memberCount };
}

async function update(id, payload, actor, options = {}) {
  const { req } = options;
  const cooperative = await Cooperative.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!cooperative) throw ApiError.notFound('Cooperative not found');
  assertCanAccessLga(actor, cooperative.lga);

  const before = cooperative.toObject();
  if (payload.lga) payload.lga = resolveWritableLga(actor, payload.lga);
  // memberCount is derived, never submitted.
  delete payload.memberCount;
  Object.assign(cooperative, payload);
  await cooperative.save();

  await auditService.recordChange({ action: AUDIT_ACTIONS.UPDATE, doc: cooperative, before, req });
  await cache.bumpNamespace(cache.NS.REFERENCE);

  return cooperative;
}

/** Members of a cooperative, from the register. */
async function listMembers(id, query, actor) {
  const cooperative = await Cooperative.findById(id).lean();
  if (!cooperative) throw ApiError.notFound('Cooperative not found');
  assertCanAccessLga(actor, cooperative.lga);

  const pagination = resolvePagination(query);
  return paginate(
    Fisherman,
    { 'cooperative.id': id, isDeleted: { $ne: true } },
    pagination,
    {
      sort: { fullName: 1 },
      select: 'blueId fullName gender phone lga communityName status cooperative fishermanTypes',
    }
  );
}

/** Adds a fisherman to a cooperative. */
async function addMember(id, { fishermanId, membershipNumber }, actor, options = {}) {
  const { req } = options;
  const cooperative = await Cooperative.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!cooperative) throw ApiError.notFound('Cooperative not found');
  assertCanAccessLga(actor, cooperative.lga);

  const fisherman = await Fisherman.findOne({ _id: fishermanId, isDeleted: { $ne: true } });
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessLga(actor, fisherman.lga);

  if (fisherman.cooperative?.id && String(fisherman.cooperative.id) !== String(id)) {
    throw ApiError.conflict('This fisherman already belongs to another cooperative', {
      code: 'ALREADY_A_MEMBER',
      details: { currentCooperative: fisherman.cooperative.name },
    });
  }

  fisherman.cooperative = {
    id: cooperative._id,
    name: cooperative.name,
    membershipNumber,
    joinedAt: new Date(),
  };
  await fisherman.save();

  await Cooperative.updateOne({ _id: id }, { $inc: { memberCount: 1 } });

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: { type: 'Fisherman', id: fisherman._id, blueId: fisherman.blueId, label: fisherman.fullName },
    lga: fisherman.lga,
    changes: [{ field: 'cooperative', from: null, to: cooperative.name }],
    req,
  });

  return fisherman;
}

async function removeMember(id, fishermanId, actor, options = {}) {
  const { req, reason } = options;
  const fisherman = await Fisherman.findOne({ _id: fishermanId, 'cooperative.id': id });
  if (!fisherman) throw ApiError.notFound('That fisherman is not a member of this cooperative');
  assertCanAccessLga(actor, fisherman.lga);

  const previous = fisherman.cooperative?.name;
  fisherman.cooperative = undefined;
  await fisherman.save();

  await Cooperative.updateOne({ _id: id, memberCount: { $gt: 0 } }, { $inc: { memberCount: -1 } });

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: { type: 'Fisherman', id: fisherman._id, blueId: fisherman.blueId },
    lga: fisherman.lga,
    changes: [{ field: 'cooperative', from: previous, to: null }],
    metadata: { reason },
    req,
  });

  return fisherman;
}

async function softDelete(id, actor, options = {}) {
  const { req, reason } = options;
  const cooperative = await Cooperative.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!cooperative) throw ApiError.notFound('Cooperative not found');
  assertCanAccessLga(actor, cooperative.lga);

  const members = await Fisherman.countDocuments({ 'cooperative.id': id, isDeleted: { $ne: true } });
  if (members > 0) {
    throw ApiError.conflict('This cooperative still has members — deactivate it instead', {
      code: 'COOPERATIVE_IN_USE',
      details: { memberCount: members },
    });
  }

  cooperative.isDeleted = true;
  cooperative.deletedAt = new Date();
  cooperative.isActive = false;
  await cooperative.save();

  await auditService.record({
    action: AUDIT_ACTIONS.DELETE,
    entity: { type: 'Cooperative', id: cooperative._id, label: cooperative.name },
    lga: cooperative.lga,
    metadata: { reason },
    req,
  });

  return cooperative;
}

/** Rebuilds memberCount from the register. */
async function recountMembers() {
  const counts = await Fisherman.aggregate([
    { $match: { 'cooperative.id': { $ne: null }, isDeleted: { $ne: true } } },
    { $group: { _id: '$cooperative.id', count: { $sum: 1 } } },
  ]);

  await Cooperative.updateMany({}, { $set: { memberCount: 0 } });
  if (counts.length) {
    await Cooperative.bulkWrite(
      counts.map((c) => ({
        updateOne: { filter: { _id: c._id }, update: { $set: { memberCount: c.count } } },
      }))
    );
  }
  return { updated: counts.length };
}

module.exports = {
  create,
  list,
  getById,
  update,
  listMembers,
  addMember,
  removeMember,
  softDelete,
  recountMembers,
};
