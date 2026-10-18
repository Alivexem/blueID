'use strict';

const fishermenRepo = require('./fisherman.repository');
const { deriveMatchKeys, revealNin } = require('./fisherman.derive');
const communityRepo = require('../communities/community.repository');
const boatRepo = require('../assets/boat.repository');
const engineRepo = require('../assets/engine.repository');
const equipmentRepo = require('../assets/equipment.repository');
const allocationRepo = require('../programmes/allocation.repository');

const blueIdService = require('../../services/blueId.service');
const duplicateService = require('../../services/duplicate.service');
const auditService = require('../../services/audit.service');
const mediaService = require('../../services/media.service');
const cache = require('../../services/cache.service');

const ApiError = require('../../utils/ApiError');
const database = require('../../config/database');
const queue = require('../../services/queue.service');
const fieldCrypto = require('../../utils/fieldCrypto');
const { paginate, resolvePagination } = require('../../utils/pagination');
const { andFilters, resolveSort } = require('../../utils/query');
const {
  buildScopeFilter,
  assertCanAccessRecord,
  assertCanAccessLga,
  assertCanVerify,
  assertNotSelfApproval,
  resolveWritableLga,
  isStateWide,
  hasPermission,
} = require('../../middleware/authorize');
const {
  FISHERMAN_STATUS,
  FISHERMAN_TRANSITIONS,
  REGISTRATION_CHANNEL,
  AUDIT_ACTIONS,
  ALLOCATION_STATUS,
  PERMISSIONS,
  ROLES,
} = require('../../config/constants');

/**
 * Fishermen register — the core of the system.
 *
 * Lifecycle, and why it is shaped this way:
 *
 *   PENDING_VERIFICATION  a record captured in the field. It has no Blue ID.
 *   DUPLICATE_UNDER_REVIEW  the matcher found a strong candidate; held for a
 *                           human decision, never auto-deleted (§10).
 *   ACTIVE                verified by an administrator, Blue ID issued.
 *
 * The Blue ID is deliberately NOT issued at registration. The concept note
 * ties it to verification ("every verified fisherman") and the number is
 * permanent and printed on a card — issuing one to an unverified or duplicate
 * record would put a number into circulation that can never be cleanly
 * withdrawn.
 */

/** Fields a non-admin may never set directly. */
const PROTECTED_FIELDS = ['blueId', 'status', 'verification', 'duplicateFlags', 'mergedInto', 'match'];

async function resolveCommunity(communityId, lga) {
  if (!communityId) return null;
  const community = await communityRepo.findById(communityId);
  if (!community) throw ApiError.badRequest('Unknown community', { code: 'UNKNOWN_COMMUNITY' });
  if (lga && community.lga !== lga) {
    throw ApiError.badRequest('The selected community is not in that Local Government Area', {
      code: 'COMMUNITY_LGA_MISMATCH',
      details: { communityLga: community.lga, submittedLga: lga },
    });
  }
  return community;
}

/**
 * Registers a fisherman.
 *
 * @param {object} payload   validated request body
 * @param {object} actor     the authenticated user
 * @param {object} options   { req, channel, device, skipDuplicateCheck }
 */
