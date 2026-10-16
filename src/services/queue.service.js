'use strict';

const OutboxJob = require('../modules/outbox/outbox.model');
const logger = require('../config/logger');
const config = require('../config');

/**
 * Enqueueing side of the durable job queue. The consuming side lives in
 * src/workers.
 *
 * The important call signature is `enqueue(type, payload, { session })`:
 * passing the caller's Mongo session writes the job inside the same
 * transaction as the business change, so a crash can never leave a committed
 * registration with its notification lost, or a sent notification for a
 * registration that rolled back.
 */

/** Job types. Keep in step with the handler registry in src/workers/handlers. */
const JOB_TYPES = Object.freeze({
  EMAIL_SEND: 'email.send',
  DUPLICATE_REVIEW_NOTIFY: 'duplicate.review.notify',
  ALLOCATION_NOTIFY: 'allocation.notify',
  SYNC_FAILURE_NOTIFY: 'sync.failure.notify',
  COMMUNITY_STATS_RECALCULATE: 'community.stats.recalculate',
  COOPERATIVE_RECOUNT: 'cooperative.recount',
  DASHBOARD_WARM: 'dashboard.warm',
  OUTBOX_SWEEP: 'outbox.sweep',
  PROGRAMME_RECONCILE: 'programme.reconcile',
});

/** Retry backoff: exponential with jitter, capped at an hour. */
function nextRunAt(attempts) {
  const base = Math.min(2 ** attempts * 1000, 60 * 60 * 1000);
  const jitter = Math.random() * base * 0.25;
  return new Date(Date.now() + base + jitter);
}

/**
 * Schedules a job.
 *
 * @param {string} type       one of JOB_TYPES
 * @param {object} payload    serialisable handler input
 * @param {object} [options]  { session, dedupeKey, runAt, priority, maxAttempts, req }
 */
async function enqueue(type, payload = {}, options = {}) {
  const {
    session = null,
    dedupeKey,
    runAt = new Date(),
    priority = 0,
    maxAttempts = config.worker.maxAttempts,
    req,
  } = options;

  const doc = {
    type,
    payload,
    dedupeKey,
    runAt,
    priority,
    maxAttempts,
    requestId: req?.id,
    actor: req?.user?._id,
    lga: payload.lga,
  };

  try {
    const [job] = await OutboxJob.create([doc], session ? { session } : {});
    logger.debug({ type, jobId: job._id, dedupeKey }, 'Job enqueued');
    return job;
  } catch (err) {
    // A duplicate dedupeKey means the job is already scheduled or done. That
    // is the point of the key, so it is a success, not a failure.
    if (err.code === 11000) {
      logger.debug({ type, dedupeKey }, 'Job already enqueued — skipping duplicate');
      return null;
    }
    throw err;
  }
}

/**
 * Fire-and-forget enqueue for paths where losing the job is preferable to
 * failing the request (for example a best-effort cache warm). Anything that
 * matters should use `enqueue` with a session instead.
 */
function enqueueSafe(type, payload, options) {
  return enqueue(type, payload, options).catch((err) => {
    logger.warn({ err, type }, 'Could not enqueue background job');
    return null;
  });
}

/**
 * Runs a non-idempotent side effect at most once across all retries.
 *
 *   await queue.once(job, 'email', () => sendEmail(...));
 *
 * The claim is an atomic conditional update: `$addToSet` under a filter that
 * requires the name to be absent. Exactly one attempt can win, so a job
 * retried after a crash re-runs its safe work without sending a second email
 * to a reviewer or a beneficiary.
 *
 * The marker is written BEFORE the effect, which is the correct bias here: a
 * missed notification is recoverable by looking at the record, while a
 * duplicate official email to a fisherman is not retractable.
 */
async function once(job, name, fn) {
  if (!job?._id) return fn();

  const claimed = await OutboxJob.findOneAndUpdate(
    { _id: job._id, sideEffects: { $ne: name } },
    { $addToSet: { sideEffects: name } },
    { new: true }
  );

  if (!claimed) {
    logger.info({ jobId: job._id, name }, 'Side effect already performed — skipping on retry');
    return { skipped: true, reason: 'already performed' };
  }

  return fn();
}

/** Marks a claimed job finished. */
async function complete(job) {
  await OutboxJob.updateOne(
    { _id: job._id },
    {
      $set: { status: 'COMPLETED', completedAt: new Date(), lastError: undefined },
      $unset: { lockedBy: '', lockedUntil: '' },
    }
  );
}

/**
 * Records a failed attempt. Retries with backoff until `maxAttempts`, then
 * moves the job to DEAD for human investigation rather than retrying forever.
 */
async function fail(job, error) {
  const message = error?.message || String(error);
  const exhausted = job.attempts >= job.maxAttempts;

  await OutboxJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: exhausted ? 'DEAD' : 'PENDING',
        lastError: message.slice(0, 1000),
        ...(exhausted ? {} : { runAt: nextRunAt(job.attempts) }),
      },
      $unset: { lockedBy: '', lockedUntil: '' },
    }
  );

  if (exhausted) {
    logger.error(
      { jobId: job._id, type: job.type, attempts: job.attempts, error: message },
      'Job moved to dead-letter after exhausting retries'
    );
  } else {
    logger.warn({ jobId: job._id, type: job.type, attempt: job.attempts }, 'Job failed — will retry');
  }
}

/** Queue depth and health, for the ops dashboard and /health. */
async function stats() {
  const rows = await OutboxJob.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.count]));

  const oldest = await OutboxJob.findOne({ status: 'PENDING', runAt: { $lte: new Date() } })
    .sort({ runAt: 1 })
    .select('runAt type')
    .lean();

  return {
    byStatus,
    due: await OutboxJob.countPending(),
    oldestPendingAgeMs: oldest ? Date.now() - new Date(oldest.runAt).getTime() : 0,
    oldestPendingType: oldest?.type || null,
  };
}

/** Requeues a dead job after the underlying problem has been fixed. */
async function retryDead(jobId) {
  return OutboxJob.findOneAndUpdate(
    { _id: jobId, status: 'DEAD' },
    { $set: { status: 'PENDING', attempts: 0, runAt: new Date(), lastError: undefined } },
    { new: true }
  );
}

/** Removes completed jobs older than `olderThanDays`. */
async function sweep(olderThanDays = 7) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await OutboxJob.deleteMany({ status: 'COMPLETED', completedAt: { $lt: cutoff } });
  return result.deletedCount;
}

module.exports = {
  JOB_TYPES,
  enqueue,
  once,
  enqueueSafe,
  complete,
  fail,
  stats,
  retryDead,
  sweep,
  nextRunAt,
};
