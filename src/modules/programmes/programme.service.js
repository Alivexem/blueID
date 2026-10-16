'use strict';

const mongoose = require('mongoose');
const Programme = require('./programme.model');
const Allocation = require('./allocation.model');
const Fisherman = require('../fishermen/fisherman.model');
const Boat = require('../assets/boat.model');

const auditService = require('../../services/audit.service');
const mediaService = require('../../services/media.service');
const cache = require('../../services/cache.service');
const database = require('../../config/database');
const logger = require('../../config/logger');

const ApiError = require('../../utils/ApiError');
const { paginate, resolvePagination } = require('../../utils/pagination');
const {
  buildScopeFilter,
  assertCanAccessRecord,
  assertCanAccessLga,
  assertNotSelfApproval,
  isStateWide,
} = require('../../middleware/authorize');
const { andFilters } = require('../../utils/query');
const {
  PROGRAMME_STATUS,
  ALLOCATION_STATUS,
  ALLOCATION_TRANSITIONS,
  FISHERMAN_STATUS,
  FISHERMAN_TYPES,
  AUDIT_ACTIONS,
} = require('../../config/constants');

/**
 * Government programme management (concept note §6).
 *
 * The central promise of this module is that every benefit is tied to a
 * Blue ID, so the ministry can see exactly who received what, when, and under
 * which programme — and so the same person cannot collect the same
 * intervention twice.
 *
 * That guarantee is enforced in three layers, deliberately overlapping:
 *   1. A partial unique index on (programme, fisherman) in the database.
 *   2. The eligibility engine, which excludes anyone who already holds an
 *      active allocation, or who received the same programme type recently.
 *   3. An explicit conflict response naming the existing allocation, so an
 *      officer in the field understands why a name was refused.
 */

// ---------------------------------------------------------------------------
// Programmes
// ---------------------------------------------------------------------------

async function create(payload, actor, options = {}) {
  const { req } = options;
  const programme = await Programme.create({ ...payload, createdBy: actor._id });

  await auditService.recordChange({ action: AUDIT_ACTIONS.CREATE, doc: programme, req });
  await cache.bumpNamespace(cache.NS.PROGRAMMES);
  return programme;
}

async function list(query) {
  const pagination = resolvePagination(query);
  const filter = { isDeleted: { $ne: true } };

  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.year) filter.year = query.year;
  if (query.lga) filter['eligibility.lgas'] = query.lga;
  if (query.search) filter.$text = { $search: query.search };

  return paginate(Programme, filter, pagination, {
    sort: { year: -1, createdAt: -1 },
    populate: [{ path: 'createdBy', select: 'firstName lastName role' }],
  });
}

async function getById(id) {
  const programme = await Programme.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate('createdBy', 'firstName lastName role')
    .populate('approvedBy', 'firstName lastName role');
  if (!programme) throw ApiError.notFound('Programme not found');
  return programme;
}

async function update(id, payload, actor, options = {}) {
  const { req } = options;
  const programme = await getById(id);

  // Once allocations exist, the eligibility rules that produced them are part
  // of the record of how beneficiaries were chosen and must not be rewritten.
  if (programme.allocatedCount > 0 && payload.eligibility) {
    throw ApiError.conflict(
      'Eligibility criteria cannot be changed after allocations have been made',
      { code: 'ELIGIBILITY_LOCKED', details: { allocatedCount: programme.allocatedCount } }
    );
  }

  const before = programme.toObject();
  Object.assign(programme, payload);
  await programme.save();

  await auditService.recordChange({ action: AUDIT_ACTIONS.UPDATE, doc: programme, before, req });
  await cache.bumpNamespace(cache.NS.PROGRAMMES);
  return programme;
}