async function create(payload, actor, options = {}) {
  const { req, channel = REGISTRATION_CHANNEL.WEB_PORTAL, device = null, session = null } = options;

  const lga = resolveWritableLga(actor, payload.lga);
  const community = await resolveCommunity(payload.community, lga);

  /**
   * Strip authority fields before anything else.
   *
   * These were only removed on the UPDATE path, so a caller that reached
   * `create` with an unfiltered payload — the offline sync path did exactly
   * that — could assign a Blue ID the counter never issued, or a forged
   * verification. The sync layer now validates per entity as well; this is
   * the second lock on the same door, because `create` is reachable from
   * more than one place.
   */
  const safePayload = { ...payload };
  for (const field of PROTECTED_FIELDS) delete safePayload[field];
  delete safePayload.verificationToken;
  delete safePayload.qrVersion;
  delete safePayload.tempReference;

  const draft = {
    ...safePayload,
    lga,
    communityName: community?.name || payload.communityName,
    registrationChannel: channel,
    registeredBy: actor.id || actor._id,
    device: device?.id || device?._id,
    capturedAt: payload.capturedAt || new Date(),
    status: FISHERMAN_STATUS.PENDING_VERIFICATION,
  };

  // --- Duplicate screening (§10) -------------------------------------------
  let duplicates = { matches: [], hasDuplicate: false };
  let pendingFlags = [];
  if (!options.skipDuplicateCheck) {
    duplicates = await duplicateService.findDuplicates(draft);
    if (duplicates.hasDuplicate) {
      draft.status = FISHERMAN_STATUS.DUPLICATE_UNDER_REVIEW;
      // Flags are rows now, so they are written after the record exists —
      // inside the same transaction, so a flagged registration can never
      // commit without its flags.
      pendingFlags = duplicateService.buildFlags(duplicates.matches, 'REGISTRATION');
    }
  }

  /**
   * The registration and any follow-up job are committed together.
   *
   * These were two independent writes, so a crash in between committed the
   * registration and lost the duplicate-review notification — the flagged
   * record would then sit unreviewed with nobody told. That is the exact gap
   * the outbox pattern exists to close, and closing it requires the job row
   * to be written inside this transaction.
   */
  let fisherman;

  await database.withTransaction(async (txClient) => {
    const client = session || txClient;

    fisherman = await fishermenRepo.create(draft, { client, derive: deriveMatchKeys });

    if (pendingFlags.length) {
      await fishermenRepo.addDuplicateFlags(fisherman.id, pendingFlags, { client });
    }

    if (duplicates.hasDuplicate) {
      await queue.enqueue(
        queue.JOB_TYPES.DUPLICATE_REVIEW_NOTIFY,
        {
          fishermanId: String(fisherman.id),
          lga,
          matches: duplicates.matches.map((m) => ({
            blueId: m.blueId,
            fullName: m.fullName,
            score: m.score,
            reasons: m.reasons,
          })),
        },
        { dedupeKey: `dup-notify:${fisherman.id}`, session: client, req }
      );
    }
  }, session);

  await auditService.recordChange({
    action: AUDIT_ACTIONS.CREATE,
    entityType: 'Fisherman',
    doc: fisherman,
    req,
    metadata: {
      channel,
      duplicateScore: duplicates.highestScore,
      duplicatesFound: duplicates.matches.length,
    },
  });

  if (duplicates.hasDuplicate) {
    await auditService.record({
      action: AUDIT_ACTIONS.DUPLICATE_FLAGGED,
      entity: { type: 'Fisherman', id: fisherman.id, label: fisherman.fullName },
      lga,
      metadata: { matches: duplicates.matches.map((m) => ({ id: m.candidateId, score: m.score })) },
      req,
    });
    // The notification job was already committed alongside the registration,
    // inside the transaction above.
  }

  await cache.bumpNamespace(cache.NS.DASHBOARD);

  return { fisherman, duplicates };
}

const SORTABLE_FIELDS = ['createdAt', 'updatedAt', 'fullName', 'status', 'lga'];

/**
 * Scope for the caller, as the repository expects it.
 *
 * Exported and pure so the authorization behaviour can be unit-tested
 * without a database. It is a parameter on every read rather than something
 * each query remembers to add — the defect this replaced was a search clause
 * overwriting the scope filter and exposing the whole state register, which
 * was invisible at the route level.
 */
function scopeFor(actor) {
  if (isStateWide(actor)) return { stateWide: true };

  const scope = { lgas: scopedLgas(actor) };
  if (actor.role === ROLES.ENUMERATOR) {
    scope.ownerId = actor.id || actor._id;
    scope.communities = actor.scope?.communities || [];
  }
  if (actor.role === ROLES.COOPERATIVE_OFFICER && actor.cooperative) {
    scope.cooperativeId = actor.cooperative;
  }
  return scope;
}

/** Lists fishermen within the caller's scope. */
async function list(query, actor) {
  const term = String(query.search || '').trim();
  const search = {};

  // Pick the index that fits the term rather than scanning: an exact Blue
  // ID, an exact normalised phone, a blind-indexed NIN, or the full-text
  // vector for a name.
  if (term) {
    if (blueIdService.isWellFormed(term)) {
      search.searchBlueId = true;
    } else {
      const { normalizePhone, normalizeNin } = require('../../utils/normalize');
      const phone = normalizePhone(term);
      const nin = normalizeNin(term);
      if (phone) search.searchPhone = phone;
      else if (nin) search.searchNinIndex = fieldCrypto.blindIndex(nin);
    }
  }

  return fishermenRepo.list({ ...query, search: term || undefined, ...search }, {
    scope: scopeFor(actor),
  });
}

