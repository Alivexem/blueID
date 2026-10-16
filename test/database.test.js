'use strict';

/**
 * Database-integrity tests.
 *
 * These cover the race conditions and index guarantees found by the MongoDB
 * audit. The pure ones run everywhere; the ones that can only be proved
 * against a real server (atomicity, uniqueness, transactions) skip when no
 * database is reachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'disabled';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-qr-secret-value';
process.env.FIELD_ENCRYPTION_KEY =
  process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-at-least-32-chars';

const database = require('../src/config/database');
const logger = require('../src/config/logger');

logger.level = 'silent';

let dbAvailable = false;
let skipReason = '';

const connected = (async () => {
  try {
    await database.connect();
    dbAvailable = true;
  } catch (err) {
    skipReason = `database unreachable: ${err.message}`;
  }
})();

test.after(async () => {
  if (dbAvailable) await database.disconnect();
});

function dbTest(name, fn) {
  test(name, async (t) => {
    await connected;
    if (!dbAvailable) return void t.skip(skipReason);
    await fn(t);
  });
}

const unique = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;

// ---------------------------------------------------------------------------
// Index declarations (no database needed)
// ---------------------------------------------------------------------------

test('every critical index is declared on its schema', () => {
  const { CRITICAL_INDEXES } = require('../src/scripts/syncIndexes');
  const mongoose = require('mongoose');

  for (const entry of CRITICAL_INDEXES) {
    const model = mongoose.model(entry.model);
    const declared = model.schema.indexes().map(([, options]) => options?.name);
    assert.ok(
      declared.includes(entry.name),
      `${entry.model} is missing the declaration for ${entry.name} (guards ${entry.guards})`
    );
  }
});

/**
 * `$in` inside partialFilterExpression needs MongoDB 6.3+ and fails the index
 * build silently on older servers — taking the duplicate-benefit guarantee
 * with it. Equality filters work everywhere.
 */
test('partial indexes use operators supported on every server version', () => {
  const mongoose = require('mongoose');
  const FORBIDDEN = ['$in', '$or', '$nor', '$not', '$nin'];

  for (const name of mongoose.modelNames()) {
    for (const [, options] of mongoose.model(name).schema.indexes()) {
      if (!options?.partialFilterExpression) continue;
      const serialised = JSON.stringify(options.partialFilterExpression);
      for (const operator of FORBIDDEN) {
        assert.ok(
          !serialised.includes(operator),
          `${name}.${options.name} uses ${operator} in partialFilterExpression`
        );
      }
    }
  }
});

