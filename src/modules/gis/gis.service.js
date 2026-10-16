'use strict';

const Community = require('../communities/community.model');
const Fisherman = require('../fishermen/fisherman.model');
const Boat = require('../assets/boat.model');
const Engine = require('../assets/engine.model');

const cache = require('../../services/cache.service');
const ApiError = require('../../utils/ApiError');
const { buildScopeFilter, assertCanAccessLga } = require('../../middleware/authorize');
const { LGA_BY_CODE, FISHERMAN_TYPES } = require('../../config/constants');

/**
 * GIS and mapping (concept note §8).
 *
 * The portal map shows fishing communities across Cross River State; clicking
 * one opens its statistics. Output is GeoJSON so it drops straight into
 * Leaflet, Mapbox or QGIS without a translation layer — the ministry should be
 * able to open the same data in a desktop GIS tool when planning infrastructure.
 */

/** FeatureCollection of communities with their headline statistics. */
async function communityMap(query, actor) {
  // Keyed on the resolved scope filter, so a caller can only ever be served a
  // map built for exactly their own visibility.
  const key = await cache.versionedKey(
    cache.NS.GIS,
    'communities',
    cache.scopeHash(
      buildScopeFilter(actor, { ownerField: null, cooperativeField: null }),
      { lga: query.lga || null }
    )
  );

  return cache.wrap(key, 300, async () => {
    const filter = { isDeleted: { $ne: true }, isActive: true };
    if (query.lga) {
      assertCanAccessLga(actor, query.lga);
      filter.lga = query.lga;
    } else {
      Object.assign(filter, buildScopeFilter(actor, { ownerField: null, cooperativeField: null }));
    }
    // Only mapped communities belong in a FeatureCollection.
    filter['location.coordinates'] = { $exists: true, $ne: [] };

    const communities = await Community.find(filter)
      .select('name lga ward type location facilities stats estimatedFishermen developmentNeeds')
      .lean();

    const counts = await Fisherman.aggregate([
      { $match: { isDeleted: { $ne: true }, community: { $in: communities.map((c) => c._id) } } },
      {
        $group: {
          _id: '$community',
          fishermen: { $sum: 1 },
          verified: { $sum: { $cond: [{ $ifNull: ['$blueId', false] }, 1, 0] } },
          boatOwners: {
            $sum: { $cond: [{ $in: [FISHERMAN_TYPES.BOAT_OWNER, '$fishermanTypes'] }, 1, 0] },
          },
        },
      },
    ]);
    const countMap = Object.fromEntries(counts.map((c) => [String(c._id), c]));

    return {
      type: 'FeatureCollection',
      features: communities.map((c) => ({
        type: 'Feature',
        id: String(c._id),
        geometry: c.location,
        properties: {
          id: String(c._id),
          name: c.name,
          lga: c.lga,
          lgaName: LGA_BY_CODE[c.lga]?.name || c.lga,
          ward: c.ward,
          type: c.type,
          fishermen: countMap[String(c._id)]?.fishermen || 0,
          verified: countMap[String(c._id)]?.verified || 0,
          boatOwners: countMap[String(c._id)]?.boatOwners || 0,
          estimatedFishermen: c.estimatedFishermen,
          facilities: c.facilities,
          /** Drives map styling: red where infrastructure is missing. */
          missingFacilities: Object.entries(c.facilities || {})
            .filter(([, present]) => present === false)
            .map(([name]) => name),
          developmentNeeds: c.developmentNeeds,
        },
      })),
      generatedAt: new Date(),
    };
  });
}

