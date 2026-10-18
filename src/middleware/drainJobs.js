'use strict';

const config = require('../config');
const logger = require('../config/logger');

/**
 * Runs queued jobs when there is no worker to run them.
 *
 * WHY THIS EXISTS
 *
 * Background work here is a transactional outbox: a job row is written
 * inside the transaction that caused it, so a password reset email is
 * committed with the token it carries, and a duplicate-review notification
 * is committed with the flagged registration. That is the property worth
 * keeping — it is why a crash cannot leave a flagged record with nobody
 * told about it.
 *
 * On a long-running server a polling worker drains the queue. A serverless
 * platform has no long-running process, and a scheduled function on a free
 * plan runs at most once a day, so a password reset email would arrive
 * tomorrow. Here the draining rides on ordinary traffic instead.
 *
 * WHAT THIS COSTS, HONESTLY
 *
 * Jobs run after a request rather than within seconds of being created, so
 * delivery is tied to the API being used. On a quiet instance a job waits
 * for the next request. For a small team testing the system that is fine;
 * for a busy register it is not, which is why the real worker still exists
 * and is what a VM deployment runs.
 *
 * The drain happens AFTER the response has been sent, so it never adds
 * latency to the request that triggered it. If the platform freezes the
 * instance first, the jobs are still in the queue and the next request
 * picks them up — nothing is lost either way, which is the whole point of
 * keeping them in the database rather than in memory.
 */

/** Bounded so a backlog cannot turn one request into a long one. */
const MAX_JOBS_PER_REQUEST = 3;
const TIME_BUDGET_MS = 5_000;

let draining = false;

async function drain() {
  // One drain at a time per instance. Two overlapping drains would not
  // corrupt anything — claiming is atomic — but they would compete for the
  // same invocation's remaining time.
  if (draining) return;
  draining = true;

  const startedAt = Date.now();
  const workers = require('../workers');

  try {
    for (let i = 0; i < MAX_JOBS_PER_REQUEST; i += 1) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
      // eslint-disable-next-line no-await-in-loop
      const ran = await workers.runOnce();
      if (!ran) break; // queue empty
    }
  } catch (err) {
    // A failed job is recorded and retried by the queue itself. Reaching
    // here means the drain mechanism broke, which must never affect the
    // request that has already been answered.
    logger.error({ err }, 'Inline job drain failed');
  } finally {
    draining = false;
  }
}

/**
 * Mounted only when no worker process is running. With a worker, this would
 * be two things claiming the same jobs for no benefit.
 *
 * Never under the test harness. Test files run concurrently against one
 * database and the queue tests assert on jobs they have just created; a
 * drain riding on any HTTP request in any other file would claim those
 * jobs out from under them. It did, and it showed up as unrelated queue
 * tests failing perhaps one run in three — which is exactly the kind of
 * flake that gets rerun until it passes rather than investigated.
 *
 * The drain itself is covered directly in test/serverless.test.js, against
 * its own database.
 */
function drainJobs(req, res, next) {
  if (config.worker.enabled || config.isTest) return next();

  res.on('finish', () => {
    drain().catch(() => {});
  });

  return next();
}

module.exports = { drainJobs, drain };
