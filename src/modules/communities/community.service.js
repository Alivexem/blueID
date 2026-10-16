'use strict';

const Community = require('./community.model');
const Fisherman = require('../fishermen/fisherman.model');
const Boat = require('../assets/boat.model');

const auditService = require('../../services/audit.service');
const cache = require('../../services/cache.service');
const ApiError = require('../../utils/ApiError');
const { paginate, resolvePagination } = require('../../utils/pagination');
const { buildScopeFilter, assertCanAccessLga, resolveWritableLga } = require('../../middleware/authorize');
const { AUDIT_ACTIONS, LGA_BY_CODE } = require('../../config/constants');

/**
 * Fishing communities — the reference data every registration hangs off, and
 * the unit the GIS map and infrastructure-gap reports are built from.
 *
 * Communities change rarely and are read constantly (the field app caches the
 * whole list for offline use), so reads are cached and every write bumps the
 * reference namespace.
 */

async function create(payload, actor, options = {}) {
  const { req } = options;
  const lga = resolveWritableLga(actor, payload.lga);

  const existing = await Community.findOne({
    lga,
    normalizedName: require('../../utils/normalize').normalizeText(payload.name),
    isDeleted: { $ne: true },
  });
  if (existing) {
    throw ApiError.conflict('A community with that name already exists in this LGA', {
      code: 'COMMUNITY_EXISTS',
      details: { id: existing._id },
    });
  }

  const community = await Community.create({ ...payload, lga });

  await auditService.recordChange({ action: AUDIT_ACTIONS.CREATE, doc: community, req });
  await cache.bumpNamespace(cache.NS.REFERENCE);
  await cache.bumpNamespace(cache.NS.GIS);

  return community;
}

async function list(query, actor) {
  const pagination = resolvePagination(query);
  const filter = { isDeleted: { $ne: true } };

  if (query.lga) {
    assertCanAccessLga(actor, query.lga);
    filter.lga = query.lga;
  } else {
    Object.assign(filter, buildScopeFilter(actor, { ownerField: null, communityField: null, cooperativeField: null }));
  }
  if (query.type) filter.type = query.type;
  if (query.isActive != null) filter.isActive = query.isActive;
  if (query.search) filter.$text = { $search: query.search };

  // Facility filters drive the "which communities lack X" views.
  if (query.lacking) filter[`facilities.${query.lacking}`] = false;
  if (query.has) filter[`facilities.${query.has}`] = true;

  return paginate(Community, filter, pagination, {
    sort: query.search ? { score: { $meta: 'textScore' } } : { lga: 1, name: 1 },
  });
}

async function getById(id, actor) {
  const community = await Community.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
  if (!community) throw ApiError.notFound('Community not found');
  assertCanAccessLga(actor, community.lga);

  const [fishermen, boats] = await Promise.all([
    Fisherman.countDocuments({ community: id, isDeleted: { $ne: true } }),
    Boat.countDocuments({ community: id, isDeleted: { $ne: true } }),
  ]);

  return {
    ...community,
    lgaName: LGA_BY_CODE[community.lga]?.name,
    stats: { ...community.stats, registeredFishermen: fishermen, registeredBoats: boats },
  };
}

async function update(id, payload, actor, options = {}) {
  const { req } = options;
  const community = await Community.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!community) throw ApiError.notFound('Community not found');
  assertCanAccessLga(actor, community.lga);

  const before = community.toObject();
  if (payload.lga) payload.lga = resolveWritableLga(actor, payload.lga);
  Object.assign(community, payload);
  await community.save();

  await auditService.recordChange({ action: AUDIT_ACTIONS.UPDATE, doc: community, before, req });
  await cache.bumpNamespace(cache.NS.REFERENCE);
  await cache.bumpNamespace(cache.NS.GIS);

  return community;
}

async function softDelete(id, actor, options = {}) {
  const { req, reason } = options;
  const community = await Community.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!community) throw ApiError.notFound('Community not found');
  assertCanAccessLga(actor, community.lga);

  const registered = await Fisherman.countDocuments({ community: id, isDeleted: { $ne: true } });
  if (registered > 0) {
    throw ApiError.conflict(
      'This community has registered fishermen — deactivate it instead of removing it',
      { code: 'COMMUNITY_IN_USE', details: { registeredFishermen: registered } }
    );
  }

  community.isDeleted = true;
  community.deletedAt = new Date();
  community.isActive = false;
  await community.save();

  await auditService.record({
    action: AUDIT_ACTIONS.DELETE,
    entity: { type: 'Community', id: community._id, label: community.name },
    lga: community.lga,
    metadata: { reason },
    req,
  });
  await cache.bumpNamespace(cache.NS.REFERENCE);

  return community;
}

/**
 * Recalculates the denormalised per-community counters.
 * Run on a schedule or after a bulk import; the dashboard aggregates live
 * figures itself, so these exist only for cheap map rendering.
 */
async function recalculateStats(lga) {
  const match = { isDeleted: { $ne: true }, ...(lga ? { lga } : {}) };

  const [fishermen, boats] = await Promise.all([
    Fisherman.aggregate([
      { $match: { ...match, community: { $ne: null } } },
      { $group: { _id: '$community', count: { $sum: 1 } } },
    ]),
    Boat.aggregate([
      { $match: { ...match, community: { $ne: null } } },
      { $group: { _id: '$community', count: { $sum: 1 } } },
    ]),
  ]);

  const boatMap = Object.fromEntries(boats.map((b) => [String(b._id), b.count]));
  const now = new Date();

  const operations = fishermen.map((f) => ({
    updateOne: {
      filter: { _id: f._id },
      update: {
        $set: {
          'stats.registeredFishermen': f.count,
          'stats.registeredBoats': boatMap[String(f._id)] || 0,
          'stats.lastRecalculatedAt': now,
        },
      },
    },
  }));

  if (operations.length) await Community.bulkWrite(operations);
  await cache.bumpNamespace(cache.NS.GIS);

  return { updated: operations.length };
}

/** Flat list for dropdowns and offline caching. */
async function reference(actor) {
  /**
   * The key omitted `role` entirely, so a state administrator (no LGA scope,
   * filter `{}`) and an unscoped LGA administrator (no LGA scope, filter
   * `{_id: null}`) collided on the key `all` — and the second could be served
   * the state-wide list. Hashing the filter distinguishes them.
   */
  const scope = buildScopeFilter(actor, {
    ownerField: null,
    communityField: null,
    cooperativeField: null,
  });
  const key = await cache.versionedKey(cache.NS.REFERENCE, 'communities', cache.scopeHash(scope));

  return cache.wrap(key, 900, async () => {
    const filter = { ...scope, isDeleted: { $ne: true }, isActive: true };
    return Community.find(filter).select('name lga ward type landingSites.name').sort({ lga: 1, name: 1 }).lean();
  });
}

module.exports = { create, list, getById, update, softDelete, recalculateStats, reference };