/**
 * Loads one record and enforces OBJECT-LEVEL authorization.
 *
 * This is the IDOR boundary: knowing an id must never be enough. The check
 * uses the same rules as the list filter, so a record a user can see in a list
 * is a record they can open, and nothing else is.
 *
 * `includeNin` additionally requires the `fisherman:read_sensitive` grant and
 * writes an audit entry, because reading a National Identification Number is a
 * privileged act, not an ordinary field read.
 */
async function getById(
  id,
  actor,
  { includeAssets = false, signPhoto = true, includeNin = false, req } = {}
) {
  const canReadSensitive = hasPermission(actor, PERMISSIONS.FISHERMAN_READ_SENSITIVE);

  // The encrypted NIN is only selected by a query that says so, so a caller
  // without the grant cannot receive it even by accident.
  const fisherman = await fishermenRepo.findById(id, { withSensitive: canReadSensitive });

  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  const result = { ...fisherman };

  if (canReadSensitive && fisherman.nin) {
    if (includeNin) {
      result.nin = revealNin(fisherman);
      // Deliberately awaited: an unlogged read of a NIN is the gap an audit
      // trail exists to close.
      await auditService.record({
        action: AUDIT_ACTIONS.VIEW_SENSITIVE,
        entity: {
          type: 'Fisherman',
          id: fisherman.id,
          blueId: fisherman.blueId,
          label: fisherman.fullName,
        },
        lga: fisherman.lga,
        metadata: { field: 'nin' },
        req,
      });
    } else {
      const plain = revealNin(fisherman);
      result.ninMasked = plain ? fieldCrypto.mask(plain) : undefined;
      delete result.nin;
    }
  } else {
    // Absent entirely rather than null, so a response never hints that a
    // record has a NIN the caller may not see.
    delete result.nin;
  }

  if (signPhoto && result.photo?.publicId) {
    result.photo = mediaService.withSignedUrl(result.photo);
  }

  if (includeAssets) {
    const [boats, engines, equipment, allocations] = await Promise.all([
      boatRepo.findByOwner(id),
      engineRepo.findByOwner(id),
      equipmentRepo.findByOwner(id),
      allocationRepo.findByFisherman(id),
    ]);
    result.boats = boats;
    result.engines = engines;
    result.equipment = equipment;
    result.allocations = allocations;
  }

  return result;
}

async function getByBlueId(blueId, actor, options) {
  const fisherman = await fishermenRepo.findByBlueId(blueId);
  if (!fisherman) throw ApiError.notFound('No fisherman found with that Blue ID');
  return getById(fisherman._id, actor, options);
}

