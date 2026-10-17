'use strict';

/**
 * Fisherman repository tests.
 *
 * The register is the thing this system exists to protect, so these cover
 * the failures that would be discovered late and in person: a Blue ID issued
 * twice, a replayed sync creating a second record for one man, an officer in
 * one LGA reading another's register, and a duplicate that the matching
 * never surfaced.
 *
 * Synthetic people only. Names and numbers are invented.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const database = require('../../src/config/database');
const fishermen = require('../../src/modules/fishermen/fisherman.repository');
const counters = require('../../src/modules/fishermen/counter.repository');

const TAG = crypto.randomBytes(4).toString('hex');

test.before(async () => {
  await database.connect();
});
test.after(async () => {
  await fishermen.hardDelete({ clientRecordIdLike: `${TAG}-%` }).catch(() => {});
  await database.disconnect();
});

/** Stands in for the real derivation, which needs an encryption key. */
const derive = (row) => ({
  normalizedPhone: row.phone ? String(row.phone).replace(/\D/g, '').slice(-10) : null,
  normalizedName: [row.firstName, row.lastName].filter(Boolean).join(' ').toLowerCase(),
  phoneticName: [row.firstName, row.lastName].filter(Boolean).join('').toLowerCase().replace(/[aeiou]/g, ''),
  birthYear: row.dateOfBirth ? new Date(row.dateOfBirth).getFullYear() : row.estimatedYearOfBirth || null,
});

