'use strict';

/**
 * Migrations.
 *
 *   npm run db:migrate            apply everything outstanding
 *   npm run db:migrate -- --dry   report what would change, write nothing
 *   npm run db:migrate -- --status   list applied and pending
 *
 * Each migration records itself in `migrations`, so running twice is a no-op.
 * Every one is written to be idempotent anyway — a migration that cannot be
 * safely re-run is a migration that cannot be safely resumed after a failure.
 *
 * These exist because several schema changes shipped without one, and the
 * affected records would otherwise be silently wrong rather than visibly
 * broken: a fisherman whose NIN never matches during duplicate detection
 * looks exactly like a fisherman who has no NIN.
 */

const mongoose = require('mongoose');
const database = require('../config/database');
const logger = require('../config/logger');
const fieldCrypto = require('../utils/fieldCrypto');

const Fisherman = require('../modules/fishermen/fisherman.model');
const Allocation = require('../modules/programmes/allocation.model');
const Device = require('../modules/sync/device.model');

const migrationSchema = new mongoose.Schema(
  {
    _id: String,
    appliedAt: { type: Date, default: Date.now },
    durationMs: Number,
    result: mongoose.Schema.Types.Mixed,
  },
  { versionKey: false }
);
const Migration = mongoose.models.Migration || mongoose.model('Migration', migrationSchema);

const MIGRATIONS = [
  {
    id: '001-encrypt-nin-and-rebuild-blind-index',
    description:
      'Encrypt plaintext NINs, populate match.ninIndex, and drop the superseded match.normalizedNin field and its index.',
    async run({ dry }) {
      /**
       * The NIN moved from plaintext to AES-GCM ciphertext, and matching moved
       * from `match.normalizedNin` to a keyed blind index. Records written
       * before that change still hold plaintext and the old key, so duplicate
       * detection silently stops recognising them — the most consequential
       * kind of quiet failure in this system.
       */
      const cursor = Fisherman.find({ nin: { $exists: true, $ne: null } })
        .select('+nin match')
        .cursor();

      let scanned = 0;
      let encrypted = 0;
      let reindexed = 0;
      const operations = [];

      for await (const doc of cursor) {
        scanned += 1;
        const raw = doc.nin;
        if (!raw) continue;

        const isAlreadyEncrypted = fieldCrypto.isCiphertext(raw);
        const plaintext = isAlreadyEncrypted ? fieldCrypto.decrypt(raw) : String(raw);
        if (!plaintext) continue; // undecryptable: leave it alone and report

        const update = {};
        if (!isAlreadyEncrypted) {
          update.nin = fieldCrypto.encrypt(plaintext);
          encrypted += 1;
        }

        const expectedIndex = fieldCrypto.blindIndex(plaintext);
        if (doc.match?.ninIndex !== expectedIndex) {
          update['match.ninIndex'] = expectedIndex;
          reindexed += 1;
        }

        if (Object.keys(update).length) {
          operations.push({
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: update, $unset: { 'match.normalizedNin': '' } },
            },
          });
        }
      }

      if (!dry && operations.length) {
        // Batched so a large register does not build one enormous write.
        for (let i = 0; i < operations.length; i += 500) {
          await Fisherman.bulkWrite(operations.slice(i, i + 500));
        }

        // The old field's index is now dead weight on every write.
        await Fisherman.collection
          .dropIndex('match.normalizedNin_1')
          .catch(() => {}); // absent on a fresh database
      }

      return { scanned, encrypted, reindexed, pending: operations.length };
    },
  },

  {
    id: '002-allocation-active-flag',
    description:
      'Populate isActiveAllocation, which the duplicate-benefit index now filters on.',
    async run({ dry }) {
      /**
       * The uniqueness index moved from `status: { $in: [...] }` — which needs
       * MongoDB 6.3+ and fails to build silently on older servers — to an
       * equality filter on a derived boolean. Existing rows have no flag, so
       * they are invisible to the index until this runs.
       */
      const active = { $in: ['PENDING', 'APPROVED', 'DELIVERED'] };

      if (dry) {
        const [toActivate, toDeactivate] = await Promise.all([
          Allocation.countDocuments({ status: active, isActiveAllocation: { $ne: true } }),
          Allocation.countDocuments({
            status: { $nin: ['PENDING', 'APPROVED', 'DELIVERED'] },
            isActiveAllocation: { $ne: false },
          }),
        ]);
        return { toActivate, toDeactivate };
      }

      const [activated, deactivated] = await Promise.all([
        Allocation.updateMany(
          { status: active, isActiveAllocation: { $ne: true } },
          { $set: { isActiveAllocation: true } }
        ),
        Allocation.updateMany(
          { status: { $nin: ['PENDING', 'APPROVED', 'DELIVERED'] }, isActiveAllocation: { $ne: false } },
          { $set: { isActiveAllocation: false } }
        ),
      ]);

      return { activated: activated.modifiedCount, deactivated: deactivated.modifiedCount };
    },
  },

  {
    id: '003-device-per-entity-cursors',
    description: 'Migrate the single lastSyncCursor to the per-entity lastSyncCursors map.',
    async run({ dry }) {
      /**
       * One shared cursor skipped records whenever entities drained at
       * different rates. Seeding every entity from the old value is the
       * conservative choice: a device may re-receive some records, which is
       * harmless because sync is idempotent, but it cannot miss any.
       */
      const devices = await Device.find({ lastSyncCursor: { $exists: true, $ne: null } })
        .select('lastSyncCursor lastSyncCursors')
        .lean();

      if (dry) return { devices: devices.length };

      const entities = ['FISHERMAN', 'BOAT', 'ENGINE', 'EQUIPMENT', 'ALLOCATION'];
      const operations = devices.map((device) => ({
        updateOne: {
          filter: { _id: device._id },
          update: {
            $set: Object.fromEntries(
              entities
                .filter((e) => !device.lastSyncCursors?.[e])
                .map((e) => [`lastSyncCursors.${e}`, device.lastSyncCursor])
            ),
            $unset: { lastSyncCursor: '' },
          },
        },
      }));

      if (operations.length) await Device.bulkWrite(operations);
      return { migrated: operations.length };
    },
  },

  {
    id: '004-verification-tokens',
    description: 'Issue opaque QR verification tokens to already-verified fishermen.',
    async run({ dry }) {
      /**
       * The QR code stopped encoding the Blue ID and started carrying an
       * opaque token. Records verified before that change have no token, so a
       * card cannot be printed for them until one is issued.
       */
      const filter = {
        blueId: { $type: 'string' },
        verificationToken: { $in: [null, undefined] },
        isDeleted: { $ne: true },
      };

      const count = await Fisherman.countDocuments(filter);
      if (dry) return { needingTokens: count };

      const crypto = require('node:crypto');
      const cursor = Fisherman.find(filter).select('_id qrVersion').cursor();
      const operations = [];

      for await (const doc of cursor) {
        operations.push({
          updateOne: {
            filter: { _id: doc._id },
            update: {
              $set: { verificationToken: crypto.randomBytes(24).toString('base64url') },
              $inc: { qrVersion: 1 },
            },
          },
        });
      }

      for (let i = 0; i < operations.length; i += 500) {
        await Fisherman.bulkWrite(operations.slice(i, i + 500));
      }

      return { issued: operations.length };
    },
  },
];