/** Updates a record. Protected fields are stripped unless the caller is an admin. */
async function update(id, payload, actor, options = {}) {
  const { req } = options;
  const fisherman = await fishermenRepo.findById(id);
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  // An enumerator may only correct a record they captured, and only while it
  // is still unverified — after verification the data is authoritative.
  if (actor.role === ROLES.ENUMERATOR) {
    if (String(fisherman.registeredBy) !== String(actor.id || actor._id)) {
      throw ApiError.forbidden('You can only edit registrations you captured');
    }
    if (fisherman.status === FISHERMAN_STATUS.ACTIVE) {
      throw ApiError.forbidden('This record has been verified — ask an administrator to amend it');
    }
  }

  const before = { ...fisherman };
  const updates = { ...payload };
  for (const field of PROTECTED_FIELDS) delete updates[field];

  if (updates.lga) {
    updates.lga = resolveWritableLga(actor, updates.lga);
  }
  if (updates.community) {
    const community = await resolveCommunity(updates.community, updates.lga || fisherman.lga);
    updates.communityName = community?.name;
  }

  // Identity changes re-open the duplicate question. Computed from the
  // payload rather than from a dirty-tracking flag, which no longer exists.
  const identityTouched = ['firstName', 'middleName', 'lastName', 'phone', 'nin', 'dateOfBirth']
    .some((f) => updates[f] !== undefined && String(updates[f]) !== String(before[f] ?? ''));

  let updated = await fishermenRepo.update(id, updates, { derive: deriveMatchKeys });

  let duplicates = null;
  if (identityTouched) {
    duplicates = await duplicateService.findDuplicates(updated, { excludeId: updated.id });
    if (duplicates.hasDuplicate && updated.status !== FISHERMAN_STATUS.ACTIVE) {
      await fishermenRepo.addDuplicateFlags(
        updated.id,
        duplicateService.buildFlags(duplicates.matches, 'REGISTRATION')
      );
      updated = await fishermenRepo.changeStatus(updated.id, {
        status: FISHERMAN_STATUS.DUPLICATE_UNDER_REVIEW,
        reason: 'possible duplicate found after an identity change',
        changedBy: actor.id || actor._id,
      });
    }
  }

  await auditService.recordChange({
    action: AUDIT_ACTIONS.UPDATE,
    entityType: 'Fisherman',
    doc: updated,
    before,
    req,
  });
  await cache.bumpNamespace(cache.NS.DASHBOARD);

  return { fisherman: updated, duplicates };
}

/**
 * Verifies a record and issues its permanent Blue ID.
 *
 * This is the only path that mints a Blue ID. It refuses while a duplicate
 * flag is unresolved, which is what stops a duplicate from acquiring a
 * permanent number and entering the benefit stream.
 */
async function verify(id, actor, options = {}) {
  const { req, notes, session = null } = options;
  assertCanVerify(actor);

  const fisherman = await fishermenRepo.findById(id);
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  if (fisherman.blueId) {
    throw ApiError.conflict('This fisherman already holds a Blue ID', {
      code: 'ALREADY_VERIFIED',
      details: { blueId: fisherman.blueId },
    });
  }
  /**
   * An unresolved duplicate blocks verification.
   *
   * This is what stops a duplicate acquiring a permanent number and
   * entering the benefit stream, which is the failure section 10 exists to
   * prevent and the one that is hardest to unpick afterwards.
   */
  const openFlags = await fishermenRepo.listDuplicateFlags(id, { status: 'PENDING' });
  if (openFlags.length) {
    throw ApiError.conflict('Resolve the outstanding duplicate review before verifying this record', {
      code: 'DUPLICATE_REVIEW_PENDING',
      details: {
        flags: openFlags.map((f) => ({ candidate: f.candidate, score: f.score, reasons: f.reasons })),
      },
    });
  }
  if (!fisherman.photo?.url) {
    throw ApiError.badRequest('A passport photograph is required before a Blue ID can be issued', {
      code: 'PHOTO_REQUIRED',
    });
  }

  /**
   * Separation of duties: the officer who captured the record must not be the
   * one who certifies it. An LGA administrator may legitimately register
   * someone in the field and still must not sign off their own entry.
   */
  assertNotSelfApproval(actor, fisherman, { actorField: 'registeredBy', action: 'verify' });

  const before = { ...fisherman };

  /**
   * Issuing a Blue ID is the one genuinely irreversible act in the system:
   * the number is printed on a card and becomes the person's permanent
   * reference. Allocating the sequence and persisting it must therefore be
   * atomic — otherwise a failure after allocation silently burns a number,
   * and a failure after the write leaves assets pointing at nothing.
   */
  let issuedRecord;

  const blueId = await database.withTransaction(async (txClient) => {
    const client = session || txClient;

    /**
     * Take the number first, inside the transaction.
     *
     * The counter is transactional, so an abandoned verification gives its
     * number back rather than leaving a permanent gap in a sequence the
     * Ministry reads as a count.
     */
    const { blueId: issued } = await blueIdService.issue(fisherman.lga, client);

    /**
     * Attach it conditionally on the record still having none.
     *
     * The guard earlier read a record loaded before this call, so two
     * administrators verifying the same registration at the same moment
     * both passed it. This UPDATE can only match once; the loser's whole
     * transaction rolls back, returning its sequence number with it.
     */
    const claimed = await fishermenRepo.assignBlueId(
      fisherman.id,
      {
        blueId: issued,
        // A fresh opaque token for the printed card. Never the Blue ID
        // itself: a card photographed by a stranger would otherwise hand
        // over a real identifier.
        verificationToken: qrService.newToken(),
        verifiedBy: actor.id || actor._id,
      },
      { client }
    );

    if (!claimed) {
      throw ApiError.conflict('This fisherman has just been verified by someone else', {
        code: 'ALREADY_VERIFIED',
      });
    }

    if (notes) {
      await fishermenRepo.update(claimed.id, { verificationNotes: notes }, { client });
    }

    // Denormalised Blue ID on the assets, so listings and exports never need
    // a join back to the register.
    await fishermenRepo.stampBlueIdOnAssets(claimed.id, issued, { client });

    issuedRecord = claimed;
    return issued;
  }, session);

  await auditService.record({
    action: AUDIT_ACTIONS.BLUE_ID_ISSUED,
    entity: { type: 'Fisherman', id: issuedRecord.id, blueId, label: issuedRecord.fullName },
    lga: issuedRecord.lga,
    changes: auditService.diff(before, issuedRecord),
    metadata: { notes },
    req,
  });
  await cache.bumpNamespace(cache.NS.DASHBOARD);

  return issuedRecord;
}

