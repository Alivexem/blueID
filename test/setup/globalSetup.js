'use strict';

/**
 * Global test setup.
 *
 * Creates a real, disposable PostgreSQL database and applies the actual
 * migrations to it — the same SQL that runs on the server. Testing against a
 * stand-in would mean the constraints that carry this register's integrity
 * (one Blue ID per fisherman, one live allocation per programme, replayed
 * sync as a no-op) were never exercised, and those are exactly the ones that
 * fail silently rather than loudly.
 *
 * Everything here is synthetic and thrown away: a database named for this
 * run, dropped when the run ends. No production data or credentials are used
 * or reachable.
 *
 * Point it at a server with TEST_DATABASE_URL; the default is a local one.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');

const ADMIN_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';

const DB_NAME = `blueid_test_${crypto.randomBytes(5).toString('hex')}`;

/** Swaps the database name on a connection URL, keeping everything else. */
function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function adminQuery(sql) {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function globalSetup() {
  // Fail with something an engineer can act on, rather than a connection
  // refused from somewhere deep in a test file.
  try {
    await adminQuery('SELECT 1');
  } catch (err) {
    throw new Error(
      `Cannot reach PostgreSQL at ${ADMIN_URL.replace(/:[^:@]*@/, ':***@')}\n` +
        `  ${err.message}\n\n` +
        '  Start a local server, or set TEST_DATABASE_URL.\n' +
        '  The tests create and drop their own database; they never touch an existing one.\n'
    );
  }

  await adminQuery(`CREATE DATABASE ${DB_NAME}`);

  const url = withDatabase(ADMIN_URL, DB_NAME);

  // Test-only configuration. These values exist solely for this process.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = url;
  process.env.TEST_DATABASE_NAME = DB_NAME;
  process.env.AUTH_MODE = 'disabled';
  process.env.AUTH_JWT_SECRET = 'a-test-signing-secret-of-at-least-32-chars';
  process.env.QR_SIGNING_SECRET = 'test-qr-signing-secret-not-a-real-key';
  process.env.FIELD_ENCRYPTION_KEY = 'test-field-encryption-key-at-least-32-chars';
  process.env.SERVICE_API_KEY = 'test-service-api-key';
  process.env.HEALTH_PROBE_KEY = 'test-probe-key';
  process.env.MEDIA_DRIVER = 'local';
  process.env.MEDIA_URL_SECRET = 'test-media-url-signing-secret-at-least-32-chars';
  process.env.LOG_LEVEL = 'silent';
  // Workers are driven explicitly by the tests that cover them.
  process.env.WORKER_ENABLED = 'false';

  /**
   * Apply the real migrations.
   *
   * Not a hand-written fixture schema: the indexes ARE the guarantees, and a
   * fixture that forgot one would let a test pass against a database that
   * cannot enforce what the test claims to prove.
   */
  const database = require('../../src/config/database');
  await database.connect();
  const applied = await database.migrate({
    directory: path.join(__dirname, '..', '..', 'src', 'db', 'migrations'),
  });

  // Prove the guarantees exist before a single test runs.
  const { rows } = await database.query(`
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN (
         'fisherman_blue_id', 'fisherman_client_record_id',
         'one_active_allocation_per_programme', 'allocation_client_record_id',
         'boat_registration_number', 'engine_serial_number',
         'user_email', 'outbox_dedupe_key'
       )
  `);

  const expected = 8;
  if (rows.length !== expected) {
    const found = rows.map((r) => r.indexname);
    throw new Error(
      `Only ${rows.length}/${expected} integrity indexes exist after migrating. ` +
        `Found: ${found.join(', ')}`
    );
  }

  await database.disconnect();

  process.stdout.write(
    `\n  test database ${DB_NAME} — ${applied.length} migration(s), ${expected} integrity indexes verified\n`
  );
}

async function globalTeardown() {
  try {
    const database = require('../../src/config/database');
    await database.disconnect().catch(() => {});
    // Evict anything still attached, or the drop blocks.
    await adminQuery(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid()
    `);
    await adminQuery(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  } catch {
    // A leftover test database is untidy, not harmful; never fail a run here.
  }
}

module.exports = { globalSetup, globalTeardown };