async function appliedIds() {
  const applied = await Migration.find().select('_id').lean();
  return new Set(applied.map((m) => m._id));
}

async function status() {
  const applied = await appliedIds();
  return MIGRATIONS.map((m) => ({
    id: m.id,
    description: m.description,
    applied: applied.has(m.id),
  }));
}

async function run() {
  const dry = process.argv.includes('--dry');
  const showStatus = process.argv.includes('--status');

  await database.connect();

  if (showStatus) {
    for (const entry of await status()) {
      process.stdout.write(`${entry.applied ? '[applied]' : '[pending]'} ${entry.id}\n`);
      process.stdout.write(`           ${entry.description}\n`);
    }
    await database.disconnect();
    process.exit(0);
  }

  if (dry) {
    logger.warn('DRY RUN — no documents will be modified');
  }
  if (!fieldCrypto.isEnabled()) {
    logger.warn(
      'FIELD_ENCRYPTION_KEY is not set — NIN values will be left in plaintext by migration 001'
    );
  }

  const applied = await appliedIds();

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      logger.debug({ id: migration.id }, 'Migration already applied');
      continue;
    }

    logger.info({ id: migration.id }, migration.description);
    const startedAt = Date.now();

    try {
      const result = await migration.run({ dry });
      const durationMs = Date.now() - startedAt;

      if (!dry) {
        await Migration.create({ _id: migration.id, durationMs, result });
      }
      logger.info({ id: migration.id, durationMs, result, dry }, 'Migration complete');
    } catch (err) {
      logger.fatal({ err, id: migration.id }, 'Migration FAILED — stopping');
      await database.disconnect();
      process.exit(1);
    }
  }

  logger.info({ dry }, 'All migrations up to date');
  await database.disconnect();
  process.exit(0);
}

if (require.main === module) {
  run().catch(async (err) => {
    logger.fatal({ err }, 'Migration run failed');
    await database.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { MIGRATIONS, status };