/** Full statistics for one community — the map's click-through panel. */
async function communityDetail(communityId, actor) {
  const community = await Community.findOne({ _id: communityId, isDeleted: { $ne: true } }).lean();
  if (!community) throw ApiError.notFound('Community not found');
  assertCanAccessLga(actor, community.lga);

  const [registerStats, boats, engines] = await Promise.all([
    Fisherman.aggregate([
      { $match: { community: community._id, isDeleted: { $ne: true } } },
      {
        $facet: {
          total: [{ $count: 'value' }],
          byGender: [{ $group: { _id: '$gender', count: { $sum: 1 } } }],
          byType: [
            { $unwind: '$fishermanTypes' },
            { $group: { _id: '$fishermanTypes', count: { $sum: 1 } } },
          ],
          byFishingType: [
            { $unwind: '$fishingTypes' },
            { $group: { _id: '$fishingTypes', count: { $sum: 1 } } },
          ],
          catch: [
            {
              $group: {
                _id: null,
                estimatedMonthlyCatchKg: { $sum: { $ifNull: ['$estimatedMonthlyCatchKg', 0] } },
              },
            },
          ],
        },
      },
    ]),
    Boat.countDocuments({ community: community._id, isDeleted: { $ne: true } }),
    Engine.aggregate([
      { $match: { lga: community.lga, isDeleted: { $ne: true } } },
      { $group: { _id: null, count: { $sum: 1 }, hp: { $sum: { $ifNull: ['$horsepower', 0] } } } },
    ]),
  ]);

  const f = registerStats[0] || {};
  const toMap = (rows) => Object.fromEntries((rows || []).map((r) => [String(r._id), r.count]));

  return {
    community: {
      id: community._id,
      name: community.name,
      lga: community.lga,
      lgaName: LGA_BY_CODE[community.lga]?.name || community.lga,
      ward: community.ward,
      type: community.type,
      location: community.location,
      landingSites: community.landingSites,
      facilities: community.facilities,
      accessibility: community.accessibility,
      estimatedPopulation: community.estimatedPopulation,
      developmentNeeds: community.developmentNeeds,
    },
    statistics: {
      fishermen: f.total?.[0]?.value || 0,
      byGender: toMap(f.byGender),
      byType: toMap(f.byType),
      byFishingType: toMap(f.byFishingType),
      boats,
      enginesInLga: engines[0]?.count || 0,
      estimatedMonthlyCatchKg: f.catch?.[0]?.estimatedMonthlyCatchKg || 0,
    },
    infrastructure: {
      present: Object.entries(community.facilities || {})
        .filter(([, v]) => v)
        .map(([k]) => k),
      missing: Object.entries(community.facilities || {})
        .filter(([, v]) => v === false)
        .map(([k]) => k),
      landingSiteCount: community.landingSites?.length || 0,
    },
  };
}

/**
 * Registration points as GeoJSON, for a density/heat layer.
 *
 * Returns coordinates only — no names, no Blue IDs, no phone numbers. A map
 * layer does not need to identify anyone, and shipping personal data to the
 * browser for every pin would be an unnecessary exposure of the register.
 */
async function registrationPoints(query, actor) {
  const filter = {
    ...buildScopeFilter(actor, { ownerField: null, cooperativeField: null }),
    isDeleted: { $ne: true },
    'location.coordinates': { $exists: true, $ne: [] },
  };
  if (query.lga) {
    assertCanAccessLga(actor, query.lga);
    filter.lga = query.lga;
  }

  const points = await Fisherman.find(filter)
    .select('location lga fishermanTypes')
    .limit(query.limit || 5000)
    .lean();

  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: p.location,
      properties: { lga: p.lga, types: p.fishermanTypes },
    })),
    count: points.length,
  };
}

/** Communities within a radius of a point — "what is near this landing site?" */
async function nearby(query, actor) {
  const { longitude, latitude, radiusKm = 10 } = query;

  const communities = await Community.find({
    isDeleted: { $ne: true },
    ...buildScopeFilter(actor, { ownerField: null, cooperativeField: null }),
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [longitude, latitude] },
        $maxDistance: radiusKm * 1000,
      },
    },
  })
    .select('name lga type location facilities stats')
    .limit(query.limit || 50)
    .lean();

  return communities.map((c) => ({
    ...c,
    lgaName: LGA_BY_CODE[c.lga]?.name || c.lga,
    distanceKm: haversineKm([longitude, latitude], c.location?.coordinates),
  }));
}

function haversineKm([lng1, lat1], coords) {
  if (!coords?.length) return null;
  const [lng2, lat2] = coords;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Number((2 * R * Math.asin(Math.sqrt(a))).toFixed(2));
}

module.exports = { communityMap, communityDetail, registrationPoints, nearby };
