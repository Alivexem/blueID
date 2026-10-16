'use strict';

const mongoose = require('mongoose');
const config = require('./index');
const logger = require('./logger');

/**
 * MongoDB is the system of record. The process should not serve traffic
 * without it, so connect() throws and the server exits on failure.
 */

mongoose.set('strictQuery', true);

/**
 * `sanitizeFilter` is deliberately NOT enabled.
 *
 * It looks like the obvious defence against operator injection, but it
 * rewrites EVERY object value containing a `$` key into `{ $eq: ... }` —
 * including the ones this codebase writes itself. A filter as ordinary as
 * `{ isDeleted: { $ne: true } }` becomes `{ isDeleted: { $eq: { $ne: true } } }`
 * and then fails to cast, so essentially every list query, scope filter and
 * soft-delete exclusion in the application throws. Using it correctly would
 * require wrapping every internal operator in `mongoose.trusted()` at well
 * over a hundred call sites, where a single omission silently disables a
 * filter.
 *
 * Injection is prevented at the boundary instead, which is both stronger and
 * verifiable:
 *
 *   - every request body, query and param is parsed by zod, which coerces to
 *     typed scalars and strips unknown keys, so an object can never arrive
 *     where a string is expected (see middleware/validate.js);
 *   - filters are assembled from allowlists, never spread from user input
 *     (see utils/query.js);
 *   - `assertScalar` is the backstop for any internally-built filter value.
 *
 * test/injection.test.js proves an injected operator object is rejected.
 */

/**
 * Fail fast instead of queuing.
 *
 * Set GLOBALLY rather than only as a connect option: models are compiled when
 * their modules are required, which happens before `connect()` runs, so a
 * query issued in that window still buffered — sitting in memory for ten
 * seconds before surfacing as an opaque timeout. Setting it here covers every
 * model regardless of when it was compiled.
 */
mongoose.set('bufferCommands', false);

let connected = false;

async function connect() {
  if (connected) return mongoose.connection;

  mongoose.connection.on('connected', () => {
    connected = true;
    logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
  });
  mongoose.connection.on('disconnected', () => {
    connected = false;
    logger.warn('MongoDB disconnected');
  });
  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error');
  });

  await mongoose.connect(config.mongo.uri, config.mongo.options);
  return mongoose.connection;
}

async function disconnect() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  connected = false;
  logger.info('MongoDB connection closed');
}

/** readyState 1 === connected. Used by /health. */
function isHealthy() {
  return mongoose.connection.readyState === 1;
}

async function ping() {
  const started = Date.now();
  await mongoose.connection.db.admin().command({ ping: 1 });
  return Date.now() - started;
}

/**
 * Runs `fn` inside a transaction when the deployment supports them (replica
 * set / Atlas) and falls back to a plain call on a standalone dev mongod.
 * Sync batches use this so a partially-applied batch cannot be left behind.
 */
/**
 * Cached transaction capability: null = not yet determined.
 *
 * This was previously probed with `client.topology.hasSessionSupport()`, a
 * method the modern driver no longer exposes. The optional call returned
 * `undefined`, `Boolean(undefined)` was false, and so EVERY call ran its
 * callback outside a transaction — on a replica set where transactions work
 * perfectly. Blue ID issuance, duplicate merges, benefit allocation and the
 * outbox write were all silently non-atomic.
 *
 * Capability is now established by attempting a real transaction and reading
 * the server's answer, which cannot drift from what the driver actually does.
 */
let transactionsSupported = null;

/** Does this error mean the deployment cannot do transactions at all? */
function isUnsupportedTransaction(err) {
  if (!err) return false;
  // IllegalOperation, raised by a standalone mongod.
  if (err.code === 20) return true;
  return /transaction numbers are only allowed|does not support transactions|transactions are not supported/i.test(
    err.message || ''
  );
}

async function withTransaction(fn) {
  if (transactionsSupported === false) {
    return fn(null);
  }

  const session = await mongoose.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    transactionsSupported = true;
    return result;
  } catch (err) {
    /**
     * Only fall back on the FIRST attempt, and only for a genuine capability
     * error. A standalone rejects at the first write inside the transaction,
     * so nothing has been committed and re-running is safe. Any other failure
     * propagates — quietly retrying an arbitrary error outside a transaction
     * is how half-applied writes happen.
     */
    if (transactionsSupported === null && isUnsupportedTransaction(err)) {
      transactionsSupported = false;
      logger.error(
        { err: { message: err.message, code: err.code } },
        'This MongoDB deployment does not support transactions — multi-document operations ' +
          'will run WITHOUT atomicity. Use a replica set in production.'
      );
      return fn(null);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

/** Exposed for tests and for the readiness probe. */
function transactionSupportState() {
  return transactionsSupported;
}

module.exports = {
  connect,
  disconnect,
  isHealthy,
  ping,
  withTransaction,
  transactionSupportState,
  mongoose,
};
