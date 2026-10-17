'use strict';

const outbox = require('../modules/outbox/outbox.repository');
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
    actor: req?.user?.id || req?.user?._id,
    lga: payload.lga,
  };

  // A duplicate dedupeKey means the job is already scheduled. That is the
  // point of the key, so the repository returns null rather than raising —
  // it is a success, not a failure.
  const job = await outbox.enqueue(doc, { client: session });
  if (!job) {
    logger.debug({ type, dedupeKey }, 'Job already enqueued — skipping duplicate');
    return null;
  }
  logger.debug({ type, jobId: job.id, dedupeKey }, 'Job enqueued');
  return job;
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
  const jobId = job?.id || job?._id;
  if (!jobId) return fn();

  const claimed = await outbox.claimSideEffect(jobId, name);

  if (!claimed) {
    logger.info({ jobId, name }, 'Side effect already performed — skipping on retry');
    return { skipped: true, reason: 'already performed' };
  }

  return fn();
}

/** Marks a claimed job finished. */
async function complete(job) {
  await outbox.complete(job.id || job._id);
}

/**
 * Records a failed attempt. Retries with backoff until `maxAttempts`, then
 * moves the job to DEAD for human investigation rather than retrying forever.
 */
async function fail(job, error) {
  const message = error?.message || String(error);
  const jobId = job.id || job._id;

  // The repository decides DEAD vs PENDING from attempts against
  // maxAttempts, so the rule lives in one place rather than being
  // recomputed here and there.
  const updated = await outbox.fail(jobId, {
    error: message,
    backoffSeconds: Math.round((nextRunAt(job.attempts) - Date.now()) / 1000),
  });

  if (updated?.status === 'DEAD') {
    logger.error(
      { jobId, type: job.type, attempts: job.attempts, error: message },
      'Job moved to dead-letter after exhausting retries'
    );
  } else {
    logger.warn({ jobId, type: job.type, attempt: job.attempts }, 'Job failed — will retry');
  }
}

/** Queue depth and health, for the ops dashboard and /health. */
async function stats() {
  const [rows, due, oldest] = await Promise.all([
    outbox.stats(),
    outbox.countDue(),
    outbox.oldestPending(),
  ]);

  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));

  return {
    byStatus,
    due,
    oldestPendingAgeMs: oldest ? Date.now() - new Date(oldest.runAt).getTime() : 0,
    oldestPendingType: oldest?.type || null,
  };
}

/** Requeues a dead job after the underlying problem has been fixed. */
function retryDead(jobId) {
  return outbox.retryDead(jobId);
}

/** Removes completed jobs older than `olderThanDays`. */
function sweep(olderThanDays = 7) {
  return outbox.sweepCompleted({ olderThanDays });
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
