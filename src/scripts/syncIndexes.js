'use strict';

/**
 * Index management.
 *
 *   npm run db:indexes          create/update every index, then verify
 *   npm run db:indexes -- --check   verify only; exits non-zero if any are missing
 *   npm run db:indexes -- --prune   also drop indexes no longer declared
 *
 * WHY THIS EXISTS
 *
 * `autoIndex` is disabled in production, because building an index implicitly
 * when a process boots is how a deploy stalls a live database. The consequence
 * is that indexes must be created deliberately — and until they are, every
 * uniqueness guarantee in this system is only a comment in a JavaScript file:
 *
 *   blueId                              two fishermen could hold one Blue ID
 *   clientRecordId                      a replayed sync could duplicate a person
 *   clientBatchId                       a replayed batch could reprocess
 *   one_active_allocation_per_programme the same person could collect twice
 *
 * None of those failures raise an error. They just quietly produce bad data,
 * which is why `--check` exists and why it belongs in the deploy pipeline and
 * in the readiness probe.
 */

const mongoose = require('mongoose');
const database = require('../config/database');
const logger = require('../config/logger');

// Every model must be registered before indexes can be synchronised.
require('../modules/users/user.model');
require('../modules/fishermen/fisherman.model');
require('../modules/fishermen/counter.model');
require('../modules/communities/community.model');
require('../modules/cooperatives/cooperative.model');
require('../modules/assets/boat.model');
require('../modules/assets/engine.model');
require('../modules/assets/equipment.model');
require('../modules/programmes/programme.model');
require('../modules/programmes/allocation.model');
require('../modules/sync/device.model');
require('../modules/sync/syncBatch.model');
require('../modules/audit/audit.model');
require('../modules/outbox/outbox.model');
require('../modules/auth/session.model');

/**
 * Indexes whose absence is a data-integrity failure rather than a performance
 * problem. These are asserted by name after every sync and by `--check`.
 */
const CRITICAL_INDEXES = Object.freeze([
  { model: 'Fisherman', name: 'fisherman_blue_id', guards: 'Blue ID uniqueness' },
  { model: 'Fisherman', name: 'fisherman_client_record_id', guards: 'sync replay safety' },
  { model: 'Fisherman', name: 'fisherman_verification_token', guards: 'QR token uniqueness' },
  { model: 'Boat', name: 'boat_registration_number', guards: 'boat registration uniqueness' },
  { model: 'Boat', name: 'boat_client_record_id', guards: 'sync replay safety' },
  { model: 'Engine', name: 'engine_serial_number', guards: 'engine serial uniqueness' },
  { model: 'Engine', name: 'engine_client_record_id', guards: 'sync replay safety' },
  { model: 'Equipment', name: 'equipment_client_record_id', guards: 'sync replay safety' },
  {
    model: 'Allocation',
    name: 'one_active_allocation_per_programme',
    guards: 'duplicate benefit prevention',
  },
  { model: 'Allocation', name: 'allocation_client_record_id', guards: 'sync replay safety' },
  { model: 'User', name: 'user_auth_uid', guards: 'one account per identity' },
  { model: 'User', name: 'user_email', guards: 'invitation integrity' },
  { model: 'OutboxJob', name: 'outbox_dedupe_key', guards: 'job idempotency' },
]);

/** Reads the indexes that actually exist on a collection. */
async function existingIndexNames(model) {
  try {
    const indexes = await model.collection.indexes();
    return new Set(indexes.map((i) => i.name));
  } catch (err) {
    // NamespaceNotFound: the collection has no documents yet.
    if (err.codeName === 'NamespaceNotFound' || err.code === 26) return new Set();
    throw err;
  }
}

/** Verifies every critical index is present. Returns the missing ones. */
async function check() {
  const missing = [];

  for (const entry of CRITICAL_INDEXES) {
    const model = mongoose.model(entry.model);
    // eslint-disable-next-line no-await-in-loop
    const names = await existingIndexNames(model);
    if (!names.has(entry.name)) missing.push(entry);
  }

  return missing;
}

async function sync({ prune = false } = {}) {
  const results = [];

  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    try {
      /**
       * `syncIndexes` creates what is declared and drops what is not, which is
       * destructive — so it is opt-in. The default `createIndexes` only adds,
       * which is the safe choice for a live database.
       */
      // eslint-disable-next-line no-await-in-loop
      const dropped = prune ? await model.syncIndexes() : await model.createIndexes();
      results.push({ model: name, ok: true, dropped: prune ? dropped : undefined });
      logger.info({ model: name }, 'Indexes synchronised');
    } catch (err) {
      results.push({ model: name, ok: false, error: err.message });
      logger.error({ err, model: name }, 'Index synchronisation FAILED');
    }
  }

  return results;
}

async function run() {
  const checkOnly = process.argv.includes('--check');
  const prune = process.argv.includes('--prune');

  await database.connect();

  if (!checkOnly) {
    const results = await sync({ prune });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      logger.fatal({ failed }, 'Some indexes could not be created');
      await database.disconnect();
      process.exit(1);
    }
  }

  const missing = await check();

  if (missing.length) {
    logger.fatal(
      { missing },
      'CRITICAL indexes are missing — uniqueness is NOT enforced for the listed guarantees'
    );
    for (const entry of missing) {
      process.stderr.write(`  missing: ${entry.model}.${entry.name} — guards ${entry.guards}\n`);
    }
    await database.disconnect();
    process.exit(1);
  }

  logger.info(
    { verified: CRITICAL_INDEXES.length },
    checkOnly ? 'All critical indexes present' : 'Indexes synchronised and verified'
  );

  await database.disconnect();
  process.exit(0);
}

if (require.main === module) {
  run().catch(async (err) => {
    logger.fatal({ err }, 'Index synchronisation failed');
    await database.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { sync, check, CRITICAL_INDEXES };