/** Changes lifecycle status (suspend, mark deceased, reactivate). */
async function changeStatus(id, { status, reason }, actor, options = {}) {
  const { req } = options;
  assertCanVerify(actor);

  const fisherman = await Fisherman.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  if (status === FISHERMAN_STATUS.ACTIVE && !fisherman.blueId) {
    throw ApiError.badRequest('Verify this record to activate it — a Blue ID has not been issued', {
      code: 'NOT_VERIFIED',
    });
  }

  /**
   * Enforce the lifecycle.
   *
   * Any enum value was previously accepted from any state, so a record could
   * be moved from DECEASED back to ACTIVE, or out of DUPLICATE_UNDER_REVIEW
   * without the review ever being resolved — releasing a suspected duplicate
   * straight into the benefit stream.
   */
  const permitted = FISHERMAN_TRANSITIONS[fisherman.status] || [];

  if (status !== fisherman.status && !permitted.includes(status)) {
    throw ApiError.conflict(
      `A record cannot move from ${fisherman.status} to ${status}`,
      {
        code: 'INVALID_STATUS_TRANSITION',
        details: { from: fisherman.status, to: status, permitted },
      }
    );
  }

  /**
   * A duplicate review is closed by deciding it, not by overwriting the
   * status. Allowing the latter would let an administrator clear a flag
   * without recording a resolution anyone could later review.
   */
  if (fisherman.hasOpenDuplicateFlag() && status === FISHERMAN_STATUS.ACTIVE) {
    throw ApiError.conflict('Resolve the outstanding duplicate review first', {
      code: 'DUPLICATE_REVIEW_PENDING',
    });
  }

  const before = fisherman.toObject();
  fisherman.status = status;
  fisherman.statusReason = reason;
  fisherman.statusChangedBy = actor._id;
  await fisherman.save();

  await auditService.record({
    action: AUDIT_ACTIONS.STATUS_CHANGE,
    entity: {
      type: 'Fisherman',
      id: fisherman._id,
      blueId: fisherman.blueId,
      label: fisherman.fullName,
    },
    lga: fisherman.lga,
    changes: auditService.diff(before, fisherman.toObject()),
    metadata: { reason },
    req,
  });
  await cache.bumpNamespace(cache.NS.DASHBOARD);

  return fisherman;
}

/** Re-runs duplicate detection on demand. */
async function checkDuplicates(id, actor) {
  const fisherman = await Fisherman.findById(id);
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });
  return duplicateService.findDuplicates(fisherman, { excludeId: fisherman._id });
}

/**
 * Records an administrator's decision on a flagged duplicate.
 * `MERGED` moves assets and benefit history onto the surviving record and
 * retires this one — the only operation that takes a record out of
 * circulation, and it is reversible through the audit trail.
 */
