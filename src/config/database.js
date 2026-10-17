'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool, types } = require('pg');
const config = require('./index');
const logger = require('./logger');

/**
 * PostgreSQL connection and transaction handling.
 *
 * WHY POSTGRES, AND WHY SELF-HOSTED
 *
 * The register holds identity data about Nigerian citizens — names, dates of
 * birth, NINs and photographs. NITDA's National Cloud Policy places that in a
 * tier which must be stored in Nigeria at rest, and no managed MongoDB
 * service operates in-country. The database therefore runs on the same
 * Nigerian server as the application, which also makes the concept note's
 * stated preference for a relational database the easy choice rather than a
 * compromise.
 *
 * WHAT CHANGED FROM MONGODB
 *
 * Transactions stop being conditional. The previous driver had to detect at
 * runtime whether the deployment was a replica set and silently fall back to
 * non-transactional writes on a standalone — a fallback that quietly removed
 * the atomicity the register depends on. Here a transaction is always a
 * transaction.
 */

/**
 * Return bigint as a Number rather than a string.
 *
 * Only `counters.seq` is a bigint, and it holds a Blue ID sequence that will
 * not pass 2^53 before the sun burns out. Everything else is integer. Without
 * this the sequence arrives as "41" and `41 + 1` becomes "411".
 */
types.setTypeParser(types.builtins.INT8, (value) => (value === null ? null : Number(value)));

/**
 * NUMERIC arrives as a string by default, because arbitrary precision does
 * not fit a double. The values here are boat lengths, horsepower and naira
 * amounts, all well inside a float, and the application treats them as
 * numbers throughout.
 */
types.setTypeParser(types.builtins.NUMERIC, (value) => (value === null ? null : Number(value)));

/**
 * DATE (not timestamptz) is a calendar day — a date of birth. Returning a
 * JS Date applies the server's timezone and can shift it a day, so it stays
 * the ISO string Postgres gives us.
 */
types.setTypeParser(types.builtins.DATE, (value) => value);

let pool = null;
let connected = false;

function buildPoolConfig() {
  const ssl = config.database.ssl
    ? {
        rejectUnauthorized: config.database.sslRejectUnauthorized,
        ...(config.database.sslCaPath && fs.existsSync(config.database.sslCaPath)
          ? { ca: fs.readFileSync(config.database.sslCaPath, 'utf8') }
          : {}),
      }
    : false;

  return {
    connectionString: config.database.url,
    ssl,
    max: config.database.poolMax,
    min: config.database.poolMin,
    idleTimeoutMillis: 30_000,
    // Fail a connection attempt rather than queueing behind a dead server.
    connectionTimeoutMillis: 10_000,
    // A query that has not finished in this long is not going to; cancelling
    // it frees the connection instead of holding the pool hostage.
    statement_timeout: config.database.statementTimeoutMs,
    application_name: 'blueid-api',
  };
}

async function connect() {
  if (pool) return pool;

  pool = new Pool(buildPoolConfig());

  /**
   * An idle client erroring is normal — the server restarted, a firewall
   * dropped it. Without a handler, `pg` raises it as an uncaught exception
   * and takes the process down.
   */
  pool.on('error', (err) => {
    logger.error({ err }, 'Idle database client errored; it will be replaced');
  });

  const started = Date.now();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT current_database() AS db, current_setting('server_version') AS version"
    );
    connected = true;
    logger.info(
      { database: rows[0].db, version: rows[0].version, ms: Date.now() - started },
      'PostgreSQL connected'
    );
  } finally {
    client.release();
  }

  return pool;
}

async function disconnect() {
  if (!pool) return;
  await pool.end();
  pool = null;
  connected = false;
  logger.info('PostgreSQL disconnected');
}

function getPool() {
  if (!pool) {
    throw new Error('Database not connected — call connect() during boot');
  }
  return pool;
}

/**
 * Runs a query against the pool, or against the open transaction if one is
 * in scope. Every repository goes through here, which is what lets a service
 * compose calls into a transaction without threading a client argument
 * through every function signature.
 */
function query(text, params, client) {
  return (client || getPool()).query(text, params);
}

/**
 * Runs `fn` inside a transaction, handing it a client to use.
 *
 * Unlike the MongoDB version this replaced, there is no capability detection
 * and no fallback: a single Postgres server supports transactions, so a
 * failure here is a real failure rather than a reason to proceed unsafely.
 *
 * Nested calls join the outer transaction rather than opening a second one,
 * so a service that calls another service does not deadlock against itself.
 */
async function withTransaction(fn, existingClient) {
  if (existingClient) return fn(existingClient);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // A rollback that fails means the connection is already broken; the
      // original error is the one worth reporting.
      logger.error({ err: rollbackErr }, 'Rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Serialises work across instances using a PostgreSQL advisory lock.
 *
 * This is what the in-process cache lock cannot do. The sync pipeline uses it
 * so one device's batch is never processed twice concurrently; because the
 * lock lives in the database rather than in a process, it stays correct if
 * the deployment is ever scaled beyond one instance.
 *
 * The lock is held on a dedicated connection and released in `finally`, and
 * Postgres drops it automatically if the connection dies — so a crashed
 * process cannot wedge the pipeline.
 */
async function withAdvisoryLock(key, fn, { waitMs = 0 } = {}) {
  const client = await getPool().connect();
  // Hash the name to the bigint the advisory-lock functions take.
  const lockId = hashLockKey(key);

  try {
    if (waitMs > 0) {
      await client.query(`SET LOCAL lock_timeout = '${Math.ceil(waitMs)}ms'`);
      await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    } else {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockId]);
      if (!rows[0].acquired) return { acquired: false, result: undefined };
    }

    const result = await fn();
    return { acquired: true, result };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
    client.release();
  }
}

/** FNV-1a folded into a signed 64-bit range for pg_advisory_lock. */
function hashLockKey(key) {
  const str = String(key);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return BigInt.asIntN(64, hash).toString();
}

async function ping() {
  const started = Date.now();
  await query('SELECT 1');
  return Date.now() - started;
}

function isConnected() {
  return connected;
}

/**
 * Applies any migration files that have not run yet.
 *
 * Deliberately plain SQL files applied in filename order, each inside its own
 * transaction, with the applied set recorded in a table. A migration tool
 * would add a dependency and a DSL for something this system needs to do
 * rarely and legibly — and an operator restoring a backup on a Nigerian VPS
 * at 2am should be able to read exactly what ran.
 */
async function migrate({ directory = path.join(__dirname, '..', 'db', 'migrations') } = {}) {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum   text
    )
  `);

  const files = fs
    .readdirSync(directory)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await query('SELECT filename, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
  const ran = [];

  for (const filename of files) {
    const sql = fs.readFileSync(path.join(directory, filename), 'utf8');
    const checksum = require('node:crypto').createHash('sha256').update(sql).digest('hex').slice(0, 16);

    if (applied.has(filename)) {
      /**
       * An applied migration that has since been edited means the database
       * and the repository disagree about what the schema is. Refusing is
       * the only safe answer — silently ignoring it is how two environments
       * drift apart without anyone noticing.
       */
      if (applied.get(filename) && applied.get(filename) !== checksum) {
        throw new Error(
          `Migration ${filename} has changed since it was applied. ` +
            'Add a new migration instead of editing one that has run.'
        );
      }
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
        filename,
        checksum,
      ]);
    });

    ran.push(filename);
    logger.info({ migration: filename }, 'Migration applied');
  }

  return ran;
}

module.exports = {
  connect,
  disconnect,
  getPool,
  query,
  withTransaction,
  withAdvisoryLock,
  migrate,
  ping,
  isConnected,
};
