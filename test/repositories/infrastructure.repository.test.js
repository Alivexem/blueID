'use strict';

/**
 * Community, cooperative, device, sync-batch, audit and outbox repositories.
 *
 * These carry the mechanics the register depends on but nobody looks at
 * until they fail: the replay key that stops a retried sync being processed
 * twice, the lease that returns a job after a worker dies, the append-only
 * trail, and the per-entity cursors that replaced a single shared one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const database = require('../../src/config/database');
const communities = require('../../src/modules/communities/community.repository');
const cooperatives = require('../../src/modules/cooperatives/cooperative.repository');
const devices = require('../../src/modules/sync/device.repository');
const batches = require('../../src/modules/sync/syncBatch.repository');
const audit = require('../../src/modules/audit/audit.repository');
const outbox = require('../../src/modules/outbox/outbox.repository');
const fishermen = require('../../src/modules/fishermen/fisherman.repository');

const TAG = crypto.randomBytes(4).toString('hex');

test.before(async () => { await database.connect(); });
test.after(async () => {
  await outbox.hardDelete({ dedupeKeyLike: `${TAG}%` }).catch(() => {});
  await batches.hardDelete({ clientBatchIdLike: `${TAG}%` }).catch(() => {});
  await devices.hardDelete({ deviceCodeLike: `${TAG}%` }).catch(() => {});
  await audit.hardDelete({ requestIdLike: `${TAG}%` }).catch(() => {});
  await fishermen.hardDelete({ clientRecordIdLike: `${TAG}-%` }).catch(() => {});
  await cooperatives.hardDelete({ nameLike: `${TAG}%` }).catch(() => {});
  await communities.hardDelete({ nameLike: `${TAG}%` }).catch(() => {});
  await database.disconnect();
});

// ---------------------------------------------------------------------------
// Communities (§8)
// ---------------------------------------------------------------------------

test('a radius search returns the right communities, nearest first', async () => {
  await communities.create({ name: `${TAG} Ikang`, lga: 'BAK', location: { type: 'Point', coordinates: [8.5870, 4.8970] } });
  await communities.create({ name: `${TAG} Abana`, lga: 'BAK', location: { type: 'Point', coordinates: [8.3400, 4.6800] } });
  await communities.create({ name: `${TAG} Obudu`, lga: 'OBU', location: { type: 'Point', coordinates: [9.1600, 6.6700] } });

  const near = await communities.findNearby({ latitude: 4.8970, longitude: 8.5870, radiusKm: 50 });
  const names = near.map((c) => c.name);

  assert.ok(names.includes(`${TAG} Ikang`), 'the point itself');
  assert.ok(names.includes(`${TAG} Abana`), '36km away is within 50km');
  assert.ok(!names.includes(`${TAG} Obudu`), '200km north is not');

  assert.equal(near[0].name, `${TAG} Ikang`, 'ordered by distance');
  assert.equal(near[0].distanceKm, 0);
  assert.ok(near[1].distanceKm > 30 && near[1].distanceKm < 40, `expected ~36km, got ${near[1].distanceKm}`);
});

test('a community with no coordinates is simply absent from the map', async () => {
  const noLocation = await communities.create({ name: `${TAG} Unmapped`, lga: 'BAK' });
  assert.equal(noLocation.location, undefined);

  const { items } = await communities.list({ hasLocation: true, limit: 500 });
  assert.ok(!items.some((c) => c.id === noLocation.id));
});

test('infrastructure gaps find communities lacking a facility', async () => {
  await communities.create({
    name: `${TAG} NoCold`, lga: 'BAK',
    facilities: { landingSite: true, coldStorage: false, boatRepair: false },
  });
  await communities.create({
    name: `${TAG} HasCold`, lga: 'BAK',
    facilities: { landingSite: true, coldStorage: true, boatRepair: true },
  });

  const gaps = await communities.infrastructureGaps({ facility: 'coldStorage', lgas: ['BAK'] });
  const names = gaps.map((g) => g.name);
  assert.ok(names.includes(`${TAG} NoCold`));
  assert.ok(!names.includes(`${TAG} HasCold`));
});

test('community statistics are recalculated from the register', async () => {
  const community = await communities.create({ name: `${TAG} Counted`, lga: 'BAK' });
  await fishermen.create({ firstName: 'A', lastName: 'One', gender: 'MALE', lga: 'BAK', community: community.id, clientRecordId: `${TAG}-c1` }, {});
  await fishermen.create({ firstName: 'B', lastName: 'Two', gender: 'MALE', lga: 'BAK', community: community.id, clientRecordId: `${TAG}-c2` }, {});

  const stats = await communities.recalculateStats(community.id);
  assert.equal(stats.registeredFishermen, 2);
  assert.ok(stats.lastRecalculatedAt);
});

// ---------------------------------------------------------------------------
// Cooperatives
// ---------------------------------------------------------------------------

test('a full bank account number is never stored', async () => {
  const coop = await cooperatives.create({
    name: `${TAG} Society`, lga: 'BAK',
    bankDetails: { bankName: 'Test Bank', accountName: 'Society', accountNumber: '0123456789' },
  });

  assert.equal(coop.bankDetails.accountNumberLast4, '6789');
  assert.equal(coop.bankDetails.accountNumber, undefined, 'the full number must not be kept');
  assert.ok(!JSON.stringify(coop).includes('0123456789'));
});

test('membership is read from the register, so it cannot drift', async () => {
  const coop = await cooperatives.create({ name: `${TAG} Members`, lga: 'BAK' });
  await fishermen.create({ firstName: 'M', lastName: 'One', gender: 'MALE', lga: 'BAK', cooperative: { id: coop.id }, clientRecordId: `${TAG}-m1` }, {});
  await fishermen.create({ firstName: 'M', lastName: 'Two', gender: 'MALE', lga: 'BAK', cooperative: { id: coop.id }, clientRecordId: `${TAG}-m2` }, {});

  const { total } = await cooperatives.listMembers(coop.id);
  assert.equal(total, 2);

  assert.equal(await cooperatives.recountMembers(coop.id), 2);
});

test('officers are rows, so one can be removed without rewriting the rest', async () => {
  const coop = await cooperatives.create({ name: `${TAG} Officers`, lga: 'BAK' });
  const chair = await cooperatives.addOfficer(coop.id, { name: 'Chair Person', role: 'CHAIRMAN', phone: '08030000001' });
  await cooperatives.addOfficer(coop.id, { name: 'Sec Retary', role: 'SECRETARY' });

  assert.equal((await cooperatives.listOfficers(coop.id)).length, 2);
  await cooperatives.removeOfficer(chair.id);
  const left = await cooperatives.listOfficers(coop.id);
  assert.equal(left.length, 1);
  assert.equal(left[0].name, 'Sec Retary');
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

test('the device secret is not in an ordinary read', async () => {
  const device = await devices.create({
    deviceCode: `${TAG}-D1`, label: 'Field tablet 1', lga: 'BAK',
    secretHash: 'argon2-placeholder',
  });
  assert.equal(device.secretHash, undefined);
  const withSecret = await devices.findByCode(`${TAG}-D1`, { withSecret: true });
  assert.equal(withSecret.secretHash, 'argon2-placeholder');
});

test('each entity keeps its own sync cursor', async () => {
  // A single shared cursor silently skipped records: advancing past a
  // fisherman updated at 10:00 also advanced past a boat updated at 09:59
  // that the device had never seen.
  const device = await devices.create({ deviceCode: `${TAG}-D2`, lga: 'BAK' });

  await devices.saveCursor(device.id, 'fishermen', { since: '2026-10-17T10:00:00Z', lastId: 'a' });
  await devices.saveCursor(device.id, 'boats', { since: '2026-10-17T09:59:00Z', lastId: 'b' });

  const after = await devices.findById(device.id);
  assert.equal(after.lastSyncCursors.fishermen.since, '2026-10-17T10:00:00Z');
  assert.equal(after.lastSyncCursors.boats.since, '2026-10-17T09:59:00Z', 'untouched by the other write');

  // Writing one cursor must not drop the others.
  await devices.saveCursor(device.id, 'engines', { since: '2026-10-17T11:00:00Z', lastId: 'c' });
  const final = await devices.findById(device.id);
  assert.equal(Object.keys(final.lastSyncCursors).length, 3);
});

test('a revoked device stays revoked and records who did it', async () => {
  const device = await devices.create({ deviceCode: `${TAG}-D3`, lga: 'BAK' });
  const revoked = await devices.revoke(device.id, { reason: 'lost in the field' });
  assert.equal(revoked.status, 'REVOKED');
  assert.ok(revoked.revokedAt);
  assert.equal(await devices.revoke(device.id, { reason: 'again' }), null, 'revoking twice is a no-op');
});

// ---------------------------------------------------------------------------
// Sync batches (§4d)
// ---------------------------------------------------------------------------

test('a retried batch is not processed twice', async () => {
  const clientBatchId = `${TAG}-B1`;

  const first = await batches.claim({ clientBatchId, deviceCode: `${TAG}-D1`, direction: 'PUSH' });
  assert.equal(first.claimed, true);

  // The device times out and retries. It must get the existing batch back,
  // not a second one, and not an exception.
  const retry = await batches.claim({ clientBatchId, deviceCode: `${TAG}-D1`, direction: 'PUSH' });
  assert.equal(retry.claimed, false, 'the retry does not claim');
  assert.equal(retry.batch.id, first.batch.id, 'and is told about the original');
});

test('two concurrent retries: exactly one claims', async () => {
  const clientBatchId = `${TAG}-B2`;
  const results = await Promise.all([
    batches.claim({ clientBatchId, direction: 'PUSH' }),
    batches.claim({ clientBatchId, direction: 'PUSH' }),
    batches.claim({ clientBatchId, direction: 'PUSH' }),
  ]);
  assert.equal(results.filter((r) => r.claimed).length, 1);
});

test('a batch abandoned mid-processing is reclaimed, not left blocking', async () => {
  const clientBatchId = `${TAG}-B3`;
  const { batch } = await batches.claim({ clientBatchId, direction: 'PUSH' });

  // Pretend the process died twenty minutes ago.
  await database.query(
    `UPDATE sync_batches SET started_at = now() - interval '20 minutes' WHERE id = $1`,
    [batch.id]
  );

  const reclaimed = await batches.reclaimStuck({ olderThanMinutes: 15 });
  assert.ok(reclaimed.some((b) => b.id === batch.id), 'the abandoned batch is reclaimed');

  const after = await batches.findById(batch.id);
  assert.equal(after.status, 'FAILED');
  assert.match(after.error, /abandoned/);
});

test('payloads that failed validation are kept, not discarded', async () => {
  // §4d: no information may be lost because connectivity dropped. A record
  // an enumerator spent twenty minutes on must not vanish over a typo.
  const { batch } = await batches.claim({ clientBatchId: `${TAG}-B4`, direction: 'PUSH' });
  await batches.complete(batch.id, {
    status: 'PARTIAL',
    counts: { submitted: 2, created: 1, rejected: 1 },
    rejectedPayloads: [{ clientRecordId: 'x1', reason: 'phone number malformed', payload: { phone: '08O-bad' } }],
  });

  const kept = await batches.rejectedPayloads(batch.id);
  assert.equal(kept.length, 1);
  assert.match(kept[0].reason, /phone/);

  // But they are not in an ordinary read — they hold field data.
  const ordinary = await batches.findById(batch.id);
  assert.equal(ordinary.rejectedPayloads, undefined);
});

// ---------------------------------------------------------------------------
// Audit (§9)
// ---------------------------------------------------------------------------

test('an audit entry keeps the nested shape and the actor', async () => {
  const entry = await audit.record({
    action: 'CREATE',
    actor: { name: 'Ada Officer', role: 'LGA_ADMIN', email: 'ada@test.invalid' },
    entity: { type: 'Fisherman', blueId: 'CRS-BLU-BAK-0001', label: 'Eno Bassey' },
    changes: [{ field: 'status', from: null, to: 'PENDING_VERIFICATION' }],
    lga: 'BAK',
    context: { requestId: `${TAG}-r1`, ipAddress: '198.51.100.7' },
  });

  assert.equal(entry.actor.name, 'Ada Officer');
  assert.equal(entry.entity.blueId, 'CRS-BLU-BAK-0001');
  assert.equal(entry.context.requestId, `${TAG}-r1`);
  assert.equal(entry.changes[0].to, 'PENDING_VERIFICATION');
  assert.equal(entry.succeeded, true);
});

test('an audit entry written in a transaction rolls back with it', async () => {
  // An entry describing a change that never happened is worse than no
  // entry: it is a false record in the trail a dispute is settled from.
  const requestId = `${TAG}-rollback`;

  await assert.rejects(
    database.withTransaction(async (client) => {
      await audit.record(
        { action: 'UPDATE', entity: { type: 'Fisherman' }, context: { requestId } },
        { client }
      );
      throw new Error('the change failed after the entry was written');
    })
  );

  const { total } = await audit.search({ limit: 200 });
  const found = await database.query('SELECT 1 FROM audit_logs WHERE request_id = $1', [requestId]);
  assert.equal(found.rows.length, 0, 'the entry rolled back with the change');
  assert.ok(total >= 0);
});

test('a failed action is recorded as failed, not omitted', async () => {
  await audit.record({
    action: 'LOGIN', entity: { type: 'User' },
    succeeded: false, failureReason: 'wrong password',
    context: { requestId: `${TAG}-fail` },
  });

  const { items } = await audit.search({ succeeded: false, limit: 50 });
  assert.ok(items.some((e) => e.failureReason === 'wrong password'));
});

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

test('a job enqueued in a transaction rolls back with it', async () => {
  const dedupeKey = `${TAG}-rollback-job`;

  await assert.rejects(
    database.withTransaction(async (client) => {
      await outbox.enqueue({ type: 'SEND_EMAIL', dedupeKey, payload: { to: 'x@test.invalid' } }, { client });
      throw new Error('the registration failed');
    })
  );

  const { rows } = await database.query('SELECT 1 FROM outbox_jobs WHERE dedupe_key = $1', [dedupeKey]);
  assert.equal(rows.length, 0, 'no email about a registration that never happened');
});

test('repeat requests for the same work collapse into one job', async () => {
  const dedupeKey = `${TAG}-recalc`;
  const first = await outbox.enqueue({ type: 'RECALC', dedupeKey });
  const second = await outbox.enqueue({ type: 'RECALC', dedupeKey });
  const third = await outbox.enqueue({ type: 'RECALC', dedupeKey });

  assert.ok(first.id);
  assert.equal(second, null, 'the second press does nothing');
  assert.equal(third, null);
});

test('two workers never claim the same job', async () => {
  const keys = Array.from({ length: 6 }, (_, i) => `${TAG}-work-${i}`);
  for (const dedupeKey of keys) {
    // eslint-disable-next-line no-await-in-loop
    await outbox.enqueue({ type: 'WORK', dedupeKey });
  }

  // Three workers racing for six jobs.
  const claims = await Promise.all(
    Array.from({ length: 12 }, (_, i) => outbox.claimNext({ workerId: `worker-${i % 3}` }))
  );
  const claimed = claims.filter(Boolean).map((j) => j.id);

  assert.equal(new Set(claimed).size, claimed.length, 'no job was handed out twice');
});

test('a job whose worker died returns to the queue', async () => {
  const dedupeKey = `${TAG}-orphan`;
  await outbox.enqueue({ type: 'ORPHAN', dedupeKey });
  const job = await outbox.claimNext({ workerId: 'doomed', leaseSeconds: 1 });

  await database.query(`UPDATE outbox_jobs SET locked_until = now() - interval '1 minute' WHERE id = $1`, [job.id]);

  const reclaimed = await outbox.reclaimExpired();
  assert.ok(reclaimed.some((r) => r.id === job.id));
  assert.equal((await outbox.findById(job.id)).status, 'PENDING');
});

test('a job that keeps failing is parked, not retried forever', async () => {
  const dedupeKey = `${TAG}-doomed`;
  // High priority so claimNext takes THIS job: it claims whatever is next,
  // and earlier tests leave their own jobs in the queue.
  await outbox.enqueue({ type: 'DOOMED', dedupeKey, maxAttempts: 2, priority: 100 });

  let job = await outbox.claimNext({ workerId: 'w1' });
  assert.equal(job.type, 'DOOMED', 'claimed the job under test');
  job = await outbox.fail(job.id, { error: 'upstream refused', backoffSeconds: 0 });
  assert.equal(job.status, 'PENDING', 'one attempt left');

  job = await outbox.claimNext({ workerId: 'w1' });
  assert.equal(job.type, 'DOOMED', 'claimed the same job again');
  job = await outbox.fail(job.id, { error: 'upstream refused again', backoffSeconds: 0 });
  assert.equal(job.status, 'DEAD', 'attempts spent; visible to an operator instead of looping');
});
