'use strict';

const Fisherman = require('../fishermen/fisherman.model');
const Boat = require('../assets/boat.model');
const Engine = require('../assets/engine.model');
const Equipment = require('../assets/equipment.model');
const Community = require('../communities/community.model');
const Cooperative = require('../cooperatives/cooperative.model');
const Allocation = require('../programmes/allocation.model');
const Programme = require('../programmes/programme.model');

const cache = require('../../services/cache.service');
const config = require('../../config');
const { buildScopeFilter, assertCanAccessLga } = require('../../middleware/authorize');
const { andFilters } = require('../../utils/query');
const {
  FISHERMAN_STATUS,
  FISHERMAN_TYPES,
  ALLOCATION_STATUS,
  LGA_BY_CODE,
  LGAS,
} = require('../../config/constants');

/**
 * Executive dashboard (concept note §7) and the state-level questions in §14.
 *
 * Every figure here is a MongoDB aggregation rather than a maintained counter.
 * Counters drift — a merge, a status change or a sync correction leaves them
 * wrong, and a wrong number on a ministry dashboard is worse than a slow one.
 * The cost is paid once per cache window instead, keyed on the caller's scope
 * so an LGA administrator's dashboard is cached separately from the state view.
 */

const TTL = () => config.cache.dashboardTtl;

/**
 * Cache key for an authorization-dependent response.
 *
 * Derived from the SCOPE FILTER itself, not from a chosen subset of the
 * actor's attributes. The previous version keyed on role and `scope.lgas`
 * only, which omitted `scope.communities` and `cooperative` — so two
 * cooperative officers from different societies, or two enumerators posted to
 * different communities, shared one cache entry and each was served the
 * other's figures.
 *
 * Hashing the filter makes that class of bug structurally impossible: a new
 * scope dimension changes the filter and therefore the key, automatically.
 */
function scopeKey(actor, filters = {}) {
  const scope = buildScopeFilter(actor, {
    ownerField: null,
    cooperativeField: 'cooperative.id',
  });
  return cache.scopeHash(scope, filters);
}

function baseFilter(actor, query = {}) {
  const scope = buildScopeFilter(actor, {
    ownerField: null,
    cooperativeField: 'cooperative.id',
  });

  const direct = { isDeleted: { $ne: true } };
  if (query.lga) {
    assertCanAccessLga(actor, query.lga);
    direct.lga = query.lga;
  }
  if (query.community) direct.community = query.community;
  if (query.from || query.to) {
    direct.createdAt = {};
    if (query.from) direct.createdAt.$gte = query.from;
    if (query.to) direct.createdAt.$lte = query.to;
  }

  // Composed, never spread: the scope fragment may itself be an $or.
  return andFilters(scope, direct);
}

/**
 * Headline figures. One `$facet` pipeline rather than a dozen round trips —
 * the register is scanned once and every tile falls out of the same pass.
 */