async function changeStatus(id, { status, note }, actor, options = {}) {
  const { req } = options;
  const programme = await getById(id);
  const before = programme.toObject();

  programme.status = status;
  if (status === PROGRAMME_STATUS.OPEN && !programme.approvedBy) {
    programme.approvedBy = actor._id;
    programme.approvedAt = new Date();
  }
  await programme.save();

  await auditService.record({
    action: AUDIT_ACTIONS.STATUS_CHANGE,
    entity: { type: 'Programme', id: programme._id, label: programme.name },
    changes: auditService.diff(before, programme.toObject()),
    metadata: { note },
    req,
  });
  await cache.bumpNamespace(cache.NS.PROGRAMMES);
  return programme;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Translates a programme's eligibility rules into a Mongo filter.
 *
 * Expressing the criteria as a query, rather than looping in application code,
 * means screening the whole state register stays a single indexed operation
 * even as the register grows.
 */
function eligibilityFilter(programme, extra = {}) {
  const e = programme.eligibility || {};
  const filter = {
    isDeleted: { $ne: true },
    status: FISHERMAN_STATUS.ACTIVE,
    ...extra,
  };

  if (e.requiresVerifiedBlueId !== false) {
    filter.blueId = { $exists: true, $ne: null };
  }
  if (e.lgas?.length) filter.lga = { $in: e.lgas };
  if (e.communities?.length) filter.community = { $in: e.communities };
  if (e.fishermanTypes?.length) filter.fishermanTypes = { $in: e.fishermanTypes };
  if (e.fishingTypes?.length) filter.fishingTypes = { $in: e.fishingTypes };
  if (e.genders?.length) filter.gender = { $in: e.genders };
  if (e.minYearsFishing != null) filter.yearsFishing = { $gte: e.minYearsFishing };

  // Age bounds translate to a birth-year range, which is what the register
  // actually indexes (many records hold only an estimated year).
  if (e.minAge != null || e.maxAge != null) {
    const thisYear = new Date().getFullYear();
    filter['match.birthYear'] = {};
    if (e.maxAge != null) filter['match.birthYear'].$gte = thisYear - e.maxAge;
    if (e.minAge != null) filter['match.birthYear'].$lte = thisYear - e.minAge;
  }

  if (e.requiresCooperativeMembership) {
    filter['cooperative.id'] = { $exists: true, $ne: null };
  }
  if (e.requiresBoatOwnership) {
    filter.fishermanTypes = filter.fishermanTypes
      ? { $all: [FISHERMAN_TYPES.BOAT_OWNER], $in: e.fishermanTypes }
      : FISHERMAN_TYPES.BOAT_OWNER;
  }

  return filter;
}

/** Ids already excluded: existing beneficiaries, and recent same-type recipients. */
async function buildExclusionSet(programme) {
  const excluded = new Set();

  const existing = await Allocation.find({
    programme: programme._id,
    status: { $in: [ALLOCATION_STATUS.PENDING, ALLOCATION_STATUS.APPROVED, ALLOCATION_STATUS.DELIVERED] },
  })
    .select('fisherman')
    .lean();
  for (const a of existing) excluded.add(String(a.fisherman));

  const months = programme.eligibility?.excludeIfReceivedWithinMonths;
  if (months) {
    const since = new Date();
    since.setMonth(since.getMonth() - months);
    const recent = await Allocation.find({
      programmeType: programme.type,
      allocatedAt: { $gte: since },
      status: { $in: [ALLOCATION_STATUS.APPROVED, ALLOCATION_STATUS.DELIVERED] },
    })
      .select('fisherman')
      .lean();
    for (const a of recent) excluded.add(String(a.fisherman));
  }

  return excluded;
}

/** Lists fishermen who qualify for a programme and have not yet received it. */
async function listEligible(id, query, actor) {
  const programme = await getById(id);
  const pagination = resolvePagination(query);

  const scope = buildScopeFilter(actor);
  const excluded = await buildExclusionSet(programme);

  const filter = eligibilityFilter(programme, {
    ...scope,
    ...(excluded.size
      ? { _id: { $nin: [...excluded].map((v) => new mongoose.Types.ObjectId(v)) } }
      : {}),
    ...(query.lga ? { lga: query.lga } : {}),
    ...(query.community ? { community: query.community } : {}),
    ...(query.search ? { $text: { $search: query.search } } : {}),
  });

  const result = await paginate(Fisherman, filter, pagination, {
    sort: { createdAt: -1 },
    select: 'blueId fullName gender lga communityName phone fishermanTypes yearsFishing photo cooperative',
  });

  return { programme, ...result, excludedCount: excluded.size };
}

/**
 * Explains, field by field, whether one fisherman qualifies.
 * Used by the portal before an officer commits an allocation — a flat "not
 * eligible" is not actionable, the reason is.
 */
async function checkEligibility(programmeId, fishermanId) {
  const [programme, fisherman] = await Promise.all([
    getById(programmeId),
    Fisherman.findById(fishermanId).lean(),
  ]);
  if (!fisherman) throw ApiError.notFound('Fisherman not found');

  const e = programme.eligibility || {};
  const failures = [];

  if (e.requiresVerifiedBlueId !== false && !fisherman.blueId) {
    failures.push('No Blue ID has been issued — the record is not yet verified');
  }
  if (fisherman.status !== FISHERMAN_STATUS.ACTIVE) {
    failures.push(`Record status is ${fisherman.status}`);
  }
  if (e.lgas?.length && !e.lgas.includes(fisherman.lga)) {
    failures.push(`Programme is limited to ${e.lgas.join(', ')}`);
  }
  if (e.fishermanTypes?.length && !e.fishermanTypes.some((t) => fisherman.fishermanTypes?.includes(t))) {
    failures.push(`Programme requires one of: ${e.fishermanTypes.join(', ')}`);
  }
  if (e.fishingTypes?.length && !e.fishingTypes.some((t) => fisherman.fishingTypes?.includes(t))) {
    failures.push(`Programme requires fishing type: ${e.fishingTypes.join(', ')}`);
  }
  if (e.genders?.length && !e.genders.includes(fisherman.gender)) {
    failures.push(`Programme is limited to ${e.genders.join(', ')}`);
  }
  if (e.minYearsFishing != null && (fisherman.yearsFishing ?? 0) < e.minYearsFishing) {
    failures.push(`Requires at least ${e.minYearsFishing} years fishing`);
  }
  if (e.requiresCooperativeMembership && !fisherman.cooperative?.id) {
    failures.push('Requires cooperative membership');
  }
  if (e.requiresBoatOwnership) {
    const boats = await Boat.countDocuments({ owner: fisherman._id, isDeleted: { $ne: true } });
    if (!boats) failures.push('Requires a registered boat');
  }

  const age = fisherman.match?.birthYear
    ? new Date().getFullYear() - fisherman.match.birthYear
    : null;
  if (e.minAge != null && age != null && age < e.minAge) failures.push(`Minimum age is ${e.minAge}`);
  if (e.maxAge != null && age != null && age > e.maxAge) failures.push(`Maximum age is ${e.maxAge}`);

  const excluded = await buildExclusionSet(programme);
  if (excluded.has(String(fisherman._id))) {
    failures.push('Already allocated under this programme, or recently received the same type');
  }

  return {
    eligible: failures.length === 0,
    reasons: failures,
    fisherman: {
      id: fisherman._id,
      blueId: fisherman.blueId,
      fullName: fisherman.fullName,
      lga: fisherman.lga,
    },
    programme: { id: programme._id, name: programme.name, code: programme.code },
  };
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

/** Records a benefit against a Blue ID. */
async function allocate(programmeId, payload, actor, options = {}) {
  const { req } = options;
  const programme = await getById(programmeId);

  if (!programme.isOpen && programme.status !== PROGRAMME_STATUS.OPEN) {
    throw ApiError.conflict('This programme is not open for allocations', {
      code: 'PROGRAMME_NOT_OPEN',
      details: { status: programme.status },
    });
  }

  const fisherman = await Fisherman.findOne({
    _id: payload.fisherman,
    isDeleted: { $ne: true },
  }).select('_id blueId fullName lga community status');
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  if (!fisherman.blueId) {
    throw ApiError.badRequest(
      'A benefit can only be recorded against a verified fisherman holding a Blue ID',
      { code: 'BLUE_ID_REQUIRED' }
    );
  }

  /**
   * A hard floor that `overrideEligibility` cannot lift.
   *
   * The override exists because field reality sometimes outruns the rules,
   * and a genuine beneficiary can fail an automated check. It was lifting
   * every check, including the beneficiary's own status — so a benefit could
   * be allocated to someone recorded as deceased, or to a record still under
   * duplicate review. Paying a dead or duplicated beneficiary is precisely
   * the fraud this register exists to prevent, and no written reason makes it
   * acceptable.
   */
  const INELIGIBLE_STATUSES = [
    FISHERMAN_STATUS.DECEASED,
    FISHERMAN_STATUS.DUPLICATE_UNDER_REVIEW,
    FISHERMAN_STATUS.SUSPENDED,
    FISHERMAN_STATUS.INACTIVE,
  ];

  if (INELIGIBLE_STATUSES.includes(fisherman.status)) {
    throw ApiError.unprocessable(
      `A benefit cannot be allocated to a record with status ${fisherman.status}`,
      {
        code: 'BENEFICIARY_NOT_ELIGIBLE',
        details: { status: fisherman.status, overridable: false },
      }
    );
  }

  if (!payload.overrideEligibility) {
    const check = await checkEligibility(programmeId, fisherman._id);
    if (!check.eligible) {
      throw ApiError.unprocessable('This fisherman does not meet the programme criteria', {
        code: 'NOT_ELIGIBLE',
        details: { reasons: check.reasons },
      });
    }
  }

  /**
   * Claim a slot and write the allocation atomically.
   *
   * The target check used to read `allocatedCount`, compare it, then insert.
   * Ten concurrent requests against a programme with one slot left all read
   * the same count, all passed, and all inserted — the uniqueness index does
   * not help because they are different fishermen. For engine distribution at
   * ₦1.85m a unit, that is real money committed outside the budget.
   *
   * The counter is now incremented by a conditional update that is itself the
   * check: `$expr` compares the two fields inside the write, so exactly as
   * many callers succeed as there are slots. The same transaction carries the
   * insert, so the counter can never drift from the number of allocations.
   */
  let allocation;

  try {
    allocation = await database.withTransaction(async (session) => {
      const opts = session ? { session } : {};

      if (programme.targetBeneficiaries != null) {
        const claimed = await Programme.findOneAndUpdate(
          {
            _id: programme._id,
            $expr: { $lt: ['$allocatedCount', '$targetBeneficiaries'] },
          },
          { $inc: { allocatedCount: 1 } },
          { new: true, ...opts }
        );

        if (!claimed) {
          throw ApiError.conflict('This programme has already reached its beneficiary target', {
            code: 'PROGRAMME_FULL',
            details: {
              target: programme.targetBeneficiaries,
              allocated: programme.allocatedCount,
            },
          });
        }
      } else {
        await Programme.updateOne({ _id: programme._id }, { $inc: { allocatedCount: 1 } }, opts);
      }

      const [created] = await Allocation.create(
        [
          {
            programme: programme._id,
            programmeCode: programme.code,
            programmeType: programme.type,
            fisherman: fisherman._id,
            blueId: fisherman.blueId,
            fishermanName: fisherman.fullName,
            lga: fisherman.lga,
            community: fisherman.community,
            itemDescription: payload.itemDescription || programme.itemDescription,
            quantity: payload.quantity ?? 1,
            value: payload.value ?? programme.unitValue,
            currency: programme.currency,
            status: payload.status || ALLOCATION_STATUS.PENDING,
            allocatedBy: actor._id,
            notes: payload.notes,
            clientRecordId: payload.clientRecordId,
          },
        ],
        opts
      );

      return created;
    });
  } catch (err) {
    // The unique index is the last line of defence against a double benefit.
    if (err.code === 11000) {
      const existing = await Allocation.findOne({ programme: programme._id, fisherman: fisherman._id })
        .select('status allocatedAt itemDescription')
        .lean();
      throw ApiError.conflict('This fisherman has already been allocated under this programme', {
        code: 'ALREADY_ALLOCATED',
        details: { existing },
      });
    }
    throw err;
  }

  await auditService.record({
    action: AUDIT_ACTIONS.ALLOCATION_ISSUED,
    entity: {
      type: 'Allocation',
      id: allocation._id,
      blueId: fisherman.blueId,
      label: `${programme.code} → ${fisherman.fullName}`,
    },
    lga: fisherman.lga,
    metadata: {
      programme: programme.code,
      overridden: Boolean(payload.overrideEligibility),
      overrideReason: payload.overrideReason,
    },
    req,
  });
  await cache.bumpNamespace(cache.NS.DASHBOARD);

  return allocation;
}

/** Marks an allocation delivered, optionally with a proof-of-collection image. */
async function markDelivered(allocationId, payload, actor, options = {}) {
  const { req, acknowledgementBuffer } = options;
  const allocation = await Allocation.findOne({ _id: allocationId, isDeleted: { $ne: true } });
  if (!allocation) throw ApiError.notFound('Allocation not found');
  assertCanAccessRecord(actor, allocation, { cooperativeField: null });

  if (allocation.status === ALLOCATION_STATUS.DELIVERED) {
    throw ApiError.conflict('This allocation is already marked as delivered');
  }
  if ([ALLOCATION_STATUS.REJECTED, ALLOCATION_STATUS.REVOKED].includes(allocation.status)) {
    throw ApiError.conflict(`A ${allocation.status.toLowerCase()} allocation cannot be delivered`);
  }

  const before = allocation.toObject();

  if (acknowledgementBuffer) {
    const media = await mediaService.uploadAcknowledgement(acknowledgementBuffer, {
      programmeCode: allocation.programmeCode,
      blueId: allocation.blueId,
    });
    allocation.acknowledgement = {
      ...media,
      signedAt: new Date(),
      receivedByName: payload.receivedByName,
      receivedByPhone: payload.receivedByPhone,
    };
  }

  allocation.status = ALLOCATION_STATUS.DELIVERED;
  allocation.deliveredAt = payload.deliveredAt || new Date();
  allocation.deliveredBy = actor._id;
  if (payload.notes) allocation.notes = payload.notes;

  // The status change and the counter move together, or neither does.
  await database.withTransaction(async (session) => {
    const opts = session ? { session } : {};
    await allocation.save(opts);
    await Programme.updateOne(
      { _id: allocation.programme },
      { $inc: { deliveredCount: 1 } },
      opts
    );
  });

  await auditService.record({
    action: AUDIT_ACTIONS.STATUS_CHANGE,
    entity: { type: 'Allocation', id: allocation._id, blueId: allocation.blueId },
    lga: allocation.lga,
    changes: auditService.diff(before, allocation.toObject()),
    req,
  });
  await cache.bumpNamespace(cache.NS.DASHBOARD);

  return allocation;
}

async function changeAllocationStatus(allocationId, { status, reason }, actor, options = {}) {
  const { req } = options;
  const allocation = await Allocation.findOne({ _id: allocationId, isDeleted: { $ne: true } });
  if (!allocation) throw ApiError.notFound('Allocation not found');
  assertCanAccessRecord(actor, allocation, { cooperativeField: null });

  const before = allocation.toObject();
  const wasDelivered = allocation.status === ALLOCATION_STATUS.DELIVERED;

  /**
   * Enforce the lifecycle.
   *
   * Any status was previously settable from any other, so DELIVERED could be
   * written directly — skipping `markDelivered`, and with it the
   * acknowledgement image, the deliveredAt/deliveredBy record and the counter
   * increment. The allocation would claim a delivery that has no evidence
   * behind it.
   */
  const permitted = ALLOCATION_TRANSITIONS[allocation.status] || [];

  if (status !== allocation.status && !permitted.includes(status)) {
    throw ApiError.conflict(
      `An allocation cannot move from ${allocation.status} to ${status}`,
      {
        code: 'INVALID_STATUS_TRANSITION',
        details: {
          from: allocation.status,
          to: status,
          permitted,
          ...(status === ALLOCATION_STATUS.DELIVERED
            ? { hint: 'Record a delivery through the deliver endpoint so proof is captured' }
            : {}),
        },
      }
    );
  }

  /**
   * Approving one's own allocation is the classic benefit-fraud path, so the
   * officer who raised it cannot be the one who signs it off.
   */
  if (status === ALLOCATION_STATUS.APPROVED) {
    assertNotSelfApproval(actor, allocation, { actorField: 'allocatedBy', action: 'approve' });
    allocation.approvedBy = actor._id;
    allocation.approvedAt = new Date();
  }
  if (status === ALLOCATION_STATUS.REJECTED) allocation.rejectionReason = reason;
  if (status === ALLOCATION_STATUS.REVOKED) allocation.revokedReason = reason;

  allocation.status = status;

  /**
   * Keep the programme's counters true, in one transaction with the status
   * change. Revoking or rejecting frees the slot in both the count and the
   * partial unique index so a corrected allocation can be made — and if the
   * benefit had already been delivered, the delivered count comes down too,
   * or the delivery rate drifts upward permanently.
   *
   * The decrements are guarded by the current value so a replayed or
   * out-of-order correction cannot drive a counter negative.
   */
  await database.withTransaction(async (session) => {
    const opts = session ? { session } : {};
    await allocation.save(opts);

    if (![ALLOCATION_STATUS.REVOKED, ALLOCATION_STATUS.REJECTED].includes(status)) return;

    await Programme.updateOne(
      { _id: allocation.programme, allocatedCount: { $gt: 0 } },
      { $inc: { allocatedCount: -1 } },
      opts
    );
    if (wasDelivered) {
      await Programme.updateOne(
        { _id: allocation.programme, deliveredCount: { $gt: 0 } },
        { $inc: { deliveredCount: -1 } },
        opts
      );
    }
  });

  await auditService.record({
    action: AUDIT_ACTIONS.STATUS_CHANGE,
    entity: { type: 'Allocation', id: allocation._id, blueId: allocation.blueId },
    lga: allocation.lga,
    changes: auditService.diff(before, allocation.toObject()),
    metadata: { reason },
    req,
  });

  return allocation;
}

async function listAllocations(query, actor) {
  const pagination = resolvePagination(query);
  const filter = {
    ...buildScopeFilter(actor, { ownerField: null, cooperativeField: null }),
    isDeleted: { $ne: true },
  };

  if (query.programme) filter.programme = query.programme;
  if (query.fisherman) filter.fisherman = query.fisherman;
  if (query.blueId) filter.blueId = query.blueId.toUpperCase();
  if (query.status) filter.status = query.status;
  if (query.programmeType) filter.programmeType = query.programmeType;
  if (query.lga) {
    assertCanAccessLga(actor, query.lga);
    filter.lga = query.lga;
  }
  if (query.from || query.to) {
    filter.allocatedAt = {};
    if (query.from) filter.allocatedAt.$gte = query.from;
    if (query.to) filter.allocatedAt.$lte = query.to;
  }

  return paginate(Allocation, filter, pagination, {
    sort: { allocatedAt: -1 },
    populate: [
      { path: 'programme', select: 'name code type year' },
      { path: 'allocatedBy', select: 'firstName lastName role' },
    ],
  });
}

/** Everything one fisherman has received — the §5 "benefits received" view. */
async function benefitHistory(fishermanId, actor) {
  const fisherman = await Fisherman.findById(fishermanId).select('blueId fullName lga').lean();
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  const allocations = await Allocation.find({ fisherman: fishermanId, isDeleted: { $ne: true } })
    .populate('programme', 'name code type year')
    .sort({ allocatedAt: -1 })
    .lean();

  const totalValue = allocations
    .filter((a) => a.status === ALLOCATION_STATUS.DELIVERED)
    .reduce((sum, a) => sum + (a.value || 0) * (a.quantity || 1), 0);

  return {
    fisherman,
    allocations,
    summary: {
      total: allocations.length,
      delivered: allocations.filter((a) => a.status === ALLOCATION_STATUS.DELIVERED).length,
      pending: allocations.filter((a) => a.status === ALLOCATION_STATUS.PENDING).length,
      totalValueDelivered: totalValue,
      byType: allocations.reduce((acc, a) => {
        acc[a.programmeType] = (acc[a.programmeType] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

async function softDelete(id, actor, options = {}) {
  const { req, reason } = options;
  if (!isStateWide(actor)) {
    throw ApiError.forbidden('Only state administrators may remove a programme');
  }
  const programme = await getById(id);
  if (programme.allocatedCount > 0) {
    throw ApiError.conflict('Archive this programme instead — allocations have already been made', {
      code: 'PROGRAMME_HAS_ALLOCATIONS',
    });
  }

  programme.isDeleted = true;
  programme.deletedAt = new Date();
  await programme.save();

  await auditService.record({
    action: AUDIT_ACTIONS.DELETE,
    entity: { type: 'Programme', id: programme._id, label: programme.name },
    metadata: { reason },
    req,
  });
  return programme;
}

/**
 * Recomputes `allocatedCount` and `deliveredCount` from the allocations
 * themselves.
 *
 * Even with every write transactional, stored counters are a cache of a
 * derivable fact, and a cache can be wrong — a restored backup, a manual
 * correction in the shell, or a historical record written before these
 * transactions existed. This runs on a schedule and reports what it changed,
 * so drift is corrected and visible rather than quietly wrong on a ministry
 * dashboard.
 */
async function reconcileCounters() {
  const totals = await Allocation.aggregate([
    { $match: { isDeleted: { $ne: true } } },
    {
      $group: {
        _id: '$programme',
        allocated: { $sum: { $cond: ['$isActiveAllocation', 1, 0] } },
        delivered: {
          $sum: { $cond: [{ $eq: ['$status', ALLOCATION_STATUS.DELIVERED] }, 1, 0] },
        },
      },
    },
  ]);

  const byProgramme = new Map(totals.map((t) => [String(t._id), t]));
  const programmes = await Programme.find({ isDeleted: { $ne: true } })
    .select('allocatedCount deliveredCount code')
    .lean();

  const corrections = [];
  const operations = [];

  for (const programme of programmes) {
    const actual = byProgramme.get(String(programme._id)) || { allocated: 0, delivered: 0 };
    const drifted =
      programme.allocatedCount !== actual.allocated ||
      programme.deliveredCount !== actual.delivered;

    if (!drifted) continue;

    corrections.push({
      programme: programme.code,
      allocatedCount: { from: programme.allocatedCount, to: actual.allocated },
      deliveredCount: { from: programme.deliveredCount, to: actual.delivered },
    });
    operations.push({
      updateOne: {
        filter: { _id: programme._id },
        update: {
          $set: { allocatedCount: actual.allocated, deliveredCount: actual.delivered },
        },
      },
    });
  }

  if (operations.length) await Programme.bulkWrite(operations);
  if (corrections.length) {
    logger.warn({ corrections }, 'Programme counters drifted and have been corrected');
  }

  return { checked: programmes.length, corrected: corrections.length, corrections };
}

module.exports = {
  create,
  list,
  getById,
  reconcileCounters,
  update,
  changeStatus,
  softDelete,
  listEligible,
  checkEligibility,
  eligibilityFilter,
  allocate,
  markDelivered,
  changeAllocationStatus,
  listAllocations,
  benefitHistory,
};
