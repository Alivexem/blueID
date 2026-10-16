'use strict';

const emailService = require('../services/email.service');
const cache = require('../services/cache.service');
const logger = require('../config/logger');
const { JOB_TYPES } = require('../services/queue.service');
const { ROLES, USER_STATUS } = require('../config/constants');

/**
 * Background job handlers.
 *
 * Every handler must be IDEMPOTENT. The queue is at-least-once: a worker that
 * dies after doing the work but before acknowledging it will see the job
 * again. For side effects that must not repeat (an email, an allocation
 * notice) the enqueuing caller supplies a `dedupeKey`, and the handler itself
 * is written so a repeat is harmless.
 *
 * Handlers throw on failure — the worker records the attempt and schedules a
 * retry with backoff.
 */

/** Generic transactional email. */
async function sendEmail({ to, subject, html, text, tags }, job) {
  const queue = require('../services/queue.service');
  const result = await queue.once(job, 'email', () =>
    emailService.send({ to, subject, html, text, tags })
  );
  if (result?.skipped) return result;

  // A provider rejection is retryable; a missing recipient is not.
  if (!result.sent && result.error) {
    throw new Error(`Email delivery failed: ${result.error}`);
  }
  return result;
}

/** Alerts LGA and state administrators that a record needs a duplicate decision. */
async function notifyDuplicateReview({ fishermanId, lga, matches }, job) {
  const User = require('../modules/users/user.model');
  const Fisherman = require('../modules/fishermen/fisherman.model');

  const fisherman = await Fisherman.findById(fishermanId).select('fullName lga').lean();
  if (!fisherman) {
    logger.info({ fishermanId }, 'Duplicate notification skipped — record no longer exists');
    return { skipped: true };
  }

  const reviewers = await User.find({
    status: USER_STATUS.ACTIVE,
    isDeleted: { $ne: true },
    $or: [
      { role: ROLES.LGA_ADMIN, 'scope.lgas': lga },
      { role: { $in: [ROLES.STATE_ADMIN, ROLES.SUPER_ADMIN] } },
    ],
  })
    .select('email')
    .limit(10)
    .lean();

  const recipients = reviewers.map((r) => r.email).filter(Boolean);
  if (!recipients.length) {
    logger.warn({ lga }, 'No active reviewer to notify about a duplicate');
    return { skipped: true };
  }

  const queue = require('../services/queue.service');
  return queue.once(job, 'email', () =>
    emailService.sendDuplicateReviewAlert({
      to: recipients,
      fisherman: { id: fishermanId, fullName: fisherman.fullName },
      matches: matches || [],
      lga,
    })
  );
}

/** Confirms a benefit was recorded against a Blue ID. */
async function notifyAllocation(
  { to, fishermanName, blueId, programmeName, itemDescription },
  job
) {
  if (!to) return { skipped: 'no recipient' };
  const queue = require('../services/queue.service');
  return queue.once(job, 'email', () =>
    emailService.sendAllocationNotice({
      to,
      fishermanName,
      blueId,
      programmeName,
      itemDescription,
    })
  );
}

/** Warns administrators that part of a device's sync batch was rejected. */
async function notifySyncFailure({ to, deviceCode, rejected, batchId }, job) {
  if (!to?.length) return { skipped: 'no recipient' };
  const queue = require('../services/queue.service');
  return queue.once(job, 'email', () =>
    emailService.sendSyncFailureAlert({ to, deviceCode, rejected, batchId })
  );
}

/**
 * Recomputes the denormalised per-community counters that the GIS map reads.
 * Moved off the request path: it touches every community in an LGA and would
 * otherwise make a single registration slow.
 */
async function recalculateCommunityStats({ lga }) {
  const communityService = require('../modules/communities/community.service');
  const result = await communityService.recalculateStats(lga);
  logger.info({ lga, ...result }, 'Community statistics recalculated');
  return result;
}

async function recountCooperativeMembers() {
  const cooperativeService = require('../modules/cooperatives/cooperative.service');
  const result = await cooperativeService.recountMembers();
  logger.info(result, 'Cooperative membership counts rebuilt');
  return result;
}

/**
 * Pre-warms the state-wide dashboard aggregate.
 *
 * The executive summary scans a large slice of the register. Computing it on a
 * schedule means the first administrator of the morning gets a cached answer
 * rather than paying for the scan interactively.
 */
async function warmDashboard() {
  const dashboardService = require('../modules/dashboard/dashboard.service');
  const { ROLE_PERMISSIONS } = require('../config/constants');

  // A synthetic state-wide principal: the warm pass must populate the cache
  // key that state-level users actually read.
  const systemActor = {
    _id: null,
    role: ROLES.STATE_ADMIN,
    scope: { lgas: [], communities: [] },
    permissions: ROLE_PERMISSIONS[ROLES.STATE_ADMIN],
  };

  await dashboardService.summary({}, systemActor);
  await dashboardService.capacityByLga({}, systemActor);
  logger.debug('Dashboard aggregates warmed');
  return { warmed: true };
}

/**
 * Recomputes programme counters from the allocations themselves, so a
 * restored backup or a manual correction cannot leave the dashboard's
 * delivery figures permanently wrong.
 */
async function reconcileProgrammeCounters() {
  const programmeService = require('../modules/programmes/programme.service');
  const result = await programmeService.reconcileCounters();
  if (result.corrected > 0) {
    logger.warn(result, 'Programme counters reconciled');
  }
  return result;
}

/** Housekeeping: drop completed jobs and expired cache namespaces. */
async function sweepOutbox({ olderThanDays = 7 } = {}) {
  const queue = require('../services/queue.service');
  const deleted = await queue.sweep(olderThanDays);
  logger.info({ deleted }, 'Completed jobs swept');
  return { deleted };
}

/** Registry consulted by the worker loop. */
const HANDLERS = Object.freeze({
  [JOB_TYPES.EMAIL_SEND]: sendEmail,
  [JOB_TYPES.DUPLICATE_REVIEW_NOTIFY]: notifyDuplicateReview,
  [JOB_TYPES.ALLOCATION_NOTIFY]: notifyAllocation,
  [JOB_TYPES.SYNC_FAILURE_NOTIFY]: notifySyncFailure,
  [JOB_TYPES.COMMUNITY_STATS_RECALCULATE]: recalculateCommunityStats,
  [JOB_TYPES.COOPERATIVE_RECOUNT]: recountCooperativeMembers,
  [JOB_TYPES.DASHBOARD_WARM]: warmDashboard,
  [JOB_TYPES.OUTBOX_SWEEP]: sweepOutbox,
  [JOB_TYPES.PROGRAMME_RECONCILE]: reconcileProgrammeCounters,
});

module.exports = { HANDLERS };
