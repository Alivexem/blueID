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
const fs = require('node:fs');
const path = require('node:path');

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
  /**
   * Swapped textually rather than with `new URL()`. A replica-set
   * connection string lists several comma-separated hosts, which is not a
   * valid WHATWG URL authority — `new URL()` threw ERR_INVALID_URL on it and
   * took this whole file down before a single test ran, so the file could
   * only ever be used against a single-host or +srv URI.
   */
  process.env.MONGODB_URI = process.env.MONGODB_URI.replace(
    /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/,
    (_match, head, query) => `${head}/blueid_serverless_test${query || ''}`
  );
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

// ---------------------------------------------------------------------------
// Query parsing on the platform
// ---------------------------------------------------------------------------

/**
 * Vercel's runtime sets `req.query` itself, with Node's `querystring`, which
 * cannot express nesting. Express's query middleware is guarded by
 * `if (!req.query)`, so it leaves a value the platform already set alone —
 * meaning the app's configured qs parser never runs in production, and only
 * in production.
 *
 * That divergence is the danger: `limit[a]=1` is a 422 under every test and
 * was a 200 on the deployment, and a device sending its pull cursor as
 * `cursors[FISHERMAN]=…` was silently handed page one again, with `hasMore`
 * still true and no error to explain why it never progressed.
 *
 * These run a real request through a real Express app, with the platform's
 * behaviour simulated, and assert on what the handler actually receives.
 */
function vercelStyleServer(onQuery) {
  const express = require('express');
  const { useExpressQueryParser } = require('../api/index');

  const app = express();
  app.get('/probe', (req, res) => {
    onQuery(req.query);
    res.json({ ok: true });
  });

  return http.createServer((req, res) => {
    // What Vercel does before the function sees the request: parse the query
    // with `querystring`, which flattens anything nested, and assign it.
    const querystring = require('node:querystring');
    const i = req.url.indexOf('?');
    req.query = i === -1 ? {} : querystring.parse(req.url.slice(i + 1));

    useExpressQueryParser(req);
    app(req, res);
  });
}

function getJson(origin_, path_) {
  return new Promise((resolve, reject) => {
    http
      .get(`${origin_}${path_}`, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

test('a nested query parameter survives the platform and reaches the handler', async () => {
  let seen = null;
  const srv = vercelStyleServer((q) => { seen = q; });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    await getJson(base, '/probe?entities=FISHERMAN&cursors%5BFISHERMAN%5D=abc123');

    assert.deepEqual(
      seen.cursors,
      { FISHERMAN: 'abc123' },
      'the handler must receive the nested object the sync API documents'
    );
    assert.equal(
      seen['cursors[FISHERMAN]'],
      undefined,
      'and not the flat key, which no schema reads'
    );
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('the pull schema sees a bracketed cursor, rather than silently ignoring it', async () => {
  const { pullChanges } = require('../src/modules/sync/sync.validation');

  let parsed = null;
  const srv = vercelStyleServer((q) => { parsed = pullChanges.safeParse(q); });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    await getJson(base, '/probe?entities=FISHERMAN&cursors%5BFISHERMAN%5D=abc123');
    assert.equal(parsed.success, true);
    assert.deepEqual(
      parsed.data.cursors,
      { FISHERMAN: 'abc123' },
      'a cursor the device sent must reach the query, or the pull restarts from page one forever'
    );

    // The other half of the same divergence: a malformed nested value must
    // fail here exactly as it does locally, instead of being answered 200.
    await getJson(base, '/probe?entities=FISHERMAN&limit%5Ba%5D=1');
    assert.equal(
      parsed.success,
      false,
      'a nested value the schema cannot accept must be a validation error, not a silent 200'
    );
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
