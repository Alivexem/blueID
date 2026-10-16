'use strict';

/**
 * Moves stored images from Cloudinary onto this server's filesystem.
 *
 *   npm run media:migrate -- --dry-run     report what would move, change nothing
 *   npm run media:migrate                  move everything not already local
 *   npm run media:migrate -- --limit=100   work through it in batches
 *   npm run media:migrate -- --verify      re-check that every record resolves
 *
 * SAFE TO RE-RUN. A record whose image is already on disk is skipped, so an
 * interrupted run is resumed by starting it again.
 *
 * NOTHING IS DELETED FROM CLOUDINARY. The remote copy stays until someone
 * removes it deliberately, so a migration that goes wrong is recoverable by
 * pointing MEDIA_DRIVER back at `cloudinary`. Clean up only after a verify
 * pass reports zero failures AND the local directory has been backed up.
 */

const path = require('node:path');
const database = require('../config/database');
const logger = require('../config/logger');
const config = require('../config');

const local = require('../services/storage/local.driver');
const cloudinaryDriver = require('../services/storage/cloudinary.driver');
const mediaService = require('../services/media.service');

/** Every place an image reference is held. */
const SOURCES = [
  { model: '../modules/fishermen/fisherman.model', name: 'Fisherman', field: 'photo', kind: 'fisherman' },
  { model: '../modules/assets/boat.model', name: 'Boat', field: 'photo', kind: 'asset', assetKind: 'BOAT' },
  { model: '../modules/assets/engine.model', name: 'Engine', field: 'photo', kind: 'asset', assetKind: 'ENGINE' },
  { model: '../modules/assets/equipment.model', name: 'Equipment', field: 'photo', kind: 'asset', assetKind: 'EQUIPMENT' },
  { model: '../modules/programmes/allocation.model', name: 'Allocation', field: 'acknowledgement', kind: 'acknowledgement' },
];

function parseArgs() {
  const args = { dryRun: false, verify: false, limit: 0 };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--verify') args.verify = true;
    else {
      const m = /^--limit=(\d+)$/.exec(arg);
      if (m) args.limit = Number(m[1]);
    }
  }
  return args;
}

/** An id this migration has already produced looks like `fishermen/...`. */
function isAlreadyLocal(publicId) {
  return /^(fishermen|assets|acknowledgements)\//.test(String(publicId || ''));
}

/**
 * Fetches the bytes behind a Cloudinary public id.
 *
 * A signed URL is minted for the fetch because the assets were uploaded as
 * `authenticated` — the delivery URL alone does not grant access, which was
 * the point of storing them that way.
 */
async function fetchFromCloudinary(publicId) {
  const url = cloudinaryDriver.signedUrl(publicId, { expiresInSeconds: 300 });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${publicId}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** The placement this image would get if it were being uploaded today. */
function placementFor(source, doc) {
  if (source.kind === 'fisherman') {
    return mediaService.locate('fisherman', { lga: doc.lga, blueId: doc.blueId, clientRecordId: doc.clientRecordId });
  }
  if (source.kind === 'asset') {
    return mediaService.locate('asset', { kind: source.assetKind, lga: doc.lga });
  }
  return mediaService.locate('acknowledgement', { programmeCode: doc.programmeCode, blueId: doc.blueId });
}

async function migrateOne(source, Model, doc, { dryRun }) {
  const media = doc[source.field];
  if (!media?.publicId) return 'skipped-no-image';
  if (isAlreadyLocal(media.publicId)) {
    return (await local.exists(media.publicId)) ? 'already-local' : 'local-but-missing';
  }
  if (dryRun) return 'would-move';

  const buffer = await fetchFromCloudinary(media.publicId);
  const placement = placementFor(source, doc);
  const stored = await local.put(buffer, placement);

  await Model.updateOne(
    { _id: doc._id },
    {
      $set: {
        [`${source.field}.url`]: stored.url,
        [`${source.field}.publicId`]: stored.publicId,
        [`${source.field}.width`]: stored.width,
        [`${source.field}.height`]: stored.height,
        [`${source.field}.format`]: stored.format,
        [`${source.field}.bytes`]: stored.bytes,
        // `uploadedAt` is deliberately NOT touched: it records when the
        // photograph was taken into the register, not when it was moved.
      },
    }
  );

  return 'moved';
}

async function run() {
  const args = parseArgs();

  if (config.media.driver !== 'local') {
    throw new Error(
      `MEDIA_DRIVER is "${config.media.driver}". Set MEDIA_DRIVER=local before migrating, or the new copies cannot be written.`
    );
  }

  await database.connect();
  local.ensureRootSync();

  const totals = {};
  const failures = [];

  for (const source of SOURCES) {
    const Model = require(source.model);
    const filter = { [`${source.field}.publicId`]: { $exists: true, $ne: null } };

    const cursor = Model.find(filter)
      .select(`_id lga blueId clientRecordId programmeCode ${source.field}`)
      .lean()
      .cursor();

    let n = 0;
    for await (const doc of cursor) {
      if (args.limit && n >= args.limit) break;
      n += 1;

      try {
        const outcome = args.verify
          ? (await local.exists(doc[source.field].publicId))
            ? 'present'
            : 'MISSING'
          : await migrateOne(source, Model, doc, args);

        totals[outcome] = (totals[outcome] || 0) + 1;
        if (outcome === 'MISSING' || outcome === 'local-but-missing') {
          failures.push({ model: source.name, id: String(doc._id), publicId: doc[source.field].publicId });
        }
      } catch (err) {
        totals.failed = (totals.failed || 0) + 1;
        failures.push({ model: source.name, id: String(doc._id), error: err.message });
        logger.error({ err, model: source.name, id: String(doc._id) }, 'Media migration failed for a record');
      }
    }

    logger.info({ model: source.name, examined: n }, 'Source processed');
  }

  process.stdout.write('\n  Media migration summary\n');
  process.stdout.write(`  driver: ${config.media.driver}   root: ${path.resolve(config.media.root)}\n\n`);
  for (const [outcome, count] of Object.entries(totals).sort()) {
    process.stdout.write(`    ${String(count).padStart(7)}  ${outcome}\n`);
  }

  if (failures.length) {
    process.stdout.write(`\n  ${failures.length} record(s) need attention:\n`);
    for (const f of failures.slice(0, 50)) {
      process.stdout.write(`    ${f.model} ${f.id} ${f.publicId || ''} ${f.error || ''}\n`);
    }
    if (failures.length > 50) process.stdout.write(`    ... and ${failures.length - 50} more\n`);
  }

  process.stdout.write(
    args.dryRun
      ? '\n  Dry run — nothing was written.\n\n'
      : '\n  Do NOT delete anything from Cloudinary until --verify reports no failures\n  and the media root has been backed up off this machine.\n\n'
  );

  await database.disconnect();
  process.exit(failures.length ? 1 : 0);
}

if (require.main === module) {
  run().catch(async (err) => {
    logger.fatal({ err }, 'Media migration failed');
    await database.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { SOURCES, isAlreadyLocal };