async function summary(query, actor) {
  const key = await cache.versionedKey(cache.NS.DASHBOARD, 'summary', scopeKey(actor, query));

  return cache.wrap(key, TTL(), async () => {
    const filter = baseFilter(actor, query);
    const assetFilter = { ...filter };
    delete assetFilter.createdAt; // assets are counted as a current stock

    const [registerFacets, boatCount, engineCount, coopCount, allocationFacets] = await Promise.all([
      Fisherman.aggregate([
        { $match: filter },
        {
          $facet: {
            total: [{ $count: 'value' }],
            verified: [
              { $match: { blueId: { $exists: true, $ne: null } } },
              { $count: 'value' },
            ],
            byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
            byGender: [{ $group: { _id: '$gender', count: { $sum: 1 } } }],
            byType: [
              { $unwind: '$fishermanTypes' },
              { $group: { _id: '$fishermanTypes', count: { $sum: 1 } } },
            ],
            byFishingType: [
              { $unwind: '$fishingTypes' },
              { $group: { _id: '$fishingTypes', count: { $sum: 1 } } },
            ],
            byLga: [{ $group: { _id: '$lga', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
            cooperativeMembers: [
              { $match: { 'cooperative.id': { $exists: true, $ne: null } } },
              { $count: 'value' },
            ],
            pendingReview: [
              { $match: { 'duplicateFlags.resolution': 'PENDING' } },
              { $count: 'value' },
            ],
            registeredLast30Days: [
              { $match: { createdAt: { $gte: daysAgo(30) } } },
              { $count: 'value' },
            ],
          },
        },
      ]),
      Boat.countDocuments(assetFilter),
      Engine.countDocuments(assetFilter),
      Cooperative.countDocuments({
        ...(query.lga ? { lga: query.lga } : {}),
        isDeleted: { $ne: true },
        isActive: true,
      }),
      Allocation.aggregate([
        { $match: { ...stripCreatedAt(filter), isDeleted: { $ne: true } } },
        {
          $facet: {
            total: [{ $count: 'value' }],
            delivered: [
              { $match: { status: ALLOCATION_STATUS.DELIVERED } },
              { $count: 'value' },
            ],
            byType: [{ $group: { _id: '$programmeType', count: { $sum: 1 } } }],
            beneficiaries: [{ $group: { _id: '$fisherman' } }, { $count: 'value' }],
          },
        },
      ]),
    ]);

    const f = registerFacets[0] || {};
    const a = allocationFacets[0] || {};
    const byType = toMap(f.byType);

    return {
      fishermen: {
        total: first(f.total),
        verified: first(f.verified),
        awaitingVerification: countFor(f.byStatus, FISHERMAN_STATUS.PENDING_VERIFICATION),
        underDuplicateReview: first(f.pendingReview),
        registeredLast30Days: first(f.registeredLast30Days),
        byStatus: toMap(f.byStatus),
        byGender: toMap(f.byGender),
        byType,
        byFishingType: toMap(f.byFishingType),
      },
      // Called out individually because §7 names each of these as a tile.
      highlights: {
        boatOwners: byType[FISHERMAN_TYPES.BOAT_OWNER] || 0,
        fishFarmers: byType[FISHERMAN_TYPES.FISH_FARMER] || 0,
        fishProcessors: byType[FISHERMAN_TYPES.FISH_PROCESSOR] || 0,
        fishTraders: byType[FISHERMAN_TYPES.FISH_TRADER] || 0,
        artisanal: byType[FISHERMAN_TYPES.ARTISANAL] || 0,
        commercial: byType[FISHERMAN_TYPES.COMMERCIAL] || 0,
        crewMembers: byType[FISHERMAN_TYPES.CREW_MEMBER] || 0,
        cooperativeMembers: first(f.cooperativeMembers),
      },
      assets: {
        boats: boatCount,
        outboardEngines: engineCount,
      },
      cooperatives: { total: coopCount },
      interventions: {
        totalAllocations: first(a.total),
        delivered: first(a.delivered),
        uniqueBeneficiaries: first(a.beneficiaries),
        byType: toMap(a.byType),
      },
      coverage: {
        byLga: (f.byLga || []).map((row) => ({
          lga: row._id,
          name: LGA_BY_CODE[row._id]?.name || row._id,
          count: row.count,
        })),
      },
      generatedAt: new Date(),
    };
  });
}

/** Per-community breakdown — the "fishermen by community" table in §7. */
async function byCommunity(query, actor) {
  const key = await cache.versionedKey(cache.NS.DASHBOARD, 'communities', scopeKey(actor, query));

  return cache.wrap(key, TTL(), async () => {
    const filter = baseFilter(actor, query);

    const rows = await Fisherman.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$community',
          communityName: { $first: '$communityName' },
          lga: { $first: '$lga' },
          fishermen: { $sum: 1 },
          male: { $sum: { $cond: [{ $eq: ['$gender', 'MALE'] }, 1, 0] } },
          female: { $sum: { $cond: [{ $eq: ['$gender', 'FEMALE'] }, 1, 0] } },
          verified: { $sum: { $cond: [{ $ifNull: ['$blueId', false] }, 1, 0] } },
          boatOwners: {
            $sum: { $cond: [{ $in: [FISHERMAN_TYPES.BOAT_OWNER, '$fishermanTypes'] }, 1, 0] },
          },
        },
      },
      { $sort: { fishermen: -1 } },
      { $limit: query.limit || 200 },
    ]);

    // Attach boat/engine counts per community in one pass each.
    const communityIds = rows.map((r) => r._id).filter(Boolean);
    const [boats, engines] = await Promise.all([
      Boat.aggregate([
        { $match: { community: { $in: communityIds }, isDeleted: { $ne: true } } },
        { $group: { _id: '$community', count: { $sum: 1 } } },
      ]),
      // Scoped like every other figure: an LGA user must not be shown
      // state-wide engine totals through a side channel.
      Engine.aggregate([
        {
          $match: andFilters(
            buildScopeFilter(actor, {
              ownerField: null,
              communityField: null,
              cooperativeField: null,
            }),
            filter.lga ? { lga: filter.lga } : {},
            { isDeleted: { $ne: true } }
          ),
        },
        { $group: { _id: '$lga', count: { $sum: 1 } } },
      ]),
    ]);
    const boatMap = toMap(boats);
    const engineMap = toMap(engines);

    return rows.map((r) => ({
      communityId: r._id,
      community: r.communityName || 'Unspecified',
      lga: r.lga,
      lgaName: LGA_BY_CODE[r.lga]?.name || r.lga,
      fishermen: r.fishermen,
      male: r.male,
      female: r.female,
      verified: r.verified,
      boatOwners: r.boatOwners,
      boats: boatMap[String(r._id)] || 0,
      enginesInLga: engineMap[r.lga] || 0,
    }));
  });
}

