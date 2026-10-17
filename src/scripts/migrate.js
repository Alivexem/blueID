'use strict';

/**
 * Applies pending schema migrations.
 *
 *   npm run db:migrate            apply everything outstanding
 *   npm run db:migrate -- --status   list what has run and what has not
 *
 * Run by provision.sh during setup, and before the service starts on a
 * deploy. Safe to run twice: an applied migration is skipped.
 *
 * It refuses to proceed if a migration file has changed since it was applied,
 * because that means the database and the repository no longer agree about
 * what the schema is — the kind of drift that is invisible until a column the
 * code expects turns out not to exist.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const database = require('../config/database');
const logger = require('../config/logger');

const DIRECTORY = path.join(__dirname, '..', 'db', 'migrations');

async function status() {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum   text
    )
  `);

  const files = fs.readdirSync(DIRECTORY).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await database.query(
    'SELECT filename, applied_at, checksum FROM schema_migrations'
  );
  const applied = new Map(rows.map((r) => [r.filename, r]));

  process.stdout.write('\n  Migration status\n\n');
  for (const file of files) {
    const record = applied.get(file);
    const sql = fs.readFileSync(path.join(DIRECTORY, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

    if (!record) {
      process.stdout.write(`    PENDING   ${file}\n`);
    } else if (record.checksum && record.checksum !== checksum) {
      process.stdout.write(`    CHANGED   ${file}  (applied ${record.applied_at.toISOString()})\n`);
    } else {
      process.stdout.write(`    applied   ${file}  ${record.applied_at.toISOString()}\n`);
    }
  }

  const orphans = [...applied.keys()].filter((f) => !files.includes(f));
  for (const file of orphans) {
    process.stdout.write(`    MISSING   ${file}  (recorded as applied, file is gone)\n`);
  }
  process.stdout.write('\n');
}

async function run() {
  await database.connect();

  if (process.argv.includes('--status')) {
    await status();
    await database.disconnect();
    process.exit(0);
  }

  const applied = await database.migrate({ directory: DIRECTORY });

  if (applied.length === 0) {
    logger.info('Schema is up to date; nothing to apply');
    process.stdout.write('\n  Schema is up to date.\n\n');
  } else {
    process.stdout.write(`\n  Applied ${applied.length} migration(s):\n`);
    for (const file of applied) process.stdout.write(`    ${file}\n`);
    process.stdout.write('\n');
  }

  await database.disconnect();
  process.exit(0);
}

if (require.main === module) {
  run().catch(async (err) => {
    logger.fatal({ err: err.message }, 'Migration failed');
    process.stderr.write(`\n  Migration failed: ${err.message}\n\n`);
    await database.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { status };