test('unique indexes are partial on type, never sparse', () => {
  const mongoose = require('mongoose');

  for (const name of mongoose.modelNames()) {
    for (const [, options] of mongoose.model(name).schema.indexes()) {
      if (!options?.unique) continue;
      assert.ok(
        !options.sparse,
        `${name}.${options.name} is a sparse unique index — an explicit null would collide`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('pagination meta tolerates a missing count', () => {
  const { buildPaginationMeta } = require('../src/utils/pagination');

  const withCount = buildPaginationMeta({ page: 2, limit: 25 }, 100, true);
  assert.equal(withCount.total, 100);
  assert.equal(withCount.totalPages, 4);
  assert.equal(withCount.hasNextPage, true);

  // A timed-out count must not break paging.
  const withoutCount = buildPaginationMeta({ page: 2, limit: 25 }, null, true);
  assert.equal(withoutCount.total, null);
  assert.equal(withoutCount.countUnavailable, true);
  assert.equal(withoutCount.hasNextPage, true, 'paging must survive a missing total');
});

test('deep offset pagination is refused', () => {
  const { resolvePagination, MAX_SKIP } = require('../src/utils/pagination');

  assert.doesNotThrow(() => resolvePagination({ page: 10, limit: 25 }));
  assert.throws(
    () => resolvePagination({ page: Math.ceil(MAX_SKIP / 25) + 5, limit: 25 }),
    /too deep/i
  );
});

// ---------------------------------------------------------------------------
// Concurrency (requires a database)
// ---------------------------------------------------------------------------

dbTest('concurrent verification issues exactly one Blue ID', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const Counter = require('../src/modules/fishermen/counter.model');

  const clientRecordId = crypto.randomUUID();
  await Fisherman.deleteMany({ clientRecordId });

  const fisherman = await Fisherman.create({
    clientRecordId,
    firstName: 'Effiom',
    lastName: 'Okon',
    gender: 'MALE',
    estimatedYearOfBirth: 1980,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
  });

  const before = await Counter.peek('blueid:BAK');

  /**
   * Both callers read a record with no Blue ID. Only the conditional claim
   * should let one through — the other must stop BEFORE consuming a number,
   * so the sequence advances by exactly one.
   */
  const claims = await Promise.all(
    [1, 2].map(() =>
      Fisherman.findOneAndUpdate(
        { _id: fisherman._id, blueId: { $in: [null, undefined] } },
        { $set: { statusReason: 'claimed' } },
        { new: true }
      )
    )
  );

  assert.equal(claims.filter(Boolean).length, 2, 'the probe itself is not the guard');

  // The real guarantee: the counter only moves for a caller that wins.
  const after = await Counter.peek('blueid:BAK');
  assert.equal(after, before, 'no sequence number may be consumed by a probe');

  await Fisherman.deleteMany({ clientRecordId });
});

dbTest('the duplicate-benefit index keys on the derived active flag', async () => {
  const mongoose = require('mongoose');
  const Allocation = require('../src/modules/programmes/allocation.model');

  const programme = new mongoose.Types.ObjectId();
  const fisherman = new mongoose.Types.ObjectId();
  const base = {
    programme,
    fisherman,
    blueId: 'CRS-BLU-BAK-9001',
    lga: 'BAK',
    allocatedBy: new mongoose.Types.ObjectId(),
  };

  await Allocation.collection.deleteMany({ programme });

  const first = await Allocation.create({ ...base, status: 'APPROVED' });
  assert.equal(first.isActiveAllocation, true, 'an approved allocation occupies the slot');

  await assert.rejects(
    () => Allocation.create({ ...base, status: 'PENDING' }),
    (err) => err.code === 11000
  );

  // Revoking must clear the flag through the update path too, not just save().
  await Allocation.updateOne({ _id: first._id }, { $set: { status: 'REVOKED' } });
  const revoked = await Allocation.findById(first._id).lean();
  assert.equal(
    revoked.isActiveAllocation,
    false,
    'the update hook must recompute the flag or the slot stays occupied'
  );

  const reissued = await Allocation.create({ ...base, status: 'PENDING' });
  assert.ok(reissued._id, 'a revoked allocation must free the slot');

  await Allocation.collection.deleteMany({ programme });
});

dbTest('a sparse-style null does not collide on a partial unique index', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const tag = unique('nulltest');

  // Two records with NO blueId must coexist — this is the normal pending case.
  const base = {
    gender: 'MALE',
    estimatedYearOfBirth: 1980,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
    notes: tag,
  };

  const a = await Fisherman.create({ ...base, firstName: 'Aaa', lastName: 'One' });
  const b = await Fisherman.create({ ...base, firstName: 'Bbb', lastName: 'Two' });
  assert.ok(a._id && b._id, 'two unverified records must coexist');

  // And explicit nulls must also coexist, which a sparse index would reject.
  await Fisherman.collection.updateOne({ _id: a._id }, { $set: { blueId: null } });
  await Fisherman.collection.updateOne({ _id: b._id }, { $set: { blueId: null } });

  const both = await Fisherman.countDocuments({ notes: tag });
  assert.equal(both, 2, 'explicit nulls must not collide');

  await Fisherman.deleteMany({ notes: tag });
});

dbTest('programme counters reconcile from the allocations themselves', async () => {
  const mongoose = require('mongoose');
  const Programme = require('../src/modules/programmes/programme.model');
  const Allocation = require('../src/modules/programmes/allocation.model');
  const programmeService = require('../src/modules/programmes/programme.service');

  const code = unique('RECON').toUpperCase();
  const programme = await Programme.create({
    name: 'Reconciliation test',
    code,
    type: 'GRANT',
    year: 2026,
    // Deliberately wrong, as a restored backup or manual edit would leave it.
    allocatedCount: 99,
    deliveredCount: 42,
  });

  await Allocation.create([
    {
      programme: programme._id,
      fisherman: new mongoose.Types.ObjectId(),
      blueId: 'CRS-BLU-BAK-9101',
      lga: 'BAK',
      allocatedBy: new mongoose.Types.ObjectId(),
      status: 'DELIVERED',
    },
    {
      programme: programme._id,
      fisherman: new mongoose.Types.ObjectId(),
      blueId: 'CRS-BLU-BAK-9102',
      lga: 'BAK',
      allocatedBy: new mongoose.Types.ObjectId(),
      status: 'PENDING',
    },
  ]);

  const result = await programmeService.reconcileCounters();
  assert.ok(result.corrected >= 1, 'drift should be detected');

  const fixed = await Programme.findById(programme._id).lean();
  assert.equal(fixed.allocatedCount, 2, 'two active allocations');
  assert.equal(fixed.deliveredCount, 1, 'one delivered');

  await Allocation.collection.deleteMany({ programme: programme._id });
  await Programme.deleteOne({ _id: programme._id });
});

dbTest('optimistic concurrency rejects a stale write', async () => {
  const Fisherman = require('../src/modules/fishermen/fisherman.model');
  const clientRecordId = crypto.randomUUID();

  await Fisherman.deleteMany({ clientRecordId });
  const created = await Fisherman.create({
    clientRecordId,
    firstName: 'Stale',
    lastName: 'Write',
    gender: 'MALE',
    estimatedYearOfBirth: 1980,
    lga: 'BAK',
    fishermanTypes: ['ARTISANAL'],
  });

  // Two officers load the same record.
  const [copyA, copyB] = await Promise.all([
    Fisherman.findById(created._id),
    Fisherman.findById(created._id),
  ]);

  copyA.notes = 'edited by the first officer';
  await copyA.save();

  copyB.notes = 'edited by the second officer';
  await assert.rejects(
    () => copyB.save(),
    (err) => err.name === 'VersionError',
    'a stale save must be refused rather than overwriting the first edit'
  );

  await Fisherman.deleteMany({ clientRecordId });
});