async function resolveDuplicate(id, { flagId, resolution, note, survivorId }, actor, options = {}) {
  const { req } = options;
  assertCanVerify(actor);

  const fisherman = await Fisherman.findById(id);
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  /**
   * Separation of duties on duplicate review.
   *
   * The officer who captured a record is the one most likely to have created
   * the duplicate, and was previously free to dismiss the flag on their own
   * work. A second pair of eyes is the entire point of flagging for review
   * rather than resolving automatically.
   */
  assertNotSelfApproval(actor, fisherman, {
    actorField: 'registeredBy',
    action: 'resolve a duplicate review for',
  });

  const flag = fisherman.duplicateFlags.id(flagId);
  if (!flag) throw ApiError.notFound('Duplicate flag not found');
  if (flag.resolution !== 'PENDING') {
    throw ApiError.conflict('This duplicate flag has already been resolved');
  }

  flag.resolution = resolution;
  flag.resolvedBy = actor._id;
  flag.resolvedAt = new Date();
  flag.resolutionNote = note;

  if (resolution === 'NOT_DUPLICATE') {
    // Clearing the last open flag releases the record back for verification.
    if (!fisherman.hasOpenDuplicateFlag()) {
      fisherman.status = fisherman.blueId
        ? FISHERMAN_STATUS.ACTIVE
        : FISHERMAN_STATUS.PENDING_VERIFICATION;
    }
  } else if (resolution === 'MARKED_DUPLICATE') {
    fisherman.status = FISHERMAN_STATUS.DUPLICATE_UNDER_REVIEW;
  } else if (resolution === 'MERGED') {
    /**
     * Merging retires one identity into another and moves its benefit
     * history. That is a bigger power than verification, so it has its own
     * grant — which was declared in the permission table and never checked.
     */
    if (!hasPermission(actor, PERMISSIONS.DUPLICATE_MERGE)) {
      throw ApiError.forbidden('Merging records requires the duplicate:merge permission', {
        code: 'MISSING_PERMISSION',
        details: { required: PERMISSIONS.DUPLICATE_MERGE, yourRole: actor.role },
      });
    }
    const survivor = survivorId || flag.candidate;
    // mergeInto commits the loser inside its own transaction.
    await mergeInto(fisherman, survivor, actor, { req });
  }

  // Already saved by the merge path; saving again would raise a VersionError.
  if (resolution !== 'MERGED') await fisherman.save();

  await auditService.record({
    action: AUDIT_ACTIONS.DUPLICATE_RESOLVED,
    entity: {
      type: 'Fisherman',
      id: fisherman._id,
      blueId: fisherman.blueId,
      label: fisherman.fullName,
    },
    lga: fisherman.lga,
    metadata: { flagId, resolution, note, survivorId },
    req,
  });

  return fisherman;
}

/**
 * Moves everything owned by `loser` onto `survivorId`, then retires the loser.
 * Nothing is deleted: the retired record keeps its history and points at the
 * survivor, so a merge made in error can be understood and undone.
 */