/**
 * Infrastructure gaps: which communities lack cold storage, landing sites or
 * boat repair (§7, §14). This is the list the ministry plans investment from.
 */
async function infrastructureGaps(query, actor) {
  const key = await cache.versionedKey(cache.NS.DASHBOARD, 'gaps', scopeKey(actor, query));

  return cache.wrap(key, TTL(), async () => {
    const filter = { isDeleted: { $ne: true }, isActive: true };
    if (query.lga) {
      assertCanAccessLga(actor, query.lga);
      filter.lga = query.lga;
    } else {
      const scope = buildScopeFilter(actor, { ownerField: null, communityField: null, cooperativeField: null });
      Object.assign(filter, scope);
    }

    const [communities, totals] = await Promise.all([
      Community.find(filter)
        .select('name lga type facilities stats estimatedFishermen location')
        .lean(),
      Community.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            noColdStorage: { $sum: { $cond: ['$facilities.coldStorage', 0, 1] } },
            noLandingSite: { $sum: { $cond: ['$facilities.landingSite', 0, 1] } },
            noBoatRepair: { $sum: { $cond: ['$facilities.boatRepair', 0, 1] } },
            noIceplant: { $sum: { $cond: ['$facilities.iceplant', 0, 1] } },
            noProcessing: { $sum: { $cond: ['$facilities.processingFacility', 0, 1] } },
            noJetty: { $sum: { $cond: ['$facilities.jetty', 0, 1] } },
            noMarket: { $sum: { $cond: ['$facilities.market', 0, 1] } },
          },
        },
      ]),
    ]);

    const lacking = (key2) =>
      communities
        .filter((c) => !c.facilities?.[key2])
        .map((c) => ({
          id: c._id,
          name: c.name,
          lga: c.lga,
          lgaName: LGA_BY_CODE[c.lga]?.name || c.lga,
          registeredFishermen: c.stats?.registeredFishermen || 0,
        }))
        .sort((a, b) => b.registeredFishermen - a.registeredFishermen);

    const t = totals[0] || {};
    return {
      totals: {
        communities: t.total || 0,
        lackingColdStorage: t.noColdStorage || 0,
        lackingLandingSite: t.noLandingSite || 0,
        lackingBoatRepair: t.noBoatRepair || 0,
        lackingIceplant: t.noIceplant || 0,
        lackingProcessingFacility: t.noProcessing || 0,
        lackingJetty: t.noJetty || 0,
        lackingMarket: t.noMarket || 0,
      },
      lacking: {
        coldStorage: lacking('coldStorage'),
        landingSite: lacking('landingSite'),
        boatRepair: lacking('boatRepair'),
        iceplant: lacking('iceplant'),
        processingFacility: lacking('processingFacility'),
      },
      generatedAt: new Date(),
    };
  });
}

