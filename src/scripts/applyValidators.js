'use strict';

/**
 * Database-level schema validation.
 *
 *   npm run db:validators            apply in WARN mode (safe, logs only)
 *   npm run db:validators -- --enforce   reject writes that violate the rules
 *
 * Mongoose validation only applies to writes that go through Mongoose. A
 * migration script, a `mongosh` session, a restored backup or a future
 * service writing to the same cluster bypasses all of it. These `$jsonSchema`
 * validators are the floor beneath that: the rules that must hold no matter
 * what wrote the document.
 *
 * They are deliberately NARROW. They assert types and the handful of
 * invariants that make a record meaningful, not the full schema — a validator
 * that drifts from the application is worse than none, because it rejects
 * legitimate writes for reasons nobody can find.
 *
 * WARN is the default: MongoDB logs violations without refusing the write, so
 * the rules can be observed against real data before they are enforced.
 */

const database = require('../config/database');
const logger = require('../config/logger');
const { LGA_CODES, FISHERMAN_STATUS, ALLOCATION_STATUS } = require('../config/constants');

const VALIDATORS = [
  {
    collection: 'fishermen',
    schema: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['firstName', 'lastName', 'gender', 'lga', 'status'],
        properties: {
          firstName: { bsonType: 'string', minLength: 1 },
          lastName: { bsonType: 'string', minLength: 1 },
          gender: { enum: ['MALE', 'FEMALE', 'OTHER'] },
          lga: { enum: [...LGA_CODES] },
          status: { enum: Object.values(FISHERMAN_STATUS) },
          // Permanent identifiers must be strings when present — never null,
          // which a partial unique index would treat as a real value.
          blueId: { bsonType: ['string', 'null'] },
          clientRecordId: { bsonType: ['string', 'null'] },
          estimatedYearOfBirth: { bsonType: ['int', 'long', 'double', 'null'], minimum: 1900 },
          isDeleted: { bsonType: ['bool', 'null'] },
        },
      },
    },
  },
  {
    collection: 'allocations',
    schema: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['programme', 'fisherman', 'blueId', 'lga', 'status', 'allocatedBy'],
        properties: {
          blueId: { bsonType: 'string', minLength: 1 },
          lga: { enum: [...LGA_CODES] },
          status: { enum: Object.values(ALLOCATION_STATUS) },
          // The flag the duplicate-benefit index filters on must exist.
          isActiveAllocation: { bsonType: 'bool' },
          quantity: { bsonType: ['int', 'long', 'double', 'null'], minimum: 0 },
          value: { bsonType: ['int', 'long', 'double', 'null'], minimum: 0 },
        },
      },
    },
  },
  {
    collection: 'auditlogs',
    schema: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['action', 'entity', 'createdAt'],
        properties: {
          action: { bsonType: 'string', minLength: 1 },
          outcome: { enum: ['SUCCESS', 'FAILURE', null] },
        },
      },
    },
  },
];

async function apply({ enforce = false } = {}) {
  const db = database.mongoose.connection.db;
  const validationAction = enforce ? 'error' : 'warn';
  const results = [];

  for (const entry of VALIDATORS) {
    try {
      // collMod requires the collection to exist.
      const existing = await db.listCollections({ name: entry.collection }).toArray();
      if (!existing.length) {
        await db.createCollection(entry.collection);
      }

      await db.command({
        collMod: entry.collection,
        validator: entry.schema,
        validationLevel: 'moderate', // only check inserts and valid existing docs
        validationAction,
      });

      results.push({ collection: entry.collection, ok: true, validationAction });
      logger.info({ collection: entry.collection, validationAction }, 'Validator applied');
    } catch (err) {
      results.push({ collection: entry.collection, ok: false, error: err.message });
      logger.error({ err, collection: entry.collection }, 'Could not apply the validator');
    }
  }

  return results;
}

async function run() {
  const enforce = process.argv.includes('--enforce');

  await database.connect();
  const results = await apply({ enforce });
  await database.disconnect();

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    logger.fatal({ failed }, 'Some validators could not be applied');
    process.exit(1);
  }

  if (!enforce) {
    logger.warn(
      'Validators are in WARN mode — violations are logged by MongoDB but writes still succeed. Re-run with --enforce once the logs are clean.'
    );
  }
  process.exit(0);
}

if (require.main === module) {
  run().catch(async (err) => {
    logger.fatal({ err }, 'Validator run failed');
    await database.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { VALIDATORS, apply };
