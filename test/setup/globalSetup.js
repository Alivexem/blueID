'use strict';

/**
 * Global test setup.
 *
 * Starts a real MongoDB — as a single-node REPLICA SET, not a standalone,
 * because transactions are central to this system's correctness and a
 * standalone cannot run them. Testing against a standalone would have let the
 * atomicity guarantees pass by simply not being exercised.
 *
 * Everything here is synthetic and disposable: an ephemeral in-process server
 * on a random port, throwaway credentials, and a database that is destroyed
 * when the run ends. No production data or credentials are used or reachable.
 */

const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

async function globalSetup() {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  const uri = replSet.getUri('blueid_test');

  // Test-only configuration. These values exist solely for this process.
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = uri;
  process.env.AUTH_MODE = 'disabled';
  process.env.QR_SIGNING_SECRET = 'test-qr-signing-secret-not-a-real-key';
  process.env.FIELD_ENCRYPTION_KEY = 'test-field-encryption-key-at-least-32-chars';
  process.env.SERVICE_API_KEY = 'test-service-api-key';
  process.env.HEALTH_PROBE_KEY = 'test-probe-key';
  process.env.LOG_LEVEL = 'silent';
  // Workers are driven explicitly by the tests that cover them.
  process.env.WORKER_ENABLED = 'false';

  /**
   * Build the indexes before any test runs.
   *
   * Uniqueness in this system is enforced by MongoDB, not by application
   * checks, so a suite that writes before the indexes exist is not testing
   * the guarantee — it is racing it. `autoIndex` builds in the background and
   * the first test can easily win that race, which is exactly what happened:
   * "a second allocation must be refused by the index" passed vacuously
   * because the index was not there yet.
   *
   * Running the real deploy script also means the script itself is covered.
   */
  const mongoose = require('mongoose');
  await mongoose.connect(uri);
  const { sync, check } = require('../../src/scripts/syncIndexes');
  await sync();

  const missing = await check();
  if (missing.length) {
    throw new Error(
      `Test setup could not create critical indexes: ${missing.map((m) => m.name).join(', ')}`
    );
  }
  await mongoose.disconnect();

  // Shared with the teardown hook and with individual test files.
  globalThis.__MONGO_URI__ = uri;
  globalThis.__REPLSET__ = replSet;
};

async function globalTeardown() {
  if (replSet) await replSet.stop();
}

// Node's test runner looks for these named exports.
module.exports = { globalSetup, globalTeardown };