async function mergeInto(loser, survivorId, actor, options = {}) {
  const { req } = options;
  const survivor = await Fisherman.findById(survivorId);
  if (!survivor) throw ApiError.badRequest('The record to merge into does not exist');
  if (String(survivor._id) === String(loser._id)) {
    throw ApiError.badRequest('A record cannot be merged into itself');
  }

  /**
   * The whole merge runs in one transaction.
   *
   * Previously these four updates ran concurrently with no transaction, and
   * the allocation move could fail on the uniqueness index — precisely when
   * both records hold an active allocation under the same programme, which is
   * exactly what a real duplicate looks like. The assets had already moved by
   * then and the loser was never marked merged, leaving the survivor holding
   * assets with no merge record and the "duplicate" still active. All or
   * nothing is the only safe shape here.
   */
  const moved = await database.withTransaction(async (session) => {
    const opts = session ? { session } : {};
    const ownerUpdate = { $set: { owner: survivor._id, blueId: survivor.blueId } };

    const [boats, engines, equipment] = await Promise.all([
      Boat.updateMany({ owner: loser._id }, ownerUpdate, opts),
      Engine.updateMany({ owner: loser._id }, ownerUpdate, opts),
      Equipment.updateMany({ owner: loser._id }, ownerUpdate, opts),
    ]);

    /**
     * Benefit history moves too, so the survivor's record shows everything
     * this person has already received and cannot collect twice.
     *
     * Where both records hold an ACTIVE allocation for the same programme,
     * moving the loser's would duplicate the survivor's slot. The duplicate is
     * superseded rather than moved: the record is kept for audit, pointed at
     * the survivor, and marked inactive with an explanation.
     */
    const survivorActive = await Allocation.find({
      fisherman: survivor._id,
      isActiveAllocation: true,
    })
      .select('programme')
      .lean()
      .session(session || null);

    const occupiedProgrammes = survivorActive.map((a) => a.programme);

    const superseded = occupiedProgrammes.length
      ? await Allocation.updateMany(
          {
            fisherman: loser._id,
            isActiveAllocation: true,
            programme: { $in: occupiedProgrammes },
          },
          {
            $set: {
              fisherman: survivor._id,
              blueId: survivor.blueId,
              status: ALLOCATION_STATUS.REVOKED,
              isActiveAllocation: false,
              revokedReason: `Superseded by the surviving record during a duplicate merge`,
            },
          },
          opts
        )
      : { modifiedCount: 0 };

    // Everything else moves across untouched.
    const allocations = await Allocation.updateMany(
      { fisherman: loser._id },
      { $set: { fisherman: survivor._id, blueId: survivor.blueId } },
      opts
    );

    loser.mergedInto = survivor._id;
    loser.status = FISHERMAN_STATUS.INACTIVE;
    loser.statusReason = `Merged into ${survivor.blueId || survivor._id}`;
    loser.statusChangedBy = actor._id;
    await loser.save(opts);

    return {
      boats: boats.modifiedCount,
      engines: engines.modifiedCount,
      equipment: equipment.modifiedCount,
      allocations: allocations.modifiedCount,
      supersededAllocations: superseded.modifiedCount,
    };
  });

  await auditService.record({
    action: AUDIT_ACTIONS.MERGE,
    entity: { type: 'Fisherman', id: loser._id, blueId: loser.blueId, label: loser.fullName },
    lga: loser.lga,
    metadata: {
      survivor: survivor._id,
      survivorBlueId: survivor.blueId,
      moved,
    },
    req,
  });

  await cache.bumpNamespace(cache.NS.DASHBOARD);
  return survivor;
}

/** Soft delete. The row stays for audit; it simply leaves every query. */
async function softDelete(id, actor, options = {}) {
  const { req, reason } = options;
  assertCanVerify(actor);

  const fisherman = await Fisherman.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  if (fisherman.blueId && !isStateWide(actor)) {
    throw ApiError.forbidden('Only state administrators may remove a record that holds a Blue ID');
  }

  /**
   * Withdrawing a registration withdraws its assets with it.
   *
   * The soft delete used to apply to the fisherman alone, so their boats and
   * engines stayed "active" and kept counting towards the state totals — the
   * §7 dashboard over-reported registered boats after every deletion. Benefit
   * ALLOCATIONS are deliberately left intact: they are the record that public
   * money was issued, and that history survives the registration.
   */
  const deletedAt = new Date();
  const cascade = await database.withTransaction(async (session) => {
    const opts = session ? { session } : {};
    const tombstone = { $set: { isDeleted: true, deletedAt, isActive: false } };

    const [boats, engines, equipment] = await Promise.all([
      Boat.updateMany({ owner: fisherman._id, isDeleted: { $ne: true } }, tombstone, opts),
      Engine.updateMany({ owner: fisherman._id, isDeleted: { $ne: true } }, tombstone, opts),
      Equipment.updateMany({ owner: fisherman._id, isDeleted: { $ne: true } }, tombstone, opts),
    ]);

    fisherman.isDeleted = true;
    fisherman.deletedAt = deletedAt;
    fisherman.deletedBy = actor._id;
    await fisherman.save(opts);

    return {
      boats: boats.modifiedCount,
      engines: engines.modifiedCount,
      equipment: equipment.modifiedCount,
    };
  });

  await auditService.record({
    action: AUDIT_ACTIONS.DELETE,
    entity: {
      type: 'Fisherman',
      id: fisherman._id,
      blueId: fisherman.blueId,
      label: fisherman.fullName,
    },
    lga: fisherman.lga,
    metadata: { reason, cascade },
    req,
  });
  await cache.bumpNamespace(cache.NS.DASHBOARD);

  return fisherman;
}

