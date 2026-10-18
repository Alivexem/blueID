'use strict';

const crypto = require('node:crypto');

const OutboxJob = require('../modules/outbox/outbox.model');
const queue = require('../services/queue.service');
const cache = require('../services/cache.service');
const { HANDLERS } = require('./handlers');
const config = require('../config');
const logger = require('../config/logger');

/**
 * Worker runtime.
 *
 * Runs in-process alongside the API by default, which is the right trade for a
 * single-instance government deployment: one process to operate, one set of
 * credentials, no separate deploy. `WORKER_ENABLED=false` turns it off so the
 * same image can be run as a dedicated worker fleet later without a code
 * change — claiming is atomic in MongoDB, so any number of processes may run
 * the loop concurrently and safely.
 *
 * Concurrency is bounded (`WORKER_CONCURRENCY`) so a burst of registrations
 * cannot starve the API of database connections.
 */

const WORKER_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const LOCK_SECONDS = 60;

let running = false;
let timer = null;
let active = 0;
let drained = null;

/** Runs a single claimed job. */
async function runJob(job) {
  const handler = HANDLERS[job.type];
  const startedAt = Date.now();

  if (!handler) {
    // An unknown type is a deploy mismatch, not a transient fault — retrying
    // forever would hide it.
    logger.error({ type: job.type, jobId: job._id }, 'No handler registered for job type');
    await queue.fail({ ...job.toObject(), attempts: job.maxAttempts }, new Error(`Unknown job type: ${job.type}`));
    return;
  }

  try {
    const result = await handler(job.payload || {}, job);
    await queue.complete(job);
    logger.info(
      { type: job.type, jobId: job._id, durationMs: Date.now() - startedAt },
      'Job completed'
    );
    return result;
  } catch (err) {
    await queue.fail(job, err);
    logger.warn(
      { err, type: job.type, jobId: job._id, attempt: job.attempts },
      'Job failed'
    );
    return null;
  }
}

/** Claims and dispatches up to the remaining concurrency budget. */
async function tick() {
  if (!running) return;

  try {
    while (running && active < config.worker.concurrency) {
      const job = await OutboxJob.claimOne(WORKER_ID, { lockSeconds: LOCK_SECONDS });
      if (!job) break;

      active += 1;
      // Deliberately not awaited: jobs run concurrently up to the budget.
      runJob(job)
        .catch((err) => logger.error({ err }, 'Unhandled error in job runner'))
        .finally(() => {
          active -= 1;
          if (active === 0 && drained) drained();
        });
    }
  } catch (err) {
    logger.error({ err }, 'Worker tick failed');
  } finally {
    if (running) {
      timer = setTimeout(tick, config.worker.pollIntervalMs);
      timer.unref();
    }
  }
}

/**
 * Schedules the recurring maintenance jobs.
 *
 * Each uses a time-bucketed dedupe key, so whichever instance gets there first
 * creates the job and the others no-op — no leader election required.
 */
async function scheduleRecurring() {
  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const dayBucket = new Date().toISOString().slice(0, 10);

  await Promise.all([
    queue.enqueueSafe(
      queue.JOB_TYPES.DASHBOARD_WARM,
      {},
      { dedupeKey: `dashboard-warm:${hourBucket}`, priority: -1 }
    ),
    queue.enqueueSafe(
      queue.JOB_TYPES.COMMUNITY_STATS_RECALCULATE,
      {},
      { dedupeKey: `community-stats:${hourBucket}`, priority: -1 }
    ),
    queue.enqueueSafe(
      queue.JOB_TYPES.PROGRAMME_RECONCILE,
      {},
      { dedupeKey: `programme-reconcile:${dayBucket}`, priority: -1 }
    ),
    queue.enqueueSafe(
      queue.JOB_TYPES.OUTBOX_SWEEP,
      { olderThanDays: 7 },
      { dedupeKey: `outbox-sweep:${dayBucket}`, priority: -2 }
    ),
  ]);
}

function start() {
  if (!config.worker.enabled) {
    logger.info('Background worker disabled (WORKER_ENABLED=false)');
    return false;
  }
  if (running) return true;

  running = true;
  logger.info(
    { workerId: WORKER_ID, concurrency: config.worker.concurrency },
    'Background worker started'
  );

  tick();

  // Recurring maintenance, kicked off now and then hourly.
  scheduleRecurring().catch(() => {});
  const recurring = setInterval(() => scheduleRecurring().catch(() => {}), 60 * 60 * 1000);
  recurring.unref();

  return true;
}

/** Stops claiming and waits for in-flight jobs, so a deploy loses no work. */
async function stop({ timeoutMs = 15000 } = {}) {
  if (!running) return;
  running = false;
  if (timer) clearTimeout(timer);

  if (active === 0) {
    logger.info('Background worker stopped');
    return;
  }

  logger.info({ active }, 'Waiting for in-flight jobs to finish');

  await Promise.race([
    new Promise((resolve) => {
      drained = resolve;
    }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  // Whatever did not finish keeps its claim until `lockedUntil` expires, at
  // which point another worker picks it up. Nothing is lost.
  logger.info({ remaining: active }, 'Background worker stopped');
}

/**
 * Claims and runs exactly one job, then returns.
 *
 * Used where there is no polling worker — a serverless deployment drains
 * the queue on ordinary traffic instead (see middleware/drainJobs.js).
 * Claiming is the same atomic operation the worker uses, so this is safe to
 * run from several instances at once: a job is handed to one of them.
 *
 * Returns false when the queue is empty, which is how the caller knows to
 * stop rather than spinning.
 */
async function runOnce() {
  const job = await OutboxJob.claimOne(WORKER_ID, { lockSeconds: LOCK_SECONDS });
  if (!job) return false;

  try {
    await runJob(job);
  } catch (err) {
    // runJob records the failure and schedules a retry; anything reaching
    // here is unexpected and must not stop the caller.
    logger.error({ err, jobId: String(job._id) }, 'Unhandled error running a job inline');
  }
  return true;
}

module.exports = { start, stop, runJob, runOnce, scheduleRecurring, WORKER_ID };
