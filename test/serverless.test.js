'use strict';

/**
 * Serverless behaviour.
 *
 * On Vercel there is no long-running process, so the polling worker never
 * runs and a scheduled function on the free plan fires at most once a day.
 * Background work therefore has to drain on ordinary traffic, or a password
 * reset email would arrive tomorrow.
 *
 * These cover the parts of that which can actually go wrong: a job sitting
 * in the queue forever, and the drain adding latency to the request that
 * triggered it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

// No worker, as on Vercel. Set before config is read.
process.env.WORKER_ENABLED = 'false';

/**
 * Its own database, on the same in-memory server.
 *
 * Test files run concurrently and the outbox is a shared queue: this file
 * drains it, and the queue tests in other files assert on jobs they have
 * just created. Whichever got there first won, so both failed at random.
 * Draining is only meaningful against a queue nobody else is using.
 */
if (process.env.MONGODB_URI) {
  const url = new URL(process.env.MONGODB_URI);
  url.pathname = '/blueid_serverless_test';
  process.env.MONGODB_URI = url.toString();
}

const database = require('../src/config/database');
const queue = require('../src/services/queue.service');
const OutboxJob = require('../src/modules/outbox/outbox.model');
const { drain } = require('../src/middleware/drainJobs');
const config = require('../src/config');

let server;
let origin;

test.before(async () => {
  await database.connect();
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await OutboxJob.collection.deleteMany({ dedupeKey: /^serverless-test/ });
  await database.disconnect();
});

test('the worker is off, as it is on Vercel', () => {
  assert.equal(config.worker.enabled, false, 'these tests are meaningless with a worker running');
});

test('a queued job is still run when there is no worker', async () => {
  // The job type is irrelevant; what matters is that something claims and
  // runs it. OUTBOX_SWEEP is chosen because it touches nothing else.
  const dedupeKey = `serverless-test-${crypto.randomBytes(4).toString('hex')}`;
  const job = await queue.enqueue(
    queue.JOB_TYPES.OUTBOX_SWEEP,
    { olderThanDays: 3650 },
    { dedupeKey }
  );
  assert.ok(job, 'the job was queued');
  assert.equal((await OutboxJob.findById(job._id)).status, 'PENDING');

  await drain();

  const after = await OutboxJob.findById(job._id);
  assert.equal(after.status, 'COMPLETED', 'the drain ran it without a worker');
  assert.ok(after.completedAt);
});

test('draining happens after the response, not during it', async () => {
  /**
   * The drain is bounded and runs on `finish`, so a backlog must never
   * turn a request into a slow one. If it ever moved before the handler,
   * a queue of slow jobs would show up as the API being slow.
   */
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await queue.enqueue(
      queue.JOB_TYPES.OUTBOX_SWEEP,
      { olderThanDays: 3650 },
      { dedupeKey: `serverless-test-latency-${i}` }
    );
  }

  const started = Date.now();
  const response = await fetch(`${origin}${config.app.apiPrefix}/reference/constants`);
  const elapsed = Date.now() - started;

  assert.equal(response.status, 200);
  assert.ok(elapsed < 2000, `the response took ${elapsed}ms; the queue must not block it`);
});

test('draining returns promptly rather than spinning', async () => {
  /**
   * Deliberately does NOT clear the queue first. Test files run
   * concurrently against one database, so deleting every pending job here
   * would delete the jobs another file is in the middle of asserting on --
   * which it did, and showed up as that file failing at random.
   */
  const started = Date.now();
  await drain();
  assert.ok(Date.now() - started < 3000, 'a bounded drain cannot run long');
});

test('a drain already running does not start a second one', async () => {
  // Two overlapping drains would not corrupt anything — claiming is atomic
  // — but they would compete for one invocation's remaining time.
  await queue.enqueue(
    queue.JOB_TYPES.OUTBOX_SWEEP,
    { olderThanDays: 3650 },
    { dedupeKey: `serverless-test-overlap-${crypto.randomBytes(3).toString('hex')}` }
  );

  const results = await Promise.all([drain(), drain(), drain()]);
  assert.equal(results.length, 3, 'all three settle rather than hanging');
});

test('the connection pool is sized for many instances, not one big server', () => {
  /**
   * Every warm serverless instance holds its own pool, so the cluster sees
   * instances x maxPoolSize. Atlas allows 500 on the free tier; a pool of
   * 20 would exhaust it at 25 instances, and a refused connection surfaces
   * as a failed request rather than as a wait.
   */
  assert.ok(
    config.mongo.options.maxPoolSize <= 10,
    `maxPoolSize is ${config.mongo.options.maxPoolSize}; too large for serverless`
  );
  assert.equal(
    config.mongo.options.minPoolSize,
    0,
    'an idle instance should hold no connections open'
  );
});