/** Registration volume over time — the trend chart. */
async function registrationTrend(query, actor) {
  const key = await cache.versionedKey(cache.NS.DASHBOARD, 'trend', scopeKey(actor, query));

  return cache.wrap(key, TTL(), async () => {
    const filter = baseFilter(actor, query);
    const granularity = query.granularity || 'month';
    const format = granularity === 'day' ? '%Y-%m-%d' : granularity === 'week' ? '%Y-W%V' : '%Y-%m';

    const rows = await Fisherman.aggregate([
      { $match: { ...filter, createdAt: { $gte: query.from || daysAgo(365) } } },
      {
        $group: {
          _id: { $dateToString: { format, date: '$createdAt' } },
          registered: { $sum: 1 },
          verified: { $sum: { $cond: [{ $ifNull: ['$blueId', false] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return rows.map((r) => ({ period: r._id, registered: r.registered, verified: r.verified }));
  });
}

/** Enumerator productivity — who is registering, and how much. */
async function enumeratorActivity(query, actor) {
  const filter = baseFilter(actor, query);

  return Fisherman.aggregate([
    { $match: filter },
    {
      $group: {
        _id: '$registeredBy',
        registrations: { $sum: 1 },
        verified: { $sum: { $cond: [{ $ifNull: ['$blueId', false] }, 1, 0] } },
        flagged: {
          $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$duplicateFlags', []] } }, 0] }, 1, 0] },
        },
        lastRegistrationAt: { $max: '$createdAt' },
      },
    },
    { $sort: { registrations: -1 } },
    { $limit: query.limit || 50 },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
        pipeline: [{ $project: { firstName: 1, lastName: 1, email: 1, role: 1, 'scope.lgas': 1 } }],
      },
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
  ]);
}

/** Fisheries capacity per LGA — answers "how much capacity exists in each LGA?" */
async function capacityByLga(query, actor) {
  const key = await cache.versionedKey(cache.NS.DASHBOARD, 'capacity', scopeKey(actor, query));

  return cache.wrap(key, TTL(), async () => {
    const filter = baseFilter(actor, query);

    const [fishermen, boats, engines, equipment] = await Promise.all([
      Fisherman.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$lga',
            fishermen: { $sum: 1 },
            verified: { $sum: { $cond: [{ $ifNull: ['$blueId', false] }, 1, 0] } },
            estimatedMonthlyCatchKg: { $sum: { $ifNull: ['$estimatedMonthlyCatchKg', 0] } },
          },
        },
      ]),
      Boat.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $group: { _id: '$lga', boats: { $sum: 1 } } },
      ]),
      Engine.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        {
          $group: {
            _id: '$lga',
            engines: { $sum: 1 },
            totalHorsepower: { $sum: { $ifNull: ['$horsepower', 0] } },
          },
        },
      ]),
      Equipment.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $group: { _id: '$lga', equipment: { $sum: '$quantity' } } },
      ]),
    ]);

    const index = (rows, pick) => Object.fromEntries(rows.map((r) => [r._id, pick(r)]));
    const fishermenMap = index(fishermen, (r) => r);
    const boatMap = index(boats, (r) => r.boats);
    const engineMap = index(engines, (r) => r);
    const equipmentMap = index(equipment, (r) => r.equipment);

    return LGAS.filter((lga) => !query.waterfrontOnly || lga.waterfront).map((lga) => ({
      lga: lga.code,
      name: lga.name,
      zone: lga.zone,
      waterfront: lga.waterfront,
      fishermen: fishermenMap[lga.code]?.fishermen || 0,
      verified: fishermenMap[lga.code]?.verified || 0,
      boats: boatMap[lga.code] || 0,
      engines: engineMap[lga.code]?.engines || 0,
      totalHorsepower: engineMap[lga.code]?.totalHorsepower || 0,
      equipmentItems: equipmentMap[lga.code] || 0,
      estimatedMonthlyCatchKg: fishermenMap[lga.code]?.estimatedMonthlyCatchKg || 0,
    }));
  });
}

/** Programme delivery performance. */
async function programmePerformance(query, actor) {
  const filter = { isDeleted: { $ne: true } };
  if (query.year) filter.year = query.year;

  const programmes = await Programme.find(filter)
    .select('name code type year targetBeneficiaries allocatedCount deliveredCount totalBudget status')
    .sort({ year: -1 })
    .lean();

  return programmes.map((p) => ({
    ...p,
    deliveryRate: p.allocatedCount ? Number((p.deliveredCount / p.allocatedCount).toFixed(3)) : 0,
    targetProgress: p.targetBeneficiaries
      ? Number((p.allocatedCount / p.targetBeneficiaries).toFixed(3))
      : null,
  }));
}

// --- helpers ---------------------------------------------------------------

const first = (facet) => facet?.[0]?.value || 0;
const toMap = (rows) => Object.fromEntries((rows || []).map((r) => [String(r._id), r.count]));
const countFor = (rows, id) => (rows || []).find((r) => r._id === id)?.count || 0;
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const stripCreatedAt = (filter) => {
  const { createdAt, ...rest } = filter;
  return rest;
};

module.exports = {
  summary,
  byCommunity,
  infrastructureGaps,
  registrationTrend,
  enumeratorActivity,
  capacityByLga,
  programmePerformance,
};