let seq = 0;
async function makeFisherman(overrides = {}) {
  seq += 1;
  return fishermen.create(
    {
      firstName: 'Ada',
      lastName: `Effiom${seq}`,
      gender: 'FEMALE',
      lga: 'BAK',
      phone: `080${String(10000000 + seq)}`,
      clientRecordId: `${TAG}-${seq}`,
      fishermanTypes: ['ARTISANAL'],
      fishingTypes: ['RIVER'],
      ...overrides,
    },
    { derive }
  );
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('a record comes back in the nested shape the API already returns', async () => {
  const record = await makeFisherman({
    firstName: 'Eno',
    middleName: 'Okon',
    lastName: 'Bassey',
    nextOfKin: { name: 'Mary Bassey', phone: '08030000000', relationship: 'SPOUSE' },
    location: { type: 'Point', coordinates: [8.587, 4.897], accuracy: 12 },
  });

  assert.equal(record.fullName, 'Eno Okon Bassey', 'derived, not accepted from the payload');

  // Flat columns are presented as the nested objects clients already parse.
  assert.equal(record.nextOfKin.name, 'Mary Bassey');
  assert.equal(record.nextOfKin.relationship, 'SPOUSE');
  assert.equal(record.nextOfKinName, undefined, 'the flat column must not leak');

  assert.deepEqual(record.location.coordinates, [8.587, 4.897]);
  assert.equal(record.location.type, 'Point');
  assert.equal(record.latitude, undefined, 'the flat column must not leak');

  assert.equal(record.status, 'PENDING_VERIFICATION', 'unverified until an officer approves');
  assert.equal(record.blueId, undefined, 'no Blue ID before verification');
});

test('the NIN and the matching keys stay out of the default projection', async () => {
  const record = await makeFisherman({ nin: 'encrypted-ciphertext-stand-in' });

  const plain = await fishermen.findById(record.id);
  assert.equal(plain.nin, undefined, 'the encrypted NIN is not returned by default');
  assert.equal(plain.match, undefined, 'the blind index is not a thing to hand out');

  const sensitive = await fishermen.findById(record.id, { withSensitive: true });
  assert.equal(sensitive.nin, 'encrypted-ciphertext-stand-in');
});

// ---------------------------------------------------------------------------
// Blue ID
// ---------------------------------------------------------------------------

test('a Blue ID is issued once and cannot be overwritten', async () => {
  const record = await makeFisherman();

  const first = await fishermen.assignBlueId(record.id, {
    blueId: `CRS-BLU-BAK-${TAG}1`,
    verificationToken: crypto.randomBytes(16).toString('hex'),
    verifiedBy: null,
  });
  assert.equal(first.blueId, `CRS-BLU-BAK-${TAG}1`);
  assert.equal(first.status, 'ACTIVE', 'verification activates the record');

  // A second verification must not replace a number that may be on a card.
  const second = await fishermen.assignBlueId(record.id, {
    blueId: `CRS-BLU-BAK-${TAG}2`,
    verificationToken: crypto.randomBytes(16).toString('hex'),
    verifiedBy: null,
  });
  assert.equal(second, null, 'the second verification matches no rows');

  const after = await fishermen.findById(record.id);
  assert.equal(after.blueId, `CRS-BLU-BAK-${TAG}1`, 'the original stands');
});

test('two verifications racing cannot both issue', async () => {
  const record = await makeFisherman();

  const results = await Promise.all([
    fishermen.assignBlueId(record.id, { blueId: `CRS-BLU-BAK-${TAG}A`, verificationToken: crypto.randomBytes(16).toString('hex'), verifiedBy: null }),
    fishermen.assignBlueId(record.id, { blueId: `CRS-BLU-BAK-${TAG}B`, verificationToken: crypto.randomBytes(16).toString('hex'), verifiedBy: null }),
  ]);

  assert.equal(results.filter(Boolean).length, 1, 'exactly one verification wins');
});

test('two fishermen cannot hold the same Blue ID', async () => {
  const a = await makeFisherman();
  const b = await makeFisherman();
  const blueId = `CRS-BLU-BAK-${TAG}X`;

  await fishermen.assignBlueId(a.id, { blueId, verificationToken: crypto.randomBytes(16).toString('hex'), verifiedBy: null });

  await assert.rejects(
    () => fishermen.assignBlueId(b.id, { blueId, verificationToken: crypto.randomBytes(16).toString('hex'), verifiedBy: null }),
    (err) => /duplicate key|unique/i.test(err.message),
    'the database refuses, not the application'
  );
});

test('many unverified records coexist, because a null Blue ID is not a value', async () => {
  // The Mongo equivalent needed a $type trick for this; the partial index
  // says WHERE blue_id IS NOT NULL and means it.
  await Promise.all([makeFisherman(), makeFisherman(), makeFisherman()]);
  const { total } = await fishermen.list({ hasBlueId: false, limit: 200 });
  assert.ok(total >= 3);
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

test('a replayed sync cannot create a second record for one person', async () => {
  const recordId = `${TAG}-replay`;
  const first = await fishermen.create(
    { firstName: 'Replay', lastName: 'Once', gender: 'MALE', lga: 'BAK', clientRecordId: recordId },
    { derive }
  );

  await assert.rejects(
    () =>
      fishermen.create(
        { firstName: 'Replay', lastName: 'Twice', gender: 'MALE', lga: 'BAK', clientRecordId: recordId },
        { derive }
      ),
    (err) => /duplicate key|unique/i.test(err.message)
  );

  // The caller resolves a replay by looking the record up, not by inserting.
  const found = await fishermen.findByClientRecordId(recordId);
  assert.equal(found.id, first.id);
});

test('a stale revision is refused rather than overwriting a newer edit', async () => {
  const record = await makeFisherman({ landingSite: 'Ikang' });

  const ok = await fishermen.updateIfUnchanged(record.id, { landingSite: 'Abana' }, 0, { derive });
  assert.equal(ok.updated, true);
  assert.equal(ok.record.landingSite, 'Abana');
  assert.equal(ok.record.clientRevision, 1);

  // A device that still believes it is on revision 0 must not win.
  const stale = await fishermen.updateIfUnchanged(record.id, { landingSite: 'Somewhere else' }, 0, { derive });
  assert.equal(stale.updated, false);
  assert.equal(stale.reason, 'revision conflict');

  const after = await fishermen.findById(record.id);
  assert.equal(after.landingSite, 'Abana', 'the newer edit survived');
});

test('the sync cursor walks every record exactly once', async () => {
  // Keyset, not OFFSET: a record updated mid-walk would otherwise shift the
  // window and a neighbour would be skipped without any error.
  const made = await Promise.all(Array.from({ length: 7 }, () => makeFisherman({ lga: 'OBU' })));
  const ids = new Set(made.map((m) => m.id));

  const seen = [];
  let cursor = { since: '1970-01-01T00:00:00Z', lastId: null };

  for (let page = 0; page < 20; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await fishermen.pullSince({ ...cursor, limit: 3, lgas: ['OBU'] });
    if (!batch.items.length) break;
    for (const row of batch.items) if (ids.has(row.id)) seen.push(row.id);
    cursor = batch.cursor;
  }

  assert.equal(seen.length, 7, 'every record was pulled');
  assert.equal(new Set(seen).size, 7, 'and none was pulled twice');
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test('an officer cannot read a register outside their own LGA', async () => {
  const bakassi = await makeFisherman({ lga: 'BAK' });
  const obudu = await makeFisherman({ lga: 'OBU' });

  const scope = { lgas: ['BAK'] };

  assert.ok(await fishermen.findById(bakassi.id, { scope }), 'their own LGA');
  assert.equal(
    await fishermen.findById(obudu.id, { scope }),
    null,
    'another LGA is invisible, not forbidden — knowing an id proves nothing'
  );

  const { items } = await fishermen.list({ limit: 200 }, { scope });
  assert.ok(!items.some((f) => f.lga === 'OBU'));
});

test('an officer with no LGA sees nothing, not everything', async () => {
  await makeFisherman();
  const { items, total } = await fishermen.list({ limit: 200 }, { scope: { lgas: [] } });
  assert.equal(total, 0);
  assert.equal(items.length, 0);
});

test('a search term cannot widen the caller scope', async () => {
  // The Mongo version had exactly this bug: a search clause assigned to
  // filter.$or replaced the scope's own $or and exposed the whole register.
  const obudu = await makeFisherman({ lga: 'OBU', firstName: 'Findable' });

  const { items } = await fishermen.list(
    { search: 'Findable', limit: 200 },
    { scope: { lgas: ['BAK'] } }
  );

  assert.ok(!items.some((f) => f.id === obudu.id), 'the search did not escape the scope');
});

// ---------------------------------------------------------------------------
// Duplicates (concept note §10)
// ---------------------------------------------------------------------------

test('duplicate blocking finds candidates on each signal the brief names', async () => {
  const ninIndex = crypto.randomBytes(16).toString('hex');
  const photoHash = crypto.randomBytes(8).toString('hex');

  const original = await fishermen.create(
    {
      firstName: 'Duplicate', lastName: 'Source', gender: 'MALE', lga: 'BAK',
      phone: '08099999999', clientRecordId: `${TAG}-dup-src`,
      match: { ninIndex, normalizedPhone: '8099999999', phoneticName: 'dplctsrc', photoHash, birthYear: 1980 },
    },
    {}
  );

  const byNin = await fishermen.findDuplicateCandidates({ ninIndex });
  assert.ok(byNin.some((c) => c.id === original.id), 'NIN');

  const byPhone = await fishermen.findDuplicateCandidates({ phone: '8099999999' });
  assert.ok(byPhone.some((c) => c.id === original.id), 'phone');

  // The signal the concept note names and the previous implementation
  // never used.
  const byPhoto = await fishermen.findDuplicateCandidates({ photoHash });
  assert.ok(byPhoto.some((c) => c.id === original.id), 'photograph');

  const byName = await fishermen.findDuplicateCandidates({ phoneticName: 'dplctsrc', lga: 'BAK' });
  assert.ok(byName.some((c) => c.id === original.id), 'phonetic name within the LGA');

  // A name match in a different LGA is not worth pursuing on its own.
  const otherLga = await fishermen.findDuplicateCandidates({ phoneticName: 'dplctsrc', lga: 'OBU' });
  assert.ok(!otherLga.some((c) => c.id === original.id));

  // A record never matches itself.
  const excluded = await fishermen.findDuplicateCandidates({ ninIndex, excludeId: original.id });
  assert.ok(!excluded.some((c) => c.id === original.id));
});

test('a merged record is retired, never deleted, and stops matching', async () => {
  const ninIndex = crypto.randomBytes(16).toString('hex');
  const survivor = await makeFisherman();
  const loser = await fishermen.create(
    {
      firstName: 'Merged', lastName: 'Away', gender: 'MALE', lga: 'BAK',
      clientRecordId: `${TAG}-merged`, match: { ninIndex },
    },
    {}
  );

  const merged = await fishermen.mergeInto(loser.id, survivor.id);
  assert.equal(String(merged.mergedInto), String(survivor.id));
  assert.equal(merged.status, 'DUPLICATE_UNDER_REVIEW');

  // Still there — §10 says flag for review, never delete.
  assert.ok(await fishermen.findById(loser.id), 'the record survives the merge');

  const candidates = await fishermen.findDuplicateCandidates({ ninIndex });
  assert.ok(!candidates.some((c) => c.id === loser.id), 'a retired record stops being a candidate');
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('a removed record leaves every ordinary read', async () => {
  const record = await makeFisherman();
  await fishermen.softDelete(record.id, { reason: 'registered in error' });

  assert.equal(await fishermen.findById(record.id), null);
  const { items } = await fishermen.list({ limit: 200 });
  assert.ok(!items.some((f) => f.id === record.id));

  assert.ok(await fishermen.findById(record.id, { includeDeleted: true }), 'still auditable');
});

test('reissuing a card rotates the token but keeps the Blue ID', async () => {
  const record = await makeFisherman();
  const firstToken = crypto.randomBytes(16).toString('hex');
  await fishermen.assignBlueId(record.id, {
    blueId: `CRS-BLU-BAK-${TAG}R`, verificationToken: firstToken, verifiedBy: null,
  });

  const secondToken = crypto.randomBytes(16).toString('hex');
  const reissued = await fishermen.reissueCard(record.id, {
    verificationToken: secondToken, issuedBy: null,
  });

  assert.equal(reissued.blueId, `CRS-BLU-BAK-${TAG}R`, 'the Blue ID is permanent');
  assert.equal(reissued.qrVersion, 2);

  // The lost card stops resolving; the new one works.
  assert.equal(await fishermen.findByVerificationToken(firstToken), null);
  assert.ok(await fishermen.findByVerificationToken(secondToken));
});