/** Attaches an uploaded photograph to a record. */
async function setPhoto(id, buffer, actor, options = {}) {
  const { req } = options;
  const fisherman = await Fisherman.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  const previousPublicId = fisherman.photo?.publicId;

  fisherman.photo = await mediaService.uploadFishermanPhoto(buffer, {
    lga: fisherman.lga,
    blueId: fisherman.blueId,
    clientRecordId: fisherman.clientRecordId,
  });
  await fisherman.save();

  // Replace, don't accumulate — a stale photo is still personal data.
  if (previousPublicId && previousPublicId !== fisherman.photo.publicId) {
    mediaService.destroy(previousPublicId).catch(() => {});
  }

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: {
      type: 'Fisherman',
      id: fisherman._id,
      blueId: fisherman.blueId,
      label: fisherman.fullName,
    },
    lga: fisherman.lga,
    changes: [{ field: 'photo', from: previousPublicId, to: fisherman.photo.publicId }],
    req,
  });

  return fisherman;
}

/**
 * Returns the data needed to print a Blue ID card, including the opaque
 * verification token.
 *
 * Separate from `getById` because the token is deliberately excluded from
 * normal serialisation: it is a lookup credential for the physical card, so it
 * leaves the system only when a card is actually being produced, and that act
 * is audited.
 */
async function getCardToken(id, actor, options = {}) {
  const { req } = options;

  const fisherman = await Fisherman.findOne({ _id: id, isDeleted: { $ne: true } }).select(
    '+verificationToken blueId qrVersion fullName lga community communityName photo registeredBy status'
  );
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  if (!fisherman.blueId) {
    throw ApiError.badRequest('This record has not been verified — no Blue ID has been issued', {
      code: 'BLUE_ID_NOT_ISSUED',
    });
  }

  // Older records verified before opaque tokens existed get one on first use.
  if (!fisherman.verificationToken) {
    fisherman.rotateVerificationToken();
    await fisherman.save();
  }

  await auditService.record({
    action: AUDIT_ACTIONS.VIEW_SENSITIVE,
    entity: {
      type: 'Fisherman',
      id: fisherman._id,
      blueId: fisherman.blueId,
      label: fisherman.fullName,
    },
    lga: fisherman.lga,
    metadata: { field: 'verificationToken', reason: 'card issuance' },
    req,
  });

  return {
    blueId: fisherman.blueId,
    verificationToken: fisherman.verificationToken,
    qrVersion: fisherman.qrVersion,
    fullName: fisherman.fullName,
    lga: fisherman.lga,
    communityName: fisherman.communityName,
  };
}

/**
 * Reissues a card: rotates the opaque token so the previous printed card stops
 * validating. Used when a card is lost or reported stolen.
 */
async function reissueCard(id, actor, options = {}) {
  const { req, reason } = options;
  assertCanVerify(actor);

  const fisherman = await Fisherman.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!fisherman) throw ApiError.notFound('Fisherman not found');
  assertCanAccessRecord(actor, fisherman, { cooperativeField: 'cooperative.id' });

  if (!fisherman.blueId) {
    throw ApiError.badRequest('This record has not been verified', { code: 'BLUE_ID_NOT_ISSUED' });
  }

  const previousVersion = fisherman.qrVersion;
  fisherman.rotateVerificationToken();
  fisherman.idCardIssuedAt = new Date();
  fisherman.idCardIssuedBy = actor._id;
  await fisherman.save();

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: {
      type: 'Fisherman',
      id: fisherman._id,
      blueId: fisherman.blueId,
      label: fisherman.fullName,
    },
    lga: fisherman.lga,
    changes: [{ field: 'qrVersion', from: previousVersion, to: fisherman.qrVersion }],
    metadata: { reason, cardReissued: true },
    req,
  });

  return fisherman;
}

module.exports = {
  create,
  list,
  buildListFilter,
  getCardToken,
  reissueCard,
  getById,
  getByBlueId,
  update,
  verify,
  changeStatus,
  checkDuplicates,
  resolveDuplicate,
  mergeInto,
  softDelete,
  setPhoto,
  SORTABLE_FIELDS,
};
